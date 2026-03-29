## 1. WezTerm Backend in tmux.ts

- [ ] 1.1 Add `detectBackend()` function to `tmux.ts`: `$IMCODES_MUX` → `process.platform === 'win32'` → `which tmux` → `which wezterm` → error
- [ ] 1.2 Create `src/agent/wezterm.ts` with WezTerm CLI wrapper functions (newSession, killSession, sendText, sendEnter, capturePane, etc.)
- [ ] 1.3 Add WezTerm name→pane_id tracking using existing `SessionRecord.paneId` (document as opaque backend handle)
- [ ] 1.4 Add backend branches to portable exports in `tmux.ts`: `newSession`, `killSession`, `sessionExists`, `listSessions`, `sendKeys`, `capturePane`, `respawnPane`, `getPaneCwd`, `getPaneId`, `isPaneAlive`, `sendKey`
- [ ] 1.5 Internal split: extract `rawSendText()` / `rawSendEnter()` from `sendKeys()` — backend-aware, shared agent logic (temp file, delayed Enter) stays in `sendKeys`
- [ ] 1.6 Use `os.tmpdir()` instead of hardcoded `/tmp` for temp prompt files
- [ ] 1.7 Add `UnsupportedBackendError` for tmux-only exports called on WezTerm (`showBuffer`, `deleteBuffer`, `pipe-pane` streaming, xterm key translation)
- [ ] 1.8 Move direct `tmux list-panes` call from `subsession-manager.ts:122-128` into new `getPanePids()` export in `tmux.ts`
- [ ] 1.9 WezTerm reconcile: verify pane_ids are still valid in health poller (not a separate mechanism)
- [ ] 1.10 Write WezTerm-specific unit tests (mock execFile, verify wezterm CLI args) — NO changes to existing tmux tests

## 2. IMCODES_SESSION Env Injection

- [ ] 2.1 Add `IMCODES_SESSION=<session_name>` to `extraEnv` in session-manager `launchSession()` path
- [ ] 2.2 Add `IMCODES_SESSION=<session_name>` to `startSubSession()` in subsession-manager
- [ ] 2.3 Verify env injection works for transport sessions (set in spawn env)
- [ ] 2.4 Write test: verify IMCODES_SESSION is present in newSession opts.env

## 3. Hook Server /send Endpoint

- [ ] 3.1 Add `Content-Type: application/json` validation to all hook server endpoints (return 415 for non-JSON)
- [ ] 3.2 Add body size limit (1MB) to hook server request handling
- [ ] 3.3 Add `POST /send` route handler — separate validation from CC-only `/notify`
- [ ] 3.4 Implement target resolution: label (case-insensitive) → session name → agent type. Error + candidate list on collision or not-found.
- [ ] 3.5 Implement runtime dispatch: process sessions → `sendKeys()`, transport sessions → `runtime.send()`
- [ ] 3.6 Implement queue-when-busy: check status (process: capturePane heuristics, transport: runtime.getStatus()), queue if busy, deliver on idle, expire after 5min
- [ ] 3.7 Implement queue drain: on session state change to idle, deliver queued messages FIFO
- [ ] 3.8 Implement circuit breakers: depth counter (max 3), rate limit (10/min per source session), `--all` cap (8)
- [ ] 3.9 Write tests for /send handler (target resolution, queue, circuit breakers, CORS rejection, transport dispatch)

## 4. CLI Extension

- [ ] 4.1 Extend existing `imcodes send` in `src/index.ts` — add `--files`, `--all`, `--type`, `--list` flags
- [ ] 4.2 Implement sender identity detection: `$IMCODES_SESSION` → `$WEZTERM_PANE` (lookup paneId in session store) → `$TMUX_PANE` (query tmux session name)
- [ ] 4.3 Implement hook server IPC: read `~/.imcodes/hook-port`, POST to localhost with `Content-Type: application/json`
- [ ] 4.4 Implement `--list` flag: query hook server for available siblings
- [ ] 4.5 Implement `--files` agent-type-aware formatting (CC gets `@path`, transport gets context payload, others get plain text)
- [ ] 4.6 Ensure backward compat: `imcodes send <session-name> <message>` still works
- [ ] 4.7 Write CLI tests

## 5. System Prompt Injection

- [ ] 5.1 Add `imcodes send` usage docs to `src/daemon/memory-inject.ts`
- [ ] 5.2 Verify prompt injection works for all agent types (CC, Codex, Gemini, transport)

## 6. Final Verification

- [ ] 6.1 Run full test suite — zero existing test regressions
- [ ] 6.2 Manual e2e: agent A sends message to agent B via label (tmux)
- [ ] 6.3 Manual e2e: send to transport session via label
- [ ] 6.4 Manual e2e: queue-when-busy (send to running target, verify delivery on idle)
- [ ] 6.5 Verify backward compat: old `imcodes send <session> <message>` format
- [ ] 6.6 Verify WezTerm path works (WezTerm on Linux or Windows)

## 7. Windows CI — WezTerm Integration Tests

- [ ] 7.1 Add `Windows WezTerm Integration` job to CI (`runs-on: windows-latest`)
- [ ] 7.2 Install WezTerm in CI via `winget install wez.wezterm` or `choco install wezterm`
- [ ] 7.3 Write integration tests: real `wezterm cli spawn` → create session, verify pane_id captured
- [ ] 7.4 Write integration tests: real `wezterm cli send-text` → send text to pane, `get-text` → verify received
- [ ] 7.5 Write integration tests: real `wezterm cli kill-pane` → kill session, verify cleanup
- [ ] 7.6 Write integration tests: capturePane normalization — verify output matches tmux format expectations
- [ ] 7.7 Write integration tests: session lifecycle — newSession → sendKeys → capturePane → isPaneAlive → killSession
- [ ] 7.8 Gate WezTerm integration tests behind `IMCODES_MUX=wezterm` env (skip on Linux CI where WezTerm not installed)
