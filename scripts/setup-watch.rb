#!/usr/bin/env ruby
# frozen_string_literal: true

require 'cfpropertylist'
require 'fileutils'
require 'xcodeproj'
require 'xcodeproj/project/project_helper'

ROOT = File.expand_path('..', __dir__)
APP_DIR = File.join(ROOT, 'web', 'ios', 'App')
PROJECT_PATH = File.join(APP_DIR, 'App.xcodeproj')
WATCH_DIR = File.join(APP_DIR, 'IMCodesWatch')
APP_ENTITLEMENTS_PATH = File.join(APP_DIR, 'App', 'App.entitlements')
WATCH_ENTITLEMENTS_PATH = File.join(WATCH_DIR, 'IMCodesWatch.entitlements')
APP_GROUP_ID = 'group.com.im.codes'
APP_BUNDLE_ID = 'com.im.codes'
WATCH_BUNDLE_ID = 'com.im.codes.watchkitapp'
WATCH_TARGET_NAME = 'IMCodesWatch'
WATCH_DEPLOYMENT_TARGET = '9.0'
TEAM_ID = 'M675E26Q67'

SWIFT_FILES = {
  'IMCodesWatchApp.swift' => <<~SWIFT,
    import SwiftUI
    import UserNotifications
    import WatchKit

    final class WatchAppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
        func applicationDidFinishLaunching() {
            UNUserNotificationCenter.current().delegate = self
        }

        func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
            WatchSessionManager.shared.handleNotificationPayload(response.notification.request.content.userInfo)
        }
    }

    @main
    struct IMCodesWatchApp: App {
        @WKApplicationDelegateAdaptor(WatchAppDelegate.self) var appDelegate
        @StateObject private var sessionManager = WatchSessionManager.shared

        init() {
            WatchSessionManager.shared.activate()
        }

        var body: some Scene {
            WindowGroup {
                ContentView()
                    .environmentObject(sessionManager)
            }
        }
    }
  SWIFT
  'ContentView.swift' => <<~SWIFT,
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
  SWIFT
  'SessionDetailView.swift' => <<~SWIFT,
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
  SWIFT
  'WatchSessionManager.swift' => <<~SWIFT,
    import Combine
    import Foundation
    import WatchKit
    import WatchConnectivity

    final class WatchSessionManager: NSObject, ObservableObject {
        static let shared = WatchSessionManager()

        @Published private(set) var applicationContext: WatchApplicationContext = .empty
        @Published private(set) var activationState: WCSessionActivationState = .notActivated
        @Published private(set) var lastErrorMessage: String?
        @Published private(set) var activeRoute: WatchRoute?

        private var pendingRoute: WatchRoute?
        private var routeTimeoutWorkItem: DispatchWorkItem?

        private override init() {
            super.init()
            hydrateCachedContext()
        }

        func activate() {
            guard WCSession.isSupported() else { return }
            let session = WCSession.default
            if session.delegate !== self {
                session.delegate = self
            }
            if session.activationState == .notActivated {
                session.activate()
            }
        }

        func syncSnapshot(_ context: WatchApplicationContext) {
            DispatchQueue.main.async {
                self.applicationContext = context
                self.resolvePendingRouteIfPossible()
            }
        }

        func currentServer() -> WatchServerRow? {
            guard let currentServerId = applicationContext.currentServerId else { return nil }
            return applicationContext.servers.first(where: { $0.id == currentServerId })
        }

        func requestServerSwitch(to serverId: String) {
            requestServerSwitch(to: serverId, preservePendingRoute: false)
        }

        func requestRefresh() {
            sendControlMessage(["action": "refresh"])
        }

        func handleNotificationPayload(_ userInfo: [AnyHashable: Any]) {
            guard let serverId = userInfo["serverId"] as? String, !serverId.isEmpty else {
                lastErrorMessage = "Notification missing server route."
                return
            }
            let sessionName = (userInfo["session"] as? String) ?? (userInfo["sessionName"] as? String)
            guard let sessionName, !sessionName.isEmpty else {
                lastErrorMessage = "Notification missing session route."
                return
            }

            activeRoute = nil
            pendingRoute = WatchRoute(serverId: serverId, sessionName: sessionName)
            startRouteTimeout()
            resolvePendingRouteIfPossible()
        }

        func clearActiveRoute() {
            activeRoute = nil
        }

        private func hydrateCachedContext() {
            guard WCSession.isSupported() else { return }
            let cached = WCSession.default.receivedApplicationContext
            guard !cached.isEmpty else { return }
            if let decoded = decodeContext(cached) {
                DispatchQueue.main.async {
                    self.applicationContext = decoded
                }
            }
        }

        private func decodeContext(_ raw: [String: Any]) -> WatchApplicationContext? {
            guard let data = try? PropertyListSerialization.data(fromPropertyList: raw, format: .xml, options: 0) else {
                return nil
            }
            guard let decoded = try? PropertyListDecoder().decode(WatchApplicationContext.self, from: data) else {
                return nil
            }
            guard decoded.v <= 1 else {
                DispatchQueue.main.async {
                    self.lastErrorMessage = "Watch snapshot version is too new."
                }
                return nil
            }
            return decoded
        }

        private func requestServerSwitch(to serverId: String, preservePendingRoute: Bool) {
            sendControlMessage(["action": "switchServer", "serverId": serverId]) {
                self.applicationContext.currentServerId = serverId
                self.applicationContext.snapshotStatus = .switching
                if !preservePendingRoute {
                    self.pendingRoute = nil
                    self.cancelRouteTimeout()
                }
            }
        }

        private func sendControlMessage(_ payload: [String: Any], optimisticUpdate: (() -> Void)? = nil) {
            guard WCSession.isSupported() else { return }
            let session = WCSession.default
            guard session.activationState == .activated else {
                lastErrorMessage = "Phone session is not ready."
                return
            }
            guard session.isReachable else {
                lastErrorMessage = "Phone app is unavailable."
                return
            }
            session.sendMessage(payload, replyHandler: { _ in
                DispatchQueue.main.async {
                    optimisticUpdate?()
                    self.lastErrorMessage = nil
                }
            }, errorHandler: { error in
                DispatchQueue.main.async {
                    self.lastErrorMessage = error.localizedDescription
                }
            })
        }

        private func handleDurableEvent(_ userInfo: [String: Any]) {
            guard let type = userInfo["type"] as? String else { return }
            DispatchQueue.main.async {
                switch type {
                case "session.idle":
                    WKInterfaceDevice.current().play(.success)
                case "session.notification":
                    WKInterfaceDevice.current().play(.notification)
                case "session.error":
                    WKInterfaceDevice.current().play(.failure)
                    if let message = userInfo["message"] as? String, !message.isEmpty {
                        self.lastErrorMessage = "Session error — \(message)"
                    }
                default:
                    break
                }
            }
        }

        private func resolvePendingRouteIfPossible() {
            guard let pendingRoute else { return }
            guard !applicationContext.servers.isEmpty else { return }

            if applicationContext.currentServerId == pendingRoute.serverId {
                if applicationContext.sessions.contains(where: { $0.sessionName == pendingRoute.sessionName }) {
                    activeRoute = pendingRoute
                    self.pendingRoute = nil
                    cancelRouteTimeout()
                    lastErrorMessage = nil
                }
                return
            }

            guard applicationContext.snapshotStatus != .switching else { return }
            requestServerSwitch(to: pendingRoute.serverId, preservePendingRoute: true)
        }

        private func startRouteTimeout() {
            cancelRouteTimeout()
            let workItem = DispatchWorkItem { [weak self] in
                guard let self else { return }
                guard self.pendingRoute != nil else { return }
                self.pendingRoute = nil
                self.activeRoute = nil
                self.lastErrorMessage = "Session unavailable."
            }
            routeTimeoutWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: workItem)
        }

        private func cancelRouteTimeout() {
            routeTimeoutWorkItem?.cancel()
            routeTimeoutWorkItem = nil
        }
    }

    extension WatchSessionManager: WCSessionDelegate {
        func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
            DispatchQueue.main.async {
                self.activationState = activationState
                self.lastErrorMessage = error?.localizedDescription
            }
        }

        func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
            DispatchQueue.main.async {
                if let decoded = self.decodeContext(applicationContext) {
                    self.applicationContext = decoded
                    self.lastErrorMessage = nil
                } else {
                    self.lastErrorMessage = "Unable to decode watch context."
                }
            }
        }

        func session(_ session: WCSession, didReceiveUserInfo userInfo: [String : Any]) {
            handleDurableEvent(userInfo)
        }

        func sessionReachabilityDidChange(_ session: WCSession) {}
    }
  SWIFT
  'WatchRestClient.swift' => <<~SWIFT,
    import Foundation

    actor WatchRestClient {
        enum SendResult: Equatable {
            case accepted
            case authExpired
            case agentUnavailable
        }

        enum WatchRestError: LocalizedError {
            case missingParameters
            case invalidResponse
            case networkError(Error)
            case serverError(statusCode: Int)

            var errorDescription: String? {
                switch self {
                case .missingParameters:
                    return "Missing watch request parameters."
                case .invalidResponse:
                    return "The server returned an invalid response."
                case .networkError(let error):
                    return error.localizedDescription
                case .serverError(let statusCode):
                    return "Server responded with HTTP \(statusCode)."
                }
            }
        }

        private let session: URLSession = {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 30
            config.timeoutIntervalForResource = 30
            return URLSession(configuration: config)
        }()

        struct SendRequestBody: Codable {
            let commandId: String
            let sessionName: String
            let text: String
        }

        static func makeRequest(
            baseUrl: URL,
            serverId: String,
            sessionName: String,
            text: String,
            apiKey: String,
            commandId: String = UUID().uuidString
        ) throws -> URLRequest {
            guard !serverId.isEmpty, !sessionName.isEmpty, !text.isEmpty, !apiKey.isEmpty else {
                throw WatchRestError.missingParameters
            }

            let url = baseUrl
                .appendingPathComponent("api")
                .appendingPathComponent("server")
                .appendingPathComponent(serverId)
                .appendingPathComponent("session")
                .appendingPathComponent("send")

            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(
                SendRequestBody(commandId: commandId, sessionName: sessionName, text: text)
            )
            return request
        }

        func sendReply(
            baseUrl: URL,
            serverId: String,
            sessionName: String,
            text: String,
            apiKey: String
        ) async throws -> SendResult {
            let request = try Self.makeRequest(
                baseUrl: baseUrl,
                serverId: serverId,
                sessionName: sessionName,
                text: text,
                apiKey: apiKey
            )

            do {
                let (_, response) = try await session.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw WatchRestError.invalidResponse
                }

                switch httpResponse.statusCode {
                case 200..<300:
                    return .accepted
                case 401, 403:
                    return .authExpired
                case 502, 503:
                    return .agentUnavailable
                default:
                    throw WatchRestError.serverError(statusCode: httpResponse.statusCode)
                }
            } catch let error as WatchRestError {
                throw error
            } catch {
                throw WatchRestError.networkError(error)
            }
        }
    }
  SWIFT
  'Models.swift' => <<~SWIFT,
    import Foundation

    enum SnapshotStatus: String, Codable, CaseIterable {
        case fresh
        case stale
        case switching
    }

    enum WatchSessionState: String, Codable, CaseIterable {
        case working
        case idle
        case error
        case stopped
    }

    struct WatchServerRow: Identifiable, Codable, Equatable {
        let id: String
        var name: String
        var baseUrl: String
    }

    struct WatchSessionRow: Identifiable, Codable, Equatable {
        var sessionName: String
        var serverId: String
        var title: String
        var state: WatchSessionState
        var agentBadge: String
        var isSubSession: Bool
        var parentTitle: String?
        var previewText: String?
        var previewUpdatedAt: Double?

        var id: String { "\(serverId):\(sessionName)" }
    }

    struct WatchApplicationContext: Codable, Equatable {
        var v: Int
        var generatedAt: Double?
        var currentServerId: String?
        var servers: [WatchServerRow]
        var sessions: [WatchSessionRow]
        var snapshotStatus: SnapshotStatus
        var apiKey: String?

        static let empty = WatchApplicationContext(
            v: 1,
            generatedAt: nil,
            currentServerId: nil,
            servers: [],
            sessions: [],
            snapshotStatus: .stale,
            apiKey: nil
        )
    }

    struct WatchRoute: Codable, Equatable, Hashable, Identifiable {
        var serverId: String
        var sessionName: String

        var id: String { "\(serverId):\(sessionName)" }
    }

    struct WatchControlMessage: Codable, Equatable {
        var action: String
        var serverId: String?
    }

    struct WatchNotificationPayload: Codable, Equatable {
        var serverId: String
        var session: String
        var type: String
        var sessionName: String?

        enum CodingKeys: String, CodingKey {
            case serverId
            case session
            case type
            case sessionName
        }

        init(serverId: String, session: String, type: String, sessionName: String? = nil) {
            self.serverId = serverId
            self.session = session
            self.type = type
            self.sessionName = sessionName
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let serverId = try container.decode(String.self, forKey: .serverId)
            let type = try container.decode(String.self, forKey: .type)
            let session = try container.decodeIfPresent(String.self, forKey: .session)
                ?? container.decode(String.self, forKey: .sessionName)
            let alias = try container.decodeIfPresent(String.self, forKey: .sessionName)

            self.init(serverId: serverId, session: session, type: type, sessionName: alias)
        }
    }
  SWIFT
}

