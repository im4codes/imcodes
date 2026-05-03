## 1. Scope, traceability, and cross-wave foundations gates

- [x] 1.1 Confirm the current completion milestone is Wave 1-5; keep Wave 6+ candidates as non-checkbox backlog until promoted by spec/task update.
- [x] 1.2 Keep `docs/plan/mem1.1.md` synchronized as historical rationale and point implementation to this OpenSpec change as the authoritative contract.
- [x] 1.3 Maintain the traceability matrix below; every `POST11-R*` requirement MUST have at least one implementation task and one test/validation anchor before implementation starts.
- [x] 1.4 Document foundations deltas in `design.md` while `memory-system-1.1-foundations` is active and cumulative `openspec/specs/daemon-memory-pipeline/spec.md` is unavailable.
- [x] 1.5 Archive gate: before archiving this change, re-check cumulative OpenSpec state. If `daemon-memory-pipeline` exists, create `specs/daemon-memory-pipeline/spec.md` with `## MODIFIED Requirements` for send ack, priority controls, startup selection, render payloads, and citation-aware recall deltas, then rerun `openspec validate memory-system-post-1-1-integration`.
- [x] 1.6 Run the foundations regression matrix for every wave PR: daemon-receipt send ack, `/compact` SDK-native pass-through, `/stop` and approval/feedback priority, fail-open recall/bootstrap, provider send-start watchdog, materialization repair, redaction, scope filtering, source lookup authorization, and same-shape missing/unauthorized/disabled lookup responses.
- [x] 1.7 Add shared constants inventory tasks to the first implementation PR: `shared/memory-scope.ts`, `shared/memory-origin.ts`, `shared/memory-namespace.ts`, `shared/memory-observation.ts`, `shared/send-origin.ts`, `shared/feature-flags.ts`, `shared/memory-counters.ts`, `shared/skill-envelope.ts`, `shared/skill-review-triggers.ts`, `shared/builtin-skill-manifest.ts`, `shared/memory-defaults.ts`, and `web/src/i18n/locales/index.ts`; `shared/memory-scope.ts` MUST export narrow scope subtypes and `SearchRequestScope`.
- [x] 1.8 Split security validation into atomic gates: redaction, scope filtering, source lookup authorization, missing-vs-unauthorized-vs-disabled response shape, metadata suppression, count suppression, drift suppression, and raw-source suppression.
- [x] 1.9 Migration/backfill rule: no current post-1.1 requirement may be deferred because it requires daemon SQLite migration, server PostgreSQL migration, backfill, migration-number coordination, or rollback/repair work; instead add the migration, rollback, repair, and tests to the same wave.
- [x] 1.10 Test-anchor rule: each path below is either an existing test to update or a new test file to create; implementation PRs must not claim completion against phantom paths.
- [x] 1.11 Acceptance harness rule: update the canonical acceptance wrapper so it validates `memory-system-post-1-1-integration` directly, not only `memory-system-1.1-foundations`.

### Traceability matrix

| Requirement | Implementation tasks | Expected code areas | Test anchors / validation |
| --- | --- | --- | --- |
| POST11-R1 foundations liveness | 1.6, 8.1-8.8, 14.2 | `src/daemon/*`, `src/agent/*`, `src/context/*`, server bridge where relevant | `server/test/ack-reliability.test.ts`, `test/ack-reliability-e2e.test.ts`, `test/daemon/command-handler-transport-queue.test.ts`, `test/daemon/transport-session-runtime.test.ts`, `test/agent/runtime-context-bootstrap.test.ts`, `web/test/use-timeline-optimistic.test.ts` |
| POST11-R2 fingerprints | 2.1-2.7 | `shared/memory-fingerprint.ts`, daemon/server write paths, migrations | `test/context/memory-fingerprint-v1.test.ts`, `test/fixtures/fingerprint-v1/**` |
| POST11-R3 origins | 3.1-3.6 | `shared/memory-origin.ts`, daemon SQLite, server migrations, write APIs | origin migration/write tests, reserved-origin rejection tests, search/UI origin tests |
| POST11-R4 feature flags | 4.1-4.9 | `shared/feature-flags.ts`, config propagation, daemon/server/web observers | `test/context/memory-feature-flags.test.ts`, server/web disabled-feature tests, dependency/default coverage tests |
| POST11-R17 namespace/observations | 3.7-3.19, 9.1-9.6, 11.5, 12.10 | `shared/memory-namespace.ts`, `shared/memory-observation.ts`, daemon SQLite migrations, server migrations, projection/observation write APIs | namespace migration tests, observation write/backfill tests, classification-to-observation tests, scope authorization tests, promotion audit tests |
| POST11-R18 authorization scope registry | 3.7, 3.20-3.25, 4.1-4.4, 8.7, 10.2 | `shared/memory-scope.ts`, shared validators, daemon/server/web scope filters, migrations | memory scope policy tests, daemon/server scope migration tests, search authorization tests, web/admin scope validation tests |
| POST11-R19 org-shared authored standards | 4.1-4.4, 12.11-12.14, 14.3-14.6 | `shared/feature-flags.ts`, `server/src/routes/shared-context.ts`, `server/src/routes/server.ts`, shared-context document/version/binding migrations, runtime authored-context resolver, web diagnostics | `server/test/shared-context-org-authored-context.test.ts`, shared-context disabled-feature tests, shared-context control-plane tests, runtime authored-context selection tests, web/i18n diagnostics tests |
| POST11-R20 memory management RPC auth/routing | 11.10-11.13, 12.17-12.20, 15.1-15.16 | `shared/memory-ws.ts`, `server/src/ws/bridge.ts`, `src/daemon/command-handler.ts`, `src/store/context-store.ts`, `shared/context-types.ts`, `src/context/memory-search.ts`, server/shared memory routes, management UI | `server/test/bridge-memory-management.test.ts`, `server/test/shared-context-processed-remote.test.ts`, `test/daemon/command-handler-memory-context.test.ts`, `test/daemon/command-handler-transport-queue.test.ts`, `test/context/memory-search.test.ts`, `web/test/components/SharedContextManagementPanel.test.tsx`, skill registry/feature flag tests |
| POST11-R5 telemetry | 5.1-5.7 | `shared/memory-counters.ts`, telemetry enqueue/sink | telemetry sink timeout/reject tests, counter registry tests |
| POST11-R6 startup budget | 6.1-6.6 | startup selection/render modules, `shared/memory-defaults.ts` | `test/context/startup-memory.test.ts`, startup over-budget fixture tests, `test/spec/design-defaults-coverage.test.ts` |
| POST11-R7 render policy | 7.1-7.5 | render policy module, skill/citation renderers | render policy tests, `test/context/skill-envelope.test.ts` |
| POST11-R8 self-learning | 9.1-9.6 | compression/materialization pipeline | classification/dedup tests, materialization repair tests |
| POST11-R9 quick search security | 10.1-10.8, 1.8 | server/daemon search, scope filters, web palette | `server/test/memory-search-auth.test.ts`, `test/context/memory-search-semantic.test.ts`, web quick-search tests |
| POST11-R10 citations/drift/cite-count | 10.3-10.14 | citation storage/API, idempotency store, cite-count columns or counter table, ranking, web citation renderer | `test/context/memory-citation-drift.test.ts`, `test/context/memory-cite-count.test.ts`, citation web tests, source lookup auth tests |
| POST11-R11 MD ingest | 11.1-11.7 | MD parser/ingest worker, startup bootstrap | MD ingest tests, startup compatibility tests |
| POST11-R12 preferences trust | 11.4-11.9 | send command schema, daemon preference parser, web/CLI send origin, preference idempotency | `test/context/preferences-trust-origin.test.ts`, ack tests |
| POST11-R13 skills storage/render/review | 12.1-12.10 | skill loader/store, manifest, render policy, background skill review | `test/context/skill-precedence.test.ts`, `test/context/skill-envelope.test.ts`, package manifest tests, skill auto-creation background tests |
| POST11-R14 skill admin | 12.4-12.9 | server/admin API, auth checks, sanitizer | admin skill auth tests, sanitizer fixtures |
| POST11-R15 web i18n/constants | 10.6, 12.8, 14.4, 14.9, 15.13, 15.16 | `web/src/i18n/*`, shared constants, web UI, `shared/context-types.ts`, `shared/memory-project-options.ts` | `web/test/i18n-coverage.test.ts`, `web/test/components/SharedContextManagementPanel.test.tsx`, web feature tests |
| POST11-R16 worker repair/backoff | 5.1-5.7, 8.2, 8.6, 9.4, 11.5, 12.6, 12.10 | worker/job tables, repair hooks, retention sweepers | materialization repair tests, worker backoff/idempotency tests, skill auto-creation background tests |

