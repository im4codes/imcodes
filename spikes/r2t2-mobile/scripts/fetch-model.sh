#!/usr/bin/env bash
# Download the pinned R2T2 GGUF pair into the gitignored cache and verify
# size + SHA-256. Reuses an existing Hugging Face cache copy when present.
#   HF_ENDPOINT=https://hf-mirror.com scripts/fetch-model.sh   # optional mirror
# The weights are licensed under the NetEase Youdao Model Use License Agreement:
#   https://raw.githubusercontent.com/netease-youdao/Confucius4-R2T2/refs/heads/master/MODEL_LICENSE
source "$(dirname "$0")/common.sh"
mkdir -p "$MODEL_DIR"
endpoint="${HF_ENDPOINT:-https://huggingface.co}"
hf_snapshot="$HOME/.cache/huggingface/hub/models--${R2T2_GGUF_REPO//\//--}/snapshots/$R2T2_GGUF_REVISION"

fetch() {  # file sha256 size
  local file=$1 sha=$2 size=$3 dest="$MODEL_DIR/$1"
  if [ ! -e "$dest" ] && [ -f "$hf_snapshot/$file" ]; then ln -s "$hf_snapshot/$file" "$dest"; fi
  if [ ! -e "$dest" ]; then
    curl -fL --retry 3 -C - -o "$dest.part" "$endpoint/$R2T2_GGUF_REPO/resolve/$R2T2_GGUF_REVISION/$file"
    mv "$dest.part" "$dest"
  fi
  local actual_size; actual_size=$(stat -L -f %z "$dest" 2>/dev/null || stat -L -c %s "$dest")
  [ "$actual_size" = "$size" ] || { echo "size mismatch for $file: $actual_size != $size" >&2; exit 1; }
  echo "$sha  $dest" | shasum -a 256 -c -
}
fetch "$R2T2_MODEL_FILE" "$R2T2_MODEL_SHA256" "$R2T2_MODEL_SIZE"
fetch "$R2T2_MMPROJ_FILE" "$R2T2_MMPROJ_SHA256" "$R2T2_MMPROJ_SIZE"
