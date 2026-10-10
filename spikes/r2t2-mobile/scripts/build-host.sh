#!/usr/bin/env bash
# macOS (Metal) / Linux host build of the shared core, CLI and text conformance test.
source "$(dirname "$0")/common.sh"
cmake -S "$SPIKE_DIR" -B "$CACHE_DIR/build-host" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DLLAMA_CPP_DIR="$LLAMA_DIR" ${HOST_CMAKE_ARGS:-}
cmake --build "$CACHE_DIR/build-host" -j "$JOBS" --target r2t2-cli r2t2-text-test
"$CACHE_DIR/build-host/r2t2-text-test" "$SPIKE_DIR/tests/text_cases.tsv"
echo "built: $CACHE_DIR/build-host/r2t2-cli"
