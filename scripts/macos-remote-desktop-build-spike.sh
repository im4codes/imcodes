#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR="$REPOSITORY_ROOT/native/macos-remote-desktop"
PIN_FILE="$REPOSITORY_ROOT/shared/remote-desktop-native-pins.json"

MINIMUM_MACOS_VERSION="12.3"
TARGET_NAME="imcodes_macos_remote_desktop_build_spike"
TARGET_LABEL="third_party/imcodes_macos_remote_desktop:$TARGET_NAME"
LAUNCH_AGENT_TARGET_NAME="imcodes_remote_desktop_launch_agent"
LAUNCH_AGENT_OUTPUT_NAME="imcodes-remote-desktop-launch-agent"
LAUNCH_AGENT_TARGET_LABEL="third_party/imcodes_macos_remote_desktop:$LAUNCH_AGENT_TARGET_NAME"
WORKER_TARGET_NAME="imcodes_remote_desktop_worker"
WORKER_OUTPUT_NAME="imcodes-remote-desktop-worker"
WORKER_TARGET_LABEL="third_party/imcodes_macos_remote_desktop:$WORKER_TARGET_NAME"
DISCLOSURE_TARGET_NAME="imcodes_remote_desktop_disclosure"
DISCLOSURE_OUTPUT_NAME="imcodes-remote-desktop-disclosure"
DISCLOSURE_TARGET_LABEL="third_party/imcodes_macos_remote_desktop:$DISCLOSURE_TARGET_NAME"
# Signed long-lived holder for the single warm virtual display. This process IS
# the display's lifetime, so it ships as its own executable rather than living
# inside the worker: a worker crash must not strand a display, and a stranded
# display must not take the worker down.
HELPER_TARGET_NAME="imcodes_virtual_display_helper"
HELPER_OUTPUT_NAME="imcodes-virtual-display-helper"
HELPER_TARGET_LABEL="third_party/imcodes_macos_remote_desktop:$HELPER_TARGET_NAME"
# The Authorization Plug-in bundle is NOT a shipped component. Auto unlock is
# unqualified (5.10-5.12 and 11.9 unchecked, no production enroller or
# installer, never signed/notarized/installed), so it is unreachable from every
# shipped root and is not built by default. --auto-unlock-verification builds
# the verification-only group; that run checks the bundle by path and exported
# symbol, and the bundle never enters the shipped provenance manifest.
AUTO_UNLOCK_TARGET_NAME="aiDeskAutoUnlock"
AUTO_UNLOCK_TARGET_LABEL="third_party/imcodes_macos_remote_desktop:$AUTO_UNLOCK_TARGET_NAME"
AUTO_UNLOCK_BUNDLE_NAME="aiDeskAutoUnlock.bundle"
AUTO_UNLOCK_GROUP_LABEL="third_party/imcodes_macos_remote_desktop:macos_auto_unlock_all"
NOTICES_GENERATOR="$REPOSITORY_ROOT/scripts/generate-macos-libwebrtc-notices.py"
NOTICES_FILE_NAME="THIRD_PARTY_NOTICES.webrtc.md"
OVERLAY_RELATIVE="third_party/imcodes_macos_remote_desktop"
COMMON_OVERLAY_RELATIVE="third_party/remote-desktop-common"
SUPPORTED_ARCHITECTURES=(arm64 x64)
REQUIRED_FRAMEWORKS=(ScreenCaptureKit VideoToolbox CoreMedia CoreVideo Foundation)

usage() {
  cat <<'EOF'
Usage:
  macos-remote-desktop-build-spike.sh --arch arm64|x64 \
    --webrtc-root PATH --depot-tools-root PATH [--out-dir out/PATH] [--jobs N] \
    [--components-only]
  macos-remote-desktop-build-spike.sh --apple-framework-only \
    --arch arm64|x64 [--output PATH]
  macos-remote-desktop-build-spike.sh --arch arm64|x64 \
    --auto-unlock-verification   # compile/link the NOT-SHIPPED auto-unlock group
  macos-remote-desktop-build-spike.sh --print-contract

The full probe must run on a native runner matching the requested architecture.
Use --components-only on an older supported build host whose SDK cannot compile
unshipped upstream aggregate sources; this still installs the root BUILD.gn
overlay and builds and verifies every shipped aiDesk.to component -- worker,
LaunchAgent, disclosure and the resident virtual-display helper.
Only the unshipped upstream build-spike aggregate is skipped.

The aiDeskAutoUnlock Authorization Plug-in bundle is NOT SHIPPED and is NOT built
by default: auto unlock is unqualified (5.10-5.12 and 11.9 are unchecked, and
there is no production enroller or installer), so it is unreachable from every
shipped root. --auto-unlock-verification builds the verification-only group so
the pinned toolchain keeps compiling those sources and links the bundle for a
symbol check. That is a compile/link check ONLY -- it does not sign, notarize,
install or otherwise qualify the plug-in, and the bundle never enters the shipped
provenance manifest, which always carries exactly four component digests.
The framework-only mode may cross-link against the local macOS SDK, but does not
qualify pinned libwebrtc.
EOF
}

