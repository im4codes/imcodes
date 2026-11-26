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
    @Published private(set) var sessionsByServerId: [String: [WatchSessionRow]] = [:]
    @Published private(set) var globalTasks: [WatchGlobalTaskRow] = []
    @Published private(set) var loadedSessionsServerId: String?
    @Published private(set) var selectedServerId: String?
    @Published private(set) var selectedTaskServerIds: Set<String>?
    @Published private(set) var manualSessionsByServer: [String: Set<String>] = [:]
    @Published private(set) var historyByRoute: [String: WatchHistoryViewState] = [:]
    @Published private(set) var isUsingFallbackSnapshot = true
    @Published private(set) var isLoadingServers = false
    @Published private(set) var isLoadingSessions = false
    @Published private(set) var isLoadingGlobalTasks = false

    static let allPinnedServerId = "__all_pinned__"

    var isAllPinnedSelected: Bool {
        selectedServerId == Self.allPinnedServerId
    }

    private static let cachedGlobalTasksKey = "imcodes.watch.cachedGlobalTasks.v1"
    private static let cachedGlobalTasksFileName = "imcodes.watch.cachedGlobalTasks.v1.json"
    private static let selectedServerIdKey = "watchSelectedServerId"
    private static let selectedTaskServerIdsKey = "watchSelectedTaskServerIds"
    private static let manualSessionsKeyPrefix = "watchManualSessions:"
    private static let cachedSessionsKeyPrefix = "watchCachedSessions:"
    private static let autoShowAllMainSessionLimit = 5

    private let restClient = WatchRestClient()
    private var pendingRoute: WatchRoute?
    private var routeTimeoutWorkItem: DispatchWorkItem?
    private var networkLoadedSessionServers: Set<String> = []
    private var loadingSessionServers: Set<String> = []
    private var isLoadingAllPinnedSessions = false
    private var isHydratingAllPinnedSessions = false
    private var allPinnedBatchToken: UInt64 = 0
    private var lastSnapshotRequestAt: Date = .distantPast

    private override init() {
        super.init()
        if UserDefaults.standard.object(forKey: Self.selectedTaskServerIdsKey) != nil {
            let saved = UserDefaults.standard.stringArray(forKey: Self.selectedTaskServerIdsKey) ?? []
            selectedTaskServerIds = Set(saved)
        } else {
            selectedTaskServerIds = nil
        }
        hydrateCachedContext()
        bootstrapFromContext(applicationContext, triggerReload: false)
        if isAllPinnedSelected {
            hydrateCachedSessions(for: Self.allPinnedServerId)
        } else if let selectedServerId {
            hydrateCachedSessions(for: selectedServerId)
        }
    }

    var displayServers: [WatchServerRow] {
        let contextPinnedById = Dictionary(
            applicationContext.servers.compactMap { row -> (String, Bool)? in
                guard let isPinned = row.isPinned else { return nil }
                return (row.id, isPinned)
            },
            uniquingKeysWith: { first, _ in first }
        )
        let raw: [WatchServerRow]
        if !servers.isEmpty {
            raw = servers.map { row in
                var copy = row
                if copy.isPinned == nil {
                    copy.isPinned = contextPinnedById[row.id]
                }
                return copy
            }
        } else {
            raw = applicationContext.servers
        }
        return Self.sortServers(raw)
    }

    static func sortServers(_ servers: [WatchServerRow]) -> [WatchServerRow] {
        servers.enumerated().sorted { lhs, rhs in
            let lhsPinned = lhs.element.isPinned ?? false
            let rhsPinned = rhs.element.isPinned ?? false
            if lhsPinned != rhsPinned { return lhsPinned }
            return lhs.offset < rhs.offset
        }.map(\.element)
    }

    private var defaultVisibleTaskServerIds: Set<String> {
        let pinnedIds = displayServers.compactMap { ($0.isPinned ?? false) ? $0.id : nil }
        if !pinnedIds.isEmpty {
            return Set(pinnedIds)
        }
        return Set(displayServers.map(\.id))
    }

    func isTaskServerVisible(_ serverId: String) -> Bool {
        if let selectedTaskServerIds {
            return selectedTaskServerIds.contains(serverId)
        }
        let pinnedIds = displayServers.compactMap { ($0.isPinned ?? false) ? $0.id : nil }
        if !pinnedIds.isEmpty {
            return pinnedIds.contains(serverId)
        }
        return true
    }

    func toggleTaskServerVisibility(_ serverId: String) {
        var next = selectedTaskServerIds ?? defaultVisibleTaskServerIds
        if next.contains(serverId) {
            next.remove(serverId)
        } else {
            next.insert(serverId)
        }
        selectedTaskServerIds = next
        UserDefaults.standard.set(Array(next).sorted(), forKey: Self.selectedTaskServerIdsKey)
    }

    private static func manualSessionsKey(for serverId: String) -> String {
        "\(manualSessionsKeyPrefix)\(serverId)"
    }

    private static func cachedSessionsKey(for serverId: String) -> String {
        "\(cachedSessionsKeyPrefix)\(serverId)"
    }

    nonisolated private static func sanitizedCacheComponent(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._"))
        let mapped = value.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }
        let result = String(mapped)
        return result.isEmpty || result == "." || result == ".." ? "_" : result
    }

    nonisolated private static func cachedSessionsFileName(for serverId: String) -> String {
        "imcodes.watch.cachedSessions.\(sanitizedCacheComponent(serverId)).json"
    }

    nonisolated private static func cacheFileURL(named name: String) -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent(name, isDirectory: false)
    }

    nonisolated private static func readCacheData(named name: String) -> Data? {
        guard let url = cacheFileURL(named: name) else { return nil }
        return try? Data(contentsOf: url)
    }

    nonisolated private static func writeCacheData(_ data: Data, named name: String) {
        guard let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name, isDirectory: false)
        try? data.write(to: url, options: .atomic)
    }

    private func hydrateCachedSessions(for serverId: String) {
        if serverId == Self.allPinnedServerId {
            guard !isHydratingAllPinnedSessions else { return }
            let serverIds = displayServers.map(\.id).filter {
                !networkLoadedSessionServers.contains($0) && sessionsByServerId[$0] == nil
            }
            guard !serverIds.isEmpty else { return }
            let batchToken = allPinnedBatchToken
            isHydratingAllPinnedSessions = true
            Task.detached(priority: .userInitiated) { [weak self] in
                var decodedByServer: [String: [WatchSessionRow]] = [:]
                let decoder = JSONDecoder()
                for id in serverIds {
                    if Task.isCancelled { break }
                    let fileName = Self.cachedSessionsFileName(for: id)
                    guard let data = Self.readCacheData(named: fileName),
                          let decoded = try? decoder.decode([WatchSessionRow].self, from: data) else {
                        continue
                    }
                    decodedByServer[id] = decoded
                }
                let snapshot = decodedByServer
                await MainActor.run { [weak self, snapshot] in
                    guard let self else { return }
                    self.isHydratingAllPinnedSessions = false
                    guard self.isAllPinnedSelected, self.allPinnedBatchToken == batchToken else { return }
                    if !snapshot.isEmpty {
                        var next = self.sessionsByServerId
                        for (id, rows) in snapshot where !self.networkLoadedSessionServers.contains(id) && next[id] == nil {
                            next[id] = rows
                        }
                        self.sessionsByServerId = next
                        for id in snapshot.keys {
                            self.seedVisibleHistoriesIfNeeded(serverId: id, pinnedOnly: true)
                        }
                    }
                }
            }
            return
        }
        let fileName = Self.cachedSessionsFileName(for: serverId)
        let legacyKey = Self.cachedSessionsKey(for: serverId)
        var data = Self.readCacheData(named: fileName)
        if data == nil, let legacyData = UserDefaults.standard.data(forKey: legacyKey) {
            data = legacyData
            Self.writeCacheData(legacyData, named: fileName)
        }
        if UserDefaults.standard.object(forKey: legacyKey) != nil {
            UserDefaults.standard.removeObject(forKey: legacyKey)
        }
        guard let data,
              let decoded = try? JSONDecoder().decode([WatchSessionRow].self, from: data) else {
            return
        }
        sessionsByServerId[serverId] = decoded
        if selectedServerId == serverId {
            sessionRows = decoded
            loadedSessionsServerId = serverId
        }
        seedVisibleHistoriesIfNeeded(serverId: serverId)
    }

    func serverName(for serverId: String) -> String? {
        displayServers.first(where: { $0.id == serverId })?.name
            ?? applicationContext.servers.first(where: { $0.id == serverId })?.name
    }

    func manualSessionNames(for serverId: String) -> Set<String> {
        if let cached = manualSessionsByServer[serverId] {
            return cached
        }
        let stored = UserDefaults.standard.stringArray(forKey: Self.manualSessionsKey(for: serverId)) ?? []
        return Set(stored)
    }

    func addManualSession(_ sessionName: String, serverId: String) {
        let trimmed = sessionName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !serverId.isEmpty else { return }
        var current = manualSessionNames(for: serverId)
        guard !current.contains(trimmed) else { return }
        current.insert(trimmed)
        manualSessionsByServer[serverId] = current
        UserDefaults.standard.set(Array(current).sorted(), forKey: Self.manualSessionsKey(for: serverId))
        if loadedSessionsServerId == serverId {
            seedVisibleHistoriesIfNeeded(serverId: serverId)
        }
    }

    func removeManualSession(_ sessionName: String, serverId: String) {
        var current = manualSessionNames(for: serverId)
        guard current.remove(sessionName) != nil else { return }
        manualSessionsByServer[serverId] = current
        UserDefaults.standard.set(Array(current).sorted(), forKey: Self.manualSessionsKey(for: serverId))
    }

    func displaySessions(for serverId: String? = nil) -> [WatchSessionRow] {
        let targetServerId = serverId ?? selectedServerId
        guard let targetServerId else {
            if displayServers.count > 1 {
                return []
            }
            if let onlyServerId = displayServers.first?.id {
                return displaySessions(for: onlyServerId)
            }
            let raw = loadedSessionsServerId != nil ? sessionRows : applicationContext.sessions
            return Self.sortSessions(raw)
        }
        if targetServerId == Self.allPinnedServerId {
            var seenIds: Set<String> = []
            var filtered: [WatchSessionRow] = []
            for server in displayServers {
                let serverRows = sessionsByServerId[server.id]
                    ?? (loadedSessionsServerId == server.id
                        ? sessionRows.filter { $0.serverId == server.id }
                        : applicationContext.sessions.filter { $0.serverId == server.id })
                var pinnedMainNames: Set<String> = []
                for row in serverRows where !Self.isSubSessionRow(row) && (row.isPinned ?? false) {
                    pinnedMainNames.insert(row.sessionName)
                }
                for row in serverRows {
                    let keep: Bool
                    if Self.isSubSessionRow(row) {
                        keep = (row.isPinned ?? false)
                            || (row.parentSessionName.map { pinnedMainNames.contains($0) } ?? false)
                    } else {
                        keep = row.isPinned ?? false
                    }
                    if keep, seenIds.insert(row.id).inserted {
                        filtered.append(row)
                    }
                }
            }
            return Self.sortSessions(
                filtered,
                pinnedServerIds: Set(displayServers.filter { $0.isPinned ?? false }.map(\.id))
            )
        }
        let raw: [WatchSessionRow]
        if let perServer = sessionsByServerId[targetServerId] {
            raw = perServer
        } else if loadedSessionsServerId == targetServerId {
            raw = sessionRows.filter { $0.serverId == targetServerId }
        } else {
            raw = applicationContext.sessions.filter { $0.serverId == targetServerId }
        }
        return Self.sortSessions(raw)
    }

    static func sortSessions(_ sessions: [WatchSessionRow], pinnedServerIds: Set<String> = []) -> [WatchSessionRow] {
        sessions.sorted { lhs, rhs in
            let lhsPinned = lhs.isPinned ?? false
            let rhsPinned = rhs.isPinned ?? false
            if lhsPinned != rhsPinned { return lhsPinned }

            if !pinnedServerIds.isEmpty {
                let lhsServerPinned = pinnedServerIds.contains(lhs.serverId)
                let rhsServerPinned = pinnedServerIds.contains(rhs.serverId)
                if lhsServerPinned != rhsServerPinned { return lhsServerPinned }
            }

            let lhsPriority = sessionStatePriority(lhs.state)
            let rhsPriority = sessionStatePriority(rhs.state)
            if lhsPriority != rhsPriority { return lhsPriority < rhsPriority }

            let lhsTs = lhs.effectivePreviewUpdatedAt ?? 0
            let rhsTs = rhs.effectivePreviewUpdatedAt ?? 0
            if lhsTs != rhsTs { return lhsTs > rhsTs }

            let titleOrder = lhs.title.localizedCaseInsensitiveCompare(rhs.title)
            if titleOrder != .orderedSame { return titleOrder == .orderedAscending }

            return lhs.sessionName < rhs.sessionName
        }
    }

    private static func sessionStatePriority(_ state: WatchSessionState) -> Int {
        switch state {
        case .working: return 0
        case .error: return 1
        case .idle: return 2
        case .stopped: return 3
        }
    }

    func displayTasks(for serverId: String? = nil) -> [WatchGlobalTaskRow] {
        let filtered: [WatchGlobalTaskRow]
        if let serverId {
            filtered = globalTasks.filter { $0.serverId == serverId && isTaskServerVisible($0.serverId) }
        } else {
            filtered = globalTasks.filter { isTaskServerVisible($0.serverId) }
        }
        return filtered.sorted { lhs, rhs in
            let lhsTerminal = lhs.isTerminal ?? false
            let rhsTerminal = rhs.isTerminal ?? false
            if lhsTerminal != rhsTerminal { return !lhsTerminal }
            let lhsRank = taskActiveSortRank(lhs)
            let rhsRank = taskActiveSortRank(rhs)
            if lhsRank != rhsRank { return lhsRank < rhsRank }
            let lhsTs = lhs.updatedAt ?? 0
            let rhsTs = rhs.updatedAt ?? 0
            if lhsTs != rhsTs { return lhsTs > rhsTs }
            return lhs.taskId < rhs.taskId
        }
    }

    private func taskActiveSortRank(_ task: WatchGlobalTaskRow) -> Int {
        if task.needsAttention ?? false { return 0 }
        switch task.status {
        case "working", "in_audit", "awaiting_audit", "rework":
            return 1
        case "passed":
            return 2
        case "queued", "paused":
            return 3
        default:
            return 4
        }
    }

    func session(for route: WatchRoute) -> WatchSessionRow? {
        sessionsByServerId[route.serverId]?.first { $0.sessionName == route.sessionName }
            ?? displaySessions(for: route.serverId).first { $0.sessionName == route.sessionName }
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
        reconcileCommandReceipts(from: context)
        bootstrapFromContext(context, triggerReload: true)
        resolvePendingRouteIfPossible()
    }

    func ensureLoaded() async {
        guard canUseDirectApi else {
            requestSnapshotFromPhoneIfReachable()
            return
        }
        async let tasksStep: Void = loadGlobalTasks(force: false)
        if servers.isEmpty {
            await loadServers(force: false)
        }
        if isAllPinnedSelected {
            hydrateCachedSessions(for: Self.allPinnedServerId)
            await loadAllPinnedSessions(force: false)
        } else if let selectedServerId {
            if loadedSessionsServerId != selectedServerId {
                hydrateCachedSessions(for: selectedServerId)
            }
            if !networkLoadedSessionServers.contains(selectedServerId) {
                await loadSessions(serverId: selectedServerId, force: false)
            }
        }
        _ = await tasksStep
    }

    func refresh() async {
        guard canUseDirectApi else {
            isUsingFallbackSnapshot = true
            lastErrorMessage = "Open IM.codes on iPhone to sync first."
            requestSnapshotFromPhoneIfReachable(force: true)
            return
        }
        async let tasksStep: Void = loadGlobalTasks(force: true)
        await loadServers(force: true)
        if isAllPinnedSelected {
            await loadAllPinnedSessions(force: true)
        } else if let selectedServerId {
            await loadSessions(serverId: selectedServerId, force: true)
        }
        _ = await tasksStep
    }

    /// Immediate refresh when the Watch app wakes/becomes active in foreground.
    func refreshOnForeground() async {
        guard canUseDirectApi else {
            requestSnapshotFromPhoneIfReachable()
            return
        }
        async let tasksStep: Void = loadGlobalTasks(force: true)
        if servers.isEmpty || servers.contains(where: { $0.isPinned == nil }) {
            await loadServers(force: false)
        }
        if isAllPinnedSelected {
            await loadAllPinnedSessions(force: true)
        } else if let selectedServerId {
            await loadSessions(serverId: selectedServerId, force: true)
        }
        _ = await tasksStep
    }

    /// Light refresh — reload sessions and task statuses (no servers). Used by auto-poll timer and view switches.
    func refreshSessions(includeSessions: Bool = true) async {
        guard canUseDirectApi else { return }
        async let tasksStep: Void = loadGlobalTasks(force: true)
        if includeSessions {
            if isAllPinnedSelected {
                await loadAllPinnedSessions(force: true)
            } else if let selectedServerId {
                await loadSessions(serverId: selectedServerId, force: true)
            }
        }
        _ = await tasksStep
    }

    func selectServer(_ serverId: String) async {
        allPinnedBatchToken &+= 1
        isLoadingAllPinnedSessions = false
        isHydratingAllPinnedSessions = false
        if selectedServerId != serverId {
            selectedServerId = serverId
            activeRoute = nil
            UserDefaults.standard.set(serverId, forKey: Self.selectedServerIdKey)
            sessionRows = []
            loadedSessionsServerId = nil
            hydrateCachedSessions(for: serverId)
        } else if loadedSessionsServerId != serverId {
            hydrateCachedSessions(for: serverId)
        }
        await loadSessions(serverId: serverId, force: true)
        resolvePendingRouteIfPossible()
    }

    func selectAllPinnedSessions() async {
        if selectedServerId != Self.allPinnedServerId {
            allPinnedBatchToken &+= 1
            isLoadingAllPinnedSessions = false
            isHydratingAllPinnedSessions = false
            selectedServerId = Self.allPinnedServerId
            activeRoute = nil
            UserDefaults.standard.set(Self.allPinnedServerId, forKey: Self.selectedServerIdKey)
            sessionRows = []
            loadedSessionsServerId = nil
        }
        hydrateCachedSessions(for: Self.allPinnedServerId)
        await loadAllPinnedSessions(force: true)
        resolvePendingRouteIfPossible()
    }

    nonisolated private static func fetchAndCacheServerSessions(
        restClient: WatchRestClient,
        serverId: String,
        baseUrl: URL,
        apiKey: String,
        manualNames: Set<String>
    ) async -> (String, Result<[WatchSessionRow], Error>) {
        do {
            let response = try await restClient.fetchSessions(
                baseUrl: baseUrl,
                serverId: serverId,
                apiKey: apiKey
            )
            let rowsToCache = Self.prepareSessionsForCache(response.sessions, manualNames: manualNames)
            if let encoded = try? JSONEncoder().encode(rowsToCache) {
                Self.writeCacheData(encoded, named: Self.cachedSessionsFileName(for: serverId))
            }
            return (serverId, .success(response.sessions))
        } catch {
            return (serverId, .failure(error))
        }
    }

    private func loadAllPinnedSessions(force: Bool) async {
        guard canUseDirectApi, let apiKey = currentApiKey() else { return }
        guard !isLoadingAllPinnedSessions else { return }
        let batchToken = allPinnedBatchToken
        isLoadingAllPinnedSessions = true
        defer {
            if self.allPinnedBatchToken == batchToken {
                self.isLoadingAllPinnedSessions = false
            }
        }

        if servers.isEmpty {
            await loadServers(force: false)
        }
        guard isAllPinnedSelected, allPinnedBatchToken == batchToken else { return }

        let serverTargets: [(serverId: String, baseUrl: URL, manualNames: Set<String>)] = displayServers.compactMap { server in
            if !force && networkLoadedSessionServers.contains(server.id) {
                return nil
            }
            guard let baseUrl = currentBaseUrl(for: server.id) else { return nil }
            return (server.id, baseUrl, manualSessionNames(for: server.id))
        }
        guard !serverTargets.isEmpty else { return }

        let batchResult = await Task.detached(priority: .userInitiated) { [restClient] in
            var fetchedByServer: [String: [WatchSessionRow]] = [:]
            var firstError: String?

            await withTaskGroup(of: (String, Result<[WatchSessionRow], Error>).self) { group in
                let maxConcurrent = 4
                var nextIndex = 0

                while nextIndex < serverTargets.count && nextIndex < maxConcurrent {
                    let target = serverTargets[nextIndex]
                    nextIndex += 1
                    group.addTask {
                        await Self.fetchAndCacheServerSessions(
                            restClient: restClient,
                            serverId: target.serverId,
                            baseUrl: target.baseUrl,
                            apiKey: apiKey,
                            manualNames: target.manualNames
                        )
                    }
                }

                while let (serverId, result) = await group.next() {
                    switch result {
                    case .success(let rows):
                        fetchedByServer[serverId] = rows
                    case .failure(let error):
                        if firstError == nil {
                            firstError = (error as? WatchRestClient.WatchRestError)?.errorDescription
                                ?? error.localizedDescription
                        }
                    }

                    if nextIndex < serverTargets.count && !Task.isCancelled {
                        let target = serverTargets[nextIndex]
                        nextIndex += 1
                        group.addTask {
                            await Self.fetchAndCacheServerSessions(
                                restClient: restClient,
                                serverId: target.serverId,
                                baseUrl: target.baseUrl,
                                apiKey: apiKey,
                                manualNames: target.manualNames
                            )
                        }
                    }
                }
            }
            return (fetchedByServer, firstError)
        }.value

        guard isAllPinnedSelected, allPinnedBatchToken == batchToken else { return }

        let (fetchedByServer, firstError) = batchResult
        if !fetchedByServer.isEmpty {
            var nextSessionsByServer = sessionsByServerId
            for (serverId, rows) in fetchedByServer {
                nextSessionsByServer[serverId] = rows
                networkLoadedSessionServers.insert(serverId)
                let legacyKey = Self.cachedSessionsKey(for: serverId)
                if UserDefaults.standard.object(forKey: legacyKey) != nil {
                    UserDefaults.standard.removeObject(forKey: legacyKey)
                }
            }
            sessionsByServerId = nextSessionsByServer
            isUsingFallbackSnapshot = false
            lastErrorMessage = nil
            for (serverId, rows) in fetchedByServer {
                pruneSessionState(for: serverId, keepingSessionNames: Set(rows.map(\.sessionName)))
                seedVisibleHistoriesIfNeeded(serverId: serverId, pinnedOnly: true)
            }
            resolvePendingRouteIfPossible()
        } else if let firstError {
            isUsingFallbackSnapshot = true
            lastErrorMessage = firstError
        }
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

    // MARK: - Optimistic send UX
    //
    // The watch chat polls history every 6s when the detail view is open. That
    // still leaves a visible gap between tapping Send and the reply appearing
    // on the tiny screen. `appendOptimisticSend` injects a pending user bubble
    // immediately; `markOptimisticSendFailed` flips it to the red failure state
    // when the REST call errors. `WatchConversationItem.merge` replaces the
    // optimistic bubble when the real echo arrives (matched by commandId, with
    // a text+timestamp fallback for older daemons).

    func appendOptimisticSend(for route: WatchRoute, text: String, commandId: String) {
        seedHistoryStateIfNeeded(for: route)
        let item = WatchConversationItem.optimisticSend(
            sessionId: route.sessionName,
            text: text,
            commandId: commandId
        )
        updateHistoryState(for: route) { state in
            state.items = WatchConversationItem.merge(existing: state.items, incoming: [item])
        }
    }

    func markOptimisticSendFailed(for route: WatchRoute, commandId: String, reason: String?) {
        updateHistoryState(for: route) { state in
            state.items = state.items.map { item in
                guard item.commandId == commandId, item.isPending else { return item }
                var updated = item
                updated.isPending = false
                updated.isFailed = true
                updated.failureReason = reason
                return updated
            }
        }
    }

    func removeOptimisticSend(for route: WatchRoute, commandId: String) {
        updateHistoryState(for: route) { state in
            state.items = state.items.filter { item in
                !(item.commandId == commandId && (item.isPending || item.isFailed))
            }
        }
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
            if let saved = UserDefaults.standard.string(forKey: Self.selectedServerIdKey),
               !saved.isEmpty,
               saved == Self.allPinnedServerId || displayServers.isEmpty || displayServers.contains(where: { $0.id == saved }) {
                selectedServerId = saved
            } else if displayServers.count <= 1 {
                selectedServerId = context.currentServerId ?? displayServers.first?.id
            }
        } else if selectedServerId != Self.allPinnedServerId && !displayServers.isEmpty && !displayServers.contains(where: { $0.id == selectedServerId }) {
            selectedServerId = displayServers.count == 1 ? displayServers.first?.id : nil
        }
        if let selectedServerId, selectedServerId == Self.allPinnedServerId || loadedSessionsServerId != selectedServerId {
            hydrateCachedSessions(for: selectedServerId)
        }
        if triggerReload && canUseDirectApi {
            Task { await self.refresh() }
        }
    }

    private func hydrateCachedContext() {
        var cachedTaskData = Self.readCacheData(named: Self.cachedGlobalTasksFileName)
        if cachedTaskData == nil, let legacyTaskData = UserDefaults.standard.data(forKey: Self.cachedGlobalTasksKey) {
            cachedTaskData = legacyTaskData
            Self.writeCacheData(legacyTaskData, named: Self.cachedGlobalTasksFileName)
        }
        if UserDefaults.standard.object(forKey: Self.cachedGlobalTasksKey) != nil {
            UserDefaults.standard.removeObject(forKey: Self.cachedGlobalTasksKey)
        }
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix(Self.cachedSessionsKeyPrefix) {
            let serverId = String(key.dropFirst(Self.cachedSessionsKeyPrefix.count))
            if let legacyData = UserDefaults.standard.data(forKey: key), !serverId.isEmpty {
                let fileName = Self.cachedSessionsFileName(for: serverId)
                if Self.readCacheData(named: fileName) == nil {
                    Self.writeCacheData(legacyData, named: fileName)
                }
            }
            UserDefaults.standard.removeObject(forKey: key)
        }
        if let cachedTaskData,
           let decodedTasks = try? JSONDecoder().decode([WatchGlobalTaskRow].self, from: cachedTaskData) {
            globalTasks = decodedTasks
        }
        if let savedServerId = UserDefaults.standard.string(forKey: Self.selectedServerIdKey), !savedServerId.isEmpty {
            selectedServerId = savedServerId
        }
        guard WCSession.isSupported() else { return }
        let cached = WCSession.default.receivedApplicationContext
        guard !cached.isEmpty else { return }
        if let decoded = decodeContext(cached) {
            applicationContext = decoded
            for server in decoded.servers {
                let stored = UserDefaults.standard.stringArray(forKey: Self.manualSessionsKey(for: server.id)) ?? []
                if !stored.isEmpty {
                    manualSessionsByServer[server.id] = Set(stored)
                }
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
            for server in nextServers where manualSessionsByServer[server.id] == nil {
                let stored = UserDefaults.standard.stringArray(forKey: Self.manualSessionsKey(for: server.id)) ?? []
                if !stored.isEmpty {
                    manualSessionsByServer[server.id] = Set(stored)
                }
            }
            if let current = selectedServerId,
               current != Self.allPinnedServerId,
               !nextServers.contains(where: { $0.id == current }) {
                selectedServerId = nextServers.count == 1 ? nextServers.first?.id : nil
                if let resolved = selectedServerId {
                    hydrateCachedSessions(for: resolved)
                }
            } else if selectedServerId == nil && nextServers.count == 1 {
                selectedServerId = nextServers.first?.id
                if let resolved = selectedServerId {
                    hydrateCachedSessions(for: resolved)
                }
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
        if loadingSessionServers.contains(serverId) && !force { return }
        loadingSessionServers.insert(serverId)
        isLoadingSessions = !loadingSessionServers.isEmpty
        defer {
            loadingSessionServers.remove(serverId)
            isLoadingSessions = !loadingSessionServers.isEmpty
        }

        do {
            let response = try await restClient.fetchSessions(baseUrl: baseUrl, serverId: serverId, apiKey: apiKey)
            sessionsByServerId[serverId] = response.sessions
            if selectedServerId == serverId {
                sessionRows = response.sessions
                loadedSessionsServerId = serverId
            }
            networkLoadedSessionServers.insert(serverId)
            let fetchedSessions = response.sessions
            let manualNames = manualSessionNames(for: serverId)
            let cacheFileName = Self.cachedSessionsFileName(for: serverId)
            Task.detached(priority: .utility) {
                let rowsToCache = Self.prepareSessionsForCache(fetchedSessions, manualNames: manualNames)
                if let encoded = try? JSONEncoder().encode(rowsToCache) {
                    Self.writeCacheData(encoded, named: cacheFileName)
                }
            }
            let legacyKey = Self.cachedSessionsKey(for: serverId)
            if UserDefaults.standard.object(forKey: legacyKey) != nil {
                UserDefaults.standard.removeObject(forKey: legacyKey)
            }
            isUsingFallbackSnapshot = false
            lastErrorMessage = nil
            pruneSessionState(for: serverId, keepingSessionNames: Set(fetchedSessions.map(\.sessionName)))
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

    private func loadGlobalTasks(force: Bool) async {
        guard canUseDirectApi, let baseUrl = currentBaseUrl(), let apiKey = currentApiKey() else { return }
        if isLoadingGlobalTasks && !force { return }
        isLoadingGlobalTasks = true
        defer { isLoadingGlobalTasks = false }

        do {
            let nextTasks = try await restClient.fetchGlobalTasks(baseUrl: baseUrl, apiKey: apiKey)
            globalTasks = nextTasks
            let cacheFileName = Self.cachedGlobalTasksFileName
            Task.detached(priority: .utility) {
                if let encoded = try? JSONEncoder().encode(nextTasks) {
                    Self.writeCacheData(encoded, named: cacheFileName)
                }
            }
            if UserDefaults.standard.object(forKey: Self.cachedGlobalTasksKey) != nil {
                UserDefaults.standard.removeObject(forKey: Self.cachedGlobalTasksKey)
            }
        } catch {
            // Task status visibility is additive; keep cached tasks without failing server/session loads.
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

    nonisolated private static let autoShowAllMainSessionLimitCount = 5

    nonisolated private static func isSubSessionRow(_ row: WatchSessionRow) -> Bool {
        row.isSubSession || row.sessionName.hasPrefix("deck_sub_") || row.parentSessionName != nil
    }

    nonisolated private static func visibleSessionNameSet(in sessions: [WatchSessionRow], manualNames: Set<String>) -> Set<String> {
        let mainRows = sessions.filter { !Self.isSubSessionRow($0) }
        guard mainRows.count > Self.autoShowAllMainSessionLimitCount else {
            return Set(sessions.map(\.sessionName))
        }
        let visibleMainNames = Set(
            mainRows
                .filter { ($0.isPinned ?? false) || manualNames.contains($0.sessionName) }
                .map(\.sessionName)
        )
        var visible = visibleMainNames
        for row in sessions where Self.isSubSessionRow(row) {
            if let parent = row.parentSessionName, visibleMainNames.contains(parent) {
                visible.insert(row.sessionName)
            }
        }
        return visible
    }

    nonisolated private static func prepareSessionsForCache(_ sessions: [WatchSessionRow], manualNames: Set<String>) -> [WatchSessionRow] {
        let mainCount = sessions.reduce(into: 0) { count, row in
            if !Self.isSubSessionRow(row) { count += 1 }
        }
        guard mainCount > Self.autoShowAllMainSessionLimitCount else {
            return sessions
        }
        let visibleNames = visibleSessionNameSet(in: sessions, manualNames: manualNames)
        return sessions.map { row in
            if visibleNames.contains(row.sessionName) {
                return row
            }
            var stripped = row
            stripped.recentText = nil
            return stripped
        }
    }

    private func seedVisibleHistoriesIfNeeded(serverId: String, pinnedOnly: Bool = false) {
        let serverSessions = sessionsByServerId[serverId]
            ?? (loadedSessionsServerId == serverId
                ? sessionRows.filter { $0.serverId == serverId }
                : applicationContext.sessions.filter { $0.serverId == serverId })
        guard !serverSessions.isEmpty else { return }

        let targetRows: [WatchSessionRow]
        if pinnedOnly {
            var pinnedMainNames: Set<String> = []
            for row in serverSessions where !Self.isSubSessionRow(row) && (row.isPinned ?? false) {
                pinnedMainNames.insert(row.sessionName)
            }
            targetRows = serverSessions.filter { row in
                if Self.isSubSessionRow(row) {
                    return (row.isPinned ?? false)
                        || (row.parentSessionName.map { pinnedMainNames.contains($0) } ?? false)
                }
                return row.isPinned ?? false
            }
        } else {
            let manual = manualSessionNames(for: serverId)
            let visibleNames = Self.visibleSessionNameSet(in: serverSessions, manualNames: manual)
            targetRows = serverSessions.filter { visibleNames.contains($0.sessionName) }
        }

        for row in targetRows {
            let route = WatchRoute(serverId: row.serverId, sessionName: row.sessionName, title: row.title)
            if historyByRoute[route.id] == nil {
                historyByRoute[route.id] = seededHistoryState(for: route)
            }
        }
    }

    private func reconcileCommandReceipts(from context: WatchApplicationContext) {
        for row in context.sessions {
            let receipts = row.allCommandReceipts
            guard !receipts.isEmpty else { continue }
            let route = WatchRoute(serverId: row.serverId, sessionName: row.sessionName, title: row.title)
            updateHistoryState(for: route) { state in
                state.items = state.items.map { item in
                    guard let commandId = item.commandId,
                          let receipt = receipts.last(where: { $0.commandId == commandId }) else {
                        return item
                    }
                    guard receipt.status == "error" else { return item }
                    var updated = item
                    updated.isPending = false
                    updated.isFailed = true
                    updated.failureReason = receipt.reason ?? "Send failed"
                    return updated
                }
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

    private func requestSnapshotFromPhoneIfReachable(force: Bool = false) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        let now = Date()
        if !force && now.timeIntervalSince(lastSnapshotRequestAt) < 3 {
            return
        }
        lastSnapshotRequestAt = now
        session.sendMessage(["action": "requestSnapshot"], replyHandler: nil, errorHandler: nil)
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
        case "session.notification", "ask.question":
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
            if let error {
                self.lastErrorMessage = error.localizedDescription
            }
            if activationState == .activated {
                let received = WCSession.default.receivedApplicationContext
                if !received.isEmpty, self.currentApiKey() == nil, let decoded = self.decodeContext(received) {
                    self.applicationContext = decoded
                    self.reconcileCommandReceipts(from: decoded)
                    self.bootstrapFromContext(decoded, triggerReload: true)
                    self.lastErrorMessage = nil
                    self.resolvePendingRouteIfPossible()
                } else if self.canUseDirectApi {
                    await self.ensureLoaded()
                } else {
                    self.requestSnapshotFromPhoneIfReachable()
                }
            }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
        Task { @MainActor in
            if let decoded = self.decodeContext(applicationContext) {
                self.applicationContext = decoded
                self.reconcileCommandReceipts(from: decoded)
                self.bootstrapFromContext(decoded, triggerReload: true)
                self.lastErrorMessage = nil
                self.resolvePendingRouteIfPossible()
            } else {
                self.lastErrorMessage = "Unable to decode watch context."
            }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
        Task { @MainActor in
            self.handleWatchAsrMessage(message)
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String : Any], replyHandler: @escaping ([String : Any]) -> Void) {
        replyHandler(["ok": true])
        Task { @MainActor in
            self.handleWatchAsrMessage(message)
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String : Any]) {
        Task { @MainActor in
            if (userInfo["action"] as? String) == "watchAsrResult" {
                self.handleWatchAsrMessage(userInfo)
            } else {
                self.handleDurableEvent(userInfo)
            }
        }
    }

    nonisolated func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        let metadata = fileTransfer.file.metadata
        let fileURL = fileTransfer.file.fileURL
        Task { @MainActor in
            WatchVoiceInputManager.shared.handleFileTransferCompleted(
                metadata: metadata,
                fileURL: fileURL,
                error: error
            )
        }
    }

    private func handleWatchAsrMessage(_ message: [String: Any]) {
        guard let action = message["action"] as? String else { return }
        switch action {
        case "watchAsrResult":
            WatchVoiceInputManager.shared.handleWatchAsrResult(message)
        case "watchAsrStatus":
            WatchVoiceInputManager.shared.handleWatchAsrStatus(message)
        default:
            break
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in
            if session.isReachable, !self.canUseDirectApi {
                self.requestSnapshotFromPhoneIfReachable()
            }
        }
    }
}
