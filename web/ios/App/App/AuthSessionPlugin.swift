import Capacitor
import AuthenticationServices
import Foundation
import UIKit
import UniformTypeIdentifiers

/// Capacitor plugin wrapping ASWebAuthenticationSession.
/// Unlike SFSafariViewController (@capacitor/browser), this shows a compact
/// authentication sheet that auto-closes on redirect — ideal for passkey flows.
@objc(AuthSessionPlugin)
public class AuthSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AuthSessionPlugin"
    public let jsName = "AuthSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise)
    ]

    private var session: ASWebAuthenticationSession?

    @objc func start(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              let url = URL(string: urlString),
              let callbackScheme = call.getString("callbackScheme") else {
            call.reject("Missing url or callbackScheme")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                call.reject("AuthSessionPlugin deallocated")
                return
            }
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { [weak self] callbackURL, error in
                self?.session = nil
                if let error = error {
                    let nsError = error as NSError
                    if nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        call.reject("cancelled")
                    } else {
                        call.reject(error.localizedDescription)
                    }
                    return
                }

                guard let callbackURL = callbackURL else {
                    call.reject("No callback URL")
                    return
                }

                call.resolve(["url": callbackURL.absoluteString])
            }

            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            self.session = session
            if !session.start() {
                self.session = nil
                call.reject("Failed to start authentication session")
            }
        }
    }
}

extension AuthSessionPlugin: ASWebAuthenticationPresentationContextProviding {
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let webViewWindow = self.bridge?.webView?.window {
            return webViewWindow
        }
        let activeScene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first
        if let sceneWindow = activeScene?.windows.first(where: { $0.isKeyWindow }) ?? activeScene?.windows.first {
            return sceneWindow
        }
        return UIWindow()
    }
}

/// Capacitor plugin that receives files opened/shared from external iOS apps
/// (`application(_:open:options:)`) and forwards them to the web frontend.
@objc(ShareReceiverPlugin)
public class ShareReceiverPlugin: CAPPlugin, CAPBridgedPlugin {
    public static let shared = ShareReceiverPlugin()
    public static let maxShareBytes = 50 * 1024 * 1024
    public static let maxPendingShares = 20
    private static let duplicatePathDebounceInterval: TimeInterval = 2.0

