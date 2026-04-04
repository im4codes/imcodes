import SwiftUI
import WatchKit

struct ContentView: View {
    @EnvironmentObject private var sessionManager: WatchSessionManager
    @State private var path: [WatchRoute] = []
    @State private var showServerPicker = false
    @State private var expandedSessions: Set<String> = []

    private var mainSessions: [WatchSessionRow] {
        sessionManager.applicationContext.sessions.filter { !$0.isSubSession }
    }

    private func subSessions(for parent: String) -> [WatchSessionRow] {
        sessionManager.applicationContext.sessions.filter { $0.parentSessionName == parent }
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if sessionManager.applicationContext.sessions.isEmpty {
                    VStack(spacing: 6) {
                        Text("No sessions")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Text("Open IM.codes on iPhone")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    .padding()
                } else {
                    List {
                        ForEach(mainSessions) { session in
                            let subs = subSessions(for: session.sessionName)
                            let isExpanded = expandedSessions.contains(session.sessionName)

                            // Main session row + expand button
                            HStack(spacing: 0) {
                                Button {
                                    path = [WatchRoute(serverId: session.serverId, sessionName: session.sessionName)]
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

                            // Sub-sessions
                            if isExpanded {
                                ForEach(subs) { sub in
                                    Button {
                                        path = [WatchRoute(serverId: sub.serverId, sessionName: sub.sessionName)]
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
                    if sessionManager.applicationContext.servers.count > 1 {
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
                List(sessionManager.applicationContext.servers) { server in
                    Button {
                        showServerPicker = false
                        sessionManager.requestServerSwitch(to: server.id)
                    } label: {
                        HStack {
                            Text(server.name).font(.caption)
                            Spacer()
                            if sessionManager.applicationContext.currentServerId == server.id {
                                Image(systemName: "checkmark").font(.caption2)
                            }
                        }
                    }
                }
            }
            .navigationDestination(for: WatchRoute.self) { route in
                SessionDetailView(route: route)
            }
            .refreshable {
                sessionManager.requestRefresh()
                try? await Task.sleep(for: .seconds(2))
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
            // State dot + optional pin dot, stacked vertically
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

            // Title + badge + preview, left-aligned
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

                if let previewText = session.previewText, !previewText.isEmpty {
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
