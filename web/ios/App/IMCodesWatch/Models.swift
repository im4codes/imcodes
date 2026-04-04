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

struct WatchRecentTextRow: Identifiable, Codable, Equatable {
    let eventId: String
    let type: String
    let text: String
    let ts: Double

    var id: String { eventId }
}

struct WatchSessionRow: Identifiable, Codable, Equatable {
    var sessionName: String
    var serverId: String
    var title: String
    var state: WatchSessionState
    var agentBadge: String
    var isSubSession: Bool
    var parentTitle: String?
    var parentSessionName: String?
    var isPinned: Bool?
    var previewText: String?
    var previewUpdatedAt: Double?
    var recentText: [WatchRecentTextRow]?

    enum CodingKeys: String, CodingKey {
        case sessionName
        case serverId
        case title
        case state
        case agentBadge
        case isSubSession
        case parentTitle
        case parentSessionName
        case isPinned
        case previewText
        case previewUpdatedAt
        case recentText
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let sessionName = try container.decode(String.self, forKey: .sessionName)
        let serverId = try container.decode(String.self, forKey: .serverId)
        let parentSessionName = try container.decodeIfPresent(String.self, forKey: .parentSessionName)
        let explicitIsSubSession = try container.decodeIfPresent(Bool.self, forKey: .isSubSession)

        self.sessionName = sessionName
        self.serverId = serverId
        self.title = try container.decodeIfPresent(String.self, forKey: .title) ?? sessionName
        self.state = (try? container.decode(WatchSessionState.self, forKey: .state)) ?? .stopped
        self.agentBadge = try container.decodeIfPresent(String.self, forKey: .agentBadge) ?? ""
        self.parentTitle = try container.decodeIfPresent(String.self, forKey: .parentTitle)
        self.parentSessionName = parentSessionName
        self.isSubSession = explicitIsSubSession ?? sessionName.hasPrefix("deck_sub_") || parentSessionName != nil
        self.isPinned = try container.decodeIfPresent(Bool.self, forKey: .isPinned) ?? false
        self.previewText = try container.decodeIfPresent(String.self, forKey: .previewText)
        self.previewUpdatedAt = try container.decodeIfPresent(Double.self, forKey: .previewUpdatedAt)
        self.recentText = try container.decodeIfPresent([WatchRecentTextRow].self, forKey: .recentText) ?? []
    }

    var id: String { "\(serverId):\(sessionName)" }

    var latestRecentText: WatchRecentTextRow? {
        (recentText ?? []).sorted { lhs, rhs in
            if lhs.ts == rhs.ts { return lhs.eventId < rhs.eventId }
            return lhs.ts < rhs.ts
        }.last
    }

    var effectivePreviewText: String? {
        if let previewText, !previewText.isEmpty { return previewText }
        return latestRecentText?.text
    }

    var effectivePreviewUpdatedAt: Double? {
        previewUpdatedAt ?? latestRecentText?.ts
    }
}

struct WatchServerListResponse: Codable, Equatable {
    let servers: [WatchServerRow]
}

struct WatchSessionListResponse: Codable, Equatable {
    let serverId: String
    let sessions: [WatchSessionRow]
}

enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let object = try? container.decode([String: JSONValue].self) {
            self = .object(object)
        } else if let array = try? container.decode([JSONValue].self) {
            self = .array(array)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }
}

struct WatchTimelineEvent: Identifiable, Codable, Equatable {
    let eventId: String
    let sessionId: String
    let ts: Double
    let type: String
    let payload: JSONValue?

    var id: String { eventId }

    var text: String? {
        payload?.objectValue?["text"]?.stringValue
    }
}

struct WatchHistoryResponse: Codable, Equatable {
    let sessionName: String
    let epoch: Int?
    let events: [WatchTimelineEvent]
    let hasMore: Bool
    let nextCursor: Double?
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

struct WatchConversationItem: Identifiable, Equatable {
    let eventId: String
    let sessionId: String
    let ts: Double
    let type: String
    let text: String
    let isWarmCache: Bool

    var id: String { eventId }
    var isUser: Bool { type == "user.message" }

    static func fromRecentText(_ row: WatchRecentTextRow, sessionId: String) -> WatchConversationItem? {
        guard row.type == "user.message" || row.type == "assistant.text" else { return nil }
        let trimmed = row.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return WatchConversationItem(
            eventId: row.eventId,
            sessionId: sessionId,
            ts: row.ts,
            type: row.type,
            text: trimmed,
            isWarmCache: true
        )
    }

    static func fromTimelineEvent(_ event: WatchTimelineEvent) -> WatchConversationItem? {
        guard event.type == "user.message" || event.type == "assistant.text" else { return nil }
        guard let text = event.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return WatchConversationItem(
            eventId: event.eventId,
            sessionId: event.sessionId,
            ts: event.ts,
            type: event.type,
            text: text,
            isWarmCache: false
        )
    }

    static func merge(existing: [WatchConversationItem], incoming: [WatchConversationItem]) -> [WatchConversationItem] {
        var byId: [String: WatchConversationItem] = [:]
        for item in existing + incoming {
            if let current = byId[item.eventId] {
                if current.isWarmCache && !item.isWarmCache {
                    byId[item.eventId] = item
                } else if current.isWarmCache == item.isWarmCache {
                    byId[item.eventId] = item.ts >= current.ts ? item : current
                }
            } else {
                byId[item.eventId] = item
            }
        }

        return byId.values.sorted { lhs, rhs in
            if lhs.ts == rhs.ts { return lhs.eventId < rhs.eventId }
            return lhs.ts < rhs.ts
        }
    }
}

struct WatchHistoryViewState: Equatable {
    var items: [WatchConversationItem] = []
    var hasMore = false
    var nextCursor: Double?
    var isLoading = false
    var isLoadingOlder = false
    var loadedOnce = false
    var errorMessage: String?
}
