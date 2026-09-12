#!/usr/bin/env bash
# Build the macOS remote-desktop components against the immutable libwebrtc SDK.
#
# The counterpart of build-libwebrtc-sdk.sh. That script needs a 25GB pinned
# WebRTC checkout and half an hour; this one needs the published SDK and a
# clone of this repository, which is what makes building these components in
# ordinary CI possible at all.
#
# There is no gn and no ninja here. Every compile flag comes from the SDK's own
# sdk-compile-flags.json, recorded by GN when the SDK was produced, because a
# hand-assembled flag set is not merely fragile: one missing define changes a
# struct layout, and the result compiles cleanly, links with no undefined
# symbols, and segfaults inside a WebRTC constructor.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMMON_DIR="$REPOSITORY_ROOT/native/remote-desktop-common"

SDK_ROOT=""
ARTIFACT_ROOT=""
TARGET_CPU=""
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"

usage() {
  cat >&2 <<'USAGE'
usage: build-worker-from-sdk.sh --sdk-root DIR --artifact-root DIR
                               [--target-cpu arm64|x64] [--jobs N]

  --sdk-root       An installed immutable libwebrtc SDK.
  --artifact-root  Output directory for the components. Replaced wholesale.
  --target-cpu     Architecture to build. Default: the SDK's own.
  --jobs           Compile parallelism. Default: all cores.
USAGE
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sdk-root) SDK_ROOT="${2:-}"; shift 2 ;;
    --artifact-root) ARTIFACT_ROOT="${2:-}"; shift 2 ;;
    --target-cpu) TARGET_CPU="${2:-}"; shift 2 ;;
    --jobs) JOBS="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[[ -n "$SDK_ROOT" && -n "$ARTIFACT_ROOT" ]] || usage
