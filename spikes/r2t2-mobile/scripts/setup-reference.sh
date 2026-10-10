#!/usr/bin/env bash
# One-time setup to run the UPSTREAM Python stream_llama route on macOS:
#  - Python 3.12 venv (uv) with torch (CPU), transformers, qwen-asr (no vllm)
#  - HF processor files (tokenizer/config only, no weights)
#  - upstream's own pybind extension qwen3asr_native, built against pinned llama.cpp with Metal
source "$(dirname "$0")/common.sh"
UV="${UV:-uv}"
venv="$CACHE_DIR/venv-ref"
if [ ! -x "$venv/bin/python" ]; then "$UV" venv -p 3.12 "$venv"; fi
VIRTUAL_ENV="$venv" "$UV" pip install torch "transformers==4.57.6" "accelerate==1.12.0" librosa soundfile numpy \
  pybind11 requests "nagisa==0.2.11" "soynlp==0.0.493"
VIRTUAL_ENV="$venv" "$UV" pip install --no-deps "qwen-asr==$QWEN_ASR_VERSION"

proc="$CACHE_DIR/hf-processor"; mkdir -p "$proc"
for f in added_tokens.json chat_template.json config.json generation_config.json merges.txt \
         preprocessor_config.json special_tokens_map.json tokenizer.json tokenizer_config.json vocab.json; do
  [ -s "$proc/$f" ] || curl -fL --retry 3 -o "$proc/$f" "${HF_ENDPOINT:-https://huggingface.co}/$R2T2_HF_REPO/resolve/$R2T2_HF_REVISION/$f"
done

cmake -S "$UPSTREAM_DIR/r2t2_llama" -B "$CACHE_DIR/build-upstream-ext" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DLLAMA_CPP_DIR="$LLAMA_DIR" -DGGML_METAL=ON -DLLAMA_OPENSSL=OFF \
  -DPython_EXECUTABLE="$venv/bin/python" -Dpybind11_DIR="$("$venv/bin/python" -m pybind11 --cmakedir)"
cmake --build "$CACHE_DIR/build-upstream-ext" -j "$JOBS"
ls "$UPSTREAM_DIR/r2t2_llama/native/"