## 2. Wave 1 — stable fingerprint foundation

**Prerequisites:** foundations archive/source identity remains green.
**Satisfies:** POST11-R2.

- [x] 2.1 Define canonical `shared/memory-fingerprint.ts` API: `computeMemoryFingerprint({ kind, content, scopeKey?, version?: 'v1' }): string` with `FingerprintKind = 'summary' | 'preference' | 'skill' | 'decision' | 'note'`.
- [x] 2.2 Mark older summary-only helpers as deprecated/internal and ensure new call sites use the canonical API.
- [x] 2.3 Add kind-specific normalization rules: summary, preference, skill front matter stripping, decision, and note handling.
- [x] 2.4 Migration: add nullable/backfillable fingerprint columns/indexes to daemon SQLite and server PostgreSQL surfaces that store projections/preferences/skills, using the next available migration number at implementation time.
- [x] 2.5 Failure handling: lazy backfill must not block daemon startup or send ack; eager backfill, if provided, must be explicit, bounded, and restartable.
- [x] 2.6 Tests: add byte-identical daemon/server fingerprint fixtures covering CJK, emoji, RTL, whitespace, front matter, punctuation, and scope separation.
- [x] 2.7 Acceptance: same-scope identical normalized content dedups; different scopes never merge.

## 3. Wave 1 — origin metadata, namespace registry, and observation foundation

**Prerequisites:** 2.x fingerprint design.
**Satisfies:** POST11-R3, POST11-R17, POST11-R18.

