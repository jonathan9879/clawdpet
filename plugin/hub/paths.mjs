import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = process.env.CLAWDPET_HOME || path.join(os.homedir(), '.clawdpet');
export const SOCKET = path.join(HOME_DIR, 'hub.sock');
export const LOCK = path.join(HOME_DIR, 'hub.lock');
export const LOG = path.join(HOME_DIR, 'hub.log');

// Command a new session window runs; the plugin loads like any installed plugin.
export const CLAUDE_ARGS = [];
export const TMUX_SESSION = 'clawdpet';

// Session identity shared by the session server and hooks: the tmux pane.
// Sessions outside tmux are not tracked, since the remote can neither switch
// to them nor type into them.
export function sessionKey() {
  return process.env.TMUX_PANE || null;
}
