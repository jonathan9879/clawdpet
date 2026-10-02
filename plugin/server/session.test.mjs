import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.join(here, 'session.mjs');
const PERMISSION = path.join(here, '..', 'hooks', 'permission.mjs');
const HOOK = path.join(here, '..', 'hooks', 'notify.mjs');

function fakeHub(dir) {
  const received = [];
  const sockets = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        received.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
  });
  return new Promise((resolve) => server.listen(path.join(dir, 'hub.sock'), () => resolve({
    received,
    send: (obj) => sockets.forEach((s) => s.write(JSON.stringify(obj) + '\n')),
    close: () => new Promise((r) => { sockets.forEach((s) => s.destroy()); server.close(r); }),
  })));
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};

test('the session server registers its tmux pane and offers no channel capability', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdpet-'));
  const hub = await fakeHub(dir);
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SESSION],
    env: { ...process.env, CLAWDPET_HOME: dir, TMUX_PANE: '%9' },
    stderr: 'ignore',
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerCapabilities().experimental, undefined);
    const reg = await until(() => hub.received.find((m) => m.type === 'register'));
    assert.equal(reg.key, '%9');
    assert.equal(reg.pane, '%9');
  } finally {
    await client.close();
    await hub.close();
  }
});

async function runPermissionHook(dir, input, reply) {
  const { spawn } = await import('node:child_process');
  const hub = await fakeHub(dir);
  try {
    const child = spawn(process.execPath, [PERMISSION], { env: { ...process.env, CLAWDPET_HOME: dir, TMUX_PANE: '%5' } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const exited = new Promise((r) => child.on('exit', r));
    child.stdin.end(JSON.stringify(input));
    const msg = await until(() => hub.received.find((m) => m.type === 'perm'));
    hub.send({ type: 'perm_reply', request_id: msg.request_id, behavior: reply });
    assert.equal(await exited, 0);
    return { msg, out };
  } finally {
    await hub.close();
  }
}

test('the permission hook returns the device verdict as the decision', async () => {
  const input = { hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash',
    tool_input: { command: 'ls', description: 'List files' } };
  for (const behavior of ['allow', 'deny']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdpet-'));
    const { msg, out } = await runPermissionHook(dir, input, behavior);
    assert.equal(msg.key, '%5');
    assert.equal(msg.tool_name, 'Bash');
    assert.equal(msg.description, 'List files');
    assert.equal(msg.input_preview, '{"command":"ls","description":"List files"}');
    assert.deepEqual(JSON.parse(out),
      { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } } }, behavior);
  }
});

test('the permission hook prints nothing when the device hands the prompt to the keyboard', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdpet-'));
  const input = { hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } };
  const { out } = await runPermissionHook(dir, input, null);
  assert.equal(out, '');
  const noHub = spawnSync(process.execPath, [PERMISSION], {
    input: JSON.stringify(input), env: { ...process.env, CLAWDPET_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'clawdpet-')), TMUX_PANE: '%5' }, encoding: 'utf8',
  });
  assert.equal(noHub.status, 0);
  assert.equal(noHub.stdout, '');
});

test('hooks exit 0 quickly with no output when no hub is running', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdpet-'));
  const events = [
    { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash' },
    { hook_event_name: 'Stop', session_id: 's1' },
    { hook_event_name: 'Nonsense' },
  ];
  for (const ev of events) {
    const start = Date.now();
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(ev), env: { ...process.env, CLAWDPET_HOME: dir, TMUX_PANE: '' }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, ev.hook_event_name);
    assert.equal(r.stdout, '', ev.hook_event_name);
    assert.ok(Date.now() - start < 1500, `${ev.hook_event_name} took too long`);
  }
});

test('a hook event reaches a running hub keyed by the tmux pane', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdpet-'));
  const hub = await fakeHub(dir);
  try {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, CLAWDPET_HOME: dir, TMUX_PANE: '%5' } });
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Edit' }));
    const msg = await until(() => hub.received[0]);
    assert.deepEqual(msg, { type: 'pretool', tool: 'Edit', key: '%5', pane: '%5' });
  } finally {
    await hub.close();
  }
});

const ASK = path.join(here, '..', 'hooks', 'ask.mjs');

test('the question hook returns the device answer as updatedInput', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdpet-'));
  const hub = await fakeHub(dir);
  const { spawn } = await import('node:child_process');
  const input = { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Pick?', header: 'P', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] } };
  try {
    const child = spawn(process.execPath, [ASK], { env: { ...process.env, CLAWDPET_HOME: dir, TMUX_PANE: '%5' } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const exited = new Promise((r) => child.on('exit', r));
    child.stdin.end(JSON.stringify(input));
    const msg = await until(() => hub.received.find((m) => m.type === 'ask'));
    assert.equal(msg.key, '%5');
    assert.deepEqual(msg.questions, input.tool_input.questions);
    hub.send({ type: 'ask_reply', ask_id: msg.ask_id, answers: { 'Pick?': 'B' } });
    assert.equal(await exited, 0);
    const res = JSON.parse(out).hookSpecificOutput;
    assert.equal(res.permissionDecision, 'allow');
    assert.deepEqual(res.updatedInput, { ...input.tool_input, answers: { 'Pick?': 'B' } });
  } finally {
    await hub.close();
  }
});

test('the question hook prints nothing when the device cancels or no hub runs', async () => {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Pick?', options: [{ label: 'A' }] }] } });
  const noHub = spawnSync(process.execPath, [ASK], {
    input, env: { ...process.env, CLAWDPET_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'clawdpet-')) }, encoding: 'utf8',
  });
  assert.equal(noHub.status, 0);
  assert.equal(noHub.stdout, '');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdpet-'));
  const hub = await fakeHub(dir);
  const { spawn } = await import('node:child_process');
  try {
    const child = spawn(process.execPath, [ASK], { env: { ...process.env, CLAWDPET_HOME: dir, TMUX_PANE: '%5' } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const exited = new Promise((r) => child.on('exit', r));
    child.stdin.end(input);
    const msg = await until(() => hub.received.find((m) => m.type === 'ask'));
    hub.send({ type: 'ask_reply', ask_id: msg.ask_id, answers: null });
    assert.equal(await exited, 0);
    assert.equal(out, '');
  } finally {
    await hub.close();
  }
});

test('sessions outside tmux send nothing to the hub', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdpet-'));
  const hub = await fakeHub(dir);
  try {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }),
      env: { ...process.env, CLAWDPET_HOME: dir, TMUX_PANE: '' }, encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(hub.received, []);
  } finally {
    await hub.close();
  }
});

test('suggest_replies reaches the hub and rejects replies that are too long', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdpet-'));
  const hub = await fakeHub(dir);
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SESSION],
    env: { ...process.env, CLAWDPET_HOME: dir, TMUX_PANE: '%9' }, stderr: 'ignore',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['suggest_replies']);
    await until(() => hub.received.find((m) => m.type === 'register'));
    const ok = await client.callTool({ name: 'suggest_replies', arguments: { replies: ['yes, run them', 'no thanks'] } });
    assert.equal(ok.isError, undefined);
    const msg = await until(() => hub.received.find((m) => m.type === 'replies'));
    assert.deepEqual(msg, { type: 'replies', key: '%9', replies: ['yes, run them', 'no thanks'] });
    const bad = await client.callTool({ name: 'suggest_replies', arguments: { replies: ['x'.repeat(36)] } });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
    await hub.close();
  }
});
