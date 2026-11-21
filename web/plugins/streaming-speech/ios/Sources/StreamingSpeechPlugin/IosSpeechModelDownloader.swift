import CryptoKit
import Foundation

public struct IosSpeechModelAsset: Equatable {
    public let filename: String
    public let expectedSize: Int64
    public let expectedSha256: String
    public let downloadable: Bool

    public init(filename: String, expectedSize: Int64, expectedSha256: String, downloadable: Bool = true) {
        self.filename = filename
        self.expectedSize = expectedSize
        self.expectedSha256 = expectedSha256
        self.downloadable = downloadable
    }
}

public enum IosSpeechDownloadStatus: Equatable {
    case idle
    case downloading(progress: Double)
    case ready
    case failed(String)

    public var isDownloading: Bool {
        if case .downloading = self { return true }
        return false
    }

    public var progress: Double {
        switch self {
        case .idle:
            return 0
        case .downloading(let progress):
            return progress
        case .ready:
            return 1
        case .failed:
            return 0
        }
    }
}

/// Downloads and SHA-256 verifies Qwen3-ASR-0.6B-MLX-4bit weights into Application Support
/// using a background URLSession with automatic HuggingFace / hf-mirror fallback.
public final class IosSpeechModelDownloader: NSObject, URLSessionDownloadDelegate {
    public static let backgroundSessionIdentifier = "com.im.codes.qwen3asr-model-download"
    public static let repoId = "aufklarer/Qwen3-ASR-0.6B-MLX-4bit"
    public static let revision = "bc441bd1e4295c1f42d9879f056049a925b6e013"
    public static let modelDirectoryRelativePath = "imcodes-speech-models/Qwen3-ASR-0.6B-MLX-4bit"
    public static let defaultMirrorOrigins = ["https://huggingface.co", "https://hf-mirror.com"]
    public static let chinaMirrorOrigins = ["https://hf-mirror.com", "https://huggingface.co"]
    public static let customMirrorEnvKey = "IMCODES_SPEECH_MODEL_MIRRORS"
    public static let customMirrorDefaultsKey = "imcodes.speech.modelMirrors"
    private static let chinaTimeZoneIdentifiers: Set<String> = [
        "Asia/Shanghai",
        "Asia/Chongqing",
        "Asia/Harbin",
        "Asia/Urumqi",
        "Asia/Kashgar",
    ]
    public static let emptyFileSha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    public static let verifiedMarkerFilename = ".verified-\(revision)"

    public static let requiredAssets: [IosSpeechModelAsset] = [
        IosSpeechModelAsset(
            filename: "config.json",
            expectedSize: 7187,
            expectedSha256: "923618cf5ca452fda0253a6be5c1a17f94a2e4851d3b98beb45848565587bd72"
        ),
        IosSpeechModelAsset(
            filename: "merges.txt",
            expectedSize: 1_671_853,
            expectedSha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5"
        ),
        IosSpeechModelAsset(
            filename: "model.safetensors",
            expectedSize: 708_236_945,
            expectedSha256: "70c7e67e588062adce4f10796e47ad42ead51c6671eda61a0987eae38ca95ddf"
        ),
        IosSpeechModelAsset(
            filename: "model.safetensors.index.json",
            expectedSize: 71814,
            expectedSha256: "e3bb80ef0fd42a5be07b04e90c97d60460bbde8af3531e0bfe9100a61404d81a"
        ),
        IosSpeechModelAsset(
            filename: "tokenizer_config.json",
            expectedSize: 12487,
            expectedSha256: "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c"
        ),
        IosSpeechModelAsset(
            filename: "vocab.json",
            expectedSize: 2_776_833,
            expectedSha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910"
        ),
        IosSpeechModelAsset(
            filename: "hotwords.txt",
            expectedSize: 0,
            expectedSha256: emptyFileSha256,
            downloadable: false
        ),
    ]

    public enum DownloadError: Error, LocalizedError, Equatable {
        case invalidURL(String)
        case httpStatus(Int)
        case checksumMismatch(String)
        case fileMoveFailed(String)
        case missingOutput(String)

