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
# That same switch also suppresses the one-time bootstrap `update_depot_tools`
# would have performed, which is what writes `python3_bin_reldir.txt` -- and
# without that file depot_tools' own `python3` shim refuses to run. The failure
# surfaces nowhere near here: the checkout syncs completely and then a late
# gclient hook dies with "need to initialize depot_tools". `ensure_bootstrap`
# is the supported way to do only the bootstrap, explicitly documented as
# working on the current checkout without updating the repository.
if [[ ! -f "$DEPOT_TOOLS/python3_bin_reldir.txt" ]]; then
  "$DEPOT_TOOLS/ensure_bootstrap"
fi

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

# --- root BUILD.gn visibility seam ----------------------------------------
# `//:webrtc` restricts itself to the root target and the link test:
#
#     rtc_static_library("webrtc") {
#       # Only the root target and the test should depend on this.
#       visibility = [ "//:default", "//:webrtc_lib_link_test" ]
#
# so depending on it from anywhere else fails `gn gen` outright with "can not
# depend on //:webrtc ... not in visibility list". The product build hit the
# same wall and opened the same seam, transiently, restoring the file on the
# way out; this does exactly that rather than inventing a second mechanism.
# The whole point of depending on `//:webrtc` is that it is definitionally the
# set the product links -- a curated label list would drift from it silently.
ROOT_BUILD="$WEBRTC_ROOT/BUILD.gn"
[[ -f "$ROOT_BUILD" ]] || { echo "pinned WebRTC checkout has no BUILD.gn: $ROOT_BUILD" >&2; exit 1; }
ROOT_BUILD_BACKUP="$(mktemp "${TMPDIR:-/tmp}/imcodes-sdk-root-build.XXXXXX")"
cp -p "$ROOT_BUILD" "$ROOT_BUILD_BACKUP"
restore_root_build() {
  if [[ -f "$ROOT_BUILD_BACKUP" ]]; then
    cp -p "$ROOT_BUILD_BACKUP" "$ROOT_BUILD"
    rm -f "$ROOT_BUILD_BACKUP"
  fi
}
# The patch must outlive `gn gen`: ninja re-runs generation whenever a BUILD.gn
# is newer than build.ninja, so restoring early makes the very next ninja
# invocation regenerate against the unpatched file and fail.
trap restore_root_build EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

python3 - "$ROOT_BUILD" "//$OVERLAY_RELATIVE:imcodes_macos_libwebrtc_sdk" <<'PATCH'
import sys

path, label = sys.argv[1:3]
with open(path, encoding='utf-8') as handle:
    source = handle.read()

needle = (
    '    visibility = [\n'
    '      "//:default",\n'
    '      "//:webrtc_lib_link_test",\n'
    '    ]'
)
# Checked before the seam, because a previous run that died without restoring
# leaves the seam already widened -- and reporting that as "seam missing" would
# send the next reader looking for an upstream change that never happened.
if label in source:
    raise SystemExit(
        'root BUILD.gn already names the SDK target: an earlier run did not '
        'restore it. Restore it from git before building.'
    )
# Uniqueness is the whole safety argument: a textual patch that matched twice,
# or zero times, would silently produce a different graph than the one this
# script claims to build.
if source.count(needle) != 1:
    raise SystemExit(
        'pinned WebRTC root BUILD.gn does not contain the expected unique '
        ':webrtc visibility seam'
    )

replacement = needle[:-len('    ]')] + f'      "{label}",\n    ]'
with open(path, 'w', encoding='utf-8') as handle:
    handle.write(source.replace(needle, replacement))
PATCH

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
# The payload is upstream's OWN archive, not the wrapper target above.
#
# `//:webrtc` is itself declared `complete_static_lib`, and GN does not
# re-expand a complete_static_lib dependency -- it treats it as a terminal
# artifact. So the wrapper's archive contains exactly one object, its anchor,
# and weighs two kilobytes. It builds, it stages, it publishes, and it links
# against nothing. `obj/libwebrtc.a` is the 400MB+ archive the product's
# `deps = [ "//:webrtc" ]` actually resolves to, which is the whole point of
# depending on that label rather than a curated list.
rm -rf "$ARTIFACT_ROOT"
mkdir -p "$ARTIFACT_ROOT/lib" "$ARTIFACT_ROOT/include" "$ARTIFACT_ROOT/gen" \
  "$ARTIFACT_ROOT/toolchain/bin" "$ARTIFACT_ROOT/toolchain/lib"

