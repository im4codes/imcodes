## ADDED Requirements

### Requirement: POST11-R1 Foundations liveness invariants MUST remain hard gates
Post-foundations memory features MUST NOT change daemon receipt semantics for ordinary sends or urgent controls. Ordinary `session.send` ack MUST remain daemon receipt for accepted non-duplicate sends and MUST be emitted before memory work, relaunch waits, transport locks, bootstrap, recall, embedding, provider send-start, provider settlement, telemetry sinks, MD ingest, skill load, quick-search/citation lookup, feature-flag polling, or skill review completes. `/compact` MUST remain SDK-native pass-through. `/stop` and approval/feedback controls MUST remain priority-lane controls.

- **State variables:** command id ownership, duplicate-command status, ack status, transport lock state, relaunch state, bootstrap/recall/embedding/provider state, priority-control lane.
- **Failure modes:** pending relaunch, held transport lock, bootstrap hang, recall/embedding failure, provider send-start never settles, feature-flag read failure, telemetry timeout, duplicate command id.
- **Implemented by tasks:** 1.1, 1.6, 1.7, 8.1-8.8, 16.1-16.4.
- **Test anchors:** `server/test/ack-reliability.test.ts`, `test/ack-reliability-e2e.test.ts`, `test/daemon/command-handler-transport-queue.test.ts`, `test/daemon/transport-session-runtime.test.ts`, `test/agent/runtime-context-bootstrap.test.ts`, `test/agent/codex-sdk-provider.test.ts`, `test/daemon/transport-relay.test.ts`, `web/test/use-timeline-optimistic.test.ts`.

#### Scenario: accepted ordinary send enters asynchronous memory work
- **WHEN** a normal user send has a non-duplicate command id accepted by the daemon
- **THEN** the daemon MUST emit a success receipt ack before feature-flag reads, named-stage startup selection, MD ingest, skill loading, quick-search/citation lookup, recall, embedding, bootstrap, telemetry, provider send-start, provider settlement, or skill review
- **AND** the success receipt ack MAY be `accepted` or `accepted_legacy` according to the existing client/command-id path
- **AND** duplicate non-retry command ids MAY emit the existing duplicate/error ack instead of success

#### Scenario: downstream memory work fails after ack
- **WHEN** recall, bootstrap, embedding, MD ingest, skill load, search, citation lookup, classification, or skill review fails or times out after daemon receipt
- **THEN** the original user message MUST still be dispatched to the SDK/provider
- **AND** failed memory context MUST be omitted from the payload instead of blocking or spinning the send
- **AND** the failure MUST be reported through bounded telemetry/status where applicable

#### Scenario: send is received while relaunch or transport lock is pending
- **WHEN** a normal send arrives while session relaunch, transport lock, bootstrap, or provider start is pending
- **THEN** daemon receipt ack MUST be emitted before waiting for that downstream condition
- **AND** later SDK/provider delivery MAY proceed after the condition clears or degrades

#### Scenario: compact and urgent controls keep foundations behavior
- **WHEN** the user sends `/compact`
- **THEN** the daemon MUST forward it through the ordinary send path to the SDK/provider without daemon-side synthetic compaction or interception
- **AND** the transport runtime MUST treat slash controls as provider-control payloads for every transport provider, suppressing daemon-added startup memory, per-turn recall, preference preambles, authored context, and extra per-turn system prompt so the provider receives the raw control token
- **AND** provider adapters with a native compact API, such as Codex app-server `thread/compact/start`, MUST translate the raw `/compact` token at the SDK boundary and MUST NOT send `/compact` as ordinary model text
- **AND** the provider adapter MUST settle the transport runtime from native compact lifecycle signals (`thread/compacted`, `contextCompaction` item completion, turn completion, or equivalent thread-status idle), accepting both camelCase and snake_case thread/turn identifiers when the upstream SDK shape varies
- **AND** an accepted native compact request that produces no asynchronous completion signal MUST resolve through a bounded no-op/accepted fallback, while a compact request or active compaction that exceeds the hard timeout MUST clear the busy state and emit a retryable provider error instead of leaving the UI in `Agent working...`
- **AND** receipt ack timing MUST remain daemon receipt
- **WHEN** the user sends `/stop` or an approval/feedback response
- **THEN** the command MUST use the priority path and MUST NOT wait behind normal send locks, memory work, relaunch, provider cancel completion, or telemetry

#### Scenario: SDK tool-side sender identity is a runtime guarantee
- **WHEN** a local SDK transport session is created with daemon-provided IM.codes session environment
- **THEN** the SDK provider integration MUST preserve `IMCODES_SESSION` and `IMCODES_SESSION_LABEL` as runtime/tool-side inputs or an equivalent non-prompt adapter
- **AND** prompt text alone MUST NOT be the only mechanism for `imcodes send` sender/reply identity

#### Scenario: Codex SDK ctx usage is current-window and model-stable
- **WHEN** Codex app-server emits `thread/tokenUsage/updated` with both `last` and `total` token usage
- **THEN** the IM.codes ctx meter MUST represent the current live prompt/window from `tokenUsage.last.inputTokens`, falling back to `tokenUsage.total.inputTokens` only for older payloads that omit `last`
- **AND** cumulative `tokenUsage.total` values MAY be retained only as diagnostics and MUST NOT drive the visible ctx percentage when `last` is present
- **AND** because Codex/OpenAI `cachedInputTokens` is a subset of `inputTokens`, the timeline MUST normalize it as `inputTokens - cachedInputTokens` plus `cacheTokens`, so the visible total still equals the selected current-window input token count
- **AND** the provider-reported `modelContextWindow`, when present, MUST be propagated as the timeline context-window value with a provider-source marker unless it is a known stale/mismatched provider fallback for the selected model
- **AND** if a usage event omits `model`, the daemon MUST resolve the effective model from the persisted session metadata (`activeModel`, `requestedModel`, `modelDisplay`, or provider-specific stored model) before resolving the context window or forwarding usage to Web
- **AND** GPT-5.5 MUST resolve to the locked 922k model window for ctx display even when Codex SDK/native Codex reports stale fallback windows such as 258400 or 1000000
- **AND** Web context UI MUST prefer a provider-marked explicit context window over model-family inference, while known stale/mismatched provider values and older unmarked/stale explicit context-window values MAY still be overridden by model-family inference

### Requirement: POST11-R2 Stable memory fingerprints MUST be deterministic, kind-aware, and scope-safe
The system MUST compute stable fingerprints for post-foundations memory content using one shared implementation. Fingerprints MUST be deterministic across daemon SQLite and server PostgreSQL contexts and MUST NOT deduplicate across namespace/scope boundaries.

- **State variables:** fingerprint kind, fingerprint version, normalized content, scope key, namespace, source ids.
- **Failure modes:** missing fingerprint, legacy helper misuse, normalization mismatch, cross-scope merge, backfill interruption.
- **Implemented by tasks:** 2.1-2.7.
- **Test anchors:** `test/context/memory-fingerprint-v1.test.ts`, `test/fixtures/fingerprint-v1/**`, daemon/server fixture parity tests.

#### Scenario: equivalent scoped content is fingerprinted
- **WHEN** two memory entries of the same fingerprint kind normalize to the same content within the same namespace/scope
- **THEN** they MUST compute the same `v1` fingerprint through `computeMemoryFingerprint({ kind, content, scopeKey, version: 'v1' })`
- **AND** deduplication MAY merge them while preserving all source ids

#### Scenario: identical content is in different scopes
- **WHEN** two entries have identical normalized content but different scopes or namespaces
- **THEN** they MUST NOT be merged into one logical memory
- **AND** citation, hit, drift, and ranking signals MUST remain scope-local