        public var errorDescription: String? {
            switch self {
            case .invalidURL(let raw): return "Invalid model asset URL: \(raw)"
            case .httpStatus(let code): return "Model download HTTP error \(code)"
            case .checksumMismatch(let name): return "Model verification failed for \(name)"
            case .fileMoveFailed(let name): return "Could not store downloaded model file \(name)"
            case .missingOutput(let name): return "Downloaded file missing for \(name)"
            }
        }
    }

    private struct ActiveTaskState {
        let asset: IosSpeechModelAsset
        let destURL: URL
        let partURL: URL
        let baseCompletedBytes: Int64
        let totalDownloadBytes: Int64
        let completion: (Result<Void, Error>) -> Void
        var finishError: Error?
    }

    private struct FileFingerprint: Equatable {
        let size: Int64
        let modificationDate: Date?
    }

    public typealias FileVerifier = @Sendable (URL, IosSpeechModelAsset) -> Bool

    public static let shared = IosSpeechModelDownloader()

    public let modelsDirectory: URL
    public let mirrorOrigins: [String]
    public let assets: [IosSpeechModelAsset]

    private var fileManager: FileManager { .default }
    private let workQueue = DispatchQueue(label: "com.im.codes.speech-model-downloader", qos: .utility)
    private let lock = NSLock()
    private let customSessionConfiguration: URLSessionConfiguration?
    private let sessionIdentifier: String?
    private let retryCooldownSeconds: TimeInterval
    private let fileVerifier: FileVerifier

