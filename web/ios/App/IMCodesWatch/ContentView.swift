import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var sessionManager: WatchSessionManager
    @State private var path: [WatchRoute] = []
    @State private var showServerPicker = false

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 8) {
                Button("Refresh") {
                    sessionManager.requestRefresh()
                }
                .disabled(sessionManager.activationState != .activated)

                if let lastErrorMessage = sessionManager.lastErrorMessage, !lastErrorMessage.isEmpty {
                    Text(lastErrorMessage)
                        .font(.caption2)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.red)
                        .padding(.horizontal, 8)
                }

                Group {
                    if sessionManager.applicationContext.sessions.isEmpty {
                        emptyState
                    } else {
                        sessionList
                    }
                }
            }
            .navigationTitle("IM Codes")
            .toolbar {
                ToolbarItem {
                    Button {
                        showServerPicker = true
                    } label: {
                        Image(systemName: "server.rack")
                    }
                    .disabled(sessionManager.applicationContext.servers.isEmpty)
                }
            }
            .sheet(isPresented: $showServerPicker) {
                serverPickerSheet
            }
            .navigationDestination(for: WatchRoute.self) { route in
                SessionDetailView(route: route)
            }
            .onChange(of: sessionManager.activeRoute) { route in
                guard let route else { return }
                path = [route]
            }
        }
    }

    @ViewBuilder
    private var sessionList: some View {
        List(sessionManager.applicationContext.sessions) { session in
            NavigationLink(value: WatchRoute(serverId: session.serverId, sessionName: session.sessionName)) {
                SessionRowView(session: session)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "applewatch")
                .font(.title2)
            Text("No sessions yet")
                .font(.headline)
            Text("Sync the phone app to populate this view.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .padding()
    }

    private var serverPickerSheet: some View {
        List(sessionManager.applicationContext.servers) { server in
            Button {
                showServerPicker = false
                sessionManager.requestServerSwitch(to: server.id)
            } label: {
                HStack {
                    Text(server.name)
                    Spacer()
                    if sessionManager.applicationContext.currentServerId == server.id {
                        Image(systemName: "checkmark")
                    }
                }
            }
        }
    }
}

private struct SessionRowView: View {
    let session: WatchSessionRow

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(stateColor)
                .frame(width: 10, height: 10)
                .padding(.top, 6)

            VStack(alignment: .leading, spacing: 2) {
                Text(session.title)
                    .font(.headline)
                    .lineLimit(1)

                if let parentTitle = session.parentTitle, !parentTitle.isEmpty {
                    Text(parentTitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                if let previewText = session.previewText, !previewText.isEmpty {
                    Text(previewText)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                } else {
                    Text(session.state.rawValue)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var stateColor: Color {
        switch session.state {
        case .working:
            return .yellow
        case .idle:
            return .green
        case .error:
            return .red
        case .stopped:
            return .gray
        }
    }
}
