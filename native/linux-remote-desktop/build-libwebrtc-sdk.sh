#!/usr/bin/env bash
# Build the immutable Linux libwebrtc foundation SDK for one architecture.
#
# Mirrors native/macos-remote-desktop/build-libwebrtc-sdk.sh and
# native/windows-remote-desktop/build-libwebrtc-sdk.ps1: a pinned WebRTC
# checkout is built ONCE against a curated dependency list (this repo's own
# X11 adapters supply capture, input and clipboard; the initial worker has no
# bespoke hardware encoder, so it uses libwebrtc's OWN builtin video encoder
# factory rather than injecting one -- see libwebrtc-sdk.gni), archived, and
# consumed from then on.
#
# Linux uses a curated GN dependency list (like Windows), not `//:webrtc`
# (macOS only): there is no Apple-style monolithic root target here, so
# `gn gen --root-target=` needs no transient patch to WebRTC's own root
# BUILD.gn visibility list the way the macOS producer does.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PIN_FILE="$REPOSITORY_ROOT/shared/remote-desktop-native-pins.json"

CHECKOUT_ROOT=""
ARTIFACT_ROOT=""
TARGET_CPU="x64"
JOBS="$(nproc 2>/dev/null || echo 4)"
SKIP_SYNC=0

usage() {
  cat >&2 <<'USAGE'
usage: build-libwebrtc-sdk.sh --checkout-root DIR --artifact-root DIR
                             [--target-cpu x64] [--jobs N] [--skip-sync]

  --checkout-root  Dedicated directory for depot_tools and the WebRTC checkout.
  --artifact-root  Dedicated directory for the produced SDK. Replaced wholesale.
  --target-cpu     Architecture to build. Default and only supported: x64.
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
case "$TARGET_CPU" in x64) ;; *) echo "--target-cpu must be x64" >&2; exit 2 ;; esac
[[ "$JOBS" =~ ^[0-9]+$ && "$JOBS" -ge 1 ]] || { echo "--jobs must be a positive integer" >&2; exit 2; }

