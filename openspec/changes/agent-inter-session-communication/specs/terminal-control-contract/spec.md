## MODIFIED Requirements

### Requirement: tmux.ts supports WezTerm backend via internal dispatch
The existing `src/agent/tmux.ts` SHALL add internal backend detection and dispatch to WezTerm CLI functions. All portable exports keep their exact signatures. Callers require zero changes.

#### Scenario: Backend detection at module load
- **WHEN** the daemon starts
- **THEN** `detectBackend()` SHALL check `$IMCODES_MUX` env → `process.platform === 'win32'` → `which tmux` → `which wezterm`, and set a module-level constant

#### Scenario: Portable exports dispatch to WezTerm
- **WHEN** backend is `'wezterm'` and a portable function is called (newSession, killSession, sendKeys, capturePane, etc.)
- **THEN** it SHALL dispatch to the corresponding WezTerm CLI wrapper in `src/agent/wezterm.ts`

#### Scenario: tmux-only exports throw on WezTerm
- **WHEN** backend is `'wezterm'` and a tmux-only function is called (showBuffer, deleteBuffer, pipe-pane streaming)
- **THEN** it SHALL throw `UnsupportedBackendError`

#### Scenario: paneId is opaque backend handle
- **WHEN** `SessionRecord.paneId` is set
- **THEN** it SHALL be treated as an opaque backend-specific identifier (tmux `%42` or WezTerm numeric ID), not a tmux-specific value

#### Scenario: WezTerm pane reconciliation via health poller
- **WHEN** backend is `'wezterm'` and the health poller runs
- **THEN** it SHALL verify stored pane_ids are still valid via `wezterm cli list`, removing stale entries

### Requirement: WezTerm session management via name→pane_id in session store
The WezTerm backend SHALL track session-to-pane mapping using the existing `SessionRecord.paneId` field, not a separate JSON file.

#### Scenario: newSession stores pane_id
- **WHEN** `newSession(name, cmd, opts)` is called on WezTerm backend
- **THEN** it SHALL execute `wezterm cli spawn --cwd <cwd> -- cmd`, capture the pane ID, and store it in `SessionRecord.paneId`

#### Scenario: newSession always passes --cwd
- **WHEN** WezTerm `newSession` is called
- **THEN** `--cwd` SHALL always be passed explicitly

#### Scenario: Direct tmux calls moved to exports
- **WHEN** code outside tmux.ts directly calls tmux CLI (e.g., `subsession-manager.ts` calling `tmux list-panes`)
- **THEN** those calls SHALL be wrapped in a new backend-aware export (e.g., `getPanePids()`)
