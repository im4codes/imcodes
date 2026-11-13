# IM.codes offline streaming speech

Android AudioRecord (`sherpa-onnx` ONNX in `models/`) and iOS AVAudioEngine (`mlx-swift` Metal GPU in `ios-models/`, iOS 17.0+) expose the same StreamingSpeech
Capacitor events as VoiceInput/VoiceOverlay. All languages use **Qwen3-ASR-0.6B
INT4** when this plugin is installed; only old shells without the plugin retain
their platform recognizer. There is no cloud API/key, audio upload or language
switching UI. Native multilingual recognition and punctuation come from Qwen3;
no separate punctuation graph or transcript rewriting is used.

Run `npm --prefix web run prepare:speech` before native sync/build (or pass `--ios` / `--android`). The script
pins Android ONNX revision `9012f07ac1ce43c7e9fbd3afd8cad90fe147f88e` (`models/`, `sherpa-onnx-2.0.1.aar`) and
iOS MLX revision `bc441bd1e4295c1f42d9879f056049a925b6e013` (`ios-models/` from `aufklarer/Qwen3-ASR-0.6B-MLX-4bit`) by SHA256 and size.
Incomplete/corrupt downloads are never published. Obsolete Zipformer/punctuation
assets are removed only after the replacement verifies; unrelated files remain.
Binaries remain ignored, never committed. This requires a **new native build**;
web-only OTA cannot replace installed native graphs or code.

The resident iOS recognizer runs Qwen3-ASR 4-bit MLX weights on Metal GPU with a 128-token
generation budget (requiring iOS 17.0+ and a Metal GPU device); Android uses `sherpa-onnx`
with a 24-token generation budget. New-audio cadence is 1.5s, with VAD/capacity/Stop able to flush earlier.
Each worker turn drains the entire current inbox instead of replaying small
queued steps. Stop waits for in-flight capture/decode and merges the remaining
tail into at most one final decode before stopped/ACK. Each result is cumulative.
iOS retains a bounded 6.0s overlapping window; Android commits at 3s/VAD. A drained
backlog stays bounded by the inbox/window limits. No audio
history grows with recording duration, and overload fails visibly.

On iOS, app-owned Web playback is paused before capture, the audio session uses
playAndRecord/mixWithOthers/defaultToSpeaker, and exactly the first 100ms of
converted PCM is discarded once per capture. Background/interruption stops the
microphone and never silently restarts it. Native streams/results are freed.

These are scheduling/resource contracts, **not measured physical-device speed
or accuracy guarantees**. The <500ms step / >=60% headroom targets and acoustic
startup behavior require device measurements. See the complete
[mobile speech guidelines](../../docs/STREAMING_SPEECH_MOBILE_GUIDELINES.md).

Android copies the packaged assets once into a revision-keyed **no-backup private
cache**, atomically per file, because ONNX external `.weights` need filesystem
paths rather than an in-memory AssetManager graph. Allow storage for both the
packaged model and its extracted copy. iOS reads its model bundle directly.
Then `cd web && npx cap sync android` / `npx cap sync ios` and use the normal build.
No claims of physical-device performance or App Store approval are made by unit
fixtures; native compile/device validation remains a separate step.

Runtime (Apache-2.0): https://github.com/k2-fsa/sherpa-onnx/tree/v2.0.1
Model: https://huggingface.co/goodpixelltd/qwen3-asr-0.6b-int4-sherpa-onnx
Review the model provider's redistribution terms before distribution.
