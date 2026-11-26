#!/usr/bin/env bash
# Fetch pinned sources: llama.cpp @ b10950, upstream R2T2 @ pinned commit, and the
# official llama.cpp release xcframework (SHA-256 verified). Idempotent.
source "$(dirname "$0")/common.sh"
mkdir -p "$CACHE_DIR"

checkout() {  # repo dir commit
  local repo=$1 dir=$2 commit=$3
  if [ ! -d "$dir/.git" ]; then git clone --filter=blob:none "$repo" "$dir"; fi
  git -C "$dir" fetch --quiet origin "$commit" 2>/dev/null || git -C "$dir" fetch --quiet origin
  git -C "$dir" checkout --quiet --detach "$commit"
  [ "$(git -C "$dir" rev-parse HEAD)" = "$commit" ] || { echo "pin mismatch in $dir" >&2; exit 1; }
  echo "$dir @ $(git -C "$dir" rev-parse HEAD)"
}
checkout "$LLAMA_CPP_REPO" "$LLAMA_DIR" "$LLAMA_CPP_COMMIT"
checkout "$R2T2_REPO" "$UPSTREAM_DIR" "$R2T2_COMMIT"

zip="$CACHE_DIR/llama-$LLAMA_CPP_TAG-xcframework.zip"
if [ ! -f "$zip" ]; then curl -fL --retry 3 -o "$zip.part" "$LLAMA_XCFRAMEWORK_URL" && mv "$zip.part" "$zip"; fi
echo "$LLAMA_XCFRAMEWORK_SHA256  $zip" | shasum -a 256 -c -
if [ ! -d "$CACHE_DIR/xcframework/build-apple/llama.xcframework" ]; then
  rm -rf "$CACHE_DIR/xcframework" && mkdir -p "$CACHE_DIR/xcframework"
  unzip -q "$zip" -d "$CACHE_DIR/xcframework"
fi
ls "$CACHE_DIR/xcframework/build-apple/llama.xcframework"

# KleidiAI source for Arm CPU builds (FETCHCONTENT_SOURCE_DIR_KLEIDIAI).
kz="$CACHE_DIR/kleidiai-$KLEIDIAI_TAG-src.tar.gz"
if [ ! -f "$kz" ]; then curl -fL --retry 3 -o "$kz.part" "$KLEIDIAI_URL" && mv "$kz.part" "$kz"; fi
[ "$(md5 -q "$kz" 2>/dev/null || md5sum "$kz" | cut -d' ' -f1)" = "$KLEIDIAI_MD5" ] || { echo "kleidiai md5 mismatch" >&2; exit 1; }
if [ ! -f "$CACHE_DIR/kleidiai/CMakeLists.txt" ]; then
  rm -rf "$CACHE_DIR/kleidiai" && mkdir -p "$CACHE_DIR/kleidiai" && tar -xzf "$kz" -C "$CACHE_DIR/kleidiai" --strip-components=1
fi
echo "kleidiai $KLEIDIAI_TAG at $CACHE_DIR/kleidiai"
