## MODIFIED Requirements

### Requirement: Transport dispatch SHALL bound memory-context pre-dispatch work and fail open
Transport-runtime sends SHALL treat live context bootstrap, per-message semantic memory recall, feature-flag reads, MD ingest, skill loading, quick-search/citation lookup, telemetry enqueue/sink work, classification, and skill-review scheduling as best-effort asynchronous or bounded enrichment. Ordinary non-P2P `session.send` ack is a daemon-receipt acknowledgement, not proof that memory recall succeeded or that the provider has started or completed the turn. Once the daemon validates ownership of a non-duplicate commandId, it MUST emit `command.ack accepted` before the first asynchronous delivery boundary in the send handler.

The daemon MUST NOT wait for P2P preference reads, pending session relaunches, per-session transport locks, live context bootstrap, semantic recall, embedding generation, candidate scoring, feature-flag polling, MD ingest, skill loading, quick-search/citation lookup, telemetry sinks, skill review, provider send-start, provider settlement, or any background memory work before acking an accepted ordinary send. Downstream recall/bootstrap/enrichment success, failure, or timeout MUST NOT affect ack timing; the message MUST still be dispatched to the SDK/provider with memory context when available and without failed memory payloads otherwise. Daemon-handled controls whose ack intentionally reports command validation/result (`/model`, `/thinking`/`/effort`, `/clear`) MAY keep result/error ack semantics. `/compact` is not daemon-handled and MUST use the ordinary immediate-receipt ack plus SDK-forwarding path.

Transport `/stop` and transport approval/feedback responses are priority-lane commands. `/stop` MUST emit receipt ack and clear queued resend work before P2P preference reads, pending relaunch waits, per-session send locks, context bootstrap, recall, embedding, provider cancel awaits, telemetry, or memory work. Provider cancellation MUST run in the background and surface failures via timeline/session state. Transport approval/feedback responses, including `transport.approval_response`, MUST be forwarded directly to the live runtime and MUST NOT be serialized behind normal send, relaunch, context, recall, telemetry, or memory work.

#### Scenario: ordinary send ack is not delayed by post-1.1 memory features
- **WHEN** the daemon receives an ordinary non-P2P `session.send` with a fresh commandId
- **AND** post-1.1 features such as feature flags, MD ingest, skill loading, quick search, citation lookup, telemetry, classification, or skill review are slow, disabled, or failing
- **THEN** the daemon MUST emit `command.ack accepted` immediately after accepting command ownership and before the first async delivery boundary
- **AND** provider dispatch MUST still proceed later with available context or without failed context

#### Scenario: stop and feedback remain priority-lane controls
- **WHEN** a transport session has a held send-control lock, pending relaunch, slow memory work, or pending provider send-start
- **AND** the user sends `/stop` or responds to an approval/feedback request
- **THEN** `/stop` MUST emit `command.ack accepted` and invoke provider cancellation without waiting for those blockers
- **AND** approval/feedback MUST reach the runtime approval handler without waiting for those blockers
- **AND** neither path MAY run memory recall, context bootstrap, feature reads, telemetry sinks, or skill work before reaching the transport runtime

### Requirement: Manual `/compact` SHALL remain SDK-native pass-through
The daemon SHALL forward the literal `/compact` command unchanged through the normal transport send path for transport-runtime sessions. The daemon MUST NOT intercept `/compact` to replay history, call daemon compression/materialization helpers, relaunch the transport conversation, synthesize a compacted summary, emit a daemon-owned `compaction.result` event, or implement topic-focused daemon compaction in this milestone. If manual compaction appears broken, the implementation SHALL debug transport forwarding, SDK session state, provider health, lifecycle/admission races, or provider-side compact behavior rather than replacing SDK-native behavior.

