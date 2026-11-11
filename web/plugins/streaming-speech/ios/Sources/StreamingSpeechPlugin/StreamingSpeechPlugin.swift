import AVFoundation
import Capacitor
import SherpaOnnx
import SherpaOnnxC
import UIKit

/// The same Capacitor event contract as the existing voice input. No cloud service.
@objc(StreamingSpeechPlugin)
public class StreamingSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StreamingSpeechPlugin"
    public let jsName = "StreamingSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]
    private let worker = DispatchQueue(label: "com.imcodes.streaming-speech", qos: .userInitiated)
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var abortedOwner: UInt64 = 0
    // Bounded audio work: buffer up to ~6.4s while the model finishes cold warmup.
    private let slots = DispatchSemaphore(value: 64)
    private var engine: AVAudioEngine?
    private var tapInstalled = false
    // Resident recognizer model kept across sessions on worker; stream is per-capture.
    private var recognizer: SpeechRecognizer?
    // Only accessed on worker; queued PCM drains before the stop/final barrier.
    private var decoder: SpeechDecoder?
    private var decoderOwner: UInt64 = 0
    private var committed = ""
    private var lastText = ""
    private var utteranceSamples: [Float] = []
    private var lastDecodedCount = 0
    private var unchangedSilentChunks = 0
    private let maxUtteranceSamples = 20 * 16000
    private let partialIntervalSamples = 9600 // 0.6s, not a latency guarantee

    public override func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        worker.async { [weak self] in
            guard let self = self else { return }
            _ = self.ensureRecognizer()
        }
    }
    deinit {
        NotificationCenter.default.removeObserver(self)
        let retainedDecoder = decoder
        let retainedRecognizer = recognizer
        if retainedDecoder != nil || retainedRecognizer != nil {
            worker.async {
                _ = retainedDecoder
                _ = retainedRecognizer
            }
        }
    }
    private func ensureRecognizer() -> SpeechRecognizer? {
        if let existing = recognizer { return existing }
        guard modelAvailable, let root = modelRoot, let created = SpeechRecognizer(root: root) else { return nil }
        recognizer = created
        return created
    }
    private func nextOwner() -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        generation &+= 1
        return generation
    }
    private func isCurrent(_ owner: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return generation == owner
    }
    private var modelRoot: URL? { Bundle.module.resourceURL?.appendingPathComponent("models", isDirectory: true) }
    private var modelAvailable: Bool {
        guard let root = modelRoot else { return false }
        return ["conv_frontend.onnx", "encoder.int4.onnx", "encoder.int4.weights", "decoder.int4.onnx", "decoder.int4.weights", "tokenizer/vocab.json", "tokenizer/merges.txt", "tokenizer/tokenizer_config.json", "hotwords.txt"].allSatisfy {
            FileManager.default.isReadableFile(atPath: root.appendingPathComponent($0).path)
        }
    }
    @objc public func available(_ call: CAPPluginCall) { call.resolve(["available": modelAvailable]) }
    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        AVAudioSession.sharedInstance().requestRecordPermission { allowed in
            call.resolve(["speechRecognition": allowed ? "granted" : "denied"])
        }
    }
    @objc public func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active else {
                call.reject("Speech requires a foreground app"); return
            }
            if self.engine?.isRunning == true { call.resolve(); return }
            guard AVAudioSession.sharedInstance().recordPermission == .granted else {
                call.reject("Microphone permission denied"); return
            }
            guard self.modelAvailable else {
                call.reject("Offline speech model missing"); return
            }
            let owner = self.nextOwner()
            // Enqueue decoder setup on the serial worker queue BEFORE starting AVAudioEngine
            // so any audio buffers captured while the model finishes warming up are queued
            // strictly behind this setup block and decoded in order without losing the first words.
            self.worker.async {
                self.lock.lock()
                let aborted = self.abortedOwner == owner
                self.lock.unlock()
                guard !aborted else { return }
                guard let recognizer = self.ensureRecognizer(),
                      let decoder = SpeechDecoder(recognizer: recognizer) else {
                    self.decoder = nil
                    self.decoderOwner = 0
                    DispatchQueue.main.async {
                        if self.isCurrent(owner) {
                            self.notifyListeners("recognitionError", data: ["message": "Offline speech model initialization failed"])
                            self.endCapture(nil)
                        }
                    }
                    return
                }
                self.decoder = decoder
                self.decoderOwner = owner
                self.committed = ""; self.lastText = ""
                self.utteranceSamples.removeAll(keepingCapacity: true)
                self.lastDecodedCount = 0; self.unchangedSilentChunks = 0
            }
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth])
                try session.setActive(true)
                let engine = AVAudioEngine()
                let input = engine.inputNode
                let format = input.outputFormat(forBus: 0)
                guard format.sampleRate > 0, format.channelCount > 0 else {
                    throw NSError(domain: "StreamingSpeech", code: 1, userInfo: [NSLocalizedDescriptionKey: "Microphone format unavailable"])
                }
                guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
                      let converter = AVAudioConverter(from: format, to: mono) else {
                    throw NSError(domain: "StreamingSpeech", code: 2, userInfo: nil)
                }
                self.engine = engine
                input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 10), format: nil) { [weak self] buffer, _ in
                    self?.consume(buffer, owner: owner, converter: converter, format: mono)
                }
                self.tapInstalled = true
                try engine.start()
                self.notifyListeners("listeningState", data: ["status": "started"])
                call.resolve()
            } catch {
                self.lock.lock()
                self.abortedOwner = owner
                self.lock.unlock()
                self.endCapture(nil)
                call.reject("Offline speech could not start", nil, error)
            }
        }
    }
    private func consume(_ buffer: AVAudioPCMBuffer, owner: UInt64, converter: AVAudioConverter, format: AVAudioFormat) {
        guard isCurrent(owner) else { return }
        guard slots.wait(timeout: .now()) == .success else {
            // Fail visibly, instead of silently dropping audio or growing memory.
            DispatchQueue.main.async {
                if self.isCurrent(owner) {
                    self.notifyListeners("recognitionError", data: ["message": "Offline speech processing overloaded"])
                    self.endCapture(nil)
                }
            }
            return
        }
        let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / buffer.format.sampleRate) + 16)
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { slots.signal(); return }
        var supplied = false
        var conversionError: NSError?
        converter.convert(to: converted, error: &conversionError) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return buffer
        }
        guard conversionError == nil, let channel = converted.floatChannelData?[0] else {
            slots.signal()
            DispatchQueue.main.async {
                if self.isCurrent(owner) { self.endCapture(nil) }
            }
            return
        }
        let count = Int(converted.frameLength)
        let samples = Array(UnsafeBufferPointer(start: channel, count: count))
        let power = samples.reduce(Float(0)) { $0 + $1 * $1 }
        let level = min(1, sqrt(power / Float(max(count, 1))) * 3)
        notifyListeners("audioLevel", data: ["level": level])
        worker.async {
            defer { self.slots.signal() }
            guard self.decoderOwner == owner, let decoder = self.decoder else { return }
            let speech = level >= 0.01
            if self.utteranceSamples.isEmpty && !speech { return }
            var offset = 0
            while offset < samples.count {
                let count = min(samples.count - offset, self.maxUtteranceSamples - self.utteranceSamples.count)
                self.utteranceSamples.append(contentsOf: samples[offset..<(offset + count)])
                offset += count
                self.unchangedSilentChunks = speech ? 0 : self.unchangedSilentChunks + 1
                let endpoint = self.utteranceSamples.count == self.maxUtteranceSamples || self.unchangedSilentChunks >= 6
                if endpoint || (speech && self.utteranceSamples.count - self.lastDecodedCount >= self.partialIntervalSamples) {
                    guard let text = decoder.decode(samples: self.utteranceSamples) else {
                        self.decoder = nil; self.decoderOwner = 0
                        self.utteranceSamples.removeAll(keepingCapacity: true)
                        DispatchQueue.main.async {
                            if self.isCurrent(owner) {
                                self.notifyListeners("recognitionError", data: ["message": "Offline speech decoding failed"])
                                self.endCapture(nil)
                            }
                        }
                        return
                    }
                    let full = self.join(self.committed, text)
                    if full != self.lastText { self.emitText(full, final: false); self.lastText = full }
                    self.lastDecodedCount = self.utteranceSamples.count
                    if endpoint {
                        self.committed = full
                        self.utteranceSamples.removeAll(keepingCapacity: true)
                        self.lastDecodedCount = 0; self.unchangedSilentChunks = 0
                    }
                }
            }
        }
    }

    private func join(_ previous: String, _ text: String) -> String {
        if previous.isEmpty { return text }
        if text.isEmpty { return previous }
        let ascii = previous.unicodeScalars.last!.value < 128 && text.unicodeScalars.first!.value < 128
        return previous + (ascii ? " " : "") + text
    }
    private func emitText(_ text: String, final: Bool) {
        notifyListeners("partialResults", data: ["matches": [text], "isFinal": final])
    }
    @objc private func interrupted(_ notification: Notification) {
        if notification.name == AVAudioSession.interruptionNotification,
           let value = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
           value != AVAudioSession.InterruptionType.began.rawValue { return }
        DispatchQueue.main.async { self.endCapture(nil) }
    }
    @objc public func stop(_ call: CAPPluginCall) { DispatchQueue.main.async { self.endCapture(call) } }
    // Main-thread capture teardown; serial decoder flush precedes stopped and ACK.
    private func endCapture(_ call: CAPPluginCall?) {
        let stoppingOwner = nextOwner()
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }
        engine?.stop(); engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        worker.async {
            if let decoder = self.decoder {
                if let text = decoder.decode(samples: self.utteranceSamples) {
                    self.emitText(self.join(self.committed, text), final: true)
                } else {
                    self.notifyListeners("recognitionError", data: ["message": "Offline speech final decoding failed"])
                }
            }
            self.utteranceSamples.removeAll(keepingCapacity: true)
            self.decoder = nil
            DispatchQueue.main.async {
                if self.isCurrent(stoppingOwner) { self.notifyListeners("listeningState", data: ["status": "stopped"]) }
                call?.resolve()
            }
        }
    }
}

