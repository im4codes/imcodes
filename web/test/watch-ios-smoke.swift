import Foundation

@main
struct WatchIOSSmoke {
    static func assertCondition(_ condition: @autoclosure () -> Bool, _ message: String) {
        if !condition() {
            fputs("Assertion failed: \(message)\n", stderr)
            exit(1)
        }
    }

    static func main() throws {
        let decoder = JSONDecoder()

        let canonicalPayload = """
        {"serverId":"srv-1","session":"deck_sub_alpha","type":"session.notification"}
        """.data(using: .utf8)!
        let canonical = try decoder.decode(WatchNotificationPayload.self, from: canonicalPayload)
        assertCondition(canonical.serverId == "srv-1", "serverId should decode from canonical payload")
        assertCondition(canonical.session == "deck_sub_alpha", "`session` field should be preserved")

        let aliasPayload = """
        {"serverId":"srv-2","sessionName":"deck_sub_beta","type":"session.idle"}
        """.data(using: .utf8)!
        let alias = try decoder.decode(WatchNotificationPayload.self, from: aliasPayload)
        assertCondition(alias.session == "deck_sub_beta", "`sessionName` alias should decode into session")

        let request = try WatchRestClient.makeRequest(
            baseUrl: URL(string: "https://example.test")!,
            serverId: "srv-3",
            sessionName: "deck_sub_gamma",
            text: "hello",
            apiKey: "watch-token",
            commandId: "cmd-123"
        )
        assertCondition(request.url?.absoluteString == "https://example.test/api/server/srv-3/session/send", "request URL should target session send endpoint")
        assertCondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer watch-token", "Authorization header should be set")
        let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data(), options: []) as? [String: Any]
        assertCondition(body?["commandId"] as? String == "cmd-123", "commandId should be serialized in request body")
        assertCondition(body?["sessionName"] as? String == "deck_sub_gamma", "sessionName should be serialized in request body")

        print("watch-ios-smoke ok")
    }
}
