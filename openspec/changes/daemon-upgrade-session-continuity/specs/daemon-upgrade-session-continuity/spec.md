## ADDED Requirements

### Requirement: Restorable ordinary sessions SHALL be handed off across daemon upgrade

An ordinary session with a supported runtime and durable restoration authority SHALL NOT block a daemon upgrade solely because it is executing or has queued messages. The upgrade coordinator SHALL first persist the handoff needed to resume that session and SHALL fail closed when the handoff cannot be made durable.

#### Scenario: Executing ordinary session is restorable

- **WHEN** a daemon upgrade is requested while an ordinary supported session is executing
- **AND** its durable session and transport queue authorities can be persisted
- **THEN** the upgrade coordinator records a resumable handoff instead of rejecting the upgrade merely because the session is busy

#### Scenario: Ordinary session handoff cannot be persisted

- **WHEN** an ordinary session is executing or queued but its required restoration authority cannot be persisted
- **THEN** the upgrade remains blocked
- **AND** the session is not represented as safely handed off

### Requirement: Upgrade continuation SHALL preserve durable queue order and exactly-once delivery

The handoff SHALL reuse the existing SQLite-backed transport queue authority rather than create a second queue. For an executing ordinary session, the coordinator SHALL append exactly one daemon-owned continuation behind messages that were already queued, and restoration SHALL deliver that continuation at most once.

#### Scenario: Existing messages precede the continuation

- **WHEN** a restorable executing session already has queued messages at upgrade time
- **THEN** those messages retain their existing order
- **AND** one daemon-owned continuation is appended after them

#### Scenario: Daemon restarts after accepting the handoff

- **WHEN** the replacement daemon restores the session and its durable queue
- **THEN** it resumes from the existing queue authority
- **AND** it does not synthesize a duplicate continuation or replay an acknowledged continuation

### Requirement: Upgrade handoff status SHALL be truthful and bounded

The coordinator SHALL expose a concise status for each attempted ordinary-session handoff that distinguishes queued, sent, and failed continuation delivery. A failed handoff SHALL remain an upgrade blocker rather than being reported as successful continuity.

#### Scenario: Continuation is durably queued

- **WHEN** the continuation is accepted into the durable queue but has not yet been dispatched
- **THEN** the handoff status reports queued rather than sent

#### Scenario: Continuation handoff fails

- **WHEN** persistence, restoration binding, or continuation delivery cannot be established
- **THEN** the handoff status reports failed
- **AND** the upgrade does not claim continuity for that session

### Requirement: Non-restorable runtime activity SHALL continue to block upgrade

The continuity handoff SHALL apply only to ordinary restorable sessions. Active P2P or Team work, OpenSpec Auto Deliver, compaction or compression, unsupported runtimes, and failed handoffs SHALL retain their fail-closed upgrade blockers.

#### Scenario: Specialized orchestration is active

- **WHEN** an upgrade is requested while P2P, Team, or OpenSpec Auto Deliver work is active
- **THEN** the upgrade remains blocked by that activity
- **AND** the ordinary-session continuation path is not used to bypass the blocker

#### Scenario: Runtime cannot be restored safely

- **WHEN** an active session uses an unsupported runtime or lacks exact restoration identity
- **THEN** the upgrade remains blocked
- **AND** no continuation is queued for that session
