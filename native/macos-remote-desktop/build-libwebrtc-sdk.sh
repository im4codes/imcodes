#!/usr/bin/env bash
# Build the immutable macOS libwebrtc foundation SDK for one architecture.
#
# The product's macOS components link `//:webrtc`, which means a build from
# source needs a full pinned WebRTC checkout: tens of gigabytes and hours. Doing
# that per commit is not viable, so -- exactly as the Windows side already does
# -- the upstream objects are built ONCE against a pinned revision, archived,
# and consumed from then on. This script is the producer.
#
# One architecture per run. The runtime verifier requires thin binaries, so
# there is no universal SDK to build; `--target-cpu` selects arm64 or x64 and
# an Apple Silicon host cross-compiles the latter natively.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PIN_FILE="$REPOSITORY_ROOT/shared/remote-desktop-native-pins.json"

CHECKOUT_ROOT=""
ARTIFACT_ROOT=""
TARGET_CPU="arm64"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
SKIP_SYNC=0
# The floor the product declares; the SDK must not be compiled against a newer
# one or a consumer built for 12.3 links objects that assume more.
MINIMUM_MACOS_VERSION="12.3"

usage() {
  cat >&2 <<'USAGE'
usage: build-libwebrtc-sdk.sh --checkout-root DIR --artifact-root DIR
                             [--target-cpu arm64|x64] [--jobs N] [--skip-sync]

  --checkout-root  Dedicated directory for depot_tools and the WebRTC checkout.
  --artifact-root  Dedicated directory for the produced SDK. Replaced wholesale.
  --target-cpu     Architecture to build. Default arm64.
  --jobs           Ninja parallelism. Default: all cores.
  --skip-sync      Reuse an existing checkout, refusing if it is not at the pin.
USAGE
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --checkout-root) CHECKOUT_ROOT="${2:-}"; shift 2 ;;
    --artifact-root) ARTIFACT_ROOT="${2:-}"; shift 2 ;;
    --target-cpu) TARGET_CPU="${2:-}"; shift 2 ;;
    --jobs) JOBS="${2:-}"; shift 2 ;;
    --skip-sync) SKIP_SYNC=1; shift ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[[ -n "$CHECKOUT_ROOT" && -n "$ARTIFACT_ROOT" ]] || usage
case "$TARGET_CPU" in arm64|x64) ;; *) echo "--target-cpu must be arm64 or x64" >&2; exit 2 ;; esac
[[ "$JOBS" =~ ^[0-9]+$ && "$JOBS" -ge 1 ]] || { echo "--jobs must be a positive integer" >&2; exit 2; }

