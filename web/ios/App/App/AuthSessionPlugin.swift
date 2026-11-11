import Capacitor
import AuthenticationServices
import Foundation
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
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { callbackURL, error in
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
            self?.session = session
            session.start()
        }
    }
}

extension AuthSessionPlugin: ASWebAuthenticationPresentationContextProviding {
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return self.bridge?.webView?.window ?? UIWindow()
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

    public func drainInboxFilesIfNeeded() {
        lock.lock()
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
                if rescan { self.drainInboxFilesIfNeeded() }
            }
            for root in self.inboxRoots {
                guard let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .isDirectoryKey], options: []) else { continue }
                for case let file as URL in files {
                    self.lock.lock(); let full = self.pendingShares.count >= Self.maxPendingShares; self.lock.unlock()
                    if full { return } // Leave overflow on disk for consumePendingShares' next pass.
                    guard let info = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .isDirectoryKey]) else { continue }
                    // Only unpublished extension batches are reserved; a shared .env
                    // or another hidden regular file is still a legitimate attachment.
                    if root.lastPathComponent == "SharedInbox", info.isDirectory == true,
                       file.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL,
                       file.lastPathComponent.hasPrefix(".pending-") {
                        files.skipDescendants()
                        continue
                    }
                    guard self.isManagedInboxFile(file), info.isRegularFile == true,
                          info.isSymbolicLink != true else { continue }
                    _ = self.handleIncomingFileURL(file)
                }
            }
        }
    }

    @discardableResult
    public func handleIncomingFileURL(_ url: URL) -> Bool {
        guard url.isFileURL else { return false }

        let normalizedPath = url.standardizedFileURL.path
        let now = Date().timeIntervalSince1970
        lock.lock()
        recentHandledPaths = recentHandledPaths.filter { (_, timestamp) in
            (now - timestamp) < Self.duplicatePathDebounceInterval
        }
        if let lastHandledAt = recentHandledPaths[normalizedPath],
           (now - lastHandledAt) < Self.duplicatePathDebounceInterval {
            lock.unlock()
            return true
        }
        recentHandledPaths[normalizedPath] = now
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
            ])
            return true
        }

        guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else {
            dispatchOrEnqueue([
                "id": payloadId,
                "files": [],
                "error": "read_failed"
            ])
            return true
        }

        if data.count > Self.maxShareBytes {
            consumed = true
            dispatchOrEnqueue([
                "id": payloadId,
                "files": [],
                "error": "file_too_large"
            ])
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
        ])
        return true
    }

    private func dispatchOrEnqueue(_ payload: [String: Any]) {
        self.lock.lock()
        let payloadId = payload["id"] as? String
        if let payloadId = payloadId {
            self.pendingShares.removeAll { ($0["id"] as? String) == payloadId }
        }
        self.pendingShares.append(payload)
        if self.pendingShares.count > Self.maxPendingShares {
            self.pendingShares.removeFirst(self.pendingShares.count - Self.maxPendingShares)
        }
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
        lock.unlock()
        call.resolve(["items": items])
        // Refill capacity after successful delivery, but don't turn an
        // unreadable retained file into an automatic error/retry loop.
        if items.contains(where: { $0["error"] == nil }) { drainInboxFilesIfNeeded() }
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
