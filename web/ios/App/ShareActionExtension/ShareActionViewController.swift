import UIKit
import UniformTypeIdentifiers
import UserNotifications

private struct ShareBatchManifest: Encodable {
    let version: Int
    let text: String?
    let files: [String]
}

/// Shared entry controller used by both `ShareExtension` (`com.apple.share-services`)
/// and `ShareActionExtension` (`com.apple.ui-services`).
final class ShareActionViewController: UIViewController {
    private static let appGroupIdentifier = "group.com.im.codes"
    private static let maxAttachments = 20

    private var started = false
    private var didPresentCompletion = false
    private let fileManager = FileManager.default

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        importSharedItems()
    }

    private func importSharedItems() {
        let extensionItems = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        var itemLevelTexts: [String] = []
        for item in extensionItems {
            if let title = item.attributedTitle?.string.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
                itemLevelTexts.append(title)
            }
            if let content = item.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines), !content.isEmpty {
                itemLevelTexts.append(content)
            }
        }
        let providers = extensionItems.flatMap { $0.attachments ?? [] }
        guard (!providers.isEmpty || !itemLevelTexts.isEmpty),
              providers.count <= Self.maxAttachments,
              let container = fileManager.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroupIdentifier) else {
            fail(); return
        }

        let inbox = container.appendingPathComponent("SharedInbox", isDirectory: true)
        let batch = UUID().uuidString
        let staging = inbox.appendingPathComponent(".pending-" + batch, isDirectory: true)
        do { try fileManager.createDirectory(at: staging, withIntermediateDirectories: true) }
        catch { fail(); return }

        let group = DispatchGroup()
        let lock = NSLock()
        var capturedFiles: [(index: Int, relativePath: String)] = []
        var capturedTexts: [(index: Int, order: Int, value: String)] = []

        let recordFile: (Int, String) -> Void = { index, relativePath in
            lock.lock()
            capturedFiles.append((index: index, relativePath: relativePath))
            lock.unlock()
        }
        let recordText: (Int, Int, String) -> Void = { index, order, raw in
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            lock.lock()
            capturedTexts.append((index: index, order: order, value: trimmed))
            lock.unlock()
        }

        for (index, provider) in providers.enumerated() {
            let folderName = String(index)
            let destination = staging.appendingPathComponent(folderName, isDirectory: true)
            self.extractProvider(
                provider,
                index: index,
                destination: destination,
                folderName: folderName,
                group: group,
                recordFile: recordFile,
                recordText: recordText
            )
        }

        group.notify(queue: .main) {
            let orderedFiles = capturedFiles
                .sorted { $0.index < $1.index }
                .map(\.relativePath)

            var orderedTextCandidates = itemLevelTexts
            orderedTextCandidates.append(
                contentsOf: capturedTexts
                    .sorted { ($0.index, $0.order) < ($1.index, $1.order) }
                    .map(\.value)
            )
            var seenTexts = Set<String>()
            var uniqueTexts: [String] = []
            for snippet in orderedTextCandidates {
                let trimmed = snippet.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty, seenTexts.insert(trimmed).inserted else { continue }
                uniqueTexts.append(trimmed)
            }
            let combinedText: String? = uniqueTexts.isEmpty ? nil : uniqueTexts.joined(separator: "\n")

            guard !orderedFiles.isEmpty || combinedText != nil else {
                try? self.fileManager.removeItem(at: staging)
                self.fail(); return
            }

            do {
                let manifest = ShareBatchManifest(version: 1, text: combinedText, files: orderedFiles)
                let manifestData = try JSONEncoder().encode(manifest)
                try manifestData.write(to: staging.appendingPathComponent("manifest.json"), options: .atomic)
                // Publish the whole batch atomically; the app ignores hidden staging dirs.
                try self.fileManager.moveItem(at: staging, to: inbox.appendingPathComponent(batch, isDirectory: true))
            } catch {
                try? self.fileManager.removeItem(at: staging)
                self.fail(); return
            }

            let fileCount = orderedFiles.count
            // Schedule an immediate local notification banner so tapping it
            // wakes IM.codes directly (iOS 18 blocks Extension openURL calls).
            // Never block or fail completion if notification permission is denied.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                self?.presentCompletionAlert(fileCount: fileCount)
            }
            self.scheduleShareNotification(fileCount: fileCount, batch: batch) { [weak self] in
                self?.presentCompletionAlert(fileCount: fileCount)
            }
        }
    }

    private func extractProvider(
        _ provider: NSItemProvider,
        index: Int,
        destination: URL,
        folderName: String,
        group: DispatchGroup,
        recordFile: @escaping (Int, String) -> Void,
        recordText: @escaping (Int, Int, String) -> Void
    ) {
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            group.enter()
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                defer { group.leave() }
                if let url = item as? URL {
                    if url.isFileURL {
                        if let rel = self.copy(url, to: destination, folderName: folderName, fallbackName: "shared-file-\(index)") {
                            recordFile(index, rel)
                        }
                    } else {
                        recordText(index, 1, url.absoluteString)
                    }
                }
            }
            return
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            let imageTypeId = firstMatchingIdentifier(in: provider, conformingTo: [.image]) ?? UTType.image.identifier
            let preferredExt = UTType(imageTypeId)?.preferredFilenameExtension ?? "png"
            group.enter()
            provider.loadFileRepresentation(forTypeIdentifier: imageTypeId) { url, _ in
                if let url,
                   let rel = self.copy(url, to: destination, folderName: folderName, fallbackName: "shared-image-\(index).\(preferredExt)", preferredExtension: preferredExt) {
                    recordFile(index, rel)
                    group.leave()
                    return
                }
                provider.loadItem(forTypeIdentifier: imageTypeId, options: nil) { item, _ in
                    defer { group.leave() }
                    if let url = item as? URL {
                        if url.isFileURL {
                            if let rel = self.copy(url, to: destination, folderName: folderName, fallbackName: "shared-image-\(index).\(preferredExt)", preferredExtension: preferredExt) {
                                recordFile(index, rel)
                            }
                        } else {
                            recordText(index, 1, url.absoluteString)
                        }
                    } else if let image = item as? UIImage {
                        if let png = image.pngData(),
                           let rel = self.writeData(png, to: destination, folderName: folderName, filename: "shared-image-\(index).png") {
                            recordFile(index, rel)
                        } else if let jpg = image.jpegData(compressionQuality: 0.92),
                                  let rel = self.writeData(jpg, to: destination, folderName: folderName, filename: "shared-image-\(index).jpg") {
                            recordFile(index, rel)
                        }
                    } else if let data = item as? Data,
                              let rel = self.writeData(data, to: destination, folderName: folderName, filename: "shared-image-\(index).\(preferredExt)") {
                        recordFile(index, rel)
                    }
                }
            }
            return
        }

        if let mediaTypeId = firstMatchingIdentifier(in: provider, conformingTo: [.movie, .audio]) {
            let preferredExt = UTType(mediaTypeId)?.preferredFilenameExtension
            let baseFallback = UTType(mediaTypeId)?.conforms(to: .movie) == true ? "shared-video-\(index)" : "shared-audio-\(index)"
            let fallbackName = preferredExt.map { "\(baseFallback).\($0)" } ?? baseFallback
            group.enter()
            provider.loadFileRepresentation(forTypeIdentifier: mediaTypeId) { url, _ in
                defer { group.leave() }
                if let url,
                   let rel = self.copy(url, to: destination, folderName: folderName, fallbackName: fallbackName, preferredExtension: preferredExt) {
                    recordFile(index, rel)
                }
            }
            return
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            group.enter()
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                defer { group.leave() }
                if let url = item as? URL {
                    if url.isFileURL {
                        if let rel = self.copy(url, to: destination, folderName: folderName, fallbackName: "shared-file-\(index)") {
                            recordFile(index, rel)
                        }
                    } else {
                        recordText(index, 1, url.absoluteString)
                    }
                } else if let str = item as? String {
                    recordText(index, 1, str)
                } else if let data = item as? Data, let str = String(data: data, encoding: .utf8) {
                    recordText(index, 1, str)
                }
            }
            if let textTypeId = firstMatchingIdentifier(in: provider, conformingTo: [.plainText, .text]) {
                group.enter()
                provider.loadItem(forTypeIdentifier: textTypeId, options: nil) { item, _ in
                    defer { group.leave() }
                    if let text = self.extractText(from: item) {
                        recordText(index, 0, text)
                    }
                }
            }
            return
        }

        if let textTypeId = firstMatchingIdentifier(in: provider, conformingTo: [.plainText, .text]) {
            group.enter()
            provider.loadItem(forTypeIdentifier: textTypeId, options: nil) { item, _ in
                defer { group.leave() }
                if let text = self.extractText(from: item) {
                    recordText(index, 0, text)
                }
            }
            return
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) {
            group.enter()
            provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier, options: nil) { item, _ in
                defer { group.leave() }
                guard let root = item as? [AnyHashable: Any] else { return }
                let dict = (root[NSExtensionJavaScriptPreprocessingResultsKey] as? [AnyHashable: Any]) ?? root
                for key in ["title", "selection", "text"] {
                    if let val = dict[key] as? String {
                        recordText(index, 0, val)
                    }
                }
                for key in ["URL", "url"] {
                    if let val = dict[key] as? String {
                        recordText(index, 1, val)
                    } else if let url = dict[key] as? URL, !url.isFileURL {
                        recordText(index, 1, url.absoluteString)
                    }
                }
            }
            return
        }

        if let dataTypeId = firstMatchingIdentifier(in: provider, conformingTo: [.data, .content, .item]) {
            let preferredExt = UTType(dataTypeId)?.preferredFilenameExtension
            let fallbackName = preferredExt.map { "shared-file-\(index).\($0)" } ?? "shared-file-\(index)"
            group.enter()
            provider.loadFileRepresentation(forTypeIdentifier: dataTypeId) { url, _ in
                defer { group.leave() }
                if let url,
                   let rel = self.copy(url, to: destination, folderName: folderName, fallbackName: fallbackName, preferredExtension: preferredExt) {
                    recordFile(index, rel)
                }
            }
        }
    }

    private func firstMatchingIdentifier(in provider: NSItemProvider, conformingTo targets: [UTType]) -> String? {
        for target in targets {
            if let match = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: target) == true }) {
                return match
            }
        }
        return nil
    }

    private func extractText(from item: Any?) -> String? {
        if let text = item as? String {
            return text
        }
        if let attr = item as? NSAttributedString {
            return attr.string
        }
        if let data = item as? Data, let decoded = String(data: data, encoding: .utf8) {
            return decoded
        }
        if let url = item as? URL, !url.isFileURL {
            return url.absoluteString
        }
        return nil
    }

    private func scheduleShareNotification(fileCount: Int, batch: String, completion: @escaping () -> Void) {
        let center = UNUserNotificationCenter.current()
        let finish: () -> Void = {
            DispatchQueue.main.async {
                completion()
            }
        }
        let enqueue: () -> Void = {
            let content = UNMutableNotificationContent()
            content.title = self.localized("CFBundleDisplayName")
            content.body = fileCount > 0
                ? String(format: self.localized("share.notificationBody"), fileCount)
                : self.localized("share.notificationBodyText")
            content.sound = .default
            content.userInfo = [
                "type": "share-inbox",
                "batch": batch,
                "fileCount": fileCount
            ]
            let request = UNNotificationRequest(
                identifier: "imcodes.share.\(batch)",
                content: content,
                trigger: nil
            )
            center.add(request) { _ in
                finish()
            }
        }
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                enqueue()
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    if granted {
                        enqueue()
                    } else {
                        finish()
                    }
                }
            default:
                finish()
            }
        }
    }

    private func presentCompletionAlert(fileCount: Int) {
        guard !didPresentCompletion else { return }
        didPresentCompletion = true
        let alert = UIAlertController(
            title: localized("CFBundleDisplayName"),
            message: fileCount > 0 ? localized("share.openApp") : localized("share.openAppText"),
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: localized("share.done"), style: .default) { _ in
            self.extensionContext?.completeRequest(returningItems: nil)
        })
        present(alert, animated: true)
    }

    private func resolvedFilename(sourceName: String, fallbackName: String, preferredExtension: String?) -> String {
        let candidate = sourceName.trimmingCharacters(in: .whitespacesAndNewlines)
        var name = candidate.isEmpty ? fallbackName : candidate
        if URL(fileURLWithPath: name).pathExtension.isEmpty,
           let ext = preferredExtension?.trimmingCharacters(in: .whitespacesAndNewlines),
           !ext.isEmpty {
            name += ".\(ext)"
        }
        return name
    }

    private func copy(
        _ source: URL,
        to directory: URL,
        folderName: String,
        fallbackName: String,
        preferredExtension: String? = nil
    ) -> String? {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        do {
            let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else { return nil }
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            let filename = resolvedFilename(
                sourceName: source.lastPathComponent,
                fallbackName: fallbackName,
                preferredExtension: preferredExtension
            )
            try fileManager.copyItem(at: source, to: directory.appendingPathComponent(filename))
            return "\(folderName)/\(filename)"
        } catch { return nil }
    }

    private func writeData(
        _ data: Data,
        to directory: URL,
        folderName: String,
        filename: String
    ) -> String? {
        do {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: directory.appendingPathComponent(filename), options: .atomic)
            return "\(folderName)/\(filename)"
        } catch { return nil }
    }

    private func localized(_ key: String) -> String {
        NSLocalizedString(key, tableName: "InfoPlist", bundle: .main, comment: "")
    }

    private func fail() {
        extensionContext?.cancelRequest(withError: NSError(domain: "com.im.codes.ShareAction", code: 1, userInfo: [NSLocalizedDescriptionKey: localized("share.error")]))
    }
}
