import Foundation

actor WatchRestClient {
    enum SendResult: Equatable {
        case accepted
        case authExpired
        case agentUnavailable
    }

    enum WatchRestError: LocalizedError, Equatable {
        case missingParameters
        case invalidResponse
        case authExpired
        case agentUnavailable
        case networkError(String)
        case serverError(statusCode: Int)

        var errorDescription: String? {
            switch self {
            case .missingParameters:
                return "Missing watch request parameters."
            case .invalidResponse:
                return "The server returned an invalid response."
            case .authExpired:
                return "Authentication expired."
            case .agentUnavailable:
                return "Agent unavailable."
            case .networkError(let message):
                return message
            case .serverError(let statusCode):
                return "Server responded with HTTP \(statusCode)."
            }
        }
    }

    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 30
            config.timeoutIntervalForResource = 30
            self.session = URLSession(configuration: config)
        }
    }

    struct SendRequestBody: Codable, Equatable {
        let commandId: String
        let sessionName: String
        let text: String
    }

    static func makeServersRequest(baseUrl: URL, apiKey: String) throws -> URLRequest {
        guard !apiKey.isEmpty else { throw WatchRestError.missingParameters }
        let url = baseUrl
            .appendingPathComponent("api")
            .appendingPathComponent("watch")
            .appendingPathComponent("servers")
        return try makeAuthorizedRequest(url: url, apiKey: apiKey)
    }

    static func makeSessionsRequest(baseUrl: URL, serverId: String, apiKey: String) throws -> URLRequest {
        guard !serverId.isEmpty, !apiKey.isEmpty else { throw WatchRestError.missingParameters }
        var components = URLComponents(url: baseUrl
            .appendingPathComponent("api")
            .appendingPathComponent("watch")
            .appendingPathComponent("sessions"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "serverId", value: serverId)]
        guard let url = components?.url else { throw WatchRestError.invalidResponse }
        return try makeAuthorizedRequest(url: url, apiKey: apiKey)
    }

    static func makeHistoryRequest(
        baseUrl: URL,
        serverId: String,
        sessionName: String,
        apiKey: String,
        limit: Int = 50,
        beforeTs: Double? = nil
    ) throws -> URLRequest {
        guard !serverId.isEmpty, !sessionName.isEmpty, !apiKey.isEmpty else {
            throw WatchRestError.missingParameters
        }
        var components = URLComponents(url: baseUrl
            .appendingPathComponent("api")
            .appendingPathComponent("server")
            .appendingPathComponent(serverId)
            .appendingPathComponent("timeline")
            .appendingPathComponent("history"), resolvingAgainstBaseURL: false)
        var queryItems = [
            URLQueryItem(name: "sessionName", value: sessionName),
            URLQueryItem(name: "limit", value: String(limit))
        ]
        if let beforeTs {
            queryItems.append(URLQueryItem(name: "beforeTs", value: String(Int64(beforeTs))))
        }
        components?.queryItems = queryItems
        guard let url = components?.url else { throw WatchRestError.invalidResponse }
        return try makeAuthorizedRequest(url: url, apiKey: apiKey)
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

        var request = try makeAuthorizedRequest(url: url, apiKey: apiKey)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            SendRequestBody(commandId: commandId, sessionName: sessionName, text: text)
        )
        return request
    }

    func fetchServers(baseUrl: URL, apiKey: String) async throws -> [WatchServerRow] {
        let request = try Self.makeServersRequest(baseUrl: baseUrl, apiKey: apiKey)
        let response: WatchServerListResponse = try await performJSON(request: request)
        return response.servers
    }

    func fetchSessions(baseUrl: URL, serverId: String, apiKey: String) async throws -> WatchSessionListResponse {
        let request = try Self.makeSessionsRequest(baseUrl: baseUrl, serverId: serverId, apiKey: apiKey)
        return try await performJSON(request: request)
    }

    func fetchHistory(
        baseUrl: URL,
        serverId: String,
        sessionName: String,
        apiKey: String,
        limit: Int = 50,
        beforeTs: Double? = nil
    ) async throws -> WatchHistoryResponse {
        let request = try Self.makeHistoryRequest(
            baseUrl: baseUrl,
            serverId: serverId,
            sessionName: sessionName,
            apiKey: apiKey,
            limit: limit,
            beforeTs: beforeTs
        )
        return try await performJSON(request: request)
    }

    func sendReply(
        baseUrl: URL,
        serverId: String,
        sessionName: String,
        text: String,
        apiKey: String,
        commandId: String = UUID().uuidString
    ) async throws -> SendResult {
        let request = try Self.makeRequest(
            baseUrl: baseUrl,
            serverId: serverId,
            sessionName: sessionName,
            text: text,
            apiKey: apiKey,
            commandId: commandId
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
            throw WatchRestError.networkError(error.localizedDescription)
        }
    }

    private static func makeAuthorizedRequest(url: URL, apiKey: String) throws -> URLRequest {
        guard !apiKey.isEmpty else { throw WatchRestError.missingParameters }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func performJSON<T: Decodable>(request: URLRequest) async throws -> T {
        do {
            let (data, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw WatchRestError.invalidResponse
            }
            switch httpResponse.statusCode {
            case 200..<300:
                return try JSONDecoder().decode(T.self, from: data)
            case 401, 403:
                throw WatchRestError.authExpired
            case 502, 503:
                throw WatchRestError.agentUnavailable
            default:
                throw WatchRestError.serverError(statusCode: httpResponse.statusCode)
            }
        } catch let error as WatchRestError {
            throw error
        } catch let error as DecodingError {
            let detail: String
            switch error {
            case .keyNotFound(let key, _): detail = "missing key '\(key.stringValue)'"
            case .typeMismatch(let type, let ctx): detail = "type mismatch \(type) at \(ctx.codingPath.map(\.stringValue).joined(separator: "."))"
            case .valueNotFound(let type, let ctx): detail = "null \(type) at \(ctx.codingPath.map(\.stringValue).joined(separator: "."))"
            case .dataCorrupted(let ctx): detail = "corrupted at \(ctx.codingPath.map(\.stringValue).joined(separator: "."))"
            @unknown default: detail = error.localizedDescription
            }
            throw WatchRestError.networkError("Decode: \(detail)")
        } catch {
            throw WatchRestError.networkError(error.localizedDescription)
        }
    }
}
