import Foundation
import WatchConnectivity
import WatchKit

@MainActor
final class WatchSessionManager: NSObject, ObservableObject {
    static let shared = WatchSessionManager()

    @Published private(set) var applicationContext: WatchApplicationContext = .empty
    @Published private(set) var activationState: WCSessionActivationState = .notActivated
    @Published private(set) var lastErrorMessage: String?
    @Published private(set) var activeRoute: WatchRoute?
    @Published private(set) var servers: [WatchServerRow] = []
    @Published private(set) var sessionRows: [WatchSessionRow] = []
    @Published private(set) var loadedSessionsServerId: String?
    @Published private(set) var selectedServerId: String?
    @Published private(set) var historyByRoute: [String: WatchHistoryViewState] = [:]
    @Published private(set) var isUsingFallbackSnapshot = true
    @Published private(set) var isLoadingServers = false
    @Published private(set) var isLoadingSessions = false

    private let restClient = WatchRestClient()
    private var pendingRoute: WatchRoute?
    private var routeTimeoutWorkItem: DispatchWorkItem?

    private override init() {
        super.init()
        hydrateCachedContext()
        bootstrapFromContext(applicationContext, triggerReload: false)
    }

    var displayServers: [WatchServerRow] {
        if !servers.isEmpty { return servers }
        return applicationContext.servers
    }

    func displaySessions(for serverId: String? = nil) -> [WatchSessionRow] {
        let targetServerId = serverId ?? selectedServerId
        if let targetServerId {
            if loadedSessionsServerId == targetServerId {
                return sessionRows.filter { $0.serverId == targetServerId }
            }
            return applicationContext.sessions.filter { $0.serverId == targetServerId }
        }
        if loadedSessionsServerId != nil { return sessionRows }
        return applicationContext.sessions
    }

    func session(for route: WatchRoute) -> WatchSessionRow? {
        displaySessions(for: route.serverId).first { $0.sessionName == route.sessionName }
            ?? applicationContext.sessions.first { $0.serverId == route.serverId && $0.sessionName == route.sessionName }
    }

    func historyState(for route: WatchRoute) -> WatchHistoryViewState {
        historyByRoute[route.id] ?? seededHistoryState(for: route)
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
        applicationContext = context
        bootstrapFromContext(context, triggerReload: true)
        resolvePendingRouteIfPossible()
    }

    func ensureLoaded() async {
        guard canUseDirectApi else { return }
        if servers.isEmpty {
            await loadServers(force: false)
        }
        if let selectedServerId {
            let alreadyLoaded = sessionRows.contains(where: { $0.serverId == selectedServerId })
            if !alreadyLoaded {
                await loadSessions(serverId: selectedServerId, force: false)
            }
        }
    }

    func refresh() async {
        guard canUseDirectApi else {
            isUsingFallbackSnapshot = true
            lastErrorMessage = "Open IM.codes on iPhone to sync first."
            return
        }
        await loadServers(force: true)
        if let selectedServerId {
            await loadSessions(serverId: selectedServerId, force: true)
        }
    }

    /// Light refresh — reload sessions only (no servers). Used by auto-poll timer.
    func refreshSessions() async {
        guard canUseDirectApi, let selectedServerId else { return }
        await loadSessions(serverId: selectedServerId, force: true)
    }

    func selectServer(_ serverId: String) async {
        if selectedServerId != serverId {
            selectedServerId = serverId
            activeRoute = nil
        }
        await loadSessions(serverId: serverId, force: true)
        resolvePendingRouteIfPossible()
    }

    func loadHistoryIfNeeded(for route: WatchRoute) async {
        seedHistoryStateIfNeeded(for: route)
        // Always fetch latest history when entering the detail view
        await loadHistoryPage(for: route, beforeTs: nil)
    }

    func reloadHistory(for route: WatchRoute) async {
        historyByRoute[route.id] = seededHistoryState(for: route)
        await loadHistoryPage(for: route, beforeTs: nil)
    }

    func loadOlderHistory(for route: WatchRoute) async {
        guard let nextCursor = historyByRoute[route.id]?.nextCursor,
              historyByRoute[route.id]?.hasMore == true,
              historyByRoute[route.id]?.isLoadingOlder != true else {
            return
        }
        await loadHistoryPage(for: route, beforeTs: nextCursor)
    }

    func clearActiveRoute() {
        activeRoute = nil
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
        pendingRoute = WatchRoute(serverId: serverId, sessionName: sessionName, title: nil)
        startRouteTimeout()
        if selectedServerId != serverId {
            selectedServerId = serverId
        }
        Task {
            await self.ensureLoaded()
            await self.loadSessions(serverId: serverId, force: true)
            self.resolvePendingRouteIfPossible()
        }
    }

