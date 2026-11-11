# IM.codes offline streaming speech

Android AudioRecord and iOS AVAudioEngine expose the same StreamingSpeech
Capacitor events as VoiceInput/VoiceOverlay. All languages use **Qwen3-ASR-0.6B
INT4** when this plugin is installed; only old shells without the plugin retain
their platform recognizer. There is no cloud API/key, audio upload or language
switching UI. Native multilingual recognition and punctuation come from Qwen3;
no separate punctuation graph or transcript rewriting is used.

Run `npm --prefix web run prepare:speech` before native sync/build. The script
pins model revision `9012f07ac1ce43c7e9fbd3afd8cad90fe147f88e`, each graph, external
weights, tokenizer file and the existing sherpa-onnx 2.0.1 AAR by SHA256 and size.
Incomplete/corrupt downloads are never published. Obsolete Zipformer/punctuation
assets are removed only after the replacement verifies; unrelated files remain.
Binaries remain ignored, never committed. This requires a **new native build**;
web-only OTA cannot replace installed native graphs or code.

The resident recognizer uses at most two threads. Recognition is segmented
rather than a streaming transducer: 16kHz mono PCM is decoded every ~0.6 seconds
of active speech, at six silent chunks, at the 20-second window, and on Stop.
These are scheduling intervals, **not guaranteed end-to-end latency**. Each
partial is the cumulative transcript; Stop drains accepted PCM and emits its
final result before stopped/ACK. Real speed and accuracy depend on the device.

The serial worker retains the existing 64-chunk (~6.4s) audio backlog bound.
Overflow fails visibly rather than silently dropping words or growing memory.
Background/interruption stops the microphone; it never silently restarts. JNI/C
streams and result snapshots are freed after each decode. Hotwords are loaded
from the shared text file as comma-separated native hints, not string replacements.

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
