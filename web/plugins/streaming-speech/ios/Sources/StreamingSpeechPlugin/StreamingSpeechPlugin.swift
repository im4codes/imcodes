import AVFoundation
import Capacitor
import Metal
import AudioCommon
import MLXCommon
import Qwen3ASR
import UIKit

// MARK: - System TTS Voice Selection

struct TtsVoiceCandidate: Equatable {
    enum QualityTier: Int, Comparable {
        case standard = 0
        case enhanced = 1
        case premium = 2

        static func < (lhs: QualityTier, rhs: QualityTier) -> Bool {
            lhs.rawValue < rhs.rawValue
        }
    }

    let identifier: String
    let name: String
    let language: String
    let quality: QualityTier
    let isNoveltyVoice: Bool
}

enum TtsVoiceSelector {
    static func normalizeBcp47LanguageTag(_ lang: String?) -> String? {
        guard let raw = lang?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        return raw.replacingOccurrences(of: "_", with: "-")
    }

    static func isSiriVoiceIdentifier(_ identifier: String) -> Bool {
        let lower = identifier.lowercased()
        return lower.contains(".siri") || lower.contains("ttsbundle.siri")
    }

    static func isMechanicalOrNovelty(_ candidate: TtsVoiceCandidate) -> Bool {
        if candidate.isNoveltyVoice {
            return true
        }
        let lower = candidate.identifier.lowercased()
        return lower.contains("com.apple.eloquence.")
            || lower.contains("com.apple.speech.synthesis.voice.")
    }

    static func score(_ candidate: TtsVoiceCandidate) -> Int {
        if isMechanicalOrNovelty(candidate) {
            return candidate.quality.rawValue
        }
        let lower = candidate.identifier.lowercased()
        let isSiri = isSiriVoiceIdentifier(lower)
        let isPremium = candidate.quality == .premium
            || lower.contains(".premium.")
            || lower.hasSuffix(".premium")
        if isPremium {
            return 600 + (isSiri ? 10 : 0)
        }
        let isEnhanced = candidate.quality == .enhanced
            || lower.contains(".enhanced.")
            || lower.hasSuffix(".enhanced")
        if isEnhanced {
            return 500 + (isSiri ? 10 : 0)
        }
        if isSiri {
            return 450
        }
        if lower.contains("super-compact") {
            return 200
        }
        if lower.contains(".compact") || lower.contains("-compact") || lower.contains("_compact") {
            return 300
        }
        return 100
    }

    static func selectIndex(for lang: String?, from candidates: [TtsVoiceCandidate]) -> Int? {
        guard let normalized = normalizeBcp47LanguageTag(lang) else {
            return nil
        }
        let lower = normalized.lowercased()
        let exactIndices = candidates.indices.filter { candidates[$0].language.lowercased() == lower }
        if let bestExact = exactIndices.max(by: { score(candidates[$0]) < score(candidates[$1]) }) {
            return bestExact
        }
        let primarySubtag = lower.split(separator: "-").first.map(String.init) ?? lower
        let primaryIndices = candidates.indices.filter {
            candidates[$0].language.lowercased().split(separator: "-").first.map(String.init) == primarySubtag
        }
        if let bestPrimary = primaryIndices.max(by: { score(candidates[$0]) < score(candidates[$1]) }) {
            return bestPrimary
        }
        return nil
    }

    static func selectCandidate(for lang: String?, from candidates: [TtsVoiceCandidate]) -> TtsVoiceCandidate? {
        guard let index = selectIndex(for: lang, from: candidates) else {
            return nil
        }
        return candidates[index]
    }
}

// MARK: - Background TTS Lifecycle Policy

enum TtsLifecycleEvent: Equatable {
    case willResignActive
    case didEnterBackground
    case audioSessionInterruptionBegan
    case audioSessionInterruptionEnded
}

struct TtsLifecycleDecision: Equatable {
    let shouldStopCapture: Bool
    let shouldStopTts: Bool
    let shouldDeactivateAudioSession: Bool
    let shouldScheduleWarmHold: Bool
}

enum TtsBackgroundLifecyclePolicy {
    static func decide(
        event: TtsLifecycleEvent,
        isTtsActive: Bool,
        hasActiveCapture: Bool
    ) -> TtsLifecycleDecision {
        switch event {
        case .audioSessionInterruptionEnded:
            return TtsLifecycleDecision(
                shouldStopCapture: false,
                shouldStopTts: false,
                shouldDeactivateAudioSession: false,
                shouldScheduleWarmHold: false
            )
        case .audioSessionInterruptionBegan:
            return TtsLifecycleDecision(
                shouldStopCapture: true,
                shouldStopTts: isTtsActive,
                shouldDeactivateAudioSession: true,
                shouldScheduleWarmHold: false
            )
        case .willResignActive, .didEnterBackground:
            if isTtsActive {
                // Keep AVAudioSession alive for the active utterance; stop capture only if a race left STT open,
                // never deactivating or scheduling warm-hold while TTS is speaking.
                return TtsLifecycleDecision(
                    shouldStopCapture: hasActiveCapture,
                    shouldStopTts: false,
                    shouldDeactivateAudioSession: false,
                    shouldScheduleWarmHold: false
                )
            }
            return TtsLifecycleDecision(
                shouldStopCapture: true,
                shouldStopTts: false,
                shouldDeactivateAudioSession: true,
                shouldScheduleWarmHold: false
            )
        }
    }
}

/// Pure Foundation/Dispatch session coordinator managing capture ownership, foreground Metal
/// gating, serial inbox draining, and lossless background/stop error reporting.
final class SpeechCoordinator {
    enum Event: Equatable {
        case started
        case stopped
        case audioLevel(Float)
        case partial(String)
        case final(String)
        case error(String)
    }
    enum CaptureResult {
        case samples([Float])
        case failure(String)
        case ignore
    }
    typealias DecodeResult = (text: String, tokens: [Int32])
    typealias DecodeFn = ([Float], [Int32], @escaping () -> Bool) -> DecodeResult?
    typealias RollbackPrefixFn = ([Int32], Int) -> [Int32]
    struct Decoder {
        let decode: DecodeFn
        let rollbackPrefix: RollbackPrefixFn
        init(
            decode: @escaping DecodeFn,
            rollbackPrefix: @escaping RollbackPrefixFn = SpeechWindow.defaultRollbackPrefix
        ) {
            self.decode = decode
            self.rollbackPrefix = rollbackPrefix
        }
    }

    private let lock = NSCondition()
    static let sharedMlxWorker = DispatchQueue(label: "com.imcodes.streaming-speech", qos: .userInteractive)
    let worker: DispatchQueue
    private let emitQueue: DispatchQueue
    private let onEvent: (Event) -> Void

    private var generation: UInt64 = 0
    private var eventOwner: UInt64 = 0
    private var inboxOwner: UInt64 = 0
    private var inFlightCapturesByOwner: [UInt64: Int] = [:]
    private var pendingStopCaptureError: [UInt64: String] = [:]
    private var stopInitiatedOwners: Set<UInt64> = []
    private var abortedOwner: UInt64 = 0
    private var isAppBackgrounded = false
    private var inbox = SpeechInbox()
    private var window = SpeechWindow()
    private var activeDecoder: Decoder?
    private var decoderOwner: UInt64 = 0
    private var startPendingOwner: UInt64 = 0
    private var startReadyCallback: (() -> Void)?
    private var drainInterruptedOwner: UInt64 = 0
    private var reportedErrorOwner: UInt64 = 0
    private var stoppedEmittedOwner: UInt64 = 0
    private var pendingStopCallbacks: [UInt64: [(String?) -> Void]] = [:]
    private var settledStopErrors: [UInt64: String?] = [:]

    init(
        worker: DispatchQueue = SpeechCoordinator.sharedMlxWorker,
        emitQueue: DispatchQueue = .main,
        onEvent: @escaping (Event) -> Void
    ) {
        self.worker = worker
        self.emitQueue = emitQueue
        self.onEvent = onEvent
    }

    func isCurrent(_ owner: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return generation == owner
    }

    func isEventOwner(_ owner: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return eventOwner == owner
    }

    func canRunMetal(_ owner: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return eventOwner == owner && !isAppBackgrounded
    }

    var isBackgrounded: Bool {
        lock.lock(); defer { lock.unlock() }
        return isAppBackgrounded
    }

    var hasActiveCapture: Bool {
        lock.lock(); defer { lock.unlock() }
        return eventOwner != 0 && stoppedEmittedOwner != eventOwner
    }

    private func claimStoppedEmissionLocked(for owner: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard eventOwner == owner, stoppedEmittedOwner != owner else { return false }
        stoppedEmittedOwner = owner
        return true
    }

    private func releaseCaptureLeaseLocked(for owner: UInt64) {
        let remaining = (inFlightCapturesByOwner[owner] ?? 1) - 1
        if remaining <= 0 {
            inFlightCapturesByOwner.removeValue(forKey: owner)
            lock.broadcast()
        } else {
            inFlightCapturesByOwner[owner] = remaining
        }
    }

    private func deliverStopOutcome(
        owner: UInt64,
        finalText: String? = nil,
        errorMessage: String? = nil,
        outcomeError: String?,
        callbacks: [(String?) -> Void]
    ) {
        emitQueue.async { [weak self] in
            guard let self = self else {
                for cb in callbacks { cb(outcomeError) }
                return
            }
            if let finalText = finalText, self.isEventOwner(owner) {
                self.onEvent(.final(finalText))
            }
            if let errorMessage = errorMessage, self.isEventOwner(owner) {
                self.onEvent(.error(errorMessage))
            }
            if self.claimStoppedEmissionLocked(for: owner) {
                self.onEvent(.stopped)
            }
            for cb in callbacks {
                cb(outcomeError)
            }
        }
    }

    func beginStart(
        warmupSamples: Int = SpeechInbox.warmupSamples,
        makeDecode: @escaping () -> Decoder?,
        onStartReady: @escaping () -> Void,
        onSetupFailureTeardown: @escaping () -> Void
    ) -> UInt64 {
        lock.lock()
        generation &+= 1
        let owner = generation
        eventOwner = owner
        inboxOwner = owner
        abortedOwner = 0
        isAppBackgrounded = false
        inbox = SpeechInbox(warmupSamples: warmupSamples)
        pendingStopCaptureError.removeAll()
        stopInitiatedOwners.removeAll()
        startPendingOwner = owner
        startReadyCallback = onStartReady
        drainInterruptedOwner = 0
        reportedErrorOwner = 0
        settledStopErrors.removeAll()
        lock.broadcast()
        lock.unlock()

        // Enqueue decoder setup on the serial worker queue BEFORE starting AVAudioEngine
        // so any audio buffers captured while the model finishes warming up are queued
        // strictly behind this setup block and decoded in order without losing the first words.
        worker.async { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let aborted = self.abortedOwner == owner || self.eventOwner != owner
            self.lock.unlock()
            guard !aborted else { return }
            guard let decoder = makeDecode() else {
                self.lock.lock()
                if self.decoderOwner == owner || self.decoderOwner == 0 {
                    self.activeDecoder = nil
                    self.decoderOwner = 0
                }
                let shouldReport = self.eventOwner == owner && self.reportedErrorOwner != owner
                if shouldReport { self.reportedErrorOwner = owner }
                self.lock.unlock()
                if shouldReport {
                    self.emitQueue.async {
                        if self.isEventOwner(owner) {
                            self.onEvent(.error("Offline speech model initialization failed"))
                            onSetupFailureTeardown()
                        }
                    }
                }
                return
            }
            self.lock.lock()
            let stillActive = self.eventOwner == owner
            self.lock.unlock()
            guard stillActive else { return }
            self.activeDecoder = decoder
            self.decoderOwner = owner
            self.window = SpeechWindow()
        }
        return owner
    }

    func cancelStartSetup(owner: UInt64) {
        lock.lock()
        abortedOwner = owner
        if startPendingOwner == owner {
            startPendingOwner = 0
            startReadyCallback = nil
        }
        lock.unlock()
    }

    func markStarted(owner: UInt64) {
        lock.lock()
        guard generation == owner, eventOwner == owner, startPendingOwner == owner else {
            lock.unlock()
            return
        }
        startPendingOwner = 0
        let readyCallback = startReadyCallback
        startReadyCallback = nil
        lock.unlock()

        emitQueue.async { [weak self] in
            readyCallback?()
            guard let self = self, self.isCurrent(owner) else { return }
            self.onEvent(.started)
        }
    }

    func failCapture(owner: UInt64, message: String, teardown: @escaping () -> Void) {
        emitQueue.async { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let shouldReport = self.generation == owner && self.eventOwner == owner && self.reportedErrorOwner != owner
            if shouldReport { self.reportedErrorOwner = owner }
            self.lock.unlock()
            guard shouldReport else { return }
            self.onEvent(.error(message))
            teardown()
        }
    }

    @discardableResult
    func admitAndOffer(
        owner: UInt64,
        now: TimeInterval = ProcessInfo.processInfo.systemUptime,
        onOverloadTeardown: @escaping () -> Void,
        onErrorTeardown: (() -> Void)? = nil,
        produce: () -> CaptureResult
    ) -> Bool {
        lock.lock()
        guard generation == owner, inboxOwner == owner else {
            lock.unlock()
            return false
        }
        inFlightCapturesByOwner[owner, default: 0] += 1
        lock.unlock()

        let result = produce()

        lock.lock()
        releaseCaptureLeaseLocked(for: owner)
        guard inboxOwner == owner else {
            lock.unlock()
            return true
        }
        if generation != owner {
            switch result {
            case .samples(let samples):
                do {
                    _ = try inbox.offer(samples)
                } catch {
                    if pendingStopCaptureError[owner] == nil {
                        pendingStopCaptureError[owner] = "Offline speech processing overloaded"
                    }
                }
            case .failure(let message):
                if pendingStopCaptureError[owner] == nil {
                    pendingStopCaptureError[owner] = message
                }
            case .ignore:
                break
            }
            lock.unlock()
            return true
        }

        switch result {
        case .samples(let samples):
            do {
                let schedule = try inbox.offer(samples)
                let level = inbox.pollAudioLevel(now: now)
                lock.unlock()

                if let level = level {
                    emitQueue.async { [weak self] in
                        guard let self = self else { return }
                        self.lock.lock()
                        let active = self.generation == owner && self.eventOwner == owner
                        self.lock.unlock()
                        guard active else { return }
                        self.onEvent(.audioLevel(level))
                    }
                }
                if schedule {
                    worker.async { [weak self] in self?.drain(owner: owner) }
                }
            } catch {
                lock.unlock()
                // Bounded admission fails visibly; never silently discard words.
                failCapture(owner: owner, message: "Offline speech processing overloaded", teardown: onOverloadTeardown)
            }
        case .failure(let message):
            lock.unlock()
            failCapture(owner: owner, message: message, teardown: onErrorTeardown ?? onOverloadTeardown)
        case .ignore:
            lock.unlock()
        }
        return true
    }

