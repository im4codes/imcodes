#!/usr/bin/env bash
# Generate the Xcode project (XcodeGen) and build the harness for a real iPhone.
#   scripts/build-ios-app.sh                 # build (automatic signing, team M675E26Q67)
#   scripts/build-ios-app.sh --install       # also install on the connected iPhone/iPad (devicectl)
#   DEVICE=<udid|identifier|name> scripts/build-ios-app.sh --install   # pick the device explicitly
#   UNSIGNED=1 scripts/build-ios-app.sh      # compile/link check only (no keychain/account needed)
#   XCFRAMEWORK=.cache/xcframework-src/llama.xcframework scripts/build-ios-app.sh   # from-source framework
source "$(dirname "$0")/common.sh"
install=0; [ "${1:-}" = "--install" ] && install=1
xcf="${XCFRAMEWORK:-$CACHE_DIR/xcframework/build-apple/llama.xcframework}"
[ -d "$xcf" ] || "$SPIKE_DIR/scripts/build-ios-xcframework.sh"
export R2T2_XCFRAMEWORK="$(cd "$xcf" && pwd)"
cd "$SPIKE_DIR/ios"
xcodegen generate --quiet
dd="$CACHE_DIR/ios-derived"
# Target-based build: needs only the iphoneos SDK, not an installed iOS
# platform/destination component (Xcode 26 without the iOS 26.2 component).
xcodebuild -project R2T2Harness.xcodeproj -target R2T2Harness -configuration Release -sdk iphoneos \
  SYMROOT="$dd/Build/Products" OBJROOT="$dd/Build/Intermediates" \
  $( [ "${UNSIGNED:-0}" = 1 ] && echo CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO || echo -allowProvisioningUpdates ) \
  -jobs "$JOBS" build
app="$dd/Build/Products/Release-iphoneos/R2T2Harness.app"
echo "built: $app"
if [ "$install" = 1 ]; then
  [ "${UNSIGNED:-0}" = 1 ] && { echo "UNSIGNED=1 builds cannot be installed; rebuild signed" >&2; exit 1; }
  device="${DEVICE:-}"
  if [ -z "$device" ]; then
    # Only reachable, paired iOS phones/tablets: skips "unavailable" stale pairings,
    # Apple Watch / Apple TV / Vision, and simulators. Prefer an active tunnel, then USB.
    json="$(mktemp)"; trap 'rm -f "$json"' EXIT
    xcrun devicectl list devices --json-output "$json" >/dev/null 2>&1 || true
    device=$(python3 - "$json" <<'PY'
import json, sys
try:
    devices = json.load(open(sys.argv[1]))["result"]["devices"]
except Exception:
    devices = []
rows = []
for d in devices:
    hw, conn = d.get("hardwareProperties", {}), d.get("connectionProperties", {})
    name = d.get("deviceProperties", {}).get("name", "?")
    ok = (hw.get("platform") == "iOS" and hw.get("deviceType") in ("iPhone", "iPad")
          and hw.get("reality") != "virtual" and conn.get("pairingState") == "paired"
          and conn.get("tunnelState") not in (None, "unavailable"))
    print(f"  {'candidate' if ok else 'skipped  '} {name} [{hw.get('deviceType')}] "
          f"tunnel={conn.get('tunnelState')} transport={conn.get('transportType')} udid={hw.get('udid')}",
          file=sys.stderr)
    if ok:
        rank = (conn.get("tunnelState") != "connected", conn.get("transportType") != "wired")
        rows.append((rank, d.get("identifier")))
if rows:
    print(sorted(rows)[0][1])
PY
)
  fi
  [ -n "$device" ] || { echo "no connected, paired iPhone/iPad found (plug it in, unlock, trust; or set DEVICE=<udid>)" >&2; exit 1; }
  echo "installing on $device"
  xcrun devicectl device install app --device "$device" "$app"
fi
