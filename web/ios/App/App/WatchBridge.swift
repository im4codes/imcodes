import UIKit
import WatchConnectivity
import UserNotifications
import StreamingSpeechPlugin
import Speech
import AVFoundation
import os.log

private let logger = Logger(subsystem: "com.im.codes", category: "WatchBridge")

private final class BgSpeechStreamSession {
    private static let pcmFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16000,
        channels: 1,
        interleaved: true
    )

    let streamId: String
    private let queue: DispatchQueue
    private let recognizer: SFSpeechRecognizer
    private let onUpdate: (WatchAsrUpdate) -> Void

    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var bgTaskId: UIBackgroundTaskIdentifier = .invalid
    private var latestText = ""
    private var finished = false
    private var cancelled = false
    private var finishTimeoutWorkItem: DispatchWorkItem?

    init(
        streamId: String,
        recognizer: SFSpeechRecognizer,
        queue: DispatchQueue,
        onUpdate: @escaping (WatchAsrUpdate) -> Void
    ) {
        self.streamId = streamId
        self.recognizer = recognizer
        self.queue = queue
        self.onUpdate = onUpdate
    }

    func start() {
        acquireBackgroundTask(name: "IMCodesWatchBgAsr") { [weak self] in
            self?.cancel()
        }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = false

        lock.lock()
        guard !cancelled, !finished else {
            lock.unlock()
            endBackgroundTask()
            return
        }
        self.request = req
        self.task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            self?.handleRecognitionCallback(result: result, error: error)
        }
        lock.unlock()
    }

    func append(pcm16: Data, isFinal: Bool) {
        lock.lock()
        let isDone = cancelled || finished
        let activeReq = request
        lock.unlock()
        guard !isDone, let activeReq else { return }

        let frameCount = AVAudioFrameCount(pcm16.count / 2)
        if frameCount > 0,
           let format = Self.pcmFormat,
           let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount),
           let dst = buffer.int16ChannelData?[0] {
            buffer.frameLength = frameCount
            pcm16.withUnsafeBytes { raw in
                if let src = raw.bindMemory(to: Int16.self).baseAddress {
                    dst.update(from: src, count: Int(frameCount))
                }
            }
            activeReq.append(buffer)
        }

        if isFinal {
            finish()
        }
    }

    func finish() {
        lock.lock()
        if cancelled || finished {
            lock.unlock()
            return
        }
        let activeReq = request
        if finishTimeoutWorkItem == nil {
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.completeOnce(textOverride: nil, error: nil)
            }
            finishTimeoutWorkItem = work
            queue.asyncAfter(deadline: .now() + 5.0, execute: work)
        }
        lock.unlock()
        activeReq?.endAudio()
    }

    func cancel() {
        lock.lock()
        if cancelled || finished {
            lock.unlock()
            endBackgroundTask()
            return
        }
        cancelled = true
        finishTimeoutWorkItem?.cancel()
        finishTimeoutWorkItem = nil
        let activeReq = request
        let activeTask = task
        request = nil
        task = nil
        lock.unlock()

        activeReq?.endAudio()
        activeTask?.cancel()
        endBackgroundTask()
    }

    private func handleRecognitionCallback(result: SFSpeechRecognitionResult?, error: Error?) {
        if let result {
            let transcript = result.bestTranscription.formattedString
            lock.lock()
            let shouldSkip = cancelled || finished
            if !shouldSkip && !transcript.isEmpty {
                latestText = transcript
            }
            lock.unlock()
            guard !shouldSkip else { return }

            if result.isFinal {
                completeOnce(textOverride: transcript, error: nil)
                return
            }
            onUpdate(WatchAsrUpdate(streamId: streamId, text: transcript, isFinal: false))
        }

        if let error {
            completeOnce(textOverride: nil, error: error)
        }
    }

    private func completeOnce(textOverride: String?, error: Error?) {
        lock.lock()
        if cancelled || finished {
            lock.unlock()
            endBackgroundTask()
            return
        }
        finished = true
        finishTimeoutWorkItem?.cancel()
        finishTimeoutWorkItem = nil
        let finalText: String
        if let textOverride, !textOverride.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            finalText = textOverride
        } else {
            finalText = latestText
        }
        let activeReq = request
        let activeTask = task
        request = nil
        task = nil
        lock.unlock()

        activeReq?.endAudio()
        if error != nil {
            activeTask?.cancel()
        } else {
            activeTask?.finish()
        }

        if let error, finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !Self.isBenignSpeechError(error) {
            onUpdate(WatchAsrUpdate(
                streamId: streamId,
                text: "",
                isFinal: true,
                errorCode: "speech_recognition_failed",
                errorMessage: error.localizedDescription
            ))
        } else {
            onUpdate(WatchAsrUpdate(streamId: streamId, text: finalText, isFinal: true))
        }
        endBackgroundTask()
    }

    static func isBenignSpeechError(_ error: Error) -> Bool {
        let nsErr = error as NSError
        if nsErr.domain == NSCocoaErrorDomain && nsErr.code == NSUserCancelledError {
            return true
        }
        // Apple Speech Assistant domain silent / cancelled codes (1110: no speech detected, 203: retry/empty, 209/216: cancelled)
        if nsErr.domain == "kAFAssistantErrorDomain" && [203, 209, 216, 1110].contains(nsErr.code) {
            return true
        }
        return false
    }

    private func acquireBackgroundTask(name: String, onExpire: @escaping () -> Void) {
        let acquire = {
            var id: UIBackgroundTaskIdentifier = .invalid
            id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
                onExpire()
                self?.endBackgroundTask(expectedId: id)
            }
            self.lock.lock()
            if self.finished || self.cancelled {
                self.lock.unlock()
                if id != .invalid {
                    UIApplication.shared.endBackgroundTask(id)
                }
                return
            }
            self.bgTaskId = id
            self.lock.unlock()
        }
        if Thread.isMainThread {
            acquire()
        } else {
            DispatchQueue.main.async(execute: acquire)
        }
    }

    private func endBackgroundTask(expectedId: UIBackgroundTaskIdentifier? = nil) {
        lock.lock()
        let id = bgTaskId
        if id == .invalid || (expectedId != nil && expectedId != id) {
            lock.unlock()
            return
        }
        bgTaskId = .invalid
        lock.unlock()
        let end = {
            UIApplication.shared.endBackgroundTask(id)
        }
        if Thread.isMainThread {
            end()
        } else {
            DispatchQueue.main.async(execute: end)
        }
    }
}

