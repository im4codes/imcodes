# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build & typecheck
npm run build                              # daemon (src/ → dist/)
npx tsc --noEmit                           # daemon typecheck only
npx tsc -p server/tsconfig.json --noEmit   # server (stricter: noUnusedLocals, noImplicitReturns)

# Tests (vitest workspace)
npm test                               # all projects
npm run test:unit                      # daemon only (src/**/*.test.ts, test/**/*.test.ts, excludes e2e)
npm run test:server                    # server only (server/test/**/*.test.ts)
npm run test:web                       # web only (web/test/**/*.test.ts, jsdom environment)
npm run test:e2e                       # e2e only (test/e2e/**/*.test.ts, 30s timeout, requires tmux)
npx vitest run path/to/file.test.ts    # single file

# Server (self-hosted backend)
cd server && npm run dev               # run server via tsx
cd server && npm run migrate           # apply PostgreSQL migrations

# Dev
npm run dev                            # run daemon via tsx
```

## Architecture

IM.codes is a specialized instant messenger for AI coding agents — a three-tier system for remote terminal access, file browsing, multi-agent workflows, and session management:

```
You (browser / mobile app)
        ↓ WebSocket
Server (Node.js + Hono + PostgreSQL, self-hosted in server/)
        ↓ WebSocket
