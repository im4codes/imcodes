import CryptoKit
import XCTest
@testable import StreamingSpeechPlugin

private final class MockSpeechAssetURLProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (Int, Data?, Error?))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let (statusCode, data, error) = handler(request)
        if let error {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        let url = request.url ?? URL(string: "https://example.com")!
        let response = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if let data {
            client?.urlProtocol(self, didLoad: data)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class IosSpeechModelDownloaderTests: XCTestCase {
    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func makeTempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ios-speech-dl-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func testRequiredAssetManifestMatchesChecksumPinnedQwen3Asr06B4Bit() {
        XCTAssertEqual(IosSpeechModelDownloader.backgroundSessionIdentifier, "com.im.codes.qwen3asr-model-download")
        XCTAssertEqual(IosSpeechModelDownloader.defaultMirrorOrigins, ["https://huggingface.co", "https://hf-mirror.com"])
        let byName = Dictionary(uniqueKeysWithValues: IosSpeechModelDownloader.requiredAssets.map { ($0.filename, $0) })
        XCTAssertEqual(byName["config.json"]?.expectedSize, 7187)
        XCTAssertEqual(byName["config.json"]?.expectedSha256, "923618cf5ca452fda0253a6be5c1a17f94a2e4851d3b98beb45848565587bd72")
        XCTAssertEqual(byName["merges.txt"]?.expectedSize, 1_671_853)
        XCTAssertEqual(byName["model.safetensors"]?.expectedSize, 708_236_945)
        XCTAssertEqual(byName["model.safetensors"]?.expectedSha256, "70c7e67e588062adce4f10796e47ad42ead51c6671eda61a0987eae38ca95ddf")
        XCTAssertEqual(byName["model.safetensors.index.json"]?.expectedSize, 71814)
        XCTAssertEqual(byName["tokenizer_config.json"]?.expectedSize, 12487)
        XCTAssertEqual(byName["vocab.json"]?.expectedSize, 2_776_833)
        XCTAssertEqual(byName["hotwords.txt"]?.downloadable, false)
        XCTAssertEqual(byName["hotwords.txt"]?.expectedSize, 0)
    }

    func testDownloadsVerifiesSha256ExcludesFromBackupAndFallsBackToMirror() throws {
        let root = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let modelsDir = root.appendingPathComponent("imcodes-speech-models/Qwen3-ASR-0.6B-MLX-4bit", isDirectory: true)

        let payloadA = Data("{\"ok\":true}".utf8)
        let payloadB = Data("weights-bytes".utf8)
        let testAssets = [
            IosSpeechModelAsset(filename: "config.json", expectedSize: Int64(payloadA.count), expectedSha256: sha256(payloadA)),
            IosSpeechModelAsset(filename: "model.safetensors", expectedSize: Int64(payloadB.count), expectedSha256: sha256(payloadB)),
            IosSpeechModelAsset(filename: "hotwords.txt", expectedSize: 0, expectedSha256: IosSpeechModelDownloader.emptyFileSha256, downloadable: false),
        ]

        // Pre-seed a corrupt truncated config.json and a stray .part file to verify cleanup + re-download.
        try FileManager.default.createDirectory(at: modelsDir, withIntermediateDirectories: true)
        try Data("bad".utf8).write(to: modelsDir.appendingPathComponent("config.json"))
        try Data("partial".utf8).write(to: modelsDir.appendingPathComponent("model.safetensors.part.stale"))

        var requestedHosts: [String] = []
        MockSpeechAssetURLProtocol.handler = { request in
            let url = request.url!
            requestedHosts.append(url.host ?? "")
            if url.host == "huggingface.co" {
                return (503, nil, URLError(.timedOut))
            }
            if url.lastPathComponent == "config.json" { return (200, payloadA, nil) }
            if url.lastPathComponent == "model.safetensors" { return (200, payloadB, nil) }
            return (404, nil, nil)
        }
        defer { MockSpeechAssetURLProtocol.handler = nil }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockSpeechAssetURLProtocol.self]
        let downloader = IosSpeechModelDownloader(
            modelsDirectory: modelsDir,
            mirrorOrigins: ["https://huggingface.co", "https://hf-mirror.com"],
            assets: testAssets,
            sessionIdentifier: nil,
            urlSessionConfiguration: config
        )
        defer { downloader.invalidateSession() }

        XCTAssertFalse(downloader.hasVerifiedLocalModels)

        let exp = expectation(description: "download completes via mirror fallback")
        var resultSuccess = false
        downloader.ensureDownloadedIfNeeded { ok in
            resultSuccess = ok
            exp.fulfill()
        }
        wait(for: [exp], timeout: 10)

        XCTAssertTrue(resultSuccess)
        XCTAssertTrue(downloader.hasVerifiedLocalModels)
        XCTAssertEqual(downloader.status, .ready)
        XCTAssertEqual(try Data(contentsOf: modelsDir.appendingPathComponent("config.json")), payloadA)
        XCTAssertEqual(try Data(contentsOf: modelsDir.appendingPathComponent("model.safetensors")), payloadB)
        XCTAssertTrue(FileManager.default.isReadableFile(atPath: modelsDir.appendingPathComponent("hotwords.txt").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: modelsDir.appendingPathComponent("model.safetensors.part.stale").path))
        XCTAssertTrue(requestedHosts.contains("huggingface.co"))
        XCTAssertTrue(requestedHosts.contains("hf-mirror.com"))
        let resourceValues = try modelsDir.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(resourceValues.isExcludedFromBackup, true)
    }

    func testSharedSpeechRecognizerStorePrefersDownloadedModelsOverBundleFallback() throws {
        let root = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let downloadedDir = root.appendingPathComponent("downloaded", isDirectory: true)
        let bundleRoot = root.appendingPathComponent("bundle", isDirectory: true)
        let bundleModels = bundleRoot.appendingPathComponent("ios-models", isDirectory: true)
        try FileManager.default.createDirectory(at: downloadedDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: bundleModels, withIntermediateDirectories: true)

        let required = ["config.json", "model.safetensors", "vocab.json", "merges.txt", "tokenizer_config.json", "hotwords.txt"]
        let stubBytes = Data("ok".utf8)
        let stubSha = sha256(stubBytes)
        let testAssets = required.map {
            IosSpeechModelAsset(
                filename: $0,
                expectedSize: $0 == "hotwords.txt" ? 0 : Int64(stubBytes.count),
                expectedSha256: $0 == "hotwords.txt" ? IosSpeechModelDownloader.emptyFileSha256 : stubSha,
                downloadable: $0 != "hotwords.txt"
            )
        }

        let downloader = IosSpeechModelDownloader(
            modelsDirectory: downloadedDir,
            assets: testAssets,
            sessionIdentifier: nil,
            urlSessionConfiguration: .ephemeral
        )
        defer { downloader.invalidateSession() }
        let store = SharedSpeechRecognizerStore(downloader: downloader, bundleResourceURL: bundleRoot)

        XCTAssertNil(store.modelRoot)
        XCTAssertFalse(store.hasRequiredModelFiles)

        for name in required {
            try (name == "hotwords.txt" ? Data() : stubBytes).write(to: bundleModels.appendingPathComponent(name))
        }
        XCTAssertEqual(store.modelRoot, bundleModels)
        XCTAssertTrue(store.hasRequiredModelFiles)

        for name in required {
            try (name == "hotwords.txt" ? Data() : stubBytes).write(to: downloadedDir.appendingPathComponent(name))
        }
        try Data("v1".utf8).write(to: downloadedDir.appendingPathComponent(IosSpeechModelDownloader.verifiedMarkerFilename))

        let exp = expectation(description: "async verification marks downloaded store ready")
        downloader.ensureDownloadedIfNeeded { ok in
            XCTAssertTrue(ok)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5)

        XCTAssertEqual(store.modelRoot, downloadedDir)
        XCTAssertTrue(store.hasRequiredModelFiles)
    }

    func testEnsureDownloadedReturnsImmediatelyBeforeWorkerVerificationCompletes() throws {
        let root = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let modelsDir = root.appendingPathComponent("models", isDirectory: true)
        try FileManager.default.createDirectory(at: modelsDir, withIntermediateDirectories: true)

        let payload = Data("warm-model-payload".utf8)
        let testAssets = [
            IosSpeechModelAsset(filename: "config.json", expectedSize: Int64(payload.count), expectedSha256: sha256(payload)),
            IosSpeechModelAsset(filename: "hotwords.txt", expectedSize: 0, expectedSha256: IosSpeechModelDownloader.emptyFileSha256, downloadable: false),
        ]
        try payload.write(to: modelsDir.appendingPathComponent("config.json"))
        try Data().write(to: modelsDir.appendingPathComponent("hotwords.txt"))
        try Data("v1".utf8).write(to: modelsDir.appendingPathComponent(IosSpeechModelDownloader.verifiedMarkerFilename))

        final class VerifierGateState: @unchecked Sendable {
            let lock = NSLock()
            var startedSignaled = false
            var ranOffMainThread = false
        }
        let gateState = VerifierGateState()
        let verificationStarted = DispatchSemaphore(value: 0)
        let allowVerificationToFinish = DispatchSemaphore(value: 0)

        let downloader = IosSpeechModelDownloader(
            modelsDirectory: modelsDir,
            assets: testAssets,
            sessionIdentifier: nil,
            urlSessionConfiguration: .ephemeral,
            fileVerifier: { url, asset in
                let isMain = Thread.isMainThread
                gateState.lock.lock()
                gateState.ranOffMainThread = !isMain
                let shouldSignal = !gateState.startedSignaled && asset.downloadable
                if shouldSignal { gateState.startedSignaled = true }
                gateState.lock.unlock()
                if shouldSignal {
                    verificationStarted.signal()
                    allowVerificationToFinish.wait()
                }
                return IosSpeechModelDownloader.verifyFile(at: url, asset: asset)
            }
        )
        defer { downloader.invalidateSession() }
        let store = SharedSpeechRecognizerStore(downloader: downloader, bundleResourceURL: root.appendingPathComponent("no-bundle"))

        var callbackResult: Bool?
        let readyExp = expectation(description: "async verification completes off main thread")
        store.ensureBackgroundModelDownloadIfNeeded { ok in
            callbackResult = ok
            readyExp.fulfill()
        }

        // Wait until worker starts hashing; verify caller returned non-blockingly and status is still downloading.
        XCTAssertEqual(verificationStarted.wait(timeout: .now() + 2), .success)
        XCTAssertNil(callbackResult)
        XCTAssertTrue(downloader.status.isDownloading)
        XCTAssertFalse(downloader.hasVerifiedLocalModels)
        XCTAssertFalse(store.hasRequiredModelFiles)

        allowVerificationToFinish.signal()
        wait(for: [readyExp], timeout: 5)

        XCTAssertEqual(callbackResult, true)
        gateState.lock.lock()
        let ranOffMain = gateState.ranOffMainThread
        gateState.lock.unlock()
        XCTAssertTrue(ranOffMain)
        XCTAssertEqual(downloader.status, .ready)
        XCTAssertTrue(downloader.hasVerifiedLocalModels)
        XCTAssertEqual(store.modelRoot, modelsDir)
    }

    func testSameSizeCorruptFileFailsVerifyAllAssetsAndTriggersCleanRedownload() throws {
        let root = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let modelsDir = root.appendingPathComponent("models", isDirectory: true)
        try FileManager.default.createDirectory(at: modelsDir, withIntermediateDirectories: true)

        let goodData = Data("good-data-12".utf8)
        let badSameSizeData = Data("xxxx-data-12".utf8)
        XCTAssertEqual(goodData.count, badSameSizeData.count)

        let asset = IosSpeechModelAsset(
            filename: "config.json",
            expectedSize: Int64(goodData.count),
            expectedSha256: sha256(goodData)
        )
        let hotwords = IosSpeechModelAsset(
            filename: "hotwords.txt",
            expectedSize: 0,
            expectedSha256: IosSpeechModelDownloader.emptyFileSha256,
            downloadable: false
        )

        try badSameSizeData.write(to: modelsDir.appendingPathComponent("config.json"))
        try Data().write(to: modelsDir.appendingPathComponent("hotwords.txt"))
        try Data("v1".utf8).write(to: modelsDir.appendingPathComponent(IosSpeechModelDownloader.verifiedMarkerFilename))

        var fetchCount = 0
        MockSpeechAssetURLProtocol.handler = { _ in
            fetchCount += 1
            return (200, goodData, nil)
        }
        defer { MockSpeechAssetURLProtocol.handler = nil }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockSpeechAssetURLProtocol.self]
        let downloader = IosSpeechModelDownloader(
            modelsDirectory: modelsDir,
            assets: [asset, hotwords],
            sessionIdentifier: nil,
            urlSessionConfiguration: config
        )
        defer { downloader.invalidateSession() }

        // Even with the verified marker on disk, same-size byte corruption must fail `hasVerifiedLocalModels` immediately.
        XCTAssertFalse(downloader.hasVerifiedLocalModels)
        XCTAssertFalse(downloader.verifyAllAssetsOnDisk())
        XCTAssertFalse(downloader.hasVerifiedLocalModels)

        let exp = expectation(description: "re-downloads corrupted file")
        var ok = false
        downloader.ensureDownloadedIfNeeded { result in
            ok = result
            exp.fulfill()
        }
        wait(for: [exp], timeout: 10)

        XCTAssertTrue(ok)
        XCTAssertEqual(fetchCount, 1)
        XCTAssertTrue(downloader.verifyAllAssetsOnDisk())
        XCTAssertTrue(downloader.hasVerifiedLocalModels)
        XCTAssertEqual(try Data(contentsOf: modelsDir.appendingPathComponent("config.json")), goodData)

        // Post-ready same-size tampering must also invalidate the fingerprint snapshot immediately.
        let configURL = modelsDir.appendingPathComponent("config.json")
        try badSameSizeData.write(to: configURL, options: .atomic)
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(10)],
            ofItemAtPath: configURL.path
        )
        XCTAssertFalse(downloader.hasVerifiedLocalModels)

        let exp2 = expectation(description: "re-downloads post-ready corrupted file")
        var ok2 = false
        downloader.ensureDownloadedIfNeeded { result in
            ok2 = result
            exp2.fulfill()
        }
        wait(for: [exp2], timeout: 10)

        XCTAssertTrue(ok2)
        XCTAssertEqual(fetchCount, 2)
        XCTAssertTrue(downloader.hasVerifiedLocalModels)
        XCTAssertEqual(try Data(contentsOf: configURL), goodData)
    }

    func testResolvedDefaultMirrorOriginsRoutesByRegionAndSanitizesCustomOverrides() {
        let suiteName = "IosSpeechModelDownloaderTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        // CN locale -> hf-mirror first
        XCTAssertEqual(
            IosSpeechModelDownloader.resolvedDefaultMirrorOrigins(
                locale: Locale(identifier: "zh_CN"),
                timeZone: TimeZone(identifier: "America/New_York")!,
                environment: [:],
                userDefaults: defaults
            ),
            ["https://hf-mirror.com", "https://huggingface.co"]
        )

        // China timezone even with en_US locale -> hf-mirror first
        XCTAssertEqual(
            IosSpeechModelDownloader.resolvedDefaultMirrorOrigins(
                locale: Locale(identifier: "en_US"),
                timeZone: TimeZone(identifier: "Asia/Shanghai")!,
                environment: [:],
                userDefaults: defaults
            ),
            ["https://hf-mirror.com", "https://huggingface.co"]
        )

        // Global locale + non-CN timezone -> huggingface first
        XCTAssertEqual(
            IosSpeechModelDownloader.resolvedDefaultMirrorOrigins(
                locale: Locale(identifier: "en_US"),
                timeZone: TimeZone(identifier: "America/Los_Angeles")!,
                environment: [:],
                userDefaults: defaults
            ),
            ["https://huggingface.co", "https://hf-mirror.com"]
        )

        // Env + UserDefaults custom mirrors prepended; invalid/empty entries ignored safely; duplicates deduplicated
        defaults.set(["https://r2.example.com/", "not-a-url", ""], forKey: IosSpeechModelDownloader.customMirrorDefaultsKey)
        XCTAssertEqual(
            IosSpeechModelDownloader.resolvedDefaultMirrorOrigins(
                locale: Locale(identifier: "en_US"),
                timeZone: TimeZone(identifier: "America/Los_Angeles")!,
                environment: [
                    IosSpeechModelDownloader.customMirrorEnvKey: " , ftp://bad.example, https://cdn.example.com/ , javascript:alert(1) "
                ],
                userDefaults: defaults
            ),
            [
                "https://cdn.example.com",
                "https://r2.example.com",
                "https://huggingface.co",
                "https://hf-mirror.com",
            ]
        )

        // Only invalid custom entries -> falls back cleanly to region defaults
        defaults.set(" , invalid-host , file:///etc/passwd", forKey: IosSpeechModelDownloader.customMirrorDefaultsKey)
        XCTAssertEqual(
            IosSpeechModelDownloader.resolvedDefaultMirrorOrigins(
                locale: Locale(identifier: "zh_CN"),
                timeZone: TimeZone(identifier: "Asia/Shanghai")!,
                environment: [IosSpeechModelDownloader.customMirrorEnvKey: "   , http://"],
                userDefaults: defaults
            ),
            ["https://hf-mirror.com", "https://huggingface.co"]
        )
    }

    func testStickyMirrorPromotesWorkingMirrorAcrossRemainingAssets() throws {
        let root = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let modelsDir = root.appendingPathComponent("models", isDirectory: true)

        let payloadA = Data("{\"a\":1}".utf8)
        let payloadB = Data("merges-data".utf8)
        let payloadC = Data("vocab-data".utf8)
        let testAssets = [
            IosSpeechModelAsset(filename: "config.json", expectedSize: Int64(payloadA.count), expectedSha256: sha256(payloadA)),
            IosSpeechModelAsset(filename: "merges.txt", expectedSize: Int64(payloadB.count), expectedSha256: sha256(payloadB)),
            IosSpeechModelAsset(filename: "vocab.json", expectedSize: Int64(payloadC.count), expectedSha256: sha256(payloadC)),
            IosSpeechModelAsset(filename: "hotwords.txt", expectedSize: 0, expectedSha256: IosSpeechModelDownloader.emptyFileSha256, downloadable: false),
        ]

        var requestedHosts: [String] = []
        MockSpeechAssetURLProtocol.handler = { request in
            let url = request.url!
            let host = url.host ?? ""
            requestedHosts.append(host)
            if host == "blocked.mirror.test" || host == "huggingface.co" {
                return (503, nil, URLError(.timedOut))
            }
            if url.lastPathComponent == "config.json" { return (200, payloadA, nil) }
            if url.lastPathComponent == "merges.txt" { return (200, payloadB, nil) }
            if url.lastPathComponent == "vocab.json" { return (200, payloadC, nil) }
            return (404, nil, nil)
        }
        defer { MockSpeechAssetURLProtocol.handler = nil }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockSpeechAssetURLProtocol.self]
        let downloader = IosSpeechModelDownloader(
            modelsDirectory: modelsDir,
            mirrorOrigins: ["https://blocked.mirror.test", "https://huggingface.co", "https://hf-mirror.com"],
            assets: testAssets,
            sessionIdentifier: nil,
            urlSessionConfiguration: config
        )
        defer { downloader.invalidateSession() }

        XCTAssertEqual(downloader.mirrorOrigins, ["https://blocked.mirror.test", "https://huggingface.co", "https://hf-mirror.com"])

        let exp = expectation(description: "sticky mirror avoids retrying blocked mirrors on subsequent files")
        var ok = false
        downloader.ensureDownloadedIfNeeded { result in
            ok = result
            exp.fulfill()
        }
        wait(for: [exp], timeout: 10)

        XCTAssertTrue(ok)
        // Asset 1 fails blocked.mirror.test -> huggingface.co -> succeeds on hf-mirror.com;
        // Assets 2 and 3 go straight to hf-mirror.com without touching failed mirrors again.
        XCTAssertEqual(requestedHosts, [
            "blocked.mirror.test",
            "huggingface.co",
            "hf-mirror.com",
            "hf-mirror.com",
            "hf-mirror.com",
        ])
        XCTAssertEqual(downloader.currentMirrorOrder, [
            "https://hf-mirror.com",
            "https://blocked.mirror.test",
            "https://huggingface.co",
        ])
    }

    func testSessionConfigurationDefaultsToWifiOnlyUnlessAllowCellularConfirmed() {
        let wifiConfig = IosSpeechModelDownloader.makeSessionConfiguration(
            sessionIdentifier: IosSpeechModelDownloader.backgroundSessionIdentifier,
            allowCellular: false
        )
        XCTAssertEqual(wifiConfig.identifier, IosSpeechModelDownloader.backgroundSessionIdentifier)
        XCTAssertFalse(wifiConfig.isDiscretionary)
        XCTAssertFalse(wifiConfig.allowsCellularAccess)
        XCTAssertFalse(wifiConfig.allowsExpensiveNetworkAccess)
        XCTAssertFalse(wifiConfig.allowsConstrainedNetworkAccess)

        let cellularConfig = IosSpeechModelDownloader.makeSessionConfiguration(
            sessionIdentifier: IosSpeechModelDownloader.cellularBackgroundSessionIdentifier,
            allowCellular: true
        )
        XCTAssertEqual(cellularConfig.identifier, IosSpeechModelDownloader.cellularBackgroundSessionIdentifier)
        XCTAssertFalse(cellularConfig.isDiscretionary)
        XCTAssertTrue(cellularConfig.allowsCellularAccess)
        XCTAssertTrue(cellularConfig.allowsExpensiveNetworkAccess)
        XCTAssertTrue(cellularConfig.allowsConstrainedNetworkAccess)
    }

    func testVerifyExistingLocalModelsIfPresentNeverTouchesNetworkWhenAbsentAndMarksReadyWhenValid() throws {
        let root = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let modelsDir = root.appendingPathComponent("models", isDirectory: true)
        try FileManager.default.createDirectory(at: modelsDir, withIntermediateDirectories: true)

        let payload = Data("offline-weights".utf8)
        let testAssets = [
            IosSpeechModelAsset(filename: "config.json", expectedSize: Int64(payload.count), expectedSha256: sha256(payload)),
            IosSpeechModelAsset(filename: "hotwords.txt", expectedSize: 0, expectedSha256: IosSpeechModelDownloader.emptyFileSha256, downloadable: false),
        ]

        var fetchCount = 0
        MockSpeechAssetURLProtocol.handler = { _ in
            fetchCount += 1
            return (200, payload, nil)
        }
        defer { MockSpeechAssetURLProtocol.handler = nil }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockSpeechAssetURLProtocol.self]
        let downloader = IosSpeechModelDownloader(
            modelsDirectory: modelsDir,
            mirrorOrigins: ["https://huggingface.co", "https://hf-mirror.com"],
            assets: testAssets,
            sessionIdentifier: nil,
            urlSessionConfiguration: config
        )
        defer { downloader.invalidateSession() }

        // Fresh install: absent local files -> stays .idle, zero HTTP traffic.
        let freshExp = expectation(description: "fresh install stays idle without network")
        var freshReady = true
        downloader.verifyExistingLocalModelsIfPresent { ok in
            freshReady = ok
            freshExp.fulfill()
        }
        wait(for: [freshExp], timeout: 5)
        XCTAssertFalse(freshReady)
        XCTAssertEqual(fetchCount, 0)
        XCTAssertEqual(downloader.status, .idle)
        XCTAssertFalse(downloader.hasVerifiedLocalModels)

        // Returning user with valid local files + marker -> marks .ready with zero HTTP traffic.
        try payload.write(to: modelsDir.appendingPathComponent("config.json"))
        try Data().write(to: modelsDir.appendingPathComponent("hotwords.txt"))
        try Data(IosSpeechModelDownloader.revision.utf8).write(
            to: modelsDir.appendingPathComponent(IosSpeechModelDownloader.verifiedMarkerFilename)
        )

        let warmExp = expectation(description: "returning install verifies locally without network")
        var warmReady = false
        downloader.verifyExistingLocalModelsIfPresent { ok in
            warmReady = ok
            warmExp.fulfill()
        }
        wait(for: [warmExp], timeout: 5)
        XCTAssertTrue(warmReady)
        XCTAssertEqual(fetchCount, 0)
        XCTAssertEqual(downloader.status, .ready)
        XCTAssertTrue(downloader.hasVerifiedLocalModels)
    }

    func testCellularNetworkRequiresExplicitConfirmationBeforeDownloading() throws {
        let root = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let modelsDir = root.appendingPathComponent("models", isDirectory: true)

        let payload = Data("cellular-ok".utf8)
        let testAssets = [
            IosSpeechModelAsset(filename: "config.json", expectedSize: Int64(payload.count), expectedSha256: sha256(payload)),
            IosSpeechModelAsset(filename: "hotwords.txt", expectedSize: 0, expectedSha256: IosSpeechModelDownloader.emptyFileSha256, downloadable: false),
        ]

        var fetchCount = 0
        MockSpeechAssetURLProtocol.handler = { _ in
            fetchCount += 1
            return (200, payload, nil)
        }
        defer { MockSpeechAssetURLProtocol.handler = nil }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockSpeechAssetURLProtocol.self]
        let downloader = IosSpeechModelDownloader(
            modelsDirectory: modelsDir,
            assets: testAssets,
            sessionIdentifier: nil,
            urlSessionConfiguration: config,
            networkStatusProvider: { IosSpeechNetworkStatus(networkType: .cellular, isExpensive: true) }
        )
        defer { downloader.invalidateSession() }

        let deniedExp = expectation(description: "default allowCellular=false requires confirmation")
        var startResult: IosSpeechStartDownloadResult?
        downloader.startDownload(allowCellular: false) { result in
            startResult = result
            deniedExp.fulfill()
        }
        wait(for: [deniedExp], timeout: 5)
        XCTAssertEqual(startResult?.started, false)
        XCTAssertEqual(startResult?.requiresCellularConfirmation, true)
        XCTAssertEqual(fetchCount, 0)
        XCTAssertEqual(downloader.status, .idle)

        let confirmedExp = expectation(description: "confirmed allowCellular=true proceeds")
        var finishedOk = false
        downloader.ensureDownloadedIfNeeded(forceRetry: true, allowCellular: true) { ok in
            finishedOk = ok
            confirmedExp.fulfill()
        }
        wait(for: [confirmedExp], timeout: 10)
        XCTAssertTrue(finishedOk)
        XCTAssertEqual(fetchCount, 1)
        XCTAssertEqual(downloader.status, .ready)
        XCTAssertTrue(downloader.hasVerifiedLocalModels)
    }

    func testCancelAndDeleteCleanlyAbortAndRemoveWeights() throws {
        let root = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let modelsDir = root.appendingPathComponent("models", isDirectory: true)

        let payload = Data("model-bytes-for-delete".utf8)
        let testAssets = [
            IosSpeechModelAsset(filename: "config.json", expectedSize: Int64(payload.count), expectedSha256: sha256(payload)),
            IosSpeechModelAsset(filename: "hotwords.txt", expectedSize: 0, expectedSha256: IosSpeechModelDownloader.emptyFileSha256, downloadable: false),
        ]

        let requestStarted = DispatchSemaphore(value: 0)
        let gateLock = NSLock()
        var cancelled = false
        MockSpeechAssetURLProtocol.handler = { _ in
            requestStarted.signal()
            // Wait until cancelled or timeout so cancelDownload() hits an in-flight download.
            let deadline = Date().addingTimeInterval(3)
            while Date() < deadline {
                gateLock.lock()
                let isCancelled = cancelled
                gateLock.unlock()
                if isCancelled {
                    return (0, nil, URLError(.cancelled))
                }
                Thread.sleep(forTimeInterval: 0.02)
            }
            return (200, payload, nil)
        }
        defer { MockSpeechAssetURLProtocol.handler = nil }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockSpeechAssetURLProtocol.self]
        let downloader = IosSpeechModelDownloader(
            modelsDirectory: modelsDir,
            mirrorOrigins: ["https://huggingface.co", "https://hf-mirror.com"],
            assets: testAssets,
            sessionIdentifier: nil,
            urlSessionConfiguration: config
        )
        defer { downloader.invalidateSession() }

        let cancelExp = expectation(description: "cancel finishes pending completion with false")
        var cancelResult = true
        downloader.ensureDownloadedIfNeeded(forceRetry: true, allowCellular: false) { ok in
            cancelResult = ok
            cancelExp.fulfill()
        }
        XCTAssertEqual(requestStarted.wait(timeout: .now() + 3), .success)
        XCTAssertTrue(downloader.cancelDownload())
        gateLock.lock()
        cancelled = true
        gateLock.unlock()
        wait(for: [cancelExp], timeout: 5)
        XCTAssertFalse(cancelResult)
        XCTAssertEqual(downloader.status, .idle)

        // Now complete a download and verify deleteDownloadedModels removes weights and marker.
        MockSpeechAssetURLProtocol.handler = { _ in (200, payload, nil) }
        let dlExp = expectation(description: "download completes before delete")
        var dlOk = false
        downloader.ensureDownloadedIfNeeded(forceRetry: true, allowCellular: false) { ok in
            dlOk = ok
            dlExp.fulfill()
        }
        wait(for: [dlExp], timeout: 10)
        XCTAssertTrue(dlOk)
        XCTAssertTrue(downloader.hasVerifiedLocalModels)

        let delExp = expectation(description: "delete clears weights and state")
        downloader.deleteDownloadedModels {
            delExp.fulfill()
        }
        wait(for: [delExp], timeout: 5)
        XCTAssertFalse(downloader.hasVerifiedLocalModels)
        XCTAssertEqual(downloader.status, .idle)
        XCTAssertFalse(FileManager.default.fileExists(atPath: modelsDir.appendingPathComponent("config.json").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: modelsDir.appendingPathComponent(IosSpeechModelDownloader.verifiedMarkerFilename).path))
    }

    func testAppleHostedPrimarySuccessCellularGateFallbackAndCancel() throws {
        let root = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let modelsDir = root.appendingPathComponent("models", isDirectory: true)
        let packDir = root.appendingPathComponent("apple-pack/ios-models", isDirectory: true)
        try FileManager.default.createDirectory(at: packDir, withIntermediateDirectories: true)

        let payload = Data("apple-hosted-or-https-bytes".utf8)
        let testAssets = [
            IosSpeechModelAsset(filename: "config.json", expectedSize: Int64(payload.count), expectedSha256: sha256(payload)),
            IosSpeechModelAsset(filename: "hotwords.txt", expectedSize: 0, expectedSha256: IosSpeechModelDownloader.emptyFileSha256, downloadable: false),
        ]

        // Case 1: Cellular confirmation gates Apple-hosted download BEFORE calling backend.downloadAssetPack.
        let mockBackend = MockAppleHostedBackend()
        let cellularNet = IosSpeechNetworkStatus(networkType: .cellular, isExpensive: true, isConstrained: false)
        let gatedDownloader = IosSpeechModelDownloader(
            modelsDirectory: modelsDir,
            mirrorOrigins: ["https://huggingface.co"],
            assets: testAssets,
            sessionIdentifier: nil,
            networkStatusProvider: { cellularNet },
            assetPackBackend: mockBackend
        )
        defer { gatedDownloader.invalidateSession() }

        let gateExp = expectation(description: "cellular gate stops before apple-hosted backend")
        var gatedStart: IosSpeechStartDownloadResult?
        gatedDownloader.startDownload(allowCellular: false) { result in
            gatedStart = result
            gateExp.fulfill()
        }
        wait(for: [gateExp], timeout: 5)
        XCTAssertEqual(gatedStart?.started, false)
        XCTAssertEqual(gatedStart?.requiresCellularConfirmation, true)
        XCTAssertEqual(mockBackend.downloadCalls, 0)

        // Case 2: Apple-hosted download succeeds on Wi-Fi, updates progress, and resolves verifiedModelRoot to packDir.
        try payload.write(to: packDir.appendingPathComponent("config.json"))
        try Data().write(to: packDir.appendingPathComponent("hotwords.txt"))
        mockBackend.downloadHandler = { onProgress, completion in
            onProgress(0.5)
            completion(.success(packDir))
            return {}
        }

        let wifiNet = IosSpeechNetworkStatus(networkType: .wifi)
        let primaryDownloader = IosSpeechModelDownloader(
            modelsDirectory: modelsDir,
            mirrorOrigins: ["https://huggingface.co"],
            assets: testAssets,
            sessionIdentifier: nil,
            networkStatusProvider: { wifiNet },
            assetPackBackend: mockBackend
        )
        defer { primaryDownloader.invalidateSession() }

        let readyExp = expectation(description: "apple-hosted download reaches ready")
        primaryDownloader.addReadyObserver {
            readyExp.fulfill()
        }
        primaryDownloader.startDownload(allowCellular: false)
        wait(for: [readyExp], timeout: 5)
        XCTAssertEqual(primaryDownloader.status, .ready)
        XCTAssertEqual(primaryDownloader.verifiedModelRoot?.standardizedFileURL, packDir.standardizedFileURL)

        // Delete invokes backend.removeAssetPack and clears local ready state.
        let delExp = expectation(description: "delete calls removeAssetPack")
        primaryDownloader.deleteDownloadedModels {
            delExp.fulfill()
        }
        wait(for: [delExp], timeout: 5)
        XCTAssertEqual(mockBackend.removeCalls, 1)
        XCTAssertFalse(primaryDownloader.hasVerifiedLocalModels)

        // Case 3: AssetPack unavailable seamlessly falls back to Phase 1 HTTPS downloader.
        let unavailableBackend = MockAppleHostedBackend()
        unavailableBackend.downloadHandler = { _, completion in
            completion(.failure(IosSpeechAssetPackBackendError.unavailable))
            return {}
        }
        var httpsRequests = 0
        MockSpeechAssetURLProtocol.handler = { _ in
            httpsRequests += 1
            return (200, payload, nil)
        }
        defer { MockSpeechAssetURLProtocol.handler = nil }

        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [MockSpeechAssetURLProtocol.self]
        let fallbackDownloader = IosSpeechModelDownloader(
            modelsDirectory: modelsDir,
            mirrorOrigins: ["https://huggingface.co"],
            assets: testAssets,
            sessionIdentifier: nil,
            urlSessionConfiguration: cfg,
            networkStatusProvider: { wifiNet },
            assetPackBackend: unavailableBackend
        )
        defer { fallbackDownloader.invalidateSession() }

        let fallbackExp = expectation(description: "fallback to HTTPS completes")
        fallbackDownloader.addReadyObserver {
            fallbackExp.fulfill()
        }
        fallbackDownloader.startDownload(allowCellular: false)
        wait(for: [fallbackExp], timeout: 10)
        XCTAssertEqual(httpsRequests, 1)
        XCTAssertEqual(fallbackDownloader.verifiedModelRoot?.standardizedFileURL, modelsDir.standardizedFileURL)

        // Case 4: User cancel during Apple-hosted download never falls back to HTTPS.
        httpsRequests = 0
        let cancelBackend = MockAppleHostedBackend()
        let startedSem = DispatchSemaphore(value: 0)
        var backendCancelled = false
        cancelBackend.downloadHandler = { _, _ in
            startedSem.signal()
            return { backendCancelled = true }
        }
        let cancelDownloader = IosSpeechModelDownloader(
            modelsDirectory: modelsDir.appendingPathComponent("cancel-case", isDirectory: true),
            mirrorOrigins: ["https://huggingface.co"],
            assets: testAssets,
            sessionIdentifier: nil,
            urlSessionConfiguration: cfg,
            networkStatusProvider: { wifiNet },
            assetPackBackend: cancelBackend
        )
        defer { cancelDownloader.invalidateSession() }

        cancelDownloader.startDownload(allowCellular: false)
        XCTAssertEqual(startedSem.wait(timeout: .now() + 3), .success)
        XCTAssertTrue(cancelDownloader.cancelDownload())
        XCTAssertTrue(backendCancelled)
        XCTAssertEqual(cancelDownloader.status, .idle)
        XCTAssertEqual(httpsRequests, 0)
    }

    func testAppleHostedRejectsWrongContentWrongSizeAndTamperedHotwordsAndFallsBackToHttps() throws {
        let root = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }

        let validPayload = Data("valid-apple-hosted-model-bytes".utf8)
        let sameSizeWrongPayload = Data("WRONG-apple-hosted-model-bytes".utf8)
        XCTAssertEqual(validPayload.count, sameSizeWrongPayload.count)
        let wrongSizePayload = Data("short".utf8)

        let testAssets = [
            IosSpeechModelAsset(
                filename: "config.json",
                expectedSize: Int64(validPayload.count),
                expectedSha256: sha256(validPayload)
            ),
            IosSpeechModelAsset(
                filename: "hotwords.txt",
                expectedSize: 0,
                expectedSha256: IosSpeechModelDownloader.emptyFileSha256,
                downloadable: false
            ),
        ]

        // 1) Wrong content with identical byte length: localModelRoot & verifyExistingLocalModelsIfPresent reject it.
        let wrongContentDir = root.appendingPathComponent("wrong-content", isDirectory: true)
        try FileManager.default.createDirectory(at: wrongContentDir, withIntermediateDirectories: true)
        try sameSizeWrongPayload.write(to: wrongContentDir.appendingPathComponent("config.json"))
        try Data().write(to: wrongContentDir.appendingPathComponent("hotwords.txt"))

        let verifyingBackend = MockAppleHostedBackend()
        verifyingBackend.localRoot = wrongContentDir
        let wifiNet = IosSpeechNetworkStatus(networkType: .wifi)
        let wrongContentDownloader = IosSpeechModelDownloader(
            modelsDirectory: root.appendingPathComponent("dl-wrong-content", isDirectory: true),
            mirrorOrigins: ["https://huggingface.co"],
            assets: testAssets,
            sessionIdentifier: nil,
            networkStatusProvider: { wifiNet },
            assetPackBackend: verifyingBackend
        )
        defer { wrongContentDownloader.invalidateSession() }

        XCTAssertNil(verifyingBackend.localModelRoot(
            assetPackID: IosSpeechModelDownloader.appleAssetPackID,
            requiredAssets: testAssets,
            fileVerifier: { url, asset in IosSpeechModelDownloader.verifyFile(at: url, asset: asset) },
            fileManager: .default
        ))
        let exp1 = expectation(description: "wrong content verifyExistingLocalModelsIfPresent returns false")
        var ok1 = true
        wrongContentDownloader.verifyExistingLocalModelsIfPresent { ok in
            ok1 = ok
            exp1.fulfill()
        }
        wait(for: [exp1], timeout: 5)
        XCTAssertFalse(ok1)
        XCTAssertEqual(wrongContentDownloader.status, .idle)
        XCTAssertFalse(wrongContentDownloader.hasVerifiedLocalModels)
        XCTAssertNil(wrongContentDownloader.verifiedModelRoot)

        // 2) Wrong size: rejected cleanly as well.
        let wrongSizeDir = root.appendingPathComponent("wrong-size", isDirectory: true)
        try FileManager.default.createDirectory(at: wrongSizeDir, withIntermediateDirectories: true)
        try wrongSizePayload.write(to: wrongSizeDir.appendingPathComponent("config.json"))
        try Data().write(to: wrongSizeDir.appendingPathComponent("hotwords.txt"))
        verifyingBackend.localRoot = wrongSizeDir

        let exp2 = expectation(description: "wrong size verifyExistingLocalModelsIfPresent returns false")
        var ok2 = true
        wrongContentDownloader.verifyExistingLocalModelsIfPresent { ok in
            ok2 = ok
            exp2.fulfill()
        }
        wait(for: [exp2], timeout: 5)
        XCTAssertFalse(ok2)
        XCTAssertEqual(wrongContentDownloader.status, .idle)
        XCTAssertNil(wrongContentDownloader.verifiedModelRoot)

        // 3) Tampered non-downloadable hotwords.txt (must remain empty): rejected even when downloadable files match.
        let badHotwordsDir = root.appendingPathComponent("bad-hotwords", isDirectory: true)
        try FileManager.default.createDirectory(at: badHotwordsDir, withIntermediateDirectories: true)
        try validPayload.write(to: badHotwordsDir.appendingPathComponent("config.json"))
        try Data("tampered".utf8).write(to: badHotwordsDir.appendingPathComponent("hotwords.txt"))
        verifyingBackend.localRoot = badHotwordsDir
        XCTAssertNil(wrongContentDownloader.verifiedModelRoot)
        XCTAssertEqual(wrongContentDownloader.status, .idle)

        // 4) Even if a backend bypasses its own check and supplies a tampered/wrong-size root on download,
        // IosSpeechModelDownloader rejects it and falls back cleanly to HTTPS.
        let rawTamperedBackend = MockAppleHostedBackend()
        rawTamperedBackend.enforceIntegrityInMock = false
        rawTamperedBackend.localRoot = nil
        rawTamperedBackend.downloadHandler = { _, completion in
            completion(.success(wrongContentDir))
            return {}
        }

        var httpsRequests = 0
        MockSpeechAssetURLProtocol.handler = { _ in
            httpsRequests += 1
            return (200, validPayload, nil)
        }
        defer { MockSpeechAssetURLProtocol.handler = nil }

        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [MockSpeechAssetURLProtocol.self]
        let fallbackModelsDir = root.appendingPathComponent("dl-fallback", isDirectory: true)
        let fallbackDownloader = IosSpeechModelDownloader(
            modelsDirectory: fallbackModelsDir,
            mirrorOrigins: ["https://huggingface.co"],
            assets: testAssets,
            sessionIdentifier: nil,
            urlSessionConfiguration: cfg,
            networkStatusProvider: { wifiNet },
            assetPackBackend: rawTamperedBackend
        )
        defer { fallbackDownloader.invalidateSession() }

        let fallbackExp = expectation(description: "tampered apple-hosted pack falls back to valid HTTPS download")
        fallbackDownloader.addReadyObserver {
            fallbackExp.fulfill()
        }
        fallbackDownloader.startDownload(allowCellular: false)
        wait(for: [fallbackExp], timeout: 10)
        XCTAssertEqual(httpsRequests, 1)
        XCTAssertEqual(fallbackDownloader.status, .ready)
        XCTAssertEqual(fallbackDownloader.verifiedModelRoot?.standardizedFileURL, fallbackModelsDir.standardizedFileURL)
    }
}