WATCH_INFO_PLIST = {
  'CFBundleDevelopmentRegion' => '$(DEVELOPMENT_LANGUAGE)',
  'CFBundleDisplayName' => 'IMCodesWatch',
  'CFBundleExecutable' => '$(EXECUTABLE_NAME)',
  'CFBundleIdentifier' => '$(PRODUCT_BUNDLE_IDENTIFIER)',
  'CFBundleInfoDictionaryVersion' => '6.0',
  'CFBundleName' => '$(PRODUCT_NAME)',
  'CFBundlePackageType' => 'APPL',
  'CFBundleShortVersionString' => '1.0',
  'CFBundleVersion' => '1',
  'WKCompanionAppBundleIdentifier' => APP_BUNDLE_ID,
  'WKWatchKitApp' => true,
}.freeze

WATCH_ROOT_ASSET_CATALOG = {
  'info' => {
    'author' => 'xcode',
    'version' => 1,
  },
}.freeze

WATCH_ICON_SET = {
  'images' => [],
  'info' => {
    'author' => 'xcode',
    'version' => 1,
  },
}.freeze


def load_plist_hash(path)
  return {} unless File.exist?(path)

  list = CFPropertyList::List.new(file: path)
  CFPropertyList.native_types(list.value)
end


def save_plist_hash(path, hash)
  FileUtils.mkdir_p(File.dirname(path))
  list = CFPropertyList::List.new
  list.value = CFPropertyList.guess(hash)
  list.save(path, CFPropertyList::List::FORMAT_XML)
