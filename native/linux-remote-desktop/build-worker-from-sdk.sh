#!/usr/bin/env bash
# Build the Linux remote-desktop worker executable from the published,
# immutable libwebrtc foundation SDK (see build-libwebrtc-sdk.sh, which builds
# that SDK itself -- this script never touches WebRTC sources or gn/ninja).
#
# Mirrors native/windows-remote-desktop/build-worker-from-sdk.ps1 and the
# macOS producer (scripts/build-macos-remote-desktop-release.mjs): the SDK is
# a self-contained, pinned compiler + curated static libraries, and this
# script's only job is to compile+link this repo's own sources against it and
# write one artifact with a manifest describing exactly what was produced.
#
# The compile/link recipe below is not invented here -- it is the exact
# recipe qualified by hand against a live X11 desktop (linux-remote-desktop-
# worker-qualification.cc, out-of-process, real stdin/stdout protocol,
# decoded VP8 video end to end) before being captured into a script. Do not
# add or remove a source file here without re-running that qualification
# test: this is the worker's own build, not a test build.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SDK_ROOT=""
ARTIFACT_ROOT=""
WORKER_VERSION=""
JOBS="$(nproc 2>/dev/null || echo 4)"
RUN_NATIVE_TESTS=0

usage() {
  cat >&2 <<'USAGE'
usage: build-worker-from-sdk.sh --sdk-root DIR --artifact-root DIR
                                --worker-version X.Y.Z [--jobs N] [--run-native-tests]

  --sdk-root           Extracted linux-x64 libwebrtc SDK (install-libwebrtc-sdk.mjs --target linux-x64).
  --artifact-root      Directory the worker binary + manifest are written into. Created if missing.
  --worker-version     Recorded in the manifest; not embedded in the binary itself.
  --jobs               Parallel compiles. Default: all cores.
  --run-native-tests   Also build and run the in-process qualification test. Requires a live X11
                        display (DISPLAY set) -- skipped by default because most CI runners are headless.
USAGE
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sdk-root) SDK_ROOT="${2:-}"; shift 2 ;;
    --artifact-root) ARTIFACT_ROOT="${2:-}"; shift 2 ;;
    --worker-version) WORKER_VERSION="${2:-}"; shift 2 ;;
    --jobs) JOBS="${2:-}"; shift 2 ;;
    --run-native-tests) RUN_NATIVE_TESTS=1; shift ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[[ -n "$SDK_ROOT" && -n "$ARTIFACT_ROOT" && -n "$WORKER_VERSION" ]] || usage
