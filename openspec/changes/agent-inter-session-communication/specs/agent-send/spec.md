## ADDED Requirements

### Requirement: sendMessageToAgent delivers messages cross-platform and cross-runtime
The system SHALL provide a shared `sendMessageToAgent()` function in `src/agent/agent-send.ts` that routes messages to mux-backed sessions (tmux/WezTerm) or transport-backed sessions (OpenClaw etc.) based on session runtime type.

#### Scenario: Mux session — short message delivered directly
- **WHEN** target is a mux-backed session and message is ≤4000 characters and single-line
- **THEN** it SHALL call `mux.sendText` + delay + `mux.sendKey('Enter')`

#### Scenario: Mux session — long message delivered via temp file
- **WHEN** target is a mux-backed session and message exceeds 4000 characters or contains newlines
- **THEN** it SHALL write to `os.tmpdir()/.imcodes-prompt-<uuid>.md`, send `Read and execute all instructions in @<path>` via `mux.sendText` + Enter, and schedule file cleanup after 30 seconds

#### Scenario: Mux session — message sanitized before delivery
- **WHEN** target is a mux-backed session
- **THEN** `mux.sanitize()` SHALL be called before delivery to strip platform-specific dangerous characters

#### Scenario: Transport session — message delivered via provider API
- **WHEN** target is a transport-backed session (runtimeType === 'transport')
- **THEN** it SHALL send the message through the transport provider's chat API (e.g., `provider.sendChat()`) without terminal mux involvement

#### Scenario: Transport session — files included as context
- **WHEN** target is a transport-backed session and `--files` are specified
- **THEN** file paths or contents SHALL be included in the provider API payload as context

### Requirement: imcodes send CLI resolves targets by label
The system SHALL extend the existing `imcodes send` CLI command to resolve targets by label, agent type, or session name within the same parent session scope.

#### Scenario: Target resolved by label
- **WHEN** `imcodes send "Plan" "review this"` is called
- **THEN** CLI SHALL resolve "Plan" to the sibling session with matching label (case-insensitive)

#### Scenario: Target resolved by session name (backward compat)
- **WHEN** `imcodes send "deck_sub_xxx" "hello"` is called
- **THEN** CLI SHALL match the exact session name (existing behavior preserved)

#### Scenario: Target resolved by agent type
- **WHEN** `imcodes send --type codex "run tests"` is called
- **THEN** CLI SHALL find the sibling session with matching agent type; error if multiple match

#### Scenario: Ambiguous target returns error with candidates
- **WHEN** multiple sessions match the target label or type
- **THEN** CLI SHALL return an error listing available candidates

#### Scenario: Broadcast to all siblings
- **WHEN** `imcodes send --all "status update"` is called
- **THEN** CLI SHALL send to all non-self siblings under the same parent, up to 8 recipients

### Requirement: Sender identity auto-detected
The system SHALL auto-detect the sender's session identity without agent involvement.

#### Scenario: Identity from IMCODES_SESSION env var
- **WHEN** `$IMCODES_SESSION` is set
- **THEN** CLI SHALL use it as the sender session name

#### Scenario: Identity from WEZTERM_PANE fallback
- **WHEN** `$IMCODES_SESSION` is not set but `$WEZTERM_PANE` is set
- **THEN** CLI SHALL look up the pane ID in the WezTerm name→pane_id mapping

#### Scenario: Identity from TMUX_PANE fallback
- **WHEN** neither `$IMCODES_SESSION` nor `$WEZTERM_PANE` is set but `$TMUX_PANE` is set
- **THEN** CLI SHALL query tmux for the session name of that pane

### Requirement: IMCODES_SESSION injected at session launch
The system SHALL inject `IMCODES_SESSION` env var into every agent session at launch time via `newSession({ env })`.

#### Scenario: Env injected through existing extraEnv path
- **WHEN** a new session is launched (main or sub)
- **THEN** `IMCODES_SESSION=<session_name>` SHALL be included in the `env` option passed to `mux.newSession()`

### Requirement: Hook server /send endpoint handles agent-to-agent messages
The system SHALL add a `POST /send` endpoint to the hook server for agent-to-agent message routing.

#### Scenario: Valid send request delivered immediately
- **WHEN** POST /send with valid `from`, `to`, `message` and target is idle
- **THEN** handler SHALL resolve target, call `sendMessageToAgent()`, return `{ ok: true, delivered: true, target }`

#### Scenario: Target busy — message queued
- **WHEN** POST /send and target session state is `running`
- **THEN** message SHALL be queued in memory and response SHALL be `{ ok: true, queued: true }`

#### Scenario: Queued message delivered when target becomes idle
- **WHEN** a queued target session transitions to `idle`
- **THEN** queued messages SHALL be delivered FIFO, skipping any older than 5 minutes

#### Scenario: Queue limits enforced
- **WHEN** a target already has 10 queued messages
- **THEN** new messages for that target SHALL be rejected

#### Scenario: Target not found
- **WHEN** target cannot be resolved
- **THEN** response SHALL be `{ ok: false, error: "target not found", available: [...] }`

### Requirement: Circuit breakers prevent abuse
The system SHALL enforce depth, rate, and broadcast limits on `/send`.

#### Scenario: Circular send depth exceeded
- **WHEN** `/send` payload has `depth >= 3`
- **THEN** request SHALL be rejected with `{ ok: false, error: "depth limit exceeded" }`

#### Scenario: Rate limit exceeded
- **WHEN** a source session sends more than 10 messages per minute
- **THEN** request SHALL be rejected with `{ ok: false, error: "rate limit exceeded" }`

#### Scenario: Broadcast cap exceeded
- **WHEN** `--all` resolves to more than 8 siblings
- **THEN** only the first 8 SHALL receive the message

### Requirement: CORS protection on hook server
The system SHALL require `Content-Type: application/json` on all hook server endpoints to prevent browser cross-origin attacks.

#### Scenario: Non-JSON content type rejected
- **WHEN** a request arrives with `Content-Type` other than `application/json`
- **THEN** server SHALL respond with 415 Unsupported Media Type

#### Scenario: OPTIONS not implemented
- **WHEN** an OPTIONS request arrives (CORS preflight)
- **THEN** server SHALL respond with 404 (no CORS headers)

### Requirement: --files injection is agent-type-aware
The system SHALL format file references based on the target agent type.

#### Scenario: Claude Code target gets @ references
- **WHEN** `--files src/api.ts` is sent to a claude-code session
- **THEN** message SHALL be prefixed with `@src/api.ts`

#### Scenario: Non-CC target gets plain text paths
- **WHEN** `--files src/api.ts` is sent to a codex or gemini session
- **THEN** file paths SHALL be appended as plain text at the end of the message

### Requirement: System prompt injection for imcodes send docs
The system SHALL auto-inject `imcodes send` usage instructions into agent prompts via `src/daemon/memory-inject.ts`.

#### Scenario: Agent receives send instructions at launch
- **WHEN** an agent session starts
- **THEN** the system prompt SHALL include `imcodes send` usage documentation