extension Notification.Name {
    static let watchCommand = Notification.Name("watchCommand")
}

final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()

    private enum StreamBackend {
        case mlx
        case appleSpeech(BgSpeechStreamSession)
    }

    private struct StreamBufferState {
        var backend: StreamBackend = .mlx
        var nextExpectedSeq: UInt32 = 0
        var reordered: [UInt32: (isFinal: Bool, pcm16: Data)] = [:]
        var isStarted: Bool = false
    }

    private struct PendingAudioFile {
        let streamId: String
        let fileURL: URL
        let language: String?
    }

    private static let packetMagic: [UInt8] = [0x57, 0x41, 0x53, 0x31] // "WAS1"
    private static let packetHeaderSize = 28

    private let session = WCSession.default
    private var didAttemptActivation = false
    private var didRequestSpeechAuth = false
    private let asrQueue = DispatchQueue(label: "com.im.codes.watch-bridge.asr", qos: .userInitiated)
    private var activeStreams: [String: StreamBufferState] = [:]
    private var activeBgFileTasks: [String: SFSpeechRecognitionTask] = [:]
    private var pendingAudioFiles: [PendingAudioFile] = []

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func appDidBecomeActive() {
        drainPendingAudioFiles()
    }

    func activate() {
        guard WCSession.isSupported() else { return }

        if session.delegate !== self {
            session.delegate = self
        }

        if !didAttemptActivation || session.activationState != .activated {
            didAttemptActivation = true
            session.activate()
        }
    }

    func syncSnapshot(_ context: [String: Any]) {
        guard WCSession.isSupported() else {
            logger.error("WCSession not supported")
            return
        }
        let s = self.session
        logger.info("syncSnapshot called, activationState=\(s.activationState.rawValue) isPaired=\(s.isPaired) isWatchAppInstalled=\(s.isWatchAppInstalled) keys=\(context.keys.sorted().joined(separator: ","))")
        guard s.activationState == .activated else {
            logger.error("WCSession not activated (state: \(s.activationState.rawValue))")
            return
        }
        guard s.isPaired else {
            logger.error("Watch not paired")
            return
        }
        guard s.isWatchAppInstalled else {
            logger.error("Watch app not installed")
            return
        }

        do {
            try session.updateApplicationContext(context)
            logger.info("Snapshot pushed OK (\(context.count) keys)")
        } catch {
            logger.error("updateApplicationContext failed: \(error.localizedDescription)")
        }
    }

    func pushDurableEvent(_ event: [String: Any]) {
        guard WCSession.isSupported(),
              session.isPaired,
              session.isWatchAppInstalled else {
            return
        }

        session.transferUserInfo(event)
    }

    private func handleWatchMessage(_ message: [String: Any]) {
        guard let action = message["action"] as? String else { return }

        switch action {
        case "switchServer":
            guard let serverId = message["serverId"] as? String, !serverId.isEmpty else { return }
            NotificationCenter.default.post(
                name: .watchCommand,
                object: nil,
                userInfo: [
                    "action": action,
                    "serverId": serverId
                ]
            )
        case "refresh", "requestSnapshot":
            NotificationCenter.default.post(
                name: .watchCommand,
                object: nil,
                userInfo: [
                    "action": action
                ]
            )
        case "openSession":
            guard let serverId = message["serverId"] as? String,
                  let sessionName = message["sessionName"] as? String else { return }
            // Forward to JS for session switching
            NotificationCenter.default.post(
                name: .watchCommand,
                object: nil,
                userInfo: [
                    "action": action,
                    "serverId": serverId,
                    "sessionName": sessionName
                ]
            )
            // If app is in background, fire local notification so user can tap to foreground
            if UIApplication.shared.applicationState != .active {
                let content = UNMutableNotificationContent()
                content.title = "IM.codes"
                content.body = "Tap to open session"
                content.sound = .default
                let request = UNNotificationRequest(
                    identifier: "watch-open-session",
                    content: content,
                    trigger: nil
                )
                UNUserNotificationCenter.current().add(request)
            }
        case "watchAsrStart":
            let streamId = (message["streamId"] as? String) ?? ""
            let language = message["language"] as? String
            startWatchAsrStream(streamId: streamId, language: language)
        case "watchAsrStop":
            let streamId = (message["streamId"] as? String) ?? ""
            let cancel = (message["cancel"] as? Bool) ?? false
            stopWatchAsrStream(streamId: streamId, cancel: cancel)
        default:
            break
        }
    }

    private static func isAppBackgrounded() -> Bool {
        if Thread.isMainThread {
            return UIApplication.shared.applicationState == .background
        }
        return DispatchQueue.main.sync {
            UIApplication.shared.applicationState == .background
        }
    }

    private static func makeSpeechRecognizer(language: String?) -> SFSpeechRecognizer? {
        if let raw = language?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty {
            if let recognizer = SFSpeechRecognizer(locale: Locale(identifier: raw)) {
                return recognizer
            }
        }
        if let preferred = Locale.preferredLanguages.first,
           let recognizer = SFSpeechRecognizer(locale: Locale(identifier: preferred)) {
            return recognizer
        }
        return SFSpeechRecognizer()
    }

    private func prewarmSpeechAuthorizationIfNeeded() {
        guard !didRequestSpeechAuth,
              SFSpeechRecognizer.authorizationStatus() == .notDetermined else {
            return
        }
        didRequestSpeechAuth = true
        DispatchQueue.main.async {
            SFSpeechRecognizer.requestAuthorization { _ in }
        }
    }

    private func cancelAllActiveStreamsLocked() {
        for (_, state) in activeStreams {
            if case .appleSpeech(let bgSession) = state.backend {
                bgSession.cancel()
            }
        }
        activeStreams.removeAll()
    }

    private func startBackgroundSpeechStreamLocked(
        streamId: String,
        language: String?
    ) -> Result<Void, WatchAsrError> {
        guard !WatchAsrBridge.shared.isPhoneMicBusy else {
            return .failure(.phoneMicBusy)
        }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized,
              let recognizer = Self.makeSpeechRecognizer(language: language),
              recognizer.isAvailable else {
            return .failure(.phoneBackgrounded)
        }
        WatchAsrBridge.shared.cancelExternalStream()
        cancelAllActiveStreamsLocked()
        let bgSession = BgSpeechStreamSession(
            streamId: streamId,
            recognizer: recognizer,
            queue: asrQueue
        ) { [weak self] update in
            self?.sendWatchAsrResult(update)
        }
        bgSession.start()
        activeStreams[streamId] = StreamBufferState(
            backend: .appleSpeech(bgSession),
            nextExpectedSeq: 0,
            reordered: [:],
            isStarted: true
        )
        return .success(())
    }

    private func startStreamBackendLocked(
        streamId: String,
        language: String?
    ) -> Result<Void, WatchAsrError> {
        guard !streamId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .failure(.invalidStreamId)
        }
        if Self.isAppBackgrounded() {
            return startBackgroundSpeechStreamLocked(streamId: streamId, language: language)
        }
        prewarmSpeechAuthorizationIfNeeded()
        let result = WatchAsrBridge.shared.startExternalStream(
            streamId: streamId,
            language: language
        ) { [weak self] update in
            self?.sendWatchAsrResult(update)
        }
        switch result {
        case .success:
            cancelAllActiveStreamsLocked()
            activeStreams[streamId] = StreamBufferState(
                backend: .mlx,
                nextExpectedSeq: 0,
                reordered: [:],
                isStarted: true
            )
            return .success(())
        case .failure(.phoneBackgrounded):
            return startBackgroundSpeechStreamLocked(streamId: streamId, language: language)
        case .failure(let err):
            activeStreams.removeValue(forKey: streamId)
            return .failure(err)
        }
    }

    private func dispatchPcmChunkLocked(
        streamId: String,
        backend: StreamBackend,
        pcm16: Data,
        isFinal: Bool
    ) {
        switch backend {
        case .mlx:
            WatchAsrBridge.shared.appendExternalPcm16(
                streamId: streamId,
                data: pcm16,
                isFinal: isFinal
            )
        case .appleSpeech(let bgSession):
            bgSession.append(pcm16: pcm16, isFinal: isFinal)
        }
    }

    private func startWatchAsrStream(
        streamId: String,
        language: String?,
        replyHandler: (([String: Any]) -> Void)? = nil
    ) {
        asrQueue.async { [weak self] in
            guard let self else {
                replyHandler?(["ok": false, "errorCode": "bridge_unavailable", "error": "Watch bridge unavailable"])
                return
            }
            let result = self.startStreamBackendLocked(streamId: streamId, language: language)
            switch result {
            case .success:
                replyHandler?(["ok": true, "streamId": streamId])
            case .failure(let err):
                self.activeStreams.removeValue(forKey: streamId)
                let errorPayload: [String: Any] = [
                    "ok": false,
                    "streamId": streamId,
                    "errorCode": err.code,
                    "error": err.message
                ]
                replyHandler?(errorPayload)
                if replyHandler == nil {
                    self.sendWatchAsrResult(WatchAsrUpdate(
                        streamId: streamId,
                        text: "",
                        isFinal: true,
                        errorCode: err.code,
                        errorMessage: err.message
                    ))
                }
            }
        }
    }

    private func stopWatchAsrStream(streamId: String, cancel: Bool) {
        asrQueue.async { [weak self] in
            guard let self else { return }
            let removed = self.activeStreams.removeValue(forKey: streamId)
            if case .appleSpeech(let bgSession) = removed?.backend {
                if cancel {
                    bgSession.cancel()
                } else {
                    bgSession.finish()
                }
                return
            }
            if cancel {
                WatchAsrBridge.shared.cancelExternalStream(streamId: streamId)
            } else {
                WatchAsrBridge.shared.appendExternalPcm16(streamId: streamId, data: Data(), isFinal: true)
            }
        }
    }

    static func parseWatchAudioPacket(_ data: Data) -> (streamId: String, seq: UInt32, isFinal: Bool, pcm16: Data)? {
        guard data.count >= packetHeaderSize else { return nil }
        for idx in 0..<packetMagic.count {
            if data[idx] != packetMagic[idx] { return nil }
        }
        let uuidBytes = data.subdata(in: 4..<20)
        let uuid = uuidBytes.withUnsafeBytes { ptr -> uuid_t in
            var value: uuid_t = (0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0)
            if let base = ptr.baseAddress {
                memcpy(&value, base, 16)
            }
            return value
        }
        let streamId = UUID(uuid: uuid).uuidString
        let seq = (UInt32(data[20]) << 24)
            | (UInt32(data[21]) << 16)
            | (UInt32(data[22]) << 8)
            | UInt32(data[23])
        let flags = data[24]
        let isFinal = (flags & 0x01) != 0
        let pcm16 = data.subdata(in: packetHeaderSize..<data.count)
        return (streamId, seq, isFinal, pcm16)
    }

    private func handleWatchAudioPacket(_ data: Data) {
        guard let parsed = Self.parseWatchAudioPacket(data) else {
            logger.error("Ignored malformed Watch ASR audio packet (\(data.count) bytes)")
            return
        }
        asrQueue.async { [weak self] in
            guard let self else { return }
            if self.activeStreams[parsed.streamId] == nil {
                // If packets raced ahead of watchAsrStart, initialize stream state lazily.
                let startResult = self.startStreamBackendLocked(streamId: parsed.streamId, language: nil)
                if case .failure(let err) = startResult {
                    self.sendWatchAsrResult(WatchAsrUpdate(
                        streamId: parsed.streamId,
                        text: "",
                        isFinal: true,
                        errorCode: err.code,
                        errorMessage: err.message
                    ))
                    return
                }
            }

            guard var state = self.activeStreams[parsed.streamId] else { return }
            if parsed.seq < state.nextExpectedSeq {
                return
            }
            state.reordered[parsed.seq] = (parsed.isFinal, parsed.pcm16)
            while let nextChunk = state.reordered.removeValue(forKey: state.nextExpectedSeq) {
                state.nextExpectedSeq &+= 1
                self.dispatchPcmChunkLocked(
                    streamId: parsed.streamId,
                    backend: state.backend,
                    pcm16: nextChunk.pcm16,
                    isFinal: nextChunk.isFinal
                )
                if nextChunk.isFinal {
                    self.activeStreams.removeValue(forKey: parsed.streamId)
                    return
                }
            }
            // Prevent unbounded buffering if an intermediate seq packet was dropped.
            if state.reordered.count > 16, let minSeq = state.reordered.keys.min() {
                state.nextExpectedSeq = minSeq
                while let nextChunk = state.reordered.removeValue(forKey: state.nextExpectedSeq) {
                    state.nextExpectedSeq &+= 1
                    self.dispatchPcmChunkLocked(
                        streamId: parsed.streamId,
                        backend: state.backend,
                        pcm16: nextChunk.pcm16,
                        isFinal: nextChunk.isFinal
                    )
                    if nextChunk.isFinal {
                        self.activeStreams.removeValue(forKey: parsed.streamId)
                        return
                    }
                }
            }
            self.activeStreams[parsed.streamId] = state
        }
    }

    private func sendWatchAsrResult(_ update: WatchAsrUpdate) {
        guard WCSession.isSupported(),
              session.activationState == .activated,
              session.isPaired,
              session.isWatchAppInstalled else {
            return
        }
        var payload: [String: Any] = [
            "action": "watchAsrResult",
            "streamId": update.streamId,
            "text": update.text,
            "isFinal": update.isFinal
        ]
        if let errorCode = update.errorCode {
            payload["errorCode"] = errorCode
        }
        if let errorMessage = update.errorMessage {
            payload["error"] = errorMessage
        }

        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil, errorHandler: { [weak self] _ in
                if update.isFinal {
                    self?.session.transferUserInfo(payload)
                }
            })
        } else if update.isFinal {
            session.transferUserInfo(payload)
        }
    }

    private func sendWatchAsrStatus(streamId: String, status: String) {
        guard WCSession.isSupported(),
              session.activationState == .activated,
              session.isPaired,
              session.isWatchAppInstalled,
              session.isReachable else {
            return
        }
        session.sendMessage([
            "action": "watchAsrStatus",
            "streamId": streamId,
            "status": status
        ], replyHandler: nil, errorHandler: nil)
    }

    private func transcribeAudioFileInBackground(_ item: PendingAudioFile) -> Bool {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized,
              let recognizer = Self.makeSpeechRecognizer(language: item.language),
              recognizer.isAvailable else {
            return false
        }

        let finishLock = NSLock()
        var completed = false
        var bgTaskId: UIBackgroundTaskIdentifier = .invalid
        let endBgTask = {
            finishLock.lock()
            let id = bgTaskId
            bgTaskId = .invalid
            finishLock.unlock()
            guard id != .invalid else { return }
            DispatchQueue.main.async {
                UIApplication.shared.endBackgroundTask(id)
            }
        }

        let completeFileTask: (WatchAsrUpdate) -> Void = { [weak self] update in
            finishLock.lock()
            if completed {
                finishLock.unlock()
                return
            }
            completed = true
            finishLock.unlock()

            try? FileManager.default.removeItem(at: item.fileURL)
            self?.asrQueue.async {
                self?.activeBgFileTasks.removeValue(forKey: item.streamId)
            }
            self?.sendWatchAsrResult(update)
            endBgTask()
        }

        bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "IMCodesWatchBgAsrFile") { [weak self] in
            self?.asrQueue.async {
                self?.activeBgFileTasks[item.streamId]?.cancel()
            }
            completeFileTask(WatchAsrUpdate(
                streamId: item.streamId,
                text: "",
                isFinal: true,
                errorCode: "background_task_expired",
                errorMessage: "Background speech recognition expired"
            ))
        }

        let request = SFSpeechURLRecognitionRequest(url: item.fileURL)
        request.shouldReportPartialResults = false
        request.requiresOnDeviceRecognition = false

        var latestText = ""
        let task = recognizer.recognitionTask(with: request) { result, error in
            if let result {
                let text = result.bestTranscription.formattedString
                if !text.isEmpty {
                    finishLock.lock()
                    latestText = text
                    finishLock.unlock()
                }
                if result.isFinal {
                    completeFileTask(WatchAsrUpdate(streamId: item.streamId, text: text, isFinal: true))
                    return
                }
            }
            if let error {
                finishLock.lock()
                let capturedText = latestText
                finishLock.unlock()
                if !capturedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || BgSpeechStreamSession.isBenignSpeechError(error) {
                    completeFileTask(WatchAsrUpdate(streamId: item.streamId, text: capturedText, isFinal: true))
                } else {
                    completeFileTask(WatchAsrUpdate(
                        streamId: item.streamId,
                        text: "",
                        isFinal: true,
                        errorCode: "speech_recognition_failed",
                        errorMessage: error.localizedDescription
                    ))
                }
            }
        }
        asrQueue.async { [weak self] in
            self?.activeBgFileTasks[item.streamId] = task
        }
        return true
    }

    private func enqueueBackgroundPendingFile(_ item: PendingAudioFile) {
        if !WatchAsrBridge.shared.isModelAvailable {
            try? FileManager.default.removeItem(at: item.fileURL)
            sendWatchAsrResult(WatchAsrUpdate(
                streamId: item.streamId,
                text: "",
                isFinal: true,
                errorCode: WatchAsrError.modelNotReady.code,
                errorMessage: WatchAsrError.modelNotReady.message
            ))
            return
        }
        asrQueue.async {
            self.pendingAudioFiles.removeAll { $0.streamId == item.streamId }
            self.pendingAudioFiles.append(item)
        }
        sendWatchAsrStatus(streamId: item.streamId, status: "queued_background")
    }

    private func processPendingOrImmediateAudioFile(_ item: PendingAudioFile) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if UIApplication.shared.applicationState == .background {
                if self.transcribeAudioFileInBackground(item) {
                    return
                }
                self.enqueueBackgroundPendingFile(item)
                return
            }

            if !WatchAsrBridge.shared.isModelAvailable {
                try? FileManager.default.removeItem(at: item.fileURL)
                self.sendWatchAsrResult(WatchAsrUpdate(
                    streamId: item.streamId,
                    text: "",
                    isFinal: true,
                    errorCode: WatchAsrError.modelNotReady.code,
                    errorMessage: WatchAsrError.modelNotReady.message
                ))
                return
            }

            WatchAsrBridge.shared.transcribeExternalFile(
                streamId: item.streamId,
                fileURL: item.fileURL,
                language: item.language
            ) { [weak self] update in
                guard let self else { return }
                if update.errorCode == WatchAsrError.phoneBackgrounded.code {
                    DispatchQueue.main.async {
                        if self.transcribeAudioFileInBackground(item) {
                            return
                        }
                        self.enqueueBackgroundPendingFile(item)
                    }
                    return
                }
                try? FileManager.default.removeItem(at: item.fileURL)
                self.sendWatchAsrResult(update)
            }
        }
    }

    private func drainPendingAudioFiles() {
        asrQueue.async { [weak self] in
            guard let self, !self.pendingAudioFiles.isEmpty else { return }
            let items = self.pendingAudioFiles
            self.pendingAudioFiles.removeAll()
            for item in items {
                self.processPendingOrImmediateAudioFile(item)
            }
        }
    }

    private func replyAndHandle(_ message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        if let action = message["action"] as? String, action == "watchAsrStart" {
            let streamId = (message["streamId"] as? String) ?? ""
            let language = message["language"] as? String
            startWatchAsrStream(streamId: streamId, language: language, replyHandler: replyHandler)
            return
        }

        replyHandler(["ok": true])

        DispatchQueue.main.async { [weak self] in
            self?.handleWatchMessage(message)
        }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
        replyAndHandle(message, replyHandler: { _ in })
    }

    func session(_ session: WCSession, didReceiveMessage message: [String : Any], replyHandler: @escaping ([String : Any]) -> Void) {
        replyAndHandle(message, replyHandler: replyHandler)
    }

    func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        handleWatchAudioPacket(messageData)
    }

    func session(_ session: WCSession, didReceiveMessageData messageData: Data, replyHandler: @escaping (Data) -> Void) {
        handleWatchAudioPacket(messageData)
        replyHandler(Data())
    }

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        guard (file.metadata?["action"] as? String) == "watchAsrAudioFile" else {
            return
        }
        let streamId = (file.metadata?["streamId"] as? String) ?? UUID().uuidString
        let language = file.metadata?["language"] as? String
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("watch-asr", isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let copiedURL = tempDir.appendingPathComponent("\(streamId).wav")
        try? FileManager.default.removeItem(at: copiedURL)
        do {
            try FileManager.default.copyItem(at: file.fileURL, to: copiedURL)
        } catch {
            logger.error("Failed to copy Watch ASR audio file: \(error.localizedDescription)")
            sendWatchAsrResult(WatchAsrUpdate(
                streamId: streamId,
                text: "",
                isFinal: true,
                errorCode: "file_copy_failed",
                errorMessage: error.localizedDescription
            ))
            return
        }
        processPendingOrImmediateAudioFile(PendingAudioFile(streamId: streamId, fileURL: copiedURL, language: language))
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        // No-op: bridge activation is intentionally best-effort and idempotent.
    }

    func sessionDidBecomeInactive(_ session: WCSession) {
        // No-op: the app will re-activate on foreground.
    }

    func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate to pick up the active paired watch if it changed.
        activate()
    }
}
