// PermissionRequest hook: shows the tool approval on the device and waits for
// a verdict. Allow or deny is returned as the decision; B to keyboard, a
// timeout, a prompt too long to show, or a missing hub prints nothing so the
// terminal dialog opens as usual.
import crypto from 'node:crypto';
import { requestReply } from '../hub/client.mjs';
import { sessionKey } from '../hub/paths.mjs';

// Shorter than the hook timeout in hooks.json; while it waits the terminal
// shows the hook spinner instead of the permission dialog.
const WAIT_MS = 20_000;

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || '{}');
  const key = sessionKey();
  if (!key || typeof input.tool_name !== 'string') return;

  const toolInput = input.tool_input ?? {};
  const reply = await requestReply({
    type: 'perm',
    key,
    pane: key,
    request_id: crypto.randomUUID(),
    tool_name: input.tool_name,
    description: typeof toolInput.description === 'string' ? toolInput.description : '',
    input_preview: JSON.stringify(toolInput),
  }, 'request_id', WAIT_MS);
  if (reply?.behavior !== 'allow' && reply?.behavior !== 'deny') return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: reply.behavior } },
  }));
}

main().catch(() => {}).finally(() => process.exit(0));