    public let identifier = "ShareReceiverPlugin"
    public let jsName = "ShareReceiver"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "consumePendingShares", returnType: CAPPluginReturnPromise)
    ]

    private let lock = NSLock()
    private var pendingShares: [[String: Any]] = []
    private var recentHandledPaths: [String: TimeInterval] = [:]
    // Reservations and pending paths share the same lock/capacity protocol for
    // direct URL callbacks and the disk scanner. Accepted payloads never evict.
    private var inFlightPaths = Set<String>()
    private var pendingPaths = Set<String>()
    private var failedInboxPaths = Set<String>()
    private let inboxWorker = DispatchQueue(label: "com.imcodes.share-inbox", qos: .userInitiated)
    private var inboxScanScheduled = false
    private var inboxRescanRequested = false

    private var inboxRoots: [URL] {
        var roots = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).map { $0.appendingPathComponent("Inbox", isDirectory: true) }
        if let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.im.codes") {
            roots.append(group.appendingPathComponent("SharedInbox", isDirectory: true))
        }
        return roots
    }

    private func isManagedInboxFile(_ url: URL) -> Bool {
        let path = url.resolvingSymlinksInPath().standardizedFileURL.path
        return inboxRoots.contains { path.hasPrefix($0.resolvingSymlinksInPath().standardizedFileURL.path + "/") }
    }

    public func drainInboxFilesIfNeeded(retryFailures: Bool = true) {
        lock.lock()
        // A real activation/open may retry a retained read failure. Automatic
        // capacity refills skip it so it cannot starve later files or spin.
        if retryFailures { failedInboxPaths.formIntersection(pendingPaths) }
        guard !inboxScanScheduled else { inboxRescanRequested = true; lock.unlock(); return }
        inboxScanScheduled = true
        lock.unlock()
        inboxWorker.async {
            defer {
                self.lock.lock()
                self.inboxScanScheduled = false
                let rescan = self.inboxRescanRequested
                self.inboxRescanRequested = false
                self.lock.unlock()
                if rescan { self.drainInboxFilesIfNeeded(retryFailures: false) }
            }
            for root in self.inboxRoots {
                guard let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .isDirectoryKey], options: []) else { continue }
                let isSharedInboxRoot = root.lastPathComponent == "SharedInbox"
                let standardizedRoot = root.standardizedFileURL
                for case let file as URL in files {
                    self.lock.lock(); let full = self.pendingShares.count + self.inFlightPaths.count >= Self.maxPendingShares; self.lock.unlock()
                    if full { return } // Leave overflow on disk for consumePendingShares' next pass.
                    guard let info = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .isDirectoryKey]) else { continue }
                    if isSharedInboxRoot, info.isDirectory == true,
                       file.deletingLastPathComponent().standardizedFileURL == standardizedRoot {
                        // Unpublished extension batches stay ignored until moved into place.
                        if file.lastPathComponent.hasPrefix(".pending-") {
                            files.skipDescendants()
                            continue
                        }
                        let manifestURL = file.appendingPathComponent("manifest.json", isDirectory: false)
                        if let manifestInfo = try? manifestURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
                           manifestInfo.isRegularFile == true,
                           manifestInfo.isSymbolicLink != true {
                            files.skipDescendants()
                            _ = self.handleIncomingBatchDirectory(file, retryFailures: false)
                            continue
                        }
                    }
                    guard self.isManagedInboxFile(file), info.isRegularFile == true,
                          info.isSymbolicLink != true else { continue }
                    _ = self.handleIncomingFileURL(file, retryFailures: false)
                }
            }
        }
    }

    private struct ShareBatchManifest: Decodable {
        let version: Int?
        let text: String?
        let files: [String]?
    }

    private static func resolveSafeBatchFile(_ relPath: String, in batchDir: URL) -> URL? {
        let trimmed = relPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !trimmed.hasPrefix("/"),
              !trimmed.contains("\\"),
              !trimmed.contains("\0") else { return nil }
        let components = trimmed.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.isEmpty,
              !components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
            return nil
        }
        let resolvedBatch = batchDir.resolvingSymlinksInPath().standardizedFileURL
        var cursor = batchDir
        for component in components {
            cursor.appendPathComponent(String(component), isDirectory: false)
            guard let values = try? cursor.resourceValues(forKeys: [.isSymbolicLinkKey]),
                  values.isSymbolicLink != true else {
                return nil
            }
        }
        guard let fileValues = try? cursor.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              fileValues.isRegularFile == true,
              fileValues.isSymbolicLink != true else {
            return nil
        }
        let resolvedTarget = cursor.resolvingSymlinksInPath().standardizedFileURL
        guard resolvedTarget.path.hasPrefix(resolvedBatch.path + "/") else {
            return nil
        }
        return cursor
    }

    @discardableResult
    public func handleIncomingBatchDirectory(_ batchDir: URL, retryFailures: Bool = true) -> Bool {
        guard batchDir.isFileURL, isManagedInboxFile(batchDir) else { return false }

        let normalizedPath = batchDir.standardizedFileURL.path
        let now = Date().timeIntervalSince1970
        lock.lock()
        if inFlightPaths.contains(normalizedPath) || pendingPaths.contains(normalizedPath) {
            lock.unlock()
            return true
        }
        if retryFailures { failedInboxPaths.remove(normalizedPath) }
        if failedInboxPaths.contains(normalizedPath) {
            lock.unlock()
            return true
        }
        recentHandledPaths = recentHandledPaths.filter { (_, timestamp) in
            (now - timestamp) < Self.duplicatePathDebounceInterval
        }
        if let lastHandledAt = recentHandledPaths[normalizedPath],
           (now - lastHandledAt) < Self.duplicatePathDebounceInterval {
            lock.unlock()
            return true
        }
        guard pendingShares.count + inFlightPaths.count < Self.maxPendingShares else {
            lock.unlock()
            return false
        }
        inFlightPaths.insert(normalizedPath)
        lock.unlock()

        var consumed = false
        defer {
            if consumed && batchDir.path.contains("/SharedInbox/") && isManagedInboxFile(batchDir) {
                try? FileManager.default.removeItem(at: batchDir)
            }
        }

        let payloadId = UUID().uuidString
        let manifestURL = batchDir.appendingPathComponent("manifest.json", isDirectory: false)
        guard let manifestData = try? Data(contentsOf: manifestURL, options: [.mappedIfSafe]) else {
            dispatchOrEnqueue([
                "id": payloadId,
                "files": [],
                "error": "read_failed"
            ], path: normalizedPath, readFailed: true)
            return true
        }

        guard let manifest = try? JSONDecoder().decode(ShareBatchManifest.self, from: manifestData) else {
            consumed = true
            dispatchOrEnqueue([
                "id": payloadId,
                "files": [],
                "error": "read_failed"
            ], path: normalizedPath)
            return true
        }

        let trimmedText = manifest.text?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nonEmptyText = (trimmedText?.isEmpty == false) ? trimmedText : nil
        let relativePaths = manifest.files ?? []

        var fileEntries: [[String: Any]] = []
        var errorCode: String?
        var ioReadFailed = false

        for relPath in relativePaths {
            guard let fileURL = Self.resolveSafeBatchFile(relPath, in: batchDir) else {
                errorCode = errorCode ?? "read_failed"
                continue
            }
            if let resourceValues = try? fileURL.resourceValues(forKeys: [.fileSizeKey]),
               let fileSize = resourceValues.fileSize,
               fileSize > Self.maxShareBytes {
                errorCode = "file_too_large"
                break
            }
            guard let data = try? Data(contentsOf: fileURL, options: [.mappedIfSafe]) else {
                errorCode = errorCode ?? "read_failed"
                ioReadFailed = true
                continue
            }
            if data.count > Self.maxShareBytes {
                errorCode = "file_too_large"
                break
            }
            let rawName = fileURL.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
            let fileName = rawName.isEmpty ? "shared-file" : rawName
            fileEntries.append([
                "name": fileName,
                "mimeType": Self.inferMimeType(for: fileURL),
                "size": data.count,
                "base64": data.base64EncodedString()
            ])
        }

        if errorCode == "file_too_large" {
            consumed = true
            var payload: [String: Any] = [
                "id": payloadId,
                "files": [],
                "error": "file_too_large"
            ]
            if let nonEmptyText { payload["text"] = nonEmptyText }
            dispatchOrEnqueue(payload, path: normalizedPath)
            return true
        }

        if fileEntries.isEmpty && nonEmptyText == nil && errorCode == nil {
            consumed = true
            lock.lock()
            inFlightPaths.remove(normalizedPath)
            lock.unlock()
            return true
        }

        consumed = !ioReadFailed
        var payload: [String: Any] = [
            "id": payloadId,
            "files": fileEntries
        ]
        if let nonEmptyText {
            payload["text"] = nonEmptyText
        }
        if let errorCode {
            payload["error"] = errorCode
        }
        dispatchOrEnqueue(payload, path: normalizedPath, readFailed: ioReadFailed)
        return true
    }

    @discardableResult
    public func handleIncomingFileURL(_ url: URL, retryFailures: Bool = true) -> Bool {
        guard url.isFileURL else { return false }

        let normalizedPath = url.standardizedFileURL.path
        let now = Date().timeIntervalSince1970
        lock.lock()
        if inFlightPaths.contains(normalizedPath) || pendingPaths.contains(normalizedPath) {
            lock.unlock()
            return true
        }
        if retryFailures { failedInboxPaths.remove(normalizedPath) }
        if failedInboxPaths.contains(normalizedPath) {
            lock.unlock()
            return true
        }
        recentHandledPaths = recentHandledPaths.filter { (_, timestamp) in
            (now - timestamp) < Self.duplicatePathDebounceInterval
        }
        if let lastHandledAt = recentHandledPaths[normalizedPath],
           (now - lastHandledAt) < Self.duplicatePathDebounceInterval {
            lock.unlock()
            return true
        }
        guard pendingShares.count + inFlightPaths.count < Self.maxPendingShares else {
            lock.unlock()
            // Managed files remain on disk for the next consume/scan. A direct
            // external temporary URL is explicitly refused, never falsely accepted.
            return false
        }
        inFlightPaths.insert(normalizedPath)
        lock.unlock()
        let accessed = url.startAccessingSecurityScopedResource()
        var consumed = false
        defer {
            if accessed {
                url.stopAccessingSecurityScopedResource()
            }
            if consumed && (url.path.contains("/Documents/Inbox/") || url.path.contains("-Inbox/") || url.path.contains("/SharedInbox/")) && isManagedInboxFile(url) {
                try? FileManager.default.removeItem(at: url)
            }
        }

        let payloadId = UUID().uuidString
        let fileName = url.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "shared-file"
            : url.lastPathComponent
        let mimeType = Self.inferMimeType(for: url)

        if let resourceValues = try? url.resourceValues(forKeys: [.fileSizeKey]),
           let fileSize = resourceValues.fileSize,
           fileSize > Self.maxShareBytes {
            consumed = true
            dispatchOrEnqueue([
                "id": payloadId,
                "files": [],
                "error": "file_too_large"
            ], path: normalizedPath)
            return true
        }

        guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else {
            dispatchOrEnqueue([
                "id": payloadId,
                "files": [],
                "error": "read_failed"
            ], path: normalizedPath, readFailed: true)
            return true
        }

        if data.count > Self.maxShareBytes {
            consumed = true
            dispatchOrEnqueue([
                "id": payloadId,
                "files": [],
                "error": "file_too_large"
            ], path: normalizedPath)
            return true
        }

        let fileEntry: [String: Any] = [
            "name": fileName,
            "mimeType": mimeType,
            "size": data.count,
            "base64": data.base64EncodedString()
        ]
        consumed = true
        dispatchOrEnqueue([
            "id": payloadId,
            "files": [fileEntry]
        ], path: normalizedPath)
        return true
    }

    private func dispatchOrEnqueue(_ payload: [String: Any], path normalizedPath: String, readFailed: Bool = false) {
        let now = Date().timeIntervalSince1970
        self.lock.lock()
        // The reservation already owns this slot; release+publish is atomic.
        self.inFlightPaths.remove(normalizedPath)
        self.pendingPaths.insert(normalizedPath)
        self.pendingShares.append(payload)
        if readFailed { self.failedInboxPaths.insert(normalizedPath) }
        else { self.recentHandledPaths[normalizedPath] = now }
        self.lock.unlock()

        let deliverAction = { [weak self] in
            guard let self = self, self.bridge != nil else { return }
            self.notifyListeners("sharedPayload", data: payload)
            self.bridge?.webView?.evaluateJavaScript("window.__imcodesConsumePendingShares?.()", completionHandler: nil)
        }
        if Thread.isMainThread {
            deliverAction()
        } else {
            DispatchQueue.main.async(execute: deliverAction)
        }
    }

    public func flushToWebView() {
        let flushAction = { [weak self] in
            guard let self = self else { return }
            self.bridge?.webView?.evaluateJavaScript("window.__imcodesConsumePendingShares?.()", completionHandler: nil)
        }
        if Thread.isMainThread {
            flushAction()
        } else {
            DispatchQueue.main.async(execute: flushAction)
        }
    }

    @objc func consumePendingShares(_ call: CAPPluginCall) {
        lock.lock()
        let items = pendingShares
        pendingShares.removeAll()
        pendingPaths.removeAll()
        lock.unlock()
        call.resolve(["items": items])
        // Errors can also represent real disk progress (oversize was consumed).
        // Retry the remaining disk backlog whenever slots are released; retained
        // read failures are skipped until an explicit activation/open retries them.
        if !items.isEmpty { drainInboxFilesIfNeeded(retryFailures: false) }
    }

    private static func inferMimeType(for url: URL) -> String {
        let ext = url.pathExtension.lowercased()
        if !ext.isEmpty, #available(iOS 14.0, *) {
            if let utType = UTType(filenameExtension: ext),
               let mime = utType.preferredMIMEType {
                return mime
            }
        }
        return "application/octet-stream"
    }
}
