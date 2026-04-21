import SwiftUI
import WatchKit

struct SessionDetailView: View {
    @EnvironmentObject private var sessionManager: WatchSessionManager
    let route: WatchRoute

    @State private var draft = ""
    @State private var isSending = false
    @State private var statusMessage: String?
    @State private var initialScrollDone = false
    @State private var prevItemCount = 0
    @State private var isAtBottom = true
    @State private var unreadCount = 0
    @State private var scrollProxy: ScrollViewProxy?

    private let quickReplies = ["Yes", "Continue", "Fix"]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    header
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
            .onAppear {
                scrollProxy = proxy
                // Initial scroll — covers case where items are already seeded before onChange fires
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                    if !initialScrollDone {
                        initialScrollDone = true
                        prevItemCount = historyState.items.count
                        proxy.scrollTo("replyField", anchor: .bottom)
                    }
                }
            }
            .onChange(of: historyState.items.count) { newCount in
                let added = newCount - prevItemCount
                if !initialScrollDone {
                    initialScrollDone = true
                    prevItemCount = newCount
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                        proxy.scrollTo("replyField", anchor: .bottom)
                    }
                } else if added > 0 && added <= 3 && isAtBottom {
                    prevItemCount = newCount
                    proxy.scrollTo("replyField", anchor: .bottom)
                } else if added > 0 && added <= 3 && !isAtBottom {
                    prevItemCount = newCount
                    unreadCount += added
                    WKInterfaceDevice.current().play(.notification)
                } else {
                    prevItemCount = newCount
                }
            }
        }
        .navigationTitle(session?.title ?? route.title ?? "Session")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                HStack(spacing: 8) {
                    // Load older button
                    if historyState.hasMore && historyState.loadedOnce {
                        Button {
                            Task { await sessionManager.loadOlderHistory(for: route) }
                        } label: {
                            if historyState.isLoadingOlder {
                                ProgressView()
                                    .frame(width: 14, height: 14)
                            } else {
                                Image(systemName: "arrow.up")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(.white.opacity(0.7))
                            }
                        }
                        .disabled(historyState.isLoadingOlder)
                    }

                    // Scroll to bottom button
                    if !isAtBottom || unreadCount > 0 {
                        Button {
                            unreadCount = 0
                            scrollProxy?.scrollTo("replyField", anchor: .bottom)
                        } label: {
                            ZStack(alignment: .topTrailing) {
                                Image(systemName: "arrow.down")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(.white.opacity(0.85))

                                if unreadCount > 0 {
                                    Text("\(unreadCount)")
                                        .font(.system(size: 7, weight: .bold))
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 2)
                                        .background(Color.red)
                                        .clipShape(Capsule())
                                        .offset(x: 8, y: -4)
                                }
                            }
                        }
                    }
                }
            }
        }
        .task {
            await sessionManager.loadHistoryIfNeeded(for: route)
            // Chat view active → poll more aggressively so a sent message
            // reconciles with the real echo fast instead of sitting in the
            // optimistic "sending" state for 12+ seconds.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(6))
                guard !Task.isCancelled else { break }
                await sessionManager.loadHistoryIfNeeded(for: route)
            }
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
            Text(session?.title ?? route.title ?? "Session")
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
                        VStack(alignment: item.isUser ? .trailing : .leading, spacing: 2) {
                            Text(item.text)
                                .font(.system(size: 12))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 6)
                                .foregroundStyle(bubbleForeground(for: item))
                                .background(bubbleBackground(for: item))
                                .opacity(item.isPending ? 0.65 : 1.0)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .strokeBorder(item.isFailed ? Color.red.opacity(0.85) : Color.clear, lineWidth: 1)
                                )
                            if item.isPending {
                                HStack(spacing: 3) {
                                    ProgressView()
                                        .progressViewStyle(.circular)
                                        .scaleEffect(0.45)
                                        .frame(width: 10, height: 10)
                                    Text("Sending")
                                        .font(.system(size: 8))
                                        .foregroundStyle(.secondary)
                                }
                            } else if item.isFailed {
                                HStack(spacing: 3) {
                                    Text("!")
                                        .font(.system(size: 9, weight: .bold))
                                        .foregroundStyle(.white)
                                        .frame(width: 10, height: 10)
                                        .background(Circle().fill(Color.red))
                                    Text(item.failureReason ?? "Failed — tap Send to retry")
                                        .font(.system(size: 8))
                                        .foregroundStyle(.red)
                                }
                            }
                        }
                        if !item.isUser { Spacer(minLength: 20) }
                    }
                }

                // Bottom sentinel — tracks whether user is near the bottom
                Color.clear.frame(height: 1).id("chatEnd")
                    .onAppear { isAtBottom = true; unreadCount = 0 }
                    .onDisappear { isAtBottom = false }
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
                .id("replyField")

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

    // Pending/failed states tint the bubble so the user can see the status of
    // each send at a glance on a tiny screen. Assistant messages always use the
    // muted gray background.
    private func bubbleBackground(for item: WatchConversationItem) -> Color {
        if !item.isUser { return Color.gray.opacity(0.22) }
        if item.isFailed { return Color.red.opacity(0.28) }
        if item.isPending { return Color.green.opacity(0.45) }
        return Color.green
    }

    private func bubbleForeground(for item: WatchConversationItem) -> Color {
        if !item.isUser { return Color.primary }
        if item.isFailed { return Color.white }
        return Color.white
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

        // Inject an optimistic user bubble immediately so the watch screen
        // shows the message before the HTTP round-trip completes. The real
        // echo from the next 6s history poll replaces it by commandId.
        let commandId = UUID().uuidString
        let sendRoute = route
        sessionManager.appendOptimisticSend(for: sendRoute, text: text, commandId: commandId)

        do {
            let client = WatchRestClient()
            let result = try await client.sendReply(
                baseUrl: baseURL,
                serverId: route.serverId,
                sessionName: session.sessionName,
                text: text,
                apiKey: apiKey,
                commandId: commandId
            )
            switch result {
            case .accepted:
                draft = ""
                WKInterfaceDevice.current().play(.success)
                statusMessage = "Sent"
                // Speed up reconciliation: pull fresh history right away
                // instead of waiting for the 6s tick.
                Task { await sessionManager.loadHistoryIfNeeded(for: sendRoute) }
            case .authExpired:
                WKInterfaceDevice.current().play(.failure)
                statusMessage = "Auth expired"
                sessionManager.markOptimisticSendFailed(for: sendRoute, commandId: commandId, reason: "Auth expired")
            case .agentUnavailable:
                WKInterfaceDevice.current().play(.failure)
                statusMessage = "Agent offline"
                sessionManager.markOptimisticSendFailed(for: sendRoute, commandId: commandId, reason: "Agent offline")
            }
        } catch {
            WKInterfaceDevice.current().play(.failure)
            statusMessage = "Network error"
            sessionManager.markOptimisticSendFailed(for: sendRoute, commandId: commandId, reason: "Network error")
        }
    }
}