- [x] 3.1 Define closed `MEMORY_ORIGINS` in `shared/memory-origin.ts`: `chat_compacted`, `user_note`, `skill_import`, `manual_pin`, `agent_learned`, `md_ingest`. Reserve but do not emit `quick_search_cache` until a future cache contract defines TTL/invalidation/auth semantics.
- [x] 3.2 Migration: add origin metadata to daemon processed local rows, server shared projections, pinned note mirrors, MD imports, preferences, and skills as applicable.
- [x] 3.3 Implementation: require explicit origin in new write APIs; only migration/backfill code may apply defaults.
- [x] 3.4 Failure handling: reject or no-op writes that cannot determine origin outside migration boundaries.
- [x] 3.5 Tests: cover backfill, explicit write paths, invalid origin rejection, reserved cache-origin rejection, and UI/search access to origin without parsing summary text.
- [x] 3.6 Split already-existing daemon-local baseline from new post-1.1/server parity work to avoid duplicate daemon migrations.
- [x] 3.7 Add `shared/memory-scope.ts` with `MemoryScope = 'user_private' | 'personal' | 'project_shared' | 'workspace_shared' | 'org_shared'`, narrow subtypes (`OwnerPrivateMemoryScope`, `ReplicableSharedProjectionScope`, `AuthoredContextScope`), `SearchRequestScope = 'owner_private' | 'shared' | 'all_authorized' | MemoryScope`, and per-scope policy metadata: required/forbidden identity fields, replication behavior, request expansion, raw-source access, and promotion targets.
- [x] 3.8 Add `shared/memory-namespace.ts` and define canonical namespace constructors that bind namespace keys to `MemoryScope` policies; project-bound namespaces MUST use canonical remote-backed `canonicalRepoId`/`project_id`; include `root_session_id`/`session_tree_id` only for session-tree context binding; do not require `projectId` globally for `user_private`; do not introduce ad hoc scope strings or parallel namespace tiers.
- [x] 3.9 Add `shared/memory-observation.ts` with `ObservationClass = 'fact' | 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'preference' | 'skill_candidate' | 'workflow' | 'code_pattern' | 'note'` and typed content JSON validation. `note` is canonical; do not introduce `memory_note`.
- [x] 3.10 Migration: add daemon SQLite namespace and observation tables, plus matching server PostgreSQL tables/migrations using the next available migration numbers at implementation time.
- [x] 3.11 Namespace schema minimum: implement `context_namespaces(id, tenant_id/local_tenant, scope, user_id, root_session_id/session_tree_id, session_id, workspace_id, project_id, org_id, key, visibility, created_at, updated_at)` plus unique/index constraints preventing duplicate canonical namespace keys in the same tenant/scope context; for project-bound scopes `project_id` is canonical remote identity, not cwd/machine/session id.
- [x] 3.12 Observation schema minimum: implement `context_observations(id, namespace_id, scope, class, origin, fingerprint, content_json, text_hash, source_event_ids_json, projection_id, state, confidence, created_at, updated_at, promoted_at)` plus idempotency indexes over namespace/class/fingerprint/text hash.
- [x] 3.13 Projection/observation write semantics: new durable memory writes must write typed observations transactionally with projection aggregate updates or through a repairable outbox path, preserving source event ids, origin, fingerprint, namespace id, and scope.
- [x] 3.14 Backfill: create namespace records for existing projections and lazily backfill observation rows where class/source information is available; old projections must remain readable during backfill.
- [x] 3.15 Scope safety: automatic classification may preserve source scope but must not promote observations from private scopes (`user_private`, `personal`) to shared scopes without explicit authorized user/admin action.
- [x] 3.16 Promotion audit: implement `observation_promotion_audit(id, observation_id, actor_id, action, from_scope, to_scope, reason, created_at)` and allow only web UI Promote, CLI `imcodes mem promote`, and admin API `POST /api/v1/mem/promote` for cross-scope promotion.
- [x] 3.17 Failure handling: interrupted migration/backfill must be restartable; duplicate observations must be idempotently merged or ignored within the same scope.
- [x] 3.18 Tests: namespace migration, observation write/backfill, projection/observation consistency, class validation, idempotency, cross-scope promotion rejection, and promotion audit.
- [x] 3.19 Repair: add a consistency check/repair path for projection rows whose observation outbox/transaction failed midway.
- [x] 3.20 Scope migration: migrate daemon/server/web validators and storage schemas from hard-coded old scope unions to `shared/memory-scope.ts`, preserving legacy `personal` behavior.
- [x] 3.21 Lock project/session context binding: main session and all sub-sessions under the same root share the same project/session context without introducing a new `MemoryScope`; same signed-in user on another device sees the same project-bound memory when canonical `canonicalRepoId` matches and sync/shared policy allows it; sessions outside the root do not receive tree-bound context unless it is also available through existing project/user/shared scopes.
- [x] 3.22 Add `user_private` support: user-bound cross-project private observations/preferences/skills; daemon-local when `mem.feature.user_private_sync=false`; dedicated owner-private server sync route/table with owner-only auth/idempotency when true; owner-only search/startup selection across projects; no writes to `shared_context_projections`.
- [x] 3.23 Legacy backfill: existing `personal` rows stay owner-only and project-bound; automatic migration/backfill MUST NOT classify them as `user_private`; any explicit reclassification requires audited user/admin action and rollback.
- [x] 3.24 Scope filter helpers: quick search, citation lookup, source lookup, startup selection, MCP read tools, web/admin validation, and server SQL must use shared scope policy helpers and `SearchRequestScope` expansion rather than duplicated string lists.
- [x] 3.25 Scope tests: `(NEW) test/context/memory-scope-policy.test.ts`, `(NEW) test/context/session-tree-context-binding.test.ts`, `(NEW) test/context/project-remote-identity-sync.test.ts`, `(NEW) test/context/user-private-scope.test.ts`, `(NEW) test/context/scope-migration.test.ts`, `(NEW) server/test/memory-scope-replication-check.test.ts`, and `(NEW) server/test/memory-scope-authorization.test.ts` covering policy registry, legacy personal compatibility, same-root session tree context binding, same-user same-remote cross-device project visibility, remote alias equivalence, dedicated user-private sync path, owner-only cross-project search, shared-scope membership filtering, promotion target validation, and no hard-coded old enum literals in new code.

## 4. Wave 1 — feature flags and kill switches

**Prerequisites:** origin/fingerprint/scope/namespace design for feature-scoped data.
**Satisfies:** POST11-R4.

- [x] 4.1 Add `shared/feature-flags.ts` with `mem.feature.scope_registry_extensions`, `mem.feature.user_private_sync`, `mem.feature.self_learning`, `mem.feature.namespace_registry`, `mem.feature.observation_store`, `mem.feature.quick_search`, `mem.feature.citation`, `mem.feature.cite_count`, `mem.feature.cite_drift_badge`, `mem.feature.md_ingest`, `mem.feature.preferences`, `mem.feature.skills`, `mem.feature.skill_auto_creation`, and `mem.feature.org_shared_authored_standards`.
- [x] 4.2 Implement or document runtime source-of-truth precedence: runtime config override > persisted local/server config > environment startup default > registry default.
- [x] 4.3 Encode dependencies: `observation_store` requires `namespace_registry`; `citation` requires `quick_search`; `cite_count` and `cite_drift_badge` require `citation`; `skill_auto_creation` requires `skills` and `self_learning`; `org_shared_authored_standards` requires scope registry extensions and shared-context document/version/binding migrations; `namespace_registry` observes scope policies; `scope_registry_extensions` gates new `user_private` writes while preserving legacy scopes; `user_private_sync` requires `scope_registry_extensions`, `namespace_registry`, and `observation_store`.
- [x] 4.4 Wire feature observers so disabled means no background work, no persistent writes, no new reads/RPCs for that feature, and pre-feature or same-shape disabled user-visible behavior.
- [x] 4.5 Failure handling: flag read failure fails closed for new features and never blocks ordinary send ack.
- [x] 4.6 Gate cite-count with `mem.feature.cite_count`; disabled mode stores no new count increments and ignores existing counts in ranking without dropping data.
- [x] 4.7 Gate skill review with `mem.feature.skill_auto_creation`; disabled mode claims no review jobs and creates/updates no skills.
- [x] 4.8 Tests: disabled feature paths skip writes/jobs; runtime disable stops new work within propagation target; dependency-disabled children remain effectively disabled.
- [x] 4.9 Ensure flags are shared constants, not duplicated daemon/server/web literals.
- [x] 4.10 Add daemon-persisted management overrides for feature flags: `memory.features.set` requires management context, validates closed registry names, cascades enable requests to dependencies, persists requested values above env startup defaults, returns requested/effective/source/dependency metadata, fails closed on missing context, malformed requests, or config write failures, and covers persistence plus dependency-blocked semantics in daemon tests.

