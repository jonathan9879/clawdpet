#!/bin/sh
# One-time setup of clawdpet on a Mac. Safe to re-run.
#   ./install.sh [device-host]        default host: protobadge.local
# The device encryption key must be in ~/.clawdpet/api_key (copy it from the
# Mac that generated it; it must match the key in the device firmware).
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
HOST="${1:-protobadge.local}"
STATE="$HOME/.clawdpet"

step() { printf '\n==> %s\n' "$1"; }

step "Checking tools"
command -v node >/dev/null || { echo "node is required"; exit 1; }
command -v claude >/dev/null || { echo "Claude Code (claude) is required"; exit 1; }
command -v tmux >/dev/null || { command -v brew >/dev/null && brew install tmux || { echo "install tmux first"; exit 1; }; }

step "Installing dependencies"
(cd "$ROOT/plugin" && npm ci --omit=dev --silent)

step "Device config"
mkdir -p "$STATE" && chmod 700 "$STATE"
[ -f "$STATE/api_key" ] || { echo "missing $STATE/api_key (copy the device key here)"; exit 1; }
chmod 600 "$STATE/api_key"
printf '{\n  "host": "%s",\n  "port": 6053\n}\n' "$HOST" > "$STATE/config.json"
chmod 600 "$STATE/config.json"

step "Plugin"
claude plugin marketplace add "$ROOT" 2>/dev/null || claude plugin marketplace update clawdpet-local
claude plugin install clawdpet@clawdpet-local 2>/dev/null || true

step "Voice dictation: tap mode, Option+K as the push-to-talk key"
node - <<'EOF'
const fs = require('fs'), path = require('path'), os = require('os');
const dir = path.join(os.homedir(), '.claude');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const settingsFile = path.join(dir, 'settings.json');
const settings = read(settingsFile, {});
settings.voice = { ...(settings.voice || {}), enabled: true, mode: 'tap' };
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
const kbFile = path.join(dir, 'keybindings.json');
const kb = read(kbFile, { bindings: [] });
kb.bindings = kb.bindings || [];
let chat = kb.bindings.find((b) => b.context === 'Chat');
if (!chat) { chat = { context: 'Chat', bindings: {} }; kb.bindings.push(chat); }
chat.bindings['meta+k'] = 'voice:pushToTalk';
fs.writeFileSync(kbFile, JSON.stringify(kb, null, 2) + '\n');
EOF

step "Launcher"
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/bin/clawd" "$HOME/.local/bin/clawd"
chmod +x "$ROOT/bin/clawd"

echo
echo "Done. Start a session with: clawd"
echo "Voice needs a claude.ai login and microphone access for your terminal app."
