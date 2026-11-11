# IM.codes offline streaming speech

One Capacitor plugin/event contract for the existing VoiceInput/VoiceOverlay,
with small Android AudioRecord and iOS AVAudioEngine adapters. Recognizes Mandarin
and English with the **same** streaming Zipformer transducer (INT8 encoder and
joiner, FP32 decoder; 199 MB decimal). A small shared hotword file biases
`COMMIT`, `GITHUB`, and `ENGLISH` during decoding rather than rewriting text.
No audio upload, desktop process, cloud key, or language-switching UI.

Before native sync/build run `npm --prefix web run prepare:speech`. The build-time
script downloads only checksum/revision-pinned official assets; interrupted or
corrupt downloads are never published. Android preBuild also invokes it. Model
and AAR binaries are ignored, never committed. iOS uses the upstream exact 2.0.1
Swift package (including its checksummed XCFramework/ONNX Runtime dependencies).
After preparing: `cd web && npx cap sync android` / `npx cap sync ios`, then the
normal native build. Both regional APKs use the same recognizer. Requires a new
native app binary; a web-only OTA cannot install the native runtime/models.

The existing microphone permission/voice overlay is reused. Microphone capture
and recognition run locally, inference uses at most two threads, audio processing
is bounded, Stop drains final text and releases the recorder/decoder. iOS/Android
backgrounding stops capture; recognition never restarts the microphone silently.
Old installed shells and web browsers retain their previous recognition path.

Upstream runtime: https://github.com/k2-fsa/sherpa-onnx (Apache-2.0).
Model: https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20
See the model provider's terms before redistributing modified model assets. Do
not claim hallucination-free transcription, automatic punctuation, or a fixed
100ms recognition latency; chunk duration is not end-to-end latency.