end


def write_if_missing(path, content)
  return if File.exist?(path)

  FileUtils.mkdir_p(File.dirname(path))
  File.write(path, content)
end


def ensure_group(parent, name, path = name)
  existing = parent.find_subpath(name, false)
  return existing if existing

  parent.new_group(name, path)
end


def ensure_file(group, relative_path)
  group.find_file_by_path(relative_path) || group.new_file(relative_path)
end


def configure_target_settings(target, settings)
  target.build_configurations.each do |config|
    settings.each do |key, value|
      config.build_settings[key] = value
    end
  end
end

project = Xcodeproj::Project.open(PROJECT_PATH)
main_group = project.main_group
products_group = project.products_group
app_target = project.targets.find { |target| target.name == 'App' }
raise 'App target not found' unless app_target

watch_group = ensure_group(main_group, 'IMCodesWatch', 'IMCodesWatch')
assets_group = ensure_group(watch_group, 'Assets.xcassets', 'Assets.xcassets')
app_icon_group = ensure_group(assets_group, 'AppIcon.appiconset', 'AppIcon.appiconset')

swift_file_refs = SWIFT_FILES.map do |filename, contents|
  path = File.join(WATCH_DIR, filename)
  write_if_missing(path, contents)
  ensure_file(watch_group, filename)
