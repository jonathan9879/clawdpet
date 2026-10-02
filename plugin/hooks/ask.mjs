// PreToolUse hook for AskUserQuestion: shows the question on the device and
// waits for a pick. A device answer is returned as updatedInput.answers; a
// cancel, timeout, or missing hub prints nothing so the terminal dialog opens.
import crypto from 'node:crypto';
import { requestReply } from '../hub/client.mjs';
import { sessionKey } from '../hub/paths.mjs';

// Shorter than the hook timeout in hooks.json, so the hook always exits
// cleanly; while it waits, the terminal shows the hook spinner instead of the dialog.
const WAIT_MS = 45_000;

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || '{}');
  const key = sessionKey();
  const questions = input.tool_input?.questions;
  if (input.tool_name !== 'AskUserQuestion' || !key || !Array.isArray(questions)) return;

  const reply = await requestReply(
    { type: 'ask', key, pane: key, ask_id: crypto.randomUUID(), questions }, 'ask_id', WAIT_MS);
  if (!reply?.answers) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Answered on the clawdpet device',
      updatedInput: { ...input.tool_input, answers: reply.answers },
    },
  }));
}

main().catch(() => {}).finally(() => process.exit(0));