    func offerSamples(
        _ samples: [Float],
        owner: UInt64,
        now: TimeInterval = ProcessInfo.processInfo.systemUptime,
        onOverloadTeardown: @escaping () -> Void
    ) {
        _ = admitAndOffer(owner: owner, now: now, onOverloadTeardown: onOverloadTeardown) {
            .samples(samples)
        }
    }

    func setBackgrounded(_ backgrounded: Bool) {
        lock.lock()
        isAppBackgrounded = backgrounded
        lock.unlock()
    }

    func endCapture(
        stopCompletion: ((String?) -> Void)? = nil,
        stopAudio: () -> Void,
        onAsyncErrorTeardown: (() -> Void)? = nil
    ) {
        _ = onAsyncErrorTeardown
        lock.lock()
        let owner = eventOwner
        generation &+= 1
        if owner == 0 {
            var readyCallback: (() -> Void)?
            if startPendingOwner == 0 {
                readyCallback = startReadyCallback
                startReadyCallback = nil
            }
            lock.unlock()
            readyCallback?()
            stopAudio()
            if let stopCompletion = stopCompletion {
                emitQueue.async { stopCompletion(nil) }
            }
            return
        }

        let isFirstStopForOwner = !stopInitiatedOwners.contains(owner)
        if isFirstStopForOwner {
            stopInitiatedOwners.insert(owner)
            while inboxOwner == owner && (inFlightCapturesByOwner[owner] ?? 0) > 0 {
                lock.wait()
            }
        }
        let takeTail = isFirstStopForOwner && inboxOwner == owner
        let tail = takeTail ? inbox.take() : nil
        let captureFailure = takeTail ? pendingStopCaptureError.removeValue(forKey: owner) : nil
        if takeTail {
            inboxOwner = 0
        }

        var readyCallback: (() -> Void)?
        if startPendingOwner == owner {
            startPendingOwner = 0
            readyCallback = startReadyCallback
            startReadyCallback = nil
        }

        if !isFirstStopForOwner, let existingOutcome = settledStopErrors[owner] {
            let callbacks = stopCompletion.map { [$0] } ?? []
            let stoppedPending = eventOwner == owner && stoppedEmittedOwner != owner
            lock.unlock()
            readyCallback?()
            stopAudio()
            if stoppedPending || !callbacks.isEmpty {
                deliverStopOutcome(owner: owner, outcomeError: existingOutcome, callbacks: callbacks)
            }
            return
        }

        if let stopCompletion = stopCompletion {
            pendingStopCallbacks[owner, default: []].append(stopCompletion)
        }
        lock.unlock()

        // Stop during warmup must also settle the pending start promise.
        readyCallback?()
        // Release lock before AVAudioEngine teardown so removeTap/engine.stop cannot deadlock.
        stopAudio()
        guard isFirstStopForOwner else { return }

        worker.async { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let alreadyReportedError = self.reportedErrorOwner == owner
            let wasDrainInterrupted = self.drainInterruptedOwner == owner
            self.lock.unlock()

            let tailHasSpeech = tail.map { !$0.samples.isEmpty && ($0.speech || !self.window.samples.isEmpty) } ?? false
            let hadUnflushedSpeech = (self.window.newSamples > 0) || tailHasSpeech || wasDrainInterrupted

            var outcomeError: String?
            var errorToEmit: String?
            var finalToEmit: String?

            if let captureFailure = captureFailure {
                if self.isEventOwner(owner) {
                    outcomeError = captureFailure
                    if !alreadyReportedError { errorToEmit = captureFailure }
                }
            } else if self.isEventOwner(owner) {
                if self.decoderOwner == owner, let decoder = self.activeDecoder, self.canRunMetal(owner) {
                    do {
                        if let tail = tail {
                            try self.window.append(
                                tail.samples,
                                speech: tail.speech,
                                trailingSilence: tail.trailingSilence,
                                activeSamples: tail.activeSamples,
                                noiseFloorRMS: tail.noiseFloorRMS,
                                final: true,
                                shouldContinue: { [weak self] in self?.canRunMetal(owner) ?? false },
                                rollbackPrefix: decoder.rollbackPrefix,
                                decode: { [weak self] samples, prefixTokens in
                                    decoder.decode(samples, prefixTokens) { self?.canRunMetal(owner) ?? false }
                                }
                            ) { _ in }
                        }
                        guard self.canRunMetal(owner) else { throw SpeechWindow.Failure.cancelled }
                        let text = try self.window.finish(
                            shouldContinue: { [weak self] in self?.canRunMetal(owner) ?? false },
                            rollbackPrefix: decoder.rollbackPrefix
                        ) { samples, prefixTokens in
                            decoder.decode(samples, prefixTokens) { [weak self] in self?.canRunMetal(owner) ?? false }
                        }
                        finalToEmit = text
                    } catch SpeechWindow.Failure.cancelled {
                        if self.isEventOwner(owner) {
                            let msg = "Offline speech interrupted before final flush"
                            outcomeError = msg
                            if !alreadyReportedError { errorToEmit = msg }
                        }
                    } catch {
                        // Preserve the last successful hypothesis on a visible non-cancel error;
                        // never silently replace the full transcript with an empty tail.
                        finalToEmit = self.window.text
                        if !alreadyReportedError { errorToEmit = "Offline speech final decoding failed" }
                    }
                } else if alreadyReportedError {
                    outcomeError = "Offline speech interrupted"
                } else if hadUnflushedSpeech {
                    // Never mark partial/un-decoded tail as a complete final or silently ACK.
                    let msg = "Offline speech interrupted before final flush"
                    outcomeError = msg
                    errorToEmit = msg
                } else if self.decoderOwner == owner, self.activeDecoder != nil {
                    finalToEmit = self.window.text
                }
            }

            if self.decoderOwner == owner || self.decoderOwner == 0 {
                self.window = SpeechWindow()
                self.activeDecoder = nil
                self.decoderOwner = 0
            }

            self.lock.lock()
            if errorToEmit != nil { self.reportedErrorOwner = owner }
            self.settledStopErrors[owner] = outcomeError
            let callbacks = self.pendingStopCallbacks.removeValue(forKey: owner) ?? []
            self.lock.unlock()

            self.deliverStopOutcome(
                owner: owner,
                finalText: finalToEmit,
                errorMessage: errorToEmit,
                outcomeError: outcomeError,
                callbacks: callbacks
            )
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
            guard decoderOwner == owner, let decoder = activeDecoder else {
                lock.lock()
                if eventOwner == owner && isAppBackgrounded && (!batch.samples.isEmpty && (batch.speech || !window.samples.isEmpty)) {
                    drainInterruptedOwner = owner
                }
                lock.unlock()
                return
            }
            let batchHasSpeech = !batch.samples.isEmpty && (batch.speech || !window.samples.isEmpty)
            do {
                try window.append(
                    batch.samples,
                    speech: batch.speech,
                    trailingSilence: batch.trailingSilence,
                    activeSamples: batch.activeSamples,
                    noiseFloorRMS: batch.noiseFloorRMS,
                    shouldEmitNonFinal: { [weak self] in self?.isCurrent(owner) ?? false },
                    shouldContinue: { [weak self] in self?.canRunMetal(owner) ?? false },
                    rollbackPrefix: decoder.rollbackPrefix,
                    decode: { [weak self] samples, prefixTokens in
                        decoder.decode(samples, prefixTokens) { self?.canRunMetal(owner) ?? false }
                    }
                ) { [weak self] text in
                    guard let self = self else { return }
                    self.emitQueue.async {
                        if self.isEventOwner(owner) {
                            self.onEvent(.partial(text))
                        }
                    }
                }
            } catch SpeechWindow.Failure.cancelled {
                lock.lock()
                if eventOwner == owner && isAppBackgrounded && (batchHasSpeech || window.newSamples > 0) {
                    drainInterruptedOwner = owner
                }
                lock.unlock()
                return
            } catch {
                lock.lock()
                let shouldReport = generation == owner && eventOwner == owner && reportedErrorOwner != owner
                if shouldReport { reportedErrorOwner = owner }
                lock.unlock()
                if shouldReport {
                    emitQueue.async {
                        if self.isCurrent(owner) {
                            self.onEvent(.error("Offline speech decoding failed"))
                            self.endCapture(stopAudio: {})
                        }
                    }
                }
                return
            }
        }
    }
}

