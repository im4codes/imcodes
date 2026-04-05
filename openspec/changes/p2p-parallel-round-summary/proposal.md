## Why

P2P multi-round discussion is currently fully serial, so total runtime grows with every hop in every round. That makes multi-agent audit/review discussions too slow, and it also forces all hops to write directly into one shared file, which makes round-level collection and status reporting hard to reason about.

## What Changes

- Run phase-2 hops in parallel within each round, while keeping the initiator kickoff and round summary sequential.
- Give each hop its own temporary discussion file, let the orchestrator collect each hop's newly added analysis into the main discussion file in place, and let the summary step append the round summary section.
- Standardize hop-level and run-level status updates so timeout, failure, cancel, and summary phases are observable.
- Make the daemon serializer explicitly responsible for preserving the legacy top-level P2P progress projection so richer hop/run fields remain additive for existing consumers.
- Preserve existing discussion naming and prompt structure, with only the summary prompt gaining explicit collection/synthesis instructions.
- Keep server/web scope additive: richer run-update payloads are relayed compatibly, without requiring a new P2P UI redesign in this change.

## Capabilities

### New Capabilities
- `p2p-parallel-orchestration`: Parallelize per-round hop execution with per-hop temp files, orchestrator-managed main-file collection, and summary-driven round synthesis.
- `p2p-hop-status`: Expose explicit hop and round status transitions for daemon progress tracking and additive downstream relay.

### Modified Capabilities
- `timeline-events`: Extend discussion-related run updates with additive hop-progress and summary-phase fields so downstream consumers can observe parallel execution without breaking existing payload handling.

## Impact

- **Daemon**: `src/daemon/p2p-orchestrator.ts`, prompt construction, temp-file management, timeout/cancel flow, and tests.
- **Shared**: New shared P2P status/event contract for hop- and round-level states.
- **Server**: Relay richer P2P run-update payloads compatibly.
- **Web**: Existing consumers of P2P run updates remain compatible with additive fields; full new UI behavior is out of scope for this change.
