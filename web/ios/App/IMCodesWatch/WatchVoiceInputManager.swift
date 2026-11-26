import AVFoundation
import Foundation
import WatchConnectivity
import WatchKit

private final class WatchAudioCaptureWorker {
    enum Mode {
        case streaming
        case fileFallback
    }

    private static let packetMagic: [UInt8] = [0x57, 0x41, 0x53, 0x31] // "WAS1"
    private static let packetHeaderSize = 28
    private static let sampleRate: Double = 16000
    private static let chunkByteThreshold = 16000 // 0.5s @ 16kHz mono PCM16 (2 bytes/sample)

    let queue = DispatchQueue(label: "com.im.codes.watch.voice", qos: .userInitiated)
    private var audioEngine: AVAudioEngine?
    private var activeStreamId: String?
    private var mode: Mode = .streaming
    private var nextSeq: UInt32 = 0
    private var chunkBuffer = Data()
    private var pendingStartChunks: [Data] = []
    private var startAcked = false
    private var wavFileURL: URL?
    private var wavFileHandle: FileHandle?
    private var wavPcmByteCount: UInt32 = 0

    func start(
        streamId: String,
        initialMode: Mode,
        onStarted: @escaping (Result<Void, Error>) -> Void,
        onPacketSendError: @escaping (String, String) -> Void
    ) {
        queue.async { [weak self] in
            guard let self else { return }
            self.teardownAudioGraphLocked()
            self.cleanupWavLocked(deleteFile: true)
            self.chunkBuffer.removeAll(keepingCapacity: false)
            self.pendingStartChunks.removeAll(keepingCapacity: false)
            self.activeStreamId = streamId
            self.mode = initialMode
            self.nextSeq = 0
            self.startAcked = false
            self.wavPcmByteCount = 0

            if initialMode == .fileFallback {
                guard self.prepareWavFileLocked(streamId: streamId) else {
                    self.activeStreamId = nil
                    onStarted(.failure(NSError(
                        domain: "WatchVoiceInput",
                        code: -3,
                        userInfo: [NSLocalizedDescriptionKey: "Unable to create Watch audio buffer"]
                    )))
                    return
                }
            }

            do {
                let audioSession = AVAudioSession.sharedInstance()
                try audioSession.setCategory(.record, mode: .default)
                try audioSession.setActive(true)

                let engine = AVAudioEngine()
                let inputNode = engine.inputNode
                let inputFormat = inputNode.outputFormat(forBus: 0)
                guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
                    throw NSError(
                        domain: "WatchVoiceInput",
                        code: -1,
                        userInfo: [NSLocalizedDescriptionKey: "Microphone input format unavailable"]
                    )
                }
                guard let targetFormat = AVAudioFormat(
                    commonFormat: .pcmFormatInt16,
                    sampleRate: Self.sampleRate,
                    channels: 1,
                    interleaved: true
                ), let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
                    throw NSError(
                        domain: "WatchVoiceInput",
                        code: -2,
                        userInfo: [NSLocalizedDescriptionKey: "Audio converter unavailable"]
                    )
                }

                inputNode.removeTap(onBus: 0)
                inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
                    self?.handleTapBuffer(
                        buffer,
                        converter: converter,
                        targetFormat: targetFormat,
                        streamId: streamId,
                        onPacketSendError: onPacketSendError
                    )
                }
                engine.prepare()
                try engine.start()
                self.audioEngine = engine
                onStarted(.success(()))
            } catch {
                self.teardownAudioGraphLocked()
                self.cleanupWavLocked(deleteFile: true)
                self.activeStreamId = nil
                onStarted(.failure(error))
            }
        }
    }

    func markStartAcked(
        streamId: String,
        onPacketSendError: @escaping (String, String) -> Void
    ) {
        queue.async { [weak self] in
            guard let self, self.activeStreamId == streamId, self.mode == .streaming else { return }
            self.startAcked = true
            for buffered in self.pendingStartChunks {
                self.sendPacketLocked(streamId: streamId, pcm16: buffered, isFinal: false, onPacketSendError: onPacketSendError)
            }
            self.pendingStartChunks.removeAll(keepingCapacity: false)
        }
    }

    func switchToFileFallback(streamId: String) {
        queue.async { [weak self] in
            guard let self, self.activeStreamId == streamId, self.mode != .fileFallback else { return }
            self.mode = .fileFallback
            guard self.prepareWavFileLocked(streamId: streamId) else { return }
            for buffered in self.pendingStartChunks {
                self.appendWavBytesLocked(buffered)
            }
            self.pendingStartChunks.removeAll(keepingCapacity: false)
        }
    }

    func stop(
        streamId: String,
        onPacketSendError: @escaping (String, String) -> Void,
        completion: @escaping (Mode, URL?) -> Void
    ) {
        queue.async { [weak self] in
            guard let self else {
                completion(.streaming, nil)
                return
            }
            self.teardownAudioGraphLocked()
            guard self.activeStreamId == streamId else {
                completion(self.mode, nil)
                return
            }
            let currentMode = self.mode
            let remaining = self.chunkBuffer
            self.chunkBuffer.removeAll(keepingCapacity: false)
            self.activeStreamId = nil

            if currentMode == .streaming {
                if !self.startAcked {
                    for chunk in self.pendingStartChunks {
                        self.sendPacketLocked(streamId: streamId, pcm16: chunk, isFinal: false, onPacketSendError: onPacketSendError)
                    }
                    self.pendingStartChunks.removeAll(keepingCapacity: false)
                }
                self.sendPacketLocked(streamId: streamId, pcm16: remaining, isFinal: true, onPacketSendError: onPacketSendError)
                completion(.streaming, nil)
            } else {
                if !remaining.isEmpty {
                    self.appendWavBytesLocked(remaining)
                }
                let url = self.finalizeWavFileLocked()
                completion(.fileFallback, url)
            }
        }
    }

    func cancel(streamId: String?, sendRemoteStop: Bool) {
        queue.async { [weak self] in
            guard let self else { return }
            let targetStreamId = streamId ?? self.activeStreamId
            let wasStreaming = (self.mode == .streaming)
            self.teardownAudioGraphLocked()
            self.chunkBuffer.removeAll(keepingCapacity: false)
            self.pendingStartChunks.removeAll(keepingCapacity: false)
            self.cleanupWavLocked(deleteFile: true)
            self.activeStreamId = nil

            if sendRemoteStop, wasStreaming, let targetStreamId, WCSession.default.isReachable {
                WCSession.default.sendMessage([
                    "action": "watchAsrStop",
                    "streamId": targetStreamId,
                    "cancel": true
                ], replyHandler: nil, errorHandler: nil)
            }
        }
    }

    private func handleTapBuffer(
        _ buffer: AVAudioPCMBuffer,
        converter: AVAudioConverter,
        targetFormat: AVAudioFormat,
        streamId: String,
        onPacketSendError: @escaping (String, String) -> Void
    ) {
        let ratio = Self.sampleRate / max(1, buffer.format.sampleRate)
        let outCapacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * ratio) + 32)
        guard let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outCapacity) else { return }

        var supplied = false
        var conversionError: NSError?
        converter.convert(to: converted, error: &conversionError) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard conversionError == nil,
              converted.frameLength > 0,
              let channel = converted.int16ChannelData?[0] else {
            return
        }
        let byteCount = Int(converted.frameLength) * MemoryLayout<Int16>.size
        let pcmData = Data(bytes: channel, count: byteCount)

        queue.async { [weak self] in
            guard let self, self.activeStreamId == streamId, self.audioEngine != nil else { return }
            if self.mode == .fileFallback {
                self.appendWavBytesLocked(pcmData)
                return
            }

            self.chunkBuffer.append(pcmData)
            while self.chunkBuffer.count >= Self.chunkByteThreshold {
                let chunk = self.chunkBuffer.prefix(Self.chunkByteThreshold)
                self.chunkBuffer.removeFirst(Self.chunkByteThreshold)
                if self.startAcked {
                    self.sendPacketLocked(streamId: streamId, pcm16: Data(chunk), isFinal: false, onPacketSendError: onPacketSendError)
                } else {
                    self.pendingStartChunks.append(Data(chunk))
                }
            }
        }
    }

    private func sendPacketLocked(
        streamId: String,
        pcm16: Data,
        isFinal: Bool,
        onPacketSendError: @escaping (String, String) -> Void
    ) {
        let seq = nextSeq
        nextSeq &+= 1
        guard let packet = Self.encodePacket(streamId: streamId, seq: seq, isFinal: isFinal, pcm16: pcm16) else {
            return
        }
        WCSession.default.sendMessageData(packet, replyHandler: nil, errorHandler: { error in
            if !isFinal {
                onPacketSendError(streamId, error.localizedDescription)
            }
        })
    }

    static func encodePacket(streamId: String, seq: UInt32, isFinal: Bool, pcm16: Data) -> Data? {
        guard let uuid = UUID(uuidString: streamId) else { return nil }
        var data = Data(capacity: packetHeaderSize + pcm16.count)
        data.append(contentsOf: packetMagic)
        var rawUUID = uuid.uuid
        withUnsafeBytes(of: &rawUUID) { ptr in
            data.append(contentsOf: ptr)
        }
        data.append(UInt8((seq >> 24) & 0xff))
        data.append(UInt8((seq >> 16) & 0xff))
        data.append(UInt8((seq >> 8) & 0xff))
        data.append(UInt8(seq & 0xff))
        data.append(isFinal ? 0x01 : 0x00)
        data.append(contentsOf: [0x00, 0x00, 0x00])
        data.append(pcm16)
        return data
    }

    private func teardownAudioGraphLocked() {
        if let engine = audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            if engine.isRunning {
                engine.stop()
            }
            audioEngine = nil
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func prepareWavFileLocked(streamId: String) -> Bool {
        cleanupWavLocked(deleteFile: true)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("watch-asr-\(streamId).wav")
        FileManager.default.createFile(atPath: url.path, contents: Data(repeating: 0, count: 44))
        guard let handle = try? FileHandle(forUpdating: url) else {
            try? FileManager.default.removeItem(at: url)
            return false
        }
        _ = try? handle.seekToEnd()
        wavFileURL = url
        wavFileHandle = handle
        wavPcmByteCount = 0
        return true
    }

    private func appendWavBytesLocked(_ data: Data) {
        guard let handle = wavFileHandle, !data.isEmpty else { return }
        handle.write(data)
        wavPcmByteCount &+= UInt32(data.count)
    }

    private func finalizeWavFileLocked() -> URL? {
        guard let handle = wavFileHandle, let url = wavFileURL else { return nil }
        let header = Self.makeWavHeader(pcmDataSize: wavPcmByteCount, sampleRate: 16000, channels: 1, bitsPerSample: 16)
        try? handle.seek(toOffset: 0)
        handle.write(header)
        try? handle.close()
        wavFileHandle = nil
        wavFileURL = nil
        return url
    }

    private func cleanupWavLocked(deleteFile: Bool) {
        if let handle = wavFileHandle {
            try? handle.close()
            wavFileHandle = nil
        }
        if deleteFile, let url = wavFileURL {
            try? FileManager.default.removeItem(at: url)
        }
        wavFileURL = nil
    }

    static func makeWavHeader(pcmDataSize: UInt32, sampleRate: UInt32, channels: UInt16, bitsPerSample: UInt16) -> Data {
        var header = Data(capacity: 44)
        func appendUInt32(_ v: UInt32) {
            var le = v.littleEndian
            withUnsafeBytes(of: &le) { header.append(contentsOf: $0) }
        }
        func appendUInt16(_ v: UInt16) {
            var le = v.littleEndian
            withUnsafeBytes(of: &le) { header.append(contentsOf: $0) }
        }
        let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)
        header.append(contentsOf: "RIFF".utf8)
        appendUInt32(36 &+ pcmDataSize)
        header.append(contentsOf: "WAVE".utf8)
        header.append(contentsOf: "fmt ".utf8)
        appendUInt32(16)
        appendUInt16(1)
        appendUInt16(channels)
        appendUInt32(sampleRate)
        appendUInt32(byteRate)
        appendUInt16(blockAlign)
        appendUInt16(bitsPerSample)
        header.append(contentsOf: "data".utf8)
        appendUInt32(pcmDataSize)
        return header
    }
}

