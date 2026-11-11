import UIKit
import UniformTypeIdentifiers

/// An Action extension, not a Share extension: appears in the vertical actions list.
final class ShareActionViewController: UIViewController {
    private var started = false
    private let fileManager = FileManager.default

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        importFiles()
    }

    private func importFiles() {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        guard !providers.isEmpty, providers.count <= 20,
              let container = fileManager.containerURL(forSecurityApplicationGroupIdentifier: "group.com.im.codes") else {
            fail(); return
        }
        let inbox = container.appendingPathComponent("SharedInbox", isDirectory: true)
        let batch = UUID().uuidString
        let staging = inbox.appendingPathComponent(".pending-" + batch, isDirectory: true)
        do { try fileManager.createDirectory(at: staging, withIntermediateDirectories: true) }
        catch { fail(); return }
        let group = DispatchGroup(), lock = NSLock()
        var failed = false
        for (index, provider) in providers.enumerated() {
            group.enter()
            let destination = staging.appendingPathComponent(String(index), isDirectory: true)
            do { try fileManager.createDirectory(at: destination, withIntermediateDirectories: true) }
            catch { lock.lock(); failed = true; lock.unlock(); group.leave(); continue }
            let complete: (Bool) -> Void = { success in
                if !success { lock.lock(); failed = true; lock.unlock() }
                group.leave()
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                    guard let url = item as? URL, url.isFileURL else { complete(false); return }
                    complete(self.copy(url, to: destination))
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                    guard let url = item as? URL else { complete(false); return }
                    do {
                        try Data(url.absoluteString.utf8).write(to: destination.appendingPathComponent("link.txt"), options: .atomic)
                        complete(true)
                    } catch { complete(false) }
                }
            } else if let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) == true }) {
                provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                    // The temporary URL expires when this callback returns.
                    complete(url.map { self.copy($0, to: destination) } ?? false)
                }
            } else { complete(false) }
        }
        group.notify(queue: .main) {
            if failed {
                try? self.fileManager.removeItem(at: staging)
                self.fail(); return
            }
            do {
                // Publish the whole batch atomically; the app ignores hidden staging dirs.
                try self.fileManager.moveItem(at: staging, to: inbox.appendingPathComponent(batch, isDirectory: true))
            } catch {
                try? self.fileManager.removeItem(at: staging)
                self.fail(); return
            }
            self.extensionContext?.open(URL(string: "imcodes://share-inbox")!) { opened in
                DispatchQueue.main.async {
                    if opened { self.extensionContext?.completeRequest(returningItems: nil) }
                    else {
                        // Action extensions may not open the app on iOS. Never lose the
                        // queued files or pretend launch succeeded: next activation drains them.
                        let alert = UIAlertController(title: self.localized("CFBundleDisplayName"), message: self.localized("share.openApp"), preferredStyle: .alert)
                        alert.addAction(UIAlertAction(title: self.localized("share.done"), style: .default) { _ in
                            self.extensionContext?.completeRequest(returningItems: nil)
                        })
                        self.present(alert, animated: true)
                    }
                }
            }
        }
    }

    private func copy(_ source: URL, to directory: URL) -> Bool {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        do {
            let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else { return false }
            try fileManager.copyItem(at: source, to: directory.appendingPathComponent(source.lastPathComponent))
            return true
        } catch { return false }
    }

    private func localized(_ key: String) -> String {
        NSLocalizedString(key, tableName: "InfoPlist", bundle: .main, comment: "")
    }

    private func fail() {
        extensionContext?.cancelRequest(withError: NSError(domain: "com.im.codes.ShareAction", code: 1, userInfo: [NSLocalizedDescriptionKey: localized("share.error")]))
    }
}
