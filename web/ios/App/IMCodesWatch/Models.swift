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
    var parentSessionName: String?
    var isPinned: Bool?
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
