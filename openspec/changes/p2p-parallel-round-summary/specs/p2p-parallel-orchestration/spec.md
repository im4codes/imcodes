## ADDED Requirements

### Requirement: Round phase-2 hops run in parallel
The system SHALL dispatch all non-summary hops within the same round concurrently, while keeping the initiator kickoff and round summary sequential barriers.

#### Scenario: Parallel hop dispatch in one round
- **WHEN** a round has three target hops after the initiator kickoff
- **THEN** the orchestrator dispatches those three hops without awaiting each prior hop to complete

#### Scenario: Summary waits for round barrier
- **WHEN** one hop completes early and another hop is still running
- **THEN** the round summary SHALL NOT start until all hops in that round have reached a terminal hop state

### Requirement: Each hop uses a round-scoped temp file with stable naming
The system SHALL give each hop an isolated temporary discussion file for that round. Each hop temp file SHALL be named with the run id, round number, and hop index so multi-round execution and orphan cleanup remain unambiguous. A hop SHALL append its output only to its own temp file and SHALL NOT write directly to the main discussion file.

#### Scenario: Per-hop file isolation
- **WHEN** two hops in the same round are running concurrently
- **THEN** each hop writes only to its own temp file and neither hop writes directly to the main discussion file

#### Scenario: Multi-round file naming stays unique
- **WHEN** round 2 starts after round 1 has already produced hop files
- **THEN** round 2 hop files use different file names from round 1 hop files for the same hop index

### Requirement: Cross-project hops copy results back into round hop artifacts, not the main discussion file
For cross-project hops, the system SHALL copy the hop temp file into the target project only as a working artifact and SHALL copy the completed result back into the main project's round hop-file location. That main-project hop-file location SHALL use the same run-id / round / hop-index naming convention as same-project hop artifacts. Cross-project hops SHALL NOT copy their result directly into the main discussion file.

#### Scenario: Cross-project hop writes through project-local copy
- **WHEN** a hop runs in a different project context from the main discussion file
- **THEN** the target agent writes to its project-local copy of the hop file and the orchestrator copies that hop file back to the main project's hop artifact path after completion

### Requirement: The orchestrator appends hop-added content to the main discussion file
At the end of each round, the orchestrator SHALL extract the newly-added content from each hop temp file and append it to the main discussion file in hop order before the summary step runs.

The correctness priority for this phase is:
- completed-hop evidence SHALL NOT be silently omitted;
- bounded duplication is acceptable if needed to preserve content;
- implementations MAY use best-effort fallback extraction when a hop file does not preserve an append-only structure well enough for exact byte-offset slicing.

#### Scenario: Hop-added content uses round baseline offset
- **WHEN** the orchestrator creates round hop files from the current main discussion file
- **THEN** it records the main file size before copying and treats content after that byte offset in each hop file as that hop's new contribution

#### Scenario: Main file receives hop evidence before summary
- **WHEN** two hops produce different audit findings in the same round
- **THEN** the orchestrator appends both hops' newly-added content to the main discussion file before the summary step appends the round-summary section

#### Scenario: Append-phase recovery prefers retention over omission
- **WHEN** the orchestrator cannot prove an exact byte-offset extraction for a completed hop because the hop file was rewritten or structurally deviated
- **THEN** the orchestrator prefers retaining attributable hop content, even if that may introduce bounded duplication, and SHALL NOT silently drop the completed hop's contribution

### Requirement: The summary step appends the round-summary section after collection
After the orchestrator has appended the round's hop evidence to the main discussion file, the summary step SHALL read the updated discussion file and append a round-summary section. The summary step SHALL NOT be the component responsible for structural collection of hop file content into the main discussion file.

#### Scenario: Single-round discussion still collects and summarizes
- **WHEN** a discussion has only one round
- **THEN** the orchestrator first appends the round's hop evidence to the main file and the final summary step then appends the summary section

#### Scenario: Last round of multi-round discussion
- **WHEN** the orchestrator reaches the final round of a multi-round run
- **THEN** the final summary still runs after hop evidence collection for that round and appends the final round-summary section

### Requirement: Summary failure preserves the pre-summary collected main file state
If the summary step fails or times out after hop evidence collection, the main discussion file SHALL retain the hop evidence already appended for that round, and the run SHALL enter a terminal failure state without silently discarding collected evidence.

#### Scenario: Summary failure after evidence collection
- **WHEN** the orchestrator has appended hop evidence to the main file and the summary step then fails
- **THEN** the main discussion file still contains the collected hop evidence and the run records a summary failure terminal state

### Requirement: Temp files are best-effort cleaned after summary completion
The system SHALL attempt to delete round-scoped hop temp files after the summary step finishes successfully and SHALL tolerate cleanup failure without failing the run result.

#### Scenario: Successful cleanup
- **WHEN** a round summary completes successfully
- **THEN** the orchestrator schedules deletion of that round's hop temp files

#### Scenario: Cleanup failure does not fail run
- **WHEN** temp-file deletion fails after summary completion
- **THEN** the run remains completed and the cleanup failure is logged for later diagnosis

#### Scenario: Orphan cleanup is conservative
- **WHEN** the orchestrator scans for orphaned round hop files on a later run initialization
- **THEN** it only deletes files that are unambiguously stale according to implementation-defined age/ownership heuristics and SHALL avoid deleting fresh artifacts from an active or recently interrupted run