WEBRTC_ARCHIVE="$BUILD_DIR/obj/libwebrtc.a"
[[ -f "$WEBRTC_ARCHIVE" ]] || { echo "upstream archive missing: $WEBRTC_ARCHIVE" >&2; exit 1; }
# A floor, not a checksum: the failure this guards against produced a valid,
# well-formed, two-kilobyte archive that everything downstream accepted.
ARCHIVE_BYTES="$(stat -f %z "$WEBRTC_ARCHIVE")"
MINIMUM_ARCHIVE_BYTES=$((100 * 1024 * 1024))
[[ "$ARCHIVE_BYTES" -ge "$MINIMUM_ARCHIVE_BYTES" ]] || {
  echo "upstream archive is implausibly small ($ARCHIVE_BYTES bytes): the SDK would link against nothing" >&2
  exit 1
}
install -m 0644 "$WEBRTC_ARCHIVE" "$ARTIFACT_ROOT/lib/libwebrtc.a"

TEST_ARCHIVE="$BUILD_DIR/obj/$OVERLAY_RELATIVE/libimcodes_macos_libwebrtc_test_sdk.a"
[[ -f "$TEST_ARCHIVE" ]] || { echo "test archive missing: $TEST_ARCHIVE" >&2; exit 1; }
install -m 0644 "$TEST_ARCHIVE" "$ARTIFACT_ROOT/lib/libimcodes_macos_libwebrtc_test_sdk.a"

# --- headers ------------------------------------------------------------------
# Taken from the same checkout that produced the objects, so the two can never
# describe different APIs.
copy_headers() {
  local root="$1" extensionless="$2"
  [[ -d "$WEBRTC_ROOT/$root" ]] || { echo "pinned SDK header root is missing: $root" >&2; exit 1; }
  local predicate=( -name '*.h' -o -name '*.hpp' -o -name '*.inc' )
  # libc++ ships its public headers with no extension at all -- <vector>,
  # <string>, <__config>. An extension filter silently produces a toolchain
  # that cannot compile `#include <vector>`.
  if [[ "$extensionless" == "extensionless" ]]; then
    predicate+=( -o ! -name '*.*' )
  fi
  ( cd "$WEBRTC_ROOT" && find "$root" -type f \( "${predicate[@]}" \) -print0 ) \
    | ( cd "$WEBRTC_ROOT" && tar --null -cf - -T - ) \
    | ( cd "$ARTIFACT_ROOT/include" && tar -xf - )
}

for header_root in api call common_audio common_video logging media modules net p2p pc \
  rtc_base sdk system_wrappers test testing/gmock testing/gtest \
  third_party/abseil-cpp third_party/boringssl third_party/crc32c third_party/googletest \
  third_party/jsoncpp third_party/libyuv/include third_party/perfetto/include; do
  copy_headers "$header_root" with-extensions
done
for header_root in buildtools/third_party/libc++ third_party/libc++/src/include; do
  copy_headers "$header_root" extensionless
done

# Two files the consumer's every translation unit reaches through, and whose
# absence shows up as an incomprehensible error deep inside <type_traits>.
for required in buildtools/third_party/libc++/__config_site third_party/libc++/src/include/__config; do
  [[ -f "$ARTIFACT_ROOT/include/$required" ]] \
    || { echo "staged headers are missing $required" >&2; exit 1; }
done

# Generated headers live only in the build directory and are as much part of
# the API as the checked-in ones.
( cd "$BUILD_DIR/gen" && find . -type f \( -name '*.h' -o -name '*.hpp' -o -name '*.inc' \) -print0 ) \
  | ( cd "$BUILD_DIR/gen" && tar --null -cf - -T - ) \
  | ( cd "$ARTIFACT_ROOT/gen" && tar -xf - )