    func openOnPhone(route: WatchRoute) {
        sendControlMessage([
            "action": "openSession",
            "serverId": route.serverId,
            "sessionName": route.sessionName,
        ])
    }

    func currentBaseUrl(for serverId: String? = nil) -> URL? {
        let serverId = serverId ?? selectedServerId
        let row = displayServers.first(where: { $0.id == serverId })
            ?? applicationContext.servers.first(where: { $0.id == serverId })
            ?? displayServers.first
            ?? applicationContext.servers.first
        guard let baseUrl = row?.baseUrl, let url = URL(string: baseUrl) else { return nil }
        return url
    }

    func currentApiKey() -> String? {
        guard let apiKey = applicationContext.apiKey?.trimmingCharacters(in: .whitespacesAndNewlines), !apiKey.isEmpty else {
            return nil
        }
        return apiKey
    }

    func canSend(to route: WatchRoute) -> Bool {
        currentApiKey() != nil && currentBaseUrl(for: route.serverId) != nil && session(for: route) != nil
    }

    private var canUseDirectApi: Bool {
        currentApiKey() != nil && currentBaseUrl() != nil
    }

    private func bootstrapFromContext(_ context: WatchApplicationContext, triggerReload: Bool) {
        if selectedServerId == nil {
            selectedServerId = context.currentServerId ?? context.servers.first?.id
        }
        if selectedServerId == nil {
            selectedServerId = displayServers.first?.id
        }
        if triggerReload && canUseDirectApi {
            Task { await self.refresh() }
        }
    }

    private func hydrateCachedContext() {
        guard WCSession.isSupported() else { return }
        let cached = WCSession.default.receivedApplicationContext
        guard !cached.isEmpty else { return }
        if let decoded = decodeContext(cached) {
            applicationContext = decoded
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
            lastErrorMessage = "Watch snapshot version is too new."
            return nil
        }
        return decoded
    }

    private func loadServers(force: Bool) async {
        guard canUseDirectApi, let baseUrl = currentBaseUrl(), let apiKey = currentApiKey() else { return }
        if isLoadingServers && !force { return }
        isLoadingServers = true
        defer { isLoadingServers = false }

        do {
            let nextServers = try await restClient.fetchServers(baseUrl: baseUrl, apiKey: apiKey)
            servers = nextServers
            if selectedServerId == nil || !nextServers.contains(where: { $0.id == selectedServerId }) {
                selectedServerId = nextServers.first?.id ?? applicationContext.currentServerId
            }
            isUsingFallbackSnapshot = false
            lastErrorMessage = nil
        } catch let error as WatchRestClient.WatchRestError {
            isUsingFallbackSnapshot = true
            lastErrorMessage = error.errorDescription
        } catch {
            isUsingFallbackSnapshot = true
            lastErrorMessage = error.localizedDescription
        }
    }

    private func loadSessions(serverId: String, force: Bool) async {
        guard canUseDirectApi, let baseUrl = currentBaseUrl(for: serverId), let apiKey = currentApiKey() else { return }
        if isLoadingSessions && !force { return }
        isLoadingSessions = true
        defer { isLoadingSessions = false }

        do {
            let response = try await restClient.fetchSessions(baseUrl: baseUrl, serverId: serverId, apiKey: apiKey)
            sessionRows = response.sessions
            loadedSessionsServerId = serverId
            isUsingFallbackSnapshot = false
            lastErrorMessage = nil
            pruneSessionState(for: serverId, keepingSessionNames: Set(response.sessions.map(\.sessionName)))
            seedVisibleHistoriesIfNeeded(serverId: serverId)
            resolvePendingRouteIfPossible()
        } catch let error as WatchRestClient.WatchRestError {
            isUsingFallbackSnapshot = true
            lastErrorMessage = error.errorDescription
        } catch {
            isUsingFallbackSnapshot = true
            lastErrorMessage = error.localizedDescription
        }
    }

    private func loadHistoryPage(for route: WatchRoute, beforeTs: Double?) async {
        seedHistoryStateIfNeeded(for: route)
        guard canUseDirectApi, let baseUrl = currentBaseUrl(for: route.serverId), let apiKey = currentApiKey() else {
            updateHistoryState(for: route) { state in
                state.errorMessage = "Open IM.codes on iPhone to sync first."
            }
            return
        }

        updateHistoryState(for: route) { state in
            if beforeTs == nil { state.isLoading = true }
            else { state.isLoadingOlder = true }
            state.errorMessage = nil
        }

        do {
            let response = try await restClient.fetchHistory(
                baseUrl: baseUrl,
                serverId: route.serverId,
                sessionName: route.sessionName,
                apiKey: apiKey,
                limit: beforeTs == nil ? 30 : 15,
                beforeTs: beforeTs
            )
            let incoming = response.events.compactMap(WatchConversationItem.fromTimelineEvent)
            updateHistoryState(for: route) { state in
                state.items = WatchConversationItem.merge(existing: state.items, incoming: incoming)
                state.hasMore = response.hasMore
                state.nextCursor = response.nextCursor
                state.loadedOnce = true
                state.isLoading = false
                state.isLoadingOlder = false
                state.errorMessage = nil
            }
            lastErrorMessage = nil
            resolvePendingRouteIfPossible()
        } catch let error as WatchRestClient.WatchRestError {
            updateHistoryState(for: route) { state in
                state.isLoading = false
                state.isLoadingOlder = false
                state.errorMessage = error.errorDescription
            }
            lastErrorMessage = error.errorDescription
        } catch {
            updateHistoryState(for: route) { state in
                state.isLoading = false
                state.isLoadingOlder = false
                state.errorMessage = error.localizedDescription
            }
            lastErrorMessage = error.localizedDescription
        }
    }

