import AVFoundation
import Capacitor
import Metal
import AudioCommon
import MLXCommon
import Qwen3ASR
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
    private var isAppBackgrounded = false
    // One scheduled drain, not one queued decode per 100ms microphone tap.
    private var inbox = SpeechInbox()
    private var engine: AVAudioEngine?
    private var tapInstalled = false
    private var startingCall: CAPPluginCall? // main-thread only; ready after warmup
    // Resident recognizer model kept across sessions on worker; Metal state is guarded for foreground use.
    private var recognizer: SpeechRecognizer?
    // Only accessed on worker; queued PCM drains before the stop/final barrier.
    private var decoder: SpeechDecoder?
    private var decoderOwner: UInt64 = 0
    private var window = SpeechWindow()

    public override func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackground(_:)), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didBecomeActive(_:)), name: UIApplication.didBecomeActiveNotification, object: nil)
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
    private func isEventOwner(_ owner: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return eventOwner == owner
    }
    private func canRunMetal(_ owner: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return eventOwner == owner && !isAppBackgrounded
    }
    private func isMetalDeviceAvailable() -> Bool {
        SpeechRecognizer.isMetalSupported
    }
    var modelRoot: URL? { Bundle.module.resourceURL?.appendingPathComponent("ios-models", isDirectory: true) }
    private var modelAvailable: Bool {
        guard isMetalDeviceAvailable(), let root = modelRoot else { return false }
        return ["config.json", "model.safetensors", "vocab.json", "merges.txt", "tokenizer_config.json", "hotwords.txt"].allSatisfy {
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
            guard UIApplication.shared.applicationState != .background else {
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
            self.lock.lock()
            self.eventOwner = owner
            self.isAppBackgrounded = false
            self.inbox = SpeechInbox()
            self.lock.unlock()
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
                try session.setCategory(.playAndRecord, mode: .measurement, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth])
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
                input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 10), format: format) { [weak self] buffer, _ in
                    self?.consume(buffer, owner: owner, converter: converter, mono: mono)
                }
                self.tapInstalled = true
                self.startingCall = call
                try engine.start()
                // consume() signals ready only after startup PCM was discarded;
                // the UI must not invite speech during that 100ms interval.
            } catch {
                self.startingCall = nil
                self.lock.lock()
                self.abortedOwner = owner
                self.lock.unlock()
                self.endCapture(nil)
                call.reject("Offline speech could not start", nil, error)
            }
        }
    }
    private func consume(_ buffer: AVAudioPCMBuffer, owner: UInt64, converter: AVAudioConverter, mono: AVAudioFormat) {
        // Admission and worker enqueue are atomic with the stop barrier. A tap
        // already converting when stop begins must enqueue its tail before flush.
        lock.lock()
        defer { lock.unlock() }
        guard generation == owner else { return }
        let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / buffer.format.sampleRate) + 16)
        guard let converted = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: capacity) else { return }
        let activeConverter: AVAudioConverter
        if converter.inputFormat == buffer.format {
            activeConverter = converter
        } else if let fallback = AVAudioConverter(from: buffer.format, to: mono) {
            activeConverter = fallback
        } else {
            DispatchQueue.main.async {
                if self.isCurrent(owner) {
                    self.notifyListeners("recognitionError", data: ["message": "Offline audio conversion failed: incompatible tap format"])
                    self.endCapture(nil)
                }
            }
            return
        }
        var supplied = false
        var conversionError: NSError?
        activeConverter.convert(to: converted, error: &conversionError) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return buffer
        }
        guard conversionError == nil, let channel = converted.floatChannelData?[0] else {
            let detail = conversionError?.localizedDescription ?? "missing converted channel data"
            DispatchQueue.main.async {
                if self.isCurrent(owner) {
                    self.notifyListeners("recognitionError", data: ["message": "Offline audio conversion failed: \(detail)"])
                    self.endCapture(nil)
                }
            }
            return
        }
        let samples = Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
        do {
            let warming = inbox.warmupRemaining > 0
            let schedule = try inbox.offer(samples)
            if warming && inbox.warmupRemaining == 0 {
                DispatchQueue.main.async {
                    guard self.isCurrent(owner), let call = self.startingCall else { return }
                    self.startingCall = nil
                    self.notifyListeners("listeningState", data: ["status": "started"])
                    call.resolve()
                }
            }
            if let level = inbox.pollAudioLevel(now: ProcessInfo.processInfo.systemUptime) {
                DispatchQueue.main.async {
                    self.lock.lock()
                    let active = self.generation == owner && self.eventOwner == owner
                    self.lock.unlock()
                    guard active else { return }
                    self.notifyListeners("audioLevel", data: ["level": level])
                }
            }
            if schedule { worker.async { self.drain(owner: owner) } }
        } catch {
            // Bounded admission fails visibly; never silently discard words.
            DispatchQueue.main.async {
                if self.isCurrent(owner) {
                    self.notifyListeners("recognitionError", data: ["message": "Offline speech processing overloaded"])
                    self.endCapture(nil)
                }
            }
        }
    }

    private func drain(owner: UInt64) {
        while true {
            lock.lock()
            // Stop owns the entire remaining tail. Its single final barrier
            // follows this in-flight decode on worker, without intermediate steps.
            guard generation == owner, let batch = inbox.take() else {
                lock.unlock(); return
            }
            lock.unlock()
            guard decoderOwner == owner, let decoder = decoder else { return }
            do {
                try window.append(
                    batch.samples,
                    speech: batch.speech,
                    trailingSilence: batch.trailingSilence,
                    shouldEmitNonFinal: { [weak self] in self?.isCurrent(owner) ?? false },
                    shouldContinue: { [weak self] in self?.canRunMetal(owner) ?? false },
                    decode: { [weak self] samples in
                        decoder.decode(samples: samples) { self?.canRunMetal(owner) ?? false }
                    }
                ) { text in
                    self.emitText(text, final: false, owner: owner)
                }
            } catch SpeechWindow.Failure.cancelled {
                return
            } catch {
                DispatchQueue.main.async {
                    if self.isCurrent(owner) {
                        self.notifyListeners("recognitionError", data: ["message": "Offline speech decoding failed"])
                        self.endCapture(nil)
                    }
                }
                return
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
        if notification.name == UIApplication.willResignActiveNotification {
            lock.lock(); isAppBackgrounded = true; lock.unlock()
        } else if notification.name == AVAudioSession.interruptionNotification,
           let value = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
           value != AVAudioSession.InterruptionType.began.rawValue { return }
        DispatchQueue.main.async { self.endCapture(nil) }
    }
    @objc private func didEnterBackground(_ notification: Notification) {
        lock.lock(); isAppBackgrounded = true; lock.unlock()
        DispatchQueue.main.async { self.endCapture(nil) }
    }
    @objc private func didBecomeActive(_ notification: Notification) {
        lock.lock(); isAppBackgrounded = false; lock.unlock()
    }
    @objc public func stop(_ call: CAPPluginCall) { DispatchQueue.main.async { self.endCapture(call) } }
    // Main-thread capture teardown; serial decoder flush precedes stopped and ACK.
    private func endCapture(_ call: CAPPluginCall?) {
        lock.lock()
        generation &+= 1
        let stoppingOwner = generation
        let tail = inbox.take()
        lock.unlock()
        // Stop during warmup must also settle the pending start promise.
        startingCall?.resolve(); startingCall = nil
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }
        engine?.stop(); engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        worker.async {
            let owner = self.decoderOwner
            if let decoder = self.decoder, self.canRunMetal(owner) {
                do {
                    if let tail = tail {
                        try self.window.append(
                            tail.samples,
                            speech: tail.speech,
                            trailingSilence: tail.trailingSilence,
                            final: true,
                            shouldContinue: { [weak self] in self?.canRunMetal(owner) ?? false },
                            decode: { [weak self] samples in
                                decoder.decode(samples: samples) { self?.canRunMetal(owner) ?? false }
                            }
                        ) { _ in }
                    }
                    if self.canRunMetal(owner) {
                        let text = try self.window.finish(shouldContinue: { [weak self] in self?.canRunMetal(owner) ?? false }) { samples in
                            decoder.decode(samples: samples) { [weak self] in self?.canRunMetal(owner) ?? false }
                        }
                        self.emitText(text, final: true, owner: owner)
                    } else if self.isEventOwner(owner) {
                        self.emitText(self.window.text, final: true, owner: owner)
                    }
                } catch SpeechWindow.Failure.cancelled {
                    if self.isEventOwner(owner) {
                        self.emitText(self.window.text, final: true, owner: owner)
                    }
                } catch {
                    // Preserve the last successful hypothesis on a visible error;
                    // never silently replace the full transcript with an empty tail.
                    self.emitText(self.window.text, final: true, owner: owner)
                    DispatchQueue.main.async {
                        self.lock.lock(); let current = self.eventOwner == owner; self.lock.unlock()
                        if current { self.notifyListeners("recognitionError", data: ["message": "Offline speech final decoding failed"]) }
                    }
                }
            } else if self.decoder != nil && self.isEventOwner(owner) {
                self.emitText(self.window.text, final: true, owner: owner)
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

// Resident MLX Metal GPU Qwen3-ASR recognizer; all decode calls stay on the
// plugin's serial worker and remain guarded against background Metal submission.
final class SpeechRecognizer {
    static var isMetalSupported: Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        return MTLCreateSystemDefaultDevice() != nil
        #endif
    }
    let model: Qwen3ASRModel
    let hotwords: String?
    init?(root: URL) {
        guard Self.isMetalSupported else { return nil }
        let words = ((try? String(contentsOf: root.appendingPathComponent("hotwords.txt"), encoding: .utf8)) ?? "")
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        self.hotwords = words.isEmpty ? nil : words.joined(separator: ", ")
        guard let loaded = try? Qwen3ASRModel.loadLocal(from: root) else { return nil }
        self.model = loaded
    }
}

final class SpeechDecoder {
    let recognizer: SpeechRecognizer
    init?(recognizer: SpeechRecognizer) { self.recognizer = recognizer }
    func decode(samples: [Float], shouldContinue: () -> Bool = { true }) -> String? {
        if samples.isEmpty { return "" }
        guard shouldContinue() else { return nil }
        let options = Qwen3DecodingOptions(maxTokens: 128, language: nil, context: recognizer.hotwords)
        do {
            let text = try recognizer.model.transcribeWithCancellation(audio: samples, sampleRate: 16000, options: options) {
                if !shouldContinue() { throw CancellationError() }
            }
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch is CancellationError {
            return nil
        } catch {
            return nil
        }
    }
}

// MARK: - Bounded offline segmentation
// This is local acoustic/text overlap reconciliation, NOT model-prefix/KV-cache
// continuation. sherpa's offline Qwen API does not accept an assistant prefix or
// previous-sentence context. Only the transcript grows with recording duration;
// PCM, overlap anchors and each decode input stay bounded.
struct SpeechWindow {
    static let sampleRate = 16000
    static let stride = sampleRate * 3 / 2 // 1.5s of NEW audio per partial decode
    static let capacity = 4 * stride // 6.0s bounded Metal GPU window (measured RTF=0.187, stepMax=369ms, CER=0.030)
    static let overlap = stride
    static let finalSilencePadding = sampleRate * 2 / 10 // 200ms (3200 zero samples) flushed once at final boundary
    static let rollbackCharacters = 5
    static let punctuationPause = sampleRate * 4 / 10
    static let vadPause = sampleRate * 7 / 10
    enum Failure: Error { case decode, cancelled }

    private(set) var samples: [Float] = []
    private(set) var committed = ""
    private(set) var partial = ""
    private var anchor = ""
    private var rolling = false
    // Frozen at each acoustic roll, never fed back from intermediate snapshots.
    private var seamTail = ""
    private var overlapText: String?
    private var overlapHint: String?
    private var lastGrowth: String?
    private var hypothesis: String?
    private var previousHypothesis: String?
    private var newSamples = 0
    private var silentSamples = 0
    private var lastEmitted = ""
    var text: String { rolling ? committed + partial : Self.join(committed, partial) }

    mutating func append(_ input: [Float], speech: Bool, trailingSilence: Int = 0, final: Bool = false,
                         shouldEmitNonFinal: () -> Bool = { true },
                         shouldContinue: () -> Bool = { true },
                         decode: ([Float]) -> String?, emit: (String) -> Void) throws {
        guard !input.isEmpty, !samples.isEmpty || speech else { return }
        // Chunk oversized batches (both live and final stop drain) at the bounded
        // window capacity (4.5s = 72,000 samples) so neither continuous speech nor a
        // 32s inbox backlog ever exceeds the per-decode window capacity.
        var remaining = input[...]
        while samples.count + remaining.count > Self.capacity {
            guard shouldContinue() else { return }
            let takeCount = max(1, Self.capacity - samples.count)
            let chunk = remaining.prefix(takeCount)
            remaining = remaining.dropFirst(takeCount)
            samples.append(contentsOf: chunk)
            newSamples += chunk.count
            silentSamples = speech ? (remaining.isEmpty ? trailingSilence : 0) : silentSamples + chunk.count
            try evaluate(decode, shouldContinue: shouldContinue)
            let pause = Self.endsSentence(partial) ? Self.punctuationPause : Self.vadPause
            if silentSamples >= pause { commitSentence() }
            else { rollWindow() }
            if !final && shouldEmitNonFinal() && text != lastEmitted { lastEmitted = text; emit(text) }
        }
        guard !remaining.isEmpty, shouldContinue() else { return }
        samples.append(contentsOf: remaining)
        newSamples += remaining.count
        silentSamples = speech ? trailingSilence : silentSamples + remaining.count
        if final || !shouldEmitNonFinal() {
            // Stop flushes the final bounded window once in finish() with 200ms silence padding;
            // skip redundant non-final decodes once stop has already been requested.
            return
        }
        let pause = Self.endsSentence(partial) ? Self.punctuationPause : Self.vadPause
        let endpoint = silentSamples >= pause
        if endpoint || newSamples >= Self.stride || samples.count >= Self.capacity {
            try evaluate(decode, shouldContinue: shouldContinue)
            if endpoint { commitSentence() }
            else if samples.count >= Self.capacity { rollWindow() }
            if text != lastEmitted { lastEmitted = text; emit(text) }
        }
    }

    mutating func finish(shouldContinue: () -> Bool = { true }, decode: ([Float]) -> String?) throws -> String {
        // Accepted PCM drains on the serial worker before this call. A sub-stride
        // tail must be decoded with a single 200ms (3200-sample) trailing silence
        // flush; overlap-only audio must NOT be decoded twice.
        if newSamples > 0 {
            let padded = samples + Array(repeating: Float(0), count: Self.finalSilencePadding)
            try evaluate({ _ in decode(padded) }, shouldContinue: shouldContinue)
        }
        commitSentence()
        return text
    }

    private mutating func evaluate(_ decode: ([Float]) -> String?, shouldContinue: () -> Bool = { true }) throws {
        guard shouldContinue() else { throw Failure.cancelled }
        guard let decoded = decode(samples) else {
            throw shouldContinue() ? Failure.decode : Failure.cancelled
        }
        let next = decoded.trimmingCharacters(in: .whitespacesAndNewlines)
        previousHypothesis = hypothesis
        hypothesis = next
        var matched = 0
        if !rolling {
            partial = next
        } else {
            // Empty anchor is NOT a new segment: retired PCM may still own the
            // entire <=5 Character tail. Reconcile against the frozen roll seam,
            // not the last partial (which also contains this window's new words).
            let rawSize: Int?
            if let overlapText = overlapText, !overlapText.isEmpty, next.hasPrefix(overlapText) {
                rawSize = overlapText.count
            } else if let hint = overlapHint, !hint.isEmpty, next.hasPrefix(hint) {
                rawSize = hint.count
            } else {
                let exact = Self.overlapCount(anchor + seamTail, next)
                rawSize = exact > 0 ? exact : nil
            }
            if let size = rawSize {
                matched = size
                if size > seamTail.count {
                    // The shared acoustic text extends into the committed prefix.
                    partial = String(next.dropFirst(size - seamTail.count))
                } else {
                    partial = String(seamTail.dropLast(size)) + next
                }
            } else if let aligned = Self.normalizedOverlap(anchor: anchor, seamTail: seamTail, next: next) {
                matched = aligned.matchedRawInNext
                partial = aligned.reconciledPartial
            } else {
                // Uncertain model revisions: preserve the frozen unfixed tail.
                // This can repeat a seam, but cannot recursively re-append new
                // words already included by an earlier decode of this window.
                partial = Self.join(seamTail, next)
            }
        }
        // Remember only the most recent nonempty single-stride local growth, not a history.
        // A word may span several strides: equal hypotheses do not prove that
        // the retained audio contains no text. This hint also disambiguates
        // stable a/a -> a/a/a, where longest textual overlap would eat a word.
        if newSamples <= Self.stride {
            if let prior = previousHypothesis {
                if next != prior {
                    lastGrowth = nil
                    if next.hasPrefix(prior) {
                        let added = String(next.dropFirst(prior.count)).trimmingCharacters(in: .whitespacesAndNewlines)
                        if !added.isEmpty { lastGrowth = added }
                    }
                }
            } else {
                let added = String(next.dropFirst(matched)).trimmingCharacters(in: .whitespacesAndNewlines)
                if !added.isEmpty { lastGrowth = added }
            }
        } else {
            lastGrowth = nil
        }
        newSamples = 0
    }

    private mutating func rollWindow() {
        // When successive raw hypotheses extend exactly, their delta describes
        // the retained final stride. Prefer that acoustic seam over a longest
        // suffix match: identical repeated words can otherwise over-match.
        overlapText = nil
        if let prior = previousHypothesis, let current = hypothesis,
           current.count > prior.count, current.hasPrefix(prior) {
            let added = String(current.dropFirst(prior.count)).trimmingCharacters(in: .whitespacesAndNewlines)
            // Stable/no-progress or whitespace-only hypotheses prove no new
            // text, NOT zero acoustic overlap. Fall back to a nonempty local
            // hint/anchor; an empty candidate would match every hypothesis.
            if !added.isEmpty { overlapText = added }
        }
        overlapHint = nil
        if let growth = lastGrowth, !growth.isEmpty, let current = hypothesis, current.hasSuffix(growth) {
            overlapHint = growth
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
        overlapText = nil; overlapHint = nil; lastGrowth = nil
        hypothesis = nil; previousHypothesis = nil
        samples.removeAll(keepingCapacity: true)
        newSamples = 0; silentSamples = 0
    }

    private static func endsSentence(_ text: String) -> Bool {
        guard let last = text.last else { return false }
        return "，、；,;.。！？!?".contains(last)
    }

    private static func isOverlapIgnorable(_ c: Character) -> Bool {
        c.unicodeScalars.allSatisfy {
            CharacterSet.punctuationCharacters.contains($0)
                || CharacterSet.whitespacesAndNewlines.contains($0)
                || CharacterSet.symbols.contains($0)
        }
    }

    private static func normalizedOverlap(anchor: String, seamTail: String, next: String) -> (reconciledPartial: String, matchedRawInNext: Int)? {
        let lhsChars = Array((anchor + seamTail).suffix(64 + rollbackCharacters))
        let seamChars = Array(seamTail)
        let rhsChars = Array(next.prefix(64 + rollbackCharacters))
        let lhsNorm = lhsChars.filter { !isOverlapIgnorable($0) }.map { $0.lowercased() }
        let seamNormCount = seamChars.filter { !isOverlapIgnorable($0) }.count
        var rhsNorm: [String] = []
        var rhsRawEndForNormLen: [Int] = [0]
        for (idx, ch) in rhsChars.enumerated() {
            if !isOverlapIgnorable(ch) {
                rhsNorm.append(ch.lowercased())
                rhsRawEndForNormLen.append(idx + 1)
            }
        }
        let maxNorm = min(lhsNorm.count, rhsNorm.count)
        guard maxNorm >= 2 else { return nil }
        for len in Swift.stride(from: maxNorm, through: 2, by: -1) {
            if lhsNorm.suffix(len).elementsEqual(rhsNorm.prefix(len)) {
                let nextChars = Array(next)
                let matchedRaw = rhsRawEndForNormLen[len]
                if len > seamNormCount {
                    let dropNorm = len - seamNormCount
                    let dropRaw = rhsRawEndForNormLen[dropNorm]
                    return (String(nextChars.dropFirst(dropRaw)), matchedRaw)
                }
                // Drop trailing `len` non-ignorable chars (and trailing punctuation on them) from seamTail.
                var remainingNorm = len
                var keepEnd = seamChars.count
                while keepEnd > 0 && remainingNorm > 0 {
                    keepEnd -= 1
                    if !isOverlapIgnorable(seamChars[keepEnd]) {
                        remainingNorm -= 1
                    }
                }
                return (String(seamChars.prefix(keepEnd)) + next, matchedRaw)
            }
        }
        return nil
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


/// Caller holds the capture lock. PCM ownership swaps at take(), in O(1);
/// only copying admitted audio is O(n), bounded at 32s / 2,048,000 PCM bytes.
struct SpeechInbox {
    static let limit = 16000 * 320 / 10
    static let warmupSamples = 320 // 20ms at 16kHz drops route startup pop without clipping the first syllable
    static let audioLevelInterval: TimeInterval = 0.05 // ~20fps (50ms) main-thread audioLevel throttle
    private(set) var pending: [Float] = []
    private var scheduled = false
    private var speech = false
    private var trailingSilence = 0
    private(set) var warmupRemaining = SpeechInbox.warmupSamples
    private var pendingAudioLevel: Float?
    private var lastAudioLevelAt: TimeInterval = -.infinity
    enum Failure: Error { case overload }
    mutating func offer(_ input: [Float]) throws -> Bool {
        let skip = min(warmupRemaining, input.count)
        warmupRemaining -= skip
        let audio = input.dropFirst(skip)
        guard !audio.isEmpty else { return false }
        guard audio.count <= Self.limit - pending.count else { throw Failure.overload }
        let power = audio.reduce(Float(0)) { $0 + $1 * $1 }
        let level = min(1, sqrt(power / Float(audio.count)) * 3)
        pendingAudioLevel = level
        let voiced = level >= 0.01
        speech = speech || voiced
        trailingSilence = voiced ? 0 : trailingSilence + audio.count
        pending.append(contentsOf: audio)
        if scheduled { return false }
        scheduled = true
        return true
    }
    mutating func pollAudioLevel(now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Float? {
        guard warmupRemaining == 0, let level = pendingAudioLevel, now - lastAudioLevelAt >= Self.audioLevelInterval else { return nil }
        pendingAudioLevel = nil
        lastAudioLevelAt = now
        return level
    }
    struct Batch { let samples: [Float]; let speech: Bool; let trailingSilence: Int }
    mutating func take() -> Batch? {
        guard !pending.isEmpty else { scheduled = false; return nil }
        let batch = Batch(samples: pending, speech: speech, trailingSilence: trailingSilence)
        pending = []; speech = false; trailingSilence = 0
        return batch
    }
}
