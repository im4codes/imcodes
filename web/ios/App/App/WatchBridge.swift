import UIKit
import WatchConnectivity
import UserNotifications
import StreamingSpeechPlugin
import os.log

private let logger = Logger(subsystem: "com.im.codes", category: "WatchBridge")

extension Notification.Name {
    static let watchCommand = Notification.Name("watchCommand")
}

final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()

    private struct StreamBufferState {
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
    private let asrQueue = DispatchQueue(label: "com.im.codes.watch-bridge.asr", qos: .userInitiated)
    private var activeStreams: [String: StreamBufferState] = [:]
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
            let result = WatchAsrBridge.shared.startExternalStream(
                streamId: streamId,
                language: language
            ) { [weak self] update in
                self?.sendWatchAsrResult(update)
            }
            switch result {
            case .success:
                self.activeStreams.removeAll()
                self.activeStreams[streamId] = StreamBufferState(nextExpectedSeq: 0, reordered: [:], isStarted: true)
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
            self.activeStreams.removeValue(forKey: streamId)
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
                let startResult = WatchAsrBridge.shared.startExternalStream(
                    streamId: parsed.streamId,
                    language: nil
                ) { [weak self] update in
                    self?.sendWatchAsrResult(update)
                }
                switch startResult {
                case .success:
                    self.activeStreams.removeAll()
                    self.activeStreams[parsed.streamId] = StreamBufferState(nextExpectedSeq: 0, reordered: [:], isStarted: true)
                case .failure(let err):
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
                WatchAsrBridge.shared.appendExternalPcm16(
                    streamId: parsed.streamId,
                    data: nextChunk.pcm16,
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
                    WatchAsrBridge.shared.appendExternalPcm16(
                        streamId: parsed.streamId,
                        data: nextChunk.pcm16,
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

    private func processPendingOrImmediateAudioFile(_ item: PendingAudioFile) {
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

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if UIApplication.shared.applicationState == .background {
                self.asrQueue.async {
                    self.pendingAudioFiles.removeAll { $0.streamId == item.streamId }
                    self.pendingAudioFiles.append(item)
                }
                self.sendWatchAsrStatus(streamId: item.streamId, status: "queued_background")
                return
            }

            WatchAsrBridge.shared.transcribeExternalFile(
                streamId: item.streamId,
                fileURL: item.fileURL,
                language: item.language
            ) { [weak self] update in
                if update.errorCode == WatchAsrError.phoneBackgrounded.code {
                    self?.asrQueue.async {
                        self?.pendingAudioFiles.removeAll { $0.streamId == item.streamId }
                        self?.pendingAudioFiles.append(item)
                    }
                    self?.sendWatchAsrStatus(streamId: item.streamId, status: "queued_background")
                    return
                }
                try? FileManager.default.removeItem(at: item.fileURL)
                self?.sendWatchAsrResult(update)
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