## 5. Wave 1 — telemetry and silent-failure tracking

**Prerequisites:** feature flags for rollout safety.
**Satisfies:** POST11-R5, POST11-R16.

- [x] 5.1 Add `shared/memory-counters.ts` with the closed counter registry from `design.md`, including citation count, preference duplicate/reject, skill review throttle/dedupe/failure, and observation promotion counters.
- [x] 5.2 Design async bounded telemetry buffer, sampling, retention, and PII/secrets boundaries.
- [x] 5.3 Implement non-blocking metric/audit enqueue path; sink failure must not affect memory behavior.
- [x] 5.4 Instrument intentional soft-fail paths in startup memory, search, citation, cite-count, MD ingest, skills, skill review, preferences, materialization, observations, and classification.
- [x] 5.5 Failure handling: buffer overflow drops/samples predictably without throwing in hot paths.
- [x] 5.6 Tests: telemetry sink timeout/reject does not block send, materialization, search, citation, skill load, skill review, MD ingest, or shutdown; labels reject free-form identifiers.
- [x] 5.7 Retention: define and test retention/pruning for persistent audit/idempotency tables introduced by this change.

## 6. Wave 1 — startup budget and named-stage selection

**Prerequisites:** telemetry for overrun visibility; render policy draft.
**Satisfies:** POST11-R6.

- [x] 6.1 Add `shared/memory-defaults.ts` mirroring the `design.md` `design-defaults` JSON5 block.
- [x] 6.2 Add `test/spec/design-defaults-coverage.test.ts` to fail when design defaults drift from shared constants.
- [x] 6.3 Refactor startup selection into collect, prioritize, apply quotas, trim, dedup, render stages.
- [x] 6.4 Failure handling: stage failure omits that source and emits telemetry; ordinary send ack remains independent.
- [x] 6.5 Tests: over-budget fixtures trim in priority order and final output stays within budget.
- [x] 6.6 Acceptance: existing startup memory behavior remains compatible when new sources are disabled.

## 7. Wave 1 — typed render policy

**Prerequisites:** startup stage API.
**Satisfies:** POST11-R7.

- [x] 7.1 Define render kinds `summary`, `preference`, `note`, `skill`, `pinned`, and `citation_preview`.
- [x] 7.2 Centralize per-kind render functions and prohibit ad-hoc formatting in feature code.
- [x] 7.3 Add `shared/skill-envelope.ts` constants and delimiter collision policy.
- [x] 7.4 Failure handling: render failure for one item drops that item with telemetry, not the whole send/startup path.
- [x] 7.5 Tests: pinned remains verbatim, skill is enveloped/capped, delimiter collisions are escaped/rejected, citation preview omits unauthorized raw source, and shared constants are used.

## 8. Wave 1 — sync semantics and hardening gates G1-G6

**Prerequisites:** feature flags and telemetry.
**Satisfies:** POST11-R1, POST11-R16, operational hardening.

- [x] 8.1 Send ack matrix: test ack before pending relaunch, transport lock, bootstrap, recall, embedding, feature-flag read, MD ingest, skill load, quick-search/citation lookup, telemetry, skill review, and provider send-start.
- [x] 8.2 Recall/bootstrap degrade: timeout/failure still sends original user message to SDK/provider without failed memory payload and without spinning.
- [x] 8.3 `/compact`: remains SDK-native pass-through; no daemon-side synthetic compaction or interception; every transport receives slash controls as raw provider-control payloads without daemon-added startup memory, per-turn recall, preference preambles, authored context, or extra per-turn system prompt; Codex SDK maps the raw command to app-server `thread/compact/start` instead of sending it as model text; Codex SDK settles runtime busy state from `thread/compacted`, `contextCompaction` completion, `turn/completed`, status-idle, or a bounded accepted/no-signal fallback, accepts camelCase/snake_case thread/turn identifiers, and emits a bounded retryable error instead of leaving `Agent working...` forever.
- [x] 8.4 `/stop` and approval/feedback: priority path bypasses normal send locks, memory work, and provider cancel waits.
- [x] 8.5 Materialization/worker repair: stale jobs reset, dirty pending refs clear, active recall contains no local-fallback/raw-transcript pollution.
- [x] 8.6 Persistent audit/telemetry/idempotency retention sweeper exists for any persistent audit/idempotency table introduced by this change.
- [x] 8.7 G1: add concurrent-write retry or optimistic concurrency tests for new write paths that update projections/preferences/skills/cite-counts/observations.
- [x] 8.8 Add a Codex SDK final injected-context cap: default 32,000 chars for daemon-added context, bounded env override, preserve user turn text, and cover with provider regression tests so memory/preference/skill/MD context cannot silently trigger repeated SDK auto-compaction.
- [x] 8.8 G3/G6: per-feature sanitizer and kill-switch wiring must land in the same PR as each feature or earlier.

## 9. Wave 2 — self-learning memory

**Prerequisites:** 2.x, 3.x, 4.x, 5.x, 7.x, 8.x.
**Satisfies:** POST11-R8.

- [x] 9.1 Define classification and dedup-decision output enums, storage fields, startup-state tags, and scope constraints.
- [x] 9.2 Add classify/dedup/durable-signal phases to the existing isolated compression/materialization pipeline; do not create a new foreground agent/session.
- [x] 9.3 Add cold/warm/resumed startup-state switching using named-stage startup policy and budget caps; render policy remains owned by 7.x.
- [x] 9.4 Failure handling: classification/dedup failures must not block ordinary send, write fallback pollution, or delete retryable staged events incorrectly.
- [x] 9.5 Tests: scope-bounded classification, dedup source-id union, redaction/pinned preservation, failure degrade, startup state switching.
- [x] 9.6 Ensure feature flag disablement stops new classification/dedup work.

