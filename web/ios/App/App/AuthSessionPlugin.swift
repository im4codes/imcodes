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
    private var lastHandledPath: String?
    private var lastHandledAt: TimeInterval = 0

    @discardableResult
    public func handleIncomingFileURL(_ url: URL) -> Bool {
        guard url.isFileURL else { return false }

        let normalizedPath = url.standardizedFileURL.path
        let now = Date().timeIntervalSince1970
        lock.lock()
        if let lastPath = lastHandledPath,
           lastPath == normalizedPath,
           (now - lastHandledAt) < Self.duplicatePathDebounceInterval {
            lock.unlock()
            return true
        }
        lastHandledPath = normalizedPath
        lastHandledAt = now
        lock.unlock()

        let accessed = url.startAccessingSecurityScopedResource()
        defer {
            if accessed {
                url.stopAccessingSecurityScopedResource()
            }
            if url.path.contains("/Documents/Inbox/") || url.path.contains("-Inbox/") {
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
