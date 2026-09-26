import CryptoKit
import Foundation

/// Finds (or downloads) the pinned R2T2 GGUF pair in the app's Documents
/// directory. Pins mirror spikes/r2t2-mobile/PINS.env.
enum ModelPins {
    static let revision = "86ff0251cb9f456b63aeef5f80137f104e22869a"
    static let repo = "netease-youdao/Confucius4-R2T2-GGUF"
    static let model = PinnedFile(name: "Confucius4-R2T2-Q4_K_M.gguf", size: 1_107_404_736,
                                  sha256: "fa3cb46c8c3a66a58812b9098ba6e96a0266d4e8c9b3cf5ba34432fd2f9f6466")
    static let mmproj = PinnedFile(name: "mmproj-Confucius4-R2T2-Q8_0.gguf", size: 348_336_544,
                                   sha256: "8dc2c67e6a0484114928142d098db7ad94ae9f34c78948ef9d37a9678418cb65")
    static let licenseURL = URL(string: "https://raw.githubusercontent.com/netease-youdao/Confucius4-R2T2/refs/heads/master/MODEL_LICENSE")!
}

struct PinnedFile {
    let name: String
    let size: Int64
    let sha256: String
    func url(endpoint: String) -> URL {
        URL(string: "\(endpoint)/\(ModelPins.repo)/resolve/\(ModelPins.revision)/\(name)")!
    }
}

enum ModelStore {
    static var documents: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }

    /// Any `mmproj*.gguf` + other `*.gguf` in Documents, preferring pinned names.
    static func locate() -> (model: URL, mmproj: URL)? {
        let files = (try? FileManager.default.contentsOfDirectory(at: documents, includingPropertiesForKeys: nil)) ?? []
        let ggufs = files.filter { $0.pathExtension == "gguf" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        let projectors = ggufs.filter { $0.lastPathComponent.hasPrefix("mmproj") }
        let models = ggufs.filter { !$0.lastPathComponent.hasPrefix("mmproj") }
        let model = models.first { $0.lastPathComponent == ModelPins.model.name } ?? models.first
        let mmproj = projectors.first { $0.lastPathComponent == ModelPins.mmproj.name } ?? projectors.first
        guard let model, let mmproj else { return nil }
        return (model, mmproj)
    }

    static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 8 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func excludeFromBackup(_ url: URL) {
        var u = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? u.setResourceValues(values)
    }
}

/// Foreground download of one pinned file with progress and SHA-256 check.
final class PinnedDownloader: NSObject, URLSessionDownloadDelegate {
    private var continuation: CheckedContinuation<URL, Error>?
    private let progress: (Double) -> Void
    private let file: PinnedFile

    init(file: PinnedFile, progress: @escaping (Double) -> Void) {
        self.file = file
        self.progress = progress
    }

    func run(endpoint: String) async throws {
        let dest = ModelStore.documents.appendingPathComponent(file.name)
        if FileManager.default.fileExists(atPath: dest.path) { return }
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        let tmp: URL = try await withCheckedThrowingContinuation { cont in
            continuation = cont
            session.downloadTask(with: file.url(endpoint: endpoint)).resume()
        }
        let attrs = try FileManager.default.attributesOfItem(atPath: tmp.path)
        guard (attrs[.size] as? NSNumber)?.int64Value == file.size else {
            throw NSError(domain: "r2t2", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(file.name): size mismatch"])
        }
        guard try ModelStore.sha256(of: tmp) == file.sha256 else {
            throw NSError(domain: "r2t2", code: 2, userInfo: [NSLocalizedDescriptionKey: "\(file.name): SHA-256 mismatch"])
        }
        try FileManager.default.moveItem(at: tmp, to: dest)
        ModelStore.excludeFromBackup(dest)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // `location` is deleted when this returns; move it somewhere we own first.
        let keep = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        do {
            try FileManager.default.moveItem(at: location, to: keep)
            continuation?.resume(returning: keep)
        } catch {
            continuation?.resume(throwing: error)
        }
        continuation = nil
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        progress(Double(totalBytesWritten) / Double(max(totalBytesExpectedToWrite, file.size)))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            continuation?.resume(throwing: error)
            continuation = nil
        }
    }
}