private final class MockAppleHostedBackend: IosSpeechAssetPackBackend {
    var localRoot: URL?
    var enforceIntegrityInMock = true
    var downloadCalls = 0
    var removeCalls = 0
    var downloadHandler: ((@escaping (Double) -> Void, @escaping (Result<URL, Error>) -> Void) -> (() -> Void))?

    func localModelRoot(
        assetPackID: String,
        requiredAssets: [IosSpeechModelAsset],
        fileVerifier: @escaping IosSpeechModelDownloader.FileVerifier,
        fileManager: FileManager
    ) -> URL? {
        guard let candidate = localRoot else { return nil }
        if enforceIntegrityInMock {
            guard IosSpeechModelDownloader.verifyAssets(
                at: candidate,
                assets: requiredAssets,
                fileVerifier: fileVerifier,
                fileManager: fileManager
            ) else {
                return nil
            }
        }
        return candidate
    }

    func downloadAssetPack(
        assetPackID: String,
        requiredAssets: [IosSpeechModelAsset],
        fileVerifier: @escaping IosSpeechModelDownloader.FileVerifier,
        fileManager: FileManager,
        onProgress: @escaping (Double) -> Void,
        completion: @escaping (Result<URL, Error>) -> Void
    ) -> (() -> Void) {
        downloadCalls += 1
        if let handler = downloadHandler {
            return handler(onProgress, completion)
        }
        completion(.failure(IosSpeechAssetPackBackendError.unavailable))
        return {}
    }

    func removeAssetPack(assetPackID: String, completion: @escaping () -> Void) {
        removeCalls += 1
        localRoot = nil
        completion()
    }
}
