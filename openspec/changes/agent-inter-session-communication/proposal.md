## Why

AI agents running in separate sessions cannot communicate with each other. An agent in one sub-session has no way to ask a sibling agent to review code, run tests, or coordinate on a task. Users must manually copy-paste between sessions. Additionally, the daemon is tightly coupled to tmux — no Windows support.

This change adds agent-to-agent messaging via `imcodes send` CLI and WezTerm backend support inside the existing `tmux.ts` module (zero caller changes). Transport sessions are first-class citizens.

## What Changes

- **WezTerm backend in tmux.ts**: Add `detectBackend()` internally. Each portable export dispatches to WezTerm CLI on Windows. Zero caller changes, zero test changes. WezTerm-specific code in `src/agent/wezterm.ts`.
- **Feature classification**: Portable functions (Phase 1) vs tmux-only (parity later). tmux-only calls throw `UnsupportedBackendError` on WezTerm.
- **Agent message delivery**: `/send` handler checks `runtimeType` — process sessions → `sendKeys()`, transport sessions → `SessionRuntime.send()`. No new routing layer.
- **Extend `imcodes send` CLI**: Add label-based target resolution, `--files`, `--all`, `--list`, `--type` flags. CLI auto-detects sender identity via `$IMCODES_SESSION` env var.
- **Hook server `/send` endpoint**: New `POST /send` for agent-to-agent messaging, separate from CC-only `/notify`. CORS protection via `Content-Type: application/json` requirement. No token auth.
- **Queue-when-busy**: Messages to running targets queued in-memory. Asymmetric status detection: process sessions use capturePane heuristics, transport sessions use `runtime.getStatus()`.
- **Circuit breakers**: Depth limit (3), rate limiting (10/min/source), broadcast cap (8).
- **`IMCODES_SESSION` env injection**: All sessions inject identity at launch via `newSession({ env })`.
- **System prompt injection**: `src/daemon/memory-inject.ts` auto-injects `imcodes send` docs.

## Capabilities

### New Capabilities
- `agent-send`: Agent-to-agent message delivery via `imcodes send` CLI and hook server `/send` endpoint. Includes target resolution, queue-when-busy, circuit breakers, transport-first-class support, and WezTerm backend for Windows.

### Modified Capabilities
- `terminal-control-contract`: tmux.ts gains internal WezTerm backend dispatch. Portable exports unchanged. tmux-only exports throw on WezTerm.
- `web-command-handler`: Hook server gains `/send` endpoint with CORS protection, separate from existing CC-only `/notify`.

## Impact

- **Daemon (`src/agent/tmux.ts`)**: Internal WezTerm backend branches added. New `src/agent/wezterm.ts`. One external fix: `subsession-manager.ts` tmux leak → new `getPanePids()` export.
- **Daemon (`src/daemon/`)**: New `/send` handler in `hook-server.ts`. Modified: `memory-inject.ts`, `command-handler.ts`.
- **CLI (`src/index.ts`)**: Existing `imcodes send` extended with new flags and hook-server IPC.
- **Session store**: `paneId` field becomes "opaque backend-specific terminal pane handle" (tmux or WezTerm).
- **Dependencies**: WezTerm CLI required on Windows. No new npm dependencies.
- **Backward compatibility**: All existing exports, callers, and tests unchanged. Existing `imcodes send <session> <message>` format preserved.
- **Existing tests**: Zero changes. New WezTerm-specific tests added separately.