/// The same Capacitor event contract as the existing voice input. No cloud service.
@objc(StreamingSpeechPlugin)
public class StreamingSpeechPlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "StreamingSpeechPlugin"
    public let jsName = "StreamingSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prewarm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeaking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isSpeaking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTtsVoiceQuality", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openTtsSettings", returnType: CAPPluginReturnPromise)
    ]
    private lazy var coordinator = SpeechCoordinator { [weak self] event in
        guard let self = self else { return }
        switch event {
        case .started:
            self.notifyListeners("listeningState", data: ["status": "started"])
        case .stopped:
            self.notifyListeners("listeningState", data: ["status": "stopped"])
        case .audioLevel(let level):
            self.notifyListeners("audioLevel", data: ["level": level])
        case .partial(let text):
            self.notifyListeners("partialResults", data: ["matches": [text], "isFinal": false])
        case .final(let text):
            self.notifyListeners("partialResults", data: ["matches": [text], "isFinal": true])
        case .error(let message):
            self.notifyListeners("recognitionError", data: ["message": message])
        }
    }
    private static let audioQueueKey = DispatchSpecificKey<Bool>()
    private let audioQueue: DispatchQueue = {
        let queue = DispatchQueue(label: "com.imcodes.streaming-speech.audio", qos: .userInteractive)
        queue.setSpecific(key: StreamingSpeechPlugin.audioQueueKey, value: true)
        return queue
    }()
    var isOnAudioQueueForTesting: Bool {
        DispatchQueue.getSpecific(key: Self.audioQueueKey) == true
    }
    // Audio capture graph & AVAudioSession state are owned strictly by audioQueue.
    private var engine: AVAudioEngine?
    private var tapInstalled = false
    private var cachedInputFormat: AVAudioFormat?
    private var cachedMonoFormat: AVAudioFormat?
    private var cachedConverter: AVAudioConverter?
    private var audioSessionCategoryConfigured = false
    private var audioSessionActive = false
    private static let warmHoldIdleTimeout: TimeInterval = 20.0
    private var warmHoldIdleWorkItem: DispatchWorkItem? // audioQueue only
    private var warmHoldGeneration: UInt64 = 0 // audioQueue only
    // Call & lifecycle tracking on main thread.
    private var activeMainOwner: UInt64 = 0
    private var startingCall: CAPPluginCall? // main-thread only
    private var warmupWatchdog: DispatchWorkItem? // main-thread only
    // System TTS synthesizer & utterance generation tracking (main-thread only).
    private var speechSynthesizer: AVSpeechSynthesizer?
    private var ttsUtteranceId: UInt64 = 0
    private var ttsUtteranceMap: [ObjectIdentifier: UInt64] = [:]
    private var ttsSpeaking = false
    private var ttsPreparingPlayback = false
    private var isTtsPlaybackActiveOnMain: Bool {
        ttsSpeaking || ttsPreparingPlayback || (speechSynthesizer?.isSpeaking ?? false)
    }
    // Resident recognizer model kept across sessions on worker; Metal state is guarded for foreground use.
    private var recognizer: SpeechRecognizer?

    public override func load() {
        coordinator.setBackgrounded(UIApplication.shared.applicationState == .background)
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackground(_:)), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didBecomeActive(_:)), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(engineConfigurationChanged(_:)), name: .AVAudioEngineConfigurationChange, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didReceiveMemoryWarning(_:)), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
        SharedSpeechRecognizerStore.shared.ensureBackgroundModelDownloadIfNeeded { [weak self] ready in
            guard ready else { return }
            self?.warmUpRecognizerOnWorkerIfIdle()
        }
    }

    private func warmUpRecognizerOnWorkerIfIdle() {
        coordinator.worker.async { [weak self] in
            guard let self = self,
                  !self.coordinator.isBackgrounded,
                  !self.coordinator.hasActiveCapture,
                  let recognizer = self.ensureRecognizer() else { return }
            recognizer.warmupMetalIfNeeded { [weak self] in
                guard let self = self else { return false }
                return !self.coordinator.isBackgrounded && !self.coordinator.hasActiveCapture
            }
        }
    }
    @objc private func didReceiveMemoryWarning(_ notification: Notification) {
        coordinator.worker.async { [weak self] in
            SharedSpeechRecognizerStore.shared.clearInferenceCaches()
            self?.recognizer?.model.clearInferenceCaches()
            Qwen3ASRModel.clearMetalCache()
        }
    }
    deinit {
        NotificationCenter.default.removeObserver(self)
        warmupWatchdog?.cancel()
        warmupWatchdog = nil
        warmHoldIdleWorkItem?.cancel()
        warmHoldIdleWorkItem = nil
        speechSynthesizer?.delegate = nil
        speechSynthesizer?.stopSpeaking(at: .immediate)
        speechSynthesizer = nil
        let retainedRecognizer = recognizer
        if retainedRecognizer != nil {
            coordinator.worker.async {
                _ = retainedRecognizer
            }
        }
    }
    private func cancelWarmupWatchdog() {
        warmupWatchdog?.cancel()
        warmupWatchdog = nil
    }
    private func settleStartingCall(errorMessage: String? = nil) {
        cancelWarmupWatchdog()
        guard let call = startingCall else { return }
        startingCall = nil
        if let errorMessage = errorMessage {
            call.reject(errorMessage)
        } else {
            call.resolve()
        }
    }
    private func ensureRecognizer() -> SpeechRecognizer? {
        if let existing = recognizer { return existing }
        guard let shared = SharedSpeechRecognizerStore.shared.ensureRecognizer() else { return nil }
        recognizer = shared
        return shared
    }
    private func isMetalDeviceAvailable() -> Bool {
        SpeechRecognizer.isMetalSupported
    }
    var modelRoot: URL? { SharedSpeechRecognizerStore.shared.modelRoot }
    private var modelAvailable: Bool {
        guard isMetalDeviceAvailable() else { return false }
        return SharedSpeechRecognizerStore.shared.hasRequiredModelFiles
    }
    @objc public func available(_ call: CAPPluginCall) {
        let downloadStatus = SharedSpeechRecognizerStore.shared.downloadStatus
        call.resolve([
            "available": modelAvailable,
            "downloading": downloadStatus.isDownloading,
            "progress": downloadStatus.progress,
        ])
    }
    func requestRecordPermission(
        requester: @escaping (@escaping (Bool) -> Void) -> Void = { completion in
            AVAudioSession.sharedInstance().requestRecordPermission(completion)
        },
        completion: @escaping (Bool) -> Void
    ) {
        audioQueue.async {
            dispatchPrecondition(condition: .onQueue(self.audioQueue))
            requester { allowed in
                DispatchQueue.main.async {
                    completion(allowed)
                }
            }
        }
    }

    static func mapRecordPermissionStatus(_ permission: AVAudioSession.RecordPermission) -> String {
        switch permission {
        case .granted:
            return "granted"
        case .denied:
            return "denied"
        case .undetermined:
            return "prompt"
        @unknown default:
            return "prompt"
        }
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(["speechRecognition": Self.mapRecordPermissionStatus(AVAudioSession.sharedInstance().recordPermission)])
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        requestRecordPermission { allowed in
            call.resolve(["speechRecognition": allowed ? "granted" : "denied"])
        }
    }
    @objc public func prewarm(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let backgrounded = UIApplication.shared.applicationState == .background
            self.coordinator.setBackgrounded(backgrounded)
            if !backgrounded && self.modelAvailable {
                self.warmUpRecognizerOnWorkerIfIdle()
            }
            self.audioQueue.async { [weak self] in
                self?.prewarmAudioOnAudioQueue()
                call.resolve()
            }
        }
    }

    private func preferBuiltInMicIfAvailable(session: AVAudioSession) {
        dispatchPrecondition(condition: .onQueue(audioQueue))
        guard let builtInMic = session.availableInputs?.first(where: { $0.portType == .builtInMic }) else {
            return
        }
        if session.preferredInput?.uid != builtInMic.uid {
            try? session.setPreferredInput(builtInMic)
        }
    }

    private func configureAudioSessionCategoryIfNeeded(session: AVAudioSession) throws {
        dispatchPrecondition(condition: .onQueue(audioQueue))
        let desiredOptions: AVAudioSession.CategoryOptions = [.mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP]
        let categoryMatches = audioSessionCategoryConfigured
            && session.category == .playAndRecord
            && (session.mode == .spokenAudio || session.mode == .default)
            && session.categoryOptions.contains(desiredOptions)
            && !session.categoryOptions.contains(.allowBluetooth)
        if !categoryMatches {
            do {
                try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP])
            } catch {
                try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
            }
            audioSessionCategoryConfigured = true
        }
    }

    private func cancelWarmHoldDeactivationOnAudioQueue() {
        dispatchPrecondition(condition: .onQueue(audioQueue))
        warmHoldGeneration &+= 1
        warmHoldIdleWorkItem?.cancel()
        warmHoldIdleWorkItem = nil
    }

    private func scheduleWarmHoldDeactivationOnAudioQueue() {
        dispatchPrecondition(condition: .onQueue(audioQueue))
        cancelWarmHoldDeactivationOnAudioQueue()
        let token = warmHoldGeneration
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            dispatchPrecondition(condition: .onQueue(self.audioQueue))
            guard self.warmHoldGeneration == token,
                  !self.tapInstalled,
                  self.audioSessionActive else { return }
            self.warmHoldIdleWorkItem = nil
            self.invalidateEngineOnAudioQueue()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            self.audioSessionActive = false
        }
        warmHoldIdleWorkItem = work
        audioQueue.asyncAfter(deadline: .now() + Self.warmHoldIdleTimeout, execute: work)
    }

    private func invalidateEngineOnAudioQueue() {
        dispatchPrecondition(condition: .onQueue(audioQueue))
        if tapInstalled {
            engine?.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        engine?.stop()
        engine = nil
        cachedInputFormat = nil
        cachedMonoFormat = nil
        cachedConverter = nil
    }

    private func prepareGraphOnAudioQueue() throws -> (
        engine: AVAudioEngine,
        format: AVAudioFormat,
        mono: AVAudioFormat,
        converter: AVAudioConverter
    ) {
        dispatchPrecondition(condition: .onQueue(audioQueue))
        if let existing = engine {
            let format = existing.inputNode.outputFormat(forBus: 0)
            if format.sampleRate > 0, format.channelCount > 0 {
                if let cachedIn = cachedInputFormat,
                   let cachedMono = cachedMonoFormat,
                   let cachedConv = cachedConverter,
                   cachedIn == format {
                    return (existing, format, cachedMono, cachedConv)
                }
                if tapInstalled {
                    existing.inputNode.removeTap(onBus: 0)
                    tapInstalled = false
                }
                if let mono = cachedMonoFormat ?? AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
                   let converter = AVAudioConverter(from: format, to: mono) {
                    cachedInputFormat = format
                    cachedMonoFormat = mono
                    cachedConverter = converter
                    return (existing, format, mono, converter)
                }
            }
            invalidateEngineOnAudioQueue()
        }

        let created = AVAudioEngine()
        let format = created.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "StreamingSpeech", code: 1, userInfo: [NSLocalizedDescriptionKey: "Microphone format unavailable"])
        }
        guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: format, to: mono) else {
            throw NSError(domain: "StreamingSpeech", code: 2, userInfo: nil)
        }
        created.prepare()
        engine = created
        cachedInputFormat = format
        cachedMonoFormat = mono
        cachedConverter = converter
        return (created, format, mono, converter)
    }

    private func prewarmAudioOnAudioQueue() {
        dispatchPrecondition(condition: .onQueue(audioQueue))
        guard !tapInstalled else { return }
        let session = AVAudioSession.sharedInstance()
        try? configureAudioSessionCategoryIfNeeded(session: session)
        // Touching inputNode when permission is .undetermined can trigger the OS prompt;
        // only prepare AVAudioEngine passively when mic permission is already granted,
        // and never activate AVAudioSession while idle.
        guard session.recordPermission == .granted else { return }
        if audioSessionActive {
            preferBuiltInMicIfAvailable(session: session)
        }
        if let existing = engine {
            if !existing.isRunning {
                existing.prepare()
            }
            return
        }
        _ = try? prepareGraphOnAudioQueue()
    }

    private func installTapAndStartOnAudioQueue(owner: UInt64) throws {
        dispatchPrecondition(condition: .onQueue(audioQueue))
        let installAndStart: (AVAudioEngine, AVAudioFormat, AVAudioFormat, AVAudioConverter) throws -> Void = { eng, fmt, mono, conv in
            if self.tapInstalled {
                eng.inputNode.removeTap(onBus: 0)
                self.tapInstalled = false
            }
            let tapFrames = AVAudioFrameCount(max(512, Int(fmt.sampleRate / 40)))
            eng.inputNode.installTap(onBus: 0, bufferSize: tapFrames, format: fmt) { [weak self] buffer, _ in
                self?.consume(buffer, owner: owner, converter: conv, mono: mono)
            }
            self.tapInstalled = true
            try eng.start()
        }

        let hadExistingEngine = (engine != nil)
        let graph = try prepareGraphOnAudioQueue()
        do {
            try installAndStart(graph.engine, graph.format, graph.mono, graph.converter)
        } catch {
            guard hadExistingEngine else { throw error }
            invalidateEngineOnAudioQueue()
            let rebuilt = try prepareGraphOnAudioQueue()
            try installAndStart(rebuilt.engine, rebuilt.format, rebuilt.mono, rebuilt.converter)
        }
    }

    private func stopCaptureAudioOnAudioQueue(deactivateSession: Bool, forceTeardown: Bool, allowWarmHold: Bool = true) {
        dispatchPrecondition(condition: .onQueue(audioQueue))
        cancelWarmHoldDeactivationOnAudioQueue()
        if tapInstalled {
            engine?.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        if let engine = engine {
            if forceTeardown {
                invalidateEngineOnAudioQueue()
            } else if engine.isRunning {
                engine.stop()
                if !deactivateSession {
                    engine.prepare()
                }
            }
        }
        if forceTeardown {
            audioSessionCategoryConfigured = false
        }
        if deactivateSession {
            if audioSessionActive {
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                audioSessionActive = false
            }
        } else if allowWarmHold && audioSessionActive {
            scheduleWarmHoldDeactivationOnAudioQueue()
        }
    }

    @objc public func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState != .background else {
                call.reject("Speech requires a foreground app"); return
            }
            guard self.modelAvailable else {
                call.reject("Offline speech model missing"); return
            }
            if self.ttsSpeaking || (self.speechSynthesizer?.isSpeaking ?? false) {
                self.stopTtsPlaybackOnMain(deactivateSession: false)
            }
            if self.activeMainOwner != 0 || self.startingCall != nil {
                self.settleStartingCall(errorMessage: "Offline speech superseded by new session")
                self.endCapture(nil, deactivateSession: false)
            }
            WatchAsrBridge.shared.cancelExternalStream(
                reason: "iPhone microphone session is active",
                code: "phone_mic_busy"
            )
            SharedSpeechRecognizerStore.shared.setPhoneCaptureActive(true)
            let expectedCall = call
            self.startingCall = call
            let targetLanguage = Qwen3LanguageMapper.resolve(call.getString("language"))
            let owner = self.coordinator.beginStart(
                makeDecode: { [weak self] in
                    guard let self = self,
                          let recognizer = self.ensureRecognizer(),
                          let decoder = SpeechDecoder(recognizer: recognizer, language: targetLanguage) else { return nil }
                    return SpeechCoordinator.Decoder(
                        decode: { samples, prefixTokens, shouldContinue in
                            decoder.decode(samples: samples, prefixTokens: prefixTokens, shouldContinue: shouldContinue)
                        },
                        rollbackPrefix: { tokens, rollbackCount in
                            decoder.rollbackPrefix(tokens, rollbackCount: rollbackCount)
                        }
                    )
                },
                onStartReady: { [weak self, weak expectedCall] in
                    guard let self = self, let expectedCall = expectedCall,
                          self.startingCall === expectedCall else { return }
                    self.settleStartingCall()
                },
                onSetupFailureTeardown: { [weak self] in
                    self?.settleStartingCall(errorMessage: "Offline speech model initialization failed")
                    self?.endCapture(nil)
                }
            )
            self.activeMainOwner = owner
            let watchdog = DispatchWorkItem { [weak self, weak expectedCall] in
                guard let self = self, let expectedCall = expectedCall,
                      self.startingCall === expectedCall else { return }
                self.settleStartingCall(errorMessage: "Offline speech microphone failed to start")
                self.coordinator.cancelStartSetup(owner: owner)
                self.endCapture(nil)
            }
            self.cancelWarmupWatchdog()
            self.warmupWatchdog = watchdog
            DispatchQueue.main.asyncAfter(deadline: .now() + 12.0, execute: watchdog)

            self.audioQueue.async { [weak self] in
                guard let self = self else { return }
                guard self.coordinator.isCurrent(owner) else {
                    DispatchQueue.main.async {
                        if self.startingCall === expectedCall {
                            self.settleStartingCall(errorMessage: "Offline speech cancelled during startup")
                        }
                    }
                    return
                }
                let session = AVAudioSession.sharedInstance()
                guard session.recordPermission == .granted else {
                    self.coordinator.cancelStartSetup(owner: owner)
                    DispatchQueue.main.async {
                        if self.startingCall === expectedCall {
                            self.settleStartingCall(errorMessage: "Microphone permission denied")
                        }
                        if self.activeMainOwner == owner {
                            self.activeMainOwner = 0
                        }
                        self.endCapture(nil, deactivateSession: false)
                    }
                    return
                }
                do {
                    self.cancelWarmHoldDeactivationOnAudioQueue()
                    try self.configureAudioSessionCategoryIfNeeded(session: session)
                    if !self.audioSessionActive {
                        try session.setActive(true)
                        self.audioSessionActive = true
                    }
                    self.preferBuiltInMicIfAvailable(session: session)
                    if session.isInputGainSettable, session.inputGain != 1.0 {
                        try? session.setInputGain(1.0)
                    }
                    try self.installTapAndStartOnAudioQueue(owner: owner)
                    guard self.coordinator.isCurrent(owner) else {
                        self.stopCaptureAudioOnAudioQueue(deactivateSession: true, forceTeardown: false)
                        DispatchQueue.main.async {
                            if self.startingCall === expectedCall {
                                self.settleStartingCall(errorMessage: "Offline speech cancelled during startup")
                            }
                        }
                        return
                    }
                    // Hardware capture is live; resolve start() and emit .started immediately
                    // while SpeechInbox still drops warmupSamples before feeding gain/window/levels.
                    self.coordinator.markStarted(owner: owner)
                } catch {
                    self.coordinator.cancelStartSetup(owner: owner)
                    self.stopCaptureAudioOnAudioQueue(deactivateSession: true, forceTeardown: true)
                    DispatchQueue.main.async {
                        self.cancelWarmupWatchdog()
                        if self.startingCall === expectedCall {
                            self.startingCall = nil
                        }
                        if self.activeMainOwner == owner {
                            self.activeMainOwner = 0
                        }
                        self.endCapture(nil, deactivateSession: false)
                        call.reject("Offline speech could not start", nil, error)
                    }
                }
            }
        }
    }
    private func consume(_ buffer: AVAudioPCMBuffer, owner: UInt64, converter: AVAudioConverter, mono: AVAudioFormat) {
        coordinator.admitAndOffer(
            owner: owner,
            onOverloadTeardown: { [weak self] in self?.endCapture(nil) },
            onErrorTeardown: { [weak self] in self?.endCapture(nil) }
        ) {
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / buffer.format.sampleRate) + 16)
            guard let converted = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: capacity) else { return .ignore }
            let activeConverter: AVAudioConverter
            if converter.inputFormat == buffer.format {
                activeConverter = converter
            } else if let fallback = AVAudioConverter(from: buffer.format, to: mono) {
                activeConverter = fallback
            } else {
                return .failure("Offline audio conversion failed: incompatible tap format")
            }
            var supplied = false
            var conversionError: NSError?
            activeConverter.convert(to: converted, error: &conversionError) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true; status.pointee = .haveData; return buffer
            }
            guard conversionError == nil, let channel = converted.floatChannelData?[0] else {
                let detail = conversionError?.localizedDescription ?? "missing converted channel data"
                return .failure("Offline audio conversion failed: \(detail)")
            }
            return .samples(Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength))))
        }
    }

    private func handleLifecycleEventOnMain(_ event: TtsLifecycleEvent) {
        dispatchPrecondition(condition: .onQueue(.main))
        let hasActiveCapture = (activeMainOwner != 0 || startingCall != nil || coordinator.hasActiveCapture)
        let decision = TtsBackgroundLifecyclePolicy.decide(
            event: event,
            isTtsActive: isTtsPlaybackActiveOnMain,
            hasActiveCapture: hasActiveCapture
        )
        if decision.shouldStopCapture {
            if startingCall != nil {
                let message = event == .didEnterBackground
                    ? "Speech requires a foreground app"
                    : "Offline speech interrupted during startup"
                settleStartingCall(errorMessage: message)
            }
            endCapture(
                nil,
                deactivateSession: decision.shouldDeactivateAudioSession,
                allowWarmHold: decision.shouldScheduleWarmHold
            )
        }
        if decision.shouldStopTts {
            stopTtsPlaybackOnMain(deactivateSession: decision.shouldDeactivateAudioSession)
        }
    }

    @objc private func interrupted(_ notification: Notification) {
        let event: TtsLifecycleEvent
        if notification.name == UIApplication.willResignActiveNotification {
            coordinator.setBackgrounded(true)
            event = .willResignActive
        } else if notification.name == AVAudioSession.interruptionNotification {
            guard let value = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: value) else { return }
            switch type {
            case .began:
                event = .audioSessionInterruptionBegan
            case .ended:
                event = .audioSessionInterruptionEnded
            @unknown default:
                return
            }
        } else {
            return
        }
        DispatchQueue.main.async {
            self.handleLifecycleEventOnMain(event)
        }
    }
    @objc private func didEnterBackground(_ notification: Notification) {
        coordinator.setBackgrounded(true)
        DispatchQueue.main.async {
            self.handleLifecycleEventOnMain(.didEnterBackground)
        }
    }
    @objc private func engineConfigurationChanged(_ notification: Notification) {
        let notifiedEngine = notification.object as? AVAudioEngine
        audioQueue.async { [weak self] in
            guard let self = self, let activeEngine = self.engine else { return }
            if let notifiedEngine = notifiedEngine, notifiedEngine !== activeEngine {
                return
            }
            let wasCapturing = self.tapInstalled
            self.cancelWarmHoldDeactivationOnAudioQueue()
            self.invalidateEngineOnAudioQueue()
            self.audioSessionCategoryConfigured = false
            if self.audioSessionActive {
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                self.audioSessionActive = false
            }
            DispatchQueue.main.async {
                guard wasCapturing else { return }
                if self.startingCall != nil {
                    self.settleStartingCall(errorMessage: "Offline speech interrupted by audio configuration change")
                }
                if self.activeMainOwner != 0 {
                    self.endCapture(nil, deactivateSession: true, forceTeardown: true)
                }
            }
        }
    }
    @objc private func didBecomeActive(_ notification: Notification) {
        coordinator.setBackgrounded(false)
        SharedSpeechRecognizerStore.shared.ensureBackgroundModelDownloadIfNeeded { [weak self] ready in
            guard ready else { return }
            self?.warmUpRecognizerOnWorkerIfIdle()
        }
    }
    @objc public func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // Keep AVAudioSession warm briefly in foreground so consecutive presses start immediately;
            // backgrounding, audio interruptions, and the idle timer deactivate the session cleanly.
            self.endCapture(call, deactivateSession: self.coordinator.isBackgrounded)
        }
    }
    // Capture teardown dispatches CoreAudio/AVAudioSession work off main onto audioQueue;
    // serial decoder flush still precedes .stopped emission and stop() resolution.
    private func endCapture(_ call: CAPPluginCall?, deactivateSession: Bool = true, forceTeardown: Bool = false, allowWarmHold: Bool = true) {
        cancelWarmupWatchdog()
        activeMainOwner = 0
        SharedSpeechRecognizerStore.shared.setPhoneCaptureActive(false)
        coordinator.endCapture(
            stopCompletion: call.map { c in
                { errorMsg in
                    if let errorMsg = errorMsg { c.reject(errorMsg) }
                    else { c.resolve() }
                }
            },
            stopAudio: {
                audioQueue.async { [weak self] in
                    self?.stopCaptureAudioOnAudioQueue(deactivateSession: deactivateSession, forceTeardown: forceTeardown, allowWarmHold: allowWarmHold)
                }
            }
        )
        coordinator.worker.async { [weak self] in
            self?.recognizer?.model.clearInferenceCaches()
            Qwen3ASRModel.clearMetalCache()
        }
    }

    // MARK: - System Text-to-Speech (AVSpeechSynthesizer)

    static func mapTtsSpeechRate(_ rate: Double?) -> Float {
        let minRate = AVSpeechUtteranceMinimumSpeechRate
        let defaultRate = AVSpeechUtteranceDefaultSpeechRate
        let maxRate = AVSpeechUtteranceMaximumSpeechRate
        let raw = rate ?? 1.0
        let multiplier = raw.isFinite ? min(2.0, max(0.5, raw)) : 1.0
        if multiplier <= 1.0 {
            let scaled = minRate + (defaultRate - minRate) * Float(multiplier)
            return min(maxRate, max(minRate, scaled))
        }
        let scaled = defaultRate + (maxRate - defaultRate) * Float(multiplier - 1.0)
        return min(maxRate, max(minRate, scaled))
    }

    static func normalizeBcp47LanguageTag(_ lang: String?) -> String? {
        TtsVoiceSelector.normalizeBcp47LanguageTag(lang)
    }

    private static func makeVoiceCandidate(_ voice: AVSpeechSynthesisVoice) -> TtsVoiceCandidate {
        let tier: TtsVoiceCandidate.QualityTier
        if #available(iOS 16.0, macOS 13.0, *), voice.quality == .premium {
            tier = .premium
        } else if voice.quality == .enhanced {
            tier = .enhanced
        } else {
            tier = .standard
        }
        let isNovelty: Bool
        if #available(iOS 17.0, macOS 14.0, *) {
            isNovelty = voice.voiceTraits.contains(.isNoveltyVoice)
        } else {
            isNovelty = false
        }
        return TtsVoiceCandidate(
            identifier: voice.identifier,
            name: voice.name,
            language: voice.language,
            quality: tier,
            isNoveltyVoice: isNovelty
        )
    }

    static func selectTtsVoice(
        for lang: String?,
        from voices: [AVSpeechSynthesisVoice] = AVSpeechSynthesisVoice.speechVoices()
    ) -> AVSpeechSynthesisVoice? {
        guard let normalized = normalizeBcp47LanguageTag(lang) else {
            return nil
        }
        let candidates = voices.map(makeVoiceCandidate)
        if let index = TtsVoiceSelector.selectIndex(for: normalized, from: candidates) {
            return voices[index]
        }
        return AVSpeechSynthesisVoice(language: normalized)
    }

    private func ensureSpeechSynthesizerOnMain() -> AVSpeechSynthesizer {
        dispatchPrecondition(condition: .onQueue(.main))
        if let existing = speechSynthesizer {
            return existing
        }
        let created = AVSpeechSynthesizer()
        created.delegate = self
        speechSynthesizer = created
        return created
    }

    private func configurePlaybackAudioSessionOnAudioQueue() throws {
        dispatchPrecondition(condition: .onQueue(audioQueue))
        cancelWarmHoldDeactivationOnAudioQueue()
        invalidateEngineOnAudioQueue()
        audioSessionCategoryConfigured = false
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setActive(true)
        audioSessionActive = true
    }

    private func releasePlaybackAudioSessionOnAudioQueue() {
        dispatchPrecondition(condition: .onQueue(audioQueue))
        audioSessionCategoryConfigured = false
        if !tapInstalled && audioSessionActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            audioSessionActive = false
        }
    }

    private func stopTtsPlaybackOnMain(deactivateSession: Bool) {
        dispatchPrecondition(condition: .onQueue(.main))
        ttsUtteranceId &+= 1
        ttsUtteranceMap.removeAll()
        let wasSpeaking = ttsSpeaking || (speechSynthesizer?.isSpeaking ?? false)
        ttsPreparingPlayback = false
        ttsSpeaking = false
        if let synth = speechSynthesizer, synth.isSpeaking || synth.isPaused {
            synth.stopSpeaking(at: .immediate)
        }
        if wasSpeaking {
            notifyListeners("ttsState", data: ["status": "stopped"])
        }
        audioQueue.async { [weak self] in
            guard let self = self else { return }
            self.audioSessionCategoryConfigured = false
            if deactivateSession {
                self.releasePlaybackAudioSessionOnAudioQueue()
            }
        }
    }

    @objc public func speak(_ call: CAPPluginCall) {
        let trimmed = call.getString("text")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else {
            call.reject("TTS text is required")
            return
        }
        let lang = Self.normalizeBcp47LanguageTag(call.getString("lang"))
        let rate = call.getDouble("rate")

        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                call.reject("TTS plugin unavailable")
                return
            }
            if self.activeMainOwner != 0 || self.startingCall != nil {
                self.settleStartingCall(errorMessage: "Speech recognition stopped for TTS playback")
                self.endCapture(nil, deactivateSession: true, forceTeardown: true)
            }
            self.ttsUtteranceId &+= 1
            let requestId = self.ttsUtteranceId
            self.ttsPreparingPlayback = true
            if let synth = self.speechSynthesizer, synth.isSpeaking || synth.isPaused {
                synth.stopSpeaking(at: .immediate)
            }

            self.audioQueue.async { [weak self] in
                guard let self = self else { return }
                do {
                    try self.configurePlaybackAudioSessionOnAudioQueue()
                } catch {
                    DispatchQueue.main.async {
                        if self.ttsUtteranceId == requestId {
                            self.ttsPreparingPlayback = false
                            self.ttsSpeaking = false
                            self.notifyListeners("ttsState", data: ["status": "error", "message": error.localizedDescription])
                            call.reject("System TTS audio session failed", nil, error)
                        }
                    }
                    return
                }

                DispatchQueue.main.async {
                    guard self.ttsUtteranceId == requestId else {
                        call.resolve()
                        return
                    }
                    let synth = self.ensureSpeechSynthesizerOnMain()
                    if synth.isSpeaking || synth.isPaused {
                        synth.stopSpeaking(at: .immediate)
                    }
                    let utterance = AVSpeechUtterance(string: trimmed)
                    utterance.rate = Self.mapTtsSpeechRate(rate)
                    utterance.postUtteranceDelay = 0.12
                    if let voice = Self.selectTtsVoice(for: lang) {
                        utterance.voice = voice
                    }
                    self.ttsUtteranceMap[ObjectIdentifier(utterance)] = requestId
                    self.ttsPreparingPlayback = false
                    self.ttsSpeaking = true
                    synth.speak(utterance)
                    call.resolve()
                }
            }
        }
    }

    @objc public func stopSpeaking(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.stopTtsPlaybackOnMain(deactivateSession: true)
            call.resolve()
        }
    }

    @objc public func isSpeaking(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let speaking = (self?.ttsSpeaking ?? false) || (self?.speechSynthesizer?.isSpeaking ?? false)
            call.resolve(["speaking": speaking])
        }
    }

    static func ttsVoiceQualityLabel(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
        if #available(iOS 16.0, macOS 13.0, *) {
            if quality == .premium {
                return "premium"
            }
        }
        if quality == .enhanced {
            return "enhanced"
        }
        return "default"
    }

    @objc public func getTtsVoiceQuality(_ call: CAPPluginCall) {
        let requested = Self.normalizeBcp47LanguageTag(call.getString("lang"))
            ?? Self.normalizeBcp47LanguageTag(Locale.preferredLanguages.first)
            ?? "en-US"
        guard let voice = Self.selectTtsVoice(for: requested) else {
            call.resolve(["quality": "unavailable", "language": requested])
            return
        }
        call.resolve([
            "quality": Self.ttsVoiceQualityLabel(voice.quality),
            "language": voice.language,
            "voiceName": voice.name,
            "voiceIdentifier": voice.identifier,
        ])
    }

    @objc public func openTtsSettings(_ call: CAPPluginCall) {
        #if canImport(UIKit)
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.resolve(["opened": false])
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                call.resolve(["opened": opened])
            }
        }
        #else
        call.resolve(["opened": false])
        #endif
    }

    private func handleUtteranceFinishedOnMain(_ utterance: AVSpeechUtterance) {
        dispatchPrecondition(condition: .onQueue(.main))
        let owner = ttsUtteranceMap.removeValue(forKey: ObjectIdentifier(utterance))
        guard owner == ttsUtteranceId else { return }
        ttsSpeaking = false
        notifyListeners("ttsState", data: ["status": "stopped"])
        audioQueue.async { [weak self] in
            self?.releasePlaybackAudioSessionOnAudioQueue()
        }
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self,
                  self.ttsUtteranceMap[ObjectIdentifier(utterance)] == self.ttsUtteranceId else { return }
            self.ttsSpeaking = true
            self.notifyListeners("ttsState", data: ["status": "started"])
        }
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [weak self] in
            self?.handleUtteranceFinishedOnMain(utterance)
        }
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [weak self] in
            self?.handleUtteranceFinishedOnMain(utterance)
        }
    }
}

