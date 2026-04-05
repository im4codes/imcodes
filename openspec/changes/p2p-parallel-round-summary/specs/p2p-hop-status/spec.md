## ADDED Requirements

### Requirement: Each hop has a defined lifecycle state set
The system SHALL track each hop independently using the lifecycle states `queued`, `dispatched`, `running`, `completed`, `timed_out`, `failed`, and `cancelled`.

#### Scenario: Successful hop lifecycle
- **WHEN** a hop is accepted, dispatched, runs, and finishes normally
- **THEN** that hop transitions through defined lifecycle states ending in `completed`

#### Scenario: Timed-out hop lifecycle
- **WHEN** a hop exceeds its timeout budget
- **THEN** that hop transitions to `timed_out` and does not block other hops in the same round

#### Scenario: Failed hop lifecycle
- **WHEN** dispatch or execution fails for one hop
- **THEN** that hop transitions to `failed` while other hops in the same round continue toward the barrier

#### Scenario: Cancelled hop lifecycle
- **WHEN** the overall run is cancelled before a hop has completed
- **THEN** that hop transitions to `cancelled`

### Requirement: Run-level state distinguishes round execution from summary execution
The system SHALL expose run-level states that distinguish round execution from summary execution. At minimum, the run SHALL represent preparing, round execution, summarizing, completed, failed, and cancelled outcomes.

`preparing` SHALL mean the run has been created and is performing run-start or round-start setup before the first dispatch of that execution window. It SHALL exit when the initiator kickoff begins for round 1, or when a later round begins dispatch preparation if the implementation chooses to expose per-round preparation.

#### Scenario: Entering summary phase
- **WHEN** all hops in a round have reached terminal hop states
- **THEN** the run enters a summary-specific state before the summary step starts appending the round-summary section

#### Scenario: Summary completion advances run
- **WHEN** the summary step finishes for a non-final round
- **THEN** the run transitions back into round execution for the next round instead of directly completing

#### Scenario: Run-level transitions stay within the defined state machine
- **WHEN** a run changes top-level state
- **THEN** it only transitions along legal paths: `preparing -> round execution`, `round execution -> summarizing`, `round execution -> failed`, `round execution -> cancelled`, `summarizing -> round execution`, `summarizing -> completed`, `summarizing -> failed`, or `summarizing -> cancelled`

### Requirement: Hop terminal states have defined summary semantics
Only `completed` hops SHALL contribute collected evidence to the main discussion file. `timed_out`, `failed`, and `cancelled` hops SHALL remain observable in run updates but SHALL NOT be treated as successful evidence sources for that round.

#### Scenario: Partial failure still permits summary
- **WHEN** one hop fails or times out but other hops in the round complete
- **THEN** the run update reflects the non-completed hop terminal state and the summary phase may still start using only the completed hop evidence

#### Scenario: Zero completed hops still has defined behavior
- **WHEN** every hop in a round reaches `timed_out`, `failed`, or `cancelled` and zero hops complete
- **THEN** the run still enters the summary phase for that round, the main discussion file receives no completed-hop evidence for that round, and the summary step appends a summary section based on the empty-evidence outcome instead of silently skipping the round

### Requirement: Hop and run updates are relayed compatibly to observers
The daemon SHALL emit run updates that include hop-level status progress and summary-phase transitions as additive fields, and downstream relay behavior SHALL preserve compatibility for consumers that do not understand the new fields. The daemon serializer SHALL own this compatibility projection.

#### Scenario: Browser receives hop progress
- **WHEN** a hop transitions from running to completed
- **THEN** connected observers receive a run update that reflects that hop's new terminal state

#### Scenario: Additive compatibility for older consumers
- **WHEN** a downstream consumer reads a richer run-update payload but ignores hop-level fields
- **THEN** the existing run-update handling still succeeds without requiring new mandatory fields

#### Scenario: Legacy skipped compatibility is preserved
- **WHEN** a hop ends in any non-completed terminal state
- **THEN** the richer hop-level payload records the specific terminal state, and any legacy skip-oriented compatibility field remains an aggregate backward-compatible projection rather than a replacement for the detailed hop state

### Requirement: Cancellation preserves completed hop outcomes
The system SHALL preserve completed hop outcomes even when the overall run is cancelled.

#### Scenario: Cancel during phase-2 execution
- **WHEN** the user cancels a run while some hops have already completed and others are still running
- **THEN** completed hops remain marked completed, unfinished hops transition to cancelled, and no new summary phase starts
