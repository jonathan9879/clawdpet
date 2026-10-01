# Set up clawdpet on a new Mac

Paste everything below the line into Claude Code on the new Mac (a terminal `claude` session or the desktop app's Code tab).

---

Set up **clawdpet** on this Mac. Clawdpet is a handheld ESP32-C6 device ("protobadge") that shows the Claude mascot and acts as a remote for Claude Code sessions: it mirrors session state (busy, needs you, done), approves or denies tool calls (hold A 1 s to allow, B to deny), answers AskUserQuestion questions, offers suggested replies, switches sessions, and starts voice dictation (hold Up to talk, release to send).

Source code: REPO_URL (replace with the repository URL before pasting).

## How it works (read before acting)

- **Device firmware** (ESPHome) runs on the protobadge and talks to one Mac over the local network using ESPHome's encrypted native API (port 6053, Noise pre-shared key). Nothing goes through the cloud for the remote.
- **Claude Code plugin `clawdpet`** (in `plugin/` of the repo), installed from a local marketplace (`.claude-plugin/marketplace.json` at the repo root):
  - a **channel MCP server** (`plugin/server/channel.mjs`), one per session: relays permission prompts to the device (Claude Code channels, permission relay) and provides the `suggest_replies` tool;
  - **hooks** (`plugin/hooks/`): report session state to the hub, show AskUserQuestion on the device (`ask.mjs`), and pre-approve `suggest_replies`;
  - the **hub** (`plugin/hub/hub.mjs`), a small Node daemon started automatically by the first channel server. It owns the device connection, keeps the session list, and uses tmux to switch sessions, open new ones, type replies, and press the dictation key.
- Sessions must run inside **tmux** via the `clawd` launcher (`bin/clawd`), which starts `claude --dangerously-load-development-channels plugin:clawdpet@clawdpet-local`. Custom channels are a research preview, so Claude Code shows a one-time "development channels" warning that the user confirms. Sessions outside tmux are not tracked.
- Per-Mac private state lives in `~/.clawdpet/` (mode 700): `api_key` (device encryption key), `config.json` (device host), `hub.log`, `hub.sock`.

## Requirements to check first

1. macOS with Homebrew, Node 18+ (`node --version`), git, and Claude Code 2.1.234 or newer (`claude --version`). Voice dictation also needs a claude.ai login, not an API key.
2. **Same network as the device.** The Mac must reach the device on the local network. Test once the device is powered: `ping -c 2 protobadge.local` (or its IP, shown on the device's sleep screen as `IP x.x.x.x`). If the device is in another place (home vs office), stop and tell the user: the device only joins the WiFi networks in its firmware, and office networks often block device-to-device traffic or use enterprise WiFi logins.
3. Only one Mac should drive the device at a time. If another Mac is running clawdpet sessions on the same network, tell the user both hubs would compete for the screen.

## Steps

1. Clone the repo to `~/clawdpet` (or a folder the user prefers) and `cd` into it.
2. **Device key.** The key must not pass through this chat. Ask the user to run these two commands themselves:
   - on the Mac that already runs clawdpet: `pbcopy < ~/.clawdpet/api_key` (or read it from `~/.clawdpet/api_key` and transfer it in a password manager)
   - on this Mac, after getting it onto the clipboard: `mkdir -p ~/.clawdpet && chmod 700 ~/.clawdpet && pbpaste > ~/.clawdpet/api_key && chmod 600 ~/.clawdpet/api_key`

   Then check only that the file exists and holds 44 base64 characters plus a newline (`wc -c < ~/.clawdpet/api_key` prints 45). Never print its contents.
3. Run `./install.sh` (or `./install.sh <device-ip>` if `protobadge.local` does not resolve). It installs tmux with Homebrew if missing, installs the plugin's npm dependencies, writes `~/.clawdpet/config.json`, adds the local marketplace and installs the plugin, enables voice dictation in tap mode with Option+K as the push-to-talk key (`~/.claude/settings.json` and `~/.claude/keybindings.json`), and links `clawd` into `~/.local/bin`. Tell the user before running it that it changes those Claude Code settings.
4. Run the tests: `cd plugin && npm install && npm test` (all should pass).

## Verify the connection

1. Confirm the plugin: `claude plugin list` shows `clawdpet@clawdpet-local` enabled.
2. Ask the user to run `clawd` in a terminal in any project folder and confirm the development channels warning. That starts the hub.
3. Check `tail -5 ~/.clawdpet/hub.log`: expect `hub ... listening` and then `device connected`. On the device the pet wakes up and the top left shows `1/1 <folder>`.
   - `getaddrinfo ENOTFOUND protobadge.local`: mDNS is not resolving. Rerun `./install.sh <device-ip>`, then restart the hub with `pkill -f clawdpet/plugin/hub/hub.mjs` (it restarts within 10 s while a `clawd` session is open).
   - `EHOSTUNREACH` or timeouts: not on the same network (see requirement 2).
   - repeated `device setup failed` or handshake errors: the key does not match the device firmware; redo step 2.
4. End-to-end checks, done by the user in the `clawd` session:
   - Ask Claude to run a shell command: the pet waves and buzzes, holding A for 1 s approves it.
   - Ask Claude to ask a multiple-choice question: it appears on the device; pick with Up/Down and A.
   - When Claude ends a turn with suggested replies, the footer shows `A REPLY(n)`: A, pick, A types the reply.
   - Hold Up, speak at least three words, release: the dictation is sent. If nothing records, grant the terminal app microphone access in System Settings, Privacy & Security, Microphone.

## Firmware updates (optional, only on a Mac that flashes the device)

Firmware is built locally with ESPHome (`brew install esphome`) and flashed over WiFi with `firmware/flash.sh` (`ota`, the default), or over USB with `firmware/flash.sh usb`. It needs, in `~/.clawdpet/`: `firmware.env` (WiFi SSIDs, password, device host), `api_key`, `ota_password`, and `secrets.yaml` (`vento_mqtt_password`). Copy those from the Mac that already flashes the device, by the same clipboard method as the key. Never commit them.

Report at the end: what was installed, the hub log lines that prove the connection, and which end-to-end checks the user confirmed.