// MARK: - Shared Recognizer Store & Watch External ASR Bridge

final class SharedSpeechRecognizerStore {
    static let shared = SharedSpeechRecognizerStore()
    private let lock = NSLock()
    private let downloader: IosSpeechModelDownloader
    private let bundleResourceURL: URL?
    private let fileManager: FileManager
    private var cachedRecognizer: SpeechRecognizer?
    private var phoneCaptureActive = false

    init(
        downloader: IosSpeechModelDownloader = .shared,
        bundleResourceURL: URL? = Bundle.module.resourceURL,
        fileManager: FileManager = .default
    ) {
        self.downloader = downloader
        self.bundleResourceURL = bundleResourceURL
        self.fileManager = fileManager
    }

    static func directoryContainsRequiredModelFiles(_ root: URL, fileManager: FileManager = .default) -> Bool {
        ["config.json", "model.safetensors", "vocab.json", "merges.txt", "tokenizer_config.json", "hotwords.txt"].allSatisfy {
            fileManager.isReadableFile(atPath: root.appendingPathComponent($0).path)
        }
    }

    var bundledModelRoot: URL? {
        guard let root = bundleResourceURL?.appendingPathComponent("ios-models", isDirectory: true),
              Self.directoryContainsRequiredModelFiles(root, fileManager: fileManager) else {
            return nil
        }
        return root
    }

