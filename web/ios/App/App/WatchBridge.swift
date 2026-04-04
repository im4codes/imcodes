import UIKit
import WatchConnectivity
import UserNotifications
import os.log

private let logger = Logger(subsystem: "com.im.codes", category: "WatchBridge")

extension Notification.Name {
    static let watchCommand = Notification.Name("watchCommand")
}

final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()

    private let session = WCSession.default
    private var didAttemptActivation = false

    private override init() {
        super.init()
    }

    func activate() {
        guard WCSession.isSupported() else { return }

        if session.delegate !== self {
            session.delegate = self
        }

        if !didAttemptActivation || session.activationState != .activated {
            didAttemptActivation = true
            session.activate()
        }
    }

    func syncSnapshot(_ context: [String: Any]) {
        guard WCSession.isSupported() else {
            logger.error("WCSession not supported")
            return
        }
        let s = self.session
        logger.info("syncSnapshot called, activationState=\(s.activationState.rawValue) isPaired=\(s.isPaired) isWatchAppInstalled=\(s.isWatchAppInstalled) keys=\(context.keys.sorted().joined(separator: ","))")
        guard s.activationState == .activated else {
            logger.error("WCSession not activated (state: \(s.activationState.rawValue))")
            return
        }
        guard s.isPaired else {
            logger.error("Watch not paired")
            return
        }
        guard s.isWatchAppInstalled else {
            logger.error("Watch app not installed")
            return
        }

        do {
            try session.updateApplicationContext(context)
            logger.info("Snapshot pushed OK (\(context.count) keys)")
        } catch {
            logger.error("updateApplicationContext failed: \(error.localizedDescription)")
        }
    }

    func pushDurableEvent(_ event: [String: Any]) {
        guard WCSession.isSupported(),
              session.isPaired,
              session.isWatchAppInstalled else {
            return
        }

        session.transferUserInfo(event)
    }

    private func handleWatchMessage(_ message: [String: Any]) {
        guard let action = message["action"] as? String else { return }

        switch action {
        case "switchServer":
            guard let serverId = message["serverId"] as? String, !serverId.isEmpty else { return }
            NotificationCenter.default.post(
                name: .watchCommand,
                object: nil,
                userInfo: [
                    "action": action,
                    "serverId": serverId
                ]
            )
        case "refresh":
            NotificationCenter.default.post(
                name: .watchCommand,
                object: nil,
                userInfo: [
                    "action": action
                ]
            )
        case "openSession":
            guard let serverId = message["serverId"] as? String,
                  let sessionName = message["sessionName"] as? String else { return }
            // Forward to JS for session switching
            NotificationCenter.default.post(
                name: .watchCommand,
                object: nil,
                userInfo: [
                    "action": action,
                    "serverId": serverId,
                    "sessionName": sessionName
                ]
            )
            // If app is in background, fire local notification so user can tap to foreground
            if UIApplication.shared.applicationState != .active {
                let content = UNMutableNotificationContent()
                content.title = "IM.codes"
                content.body = "Tap to open session"
                content.sound = .default
                let request = UNNotificationRequest(
                    identifier: "watch-open-session",
                    content: content,
                    trigger: nil
                )
                UNUserNotificationCenter.current().add(request)
            }
        default:
            break
        }
    }

    private func replyAndHandle(_ message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        replyHandler(["ok": true])

        DispatchQueue.main.async { [weak self] in
            self?.handleWatchMessage(message)
        }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
        replyAndHandle(message, replyHandler: { _ in })
    }

    func session(_ session: WCSession, didReceiveMessage message: [String : Any], replyHandler: @escaping ([String : Any]) -> Void) {
        replyAndHandle(message, replyHandler: replyHandler)
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        // No-op: bridge activation is intentionally best-effort and idempotent.
    }

    func sessionDidBecomeInactive(_ session: WCSession) {
        // No-op: the app will re-activate on foreground.
    }

    func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate to pick up the active paired watch if it changed.
        activate()
    }
}