#### Scenario: fingerprint backfill runs
- **WHEN** existing rows lack fingerprints
- **THEN** lazy backfill MUST NOT block daemon startup or ordinary send ack
- **AND** eager backfill, if provided, MUST run in bounded restartable batches

### Requirement: POST11-R3 Origin metadata MUST be explicit and closed for the current milestone
Every post-foundations projection, preference, pinned note mirror, MD import, skill import, and self-learning output MUST carry explicit origin metadata from the shared `MEMORY_ORIGINS` enum: `chat_compacted`, `user_note`, `skill_import`, `manual_pin`, `agent_learned`, and `md_ingest`. `quick_search_cache` and other cache origins are reserved and MUST NOT be emitted in this milestone. New origin values require a later OpenSpec delta and migration.

- **State variables:** origin, scope, writer kind, migration boundary, feature flag.
- **Failure modes:** missing origin, invalid origin, fallback default outside migration, cache origin emitted without cache contract, origin used to bypass authorization.
- **Implemented by tasks:** 3.1-3.6.
- **Test anchors:** origin migration/write tests, search/UI origin tests, reserved-origin rejection tests.

#### Scenario: a new memory row is written
- **WHEN** post-foundations code writes or updates a projection, preference, pinned note mirror, MD import, skill import, or self-learning output
- **THEN** it MUST set origin metadata explicitly
- **AND** missing or invalid origin MUST be rejected outside a documented migration/backfill boundary

#### Scenario: origin is used for UI, pruning, or feature flags
- **WHEN** memory is rendered, searched, pruned, or controlled by a feature flag
- **THEN** origin metadata MUST be available without parsing free-form summary text
- **AND** origin MUST NOT override scope authorization

### Requirement: POST11-R4 Feature flags MUST fail closed and stop new background work when disabled
Every new post-foundations feature MUST have a concrete feature flag or kill switch before it can be enabled. Disabled features MUST return pre-feature behavior, enqueue no new background work, and perform no persistent writes for that feature. Runtime disablement MUST stop new work within the documented propagation target. The current registry MUST include `mem.feature.scope_registry_extensions`, `mem.feature.user_private_sync`, `mem.feature.self_learning`, `mem.feature.namespace_registry`, `mem.feature.observation_store`, `mem.feature.quick_search`, `mem.feature.citation`, `mem.feature.cite_count`, `mem.feature.cite_drift_badge`, `mem.feature.md_ingest`, `mem.feature.preferences`, `mem.feature.skills`, `mem.feature.skill_auto_creation`, and `mem.feature.org_shared_authored_standards`.

- **State variables:** flag name, default, source of truth, dependency, propagation state, observer components, in-flight job state.
- **Failure modes:** flag read failure, missing registry entry, partial disablement, dependency enabled while parent disabled, UI disabled while workers run, server disabled while daemon writes, stale config.
- **Implemented by tasks:** 4.1-4.10.
- **Test anchors:** `test/context/memory-feature-flags.test.ts`, server/web feature-disable tests, dependency/default coverage tests.

#### Scenario: a feature is disabled
- **WHEN** a disabled feature path is invoked
- **THEN** it MUST skip new reads, writes, RPCs, and background jobs for that feature
- **AND** it MUST preserve previous user-visible behavior or the documented same-shape disabled envelope
- **AND** ordinary send ack MUST still follow POST11-R1 timing

#### Scenario: runtime kill switch changes
- **WHEN** an operator disables a memory feature at runtime
- **THEN** new work for that feature MUST stop within the documented propagation target
- **AND** in-flight work MAY finish only if it cannot corrupt state, block shutdown/upgrade, or leak data
- **AND** flag read failure MUST fail closed for new features

#### Scenario: operator changes a daemon memory feature from the management UI
- **WHEN** the management UI sends a shared `memory.features.set` request for a closed registry flag
- **THEN** the daemon MUST require a server-derived or local-daemon management context before mutating config
- **AND** it MUST persist the requested override above environment startup defaults
- **AND** enabling a feature from this operator surface MUST also request-enable its dependency closure so the action can produce an effective enabled state when prerequisites are available
- **AND** the daemon MUST return the recomputed requested/effective records, value source, dependencies, blocked dependencies, and disabled behavior in a shared response
- **AND** invalid flags, malformed payloads, and config-write failures MUST fail closed with shared error codes and without changing feature state

#### Scenario: dependent flag is enabled without its parent or prerequisite
- **WHEN** a dependent flag such as `mem.feature.cite_count`, `mem.feature.user_private_sync`, `mem.feature.skill_auto_creation`, or `mem.feature.org_shared_authored_standards` is enabled while its required parent flag is disabled or required registry/migration prerequisite is unavailable
- **THEN** the dependent feature MUST remain effectively disabled
- **AND** the system MUST emit bounded telemetry rather than partially running the dependent feature

### Requirement: POST11-R5 Telemetry MUST be asynchronous, bounded, and low-cardinality
Post-foundations metrics and audit events MUST be emitted through a bounded asynchronous path. Telemetry sink failure MUST NOT block sends, memory reads, materialization, skill loading, MD ingest, search, citation, skill review, or shutdown. Counter names and labels MUST use shared closed enums.

- **State variables:** telemetry buffer size, counter name, labels, sink state, sampling state.
- **Failure modes:** sink timeout, sink rejection, buffer overflow, unbounded label cardinality, secret/raw-content logging.
- **Implemented by tasks:** 5.1-5.6.
- **Test anchors:** telemetry sink timeout/reject tests, memory counter registry tests.

#### Scenario: telemetry sink is unavailable
- **WHEN** the telemetry sink rejects, times out, or is unreachable
- **THEN** memory feature behavior MUST continue according to normal success/failure semantics
- **AND** high-frequency metric labels MUST NOT include unbounded identifiers, user content, file paths, session ids, project ids, user ids, or secrets

#### Scenario: soft failure is swallowed intentionally
- **WHEN** a memory path degrades by returning empty/no-op instead of throwing
- **THEN** it MUST emit a rate-limited structured warning and a bounded counter from `MEMORY_COUNTERS`
- **AND** the warning MUST avoid secrets or raw private content

### Requirement: POST11-R6 Startup context MUST use named-stage selection and a total budget
Startup memory assembly MUST be staged as collect, prioritize, apply quotas, trim to total budget, deduplicate, and render. The total rendered startup memory payload MUST stay under the configured token budget defined in `design.md` defaults unless changed by a later OpenSpec delta.

- **State variables:** total budget, per-kind cap, trim priority, stage outputs, render kind, telemetry.
- **Failure modes:** over-budget payload, stage failure, render failure, duplicate content, unbounded project docs/skills.
- **Implemented by tasks:** 6.1-6.6.
- **Test anchors:** `test/context/startup-memory.test.ts`, startup over-budget fixture tests, `test/spec/design-defaults-coverage.test.ts`.

#### Scenario: startup candidates exceed the budget
- **WHEN** collected startup memory exceeds the total budget
- **THEN** the system MUST trim using configured trim priority and per-kind caps
- **AND** final rendered output MUST be at or below the total budget
- **AND** pinned content MUST receive the highest preservation priority

#### Scenario: a selection stage fails
- **WHEN** a collect, prioritize, dedup, or render stage fails for a non-critical source
- **THEN** startup assembly MUST degrade by omitting that source and recording telemetry
- **AND** ordinary send ack MUST NOT wait for recovery

