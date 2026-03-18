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

IM.codes is a three-tier system for remote-controlling AI coding agents via chat platforms:

```
Chat Platforms (Discord/Telegram/Feishu)
        ↓ webhooks
Server (Node.js + Hono + PostgreSQL, self-hosted in server/)
        ↓ WebSocket
Daemon (Node.js CLI on user's machine, src/)
        ↓ tmux
AI Agents (Claude Code / Codex / Gemini / OpenCode / Shell in tmux sessions)
```

### Daemon (`src/`)

Node.js process that manages AI agent sessions via tmux. Entry point: `src/index.ts` (commander CLI).

- **Agent layer** (`src/agent/`): `tmux.ts` wraps tmux commands. `session-manager.ts` manages project sessions (brain + workers), auto-restart with loop prevention. Each agent type has a driver (`drivers/claude-code.ts`, `drivers/codex.ts`, `drivers/gemini.ts`, `drivers/opencode.ts`, `drivers/shell.ts`) implementing `AgentDriver` — build launch/resume commands, detect status, capture output.
- **Routing** (`src/router/`): `message-router.ts` routes inbound messages from chat platforms to the correct tmux session based on channel bindings. Bindings are cached in-memory and persisted to the server DB. `command-parser.ts` handles `/bind`, `/status`, `/send`, etc.
- **Brain dispatcher** (`src/agent/brain-dispatcher.ts`): Parses `@w1`, `@status`, `@reply` commands from the brain session's output, dispatching to workers.
- **Server link** (`src/daemon/server-link.ts`): WebSocket client connecting to the server at `/api/server/:id/ws`. Sends `{ type: 'auth', serverId, token }` on open. Credentials stored in `~/.imcodes/server.json` after `imcodes bind`.
- **Session store** (`src/store/session-store.ts`): JSON file at `~/.imcodes/sessions.json`, debounced writes.

### Server (`server/`)

Self-hosted Node.js backend (Hono). Has its own `tsconfig.json` and `node_modules`.

- **Routes** (`server/src/routes/`): `webhook.ts` receives platform webhooks, verifies signatures, normalizes to `InboundMessage`. `outbound.ts` handles daemon→platform message delivery. `server.ts` includes WebSocket upgrade + channel binding CRUD. `bot.ts` manages per-user bot registrations with encrypted credentials.
- **WsBridge** (`server/src/ws/bridge.ts`): Holds the daemon WebSocket. Enforces auth handshake, queues messages when daemon is disconnected, relays between daemon and browser viewers.
- **Platform handlers** (`server/src/platform/handlers/{discord,telegram,feishu}/`): Each implements `PlatformHandler` — `verifyInbound()`, `normalizeInbound()`, `sendOutbound()`. Per-user bot credentials are AES-256-GCM encrypted in PostgreSQL, decrypted at runtime with `BOT_ENCRYPTION_KEY`.
- **DB schema**: PostgreSQL migrations in `server/src/db/migrations/` (001–010). Key tables: `users`, `servers`, `channel_bindings`, `platform_bots` (encrypted credentials), `sessions`.
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

- Session names follow the pattern `deck_{project}_{role}` (e.g., `deck_myapp_brain`, `deck_myapp_w1`).
- Agent types: `'claude-code' | 'codex' | 'gemini' | 'opencode' | 'shell' | 'script'` — the `AgentType` union in `src/agent/detect.ts`.
- Server secrets (`JWT_SIGNING_KEY`, `BOT_ENCRYPTION_KEY`) are set via environment variables, never committed.
- E2E tests require tmux. They are auto-skipped when `SKIP_TMUX_TESTS=1` or inside a Claude Code session (`CLAUDECODE` env var set).
- The server TypeScript project is stricter (`noUnusedLocals`, `noImplicitReturns`). Both daemon and server projects must compile cleanly.