@MainActor
final class WatchVoiceInputManager: NSObject, ObservableObject {
    static let shared = WatchVoiceInputManager()

    enum State: Equatable {
        case idle
        case starting
        case streaming
        case recordingFile
        case transcribing
    }

    struct TranscriptUpdate: Equatable {
        let streamId: String
        let text: String
        let isFinal: Bool
        let version: UInt64
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var liveTranscript: String = ""
    @Published private(set) var transcriptUpdate: TranscriptUpdate?
    @Published private(set) var statusMessage: String?
    @Published private(set) var errorMessage: String?
    @Published private(set) var activeStreamId: String?

    private let captureWorker = WatchAudioCaptureWorker()
    private var captureStreamId: String?
    private var pendingFileStreamIds: Set<String> = []
    private var transcribingTimeoutWorkItem: DispatchWorkItem?
    private var updateVersion: UInt64 = 0

    private override init() {
        super.init()
    }

    var isRecording: Bool {
        state == .starting || state == .streaming || state == .recordingFile
    }

    func toggleRecording() {
        if isRecording {
            stopRecording()
        } else if state == .idle {
            startRecording()
        }
    }

    func startRecording() {
        guard state == .idle else { return }
        guard WCSession.isSupported() else {
            errorMessage = "WatchConnectivity unsupported"
            return
        }

        errorMessage = nil
        statusMessage = nil
        liveTranscript = ""
        state = .starting

        let session = AVAudioSession.sharedInstance()
        switch session.recordPermission {
        case .granted:
            beginAudioCapture()
        case .denied:
            state = .idle
            errorMessage = "Microphone permission denied"
        case .undetermined:
            session.requestRecordPermission { [weak self] granted in
                Task { @MainActor in
                    guard let self, self.state == .starting else { return }
                    if granted {
                        self.beginAudioCapture()
                    } else {
                        self.state = .idle
                        self.errorMessage = "Microphone permission denied"
                    }
                }
            }
        @unknown default:
            state = .idle
            errorMessage = "Microphone permission unavailable"
        }
    }

