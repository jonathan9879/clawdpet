// Hook entry point: maps a Claude Code hook event to a hub message.
// Always exits 0 with no stdout, so a missing hub never affects the session.
import { sendOnce } from '../hub/client.mjs';
import { sessionKey } from '../hub/paths.mjs';

const EVENTS = {
  SessionStart: (i) => ({ type: 'session_start', cwd: i.cwd }),
  SessionEnd: () => ({ type: 'session_end' }),
  UserPromptSubmit: () => ({ type: 'prompt' }),
  PreToolUse: (i) => ({ type: 'pretool', tool: i.tool_name }),
  PostToolUse: (i) => ({ type: 'posttool', tool: i.tool_name }),
  Notification: (i) =>
    // only prompts that block on the user; an idle session after Stop is not urgent
    ['permission_prompt', 'elicitation_dialog'].includes(i.notification_type) ? { type: 'notify' } : null,
  Stop: () => ({ type: 'stop' }),
};

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || '{}');
  const map = EVENTS[input.hook_event_name];
  const msg = map && map(input);
  const key = sessionKey();
  if (!msg || !key) return;
  await sendOnce({ ...msg, key, pane: process.env.TMUX_PANE || null });
}

main().catch(() => {}).finally(() => process.exit(0));
