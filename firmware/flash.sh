#!/bin/sh
# Build the protobadge firmware locally and flash it.
#   ./flash.sh          flash over WiFi (needs firmware with the ota block already on the device)
#   ./flash.sh usb      flash over the USB cable (first time, or recovery)
#   ./flash.sh build    only compile (validates the YAML)
# Values come from ~/.clawdpet: firmware.env, api_key, ota_password, secrets.yaml.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="$HOME/.clawdpet"
BUILD="$STATE/build"
MODE="${1:-ota}"

for f in firmware.env api_key ota_password secrets.yaml; do
  [ -f "$STATE/$f" ] || { echo "missing $STATE/$f"; exit 1; }
done
command -v esphome >/dev/null || { echo "install ESPHome first: brew install esphome"; exit 1; }
. "$STATE/firmware.env"

umask 077
mkdir -p "$BUILD"
cp "$STATE/secrets.yaml" "$BUILD/secrets.yaml"
API_KEY="$(cat "$STATE/api_key")" OTA_PASSWORD="$(cat "$STATE/ota_password")" \
WIFI_SSID_24="$WIFI_SSID_24" WIFI_SSID_5="$WIFI_SSID_5" WIFI_PASSWORD="$WIFI_PASSWORD" \
python3 - "$HERE/protobadge.yaml" "$BUILD/protobadge.yaml" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
for name in ["API_KEY", "OTA_PASSWORD", "WIFI_SSID_24", "WIFI_SSID_5", "WIFI_PASSWORD"]:
    text = text.replace(f"__{name}__", os.environ[name])
# Vento's identity component lives in a private repository that only Vento's
# compiler can fetch, so local builds leave it out; MQTT entities are unaffected.
out, skip = [], False
for line in text.splitlines(keepends=True):
    top = line[:1] not in (" ", "\n", "#", "")
    if top:
        skip = line.split(":")[0] in ("external_components", "vento")
    if not skip:
        out.append(line)
open(dst, "w").write("".join(out))
PY

if grep -qE '__[A-Z0-9_]+__' "$BUILD/protobadge.yaml"; then
  echo "unfilled placeholder in firmware: $(grep -oE '__[A-Z0-9_]+__' "$BUILD/protobadge.yaml" | sort -u | tr '\n' ' ')"; exit 1
fi

case "$MODE" in
  build) exec esphome compile "$BUILD/protobadge.yaml" ;;
  usb)   PORT="$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)"
         [ -n "$PORT" ] || { echo "board not found on USB (data cable? hold BOOT while plugging in)"; exit 1; }
         exec esphome run "$BUILD/protobadge.yaml" --device "$PORT" --no-logs ;;
  ota)   exec esphome run "$BUILD/protobadge.yaml" --device "${DEVICE_HOST:-protobadge.local}" --no-logs ;;
  *)     echo "usage: $0 [ota|usb|build]"; exit 1 ;;
esac
