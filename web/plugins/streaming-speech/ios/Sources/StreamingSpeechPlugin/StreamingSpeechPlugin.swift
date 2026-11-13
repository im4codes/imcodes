import AVFoundation
import Capacitor
import Metal
import AudioCommon
import MLXCommon
import Qwen3ASR
import UIKit

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
    let worker = DispatchQueue(label: "com.imcodes.streaming-speech", qos: .userInteractive)
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

    init(emitQueue: DispatchQueue = .main, onEvent: @escaping (Event) -> Void) {
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
        inbox = SpeechInbox()
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
                let warming = inbox.warmupRemaining > 0
                let schedule = try inbox.offer(samples)
                var readyCallback: (() -> Void)?
                if warming && inbox.warmupRemaining == 0 && startPendingOwner == owner {
                    startPendingOwner = 0
                    readyCallback = startReadyCallback
                    startReadyCallback = nil
                }
                let level = inbox.pollAudioLevel(now: now)
                lock.unlock()

                if let readyCallback = readyCallback {
                    emitQueue.async { [weak self] in
                        readyCallback()
                        guard let self = self, self.isCurrent(owner) else { return }
                        self.onEvent(.started)
                    }
                }
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
public class StreamingSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StreamingSpeechPlugin"
    public let jsName = "StreamingSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
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
    private var engine: AVAudioEngine?
    private var tapInstalled = false
    private var startingCall: CAPPluginCall? // main-thread only; ready after warmup
    private var warmupWatchdog: DispatchWorkItem? // main-thread only; guards stalled CoreAudio warmup
    // Resident recognizer model kept across sessions on worker; Metal state is guarded for foreground use.
    private var recognizer: SpeechRecognizer?

    public override func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackground(_:)), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didBecomeActive(_:)), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(engineConfigurationChanged(_:)), name: .AVAudioEngineConfigurationChange, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didReceiveMemoryWarning(_:)), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
        coordinator.worker.async { [weak self] in
            guard let self = self else { return }
            _ = self.ensureRecognizer()
        }
    }
    @objc private func didReceiveMemoryWarning(_ notification: Notification) {
        coordinator.worker.async {
            Qwen3ASRModel.clearMetalCache()
        }
    }
    deinit {
        NotificationCenter.default.removeObserver(self)
        warmupWatchdog?.cancel()
        warmupWatchdog = nil
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
        guard modelAvailable, let root = modelRoot, let created = SpeechRecognizer(root: root) else { return nil }
        recognizer = created
        return created
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
            guard AVAudioSession.sharedInstance().recordPermission == .granted else {
                call.reject("Microphone permission denied"); return
            }
            guard self.modelAvailable else {
                call.reject("Offline speech model missing"); return
            }
            if self.engine != nil || self.tapInstalled || self.startingCall != nil {
                self.settleStartingCall(errorMessage: "Offline speech superseded by new session")
                self.endCapture(nil, deactivateSession: false)
            }
            let expectedCall = call
            self.startingCall = call
            let owner = self.coordinator.beginStart(
                makeDecode: { [weak self] in
                    guard let self = self,
                          let recognizer = self.ensureRecognizer(),
                          let decoder = SpeechDecoder(recognizer: recognizer) else { return nil }
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
            do {
                let session = AVAudioSession.sharedInstance()
                do {
                    try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth])
                } catch {
                    try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth])
                }
                try session.setActive(true)
                if session.isInputGainSettable {
                    try? session.setInputGain(1.0)
                }
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
                let tapFrames = AVAudioFrameCount(max(512, Int(format.sampleRate / 40)))
                input.installTap(onBus: 0, bufferSize: tapFrames, format: format) { [weak self] buffer, _ in
                    self?.consume(buffer, owner: owner, converter: converter, mono: mono)
                }
                self.tapInstalled = true
                try engine.start()
                let watchdog = DispatchWorkItem { [weak self, weak expectedCall] in
                    guard let self = self, let expectedCall = expectedCall,
                          self.startingCall === expectedCall else { return }
                    self.settleStartingCall(errorMessage: "Offline speech microphone failed to start")
                    self.coordinator.cancelStartSetup(owner: owner)
                    self.endCapture(nil)
                }
                self.cancelWarmupWatchdog()
                self.warmupWatchdog = watchdog
                DispatchQueue.main.asyncAfter(deadline: .now() + 10.0, execute: watchdog)
                // consume() signals ready only after startup PCM was discarded;
                // ~25ms tap interval reaches the 20ms warmup threshold without long UI stall.
            } catch {
                self.cancelWarmupWatchdog()
                if self.startingCall === expectedCall {
                    self.startingCall = nil
                }
                self.coordinator.cancelStartSetup(owner: owner)
                self.endCapture(nil)
                call.reject("Offline speech could not start", nil, error)
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

    @objc private func interrupted(_ notification: Notification) {
        if notification.name == UIApplication.willResignActiveNotification {
            coordinator.setBackgrounded(true)
        } else if notification.name == AVAudioSession.interruptionNotification,
           let value = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
           value != AVAudioSession.InterruptionType.began.rawValue { return }
        DispatchQueue.main.async {
            if self.startingCall != nil {
                self.settleStartingCall(errorMessage: "Offline speech interrupted during startup")
            }
            self.endCapture(nil)
        }
    }
    @objc private func didEnterBackground(_ notification: Notification) {
        coordinator.setBackgrounded(true)
        DispatchQueue.main.async {
            if self.startingCall != nil {
                self.settleStartingCall(errorMessage: "Speech requires a foreground app")
            }
            self.endCapture(nil)
        }
    }
    @objc private func engineConfigurationChanged(_ notification: Notification) {
        DispatchQueue.main.async {
            guard let activeEngine = self.engine else { return }
            if let notifiedEngine = notification.object as? AVAudioEngine, notifiedEngine !== activeEngine {
                return
            }
            if self.startingCall != nil {
                self.settleStartingCall(errorMessage: "Offline speech interrupted by audio configuration change")
            }
            self.endCapture(nil)
        }
    }
    @objc private func didBecomeActive(_ notification: Notification) {
        coordinator.setBackgrounded(false)
    }
    @objc public func stop(_ call: CAPPluginCall) { DispatchQueue.main.async { self.endCapture(call) } }
    // Main-thread capture teardown; serial decoder flush precedes stopped and ACK.
    private func endCapture(_ call: CAPPluginCall?, deactivateSession: Bool = true) {
        cancelWarmupWatchdog()
        coordinator.endCapture(
            stopCompletion: call.map { c in
                { errorMsg in
                    if let errorMsg = errorMsg { c.reject(errorMsg) }
                    else { c.resolve() }
                }
            },
            stopAudio: {
                if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }
                engine?.stop(); engine = nil
                if deactivateSession {
                    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                }
            }
        )
        coordinator.worker.async {
            Qwen3ASRModel.clearMetalCache()
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
    func decode(
        samples: [Float],
        prefixTokens: [Int32] = [],
        shouldContinue: () -> Bool = { true }
    ) -> (text: String, tokens: [Int32])? {
        if samples.isEmpty { return ("", prefixTokens) }
        guard shouldContinue() else { return nil }
        let options = Qwen3DecodingOptions(maxTokens: 192, language: nil, context: recognizer.hotwords)
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
        recognizer.model.safePrefixTokensForRollback(tokens, rollbackCount: rollbackCount)
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
    static let stride = sampleRate * 3 / 2 // 1.5s of NEW audio per partial decode
    static let segmentCapacity = sampleRate * 27 / 2 // 13.5s bounded active segment capacity (216,000 samples, below 15s threshold)
    static let splitSearchWindow = sampleRate * 5 / 2 // Search trailing 2.5s band for a sustained quiet interval boundary
    static let finalSilencePadding = sampleRate * 2 / 10 // 200ms (3200 zero samples) flushed once at final boundary
    static let unfixedChunkNum = 2
    static let unfixedTokenNum = 5
    static let punctuationPause = sampleRate * 4 / 10
    static let vadPause = sampleRate * 7 / 10
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
    var text: String { Self.join(committed, partial) }

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

    private mutating func advanceSilence(sliceCount: Int, speech: Bool, trailingSilence: Int, tailRemaining: Int) {
        guard speech else {
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
        final: Bool = false,
        shouldEmitNonFinal: () -> Bool = { true },
        shouldContinue: () -> Bool = { true },
        rollbackPrefix: RollbackFn = SpeechWindow.defaultRollbackPrefix,
        decode: DecodeFn,
        emit: (String) -> Void
    ) throws {
        guard !input.isEmpty, !samples.isEmpty || speech else { return }
        var remaining = input[...]
        while samples.count + remaining.count > Self.segmentCapacity {
            guard shouldContinue() else { throw Failure.cancelled }
            let takeCount = max(0, Self.segmentCapacity - samples.count)
            let chunk = remaining.prefix(takeCount)
            remaining = remaining.dropFirst(takeCount)
            samples.append(contentsOf: chunk)
            newSamples += chunk.count
            advanceSilence(sliceCount: chunk.count, speech: speech, trailingSilence: trailingSilence, tailRemaining: remaining.count)
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
        advanceSilence(sliceCount: remaining.count, speech: speech, trailingSilence: trailingSilence, tailRemaining: 0)
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
    static let maxGain: Float = 8.0
    static let minNoiseFloorRMS: Float = 0.0004
    static let initialNoiseFloorRMS: Float = 0.0005
    static let maxNoiseFloorRMS: Float = 0.0038
    static let maxNoiseCeilingRMS: Float = 0.0040
    static let noiseFloorLowRMS: Float = 0.0005
    static let noiseFloorHighRMS: Float = 0.0014
    static let voicedRawRMSFloor: Float = 0.0010
    static let voicedNoiseMultiplier: Float = 1.45
    static let voicedBoostedRMSFloor: Float = 0.0050
    static let stationaryHoldSeconds: Float = 0.18
    static let noiseFloorAttackTau: Float = 0.13
    static let noiseFloorReleaseTau: Float = 0.06
    static let gainAttackUpTau: Float = 0.018
    static let gainReleaseTau: Float = 0.125
    static let analysisSubframeSamples = 400 // 25 ms @ 16 kHz keeps tracker & gain chunk-size invariant
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
    }

    private(set) var currentGain: Float = 1.0
    private(set) var noiseFloorRMS: Float = SpeechGain.initialNoiseFloorRMS
    private var prevSubframeRMS: Float = 0.0
    private var stationaryDuration: Float = 0.0

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

    private mutating func updateNoiseFloor(rawRMS: Float, dt: Float) {
        guard rawRMS.isFinite else { return }
        if rawRMS > Self.maxNoiseCeilingRMS {
            stationaryDuration = 0
            prevSubframeRMS = rawRMS
            return
        }
        if prevSubframeRMS <= 0 {
            prevSubframeRMS = rawRMS
            stationaryDuration = 0
        } else {
            let ratio = rawRMS / prevSubframeRMS
            if ratio >= 0.65 && ratio <= 1.54 {
                stationaryDuration += dt
                prevSubframeRMS += (rawRMS - prevSubframeRMS) * 0.35
            } else {
                stationaryDuration = 0
                prevSubframeRMS = rawRMS
            }
        }
        if rawRMS < noiseFloorRMS {
            let alpha = 1.0 - expf(-dt / Self.noiseFloorReleaseTau)
            noiseFloorRMS = max(Self.minNoiseFloorRMS, noiseFloorRMS + (rawRMS - noiseFloorRMS) * alpha)
        } else if stationaryDuration >= Self.stationaryHoldSeconds {
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
        let rawRMS = Self.rms(subframe)
        updateNoiseFloor(rawRMS: rawRMS, dt: dt)

        let confidence = Self.speechConfidence(rawRMS: rawRMS, noiseFloor: noiseFloorRMS)
        let speechDesired = min(Self.maxGain, max(Self.minGain, Self.targetRMS / max(rawRMS, 1e-4)))
        let desiredGain = Self.minGain + confidence * (speechDesired - Self.minGain)

        let startGain = currentGain
        let alpha: Float
        if desiredGain < currentGain {
            alpha = confidence < 0.5 ? (1.0 - expf(-dt / Self.gainReleaseTau)) : 1.0
        } else {
            alpha = 1.0 - expf(-dt / Self.gainAttackUpTau)
        }
        let nextGain = min(Self.maxGain, max(Self.minGain, currentGain + (desiredGain - currentGain) * alpha))
        currentGain = nextGain

        let rampLimit = nextGain < startGain ? Self.maxDownRampSamples : Self.maxUpRampSamples
        let rampCount = min(count, rampLimit)
        let delta = nextGain - startGain
        var sumSqOut: Double = 0
        var idx = subframe.startIndex
        for i in 0..<count {
            let sample = subframe[idx]
            idx += 1
            let g: Float
            if i < rampCount && rampCount > 0 {
                let t = Float(i + 1) / Float(rampCount)
                g = startGain + delta * t
            } else {
                g = nextGain
            }
            let y = Self.softLimit((sample.isFinite ? sample : 0) * g)
            out[outOffset + i] = y
            let dy = Double(y)
            sumSqOut += dy * dy
        }
        let boostedRMS = Float(sqrt(sumSqOut / Double(count)))
        let minSpeechFloor = max(Self.voicedRawRMSFloor, noiseFloorRMS * Self.voicedNoiseMultiplier)
        let voiced = rawRMS >= minSpeechFloor && boostedRMS >= Self.voicedBoostedRMSFloor
        return (voiced, sumSqOut)
    }

    mutating func process(_ samples: [Float]) -> Result {
        guard !samples.isEmpty else {
            return Result(samples: [], rawRMS: 0, boostedRMS: 0, anyVoiced: false, lastVoiced: false, trailingUnvoicedSamples: 0)
        }
        let overallRawRMS = Self.rms(samples)
        var out = [Float](repeating: 0, count: samples.count)
        var totalSumSqOut: Double = 0
        var anyVoiced = false
        var lastVoiced = false
        var trailingUnvoiced = 0

        var pos = 0
        while pos < samples.count {
            let end = min(samples.count, pos + Self.analysisSubframeSamples)
            let (voiced, subSumSqOut) = processSubframe(samples[pos..<end], into: &out, outOffset: pos)
            totalSumSqOut += subSumSqOut
            let subCount = end - pos
            anyVoiced = anyVoiced || voiced
            lastVoiced = voiced
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
            trailingUnvoicedSamples: trailingUnvoiced
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
    private var gain = SpeechGain()
    private(set) var warmupRemaining = SpeechInbox.warmupSamples
    private var pendingAudioLevel: Float?
    private var lastAudioLevelAt: TimeInterval = -.infinity
    private(set) var lastVoiced = false
    enum Failure: Error { case overload }
    mutating func offer(_ input: [Float]) throws -> Bool {
        let skip = min(warmupRemaining, input.count)
        warmupRemaining -= skip
        let audio = input.dropFirst(skip)
        guard !audio.isEmpty else { return false }
        guard audio.count <= Self.limit - pending.count else { throw Failure.overload }
        let result = gain.process(Array(audio))
        let level = min(1, result.boostedRMS * 4)
        pendingAudioLevel = level
        lastVoiced = result.lastVoiced
        speech = speech || result.anyVoiced
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
    struct Batch { let samples: [Float]; let speech: Bool; let trailingSilence: Int }
    mutating func take() -> Batch? {
        guard !pending.isEmpty else { scheduled = false; return nil }
        let batch = Batch(samples: pending, speech: speech, trailingSilence: trailingSilence)
        pending = []; speech = false; trailingSilence = 0
        return batch
    }
}
