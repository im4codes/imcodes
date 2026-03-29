## Context

The daemon currently hardcodes tmux throughout `src/agent/tmux.ts` (538 lines, 20+ exports, 36 import sites in production, 16 in tests). The existing `imcodes send <session> <message>` CLI at `src/index.ts:260-271` calls `sendKeys` directly but cannot resolve labels or check session state. The hook server (`src/daemon/hook-server.ts`) only handles CC-specific `/notify` callbacks. `SessionRuntime` interface (`src/agent/session-runtime.ts`) already provides `send(message)` for both process and transport sessions.

## Goals / Non-Goals

**Goals:**
- Windows support via WezTerm backend swap inside tmux.ts — zero caller changes
- Agent-to-agent messaging via `imcodes send` with label resolution, queue-when-busy, circuit breakers
- Transport sessions as first-class citizens in messaging

**Non-Goals:**
- Token/secret authentication (same-user = full trust)
- TerminalMux interface / `getMux()` migration (too much churn — 50+ files)
- Full tmux feature parity on WezTerm day-1 (streaming, paste buffers are tmux-only initially)
- GUI terminal emulator
- Daemon service registration (separate change)

## Decisions

### 1. Internal backend swap in tmux.ts, not TerminalMux interface

**Decision:** Keep `tmux.ts` (optionally rename to `terminal.ts` with re-export shim). Add `detectBackend()` internally. Each exported function dispatches to WezTerm when backend is `'wezterm'`. WezTerm-specific code lives in a separate `wezterm.ts` file imported by tmux.ts.

**Why:** TerminalMux interface requires migrating 36 production imports + 16 test imports (50+ files). Internal swap requires 0 caller changes, 0 test changes. Same runtime behavior.

**Alternative rejected:** Full `TerminalMux` interface + `getMux()` singleton. Rejected due to massive blast radius for identical runtime behavior.

**Result:**
- Existing exports (`sendKeys`, `newSession`, `killSession`, etc.) keep exact same signatures
- Internal: `rawSendText()` / `rawSendEnter()` dispatch per-backend
- WezTerm-specific logic (name→pane_id mapping via `SessionRecord.paneId`) in `src/agent/wezterm.ts`

### 2. Explicit portable vs tmux-only feature classification

**Decision:** Not all tmux.ts features get WezTerm parity day-1. Classify explicitly.

**Portable (Phase 1):** `newSession`, `killSession`, `sessionExists`, `listSessions`, `sendKeys`, `capturePane`, `respawnPane`, `getPaneCwd`, `getPaneId`, `isPaneAlive`, `sendKey`

**tmux-only (parity later):** `pipe-pane -O` streaming, paste buffer (`showBuffer`/`deleteBuffer`), xterm→tmux key name translation, `capturePaneVisible`/`capturePaneHistory` with ANSI codes, `resizeSession`

**Why:** Hiding unsupported features behind silent no-ops creates subtle regressions. Better to throw `UnsupportedBackendError` on tmux-only calls from WezTerm, so callers can degrade explicitly.

### 3. Transport sessions via existing SessionRuntime.send()

**Decision:** The `/send` handler checks `runtimeType`. Process sessions → `sendKeys()` (terminal backend). Transport sessions → `runtime.send(message)` (provider API). No new routing layer.

**Why:** `SessionRuntime.send()` already exists and works for both runtimes. Building a parallel `sendMessageToAgent()` routing layer duplicates existing dispatch. Phase 2 extends `send()` signature for `--files`/context.

### 4. Queue-when-busy: asymmetric status sources

**Decision:** Same queue policy (in-memory, 10 per target, 5min expiry, FIFO), but different status detection per runtime:
- Process sessions: `capturePane` + `detect.ts` prompt pattern matching
- Transport sessions: `runtime.getStatus()` (already tracks `_sending`/`_status`)

**Why:** Terminal status heuristics don't apply to transport sessions. Transport has explicit status tracking that's more reliable.

### 5. WezTerm pane_id stored in existing SessionRecord.paneId

**Decision:** Reuse `SessionRecord.paneId` field (already exists for tmux). Document it as "opaque backend-specific terminal pane handle" — tmux `%42` or WezTerm numeric ID.

**Why:** Avoids a separate `~/.imcodes/wezterm-sessions.json` mapping file. Existing session store already persists, reconciles on startup, has upsert/remove.

**Contract change:** `paneId` is no longer documented as "tmux pane ID." Callers must treat it as an opaque identifier.

### 6. CORS-only browser protection

**Decision:** Require `Content-Type: application/json` on all hook server endpoints. Reject non-JSON with 415. No OPTIONS handler. No CORS headers. No token auth.

### 7. detectBackend() is a daemon-wide constant

**Decision:** One backend per daemon process. Detected at startup (sync). `$IMCODES_MUX` env override for testing.

**Why:** Mixed backends per-session would create restore/reconcile chaos. Single backend keeps the model simple.

## Risks / Trade-offs

- **[Windows feature gap]** → Terminal streaming (`pipe-pane`), paste buffers, and some capture modes are tmux-only. Windows users get session management + messaging but not live terminal streaming initially. Documented, not silently degraded.
- **[paneId semantic change]** → Existing code comments/docs say "tmux pane ID." Must audit callers that interpret the value rather than treating it as opaque.
- **[Backend detection timing]** → Module-level sync detection means tests that mock tmux behavior need the mock set up before import. May need `$IMCODES_MUX=tmux` in test setup.
- **[Queue message loss]** → In-memory queue lost on daemon restart. CLI response includes `queued: true` warning.
- **[Backward compat]** → Existing `imcodes send <session> <message>` format preserved via target resolution priority #2.
