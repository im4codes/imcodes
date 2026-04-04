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

        let sessionListPayload = """
        {
          "serverId":"srv-1",
          "sessions":[
            {
              "serverId":"srv-1",
              "sessionName":"deck_proj_brain",
              "title":"Main",
              "state":"working",
              "agentBadge":"cc",
              "isSubSession":false,
              "previewText":"latest",
              "previewUpdatedAt":100,
              "recentText":[
                {"eventId":"e1","type":"user.message","text":"Yes","ts":90},
                {"eventId":"e2","type":"assistant.text","text":"Continue","ts":100}
              ]
            }
          ]
        }
        """.data(using: .utf8)!
        let sessionList = try decoder.decode(WatchSessionListResponse.self, from: sessionListPayload)
        assertCondition(sessionList.serverId == "srv-1", "session list should decode serverId")
        assertCondition(sessionList.sessions.count == 1, "session list should decode rows")
        assertCondition(sessionList.sessions[0].latestRecentText?.eventId == "e2", "latest recent text should be newest row")
        assertCondition(sessionList.sessions[0].effectivePreviewText == "latest", "preview text should win over fallback recent text")

        let legacySessionPayload = """
        {
          "serverId":"srv-1",
          "sessions":[
            {
              "serverId":"srv-1",
              "sessionName":"deck_sub_legacy",
              "title":"Legacy Worker",
              "state":"working",
              "parentSessionName":"deck_proj_brain"
            }
          ]
        }
        """.data(using: .utf8)!
        let legacySessions = try decoder.decode(WatchSessionListResponse.self, from: legacySessionPayload)
        assertCondition(legacySessions.sessions.count == 1, "legacy session list should decode one row")
        assertCondition(legacySessions.sessions[0].isSubSession, "legacy deck_sub_ rows should infer sub-session status")
        assertCondition(legacySessions.sessions[0].agentBadge.isEmpty, "legacy rows should default missing agentBadge to empty string")
        assertCondition((legacySessions.sessions[0].recentText ?? []).isEmpty, "legacy rows should default missing recentText to empty array")
        assertCondition(legacySessions.sessions[0].isPinned == false, "legacy rows should default missing isPinned to false")

        let serverRequest = try WatchRestClient.makeServersRequest(
            baseUrl: URL(string: "https://example.test")!,
            apiKey: "watch-token"
        )
        assertCondition(serverRequest.url?.absoluteString == "https://example.test/api/watch/servers", "server list URL should be correct")
        assertCondition(serverRequest.value(forHTTPHeaderField: "Authorization") == "Bearer watch-token", "server list auth header should be set")

        let sessionsRequest = try WatchRestClient.makeSessionsRequest(
            baseUrl: URL(string: "https://example.test")!,
            serverId: "srv-3",
            apiKey: "watch-token"
        )
        assertCondition(sessionsRequest.url?.absoluteString == "https://example.test/api/watch/sessions?serverId=srv-3", "session list URL should include serverId query")

        let historyRequest = try WatchRestClient.makeHistoryRequest(
            baseUrl: URL(string: "https://example.test")!,
            serverId: "srv-3",
            sessionName: "deck_sub_gamma",
            apiKey: "watch-token",
            limit: 50,
            beforeTs: 1234
        )
        assertCondition(historyRequest.url?.absoluteString == "https://example.test/api/server/srv-3/timeline/history?sessionName=deck_sub_gamma&limit=50&beforeTs=1234", "history URL should include canonical pagination params")

        let sendRequest = try WatchRestClient.makeRequest(
            baseUrl: URL(string: "https://example.test")!,
            serverId: "srv-3",
            sessionName: "deck_sub_gamma",
            text: "hello",
            apiKey: "watch-token",
            commandId: "cmd-123"
        )
        assertCondition(sendRequest.url?.absoluteString == "https://example.test/api/server/srv-3/session/send", "request URL should target session send endpoint")
        assertCondition(sendRequest.value(forHTTPHeaderField: "Authorization") == "Bearer watch-token", "Authorization header should be set")
        let body = try JSONSerialization.jsonObject(with: sendRequest.httpBody ?? Data(), options: []) as? [String: Any]
        assertCondition(body?["commandId"] as? String == "cmd-123", "commandId should be serialized in request body")
        assertCondition(body?["sessionName"] as? String == "deck_sub_gamma", "sessionName should be serialized in request body")

        let historyPayload = """
        {
          "sessionName":"deck_proj_brain",
          "epoch":7,
          "hasMore":true,
          "nextCursor":100,
          "events":[
            {"eventId":"e1","sessionId":"deck_proj_brain","ts":100,"type":"user.message","payload":{"text":"old"}},
            {"eventId":"e2","sessionId":"deck_proj_brain","ts":200,"type":"assistant.text","payload":{"text":"new"}},
            {"eventId":"e3","sessionId":"deck_proj_brain","ts":210,"type":"tool.call","payload":{"text":"ignore"}}
          ]
        }
        """.data(using: .utf8)!
        let history = try decoder.decode(WatchHistoryResponse.self, from: historyPayload)
        assertCondition(history.events[0].eventId == "e1", "history should preserve canonical event ids")
        assertCondition(history.nextCursor == 100, "history should decode nextCursor")

        let warmItems = sessionList.sessions[0].recentText?.compactMap { WatchConversationItem.fromRecentText($0, sessionId: "deck_proj_brain") } ?? []
        let canonicalItems = history.events.compactMap(WatchConversationItem.fromTimelineEvent)
        let merged = WatchConversationItem.merge(existing: warmItems, incoming: canonicalItems)
        assertCondition(merged.map(\.eventId) == ["e1", "e2"], "merge should dedupe by canonical eventId and ignore unsupported event types")
        assertCondition(merged[0].isUser && !merged[1].isUser, "bubble mapping should keep user on the right and assistant on the left")
        assertCondition(merged[0].text == "old" && merged[1].text == "new", "canonical history should replace warm cache text on duplicate ids")

        let olderItems = [WatchConversationItem(eventId: "e0", sessionId: "deck_proj_brain", ts: 50, type: "assistant.text", text: "earliest", isWarmCache: false)]
        let prepended = WatchConversationItem.merge(existing: merged, incoming: olderItems)
        assertCondition(prepended.map(\.eventId) == ["e0", "e1", "e2"], "older page merge should prepend in ts order")

        print("watch-ios-smoke ok")
    }
}
