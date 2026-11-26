#!/usr/bin/env bash
# Shared paths/pins for the spike scripts. Source it; do not execute.
set -euo pipefail
SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${R2T2_CACHE_DIR:-$SPIKE_DIR/.cache}"
# shellcheck source=../PINS.env
source "$SPIKE_DIR/PINS.env"
LLAMA_DIR="$CACHE_DIR/llama.cpp"
UPSTREAM_DIR="$CACHE_DIR/r2t2-upstream"
MODEL_DIR="$CACHE_DIR/models/gguf"
MODEL_GGUF="$MODEL_DIR/$R2T2_MODEL_FILE"
MMPROJ_GGUF="$MODEL_DIR/$R2T2_MMPROJ_FILE"
# Capped parallelism for native builds: never all cores.
JOBS="${JOBS:-$(( $( (sysctl -n hw.ncpu 2>/dev/null || nproc) ) / 2 ))}"
[ "$JOBS" -lt 1 ] && JOBS=1
export PATH="/opt/homebrew/bin:$PATH"