### Requirement: POST11-R7 Render policy MUST type memory before context injection
Every memory item injected into startup or provider context MUST be rendered through an explicit render kind such as `summary`, `preference`, `note`, `skill`, `pinned`, or `citation_preview`. Render policy MUST enforce per-kind truncation, delimiter, authorization, and safety rules.

- **State variables:** render kind, source authorization, envelope, length cap, delimiter collision state.
- **Failure modes:** ad-hoc formatting, skill as system instruction, unauthorized raw source preview, delimiter collision.
- **Implemented by tasks:** 7.1-7.5.
- **Test anchors:** render policy tests, `test/context/skill-envelope.test.ts`.

#### Scenario: skill content is rendered
- **WHEN** a skill is selected for context injection
- **THEN** it MUST be wrapped by `SKILL_ENVELOPE_OPEN` and `SKILL_ENVELOPE_CLOSE`
- **AND** it MUST respect `SKILL_MAX_BYTES`
- **AND** delimiter collisions MUST be rejected or escaped according to `SKILL_ENVELOPE_COLLISION_PATTERN`
- **AND** skill content MUST NOT be rendered as a system instruction outside the skill envelope

#### Scenario: citation preview is rendered
- **WHEN** citation preview content is rendered
- **THEN** it MUST pass source authorization first
- **AND** unauthorized raw source content MUST NOT be present in the preview

### Requirement: POST11-R8 Self-learning memory MUST be scope-bound and fail open for delivery
Classification, dedup-decision, durable-signal extraction, and cold/warm/resumed startup-state tagging MUST operate within the source namespace/scope. Failure in self-learning phases MUST NOT block ordinary send, urgent controls, materialization retry safety, or source provenance.

- **State variables:** classifier output, dedup decision, source ids, origin, fingerprint, scope, retry state, startup state tag.
- **Failure modes:** classifier timeout, dedup error, cross-scope merge, local-fallback pollution, retry storm.
- **Implemented by tasks:** 9.1-9.6.
- **Test anchors:** classification/dedup tests, materialization repair tests.

#### Scenario: classification succeeds
- **WHEN** a materialized summary is classified
- **THEN** classifier output MUST be stored with provenance, origin `agent_learned` where applicable, fingerprint, namespace, and scope
- **AND** dedup decisions MUST preserve all source event ids

#### Scenario: classification fails
- **WHEN** classification, dedup-decision, or durable extraction fails
- **THEN** original user message delivery MUST continue
- **AND** the system MUST NOT persist local-fallback/raw-transcript pollution as active memory
- **AND** retry/backoff MUST remain bounded

### Requirement: POST11-R9 Quick search MUST be authorized, scoped, and side-channel resistant
Quick search, palette search, and fast-path memory reads MUST use shared scope filtering and render-policy-safe previews. Missing, unauthorized, and disabled-feature projection/source lookups MUST return the same external response envelope where object existence could otherwise leak and MUST NOT leak existence through status shape, role diagnostics, counts, drift metadata, timing-dependent alternate shapes, or raw source fields.

- **State variables:** caller scope, authorized scope set, search query, projection id, source id, response envelope, feature flag state.
- **Failure modes:** bespoke SQL scope bug, 403 role detail leak, count leak, drift leak, raw source leak, timing-dependent alternate shape, disabled-feature shape leak.
- **Implemented by tasks:** 10.1-10.8, 1.8 security matrix.
- **Test anchors:** `server/test/memory-search-auth.test.ts`, `test/context/memory-search-semantic.test.ts`, web quick-search tests.

#### Scenario: user searches memory
- **WHEN** a caller invokes quick search
- **THEN** results MUST be restricted to the caller's authorized namespace/scope
- **AND** result previews MUST be rendered through approved render policy
- **AND** raw source content MUST NOT be returned through search results

#### Scenario: caller requests inaccessible source
- **WHEN** a caller requests a missing, unauthorized, or feature-disabled projection/source id
- **THEN** the response MUST use the documented same-shape not-found/disabled envelope for all cases that would otherwise reveal object existence
- **AND** the response MUST NOT include role diagnostics, source counts, hit counts, drift markers, raw source content, or cross-scope identifiers

### Requirement: POST11-R10 Citations MUST use projection identity, explicit drift semantics, and replay-safe cite-count
Citation insertion MUST use projection identity for the current wave. Each citation insertion MUST create a new citation record with its own `created_at` and authoritative idempotency key. Citation display MUST indicate drift using a content-stable projection marker, without exposing unauthorized source rows. Cite-count storage, idempotent incrementing, authorized ranking use, replay protection, migration/backfill, and tests are in current Wave 3 scope.

- **State variables:** projection id, cite id, cite created_at, projection content marker, authorization state, drift flag, cite_count, citation idempotency key, citing message id, replay state.
- **Failure modes:** raw source snapshot, per-projection cite reuse, no-op update drift false positive, unauthorized drift/source leak, cite-count replay inflation, cross-scope count leak, repeated composer replay, missing citing message identity, hot-row contention.
- **Implemented by tasks:** 10.3-10.14.
- **Test anchors:** `test/context/memory-citation-drift.test.ts`, `test/context/memory-cite-count.test.ts`, web citation tests, source-lookup auth tests.

#### Scenario: citation is inserted
- **WHEN** the user inserts a memory citation from authorized search results
- **THEN** the citation MUST store projection identity and a new citation `created_at` timestamp for that insertion
- **AND** it MUST NOT snapshot raw source content in the current wave
- **AND** it MUST include an authoritative idempotency key so composer retries, websocket replays, or timeline replays do not inflate cite counts
- **AND** the implementation MUST NOT trust a client-supplied citation idempotency key

#### Scenario: cited projection content changes
- **WHEN** a cited projection's normalized content changes after citation creation
- **THEN** drift MUST evaluate using canonical persistent `content_hash` captured at citation time and stored/recomputed from current normalized projection content
- **AND** daemon/server projection writes MUST persist `content_hash`, and routine maintenance writes or idempotent upserts that do not change normalized content MUST NOT change `content_hash` or create false drift
- **AND** the drift indicator MUST NOT bypass source authorization

#### Scenario: cite-count ranking signal is updated
- **WHEN** an authorized citation insertion is accepted exactly once for an idempotency key
- **THEN** the cited projection's `cite_count` MUST increment at most once for that idempotency key
- **AND** the same citing message replay MUST dedupe while a different citing message citing the same authorized projection MUST increment once for that different message
- **AND** the count MUST remain scoped to the authorized projection namespace/scope
- **AND** quick-search ranking MUST include a bounded `cite_count` signal when `mem.feature.cite_count=true`, only after scope filtering, and without replacing existing semantic score or `hitCount` behavior
- **AND** missing or unauthorized citation attempts MUST NOT reveal or increment counts

#### Scenario: citation identity cannot be derived
- **WHEN** the system cannot derive a stable authoritative citing message identity
- **THEN** cite-count increment MUST fail closed for that citation attempt without blocking send ack or citation display
- **AND** implementation MUST emit bounded telemetry and preserve replay safety

### Requirement: POST11-R11 Markdown ingest MUST be bounded, idempotent, and origin-aware
Markdown memory/preference ingest MUST run only from trusted triggers, enforce resource bounds, compute stable fingerprints, and store origin metadata. It MUST NOT silently promote or downgrade project content to cross-project, `user_private`, `workspace_shared`, `org_shared`, or enterprise-wide authored standards. Filesystem markdown is project-bound: unsupported `user_private`, workspace, and org bootstrap namespaces MUST fail closed without writing and MUST emit a bounded scope-dropped counter; authorized workspace/org standards must use the authored-context binding flow, not filesystem markdown scope promotion.