    var modelRoot: URL? {
        if downloader.hasVerifiedLocalModels {
            return downloader.modelsDirectory
        }
        return bundledModelRoot
    }

    var hasRequiredModelFiles: Bool {
        guard let root = modelRoot else { return false }
        return Self.directoryContainsRequiredModelFiles(root, fileManager: fileManager)
    }

    var modelAvailable: Bool {
        SpeechRecognizer.isMetalSupported && hasRequiredModelFiles
    }

    var downloadStatus: IosSpeechDownloadStatus {
        if hasRequiredModelFiles { return .ready }
        return downloader.status
    }

    func ensureBackgroundModelDownloadIfNeeded(completion: ((Bool) -> Void)? = nil) {
        if bundledModelRoot != nil {
            completion?(true)
            return
        }
        downloader.ensureDownloadedIfNeeded(completion: completion)
    }

    func ensureRecognizer() -> SpeechRecognizer? {
        lock.lock(); defer { lock.unlock() }
        if let existing = cachedRecognizer { return existing }
        guard modelAvailable, let root = modelRoot else { return nil }
        if root == downloader.modelsDirectory && !downloader.verifyAllAssetsOnDisk() {
            downloader.ensureDownloadedIfNeeded(forceRetry: true)
            return nil
        }
        guard let created = SpeechRecognizer(root: root) else { return nil }
        cachedRecognizer = created
        return created
    }

    func clearInferenceCaches() {
        lock.lock()
        let existing = cachedRecognizer
        lock.unlock()
        existing?.model.clearInferenceCaches()
        Qwen3ASRModel.clearMetalCache()
    }

    func setPhoneCaptureActive(_ active: Bool) {
        lock.lock()
        phoneCaptureActive = active
        lock.unlock()
    }

    var isPhoneCaptureActive: Bool {
        lock.lock(); defer { lock.unlock() }
        return phoneCaptureActive
    }
}

public struct WatchAsrUpdate: Equatable {
    public let streamId: String
    public let text: String
    public let isFinal: Bool
    public let errorCode: String?
    public let errorMessage: String?

    public init(
        streamId: String,
        text: String,
        isFinal: Bool,
        errorCode: String? = nil,
        errorMessage: String? = nil
    ) {
        self.streamId = streamId
        self.text = text
        self.isFinal = isFinal
        self.errorCode = errorCode
        self.errorMessage = errorMessage
    }
}

public enum WatchAsrError: Error, Equatable {
    case invalidStreamId
    case modelNotReady
    case phoneMicBusy
    case phoneBackgrounded
    case invalidAudioFormat

    public var code: String {
        switch self {
        case .invalidStreamId: return "invalid_stream_id"
        case .modelNotReady: return "model_not_ready"
        case .phoneMicBusy: return "phone_mic_busy"
        case .phoneBackgrounded: return "phone_backgrounded"
        case .invalidAudioFormat: return "invalid_audio_format"
        }
    }

    public var message: String {
        switch self {
        case .invalidStreamId: return "Invalid Watch audio stream id"
        case .modelNotReady: return "Offline speech model is not ready on iPhone"
        case .phoneMicBusy: return "iPhone microphone session is active"
        case .phoneBackgrounded: return "Open IM.codes on iPhone for live transcription"
        case .invalidAudioFormat: return "Unsupported Watch audio format (expected 16kHz mono PCM16)"
        }
    }
}

/// Public Swift bridge allowing host app extensions (such as WatchConnectivity)
/// to stream 16kHz mono PCM16 audio through the shared resident Qwen3-ASR engine
/// while serializing GPU/capture ownership with the iPhone Capacitor plugin.
public final class WatchAsrBridge {
    public static let shared = WatchAsrBridge()

    private struct ActiveExternalStream {
        let streamId: String
        let owner: UInt64
        let coordinator: SpeechCoordinator
        let onUpdate: (WatchAsrUpdate) -> Void
        var cancelled: Bool
    }

    private let lock = NSLock()
    private let emitQueue = DispatchQueue(label: "com.imcodes.watch-asr.emit", qos: .userInitiated)
    private var activeStream: ActiveExternalStream?