    func stopRecording() {
        guard isRecording else { return }
        if state == .starting {
            cancelIfRecording()
            return
        }
        guard let streamId = captureStreamId else {
            cancelIfRecording()
            return
        }
        captureWorker.stop(
            streamId: streamId,
            onPacketSendError: { [weak self] failedStreamId, message in
                Task { @MainActor in
                    guard let self, self.captureStreamId == failedStreamId, self.errorMessage == nil else { return }
                    self.errorMessage = message
                }
            },
            completion: { [weak self] mode, finalizedURL in
                Task { @MainActor in
                    guard let self, self.captureStreamId == streamId else {
                        if let finalizedURL {
                            try? FileManager.default.removeItem(at: finalizedURL)
                        }
                        return
                    }
                    if mode == .streaming {
                        self.state = .transcribing
                        self.statusMessage = "Transcribing…"
                        self.scheduleTranscribingTimeout(for: streamId)
                        WKInterfaceDevice.current().play(.stop)
                    } else {
                        if let finalizedURL {
                            self.pendingFileStreamIds.insert(streamId)
                            let session = WCSession.default
                            if session.activationState == .activated {
                                session.transferFile(finalizedURL, metadata: [
                                    "action": "watchAsrAudioFile",
                                    "streamId": streamId,
                                    "sampleRate": 16000,
                                    "channels": 1
                                ])
                                self.state = .idle
                                self.activeStreamId = nil
                                self.captureStreamId = nil
                                self.statusMessage = "Sent to iPhone for transcription…"
                            } else {
                                try? FileManager.default.removeItem(at: finalizedURL)
                                self.pendingFileStreamIds.remove(streamId)
                                self.state = .idle
                                self.activeStreamId = nil
                                self.captureStreamId = nil
                                self.errorMessage = "iPhone session not ready"
                            }
                        } else {
                            self.state = .idle
                            self.activeStreamId = nil
                            self.captureStreamId = nil
                            self.errorMessage = "Failed to save Watch audio recording"
                        }
                        WKInterfaceDevice.current().play(.stop)
                    }
                }
            }
        )
    }

