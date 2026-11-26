import CryptoKit
import Foundation
import Network
#if canImport(BackgroundAssets)
import BackgroundAssets
#endif
#if canImport(System)
import System
#endif

public enum IosSpeechNetworkType: String, Equatable, Sendable {
    case wifi
    case cellular
    case offline
    case unknown
}

public struct IosSpeechNetworkStatus: Equatable, Sendable {
    public let networkType: IosSpeechNetworkType
    public let isExpensive: Bool
    public let isConstrained: Bool

    public init(networkType: IosSpeechNetworkType, isExpensive: Bool = false, isConstrained: Bool = false) {
        self.networkType = networkType
        self.isExpensive = isExpensive
        self.isConstrained = isConstrained
    }

    public var requiresCellularConfirmation: Bool {
        networkType == .cellular || isExpensive || isConstrained
    }
}

public struct IosSpeechModelStatusSnapshot: Equatable {
    public let status: IosSpeechDownloadStatus
    public let statusString: String
    public let progress: Double
    public let downloadedBytes: Int64
    public let totalBytes: Int64
    public let allowCellular: Bool
    public let networkStatus: IosSpeechNetworkStatus
    public let errorMessage: String?

    public var requiresCellularConfirmation: Bool {
        networkStatus.requiresCellularConfirmation
    }
}

public struct IosSpeechStartDownloadResult: Equatable {
    public let started: Bool
    public let requiresCellularConfirmation: Bool
    public let snapshot: IosSpeechModelStatusSnapshot
}

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

public enum IosSpeechAssetPackBackendError: Error, LocalizedError, Equatable {
    case unavailable

    public var errorDescription: String? {
        switch self {
        case .unavailable:
            return "Apple-hosted asset pack unavailable"
        }
    }
}

public protocol IosSpeechAssetPackBackend: AnyObject {
    func localModelRoot(
        assetPackID: String,
        requiredAssets: [IosSpeechModelAsset],
        fileVerifier: @escaping IosSpeechModelDownloader.FileVerifier,
        fileManager: FileManager
    ) -> URL?
    func downloadAssetPack(
        assetPackID: String,
        requiredAssets: [IosSpeechModelAsset],
        fileVerifier: @escaping IosSpeechModelDownloader.FileVerifier,
        fileManager: FileManager,
        onProgress: @escaping (Double) -> Void,
        completion: @escaping (Result<URL, Error>) -> Void
    ) -> (() -> Void)
    func removeAssetPack(assetPackID: String, completion: @escaping () -> Void)
}

#if canImport(BackgroundAssets) && canImport(System)
@available(iOS 26, macOS 26, *)
final class AppleHostedAssetPackBackend: IosSpeechAssetPackBackend {
    private static let candidateRelativeDirectories = ["ios-models", ""]

    func localModelRoot(
        assetPackID: String,
        requiredAssets: [IosSpeechModelAsset],
        fileVerifier: @escaping IosSpeechModelDownloader.FileVerifier,
        fileManager: FileManager
    ) -> URL? {
        if #available(iOS 26.4, macOS 26.4, *) {
            guard AssetPackManager.shared.assetPackIsAvailableLocally(withID: assetPackID) else {
                return nil
            }
        }
        return Self.resolveVerifiedPackRoot(
            requiredAssets: requiredAssets,
            fileVerifier: fileVerifier,
            fileManager: fileManager
        )
    }

    func downloadAssetPack(
        assetPackID: String,
        requiredAssets: [IosSpeechModelAsset],
        fileVerifier: @escaping IosSpeechModelDownloader.FileVerifier,
        fileManager: FileManager,
        onProgress: @escaping (Double) -> Void,
        completion: @escaping (Result<URL, Error>) -> Void
    ) -> (() -> Void) {
        let task = Task {
            do {
                let pack: AssetPack
                do {
                    pack = try await AssetPackManager.shared.assetPack(withID: assetPackID)
                } catch is CancellationError {
                    completion(.failure(CancellationError()))
                    return
                } catch {
                    // Sideloaded, debug, or missing App Store Connect asset packs trigger HTTPS fallback.
                    completion(.failure(IosSpeechAssetPackBackendError.unavailable))
                    return
                }

                if Task.isCancelled {
                    completion(.failure(CancellationError()))
                    return
                }

                let statusTask = Task {
                    for await update in AssetPackManager.shared.statusUpdates(forAssetPackWithID: assetPackID) {
                        if Task.isCancelled { break }
                        switch update {
                        case .downloading(_, let progress):
                            onProgress(min(1.0, max(0.0, progress.fractionCompleted)))
                        case .finished, .failed:
                            break
                        case .began, .paused:
                            continue
                        @unknown default:
                            continue
                        }
                    }
                }
                defer { statusTask.cancel() }

                if #available(iOS 26.4, macOS 26.4, *) {
                    try await AssetPackManager.shared.ensureLocalAvailability(of: pack, requireLatestVersion: false)
                } else {
                    try await AssetPackManager.shared.ensureLocalAvailability(of: pack)
                }

                if Task.isCancelled {
                    completion(.failure(CancellationError()))
                    return
                }

                guard let root = Self.resolveVerifiedPackRoot(
                    requiredAssets: requiredAssets,
                    fileVerifier: fileVerifier,
                    fileManager: fileManager
                ) else {
                    completion(.failure(IosSpeechAssetPackBackendError.unavailable))
                    return
                }
                completion(.success(root))
            } catch is CancellationError {
                completion(.failure(CancellationError()))
            } catch let managedError as ManagedBackgroundAssetsError {
                switch managedError {
                case .assetPackNotFound, .fileNotFound:
                    completion(.failure(IosSpeechAssetPackBackendError.unavailable))
                @unknown default:
                    completion(.failure(IosSpeechAssetPackBackendError.unavailable))
                }
            } catch {
                if Task.isCancelled {
                    completion(.failure(CancellationError()))
                } else {
                    completion(.failure(error))
                }
            }
        }
        return { task.cancel() }
    }

    func removeAssetPack(assetPackID: String, completion: @escaping () -> Void) {
        Task {
            try? await AssetPackManager.shared.remove(assetPackWithID: assetPackID)
            completion()
        }
    }

    private static func resolveVerifiedPackRoot(
        requiredAssets: [IosSpeechModelAsset],
        fileVerifier: IosSpeechModelDownloader.FileVerifier,
        fileManager: FileManager
    ) -> URL? {
        for dir in candidateRelativeDirectories {
            let probe = dir.isEmpty ? "config.json" : "\(dir)/config.json"
            if let configURL = try? AssetPackManager.shared.url(for: FilePath(probe)) {
                let root = configURL.deletingLastPathComponent()
                if IosSpeechModelDownloader.verifyAssets(
                    at: root,
                    assets: requiredAssets,
                    fileVerifier: fileVerifier,
                    fileManager: fileManager
                ) {
                    return root
                }
            }
        }
        return nil
    }
}
#endif