read_pins() {
  node - "$PIN_FILE" <<'NODE'
const { readFileSync } = require('node:fs');
const path = process.argv[2];
const value = JSON.parse(readFileSync(path, 'utf8'));
for (const key of ['libwebrtcRevision', 'depotToolsRevision']) {
  if (typeof value[key] !== 'string' || !/^[a-f0-9]{40}$/.test(value[key])) {
    throw new Error(`invalid ${key} in ${path}`);
  }
}
process.stdout.write(`${value.libwebrtcRevision}\n${value.depotToolsRevision}\n`);
NODE
}

mapfile_compat() {
  local output
  output="$(read_pins)"
  PINNED_LIBWEBRTC_REVISION="$(printf '%s\n' "$output" | sed -n '1p')"
  PINNED_DEPOT_TOOLS_REVISION="$(printf '%s\n' "$output" | sed -n '2p')"
}

print_contract() {
  mapfile_compat
  node - \
    "$MINIMUM_MACOS_VERSION" \
    "$PINNED_LIBWEBRTC_REVISION" \
    "$PINNED_DEPOT_TOOLS_REVISION" <<'NODE'
const [minimumMacosVersion, libwebrtcRevision, depotToolsRevision] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({
  contractVersion: 1,
  minimumMacosVersion,
  architectures: [
    { name: 'arm64', hostArchitecture: 'arm64', gnTargetCpu: 'arm64', clangArchitecture: 'arm64' },
    { name: 'x64', hostArchitecture: 'x86_64', gnTargetCpu: 'x64', clangArchitecture: 'x86_64' },
  ],
  frameworks: ['ScreenCaptureKit', 'VideoToolbox', 'CoreMedia', 'CoreVideo', 'Foundation'],
  targets: {
    mediaProbe: '//third_party/imcodes_macos_remote_desktop:imcodes_macos_remote_desktop_build_spike',
    launchAgent: '//third_party/imcodes_macos_remote_desktop:imcodes_remote_desktop_launch_agent',
    worker: '//third_party/imcodes_macos_remote_desktop:imcodes_remote_desktop_worker',
    disclosure: '//third_party/imcodes_macos_remote_desktop:imcodes_remote_desktop_disclosure',
    virtualDisplayHelper: '//third_party/imcodes_macos_remote_desktop:imcodes_virtual_display_helper',
  },
  launchAgent: {
    peerVerifierMode: '--imcodes-verify-peer-v1',
    inheritedSocketFd: 3,
    normalWorkerSibling: 'imcodes-remote-desktop-worker',
    refusesRootWorkerStart: true,
  },
  libwebrtcRevision,
  depotToolsRevision,
  // Machine-readable and explicit: auto unlock is neither shipped nor qualified,
  // so a consumer can assert that without parsing prose. The bundle is
  // deliberately absent from `targets` and from the provenance manifest.
  autoUnlock: {
    shipped: false,
    qualified: false,
    builtByDefault: false,
    inDefaultProvenance: false,
    provenanceComponentCount: 4,
    verificationFlag: '--auto-unlock-verification',
    verificationGroup:
      '//third_party/imcodes_macos_remote_desktop:macos_auto_unlock_all',
    bundleName: 'aiDeskAutoUnlock.bundle',
    unqualifiedReason:
      'tasks 5.10-5.12 and 11.9 unchecked; no production enroller or installer; never signed, notarized or installed',
  },
  runtimeDownloadsAllowed: false,
  noticesFileName: 'THIRD_PARTY_NOTICES.webrtc.md',
  fullProbeRequiresNativeArchitecture: true,
})}\n`);
NODE
}

require_macos_toolchain() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo 'macOS remote-desktop build spike requires a macOS host.' >&2
    exit 2
  fi
  xcrun --find clang++ >/dev/null
  xcrun --sdk macosx --show-sdk-path >/dev/null
  xcrun --find lipo >/dev/null
  xcrun --find otool >/dev/null
  xcrun --find nm >/dev/null
}

validate_architecture() {
  case "$ARCHITECTURE" in
    arm64)
      HOST_ARCHITECTURE=arm64
      CLANG_ARCHITECTURE=arm64
      GN_TARGET_CPU=arm64
      ;;
    x64)
      HOST_ARCHITECTURE=x86_64
      CLANG_ARCHITECTURE=x86_64
      GN_TARGET_CPU=x64
      ;;
    *)
      echo "unsupported architecture: $ARCHITECTURE (expected arm64 or x64)" >&2
      exit 2
      ;;
  esac
}

verify_binary_contract() {
  local artifact="$1"
  local require_media_frameworks="${2:-true}"
  local architectures
  architectures="$(xcrun lipo -archs "$artifact")"
  if [[ "$architectures" != "$CLANG_ARCHITECTURE" ]]; then
    echo "probe artifact is not a thin $CLANG_ARCHITECTURE slice: $architectures" >&2
    exit 1
  fi

  local load_commands
  load_commands="$(xcrun otool -l "$artifact")"
  if ! grep -Eq "minos[[:space:]]+$MINIMUM_MACOS_VERSION([[:space:]]|$)" <<<"$load_commands"; then
    echo "probe artifact does not encode macOS $MINIMUM_MACOS_VERSION as its minimum OS" >&2
    exit 1
  fi

  if [[ "$require_media_frameworks" == true ]]; then
    local libraries
    libraries="$(xcrun otool -L "$artifact")"
    for framework in ScreenCaptureKit VideoToolbox; do
      if ! grep -Fq "/$framework.framework/" <<<"$libraries"; then
        echo "probe artifact is not linked to $framework.framework" >&2
        exit 1
      fi
    done
  fi
}

ARCHITECTURE=''
ALLOW_CROSS_BUILD=false
# Auto unlock is not qualified and is unreachable from the shipped roots. This
# opt-in builds the verification-only group so the pinned toolchain still
# compiles every auto-unlock TU and links the bundle; it never ships.
AUTO_UNLOCK_VERIFY=false
WEBRTC_ROOT=''
DEPOT_TOOLS_ROOT=''
OUT_DIR=''
OUTPUT=''
JOBS=2
APPLE_FRAMEWORK_ONLY=false
PRINT_CONTRACT=false
COMPONENTS_ONLY=false

while (($# > 0)); do
  case "$1" in
    --arch)
      ARCHITECTURE="${2:-}"
      shift 2
      ;;
    --webrtc-root)
      WEBRTC_ROOT="${2:-}"
      shift 2
      ;;
    --depot-tools-root)
      DEPOT_TOOLS_ROOT="${2:-}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    --jobs)
      JOBS="${2:-}"
      shift 2
      ;;
    --apple-framework-only)
      APPLE_FRAMEWORK_ONLY=true
      shift
      ;;
    --components-only)
      COMPONENTS_ONLY=true
      shift
      ;;
    --auto-unlock-verification)
      # Verification only. Adds the non-shipped auto-unlock group so the pinned
      # toolchain keeps compiling it; does not add it to any shipped artifact.
      AUTO_UNLOCK_VERIFY=true
      shift
      ;;
    --allow-cross-build-diagnostic)
      # Opt-in ONLY. Produces a diagnostic artifact that is explicitly not a
      # qualification; see the cross-architecture policy below.
      ALLOW_CROSS_BUILD=true
      shift
      ;;
    --print-contract)
      PRINT_CONTRACT=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if $PRINT_CONTRACT; then
  print_contract
  exit 0
fi

if [[ -z "$ARCHITECTURE" ]]; then
  echo '--arch is required.' >&2
  usage >&2
  exit 2
fi
validate_architecture
require_macos_toolchain

if ! [[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || ((JOBS > 32)); then
  echo '--jobs must be an integer between 1 and 32.' >&2
  exit 2
fi

if $APPLE_FRAMEWORK_ONLY; then
  if [[ -z "$OUTPUT" ]]; then
    OUTPUT="${TMPDIR:-/tmp}/imcodes-macos-remote-desktop-framework-$ARCHITECTURE"
  fi
  mkdir -p "$(dirname "$OUTPUT")"
  xcrun --sdk macosx clang++ \
    -std=c++17 \
    -fobjc-arc \
    -arch "$CLANG_ARCHITECTURE" \
    "-mmacosx-version-min=$MINIMUM_MACOS_VERSION" \
    -Werror=unguarded-availability-new \
    -DIMCODES_MACOS_REMOTE_DESKTOP_APPLE_FRAMEWORK_ONLY=1 \
    "$SOURCE_DIR/build_spike.mm" \
    -framework CoreMedia \
    -framework CoreVideo \
    -framework Foundation \
    -framework ScreenCaptureKit \
    -framework VideoToolbox \
    -o "$OUTPUT"
  verify_binary_contract "$OUTPUT"
  printf 'Apple framework compile/link probe passed: %s (%s, macOS %s)\n' \
    "$OUTPUT" "$ARCHITECTURE" "$MINIMUM_MACOS_VERSION"
  exit 0
fi

# Cross-architecture policy.
#
# The default is refusal, and that is the important half: a binary that merely
# LINKED on another architecture has been shown to build, not to run, and
# treating the two as the same thing is how an unrunnable artifact acquires a
# qualification it never earned.
#
# An explicit opt-in produces a DIAGNOSTIC artifact only. It is admissible under
# exactly two extra conditions -- components-only, and a legal target pair --
# and everything it emits is stamped crossBuilt/nativeBuild=false so no later
# reader can mistake it for a qualification. Qualification for such an artifact
# is completed elsewhere, by executing that same sha256 natively.
BUILD_HOST_ARCHITECTURE="$(uname -m)"
CROSS_BUILT=false
if [[ "$BUILD_HOST_ARCHITECTURE" != "$HOST_ARCHITECTURE" ]]; then
  if ! $ALLOW_CROSS_BUILD; then
    echo "full $ARCHITECTURE probe requires a native $HOST_ARCHITECTURE CI runner; cross-linking is not qualification" >&2
    echo "pass --allow-cross-build-diagnostic with --components-only to produce a NON-QUALIFYING diagnostic artifact" >&2
    exit 2
  fi
  if ! $COMPONENTS_ONLY; then
    # The full probe links the media aggregate and is the artifact a release
    # would be cut from. Allowing it to be cross-built would put an unrunnable
    # binary on the qualification path, which is exactly what the opt-in exists
    # to keep out.
    echo 'cross-build diagnostics are limited to --components-only; the full probe must be native.' >&2
    exit 2
  fi
  case "$BUILD_HOST_ARCHITECTURE:$HOST_ARCHITECTURE" in
    arm64:x86_64|x86_64:arm64) ;;
    *)
      echo "unsupported cross-build pair $BUILD_HOST_ARCHITECTURE -> $HOST_ARCHITECTURE" >&2
      exit 2
      ;;
  esac
  CROSS_BUILT=true
  echo "WARNING: cross-built diagnostic artifact ($BUILD_HOST_ARCHITECTURE -> $HOST_ARCHITECTURE). NOT a qualification." >&2
fi
if [[ -z "$WEBRTC_ROOT" || -z "$DEPOT_TOOLS_ROOT" ]]; then
  echo '--webrtc-root and --depot-tools-root are required for the full probe.' >&2
  exit 2
fi
if [[ ! -d "$WEBRTC_ROOT/.git" || ! -d "$DEPOT_TOOLS_ROOT/.git" ]]; then
  echo 'full probe requires git checkouts for WebRTC and depot_tools.' >&2
  exit 2
fi

mapfile_compat
ACTUAL_LIBWEBRTC_REVISION="$(git -C "$WEBRTC_ROOT" rev-parse HEAD)"
ACTUAL_DEPOT_TOOLS_REVISION="$(git -C "$DEPOT_TOOLS_ROOT" rev-parse HEAD)"
if [[ "$ACTUAL_LIBWEBRTC_REVISION" != "$PINNED_LIBWEBRTC_REVISION" ]]; then
  echo "libwebrtc revision mismatch: $ACTUAL_LIBWEBRTC_REVISION (expected $PINNED_LIBWEBRTC_REVISION)" >&2
  exit 1
fi
if [[ "$ACTUAL_DEPOT_TOOLS_REVISION" != "$PINNED_DEPOT_TOOLS_REVISION" ]]; then
  echo "depot_tools revision mismatch: $ACTUAL_DEPOT_TOOLS_REVISION (expected $PINNED_DEPOT_TOOLS_REVISION)" >&2
  exit 1
fi

GN="$DEPOT_TOOLS_ROOT/gn"
AUTONINJA="$DEPOT_TOOLS_ROOT/autoninja"
if [[ ! -x "$GN" || ! -x "$AUTONINJA" ]]; then
  echo 'pinned depot_tools checkout has not bootstrapped executable gn/autoninja.' >&2
  exit 2
fi

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="out/imcodes-macos-remote-desktop-spike-$ARCHITECTURE"
fi
if [[ "$OUT_DIR" = /* || "$OUT_DIR" == *'..'* ]]; then
  echo '--out-dir must be a relative path inside the pinned WebRTC checkout.' >&2
  exit 2
fi

OVERLAY_DIR="$WEBRTC_ROOT/$OVERLAY_RELATIVE"
COMMON_OVERLAY_DIR="$WEBRTC_ROOT/$COMMON_OVERLAY_RELATIVE"
ROOT_BUILD="$WEBRTC_ROOT/BUILD.gn"
if [[ -e "$OVERLAY_DIR" || -e "$COMMON_OVERLAY_DIR" ]]; then
  echo 'refusing to replace an existing checkout overlay path' >&2
  exit 1
fi
if [[ ! -f "$ROOT_BUILD" ]]; then
  echo "pinned WebRTC checkout has no BUILD.gn: $ROOT_BUILD" >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/imcodes-macos-rd-spike.XXXXXX")"
cp -p "$ROOT_BUILD" "$TEMP_DIR/BUILD.gn.original"
cleanup() {
  if [[ -f "$TEMP_DIR/BUILD.gn.original" ]]; then
    cp -p "$TEMP_DIR/BUILD.gn.original" "$ROOT_BUILD"
  fi
  rm -rf "$OVERLAY_DIR" "$COMMON_OVERLAY_DIR" "$TEMP_DIR"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$OVERLAY_DIR"
mkdir -p "$COMMON_OVERLAY_DIR"
cp -p "$SOURCE_DIR"/*.{cc,h,mm} "$SOURCE_DIR/BUILD.gn" "$OVERLAY_DIR/"
cp -p "$REPOSITORY_ROOT/native/remote-desktop-common"/*.{cc,h} \
  "$REPOSITORY_ROOT/native/remote-desktop-common/BUILD.gn" \
  "$COMMON_OVERLAY_DIR/"

# The root BUILD.gn overlay is what puts third_party/imcodes_macos_remote_desktop
# into the graph at all. GN only generates ninja rules for targets reachable
# from the root, so without this patch `gn gen` never loads the overlay's
# BUILD.gn and every component label is an unknown ninja target.
#
# This runs in BOTH modes. It used to be skipped for --components-only, which
# contradicted that mode's own promise to build every shipped component: the
# run failed at `ninja: error: unknown target ...imcodes_remote_desktop_launch_agent`
# before compiling anything.
#
# What differs between the modes is only WHICH targets are injected into
# //:default. The `:webrtc` visibility seam is NOT conditional, even though only
# the build_spike needs it: GN defines every target in a BUILD.gn file once that
# file is loaded, and visibility-checks each one. So the spike's dependency on
# //:webrtc is validated in --components-only too, despite never being built --
# `gn gen` fails with "can not depend on //:webrtc ... not in visibility list"
# before ninja is ever reached. Verified against the pinned checkout, not
# assumed.
OVERLAY_TARGETS=(
  "//$LAUNCH_AGENT_TARGET_LABEL"
  "//$WORKER_TARGET_LABEL"
  "//$DISCLOSURE_TARGET_LABEL"
  "//$HELPER_TARGET_LABEL"
)
if $AUTO_UNLOCK_VERIFY; then
  OVERLAY_TARGETS+=("//$AUTO_UNLOCK_GROUP_LABEL")
fi
if ! $COMPONENTS_ONLY; then
  OVERLAY_TARGETS=("//$TARGET_LABEL" "${OVERLAY_TARGETS[@]}")
fi
ROOT_BUILD="$ROOT_BUILD" \
OVERLAY_TARGETS="$(printf '%s\n' "${OVERLAY_TARGETS[@]}")" \
SPIKE_TARGET_LABEL="//$TARGET_LABEL" \
node <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const path = process.env.ROOT_BUILD;
const source = readFileSync(path, 'utf8');
const targets = process.env.OVERLAY_TARGETS.split('\n').filter(Boolean);
if (targets.length === 0) {
  throw new Error('overlay patch was asked to inject no targets at all');
}
const needle = '    deps = [ ":webrtc" ]';
const replacement = [
  '    deps = [',
  '      ":webrtc",',
  ...targets.map((target) => `      "${target}",`),
  '    ]',
].join('\n');
if (source.split(needle).length !== 2) {
  throw new Error('pinned WebRTC root BUILD.gn does not contain the expected unique :webrtc dependency seam');
}
const visibilityNeedle = [
  '    visibility = [',
  '      "//:default",',
  '      "//:webrtc_lib_link_test",',
  '    ]',
].join('\n');
const visibilityReplacement = [
  '    visibility = [',
  '      "//:default",',
  '      "//:webrtc_lib_link_test",',
  `      "${process.env.SPIKE_TARGET_LABEL}",`,
  '    ]',
].join('\n');
if (source.split(visibilityNeedle).length !== 2) {
  throw new Error('pinned WebRTC root BUILD.gn does not contain the expected unique :webrtc visibility seam');
}
writeFileSync(
  path,
  source.replace(needle, replacement).replace(visibilityNeedle, visibilityReplacement),
);
NODE

export PATH="$DEPOT_TOOLS_ROOT:$WEBRTC_ROOT/buildtools/mac:$PATH"
export MACOSX_DEPLOYMENT_TARGET="$MINIMUM_MACOS_VERSION"
GN_ARGS="target_os=\"mac\" target_cpu=\"$GN_TARGET_CPU\" mac_deployment_target=\"$MINIMUM_MACOS_VERSION\" mac_min_system_version=\"$MINIMUM_MACOS_VERSION\" is_debug=false is_component_build=false rtc_include_tests=false rtc_build_examples=false rtc_enable_protobuf=false use_rtti=false"
if [[ -n "${IMCODES_MACOS_SDK_PATH:-}" ]]; then
  if [[ "$IMCODES_MACOS_SDK_PATH" != /* || ! -d "$IMCODES_MACOS_SDK_PATH" ||
        "$IMCODES_MACOS_SDK_PATH" == *'"'* ]]; then
    echo 'IMCODES_MACOS_SDK_PATH must name an absolute SDK directory.' >&2
    exit 2
  fi
  # GN rejects SDK action inputs outside root_build_dir. Mirror Chromium's
  # system-Xcode convention by presenting an explicit SDK through an
  # output-relative symlink instead of embedding the host path in args.gn.
  SDK_LINK_RELATIVE="$OUT_DIR/sdk/imcodes_override/MacOSX.sdk"
  SDK_GN_PATH="//$SDK_LINK_RELATIVE"
  SDK_LINK_DIRECTORY="$WEBRTC_ROOT/$(dirname "$SDK_LINK_RELATIVE")"
  mkdir -p "$SDK_LINK_DIRECTORY"
  ln -sfn "$IMCODES_MACOS_SDK_PATH" \
    "$WEBRTC_ROOT/$SDK_LINK_RELATIVE"
  GN_ARGS+=" mac_sdk_path=\"$SDK_GN_PATH\""
fi
(
  cd "$WEBRTC_ROOT"
  "$GN" gen "$OUT_DIR" "--args=$GN_ARGS"
  SHIPPED_TARGET_LABELS=(
    "$LAUNCH_AGENT_TARGET_LABEL"
    "$WORKER_TARGET_LABEL"
    "$DISCLOSURE_TARGET_LABEL"
    "$HELPER_TARGET_LABEL"
  )
  if $AUTO_UNLOCK_VERIFY; then
    SHIPPED_TARGET_LABELS+=("$AUTO_UNLOCK_GROUP_LABEL")
  fi
  if $COMPONENTS_ONLY; then
    "$AUTONINJA" -C "$OUT_DIR" -j "$JOBS" "${SHIPPED_TARGET_LABELS[@]}"
  else
    "$AUTONINJA" -C "$OUT_DIR" -j "$JOBS" \
      "$TARGET_LABEL" "${SHIPPED_TARGET_LABELS[@]}"
  fi
)

NOTICES_OUTPUT="$WEBRTC_ROOT/$OUT_DIR/$NOTICES_FILE_NAME"
python3 "$NOTICES_GENERATOR" \
  --webrtc-root "$WEBRTC_ROOT" \
  --build-directory "$WEBRTC_ROOT/$OUT_DIR" \
  --gn "$GN" \
  --revision "$PINNED_LIBWEBRTC_REVISION" \
  --target "//$WORKER_TARGET_LABEL" \
  --target "//$LAUNCH_AGENT_TARGET_LABEL" \
  --target "//$DISCLOSURE_TARGET_LABEL" \
  --target "//$HELPER_TARGET_LABEL" \
  --output "$NOTICES_OUTPUT"
if [[ ! -s "$NOTICES_OUTPUT" ]]; then
  echo "macOS pinned build produced no third-party notices: $NOTICES_OUTPUT" >&2
  exit 1
fi

if ! $COMPONENTS_ONLY; then
  ARTIFACT="$WEBRTC_ROOT/$OUT_DIR/$TARGET_NAME"
  if [[ ! -x "$ARTIFACT" ]]; then
    echo "full probe did not produce its executable: $ARTIFACT" >&2
    exit 1
  fi
  verify_binary_contract "$ARTIFACT"
  ARTIFACT_SYMBOLS="$(xcrun nm "$ARTIFACT")"
  if ! grep -Fq 'CreateModularPeerConnectionFactory' <<<"$ARTIFACT_SYMBOLS"; then
    echo 'probe artifact does not contain the required pinned libwebrtc factory symbol.' >&2
    exit 1
  fi
fi

LAUNCH_AGENT_ARTIFACT="$WEBRTC_ROOT/$OUT_DIR/$LAUNCH_AGENT_OUTPUT_NAME"
if [[ ! -x "$LAUNCH_AGENT_ARTIFACT" ]]; then
  echo "full probe did not produce its LaunchAgent executable: $LAUNCH_AGENT_ARTIFACT" >&2
  exit 1
fi
verify_binary_contract "$LAUNCH_AGENT_ARTIFACT" false
LAUNCH_AGENT_SYMBOLS="$(xcrun nm "$LAUNCH_AGENT_ARTIFACT")"
if ! grep -Fq 'MaybeRunMacosPeerVerifierCommand' \
  <<<"$LAUNCH_AGENT_SYMBOLS"; then
  echo 'LaunchAgent does not contain the native inherited-fd peer verifier.' >&2
  exit 1
fi

WORKER_ARTIFACT="$WEBRTC_ROOT/$OUT_DIR/$WORKER_OUTPUT_NAME"
if [[ ! -x "$WORKER_ARTIFACT" ]]; then
  echo "full probe did not produce its worker executable: $WORKER_ARTIFACT" >&2
  exit 1
fi
verify_binary_contract "$WORKER_ARTIFACT" false
WORKER_SYMBOLS="$(xcrun nm "$WORKER_ARTIFACT")"
if ! grep -Fq 'RunNativeCommandV1' <<<"$WORKER_SYMBOLS" || \
   ! grep -Fq 'CreatePinnedLibwebrtcTransportBackend' <<<"$WORKER_SYMBOLS"; then
  echo 'worker does not contain the native command and pinned transport composition.' >&2
  exit 1
fi

DISCLOSURE_ARTIFACT="$WEBRTC_ROOT/$OUT_DIR/$DISCLOSURE_OUTPUT_NAME"
if [[ ! -x "$DISCLOSURE_ARTIFACT" ]]; then
  echo "full probe did not produce its disclosure executable: $DISCLOSURE_ARTIFACT" >&2
  exit 1
fi
verify_binary_contract "$DISCLOSURE_ARTIFACT" false
DISCLOSURE_SYMBOLS="$(xcrun nm "$DISCLOSURE_ARTIFACT")"
if ! grep -Fq 'MacosLocalDisclosureAdapter' <<<"$DISCLOSURE_SYMBOLS"; then
  echo 'disclosure executable does not contain the local disclosure adapter.' >&2
  exit 1
fi

HELPER_ARTIFACT="$WEBRTC_ROOT/$OUT_DIR/$HELPER_OUTPUT_NAME"
if [[ ! -x "$HELPER_ARTIFACT" ]]; then
  echo "full probe did not produce its virtual-display helper executable: $HELPER_ARTIFACT" >&2
  exit 1
fi
verify_binary_contract "$HELPER_ARTIFACT" false
HELPER_SYMBOLS="$(xcrun nm "$HELPER_ARTIFACT")"
# The helper is only useful if it carries BOTH halves: the version gate that
# fails closed on an unqualified OS, and the SkyLight seam that resolves the
# private symbols at runtime. A helper that links one without the other either
# advertises display control it cannot deliver, or refuses on an OS it could
# have served.
if ! grep -Fq 'ResolveSystemSkyLightSeam' <<<"$HELPER_SYMBOLS" || \
   ! grep -Fq 'EvaluateVirtualDisplayVersion' <<<"$HELPER_SYMBOLS"; then
  echo 'virtual-display helper does not contain the SkyLight seam and version gate.' >&2
  exit 1
fi
# Fail closed on a compile-time link to a private framework. Every private
# symbol MUST arrive through dlopen/dlsym at runtime; a linked SkyLight would
# make the helper refuse to launch on any OS that moved the symbol, which is the
# exact failure mode the dynamic seam exists to avoid.
if xcrun otool -L "$HELPER_ARTIFACT" | grep -Fq 'SkyLight'; then
  echo 'virtual-display helper links SkyLight at build time; it must resolve it dynamically.' >&2
  exit 1
fi

# The Authorization Plug-in is a loadable_module, so there is no executable bit
# to check. What makes it usable is that loginwindow can find its entry point:
# a bundle that builds but does not export AuthorizationPluginCreate loads and
# then does nothing, which is exactly the silent failure this check exists for.
# Deliberately NOT a --target of the libwebrtc notices generator above. Its
# whole dependency closure is this project's own source_sets plus the Security
# and CoreFoundation frameworks, so it links no libwebrtc and no third-party
# code and has nothing to declare there. Verified on the built artifact: `nm`
# reports zero webrtc symbols. The generator also enforces an exact
# three-executable set that the merge/verification path re-checks, so adding a
# loadable_module to it would break that contract to record nothing.
AUTO_UNLOCK_ARTIFACT="$WEBRTC_ROOT/$OUT_DIR/$AUTO_UNLOCK_BUNDLE_NAME"
# Only the verification run produces this bundle; it is not a shipped component
# and its absence in a normal build is the intended state, not a failure.
if ! $AUTO_UNLOCK_VERIFY; then
  # Ninja does not delete outputs of targets that left the graph, so a bundle
  # built by an EARLIER verification run survives in a reused out dir and can be
  # mistaken for a shipped artifact by anything that only checks existence.
  # A default build must leave no auto-unlock artifact behind at all.
  rm -f "$AUTO_UNLOCK_ARTIFACT"
fi
if $AUTO_UNLOCK_VERIFY; then
  if [[ ! -f "$AUTO_UNLOCK_ARTIFACT" ]]; then
    echo "auto-unlock verification did not produce the bundle: $AUTO_UNLOCK_ARTIFACT" >&2
    exit 1
  fi
  AUTO_UNLOCK_SYMBOLS="$(xcrun nm -g "$AUTO_UNLOCK_ARTIFACT")"
  if ! grep -Fq 'AuthorizationPluginCreate' <<<"$AUTO_UNLOCK_SYMBOLS"; then
    echo 'auto-unlock bundle does not export AuthorizationPluginCreate.' >&2
    exit 1
  fi
fi

CROSS_BUILD_MANIFEST="$WEBRTC_ROOT/$OUT_DIR/imcodes-macos-build-provenance.json"

# Hash every shipped component FIRST, into named variables, so a failure is
# visible instead of being swallowed inside a printf substitution.
#
# Exactly four shipped components are hashed. The auto-unlock bundle is NOT one
# of them: it is unqualified and not shipped, so it must never claim shipped
# provenance, and no evidence chain may depend on it. The verification opt-in
# checks it by path and exported symbol only.
#
# A digest must never be silently empty: a `2>/dev/null` on a hashing
# substitution once turned a missing path into an empty string that still
# reached the manifest, so hashing fails loudly instead.
hash_artifact() {
  local label="$1"
  local target="$2"
  if [[ ! -f "$target" ]]; then
    echo "provenance: $label artifact is not a regular file: $target" >&2
    exit 2
  fi
  # No stderr redirection: a shasum failure must surface, not vanish.
  shasum -a 256 "$target" | cut -d' ' -f1
}

WORKER_SHA256="$(hash_artifact worker "$WORKER_ARTIFACT")"
LAUNCH_AGENT_SHA256="$(hash_artifact launchAgent "$LAUNCH_AGENT_ARTIFACT")"
DISCLOSURE_SHA256="$(hash_artifact disclosure "$DISCLOSURE_ARTIFACT")"
HELPER_SHA256="$(hash_artifact virtualDisplayHelper "$HELPER_ARTIFACT")"

# Every digest must be exactly 64 lower-case hex characters. An empty or
# malformed digest is a hard failure, never a field that quietly ships blank.
for entry in \
  "worker:$WORKER_SHA256" \
  "launchAgent:$LAUNCH_AGENT_SHA256" \
  "disclosure:$DISCLOSURE_SHA256" \
  "virtualDisplayHelper:$HELPER_SHA256"; do
  entry_label="${entry%%:*}"
  entry_digest="${entry#*:}"
  if [[ ! "$entry_digest" =~ ^[0-9a-f]{64}$ ]]; then
    echo "provenance: $entry_label digest is not 64 lower-case hex: '$entry_digest'" >&2
    exit 2
  fi
done

# Machine-readable provenance, emitted for BOTH native and cross builds so a
# consumer never has to infer nativeness from the file's absence. `qualified` is
# deliberately always false here: this script builds and links, it does not
# execute, and only native execution of this exact sha256 can qualify it.
{
  printf '{\n'
  printf '  "provenanceVersion": 1,\n'
  printf '  "crossBuilt": %s,\n' "$($CROSS_BUILT && echo true || echo false)"
  printf '  "nativeBuild": %s,\n' "$($CROSS_BUILT && echo false || echo true)"
  printf '  "qualified": false,\n'
  printf '  "buildHostArch": "%s",\n' "$BUILD_HOST_ARCHITECTURE"
  printf '  "targetArch": "%s",\n' "$HOST_ARCHITECTURE"
  printf '  "componentsOnly": %s,\n' "$($COMPONENTS_ONLY && echo true || echo false)"
  printf '  "sdk": "%s",\n' "$(xcrun --sdk macosx --show-sdk-version)"
  printf '  "minOS": "%s",\n' "$MINIMUM_MACOS_VERSION"
  printf '  "artifacts": {\n'
  printf '    "worker": "%s",\n' "$WORKER_SHA256"
  printf '    "launchAgent": "%s",\n' "$LAUNCH_AGENT_SHA256"
  printf '    "disclosure": "%s",\n' "$DISCLOSURE_SHA256"
  printf '    "virtualDisplayHelper": "%s"\n' "$HELPER_SHA256"
  printf '  }\n'
  printf '}\n'
} > "$CROSS_BUILD_MANIFEST"

# Re-read what was actually written: the emitted file is what a consumer sees,
# and a formatting slip could still produce a blank field the variables did not
# have.
for entry_label in worker launchAgent disclosure virtualDisplayHelper; do
  if ! grep -Eq "\"$entry_label\": \"[0-9a-f]{64}\"" "$CROSS_BUILD_MANIFEST"; then
    echo "provenance: emitted manifest lacks a valid $entry_label digest" >&2
    exit 2
  fi
done

if grep -q '"qualified": true' "$CROSS_BUILD_MANIFEST"; then
  echo 'build provenance must never claim qualification.' >&2
  exit 2
fi

if $COMPONENTS_ONLY; then
  if $CROSS_BUILT; then
    printf 'CROSS-BUILT DIAGNOSTIC (%s -> %s), NOT QUALIFIED: %s\n' \
      "$BUILD_HOST_ARCHITECTURE" "$HOST_ARCHITECTURE" "$WORKER_ARTIFACT"
    printf 'Provenance: %s\n' "$CROSS_BUILD_MANIFEST"
    exit 0
  fi
  printf 'Pinned libwebrtc shipped-component compile/link probe passed: %s\n' \
    "$WORKER_ARTIFACT"
else
  printf 'Pinned libwebrtc + Apple framework shipped-component compile/link probe passed: %s\n' \
    "$ARTIFACT"
fi
printf 'architecture=%s minimum_macos=%s libwebrtc=%s depot_tools=%s\n' \
  "$ARCHITECTURE" "$MINIMUM_MACOS_VERSION" \
  "$PINNED_LIBWEBRTC_REVISION" "$PINNED_DEPOT_TOOLS_REVISION"
if $AUTO_UNLOCK_VERIFY; then
  printf 'auto_unlock_verification_bundle=%s (NOT SHIPPED, NOT QUALIFIED)\n' "$AUTO_UNLOCK_ARTIFACT"
fi
printf 'third_party_notices=%s\n' "$NOTICES_OUTPUT"
