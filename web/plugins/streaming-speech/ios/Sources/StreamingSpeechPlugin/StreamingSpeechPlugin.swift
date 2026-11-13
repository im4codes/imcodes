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
    typealias DecodeFn = ([Float], @escaping () -> Bool) -> String?

    private let lock = NSCondition()
    let worker = DispatchQueue(label: "com.imcodes.streaming-speech", qos: .userInitiated)
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
    private var activeDecode: DecodeFn?
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
        makeDecode: @escaping () -> DecodeFn?,
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
            guard let decode = makeDecode() else {
                self.lock.lock()
                if self.decoderOwner == owner || self.decoderOwner == 0 {
                    self.activeDecode = nil
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
            self.activeDecode = decode
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
                if self.decoderOwner == owner, let decode = self.activeDecode, self.canRunMetal(owner) {
                    do {
                        if let tail = tail {
                            try self.window.append(
                                tail.samples,
                                speech: tail.speech,
                                trailingSilence: tail.trailingSilence,
                                final: true,
                                shouldContinue: { [weak self] in self?.canRunMetal(owner) ?? false },
                                decode: { [weak self] samples in
                                    decode(samples) { self?.canRunMetal(owner) ?? false }
                                }
                            ) { _ in }
                        }
                        guard self.canRunMetal(owner) else { throw SpeechWindow.Failure.cancelled }
                        let text = try self.window.finish(shouldContinue: { [weak self] in self?.canRunMetal(owner) ?? false }) { samples in
                            decode(samples) { [weak self] in self?.canRunMetal(owner) ?? false }
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
                } else if self.decoderOwner == owner, self.activeDecode != nil {
                    finalToEmit = self.window.text
                }
            }

            if self.decoderOwner == owner || self.decoderOwner == 0 {
                self.window = SpeechWindow()
                self.activeDecode = nil
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
            guard decoderOwner == owner, let decode = activeDecode else {
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
                    decode: { [weak self] samples in
                        decode(samples) { self?.canRunMetal(owner) ?? false }
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
        coordinator.worker.async { [weak self] in
            guard let self = self else { return }
            _ = self.ensureRecognizer()
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
                    return { samples, shouldContinue in
                        decoder.decode(samples: samples, shouldContinue: shouldContinue)
                    }
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
    private(set) var newSamples = 0
    private var silentSamples = 0
    private var lastEmitted = ""
    var text: String { rolling ? committed + partial : Self.join(committed, partial) }

    mutating func append(_ input: [Float], speech: Bool, trailingSilence: Int = 0, final: Bool = false,
                         shouldEmitNonFinal: () -> Bool = { true },
                         shouldContinue: () -> Bool = { true },
                         decode: ([Float]) -> String?, emit: (String) -> Void) throws {
        guard !input.isEmpty, !samples.isEmpty || speech else { return }
        // Chunk oversized batches (both live and final stop drain) at the bounded
        // window capacity (6.0s = 96,000 samples) so neither continuous speech nor a
        // 32s inbox backlog ever exceeds the per-decode window capacity.
        var remaining = input[...]
        while samples.count + remaining.count > Self.capacity {
            guard shouldContinue() else { throw Failure.cancelled }
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
        guard !remaining.isEmpty else { return }
        guard shouldContinue() else { throw Failure.cancelled }
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
