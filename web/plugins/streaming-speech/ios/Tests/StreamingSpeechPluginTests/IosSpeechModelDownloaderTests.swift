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
}
