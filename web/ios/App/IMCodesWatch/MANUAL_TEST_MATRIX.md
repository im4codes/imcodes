# IMCodesWatch Manual Test Matrix

## Session list
- Launch phone app, connect daemon, open Watch app.
- Verify cached session rows render with:
  - title
  - state badge
  - preview text
  - sub-session parent title

## Voice / typed reply
- Open a session detail row on Watch.
- Enter dictation or typed text.
- Verify:
  - accepted send shows `Sent`
  - auth-expired shows `Authentication expired`
  - unavailable agent shows `Agent unavailable`

## Server switch
- Configure at least two servers.
- Use toolbar server button on Watch to switch.
- Verify:
  - app enters switching state
  - write button disables while switching
  - rows update after new snapshot arrives

## Notification routing
- Send push payload with `serverId`, `session`, `type`.
- Tap notification when:
  - app already open on same server
  - app open on different server
  - app cold-started from notification
- Verify route lands on the target session or shows `Session unavailable` after timeout.

## Daemon disconnect / reconnect
- Disconnect daemon while Watch app is open.
- Verify snapshot status becomes stale and writes remain disabled if routing/auth data is missing.
- Reconnect daemon and refresh.

## Standalone cached read
- Close iPhone app after at least one snapshot sync.
- Open Watch app.
- Verify cached session list still renders from the last application context.

## Standalone direct write
- Close iPhone app after at least one snapshot sync.
- Open Watch app and send a reply using cached `apiKey` + `baseUrl`.
- Verify phone app does not need to be foregrounded for REST send to work.