// Resident Qwen3 recognizer. Each partial/final uses a fresh bounded offline stream;
// all access stays on the plugin's serial worker, including destruction.
private final class SpeechRecognizer {
    let pointer: OpaquePointer
    init?(root: URL) {
        let hotwords = ((try? String(contentsOf: root.appendingPathComponent("hotwords.txt"), encoding: .utf8)) ?? "")
            .split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }.joined(separator: ",")
        // Own dynamic C strings until the native constructor has consumed config.
        let values = ["conv_frontend.onnx", "encoder.int4.onnx", "decoder.int4.onnx", "tokenizer"].map { root.appendingPathComponent($0).path } + [hotwords]
        let strings = values.map { strdup($0) }
        defer { strings.forEach { free($0) } }
        guard strings.allSatisfy({ $0 != nil }) else { return nil }
        var qwen = sherpaOnnxOfflineQwen3ASRModelConfig(maxTotalLen: 768, maxNewTokens: 128, temperature: 1e-6, topP: 0.8, seed: 42)
        qwen.conv_frontend = UnsafePointer(strings[0]!)
        qwen.encoder = UnsafePointer(strings[1]!)
        qwen.decoder = UnsafePointer(strings[2]!)
        qwen.tokenizer = UnsafePointer(strings[3]!)
        qwen.hotwords = UnsafePointer(strings[4]!)
        let model = sherpaOnnxOfflineModelConfig(tokens: "", numThreads: 2, qwen3Asr: qwen)
        var config = sherpaOnnxOfflineRecognizerConfig(featConfig: sherpaOnnxFeatureConfig(), modelConfig: model)
        guard let pointer = SherpaOnnxCreateOfflineRecognizer(&config) else { return nil }
        self.pointer = pointer
    }
    deinit { SherpaOnnxDestroyOfflineRecognizer(pointer) }
}

private final class SpeechDecoder {
    let recognizer: SpeechRecognizer
    init?(recognizer: SpeechRecognizer) { self.recognizer = recognizer }
    func decode(samples: [Float]) -> String? {
        if samples.isEmpty { return "" }
        guard let stream = SherpaOnnxCreateOfflineStream(recognizer.pointer) else { return nil }
        defer { SherpaOnnxDestroyOfflineStream(stream) }
        SherpaOnnxAcceptWaveformOffline(stream, 16000, samples, Int32(samples.count))
        SherpaOnnxDecodeOfflineStream(recognizer.pointer, stream)
        guard let result = SherpaOnnxGetOfflineStreamResult(stream) else { return nil }
        defer { SherpaOnnxDestroyOfflineRecognizerResult(result) }
        guard let text = result.pointee.text else { return "" }
        return String(cString: text).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
