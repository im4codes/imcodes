import SwiftUI
import WatchKit

struct SessionDetailView: View {
    @EnvironmentObject private var sessionManager: WatchSessionManager
    let route: WatchRoute

    @State private var draft = ""
    @State private var isSending = false
    @State private var statusMessage: String?

    var body: some View {
        Form {
            Section("Session") {
                if let session {
                    LabeledContent("Title", value: session.title)
                    LabeledContent("Session", value: session.sessionName)
                    LabeledContent("State", value: stateBadge)
                    if let parentTitle = session.parentTitle, !parentTitle.isEmpty {
                        LabeledContent("Parent", value: parentTitle)
                    }
                } else {
                    Text("Session unavailable.")
                        .foregroundStyle(.secondary)
                }
            }

            Section("Preview") {
                if let previewText = session?.previewText, !previewText.isEmpty {
                    Text(previewText)
                        .font(.footnote)
                    if let previewUpdatedAt = session?.previewUpdatedAt {
                        Text(Date(timeIntervalSince1970: previewUpdatedAt / 1000), style: .relative)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text("No preview available.")
                        .foregroundStyle(.secondary)
                }
            }

            Section("Reply") {
                TextField("Reply", text: $draft)

                Button(isSending ? "Sending…" : "Send") {
                    Task { await sendReply() }
                }
                .disabled(session == nil || !canSend || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
            }

            if let statusMessage {
                Section("Status") {
                    Text(statusMessage)
                }
            }
        }
        .navigationTitle(session?.title ?? route.sessionName)
        .onDisappear {
            sessionManager.clearActiveRoute()
        }
    }

    private var canSend: Bool {
        sessionManager.applicationContext.snapshotStatus != .switching
            && sessionManager.applicationContext.apiKey?.isEmpty == false
            && sessionManager.currentServer() != nil
    }

    private var session: WatchSessionRow? {
        sessionManager.applicationContext.sessions.first(where: { $0.serverId == route.serverId && $0.sessionName == route.sessionName })
    }

    private var stateBadge: String {
        guard let session else { return "⚪ unavailable" }
        switch session.state {
        case .working: return "🟡 working"
        case .idle: return "🟢 idle"
        case .error: return "🔴 error"
        case .stopped: return "⚪ stopped"
        }
    }

    private func sendReply() async {
        guard !isSending else { return }
        guard let server = sessionManager.currentServer() else {
            statusMessage = "No active server"
            return
        }
        guard let session else {
            statusMessage = "Session unavailable"
            return
        }
        guard let apiKey = sessionManager.applicationContext.apiKey, !apiKey.isEmpty else {
            statusMessage = "Missing API key"
            return
        }

        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        isSending = true
        defer { isSending = false }

        do {
            let client = WatchRestClient()
            guard let baseURL = URL(string: server.baseUrl) else {
                statusMessage = "Invalid server URL"
                return
            }

            let result = try await client.sendReply(
                baseUrl: baseURL,
                serverId: server.id,
                sessionName: session.sessionName,
                text: text,
                apiKey: apiKey
            )
            switch result {
            case .accepted:
                draft = ""
                WKInterfaceDevice.current().play(.success)
                statusMessage = "Sent"
            case .authExpired:
                WKInterfaceDevice.current().play(.failure)
                statusMessage = "Authentication expired"
            case .agentUnavailable:
                WKInterfaceDevice.current().play(.failure)
                statusMessage = "Agent unavailable"
            }
        } catch {
            WKInterfaceDevice.current().play(.failure)
            statusMessage = error.localizedDescription
        }
    }
}
