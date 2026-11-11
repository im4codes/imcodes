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
    private var prevClean = ""
    private var lastCleanInput = ""
    private var lastPunctuatedFull = ""
    private var unchangedSilentChunks = 0

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
        return ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt", "bpe.vocab", "hotwords.txt", "punct.int8.onnx"].allSatisfy {
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
                self.prevClean = ""; self.lastCleanInput = ""; self.lastPunctuatedFull = ""
                self.unchangedSilentChunks = 0
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
            decoder.acceptWaveform(samples: samples)
            self.decodeAvailable(decoder)
            let rawText = self.join(self.committed, decoder.text.trimmingCharacters(in: .whitespacesAndNewlines))
            let clean = self.stripPunctuation(rawText)
            let endpoint = decoder.isEndpoint()
            if clean.isEmpty {
                self.unchangedSilentChunks = 0
            } else if clean != self.prevClean {
                self.prevClean = clean
                self.unchangedSilentChunks = endpoint ? 3 : 0
            } else if endpoint {
                self.unchangedSilentChunks = max(self.unchangedSilentChunks, 3)
            } else if level < 0.08 {
                self.unchangedSilentChunks += 1
            } else if self.unchangedSilentChunks < 3 {
                self.unchangedSilentChunks = 0
            }
            let allowTrailingPeriod = endpoint || self.unchangedSilentChunks >= 3
            let text = self.punctuate(rawText, recognizer: decoder.recognizer, allowTrailingPeriod: allowTrailingPeriod)
            if text != self.lastText { self.emitText(text, final: false); self.lastText = text }
            if endpoint {
                if decoder.startNextStream() {
                    self.committed = rawText
                    self.prevClean = clean
                    self.unchangedSilentChunks = max(self.unchangedSilentChunks, 3)
                } else {
                    DispatchQueue.main.async {
                        if self.isCurrent(owner) {
                            self.notifyListeners("recognitionError", data: ["message": "Offline speech could not continue"])
                            self.endCapture(nil)
                        }
                    }
                }
            }
        }
    }
    private func decodeAvailable(_ decoder: SpeechDecoder) {
        decoder.decodeAvailable()
    }
    private func stripPunctuation(_ text: String) -> String {
        return text.replacingOccurrences(of: "[，。？！、；：,.?!;:…—\\-]+", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }
    private func formatBilingualPunctuation(_ text: String) -> String {
        var out = text
        out = out.replacingOccurrences(of: "([。？！?!])([，,、]+)", with: "$1", options: .regularExpression)
        out = out.replacingOccurrences(of: "([，,、]+)([。？！?!])", with: "$2", options: .regularExpression)
        out = out.replacingOccurrences(of: "[，,、]{2,}", with: "，", options: .regularExpression)
        out = out.replacingOccurrences(of: "[。]{2,}", with: "。", options: .regularExpression)
        out = out.replacingOccurrences(of: "[？?]{2,}", with: "？", options: .regularExpression)
        out = out.replacingOccurrences(of: "([A-Za-z0-9])。", with: "$1.", options: .regularExpression)
        out = out.replacingOccurrences(of: "([A-Za-z0-9])，", with: "$1, ", options: .regularExpression)
        out = out.replacingOccurrences(of: "([A-Za-z0-9])？", with: "$1?", options: .regularExpression)
        out = out.replacingOccurrences(of: "([A-Za-z0-9])！", with: "$1!", options: .regularExpression)
        return out
    }
    private func punctuate(_ rawText: String, recognizer: SpeechRecognizer, allowTrailingPeriod: Bool) -> String {
        let clean = stripPunctuation(rawText)
        if clean.isEmpty { return "" }
        let punctuated: String
        if clean == lastCleanInput {
            punctuated = lastPunctuatedFull
        } else {
            punctuated = formatBilingualPunctuation(recognizer.addRawPunctuation(clean))
            lastCleanInput = clean
            lastPunctuatedFull = punctuated
        }
        if allowTrailingPeriod {
            return punctuated.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return punctuated.replacingOccurrences(of: "[。\\.\\s]+$", with: "", options: .regularExpression)
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
        _ = nextOwner()
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }
        engine?.stop(); engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        worker.async {
            if let decoder = self.decoder {
                // One second covers the transducer's final right-context window.
                decoder.acceptWaveform(samples: [Float](repeating: 0, count: 16000))
                decoder.inputFinished()
                self.decodeAvailable(decoder)
                let rawFinal = self.join(self.committed, decoder.text.trimmingCharacters(in: .whitespacesAndNewlines))
                self.emitText(self.punctuate(rawFinal, recognizer: decoder.recognizer, allowTrailingPeriod: true), final: true)
            }
            self.decoder = nil
            DispatchQueue.main.async {
                self.notifyListeners("listeningState", data: ["status": "stopped"])
                call?.resolve()
            }
        }
    }
}

