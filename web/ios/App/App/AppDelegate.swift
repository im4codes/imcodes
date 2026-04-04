import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?
    private var didRegisterLocalPlugins = false

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Set notification delegate so push notifications display in foreground
        UNUserNotificationCenter.current().delegate = self

        WatchBridge.shared.activate()

        // Register local Capacitor plugins after the bridge initializes
        DispatchQueue.main.async {
            self.registerLocalPluginsIfNeeded()
        }
        return true
    }

    // Show push notifications even when app is in foreground
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .badge])
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

        DispatchQueue.main.async {
            self.registerLocalPluginsIfNeeded()
        }

        // Notify server to reset badge counter
        self.resetBadgeOnServer()
    }

    private func resetBadgeOnServer() {
        // Call /api/push/badge-reset via the web view's cookies (session auth)
        guard let vc = window?.rootViewController as? CAPBridgeViewController,
              let bridge = vc.bridge else { return }

        bridge.webView?.evaluateJavaScript("""
            fetch('/api/push/badge-reset', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
        """)
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
        didRegisterLocalPlugins = true
    }

}
