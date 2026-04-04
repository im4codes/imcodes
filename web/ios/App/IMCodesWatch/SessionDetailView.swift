import SwiftUI
import WatchKit

struct SessionDetailView: View {
    @EnvironmentObject private var sessionManager: WatchSessionManager
    let route: WatchRoute

    @State private var draft = ""
    @State private var isSending = false
    @State private var statusMessage: String?

    private let quickReplies = ["Yes", "Continue", "Fix"]


    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                header

                if historyState.hasMore {
                    Button(historyState.isLoadingOlder ? "Loading…" : "Load older") {
                        Task { await sessionManager.loadOlderHistory(for: route) }
                    }
                    .font(.caption2)
                    .disabled(historyState.isLoadingOlder)
                }

                chatSection

                Divider()

                replyComposer
                quickReplySection

                if let statusMessage {
                    Text(statusMessage)
                        .font(.system(size: 9))
                        .foregroundStyle(statusMessage == "Sent" ? .green : .red)
                }
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle(session?.title ?? route.sessionName)
        .task {
            await sessionManager.loadHistoryIfNeeded(for: route)
        }
        .onDisappear {
            sessionManager.clearActiveRoute()
        }
    }

    private var header: some View {
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
    }

    @ViewBuilder
    private var chatSection: some View {
        if historyState.isLoading && historyState.items.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity, alignment: .center)
        } else if historyState.items.isEmpty {
            Text("No messages yet")
                .font(.caption2)
                .foregroundStyle(.secondary)
        } else {
            LazyVStack(alignment: .leading, spacing: 6) {
                ForEach(historyState.items) { item in
                    HStack {
                        if item.isUser { Spacer(minLength: 20) }
                        Text(item.text)
                            .font(.system(size: 12))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                            .foregroundStyle(item.isUser ? Color.white : Color.primary)
                            .background(item.isUser ? Color.green : Color.gray.opacity(0.22))
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        if !item.isUser { Spacer(minLength: 20) }
                    }
                }
            }
        }

        if let error = historyState.errorMessage, !error.isEmpty {
            Text(error)
                .font(.system(size: 9))
                .foregroundStyle(.red)
        }
    }


    private var quickReplySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Quick replies")
                .font(.system(size: 9))
                .foregroundStyle(.secondary)

            HStack(spacing: 6) {
                ForEach(quickReplies, id: \.self) { reply in
                    Button(reply) {
                        Task { await sendReply(text: reply) }
                    }
                    .font(.system(size: 10))
                    .buttonStyle(.bordered)
                    .disabled(!canSend || isSending)
                }
            }
        }
    }

    private var replyComposer: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Reply…", text: $draft)
                .font(.caption2)

            HStack(spacing: 8) {
                Button(isSending ? "…" : "Send") {
                    Task { await sendReply(text: draft) }
                }
                .font(.caption2)
                .disabled(!canSend || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)

                Spacer()

                Button {
                    sessionManager.openOnPhone(route: route)
                } label: {
                    Image(systemName: "iphone.and.arrow.right.outward")
                        .font(.caption2)
                }
            }
        }
    }

    private var canSend: Bool {
        sessionManager.canSend(to: route)
    }

    private var session: WatchSessionRow? {
        sessionManager.session(for: route)
    }

    private var historyState: WatchHistoryViewState {
        sessionManager.historyState(for: route)
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

    private func sendReply(text rawText: String) async {
        guard !isSending else { return }
        guard let apiKey = sessionManager.currentApiKey(),
              let baseURL = sessionManager.currentBaseUrl(for: route.serverId),
              let session else {
            statusMessage = "Not ready"
            return
        }

        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        isSending = true
        defer { isSending = false }

        do {
            let client = WatchRestClient()
            let result = try await client.sendReply(
                baseUrl: baseURL,
                serverId: route.serverId,
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
