# IMCodesWatch Manual Test Matrix

This matrix mirrors the `watch-v1` API-first acceptance scope. The iPhone
bridge may seed cached auth/baseUrl/server metadata and notification hints, but
server/session list, history, and send must succeed through direct REST APIs.

## Pre-sync bootstrap
- Start with a Watch install that has never received iPhone auth/baseUrl/server metadata.
- Open the Watch app.
- Verify the Watch shows the open-iPhone/sync prompt and does not attempt direct API loading.

## Direct server/session browsing without active iPhone state sync
- Log in on iPhone once and let it sync auth/baseUrl/server metadata to Watch.
- Background/close the iPhone app so it is not actively pushing applicationContext updates.
- Keep network available and daemon connected.
- Open the Watch app.
- Verify:
  - `GET /api/watch/servers` refreshes the server list.
  - Selecting a server reloads local Watch `selectedServerId` state without sending a `switchServer` command to iPhone.
  - `GET /api/watch/sessions?serverId=...` refreshes the selected server's sessions.
  - Rows render title, state badge, agent badge, pinned/main/sub-session grouping, preview text, and `recentText[]` fallback snippets when present.

## Session detail and real history
- Open a session detail row on Watch.
- Verify:
  - cached `recentText[]` bubbles render immediately when present.
  - the detail view then calls `GET /api/server/:serverId/timeline/history?sessionName=...`.
  - canonical `user.message` bubbles are right-aligned green.
  - canonical `assistant.text` bubbles are left-aligned gray.
  - unsupported event types do not pollute the main chat bubble stream.

## History pagination
- Open a session with more history than the first page.
- Tap the older-history control.
- Verify:
  - the next request includes `beforeTs`.
  - older events prepend in timestamp order.
  - duplicate canonical `eventId`s are not rendered twice.
  - the older-history control disappears or disables when `hasMore` is false.

## Direct reply and quick replies
- Open a session detail row on Watch.
- Send typed/dictated text and each quick reply (`Yes`, `Continue`, `Fix`).
- Verify:
  - every send uses `POST /api/server/:serverId/session/send` with `sessionName`, `text`, and a fresh `commandId`.
  - accepted sends show an optimistic right/green user bubble and then reconcile with real history.
  - auth-expired and daemon-unavailable failures show a failed optimistic bubble and appropriate status text.
  - iPhone does not need to be foregrounded for REST send to work after metadata sync.

## Cached snapshot fallback / degraded mode
- After a successful iPhone sync, disable network or point the Watch at an unavailable server.
- Open the Watch app.
- Verify:
  - cached snapshot rows can render for cold launch/degraded mode.
  - the UI indicates cached/fallback state.
  - direct API data replaces the cached snapshot when network/API calls recover.

## Notification routing
- Send push payloads containing `serverId`, `session`, and `type`.
- Also test compatibility payloads containing `serverId`, `sessionName`, and `type`.
- Tap notifications when:
  - the app is already open on the same server.
  - the app is open on a different server.
  - the app is cold-started from notification.
- Verify:
  - Watch resolves the target route to that exact server/session.
  - it locally selects the target server as needed.
  - it fetches sessions and history via direct APIs after navigation.
  - unresolved routes show `Session unavailable` after timeout instead of navigating to the wrong session.

## Daemon disconnect / reconnect
- Disconnect daemon while Watch app is open.
- Verify live history/send failures surface as degraded/fallback state, not as stale canonical history.
- Reconnect daemon and refresh.
- Verify direct list/history/send paths recover without requiring a new iPhone `switchServer` flow.
