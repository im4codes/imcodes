## Context

P2P discussions already support multi-round execution, but each hop is awaited serially. The current design uses a single shared context file that all hops append to, which is simple for a serial chain but becomes unsafe and hard to reason about once multiple hops run concurrently. The user wants the parallel version to preserve existing naming and prompt patterns, use an LLM-driven collection/synthesis step, and keep the main discussion file updated in place.

The key architectural constraint is that this is not a source-control merge system. The goal is to preserve multiple agents' viewpoints well enough that the summary step can synthesize them, not to perform perfect byte-for-byte file merging. The highest-value contract is clear hop/run state observability; minor formatting duplication is acceptable if the content remains attributable and summarizable.

## Goals / Non-Goals

**Goals:**
- Parallelize non-summary hops within each round.
- Keep the initiator kickoff and round summary as round barriers.
- Give each hop a dedicated temp file and reserve main-file writes for orchestrator collection plus summary append.
- Add explicit hop and round status contracts that can be relayed compatibly through shared types and existing consumers.
- Preserve the legacy top-level P2P progress projection through a daemon-owned compatibility layer.
- Preserve existing prompt naming and discussion heading conventions, with minimal prompt changes outside summary collection instructions.

**Non-Goals:**
- Building a perfect diff/merge engine for hop files.
- Rewriting existing P2P discussion UX beyond additive compatibility with richer run-update payloads.
- Changing the meaning of existing P2P modes or round prompt naming.
- Introducing a second long-lived persistence model for hop files beyond round-scoped temp artifacts.

## Decisions

### 1. Use per-hop temp files and keep the main discussion file single-writer during collection
Each phase-2 hop gets its own temp file for the round. That keeps concurrent writers off the main discussion file entirely. After the round barrier, the orchestrator collects the newly-added content from each hop file and appends it to the main discussion file. The summary step then reads the updated main file and appends its round summary section.

**Alternatives considered:**
- Direct concurrent writes to the main file: rejected because correctness depends on write interleaving behavior and makes attribution/debugging harder.
- Let the summary LLM perform all main-file structural writes: rejected because it weakens append-only guarantees, complicates retries, and reduces testability.

### 2. Identify hop-added content with a bounded byte-offset strategy
For each round, the orchestrator records the main discussion file size before creating hop temp files. Hop temp files are seeded from that main file snapshot. After each hop settles, the orchestrator treats content after the recorded byte offset as that hop's newly-added analysis.

The governing correctness rule is one-way:
- **missing completed-hop evidence is never acceptable**
- **minor duplication is acceptable**

If a hop file does not preserve the expected append-only structure well enough for exact byte-offset extraction, the implementation should prefer retaining attributable content over preserving perfect formatting or strict idempotency.

**Alternatives considered:**
- Heading-based parsing: workable, but more fragile if prompt formatting drifts.
- Whole-file concatenation: rejected because it reintroduces duplicated history into each round's summary input.

### 3. Treat summary as evidence collection + synthesis, not perfect reconstruction
The summary prompt reads the round's collected evidence and appends the round summary section. The system is allowed to preserve minor duplication or formatting noise as long as each hop's viewpoint remains attributable and summarizable.

**Alternatives considered:**
- Perfect diff/merge semantics with strict idempotency: useful but too heavy for the product goal.
- Blind concatenation of whole hop files: too likely to drown the summary in duplicated history.

### 4. Add explicit hop and run state contracts before wiring broader consumers
Parallel execution makes the old serial run status insufficient. The design therefore introduces explicit hop states and summary-phase run states first, then threads them through shared types, daemon orchestration, and additive downstream relay. This is the main guardrail against an implementation that “works” but is impossible to reason about in production.

The compatibility projection remains daemon-owned: the daemon serializer is responsible for emitting the legacy top-level `status`, phase, and progress fields expected by current consumers, while newer hop/run detail remains additive.

**Alternatives considered:**
- Keep only existing run-level status fields: rejected because parallel hops would be opaque.
- Emit only best-effort textual progress: rejected because it is not stable enough for tests or downstream compatibility.

### 5. Minimize prompt churn
The kickoff and hop prompts should keep existing naming and structure. Only the summary prompt gets a new instruction block telling the summary step to consider the round's collected hop findings and append the integrated round-summary section.

**Alternatives considered:**
- Rewriting every mode prompt around parallel execution: rejected because it creates unnecessary drift and retuning cost.

### 6. Keep server/web scope additive in this change
Most execution changes belong in the daemon orchestrator and shared contracts. Server relay and existing web consumers should remain compatible with richer run-update payloads, but this change does not require a new dedicated UI capability or full browser-side hop timeline redesign.

**Alternatives considered:**
- Expanding scope to fully redesign P2P UI progress handling: rejected as out of scope for this change.
- Keeping all new fields daemon-local: rejected because server/web still need additive compatibility.

## Risks / Trade-offs

- **[A hop's new analysis is partially missed]** → Mitigate by using a deterministic byte-offset baseline per round, testing divergent multi-hop outputs, and prioritizing content retention over perfect formatting.
- **[A hop rewrites or truncates its temp file instead of pure append]** → Mitigate by treating append-only structure as a best-effort expectation, preferring attributable content retention over strict exactness, and making missing completed-hop evidence a test failure.
- **[Parallel state transitions become hard to debug]** → Mitigate by defining hop/run status contracts up front and testing event ordering explicitly.
- **[Cross-project hops accidentally regain write access to the main file]** → Mitigate by making temp-file-only writes an explicit orchestration rule and copying cross-project hop artifacts back to the main project's hop-file location instead of the main discussion file.
- **[Temp files accumulate after crashes or cleanup failures]** → Mitigate by best-effort post-summary deletion plus orphan cleanup on later orchestrator startup or run initialization.
- **[Implementation drifts by copying dispatch logic]** → Mitigate by parameterizing `dispatchHop` instead of introducing a second near-duplicate control path.
- **[Richer payloads break downstream consumers]** → Mitigate by making new run-update fields additive and testing compatibility at the relay layer.

## Migration Plan

1. Define shared hop/run status constants and additive run-update payload shape.
2. Refactor daemon orchestration so `dispatchHop` accepts per-hop file/watch parameters without duplicating logic.
3. Add per-hop temp-file lifecycle, phase-2 parallel dispatch, and cross-project hop copy-back into round hop artifacts.
4. Add orchestrator-side evidence collection into the main discussion file and summary append flow.
5. Thread expanded run payloads through existing server relay and verify existing consumers remain compatible.
6. Land unit, integration, and event-order tests before enabling the new path by default.

Rollback is straightforward: switch orchestration back to the existing serial path and ignore hop temp files. The new shared status fields should remain additive so the serial path can still populate a compatible subset.

## Resolved Decisions

- Run updates SHALL expose both a compatibility-friendly top-level projection and a stable per-hop list for debugging/observers.
- Summary prompts do not need to restate failed/timed-out hop details verbatim; only completed-hop evidence is guaranteed to be collected into the main discussion file, while failed terminal states remain observable via run updates.