- **State variables:** trigger kind, path, size, section count, per-section byte cap, parser budget, origin, fingerprint, provenance fingerprint, partial commit state.
- **Failure modes:** oversized file, unreadable file, disallowed symlink, invalid encoding, malformed section, prompt-injection-like section, partial write failure.
- **Implemented by tasks:** 11.1-11.7, 11.13.
- **Test anchors:** MD ingest tests, startup budget compatibility tests.

#### Scenario: markdown file is ingested
- **WHEN** session start or manual sync triggers MD ingest
- **THEN** the parser MUST enforce size, section-count, per-section byte, and time bounds from the design defaults
- **AND** stored rows MUST be idempotent by stable fingerprint and origin `md_ingest`, through a production worker wired to session bootstrap/manual sync without entering ordinary send ack
- **AND** each accepted markdown section MUST update the projection/search/startup surface and the linked typed observation in the same write path or a repairable outbox path
- **AND** projection and observation idempotency MUST preserve per-file provenance: identical section text in two different supported files MUST NOT overwrite the other file's `path` or source ids
- **AND** malformed sections MUST NOT corrupt valid already-written rows

#### Scenario: unsafe markdown input is encountered
- **WHEN** a file is oversized, unreadable, symlink-disallowed, invalidly encoded, or contains prompt-injection-like instructions
- **THEN** ingest MUST fail closed for unsafe sections and emit telemetry
- **AND** ordinary send ack MUST NOT wait for ingest result

### Requirement: POST11-R12 Preferences MUST enforce a user-authored trust boundary
Persistent preference writes, including `@pref:` shortcuts, MUST be accepted only from trusted `SendOrigin` values. Agent text, assistant output, tool output, timeline replay, imported memory content, daemon-injected content, and missing-origin sends MUST NOT create persistent preferences by merely containing preference syntax. When `mem.feature.preferences=true`, trusted leading `@pref:` lines MUST persist idempotently, and their preference content MUST be rendered into the provider-visible preference context for the same turn and as stable session context on the first later eligible turn without exposing raw `@pref:` syntax. Identical rendered preference context MUST NOT be repeated on every ordinary send; it MUST be re-injected only when the rendered block changes, after `/compact` or provider-reported compaction, or after a fresh `/clear` conversation.

- **State variables:** send origin, trusted origin set, preference line position, user-visible text, provider-visible preference context, preference fingerprint, origin, command/message id.
- **Failure modes:** missing origin, agent-authored preference syntax, raw preference command forwarded as prompt text, preference persisted but not rendered to the provider, duplicate preference, persistence failure, resend/replay duplicate.
- **Implemented by tasks:** 11.4-11.9.
- **Test anchors:** `test/context/preferences-trust-origin.test.ts`, send ack tests.

#### Scenario: trusted user creates a preference
- **WHEN** an authenticated user sends leading `@pref:` lines through a trusted composer/command origin and `mem.feature.preferences=true`
- **THEN** the system MUST persist the preference with origin `user_note`, fingerprint, namespace, and scope
- **AND** duplicate submissions or retries with the same command/message identity MUST be idempotent and emit `mem.preferences.duplicate_ignored`
- **AND** the trusted raw `@pref:` command lines MUST be stripped from user-visible text and from the provider-bound user message
- **AND** the trusted preference content MUST be included in a controlled provider-visible preference context for that same turn, before persistence completes
- **AND** the first later eligible ordinary send with the preferences feature enabled MUST include active persisted preferences for that user/scope in the provider-visible preference context as stable session context
- **AND** subsequent sends with an unchanged rendered preference block MUST NOT repeat that preference context until `/compact`, provider-reported compaction, `/clear`, or a changed preference block resets the injection gate
- **AND** raw `@pref:` syntax MUST NOT appear in provider-visible context or committed timeline user messages

#### Scenario: Codex SDK injected context has a final hard cap
- **WHEN** daemon-rendered system context, preferences, startup memory, skill hints, authored standards, or recall preambles would make a Codex SDK turn carry more than 32,000 characters of injected context by default
- **THEN** the Codex SDK adapter MUST truncate daemon-injected context before `turn/start`
- **AND** the adapter MUST preserve the current user turn text rather than truncating user-authored content
- **AND** the cap MAY be overridden only by the bounded `IMCODES_CODEX_SDK_CONTEXT_MAX_CHARS` runtime setting
- **AND** daemon receipt ack MUST NOT wait for preference persistence

#### Scenario: untrusted output contains preference syntax
- **WHEN** assistant output, tool output, timeline replay, imported memory, daemon-injected content, or a missing-origin send contains text resembling `@pref:`
- **THEN** the system MUST NOT persist it as a user preference
- **AND** it MUST emit a bounded `mem.preferences.untrusted_origin` or `mem.preferences.rejected_untrusted` counter where applicable

#### Scenario: preferences feature is disabled
- **WHEN** a trusted user sends leading `@pref:` lines while `mem.feature.preferences=false`
- **THEN** the text MUST pass through without persistence, stripping, or provider-visible preference context injection
- **AND** ordinary send ack MUST remain daemon receipt

### Requirement: POST11-R13 Skills MUST follow safe storage, precedence, packaging, rendering, and background review rules
The skills subsystem MUST support user-level skills by default, optional project association by metadata, an explicit project escape hatch, workspace/org shared mirrors, a loader-ready empty built-in layer, and post-response skill auto-creation/self-improvement through the existing isolated compression/materialization background path. Skill resolution MUST follow documented ordinary precedence plus separate enforced policy semantics. Runtime startup context MUST NOT scan or read every skill markdown body. It MAY expose only a provider-visible registry hint containing bounded metadata and redacted/opaque readable paths sourced from an import/install/review/admin-sync maintained skill registry; full skill bodies MUST be read only on demand when a related request, explicit skill key, classifier match, or enforced-policy resolver requires it. The shared skill envelope/render policy remains the required sanitizer for any path that explicitly renders full skill content. Wave 5 MUST NOT ship built-in skill content.

- **State variables:** skill layer, enforcement mode, project metadata, package manifest, loaded-layer diagnostics, skill registry entry, registry hint path/URI, render envelope, review trigger evidence, review job state.
- **Failure modes:** unsafe skill, malformed front matter, delimiter collision, over-cap content, missing built-in manifest, startup full-corpus scan/read, full skill body injected eagerly, stale registry path, ordinary shared skill shadowing project/user unexpectedly, auto-creation blocking send/provider delivery, duplicate skill creation, unbounded skill-review retry, hidden/error tool-result evidence pollution, trigger spam or below-threshold trigger spam.
- **Implemented by tasks:** 12.1-12.10.
- **Test anchors:** `test/context/skill-precedence.test.ts`, `test/context/skill-envelope.test.ts`, package/manifest tests, skill auto-creation background tests.

#### Scenario: user skill is loaded
- **WHEN** a user skill under `~/.imcodes/skills/` is selected
- **THEN** the loader MUST record loaded layer and origin `skill_import`
- **AND** metadata/path parsing MUST be bounded and unsafe or invalid skills MUST fail closed without blocking ordinary send ack
- **AND** import/install/review/admin-sync code MUST update a lightweight skill registry/manifest; ordinary startup and ordinary send MUST NOT construct the registry by scanning or reading all skill markdown bodies
- **AND** the transport startup memory artifact MAY include a bounded registry hint with layer, key, redacted readable path or `skill://` URI, and safe descriptor when `mem.feature.skills=true`
- **AND** polluted, absolute, traversal, NUL-containing, or otherwise provider-unsafe registry display paths MUST be replaced by an opaque `skill://` URI before rendering startup hints
- **AND** unrelated turns MUST NOT read skill bodies; related turns or explicit skill requests MUST read only selected skill bodies through a bounded resolver and the shared skill envelope sanitizer

