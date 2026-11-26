# `llama-cpp-capacitor` as a reference (task 1.7, decision D1)

Evaluated `llama-cpp-capacitor@0.1.5` (the latest version on 2026-09-25) by
unpacking `npm pack llama-cpp-capacitor@0.1.5` into
`.cache/eval-capacitor/package` and inspecting its sources, typings and
prebuilt binaries. Nothing was installed into any IM.codes project.

## Facts

| | |
|---|---|
| License / owner | MIT; one npm maintainer (`annadata`); repo `github.com/arusatech/llama-cpp` |
| Maturity | 23 versions since 2025-08-29 (still 0.1.x); ~39k downloads in the last month |
| Capacitor | peer `@capacitor/core >= 8` |
| Package size | 74 MB: vendored C++ sources plus prebuilt `ios/Frameworks/llama-cpp.framework` (arm64 device slice only) and `android/.../arm64-v8a/libllama-cpp-arm64.so` (58 MB, not stripped) |
| llama.cpp version | A vendored snapshot synced by the maintainer's `bootstrap.sh`, with local edits (`cap-*.cpp`, `tools/mtmd/`). There is no upstream tag or commit anywhere (`LLAMA_BUILD_NUMBER = 0`). Its mtmd projector enum ends at `LFM2` (roughly mid-2025). |
| Audio support | Yes, but only through `QWEN2A` / `ULTRAVOX` / `VOXTRAL` projectors. `PROJECTOR_TYPE_QWEN3A` appears nowhere: not in the sources, and not in either prebuilt binary (`grep -ac qwen3a` returns 0). |
| R2T2 mmproj | `clip.audio.projector_type = qwen3a` (checked in our pinned mmproj). Pinned llama.cpp b10950 supports it (`tools/mtmd/clip-impl.h`). |
| API | `initLlama`, `initMultimodal({path})`, `completion({prompt or messages, media_paths, emit_partial_completion}, onToken)`, `stopCompletion`, `tokenize({media_paths})`, `detokenize`. Audio arrives as a file path or base64 `input_audio`. |

## Fit against R2T2 streaming

1. **It cannot load R2T2 today.** The vendored mtmd has no `qwen3a` projector,
   so `initMultimodal` would fail on our mmproj. Using the plugin at all means
   re-vendoring a newer llama.cpp into someone else's fork, with its local
   patches, and rebuilding its binaries.
2. **Wrong granularity for the streaming loop.** The ported `stream_llama` loop
   (160 ms step, re-encode all accumulated audio with a rollback prefix, 4–32
   token budget, `unfixed_token_num` rollback) needs several things:
   - raw float PCM,
   - exact prompt-token control (tokenize, drop k tokens, retry on U+FFFD),
   - special-token-free piece decoding,
   - per-step `max_tokens`,
   - one native call per step.

   The plugin only offers an OpenAI-style completion over a file or base64 WAV.
   Every 160 ms step would re-send the whole utterance as base64 across the
   Capacitor bridge (a 30 s utterance is about 1.3 MB per step, 6 steps/s). The
   rollback logic would also have to live in JS on top of a chat/completion
   abstraction. Our C API does all of this in-process (`core/r2t2_harness.h`,
   `r2t2_live_push`).
3. **No background or live capture story.** It has no microphone capture, no
   foreground-service or `UIBackgroundModes audio` integration, and no
   locked-screen consideration. Those are exactly the parts tasks 1.4 and 1.5
   need.
4. **Supply-chain and reproducibility risk.** The large prebuilt binaries have
   no recorded provenance: no upstream commit, no build flags, no checksum in
   the repo. There is a single maintainer and the API is still 0.1.x. We could
   not audit or reproduce what ships.
5. **What is worth borrowing.** The general shape: a JS plugin with `init`,
   `release`, `stop`, and a token callback that emits partial results as
   events. Also `cap-mtmd.hpp`'s use of `mtmd_helper_eval_chunk_single` as
   sample glue.

## Recommendation on D1

**Build our own thin Capacitor plugin** over the pinned official llama.cpp
(b10950):

- iOS: the release xcframework (verified by SHA-256).
- Android: an NDK build via `scripts/build-android-libs.sh`.

Put the spike's `core/` (engine, streaming port, text post-processing) behind a
small, stable C API: `load`, `live_start` / `push` / `stop`, `oneshot`, `cancel`,
with events as JSON. That is the same API both harness apps already use. The JS
surface only needs:

- `load`, `unload`
- `startSession(language, chunkMs)`
- `stopSession`
- events `partial{committed, fixed, unfixed}`, `utteranceEnd`, `error`,
  `stats`

Audio should never cross the bridge: native code owns the microphone.
`llama-cpp-capacitor` should stay a reading reference only, not a dependency.
