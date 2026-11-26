#!/usr/bin/env bash
# iOS llama.xcframework (Metal + mtmd) for the harness.
#
#   scripts/build-ios-xcframework.sh                     # official b10950 release asset (default, D1)
#   scripts/build-ios-xcframework.sh --from-source [--min-ios 15.0] [--slices "ios-device ios-sim"]
#
# The official asset is verified against PINS.env (SHA-256) and targets iOS
# 16.4+ (upstream's build-xcframework.sh hard-codes IOS_MIN_OS_VERSION=16.4).
# --from-source runs a patched copy of the pinned build-xcframework.sh with a
# different minimum iOS and capped parallelism, and writes
# .cache/xcframework-src/llama.xcframework.
source "$(dirname "$0")/common.sh"
mode=official; min_ios=16.4; slices="ios-device"
while [ $# -gt 0 ]; do
  case $1 in
    --from-source) mode=source ;;
    --min-ios) min_ios=$2; shift ;;
    --slices) slices=$2; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
if [ "$mode" = official ]; then
  "$SPIKE_DIR/scripts/fetch-deps.sh" >/dev/null
  echo "$CACHE_DIR/xcframework/build-apple/llama.xcframework"
  exit 0
fi
[ -d "$LLAMA_DIR/.git" ] || "$SPIKE_DIR/scripts/fetch-deps.sh"
patched="$LLAMA_DIR/.r2t2-build-xcframework.sh"
sed -e "s/^IOS_MIN_OS_VERSION=.*/IOS_MIN_OS_VERSION=$min_ios/" \
    -e "s/^JOBS_PER_BUILD=\$(( \$(sysctl -n hw.logicalcpu) \/ MAX_PARALLEL_BUILDS ))/JOBS_PER_BUILD=$JOBS/" \
    "$LLAMA_DIR/build-xcframework.sh" > "$patched"
chmod +x "$patched"
grep -q "^IOS_MIN_OS_VERSION=$min_ios" "$patched" && grep -q "^JOBS_PER_BUILD=$JOBS" "$patched"
( cd "$LLAMA_DIR" && ./.r2t2-build-xcframework.sh $slices )
rm -rf "$CACHE_DIR/xcframework-src" && mkdir -p "$CACHE_DIR/xcframework-src"
cp -R "$LLAMA_DIR/build-apple/llama.xcframework" "$CACHE_DIR/xcframework-src/"
echo "$CACHE_DIR/xcframework-src/llama.xcframework (min iOS $min_ios)"