#### Scenario: ordinary skill layers conflict
- **WHEN** project, user, workspace, org, and built-in layers provide matching skill names
- **THEN** ordinary precedence MUST be project escape hatch, project-scoped user metadata, user default, workspace shared, org shared, then built-in fallback
- **AND** built-in fallback MUST remain lowest precedence and MUST NOT override user-authored, project, workspace, org, or explicitly selected skills
- **AND** loaded-layer diagnostics MUST show which layers were considered

#### Scenario: enforced workspace or org policy applies
- **WHEN** a workspace/org skill has `enforcement: 'enforced'`
- **THEN** it MUST be selected according to policy and MUST NOT be bypassed by user/project skills
- **AND** the registry hint or resolver diagnostics MUST show that the skill is enforced
- **AND** enforced policy MUST NOT require ordinary send ack to wait for skill body reads; any proactive read is bounded, post-ack, and priority-control safe

#### Scenario: skill auto-creation runs after response delivery
- **WHEN** a closed skill-review trigger (`tool_iteration_count` or `manual_review`) fires for a completed user turn and `mem.feature.skill_auto_creation=true`
- **THEN** `tool_iteration_count` MUST require real completed, non-hidden, non-error tool-result evidence meeting the configured threshold before enqueue; `manual_review` MAY bypass that automatic threshold
- **AND** skill review MUST run only after the agent response has been delivered through the existing isolated compression/materialization background path
- **AND** it MUST NOT delay ordinary send ack, provider delivery, `/stop`, approval/feedback controls, or shutdown
- **AND** the daemon production worker/scheduler MUST coalesce duplicate pending reviews per scope/session, enforce configured tool-iteration threshold, concurrency/min-interval/daily caps, write only user-level skills, update the skill registry after successful writes, and emit `mem.skill.review_throttled` only for true throttles
- **AND** daily caps MUST be keyed by scope plus the current day/window, and automatic tool-iteration evidence MUST be cleared after each completed-turn scheduling decision so unrelated below-threshold turns cannot accumulate into a later trigger
- **AND** it MUST prefer updating an existing matching user-level skill before creating a new one
- **AND** duplicate, below-threshold, unsafe, over-cap, hidden/error evidence, or failed reviews MUST be handled with bounded retry/backoff and idempotency; below-threshold/non-eligible decisions MUST be distinguishable from throttling telemetry

### Requirement: POST11-R14 Skill administration MUST enforce authorization and injection defenses
Workspace/org skill push MUST require admin authorization. Skill content MUST be checked for adversarial phrases, delimiter collision, system-instruction escape, and length cap before being accepted for context rendering.

- **State variables:** caller role, target scope, skill content, sanitizer result, rejection envelope.
- **Failure modes:** non-admin push, inventory leak, sanitizer bypass, delimiter spoof, over-cap content.
- **Implemented by tasks:** 12.4-12.9.
- **Test anchors:** server/admin skill auth tests, sanitizer fixtures.

#### Scenario: non-admin pushes workspace skill
- **WHEN** a non-admin attempts to push a workspace or org skill
- **THEN** the request MUST be rejected without creating or updating skill memory
- **AND** the rejection MUST NOT leak unrelated skill inventory

#### Scenario: skill content attempts delimiter collision
- **WHEN** skill content attempts to close or spoof the skill delimiter envelope
- **THEN** sanitization MUST reject or escape the content according to the documented policy
- **AND** a negative fixture MUST cover the collision case

### Requirement: POST11-R15 Web-visible post-foundations UI MUST obey i18n and shared-constant rules
User-visible strings introduced for search empty states, citation drift, MD ingest degradation, skill sanitization failures, feature-disabled states, preference rejection, preference management, skill registry management, manual MD ingest, project selection, feature-status display, management error states, and observation promotion MUST use the web i18n system and update all supported locales. Protocol/type/status strings MUST use shared constants. The memory management panel MUST provide the minimum operator surface for every runtime-affecting post-foundations feature: show daemon-resolved feature flag state, allow operator enable/disable for daemon-controlled memory flags through shared management RPCs, provide a searchable project selector/dropdown that defaults browse to all projects and shows both canonical ID and directory when available, list/create/delete trusted user preferences, list/rebuild/preview/delete skill registry entries without eager body reads, run bounded manual markdown ingest with explicit scope/project inputs, inspect typed observations, and promote observations only through the audited explicit UI action.

- **State variables:** translation key, supported locale list, shared protocol constant, UI feature flag state, daemon WebSocket availability, browse project filter, local-action project option, memory-index project option, project resolution status, canonical repo id, project directory, preference user id, skill registry entry, MD project scope, observation class/scope, promotion target/reason.
- **Failure modes:** hardcoded string, missing locale key, duplicated protocol literal, inaccessible/a11y palette state, disabled feature still mutates persistent state, feature status can only display disabled without an operator toggle path, feature toggle persists nowhere or is lost on restart, dependency-blocked flags appear enabled, daemon error surfaced as raw unlocalized text, preference saved but not visible, skill file created but not visible in registry, management registry write leaves runtime skill cache stale, symlink/polluted registry preview reads outside managed skill roots, UI preview causing startup-style full-corpus skill reads, manual MD ingest reads files before canonical project identity is present, unsupported MD scope silently downgraded, cross-scope observation promotion without audit, ambiguous one-click observation promotion without from/to/effect disclosure, stale project-resolve response overwrites the selected project, stale REST memory response overwrites the active browse filter, hand-typed project IDs become the primary path, browse defaults to the current project instead of all projects, memory-index projects disappear after selecting a filter, canonical-only projects incorrectly enable local file-backed tools, local tools run against an unvalidated directory/ID pair.
- **Implemented by tasks:** 10.6, 11.10-11.12, 12.8, 12.17-12.19, 14.4, 14.7-14.9, 15.1-15.15.
- **Test anchors:** `web/test/i18n-coverage.test.ts`, `web/test/i18n-memory-post11.test.ts`, `web/test/components/SharedContextManagementPanel.test.tsx`, `server/test/bridge-memory-management.test.ts`, `server/test/shared-context-processed-remote.test.ts`, `test/daemon/command-handler-memory-context.test.ts`, `test/daemon/command-handler-transport-queue.test.ts`, `test/context/skill-registry-resolver.test.ts`, `test/context/context-observation-store.test.ts`, `test/context/memory-feature-flags.test.ts`.

#### Scenario: web UI exposes a new memory state
- **WHEN** a post-foundations feature adds a user-visible web string
- **THEN** the implementation MUST use translation keys
- **AND** every locale in `SUPPORTED_LOCALES` (`en`, `zh-CN`, `zh-TW`, `es`, `ru`, `ja`, `ko`) MUST have the key
- **AND** protocol/status strings shared across daemon/server/web MUST be defined in shared code rather than duplicated literals