    private func seededHistoryState(for route: WatchRoute) -> WatchHistoryViewState {
        let recentItems = (session(for: route)?.recentText ?? [])
            .compactMap { WatchConversationItem.fromRecentText($0, sessionId: route.sessionName) }
        return WatchHistoryViewState(items: WatchConversationItem.merge(existing: [], incoming: recentItems))
    }

    private func seedHistoryStateIfNeeded(for route: WatchRoute) {
        guard historyByRoute[route.id] == nil else { return }
        historyByRoute[route.id] = seededHistoryState(for: route)
    }

    private func seedVisibleHistoriesIfNeeded(serverId: String) {
        for row in displaySessions(for: serverId) {
            let route = WatchRoute(serverId: row.serverId, sessionName: row.sessionName, title: row.title)
            if historyByRoute[route.id] == nil {
                historyByRoute[route.id] = seededHistoryState(for: route)
            }
        }
    }

    private func pruneSessionState(for serverId: String, keepingSessionNames: Set<String>) {
        historyByRoute = historyByRoute.filter { key, _ in
            let prefix = "\(serverId):"
            guard key.hasPrefix(prefix) else { return true }
            let sessionName = String(key.dropFirst(prefix.count))
            return keepingSessionNames.contains(sessionName)
        }
        if let activeRoute, activeRoute.serverId == serverId, !keepingSessionNames.contains(activeRoute.sessionName) {
            self.activeRoute = nil
        }
        if let pendingRoute, pendingRoute.serverId == serverId, !keepingSessionNames.contains(pendingRoute.sessionName) {
            self.pendingRoute = nil
            cancelRouteTimeout()
        }
    }

    private func updateHistoryState(for route: WatchRoute, mutate: (inout WatchHistoryViewState) -> Void) {
        var state = historyByRoute[route.id] ?? seededHistoryState(for: route)
        mutate(&state)
        historyByRoute[route.id] = state
    }

    private func resolvePendingRouteIfPossible() {
        guard let pendingRoute else { return }
        if selectedServerId != pendingRoute.serverId {
            selectedServerId = pendingRoute.serverId
            Task { await self.loadSessions(serverId: pendingRoute.serverId, force: true) }
            return
        }

        if displaySessions(for: pendingRoute.serverId).contains(where: { $0.sessionName == pendingRoute.sessionName }) {
            activeRoute = pendingRoute
            self.pendingRoute = nil
            cancelRouteTimeout()
            lastErrorMessage = nil
        }
    }

    private func startRouteTimeout() {
        cancelRouteTimeout()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, self.pendingRoute != nil else { return }
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

    private func sendControlMessage(_ payload: [String: Any]) {
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
            Task { @MainActor in
                self.lastErrorMessage = nil
            }
        }, errorHandler: { error in
            Task { @MainActor in
                self.lastErrorMessage = error.localizedDescription
            }
        })
    }

    private func handleDurableEvent(_ userInfo: [String: Any]) {
        guard let type = userInfo["type"] as? String else { return }
        switch type {
        case "session.idle":
            WKInterfaceDevice.current().play(.success)
        case "session.notification":
            WKInterfaceDevice.current().play(.notification)
        case "session.error":
            WKInterfaceDevice.current().play(.failure)
            if let message = userInfo["message"] as? String, !message.isEmpty {
                lastErrorMessage = "Session error — \(message)"
            }
        default:
            break
        }
    }
}

extension WatchSessionManager: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in
            self.activationState = activationState
            self.lastErrorMessage = error?.localizedDescription
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
        Task { @MainActor in
            if let decoded = self.decodeContext(applicationContext) {
                self.applicationContext = decoded
                self.bootstrapFromContext(decoded, triggerReload: true)
                self.lastErrorMessage = nil
                self.resolvePendingRouteIfPossible()
            } else {
                self.lastErrorMessage = "Unable to decode watch context."
            }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String : Any]) {
        Task { @MainActor in
            self.handleDurableEvent(userInfo)
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {}
}
