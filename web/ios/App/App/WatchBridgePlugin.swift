import Foundation
import Capacitor
import WatchConnectivity
import os.log

private let pluginLogger = Logger(subsystem: "com.im.codes", category: "WatchBridgePlugin")

@objc(WatchBridgePlugin)
public class WatchBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WatchBridgePlugin"
    public let jsName = "WatchBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "activate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushDurableEvent", returnType: CAPPluginReturnPromise)
    ]

    private var watchCommandObserver: NSObjectProtocol?

    public override func load() {
        super.load()

        watchCommandObserver = NotificationCenter.default.addObserver(
            forName: .watchCommand,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self = self else { return }
            let payload = (notification.userInfo ?? [:]).reduce(into: [String: Any]()) { result, entry in
                if let key = entry.key as? String {
                    result[key] = entry.value
                }
            }
            self.notifyListeners("watchCommand", data: payload)
        }
    }

    deinit {
        if let watchCommandObserver = watchCommandObserver {
            NotificationCenter.default.removeObserver(watchCommandObserver)
        }
    }

    @objc func activate(_ call: CAPPluginCall) {
        WatchBridge.shared.activate()
        call.resolve(["ok": true])
    }

    @objc func syncSnapshot(_ call: CAPPluginCall) {
        guard let context = call.getObject("context") else {
            call.resolve([
                "ok": false,
                "debug": "missing_context",
                "optionKeys": "\((call.options as? [String: Any])?.keys.sorted().joined(separator: ",") ?? "nil")"
            ])
            return
        }
        let s = WCSession.default
        let debug: [String: Any] = [
            "ok": true,
            "debug_activated": s.activationState.rawValue,
            "debug_paired": s.isPaired,
            "debug_installed": s.isWatchAppInstalled,
            "debug_contextKeys": context.keys.sorted().joined(separator: ","),
            "debug_sessionCount": (context["sessions"] as? [[String: Any]])?.count ?? -1
        ]
        WatchBridge.shared.syncSnapshot(context)
        call.resolve(debug)
    }

    @objc func pushDurableEvent(_ call: CAPPluginCall) {
        guard let event = call.getObject("event") as? [String: Any] else {
            call.reject("Missing event")
            return
        }

        WatchBridge.shared.pushDurableEvent(event)
        call.resolve(["ok": true])
    }
}