[[ "$JOBS" =~ ^[0-9]+$ && "$JOBS" -ge 1 ]] || { echo "--jobs must be a positive integer" >&2; exit 2; }
[[ "$WORKER_VERSION" =~ ^[0-9]+(\.[0-9]+){1,3}(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]] \
  || { echo "invalid --worker-version: $WORKER_VERSION" >&2; exit 2; }
command -v python3 >/dev/null || { echo 'python3 is required to read sdk-compile-flags.json' >&2; exit 1; }

SDK_ROOT="$(cd "$SDK_ROOT" && pwd)"
mkdir -p "$ARTIFACT_ROOT"
ARTIFACT_ROOT="$(cd "$ARTIFACT_ROOT" && pwd)"

WORKER_FILENAME="imcodes-linux-remote-desktop-worker"
WORKER_PATH="$ARTIFACT_ROOT/$WORKER_FILENAME"
MANIFEST_PATH="$ARTIFACT_ROOT/$WORKER_FILENAME.manifest.json"

CLANG="$SDK_ROOT/toolchain/bin/clang"
RESOURCE_DIR_ROOT="$SDK_ROOT/toolchain/lib/clang"
for required in "$CLANG" "$SDK_ROOT/toolchain/bin/lld" "$SDK_ROOT/toolchain/bin/ld.lld" \
  "$SDK_ROOT/toolchain/bin/llvm-strip" "$SDK_ROOT/lib/libimcodes_linux_libwebrtc_sdk.a" \
  "$SDK_ROOT/lib/libimcodes_linux_libcxx_runtime_sdk.a" "$SDK_ROOT/lib/libjsoncpp.a" \
  "$SDK_ROOT/sdk-compile-flags.json"; do
  [[ -e "$required" ]] || { echo "SDK file is missing: $required" >&2; exit 1; }
done
CLANG_RESOURCE_DIR="$RESOURCE_DIR_ROOT/$(ls "$RESOURCE_DIR_ROOT" | head -1)"

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/imcodes-linux-worker-build-XXXXXX")"
trap 'rm -rf "$BUILD_ROOT"' EXIT
OBJECT_ROOT="$BUILD_ROOT/obj"
mkdir -p "$OBJECT_ROOT"

# sdk-compile-flags.json is the SDK's own authoritative record of the exact
# defines/includes/flags its objects were built with -- read it rather than
# hand-copying flags, so a future SDK rebuild that changes them is caught by a
# build failure here instead of a silent ABI mismatch.
COMPILE_FLAGS="$(python3 - "$SDK_ROOT" <<'PYEOF'
import json, shlex, sys

sdk_root = sys.argv[1]

def rewrite_sysroot(flag):
    return f'--sysroot={sdk_root}/toolchain/sysroot' if flag.startswith('--sysroot=') else flag

with open(f'{sdk_root}/sdk-compile-flags.json') as handle:
    data = json.load(handle)

parts = []
parts += data['defines']
parts += [f'-I{sdk_root}/{directory}' for directory in data['includeDirs']]
parts += [f'-isystem{sdk_root}/{directory}' for directory in data['systemIncludeDirs']]
parts += [rewrite_sysroot(flag) for flag in data['compileFlags']]
parts += [rewrite_sysroot(flag) for flag in data.get('cxxFlags', [])]
print(' '.join(shlex.quote(part) for part in parts))
PYEOF
)"

# Relative to the repository root, in link order. remote-desktop-common first
# (shared with Windows/macOS, already qualified there), then the Linux
# platform layer, then the worker's own entry point last.
SOURCES=(
  native/remote-desktop-common/json_protocol.cc
  native/remote-desktop-common/input_ledger.cc
  native/remote-desktop-common/quality_ladder.cc
  native/remote-desktop-common/session_core.cc
  native/remote-desktop-common/transport_session_core.cc
  native/remote-desktop-common/value_types.cc
  native/linux-remote-desktop/linux_capability_probe.cc
  native/linux-remote-desktop/linux_capture_selection.cc
  native/linux-remote-desktop/linux_native_video_source.cc
  native/linux-remote-desktop/linux_platform_adapters.cc
  native/linux-remote-desktop/linux_remote_desktop_session.cc
  native/linux-remote-desktop/linux_vnc_backend.cc
  native/linux-remote-desktop/linux_x11_backend.cc
  native/linux-remote-desktop/linux_remote_desktop_worker_main.cc
)

compile_one() {
  local relative_source="$1"
  local object_path="$OBJECT_ROOT/$(basename "${relative_source%.cc}").o"
  ( cd "$REPOSITORY_ROOT" && eval "\"$CLANG\" --driver-mode=g++ -B\"$SDK_ROOT/toolchain/bin\" \
    -resource-dir=\"$CLANG_RESOURCE_DIR\" $COMPILE_FLAGS -c \"$relative_source\" -o \"$object_path\"" )
  [[ -f "$object_path" ]] || { echo "compile did not produce $object_path" >&2; exit 1; }
}

