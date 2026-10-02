# Clawdpet: a Claude tamagotchi that is also a session remote

Decisions (from the user): device `protobadge`, Claude Code CLI sessions, WiFi on the local network, simple companion (no needs game).

## Verified facts (Round 0)

| Fact | Source |
| :- | :- |
| protobadge = ESP32-C6 Touch LCD 1.47 (320x172), ESPHome on esp-idf, D-pad + A/B via PCF8574, knob on ADC GPIO4, vibration motor, 9 WS2812, battery ADC, WiFi + Vento cloud MQTT | Vento `devices/get` + `devices/yaml` |
| Channels: `experimental['claude/channel']` + `notifications/claude/channel`; permission relay via `claude/channel/permission`, `permission_request {request_id, tool_name, description, input_preview}`, verdict `notifications/claude/channel/permission {request_id, behavior}`; local dialog stays live, first answer wins | code.claude.com/docs/en/channels-reference |
| Dev flag accepts only `server:<name>` or `plugin:<name>@<marketplace>`; a plugin's server is not matched by `server:` | auditor grep of installed 2.1.281 binary |
| stdio MCP servers are spawned with `CLAUDE_CODE_SESSION_ID` (frozen at spawn) and inherit the parent env (so `TMUX_PANE`) | auditor grep of binary; confirm in S2 |
| `ctrl+_`, `ctrl+-` are bound to `chat:undo`; binary suggests `meta+k` for `voice:pushToTalk` | auditor grep of binary |
| Binary contains a "hook satisfied user interaction via updatedInput" path for AskUserQuestion | auditor grep; confirm in S3 |
| Hooks: UserPromptSubmit, PreToolUse (`permissionDecision`, `updatedInput`), PostToolUse, Stop, Notification (`permission_prompt`, `idle_prompt`), SessionStart (`source` incl. `clear`, `resume`), SessionEnd; `async: true` | code.claude.com/docs/en/hooks |
| Voice: `/voice tap`, `voice:pushToTalk` rebindable (Chat context only), needs claude.ai login and terminal mic permission | code.claude.com/docs/en/voice-dictation |
| Claude Code 2.1.281 (relay needs >= 2.1.234), node 22, Homebrew; no tmux, no local esphome | local shell |

## Architecture

```
 protobadge (ESPHome)                PC
 ┌───────────────────────┐ ESPHome   ┌──────────────────────────────┐
 │ native api: Noise PSK  │ native API│ clawdpet-hub (node, detached, │
 │  action show(mode,     │◀─────────▶│ spawned by first channel srv) │
 │   token,text,opts)     │ encrypted │  - device link (one client)   │
 │  text_sensor verdict   │           │  - session registry by pane   │
 │ display, LEDs, buzz    │           │  - tmux: switch / new / voice │
 └───────────────────────┘           └──────────────┬───────────────┘
                                     unix socket ~/.clawdpet/hub.sock (dir 0700)
                                    ┌───────────────┴───────────────┐
                                    │ plugin clawdpet: channel MCP   │
                                    │ server per session + hooks     │
                                    └───────────────────────────────┘
```

### 1. Firmware (edited via Vento `devices/save-yaml`, compiled and flashed via Vento)
- Remove the needs game. Keep drawing helpers, LEDs, buzz scripts. Move WiFi password to `!secret`. No `ota: platform: web_server`, no `web_server`.
- `api:` with `encryption: key: !secret clawdpet_api_key` (Noise PSK, authenticates both ends) and `reboot_timeout: 0s` so "asleep" never becomes a reboot loop. One user action `show(mode, token, text, opts)`; firmware stores into globals (`restore_value: false`). Text is ASCII, `|`-free and byte-capped by the hub.
- `text_sensor` `pet_verdict` publishes `<token>:allow|deny|opt<n>|menu<n>` on button actions. Raw buttons stay internal.
- Sprite: the Claude pixel mascot, per the user. Geometry from the reference SVG (viewBox 107x86, all `#DD775B` rects): body x11 y0 85x65; hands x0/x85 y21 22x23; eyes black 11x11 at x21/x75 y11; legs 11x26 at x11/32/64/85 y60. Drawn with `filled_rectangle` at scale 0.85, legs clipped at the ground line. Source: ayotomcs.me/claude-mascot, tympanus.net codrops article (2026-05-05). Personal, non-commercial use.
- Five states, procedural animations adapted from the article's timings (no rotation on this display, so tilts become offsets and leg stretch):
  - idle: look around (eyes and body shift 3 px over 0.4 s, legs on the lean side stretch 1.15 to 1.35x), occasional walk across the screen and crouch-and-jump (crouch 0.1 s, arc up 0.42 s, fall 0.2 s, 0.05 s hand bounce on landing).
  - busy: "working" loop: hands pump in turn every 125 ms, small body bob.
  - waiting: wave a pixel flag from the right hand (12-frame flag, body sways opposite), double buzz, orange LEDs.
  - done: stomp with confetti bursts (8-frame stomp at 125 ms, two mirrored confetti bursts), green LEDs.
  - asleep: crouched, eyes as 11x3 lines, slow breathing, dim backlight.
- Screens: home (sprite + session label), prompt (tool + description + preview), choice (up to 4 options), sessions menu (sessions + "+ new").
- Input safety: after any `show`, ignore A for 700 ms and cancel any A already held. Allow = a fresh press of A after the guard, held 1 s with a fill bar; deny = tap B. If the hub marks the prompt `full=0` (preview truncated, multi-line or control chars), only deny is offered and the screen says "approve at keyboard".
- Buttons: A select/allow, B back/deny, Up voice tap, Down sessions menu, knob scroll (ADC throttled, delta filter).
- Power: backlight dims after 60 s idle, off after 5 min; any button or new prompt wakes. Measure current in S1.

