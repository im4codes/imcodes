import SwiftUI

private enum WatchViewMode: String, CaseIterable {
    case tasks
    case sessions

    var label: String {
        switch self {
        case .tasks: return "Tasks"
        case .sessions: return "Sessions"
        }
    }

    var toggled: WatchViewMode {
        switch self {
        case .tasks: return .sessions
        case .sessions: return .tasks
        }
    }

    var iconName: String {
        switch self {
        case .tasks: return "checklist"
        case .sessions: return "bubble.left.and.bubble.right"
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var sessionManager: WatchSessionManager
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("watchViewMode") private var viewMode: WatchViewMode = .tasks
    @State private var path: [WatchRoute] = []
    @State private var showServerPicker = false
    @State private var showTaskServerFilter = false
    @State private var showAddSessionSheet = false
    @State private var expandedSessions: Set<String> = []

    private static let autoShowAllMainSessionLimit = 5

    private var activeServerId: String? {
        sessionManager.selectedServerId ?? (sessionManager.displayServers.count == 1 ? sessionManager.displayServers.first?.id : nil)
    }

    private var requiresServerSelection: Bool {
        sessionManager.displayServers.count > 1 && sessionManager.selectedServerId == nil
    }

    private var currentSessions: [WatchSessionRow] {
        sessionManager.displaySessions()
    }

    private var currentTasks: [WatchGlobalTaskRow] {
        sessionManager.displayTasks()
    }

    private func isSubSessionRow(_ row: WatchSessionRow) -> Bool {
        row.isSubSession || row.sessionName.hasPrefix("deck_sub_") || row.parentSessionName != nil
    }

    private var mainSessions: [WatchSessionRow] {
        currentSessions.filter { !isSubSessionRow($0) }
    }

    private var currentManualSessionNames: Set<String> {
        guard let activeServerId else { return [] }
        return sessionManager.manualSessionNames(for: activeServerId)
    }

    private var isManualFilterActive: Bool {
        mainSessions.count > Self.autoShowAllMainSessionLimit
    }

    private var visibleMainSessions: [WatchSessionRow] {
        guard !requiresServerSelection else { return [] }
        guard isManualFilterActive else { return mainSessions }
        let manual = currentManualSessionNames
        return mainSessions.filter { ($0.isPinned ?? false) || manual.contains($0.sessionName) }
    }

    private var addableMainSessions: [WatchSessionRow] {
        guard !requiresServerSelection, isManualFilterActive else { return [] }
        let manual = currentManualSessionNames
        return mainSessions.filter { !($0.isPinned ?? false) && !manual.contains($0.sessionName) }
    }

    private func subSessions(for parent: String) -> [WatchSessionRow] {
        currentSessions.filter { isSubSessionRow($0) && $0.parentSessionName == parent }
    }

    private func brainRoute(for task: WatchGlobalTaskRow) -> WatchRoute? {
        guard let brainSession = task.brainSession?.trimmingCharacters(in: .whitespacesAndNewlines),
              !brainSession.isEmpty,
              sessionManager.displayServers.contains(where: { $0.id == task.serverId }) else {
            return nil
        }
        let brainTitle = [task.brainLabel, task.projectName]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty }) ?? task.title
        return WatchRoute(serverId: task.serverId, sessionName: brainSession, title: brainTitle)
    }

