import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = process.env.CLAWDPET_HOME || path.join(os.homedir(), '.clawdpet');
export const SOCKET = path.join(HOME_DIR, 'hub.sock');
export const LOCK = path.join(HOME_DIR, 'hub.lock');
export const LOG = path.join(HOME_DIR, 'hub.log');
export const CONFIG = path.join(HOME_DIR, 'config.json');
export const KEY_FILE = path.join(HOME_DIR, 'api_key');

// The launch command for a new session; the dev flag is required while
// custom channels are in research preview.
export const CLAUDE_ARGS = ['--dangerously-load-development-channels', 'plugin:clawdpet@clawdpet-local'];
export const TMUX_SESSION = 'clawdpet';

// Session identity shared by the channel server and hooks: the tmux pane.
// Sessions outside tmux are not tracked, since the remote can neither switch
// to them nor type into them.
export function sessionKey() {
  return process.env.TMUX_PANE || null;
}