    private init() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleWillResignOrBackground),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleWillResignOrBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    public var isModelAvailable: Bool {
        SharedSpeechRecognizerStore.shared.modelAvailable
    }

    public var isPhoneMicBusy: Bool {
        SharedSpeechRecognizerStore.shared.isPhoneCaptureActive
    }

    private static func isAppBackgroundedOnMain() -> Bool {
        if Thread.isMainThread {
            return UIApplication.shared.applicationState == .background
        }
        return DispatchQueue.main.sync {
            UIApplication.shared.applicationState == .background
        }
    }

    @objc private func handleWillResignOrBackground() {
        lock.lock()
        let coordinator = activeStream?.coordinator
        lock.unlock()
        coordinator?.setBackgrounded(true)
    }

    @objc private func handleDidBecomeActive() {
        lock.lock()
        let coordinator = activeStream?.coordinator
        lock.unlock()
        coordinator?.setBackgrounded(false)
    }

    @discardableResult
    public func startExternalStream(
        streamId: String,
        language: String? = nil,
        onUpdate: @escaping (WatchAsrUpdate) -> Void
    ) -> Result<Void, WatchAsrError> {
        guard !streamId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .failure(.invalidStreamId)
        }
        guard !SharedSpeechRecognizerStore.shared.isPhoneCaptureActive else {
            return .failure(.phoneMicBusy)
        }
        guard !Self.isAppBackgroundedOnMain() else {
            return .failure(.phoneBackgrounded)
        }
        guard SharedSpeechRecognizerStore.shared.modelAvailable else {
            return .failure(.modelNotReady)
        }

        // Supersede any abandoned Watch stream cleanly.
        cancelExternalStream()

        let resolvedLanguage = Qwen3LanguageMapper.resolve(language)
        var capturedOwner: UInt64 = 0
        let coordinator = SpeechCoordinator(
            worker: SpeechCoordinator.sharedMlxWorker,
            emitQueue: emitQueue
        ) { [weak self] event in
            self?.handleCoordinatorEvent(event, streamId: streamId, owner: capturedOwner)
        }

        let owner = coordinator.beginStart(
            warmupSamples: 0,
            makeDecode: {
                guard let recognizer = SharedSpeechRecognizerStore.shared.ensureRecognizer(),
                      let decoder = SpeechDecoder(recognizer: recognizer, language: resolvedLanguage) else {
                    return nil
                }
                return SpeechCoordinator.Decoder(
                    decode: { samples, prefixTokens, shouldContinue in
                        decoder.decode(samples: samples, prefixTokens: prefixTokens, shouldContinue: shouldContinue)
                    },
                    rollbackPrefix: { tokens, rollbackCount in
                        decoder.rollbackPrefix(tokens, rollbackCount: rollbackCount)
                    }
                )
            },
            onStartReady: {},
            onSetupFailureTeardown: { [weak self] in
                self?.cancelExternalStream(
                    streamId: streamId,
                    reason: WatchAsrError.modelNotReady.message,
                    code: WatchAsrError.modelNotReady.code
                )
            }
        )
        capturedOwner = owner

        lock.lock()
        activeStream = ActiveExternalStream(
            streamId: streamId,
            owner: owner,
            coordinator: coordinator,
            onUpdate: onUpdate,
            cancelled: false
        )
        lock.unlock()

        coordinator.setBackgrounded(Self.isAppBackgroundedOnMain())
        coordinator.markStarted(owner: owner)
        return .success(())
    }

    public func appendExternalPcm16(streamId: String, data: Data, isFinal: Bool) {
        lock.lock()
        guard let current = activeStream, current.streamId == streamId, !current.cancelled else {
            lock.unlock()
            return
        }
        lock.unlock()

        let samples = Self.decodePcm16LittleEndian(data)
        if !samples.isEmpty {
            current.coordinator.offerSamples(
                samples,
                owner: current.owner,
                onOverloadTeardown: { [weak self] in
                    self?.cancelExternalStream(
                        streamId: streamId,
                        reason: "Offline speech processing overloaded",
                        code: "asr_overload"
                    )
                }
            )
        }

        if isFinal {
            current.coordinator.endCapture(stopAudio: {})
            SpeechCoordinator.sharedMlxWorker.async {
                SharedSpeechRecognizerStore.shared.clearInferenceCaches()
            }
        }
    }

    public func cancelExternalStream(
        streamId: String? = nil,
        reason: String? = nil,
        code: String? = nil
    ) {
        lock.lock()
        guard var current = activeStream else {
            lock.unlock()
            return
        }
        if let streamId, current.streamId != streamId {
            lock.unlock()
            return
        }
        current.cancelled = true
        activeStream = nil
        lock.unlock()

        current.coordinator.endCapture(stopAudio: {})
        SpeechCoordinator.sharedMlxWorker.async {
            SharedSpeechRecognizerStore.shared.clearInferenceCaches()
        }

        if let reason, !reason.isEmpty {
            let update = WatchAsrUpdate(
                streamId: current.streamId,
                text: "",
                isFinal: true,
                errorCode: code ?? "asr_cancelled",
                errorMessage: reason
            )
            emitQueue.async {
                current.onUpdate(update)
            }
        }
    }

    public func transcribeExternalFile(
        streamId: String,
        fileURL: URL,
        language: String? = nil,
        completion: @escaping (WatchAsrUpdate) -> Void
    ) {
        guard !streamId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            completion(WatchAsrUpdate(
                streamId: streamId,
                text: "",
                isFinal: true,
                errorCode: WatchAsrError.invalidStreamId.code,
                errorMessage: WatchAsrError.invalidStreamId.message
            ))
            return
        }
        guard !SharedSpeechRecognizerStore.shared.isPhoneCaptureActive else {
            completion(WatchAsrUpdate(
                streamId: streamId,
                text: "",
                isFinal: true,
                errorCode: WatchAsrError.phoneMicBusy.code,
                errorMessage: WatchAsrError.phoneMicBusy.message
            ))
            return
        }
        guard !Self.isAppBackgroundedOnMain() else {
            completion(WatchAsrUpdate(
                streamId: streamId,
                text: "",
                isFinal: true,
                errorCode: WatchAsrError.phoneBackgrounded.code,
                errorMessage: WatchAsrError.phoneBackgrounded.message
            ))
            return
        }
        guard SharedSpeechRecognizerStore.shared.modelAvailable else {
            completion(WatchAsrUpdate(
                streamId: streamId,
                text: "",
                isFinal: true,
                errorCode: WatchAsrError.modelNotReady.code,
                errorMessage: WatchAsrError.modelNotReady.message
            ))
            return
        }
        guard let rawData = try? Data(contentsOf: fileURL),
              let extracted = Self.extractPcm16FromWavOrRaw(rawData),
              extracted.sampleRate == SpeechWindow.sampleRate,
              extracted.channels == 1 else {
            completion(WatchAsrUpdate(
                streamId: streamId,
                text: "",
                isFinal: true,
                errorCode: WatchAsrError.invalidAudioFormat.code,
                errorMessage: WatchAsrError.invalidAudioFormat.message
            ))
            return
        }

        let samples = Self.decodePcm16LittleEndian(extracted.pcm16)
        guard !samples.isEmpty else {
            completion(WatchAsrUpdate(streamId: streamId, text: "", isFinal: true))
            return
        }

        let resolvedLanguage = Qwen3LanguageMapper.resolve(language)
        SpeechCoordinator.sharedMlxWorker.async {
            guard !SharedSpeechRecognizerStore.shared.isPhoneCaptureActive else {
                self.emitQueue.async {
                    completion(WatchAsrUpdate(
                        streamId: streamId,
                        text: "",
                        isFinal: true,
                        errorCode: WatchAsrError.phoneMicBusy.code,
                        errorMessage: WatchAsrError.phoneMicBusy.message
                    ))
                }
                return
            }
            guard !Self.isAppBackgroundedOnMain() else {
                self.emitQueue.async {
                    completion(WatchAsrUpdate(
                        streamId: streamId,
                        text: "",
                        isFinal: true,
                        errorCode: WatchAsrError.phoneBackgrounded.code,
                        errorMessage: WatchAsrError.phoneBackgrounded.message
                    ))
                }
                return
            }
            guard let recognizer = SharedSpeechRecognizerStore.shared.ensureRecognizer(),
                  let decoder = SpeechDecoder(recognizer: recognizer, language: resolvedLanguage) else {
                self.emitQueue.async {
                    completion(WatchAsrUpdate(
                        streamId: streamId,
                        text: "",
                        isFinal: true,
                        errorCode: WatchAsrError.modelNotReady.code,
                        errorMessage: WatchAsrError.modelNotReady.message
                    ))
                }
                return
            }

            defer {
                SharedSpeechRecognizerStore.shared.clearInferenceCaches()
            }

            var gain = SpeechGain()
            var window = SpeechWindow()
            let chunkSize = SpeechWindow.sampleRate * 2 // 2s chunks matching Qwen3-ASR stride
            var offset = 0
            do {
                while offset < samples.count {
                    let end = min(samples.count, offset + chunkSize)
                    let slice = Array(samples[offset..<end])
                    let processed = gain.process(slice)
                    let isLast = end >= samples.count
                    try window.append(
                        processed.samples,
                        speech: processed.anyVoiced || !window.samples.isEmpty,
                        trailingSilence: processed.trailingUnvoicedSamples,
                        activeSamples: processed.voicedSamples,
                        noiseFloorRMS: processed.noiseFloorRMS,
                        final: isLast,
                        shouldEmitNonFinal: { !isLast && !Self.isAppBackgroundedOnMain() },
                        shouldContinue: { !Self.isAppBackgroundedOnMain() },
                        rollbackPrefix: { tokens, rollbackCount in
                            decoder.rollbackPrefix(tokens, rollbackCount: rollbackCount)
                        },
                        decode: { segSamples, prefixTokens in
                            decoder.decode(samples: segSamples, prefixTokens: prefixTokens) {
                                !Self.isAppBackgroundedOnMain()
                            }
                        }
                    ) { _ in }
                    offset = end
                }
                let finalText = try window.finish(
                    shouldContinue: { !Self.isAppBackgroundedOnMain() },
                    rollbackPrefix: { tokens, rollbackCount in
                        decoder.rollbackPrefix(tokens, rollbackCount: rollbackCount)
                    }
                ) { segSamples, prefixTokens in
                    decoder.decode(samples: segSamples, prefixTokens: prefixTokens) {
                        !Self.isAppBackgroundedOnMain()
                    }
                }
                self.emitQueue.async {
                    completion(WatchAsrUpdate(streamId: streamId, text: finalText, isFinal: true))
                }
            } catch SpeechWindow.Failure.cancelled {
                self.emitQueue.async {
                    completion(WatchAsrUpdate(
                        streamId: streamId,
                        text: window.text,
                        isFinal: true,
                        errorCode: WatchAsrError.phoneBackgrounded.code,
                        errorMessage: WatchAsrError.phoneBackgrounded.message
                    ))
                }
            } catch {
                self.emitQueue.async {
                    completion(WatchAsrUpdate(
                        streamId: streamId,
                        text: window.text,
                        isFinal: true,
                        errorCode: "asr_decode_failed",
                        errorMessage: "Offline speech file decoding failed"
                    ))
                }
            }
        }
    }

    private func handleCoordinatorEvent(_ event: SpeechCoordinator.Event, streamId: String, owner: UInt64) {
        lock.lock()
        guard let current = activeStream,
              current.streamId == streamId,
              current.owner == owner,
              !current.cancelled else {
            lock.unlock()
            return
        }
        let callback = current.onUpdate
        switch event {
        case .partial(let text):
            lock.unlock()
            callback(WatchAsrUpdate(streamId: streamId, text: text, isFinal: false))
        case .final(let text):
            activeStream = nil
            lock.unlock()
            callback(WatchAsrUpdate(streamId: streamId, text: text, isFinal: true))
        case .error(let message):
            activeStream = nil
            lock.unlock()
            callback(WatchAsrUpdate(
                streamId: streamId,
                text: "",
                isFinal: true,
                errorCode: "asr_error",
                errorMessage: message
            ))
        case .started, .stopped, .audioLevel:
            lock.unlock()
        }
    }

    public static func decodePcm16LittleEndian(_ data: Data) -> [Float] {
        let sampleCount = data.count / MemoryLayout<Int16>.size
        guard sampleCount > 0 else { return [] }
        var out = [Float]()
        out.reserveCapacity(sampleCount)
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            let bytePtr = base.assumingMemoryBound(to: UInt8.self)
            for i in 0..<sampleCount {
                let offset = i * 2
                let lo = UInt16(bytePtr[offset])
                let hi = UInt16(bytePtr[offset + 1]) << 8
                let sample = Int16(bitPattern: lo | hi)
                out.append(Float(sample) / 32768.0)
            }
        }
        return out
    }

    public static func extractPcm16FromWavOrRaw(_ data: Data) -> (sampleRate: Int, channels: Int, pcm16: Data)? {
        guard data.count >= 12,
              String(data: data.subdata(in: 0..<4), encoding: .ascii) == "RIFF",
              String(data: data.subdata(in: 8..<12), encoding: .ascii) == "WAVE" else {
            guard !data.isEmpty else { return nil }
            return (SpeechWindow.sampleRate, 1, data)
        }

        func readUInt16LE(_ offset: Int) -> UInt16 {
            UInt16(data[offset]) | (UInt16(data[offset + 1]) << 8)
        }
        func readUInt32LE(_ offset: Int) -> UInt32 {
            UInt32(data[offset])
                | (UInt32(data[offset + 1]) << 8)
                | (UInt32(data[offset + 2]) << 16)
                | (UInt32(data[offset + 3]) << 24)
        }

        var offset = 12
        var sampleRate: Int?
        var channels: Int?
        var bitsPerSample: Int?
        var audioFormat: UInt16?
        var pcmData: Data?

        while offset + 8 <= data.count {
            let chunkId = String(data: data.subdata(in: offset..<(offset + 4)), encoding: .ascii) ?? ""
            let chunkSize = Int(readUInt32LE(offset + 4))
            let payloadStart = offset + 8
            guard chunkSize >= 0, payloadStart <= data.count else { break }
            let payloadEnd = min(data.count, payloadStart + chunkSize)

            if chunkId == "fmt " && payloadEnd - payloadStart >= 16 {
                audioFormat = readUInt16LE(payloadStart)
                channels = Int(readUInt16LE(payloadStart + 2))
                sampleRate = Int(readUInt32LE(payloadStart + 4))
                bitsPerSample = Int(readUInt16LE(payloadStart + 14))
            } else if chunkId == "data" {
                pcmData = data.subdata(in: payloadStart..<payloadEnd)
            }

            let paddedSize = chunkSize + (chunkSize & 1)
            offset = payloadStart + paddedSize
        }

        guard audioFormat == 1,
              bitsPerSample == 16,
              let sr = sampleRate,
              let ch = channels,
              let pcm = pcmData else {
            return nil
        }
        return (sr, ch, pcm)
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
    private var didWarmupMetal = false // Accessed strictly on coordinator.worker.
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

    func warmupMetalIfNeeded(shouldContinue: () -> Bool) {
        guard !didWarmupMetal, shouldContinue() else { return }
        let silent = [Float](repeating: 0, count: 1600)
        let options = Qwen3DecodingOptions(maxTokens: 1, language: nil, context: hotwords)
        do {
            _ = try model.transcribeSegmentWithCancellation(
                audio: silent,
                sampleRate: 16000,
                options: options,
                prefixTokens: []
            ) {
                if !shouldContinue() { throw CancellationError() }
            }
            didWarmupMetal = true
        } catch {
            // Cancelled or transient failure: allow retry on next prewarm/capture.
        }
        Qwen3ASRModel.clearMetalCache()
    }
}

final class SpeechDecoder {
    let recognizer: SpeechRecognizer
    let language: String?
    init?(recognizer: SpeechRecognizer, language: String? = nil) {
        self.recognizer = recognizer
        self.language = language
    }
    func decode(
        samples: [Float],
        prefixTokens: [Int32] = [],
        shouldContinue: () -> Bool = { true }
    ) -> (text: String, tokens: [Int32])? {
        if samples.isEmpty { return ("", prefixTokens) }
        guard shouldContinue() else { return nil }
        let options = Qwen3DecodingOptions(maxTokens: 192, language: language, context: recognizer.hotwords)
        do {
            let result = try recognizer.model.transcribeSegmentWithCancellation(
                audio: samples,
                sampleRate: 16000,
                options: options,
                prefixTokens: prefixTokens
            ) {
                if !shouldContinue() { throw CancellationError() }
            }
            return (result.text.trimmingCharacters(in: .whitespacesAndNewlines), result.tokens)
        } catch is CancellationError {
            return nil
        } catch {
            return nil
        }
    }

    func rollbackPrefix(_ tokens: [Int32], rollbackCount: Int = SpeechWindow.unfixedTokenNum) -> [Int32] {
        recognizer.model.safePrefixTokensForRollback(
            tokens,
            rollbackCount: rollbackCount,
            expectLanguageHeader: Qwen3ASRModel.resolveLanguage(language) == nil
        )
    }
}

// MARK: - Token Prefix Rollback streaming segmentation
// Uses Qwen3-ASR native token-level prefix continuation (unfixedChunkNum = 2,
// unfixedTokenNum = 5) inside an active segment, strict committed-vs-active
// isolation across VAD pauses, and disjoint lowest-RMS micro-frame cuts when
// continuous unpaused speech exceeds `segmentCapacity`. No string-overlap seam
// matching or character-rollback heuristics are used.
struct SpeechWindow {
    typealias DecodeResult = (text: String, tokens: [Int32])
    typealias DecodeFn = ([Float], [Int32]) -> DecodeResult?
    typealias RollbackFn = ([Int32], Int) -> [Int32]

    static let sampleRate = 16000
    static let stride = sampleRate * 2 // 2.0s of NEW audio per partial decode (Qwen3-ASR chunk_size_sec=2.0)
    static let segmentCapacity = sampleRate * 27 / 2 // 13.5s bounded active segment capacity (216,000 samples, below 15s threshold)
    static let splitSearchWindow = sampleRate * 5 / 2 // Search trailing 2.5s band for a sustained quiet interval boundary
    static let finalSilencePadding = sampleRate * 2 / 10 // 200ms (3200 zero samples) flushed once at final boundary
    static let unfixedChunkNum = 2
    static let unfixedTokenNum = 5
    static let punctuationPause = sampleRate * 4 / 10
    static let vadPause = sampleRate * 7 / 10
    static let onsetConfirmSamples = sampleRate * 15 / 100 // 150ms sustained low-level speech before locking window open
    static let onsetClearSilenceSamples = sampleRate / 10 // 100ms unvoiced gap discards unconfirmed noise onset
    static let onsetBypassRMS: Float = 0.05 // Normal handheld speech (>= -26 dBFS) opens window immediately without onset buffering
    static let minDecodeWindowRMS: Float = 0.0024 // Skip decoder call if no 200ms window reaches soft-speech energy (-52.4 dBFS)
    static let minDecodeNoiseMultiplier: Float = 1.75 // Require ~4.9 dB above adapted ambient noise floor
    static let decodeEnergyWindowSamples = sampleRate * 2 / 10 // 200ms @ 16 kHz
    static let decodeEnergyHopSamples = sampleRate / 10 // 100ms hop @ 16 kHz
    enum Failure: Error { case decode, cancelled }

    private(set) var samples: [Float] = []
    private(set) var committed = ""
    private(set) var partial = ""
    private var activeTokens: [Int32] = []
    private var chunkCount = 0
    private var lastDecodedSampleCount = 0
    private(set) var newSamples = 0
    private var silentSamples = 0
    private var lastEmitted = ""
    private var pendingOnsetSamples: [Float] = []
    private var pendingOnsetActiveSamples = 0
    private var pendingOnsetSilenceSamples = 0
    private var latestNoiseFloorRMS: Float = SpeechGain.initialNoiseFloorRMS
    private var voicedSinceSilenceSamples = 0
    static let silenceResetMinVoicedSamples = sampleRate / 20 // 50ms voiced continuity required to reset active pause clock
    var text: String { Self.join(committed, partial) }

    static func hasDecodableEnergy(
        in audio: [Float],
        count: Int? = nil,
        noiseFloorRMS: Float = SpeechGain.initialNoiseFloorRMS
    ) -> Bool {
        let n = min(audio.count, count ?? audio.count)
        guard n > 0 else { return false }
        let effectiveMinRMS = max(minDecodeWindowRMS, noiseFloorRMS * minDecodeNoiseMultiplier)
        let threshSq = Double(effectiveMinRMS) * Double(effectiveMinRMS)
        let win = decodeEnergyWindowSamples
        if n <= win {
            var sumSq: Double = 0
            for i in 0..<n {
                let v = audio[i]
                if v.isFinite {
                    let dv = Double(v)
                    sumSq += dv * dv
                }
            }
            return (sumSq / Double(n)) >= threshSq
        }

        let hop = decodeEnergyHopSamples
        var prevSum: Double = 0
        var prevCount = 0
        var pos = 0
        while pos < n {
            let end = min(n, pos + hop)
            var blockSum: Double = 0
            for i in pos..<end {
                let v = audio[i]
                if v.isFinite {
                    let dv = Double(v)
                    blockSum += dv * dv
                }
            }
            let blockCount = end - pos
            let totalCount = prevCount + blockCount
            if totalCount > 0 && ((prevSum + blockSum) / Double(totalCount)) >= threshSq {
                return true
            }
            prevSum = blockSum
            prevCount = blockCount
            pos = end
        }
        let tailStart = max(0, n - win)
        var tailSum: Double = 0
        for i in tailStart..<n {
            let v = audio[i]
            if v.isFinite {
                let dv = Double(v)
                tailSum += dv * dv
            }
        }
        return (tailSum / Double(n - tailStart)) >= threshSq
    }