## 10. Wave 3 — quick search, citations, cite-count, and fast-path reads

**Prerequisites:** fingerprint, origin, namespace/observation, render policy, feature flags, scope helpers.
**Satisfies:** POST11-R9, POST11-R10, POST11-R15.

- [x] 10.1 Define quick-search result shape, ranking inputs, rate/latency budget, authorized preview format, and same-shape disabled envelope.
- [x] 10.2 Use existing/shared scope filtering helpers for all server/daemon memory search queries; do not write bespoke cross-scope predicates.
- [x] 10.3 Define same-shape user-facing missing/unauthorized/disabled lookup envelope and forbid role diagnostics, source counts, hit counts, drift metadata, raw source text, and cross-scope ids unless authorized.
- [x] 10.4 Add citation insertion by projection identity and per-insertion `created_at`; no raw source snapshot in current wave.
- [x] 10.5 Add citation identity/idempotency storage. Authoritative store derives the key; untrusted clients must not provide it. Required properties: same citing message retry/replay dedupes; different citing message for same authorized projection increments once.
- [x] 10.6 If stable citing message identity is available, use `sha256("cite:v1:" + scope_namespace + ":" + projection_id + ":" + citing_message_id)`; otherwise add a preliminary stable `citing_message_id` task before cite-count can be enabled.
- [x] 10.7 Add drift badge using canonical persistent `content_hash` captured at citation time and recomputed from normalized projection content; daemon/server projection write paths must persist the marker, and maintenance writes/idempotent upserts that do not change normalized content must not change the hash or create false drift.
- [x] 10.8 Web gate: all user-visible strings use `t()` and every locale in `SUPPORTED_LOCALES`; shared protocol/status strings use shared constants.
- [x] 10.9 Tests: search scope isolation, full JSON shape equality for unauthorized/missing/disabled, citation insertion, drift badge, no raw source in preview, web i18n/a11y.
- [x] 10.10 Cite-count migration: add daemon SQLite and server PostgreSQL `cite_count` storage or an auxiliary citation counter table using next available migration numbers, plus lazy backfill/defaults where existing projections lack counts.
- [x] 10.11 Cite-count behavior: increment at most once per citation idempotency key; retries/replays must not inflate counts; unauthorized/missing citation attempts must not reveal or increment counts; ranking must use cite_count only after scope filtering.
- [x] 10.12 Ranking integration: when `mem.feature.cite_count=true`, quick-search ranking must include a bounded cite-count signal without replacing semantic score or existing `hitCount`; when disabled, existing counts are ignored without data loss.
- [x] 10.13 Abuse/concurrency: rate-limit citation count pumping, handle concurrent increments safely, and prevent cross-scope count leakage.
- [x] 10.14 Cite-count tests: storage migration, idempotent increment, replay dedup, different citing message increments, feature flag disabled behavior, cross-scope non-leakage, unauthorized no-increment, hot-row/concurrency, and ranking after auth filtering.

## 11. Wave 4 — MD ingest, preferences, and unified bootstrap

**Prerequisites:** fingerprint, origin, namespace/observation, feature flags, telemetry, startup policy, render policy.
**Satisfies:** POST11-R11, POST11-R12.

- [x] 11.1 Define supported MD paths/triggers, parser section classes, resource caps, partial-commit semantics, and no-fs-watch rule.
- [x] 11.2 Add bounded MD ingest with stable fingerprint, origin `md_ingest`, idempotent projection-backed writes plus linked observations, feature flag, fail-closed scope validation for unsupported `user_private`/workspace/org filesystem ingest, and production bootstrap/manual-sync worker wiring that stays out of the ordinary send ack path and permits later re-ingest after prior jobs finish.
- [x] 11.3 Unify startup memory, preferences, project/user context, and future skills through named-stage bootstrap.
- [x] 11.4 Add `shared/send-origin.ts` and `session.send.origin` contract; missing origin defaults to `system_inject`, which is untrusted for preference writes.
- [x] 11.5 Accept persistent `@pref:` only from trusted user origins; leading trusted raw `@pref:` command lines persist idempotently, are stripped from user-visible/provider-bound user text, and their preference content is rendered into controlled provider-visible preference context for the same turn and as session-level stable context on the first later eligible turn, but identical rendered preference context MUST NOT be repeated on every send; compact/clear boundaries reset the injection gate; ack does not wait for persistence or preference context work.
- [x] 11.6 Preference idempotency: dedupe trusted resends/retries by command/message identity plus user/scope/fingerprint; emit `mem.preferences.persisted` only after actual persistence succeeds, `mem.preferences.duplicate_ignored` for replayed writes, `mem.preferences.persistence_failed` on write failure, and `mem.preferences.rejected_untrusted`/`mem.preferences.untrusted_origin` for untrusted origins.
- [x] 11.7 Failure handling: oversize, symlink-disallowed, unreadable, invalid encoding, malformed section, and prompt-injection-like content fail closed per section and emit telemetry.
- [x] 11.8 Tests: idempotent ingest, caps, partial valid section commit, projection/observation linkage, no cross-project/user-private/workspace/org promotion or silent downgrade, per-file provenance preservation for identical section text, repeated schedule re-ingest, agent-emitted `@pref:` rejected, missing-origin fail-closed for preference persistence, trusted raw-command strip plus provider-visible preference context injection, persisted preference reuse as one-shot session context rather than per-turn prompt growth, compact reset/re-injection, queued-send preamble preservation, disabled pass-through, resend idempotency, startup budget compatibility.
- [x] 11.9 Ensure `mem.feature.preferences` disabled path passes text through without persistence/strip.
- [x] 11.10 Add web/daemon management UI for trusted preference records: list active persisted preferences, create an explicit user-scoped preference, delete stale preferences, and keep all messages/constants/i18n shared.
- [x] 11.11 Add web/daemon manual MD ingest control with explicit project directory, canonical project id, scope, result counters, and no silent scope downgrade.
- [x] 11.12 Add daemon/Web management feature-state and fail-closed mutation guards: feature-disabled preference writes/deletes and manual MD ingest runs are rejected with shared error codes and localized UI messages; manual MD ingest rejects missing canonical project identity before file reads.
- [x] 11.13 Audit closure: MD parser production defaults derive from `shared/memory-defaults.ts`, including `markdownMaxBytes`, `markdownMaxSections`, `markdownMaxSectionBytes`, and `markdownParserBudgetMs`; parser-default tests cover oversize, section-count, and parser-budget failure behavior.