# --- toolchain ----------------------------------------------------------------
# The objects above were compiled by Chromium's clang against Chromium's
# bundled libc++, which lives in the `std::__Cr` inline namespace. A consumer
# built with Apple clang and the system libc++ produces mangled names that do
# not match a single symbol in the archive, and the link fails with thousands
# of undefined references that look like a missing library. So the compiler
# travels with the objects, exactly as it does on Windows.
LLVM_ROOT="$WEBRTC_ROOT/third_party/llvm-build/Release+Asserts"
[[ -d "$LLVM_ROOT" ]] || { echo "pinned clang toolchain is missing: $LLVM_ROOT" >&2; exit 1; }
# In the checkout, `clang++`, `ld64.lld`, `lld-link` and `clang-cl` are all
# symlinks to two real binaries -- clang and lld -- which decide what to be
# from argv[0]. The SDK manifest refuses links, and dereferencing every name
# would stage the same 103MB and 77MB binaries twice, adding ~185MB to an
# archive that CI downloads on every cache miss.
#
# So each real binary is staged exactly once, under the name that selects the
# behaviour we need: `ld64.lld` IS lld's Mach-O driver, and it must carry that
# name for clang's `-fuse-ld=lld` to find it. There is no `clang++`; the
# consumer drives C++ with `clang --driver-mode=g++`, which is precisely what
# the `clang++` symlink would have done.
#
# Deliberately not llvm-ranlib: this toolchain does not ship one. `llvm-ar s`
# does the same job, and the consumer never invokes ranlib separately.
stage_tool() {
  local source_name="$1" staged_name="$2"
  [[ -e "$LLVM_ROOT/bin/$source_name" ]] \
    || { echo "pinned toolchain has no $source_name" >&2; exit 1; }
  cp -L "$LLVM_ROOT/bin/$source_name" "$ARTIFACT_ROOT/toolchain/bin/$staged_name"
  chmod 0755 "$ARTIFACT_ROOT/toolchain/bin/$staged_name"
}
stage_tool clang clang
stage_tool ld64.lld ld64.lld
stage_tool llvm-ar llvm-ar
stage_tool llvm-strip llvm-strip

CLANG_REVISION="$(cat "$LLVM_ROOT/cr_build_revision")"
[[ -n "$CLANG_REVISION" ]] || { echo 'pinned toolchain has no cr_build_revision' >&2; exit 1; }
CLANG_MAJOR="$(basename "$(find "$LLVM_ROOT/lib/clang" -mindepth 1 -maxdepth 1 -type d | head -1)")"
[[ -n "$CLANG_MAJOR" ]] || { echo 'pinned toolchain has no versioned clang resource directory' >&2; exit 1; }

# The compiler's own resource headers (stddef.h, stdarg.h, immintrin.h ...).
# They are version-locked to the binary above, which is why they ship with it
# rather than being taken from the host.
mkdir -p "$ARTIFACT_ROOT/toolchain/lib/clang/$CLANG_MAJOR"
( cd "$LLVM_ROOT/lib/clang/$CLANG_MAJOR" && find include -type f -print0 ) \
  | ( cd "$LLVM_ROOT/lib/clang/$CLANG_MAJOR" && tar --null -cf - -T - ) \
  | ( cd "$ARTIFACT_ROOT/toolchain/lib/clang/$CLANG_MAJOR" && tar -xf - )
for required in stddef.h stdarg.h __stddef_max_align_t.h; do
  [[ -f "$ARTIFACT_ROOT/toolchain/lib/clang/$CLANG_MAJOR/include/$required" ]] \
    || { echo "staged toolchain headers are missing $required" >&2; exit 1; }
done
install -m 0644 "$LLVM_ROOT/lib/clang/$CLANG_MAJOR/lib/darwin/libclang_rt.osx.a" \
  "$ARTIFACT_ROOT/toolchain/lib/libclang_rt.osx.a"

# Uniform modes, so the archive digest describes the tree and not the umask
# of whichever account happened to run the build.
find "$ARTIFACT_ROOT" -type f ! -path "$ARTIFACT_ROOT/toolchain/bin/*" -exec chmod 0644 {} +

# --- third-party notices ------------------------------------------------------
# Generated here, not restated: the inventory comes from the same generated GN
# graph the objects came from, so a pin that pulls in an unmapped third-party
# tree fails the build instead of shipping notices that are quietly incomplete.
#
# This must run while the root BUILD.gn visibility seam is still open. `gn desc`
# reloads the whole graph, and with the seam closed the overlay's
# `deps = [ "//:webrtc" ]` is rejected exactly as it is during `gn gen` -- the
# seam is restored by the EXIT trap, so anywhere in the script body is inside it.
#
# The target set is `sdk`, whose single label is `//:webrtc`: the archive staged
# above is upstream's own, and the overlay wrapper is a two-kilobyte anchor
# whose closure would certify nothing. The LLVM toolchain and bundled libc++
# staged into toolchain/ and include/ have no GN edge at all; the generator's
# required-redistributed set covers them, the same way the Windows SDK
# generator's REQUIRED_REDISTRIBUTED_LIBRARIES covers its own exported clang.
NOTICES_GENERATOR="$REPOSITORY_ROOT/scripts/generate-macos-libwebrtc-notices.py"
NOTICES_OUTPUT="$ARTIFACT_ROOT/THIRD_PARTY_NOTICES.webrtc.md"
[[ -f "$NOTICES_GENERATOR" ]] \
  || { echo "macOS notices generator is missing: $NOTICES_GENERATOR" >&2; exit 1; }
