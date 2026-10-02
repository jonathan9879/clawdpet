// Small client for the hub's unix socket, shared by the session server and hooks.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME_DIR, SOCKET, LOG } from './paths.mjs';

const HUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hub.mjs');

// One message, best effort: hooks must never slow Claude Code down, so a
// missing hub means the event is dropped within the timeout.
export function sendOnce(obj, timeoutMs = 200) {
  return new Promise((resolve) => {
    const sock = net.createConnection(SOCKET);
    const done = () => { sock.destroy(); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    sock.on('connect', () => sock.end(JSON.stringify(obj) + '\n', () => { clearTimeout(timer); done(); }));
    sock.on('error', () => { clearTimeout(timer); done(); });
  });
}

// Sends one request and waits for the hub's reply with the same id. Resolves
// to the reply, or null on timeout, a missing hub, or a closed socket, so a
// blocking hook always falls back to the terminal dialog.
export function requestReply(msg, idField, waitMs) {
  return new Promise((resolve) => {
    const sock = net.createConnection(SOCKET);
    let buf = '';
    const finish = (reply) => { clearTimeout(timer); sock.destroy(); resolve(reply); };
    const timer = setTimeout(() => finish(null), waitMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try {
        const reply = JSON.parse(buf.slice(0, i));
        finish(reply[idField] === msg[idField] ? reply : null);
      } catch { finish(null); }
    });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
  });
}

export function startHub() {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const out = fs.openSync(LOG, 'a', 0o600);
  const child = spawn(process.execPath, [HUB], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
}

// Persistent connection with reconnect. onOpen runs on every (re)connect so
// the caller can re-register; onMessage gets parsed JSON lines.
export function connectPersistent({ onOpen, onMessage, log = () => {} }) {
  let sock = null;
  let delay = 300;
  let lastSpawn = 0;

  const open = () => {
    sock = net.createConnection(SOCKET);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => { delay = 300; onOpen(); });
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { onMessage(JSON.parse(line)); } catch (e) { log('bad hub message', e.message); }
      }
    });
    sock.on('error', (e) => {
      if ((e.code === 'ENOENT' || e.code === 'ECONNREFUSED') && Date.now() - lastSpawn > 10_000) {
        lastSpawn = Date.now();
        startHub();
      }
    });
    sock.on('close', () => {
      sock = null;
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    });
  };
  open();

  return {
    send(obj) {
      if (sock && !sock.destroyed && sock.writable) sock.write(JSON.stringify(obj) + '\n');
    },
  };
}