[[ "$JOBS" =~ ^[0-9]+$ && "$JOBS" -ge 1 ]] || { echo '--jobs must be a positive integer' >&2; exit 2; }
for directory in "$SDK_ROOT" "$ARTIFACT_ROOT"; do
  [[ "$directory" != "/" && "$directory" == /* ]] \
    || { echo "paths must be absolute and not the filesystem root: $directory" >&2; exit 2; }
done

BUILD_METADATA="$SDK_ROOT/sdk-build.json"
COMPILE_FLAGS="$SDK_ROOT/sdk-compile-flags.json"
for required in "$BUILD_METADATA" "$COMPILE_FLAGS" \
  "$SDK_ROOT/lib/libwebrtc.a" "$SDK_ROOT/lib/libimcodes_macos_libcxx_runtime_sdk.a" \
  "$SDK_ROOT/lib/libjsoncpp.a" \
  "$SDK_ROOT/toolchain/bin/clang" "$SDK_ROOT/toolchain/bin/ld64.lld"; do
  [[ -f "$required" ]] || { echo "SDK is incomplete, missing: $required" >&2; exit 1; }
done

read_metadata() { python3 -c '
import json, sys
value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    value = value[key]
print(value)' "$BUILD_METADATA" "$1"; }

SDK_ARCH="$(read_metadata arch)"
SDK_HOST_ARCH="$(read_metadata toolchain.hostArch)"
SDK_MACOS_SDK="$(read_metadata toolchain.macosSdk)"
[[ -n "$TARGET_CPU" ]] || TARGET_CPU="$SDK_ARCH"
[[ "$TARGET_CPU" == "$SDK_ARCH" ]] \
  || { echo "SDK builds $SDK_ARCH but --target-cpu is $TARGET_CPU" >&2; exit 1; }

# The SDK carries the compiler it was built with, which is a binary for the
# architecture of the machine that produced it -- not of the target. Both SDKs
# are cross-compiled on Apple silicon, so an Intel builder gets an arm64 clang
# that cannot execute, and the only symptom is "bad CPU type in executable".
HOST_ARCH="$(uname -m)"
[[ "$HOST_ARCH" == "$SDK_HOST_ARCH" ]] || {
  echo "this SDK ships a $SDK_HOST_ARCH toolchain and cannot run on a $HOST_ARCH host" >&2
  exit 1
}

command -v xcrun >/dev/null || { echo 'xcrun is required to locate the macOS SDK' >&2; exit 1; }
SYSROOT="$(xcrun --show-sdk-path)"
[[ -d "$SYSROOT" ]] || { echo "xcrun reported an unusable macOS SDK path: $SYSROOT" >&2; exit 1; }
HOST_MACOS_SDK="$(xcrun --show-sdk-version)"
# Advisory, not fatal: the objects were compiled against Chromium's own libc++
# and only reach the system SDK for headers and frameworks, so a different
# minor version is normally fine. Verified against a host two minor versions
# behind the producer. Recorded here so a genuinely incompatible pairing is
# visible in the log rather than inferred from a link error.
if [[ "$HOST_MACOS_SDK" != "$SDK_MACOS_SDK" ]]; then
  echo "note: SDK built against macOS SDK $SDK_MACOS_SDK, building against $HOST_MACOS_SDK" >&2
fi

case "$TARGET_CPU" in
  arm64) TARGET_TRIPLE="arm64-apple-macos" ; MACHO_ARCH="arm64" ;;
  x64) TARGET_TRIPLE="x86_64-apple-macos" ; MACHO_ARCH="x86_64" ;;
  *) echo '--target-cpu must be arm64 or x64' >&2; exit 2 ;;
esac

CLANG="$SDK_ROOT/toolchain/bin/clang"
LLVM_AR="$SDK_ROOT/toolchain/bin/llvm-ar"

# --- flags, verbatim from the SDK ---------------------------------------------
read_flags() { python3 -c '
import json, sys
print("\n".join(json.load(open(sys.argv[1]))[sys.argv[2]]))' "$COMPILE_FLAGS" "$1"; }

SDK_FLAGS=()
while IFS= read -r flag; do [[ -n "$flag" ]] && SDK_FLAGS+=("$flag"); done < <(read_flags compileFlags)
while IFS= read -r flag; do [[ -n "$flag" ]] && SDK_FLAGS+=("$flag"); done < <(read_flags cxxFlags)
while IFS= read -r flag; do [[ -n "$flag" ]] && SDK_FLAGS+=("$flag"); done < <(read_flags defines)
while IFS= read -r directory; do
  [[ -n "$directory" ]] && SDK_FLAGS+=("-I$SDK_ROOT/$directory")
done < <(read_flags includeDirs)
while IFS= read -r directory; do
  [[ -n "$directory" ]] && SDK_FLAGS+=("-isystem$SDK_ROOT/$directory")
done < <(read_flags systemIncludeDirs)
[[ ${#SDK_FLAGS[@]} -gt 20 ]] \
  || { echo "SDK compile configuration looks empty (${#SDK_FLAGS[@]} flags)" >&2; exit 1; }

# The components' own headers resolve as siblings and through
# ../remote-desktop-common, exactly as they do in the checkout overlay, so the
# repository layout needs no rearranging.
SDK_FLAGS+=( "-I$SCRIPT_DIR" "-I$COMMON_DIR" "-I$REPOSITORY_ROOT/native" )
# jsoncpp is a dependency of the components, not of the SDK anchor, so its
# include directory is not in the recorded configuration. The headers are
# staged; this is where GN's own jsoncpp config points.
SDK_FLAGS+=( "-I$SDK_ROOT/include/third_party/jsoncpp/source/include" )
SDK_FLAGS+=( "--target=$TARGET_TRIPLE" "-isysroot" "$SYSROOT" )

# The deployment target has to be on the LINK line as well, not only when
# compiling. Without it the linker writes LC_BUILD_VERSION from its own default
# -- the host SDK -- and the component announces `minos 26.0`: a binary that
# refuses to launch on every macOS older than the build machine's, which is
# almost every machine this ships to. Taken from the SDK's recorded flags so
# the objects and the load command can never disagree.
DEPLOYMENT_TARGET_FLAG=""
for flag in "${SDK_FLAGS[@]}"; do
  case "$flag" in -mmacos-version-min=*) DEPLOYMENT_TARGET_FLAG="$flag" ;; esac
done
[[ -n "$DEPLOYMENT_TARGET_FLAG" ]] \
  || { echo 'SDK compile configuration records no -mmacos-version-min' >&2; exit 1; }

# --- Objective-C ARC ----------------------------------------------------------
# Which sources need ARC is read out of BUILD.gn rather than restated here.
# The two must agree exactly: a file compiled without ARC that expects it fails
# loudly (`#error ... requires Objective-C ARC`), but the reverse -- a manual
# retain/release file compiled WITH ARC -- is a silent lifetime change.
ARC_SOURCES="$(python3 - "$SCRIPT_DIR/BUILD.gn" <<'ARC'
import re, sys

text = open(sys.argv[1], encoding='utf-8').read()
arc = set()
for match in re.finditer(r'^\w+\("([^"]+)"\) \{(.*?)\n\}', text, re.S | re.M):
    body = match.group(2)
    if 'fobjc-arc' not in body:
        continue
    sources = re.search(r'sources = \[(.*?)\]', body, re.S)
    if not sources:
        continue
    for name in re.findall(r'"([^"]+)"', sources.group(1)):
        if name.endswith('.mm'):
            arc.add(name)
if not arc:
    raise SystemExit('BUILD.gn declares no ARC sources; the parser is out of date')
print('\n'.join(sorted(arc)))
ARC
)"
needs_arc() {
  local candidate="$1"
  grep -qxF "$candidate" <<< "$ARC_SOURCES"
}

# --- sources ------------------------------------------------------------------
# Each shipped component is one `main` plus the shared implementation. Rather
# than restating the GN graph's 47 targets -- a translation that would drift
# silently -- every non-main source is compiled once into a single archive and
# each component links the subset it actually references.
MAIN_SOURCES=(
  macos_remote_desktop_worker_main.mm
  macos_launch_agent_main.mm
  macos_remote_desktop_disclosure_main.mm
  macos_virtual_display_helper_main.mm
)
# Not components of the remote desktop: the build spike is a probe, and the
# aiDesk agent is the app bundle's entry point and links none of this.
EXCLUDED_SOURCES=( build_spike.mm aidesk_agent_main.mm )

is_excluded() {
  local candidate="$1" entry
  for entry in "${MAIN_SOURCES[@]}" "${EXCLUDED_SOURCES[@]}"; do
    [[ "$candidate" == "$entry" ]] && return 0
  done
  return 1
}

rm -rf "$ARTIFACT_ROOT"
mkdir -p "$ARTIFACT_ROOT/obj"

SHARED_SOURCES=()
for source in "$SCRIPT_DIR"/*.cc "$SCRIPT_DIR"/*.mm "$COMMON_DIR"/*.cc; do
  [[ -f "$source" ]] || continue
  is_excluded "$(basename "$source")" && continue
  SHARED_SOURCES+=("$source")
done
[[ ${#SHARED_SOURCES[@]} -gt 0 ]] || { echo 'no component sources were found' >&2; exit 1; }

# A clang response file rather than an exported variable. Passing 145 flags
# through `xargs` means re-quoting them in a subshell, and a flag lost that way
# does not announce itself -- dropping the two `-isystem` libc++ paths just
# made every `#include <cstddef>` fail, which reads like a broken toolchain.
# `@file` hands clang the exact argument list, once.
RESPONSE_FILE="$ARTIFACT_ROOT/compile-flags.rsp"
printf '%s\n' "${SDK_FLAGS[@]}" > "$RESPONSE_FILE"
ARC_RESPONSE_FILE="$ARTIFACT_ROOT/compile-flags-arc.rsp"
{ printf '%s\n' "${SDK_FLAGS[@]}"; echo '-fobjc-arc'; } > "$ARC_RESPONSE_FILE"

echo "compiling ${#SHARED_SOURCES[@]} sources with $JOBS jobs"
COMPILE_LIST="$ARTIFACT_ROOT/compile.list"
: > "$COMPILE_LIST"
for source in "${SHARED_SOURCES[@]}"; do
  if needs_arc "$(basename "$source")"; then
    printf '%s\t%s\n' "$ARC_RESPONSE_FILE" "$source" >> "$COMPILE_LIST"
  else
    printf '%s\t%s\n' "$RESPONSE_FILE" "$source" >> "$COMPILE_LIST"
  fi
done
tr '\n' '\0' < "$COMPILE_LIST" \
  | CLANG="$CLANG" OBJECT_DIR="$ARTIFACT_ROOT/obj" \
    xargs -0 -P "$JOBS" -I {} \
    bash -c 'entry="$1"; rsp="${entry%%$'"'"'\t'"'"'*}"; src="${entry#*$'"'"'\t'"'"'}"; \
      "$CLANG" --driver-mode=g++ "@$rsp" -c "$src" \
        -o "$OBJECT_DIR/$(basename "${src%.*}").o"' _ {}

SHARED_ARCHIVE="$ARTIFACT_ROOT/obj/libimcodes_macos_remote_desktop.a"
"$LLVM_AR" crs "$SHARED_ARCHIVE" "$ARTIFACT_ROOT/obj"/*.o

# --- link ---------------------------------------------------------------------
FRAMEWORKS=(
  AppKit ApplicationServices AudioToolbox AVFoundation CoreAudio CoreFoundation
  CoreGraphics CoreMedia CoreServices CoreVideo Foundation IOKit IOSurface
  Metal QuartzCore ScreenCaptureKit Security SystemConfiguration VideoToolbox
)
LINK_FRAMEWORKS=()
for framework in "${FRAMEWORKS[@]}"; do LINK_FRAMEWORKS+=( -framework "$framework" ); done
# `libs = [ "bsm" ]` in BUILD.gn: the peer-identity code reads an audit token to
# establish who is on the other end of a connection, and audit_token_to_pid and
# friends live in libbsm rather than in any framework.
LINK_FRAMEWORKS+=( -lbsm )

link_component() {
  local main_source="$1" output="$2"
  local main_object="$ARTIFACT_ROOT/obj/main_$(basename "${main_source%.*}").o"
  local main_rsp="$RESPONSE_FILE"
  needs_arc "$main_source" && main_rsp="$ARC_RESPONSE_FILE"
  "$CLANG" --driver-mode=g++ "@$main_rsp" -c "$SCRIPT_DIR/$main_source" -o "$main_object"
  "$CLANG" --driver-mode=g++ \
    "--target=$TARGET_TRIPLE" -isysroot "$SYSROOT" "$DEPLOYMENT_TARGET_FLAG" \
    -fuse-ld=lld -B "$SDK_ROOT/toolchain/bin" -nostdlib++ \
    "$main_object" "$SHARED_ARCHIVE" \
    "$SDK_ROOT/lib/libwebrtc.a" \
    "$SDK_ROOT/lib/libjsoncpp.a" \
    "$SDK_ROOT/lib/libimcodes_macos_libcxx_runtime_sdk.a" \
    "$SDK_ROOT/toolchain/lib/libclang_rt.osx.a" \
    "${LINK_FRAMEWORKS[@]}" \
    -o "$ARTIFACT_ROOT/$output"
  # Thin, always: the runtime verifier rejects a fat Mach-O, and the build plan
  # declares universalBinary = false.
  local described
  described="$(lipo -info "$ARTIFACT_ROOT/$output")"
  [[ "$described" == *"is architecture: $MACHO_ARCH" ]] \
    || { echo "linked $output is not thin $MACHO_ARCH: $described" >&2; exit 1; }
  # Read back from the Mach-O, because the flag being on the command line is
  # not evidence the load command carries it.
  local expected_minos="${DEPLOYMENT_TARGET_FLAG#-mmacos-version-min=}"
  local actual_minos
  actual_minos="$(otool -l "$ARTIFACT_ROOT/$output" | awk '/^ *minos /{print $2; exit}')"
  [[ "$actual_minos" == "$expected_minos" ]] \
    || { echo "linked $output announces minos $actual_minos, expected $expected_minos" >&2; exit 1; }
  echo "component=$ARTIFACT_ROOT/$output"
}

link_component macos_remote_desktop_worker_main.mm imcodes-remote-desktop-worker
link_component macos_launch_agent_main.mm imcodes-remote-desktop-launch-agent
link_component macos_remote_desktop_disclosure_main.mm imcodes-remote-desktop-disclosure
link_component macos_virtual_display_helper_main.mm imcodes-virtual-display-helper

echo "built the macOS remote-desktop components for $TARGET_CPU at $ARTIFACT_ROOT"