    private var modeToggleButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) {
                viewMode = viewMode.toggled
            }
        } label: {
            Image(systemName: viewMode.iconName)
                .font(.caption2)
        }
        .accessibilityLabel("Switch to \(viewMode.toggled.label)")
    }

    @ViewBuilder
    private var trailingToolbarButton: some View {
        if viewMode == .tasks {
            if !sessionManager.displayServers.isEmpty {
                Button {
                    showTaskServerFilter = true
                } label: {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                        .font(.caption2)
                        .foregroundStyle(sessionManager.selectedTaskServerIds != nil ? .cyan : .primary)
                }
                .accessibilityLabel("Filter devices")
            }
        } else if sessionManager.displayServers.count > 1 {
            Button {
                showServerPicker = true
            } label: {
                Image(systemName: "server.rack")
                    .font(.caption2)
            }
            .accessibilityLabel("Select server")
        }
    }

    @ViewBuilder
    private var statusBanners: some View {
        if sessionManager.isUsingFallbackSnapshot {
            Text("Cached snapshot")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }

        if let error = sessionManager.lastErrorMessage, !error.isEmpty {
            Text(error)
                .font(.caption2)
                .foregroundStyle(.red)
        }
    }

    @ViewBuilder
    private var tasksModeContent: some View {
        if currentTasks.isEmpty {
            VStack(spacing: 8) {
                statusBanners
                if sessionManager.isLoadingGlobalTasks {
                    ProgressView()
                } else {
                    Text("No tasks")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if !sessionManager.globalTasks.isEmpty && !sessionManager.displayServers.isEmpty {
                        Button("Filter Devices") {
                            showTaskServerFilter = true
                        }
                        .font(.caption2)
                    }
                    if !mainSessions.isEmpty || requiresServerSelection {
                        Button("View Sessions") {
                            viewMode = .sessions
                        }
                        .font(.caption2)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
        } else {
            List {
                statusBanners

                ForEach(currentTasks) { task in
                    let route = brainRoute(for: task)
                    if let route {
                        Button {
                            path = [route]
                        } label: {
                            TaskRowView(task: task, hasNavigation: true)
                        }
                        .buttonStyle(.plain)
                    } else {
                        TaskRowView(task: task, hasNavigation: false)
                    }
                }
            }
            .listStyle(.plain)
        }
    }

    @ViewBuilder
    private var sessionsModeContent: some View {
        if requiresServerSelection {
            List {
                statusBanners
                Section("Select Server") {
                    ForEach(sessionManager.displayServers) { server in
                        Button {
                            Task { await sessionManager.selectServer(server.id) }
                        } label: {
                            HStack {
                                if server.isPinned ?? false {
                                    Image(systemName: "pin.fill")
                                        .font(.system(size: 8))
                                        .foregroundStyle(.orange)
                                }
                                Text(server.name)
                                    .font(.caption)
                                    .lineLimit(1)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
        } else if visibleMainSessions.isEmpty {
            VStack(spacing: 8) {
                statusBanners
                if sessionManager.isLoadingSessions || sessionManager.isLoadingServers {
                    ProgressView()
                } else {
                    Text(isManualFilterActive ? "No pinned sessions" : "No sessions")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if !addableMainSessions.isEmpty {
                        Button {
                            showAddSessionSheet = true
                        } label: {
                            Label("Add Session", systemImage: "plus.circle")
                                .font(.caption2)
                        }
                    }
                    if !currentTasks.isEmpty {
                        Button("View Tasks") {
                            viewMode = .tasks
                        }
                        .font(.caption2)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
        } else {
            List {
                statusBanners

                ForEach(visibleMainSessions) { session in
                    let subs = subSessions(for: session.sessionName)
                    let isExpanded = expandedSessions.contains(session.sessionName)
                    let isManualOnly = isManualFilterActive
                        && !(session.isPinned ?? false)
                        && currentManualSessionNames.contains(session.sessionName)

                    HStack(spacing: 0) {
                        Button {
                            path = [WatchRoute(serverId: session.serverId, sessionName: session.sessionName, title: session.title)]
                        } label: {
                            SessionRowView(session: session)
                        }
                        .buttonStyle(.plain)

                        Spacer(minLength: 4)

                        if !subs.isEmpty {
                            Button {
                                withAnimation {
                                    if isExpanded { expandedSessions.remove(session.sessionName) }
                                    else { expandedSessions.insert(session.sessionName) }
                                }
                            } label: {
                                HStack(spacing: 2) {
                                    Text("\(subs.count)")
                                        .font(.system(size: 9))
                                        .foregroundStyle(.secondary)
                                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 7))
                                        .foregroundStyle(.tertiary)
                                }
                                .frame(minWidth: 28, minHeight: 28)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .swipeActions(edge: .trailing) {
                        if isManualOnly {
                            Button(role: .destructive) {
                                sessionManager.removeManualSession(session.sessionName, serverId: session.serverId)
                            } label: {
                                Label("Remove", systemImage: "trash")
                            }
                        }
                        if !subs.isEmpty {
                            Button {
                                withAnimation {
                                    if isExpanded { expandedSessions.remove(session.sessionName) }
                                    else { expandedSessions.insert(session.sessionName) }
                                }
                            } label: {
                                Label(isExpanded ? "Fold" : "\(subs.count) sub", systemImage: isExpanded ? "chevron.up" : "chevron.down")
                            }
                            .tint(.blue)
                        }
                    }

                    if isExpanded {
                        ForEach(subs) { sub in
                            Button {
                                path = [WatchRoute(serverId: sub.serverId, sessionName: sub.sessionName, title: sub.title)]
                            } label: {
                                SessionRowView(session: sub)
                                    .padding(.leading, 14)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if !addableMainSessions.isEmpty {
                    Button {
                        showAddSessionSheet = true
                    } label: {
                        Label("Add Session", systemImage: "plus.circle")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .listStyle(.plain)
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if sessionManager.currentApiKey() == nil && currentSessions.isEmpty && currentTasks.isEmpty {
                    VStack(spacing: 8) {
                        Text("Open IM.codes on iPhone")
                            .font(.footnote)
                        Text("Login once to sync Watch access")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .padding()
                } else {
                    switch viewMode {
                    case .tasks:
                        tasksModeContent
                    case .sessions:
                        sessionsModeContent
                    }
                }
            }
            .navigationTitle(viewMode.label)
            .toolbar {
                if #available(watchOS 10.5, *) {
                    ToolbarItem(placement: .topBarLeading) {
                        modeToggleButton
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        trailingToolbarButton
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) {
                        modeToggleButton
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        trailingToolbarButton
                    }
                }
            }
            .sheet(isPresented: $showServerPicker) {
                List(sessionManager.displayServers) { server in
                    Button {
                        showServerPicker = false
                        Task { await sessionManager.selectServer(server.id) }
                    } label: {
                        HStack {
                            if server.isPinned ?? false {
                                Image(systemName: "pin.fill")
                                    .font(.system(size: 8))
                                    .foregroundStyle(.orange)
                            }
                            Text(server.name).font(.caption)
                            Spacer()
                            if sessionManager.selectedServerId == server.id {
                                Image(systemName: "checkmark")
                                    .font(.caption2)
                            }
                        }
                    }
                }
            }
            .sheet(isPresented: $showTaskServerFilter) {
                NavigationStack {
                    List {
                        Section("Devices") {
                            ForEach(sessionManager.displayServers) { server in
                                Toggle(isOn: Binding(
                                    get: { sessionManager.isTaskServerVisible(server.id) },
                                    set: { _ in sessionManager.toggleTaskServerVisibility(server.id) }
                                )) {
                                    HStack(spacing: 4) {
                                        if server.isPinned ?? false {
                                            Image(systemName: "pin.fill")
                                                .font(.system(size: 8))
                                                .foregroundStyle(.orange)
                                        }
                                        Text(server.name)
                                            .font(.caption)
                                            .lineLimit(1)
                                    }
                                }
                            }
                        }
                    }
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") {
                                showTaskServerFilter = false
                            }
                        }
                    }
                }
            }
            .sheet(isPresented: $showAddSessionSheet) {
                if addableMainSessions.isEmpty {
                    Text("No sessions to add")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding()
                } else {
                    List(addableMainSessions) { session in
                        Button {
                            sessionManager.addManualSession(session.sessionName, serverId: session.serverId)
                            showAddSessionSheet = false
                        } label: {
                            SessionRowView(session: session)
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationDestination(for: WatchRoute.self) { route in
                SessionDetailView(route: route)
            }
            .refreshable {
                await sessionManager.refresh()
            }
            .task {
                await sessionManager.ensureLoaded()
                // Auto-refresh every 12s while list is visible and active
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(12))
                    guard !Task.isCancelled else { break }
                    if scenePhase == .active {
                        await sessionManager.refreshSessions()
                    }
                }
            }
            .onChange(of: scenePhase) { newPhase in
                guard newPhase == .active else { return }
                Task { await sessionManager.refreshOnForeground() }
            }
            .onChange(of: viewMode) { _ in
                Task { await sessionManager.refreshSessions() }
            }
            .onChange(of: sessionManager.activeRoute) { newRoute in
                guard let newRoute else { return }
                path = [newRoute]
            }
        }
    }
}

private struct SessionRowView: View {
    let session: WatchSessionRow

    var body: some View {
        HStack(spacing: 5) {
            VStack(spacing: 2) {
                Circle()
                    .fill(stateColor)
                    .frame(width: 7, height: 7)
                if session.isPinned == true {
                    Circle()
                        .fill(.orange)
                        .frame(width: 3, height: 3)
                }
            }
            .frame(width: 8)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(session.title)
                        .font(.system(size: 13))
                        .lineLimit(1)
                    if !session.agentBadge.isEmpty {
                        Text(session.agentBadge)
                            .font(.system(size: 8))
                            .foregroundStyle(.tertiary)
                    }
                }

                if let previewText = session.effectivePreviewText, !previewText.isEmpty {
                    Text(previewText)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
    }

    private var stateColor: Color {
        switch session.state {
        case .working: return .yellow
        case .idle: return .green
        case .error: return .red
        case .stopped: return .gray
        }
    }
}

private struct TaskRowView: View {
    let task: WatchGlobalTaskRow
    let hasNavigation: Bool

    var body: some View {
        HStack(spacing: 4) {
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)

                HStack(spacing: 4) {
                    Text(statusLabel)
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(statusColor)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(statusColor.opacity(0.18), in: Capsule())
                        .lineLimit(1)

                    if let round = task.round, round > 0 {
                        Text("R\(round)")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    if let project = task.projectName?.trimmingCharacters(in: .whitespacesAndNewlines),
                       !project.isEmpty {
                        Text(project)
                            .font(.system(size: 9))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }

                if let checklist = task.checklist, checklist.total > 0 {
                    let total = checklist.total
                    let implemented = min(max(checklist.implemented, 0), total)
                    let audited = min(max(checklist.audited, 0), total)
                    let countLabel = (audited > 0 && audited < total)
                        ? "\(implemented)/\(total) ✓\(audited)"
                        : "\(implemented)/\(total)"
                    HStack(spacing: 4) {
                        ProgressView(value: Double(implemented), total: Double(total))
                            .progressViewStyle(.linear)
                            .tint(statusColor)
                        Text(countLabel)
                            .font(.system(size: 9, weight: .medium, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                if let summary = task.liveSummary?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !summary.isEmpty {
                    Text(summary)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            if hasNavigation {
                Spacer(minLength: 2)
                Image(systemName: "chevron.right")
                    .font(.system(size: 8))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var normalizedStatus: String {
        task.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var statusLabel: String {
        switch normalizedStatus {
        case "working": return "Working"
        case "in_audit", "awaiting_audit": return "In Audit"
        case "rework": return "Rework"
        case "passed": return "Passed"
        case "done": return "Done"
        case "queued": return "Queued"
        case "paused": return "Paused"
        case "blocked": return "Blocked"
        case "needs_input": return "Input"
        case "needs_decision": return "Decision"
        case "cancelled", "canceled": return "Cancelled"
        default: return task.status
        }
    }

    private var statusColor: Color {
        if task.needsAttention == true {
            return .orange
        }
        switch normalizedStatus {
        case "working":
            return .yellow
        case "in_audit", "awaiting_audit":
            return .cyan
        case "rework", "needs_input", "needs_decision":
            return .orange
        case "blocked":
            return .red
        case "passed", "done":
            return .green
        case "queued", "paused":
            return .blue
        case "cancelled", "canceled":
            return .gray
        default:
            return .secondary
        }
    }
}