#### Scenario: operator manages post-1.1 runtime memory surfaces
- **WHEN** the daemon is connected and the user opens memory management
- **THEN** the UI MUST query local feature states, preferences, skill registry entries, and typed observations through shared WebSocket message constants
- **AND** the feature-state area MUST expose enable/disable controls for daemon-managed memory flags, persist changes through daemon-side config, show requested-vs-effective dependency-blocked state as a distinct non-enabled warning state, and refresh downstream management panes after a change
- **AND** it MUST allow trusted preference creation/deletion, skill registry rebuild/preview/delete, bounded manual MD ingest, and audited observation promotion without requiring direct filesystem/database edits
- **AND** observation promotion in the Web UI MUST be a two-step action: the first click only opens an explicit confirmation showing source scope, target scope, and visibility/audit consequences; only the confirmation action may send the shared promotion RPC
- **AND** feature-disabled management mutations MUST be rejected by the daemon with shared error codes and localized web messages
- **AND** skill management MUST show registry metadata first and read a full skill body only for an explicit preview/read action
- **AND** skill preview MUST reject symlink/non-file polluted registry entries and management registry writes MUST invalidate runtime skill cache
- **AND** the memory page MUST offer a project selector/list that defaults to all projects for browsing, shows canonical project ID and directory when available, sources active/recent session directories, enterprise canonical projects, and authorized memory-index project summaries returned by local/cloud/shared memory queries, and does not require hand-typed IDs as the primary path
- **AND** the initial browse query MUST omit `projectId`/`canonicalRepoId` until the user explicitly selects a project filter
- **AND** the UI MUST keep browse filtering separate from local file-backed action project selection, so choosing or auto-resolving a local-action project does not silently filter memory browsing
- **AND** canonical-only memory-index projects MAY filter memory views but MUST NOT enable local skill/MD/observation file actions until a validated directory/canonical pair exists
- **AND** directory-only project choices MUST resolve through the daemon before local skill/MD/observation management actions can run
- **AND** MD ingest controls MUST require a selected validated project directory and canonical project identity before running
- **AND** the daemon MUST reject missing canonical project identity before reading project files
- **AND** UI mutation controls MUST remain disabled while feature state is unknown or disabled
- **AND** UI responses MUST be accepted only when their `requestId` matches the latest request for that management surface

### Requirement: POST11-R16 New background memory workers MUST be repairable, idempotent, and bounded
Any new post-foundations background worker, including classification, ingest, search indexing, skill sync, skill auto-creation, or telemetry audit persistence, MUST define stale-state repair, bounded retry/backoff, idempotent reprocessing, retention/pruning, and feature-disable behavior.

- **State variables:** job status, attempt count, next retry, stale threshold, feature flag, retention policy, repair marker.
- **Failure modes:** stuck running jobs, retry storm, duplicate writes, poisoned fallback projections, disabled feature continues writing, unbounded audit growth.
- **Implemented by tasks:** 1.6, 5.1-5.6, 8.2, 8.6, 9.4, 11.5, 12.6, 12.10.
- **Test anchors:** materialization repair tests, worker backoff/idempotency tests, skill auto-creation background tests.

#### Scenario: worker is interrupted mid-run
- **WHEN** a post-foundations worker is interrupted after marking work in progress
- **THEN** startup or scheduled repair MUST detect stale in-progress state and return it to a retryable or failed state without blocking daemon startup
- **AND** retry MUST be bounded and observable

#### Scenario: feature is disabled with pending jobs
- **WHEN** a feature flag disables a worker while jobs are pending
- **THEN** the worker MUST stop claiming new jobs for that feature
- **AND** existing data MUST remain readable or safely ignored according to the disabled feature contract

### Requirement: POST11-R17 Namespace registry and multi-class observations MUST be first-class and scope-bound
Post-foundations memory MUST include a first-class namespace registry and multi-class observation store in the current Wave 1 milestone. Namespace records MUST bind to `MemoryScope` policies from `shared/memory-scope.ts` and MUST NOT use ad hoc scope strings outside that registry. Observation rows MUST represent typed durable memory facts, decisions, preferences, skill candidates, notes, and other closed classes while projections remain the aggregate/search/render surface.

- **State variables:** namespace id/key, memory scope policy, observation class, content JSON, projection id, source event ids, origin, fingerprint, promotion state, audit action.
- **Failure modes:** cross-scope promotion, duplicate observation writes, class enum drift, projection/observation mismatch, migration backfill interruption, unauthorized namespace access, unauthorized promotion.
- **Implemented by tasks:** 3.7-3.19, 9.1-9.6, 11.5, 12.10.
- **Test anchors:** namespace migration tests, observation write/backfill tests, classification-to-observation tests, scope authorization tests, promotion audit tests.

#### Scenario: namespace registry is migrated
- **WHEN** existing projection or memory rows are migrated into first-class namespace records
- **THEN** every namespace MUST bind to exactly one registered `MemoryScope` policy through canonical namespace constructors
- **AND** migration MUST NOT widen visibility beyond the scope policy
- **AND** old rows MUST remain readable during lazy backfill

#### Scenario: typed observation is written
- **WHEN** classification, preference ingest, markdown ingest, or skill review writes durable structured memory
- **THEN** it MUST write an observation with a class from `ObservationClass`, content JSON, source event ids, origin, fingerprint, namespace id, and scope
- **AND** the associated projection aggregate MUST be updated transactionally or through a repairable outbox path
- **AND** markdown-ingested observations MUST NOT remain observation-only; they MUST become visible to authorized startup/search/provider paths through the projection aggregate
- **AND** duplicate observations MUST be idempotently merged or ignored within the same scope

#### Scenario: observation promotion is requested
- **WHEN** an observation would move from a private scope (`user_private` or `personal`) to `project_shared`, `workspace_shared`, or `org_shared`
- **THEN** the promotion MUST require one explicit authorized action: web UI Promote, CLI `imcodes mem promote`, or admin API `POST /api/v1/mem/promote`
- **AND** the request MUST carry `expectedFromScope` and the promotion transaction MUST reject if the stored source scope differs or the expected scope is missing
- **AND** the promotion MUST write `observation_promotion_audit`
- **AND** the Web UI promotion path MUST disclose the from-scope, to-scope, and audit/visibility consequence before sending the mutation
- **AND** automatic classification or background skill review MUST NOT promote across scopes


### Requirement: POST11-R18 Authorization scope policy registry MUST be current-scope work
Post-foundations memory MUST promote authorization scope extensions into the current Wave 1 milestone. The system MUST define `MemoryScope = 'user_private' | 'personal' | 'project_shared' | 'workspace_shared' | 'org_shared'` in shared code and MUST migrate daemon, server, and web validation/filtering to that registry. `user_private` is a current-scope addition, not later backlog. Session tree is not a `MemoryScope`; main sessions and sub-sessions share project/session context through namespace/context binding. The registry MUST also expose narrow subtype unions and a `SearchRequestScope` vocabulary (`owner_private`, `shared`, `all_authorized`, or an explicit single `MemoryScope`) so request handling cannot confuse owner-private, legacy personal, and shared scopes.

- **State variables:** scope name, owner identity fields, canonical repository identity (`canonicalRepoId`), repository alias mapping, project/workspace/org fields, optional namespace/context binding such as root session tree id, replication policy, raw-source access policy, search inclusion/request expansion policy, promotion target policy, feature flag state.
- **Failure modes:** hard-coded old enum, scope silently widened, user-private memory shown to project/workspace/org users, same remote project split by device/local path, unrelated projects merged by unsafe alias, session-tree binding mistaken for a scope, missing migration/backfill, old clients sending legacy `personal`.
- **Implemented by tasks:** 3.7, 3.20-3.25, 4.1-4.4, 8.7, 10.2, 14.2-14.6.
- **Test anchors:** memory scope policy tests, daemon/server scope migration tests, search authorization tests, web/admin scope validation tests.

