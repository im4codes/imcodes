import AVFoundation
import Foundation

@MainActor
final class WatchTtsPlayer: NSObject, ObservableObject {
    @Published private(set) var playingMessageId: String?
    @Published private(set) var isLoading = false

    private let restClient: WatchRestClient
    private let synthesizer = AVSpeechSynthesizer()
    private var audioPlayer: AVAudioPlayer?
    private var playbackTask: Task<Void, Never>?
    private var currentRunId = UUID()
    private var audioContinuation: CheckedContinuation<Void, Never>?
    private var speechContinuation: CheckedContinuation<Void, Never>?

    init(restClient: WatchRestClient = WatchRestClient()) {
        self.restClient = restClient
        super.init()
        self.synthesizer.delegate = self
    }

    func play(messageId: String, text: String, baseUrl: URL?, apiKey: String?) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            stop()
            return
        }

        stop()

        let chunks = Self.chunkText(trimmed, maxChars: 220)
        guard !chunks.isEmpty else { return }

        let runId = UUID()
        currentRunId = runId
        playingMessageId = messageId
        isLoading = true

        playbackTask = Task { [weak self] in
            guard let self else { return }
            await self.runPlayback(
                runId: runId,
                chunks: chunks,
                baseUrl: baseUrl,
                apiKey: apiKey
            )
        }
    }

    func stop() {
        currentRunId = UUID()
        playbackTask?.cancel()
        playbackTask = nil

        audioPlayer?.stop()
        audioPlayer?.delegate = nil
        audioPlayer = nil

        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }

        resumeAudioContinuation()
        resumeSpeechContinuation()

        playingMessageId = nil
        isLoading = false
        deactivateAudioSession()
    }

    // MARK: - Playback Pipeline

    private func runPlayback(
        runId: UUID,
        chunks: [String],
        baseUrl: URL?,
        apiKey: String?
    ) async {
        let lang = Self.detectLanguage(chunks.joined(separator: " "))
        var useServerTts = await shouldAttemptServerTts(baseUrl: baseUrl, apiKey: apiKey)
        guard isRunActive(runId) else { return }

        var prefetchedNext: Task<WatchRestClient.WatchTtsAudioResponse?, Never>?

        for index in chunks.indices {
            guard isRunActive(runId) else { break }
            let chunk = chunks[index]

            if useServerTts, let baseUrl, let apiKey, !apiKey.isEmpty {
                let currentFetch: Task<WatchRestClient.WatchTtsAudioResponse?, Never>
                if let pending = prefetchedNext {
                    currentFetch = pending
                    prefetchedNext = nil
                } else {
                    currentFetch = prefetchChunkTask(baseUrl: baseUrl, apiKey: apiKey, input: chunk, lang: lang)
                }

                if index + 1 < chunks.count {
                    let nextChunk = chunks[index + 1]
                    prefetchedNext = prefetchChunkTask(baseUrl: baseUrl, apiKey: apiKey, input: nextChunk, lang: lang)
                }

                if let audio = await currentFetch.value {
                    guard isRunActive(runId) else {
                        prefetchedNext?.cancel()
                        return
                    }
                    let played = await playAudioData(audio, runId: runId)
                    if played {
                        continue
                    }
                }

                // Server TTS returned an error / unusable audio — cancel pending prefetch and fall back locally.
                prefetchedNext?.cancel()
                prefetchedNext = nil
                useServerTts = false
            }

            guard isRunActive(runId) else { break }
            await speakLocally(chunk, language: lang, runId: runId)
        }

        prefetchedNext?.cancel()
        if isRunActive(runId) {
            playingMessageId = nil
            isLoading = false
            playbackTask = nil
            deactivateAudioSession()
        }
    }

    private func shouldAttemptServerTts(baseUrl: URL?, apiKey: String?) async -> Bool {
        guard let baseUrl, let apiKey, !apiKey.isEmpty else { return false }
        do {
            let config = try await restClient.fetchTtsConfig(baseUrl: baseUrl, apiKey: apiKey)
            return config.mode == "server"
        } catch {
            // If config probe fails transiently, still try POST /api/tts/speech once before falling back locally.
            return true
        }
    }

    private func prefetchChunkTask(
        baseUrl: URL,
        apiKey: String,
        input: String,
        lang: String
    ) -> Task<WatchRestClient.WatchTtsAudioResponse?, Never> {
        Task { [restClient] in
            do {
                return try await restClient.fetchTtsSpeech(
                    baseUrl: baseUrl,
                    apiKey: apiKey,
                    input: input,
                    lang: lang
                )
            } catch {
                return nil
            }
        }
    }

    private func playAudioData(_ response: WatchRestClient.WatchTtsAudioResponse, runId: UUID) async -> Bool {
        guard isRunActive(runId), !response.data.isEmpty else { return false }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [])
            try session.setActive(true)
        } catch {
            // Best-effort audio session activation; continue attempting playback.
        }

        let player: AVAudioPlayer
        do {
            if let hint = Self.audioFileTypeHint(for: response.contentType),
               let hintedPlayer = try? AVAudioPlayer(data: response.data, fileTypeHint: hint) {
                player = hintedPlayer
            } else {
                player = try AVAudioPlayer(data: response.data)
            }
        } catch {
            return false
        }

        player.delegate = self
        guard player.prepareToPlay() else { return false }

        audioPlayer = player
        isLoading = false
        guard player.play() else {
            audioPlayer?.delegate = nil
            audioPlayer = nil
            return false
        }

        await withCheckedContinuation { continuation in
            audioContinuation = continuation
        }
        return true
    }

    private func speakLocally(_ text: String, language: String, runId: UUID) async {
        guard isRunActive(runId) else { return }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [])
            try session.setActive(true)
        } catch {
            // Best-effort audio session activation.
        }

        isLoading = false
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: language == "zh-CN" ? "zh-CN" : "en-US")
        synthesizer.speak(utterance)

        await withCheckedContinuation { continuation in
            speechContinuation = continuation
        }
    }

    private func isRunActive(_ runId: UUID) -> Bool {
        !Task.isCancelled && currentRunId == runId
    }

    private func resumeAudioContinuation() {
        let pending = audioContinuation
        audioContinuation = nil
        pending?.resume()
    }

    private func resumeSpeechContinuation() {
        let pending = speechContinuation
        speechContinuation = nil
        pending?.resume()
    }

    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    // MARK: - Helpers

    static func chunkText(_ raw: String, maxChars: Int = 220) -> [String] {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        let limit = max(1, maxChars)

        var chunks: [String] = []
        var remaining = trimmed

        while !remaining.isEmpty {
            if remaining.count <= limit {
                let finalPiece = remaining.trimmingCharacters(in: .whitespacesAndNewlines)
                if !finalPiece.isEmpty { chunks.append(finalPiece) }
                break
            }

            let endIndex = remaining.index(remaining.startIndex, offsetBy: limit)
            let window = remaining[..<endIndex]

            let sentenceBreak = lastBreakIndex(in: window, scalars: Set("。！？.!?;\n".unicodeScalars))
            let secondaryBreak = sentenceBreak ?? lastBreakIndex(in: window, scalars: Set(",，、 \t".unicodeScalars))
            let splitIndex = secondaryBreak ?? endIndex

            let piece = remaining[..<splitIndex].trimmingCharacters(in: .whitespacesAndNewlines)
            if !piece.isEmpty {
                chunks.append(piece)
            }
            remaining = String(remaining[splitIndex...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }

        return chunks
    }

    private static func lastBreakIndex(in slice: Substring, scalars: Set<UnicodeScalar>) -> String.Index? {
        var idx = slice.endIndex
        while idx > slice.startIndex {
            let prev = slice.index(before: idx)
            if slice[prev].unicodeScalars.contains(where: { scalars.contains($0) }) {
                return idx
            }
            idx = prev
        }
        return nil
    }

    static func detectLanguage(_ text: String) -> String {
        for scalar in text.unicodeScalars {
            if (0x4E00...0x9FFF).contains(scalar.value)
                || (0x3400...0x4DBF).contains(scalar.value) {
                return "zh-CN"
            }
        }
        return "en"
    }

    static func audioFileTypeHint(for contentType: String) -> String? {
        let normalized = contentType.lowercased()
        if normalized.contains("mpeg") || normalized.contains("mp3") {
            return AVFileType.mp3.rawValue
        }
        if normalized.contains("aac") || normalized.contains("mp4") || normalized.contains("m4a") {
            return AVFileType.m4a.rawValue
        }
        if normalized.contains("wav") {
            return AVFileType.wav.rawValue
        }
        return nil
    }
}

extension WatchTtsPlayer: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            if self.audioPlayer === player {
                self.audioPlayer = nil
            }
            self.resumeAudioContinuation()
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            if self.audioPlayer === player {
                self.audioPlayer = nil
            }
            self.resumeAudioContinuation()
        }
    }
}

extension WatchTtsPlayer: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            self?.resumeSpeechContinuation()
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            self?.resumeSpeechContinuation()
        }
    }
}
