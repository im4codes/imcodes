## 0. Spec Closure

- [x] 0.1 Align proposal, design, and specs on orchestrator-managed main-file collection versus summary-only round-summary append.
- [x] 0.2 Lock the hop-added-content extraction strategy and round/hop temp-file naming convention in the orchestration spec.
- [x] 0.3 Shrink server/web scope to additive run-update compatibility and remove any unsupported modified-capability claims.
- [x] 0.4 Expand the hop/run status spec to include the minimum state set and terminal-state summary semantics.
- [x] 0.5 Make the daemon serializer explicitly own the legacy compatibility projection for top-level run fields.
- [x] 0.6 Close the append/merge correctness rule: no missing completed-hop evidence, bounded duplication tolerated.
- [x] 0.7 Define `preparing`, legal top-level transitions, and the zero-completed-hops round outcome.

## 1. Shared Contracts

- [x] 1.1 Add shared hop/run status constants and types for parallel P2P discussion progress.
- [x] 1.2 Define the additive daemon→server/browser run-update payload shape for hop-level progress and summary-phase transitions.
- [x] 1.3 Update any existing P2P message/status helpers to import the shared constants instead of hardcoded strings.

## 2. Daemon Orchestration Core

- [x] 2.1 Refactor `src/daemon/p2p-orchestrator.ts` so `dispatchHop` accepts a per-hop output/watch path without duplicating orchestration logic.
- [x] 2.2 Add round-scoped hop temp-file creation and tracking, keyed by round and hop index.
- [x] 2.3 Replace serial phase-2 hop dispatch with `Promise.allSettled` while keeping initiator kickoff and summary as round barriers.
- [x] 2.4 Ensure cross-project hops write only to their own temp-file copies and copy completed hop artifacts back to the main project's hop-file location instead of the main discussion file.
- [x] 2.5 Add best-effort cleanup for hop temp files after successful summary completion and on later orphan-file discovery.

## 3. Evidence Collection and Summary Append

- [x] 3.1 Record each round's main-file baseline size before creating hop temp files.
- [x] 3.2 Append each completed hop's newly-added content into the main discussion file in hop order after the round barrier.
- [x] 3.3 Extend the summary prompt builder so every round summary reads the updated main discussion file and appends only the round-summary section.
- [x] 3.4 Ensure the final round summary uses the same collection-and-summary path as intermediate rounds.
- [x] 3.5 Preserve existing mode naming and prompt structure outside the new summary collection instruction block.

## 4. Hop and Run Status Reporting

- [x] 4.1 Add explicit hop lifecycle state tracking in the daemon orchestrator.
- [x] 4.2 Add run-level summary-phase states and round-barrier aggregation behavior.
- [x] 4.3 Emit daemon run updates that include hop terminal states, active summary phase, timeout/failure/cancel outcomes, and aggregated counts.
- [x] 4.4 Verify richer run updates remain additive and compatible through existing server relay and current consumers.

## 5. Unit Tests

- [x] 5.1 Add daemon unit tests for parallel phase-2 dispatch and round-barrier summary start conditions.
- [x] 5.2 Add daemon unit tests for hop temp-file tracking, naming, ordering, and cleanup behavior.
- [x] 5.3 Add daemon unit tests for evidence collection behavior, including single-round final summary coverage.
- [x] 5.4 Add daemon unit tests for hop/run state transitions, including success, timeout, failure, and cancel paths.
- [x] 5.5 Add daemon unit tests that allow minor duplication but fail on missing hop evidence or misattributed hop content.
- [x] 5.6 Verify compatibility projection tests preserve legacy top-level fields while richer hop/run detail remains additive.

## 6. Integration and Event Tests

- [x] 6.1 Add integration tests for a multi-hop parallel round where summary waits for all hops to settle.
- [x] 6.2 Add integration tests for partial-failure rounds where successful hop outputs still reach the main discussion file and summary.
- [x] 6.3 Add integration tests for cross-project hops using isolated temp files and hop-artifact copy-back into the main project.
- [x] 6.4 Add relay-facing tests that verify additive hop-level run updates and summary-phase transitions remain observable without breaking existing consumers.
- [x] 6.5 Run full daemon/server/web typechecks and the relevant P2P test suites after the implementation lands.