    private lazy var urlSession: URLSession = {
        let config: URLSessionConfiguration
        if let custom = customSessionConfiguration {
            config = custom
        } else if let sessionIdentifier, !sessionIdentifier.isEmpty {
            let bg = URLSessionConfiguration.background(withIdentifier: sessionIdentifier)
            bg.isDiscretionary = false
            bg.timeoutIntervalForRequest = 30
            bg.timeoutIntervalForResource = 60 * 60
            #if os(iOS)
            bg.sessionSendsLaunchEvents = true
            #endif
            config = bg
        } else {
            let def = URLSessionConfiguration.default
            def.timeoutIntervalForRequest = 30
            def.timeoutIntervalForResource = 60 * 60
            config = def
        }
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    private var _status: IosSpeechDownloadStatus = .idle
    private var inFlight = false
    private var lastFailureAt: Date?
    private var preferredMirrorOrder: [Int]
    private var pendingCompletions: [(Bool) -> Void] = []
    private var activeTasks: [Int: ActiveTaskState] = [:]
    private var backgroundSessionCompletionHandler: (() -> Void)?
    private var onReadyHandlers: [() -> Void] = []
    private var _verifiedFingerprints: [String: FileFingerprint] = [:]

    public init(
        modelsDirectory: URL = IosSpeechModelDownloader.defaultModelsDirectory(),
        mirrorOrigins: [String]? = nil,
        assets: [IosSpeechModelAsset] = IosSpeechModelDownloader.requiredAssets,
        sessionIdentifier: String? = IosSpeechModelDownloader.backgroundSessionIdentifier,
        urlSessionConfiguration: URLSessionConfiguration? = nil,
        retryCooldownSeconds: TimeInterval = 60,
        fileVerifier: @escaping FileVerifier = { url, asset in
            IosSpeechModelDownloader.verifyFile(at: url, asset: asset)
        }
    ) {
        self.modelsDirectory = modelsDirectory
        let resolvedMirrors: [String]
        if let explicitMirrors = mirrorOrigins {
            let sanitized = Self.sanitizedMirrorOrigins(explicitMirrors)
            resolvedMirrors = sanitized.isEmpty ? Self.resolvedDefaultMirrorOrigins() : sanitized
        } else {
            resolvedMirrors = Self.resolvedDefaultMirrorOrigins()
        }
        self.mirrorOrigins = resolvedMirrors
        self.preferredMirrorOrder = Array(0..<resolvedMirrors.count)
        self.assets = assets
        self.sessionIdentifier = sessionIdentifier
        self.customSessionConfiguration = urlSessionConfiguration
        self.retryCooldownSeconds = retryCooldownSeconds
        self.fileVerifier = fileVerifier
        super.init()
    }

    public var currentMirrorOrder: [String] {
        lock.lock()
        let order = preferredMirrorOrder
        lock.unlock()
        return order.map { mirrorOrigins[$0] }
    }

    public static func resolvedDefaultMirrorOrigins(
        locale: Locale = .current,
        timeZone: TimeZone = .current,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        userDefaults: UserDefaults = .standard
    ) -> [String] {
        let region = regionIdentifier(for: locale)
        let isChinaRegion = (region == "CN") || chinaTimeZoneIdentifiers.contains(timeZone.identifier)
        let regionDefaults = isChinaRegion ? chinaMirrorOrigins : defaultMirrorOrigins

        var customRaw: [String] = []
        if let envValue = environment[customMirrorEnvKey], !envValue.isEmpty {
            customRaw.append(contentsOf: envValue.split(separator: ",").map(String.init))
        }
        if let defaultsArray = userDefaults.stringArray(forKey: customMirrorDefaultsKey) {
            customRaw.append(contentsOf: defaultsArray)
        } else if let defaultsValue = userDefaults.string(forKey: customMirrorDefaultsKey), !defaultsValue.isEmpty {
            customRaw.append(contentsOf: defaultsValue.split(separator: ",").map(String.init))
        }

        let merged = sanitizedMirrorOrigins(customRaw + regionDefaults)
        return merged.isEmpty ? regionDefaults : merged
    }

    public static func sanitizedMirrorOrigins(_ rawOrigins: [String]) -> [String] {
        var sanitized: [String] = []
        var seen: Set<String> = []
        for raw in rawOrigins {
            let candidate = raw
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard !candidate.isEmpty,
                  let parsed = URL(string: candidate),
                  let scheme = parsed.scheme?.lowercased(),
                  scheme == "https" || scheme == "http",
                  let host = parsed.host,
                  !host.isEmpty else {
                continue
            }
            let dedupeKey = candidate.lowercased()
            guard !seen.contains(dedupeKey) else { continue }
            seen.insert(dedupeKey)
            sanitized.append(candidate)
        }
        return sanitized
    }

    private static func regionIdentifier(for locale: Locale) -> String? {
        if #available(iOS 16.0, macOS 13.0, *) {
            if let identifier = locale.region?.identifier, !identifier.isEmpty {
                return identifier.uppercased()
            }
        }
        if let legacy = (locale as NSLocale).object(forKey: .countryCode) as? String, !legacy.isEmpty {
            return legacy.uppercased()
        }
        return nil
    }

    public static func defaultModelsDirectory(fileManager: FileManager = .default) -> URL {
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        return appSupport.appendingPathComponent(modelDirectoryRelativePath, isDirectory: true)
    }

    public var status: IosSpeechDownloadStatus {
        lock.lock(); defer { lock.unlock() }
        return _status
    }

    /// Non-blocking readiness check backed by in-process worker SHA-256 verification plus
    /// constant-time file metadata (`size` + `modificationDate`) and `.verified-<revision>`.
    /// Never performs SHA-256 hashing on the caller's thread.
    public var hasVerifiedLocalModels: Bool {
        lock.lock()
        let isReady = (_status == .ready)
        let snapshots = _verifiedFingerprints
        lock.unlock()

        guard isReady else { return false }
        let markerURL = modelsDirectory.appendingPathComponent(Self.verifiedMarkerFilename)
        guard fileManager.isReadableFile(atPath: markerURL.path) else {
            invalidateVerifiedState()
            return false
        }
        for asset in assets {
            let url = modelsDirectory.appendingPathComponent(asset.filename)
            guard let expected = snapshots[asset.filename],
                  let current = Self.fileFingerprint(at: url, fileManager: fileManager),
                  current.size == asset.expectedSize,
                  current == expected else {
                invalidateVerifiedState()
                return false
            }
        }
        return true
    }