### 2. Claude Code plugin `clawdpet` (local marketplace directory, `/plugin install`)
- Launch: `claude --dangerously-load-development-channels plugin:clawdpet@clawdpet` (the form that skips the allowlist and cannot be shadowed by a repo `.mcp.json`).
- Channel MCP server per session: `claude/channel` + `claude/channel/permission` + `tools`. Keyed by `TMUX_PANE`. Starts and stays up without the hub; spawns the hub detached if the socket is missing; reconnects.
  - Relays `permission_request` to the hub, emits the verdict only for a pending `request_id` the hub returns with its token.
- Hooks (command, `async: true`, exit 0 within 200 ms when the hub is down): UserPromptSubmit/PreToolUse -> busy, PostToolUse (matching tool + input) / Stop -> clears that pane's pending item, Stop -> done, Notification permission_prompt|idle_prompt -> waiting, SessionStart -> re-key session_id for the pane, SessionEnd -> unregister.
- AskUserQuestion (phase 4, gated on S3): synchronous PreToolUse hook, timeout 30 s, returns immediately if the pane is not the active session; on a device answer returns `permissionDecision: allow` + `updatedInput` answers; else no output so the terminal dialog opens.
- `suggest_replies`: deferred; only built if S3 fails, as the fallback for "select recommended answers".

### 3. clawdpet-hub (node, detached child, no TCP listener)
- Config `~/.clawdpet/config.json` (0600): device host, Noise key.
- Exactly one API client to the device; re-pushes full screen state on every reconnect; backoff.
- Single instance: exclusive lock file `~/.clawdpet/hub.lock` (O_EXCL + pid, stale pid reclaimed); a second hub exits.
- Tokens: every `show` carries `token = <hub_id>:<seq>` with a random `hub_id` per hub process; a verdict is applied only if the token matches the currently displayed pending item, and anything received before this connection's first `show` (ESPHome replays current states on subscribe) is dropped. Late, duplicate, unknown tokens are dropped.
- Pending items are never replaced by state events. Only a verdict, a PostToolUse with matching tool_name and input, Stop, or the session disconnecting clears one.
- Session registry by pane; Down menu lists sessions; selecting runs `tmux select-window` via `execFile` argv (targets restricted to session `clawdpet`).
- New session: `tmux new-session -d -s clawdpet` if missing, then `new-window` running the launch command; the dev-channel warning needs one keypress at the keyboard (stated to the user).
- Voice: bind `meta+k` to `voice:pushToTalk`, `/voice tap`; hub sends `tmux send-keys -t <pane> M-k`. Works only in the Chat context (not while a dialog is open).
- Single PC drives the device in v1.

## Security
- Device input approves tool calls, so it equals keyboard input. Controls: Noise-encrypted native API (mutual auth by PSK), 700 ms guard + hold-to-allow, deny-only when the preview is not fully shown, tokens bind verdicts to what was displayed, plugin-form channel launch, socket dir 0700, `execFile` only, no TCP listener.
- Trusted parties: the PC user, Vento cloud (can reflash the board). Tool previews travel encrypted on the LAN.
- If S1 shows no workable node Noise client: ship relay as deny-only and status display only, until device auth exists.

## Spikes (each gates the next phase)
- S1 firmware + link: api with encryption + `show` action + `pet_verdict` compile on this C6 with display; a node client with Noise encryption (fallback: Python `aioesphomeapi` sidecar; last resort: deny-only) connects, calls `show`, receives verdicts; free heap > 40 KB (`debug` component); press-to-hub latency < 200 ms; current draw per mode.
- S2 channel: plugin-form dev flag registers; permission relay round-trips; `CLAUDE_CODE_SESSION_ID` and `TMUX_PANE` present in server env.
- S3 AskUserQuestion via PreToolUse `allow` + `updatedInput`.
- S4 `tmux send-keys M-k` starts and stops tap dictation in a tmux server spawned by the hub (mic permission attribution).

## Build phases
1. M1 demo: S1, S2, firmware (states + prompt screen), plugin with state hooks + permission relay, hub minimal. Demo: one tmux session; pet goes busy, waiting, done; a Bash approval from the device.
2. M2: sessions menu, new session, voice (S4).
3. M3: AskUserQuestion bridge (S3) or `suggest_replies` fallback.
4. Install script per PC (idempotent): `brew install tmux`, `npm ci`, add local marketplace, install plugin, keybinding + voice settings, claude.ai login check, write config, test connection.

## Tests
- Units: byte-cap ASCII sanitizer (property: <= cap, ASCII, no `|`, idempotent, prefix-preserving), option join/split round trip, verdict router case table (first wins, duplicate, late, unknown, other-pane), session registry (register, re-key, unregister, active removal), event-to-state table.
- Entry point: real channel server over stdio with an MCP SDK client and a fake hub on a temp socket (handshake, relay, hub absent, hub dies); real hub against a fake device client; hook scripts with stdin JSON and no socket exit 0 fast.
- Hardware (manual): S1 to S4 checks, glyph rendering, WiFi drop, buttons/knob, LEDs/buzz, battery.

## Out of scope for v1 (open questions)
- Desktop app sessions; multiple PCs on one device; needs game; sessions started outside tmux (shown display-only).
