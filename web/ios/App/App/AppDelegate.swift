import UIKit
import Capacitor
import UserNotifications
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?
    private var didRegisterLocalPlugins = false
    private var configuredWebViewId: ObjectIdentifier?
    private var keyboardObserverTokens: [NSObjectProtocol] = []
    private var windowBoundsObservation: NSKeyValueObservation?
    private var observedWindowId: ObjectIdentifier?
    private var lastKeyboardScreenFrame: CGRect?
    private var lastMacBottomInsetPt: Double = 0
    // #080d16 (--chrome-bg) — prevents light/black host flashes during macOS Space transitions.
    private static let macHostBackgroundColor = UIColor(red: 8.0 / 255.0, green: 13.0 / 255.0, blue: 22.0 / 255.0, alpha: 1.0)

    override init() {
        super.init()
        Self.reconcileCachedOtaBundles()
    }

    deinit {
        for token in keyboardObserverTokens {
            NotificationCenter.default.removeObserver(token)
        }
        windowBoundsObservation?.invalidate()
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

        self.configureMacHostAppearance()
        self.registerLocalPluginsIfNeeded()
        ShareReceiverPlugin.shared.drainInboxFilesIfNeeded()
        if let launchURL = launchOptions?[.url] as? URL, launchURL.isFileURL {
            _ = ShareReceiverPlugin.shared.handleIncomingFileURL(launchURL)
        }

        // Register local Capacitor plugins after the bridge initializes
        DispatchQueue.main.async {
            self.configureMacHostAppearance()
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
        if Self.currentMacHostFlags().isMacDesktop {
            lastKeyboardScreenFrame = nil
            publishMacBottomInset(0)
        }
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
        self.configureMacHostAppearance()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Clear badge count on app icon
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(0)
        } else {
            application.applicationIconBadgeNumber = 0
        }

        WatchBridge.shared.activate()

        self.configureMacHostAppearance()
        self.registerLocalPluginsIfNeeded()
        ShareReceiverPlugin.shared.drainInboxFilesIfNeeded()

        DispatchQueue.main.async {
            self.configureMacHostAppearance()
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
        guard let vc = window?.rootViewController as? CAPBridgeViewController,
              let bridge = vc.bridge else {
            return
        }

        if !didRegisterLocalPlugins {
            bridge.registerPluginInstance(AuthSessionPlugin())
            bridge.registerPluginInstance(WatchBridgePlugin())
            bridge.registerPluginInstance(ShareReceiverPlugin.shared)
            bridge.registerPluginInstance(FileTransferKeepAlivePlugin())
            didRegisterLocalPlugins = true
        }

        if let webView = bridge.webView {
            let webViewId = ObjectIdentifier(webView)
            if configuredWebViewId != webViewId {
                configureInputChrome(webView)
                configuredWebViewId = webViewId
            } else {
                refreshMacHostSignal(webView)
            }
        }
    }

    static func isMacDesktopHost(isiOSAppOnMac: Bool, isMacCatalyst: Bool) -> Bool {
        isiOSAppOnMac || isMacCatalyst
    }

    static func shouldApplyDesignedForIpadPageZoom(
        isiOSAppOnMac: Bool,
        isMacCatalyst: Bool,
        isMacIdiom: Bool
    ) -> Bool {
        isiOSAppOnMac || (isMacCatalyst && !isMacIdiom)
    }

    private static func currentMacHostFlags() -> (isMacDesktop: Bool, needsDesignedForIpadPageZoom: Bool) {
        let isiOSAppOnMac: Bool
        if #available(iOS 14.0, *) {
            isiOSAppOnMac = ProcessInfo.processInfo.isiOSAppOnMac
        } else {
            isiOSAppOnMac = false
        }
        #if targetEnvironment(macCatalyst)
        let isMacCatalyst = true
        #else
        let isMacCatalyst = false
        #endif
        let isMacIdiom: Bool
        if #available(iOS 14.0, *) {
            isMacIdiom = UIDevice.current.userInterfaceIdiom == .mac
        } else {
            isMacIdiom = false
        }
        return (
            isMacDesktop: isMacDesktopHost(isiOSAppOnMac: isiOSAppOnMac, isMacCatalyst: isMacCatalyst),
            needsDesignedForIpadPageZoom: shouldApplyDesignedForIpadPageZoom(
                isiOSAppOnMac: isiOSAppOnMac,
                isMacCatalyst: isMacCatalyst,
                isMacIdiom: isMacIdiom
            )
        )
    }

    private func configureMacHostAppearance(webView: WKWebView? = nil) {
        guard #available(iOS 14.0, *), ProcessInfo.processInfo.isiOSAppOnMac else { return }
        let bg = Self.macHostBackgroundColor
        window?.backgroundColor = bg
        if let rootVC = window?.rootViewController {
            rootVC.view.backgroundColor = bg
        }
        let targetWebView = webView ?? (window?.rootViewController as? CAPBridgeViewController)?.bridge?.webView
        if let targetWebView {
            targetWebView.backgroundColor = bg
            targetWebView.scrollView.backgroundColor = bg
            if #available(iOS 15.0, *) {
                targetWebView.underPageBackgroundColor = bg
            }
        }
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
    private func buildNativeHostSignalScript() -> String {
        let hostFlags = Self.currentMacHostFlags()
        let pageZoomApplied = false
        let scaleMode: String
        if !hostFlags.isMacDesktop {
            scaleMode = "none"
        } else if hostFlags.needsDesignedForIpadPageZoom {
            scaleMode = "designed-for-ipad"
        } else {
            scaleMode = "native-1x"
        }

        var scripts: [String] = []
        if let builtinPublic = Bundle.main.resourceURL?.appendingPathComponent("public"),
           let manifest = Self.readBuildManifest(in: builtinPublic),
           let payloadData = try? JSONSerialization.data(withJSONObject: [
               "buildId": manifest.buildId,
               "buildTime": manifest.buildTime
           ]),
           let payloadJson = String(data: payloadData, encoding: .utf8) {
            scripts.append("window.__IMCODES_NATIVE_BUILD_INFO__ = \(payloadJson);")
        }
        let hostPayload: [String: Any] = [
            "isMacDesktop": hostFlags.isMacDesktop,
            "pageZoomApplied": pageZoomApplied,
            "scaleMode": scaleMode
        ]
        if let hostData = try? JSONSerialization.data(withJSONObject: hostPayload),
           let hostJson = String(data: hostData, encoding: .utf8) {
            scripts.append("""
            (function(){
              var next = \(hostJson);
              var prev = window.__IMCODES_NATIVE_HOST__;
              window.__IMCODES_NATIVE_HOST__ = next;
              if (!prev || prev.isMacDesktop !== next.isMacDesktop || prev.pageZoomApplied !== next.pageZoomApplied || prev.scaleMode !== next.scaleMode) {
                window.dispatchEvent(new CustomEvent('imcodes:native-host'));
              }
            })();
            """)
        }
        if hostFlags.isMacDesktop {
            scripts.append(Self.buildMacBottomInsetScript(insetPoints: lastMacBottomInsetPt))
        }
        return scripts.joined(separator: "\n")
    }

    private func refreshMacHostSignal(_ webView: WKWebView) {
        self.configureMacHostAppearance(webView: webView)
        self.observeMacWindowBoundsIfNeeded()
        Self.clearInputAssistantItems(for: webView)
        Self.installMacEmptyInputAccessoryIfNeeded(for: webView)
        let signalScript = buildNativeHostSignalScript()
        if !signalScript.isEmpty {
            webView.evaluateJavaScript(signalScript, completionHandler: nil)
        }
    }

    private func configureInputChrome(_ webView: WKWebView?) {
        self.configureMacHostAppearance(webView: webView)
        self.installInputChromeObserversIfNeeded()
        self.observeMacWindowBoundsIfNeeded()
        let signalScript = buildNativeHostSignalScript()
        if !signalScript.isEmpty {
            let userScript = WKUserScript(source: signalScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            webView?.configuration.userContentController.addUserScript(userScript)
            webView?.evaluateJavaScript(signalScript, completionHandler: nil)
        }
        guard #available(iOS 14.0, *) else { return }
        Self.clearInputAssistantItems(for: webView)
        Self.installMacEmptyInputAccessoryIfNeeded(for: webView)
        webView?.scrollView.keyboardDismissMode = .interactive
    }

    private final class MacEmptyInputAccessoryView: UIView {
        override var intrinsicContentSize: CGSize {
            CGSize(width: UIView.noIntrinsicMetric, height: 0)
        }
    }

    private static var macSuppressedInputClassIds = Set<ObjectIdentifier>()
    private static var macInputAccessoryAssocKey: UInt8 = 0

    /// Under `isiOSAppOnMac` ("Designed for iPad"), UIKit/WebKit still presents a bottom
    /// `UIInputSetHostView` (`UIKBBackdropView` + `UIInputView`, 17–44pt) on input focus when
    /// `WKContentView.inputAccessoryView` is `nil` or `WKContentView` repopulates
    /// `inputAssistantItem` on focus. Providing a zero-height `MacEmptyInputAccessoryView` and
    /// keeping `inputAssistantItem` empty on Mac desktop stops UIKit from raising the empty bar
    /// while leaving real iPhone/iPad behavior untouched.
    static func installMacEmptyInputAccessoryIfNeeded(for webView: WKWebView?) {
        guard #available(iOS 14.0, *), ProcessInfo.processInfo.isiOSAppOnMac, let webView else { return }
        let accSel = #selector(getter: UIResponder.inputAccessoryView)
        let asstSel = #selector(getter: UIResponder.inputAssistantItem)
        guard let baseAccMethod = class_getInstanceMethod(UIView.self, accSel) else { return }
        let baseAccImp = method_getImplementation(baseAccMethod)

        var firstResponderSubview: UIView?
        var didPatchAnyClass = false
        var visited = Set<ObjectIdentifier>()
        var stack: [UIView] = webView.scrollView.subviews
        while let current = stack.popLast() {
            guard visited.insert(ObjectIdentifier(current)).inserted else { continue }
            if current.isFirstResponder {
                firstResponderSubview = current
            }
            let cls: AnyClass = type(of: current)
            let clsId = ObjectIdentifier(cls)
            if cls !== UIView.self,
               !macSuppressedInputClassIds.contains(clsId),
               let accMethod = class_getInstanceMethod(cls, accSel),
               method_getImplementation(accMethod) != baseAccImp {
                macSuppressedInputClassIds.insert(clsId)
                didPatchAnyClass = true

                let accBlock: @convention(block) (AnyObject) -> UIView? = { responder in
                    if let existing = objc_getAssociatedObject(responder, &macInputAccessoryAssocKey) as? UIView {
                        return existing
                    }
                    let view = MacEmptyInputAccessoryView(frame: .zero)
                    view.isHidden = true
                    view.isUserInteractionEnabled = false
                    view.backgroundColor = .clear
                    objc_setAssociatedObject(responder, &macInputAccessoryAssocKey, view, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
                    return view
                }
                class_replaceMethod(
                    cls,
                    accSel,
                    imp_implementationWithBlock(accBlock),
                    method_getTypeEncoding(accMethod)
                )

                if let asstMethod = class_getInstanceMethod(cls, asstSel) {
                    let origImp = method_getImplementation(asstMethod)
                    typealias AsstFn = @convention(c) (AnyObject, Selector) -> UITextInputAssistantItem
                    let origFn = unsafeBitCast(origImp, to: AsstFn.self)
                    let asstBlock: @convention(block) (AnyObject) -> UITextInputAssistantItem = { responder in
                        let item = origFn(responder, asstSel)
                        if !item.leadingBarButtonGroups.isEmpty {
                            item.leadingBarButtonGroups = []
                        }
                        if !item.trailingBarButtonGroups.isEmpty {
                            item.trailingBarButtonGroups = []
                        }
                        if !item.allowsHidingShortcuts {
                            item.allowsHidingShortcuts = true
                        }
                        return item
                    }
                    class_replaceMethod(
                        cls,
                        asstSel,
                        imp_implementationWithBlock(asstBlock),
                        method_getTypeEncoding(asstMethod)
                    )
                }
            }
            stack.append(contentsOf: current.subviews)
        }

        if didPatchAnyClass {
            clearInputAssistantItems(for: webView)
            firstResponderSubview?.reloadInputViews()
        }
    }

    /// Recursively clears `UITextInputAssistantItem` shortcut bar button groups across
    /// `WKWebView`, its `scrollView`, and all descendant subviews (including `WKContentView`,
    /// which becomes the actual first responder when HTML inputs focus) using public UIKit APIs only.
    static func clearInputAssistantItems(for webView: WKWebView?) {
        guard #available(iOS 14.0, *), let webView else { return }
        var visited = Set<ObjectIdentifier>()
        var stack: [UIView] = [webView, webView.scrollView]
        while let current = stack.popLast() {
            let viewId = ObjectIdentifier(current)
            guard visited.insert(viewId).inserted else { continue }
            let assistant = current.inputAssistantItem
            assistant.leadingBarButtonGroups = []
            assistant.trailingBarButtonGroups = []
            assistant.allowsHidingShortcuts = true
            stack.append(contentsOf: current.subviews)
        }
    }

    /// Computes bottom-docked keyboard / input-assistant overlap in `rootVC.view` points on Mac.
    /// Detached floating IME candidate popups (not touching the bottom edge or narrow width) return `0`.
    static func computeMacBottomOverlapPoints(
        viewBounds: CGRect,
        convertedKeyboardFrame: CGRect,
        bottomEdgeTolerance: CGFloat = 2.0
    ) -> CGFloat {
        guard !viewBounds.isNull, !viewBounds.isInfinite,
              viewBounds.width > 0, viewBounds.height > 0,
              !convertedKeyboardFrame.isNull, !convertedKeyboardFrame.isInfinite,
              convertedKeyboardFrame.width > 0, convertedKeyboardFrame.height > 0 else {
            return 0
        }
        let intersection = viewBounds.intersection(convertedKeyboardFrame)
        guard !intersection.isNull, !intersection.isEmpty,
              intersection.width > 0, intersection.height > 0 else {
            return 0
        }
        guard intersection.maxY >= viewBounds.maxY - bottomEdgeTolerance else {
            return 0
        }
        guard intersection.width >= viewBounds.width * 0.5 else {
            return 0
        }
        let overlap = max(0, viewBounds.maxY - intersection.minY)
        guard overlap >= 1.0, overlap < viewBounds.height * 0.8 else {
            return 0
        }
        return (overlap * 100).rounded() / 100
    }

    static func buildMacBottomInsetScript(insetPoints: Double) -> String {
        let sanitized = insetPoints.isFinite && insetPoints > 0
            ? (insetPoints * 100).rounded() / 100
            : 0
        let formatted = String(format: "%.2f", sanitized)
        return """
        (function(){
          var next = Number(\(formatted));
          var prev = typeof window.__IMCODES_MAC_BOTTOM_INSET__ === 'number' ? window.__IMCODES_MAC_BOTTOM_INSET__ : -1;
          window.__IMCODES_MAC_BOTTOM_INSET__ = next;
          if (Math.abs(prev - next) > 0.01) {
            window.dispatchEvent(new CustomEvent('imcodes:mac-bottom-inset', { detail: { inset: next } }));
          }
        })();
        """
    }

    private func currentBridgeWebView() -> WKWebView? {
        (window?.rootViewController as? CAPBridgeViewController)?.bridge?.webView
    }

    private func publishMacBottomInset(_ insetPoints: Double) {
        let sanitized = insetPoints.isFinite && insetPoints > 0
            ? (insetPoints * 100).rounded() / 100
            : 0
        lastMacBottomInsetPt = sanitized
        guard Self.currentMacHostFlags().isMacDesktop,
              let webView = currentBridgeWebView() else {
            return
        }
        let script = Self.buildMacBottomInsetScript(insetPoints: sanitized)
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private func observeMacWindowBoundsIfNeeded() {
        guard Self.currentMacHostFlags().isMacDesktop,
              let win = window else {
            return
        }
        let winId = ObjectIdentifier(win)
        guard observedWindowId != winId else { return }
        observedWindowId = winId
        windowBoundsObservation?.invalidate()
        windowBoundsObservation = win.observe(\.bounds, options: [.old, .new]) { [weak self] _, change in
            guard change.oldValue?.size != change.newValue?.size else { return }
            DispatchQueue.main.async {
                self?.recomputeAndPublishMacBottomInset()
            }
        }
    }

    private func recomputeAndPublishMacBottomInset() {
        guard Self.currentMacHostFlags().isMacDesktop else { return }
        guard let rootView = window?.rootViewController?.view,
              let win = rootView.window ?? window,
              let screenFrame = lastKeyboardScreenFrame else {
            publishMacBottomInset(0)
            return
        }
        let convertedFrame = rootView.convert(screenFrame, from: win.screen.coordinateSpace)
        let overlapPt = Double(Self.computeMacBottomOverlapPoints(
            viewBounds: rootView.bounds,
            convertedKeyboardFrame: convertedFrame
        ))
        if overlapPt <= 0 {
            lastKeyboardScreenFrame = nil
        }
        publishMacBottomInset(overlapPt)
    }

    private func handleMacKeyboardFrameNotification(_ notification: Notification) {
        guard Self.currentMacHostFlags().isMacDesktop else { return }
        guard let frameValue = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue else {
            return
        }
        lastKeyboardScreenFrame = frameValue.cgRectValue
        recomputeAndPublishMacBottomInset()
    }

    private func installInputChromeObserversIfNeeded() {
        guard keyboardObserverTokens.isEmpty else { return }
        let center = NotificationCenter.default

        let willShow = center.addObserver(
            forName: UIResponder.keyboardWillShowNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self else { return }
            let webView = self.currentBridgeWebView()
            Self.clearInputAssistantItems(for: webView)
            Self.installMacEmptyInputAccessoryIfNeeded(for: webView)
            DispatchQueue.main.async { [weak self] in
                let wv = self?.currentBridgeWebView()
                Self.clearInputAssistantItems(for: wv)
                Self.installMacEmptyInputAccessoryIfNeeded(for: wv)
            }
            self.handleMacKeyboardFrameNotification(notification)
        }

        let willChange = center.addObserver(
            forName: UIResponder.keyboardWillChangeFrameNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self else { return }
            Self.clearInputAssistantItems(for: self.currentBridgeWebView())
            self.handleMacKeyboardFrameNotification(notification)
        }

        let didChange = center.addObserver(
            forName: UIResponder.keyboardDidChangeFrameNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self else { return }
            Self.clearInputAssistantItems(for: self.currentBridgeWebView())
            self.handleMacKeyboardFrameNotification(notification)
        }

        let willHide = center.addObserver(
            forName: UIResponder.keyboardWillHideNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.lastKeyboardScreenFrame = nil
            self.publishMacBottomInset(0)
        }

        let didHide = center.addObserver(
            forName: UIResponder.keyboardDidHideNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.lastKeyboardScreenFrame = nil
            self.publishMacBottomInset(0)
        }

        let textFieldBegin = center.addObserver(
            forName: UITextField.textDidBeginEditingNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Self.clearInputAssistantItems(for: self?.currentBridgeWebView())
        }

        let textViewBegin = center.addObserver(
            forName: UITextView.textDidBeginEditingNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Self.clearInputAssistantItems(for: self?.currentBridgeWebView())
        }

        keyboardObserverTokens = [
            willShow,
            willChange,
            didChange,
            willHide,
            didHide,
            textFieldBegin,
            textViewBegin
        ]
    }

    private static func nativeModifierName(for keyCode: UIKeyboardHIDUsage) -> String? {
        switch keyCode {
        case .keyboardLeftControl, .keyboardRightControl:
            return "ctrl"
        case .keyboardLeftAlt, .keyboardRightAlt:
            return "alt"
        case .keyboardLeftShift, .keyboardRightShift:
            return "shift"
        case .keyboardLeftGUI, .keyboardRightGUI:
            return "meta"
        default:
            return nil
        }
    }

    private func forwardNativeModifierPresses(_ presses: Set<UIPress>, phase: String) {
        guard Self.currentMacHostFlags().isMacDesktop else { return }
        guard let webView = (window?.rootViewController as? CAPBridgeViewController)?.bridge?.webView else { return }
        for press in presses {
            guard let key = press.key else { continue }
            var detail: [String: Any] = [
                "source": "native",
                "phase": phase
            ]
            if let modifier = Self.nativeModifierName(for: key.keyCode) {
                detail["modifier"] = modifier
            } else if phase == "down" {
                detail["phase"] = "other"
            } else {
                continue
            }
            guard let data = try? JSONSerialization.data(withJSONObject: detail),
                  let json = String(data: data, encoding: .utf8) else {
                continue
            }
            let script = "window.dispatchEvent(new CustomEvent('imcodes:native-modifier-press', { detail: \(json) }));"
            webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        forwardNativeModifierPresses(presses, phase: "down")
        super.pressesBegan(presses, with: event)
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        forwardNativeModifierPresses(presses, phase: "up")
        super.pressesEnded(presses, with: event)
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        forwardNativeModifierPresses(presses, phase: "cancel")
        super.pressesCancelled(presses, with: event)
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
