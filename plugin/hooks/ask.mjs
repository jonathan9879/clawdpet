// PreToolUse hook for AskUserQuestion: shows the question on the device and
// waits for a pick. A device answer is returned as updatedInput.answers; a
// cancel, timeout, or missing hub prints nothing so the terminal dialog opens.
import net from 'node:net';
import crypto from 'node:crypto';
import { SOCKET, sessionKey } from '../hub/paths.mjs';

// Shorter than the hook timeout in hooks.json, so the hook always exits
// cleanly; while it waits, the terminal shows the hook spinner instead of the dialog.
const WAIT_MS = 45_000;

function ask(msg) {
  return new Promise((resolve) => {
    const sock = net.createConnection(SOCKET);
    let buf = '';
    const finish = (answers) => { clearTimeout(timer); sock.destroy(); resolve(answers); };
    const timer = setTimeout(() => finish(null), WAIT_MS);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try {
        const reply = JSON.parse(buf.slice(0, i));
        finish(reply.type === 'ask_reply' && reply.ask_id === msg.ask_id ? reply.answers : null);
      } catch { finish(null); }
    });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
  });
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || '{}');
  const key = sessionKey();
  const questions = input.tool_input?.questions;
  if (input.tool_name !== 'AskUserQuestion' || !key || !Array.isArray(questions)) return;

  const answers = await ask({
    type: 'ask', key, pane: process.env.TMUX_PANE || null, ask_id: crypto.randomUUID(), questions,
  });
  if (!answers) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Answered on the clawdpet device',
      updatedInput: { ...input.tool_input, answers },
    },
  }));
}

main().catch(() => {}).finally(() => process.exit(0));