    private mutating func clearPendingOnset() {
        pendingOnsetSamples.removeAll(keepingCapacity: true)
        pendingOnsetActiveSamples = 0
        pendingOnsetSilenceSamples = 0
    }

    static func defaultRollbackPrefix(_ tokens: [Int32], rollbackCount: Int = SpeechWindow.unfixedTokenNum) -> [Int32] {
        let trim = max(0, rollbackCount)
        guard tokens.count > trim else { return [] }
        return Array(tokens.dropLast(trim))
    }

    static func lowestEnergySplitIndex(
        in samples: [Float],
        searchBack: Int = SpeechWindow.splitSearchWindow,
        frameSize: Int = 1920,
        hop: Int = 160
    ) -> Int {
        guard samples.count > frameSize, searchBack > frameSize else { return samples.count }
        let searchStart = max(samples.count / 2, samples.count - searchBack)
        let limit = samples.count - frameSize
        guard searchStart <= limit else { return samples.count }
        // Prefix sum of squared amplitudes over [searchStart..<samples.count] for O(searchBack) scoring.
        let span = samples.count - searchStart
        var prefixSq = [Double](repeating: 0, count: span + 1)
        for idx in 0..<span {
            let v = Double(samples[searchStart + idx])
            prefixSq[idx + 1] = prefixSq[idx] + v * v
        }
        var bestStart = limit
        var minEnergy = Double.infinity
        var maxEnergy: Double = 0
        var pos = searchStart
        while pos <= limit {
            let rel = pos - searchStart
            let energy = prefixSq[rel + frameSize] - prefixSq[rel]
            if energy < minEnergy {
                minEnergy = energy
                bestStart = pos
            }
            if energy > maxEnergy {
                maxEnergy = energy
            }
            pos += hop
        }
        // Constant-amplitude synthetic signals split cleanly at segmentCapacity without an arbitrary offset.
        if (maxEnergy - minEnergy) / Double(frameSize) <= 1e-9 {
            return samples.count
        }
        return bestStart + frameSize / 2
    }

    private mutating func advanceSilence(
        sliceCount: Int,
        speech: Bool,
        trailingSilence: Int,
        activeInSlice: Int,
        sliceRMS: Float,
        tailRemaining: Int
    ) {
        guard speech else {
            voicedSinceSilenceSamples = 0
            silentSamples += sliceCount
            return
        }
        voicedSinceSilenceSamples += activeInSlice
        guard sliceRMS >= Self.onsetBypassRMS || voicedSinceSilenceSamples >= Self.silenceResetMinVoicedSamples else {
            // Isolated single-subframe (25ms) ambient blip must not reset an active pause clock.
            silentSamples += sliceCount
            return
        }
        let silentEnd = max(0, trailingSilence - tailRemaining)
        // If voiced speech preceded silentEnd inside this slice, reset prior clock; otherwise the whole slice
        // belongs to trailing silence and extends only the post-cut carried silence of the active segment.
        silentSamples = silentEnd < sliceCount ? silentEnd : silentSamples + sliceCount
    }

    mutating func append(
        _ input: [Float],
        speech: Bool,
        trailingSilence: Int = 0,
        activeSamples: Int? = nil,
        noiseFloorRMS: Float = SpeechGain.initialNoiseFloorRMS,
        final: Bool = false,
        shouldEmitNonFinal: () -> Bool = { true },
        shouldContinue: () -> Bool = { true },
        rollbackPrefix: RollbackFn = SpeechWindow.defaultRollbackPrefix,
        decode: DecodeFn,
        emit: (String) -> Void
    ) throws {
        latestNoiseFloorRMS = noiseFloorRMS
        guard !input.isEmpty else { return }
        var remaining: ArraySlice<Float>
        if samples.isEmpty {
            if !speech {
                guard !pendingOnsetSamples.isEmpty else { return }
                pendingOnsetSamples.append(contentsOf: input)
                pendingOnsetSilenceSamples += input.count
                pendingOnsetActiveSamples = max(0, pendingOnsetActiveSamples - input.count / 2)
                if pendingOnsetSilenceSamples >= Self.onsetClearSilenceSamples || pendingOnsetActiveSamples == 0 {
                    clearPendingOnset()
                }
                return
            }
            let silentEnd = min(input.count, max(0, trailingSilence))
            let activeInChunk = activeSamples.map { min(input.count, max(0, $0)) } ?? max(0, input.count - silentEnd)
            let bypassOnset = SpeechGain.rms(input) >= Self.onsetBypassRMS
            if pendingOnsetSamples.isEmpty && (bypassOnset || activeInChunk >= Self.onsetConfirmSamples) {
                remaining = input[...]
            } else {
                pendingOnsetSamples.append(contentsOf: input)
                if activeInChunk > 0 {
                    pendingOnsetActiveSamples += activeInChunk
                    pendingOnsetSilenceSamples = silentEnd
                } else {
                    pendingOnsetSilenceSamples += input.count
                }
                let promoted = bypassOnset || pendingOnsetActiveSamples >= Self.onsetConfirmSamples
                if !promoted {
                    if pendingOnsetSilenceSamples >= Self.onsetClearSilenceSamples {
                        clearPendingOnset()
                    }
                    return
                }
                let buffered = pendingOnsetSamples
                clearPendingOnset()
                remaining = buffered[...]
            }
        } else {
            remaining = input[...]
        }
        let activeForSilence = activeSamples ?? input.count
        let inputRMS = SpeechGain.rms(input)
        while samples.count + remaining.count > Self.segmentCapacity {
            guard shouldContinue() else { throw Failure.cancelled }
            let takeCount = max(0, Self.segmentCapacity - samples.count)
            let chunk = remaining.prefix(takeCount)
            remaining = remaining.dropFirst(takeCount)
            samples.append(contentsOf: chunk)
            newSamples += chunk.count
            advanceSilence(
                sliceCount: chunk.count,
                speech: speech,
                trailingSilence: trailingSilence,
                activeInSlice: min(chunk.count, activeForSilence),
                sliceRMS: inputRMS,
                tailRemaining: remaining.count
            )
            let pause = Self.endsSentence(partial) ? Self.punctuationPause : Self.vadPause
            if silentSamples >= pause {
                try evaluate(samples, allowPrefix: true, rollbackPrefix: rollbackPrefix, shouldContinue: shouldContinue, decode: decode)
                commitSegment()
            } else {
                try splitAtLowestEnergy(rollbackPrefix: rollbackPrefix, shouldContinue: shouldContinue, decode: decode)
            }
            if !final && shouldEmitNonFinal() && text != lastEmitted { lastEmitted = text; emit(text) }
        }
        guard !remaining.isEmpty else { return }
        guard shouldContinue() else { throw Failure.cancelled }
        samples.append(contentsOf: remaining)
        newSamples += remaining.count
        advanceSilence(
            sliceCount: remaining.count,
            speech: speech,
            trailingSilence: trailingSilence,
            activeInSlice: min(remaining.count, activeForSilence),
            sliceRMS: inputRMS,
            tailRemaining: 0
        )
        if final || !shouldEmitNonFinal() {
            // Stop flushes the final bounded segment once in finish() with 200ms silence padding;
            // skip redundant non-final decodes once stop has already been requested.
            return
        }
        let pause = Self.endsSentence(partial) ? Self.punctuationPause : Self.vadPause
        let endpoint = silentSamples >= pause
        if endpoint {
            try evaluate(samples, allowPrefix: true, rollbackPrefix: rollbackPrefix, shouldContinue: shouldContinue, decode: decode)
            commitSegment()
            if text != lastEmitted { lastEmitted = text; emit(text) }
        } else if samples.count >= Self.segmentCapacity {
            try splitAtLowestEnergy(rollbackPrefix: rollbackPrefix, shouldContinue: shouldContinue, decode: decode)
            if text != lastEmitted { lastEmitted = text; emit(text) }
        } else if newSamples >= Self.stride {
            try evaluate(samples, allowPrefix: true, rollbackPrefix: rollbackPrefix, shouldContinue: shouldContinue, decode: decode)
            if text != lastEmitted { lastEmitted = text; emit(text) }
        }
    }

    mutating func finish(
        shouldContinue: () -> Bool = { true },
        rollbackPrefix: RollbackFn = SpeechWindow.defaultRollbackPrefix,
        decode: DecodeFn
    ) throws -> String {
        if samples.isEmpty && !pendingOnsetSamples.isEmpty {
            if pendingOnsetActiveSamples >= Self.onsetConfirmSamples || SpeechGain.rms(pendingOnsetSamples) >= Self.onsetBypassRMS {
                samples = pendingOnsetSamples
                newSamples = samples.count
            }
            clearPendingOnset()
        }
        if newSamples > 0 {
            let padded = samples + Array(repeating: Float(0), count: Self.finalSilencePadding)
            try evaluate(
                padded,
                allowPrefix: true,
                rollbackPrefix: rollbackPrefix,
                shouldContinue: shouldContinue,
                decode: decode,
                decodedSampleCount: samples.count
            )
        }
        commitSegment()
        return text
    }

    private mutating func splitAtLowestEnergy(
        rollbackPrefix: RollbackFn,
        shouldContinue: () -> Bool,
        decode: DecodeFn
    ) throws {
        let cutIndex = Self.lowestEnergySplitIndex(in: samples)
        let segmentAudio = Array(samples[..<cutIndex])
        let carriedAudio = Array(samples[cutIndex...])
        let preCommitSilent = silentSamples
        if !segmentAudio.isEmpty && (newSamples > 0 || cutIndex != lastDecodedSampleCount) {
            let allowPrefix = cutIndex >= lastDecodedSampleCount
            try evaluate(
                segmentAudio,
                allowPrefix: allowPrefix,
                rollbackPrefix: rollbackPrefix,
                shouldContinue: shouldContinue,
                decode: decode,
                decodedSampleCount: segmentAudio.count
            )
        }
        commitSegment()
        samples = carriedAudio
        newSamples = carriedAudio.count
        silentSamples = carriedAudio.isEmpty ? 0 : min(preCommitSilent, carriedAudio.count)
    }

    private mutating func evaluate(
        _ audio: [Float],
        allowPrefix: Bool,
        rollbackPrefix: RollbackFn,
        shouldContinue: () -> Bool = { true },
        decode: DecodeFn,
        decodedSampleCount: Int? = nil
    ) throws {
        guard shouldContinue() else { throw Failure.cancelled }
        guard Self.hasDecodableEnergy(in: audio, noiseFloorRMS: latestNoiseFloorRMS) else {
            partial = ""
            newSamples = 0
            return
        }
        let prefixTokens: [Int32]
        if allowPrefix && chunkCount >= Self.unfixedChunkNum {
            prefixTokens = rollbackPrefix(activeTokens, Self.unfixedTokenNum)
        } else {
            prefixTokens = []
        }
        guard let result = decode(audio, prefixTokens) else {
            throw shouldContinue() ? Failure.decode : Failure.cancelled
        }
        partial = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
        activeTokens = result.tokens
        chunkCount += 1
        lastDecodedSampleCount = decodedSampleCount ?? audio.count
        newSamples = 0
    }

    private mutating func commitSegment() {
        committed = text
        partial = ""
        activeTokens.removeAll(keepingCapacity: true)
        chunkCount = 0
        lastDecodedSampleCount = 0
        samples.removeAll(keepingCapacity: true)
        newSamples = 0
        silentSamples = 0
        voicedSinceSilenceSamples = 0
        clearPendingOnset()
    }

    private static func endsSentence(_ text: String) -> Bool {
        guard let last = text.last else { return false }
        return "，、；,;.。！？!?".contains(last)
    }

    private static func join(_ previous: String, _ next: String) -> String {
        if previous.isEmpty { return next }
        if next.isEmpty { return previous }
        let ascii = previous.unicodeScalars.last!.value < 128 && next.unicodeScalars.first!.value < 128
        let separated = previous.last!.isWhitespace || next.first!.isWhitespace
        return previous + (ascii && !separated ? " " : "") + next
    }
}


/// Bounded adaptive speech AGC + adaptive pre-gain noise floor + soft-knee tanh limiter
/// for 16 kHz mono float PCM. Lifts quiet-to-normal handheld speech toward an ASR-friendly
/// RMS while adapting to stationary ambient noise/hum and bounding peaks inside (-1.0, 1.0).
struct SpeechGain {
    static let sampleRate = 16000
    static let targetRMS: Float = 0.14
    static let minGain: Float = 1.0
    static let maxGain: Float = 1.0
    static let minNoiseFloorRMS: Float = 0.0006
    static let initialNoiseFloorRMS: Float = 0.00075
    static let maxNoiseFloorRMS: Float = 0.015
    static let maxNoiseCeilingRMS: Float = 0.018
    static let noiseFloorLowRMS: Float = 0.0006
    static let noiseFloorHighRMS: Float = 0.0014
    static let voicedRawRMSFloor: Float = 0.0012
    static let voicedNoiseMultiplier: Float = 1.75
    static let voicedBoostedRMSFloor: Float = 0.0012
    static let unpitchedSpeechRMSFloor: Float = 0.05
    static let stationaryHoldSeconds: Float = 0.22
    static let noiseFloorAttackTau: Float = 0.12
    static let noiseFloorReleaseTau: Float = 0.25
    static let gainAttackUpTau: Float = 0.018
    static let gainReleaseTau: Float = 0.125
    static let analysisSubframeSamples = 400 // 25 ms @ 16 kHz keeps tracker & gain chunk-size invariant
    static let hpfCutoffHz: Float = 125.0
    private static let hpfAlpha: Float = 1.0 / (1.0 + 2.0 * Float.pi * hpfCutoffHz / Float(sampleRate))
    static let minSpeechBandRatio: Float = 0.50
    static let minPitchPeriodicity: Float = 0.55
    static let noiseAdaptMaxPitchPeriodicity: Float = 0.72
    static let pitchLagMin = 40   // 400 Hz @ 16 kHz
    static let pitchLagMax = 200  // 80 Hz @ 16 kHz
    static let pitchLagStep = 2
    static let softKnee: Float = 0.75
    static let softHeadroom: Float = 0.24 // softKnee + softHeadroom = 0.99 < 1.0
    static let maxUpRampSamples = 80    // 5 ms at 16 kHz avoids step clicks without dropping onset
    static let maxDownRampSamples = 16  // 1 ms at 16 kHz pulls down loud transients immediately