    func cancelIfRecording() {
        guard isRecording || state == .transcribing else { return }
        cancelTranscribingTimeout()
        let streamId = captureStreamId
        let wasRecording = isRecording
        activeStreamId = nil
        captureStreamId = nil
        state = .idle
        statusMessage = nil
        captureWorker.cancel(streamId: streamId, sendRemoteStop: wasRecording)
    }

    func handleWatchAsrResult(_ message: [String: Any]) {
        guard let streamId = message["streamId"] as? String else { return }
        let isExpected = (streamId == activeStreamId) || pendingFileStreamIds.contains(streamId)
        guard isExpected else { return }

        let text = (message["text"] as? String) ?? ""
        let isFinal = (message["isFinal"] as? Bool) ?? false
        let errorText = message["error"] as? String

        if let errorText, !errorText.isEmpty {
            cancelTranscribingTimeout()
            pendingFileStreamIds.remove(streamId)
            if streamId == activeStreamId {
                activeStreamId = nil
                captureStreamId = nil
                if isRecording {
                    captureWorker.cancel(streamId: streamId, sendRemoteStop: false)
                }
                state = .idle
            }
            statusMessage = nil
            errorMessage = errorText
            WKInterfaceDevice.current().play(.failure)
            return
        }

        errorMessage = nil
        liveTranscript = text
        updateVersion &+= 1
        transcriptUpdate = TranscriptUpdate(
            streamId: streamId,
            text: text,
            isFinal: isFinal,
            version: updateVersion
        )

        if isFinal {
            cancelTranscribingTimeout()
            pendingFileStreamIds.remove(streamId)
            if streamId == activeStreamId {
                activeStreamId = nil
                captureStreamId = nil
                state = .idle
            }
            statusMessage = nil
            WKInterfaceDevice.current().play(.success)
        }
    }