## 12. Wave 5 — enterprise authored standards, skills subsystem, and background skill review

**Prerequisites:** fingerprint, origin, namespace/observation, scope registry, feature flags, telemetry, render policy, shared-context document/version/binding migrations, G3 sanitizer.
**Satisfies:** POST11-R13, POST11-R14, POST11-R15, POST11-R16, POST11-R19.

- [x] 12.1 Define skill metadata/front matter, project association, escape hatch `<project>/.imc/skills/`, workspace/org shared mirrors, and empty built-in manifest schema.
- [x] 12.2 Add user-level skill storage under `~/.imcodes/skills/{category}/{skill-name}.md`.
- [x] 12.3 Implement ordinary precedence: project escape hatch, project-scoped user metadata, user default, workspace shared, org shared, built-in fallback. Built-in fallback is lowest precedence and must not override any user/project/workspace/org skill.
- [x] 12.4 Implement enforced policy as a separate workspace/org override axis; default Wave 5 admin-pushed skills are additive unless explicitly enforced.
- [x] 12.5 Add admin-only workspace/org skill push and reject unauthorized pushes without inventory leakage.
- [x] 12.6 Expose selected skills through a provider-visible registry hint containing bounded metadata and redacted readable paths/`skill://` URIs sourced from a maintained skill registry; ordinary startup/send must not scan or read every skill markdown body, and any full-body read must be on-demand through the resolver plus `shared/skill-envelope.ts`, system-instruction guard, and 4KB cap.
- [x] 12.7 Packaging: add `shared/builtin-skill-manifest.ts`, ship empty `dist/builtin-skills/manifest.json`, and ensure npm/Docker package includes the empty built-in layer.
- [x] 12.8 Web/i18n gate: skill failure states, disabled states, and layer diagnostics use `t()` and all supported locales.
- [x] 12.9 Tests: precedence conflicts, enforced/additive semantics, project association, sanitizer fixture set, delimiter collision negative fixture, empty manifest loads zero skills without error, admin authorization, i18n/shared constants.
- [x] 12.10 Skill auto-creation/self-improvement: run only after response delivery through the existing isolated compression/materialization background path; add `shared/skill-review-triggers.ts` with closed triggers `tool_iteration_count` and `manual_review`; require completed visible non-error tool-result evidence meeting `skillReviewToolIterationThreshold` before automatic `tool_iteration_count` enqueue while allowing explicit `manual_review`; provide a daemon-local production worker/scheduler that creates or updates deterministic user-level skills using matching skill keys before creating new files and updates the skill registry immediately after successful writes; never block send ack, provider delivery, `/stop`, approval/feedback, or shutdown; enforce coalescing, per-scope concurrency, min-intervals, daily caps, bounded retry/backoff, idempotency, disabled-feature behavior, and repair tests.

- [x] 12.11 Enterprise authored standards: model enterprise-wide coding standards/playbooks as `org_shared` authored context bindings (`enterprise_id` set, `workspace_id = NULL`, `enrollment_id = NULL`) behind `mem.feature.org_shared_authored_standards`, never as `global` / `namespace_tier=global` / unscoped memory. Disabling the flag must stop new org-wide mutation/selection without affecting unrelated project/workspace shared-context bindings.
- [x] 12.12 Authorization: only enterprise owner/admin may create/update/activate/deactivate org-shared documents, versions, and bindings; members may read only matching active bindings; non-members and other enterprises receive same-shape not-found/unauthorized responses without inventory leakage.
- [x] 12.13 Runtime selection: project bindings override/precede workspace bindings, workspace bindings override/precede org bindings; required org-shared bindings must be preserved or dispatch fails, advisory org-shared bindings may be trimmed only with diagnostics/telemetry; optional repo/language/path filters narrow applicability only.
- [x] 12.14 Tests: add `server/test/shared-context-org-authored-context.test.ts` plus runtime resolver/web diagnostics coverage for org-wide standard creation, admin-only mutation, member-only runtime selection, project/workspace/org precedence, required/advisory behavior, filter narrowing, and cross-enterprise non-leakage.

- [x] 12.15 Add skill registry/on-demand regression tests: startup registry hint works without existing skill body files, unrelated turns do not read skill bodies, explicit/matching resolver reads only the selected skill, stale/unauthorized resolver paths fail closed, and provider-visible hints never expose absolute home paths.
- [x] 12.16 Split skill-review telemetry so below-threshold/non-eligible evidence is distinguishable from true throttling; hidden/error tool results must not contribute to automatic `tool_iteration_count` evidence.
- [x] 12.17 Add web/daemon skill registry management UI: list registry metadata, rebuild registry only on explicit operator action, preview selected skill body on demand, delete managed skill files safely, and preserve startup manifest-only behavior.
- [x] 12.18 Add web/daemon observation-store management UI: list typed observations with scope/class filters and promote observations only through explicit audited UI actions.
- [x] 12.19 Harden skill management UI/API: skill preview rejects symlink/non-file or polluted registry paths, feature-disabled skill mutations/read-body actions fail closed, and registry management writes invalidate runtime registry cache.
- [x] 12.20 Audit closure: skill registry reads fail closed on entry-count overflow, registry display paths are sanitized to redacted paths or `skill://` URIs before provider-visible startup hints, and skill auto-review counters/evidence are scoped to the current day/completed turn rather than daemon lifetime or accumulated unrelated turns.

## 13. Later candidates retained but not current blockers

The following are backlog notes only. They are not checkboxes and do not block Wave 1-5 completion until promoted by a future OpenSpec delta:

- Drift recompaction loops, prompt caching, topic-focused compact/context-selection behavior that still must not daemon-intercept `/compact`, LLM redaction, built-in skill content harvest, autonomous prefetch/LRU, and quick-search result caching. Authorization-scope registry work, including `user_private`, dedicated user-private sync, namespace registry, observation store, cite-count ranking, preferences, enterprise org-shared authored standards, and skill auto-creation are current Wave 1-5 scope, not backlog.
- Future MCP exposure beyond the read/search behavior explicitly scoped here.

## 14. Final validation

- [x] 14.1 Run `openspec validate memory-system-post-1-1-integration`.
- [x] 14.2 Run daemon typecheck/build and targeted daemon tests for changed memory modules.
- [x] 14.3 Run server typecheck/tests for migrations, embeddings, search, authorization, and scope filtering when touched.
- [x] 14.4 Run web typecheck/tests for quick search, citation UI, skills UI, i18n, locale coverage, and accessibility when touched.
- [x] 14.5 Update and run the canonical memory acceptance harness so it validates `memory-system-post-1-1-integration`; `bash scripts/run-acceptance-suite.sh` validates this change id and includes daemon/server/web tests plus integration coverage.
- [x] 14.6 Before marking Wave 1-5 complete, rerun the traceability matrix and confirm every requirement has passing test evidence.
- [x] 14.7 Validate post-1.1 management UI with web component coverage for preferences, skills, MD ingest controls, and observation promotion, daemon WebSocket handler coverage for management messages, plus daemon/web typechecks.
- [x] 14.8 Validate management UI hardening: feature-state display, localized shared error codes, disabled mutation guards, canonical-project-id MD ingest rejection, skill registry cache invalidation, and symlink-safe skill preview paths.
- [x] 14.9 Validate memory project-index synchronization: daemon personal-memory response includes project summaries, cloud/shared routes include authorized `projects` arrays, semantic memory view preserves project summaries after scoring, the Web memory tab defaults browse to all projects, memory-index options remain available after selecting/clearing a project filter, realpath project-directory aliases resolve successfully, and targeted daemon/server/web tests plus daemon/server/web typechecks pass.

## 15. Management UI hardening closure

**Prerequisites:** 11.x preference/MD management, 12.x skill/observation management, and bridge routing.
**Satisfies:** POST11-R15, POST11-R20.

- [x] 15.1 Add a closed memory-management WebSocket request/response vocabulary in `shared/memory-ws.ts` and route management responses by pending `requestId` instead of the default browser broadcast path.
- [x] 15.2 Inject server-derived management context in `server/src/ws/bridge.ts`; daemon management handlers must use the injected actor/user/role/project context and ignore client-supplied owner/actor/role fields for authorization. Elevated roles are derived from server membership for the requested enterprise/workspace/project binding, never from browser payloads.
- [x] 15.3 Harden preference management: query/create/delete only the derived current user's preferences, reject non-owner delete with a shared error code, and use stable request/fingerprint idempotency rather than random retry identity for explicit creates.
- [x] 15.4 Harden observation management: filter private observations by derived owner, require explicit role authorization for private-to-shared promotion, verify `expectedFromScope` inside the promotion transaction, and publish cache invalidation after successful promotion.
- [x] 15.5 Harden manual MD ingest: require valid `projectDir`, canonical project identity, and matching repository identity before file reads; unsupported filesystem ingest scopes return a typed error instead of success+0 or silent downgrade.
- [x] 15.6 Harden skill management/runtime paths with a single managed-path helper, rejecting NUL, symlink directories, final symlinks/non-files, path escape, oversize previews, and oversized registry files/entry lists before unbounded parsing.
- [x] 15.7 Add runtime memory cache invalidation for preference, skill registry, MD ingest, and observation management mutations so subsequent startup/send context is not stale.
- [x] 15.8 Harden the Web management UI: latest-requestId guards per surface, mutation buttons disabled while feature state is unknown/disabled, supported MD scopes only, current-user preference create semantics, localized shared error codes in all supported locales, canonicalRepoId payload coverage for project-bound management actions, non-color feature-state accessibility labels, and regression coverage in `web/test/components/SharedContextManagementPanel.test.tsx`.
- [x] 15.9 Validation anchors added/run: `server/test/bridge-memory-management.test.ts`, `test/daemon/command-handler-memory-context.test.ts`, `test/daemon/command-handler-transport-queue.test.ts`, `test/daemon/context-store.test.ts`, `test/context/memory-search.test.ts`, `test/context/skill-registry-resolver.test.ts`, `test/context/context-observation-store.test.ts`, `test/context/memory-feature-flags.test.ts`, `web/test/components/SharedContextManagementPanel.test.tsx`, `web/test/i18n-coverage.test.ts`, and `web/test/i18n-memory-post11.test.ts`.
- [x] 15.10 Audit closure: management handlers fail closed when authenticated management context is absent, management personal/search/archive/restore/delete use the same authorization envelope as observation/preference handlers, raw search is not exposed through the management UI path, Web management requests carry project identity hints needed for server-injected bound-project authorization, and bridge context-construction failures clear pending requests with a requester-only error.
- [x] 15.11 Add daemon-backed memory project resolution: `memory.project.resolve` accepts only daemon-known project directories, derives canonical repo identity from the git remote, rejects invalid/mismatched/unauthorized directories, and returns a routed status response.
- [x] 15.12 Replace primary manual project ID/path entry in the memory UI with a searchable project selector sourced from active/recent sessions and enterprise canonical projects; wire old memory views plus skills/MD/observation actions to the selected identity, keep manual fields as advanced fallback only, add productized tabs/search controls, i18n keys, and regression coverage.
- [x] 15.13 Synchronize project browse indexes across local daemon, personal cloud, enterprise/shared, and semantic memory views: `ContextMemoryView.projects` / `ContextMemoryProjectView` provide authorized project summaries; daemon `PERSONAL_RESPONSE` includes `listMemoryProjectSummaries`; server memory routes and semantic memory views return project summaries after auth filters; the web project dropdown merges memory-index options, keeps all-project as the default/no-filter browse state, separates browse filtering from local file-backed action project selection, preserves options across filtered reloads, resolves directory aliases by realpath before local tools run, updates all locales for `memory_index`/local-action wording, and covers the behavior in daemon/server/web tests.
- [x] 15.14 Add management UI enable/disable controls for daemon memory feature flags: feature cards expose localized toggle buttons, send shared `memory.features.set` requests with requestId guards, render dependency-blocked requested-vs-effective state as a distinct warning rather than plain disabled, refresh downstream panes after a change, and cover the behavior in web component tests plus all locale files.
- [x] 15.15 Improve observation promotion usability: promotion buttons disclose the selected target scope, invalid from/to scope pairs are disabled before mutation, the first click opens an explicit confirmation showing source scope, target scope, optional reason, audit write, and visibility consequence, and only the confirmation action sends `memory.observation.promote`; cover the two-step flow with web component tests and all locale files.
- [x] 15.16 Add complete management CRUD for local memory records and preferences: processed memory supports manual project-bound create, edit, archive/restore/delete, and deterministic pinning with server-derived authorization, linked projection/observation updates, linked-observation cleanup on permanent delete, embedding invalidation, cache invalidation, shared WS constants, localized UI strings, and daemon/web regression tests; preferences support update in addition to existing create/delete, and observations support edit/delete in addition to audited promotion. Store and display record-level owner/creator/updater metadata separately from enterprise/workspace admin role; private records remain owner-only, and shared records are mutable by admins or the record creator/owner only after namespace authorization.