# The generator shells out to gn itself, and wants the binary rather than the
# `gn` the shell would resolve per invocation.
GN_BIN="$(command -v gn || true)"
[[ -n "$GN_BIN" ]] || { echo 'gn is not on PATH: depot_tools did not initialize' >&2; exit 1; }
# vpython3, not python3: depot_tools' managed interpreter is the one the pinned
# checkout's own tooling is validated against, and it is what the Windows
# producer invokes its generator with.
command -v vpython3 >/dev/null \
  || { echo 'vpython3 is not on PATH: depot_tools did not initialize' >&2; exit 1; }
vpython3 "$NOTICES_GENERATOR" \
  --webrtc-root "$WEBRTC_ROOT" \
  --build-directory "$BUILD_DIR" \
  --gn "$GN_BIN" \
  --revision "$REVISION" \
  --target-set sdk \
  --target "//:webrtc" \
  --output "$NOTICES_OUTPUT"
# The generator writes atomically, so "nothing there" and "empty" both mean it
# did not get far enough to produce an inventory -- and the staging contract
# requires this file, so a silent miss would only surface at publish time.
[[ -s "$NOTICES_OUTPUT" ]] \
  || { echo "macOS SDK notices generation produced no output: $NOTICES_OUTPUT" >&2; exit 1; }
# Written after the uniform-mode pass above, so it normalizes its own mode.
chmod 0644 "$NOTICES_OUTPUT"

# --- build metadata -----------------------------------------------------------
# The host Xcode still supplies the macOS SDK -- system headers and frameworks
# -- so both versions are recorded and checked by the consumer. The clang
# revision is read from the toolchain rather than restated, which is one
# transcription the Windows producer still carries as a literal.
# Diagnosable on failure. An earlier revision sent xcodebuild's stderr to
# /dev/null, and when one run died in this region it left no trace at all: a
# complete staging tree, no sdk-build.json, no message, exit status lost. What
# the cause was is still unknown -- which is the point. Nothing here discards
# an error stream, and each probe says which one failed.
if ! XCODE_RAW="$(xcodebuild -version 2>&1)"; then
  echo "xcodebuild -version failed: $XCODE_RAW" >&2
  exit 1
fi
XCODE_VERSION="$(printf '%s\n' "$XCODE_RAW" | awk 'NR == 1 { print $2 }')"
if ! MACOS_SDK_VERSION="$(xcrun --show-sdk-version 2>&1)"; then
  echo "xcrun --show-sdk-version failed: $MACOS_SDK_VERSION" >&2
  exit 1
fi
[[ -n "$XCODE_VERSION" ]] || { echo "could not parse an Xcode version from: $XCODE_RAW" >&2; exit 1; }
[[ -n "$MACOS_SDK_VERSION" ]] || { echo 'xcrun reported an empty macOS SDK version' >&2; exit 1; }

# The staged clang is the BUILD HOST's binary, not the target's. Both SDKs are
# produced on Apple silicon, so the x64 SDK ships an arm64 compiler that
# cross-compiles -- correct, and unusable on an Intel builder, where it fails
# with a "bad CPU type" the consumer cannot otherwise explain. Recorded so the
# consumer can refuse it by name instead.
TOOLCHAIN_HOST_ARCH="$(uname -m)"
[[ -n "$TOOLCHAIN_HOST_ARCH" ]] || { echo 'could not determine the build host architecture' >&2; exit 1; }

python3 - "$ARTIFACT_ROOT/sdk-build.json" "$REVISION" "$DEPOT_TOOLS_REVISION" \
  "$TARGET_CPU" "$GN_ARGS" "$XCODE_VERSION" "$MACOS_SDK_VERSION" "$CLANG_REVISION" \
  "$TOOLCHAIN_HOST_ARCH" <<'METADATA'
import json, sys

(path, revision, depot_tools, target_cpu, build_args,
 xcode, macos_sdk, clang, host_arch) = sys.argv[1:10]
with open(path, 'w', encoding='utf-8') as handle:
    json.dump({
        'manifestVersion': 1,
        'os': 'darwin',
        'arch': 'arm64' if target_cpu == 'arm64' else 'x64',
        'libwebrtcRevision': revision,
        'depotToolsRevision': depot_tools,
        'buildArgs': build_args,
        'toolchain': {
            'xcode': xcode,
            'macosSdk': macos_sdk,
            'clang': clang,
            'hostArch': host_arch,
        },
    }, handle, indent=2)
METADATA
chmod 0644 "$ARTIFACT_ROOT/sdk-build.json"

echo "sdk=$ARTIFACT_ROOT"
echo "built the macOS libwebrtc SDK for $TARGET_CPU at $ARTIFACT_ROOT"