end

info_plist_path = File.join(WATCH_DIR, 'Info.plist')
save_plist_hash(info_plist_path, WATCH_INFO_PLIST.merge(load_plist_hash(info_plist_path)))
ensure_file(watch_group, 'Info.plist')

watch_entitlements = load_plist_hash(WATCH_ENTITLEMENTS_PATH)
watch_groups = Array(watch_entitlements['com.apple.security.application-groups'])
watch_groups << APP_GROUP_ID unless watch_groups.include?(APP_GROUP_ID)
watch_entitlements['com.apple.security.application-groups'] = watch_groups
save_plist_hash(WATCH_ENTITLEMENTS_PATH, watch_entitlements)
ensure_file(watch_group, 'IMCodesWatch.entitlements')

app_entitlements = load_plist_hash(APP_ENTITLEMENTS_PATH)
app_groups = Array(app_entitlements['com.apple.security.application-groups'])
app_groups << APP_GROUP_ID unless app_groups.include?(APP_GROUP_ID)
app_entitlements['com.apple.security.application-groups'] = app_groups
save_plist_hash(APP_ENTITLEMENTS_PATH, app_entitlements)

root_assets_contents = File.join(WATCH_DIR, 'Assets.xcassets', 'Contents.json')
app_icon_contents = File.join(WATCH_DIR, 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json')
save_plist_hash(root_assets_contents, WATCH_ROOT_ASSET_CATALOG.merge(load_plist_hash(root_assets_contents)))
save_plist_hash(app_icon_contents, WATCH_ICON_SET.merge(load_plist_hash(app_icon_contents)))
ensure_file(assets_group, 'Contents.json')
ensure_file(app_icon_group, 'Contents.json')

watch_target = project.targets.find { |target| target.name == WATCH_TARGET_NAME }
unless watch_target
  watch_target = Xcodeproj::Project::ProjectHelper.new_target(
    project,
    :application,
    WATCH_TARGET_NAME,
    :watchos,
    WATCH_DEPLOYMENT_TARGET,
    products_group,
    :swift,
    WATCH_TARGET_NAME
  )
end

watch_target.product_type = Xcodeproj::Constants::PRODUCT_TYPE_UTI[:application]

configure_target_settings(watch_target, {
  'PRODUCT_NAME' => '$(TARGET_NAME)',
  'PRODUCT_BUNDLE_IDENTIFIER' => WATCH_BUNDLE_ID,
  'DEVELOPMENT_TEAM' => TEAM_ID,
  'CODE_SIGN_STYLE' => 'Automatic',
  'CURRENT_PROJECT_VERSION' => '1',
  'MARKETING_VERSION' => '1.0',
  'SWIFT_VERSION' => '5.0',
  'INFOPLIST_FILE' => 'IMCodesWatch/Info.plist',
  'CODE_SIGN_ENTITLEMENTS' => 'IMCodesWatch/IMCodesWatch.entitlements',
  'GENERATE_INFOPLIST_FILE' => 'NO',
  'TARGETED_DEVICE_FAMILY' => '4',
})

watch_target.add_file_references(swift_file_refs)
app_target.add_dependency(watch_target)

project.save
puts "Watch target setup complete: #{WATCH_TARGET_NAME}"
