import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var sessionManager: WatchSessionManager
    @State private var path: [WatchRoute] = []
    @State private var showServerPicker = false
    @State private var expandedSessions: Set<String> = []

    private var currentSessions: [WatchSessionRow] {
        sessionManager.displaySessions()
    }

    private func isSubSessionRow(_ row: WatchSessionRow) -> Bool {
        row.isSubSession || row.sessionName.hasPrefix("deck_sub_") || row.parentSessionName != nil
    }

    private var mainSessions: [WatchSessionRow] {
        currentSessions.filter { !isSubSessionRow($0) }
    }

    private func subSessions(for parent: String) -> [WatchSessionRow] {
        currentSessions.filter { isSubSessionRow($0) && $0.parentSessionName == parent }
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if currentSessions.isEmpty {
                    VStack(spacing: 8) {
                        if sessionManager.currentApiKey() == nil {
                            Text("Open IM.codes on iPhone")
                                .font(.footnote)
                            Text("Login once to sync Watch access")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        } else if sessionManager.isLoadingSessions || sessionManager.isLoadingServers {
                            ProgressView()
                        } else {
                            Text("No sessions")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding()
                } else {
                    List {
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

                        ForEach(mainSessions) { session in
                            let subs = subSessions(for: session.sessionName)
                            let isExpanded = expandedSessions.contains(session.sessionName)

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
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("IM.codes")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if sessionManager.displayServers.count > 1 {
                        Button {
                            showServerPicker = true
                        } label: {
                            Image(systemName: "server.rack")
                                .font(.caption2)
                        }
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
            .navigationDestination(for: WatchRoute.self) { route in
                SessionDetailView(route: route)
            }
            .refreshable {
                await sessionManager.refresh()
            }
            .task {
                await sessionManager.ensureLoaded()
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
