---
name: setup
description: Set up this Mac to use the clawdpet handheld (tmux, launcher, voice key, device connection) and verify it end to end. Run after installing the clawdpet plugin.
disable-model-invocation: true
---

# Set up clawdpet on this Mac

Clawdpet is an ESP32-C6 handheld that shows the Claude mascot and acts as a remote for Claude Code sessions. This plugin provides:

- a **session MCP server** (one per session) that registers the session and offers the `suggest_replies` tool;
- **hooks** that report session state, show tool approval prompts (PermissionRequest) and AskUserQuestion questions on the device, and pre-approve `suggest_replies`;
- a **hub** daemon, started by the first session server, that holds the encrypted ESPHome native API connection to the device (port 6053) and uses tmux to switch sessions, open new ones, type picked replies and press the dictation key.

Sessions must run inside tmux, which the `clawd` launcher does (it starts plain `claude` in the `clawdpet` tmux session). Sessions outside tmux are not tracked. While an approval or question is on the device, the terminal waits (20 s for approvals, 45 s for questions); B on the device or the timeout hands it back to the keyboard, and approvals too long to show in full go straight to the keyboard. The hub keeps its socket, lock and log in `~/.clawdpet/`.

Work through the steps in order. Tell the user what each step changes before changing user settings, and never ask for the device key in chat.

## 1. Prerequisites

Check and report: `node --version` (18 or newer), `claude --version` (2.1.234 or newer), `brew --version`, `tmux -V`. If tmux is missing, install it with `brew install tmux`. Voice dictation also needs Claude Code signed in with a claude.ai account.

## 2. Device settings

Run `claude plugin configure clawdpet@clawdpet --json` and check whether `device_key` and `device_host` are set (never print a sensitive value). If the key is unset, ask the user to run `/plugin configure clawdpet@clawdpet` in this session and paste the key into the masked field. The key is the `api.encryption.key` from the device firmware; on a Mac that already uses clawdpet they can copy it from the plugin settings there, or from `~/.clawdpet/api_key` on the Mac that flashes the device. `device_host` defaults to `protobadge.local`; use the device's IP instead if that name does not resolve (the IP shows on the device's sleep screen as `IP x.x.x.x`).

## 3. Network

The device only talks to Macs on the same local network. Test with `ping -c 2 <device_host>` and `nc -z -G 3 <device_host> 6053`. If either fails, stop and explain: the Mac must be on the same WiFi as the device, the device only joins networks in its firmware, and office networks often block device-to-device traffic. Only one Mac should drive the device at a time.

## 4. Launcher

Copy (do not symlink, the plugin path changes on every update) `${CLAUDE_PLUGIN_ROOT}/scripts/clawd` to `~/.local/bin/clawd` and make it executable. Check that `~/.local/bin` is on the user's PATH in their shell config; if not, tell them the line to add.

## 5. Voice key

Explain, then ask before changing: this enables Claude Code voice dictation in tap mode and binds Option+K to push-to-talk, which the device's Up button sends through tmux.

- In `~/.claude/settings.json`, merge `"voice": {"enabled": true, "mode": "tap"}` into the existing JSON.
- In `~/.claude/keybindings.json`, add `"meta+k": "voice:pushToTalk"` to the bindings of the `Chat` context entry, creating the file or entry if needed. Preserve everything else in both files.

## 6. Verify the connection

1. Ask the user to open a terminal in any project folder and run `clawd` (accept the folder trust question if Claude Code asks; its default answer is "No, exit").
2. Then read `tail -5 ~/.clawdpet/hub.log`. Expect `hub ... listening` followed by `device connected`; on the device the pet wakes up and the top left shows `1/1 <folder>`.
   - `no device key configured`: step 2 was not completed; after configuring, restart the hub with `pkill -f clawdpet/plugin/hub/hub.mjs` (it restarts within 10 s while a `clawd` session is open) and restart `clawd`.
   - `getaddrinfo ENOTFOUND`: the hostname does not resolve; set `device_host` to the IP and restart as above.
   - `EHOSTUNREACH` or timeouts: not on the device's network (step 3).
   - repeated handshake or decryption errors: the key does not match the device firmware.

## 7. End-to-end checks (the user does these in the `clawd` session)

- Ask Claude to run a shell command: the pet waves and buzzes; holding A for 1 second approves, B denies.
- Ask Claude to ask a multiple-choice question: it appears on the device; Up/Down or the knob moves, A picks, B hands it back to the keyboard.
- When a turn ends with suggested replies the footer shows `A REPLY(n)`: A opens them, A on one types it as the next message.
- Down opens the sessions menu; its last entry opens a new `clawd` window.
- Hold Up, speak at least three words, release: the dictation is sent. If nothing records, grant the terminal app microphone access in System Settings, Privacy & Security, Microphone.

Finish with a short report: what was installed or changed, the hub log lines that prove the connection, and which checks the user confirmed.