    /// Full cryptographic SHA-256 + byte-size verification over every file in `modelsDirectory`.
    /// Intended for background worker verification (`workQueue` / `coordinator.worker`), never main thread.
    @discardableResult
    public func verifyAllAssetsOnDisk() -> Bool {
        var snapshots: [String: FileFingerprint] = [:]
        for asset in assets {
            let url = modelsDirectory.appendingPathComponent(asset.filename)
            guard fileVerifier(url, asset),
                  let fp = Self.fileFingerprint(at: url, fileManager: fileManager) else {
                invalidateVerifiedState(removeMarker: true)
                return false
            }
            snapshots[asset.filename] = fp
        }
        lock.lock()
        _verifiedFingerprints = snapshots
        lock.unlock()
        return true
    }

    private func invalidateVerifiedState(removeMarker: Bool = false) {
        lock.lock()
        if _status == .ready {
            _status = .idle
        }
        _verifiedFingerprints.removeAll()
        lock.unlock()
        if removeMarker {
            try? fileManager.removeItem(at: modelsDirectory.appendingPathComponent(Self.verifiedMarkerFilename))
        }
    }

    public func addReadyObserver(_ handler: @escaping () -> Void) {
        lock.lock()
        onReadyHandlers.append(handler)
        lock.unlock()
    }

    public static func handleBackgroundSessionEvents(
        identifier: String,
        completionHandler: @escaping () -> Void
    ) -> Bool {
        guard identifier == backgroundSessionIdentifier else { return false }
        shared.setBackgroundCompletionHandler(completionHandler)
        return true
    }

    private func setBackgroundCompletionHandler(_ handler: @escaping () -> Void) {
        lock.lock()
        backgroundSessionCompletionHandler = handler
        lock.unlock()
        // Touch `urlSession` so Foundation connects delegate callbacks for this identifier.
        _ = urlSession
    }

    /// Ensures models are downloaded and SHA-256 verified asynchronously on `workQueue`.
    /// Never hashes on the caller thread; safe to call on launch or foreground resume, with
    /// concurrent callers sharing one single-flight worker operation.
    public func ensureDownloadedIfNeeded(forceRetry: Bool = false, completion: ((Bool) -> Void)? = nil) {
        if hasVerifiedLocalModels {
            completion?(true)
            return
        }

        lock.lock()
        if inFlight {
            if let completion { pendingCompletions.append(completion) }
            lock.unlock()
            return
        }
        if !forceRetry,
           case .failed = _status,
           let lastFailureAt,
           Date().timeIntervalSince(lastFailureAt) < retryCooldownSeconds {
            lock.unlock()
            completion?(false)
            return
        }
        inFlight = true
        _status = .downloading(progress: 0)
        if let completion { pendingCompletions.append(completion) }
        lock.unlock()

        workQueue.async { [weak self] in
            self?.runDownloadPipeline()
        }
    }

    /// Releases an isolated downloader's URLSession after completion (primarily for tests).
    public func invalidateSession() {
        urlSession.finishTasksAndInvalidate()
    }

