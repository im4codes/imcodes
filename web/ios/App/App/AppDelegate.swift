import UIKit
import Capacitor
import UserNotifications
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?
    private var didRegisterLocalPlugins = false

    override init() {
        super.init()
        Self.reconcileCachedOtaBundles()
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        if Self.reconcileCachedOtaBundles(),
           let builtinPublic = Bundle.main.resourceURL?.appendingPathComponent("public"),
           let vc = window?.rootViewController as? CAPBridgeViewController {
            vc.setServerBasePath(path: builtinPublic.path)
        }
        // Set notification delegate so push notifications display in foreground
        UNUserNotificationCenter.current().delegate = self

        WatchBridge.shared.activate()

        self.registerLocalPluginsIfNeeded()
        ShareReceiverPlugin.shared.drainInboxFilesIfNeeded()
        if let launchURL = launchOptions?[.url] as? URL, launchURL.isFileURL {
            _ = ShareReceiverPlugin.shared.handleIncomingFileURL(launchURL)
        }

        // Register local Capacitor plugins after the bridge initializes
        DispatchQueue.main.async {
            self.registerLocalPluginsIfNeeded()
            ShareReceiverPlugin.shared.flushToWebView()
        }
        return true
    }

    // Show push notifications even when app is in foreground
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        if Self.isShareInboxNotification(notification.request) {
            self.handleShareInboxNotification()
        }
        completionHandler([.banner, .sound, .badge])
    }

    // Drain SharedInbox and flush to WebView when user taps a local share notification banner
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if Self.isShareInboxNotification(response.notification.request) {
            self.handleShareInboxNotification()
        } else {
            self.registerLocalPluginsIfNeeded()
            ShareReceiverPlugin.shared.drainInboxFilesIfNeeded()
            ShareReceiverPlugin.shared.flushToWebView()
        }
        completionHandler()
    }

    static func isShareInboxNotification(_ request: UNNotificationRequest) -> Bool {
        if request.identifier.hasPrefix("imcodes.share.") {
            return true
        }
        if let type = request.content.userInfo["type"] as? String, type == "share-inbox" {
            return true
        }
        return false
    }

    private func handleShareInboxNotification() {
        self.registerLocalPluginsIfNeeded()
        ShareReceiverPlugin.shared.drainInboxFilesIfNeeded()
        ShareReceiverPlugin.shared.flushToWebView()
        DispatchQueue.main.async {
            self.registerLocalPluginsIfNeeded()
            ShareReceiverPlugin.shared.drainInboxFilesIfNeeded()
            ShareReceiverPlugin.shared.flushToWebView()
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Clear badge count on app icon
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(0)
        } else {
            application.applicationIconBadgeNumber = 0
        }

        WatchBridge.shared.activate()

        self.registerLocalPluginsIfNeeded()
        ShareReceiverPlugin.shared.drainInboxFilesIfNeeded()

        DispatchQueue.main.async {
            self.registerLocalPluginsIfNeeded()
            ShareReceiverPlugin.shared.flushToWebView()
        }

        // Notify server to reset badge counter
        self.resetBadgeOnServer()
        ShareReceiverPlugin.shared.flushToWebView()
    }

    private func resetBadgeOnServer() {
        // Use JS bridge function that calls apiFetch with correct baseUrl + Bearer token.
        // Relative URLs resolve to capacitor://localhost in WKWebView, not the server.
        guard let vc = window?.rootViewController as? CAPBridgeViewController,
              let bridge = vc.bridge else { return }

        bridge.webView?.evaluateJavaScript("window.__imcodesResetBadge?.()")
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    // ── Push Notifications ──────────────────────────────────────────────────
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        self.registerLocalPluginsIfNeeded()
        if url.isFileURL {
            let handled = ShareReceiverPlugin.shared.handleIncomingFileURL(url)
            ShareReceiverPlugin.shared.drainInboxFilesIfNeeded()
            return handled
        }
        if url.scheme?.lowercased() == "imcodes", url.host?.lowercased() == "share-inbox" {
            ShareReceiverPlugin.shared.drainInboxFilesIfNeeded()
            ShareReceiverPlugin.shared.flushToWebView()
            return true
        }
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    private func registerLocalPluginsIfNeeded() {
        guard !didRegisterLocalPlugins else { return }
        guard let vc = window?.rootViewController as? CAPBridgeViewController,
              let bridge = vc.bridge else {
            return
        }

        bridge.registerPluginInstance(AuthSessionPlugin())
        bridge.registerPluginInstance(WatchBridgePlugin())
        bridge.registerPluginInstance(ShareReceiverPlugin.shared)
        configureInputChrome(bridge.webView)
        didRegisterLocalPlugins = true
    }

    /// Removes the leading/trailing shortcuts-bar button groups -- the
    /// Previous/Next field-navigation chevrons and Done/checkmark button
    /// WebKit draws above the keyboard for any focused text field -- from
    /// every text field in the app's single WKWebView. `UITextInputAssistantItem`
    /// is the Apple-documented, native-only extension point for that bar;
    /// there is no equivalent web/JS API, so this cannot be done from `web/`
    /// itself. This used to run only for the iOS-app-on-Mac idiom, but the
    /// exact same bar shows up identically on a real iPhone/iPad, so it now
    /// always runs.
    private func configureInputChrome(_ webView: WKWebView?) {
        if let builtinPublic = Bundle.main.resourceURL?.appendingPathComponent("public"),
           let manifest = Self.readBuildManifest(in: builtinPublic),
           let payloadData = try? JSONSerialization.data(withJSONObject: [
               "buildId": manifest.buildId,
               "buildTime": manifest.buildTime
           ]),
           let payloadJson = String(data: payloadData, encoding: .utf8) {
            let script = "window.__IMCODES_NATIVE_BUILD_INFO__ = \(payloadJson);"
            let userScript = WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            webView?.configuration.userContentController.addUserScript(userScript)
            webView?.evaluateJavaScript(script, completionHandler: nil)
        }
        guard #available(iOS 14.0, *) else { return }
        webView?.inputAssistantItem.leadingBarButtonGroups = []
        webView?.inputAssistantItem.trailingBarButtonGroups = []
        webView?.scrollView.keyboardDismissMode = .interactive
    }

    private static let nativeBundledBuildIdKey = "imcodes_native_bundled_build_id"
    private static let nativeBundledBuildTimeKey = "imcodes_native_bundled_build_time"
    private static let capgoServerBasePathKey = "serverBasePath"
    private static let capgoFallbackVersionKey = "pastVersion"
    private static let capgoNextVersionKey = "nextVersion"
    private static let capgoLastFailedBundleKey = "CapacitorUpdater.lastFailedBundle"
    private static let capgoLatestNativeBuildKey = "LatestNativeBuildVersion"
    private static let capacitorOtaVersionPrefsKey = "CapacitorStorage.deck_ota_version"
    private static let capgoSnapshotsSubpath = "NoCloud/ionic_built_snapshots"

    struct BuildManifestInfo {
        let buildId: String
        let buildTime: String
        let timestamp: Date
    }

    static func parseIso8601Date(_ raw: String) -> Date? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: trimmed) {
            return date
        }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: trimmed)
    }

    static func readBuildManifest(in directoryURL: URL?, fileManager: FileManager = .default) -> BuildManifestInfo? {
        guard let directoryURL = directoryURL else { return nil }
        let manifestURL = directoryURL.appendingPathComponent("app-build.json")
        guard fileManager.fileExists(atPath: manifestURL.path),
              let data = try? Data(contentsOf: manifestURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        let rawTime = (json["buildTime"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? (json["builtAt"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? ""
        guard let timestamp = parseIso8601Date(rawTime) else {
            return nil
        }
        let buildId = (json["buildId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return BuildManifestInfo(buildId: buildId, buildTime: rawTime, timestamp: timestamp)
    }

    @discardableResult
    static func reconcileCachedOtaBundles(
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default,
        builtinPublicURL: URL? = Bundle.main.resourceURL?.appendingPathComponent("public"),
        libraryURL: URL? = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first,
        nativeBuildVersion: String = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
    ) -> Bool {
        guard let builtinManifest = readBuildManifest(in: builtinPublicURL, fileManager: fileManager),
              let libraryURL = libraryURL else {
            return false
        }

        let snapshotsDir = libraryURL.appendingPathComponent(capgoSnapshotsSubpath)

        func isCompatibleAndNewerOtaBundle(_ bundleId: String) -> Bool {
            let trimmed = bundleId.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || trimmed == "builtin" || trimmed == "unknown" {
                return false
            }
            let bundleDir = snapshotsDir.appendingPathComponent(trimmed)
            let indexURL = bundleDir.appendingPathComponent("index.html")
            guard fileManager.fileExists(atPath: indexURL.path),
                  let otaManifest = readBuildManifest(in: bundleDir, fileManager: fileManager) else {
                return false
            }
            return otaManifest.timestamp > builtinManifest.timestamp
        }

        func recordRejectedBundleVersionIfPresent(_ bundleId: String) {
            guard let infoData = defaults.data(forKey: "\(bundleId)_info"),
                  let infoJson = try? JSONSerialization.jsonObject(with: infoData) as? [String: Any],
                  let versionStr = (infoJson["version"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  let versionNum = Int(versionStr),
                  versionNum > 0 else {
                return
            }
            let currentStored = Int(defaults.string(forKey: capacitorOtaVersionPrefsKey) ?? "0") ?? 0
            if versionNum > currentStored {
                defaults.set(String(versionNum), forKey: capacitorOtaVersionPrefsKey)
            }
        }

        var didReset = false

        let serverBasePath = defaults.string(forKey: capgoServerBasePathKey) ?? ""
        if !serverBasePath.isEmpty {
            let activeId = URL(fileURLWithPath: serverBasePath).lastPathComponent
            if !isCompatibleAndNewerOtaBundle(activeId) {
                recordRejectedBundleVersionIfPresent(activeId)
                defaults.set("", forKey: capgoServerBasePathKey)
                defaults.set("builtin", forKey: capgoFallbackVersionKey)
                defaults.removeObject(forKey: capgoNextVersionKey)
                defaults.removeObject(forKey: capgoLastFailedBundleKey)
                didReset = true
            }
        }

        if let pastVersion = defaults.string(forKey: capgoFallbackVersionKey),
           !pastVersion.isEmpty,
           pastVersion != "builtin",
           !isCompatibleAndNewerOtaBundle(pastVersion) {
            recordRejectedBundleVersionIfPresent(pastVersion)
            defaults.set("builtin", forKey: capgoFallbackVersionKey)
            didReset = true
        }

        if let nextVersion = defaults.string(forKey: capgoNextVersionKey),
           !nextVersion.isEmpty,
           !isCompatibleAndNewerOtaBundle(nextVersion) {
            recordRejectedBundleVersionIfPresent(nextVersion)
            defaults.removeObject(forKey: capgoNextVersionKey)
            didReset = true
        }

        if fileManager.fileExists(atPath: snapshotsDir.path),
           let entries = try? fileManager.contentsOfDirectory(at: snapshotsDir, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) {
            for entryURL in entries {
                let isDir = (try? entryURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
                guard isDir else { continue }
                let bundleId = entryURL.lastPathComponent
                if !isCompatibleAndNewerOtaBundle(bundleId) {
                    recordRejectedBundleVersionIfPresent(bundleId)
                    try? fileManager.removeItem(at: entryURL)
                    defaults.removeObject(forKey: "\(bundleId)_info")
                    didReset = true
                }
            }
        }

        defaults.set(builtinManifest.buildId, forKey: nativeBundledBuildIdKey)
        defaults.set(builtinManifest.buildTime, forKey: nativeBundledBuildTimeKey)
        if !nativeBuildVersion.isEmpty && nativeBuildVersion != "0" {
            defaults.set(nativeBuildVersion, forKey: capgoLatestNativeBuildKey)
        }
        defaults.synchronize()
        return didReset
    }

}