/// Downloads and SHA-256 verifies Qwen3-ASR-0.6B-MLX-4bit weights into Application Support
/// using Apple-Hosted Background Assets on iOS 26+ when available, with automatic fallback to
/// a background URLSession using HuggingFace / hf-mirror.
public final class IosSpeechModelDownloader: NSObject, URLSessionDownloadDelegate {
    public static let appleAssetPackID = "com.im.codes.speech.qwen3-asr-0.6b-mlx-4bit"
    public static let backgroundSessionIdentifier = "com.im.codes.qwen3asr-model-download"
    public static let cellularBackgroundSessionIdentifier = "com.im.codes.qwen3asr-model-download.cellular"
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
        case cancelled
        case offline

        public var errorDescription: String? {
            switch self {
            case .invalidURL(let raw): return "Invalid model asset URL: \(raw)"
            case .httpStatus(let code): return "Model download HTTP error \(code)"
            case .checksumMismatch(let name): return "Model verification failed for \(name)"
            case .fileMoveFailed(let name): return "Could not store downloaded model file \(name)"
            case .missingOutput(let name): return "Downloaded file missing for \(name)"
            case .cancelled: return "Model download cancelled"
            case .offline: return "No internet connection available for model download"
            }
        }
    }

    private struct ActiveTaskState {
        let generation: Int
        let task: URLSessionDownloadTask
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
    public typealias NetworkStatusProvider = @Sendable () -> IosSpeechNetworkStatus

    public static let shared = IosSpeechModelDownloader()

    public let modelsDirectory: URL
    public let mirrorOrigins: [String]
    public let assets: [IosSpeechModelAsset]

    private var fileManager: FileManager { .default }
    private let workQueue = DispatchQueue(label: "com.im.codes.speech-model-downloader", qos: .utility)
    private let monitorQueue = DispatchQueue(label: "com.im.codes.speech-model-network-monitor", qos: .utility)
    private let lock = NSLock()
    private let customSessionConfiguration: URLSessionConfiguration?
    private let customCellularSessionConfiguration: URLSessionConfiguration?
    private let sessionIdentifier: String?
    private let retryCooldownSeconds: TimeInterval
    private let fileVerifier: FileVerifier
    private let customNetworkStatusProvider: NetworkStatusProvider?

    private var pathMonitor: NWPathMonitor?
    private var latestObservedNetworkStatus: IosSpeechNetworkStatus?
    private var hasCreatedWifiSession = false
    private var hasCreatedCellularSession = false

    public static func makeSessionConfiguration(
        sessionIdentifier: String?,
        allowCellular: Bool
    ) -> URLSessionConfiguration {
        let config: URLSessionConfiguration
        if let sessionIdentifier, !sessionIdentifier.isEmpty {
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
        config.allowsCellularAccess = allowCellular
        config.allowsExpensiveNetworkAccess = allowCellular
        config.allowsConstrainedNetworkAccess = allowCellular
        return config
    }

    private lazy var wifiSession: URLSession = {
        hasCreatedWifiSession = true
        let config = customSessionConfiguration
            ?? Self.makeSessionConfiguration(sessionIdentifier: sessionIdentifier, allowCellular: false)
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    private lazy var cellularSession: URLSession = {
        hasCreatedCellularSession = true
        let config: URLSessionConfiguration
        if let customCellularSessionConfiguration {
            config = customCellularSessionConfiguration
        } else if (sessionIdentifier == nil || sessionIdentifier?.isEmpty == true), let customSessionConfiguration {
            // Preserve custom ephemeral URLProtocol mocks in unit tests when no background identifier is set.
            config = customSessionConfiguration
        } else {
            let cellularId: String?
            if let sessionIdentifier, !sessionIdentifier.isEmpty {
                cellularId = sessionIdentifier == Self.backgroundSessionIdentifier
                    ? Self.cellularBackgroundSessionIdentifier
                    : "\(sessionIdentifier).cellular"
            } else {
                cellularId = nil
            }
            config = Self.makeSessionConfiguration(sessionIdentifier: cellularId, allowCellular: true)
        }
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    private func sessionForDownload(allowCellular: Bool) -> URLSession {
        allowCellular ? cellularSession : wifiSession
    }

    private var _status: IosSpeechDownloadStatus = .idle
    private var inFlight = false
    private var activeAllowCellular = false
    private var downloadGeneration = 0
    private var lastNotifiedProgress: Double = -1
    private var lastFailureAt: Date?
    private var preferredMirrorOrder: [Int]
    private var pendingCompletions: [(Bool) -> Void] = []
    private var activeTasks: [Int: ActiveTaskState] = [:]
    private var wifiBackgroundCompletionHandler: (() -> Void)?
    private var cellularBackgroundCompletionHandler: (() -> Void)?
    private var onReadyHandlers: [() -> Void] = []
    private var onStatusObservers: [(IosSpeechModelStatusSnapshot) -> Void] = []
    private var _verifiedFingerprints: [String: FileFingerprint] = [:]
    private let assetPackBackend: IosSpeechAssetPackBackend?
    private var activeAssetPackRoot: URL?
    private var activeAssetPackCancel: (() -> Void)?

    public static func defaultAssetPackBackend(bundle: Bundle = .main) -> IosSpeechAssetPackBackend? {
        #if canImport(BackgroundAssets) && canImport(System)
        if #available(iOS 26, macOS 26, *),
           (bundle.object(forInfoDictionaryKey: "BAUsesAppleHosting") as? Bool) == true {
            return AppleHostedAssetPackBackend()
        }
        #endif
        return nil
    }

    public init(
        modelsDirectory: URL = IosSpeechModelDownloader.defaultModelsDirectory(),
        mirrorOrigins: [String]? = nil,
        assets: [IosSpeechModelAsset] = IosSpeechModelDownloader.requiredAssets,
        sessionIdentifier: String? = IosSpeechModelDownloader.backgroundSessionIdentifier,
        urlSessionConfiguration: URLSessionConfiguration? = nil,
        cellularSessionConfiguration: URLSessionConfiguration? = nil,
        retryCooldownSeconds: TimeInterval = 60,
        networkStatusProvider: NetworkStatusProvider? = nil,
        fileVerifier: @escaping FileVerifier = { url, asset in
            IosSpeechModelDownloader.verifyFile(at: url, asset: asset)
        },
        assetPackBackend: IosSpeechAssetPackBackend? = IosSpeechModelDownloader.defaultAssetPackBackend()
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
        self.customCellularSessionConfiguration = cellularSessionConfiguration
        self.retryCooldownSeconds = retryCooldownSeconds
        self.customNetworkStatusProvider = networkStatusProvider
        self.fileVerifier = fileVerifier
        self.assetPackBackend = assetPackBackend
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
    /// constant-time file metadata (`size` + `modificationDate`) and `.verified-<revision>`,
    /// or a locally-available Apple-Hosted asset pack on iOS 26+.
    /// Never performs SHA-256 hashing or network calls on the caller's thread.
    public var hasVerifiedLocalModels: Bool {
        verifiedModelRoot != nil
    }

    /// Returns the local directory containing verified speech model assets (either `modelsDirectory`
    /// from HTTPS download or a locally available Apple-Hosted Background Assets root).
    public var verifiedModelRoot: URL? {
        lock.lock()
        let isReady = (_status == .ready)
        let snapshots = _verifiedFingerprints
        let cachedAssetPackRoot = activeAssetPackRoot
        lock.unlock()

        if isReady, let cachedAssetPackRoot {
            if Self.fingerprintsMatch(at: cachedAssetPackRoot, assets: assets, expected: snapshots, fileManager: fileManager) {
                return cachedAssetPackRoot
            }
            invalidateVerifiedState()
        }

        if isReady {
            let markerURL = modelsDirectory.appendingPathComponent(Self.verifiedMarkerFilename)
            if fileManager.isReadableFile(atPath: markerURL.path),
               Self.fingerprintsMatch(at: modelsDirectory, assets: assets, expected: snapshots, fileManager: fileManager) {
                return modelsDirectory
            }
            invalidateVerifiedState()
        }

        if let assetPackRoot = assetPackBackend?.localModelRoot(
            assetPackID: Self.appleAssetPackID,
            requiredAssets: assets,
            fileVerifier: fileVerifier,
            fileManager: fileManager
        ), let fingerprints = Self.collectVerifiedFingerprints(
            at: assetPackRoot,
            assets: assets,
            fileVerifier: fileVerifier,
            fileManager: fileManager
        ) {
            lock.lock()
            if !inFlight {
                activeAssetPackRoot = assetPackRoot
                _verifiedFingerprints = fingerprints
                _status = .ready
            }
            lock.unlock()
            return assetPackRoot
        }

        return nil
    }

    public static func verifyAssets(
        at root: URL,
        assets: [IosSpeechModelAsset] = IosSpeechModelDownloader.requiredAssets,
        fileVerifier: FileVerifier = { url, asset in
            IosSpeechModelDownloader.verifyFile(at: url, asset: asset)
        },
        fileManager: FileManager = .default
    ) -> Bool {
        collectVerifiedFingerprints(
            at: root,
            assets: assets,
            fileVerifier: fileVerifier,
            fileManager: fileManager
        ) != nil
    }

    private static func fingerprintsMatch(
        at root: URL,
        assets: [IosSpeechModelAsset],
        expected: [String: FileFingerprint],
        fileManager: FileManager
    ) -> Bool {
        for asset in assets {
            let url = root.appendingPathComponent(asset.filename)
            guard let expectedFp = expected[asset.filename],
                  let current = fileFingerprint(at: url, fileManager: fileManager),
                  current.size == asset.expectedSize,
                  current == expectedFp else {
                return false
            }
        }
        return true
    }

    private static func collectVerifiedFingerprints(
        at root: URL,
        assets: [IosSpeechModelAsset],
        fileVerifier: FileVerifier,
        fileManager: FileManager
    ) -> [String: FileFingerprint]? {
        var snapshots: [String: FileFingerprint] = [:]
        for asset in assets {
            let fileURL = root.appendingPathComponent(asset.filename)
            guard fileManager.isReadableFile(atPath: fileURL.path),
                  fileVerifier(fileURL, asset),
                  let fp = fileFingerprint(at: fileURL, fileManager: fileManager),
                  fp.size == asset.expectedSize else {
                return nil
            }
            snapshots[asset.filename] = fp
        }
        return snapshots
    }

    /// Full cryptographic SHA-256 + byte-size verification over every file in `root`.
    @discardableResult
    public func verifyAssetsOnDisk(at root: URL) -> Bool {
        guard let snapshots = Self.collectVerifiedFingerprints(
            at: root,
            assets: assets,
            fileVerifier: fileVerifier,
            fileManager: fileManager
        ) else {
            invalidateVerifiedState(removeMarker: root == modelsDirectory)
            return false
        }
        lock.lock()
        activeAssetPackRoot = (root == modelsDirectory) ? nil : root
        _verifiedFingerprints = snapshots
        lock.unlock()
        return true
    }

    /// Full cryptographic SHA-256 + byte-size verification over every file in `modelsDirectory`.
    /// Intended for background worker verification (`workQueue` / `coordinator.worker`), never main thread.
    @discardableResult
    public func verifyAllAssetsOnDisk() -> Bool {
        verifyAssetsOnDisk(at: modelsDirectory)
    }

    private func invalidateVerifiedState(removeMarker: Bool = false) {
        lock.lock()
        if _status == .ready {
            _status = .idle
        }
        activeAssetPackRoot = nil
        _verifiedFingerprints.removeAll()
        lock.unlock()
        if removeMarker {
            try? fileManager.removeItem(at: modelsDirectory.appendingPathComponent(Self.verifiedMarkerFilename))
        }
    }

    public var totalDownloadBytes: Int64 {
        max(0, assets.filter(\.downloadable).reduce(Int64(0)) { $0 + $1.expectedSize })
    }

    public func addReadyObserver(_ handler: @escaping () -> Void) {
        lock.lock()
        onReadyHandlers.append(handler)
        lock.unlock()
    }

    public func addStatusObserver(_ handler: @escaping (IosSpeechModelStatusSnapshot) -> Void) {
        lock.lock()
        onStatusObservers.append(handler)
        lock.unlock()
    }

    public static func handleBackgroundSessionEvents(
        identifier: String,
        completionHandler: @escaping () -> Void
    ) -> Bool {
        if identifier == backgroundSessionIdentifier {
            shared.setBackgroundCompletionHandler(completionHandler, allowCellular: false)
            return true
        }
        if identifier == cellularBackgroundSessionIdentifier {
            shared.setBackgroundCompletionHandler(completionHandler, allowCellular: true)
            return true
        }
        return false
    }

    private func setBackgroundCompletionHandler(_ handler: @escaping () -> Void, allowCellular: Bool) {
        lock.lock()
        if allowCellular {
            cellularBackgroundCompletionHandler = handler
        } else {
            wifiBackgroundCompletionHandler = handler
        }
        lock.unlock()
        // Touch the matching URLSession so Foundation connects delegate callbacks for this identifier.
        _ = sessionForDownload(allowCellular: allowCellular)
    }

    private static func classifyNetworkPath(_ path: NWPath) -> IosSpeechNetworkStatus {
        guard path.status == .satisfied else {
            return IosSpeechNetworkStatus(networkType: .offline, isExpensive: path.isExpensive, isConstrained: path.isConstrained)
        }
        let type: IosSpeechNetworkType
        if path.usesInterfaceType(.cellular) {
            type = .cellular
        } else if path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet) {
            type = .wifi
        } else {
            type = .unknown
        }
        return IosSpeechNetworkStatus(networkType: type, isExpensive: path.isExpensive, isConstrained: path.isConstrained)
    }

    public func currentNetworkStatus() -> IosSpeechNetworkStatus {
        if let customNetworkStatusProvider {
            return customNetworkStatusProvider()
        }
        if customSessionConfiguration != nil || customCellularSessionConfiguration != nil {
            // Isolated unit tests use ephemeral/URLProtocol configurations without live NWPathMonitor.
            return IosSpeechNetworkStatus(networkType: .wifi, isExpensive: false, isConstrained: false)
        }
        lock.lock()
        let cached = latestObservedNetworkStatus
        let existingMonitor = pathMonitor
        if existingMonitor == nil {
            let monitor = NWPathMonitor()
            monitor.pathUpdateHandler = { [weak self] path in
                let status = Self.classifyNetworkPath(path)
                self?.lock.lock()
                self?.latestObservedNetworkStatus = status
                self?.lock.unlock()
            }
            pathMonitor = monitor
            monitor.start(queue: monitorQueue)
        }
        lock.unlock()

        if let cached {
            return cached
        }
        // Brief one-shot wait on cold start before NWPathMonitor delivers its initial path snapshot.
        let sem = DispatchSemaphore(value: 0)
        let probe = NWPathMonitor()
        var probed: IosSpeechNetworkStatus?
        let probeLock = NSLock()
        probe.pathUpdateHandler = { path in
            probeLock.lock()
            let shouldSignal = (probed == nil)
            probed = Self.classifyNetworkPath(path)
            probeLock.unlock()
            if shouldSignal { sem.signal() }
        }
        probe.start(queue: monitorQueue)
        _ = sem.wait(timeout: .now() + 0.08)
        probe.cancel()
        probeLock.lock()
        let result = probed ?? IosSpeechNetworkStatus(networkType: .unknown, isExpensive: false, isConstrained: false)
        probeLock.unlock()
        lock.lock()
        if latestObservedNetworkStatus == nil {
            latestObservedNetworkStatus = result
        }
        lock.unlock()
        return result
    }

    public func statusSnapshot(networkStatus: IosSpeechNetworkStatus? = nil) -> IosSpeechModelStatusSnapshot {
        let net = networkStatus ?? currentNetworkStatus()
        lock.lock()
        let snapshot = buildStatusSnapshotLocked(networkStatus: net)
        lock.unlock()
        return snapshot
    }

    private func buildStatusSnapshotLocked(networkStatus: IosSpeechNetworkStatus) -> IosSpeechModelStatusSnapshot {
        let total = totalDownloadBytes
        let statusStr: String
        let errorMsg: String?
        let downloaded: Int64
        switch _status {
        case .idle:
            statusStr = "idle"
            errorMsg = nil
            downloaded = 0
        case .downloading(let progress):
            statusStr = "downloading"
            errorMsg = nil
            downloaded = min(total, max(0, Int64((Double(total) * progress).rounded())))
        case .ready:
            statusStr = "ready"
            errorMsg = nil
            downloaded = total
        case .failed(let message):
            statusStr = "failed"
            errorMsg = message
            downloaded = 0
        }
        return IosSpeechModelStatusSnapshot(
            status: _status,
            statusString: statusStr,
            progress: _status.progress,
            downloadedBytes: downloaded,
            totalBytes: total,
            allowCellular: activeAllowCellular,
            networkStatus: networkStatus,
            errorMessage: errorMsg
        )
    }

    private func notifyStatusObservers(_ snapshot: IosSpeechModelStatusSnapshot) {
        lock.lock()
        let observers = onStatusObservers
        lock.unlock()
        for observer in observers {
            observer(snapshot)
        }
    }

    /// Local-only verification for already-downloaded assets on disk. Never performs any
    /// network requests; fresh installs without a verified marker stay `.idle` and return `false`.
    public func verifyExistingLocalModelsIfPresent(completion: ((Bool) -> Void)? = nil) {
        if hasVerifiedLocalModels {
            completion?(true)
            return
        }
        let markerURL = modelsDirectory.appendingPathComponent(Self.verifiedMarkerFilename)
        let hasLegacyMarker = fileManager.isReadableFile(atPath: markerURL.path)
        let hasAssetPackBackend = assetPackBackend != nil
        guard hasLegacyMarker || hasAssetPackBackend else {
            completion?(false)
            return
        }

        workQueue.async { [weak self] in
            guard let self else {
                completion?(false)
                return
            }
            self.lock.lock()
            let busy = self.inFlight
            self.lock.unlock()
            if busy {
                completion?(false)
                return
            }

            let legacyOk = hasLegacyMarker ? self.verifyAllAssetsOnDisk() : false
            var assetPackRoot: URL?
            var assetPackFingerprints: [String: FileFingerprint]?
            if !legacyOk, let backend = self.assetPackBackend {
                if let candidate = backend.localModelRoot(
                    assetPackID: Self.appleAssetPackID,
                    requiredAssets: self.assets,
                    fileVerifier: self.fileVerifier,
                    fileManager: self.fileManager
                ), let fingerprints = Self.collectVerifiedFingerprints(
                    at: candidate,
                    assets: self.assets,
                    fileVerifier: self.fileVerifier,
                    fileManager: self.fileManager
                ) {
                    assetPackRoot = candidate
                    assetPackFingerprints = fingerprints
                }
            }

            let ok = legacyOk || (assetPackRoot != nil)
            if ok {
                let net = self.currentNetworkStatus()
                self.lock.lock()
                self.activeAssetPackRoot = assetPackRoot
                if let assetPackFingerprints {
                    self._verifiedFingerprints = assetPackFingerprints
                }
                self._status = .ready
                self.lastFailureAt = nil
                self.activeAllowCellular = false
                let snapshot = self.buildStatusSnapshotLocked(networkStatus: net)
                let readyObservers = self.onReadyHandlers
                self.lock.unlock()
                self.notifyStatusObservers(snapshot)
                for observer in readyObservers {
                    observer()
                }
            } else {
                self.invalidateVerifiedState(removeMarker: true)
            }
            completion?(ok)
        }
    }

    /// Explicitly starts a manual model download respecting Wi-Fi-only defaults unless
    /// `allowCellular: true` was confirmed by the user. Returns immediately with whether
    /// the download started or requires explicit cellular confirmation.
    public func startDownload(
        allowCellular: Bool = false,
        forceRetry: Bool = true,
        completion: ((IosSpeechStartDownloadResult) -> Void)? = nil
    ) {
        beginDownloadIfAllowed(
            forceRetry: forceRetry,
            allowCellular: allowCellular,
            onStart: { result in completion?(result) },
            onFinish: nil
        )
    }

    /// Ensures models are downloaded and SHA-256 verified asynchronously on `workQueue`.
    /// Enforces Wi-Fi only by default (`allowCellular = false`) unless explicitly allowed.
    public func ensureDownloadedIfNeeded(
        forceRetry: Bool = false,
        allowCellular: Bool = false,
        completion: ((Bool) -> Void)? = nil
    ) {
        beginDownloadIfAllowed(
            forceRetry: forceRetry,
            allowCellular: allowCellular,
            onStart: nil,
            onFinish: completion
        )
    }

    private func beginDownloadIfAllowed(
        forceRetry: Bool,
        allowCellular: Bool,
        onStart: ((IosSpeechStartDownloadResult) -> Void)?,
        onFinish: ((Bool) -> Void)?
    ) {
        if hasVerifiedLocalModels {
            let snapshot = statusSnapshot()
            onStart?(IosSpeechStartDownloadResult(started: false, requiresCellularConfirmation: false, snapshot: snapshot))
            onFinish?(true)
            return
        }

        lock.lock()
        if inFlight {
            if let onFinish { pendingCompletions.append(onFinish) }
            lock.unlock()
            let snapshot = statusSnapshot()
            onStart?(IosSpeechStartDownloadResult(started: true, requiresCellularConfirmation: false, snapshot: snapshot))
            return
        }
        if !forceRetry,
           case .failed = _status,
           let lastFailureAt,
           Date().timeIntervalSince(lastFailureAt) < retryCooldownSeconds {
            lock.unlock()
            let snapshot = statusSnapshot()
            onStart?(IosSpeechStartDownloadResult(started: false, requiresCellularConfirmation: false, snapshot: snapshot))
            onFinish?(false)
            return
        }
        lock.unlock()

        // Probe network outside the lock before starting any download.
        let net = currentNetworkStatus()

        lock.lock()
        if _status == .ready {
            let snapshot = buildStatusSnapshotLocked(networkStatus: net)
            lock.unlock()
            onStart?(IosSpeechStartDownloadResult(started: false, requiresCellularConfirmation: false, snapshot: snapshot))
            onFinish?(true)
            return
        }
        if inFlight {
            if let onFinish { pendingCompletions.append(onFinish) }
            let snapshot = buildStatusSnapshotLocked(networkStatus: net)
            lock.unlock()
            onStart?(IosSpeechStartDownloadResult(started: true, requiresCellularConfirmation: false, snapshot: snapshot))
            return
        }
        if net.networkType == .offline {
            _status = .failed(DownloadError.offline.localizedDescription)
            lastFailureAt = Date()
            activeAllowCellular = false
            let snapshot = buildStatusSnapshotLocked(networkStatus: net)
            lock.unlock()
            notifyStatusObservers(snapshot)
            onStart?(IosSpeechStartDownloadResult(started: false, requiresCellularConfirmation: false, snapshot: snapshot))
            onFinish?(false)
            return
        }
        if !allowCellular && net.requiresCellularConfirmation {
            let snapshot = buildStatusSnapshotLocked(networkStatus: net)
            lock.unlock()
            onStart?(IosSpeechStartDownloadResult(started: false, requiresCellularConfirmation: true, snapshot: snapshot))
            onFinish?(false)
            return
        }

        downloadGeneration &+= 1
        let generation = downloadGeneration
        inFlight = true
        activeAllowCellular = allowCellular
        _status = .downloading(progress: 0)
        lastNotifiedProgress = 0
        if let onFinish { pendingCompletions.append(onFinish) }
        let snapshot = buildStatusSnapshotLocked(networkStatus: net)
        lock.unlock()

        notifyStatusObservers(snapshot)
        onStart?(IosSpeechStartDownloadResult(started: true, requiresCellularConfirmation: false, snapshot: snapshot))

        workQueue.async { [weak self] in
            self?.startPrimaryOrFallbackPipeline(generation: generation, allowCellular: allowCellular)
        }
    }

    @discardableResult
    public func cancelDownload() -> Bool {
        lock.lock()
        let wasInFlight = inFlight
        downloadGeneration &+= 1
        inFlight = false
        activeAllowCellular = false
        lastNotifiedProgress = -1
        if case .ready = _status {
            // Keep verified ready state untouched if not downloading.
        } else {
            _status = .idle
        }
        let tasksToCancel = activeTasks.values.map(\.task)
        let assetPackCancel = activeAssetPackCancel
        activeAssetPackCancel = nil
        let completions = pendingCompletions
        pendingCompletions.removeAll()
        lock.unlock()

        assetPackCancel?()
        for task in tasksToCancel {
            task.cancel()
        }
        for cb in completions {
            cb(false)
        }
        let snapshot = statusSnapshot()
        notifyStatusObservers(snapshot)
        workQueue.async { [weak self] in
            self?.removeStalePartFiles()
        }
        return wasInFlight || !tasksToCancel.isEmpty || assetPackCancel != nil
    }

    public func deleteDownloadedModels(completion: (() -> Void)? = nil) {
        lock.lock()
        downloadGeneration &+= 1
        inFlight = false
        activeAllowCellular = false
        lastNotifiedProgress = -1
        lastFailureAt = nil
        _status = .idle
        activeAssetPackRoot = nil
        _verifiedFingerprints.removeAll()
        let tasksToCancel = activeTasks.values.map(\.task)
        let assetPackCancel = activeAssetPackCancel
        activeAssetPackCancel = nil
        let completions = pendingCompletions
        pendingCompletions.removeAll()
        lock.unlock()

        assetPackCancel?()
        for task in tasksToCancel {
            task.cancel()
        }
        for cb in completions {
            cb(false)
        }

        workQueue.async { [weak self] in
            guard let self else {
                completion?()
                return
            }
            self.removeStalePartFiles()
            try? self.fileManager.removeItem(at: self.modelsDirectory.appendingPathComponent(Self.verifiedMarkerFilename))
            for asset in self.assets {
                try? self.fileManager.removeItem(at: self.modelsDirectory.appendingPathComponent(asset.filename))
            }
            let finalizeDelete = {
                let snapshot = self.statusSnapshot()
                self.notifyStatusObservers(snapshot)
                completion?()
            }
            if let backend = self.assetPackBackend {
                backend.removeAssetPack(assetPackID: Self.appleAssetPackID) {
                    finalizeDelete()
                }
            } else {
                finalizeDelete()
            }
        }
    }

    private func startPrimaryOrFallbackPipeline(generation: Int, allowCellular: Bool) {
        guard !isGenerationCancelled(generation) else { return }
        guard let backend = assetPackBackend else {
            runDownloadPipeline(generation: generation, allowCellular: allowCellular)
            return
        }

        if let existingRoot = backend.localModelRoot(
            assetPackID: Self.appleAssetPackID,
            requiredAssets: assets,
            fileVerifier: fileVerifier,
            fileManager: fileManager
        ), let existingFingerprints = Self.collectVerifiedFingerprints(
            at: existingRoot,
            assets: assets,
            fileVerifier: fileVerifier,
            fileManager: fileManager
        ) {
            lock.lock()
            if inFlight && downloadGeneration == generation {
                activeAssetPackRoot = existingRoot
                _verifiedFingerprints = existingFingerprints
            }
            lock.unlock()
            finishPipeline(generation: generation, success: true, errorMessage: nil)
            return
        }

        let cancelFn = backend.downloadAssetPack(
            assetPackID: Self.appleAssetPackID,
            requiredAssets: assets,
            fileVerifier: fileVerifier,
            fileManager: fileManager,
            onProgress: { [weak self] rawRatio in
                self?.updateAppleHostedProgress(generation: generation, ratio: rawRatio)
            },
            completion: { [weak self] result in
                guard let self else { return }
                self.lock.lock()
                if self.downloadGeneration == generation {
                    self.activeAssetPackCancel = nil
                }
                self.lock.unlock()

                guard !self.isGenerationCancelled(generation) else { return }

                switch result {
                case .success(let root):
                    self.workQueue.async { [weak self] in
                        guard let self, !self.isGenerationCancelled(generation) else { return }
                        guard let fingerprints = Self.collectVerifiedFingerprints(
                            at: root,
                            assets: self.assets,
                            fileVerifier: self.fileVerifier,
                            fileManager: self.fileManager
                        ) else {
                            self.runDownloadPipeline(generation: generation, allowCellular: allowCellular)
                            return
                        }
                        self.lock.lock()
                        if self.inFlight && self.downloadGeneration == generation {
                            self.activeAssetPackRoot = root
                            self._verifiedFingerprints = fingerprints
                        }
                        self.lock.unlock()
                        self.finishPipeline(generation: generation, success: true, errorMessage: nil)
                    }
                case .failure(let error):
                    if error is CancellationError {
                        return
                    }
                    if Self.shouldFallbackToHttps(for: error) {
                        self.workQueue.async { [weak self] in
                            self?.runDownloadPipeline(generation: generation, allowCellular: allowCellular)
                        }
                    } else {
                        self.finishPipeline(
                            generation: generation,
                            success: false,
                            errorMessage: error.localizedDescription
                        )
                    }
                }
            }
        )

        lock.lock()
        let stillActive = inFlight && downloadGeneration == generation
        if stillActive {
            activeAssetPackCancel = cancelFn
        }
        lock.unlock()
        if !stillActive {
            cancelFn()
        }
    }

    private func updateAppleHostedProgress(generation: Int, ratio rawRatio: Double) {
        let ratio = min(1.0, max(0.0, rawRatio))
        var snapshotToNotify: IosSpeechModelStatusSnapshot?
        lock.lock()
        guard inFlight && downloadGeneration == generation else {
            lock.unlock()
            return
        }
        if case .downloading = _status {
            _status = .downloading(progress: ratio)
            if abs(ratio - lastNotifiedProgress) >= 0.01 {
                lastNotifiedProgress = ratio
                let cachedNet = latestObservedNetworkStatus ?? IosSpeechNetworkStatus(networkType: .unknown)
                snapshotToNotify = buildStatusSnapshotLocked(networkStatus: cachedNet)
            }
        }
        lock.unlock()
        if let snapshotToNotify {
            notifyStatusObservers(snapshotToNotify)
        }
    }

    private static func shouldFallbackToHttps(for error: Error) -> Bool {
        if let backendError = error as? IosSpeechAssetPackBackendError, backendError == .unavailable {
            return true
        }
        #if canImport(BackgroundAssets)
        if #available(iOS 26, macOS 26, *), error is ManagedBackgroundAssetsError {
            return true
        }
        #endif
        return false
    }

    /// Releases an isolated downloader's URLSessions after completion (primarily for tests).
    public func invalidateSession() {
        lock.lock()
        pathMonitor?.cancel()
        pathMonitor = nil
        let invalidateWifi = hasCreatedWifiSession
        let invalidateCellular = hasCreatedCellularSession
        lock.unlock()
        if invalidateWifi {
            wifiSession.finishTasksAndInvalidate()
        }
        if invalidateCellular {
            cellularSession.finishTasksAndInvalidate()
        }
    }

    private func isGenerationCancelled(_ generation: Int) -> Bool {
        lock.lock()
        let cancelled = (!inFlight || downloadGeneration != generation)
        lock.unlock()
        return cancelled
    }

    private func runDownloadPipeline(generation: Int, allowCellular: Bool) {
        guard !isGenerationCancelled(generation) else { return }
        do {
            try prepareDestinationDirectory()
        } catch {
            finishPipeline(generation: generation, success: false, errorMessage: error.localizedDescription)
            return
        }

        removeStalePartFiles()
        var verifiedSnapshots: [String: FileFingerprint] = [:]

        let downloadableAssets = assets.filter(\.downloadable)
        let totalDownloadBytes = max(1, downloadableAssets.reduce(Int64(0)) { $0 + $1.expectedSize })
        var completedBytes: Int64 = 0
        var remaining: [IosSpeechModelAsset] = []

        for asset in downloadableAssets {
            guard !isGenerationCancelled(generation) else { return }
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

        updateDownloadingProgress(generation: generation, Double(completedBytes) / Double(totalDownloadBytes))

        for asset in remaining {
            guard !isGenerationCancelled(generation) else { return }
            do {
                try downloadAndVerifyAssetWithMirrorFallback(
                    asset,
                    generation: generation,
                    allowCellular: allowCellular,
                    completedBytes: completedBytes,
                    totalDownloadBytes: totalDownloadBytes
                )
                guard !isGenerationCancelled(generation) else { return }
                let destURL = modelsDirectory.appendingPathComponent(asset.filename)
                guard let fp = Self.fileFingerprint(at: destURL, fileManager: fileManager),
                      fp.size == asset.expectedSize else {
                    throw DownloadError.missingOutput(asset.filename)
                }
                verifiedSnapshots[asset.filename] = fp
                completedBytes += asset.expectedSize
                updateDownloadingProgress(generation: generation, Double(completedBytes) / Double(totalDownloadBytes))
            } catch {
                guard !isGenerationCancelled(generation) else { return }
                try? fileManager.removeItem(at: modelsDirectory.appendingPathComponent(Self.verifiedMarkerFilename))
                finishPipeline(generation: generation, success: false, errorMessage: error.localizedDescription)
                return
            }
        }

        guard !isGenerationCancelled(generation) else { return }
        let nonDownloadableSnapshots = ensureNonDownloadableFiles()
        for (name, fp) in nonDownloadableSnapshots {
            verifiedSnapshots[name] = fp
        }
        guard verifiedSnapshots.count == assets.count else {
            finishPipeline(generation: generation, success: false, errorMessage: "Downloaded speech model failed final verification")
            return
        }

        let markerURL = modelsDirectory.appendingPathComponent(Self.verifiedMarkerFilename)
        try? Data(Self.revision.utf8).write(to: markerURL, options: .atomic)
        Self.markExcludedFromBackup(markerURL)
        Self.markExcludedFromBackup(modelsDirectory)
        lock.lock()
        guard inFlight && downloadGeneration == generation else {
            lock.unlock()
            return
        }
        _verifiedFingerprints = verifiedSnapshots
        lock.unlock()
        finishPipeline(generation: generation, success: true, errorMessage: nil)
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
        generation: Int,
        allowCellular: Bool,
        completedBytes: Int64,
        totalDownloadBytes: Int64
    ) throws {
        lock.lock()
        let orderedIndices = preferredMirrorOrder
        lock.unlock()

        var failedIndices: [Int] = []
        var lastError: Error = DownloadError.missingOutput(asset.filename)
        for mirrorIdx in orderedIndices {
            if isGenerationCancelled(generation) {
                throw DownloadError.cancelled
            }
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
                    generation: generation,
                    allowCellular: allowCellular,
                    completedBytes: completedBytes,
                    totalDownloadBytes: totalDownloadBytes
                )
                promoteWinningMirror(mirrorIdx, afterFailures: failedIndices)
                return
            } catch {
                if isGenerationCancelled(generation) {
                    throw DownloadError.cancelled
                }
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
        generation: Int,
        allowCellular: Bool,
        completedBytes: Int64,
        totalDownloadBytes: Int64
    ) throws {
        let destURL = modelsDirectory.appendingPathComponent(asset.filename)
        let partURL = modelsDirectory.appendingPathComponent("\(asset.filename).part.\(UUID().uuidString)")
        let semaphore = DispatchSemaphore(value: 0)
        var outcome: Result<Void, Error> = .failure(DownloadError.missingOutput(asset.filename))

        let session = sessionForDownload(allowCellular: allowCellular)
        lock.lock()
        guard inFlight && downloadGeneration == generation else {
            lock.unlock()
            throw DownloadError.cancelled
        }
        let task = session.downloadTask(with: url)
        let state = ActiveTaskState(
            generation: generation,
            task: task,
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
        activeTasks[task.taskIdentifier] = state
        lock.unlock()

        task.resume()
        semaphore.wait()

        if case .failure(let error) = outcome {
            try? fileManager.removeItem(at: partURL)
            throw error
        }
    }

    private func updateDownloadingProgress(generation: Int, _ progress: Double) {
        let clamped = min(1.0, max(0.0, progress))
        var snapshotToNotify: IosSpeechModelStatusSnapshot?
        let net = currentNetworkStatus()
        lock.lock()
        if inFlight && downloadGeneration == generation, case .downloading = _status {
            _status = .downloading(progress: clamped)
            if abs(clamped - lastNotifiedProgress) >= 0.01 || clamped >= 1.0 {
                lastNotifiedProgress = clamped
                snapshotToNotify = buildStatusSnapshotLocked(networkStatus: net)
            }
        }
        lock.unlock()
        if let snapshotToNotify {
            notifyStatusObservers(snapshotToNotify)
        }
    }

    private func finishPipeline(generation: Int, success: Bool, errorMessage: String?) {
        let net = currentNetworkStatus()
        lock.lock()
        guard inFlight && downloadGeneration == generation else {
            lock.unlock()
            return
        }
        inFlight = false
        activeAllowCellular = false
        lastNotifiedProgress = success ? 1.0 : -1
        if success {
            _status = .ready
            lastFailureAt = nil
        } else {
            _status = .failed(errorMessage ?? "Model download failed")
            lastFailureAt = Date()
        }
        let snapshot = buildStatusSnapshotLocked(networkStatus: net)
        let completions = pendingCompletions
        pendingCompletions.removeAll()
        let readyObservers = success ? onReadyHandlers : []
        lock.unlock()

        notifyStatusObservers(snapshot)
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
        var snapshotToNotify: IosSpeechModelStatusSnapshot?
        lock.lock()
        guard let active = activeTasks[downloadTask.taskIdentifier],
              inFlight,
              downloadGeneration == active.generation else {
            lock.unlock()
            return
        }
        let credited = min(active.asset.expectedSize, max(0, totalBytesWritten))
        let ratio = min(1.0, max(0.0, Double(active.baseCompletedBytes + credited) / Double(max(1, active.totalDownloadBytes))))
        if case .downloading = _status {
            _status = .downloading(progress: ratio)
            if abs(ratio - lastNotifiedProgress) >= 0.01 {
                lastNotifiedProgress = ratio
                let cachedNet = latestObservedNetworkStatus ?? IosSpeechNetworkStatus(networkType: .unknown)
                snapshotToNotify = buildStatusSnapshotLocked(networkStatus: cachedNet)
            }
        }
        lock.unlock()
        if let snapshotToNotify {
            notifyStatusObservers(snapshotToNotify)
        }
    }

    public func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        lock.lock()
        guard var active = activeTasks[downloadTask.taskIdentifier],
              inFlight,
              downloadGeneration == active.generation else {
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
            guard !isGenerationCancelled(active.generation) else {
                try? fileManager.removeItem(at: active.partURL)
                active.finishError = DownloadError.cancelled
                lock.lock()
                activeTasks[downloadTask.taskIdentifier] = active
                lock.unlock()
                return
            }
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
        let cancelled = (!inFlight || downloadGeneration != active.generation)
        lock.unlock()

        if cancelled {
            try? fileManager.removeItem(at: active.partURL)
            active.completion(.failure(DownloadError.cancelled))
            return
        }
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
        let isCellularSession = (session === cellularSession)
        lock.lock()
        let handler: (() -> Void)?
        if isCellularSession {
            handler = cellularBackgroundCompletionHandler
            cellularBackgroundCompletionHandler = nil
        } else {
            handler = wifiBackgroundCompletionHandler
            wifiBackgroundCompletionHandler = nil
        }
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