    func handleWatchAsrStatus(_ message: [String: Any]) {
        guard let streamId = message["streamId"] as? String,
              (streamId == activeStreamId || pendingFileStreamIds.contains(streamId)),
              let status = message["status"] as? String else {
            return
        }
        if status == "queued_background" {
            statusMessage = "Queued — open IM.codes on iPhone to transcribe"
        }
    }

    func handleFileTransferCompleted(metadata: [String: Any]?, fileURL: URL, error: Error?) {
        try? FileManager.default.removeItem(at: fileURL)
        guard (metadata?["action"] as? String) == "watchAsrAudioFile",
              let streamId = metadata?["streamId"] as? String else {
            return
        }
        if let error {
            pendingFileStreamIds.remove(streamId)
            statusMessage = nil
            errorMessage = "Audio transfer failed: \(error.localizedDescription)"
            WKInterfaceDevice.current().play(.failure)
        }
    }

    // MARK: - Private Audio Setup & Streaming

    private func beginAudioCapture() {
        let streamId = UUID().uuidString
        let wcSession = WCSession.default
        let canStreamLive = wcSession.activationState == .activated && wcSession.isReachable
        let initialMode: WatchAudioCaptureWorker.Mode = canStreamLive ? .streaming : .fileFallback

        captureStreamId = streamId
        activeStreamId = streamId
        statusMessage = initialMode == .streaming ? "Listening…" : "Recording offline…"

        captureWorker.start(
            streamId: streamId,
            initialMode: initialMode,
            onStarted: { [weak self] result in
                Task { @MainActor in
                    guard let self, self.captureStreamId == streamId else { return }
                    switch result {
                    case .success:
                        self.state = initialMode == .streaming ? .streaming : .recordingFile
                        WKInterfaceDevice.current().play(.start)
                        if initialMode == .streaming {
                            self.sendWatchAsrStart(streamId: streamId)
                        }
                    case .failure(let error):
                        self.state = .idle
                        self.activeStreamId = nil
                        self.captureStreamId = nil
                        self.statusMessage = nil
                        self.errorMessage = error.localizedDescription
                        WKInterfaceDevice.current().play(.failure)
                    }
                }
            },
            onPacketSendError: { [weak self] failedStreamId, message in
                Task { @MainActor in
                    guard let self, self.captureStreamId == failedStreamId, self.errorMessage == nil else { return }
                    self.errorMessage = message
                }
            }
        )
    }