Daemon (Node.js CLI on user's machine, src/)
        ↓ tmux / ConPTY / transport
AI Agents (Claude Code / Codex / Gemini CLI / OpenClaw / Shell)
        ↔ imcodes send (agent-to-agent)
```

### Daemon (`src/`)

Node.js process that manages AI agent sessions via tmux. Entry point: `src/index.ts` (commander CLI).

- **Agent layer** (`src/agent/`): Two runtime backends — **process agents** run in tmux/ConPTY sessions, **transport agents** stream via network protocols.
  - Process drivers (`src/agent/drivers/`): `claude-code.ts`, `codex.ts`, `gemini.ts`, `opencode.ts`, `shell.ts` — each implements `AgentDriver` (build launch/resume commands, detect status via terminal patterns, capture output). `tmux.ts` wraps tmux (Linux/macOS), `conpty.ts` provides ConPTY (Windows).
  - Transport providers (`src/agent/providers/`): `qwen.ts` (Qwen, LOCAL_SDK — spawns CLI process with stream-json output), `openclaw.ts` (OpenClaw, PERSISTENT — WebSocket to gateway). Each implements `TransportProvider` — `connect()`, `send()`, `onDelta()`, `onComplete()`. Streaming is event-driven (no terminal scraping).
  - Agent types: `ProcessAgent = 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'shell' | 'script'`, `TransportAgent = 'openclaw' | 'qwen'`. Defined in `src/agent/detect.ts`.
  - `session-manager.ts` manages all sessions, auto-restart with loop prevention. `provider-registry.ts` manages transport provider lifecycle.
- **Transport relay** (`src/daemon/transport-relay.ts`): Converts transport provider callbacks (`onDelta`, `onComplete`, `onError`) to unified timeline events (`assistant.text`, `session.state`, `tool.call`).
- **Routing** (`src/router/`): `message-router.ts` routes inbound messages to the correct session. `command-parser.ts` handles `/bind`, `/status`, `/send`, etc.
- **Brain dispatcher** (`src/agent/brain-dispatcher.ts`): Parses `@w1`, `@status`, `@reply` commands from the brain session's output, dispatching to workers.
- **Server link** (`src/daemon/server-link.ts`): WebSocket client connecting to the server at `/api/server/:id/ws`. Sends `{ type: 'auth', serverId, token }` on open. Credentials stored in `~/.imcodes/server.json` after `imcodes bind`.
- **Session store** (`src/store/session-store.ts`): JSON file at `~/.imcodes/sessions.json`, debounced writes.

### Server (`server/`)

Self-hosted Node.js backend (Hono). Has its own `tsconfig.json` and `node_modules`.

- **Routes** (`server/src/routes/`): `server.ts` includes WebSocket upgrade + session management. `passkey-auth.ts` handles WebAuthn passkey registration/login. `push.ts` dispatches push notifications to iOS (APNs) and Android (FCM). `cron-api.ts` manages scheduled tasks. `discussions.ts` serves P2P discussion runs/history. `file-transfer.ts` handles file upload/download. `session-mgmt.ts` provides session label/description/cwd CRUD.
- **WsBridge** (`server/src/ws/bridge.ts`): Holds the daemon WebSocket. Enforces auth handshake, queues messages when daemon is disconnected, relays between daemon and browser viewers. Binary PTY frames are routed only to browsers subscribed to the target session (not broadcast).
- **DB schema**: PostgreSQL migrations in `server/src/db/migrations/`. Key tables: `users`, `servers`, `sessions`, `sub_sessions`, `passkey_credentials`, `passkey_challenges`, `api_keys`, `scheduled_tasks`, `orchestration_runs`.
- **Logger** (`server/src/util/logger.ts`) recursively redacts keys matching `/_token$/i`, `/_key$/i`, `/_secret$/i` before output.

### Web (`web/`) and Mobile (`mobile/`)

Web terminal viewer (`web/src/ws-client.ts` — WebSocket client with reconnect). Mobile app with biometric auth and push notifications.

### i18n Development (`web/`)

The web project uses `i18next` with `react-i18next` for internationalization.

- **Storage**: Locales are in `web/src/i18n/locales/*.json`.
- **Structure**: JSON files use nested namespaces (e.g., `common`, `chat`, `session`).
- **Usage**:
  - Hook: `const { t } = useTranslation();`
  - Translate: `t('namespace.key')` or `t('namespace.key_with_params', { name: 'value' })`
- **Interpolation**: Uses double curly braces: `{{variable}}`.
- **Supported**: `en`, `zh-CN`, `zh-TW`, `es`, `ru`, `ja`, `ko`. Default is auto-detected from browser or `localStorage`.
- **MANDATORY**: All user-visible strings in `web/` MUST use `t()`. Never hardcode display text in any language. When adding new strings, update ALL 7 locale files.

## Key Conventions

- **FORBIDDEN — Never `git add` these directories:** `openspec/` and `docs/` are local-only planning/documentation directories. NEVER stage, commit, or push any file under `openspec/` or `docs/` to git. They are in `.gitignore` and must stay out of version control.
- Session names follow the pattern `deck_{project}_{role}` (e.g., `deck_myapp_brain`, `deck_myapp_w1`).
- Agent types: Process = `'claude-code' | 'codex' | 'gemini' | 'opencode' | 'shell' | 'script'`, Transport = `'openclaw' | 'qwen'` — the `AgentType` union in `src/agent/detect.ts`.
- **Pod-sticky routing (MANDATORY for daemon-dependent requests)**: The server runs multiple replicas. Each daemon connects to ONE pod via WebSocket (`/api/server/:serverId/ws`). The ingress routes all requests under `/api/server/:serverId/` to the same pod that holds that daemon's WS connection. Any endpoint that depends on the daemon (file download/upload, session commands, Watch API) **MUST** be under this prefix — it's regular HTTP, not WebSocket, but it must hit the same pod. Never create daemon-dependent endpoints outside `/api/server/:serverId/`. In-memory state (download tokens, WsBridge instances, terminal streams) is per-pod and will 404/fail on the wrong pod.
- Server secrets (`JWT_SIGNING_KEY`) are set via environment variables, never committed.
- E2E tests require tmux. They are auto-skipped when `SKIP_TMUX_TESTS=1` or inside a Claude Code session (`CLAUDECODE` env var set).
- The server TypeScript project is stricter (`noUnusedLocals`, `noImplicitReturns`). Both daemon and server projects must compile cleanly.
- **Shared code between daemon, server, and web**: Use `shared/` directory (NOT `src/shared/`). Server tsconfig includes `../shared/**/*`. Import path from server: `../../../shared/foo.js`. Import path from daemon/test: `../../shared/foo.js`. Import path from web: `@shared/foo.js` (Vite alias configured in `web/vite.config.ts`). The `shared/` dir is copied into Docker image by `Dockerfile` (`COPY shared/ ./shared/`). **NEVER** import across project boundaries with `../../../src/` paths — they break at runtime in Docker.
- **Web tsconfig is stricter** than daemon (`noUnusedLocals`). The Docker build runs `cd web && npm run build` which will fail on unused variables/imports that pass `npx tsc --noEmit` in daemon. Always run `cd web && npx tsc --noEmit` before pushing.
- **MANDATORY — ZERO TOLERANCE: No hardcoded strings for types, statuses, message names, cookie names, header names, or any value shared across daemon/server/web.** Before writing ANY string literal that represents a type, status, event name, cookie name, or protocol constant:
  1. **STOP and search** `shared/` for an existing constant: `grep -r "your_string" shared/`
  2. If it exists → import it. If it doesn't → create it in the appropriate `shared/*.ts` file first, then import.
  3. **NEVER** define the same string in two places. Not even with a comment saying "must match X". Import it.
  4. Import paths: server uses `../../../shared/foo.js`, daemon uses `../../shared/foo.js`, web uses `@shared/foo.js`.
  - Existing shared modules: `shared/repo-types.ts` (repo message types), `shared/p2p-status.ts` (P2P run statuses), `shared/p2p-modes.ts` (P2P modes), `shared/cookie-names.ts` (cookie/CSRF constants).
  - **When adding a new constant**: add it to an existing shared module if it fits, or create a new `shared/<name>.ts` file.
- **MANDATORY: Never copy code. Always share and reuse.** If the same logic exists in daemon and server/web, extract it to `shared/`. If a utility function is needed in multiple files, create it once in `src/util/` or `shared/` and import it. Duplicate code is a bug factory.
