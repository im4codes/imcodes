"""Minimal stand-in for `vllm.SamplingParams` so upstream r2t2 streaming code runs on macOS.

Upstream `r2t2/r2t2_asr.py` imports `SamplingParams` only to carry `max_tokens`
into `r2t2_llama.model.LlamaEngineAdapter.generate`, which reads nothing else.
vLLM itself is never used on the `stream_llama` route (all decoding is llama.cpp).
"""


class SamplingParams:
    def __init__(self, temperature=0.0, max_tokens=None, skip_special_tokens=True, **kwargs):
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.skip_special_tokens = skip_special_tokens
        self.extra = kwargs