#### Scenario: session tree context is evaluated
- **WHEN** memory lookup/startup/bootstrap needs session/sub-session context
- **THEN** the main session and all sub-sessions under the same root session tree MUST share the project/session context available to that tree
- **AND** this sharing MUST be implemented through namespace/context binding such as `root_session_id` / `session_tree_id`, not by adding a new authorization scope
- **AND** sessions outside that root tree MUST NOT receive tree-bound context unless it is also available through existing project/user/shared scopes
- **AND** the binding MUST NOT create server shared projection rows by itself

#### Scenario: same project is used on multiple devices
- **WHEN** the same signed-in user opens the same git project on two devices
- **AND** both working copies resolve to the same canonical remote repository identity (`canonicalRepoId`, normalized as `host/owner/repo` or through an authorized repository alias)
- **THEN** project-scoped `personal` memory and enrolled shared project memory MUST use that canonical project identity and be visible on both devices when the relevant sync/shared feature is enabled
- **AND** local cwd, session name, sub-session id, and `machine_id` MUST NOT split the project into separate authorization scopes
- **AND** if no usable remote identity exists, local fallback identity MAY remain device-local until explicitly aliased/enrolled to a canonical remote

#### Scenario: user-private memory is written
- **WHEN** a preference, user-level skill, persona/user fact, or cross-project private observation is created with scope `user_private`
- **THEN** it MUST be visible only to the owning user across projects/workspaces
- **AND** when `mem.feature.user_private_sync=false`, it MUST remain daemon-local and no server write/read job may run
- **AND** when `mem.feature.user_private_sync=true`, it MUST sync only through a dedicated owner-private server route/table with owner-user authorization and idempotency
- **AND** it MUST NOT be inserted into or queried through `shared_context_projections` / project/workspace/org membership filters
- **AND** project/workspace/org/shared search MUST include it only for that same owner when the request explicitly includes `owner_private` or `all_authorized`

#### Scenario: legacy personal memory is migrated
- **WHEN** existing `personal` rows are migrated into the scope registry
- **THEN** they MUST remain owner-only and project-bound `personal`, keyed by canonical `project_id` / `canonicalRepoId` when a remote exists
- **AND** the same owner using the same canonical project on another device MAY see them when personal sync is enabled
- **AND** automatic migration/backfill MUST NOT reclassify them as `user_private` or widen visibility to other projects/users
- **AND** any later `personal` -> `user_private` movement requires an explicit audited user/admin reclassification path and rollback story

#### Scenario: search request scope is expanded
- **WHEN** quick search, citation lookup, source lookup, startup selection, MCP read tools, or web/admin validation query memory
- **THEN** authorization MUST be derived from `shared/memory-scope.ts` policy helpers and the request vocabulary (`owner_private`, `shared`, `all_authorized`, or an explicit single scope)
- **AND** `shared` MUST expand only to `personal`, `project_shared`, `workspace_shared`, and `org_shared` according to caller membership; it MUST NOT include `user_private`; `org_shared` requires enterprise membership and is not public/global
- **AND** `all_authorized` MAY include `user_private` only when the caller satisfies the owner policy
- **AND** session-tree inclusion, when needed, MUST be a separate namespace/context binding filter and not a scope expansion
- **AND** project matching MUST use canonical remote-backed project identity and repository aliases, not cwd or machine id
- **AND** bespoke SQL enum lists or duplicated scope literals MUST fail tests

### Requirement: POST11-R19 Enterprise-wide authored standards MUST use `org_shared`
Enterprise-global coding standards, architecture guidelines, repo playbooks, and reusable policy documents MUST be modeled as `org_shared` authored context bindings inside one enterprise/team. The system MUST NOT introduce a separate `global` scope, `namespace_tier=global`, or any unscoped cross-enterprise memory surface for this purpose.

- **State variables:** enterprise id, caller enterprise role, document id/version id, binding id, binding mode, derived scope, optional repo/language/path filters, active/superseded state, feature flag state.
- **Failure modes:** cross-enterprise visibility, non-admin mutation, required binding dropped silently, filters widening visibility, org document mistaken for public global memory, processed projection losing project provenance, disabled-feature inventory leak.
- **Implemented by tasks:** 4.1-4.4, 12.11-12.14, 14.3-14.6.
- **Test anchors:** `server/test/shared-context-org-authored-context.test.ts`, shared-context disabled-feature tests, shared-context control-plane tests, runtime authored-context selection tests, web/i18n diagnostics tests.

#### Scenario: org-wide standard is created
- **WHEN** an enterprise owner/admin creates a coding standard or playbook intended for the whole enterprise
- **THEN** the document version MUST be bound with `enterprise_id` set, `workspace_id = NULL`, `enrollment_id = NULL`, and derived scope `org_shared`
- **AND** only members of that enterprise may receive it at runtime
- **AND** non-members or other enterprises MUST receive the same external not-found/unauthorized shape without inventory leakage

#### Scenario: org-wide standard is selected for a session
- **WHEN** a member starts or sends in a session whose canonical project, language, and file path match an active org-shared binding
- **THEN** the runtime authored-context resolver MUST include that org-shared binding after more specific project/workspace bindings
- **AND** `required` bindings MUST be preserved or dispatch must fail with the existing required-authored-context error
- **AND** `advisory` bindings MAY be budget-trimmed only with diagnostics/telemetry
- **AND** optional repo/language/path filters MUST only narrow applicability within the caller enterprise

#### Scenario: org-wide authored standards are disabled
- **WHEN** `mem.feature.org_shared_authored_standards=false`
- **THEN** creating, updating, activating, or binding an org-wide authored standard MUST fail closed with the documented disabled envelope
- **AND** runtime selection MUST skip org-wide authored standards without blocking ordinary send ack
- **AND** the disabled response MUST NOT reveal whether any org-wide standard exists

#### Scenario: org-shared processed memory exists
- **WHEN** processed project experience is promoted or written with scope `org_shared`
- **THEN** it MUST retain canonical `project_id` / `canonicalRepoId`, source ids, origin, fingerprint, and authorization metadata
- **AND** it MUST remain visible only inside the enterprise
- **AND** it MUST NOT become an unowned global pool or lose project provenance

### Requirement: POST11-R20 Memory management RPCs MUST be single-cast and server-authorized
Post-1.1 memory management WebSocket requests and responses MUST use the closed request/response vocabulary in `shared/memory-ws.ts`, including project-identity resolution used by the management UI. A management request MUST include a unique `requestId`; the server bridge MUST track that pending request and inject a server-derived management context before forwarding to the daemon. Daemon handlers MUST authorize using that context rather than trusting client-supplied `actorId`, `userId`, project, workspace, or org identity; missing/invalid management context MUST fail closed for all enabled management operations. Browser project/workspace/org fields are request hints only and MUST NOT enter daemon `boundProjects` unless the server verifies membership/enrollment for the exact canonical repo, workspace, or org. Management responses MUST be routed only to the pending requester for the matching `requestId`; unrouted responses MUST be dropped and counted, never broadcast to all browser clients. Personal-memory browse responses MUST include an authorized, bounded `projects` index so the UI can populate project filters from actual memory without requiring manual IDs or full table scans.

