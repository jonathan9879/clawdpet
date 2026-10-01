// clawdpet hub: one per Mac. Owns the encrypted link to the device, keeps the
// session registry, and turns device verdicts into Claude Code actions.
// Started detached by the first channel server; a lock keeps it single.
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { HOME_DIR, SOCKET, LOCK, CONFIG, KEY_FILE, CLAUDE_ARGS, TMUX_SESSION } from './paths.mjs';
import { newState, applyEvent, computeScreen, sameScreen, parseVerdict, decide } from './logic.mjs';

const require = createRequire(import.meta.url);
const { Connection } = require('@2colors/esphome-native-api');

const log = (...a) => console.error(new Date().toISOString(), ...a);

function acquireLock() {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(HOME_DIR, 0o700);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(LOCK, 'utf8'));
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        fs.rmSync(LOCK, { force: true });
      }
    }
  }
  return false;
}

if (!acquireLock()) {
  log('another hub is running; exiting');
  process.exit(0);
}
const releaseLock = () => {
  try {
    if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.rmSync(LOCK, { force: true });
  } catch {}
};
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const encryptionKey = fs.readFileSync(KEY_FILE, 'utf8').trim();

const state = newState();
const channels = new Map(); // session key -> socket of its channel server
const askSockets = new Map(); // ask id -> socket of the blocked AskUserQuestion hook
const hubId = crypto.randomBytes(4).toString('hex');
let seq = 0;
let shown = null; // { token, ref, ...screen } currently on the device
let device = null; // { conn, showKey, showArgs, verdictKey, ready }

// ------------------------------------------------------------ device link

function connectDevice() {
  const conn = new Connection({
    host: config.host,
    port: config.port ?? 6053,
    encryptionKey,
    clientInfo: 'clawdpet-hub',
    reconnect: true,
    reconnectInterval: 5000,
  });
  device = { conn, showKey: null, showArgs: [], verdictKey: null, ready: false };

  conn.on('authorized', async () => {
    try {
      const entities = await conn.listEntitiesService();
      const show = entities.find((e) => e.component === 'Services' && e.entity.name === 'show');
      const verdict = entities.find((e) => e.component === 'TextSensor' && e.entity.objectId === 'pet_verdict');
      if (!show || !verdict) throw new Error('device firmware has no show action or pet_verdict sensor');
      device.showKey = show.entity.key;
      device.showArgs = show.entity.argsList;
      device.verdictKey = verdict.entity.key;
      // Verdicts that arrive before this connection's first show are replays
      // of old state and are ignored.
      shown = null;
      device.ready = true;
      conn.subscribeStatesService();
      log('device connected');
      render(true);
    } catch (e) {
      log('device setup failed:', e.message);
    }
  });
  conn.on('unauthorized', () => {
    device.ready = false;
    shown = null;
    log('device disconnected');
  });
  conn.on('message.TextSensorStateResponse', (msg) => {
    if (msg.key !== device.verdictKey || msg.missingState) return;
    onVerdict(msg.state);
  });
  conn.on('error', (e) => log('device error:', e.message));
  conn.connect();
}

function render(force = false) {
  if (!device?.ready) return;
  const screen = computeScreen(state);
  if (!force && sameScreen(screen, shown)) {
    shown.ref = screen.ref;
    return;
  }
  const token = `${hubId}:${++seq}`;
  const values = { mode: screen.mode, token, label: screen.label, title: screen.title, body: screen.body,
    opts: screen.opts, full: screen.full };
  const args = device.showArgs.map((a) => ({ type: a.type, value: values[a.name] }));
  try {
    device.conn.executeServiceService({ key: device.showKey, args });
    shown = { ...screen, token };
  } catch (e) {
    log('show failed:', e.message);
  }
}

function onVerdict(raw) {
  const verdict = parseVerdict(raw);
  const effects = decide(state, shown, verdict);
  for (const fx of effects) runEffect(fx);
  render();
}