for directory in "$CHECKOUT_ROOT" "$ARTIFACT_ROOT"; do
  [[ "$directory" != "/" && "$directory" == /* ]] \
    || { echo "paths must be absolute and not the filesystem root: $directory" >&2; exit 2; }
done

command -v python3 >/dev/null || { echo 'python3 is required to read the pin file' >&2; exit 1; }
[[ -n "${HOME:-}" && -d "${HOME:-}" ]] \
  || { echo 'HOME must be set to an existing directory: depot_tools bootstraps vpython and cipd into it' >&2; exit 1; }
REVISION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["libwebrtcRevision"])' "$PIN_FILE")"
DEPOT_TOOLS_REVISION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["depotToolsRevision"])' "$PIN_FILE")"
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid pinned WebRTC revision" >&2; exit 1; }
[[ "$DEPOT_TOOLS_REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid pinned depot_tools revision" >&2; exit 1; }

DEPOT_TOOLS="$CHECKOUT_ROOT/depot_tools"
WEBRTC_ROOT="$CHECKOUT_ROOT/src"
OVERLAY_RELATIVE="third_party/imcodes_linux_remote_desktop"
OVERLAY_DIR="$WEBRTC_ROOT/$OVERLAY_RELATIVE"
BUILD_DIR="$WEBRTC_ROOT/out/imcodes_linux_sdk_$TARGET_CPU"

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
export DEPOT_TOOLS_UPDATE=0

# depot_tools' own bootstrap (`ensure_bootstrap`) fetches a pinned Python via
# CIPD and writes python3_bin_reldir.txt to point at it. On a host whose
# system `python3` resolves (via an interactive shell's own PATH, e.g. a stale
# conda environment) to something older than 3.8, that bootstrap script itself
# fails to even run (`gsutil.py`'s use of `:=` is a SyntaxError below 3.8) --
# and every later `gn`/`autoninja` invocation then refuses outright with
# "python3_bin_reldir.txt not found". Point depot_tools at *some* real,
# reasonably modern system python3 directly rather than depending on its own
# bootstrap succeeding; this script never re-execs itself through that shim.
if [[ ! -f "$DEPOT_TOOLS/python3_bin_reldir.txt" ]]; then
  SYSTEM_PYTHON3="$(command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3.9 || command -v python3.8 || true)"
  [[ -n "$SYSTEM_PYTHON3" ]] \
    || { echo 'no python3.8+ found to bootstrap depot_tools (checked python3.8-3.12)' >&2; exit 1; }
  mkdir -p "$DEPOT_TOOLS/imcodes-system-python3-shim"
  ln -sf "$SYSTEM_PYTHON3" "$DEPOT_TOOLS/imcodes-system-python3-shim/python3"
  printf imcodes-system-python3-shim > "$DEPOT_TOOLS/python3_bin_reldir.txt"
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

GN_ARGS="target_os=\"linux\" target_cpu=\"$TARGET_CPU\" is_debug=false"
GN_ARGS="$GN_ARGS is_component_build=false rtc_include_tests=true"
GN_ARGS="$GN_ARGS rtc_build_examples=false rtc_enable_protobuf=false use_rtti=false"

# Curated deps need no root BUILD.gn visibility seam (unlike macOS's
# `//:webrtc`): graph discovery just starts at the overlay's own BUILD.gn.
( cd "$WEBRTC_ROOT" && gn gen "$BUILD_DIR" "--args=$GN_ARGS" "--root-target=//$OVERLAY_RELATIVE" )

# libc++/libc++abi objects and jsoncpp are named explicitly for the same
# reason the macOS script names them: nothing in this graph links a final
# binary, so the C++ runtime and jsoncpp (reached only transitively, through
# //native/remote-desktop-common in the PRODUCT build, not the SDK's own
# anchor) are never compiled for the target toolchain unless asked for here.
( cd "$WEBRTC_ROOT" && autoninja -C "$BUILD_DIR" -j "$JOBS" \
    "$OVERLAY_RELATIVE:imcodes_linux_libwebrtc_sdk" \
    "$OVERLAY_RELATIVE:imcodes_linux_libwebrtc_test_sdk" \
    "buildtools/third_party/libc++:libc++" \
    "buildtools/third_party/libc++abi:libc++abi" \
    "third_party/jsoncpp" )

# --- collect ------------------------------------------------------------------
rm -rf "$ARTIFACT_ROOT"
mkdir -p "$ARTIFACT_ROOT/lib" "$ARTIFACT_ROOT/include" "$ARTIFACT_ROOT/gen" \
  "$ARTIFACT_ROOT/toolchain/bin" "$ARTIFACT_ROOT/toolchain/lib"

LLVM_ROOT="$WEBRTC_ROOT/third_party/llvm-build/Release+Asserts"
[[ -d "$LLVM_ROOT" ]] || { echo "pinned clang toolchain is missing: $LLVM_ROOT" >&2; exit 1; }
LLVM_AR="$LLVM_ROOT/bin/llvm-ar"

SDK_ARCHIVE="$BUILD_DIR/obj/$OVERLAY_RELATIVE/libimcodes_linux_libwebrtc_sdk.a"
[[ -f "$SDK_ARCHIVE" ]] || { echo "SDK archive missing: $SDK_ARCHIVE" >&2; exit 1; }
# A floor, not a checksum: guards against a well-formed but empty-of-upstream
# archive (the anchor's own translation unit is a couple hundred bytes).
ARCHIVE_BYTES="$(stat -c %s "$SDK_ARCHIVE")"
MINIMUM_ARCHIVE_BYTES=$((30 * 1024 * 1024))
[[ "$ARCHIVE_BYTES" -ge "$MINIMUM_ARCHIVE_BYTES" ]] || {
  echo "SDK archive is implausibly small ($ARCHIVE_BYTES bytes): it would link against nothing" >&2
  exit 1
}
install -m 0644 "$SDK_ARCHIVE" "$ARTIFACT_ROOT/lib/libimcodes_linux_libwebrtc_sdk.a"

TEST_ARCHIVE="$BUILD_DIR/obj/$OVERLAY_RELATIVE/libimcodes_linux_libwebrtc_test_sdk.a"
[[ -f "$TEST_ARCHIVE" ]] || { echo "test archive missing: $TEST_ARCHIVE" >&2; exit 1; }
install -m 0644 "$TEST_ARCHIVE" "$ARTIFACT_ROOT/lib/libimcodes_linux_libwebrtc_test_sdk.a"

# The C++ runtime the objects were compiled against. libc++ is linked in at
# the final link step, not archived into the SDK's own static library, so
# every std::__Cr:: symbol is undefined until this archive is on the link
# line -- and the build's own libc++.a is a thin archive (paths into the
# build directory), so it is re-archived here into a real one that travels.
LIBCXX_OBJECTS=( "$BUILD_DIR"/obj/buildtools/third_party/libc++/libc++/*.o )
LIBCXXABI_OBJECTS=( "$BUILD_DIR"/obj/buildtools/third_party/libc++abi/libc++abi/*.o )
[[ ${#LIBCXX_OBJECTS[@]} -ge 40 && -f "${LIBCXX_OBJECTS[0]}" ]] \
  || { echo "pinned libc++ object set is incomplete (${#LIBCXX_OBJECTS[@]} objects)" >&2; exit 1; }
[[ ${#LIBCXXABI_OBJECTS[@]} -ge 10 && -f "${LIBCXXABI_OBJECTS[0]}" ]] \
  || { echo "pinned libc++abi object set is incomplete (${#LIBCXXABI_OBJECTS[@]} objects)" >&2; exit 1; }
LIBCXX_RUNTIME="$ARTIFACT_ROOT/lib/libimcodes_linux_libcxx_runtime_sdk.a"
rm -f "$LIBCXX_RUNTIME"
"$LLVM_AR" crs "$LIBCXX_RUNTIME" "${LIBCXX_OBJECTS[@]}" "${LIBCXXABI_OBJECTS[@]}"
[[ -s "$LIBCXX_RUNTIME" ]] || { echo 'libc++ runtime archive was not produced' >&2; exit 1; }
[[ "$(head -c 8 "$LIBCXX_RUNTIME")" == '!<arch>' ]] \
  || { echo 'libc++ runtime archive is thin and would not survive the trip out of the build directory' >&2; exit 1; }

# jsoncpp: upstream declares it `source_set("jsoncpp")`, which emits object
# files and no archive at all, so there is never one to copy.
JSONCPP_OBJECTS=( "$BUILD_DIR"/obj/third_party/jsoncpp/jsoncpp/*.o )
[[ ${#JSONCPP_OBJECTS[@]} -ge 3 && -f "${JSONCPP_OBJECTS[0]}" ]] \
  || { echo "pinned jsoncpp object set is incomplete (${#JSONCPP_OBJECTS[@]} objects)" >&2; exit 1; }
rm -f "$ARTIFACT_ROOT/lib/libjsoncpp.a"
"$LLVM_AR" crs "$ARTIFACT_ROOT/lib/libjsoncpp.a" "${JSONCPP_OBJECTS[@]}"

# Every shipped archive must be a real ELF x86-64 archive, not a thin one that
# references paths in the (about to be discarded) build directory.
for staged in "$ARTIFACT_ROOT/lib/libimcodes_linux_libwebrtc_sdk.a" \
  "$ARTIFACT_ROOT/lib/libimcodes_linux_libwebrtc_test_sdk.a" \
  "$LIBCXX_RUNTIME" "$ARTIFACT_ROOT/lib/libjsoncpp.a"; do
  [[ "$(head -c 8 "$staged")" == '!<arch>' ]] \
    || { echo "staged archive is not a real (non-thin) archive: $staged" >&2; exit 1; }
done

# --- headers ------------------------------------------------------------------
copy_headers() {
  local root="$1" extensionless="$2"
  [[ -d "$WEBRTC_ROOT/$root" ]] || { echo "pinned SDK header root is missing: $root" >&2; exit 1; }
  local predicate=( -name '*.h' -o -name '*.hpp' -o -name '*.inc' )
  if [[ "$extensionless" == "extensionless" ]]; then
    predicate+=( -o ! -name '*.*' )
  fi
  ( cd "$WEBRTC_ROOT" && find "$root" -type f \( "${predicate[@]}" \) -print0 ) \
    | ( cd "$WEBRTC_ROOT" && tar --null -cf - -T - ) \
    | ( cd "$ARTIFACT_ROOT/include" && tar -xf - )
}

for header_root in api call common_audio common_video logging media modules net p2p pc \
  rtc_base system_wrappers test testing/gmock testing/gtest \
  third_party/abseil-cpp third_party/boringssl third_party/crc32c third_party/googletest \
  third_party/jsoncpp third_party/libyuv/include third_party/perfetto/include; do
  copy_headers "$header_root" with-extensions
done
for header_root in buildtools/third_party/libc++ third_party/libc++/src/include \
  third_party/libc++abi/src/include; do
  copy_headers "$header_root" extensionless
done

for required in buildtools/third_party/libc++/__config_site third_party/libc++/src/include/__config; do
  [[ -f "$ARTIFACT_ROOT/include/$required" ]] \
    || { echo "staged headers are missing $required" >&2; exit 1; }
done

( cd "$BUILD_DIR/gen" && find . -type f \( -name '*.h' -o -name '*.hpp' -o -name '*.inc' \) -print0 ) \
  | ( cd "$BUILD_DIR/gen" && tar --null -cf - -T - ) \
  | ( cd "$ARTIFACT_ROOT/gen" && tar -xf - )

# --- toolchain ----------------------------------------------------------------
# The objects above were compiled by Chromium's pinned clang against
# Chromium's bundled libc++ (the `std::__Cr` inline namespace); a consumer
# built with the host's system clang/gcc and system libc++ produces mangled
# names that do not match a single symbol in the archive. So the compiler
# travels with the objects, exactly as on macOS and Windows.
stage_tool() {
  local source_name="$1" staged_name="$2"
  [[ -e "$LLVM_ROOT/bin/$source_name" ]] \
    || { echo "pinned toolchain has no $source_name" >&2; exit 1; }
  cp -L "$LLVM_ROOT/bin/$source_name" "$ARTIFACT_ROOT/toolchain/bin/$staged_name"
  chmod 0755 "$ARTIFACT_ROOT/toolchain/bin/$staged_name"
}
stage_tool clang clang
stage_tool lld lld
stage_tool llvm-ar llvm-ar
stage_tool llvm-strip llvm-strip
# clang's own -fuse-ld=lld looks for a binary literally named ld.lld on
# Linux (unlike lld-link on Windows or ld64.lld on macOS, both already exact
# matches for their driver's expected name). Staging it here means a
# consumer's compile recipe never has to know that and carry its own
# workaround symlink. A real copy, not a symlink: the SDK verifier rejects any
# symlink in the staged tree (collectSdkFiles in
# scripts/libwebrtc-sdk-artifacts.mjs), and an archive/extract round trip is
# not guaranteed to preserve one anyway.
cp -L "$ARTIFACT_ROOT/toolchain/bin/lld" "$ARTIFACT_ROOT/toolchain/bin/ld.lld"
chmod 0755 "$ARTIFACT_ROOT/toolchain/bin/ld.lld"

CLANG_MAJOR="$(basename "$(find "$LLVM_ROOT/lib/clang" -mindepth 1 -maxdepth 1 -type d | head -1)")"
[[ -n "$CLANG_MAJOR" ]] || { echo 'pinned toolchain has no versioned clang resource directory' >&2; exit 1; }
mkdir -p "$ARTIFACT_ROOT/toolchain/lib/clang/$CLANG_MAJOR"
( cd "$LLVM_ROOT/lib/clang/$CLANG_MAJOR" && find include -type f -print0 ) \
  | ( cd "$LLVM_ROOT/lib/clang/$CLANG_MAJOR" && tar --null -cf - -T - ) \
  | ( cd "$ARTIFACT_ROOT/toolchain/lib/clang/$CLANG_MAJOR" && tar -xf - )
for required in stddef.h stdarg.h; do
  [[ -f "$ARTIFACT_ROOT/toolchain/lib/clang/$CLANG_MAJOR/include/$required" ]] \
    || { echo "staged toolchain headers are missing $required" >&2; exit 1; }
done

# The Debian sysroot the pinned build compiled against -- glibc headers and a
# stable ABI floor independent of whichever distro/version this script runs
# on. Referenced by sdk-compile-flags.json's --sysroot flag below.
SYSROOT_SRC="$WEBRTC_ROOT/build/linux/debian_bullseye_amd64-sysroot"
[[ -d "$SYSROOT_SRC" ]] || { echo "pinned sysroot is missing: $SYSROOT_SRC" >&2; exit 1; }
mkdir -p "$ARTIFACT_ROOT/toolchain/sysroot"
# -L, not -a: a real Debian sysroot is full of internal symlinks (compat
# libs, systemd units, ...), and the SDK verifier rejects any symlink
# anywhere in the staged tree (collectSdkFiles in
# scripts/libwebrtc-sdk-artifacts.mjs) -- a rule shared with macOS/Windows,
# neither of which stages a redistributable sysroot at all, so loosening it
# for Linux would touch code an already-published SDK release depends on.
# Dereferencing here instead keeps that shared rule untouched and makes the
# staged sysroot fully self-contained besides.
cp -rL "$SYSROOT_SRC/." "$ARTIFACT_ROOT/toolchain/sysroot/"
# The sysroot tarball is Chromium's own sysroot-creator.py output: it
# installs real .deb packages into a rootfs and ships whatever that leaves
# behind, not a hand-picked compile surface. -isysroot/--sysroot only ever
# resolves headers and libraries under bin/sbin/lib/lib64/usr/etc, so the
# packaging-only trees below are dead weight a compile-time sysroot never
# needed -- and dead weight that actively breaks staging: `debian/` and
# `var/lib/dpkg` are dpkg/apt package metadata (not filesystem content),
# and among the (Python stdlib copies, docs, ...) apt pulled in along with
# the actual C libraries are enough Debian-packaging-only files to trip the
# SDK manifest's general corruption checks: systemd's own escaping
# convention names one unit file with a literal backslash (e.g.
# system-systemd\x2dcryptsetup.slice, rejected by
# file.path.includes('\\') in validateLibwebrtcSdkManifest -- a check aimed
# at a stray Windows-style path separator, not a legitimate POSIX filename
# character), and Python's own empty __init__.py/py.typed markers trip
# file.size <= 0 (a zero-byte file cannot be a header any translation unit's
# declarations depend on, nor a library with any symbols to link against,
# so the check is correct -- these files were never going to matter).
# Pruned rather than either manifest rule loosened, for the same "do not
# touch what an already-published SDK depends on" reason as the symlink
# dereference above.
for packaging_tree in debian .stamp var/lib/dpkg var/cache/apt lib/systemd usr/lib/systemd etc/systemd; do
  rm -rf "${ARTIFACT_ROOT:?}/toolchain/sysroot/${packaging_tree:?}"
done
find "$ARTIFACT_ROOT/toolchain/sysroot" -type f -empty -delete
REMAINING_BACKSLASH="$(find "$ARTIFACT_ROOT/toolchain/sysroot" -name '*\\*' | head -1)"
[[ -z "$REMAINING_BACKSLASH" ]] \
  || { echo "staged sysroot still has a backslash filename: $REMAINING_BACKSLASH" >&2; exit 1; }

find "$ARTIFACT_ROOT" -type f ! -path "$ARTIFACT_ROOT/toolchain/bin/*" -exec chmod 0644 {} +

# --- notices --------------------------------------------------------------
# Fail-closed third-party notices for exactly what the two archives above
# link, generated from the SAME pinned checkout and build directory this SDK
# was built from -- see generate-libwebrtc-sdk-notices.py's own comment for
# why this is its own file rather than an import of the Windows generator.
NOTICES_STAGING="$(mktemp -d)"
trap 'rm -rf "$NOTICES_STAGING"' EXIT
python3 "$SCRIPT_DIR/generate-libwebrtc-sdk-notices.py" \
  --webrtc-root "$WEBRTC_ROOT" \
  --build-directory "$BUILD_DIR" \
  --target "//$OVERLAY_RELATIVE:imcodes_linux_libwebrtc_sdk" \
  --target "//$OVERLAY_RELATIVE:imcodes_linux_libwebrtc_test_sdk" \
  --output-directory "$NOTICES_STAGING"
[[ -s "$NOTICES_STAGING/LICENSE.md" ]] || { echo 'libwebrtc SDK notices were not produced' >&2; exit 1; }
install -m 0644 "$NOTICES_STAGING/LICENSE.md" "$ARTIFACT_ROOT/THIRD_PARTY_NOTICES.webrtc.md"

# --- consumer compile configuration ---------------------------------------
# The exact flags a translation unit must be compiled with to link against
# these objects, taken from the anchor target's own ninja file -- the same
# mechanism and the same reasoning as the macOS/Windows producers: a consumer
# that guessed a define set compiles cleanly, links with no undefined
# symbols, and segfaults inside a WebRTC constructor.
ANCHOR_NINJA="$BUILD_DIR/obj/$OVERLAY_RELATIVE/imcodes_linux_libwebrtc_sdk.ninja"
[[ -f "$ANCHOR_NINJA" ]] || { echo "anchor ninja file missing: $ANCHOR_NINJA" >&2; exit 1; }

python3 - "$ANCHOR_NINJA" "$ARTIFACT_ROOT/sdk-compile-flags.json" <<'FLAGS'
import json, shlex, sys

ninja_path, output_path = sys.argv[1:3]

values = {}
with open(ninja_path, encoding='utf-8') as handle:
    for line in handle:
        for key in ('defines', 'include_dirs', 'cflags', 'cflags_cc'):
            prefix = f'{key} = '
            if line.startswith(prefix) and key not in values:
                values[key] = shlex.split(line[len(prefix):].strip())
for key in ('defines', 'include_dirs', 'cflags', 'cflags_cc'):
    if key not in values:
        raise SystemExit(f'anchor ninja file has no {key} line')

def sdk_relative(path):
    """Rewrite a build-directory-relative include into an SDK-relative one.

    ninja runs from the build directory, so `../..` is the checkout root --
    which is what was staged into `include/` -- and `gen` is the generated
    header tree staged into `gen/`.
    """
    if path == '../..':
        return 'include'
    if path.startswith('../../'):
        return 'include/' + path[len('../../'):]
    if path == 'gen':
        return 'gen'
    if path.startswith('gen/'):
        return path
    raise SystemExit(f'include path does not resolve inside the SDK: {path}')

includes, system_includes = [], []
for token in values['include_dirs']:
    if token.startswith('-I'):
        includes.append(sdk_relative(token[2:]))
    elif token.startswith('-isystem'):
        system_includes.append(sdk_relative(token[len('-isystem'):]))
    else:
        raise SystemExit(f'unexpected include_dirs token: {token}')

language_flags = []
for token in values['cflags_cc']:
    if token.startswith('-isystem'):
        system_includes.append(sdk_relative(token[len('-isystem'):]))
    elif token.startswith('--sysroot='):
        # Lives in cflags_cc, not cflags, for this anchor -- rewritten here
        # too so it does not travel through untouched as a build-directory
        # path (../../build/linux/...) that does not exist for a consumer.
        language_flags.append('--sysroot=toolchain/sysroot')
    else:
        language_flags.append(token)

# Flags naming a path in the build directory describe a tree the consumer does
# not have; the --sysroot argument is rewritten to the staged sysroot instead
# of dropped, unlike macOS's --isysroot (which relies on the consumer's own
# Xcode) -- Linux has no equivalent "ambient" sysroot to fall back on.
def travels(flag):
    return not any(part in flag for part in (
        'clang-crashreports', 'unsafe_buffers_paths',
    ))

filtered = []
skip_next = False
for flag in values['cflags']:
    if skip_next:
        skip_next = False
        continue
    if flag.startswith('--sysroot='):
        filtered.append('--sysroot=toolchain/sysroot')
        continue
    if not travels(flag):
        continue
    filtered.append(flag)

with open(output_path, 'w', encoding='utf-8') as handle:
    json.dump({
        'schemaVersion': 1,
        'defines': values['defines'],
        'includeDirs': includes,
        'systemIncludeDirs': system_includes,
        'compileFlags': filtered,
        'cxxFlags': language_flags,
    }, handle, indent=2)
FLAGS
chmod 0644 "$ARTIFACT_ROOT/sdk-compile-flags.json"
[[ -s "$ARTIFACT_ROOT/sdk-compile-flags.json" ]] \
  || { echo 'sdk-compile-flags.json was not produced' >&2; exit 1; }

# toolchain identity for the manifest below: read from the anchor's own
# defines rather than restated, same "the ninja file is the one source of
# truth" reasoning as the compile flags above.
read -r TOOLCHAIN_CLANG TOOLCHAIN_SYSROOT <<<"$(python3 - "$ANCHOR_NINJA" <<'TOOLCHAIN'
import shlex, sys

with open(sys.argv[1], encoding='utf-8') as handle:
    defines = next(line for line in handle if line.startswith('defines = '))
tokens = shlex.split(defines[len('defines = '):].strip())
values = {}
for token in tokens:
    if token.startswith('-DCR_CLANG_REVISION='):
        values['clang'] = token[len('-DCR_CLANG_REVISION='):].strip('"')
    elif token.startswith('-DCR_SYSROOT_KEY='):
        values['sysroot'] = token[len('-DCR_SYSROOT_KEY='):]
for key in ('clang', 'sysroot'):
    if key not in values:
        raise SystemExit(f'anchor ninja defines have no {key} marker')
print(values['clang'], values['sysroot'])
TOOLCHAIN
)"
[[ -n "$TOOLCHAIN_CLANG" && -n "$TOOLCHAIN_SYSROOT" ]] \
  || { echo 'could not read toolchain identity from the anchor ninja file' >&2; exit 1; }

# The exact GN args this SDK was built with, byte-for-byte what reached `gn`
# (bash already consumed the backslashes in GN_ARGS above, so this is plain
# double quotes -- see the "quoting differs per producer" comment in
# scripts/libwebrtc-sdk-targets.mjs, which compares this string verbatim).
# Written via json.dump, not a shell heredoc: GN_ARGS itself contains double
# quotes (target_os="linux"), which a plain `"$GN_ARGS"` heredoc interpolation
# drops into the JSON string unescaped and produces invalid JSON.
TARGET_CPU="$TARGET_CPU" REVISION="$REVISION" DEPOT_TOOLS_REVISION="$DEPOT_TOOLS_REVISION" \
GN_ARGS="$GN_ARGS" TOOLCHAIN_CLANG="$TOOLCHAIN_CLANG" TOOLCHAIN_SYSROOT="$TOOLCHAIN_SYSROOT" \
python3 - "$ARTIFACT_ROOT/sdk-build.json" <<'BUILD_JSON'
import json, os, sys

with open(sys.argv[1], 'w', encoding='utf-8') as handle:
    json.dump({
        'manifestVersion': 1,
        'os': 'linux',
        'arch': os.environ['TARGET_CPU'],
        'libwebrtcRevision': os.environ['REVISION'],
        'depotToolsRevision': os.environ['DEPOT_TOOLS_REVISION'],
        'buildArgs': os.environ['GN_ARGS'],
        'toolchain': {
            'clang': os.environ['TOOLCHAIN_CLANG'],
            'sysroot': os.environ['TOOLCHAIN_SYSROOT'],
        },
    }, handle, indent=2)
    handle.write('\n')
BUILD_JSON
chmod 0644 "$ARTIFACT_ROOT/sdk-build.json"

echo "built the Linux libwebrtc SDK for $TARGET_CPU at $ARTIFACT_ROOT"
