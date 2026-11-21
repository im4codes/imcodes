import SwiftUI
import WatchKit

struct SessionDetailView: View {
    @EnvironmentObject private var sessionManager: WatchSessionManager
    @StateObject private var voiceManager = WatchVoiceInputManager.shared
    let route: WatchRoute

    @StateObject private var ttsPlayer = WatchTtsPlayer()
    @State private var draft = ""
    @State private var isSending = false
    @State private var statusMessage: String?
    @State private var voiceBaseDraft = ""
    @State private var voiceSessionActive = false
    @State private var isHoldingVoice = false
    @State private var isCancelDrag = false
    @State private var voicePulse = false
    @State private var hasScrolledInitialLoad = false
    @State private var prevItemCount = 0
    @State private var prevLastItemId: String?
    @State private var isAtBottom = true
    @State private var unreadCount = 0
    @State private var scrollProxy: ScrollViewProxy?

    private let quickReplies = ["Yes", "Continue", "Fix"]
    private let voiceCancelDragDistance: CGFloat = 45

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
                prevItemCount = historyState.items.count
                prevLastItemId = historyState.items.last?.id
                if historyState.loadedOnce {
                    hasScrolledInitialLoad = true
                }
                if historyState.items.count > 0 || historyState.loadedOnce {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
                        proxy.scrollTo("replyField", anchor: .bottom)
                    }
                }
            }
            .onChange(of: historyState.loadedOnce) { loaded in
                guard loaded, !hasScrolledInitialLoad else { return }
                hasScrolledInitialLoad = true
                prevItemCount = historyState.items.count
                prevLastItemId = historyState.items.last?.id
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
                    proxy.scrollTo("replyField", anchor: .bottom)
                }
            }
            .onChange(of: historyState.items.count) { newCount in
                let added = newCount - prevItemCount
                let currentLastId = historyState.items.last?.id
                let isTailChange = currentLastId != prevLastItemId
                prevItemCount = newCount
                prevLastItemId = currentLastId
                if !hasScrolledInitialLoad && historyState.loadedOnce {
                    hasScrolledInitialLoad = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
                        proxy.scrollTo("replyField", anchor: .bottom)
                    }
                } else if !historyState.isLoadingOlder && added > 0 && isTailChange {
                    if isAtBottom {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                            proxy.scrollTo("replyField", anchor: .bottom)
                        }
                    } else {
                        unreadCount += added
                        WKInterfaceDevice.current().play(.notification)
                    }
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
        .onChange(of: route) { _ in
            ttsPlayer.stop()
            cancelHoldVoiceInput(restoreDraft: isHoldingVoice)
            hasScrolledInitialLoad = false
            prevItemCount = historyState.items.count
            prevLastItemId = historyState.items.last?.id
            isAtBottom = true
            unreadCount = 0
            if historyState.loadedOnce {
                hasScrolledInitialLoad = true
            }
            if historyState.items.count > 0 || historyState.loadedOnce {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
                    scrollProxy?.scrollTo("replyField", anchor: .bottom)
                }
            }
        }
        .onDisappear {
            ttsPlayer.stop()
            cancelHoldVoiceInput(restoreDraft: isHoldingVoice)
            sessionManager.clearActiveRoute()
        }
        .onChange(of: voiceManager.state) { newState in
            if newState == .idle && isHoldingVoice {
                isHoldingVoice = false
                isCancelDrag = false
                voicePulse = false
                voiceSessionActive = false
            } else if voiceManager.isRecording && isHoldingVoice {
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                    voicePulse = true
                }
            } else {
                voicePulse = false
            }
        }
        .onChange(of: voiceManager.transcriptUpdate) { update in
            guard voiceSessionActive, let update else { return }
            let trimmed = update.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                draft = mergeVoiceDraft(base: voiceBaseDraft, dictated: trimmed)
            }
            if update.isFinal {
                voiceSessionActive = false
            }
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
                            } else if !item.isUser && !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                let isPlayingItem = ttsPlayer.playingMessageId == item.id
                                Button {
                                    if isPlayingItem {
                                        ttsPlayer.stop()
                                    } else {
                                        ttsPlayer.play(
                                            messageId: item.id,
                                            text: item.text,
                                            baseUrl: sessionManager.currentBaseUrl(for: route.serverId),
                                            apiKey: sessionManager.currentApiKey()
                                        )
                                    }
                                } label: {
                                    HStack(spacing: 3) {
                                        if isPlayingItem && ttsPlayer.isLoading {
                                            ProgressView()
                                                .progressViewStyle(.circular)
                                                .scaleEffect(0.45)
                                                .frame(width: 10, height: 10)
                                        } else {
                                            Image(systemName: isPlayingItem ? "stop.fill" : "speaker.wave.2")
                                                .font(.system(size: 9))
                                        }
                                        Text(isPlayingItem ? "Stop" : "Listen")
                                            .font(.system(size: 8))
                                    }
                                    .foregroundStyle(isPlayingItem ? .cyan : .secondary)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(isPlayingItem ? "Stop" : "Listen")
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
            if !draft.isEmpty {
                HStack(alignment: .top, spacing: 4) {
                    Text(draft)
                        .font(.caption2)
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)

                    Button {
                        if voiceManager.isRecording || voiceManager.state == .transcribing || isHoldingVoice {
                            cancelHoldVoiceInput(restoreDraft: false)
                        }
                        voiceSessionActive = false
                        voiceBaseDraft = ""
                        draft = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear draft")
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            TextField(draft.isEmpty ? "Reply…" : "Edit…", text: $draft)
                .font(.caption2)
                .id("replyField")

            holdToTalkControl

            HStack(spacing: 8) {
                Button(isSending ? "…" : "Send") {
                    if voiceManager.isRecording || voiceManager.state == .transcribing || isHoldingVoice {
                        cancelHoldVoiceInput(restoreDraft: false)
                    }
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

            if let voiceStatus = voiceManager.statusMessage, !voiceStatus.isEmpty {
                Text(voiceStatus)
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
            if let voiceError = voiceManager.errorMessage, !voiceError.isEmpty {
                Text(voiceError)
                    .font(.system(size: 9))
                    .foregroundStyle(.red)
            }
        }
    }

    private var holdToTalkControl: some View {
        let isTranscribing = !isHoldingVoice && voiceManager.state == .transcribing
        let isActiveHold = isHoldingVoice && voiceManager.isRecording
        let isGestureDisabled = isSending || isTranscribing

        let iconName: String = {
            if isActiveHold && isCancelDrag { return "xmark.circle.fill" }
            if isActiveHold { return "waveform" }
            return "mic.fill"
        }()
        let labelText: String = {
            if isTranscribing { return "Transcribing…" }
            if isActiveHold && isCancelDrag { return "Cancel" }
            if isActiveHold { return "Release" }
            return "Hold to Talk"
        }()
        let fillColor: Color = {
            if isActiveHold && isCancelDrag { return Color.red.opacity(0.85) }
            if isActiveHold { return Color.orange.opacity(0.85) }
            if isTranscribing { return Color.gray.opacity(0.22) }
            return Color.accentColor.opacity(0.22)
        }()
        let foregroundColor: Color = {
            if isActiveHold { return .white }
            if isGestureDisabled { return .secondary }
            return .accentColor
        }()

        return HStack(spacing: 5) {
            if isTranscribing {
                ProgressView()
                    .progressViewStyle(.circular)
                    .scaleEffect(0.55)
                    .frame(width: 14, height: 14)
            } else {
                Image(systemName: iconName)
                    .font(.system(size: 11, weight: .semibold))
                    .opacity(isActiveHold && !isCancelDrag ? (voicePulse ? 0.55 : 1.0) : 1.0)
            }
            Text(labelText)
                .font(.system(size: 11, weight: .medium))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .foregroundStyle(foregroundColor)
        .frame(maxWidth: .infinity, minHeight: 30)
        .padding(.horizontal, 8)
        .background(Capsule().fill(fillColor))
        .contentShape(Capsule())
        .opacity(isSending ? 0.5 : 1.0)
        .disabled(isGestureDisabled)
        .highPriorityGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    handleVoiceDragChanged(value)
                }
                .onEnded { value in
                    handleVoiceDragEnded(value)
                }
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(labelText)
        .accessibilityHint("Press and hold to record voice input. Slide away to cancel.")
    }

    private func handleVoiceDragChanged(_ value: DragGesture.Value) {
        if !isHoldingVoice {
            guard !isSending, voiceManager.state == .idle else { return }
            voiceBaseDraft = draft
            voiceSessionActive = true
            voiceManager.startRecording()
            guard voiceManager.isRecording else {
                voiceSessionActive = false
                return
            }
            isHoldingVoice = true
            isCancelDrag = false
            if voiceManager.state == .streaming || voiceManager.state == .recordingFile {
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                    voicePulse = true
                }
            }
        }

        let distance = hypot(value.translation.width, value.translation.height)
        let shouldCancel = distance > voiceCancelDragDistance
        if shouldCancel != isCancelDrag {
            isCancelDrag = shouldCancel
            WKInterfaceDevice.current().play(shouldCancel ? .directionDown : .click)
        }
    }

    private func handleVoiceDragEnded(_ value: DragGesture.Value) {
        guard isHoldingVoice else { return }
        let distance = hypot(value.translation.width, value.translation.height)
        let shouldCancel = isCancelDrag || distance > voiceCancelDragDistance
        isHoldingVoice = false
        isCancelDrag = false
        voicePulse = false

        if shouldCancel {
            voiceSessionActive = false
            voiceManager.cancelIfRecording()
            draft = voiceBaseDraft
            WKInterfaceDevice.current().play(.failure)
        } else {
            voiceManager.stopRecording()
            if voiceManager.state == .idle {
                voiceSessionActive = false
            }
        }
    }

    private func cancelHoldVoiceInput(restoreDraft: Bool) {
        isHoldingVoice = false
        isCancelDrag = false
        voicePulse = false
        if voiceManager.isRecording || voiceManager.state == .transcribing {
            voiceSessionActive = false
        }
        voiceManager.cancelIfRecording()
        if restoreDraft {
            draft = voiceBaseDraft
        }
    }

    private func mergeVoiceDraft(base: String, dictated: String) -> String {
        guard !base.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return dictated
        }
        if base.hasSuffix(" ") || base.hasSuffix("\n") {
            return base + dictated
        }
        return base + " " + dictated
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

        let text = rawText
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

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
