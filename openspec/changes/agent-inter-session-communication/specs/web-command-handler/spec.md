## MODIFIED Requirements

### Requirement: Hook server supports /send endpoint alongside /notify
The hook server SHALL support a new `POST /send` endpoint for generic agent-to-agent messaging, separate from the existing CC-only `POST /notify`.

#### Scenario: /notify remains CC-only
- **WHEN** `POST /notify` receives a request for a non-claude-code session
- **THEN** it SHALL be ignored (existing behavior unchanged)

#### Scenario: /send accepts any managed session type
- **WHEN** `POST /send` receives a request with `from` being any managed session (claude-code, codex, gemini, shell)
- **THEN** it SHALL process the request regardless of agent type

#### Scenario: Content-Type validation on all endpoints
- **WHEN** any request arrives at `/notify` or `/send` without `Content-Type: application/json`
- **THEN** server SHALL respond with 415 Unsupported Media Type