- **State variables:** request type, response type, requestId, pending socket, management actor/user/role, record creator/owner/updater metadata, bound project hints, project index summary, project resolution status, feature state, owner id, observation scope, skill path, canonical project identity, processed-memory mutation state, pinned-note id.
- **Failure modes:** cross-tab/body leak, stale response overwrites current UI state, duplicate requestId hijack, missing context fallback, bridge context-construction failure leaving a stuck pending request, client-forged actor/user identity, client-provided project hints promoted into authorization bindings, preference owner mismatch, legacy display metadata granting shared mutation authority, record creator confused with admin role, personal-memory owner/scope leakage, unauthorized manual memory create/edit/pin/delete, unauthorized private/shared observation query, unauthorized observation edit/delete/promotion, observation delete accidentally cascading to a processed projection, stale linked projection embeddings after observation edit, raw-source search leak, symlink or oversize skill registry path, invalid project directory, canonical project mismatch, disabled feature mutation, arbitrary browser-supplied directory accepted as a memory project, all-project memory stats non-zero but project dropdown empty because project summaries are absent, project summary leakage across owner/enterprise authorization boundaries.
- **Implemented by tasks:** 11.10-11.13, 12.17-12.20, 15.1-15.16, 16.1-16.2, 17.1-17.11.
- **Test anchors:** `server/test/bridge-memory-management.test.ts`, `server/test/shared-context-processed-remote.test.ts`, `test/daemon/command-handler-memory-context.test.ts`, `test/daemon/command-handler-transport-queue.test.ts`, `web/test/components/SharedContextManagementPanel.test.tsx`, `web/test/i18n-memory-post11.test.ts`, `test/context/skill-registry-resolver.test.ts`, `test/context/context-observation-store.test.ts`, `test/context/memory-feature-flags.test.ts`.

#### Scenario: management response would otherwise broadcast
- **WHEN** browser A sends a management request and browser B is connected to the same bridge
- **THEN** the daemon response for A's `requestId` MUST be delivered only to browser A
- **AND** browser B MUST NOT receive the response body or metadata
- **AND** a response with no pending `requestId` MUST be dropped with `mem.bridge.unrouted_response`

#### Scenario: browser forges management identity
- **WHEN** a management request carries client-supplied `actorId`, `userId`, role, owner fields, `_memoryManagementContext`, or legacy `managementContext` that differ from the authenticated browser context
- **THEN** the bridge/daemon MUST derive actor and owner from the server-injected management context
- **AND** elevated management roles MUST come only from server-side membership records for the requested enterprise/workspace/project binding
- **AND** the bridge MUST NOT add a canonical repo, workspace, or org to `boundProjects` unless that same server membership/enrollment check succeeds; unverified browser hints remain in the request payload only as hints and do not authorize daemon shared-scope access
- **AND** generic `projectId` MUST NOT be silently treated as canonical repo identity for role derivation; project-scoped management MUST use explicit `canonicalRepoId` plus a verified project directory binding before filesystem access
- **AND** preference create/update/delete, observation query/update/delete/promotion, and processed-memory manual create/update/pin/archive/restore/delete MUST fail closed or filter records when the derived context is not authorized; record-level `ownerUserId` / `createdByUserId` MUST be derived from the authenticated context at creation and MUST NOT be accepted from browser payloads
- **AND** legacy/display metadata fields such as `userId`, `createdBy`, `authorUserId`, and `updatedBy` MUST NOT grant preference, observation, or shared processed-memory mutation authority
- **AND** management search, archive, restore, delete, update, pin, skill preview/delete/rebuild, and manual MD ingest MUST apply the same derived-context authorization before returning data or mutating state
- **AND** management quick search and personal-memory management queries MUST NOT expose raw source text through `includeRaw`, MUST compute stats/pagination only after authorization, and MUST NOT return another user's `personal` / `user_private` rows from the same project
- **AND** personal-memory management queries MUST filter records, stats, pending records, and semantic results by the server-derived owner id plus `scope='personal'`; local daemon storage MUST maintain indexed namespace filter columns for processed projections, staged events, dirty targets, and jobs so these owner/project filters are applied in SQL before result construction rather than by unbounded full-table scans; missing daemon-side management context MUST return the same `PERSONAL_RESPONSE` shape with empty records/stats and a shared error code
- **AND** manual processed-memory creation MUST require non-empty text plus explicit canonical project identity and an authorized canonical project binding, write origin `user_note`, write creator/owner metadata, and create/update linked observation/projection state consistently
- **AND** processed-memory edit MUST update projection summary/content hash, linked observation text/fingerprint, `updatedByUserId`, and clear stale embeddings; permanent delete MUST remove linked observations; archive/restore/delete/update/pin MUST invalidate runtime memory cache with projection-typed invalidation; pin MUST create or update a deterministic `manual_pin` pinned note for the projection rather than appending duplicates
- **AND** observation edit MUST update linked projection text/content hash and clear stale embeddings; observation delete MUST delete only the observation row and MUST NOT cascade to the linked processed projection
- **AND** missing observations and stale `expectedFromScope` checks MUST return typed shared error codes instead of generic action failure
- **AND** private records remain mutable only by their owner; shared records may be mutated by an authorized admin or by the record creator/owner when the namespace is otherwise visible; admin mutations MUST preserve original creator metadata
- **AND** missing/unauthorized results MUST preserve the same safe envelope

#### Scenario: bridge cannot derive management context after registering a request
- **WHEN** the bridge accepts a memory-management request and context construction or role derivation fails before daemon forwarding
- **THEN** the bridge MUST clear the pending request, send an error only to the requesting browser, and MUST NOT forward a partially authorized request or broadcast the error

#### Scenario: management feature state is unknown or disabled
- **WHEN** the UI has not yet received daemon-resolved feature state, or the relevant feature is effectively disabled by dependency folding
- **THEN** mutation buttons MUST remain disabled in the UI
- **AND** forced daemon mutation/read-body requests MUST fail closed with shared error codes and no persistent writes/background work
- **AND** processed-memory management create/update/archive/restore/delete/pin MUST fail closed when `mem.feature.observation_store=false`, because those mutations create or update projection/observation consistency state

#### Scenario: memory project selector resolves a directory
- **WHEN** the web Memory tab has a directory-only project option from an active/recent daemon session
- **THEN** it MUST send a `memory.project.resolve` request with a unique `requestId`
- **AND** the daemon MUST accept only daemon-known project directories, verify the path is a directory, derive `canonicalRepoId` from the repository remote identity, and reject mismatches before the UI enables local filesystem tools
- **AND** the web UI MUST ignore stale project-resolve responses whose `requestId` is no longer current
- **AND** the picker MUST show both canonical ID and directory for resolved projects and explain canonical-only projects as cloud/shared filtering only until a local directory is resolved

#### Scenario: memory project selector is populated from memory indexes
- **WHEN** local daemon, personal cloud, enterprise/shared, or semantic memory responses contain authorized project summaries
- **THEN** the response MUST include a bounded `projects` array with canonical `projectId`, display name when available, record counters, pending count when available, and `updatedAt` metadata
- **AND** project summaries MUST be computed after owner/scope/enterprise authorization and must not reveal unauthorized project ids, counts, source text, or raw paths
- **AND** the web UI MUST merge those summaries into the project selector without replacing the full option set with only the currently filtered project
- **AND** selecting one of those projects MUST filter memory views by canonical id while preserving the all-project option

#### Scenario: skill and markdown management inputs are untrusted
- **WHEN** a skill registry entry points outside managed roots, through a symlink directory, to a non-file, or over the configured byte cap
- **THEN** management preview/runtime resolver MUST fail closed with shared error/counter behavior and MUST NOT read the file
- **AND** registry files over the configured byte or entry limit MUST be refused before parsing unbounded content
- **AND** project-scoped skill registry query/rebuild/preview/delete MUST require explicit `canonicalRepoId`, a project directory, and verified repository identity before reading or mutating project skill files
- **WHEN** manual markdown ingest provides an invalid project directory, missing canonical project identity, mismatched canonical repository identity, or unsupported filesystem scope
- **THEN** the daemon MUST reject before reading project files and MUST NOT silently downgrade scope
