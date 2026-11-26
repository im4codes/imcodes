#!/usr/bin/env bash
# Run the unmodified upstream stream_llama route on one clip.
#   scripts/run-reference.sh samples/zh_upstream_test.wav Chinese [stream|oneshot]
source "$(dirname "$0")/common.sh"
audio="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; lang=${2:-Chinese}; mode=${3:-stream}
cd "$UPSTREAM_DIR"
PYTHONPATH="$SPIKE_DIR/reference/shim:$UPSTREAM_DIR" "$CACHE_DIR/venv-ref/bin/python" \
  "$SPIKE_DIR/reference/run_upstream_stream.py" --audio "$audio" \
  --gguf_dir "$MODEL_DIR" --processor_path "$CACHE_DIR/hf-processor" --language "$lang" --mode "$mode"