echo "compiling ${#SOURCES[@]} sources ($JOBS parallel)..." >&2
pids=()
for source in "${SOURCES[@]}"; do
  compile_one "$source" &
  pids+=("$!")
  if [[ ${#pids[@]} -ge $JOBS ]]; then
    wait "${pids[@]}"
    pids=()
  fi
done
[[ ${#pids[@]} -eq 0 ]] || wait "${pids[@]}"
echo "compile OK" >&2

OBJECTS=()
for source in "${SOURCES[@]}"; do
  OBJECTS+=("$OBJECT_ROOT/$(basename "${source%.cc}").o")
done

WORKER_UNSTRIPPED="$BUILD_ROOT/$WORKER_FILENAME"
"$CLANG" --driver-mode=g++ -B"$SDK_ROOT/toolchain/bin" -fuse-ld=lld \
  "${OBJECTS[@]}" \
  "$SDK_ROOT/lib/libimcodes_linux_libwebrtc_sdk.a" \
  "$SDK_ROOT/lib/libimcodes_linux_libcxx_runtime_sdk.a" \
  "$SDK_ROOT/lib/libjsoncpp.a" \
  -lX11 -lXext -lXtst -lXfixes -lXrandr -lpthread -ldl \
  -o "$WORKER_UNSTRIPPED"
echo "link OK" >&2

file "$WORKER_UNSTRIPPED" | grep -q 'ELF 64-bit.*executable' \
  || { echo "produced file is not an ELF executable" >&2; exit 1; }

# Stripped for the shipped sidecar -- unstripped is ~24MB, stripped ~19MB, and
# nothing downstream needs local symbols (a crash is diagnosed from the
# structured REMOTE_DESKTOP_WORKER_CRASH_TYPE frame the worker itself writes,
# not from a native debugger on the machine it crashed on).
"$SDK_ROOT/toolchain/bin/llvm-strip" --strip-all -o "$WORKER_PATH" "$WORKER_UNSTRIPPED"
chmod 0755 "$WORKER_PATH"

if [[ "$RUN_NATIVE_TESTS" -eq 1 ]]; then
  [[ -n "${DISPLAY:-}" ]] || { echo "--run-native-tests requires DISPLAY to be set" >&2; exit 1; }
  QUAL_SOURCE="test/spec/linux-remote-desktop-worker-qualification.cc"
  QUAL_OBJECT="$OBJECT_ROOT/linux-remote-desktop-worker-qualification.o"
  ( cd "$REPOSITORY_ROOT" && eval "\"$CLANG\" --driver-mode=g++ -B\"$SDK_ROOT/toolchain/bin\" \
    -resource-dir=\"$CLANG_RESOURCE_DIR\" $COMPILE_FLAGS -c \"$QUAL_SOURCE\" -o \"$QUAL_OBJECT\"" )
  QUAL_BIN="$BUILD_ROOT/worker_qualification_test"
  "$CLANG" --driver-mode=g++ -B"$SDK_ROOT/toolchain/bin" -fuse-ld=lld \
    "$QUAL_OBJECT" "$OBJECT_ROOT/json_protocol.o" \
    "$SDK_ROOT/lib/libimcodes_linux_libwebrtc_sdk.a" \
    "$SDK_ROOT/lib/libimcodes_linux_libcxx_runtime_sdk.a" \
    "$SDK_ROOT/lib/libjsoncpp.a" \
    -lX11 -lXext -lXtst -lXfixes -lXrandr -lpthread -ldl \
    -o "$QUAL_BIN"
  "$QUAL_BIN" "$WORKER_UNSTRIPPED"
  echo "native qualification test OK" >&2
fi

SIZE_BYTES="$(stat -c%s "$WORKER_PATH" 2>/dev/null || stat -f%z "$WORKER_PATH")"
SHA256="$(sha256sum "$WORKER_PATH" | cut -d' ' -f1)"
python3 - "$MANIFEST_PATH" "$WORKER_FILENAME" "$SIZE_BYTES" "$SHA256" "$WORKER_VERSION" <<'PYEOF'
import json, sys

manifest_path, filename, size_bytes, sha256, worker_version = sys.argv[1:6]
manifest = {
    "schemaVersion": 1,
    "artifact": {
        "fileName": filename,
        "os": "linux",
        "arch": "x64",
        "size": int(size_bytes),
        "sha256": sha256,
    },
    "build": {
        "source": "build-worker-from-sdk",
        "version": worker_version,
    },
}
with open(manifest_path, "w") as handle:
    json.dump(manifest, handle, indent=2)
    handle.write("\n")
PYEOF

echo "wrote $WORKER_PATH ($SIZE_BYTES bytes, sha256=$SHA256)" >&2
echo "wrote $MANIFEST_PATH" >&2
