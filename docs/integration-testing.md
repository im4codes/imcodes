# Integration Testing Checklist

Manual end-to-end acceptance tests for the full imcodes system.
These scenarios require a real deployment (CF Worker, daemon, platform bot credentials).

---

## 14.4 Discord → Brain → Worker → Discord

**Prerequisites:**
- Daemon running locally with `imcodes start`
- CF Worker deployed with `wrangler deploy`
- Discord bot token configured, guild connected
- Brain session active (`@brain`), at least one worker (`@w1`)

**Steps:**
1. Register server: `POST /api/server` with name + token
2. Bind Discord channel: `/bind project my-project` in target channel
3. Start project: `/start @w1`
4. Send task: `build a hello world function` in the bound channel
5. Observe brain dispatches to `@w1`
6. Wait for worker to complete (idle detection)
7. Verify response posted back in Discord channel

**Pass criteria:**
- Response appears in Discord within 60s
- Response contains the worker's output (not an error)
- Session state transitions: `running` → `idle` → `running` (if brain sends follow-up)

---

## 14.5 Web Terminal — Live Streaming + Start/Stop

**Prerequisites:**
- CF Worker deployed
- Daemon running
- Browser open to web UI (`http://localhost:5173` or hosted URL)

**Steps:**
1. Log in to web UI with API key
2. Navigate to a project's terminal view
3. Verify terminal streams live tmux output (WebSocket connected indicator visible)
4. Type a message in the send box, press Enter
5. Observe message sent to session via `/send`
6. Click **Stop Session** button
7. Verify session stops (indicator changes to "stopped")
8. Click **Start Session** button
9. Verify session restarts and terminal resumes streaming

**Pass criteria:**
- No lag >2s in terminal stream under normal conditions
- Start/stop round-trip completes within 5s
- WebSocket reconnects automatically after brief disconnect

---

## 14.6 Mobile App — Push + Terminal + Send

**Prerequisites:**
- Capacitor app built for iOS or Android (`npx cap run ios` / `npx cap run android`)
- FCM_SERVER_KEY configured in CF Worker env
- Push token registered from device

**Steps:**
1. Open mobile app, log in with API key
2. Navigate to terminal view for an active session
3. Trigger a session event (send a message via desktop browser)
4. Verify push notification arrives on device within 10s
5. Tap notification → app opens to correct session
6. Swipe left/right to switch between sessions
7. Tap send button, type a message, send
8. Verify message appears in terminal view

**Pass criteria:**
- Push notification delivered without app open (background)
- Deep link from notification opens correct session
- Terminal streams correctly on mobile viewport
- Send works from mobile keyboard

---

## 14.7 Team Flow — Invite + Shared Access + Permissions

**Prerequisites:**
- Two user accounts (owner: User A, member: User B)
- CF Worker deployed with D1 database

**Steps:**
1. User A creates team: `POST /api/team` `{ "name": "My Team" }`
2. User A invites User B: `POST /api/team/:id/invite` `{ "email": "userb@example.com", "role": "member" }`
3. User B receives invite token (check response or email)
4. User B joins: `POST /api/team/join/:token`
5. User A assigns server to team: `PUT /api/server/:id` `{ "team_id": "..." }`
6. User B lists servers: `GET /api/server` — verify they see the shared server
7. User B sends message: `POST /api/server/:id/session/send` — should succeed
8. User B tries admin action (stop session): `POST /api/server/:id/session/stop` — should return 403

**Pass criteria:**
- Invite token valid for 7 days
- Member can read session output and send messages
- Member cannot stop/start sessions (admin-only)
- Owner can revoke membership and access is immediately denied

---

## 14.8 Cron Job → Scheduled Session Start

**Prerequisites:**
- CF Worker deployed with cron triggers enabled
- Daemon connected and online

**Steps:**
1. Create a cron job: `POST /api/cron` `{ "cron_expr": "* * * * *", "action": "start_session", "target": "my-project" }`
2. Wait for next minute trigger (CF cron fires `*/1`)
3. Verify job-dispatch handler picks up the job
4. Verify daemon receives the start request via DaemonBridge
5. Verify session starts (check `/api/server/:id/session/status`)
6. Disable cron job: `PUT /api/cron/:id` `{ "enabled": false }`
7. Wait one more minute, verify no new session starts

**Pass criteria:**
- Session starts within 5s of cron trigger
- Cron next_run updated after successful dispatch
- Disabled job is skipped by getDueCronJobs
- Health-check cron marks daemon offline if no heartbeat for >90s

---

## Running Automated E2E Tests

```bash
# Skip tmux-dependent tests
SKIP_TMUX_TESTS=1 npm run test:e2e

# Run all E2E including tmux tests (requires tmux installed)
npm run test:e2e

# Run a single E2E test
npx vitest run test/e2e/brain-worker-flow.test.ts
```

Test files:
- `test/e2e/brain-worker-flow.test.ts` — brain/worker dispatch with mock agents
- `test/e2e/crash-restart.test.ts` — session crash + auto-restart + loop prevention
- `test/e2e/memory-injection.test.ts` — memory search and prompt injection
- `test/e2e/multi-session.test.ts` — parallel brain + 2 workers
- `test/e2e/autofix-flow.test.ts` — full auto-fix pipeline with mock tracker
