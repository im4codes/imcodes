"""Run the pinned upstream R2T2 `stream_llama` route and print its transcript.

This calls upstream code unmodified:
  - model:  r2t2_llama.R2T2LlamaASRModel.LlamaNative   (same as example_llama.py --infer_mode stream_llama)
  - driver: example.run_streaming                      (same chunk schedule)
The only differences from `python -m r2t2_llama.example_llama` are:
  - `--language auto` is allowed (example_llama.py defaults to "Chinese" and
    maps only the literal "None" to auto);
  - every native decode call is traced to stderr as
    `[llama] audio_samples=N max_tokens=K text=...` so the C++ port can be
    compared step by step (upstream prints the same line under DEBUG_PRINT=1).

Output lines match example.py: `text=<fixed>` per call, `finish state.text=`
(printed by upstream finish_streaming_transcribe) and `final_result=`.

Run through scripts/run-reference.sh (sets PYTHONPATH to the upstream checkout
plus reference/shim for the `vllm.SamplingParams` stand-in).
"""
import argparse
import sys

import numpy as np

from example import _resample_to_16k, read_wav_bytes_with_librosa, run_streaming
from r2t2_llama import R2T2LlamaASRModel
from r2t2_llama.llama_native_backend import LlamaNativeConfig, LlamaNativeOnetime
from r2t2_llama.model import _resolve_gguf


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--audio", required=True)
    p.add_argument("--gguf_dir", required=True)
    p.add_argument("--processor_path", required=True)
    p.add_argument("--language", default="Chinese", help="Chinese|English|...|auto")
    p.add_argument("--mode", default="stream", choices=["stream", "oneshot"])
    p.add_argument("--chunk_size_ms", type=int, default=160)
    p.add_argument("--lookahead_ms", type=int, default=160)
    p.add_argument("--unfixed_token_num", type=int, default=1)
    a = p.parse_args()
    language = None if a.language in ("auto", "None", "") else a.language

    wav, sr = read_wav_bytes_with_librosa(a.audio)
    wav16k = _resample_to_16k(wav, sr)

    if a.mode == "oneshot":
        model_gguf, mmproj_gguf = _resolve_gguf(a.gguf_dir)
        backend = LlamaNativeOnetime(LlamaNativeConfig(model=model_gguf, mmproj=mmproj_gguf))
        result = backend.generate_once(wav16k, language=language or "Chinese")
        print(f"oneshot_result={result['text'].strip()}")
        return

    asr = R2T2LlamaASRModel.LlamaNative(processor_path=a.processor_path, gguf_dir=a.gguf_dir)
    backend = asr.model.backend
    original = backend.generate_from_prompt

    def traced(audio, prompt, max_tokens=None):
        text = original(audio=audio, prompt=prompt, max_tokens=max_tokens)
        print(f"[llama] audio_samples={len(np.asarray(audio))} max_tokens={max_tokens} text={text}", file=sys.stderr)
        return text

    backend.generate_from_prompt = traced
    result = run_streaming(
        asr, wav16k,
        step_ms=a.chunk_size_ms,
        chunk_size_sec=a.chunk_size_ms / 1000.0,
        unfixed_token_num=a.unfixed_token_num,
        lookahead_ms=a.lookahead_ms,
        language=language,
        context="",
    )
    print(f"final_result={result}")


if __name__ == "__main__":
    main()
