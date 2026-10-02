# Clawdpet

A Claude mascot on the protobadge (ESP32-C6) that mirrors your Claude Code sessions and works as a remote.

| Button | Pet screen | Approval screen | Lists |
| :- | :- | :- | :- |
| A | open suggested replies | hold 1 s to allow | select |
| B | | deny | back (questions go back to the keyboard) |
| Up | voice: hold to talk, release to send (or tap, talk, tap) | | move |
| Down | sessions menu | | move |
| Knob | | | scroll |

Pet moods: idle (looks around, hops, walks), busy (Claude is working), waiting (waves a flag and buzzes: needs you), done (stomps with confetti), asleep (no Mac linked).

## Install on a Mac

In a terminal:

```bash
claude plugin marketplace add jonathan9879/clawdpet
claude plugin install clawdpet@clawdpet
```

Then in a Claude Code session:

```
/plugin configure clawdpet@clawdpet     # device address and encryption key (stored in secure storage)
/clawdpet:setup                          # tmux, the clawd launcher, voice key, connection test
```

Start sessions with `clawd` instead of `claude`. The Mac must be on the same network as the device.


## Firmware updates over WiFi

```bash
brew install esphome          # once
firmware/flash.sh             # build locally and flash over WiFi
firmware/flash.sh usb         # first time or recovery, over the USB cable
firmware/flash.sh build       # compile only
```

Needs `~/.clawdpet/firmware.env`, `api_key`, `ota_password` and `secrets.yaml`. Local builds leave out Vento's identity component (it lives in a private repository only Vento's compiler can fetch); the device's MQTT values on Vento are unaffected.

## Layout

- `firmware/protobadge.yaml`: ESPHome config with `__PLACEHOLDER__` values; `firmware/flash.sh` fills them from `~/.clawdpet`.
- `plugin/`: Claude Code plugin: channel server (`server/`), hooks (`hooks/`), hub (`hub/`).
- `plugin/scripts/clawd`: launcher that keeps sessions in the `clawdpet` tmux session (copied to `~/.local/bin` by `/clawdpet:setup`).
- `plugin/skills/setup`: the `/clawdpet:setup` skill.
- `docs/PLAN.md`: design, security model and the open spikes.

## Tests

```bash
cd plugin && npm test
```

## Known limits

- Only sessions started with `clawd` (inside tmux) appear on the pet; the desktop app has no control surface for this.
- Suggested replies appear when Claude offers them at the end of a turn (footer shows `A REPLY(n)`); the picked one is typed into the session as your message.
- A prompt that does not fully fit on the screen can only be denied from the device.
- Claude's multiple-choice questions (AskUserQuestion) show on the device for 45 s; while one is shown the terminal waits, and B or the timeout hands it back to the keyboard. Multi-select questions take one pick from the device.