All transport providers SHALL receive slash control commands as raw provider-control payloads, not as memory-enriched user prompts. For such controls the transport runtime MUST skip daemon-added startup memory, per-turn recall, preference context preambles, authored context selection, and extra per-turn system prompt. This applies uniformly to Codex SDK, Claude Code SDK, Gemini ACP, Qwen, Cursor headless, Copilot SDK, OpenClaw, and future transport providers; provider-specific adapters may then translate the raw token to a native control API when one exists.

SDK/provider adapters that expose a native compact RPC SHALL treat the send as accepted only after the native request is accepted, and SHALL then settle the transport runtime from native compact completion signals. The adapter MUST accept known upstream notification shape drift (for example `threadId`/`turnId` and `thread_id`/`turn_id`), MUST not leave the session busy when a native compact request is accepted but emits no asynchronous completion signal, and MUST fail with a bounded retryable provider error if an active compact never completes.

#### Scenario: `/compact` is forwarded unchanged in post-1.1 builds
- **WHEN** a user sends `/compact` to a transport-runtime session
- **THEN** the active transport runtime MUST receive the exact string `/compact`
- **AND** daemon memory compression, materialization, topic selection, and summarization helpers MUST NOT be invoked for that command
- **AND** no provider-visible startup memory, recall block, preference block, authored-context block, or extra per-turn system prompt MAY be attached to the slash-control payload
- **AND** no daemon-owned compaction result event MUST be emitted
- **AND** a Codex SDK transport MUST call `thread/compact/start` for the active thread and later clear runtime busy state on `thread/compacted`, `contextCompaction` item completion, `turn/completed`, status-idle, or the bounded accepted/no-signal fallback

### Requirement: Startup and recall memory rendering SHALL use explicit typed payloads and safe degradation
Transport startup memory and per-message recall SHALL preserve the existing fail-open dispatch behavior while using typed post-1.1 render payloads. Startup selection SHALL assemble memory through collect, prioritize, quota, trim, deduplicate, and render stages. Rendered items MUST carry explicit render kind (`summary`, `preference`, `note`, `skill`, `pinned`, or `citation_preview`) and MUST honor authorization and per-kind truncation before injection.

Any stage failure for non-required memory sources MUST omit that source, emit bounded telemetry, and continue user delivery. Required authored context remains governed by the existing required-authored-context dispatch contract; advisory memory and post-1.1 enrichment MUST NOT block ordinary send ack.

#### Scenario: startup stage failure degrades without blocking send ack
- **WHEN** one startup memory source, render stage, skill load, preference load, or citation preview fails
- **THEN** ordinary send ack MUST remain daemon receipt
- **AND** provider dispatch MUST continue with the remaining authorized context
- **AND** the failed source MUST be omitted rather than injecting raw or unauthorized data

### Requirement: Citation-aware recall SHALL preserve authorization and replay-safe identity
Quick search, citation preview, citation insertion, drift metadata, and cite-count ranking MUST run after shared scope filtering. Citation insertion SHALL use projection identity, authoritative citing-message identity, and store-derived idempotency keys. Missing, unauthorized, and disabled source/projection lookups MUST return the same external response envelope wherever object existence could otherwise leak. Cite-count ranking, when enabled, MUST use bounded count signal only after scope filtering and MUST NOT reveal or increment counts for missing or unauthorized citation attempts.

#### Scenario: inaccessible citation lookup does not leak inventory
- **WHEN** a caller requests a missing, unauthorized, or feature-disabled projection/source id
- **THEN** the response shape MUST be the same for all cases that would otherwise reveal existence
- **AND** it MUST NOT include raw source text, role diagnostics, source counts, hit counts, drift markers, cross-scope ids, or cite-count state

#### Scenario: citation replay cannot inflate ranking count
- **WHEN** an authorized citation insertion is retried or replayed for the same citing message and projection
- **THEN** the authoritative idempotency key MUST dedupe the write
- **AND** cite count MUST increment at most once for that idempotency key
- **AND** ranking MUST consume cite count only after authorization filtering
