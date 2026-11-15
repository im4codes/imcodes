import UIKit
import Capacitor

/// Keeps active uploads alive across short iOS background transitions using
/// UIApplication.beginBackgroundTask and always releases cleanly on expiration
/// so the OS pauses the app instead of terminating it with 0x8badf00d.
@objc(FileTransferKeepAlivePlugin)
public class FileTransferKeepAlivePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FileTransferKeepAlivePlugin"
    public let jsName = "FileTransferKeepAlive"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private var keepAliveActive = false
    private var backgroundTaskId: UIBackgroundTaskIdentifier = .invalid
    private var backgroundObserver: NSObjectProtocol?
    private var foregroundObserver: NSObjectProtocol?

    private static var isMacDesktopHost: Bool {
        #if targetEnvironment(macCatalyst)
        return true
        #else
        if #available(iOS 14.0, *) {
            return ProcessInfo.processInfo.isiOSAppOnMac
        }
        return false
        #endif
    }

    public override func load() {
        super.load()
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleDidEnterBackground()
        }
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.endBackgroundTaskOnMain()
        }
    }

    deinit {
        if let observer = backgroundObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = foregroundObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        let taskId = backgroundTaskId
        backgroundTaskId = .invalid
        if taskId != .invalid {
            DispatchQueue.main.async {
                UIApplication.shared.endBackgroundTask(taskId)
            }
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                call.resolve(["started": false])
                return
            }
            self.keepAliveActive = true
            let started = self.ensureBackgroundTaskOnMain()
            call.resolve(["started": started])
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.keepAliveActive = false
            self?.endBackgroundTaskOnMain()
            call.resolve()
        }
    }

    private func handleDidEnterBackground() {
        guard keepAliveActive else { return }
        _ = ensureBackgroundTaskOnMain()
    }

    @discardableResult
    private func ensureBackgroundTaskOnMain() -> Bool {
        if Self.isMacDesktopHost {
            return false
        }
        guard keepAliveActive else { return false }
        if backgroundTaskId != .invalid {
            return true
        }
        let taskId = UIApplication.shared.beginBackgroundTask(withName: "IMCodesFileTransfer") { [weak self] in
            // Executed synchronously on main thread before background time expires.
            // End immediately and clear to .invalid to avoid 0x8badf00d watchdog kill.
            self?.endBackgroundTaskOnMain()
        }
        backgroundTaskId = taskId
        return taskId != .invalid
    }

    private func endBackgroundTaskOnMain() {
        let taskId = backgroundTaskId
        guard taskId != .invalid else { return }
        backgroundTaskId = .invalid
        UIApplication.shared.endBackgroundTask(taskId)
    }
}