    private func runDownloadPipeline() {
        do {
            try prepareDestinationDirectory()
        } catch {
            finishPipeline(success: false, errorMessage: error.localizedDescription)
            return
        }

        removeStalePartFiles()
        var verifiedSnapshots: [String: FileFingerprint] = [:]

        let downloadableAssets = assets.filter(\.downloadable)
        let totalDownloadBytes = max(1, downloadableAssets.reduce(Int64(0)) { $0 + $1.expectedSize })
        var completedBytes: Int64 = 0
        var remaining: [IosSpeechModelAsset] = []

        for asset in downloadableAssets {
            let destURL = modelsDirectory.appendingPathComponent(asset.filename)
            if fileVerifier(destURL, asset),
               let fp = Self.fileFingerprint(at: destURL, fileManager: fileManager) {
                Self.markExcludedFromBackup(destURL)
                verifiedSnapshots[asset.filename] = fp
                completedBytes += asset.expectedSize
            } else {
                // Remove corrupt or truncated file so it is cleanly re-downloaded.
                try? fileManager.removeItem(at: destURL)
                try? fileManager.removeItem(at: modelsDirectory.appendingPathComponent(Self.verifiedMarkerFilename))
                remaining.append(asset)
            }
        }

        updateDownloadingProgress(Double(completedBytes) / Double(totalDownloadBytes))

        for asset in remaining {
            do {
                try downloadAndVerifyAssetWithMirrorFallback(
                    asset,
                    completedBytes: completedBytes,
                    totalDownloadBytes: totalDownloadBytes
                )
                let destURL = modelsDirectory.appendingPathComponent(asset.filename)
                guard let fp = Self.fileFingerprint(at: destURL, fileManager: fileManager),
                      fp.size == asset.expectedSize else {
                    throw DownloadError.missingOutput(asset.filename)
                }
                verifiedSnapshots[asset.filename] = fp
                completedBytes += asset.expectedSize
                updateDownloadingProgress(Double(completedBytes) / Double(totalDownloadBytes))
            } catch {
                try? fileManager.removeItem(at: modelsDirectory.appendingPathComponent(Self.verifiedMarkerFilename))
                finishPipeline(success: false, errorMessage: error.localizedDescription)
                return
            }
        }

        let nonDownloadableSnapshots = ensureNonDownloadableFiles()
        for (name, fp) in nonDownloadableSnapshots {
            verifiedSnapshots[name] = fp
        }
        guard verifiedSnapshots.count == assets.count else {
            finishPipeline(success: false, errorMessage: "Downloaded speech model failed final verification")
            return
        }

        let markerURL = modelsDirectory.appendingPathComponent(Self.verifiedMarkerFilename)
        try? Data(Self.revision.utf8).write(to: markerURL, options: .atomic)
        Self.markExcludedFromBackup(markerURL)
        Self.markExcludedFromBackup(modelsDirectory)
        lock.lock()
        _verifiedFingerprints = verifiedSnapshots
        lock.unlock()
        finishPipeline(success: true, errorMessage: nil)
    }

