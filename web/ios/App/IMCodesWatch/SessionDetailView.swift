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
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(12))
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
