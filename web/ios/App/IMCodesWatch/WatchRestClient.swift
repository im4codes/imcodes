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