    private func prepareDestinationDirectory() throws {
        let parent = modelsDirectory.deletingLastPathComponent()
        try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: modelsDirectory, withIntermediateDirectories: true)
        Self.markExcludedFromBackup(parent)
        Self.markExcludedFromBackup(modelsDirectory)
    }

    @discardableResult
    private func ensureNonDownloadableFiles() -> [String: FileFingerprint] {
        var snapshots: [String: FileFingerprint] = [:]
        for asset in assets where !asset.downloadable {
            let destURL = modelsDirectory.appendingPathComponent(asset.filename)
            var isValid = fileVerifier(destURL, asset)
            if !isValid {
                try? Data().write(to: destURL, options: .atomic)
                isValid = fileVerifier(destURL, asset)
            }
            Self.markExcludedFromBackup(destURL)
            if isValid,
               let fp = Self.fileFingerprint(at: destURL, fileManager: fileManager) {
                snapshots[asset.filename] = fp
            }
        }
        return snapshots
    }

    private func removeStalePartFiles() {
        guard let entries = try? fileManager.contentsOfDirectory(at: modelsDirectory, includingPropertiesForKeys: nil) else {
            return
        }
        for entry in entries where entry.lastPathComponent.contains(".part.") || entry.pathExtension == "part" {
            try? fileManager.removeItem(at: entry)
        }
    }

    private func downloadAndVerifyAssetWithMirrorFallback(
        _ asset: IosSpeechModelAsset,
        completedBytes: Int64,
        totalDownloadBytes: Int64
    ) throws {
        lock.lock()
        let orderedIndices = preferredMirrorOrder
        lock.unlock()

        var failedIndices: [Int] = []
        var lastError: Error = DownloadError.missingOutput(asset.filename)
        for mirrorIdx in orderedIndices {
            let origin = mirrorOrigins[mirrorIdx].trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard let url = Self.assetURL(origin: origin, filename: asset.filename) else {
                failedIndices.append(mirrorIdx)
                lastError = DownloadError.invalidURL("\(origin)/\(asset.filename)")
                continue
            }
            do {
                try downloadSingleFile(
                    asset: asset,
                    from: url,
                    completedBytes: completedBytes,
                    totalDownloadBytes: totalDownloadBytes
                )
                promoteWinningMirror(mirrorIdx, afterFailures: failedIndices)
                return
            } catch {
                failedIndices.append(mirrorIdx)
                lastError = error
            }
        }
        throw lastError
    }

    private func promoteWinningMirror(_ winningIdx: Int, afterFailures failedIndices: [Int]) {
        lock.lock()
        defer { lock.unlock() }
        let failedSet = Set(failedIndices)
        var nextOrder: [Int] = [winningIdx]
        for idx in preferredMirrorOrder where idx != winningIdx && !failedSet.contains(idx) {
            nextOrder.append(idx)
        }
        for idx in failedIndices where idx != winningIdx && !nextOrder.contains(idx) {
            nextOrder.append(idx)
        }
        for idx in preferredMirrorOrder where !nextOrder.contains(idx) {
            nextOrder.append(idx)
        }
        preferredMirrorOrder = nextOrder
    }

    private func downloadSingleFile(
        asset: IosSpeechModelAsset,
        from url: URL,
        completedBytes: Int64,
        totalDownloadBytes: Int64
    ) throws {
        let destURL = modelsDirectory.appendingPathComponent(asset.filename)
        let partURL = modelsDirectory.appendingPathComponent("\(asset.filename).part.\(UUID().uuidString)")
        let semaphore = DispatchSemaphore(value: 0)
        var outcome: Result<Void, Error> = .failure(DownloadError.missingOutput(asset.filename))

        let task = urlSession.downloadTask(with: url)
        let state = ActiveTaskState(
            asset: asset,
            destURL: destURL,
            partURL: partURL,
            baseCompletedBytes: completedBytes,
            totalDownloadBytes: totalDownloadBytes,
            completion: { result in
                outcome = result
                semaphore.signal()
            }
        )
        lock.lock()
        activeTasks[task.taskIdentifier] = state
        lock.unlock()

        task.resume()
        semaphore.wait()

        if case .failure(let error) = outcome {
            try? fileManager.removeItem(at: partURL)
            throw error
        }
    }

    private func updateDownloadingProgress(_ progress: Double) {
        let clamped = min(1.0, max(0.0, progress))
        lock.lock()
        if case .downloading = _status {
            _status = .downloading(progress: clamped)
        }
        lock.unlock()
    }

    private func finishPipeline(success: Bool, errorMessage: String?) {
        lock.lock()
        inFlight = false
        if success {
            _status = .ready
            lastFailureAt = nil
        } else {
            _status = .failed(errorMessage ?? "Model download failed")
            lastFailureAt = Date()
        }
        let completions = pendingCompletions
        pendingCompletions.removeAll()
        let readyObservers = success ? onReadyHandlers : []
        lock.unlock()

        for cb in completions {
            cb(success)
        }
        for observer in readyObservers {
            observer()
        }
    }

    // MARK: - URLSessionDownloadDelegate

    public func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        lock.lock()
        guard let active = activeTasks[downloadTask.taskIdentifier] else {
            lock.unlock()
            return
        }
        let credited = min(active.asset.expectedSize, max(0, totalBytesWritten))
        let ratio = Double(active.baseCompletedBytes + credited) / Double(max(1, active.totalDownloadBytes))
        if case .downloading = _status {
            _status = .downloading(progress: min(1.0, max(0.0, ratio)))
        }
        lock.unlock()
    }

    public func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        lock.lock()
        guard var active = activeTasks[downloadTask.taskIdentifier] else {
            lock.unlock()
            return
        }
        lock.unlock()

        if let http = downloadTask.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            active.finishError = DownloadError.httpStatus(http.statusCode)
            lock.lock()
            activeTasks[downloadTask.taskIdentifier] = active
            lock.unlock()
            return
        }

        do {
            try? fileManager.removeItem(at: active.partURL)
            try fileManager.moveItem(at: location, to: active.partURL)
            guard fileVerifier(active.partURL, active.asset) else {
                try? fileManager.removeItem(at: active.partURL)
                active.finishError = DownloadError.checksumMismatch(active.asset.filename)
                lock.lock()
                activeTasks[downloadTask.taskIdentifier] = active
                lock.unlock()
                return
            }
            if fileManager.fileExists(atPath: active.destURL.path) {
                try fileManager.removeItem(at: active.destURL)
            }
            try fileManager.moveItem(at: active.partURL, to: active.destURL)
            Self.markExcludedFromBackup(active.destURL)
        } catch {
            try? fileManager.removeItem(at: active.partURL)
            active.finishError = DownloadError.fileMoveFailed(active.asset.filename)
            lock.lock()
            activeTasks[downloadTask.taskIdentifier] = active
            lock.unlock()
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        guard let active = activeTasks.removeValue(forKey: task.taskIdentifier) else {
            lock.unlock()
            return
        }
        lock.unlock()

        if let error {
            try? fileManager.removeItem(at: active.partURL)
            active.completion(.failure(error))
            return
        }
        if let finishError = active.finishError {
            try? fileManager.removeItem(at: active.partURL)
            active.completion(.failure(finishError))
            return
        }
        guard fileManager.isReadableFile(atPath: active.destURL.path) else {
            active.completion(.failure(DownloadError.missingOutput(active.asset.filename)))
            return
        }
        active.completion(.success(()))
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.lock()
        let handler = backgroundSessionCompletionHandler
        backgroundSessionCompletionHandler = nil
        lock.unlock()
        guard let handler else { return }
        DispatchQueue.main.async {
            handler()
        }
    }

    // MARK: - Static Helpers

    public static func assetURL(
        origin: String,
        repoId: String = repoId,
        revision: String = revision,
        filename: String
    ) -> URL? {
        let trimmed = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: "\(trimmed)/\(repoId)/resolve/\(revision)/\(filename)")
    }

    public static func fileSize(at url: URL, fileManager: FileManager = .default) -> Int64? {
        guard let attrs = try? fileManager.attributesOfItem(atPath: url.path),
              let number = attrs[.size] as? NSNumber else {
            return nil
        }
        return number.int64Value
    }

    private static func fileFingerprint(at url: URL, fileManager: FileManager = .default) -> FileFingerprint? {
        guard fileManager.isReadableFile(atPath: url.path),
              let attrs = try? fileManager.attributesOfItem(atPath: url.path),
              let number = attrs[.size] as? NSNumber else {
            return nil
        }
        return FileFingerprint(
            size: number.int64Value,
            modificationDate: attrs[.modificationDate] as? Date
        )
    }

    public static func sha256Hex(of url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk: Data?
            do {
                chunk = try handle.read(upToCount: 1024 * 1024)
            } catch {
                return nil
            }
            guard let chunk, !chunk.isEmpty else { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    public static func verifyFile(
        at url: URL,
        asset: IosSpeechModelAsset,
        fileManager: FileManager = .default
    ) -> Bool {
        guard fileManager.isReadableFile(atPath: url.path),
              let size = fileSize(at: url, fileManager: fileManager),
              size == asset.expectedSize else {
            return false
        }
        if asset.expectedSize == 0 {
            return asset.expectedSha256.lowercased() == emptyFileSha256
        }
        return sha256Hex(of: url)?.lowercased() == asset.expectedSha256.lowercased()
    }

    public static func markExcludedFromBackup(_ url: URL) {
        var mutable = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? mutable.setResourceValues(values)
    }
}