// Resident ONNX recognizer & CT-Transformer punctuator graphs owned by the plugin's serial worker queue.
private final class SpeechRecognizer {
    let pointer: OpaquePointer
    let punctuator: OpaquePointer
    init?(root: URL) {
        let model = sherpaOnnxOnlineModelConfig(
            tokens: root.appendingPathComponent("tokens.txt").path,
            transducer: sherpaOnnxOnlineTransducerModelConfig(
                encoder: root.appendingPathComponent("encoder.int8.onnx").path,
                decoder: root.appendingPathComponent("decoder.onnx").path,
                joiner: root.appendingPathComponent("joiner.int8.onnx").path),
            numThreads: 2, modelType: "zipformer", modelingUnit: "cjkchar+bpe",
            bpeVocab: root.appendingPathComponent("bpe.vocab").path)
        var config = sherpaOnnxOnlineRecognizerConfig(
            featConfig: sherpaOnnxFeatureConfig(), modelConfig: model, enableEndpoint: true,
            decodingMethod: "modified_beam_search",
            hotwordsFile: root.appendingPathComponent("hotwords.txt").path,
            hotwordsScore: 2.0)
        guard let recognizer = SherpaOnnxCreateOnlineRecognizer(&config) else { return nil }
        let punctModel = sherpaOnnxOfflinePunctuationModelConfig(
            ctTransformer: root.appendingPathComponent("punct.int8.onnx").path,
            numThreads: 2, debug: 0, provider: "cpu")
        var punctConfig = sherpaOnnxOfflinePunctuationConfig(model: punctModel)
        guard let punctuator = SherpaOnnxCreateOfflinePunctuation(&punctConfig) else {
            SherpaOnnxDestroyOnlineRecognizer(recognizer)
            return nil
        }
        self.pointer = recognizer
        self.punctuator = punctuator
        if let warmStream = SherpaOnnxCreateOnlineStream(recognizer) {
            let silence = [Float](repeating: 0, count: 8000)
            SherpaOnnxOnlineStreamAcceptWaveform(warmStream, 16000, silence, Int32(silence.count))
            while SherpaOnnxIsOnlineStreamReady(recognizer, warmStream) != 0 {
                SherpaOnnxDecodeOnlineStream(recognizer, warmStream)
            }
            SherpaOnnxDestroyOnlineStream(warmStream)
        }
        _ = addRawPunctuation("你好世界")
    }
    func addRawPunctuation(_ cleanText: String) -> String {
        guard !cleanText.isEmpty else { return "" }
        guard let cText = SherpaOfflinePunctuationAddPunct(punctuator, (cleanText as NSString).utf8String) else {
            return cleanText
        }
        defer { SherpaOfflinePunctuationFreeText(cText) }
        return String(cString: cText)
    }
    deinit {
        SherpaOnnxDestroyOfflinePunctuation(punctuator)
        SherpaOnnxDestroyOnlineRecognizer(pointer)
    }
}

// Unlike the upstream convenience wrapper, reject a failed native allocation
// instead of force-unwrapping it and crashing the app. Worker-thread owned.
private final class SpeechDecoder {
    let recognizer: SpeechRecognizer
    private(set) var stream: OpaquePointer
    init?(recognizer: SpeechRecognizer) {
        guard let stream = SherpaOnnxCreateOnlineStream(recognizer.pointer) else { return nil }
        self.recognizer = recognizer; self.stream = stream
        // Half-second left-context padding establishes the acoustic alignment baseline.
        acceptWaveform(samples: [Float](repeating: 0, count: 8000))
        decodeAvailable()
    }
    deinit {
        SherpaOnnxDestroyOnlineStream(stream)
    }
    func acceptWaveform(samples: [Float]) {
        SherpaOnnxOnlineStreamAcceptWaveform(stream, 16000, samples, Int32(samples.count))
    }
    func inputFinished() { SherpaOnnxOnlineStreamInputFinished(stream) }
    func isReady() -> Bool { SherpaOnnxIsOnlineStreamReady(recognizer.pointer, stream) != 0 }
    func decode() { SherpaOnnxDecodeOnlineStream(recognizer.pointer, stream) }
    func decodeAvailable() {
        while isReady() { decode() }
    }
    func startNextStream() -> Bool {
        guard let next = SherpaOnnxCreateOnlineStream(recognizer.pointer) else { return false }
        SherpaOnnxDestroyOnlineStream(stream)
        stream = next
        // Half-second left-context padding establishes the acoustic alignment baseline.
        acceptWaveform(samples: [Float](repeating: 0, count: 8000))
        decodeAvailable()
        return true
    }
    func isEndpoint() -> Bool { SherpaOnnxOnlineStreamIsEndpoint(recognizer.pointer, stream) != 0 }
    var text: String {
        guard let result = SherpaOnnxGetOnlineStreamResult(recognizer.pointer, stream) else { return "" }
        defer { SherpaOnnxDestroyOnlineRecognizerResult(result) }
        guard let text = result.pointee.text else { return "" }
        return String(cString: text)
    }
}