## 16. Transport sender identity audit closure

**Prerequisites:** foundations send ack/priority path and transport SDK session env construction.
**Satisfies:** POST11-R1, POST11-R20 operational diagnostics.

- [x] 16.1 Transport session launch and restore construct per-session `SessionConfig.env` for every transport runtime using `IMCODES_SESSION` and `IMCODES_SESSION_LABEL`; local SDK/CLI providers that can pass tool/runtime environment MUST preserve that env, and any non-env-capable transport MUST provide an equivalent non-prompt adapter instead of relying only on prompt text.
- [x] 16.2 Add regression coverage proving transport sender identity is runtime-visible: Codex SDK app-server thread/turn requests carry per-session env, Claude SDK restored/launched transport sessions carry the same env into SDK query options, and CLI sender detection prefers `IMCODES_SESSION` over labels.
- [x] 16.3 Codex SDK context usage uses app-server `thread/tokenUsage/updated.tokenUsage.last` plus `modelContextWindow` for the UI ctx meter, falling back to `total` only when `last` is absent; it normalizes Codex/OpenAI cached tokens as a subset (`inputTokens - cachedInputTokens` new input plus `cacheTokens`) so the visible total equals the current-window input token count, and keeps cumulative totals only as diagnostics; regression coverage locks the provider and transport relay mappings so ctx does not inflate from accumulated billing/thread totals.
- [x] 16.4 Carry a provider-sourced context-window marker from Codex SDK/native Codex usage events through timeline extraction into Web ctx rendering, and lock the UI rule that provider-marked `modelContextWindow` wins over model-family inference except known stale/mismatched provider fallbacks; GPT-5.5 is a locked 922k model-window override for both too-low (`258400`) and too-high (`1000000`) Codex fallback values, while unmarked legacy/stale explicit windows keep the existing model-inference precedence.
- [x] 16.5 Resolve transport usage events against the persisted session model when provider usage omits `model`, so two sessions selected as GPT-5.5 cannot split between stale provider fallback windows (`258400` / `1000000`) and instead both render the locked 922k context limit; regression coverage locks no-model usage updates with stale and missing provider context-window values.

## 17. P2P strict audit closure — management authorization follow-up

**Prerequisites:** 15.x management UI hardening and P2P discussion `7b9def0b-86f`.
**Satisfies:** POST11-R17, POST11-R18, POST11-R20.

- [x] 17.1 Management quick search and personal-memory management queries use an authorized namespace/scope+owner filter before result item construction, stats, pending-record counts, and pagination; caller-owned `personal` rows are included only for the derived current user, and other users' `personal` rows in the same project are excluded; daemon-local processed/staged/dirty/job tables maintain backfilled indexed scope/owner/project columns so these filters execute in SQL before JS result construction.
- [x] 17.2 Owner-private namespace authorization fails closed when `personal` / `user_private` owner identity is missing or does not match the derived management user.
- [x] 17.3 Project-scoped skill management requires explicit canonical repo identity plus project directory validation against the git remote before registry read/rebuild/preview/delete; generic `projectId` is not used as a role-derivation alias.
- [x] 17.4 Observation promotion requires `expectedFromScope` before promotion and returns a shared/localized error when omitted.
- [x] 17.5 Bridge regression coverage locks unauthenticated rejection, duplicate requestId rejection, pending-request cap, forged context stripping, and generic `projectId` non-elevation.
- [x] 17.6 Targeted tests cover management authorized search owner isolation, personal-memory list/search/pending owner isolation, authorized stats/pagination, same-user different-scope exclusion, daemon-local namespace filter index/backfill coverage, and expected-scope promotion rejection.
- [x] 17.7 Bridge authorization closure: browser-provided canonical repo/workspace/org hints enter `boundProjects` only after server membership/enrollment verification; unauthorized hints forward as request hints but authorize no shared daemon access.
- [x] 17.8 Metadata trust closure: record-level authorization uses trusted `ownerUserId` / `ownedByUserId` / `createdByUserId` only, while legacy/display fields (`userId`, `createdBy`, `authorUserId`, `updatedBy`) remain display-only and cannot grant shared mutation rights.
- [x] 17.9 Store consistency closure: observation delete is observation-only, processed-memory delete remains the projection+linked-observation cleanup path, and observation edits clear linked projection embeddings just like processed-memory edits.
- [x] 17.10 Feature/caching closure: processed-memory create/update/archive/restore/delete/pin fail closed when `mem.feature.observation_store=false`, and runtime memory cache invalidation distinguishes projection mutations from observation mutations.
- [x] 17.11 Validation anchors added/run: `server/test/bridge-memory-management.test.ts`, `test/daemon/command-handler-memory-context.test.ts`, and `test/context/context-observation-store.test.ts` cover verified bridge bindings, legacy metadata forgery rejection, processed mutation feature-disabled guards, observation-only delete, typed promotion errors, and linked-embedding invalidation.
