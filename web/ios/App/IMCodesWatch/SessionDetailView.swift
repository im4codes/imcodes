import SwiftUI
import WatchKit

struct SessionDetailView: View {
    @EnvironmentObject private var sessionManager: WatchSessionManager
    let route: WatchRoute

    @State private var draft = ""
    @State private var isSending = false
    @State private var statusMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                // Label + type
                HStack(spacing: 6) {
                    Circle()
                        .fill(stateColor)
                        .frame(width: 8, height: 8)
                    Text(session?.title ?? route.sessionName)
                        .font(.caption)
                        .fontWeight(.medium)
                    Text(session?.agentBadge ?? "")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }

                // Preview text
                if let previewText = session?.previewText, !previewText.isEmpty {
                    Text(previewText)
                        .font(.system(size: 11))
                        .foregroundStyle(.primary)
                    if let ts = session?.previewUpdatedAt, ts > 0 {
                        Text(Date(timeIntervalSince1970: ts / 1000), style: .relative)
                            .font(.system(size: 9))
                            .foregroundStyle(.tertiary)
                    }
                }

                Divider()

                // Reply
                TextField("Reply…", text: $draft)
                    .font(.caption2)

                HStack(spacing: 8) {
                    Button(isSending ? "…" : "Send") {
                        Task { await sendReply() }
                    }
                    .font(.caption2)
                    .disabled(!canSend || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)

                    Spacer()

                    // Open on iPhone
                    Button {
                        sessionManager.openOnPhone(route: route)
                    } label: {
                        Image(systemName: "iphone.and.arrow.right.outward")
                            .font(.caption2)
                    }
                }

                if let statusMessage {
                    Text(statusMessage)
                        .font(.system(size: 9))
                        .foregroundStyle(statusMessage == "Sent" ? .green : .red)
                }
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle(session?.title ?? route.sessionName)
        .onDisappear {
            sessionManager.clearActiveRoute()
        }
    }

    private var canSend: Bool {
        session != nil
            && sessionManager.applicationContext.snapshotStatus != .switching
            && sessionManager.applicationContext.apiKey?.isEmpty == false
            && sessionManager.currentServer() != nil
    }

    private var session: WatchSessionRow? {
        sessionManager.applicationContext.sessions.first(where: { $0.serverId == route.serverId && $0.sessionName == route.sessionName })
    }

    private var stateColor: Color {
        guard let session else { return .gray }
        switch session.state {
        case .working: return .yellow
        case .idle: return .green
        case .error: return .red
        case .stopped: return .gray
        }
    }

    private func sendReply() async {
        guard !isSending else { return }
        guard let server = sessionManager.currentServer(),
              let session,
              let apiKey = sessionManager.applicationContext.apiKey, !apiKey.isEmpty else {
            statusMessage = "Not ready"
            return
        }

        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        isSending = true
        defer { isSending = false }

        do {
            let client = WatchRestClient()
            guard let baseURL = URL(string: server.baseUrl) else {
                statusMessage = "Bad URL"
                return
            }
            let result = try await client.sendReply(
                baseUrl: baseURL, serverId: server.id,
                sessionName: session.sessionName, text: text, apiKey: apiKey
            )
            switch result {
            case .accepted:
                draft = ""
                WKInterfaceDevice.current().play(.success)
                statusMessage = "Sent"
            case .authExpired:
                WKInterfaceDevice.current().play(.failure)
                statusMessage = "Auth expired"
            case .agentUnavailable:
                WKInterfaceDevice.current().play(.failure)
                statusMessage = "Agent offline"
            }
        } catch {
            WKInterfaceDevice.current().play(.failure)
            statusMessage = "Network error"
        }
    }
}
