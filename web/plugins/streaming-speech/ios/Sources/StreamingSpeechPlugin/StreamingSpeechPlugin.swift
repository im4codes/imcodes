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
    private var eventOwner: UInt64 = 0
    // Bounded audio work: buffer up to ~6.4s while the model finishes cold warmup.
    private let slots = DispatchSemaphore(value: 64)
    private var engine: AVAudioEngine?
    private var tapInstalled = false
    // Resident recognizer model kept across sessions on worker; stream is per-capture.
    private var recognizer: SpeechRecognizer?
    // Only accessed on worker; queued PCM drains before the stop/final barrier.
    private var decoder: SpeechDecoder?
    private var decoderOwner: UInt64 = 0
    private var window = SpeechWindow()

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
            self.lock.lock(); self.eventOwner = owner; self.lock.unlock()
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
                self.window = SpeechWindow()
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
        // Admission and worker enqueue are atomic with the stop barrier. A tap
        // already converting when stop begins must enqueue its tail before flush.
        lock.lock()
        defer { lock.unlock() }
        guard generation == owner else { return }
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
            do {
                try self.window.append(samples, speech: level >= 0.01, decode: decoder.decode) { text in
                    self.emitText(text, final: false, owner: owner)
                }
            } catch {
                DispatchQueue.main.async {
                    if self.isCurrent(owner) {
                        self.notifyListeners("recognitionError", data: ["message": "Offline speech decoding failed"])
                        self.endCapture(nil)
                    }
                }
            }
        }
    }

    private func emitText(_ text: String, final: Bool, owner: UInt64) {
        DispatchQueue.main.async {
            self.lock.lock(); let current = self.eventOwner == owner; self.lock.unlock()
            guard current else { return }
            self.notifyListeners("partialResults", data: ["matches": [text], "isFinal": final])
        }
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
            let owner = self.decoderOwner
            if let decoder = self.decoder {
                do {
                    let text = try self.window.finish(decode: decoder.decode)
                    self.emitText(text, final: true, owner: owner)
                } catch {
                    // Preserve the last successful hypothesis on a visible error;
                    // never silently replace the full transcript with an empty tail.
                    self.emitText(self.window.text, final: true, owner: owner)
                    DispatchQueue.main.async {
                        self.lock.lock(); let current = self.eventOwner == owner; self.lock.unlock()
                        if current { self.notifyListeners("recognitionError", data: ["message": "Offline speech final decoding failed"]) }
                    }
                }
            }
            self.window = SpeechWindow()
            self.decoder = nil
            self.decoderOwner = 0
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
        var qwen = sherpaOnnxOfflineQwen3ASRModelConfig(maxTotalLen: 768, maxNewTokens: 32, temperature: 1e-6, topP: 0.8, seed: 42)
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

// MARK: - Bounded offline segmentation
// This is local acoustic/text overlap reconciliation, NOT model-prefix/KV-cache
// continuation. sherpa's offline Qwen API does not accept an assistant prefix or
// previous-sentence context. Only the transcript grows with recording duration;
// PCM, overlap anchors and each decode input stay bounded.
struct SpeechWindow {
    static let sampleRate = 16000
    static let stride = sampleRate // 1 second of NEW audio per partial decode
    static let capacity = 3 * sampleRate
    static let overlap = sampleRate
    static let rollbackCharacters = 5
    static let punctuationPause = sampleRate * 4 / 10
    static let vadPause = sampleRate * 7 / 10
    enum Failure: Error { case decode }

    private(set) var samples: [Float] = []
    private(set) var committed = ""
    private(set) var partial = ""
    private var anchor = ""
    private var rolling = false
    // Frozen at each acoustic roll, never fed back from intermediate snapshots.
    private var seamTail = ""
    private var overlapText: String?
    private var hypothesis: String?
    private var previousHypothesis: String?
    private var newSamples = 0
    private var silentSamples = 0
    private var lastEmitted = ""
    var text: String { rolling ? committed + partial : Self.join(committed, partial) }

    mutating func append(_ input: [Float], speech: Bool,
                         decode: ([Float]) -> String?, emit: (String) -> Void) throws {
        var offset = 0
        while offset < input.count {
            if samples.isEmpty && !speech { return }
            // Split even a large tap at exact scheduler boundaries, not just at
            // capacity: cost and silence thresholds do not depend on tap size.
            let pause = Self.endsSentence(partial) ? Self.punctuationPause : Self.vadPause
            let untilPause = speech ? Self.capacity : max(1, pause - silentSamples)
            let count = min(input.count - offset, Self.capacity - samples.count,
                            Self.stride - newSamples, untilPause)
            samples.append(contentsOf: input[offset..<(offset + count)])
            offset += count
            newSamples += count
            silentSamples = speech ? 0 : silentSamples + count
            let endpoint = silentSamples >= pause
            if endpoint || newSamples >= Self.stride || samples.count == Self.capacity {
                try evaluate(decode)
                if endpoint {
                    commitSentence()
                } else if samples.count == Self.capacity {
                    rollWindow()
                }
                if text != lastEmitted { lastEmitted = text; emit(text) }
            }
        }
    }

    mutating func finish(decode: ([Float]) -> String?) throws -> String {
        // Accepted PCM drains on the serial worker before this call. A sub-stride
        // tail must be decoded; overlap-only audio must NOT be decoded twice.
        if newSamples > 0 { try evaluate(decode) }
        commitSentence()
        return text
    }

    private mutating func evaluate(_ decode: ([Float]) -> String?) throws {
        guard let decoded = decode(samples) else { throw Failure.decode }
        let next = decoded.trimmingCharacters(in: .whitespacesAndNewlines)
        previousHypothesis = hypothesis
        hypothesis = next
        if !rolling {
            partial = next
        } else {
            // Empty anchor is NOT a new segment: retired PCM may still own the
            // entire <=5 Character tail. Reconcile against the frozen roll seam,
            // not the last partial (which also contains this window's new words).
            let size: Int
            if let overlapText = overlapText, next.hasPrefix(overlapText) {
                size = overlapText.count
            } else {
                size = Self.overlapCount(anchor + seamTail, next)
            }
            if size > seamTail.count {
                // The shared acoustic text extends into the committed prefix.
                partial = String(next.dropFirst(size - seamTail.count))
            } else if size > 0 {
                // Preserve text whose audio has retired, even if no characters
                // could be committed at the preceding roll. The seam may be one
                // CJK Character or a cut inside an ASCII word: concatenate exact
                // slices, do not insert/trim a synthetic boundary space.
                partial = String(seamTail.dropLast(size)) + next
            } else {
                // Uncertain model revisions: preserve the frozen unfixed tail.
                // This can repeat a seam, but cannot recursively re-append new
                // words already included by an earlier decode of this window.
                partial = Self.join(seamTail, next)
            }
        }
        newSamples = 0
    }

    private mutating func rollWindow() {
        // When successive raw hypotheses extend exactly, their delta describes
        // the retained final stride. Prefer that acoustic seam over a longest
        // suffix match: identical repeated words can otherwise over-match.
        if let prior = previousHypothesis, let current = hypothesis, current.hasPrefix(prior) {
            overlapText = String(current.dropFirst(prior.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            overlapText = nil
        }
        hypothesis = nil; previousHypothesis = nil
        let tail = String(partial.suffix(Self.rollbackCharacters))
        let stable = String(partial.dropLast(tail.count))
        committed = rolling ? committed + stable : Self.join(committed, stable)
        rolling = true
        anchor = String((anchor + stable).suffix(48))
        partial = tail
        seamTail = tail
        samples = Array(samples.suffix(Self.overlap))
        // Keep the silence clock: a pause crossing a roll still commits once.
    }

    private mutating func commitSentence() {
        committed = text
        partial = ""; anchor = ""; rolling = false; seamTail = ""
        overlapText = nil; hypothesis = nil; previousHypothesis = nil
        samples.removeAll(keepingCapacity: true)
        newSamples = 0; silentSamples = 0
    }

    private static func endsSentence(_ text: String) -> Bool {
        guard let last = text.last else { return false }
        return "。！？.!?".contains(last)
    }

    private static func overlapCount(_ previous: String, _ next: String) -> Int {
        // Only across known overlapping PCM, never across a VAD commit. One
        // Character matters for short CJK; all work uses a bounded seam anchor.
        let left = Array(previous.suffix(48 + rollbackCharacters)), right = Array(next.prefix(48 + rollbackCharacters))
        let limit = min(left.count, right.count)
        guard limit > 0 else { return 0 }
        for size in Swift.stride(from: limit, through: 1, by: -1) {
            if left.suffix(size).elementsEqual(right.prefix(size)) { return size }
        }
        return 0
    }

    private static func join(_ previous: String, _ next: String) -> String {
        if previous.isEmpty { return next }
        if next.isEmpty { return previous }
        let ascii = previous.unicodeScalars.last!.value < 128 && next.unicodeScalars.first!.value < 128
        let separated = previous.last!.isWhitespace || next.first!.isWhitespace
        return previous + (ascii && !separated ? " " : "") + next
    }
}