# A root filesystem passed here would be erased by the artifact refresh below.
for directory in "$CHECKOUT_ROOT" "$ARTIFACT_ROOT"; do
  [[ "$directory" != "/" && "$directory" == /* ]] \
    || { echo "paths must be absolute and not the filesystem root: $directory" >&2; exit 2; }
done

command -v python3 >/dev/null || { echo 'python3 is required to read the pin file' >&2; exit 1; }
# depot_tools bootstraps its own Python and CIPD client into the caller's home
# directory. Run from a LaunchDaemon -- which sets no HOME -- cipd's selfupdate
# stalls indefinitely rather than failing, so the build appears to hang at the
# first `gclient` call with no output at all. Refuse that up front.
[[ -n "${HOME:-}" && -d "${HOME:-}" ]] \
  || { echo 'HOME must be set to an existing directory: depot_tools bootstraps vpython and cipd into it' >&2; exit 1; }
REVISION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["libwebrtcRevision"])' "$PIN_FILE")"
DEPOT_TOOLS_REVISION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["depotToolsRevision"])' "$PIN_FILE")"
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid pinned WebRTC revision" >&2; exit 1; }
[[ "$DEPOT_TOOLS_REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid pinned depot_tools revision" >&2; exit 1; }

DEPOT_TOOLS="$CHECKOUT_ROOT/depot_tools"
WEBRTC_ROOT="$CHECKOUT_ROOT/src"
# A directory of its own, so a product build overlaying its own sources cannot
# overwrite the SDK's BUILD file or vice versa.
OVERLAY_RELATIVE="third_party/imcodes_macos_libwebrtc_sdk"
OVERLAY_DIR="$WEBRTC_ROOT/$OVERLAY_RELATIVE"
BUILD_DIR="$WEBRTC_ROOT/out/imcodes_macos_sdk_$TARGET_CPU"

mkdir -p "$CHECKOUT_ROOT"

# --- pinned depot_tools -------------------------------------------------------
if [[ ! -d "$DEPOT_TOOLS/.git" ]]; then
  git clone --filter=blob:none --no-checkout \
    https://chromium.googlesource.com/chromium/tools/depot_tools.git "$DEPOT_TOOLS"
fi
CURRENT_DEPOT_TOOLS="$(git -C "$DEPOT_TOOLS" rev-parse HEAD 2>/dev/null || echo '')"
if [[ "$CURRENT_DEPOT_TOOLS" != "$DEPOT_TOOLS_REVISION" ]]; then
  [[ "$SKIP_SYNC" -eq 0 ]] || { echo "--skip-sync depot_tools mismatch: $CURRENT_DEPOT_TOOLS" >&2; exit 1; }
  git -C "$DEPOT_TOOLS" fetch origin "$DEPOT_TOOLS_REVISION" --depth=1
  git -C "$DEPOT_TOOLS" checkout --detach "$DEPOT_TOOLS_REVISION"
fi

export PATH="$DEPOT_TOOLS:$PATH"
# depot_tools updates itself by default, which would silently move off the pin.
export DEPOT_TOOLS_UPDATE=0

# --- pinned WebRTC ------------------------------------------------------------
if [[ "$SKIP_SYNC" -eq 1 ]]; then
  [[ -d "$WEBRTC_ROOT/.git" ]] || { echo '--skip-sync requires an existing checkout' >&2; exit 1; }
  CURRENT_REVISION="$(git -C "$WEBRTC_ROOT" rev-parse HEAD)"
  [[ "$CURRENT_REVISION" == "$REVISION" ]] \
    || { echo "--skip-sync checkout revision mismatch: $CURRENT_REVISION" >&2; exit 1; }
else
  if [[ ! -d "$WEBRTC_ROOT/.git" ]]; then
    git clone --filter=blob:none --no-checkout https://webrtc.googlesource.com/src.git "$WEBRTC_ROOT"
  fi
  # Keyed on the file `gclient` actually looks for, not on the clone. An
  # interrupted first run leaves the checkout present and the solution
  # unconfigured, and every later run then fails with "client not configured"
  # while looking, from the outside, like a checkout that is simply there.
  if [[ ! -f "$CHECKOUT_ROOT/.gclient" ]]; then
    ( cd "$CHECKOUT_ROOT" && gclient config --name src https://webrtc.googlesource.com/src.git )
  fi
  git -C "$WEBRTC_ROOT" fetch origin "$REVISION" --depth=1
  git -C "$WEBRTC_ROOT" checkout --detach "$REVISION"
  ( cd "$WEBRTC_ROOT" && gclient sync -D -j "$JOBS" --revision "src@$REVISION" )
fi

# --- dependency-only overlay --------------------------------------------------
mkdir -p "$OVERLAY_DIR"
install -m 0644 "$SCRIPT_DIR/sdk.BUILD.gn" "$OVERLAY_DIR/BUILD.gn"
install -m 0644 "$SCRIPT_DIR/libwebrtc-sdk.gni" "$OVERLAY_DIR/libwebrtc-sdk.gni"
install -m 0644 "$SCRIPT_DIR/sdk_anchor.cc" "$OVERLAY_DIR/sdk_anchor.cc"

GN_ARGS="target_os=\"mac\" target_cpu=\"$TARGET_CPU\" is_debug=false"
GN_ARGS="$GN_ARGS is_component_build=false rtc_include_tests=true"
GN_ARGS="$GN_ARGS rtc_build_examples=false rtc_enable_protobuf=false use_rtti=false"
GN_ARGS="$GN_ARGS mac_deployment_target=\"$MINIMUM_MACOS_VERSION\""
# Deliberately absent: use_system_xcode. It reads like an ordinary build
# argument but is not a declared one -- build_overrides/build.gni computes it
# from should_use_hermetic_xcode.py -- so passing it makes `gn gen` fail on an
# unknown argument, hours into a run, after the whole checkout has synced.
# On a host with no hermetic Xcode that script already resolves it to true.

# Graph discovery starts at the dependency-only BUILD.gn. `--root-target`
# changes only the initial BUILD file, not the // source root, so every
# upstream //api/... label keeps its normal meaning and no edit to WebRTC's own
# root BUILD.gn is needed.
( cd "$WEBRTC_ROOT" && gn gen "$BUILD_DIR" "--args=$GN_ARGS" "--root-target=//$OVERLAY_RELATIVE" )
( cd "$WEBRTC_ROOT" && autoninja -C "$BUILD_DIR" -j "$JOBS" \
    "$OVERLAY_RELATIVE:imcodes_macos_libwebrtc_sdk" \
    "$OVERLAY_RELATIVE:imcodes_macos_libwebrtc_test_sdk" )

# --- collect ------------------------------------------------------------------
rm -rf "$ARTIFACT_ROOT"
mkdir -p "$ARTIFACT_ROOT/lib" "$ARTIFACT_ROOT/include" "$ARTIFACT_ROOT/gen"

OBJ_DIR="$BUILD_DIR/obj/$OVERLAY_RELATIVE"
for archive in libimcodes_macos_libwebrtc_sdk.a libimcodes_macos_libwebrtc_test_sdk.a; do
  [[ -f "$OBJ_DIR/$archive" ]] || { echo "SDK archive missing: $OBJ_DIR/$archive" >&2; exit 1; }
  install -m 0644 "$OBJ_DIR/$archive" "$ARTIFACT_ROOT/lib/$archive"
done

# Headers the consumer compiles against, taken from the same checkout that
# produced the objects so the two can never describe different APIs.
for header_root in api call common_audio common_video logging media modules net p2p pc rtc_base sdk system_wrappers test third_party/abseil-cpp third_party/libyuv/include; do
  [[ -d "$WEBRTC_ROOT/$header_root" ]] || continue
  ( cd "$WEBRTC_ROOT" && find "$header_root" \( -name '*.h' -o -name '*.hpp' -o -name '*.inc' \) -type f -print0 ) \
    | ( cd "$WEBRTC_ROOT" && tar --null -cf - -T - ) \
    | ( cd "$ARTIFACT_ROOT/include" && tar -xf - )
done
install -m 0644 "$WEBRTC_ROOT/webrtc.gni" "$ARTIFACT_ROOT/include/webrtc.gni" 2>/dev/null || true

# Generated headers live only in the build directory and are as much a part of
# the API as the checked-in ones.
if [[ -d "$BUILD_DIR/gen" ]]; then
  ( cd "$BUILD_DIR/gen" && find . \( -name '*.h' -o -name '*.inc' \) -type f -print0 ) \
    | ( cd "$BUILD_DIR/gen" && tar --null -cf - -T - ) \
    | ( cd "$ARTIFACT_ROOT/gen" && tar -xf - )
fi

python3 - "$ARTIFACT_ROOT" "$REVISION" "$DEPOT_TOOLS_REVISION" "$TARGET_CPU" "$MINIMUM_MACOS_VERSION" <<'PY'
import hashlib, json, os, sys

artifact_root, revision, depot_tools, target_cpu, minimum_macos = sys.argv[1:6]

def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

# Every file, sorted, so the manifest describes the whole SDK rather than the
# few pieces someone remembered to list.
entries = []
for directory, _, names in os.walk(artifact_root):
    for name in sorted(names):
        path = os.path.join(directory, name)
        entries.append({
            'path': os.path.relpath(path, artifact_root),
            'size': os.path.getsize(path),
            'sha256': digest(path),
        })
entries.sort(key=lambda entry: entry['path'])

manifest = {
    'schemaVersion': 1,
    'libwebrtcRevision': revision,
    'depotToolsRevision': depot_tools,
    'targetOs': 'mac',
    'targetCpu': target_cpu,
    'minimumMacosVersion': minimum_macos,
    'files': entries,
}
with open(os.path.join(artifact_root, 'imcodes-macos-libwebrtc-sdk.manifest.json'), 'w') as handle:
    json.dump(manifest, handle, indent=2, sort_keys=True)
    handle.write('\n')
print(f"manifest lists {len(entries)} files")
PY

echo "✅ built the macOS libwebrtc SDK for $TARGET_CPU at $ARTIFACT_ROOT"
