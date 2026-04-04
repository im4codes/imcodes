import Combine
import Foundation
import WatchKit
import WatchConnectivity

final class WatchSessionManager: NSObject, ObservableObject {
    static let shared = WatchSessionManager()

    @Published private(set) var applicationContext: WatchApplicationContext = .empty
    @Published private(set) var activationState: WCSessionActivationState = .notActivated
    @Published private(set) var lastErrorMessage: String?
    @Published private(set) var activeRoute: WatchRoute?

    private var pendingRoute: WatchRoute?
    private var routeTimeoutWorkItem: DispatchWorkItem?

    private override init() {
        super.init()
        hydrateCachedContext()
    }

    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        if session.delegate !== self {
            session.delegate = self
        }
        if session.activationState == .notActivated {
            session.activate()
        }
    }

    func syncSnapshot(_ context: WatchApplicationContext) {
        DispatchQueue.main.async {
            self.applicationContext = context
            self.resolvePendingRouteIfPossible()
        }
    }

    func currentServer() -> WatchServerRow? {
        guard let currentServerId = applicationContext.currentServerId else { return nil }
        return applicationContext.servers.first(where: { $0.id == currentServerId })
    }

    func requestServerSwitch(to serverId: String) {
        requestServerSwitch(to: serverId, preservePendingRoute: false)
    }

    func requestRefresh() {
        sendControlMessage(["action": "refresh"])
    }

    func handleNotificationPayload(_ userInfo: [AnyHashable: Any]) {
        guard let serverId = userInfo["serverId"] as? String, !serverId.isEmpty else {
            lastErrorMessage = "Notification missing server route."
            return
        }
        let sessionName = (userInfo["session"] as? String) ?? (userInfo["sessionName"] as? String)
        guard let sessionName, !sessionName.isEmpty else {
            lastErrorMessage = "Notification missing session route."
            return
        }

        activeRoute = nil
        pendingRoute = WatchRoute(serverId: serverId, sessionName: sessionName)
        startRouteTimeout()
        resolvePendingRouteIfPossible()
    }

    func clearActiveRoute() {
        activeRoute = nil
    }

    private func hydrateCachedContext() {
        guard WCSession.isSupported() else { return }
        let cached = WCSession.default.receivedApplicationContext
        guard !cached.isEmpty else { return }
        if let decoded = decodeContext(cached) {
            DispatchQueue.main.async {
                self.applicationContext = decoded
            }
        }
    }

    private func decodeContext(_ raw: [String: Any]) -> WatchApplicationContext? {
        guard let data = try? PropertyListSerialization.data(fromPropertyList: raw, format: .xml, options: 0) else {
            return nil
        }
        guard let decoded = try? PropertyListDecoder().decode(WatchApplicationContext.self, from: data) else {
            return nil
        }
        guard decoded.v <= 1 else {
            DispatchQueue.main.async {
                self.lastErrorMessage = "Watch snapshot version is too new."
            }
            return nil
        }
        return decoded
    }

    private func requestServerSwitch(to serverId: String, preservePendingRoute: Bool) {
        sendControlMessage(["action": "switchServer", "serverId": serverId]) {
            self.applicationContext.currentServerId = serverId
            self.applicationContext.snapshotStatus = .switching
            if !preservePendingRoute {
                self.pendingRoute = nil
                self.cancelRouteTimeout()
            }
        }
    }

    private func sendControlMessage(_ payload: [String: Any], optimisticUpdate: (() -> Void)? = nil) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else {
            lastErrorMessage = "Phone session is not ready."
            return
        }
        guard session.isReachable else {
            lastErrorMessage = "Phone app is unavailable."
            return
        }
        session.sendMessage(payload, replyHandler: { _ in
            DispatchQueue.main.async {
                optimisticUpdate?()
                self.lastErrorMessage = nil
            }
        }, errorHandler: { error in
            DispatchQueue.main.async {
                self.lastErrorMessage = error.localizedDescription
            }
        })
    }

    private func handleDurableEvent(_ userInfo: [String: Any]) {
        guard let type = userInfo["type"] as? String else { return }
        DispatchQueue.main.async {
            switch type {
            case "session.idle":
                WKInterfaceDevice.current().play(.success)
            case "session.notification":
                WKInterfaceDevice.current().play(.notification)
            case "session.error":
                WKInterfaceDevice.current().play(.failure)
                if let message = userInfo["message"] as? String, !message.isEmpty {
                    self.lastErrorMessage = "Session error — \(message)"
                }
            default:
                break
            }
        }
    }

    private func resolvePendingRouteIfPossible() {
        guard let pendingRoute else { return }
        guard !applicationContext.servers.isEmpty else { return }

        if applicationContext.currentServerId == pendingRoute.serverId {
            if applicationContext.sessions.contains(where: { $0.sessionName == pendingRoute.sessionName }) {
                activeRoute = pendingRoute
                self.pendingRoute = nil
                cancelRouteTimeout()
                lastErrorMessage = nil
            }
            return
        }

        guard applicationContext.snapshotStatus != .switching else { return }
        requestServerSwitch(to: pendingRoute.serverId, preservePendingRoute: true)
    }

    private func startRouteTimeout() {
        cancelRouteTimeout()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            guard self.pendingRoute != nil else { return }
            self.pendingRoute = nil
            self.activeRoute = nil
            self.lastErrorMessage = "Session unavailable."
        }
        routeTimeoutWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: workItem)
    }

    private func cancelRouteTimeout() {
        routeTimeoutWorkItem?.cancel()
        routeTimeoutWorkItem = nil
    }
}

extension WatchSessionManager: WCSessionDelegate {
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.activationState = activationState
            self.lastErrorMessage = error?.localizedDescription
        }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
        DispatchQueue.main.async {
            if let decoded = self.decodeContext(applicationContext) {
                self.applicationContext = decoded
                self.lastErrorMessage = nil
            } else {
                self.lastErrorMessage = "Unable to decode watch context."
            }
        }
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String : Any]) {
        handleDurableEvent(userInfo)
    }

    func sessionReachabilityDidChange(_ session: WCSession) {}
}