    private func sendWatchAsrStart(streamId: String) {
        WCSession.default.sendMessage([
            "action": "watchAsrStart",
            "streamId": streamId
        ], replyHandler: { [weak self] reply in
            Task { @MainActor in
                guard let self, self.captureStreamId == streamId else { return }
                let ok = (reply["ok"] as? Bool) ?? false
                if ok {
                    self.captureWorker.markStartAcked(streamId: streamId) { [weak self] failedStreamId, message in
                        Task { @MainActor in
                            guard let self, self.captureStreamId == failedStreamId, self.errorMessage == nil else { return }
                            self.errorMessage = message
                        }
                    }
                    return
                }

                let code = (reply["errorCode"] as? String) ?? ""
                let msg = (reply["error"] as? String) ?? "iPhone speech recognition unavailable"
                if code == "phone_backgrounded" {
                    self.switchToFileFallback(streamId: streamId, status: "iPhone in background — saving audio…")
                } else {
                    self.errorMessage = msg
                    self.abortCaptureOnPhoneError(streamId: streamId)
                }
            }
        }, errorHandler: { [weak self] _ in
            Task { @MainActor in
                guard let self, self.captureStreamId == streamId, self.isRecording else { return }
                self.switchToFileFallback(streamId: streamId, status: "iPhone unreachable — recording offline…")
            }
        })
    }

    private func switchToFileFallback(streamId: String, status: String) {
        guard captureStreamId == streamId, isRecording else { return }
        if state == .streaming {
            state = .recordingFile
        }
        statusMessage = status
        captureWorker.switchToFileFallback(streamId: streamId)
    }

    private func abortCaptureOnPhoneError(streamId: String) {
        guard captureStreamId == streamId else { return }
        cancelTranscribingTimeout()
        activeStreamId = nil
        captureStreamId = nil
        state = .idle
        statusMessage = nil
        WKInterfaceDevice.current().play(.failure)
        captureWorker.cancel(streamId: streamId, sendRemoteStop: false)
    }

    private func scheduleTranscribingTimeout(for streamId: String) {
        cancelTranscribingTimeout()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.activeStreamId == streamId, self.state == .transcribing else { return }
            self.activeStreamId = nil
            self.captureStreamId = nil
            self.state = .idle
            self.statusMessage = nil
            self.errorMessage = "Timed out waiting for iPhone transcription"
        }
        transcribingTimeoutWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
    }

    private func cancelTranscribingTimeout() {
        transcribingTimeoutWorkItem?.cancel()
        transcribingTimeoutWorkItem = nil
    }
}