    struct Result {
        let samples: [Float]
        let rawRMS: Float
        let boostedRMS: Float
        let anyVoiced: Bool
        let lastVoiced: Bool
        let trailingUnvoicedSamples: Int
        let voicedSamples: Int
        let noiseFloorRMS: Float
    }

    private(set) var currentGain: Float = 1.0
    private(set) var noiseFloorRMS: Float = SpeechGain.initialNoiseFloorRMS
    private var prevSubframeRMS: Float = 0.0
    private var stationaryAnchorRMS: Float = 0.0
    private var stationaryDuration: Float = 0.0
    private var hpfPrevX: Float = 0.0
    private var hpfStage1Y: Float = 0.0
    private var hpfStage2PrevX: Float = 0.0
    private var hpfStage2Y: Float = 0.0
    private var hpHistory = [Float](repeating: 0, count: SpeechGain.analysisSubframeSamples)
    private var hpHistoryCount: Int = 0
    private var hpPrefixSq = [Double](repeating: 0, count: SpeechGain.analysisSubframeSamples + 1)

    static func rms(_ samples: ArraySlice<Float>) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sumSq: Double = 0
        for sample in samples where sample.isFinite {
            let v = Double(sample)
            sumSq += v * v
        }
        return Float(sqrt(sumSq / Double(samples.count)))
    }

    static func rms(_ samples: [Float]) -> Float {
        rms(samples[...])
    }

    static func speechConfidence(rawRMS: Float, noiseFloor: Float = initialNoiseFloorRMS) -> Float {
        let low = max(noiseFloorLowRMS, noiseFloor * 1.15)
        let high = max(noiseFloorHighRMS, noiseFloor * 1.75)
        guard rawRMS.isFinite, rawRMS > low else { return 0 }
        if rawRMS >= high { return 1 }
        return (rawRMS - low) / max(high - low, 1e-6)
    }

    static func softLimit(_ x: Float) -> Float {
        guard x.isFinite else { return 0 }
        let mag = abs(x)
        if mag <= softKnee { return x }
        let sign: Float = x < 0 ? -1 : 1
        let excess = (mag - softKnee) / softHeadroom
        let limited = sign * (softKnee + softHeadroom * tanhf(excess))
        return min(0.9999, max(-0.9999, limited))
    }

    /// Computes raw RMS and updates the continuous 2-pole ~125 Hz HPF buffer in one pass.
    private mutating func analyzeSubframe(_ subframe: ArraySlice<Float>) -> (rawRMS: Float, hpRatio: Float) {
        let count = subframe.count
        guard count > 0 else { return (0, 0) }
        let cap = Self.analysisSubframeSamples
        let writeStart: Int
        if count >= cap {
            writeStart = 0
            hpHistoryCount = cap
        } else {
            let keep = min(hpHistoryCount, cap - count)
            if keep > 0 {
                let shift = hpHistoryCount - keep
                for i in 0..<keep {
                    hpHistory[i] = hpHistory[shift + i]
                }
            }
            writeStart = keep
            hpHistoryCount = keep + count
        }

        var sumSqRaw: Double = 0
        var sumSqHp: Double = 0
        let alpha = Self.hpfAlpha
        var idx = subframe.startIndex
        for i in 0..<count {
            let s = subframe[idx]
            idx += 1
            let x = s.isFinite ? s : 0
            let dx = Double(x)
            sumSqRaw += dx * dx

            let s1 = alpha * (hpfStage1Y + x - hpfPrevX)
            hpfPrevX = x
            hpfStage1Y = s1
            let s2 = alpha * (hpfStage2Y + s1 - hpfStage2PrevX)
            hpfStage2PrevX = s1
            hpfStage2Y = s2
            let ds2 = Double(s2)
            sumSqHp += ds2 * ds2
            if i < cap {
                hpHistory[writeStart + i] = s2
            }
        }
        let invN = 1.0 / Double(count)
        let rawRMS = Float(sqrt(sumSqRaw * invN))
        let hpRMS = Float(sqrt(sumSqHp * invN))
        let hpRatio = rawRMS > 1e-7 ? (hpRMS / rawRMS) : 0
        return (rawRMS, hpRatio)
    }

    /// Maximum normalized autocorrelation of the high-passed buffer over human speech pitch lags (80-400 Hz).
    /// Broadband fan noise lacks periodicity here, while sustained quiet voiced tones/vowels score high.
    private mutating func hpPitchPeriodicity() -> Float {
        let n = hpHistoryCount
        guard n >= Self.analysisSubframeSamples else { return 0 }
        hpPrefixSq[0] = 0
        for i in 0..<n {
            let v = Double(hpHistory[i])
            hpPrefixSq[i + 1] = hpPrefixSq[i] + v * v
        }
        let totalEndSq = hpPrefixSq[n]
        var best: Double = 0
        var lag = Self.pitchLagMin
        while lag <= Self.pitchLagMax {
            let m = n - lag
            let e0 = hpPrefixSq[m]
            let e1 = totalEndSq - hpPrefixSq[lag]
            let prod = e0 * e1
            if prod > 1e-18 {
                var num: Double = 0
                for i in 0..<m {
                    num += Double(hpHistory[i]) * Double(hpHistory[i + lag])
                }
                let r = num / sqrt(prod)
                if r > best { best = r }
            }
            lag += Self.pitchLagStep
        }
        return Float(best)
    }

    private mutating func updateNoiseFloor(rawRMS: Float, hpRatio: Float, pitch: Float, dt: Float) {
        guard rawRMS.isFinite, rawRMS > 1e-6 else { return }
        if rawRMS > Self.maxNoiseCeilingRMS {
            stationaryDuration = 0
            stationaryAnchorRMS = 0
            prevSubframeRMS = rawRMS
            return
        }
        if rawRMS < noiseFloorRMS {
            let alpha = 1.0 - expf(-dt / Self.noiseFloorReleaseTau)
            noiseFloorRMS = max(Self.minNoiseFloorRMS, noiseFloorRMS + (rawRMS - noiseFloorRMS) * alpha)
        }
        let isEnvelopeCandidate: Bool
        if prevSubframeRMS <= 0 || hpHistoryCount < Self.analysisSubframeSamples {
            isEnvelopeCandidate = false
            prevSubframeRMS = rawRMS
            stationaryAnchorRMS = rawRMS
            stationaryDuration = 0
        } else {
            let ratio = rawRMS / prevSubframeRMS
            let anchorOk = stationaryAnchorRMS <= 0
                || (rawRMS >= stationaryAnchorRMS * 0.58 && rawRMS <= stationaryAnchorRMS * 1.72)
            if ratio >= 0.65 && ratio <= 1.54 && anchorOk {
                isEnvelopeCandidate = true
                prevSubframeRMS += (rawRMS - prevSubframeRMS) * 0.35
                if stationaryAnchorRMS <= 0 { stationaryAnchorRMS = rawRMS }
            } else {
                isEnvelopeCandidate = false
                stationaryDuration = 0
                prevSubframeRMS = rawRMS
                stationaryAnchorRMS = rawRMS
            }
        }
        guard isEnvelopeCandidate else { return }

        // Require sustained vocal harmonic clarity before exempting stationary low-level audio from
        // ambient noise adaptation; room/fan hum with moderate 25ms autocorrelation still adapts.
        if hpRatio >= Self.minSpeechBandRatio && pitch >= Self.noiseAdaptMaxPitchPeriodicity {
            stationaryDuration = 0
            stationaryAnchorRMS = rawRMS
            return
        }

        stationaryDuration += dt
        if rawRMS > noiseFloorRMS && stationaryDuration >= Self.stationaryHoldSeconds {
            let alpha = 1.0 - expf(-dt / Self.noiseFloorAttackTau)
            noiseFloorRMS = min(Self.maxNoiseFloorRMS, noiseFloorRMS + (rawRMS - noiseFloorRMS) * alpha)
        }
    }

    private mutating func processSubframe(
        _ subframe: ArraySlice<Float>,
        into out: inout [Float],
        outOffset: Int
    ) -> (voiced: Bool, sumSqOut: Double) {
        let count = subframe.count
        let dt = Float(count) / Float(Self.sampleRate)
        let (rawRMS, hpRatio) = analyzeSubframe(subframe)
        let pitch = hpRatio >= Self.minSpeechBandRatio ? hpPitchPeriodicity() : 0
        updateNoiseFloor(rawRMS: rawRMS, hpRatio: hpRatio, pitch: pitch, dt: dt)

        // Preserve clean native microphone PCM at unity gain (1.0x) with finite sanitize + soft-knee
        // peak protection only; software normalization boost amplifies room noise and degrades audio.
        currentGain = 1.0
        var sumSqOut: Double = 0
        var idx = subframe.startIndex
        for i in 0..<count {
            let sample = subframe[idx]
            idx += 1
            let y = Self.softLimit(sample.isFinite ? sample : 0)
            out[outOffset + i] = y
            let dy = Double(y)
            sumSqOut += dy * dy
        }
        let outputRMS = Float(sqrt(sumSqOut / Double(count)))
        let minSpeechFloor = max(Self.voicedRawRMSFloor, noiseFloorRMS * Self.voicedNoiseMultiplier)
        let amplitudeVoiced = rawRMS >= minSpeechFloor && outputRMS >= Self.voicedBoostedRMSFloor
        let speechLike = rawRMS >= Self.unpitchedSpeechRMSFloor
            || (hpRatio >= Self.minSpeechBandRatio && pitch >= Self.minPitchPeriodicity)
        let voiced = amplitudeVoiced && speechLike
        return (voiced, sumSqOut)
    }

    mutating func process(_ samples: [Float]) -> Result {
        guard !samples.isEmpty else {
            return Result(
                samples: [],
                rawRMS: 0,
                boostedRMS: 0,
                anyVoiced: false,
                lastVoiced: false,
                trailingUnvoicedSamples: 0,
                voicedSamples: 0,
                noiseFloorRMS: noiseFloorRMS
            )
        }
        let overallRawRMS = Self.rms(samples)
        var out = [Float](repeating: 0, count: samples.count)
        var totalSumSqOut: Double = 0
        var anyVoiced = false
        var lastVoiced = false
        var trailingUnvoiced = 0
        var voicedSamples = 0

        var pos = 0
        while pos < samples.count {
            let end = min(samples.count, pos + Self.analysisSubframeSamples)
            let (voiced, subSumSqOut) = processSubframe(samples[pos..<end], into: &out, outOffset: pos)
            totalSumSqOut += subSumSqOut
            let subCount = end - pos
            anyVoiced = anyVoiced || voiced
            lastVoiced = voiced
            if voiced { voicedSamples += subCount }
            trailingUnvoiced = voiced ? 0 : (trailingUnvoiced + subCount)
            pos = end
        }
        let overallBoostedRMS = Float(sqrt(totalSumSqOut / Double(out.count)))
        return Result(
            samples: out,
            rawRMS: overallRawRMS,
            boostedRMS: overallBoostedRMS,
            anyVoiced: anyVoiced,
            lastVoiced: lastVoiced,
            trailingUnvoicedSamples: trailingUnvoiced,
            voicedSamples: voicedSamples,
            noiseFloorRMS: noiseFloorRMS
        )
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
    private var activeSamples = 0
    private var gain = SpeechGain()
    private(set) var warmupRemaining: Int
    private var pendingAudioLevel: Float?
    private var lastAudioLevelAt: TimeInterval = -.infinity
    private(set) var lastVoiced = false
    var currentNoiseFloorRMS: Float { gain.noiseFloorRMS }
    enum Failure: Error { case overload }
    init(warmupSamples: Int = SpeechInbox.warmupSamples) {
        self.warmupRemaining = max(0, warmupSamples)
    }
    mutating func offer(_ input: [Float]) throws -> Bool {
        let skip = min(warmupRemaining, input.count)
        warmupRemaining -= skip
        let audio = input.dropFirst(skip)
        guard !audio.isEmpty else { return false }
        guard audio.count <= Self.limit - pending.count else { throw Failure.overload }
        let result = gain.process(Array(audio))
        let level = min(1, max(0, result.rawRMS))
        pendingAudioLevel = level
        lastVoiced = result.lastVoiced
        speech = speech || result.anyVoiced
        activeSamples += result.voicedSamples
        if result.anyVoiced {
            trailingSilence = result.trailingUnvoicedSamples
        } else {
            trailingSilence += result.samples.count
        }
        pending.append(contentsOf: result.samples)
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
    struct Batch {
        let samples: [Float]
        let speech: Bool
        let trailingSilence: Int
        let activeSamples: Int
        let noiseFloorRMS: Float
    }
    mutating func take() -> Batch? {
        guard !pending.isEmpty else { scheduled = false; return nil }
        let batch = Batch(
            samples: pending,
            speech: speech,
            trailingSilence: trailingSilence,
            activeSamples: activeSamples,
            noiseFloorRMS: gain.noiseFloorRMS
        )
        pending = []; speech = false; trailingSilence = 0; activeSamples = 0
        return batch
    }
}