// ------------------------------------------------------------ effects

const PANE_RE = /^%\d+$/;

function tmux(args) {
  execFile('tmux', args, (err) => { if (err) log('tmux', args[0], 'failed:', err.message); });
}

function runEffect(fx) {
  switch (fx.type) {
    case 'verdict': {
      const sock = channels.get(fx.key);
      if (sock) send(sock, { type: 'verdict', request_id: fx.request_id, behavior: fx.behavior });
      return;
    }
    case 'ask_reply': {
      const sock = askSockets.get(fx.ask_id);
      if (sock) send(sock, { type: 'ask_reply', ask_id: fx.ask_id, answers: fx.answers });
      return;
    }
    case 'type':
      // literal text, then Enter: the reply arrives as the user's own message
      if (PANE_RE.test(fx.pane) && typeof fx.text === 'string') {
        execFile('tmux', ['send-keys', '-t', fx.pane, '-l', fx.text], (err) => {
          if (err) log('tmux send-keys failed:', err.message);
          else tmux(['send-keys', '-t', fx.pane, 'Enter']);
        });
      }
      return;
    case 'voice':
      if (PANE_RE.test(fx.pane)) tmux(['send-keys', '-t', fx.pane, 'M-k']);
      return;
    case 'focus':
      if (PANE_RE.test(fx.pane)) {
        tmux(['select-window', '-t', fx.pane]);
        tmux(['select-pane', '-t', fx.pane]);
      }
      return;
    case 'new_session': {
      const cwd = typeof fx.cwd === 'string' && fs.existsSync(fx.cwd) ? fx.cwd : process.env.HOME;
      execFile('tmux', ['has-session', '-t', TMUX_SESSION], (err) => {
        const cmd = ['claude', ...CLAUDE_ARGS].join(' ');
        if (err) tmux(['new-session', '-d', '-s', TMUX_SESSION, '-c', cwd, cmd]);
        else tmux(['new-window', '-t', `${TMUX_SESSION}:`, '-c', cwd, cmd]);
      });
      return;
    }
    default:
  }
}

// ------------------------------------------------------------ local socket

function send(sock, obj) {
  if (!sock.destroyed) sock.write(JSON.stringify(obj) + '\n');
}

function onClientMessage(sock, msg) {
  if (!msg || typeof msg.type !== 'string' || typeof msg.key !== 'string') return;
  if (msg.type === 'register') {
    sock.sessionKey = msg.key;
    channels.set(msg.key, sock);
  }
  if (msg.type === 'ask') {
    // with no device to answer on, release the hook at once so the terminal dialog opens
    if (!device?.ready || typeof msg.ask_id !== 'string') {
      send(sock, { type: 'ask_reply', ask_id: msg.ask_id, answers: null });
      return;
    }
    sock.ask = { key: msg.key, ask_id: msg.ask_id };
    askSockets.set(msg.ask_id, sock);
  }
  applyEvent(state, msg);
  render();
}

fs.rmSync(SOCKET, { force: true });
const server = net.createServer((sock) => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 1_000_000) { sock.destroy(); return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { onClientMessage(sock, JSON.parse(line)); } catch (e) { log('bad message:', e.message); }
    }
  });
  sock.on('close', () => {
    if (sock.ask) {
      askSockets.delete(sock.ask.ask_id);
      applyEvent(state, { type: 'ask_closed', key: sock.ask.key, ask_id: sock.ask.ask_id });
      render();
    }
    if (sock.sessionKey && channels.get(sock.sessionKey) === sock) {
      channels.delete(sock.sessionKey);
      applyEvent(state, { type: 'channel_closed', key: sock.sessionKey });
      render();
    }
  });
  sock.on('error', () => {});
});
server.listen(SOCKET, () => {
  fs.chmodSync(SOCKET, 0o600);
  log(`hub ${hubId} listening; device ${config.host}`);
});

connectDevice();
