import Foundation
import WatchConnectivity

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
        guard WCSession.isSupported(),
              session.isPaired,
              session.isWatchAppInstalled else {
            return
        }

        do {
            try session.updateApplicationContext(context)
        } catch {
            // Silent no-op by design; Watch snapshots are best-effort.
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
