## Context

`memory-system-1.1-foundations` established the memory pipeline baseline: durable archive/source provenance, tokenizer budgeting, bounded materialization, redaction, scope-aware read tools, SDK-native `/compact`, immediate daemon-receipt send ack, `/stop` plus approval/feedback priority, bounded fail-open recall/bootstrap, provider send-start watchdogs, and local materialization repair.

Post-1.1 work in `docs/plan/mem1.1.md` is broad and interdependent. Quick search and citations depend on stable projection identity, scope filtering, render policy, and replay-safe citation identity. Preferences, markdown ingest, and skills depend on origin metadata, feature flags, telemetry, and startup-budget rules. Self-learning dedup must preserve scope and provenance. Authorization scope registry, namespace registry, and typed observations are schema work, but schema migration is not a deferral reason on dev. Every feature must preserve foundations send/stop/compact liveness.

## Goals / Non-Goals

**Goals:**

- Make `memory-system-post-1-1-integration` the single implementation contract for post-1.1 memory waves.
- Land operational primitives before feature work: fingerprints, origins, namespace registry, typed observations, flags, telemetry, budgets, render policy, and repair/backoff/idempotency gates.
- Preserve existing scope semantics and promote scope extensions into a shared policy registry: `user_private`, `personal`, `project_shared`, `workspace_shared`, and `org_shared`. Session-tree membership is a context/namespace binding, not a separate authorization scope. Enterprise-wide shared standards use `org_shared`, not a new global namespace/scope.
- Preserve foundations liveness and safety invariants in every wave.
- Promote authorization-scope registry, cite-count ranking, namespace/observation storage, enterprise org-shared authored standards, and skill auto-creation into current Wave 1-5 scope with concrete migration/test requirements.
- Make every requirement traceable to tasks, code areas, and tests.
- Keep new behavior disabled/fail-closed until feature-specific acceptance passes.

**Non-Goals:**

- Do not create separate implicit changes for Phase 1.5/1.6/1.7/1.8/1.9/1.7-O.
- Do not make later Phase 2/3 candidates blockers for Wave 1-5 completion.
- Do not reintroduce daemon-side `/compact` interception.
- Codex SDK provider dispatch has a final injected-context hard cap: daemon-added system/preference/memory/skill/shared-context text is capped to **32,000 characters** by default (`IMCODES_CODEX_SDK_CONTEXT_MAX_CHARS`, clamped 4,000-128,000). The current user turn text is not truncated by this guard; oversized user-provided content remains the user's responsibility.
- Do not make ordinary send ack wait for memory lookup, skill load, MD ingest, classification, telemetry, relaunch, transport lock, bootstrap, recall, embedding, provider send-start, or provider settlement.
- Do not introduce ad hoc authorization strings, a parallel namespace-tier taxonomy, or a separate session-tree authorization scope outside `shared/memory-scope.ts`; every actual scope must have an explicit policy, migration, auth filter, UI/admin behavior, and tests.
- Do not emit or implement quick-search cache origins in this milestone; cache origins are reserved until a future change defines TTL, invalidation, auth binding, and side-channel behavior.
- Do not run skill auto-creation/self-improvement in the ordinary send ack path and do not spawn a new foreground agent/session for it. Built-in skill content harvest, autonomous prefetch/LRU, and Hermes RL/model fine-tuning remain outside the current milestone.

## Capability and Artifact Ownership

- `proposal.md` defines why this is one change and where the completion boundary sits.
- `design.md` defines architecture, sequencing, defaults, migration/rollback, security, performance budgets, and plan mapping.
- `specs/daemon-memory-post-foundations/spec.md` defines runtime behavior for all current post-1.1 waves and hard foundations regression requirements.
- `tasks.md` defines executable work items with prerequisites, traceability, failure handling, tests, and acceptance gates.
- `specs/daemon-memory-pipeline/spec.md` is an archive-time migration target. Once `memory-system-1.1-foundations` is archived and `daemon-memory-pipeline` exists in cumulative OpenSpec specs, foundations-touching requirements from this change MUST move into that capability as `## MODIFIED Requirements` before this change is archived. This is artifact migration only; current runtime requirements remain binding here.

## Wave Model

1. **Wave 1 — Operational foundation and hardening gates.** Stable fingerprints, origin metadata, authorization scope policy registry, first-class namespace registry, multi-class observation store, feature flags, telemetry, startup budget, named-stage selection, typed render policy, sync semantics, and G1-G6 gates.
2. **Wave 2 — Self-learning memory.** Scope-bound classification/dedup/durable extraction and cold/warm/resumed startup-state selection.
3. **Wave 3 — Quick search, citations, and cite-count.** Authorized search, citation identity, drift indication, replay-safe cite-count, source lookup safety, ranking integration, and web integration.
4. **Wave 4 — MD ingest, preferences, and unified bootstrap.** Bounded notes ingest, user-only `@pref:` trust boundary, and unified startup context.
5. **Wave 5 — Enterprise authored standards and skills.** Enterprise org-shared authored standards, safe skill storage/import/render/admin foundations, layer precedence, project association, admin authorization, sanitization, packaging, safe rendering, and post-response skill auto-creation/self-improvement via the existing isolated compression/materialization path.

Later candidates remain backlog notes only until promoted with requirements/tasks/tests.

## Plan Mapping

| Source plan area | Current disposition | Notes |
| --- | --- | --- |
| Phase 1.9 operational foundation | Included in Wave 1 | Fingerprints, origins, authorization scope registry, namespace registry, multi-class observation store, flags, telemetry, startup budgets, render policy, hardening gates. |
| Phase 1.5 self-learning | Included in Wave 2 | Uses existing isolated compression/materialization path; failures fail open for user delivery. |
| Phase 1.6 quick search + cite | Included in Wave 3 | Search, citation insertion, drift badge, same-shape unauthorized/missing lookup. |
| Phase 1.6 cite-count | Included in Wave 3 | Storage, increment triggers, replay/idempotency, ranking input, auth constraints, migrations, and tests are current scope. |
| Phase 1.6 autonomous prefetch / LRU | Deferred | Plan already marks no prefetch/no LRU for current wave. |
| Phase 1.7 MD ingest/preferences/bootstrap | Included in Wave 4 | No fs.watch; trusted triggers only; `@pref:` user-origin only. |
| Phase 1.8 skills storage/import/render/admin | Included in Wave 5 | Safe storage/import/render/admin foundations. |
| Phase 1.8 skill auto-creation/self-improvement | Included in Wave 5 | Runs only after response delivery through the existing isolated compression/materialization background path; it must not block send ack, provider delivery, `/stop`, feedback, or shutdown, and must not spawn a new foreground agent/session. |
| Built-in skill content harvest | Deferred | Wave 5 ships loader-ready empty manifest only. |
| Authorization scope extensions / namespace extensions / typed observations | Included in Wave 1 | Implement `shared/memory-scope.ts` scope policies, first-class namespace registry, and scope-bound `context_observations`/server equivalent. Current scope set is `user_private`, `personal`, `project_shared`, `workspace_shared`, and `org_shared`; session tree is represented by namespace/context binding (`root_session_id` / `session_tree_id`) rather than a new scope; no ad hoc scope strings outside the registry. |
| Enterprise-wide shared standards | Included in Wave 5 shared-context foundations | Use `org_shared` authored context bindings for enterprise-global coding standards/playbooks. Do not introduce `global`, `namespace_tier=global`, or unscoped cross-enterprise memory. |
| Drift recompaction / prompt caching / LLM redaction | Deferred | Deferred for behavioral/rollout complexity, not because of migration. Drift recompaction may be promoted after cite-count/drift signals are stable. |
| Quick-search result cache | Deferred | Deferred for cache safety semantics, not because of migration. No `quick_search_cache` origin may be emitted in this milestone because cache TTL/invalidation/auth semantics are not in scope. |
| Transport send stability | Included as cross-wave regression gate | Locks current dev ack/priority behavior. |

## Cross-Wave Vocabularies and Shared Constants

Implementation MUST add or reuse shared constants rather than duplicating literals. Expected shared files:

- Project identity source of truth
  - Durable project-scoped memory MUST key by canonical repository identity, not by device, cwd, session name, or local path.
  - The canonical key is `canonicalRepoId` produced by the existing repository identity service from normalized git remote (`host/owner/repo`), with repository aliases for SSH/HTTPS equivalence and explicit migrations.
  - Same signed-in user + same `canonicalRepoId` across laptop/desktop MUST resolve to the same project context for `personal` project-bound memory and enrolled shared project memory.
  - `machine_id` is provenance/conflict metadata only; it MUST NOT be part of authorization or project identity when a canonical remote exists.
  - Repositories without a usable remote may use local fallback identity, but that fallback is not cross-device project identity until the user enrolls/aliases it to a canonical remote.
- `shared/memory-scope.ts`
  - `MEMORY_SCOPES = ['user_private', 'personal', 'project_shared', 'workspace_shared', 'org_shared'] as const`
  - Defines per-scope policy: owner fields, required/forbidden identity fields, replication target, visibility predicate, search request expansion, promotion targets, and whether raw source access is allowed.
  - Exports narrow subtypes such as `OwnerPrivateMemoryScope`, `ReplicableSharedProjectionScope`, `AuthoredContextScope`, and `SearchRequestScope` so enrollment/admin/authored-context APIs cannot accidentally accept private scopes.
  - Defines request vocabulary: `owner_private`, `shared`, `all_authorized`, and a single explicit scope. Session-tree inclusion is represented by a separate context binding (`root_session_id` / `session_tree_id`) and must not be encoded as a scope.
  - `user_private` is owner-only cross-project memory for preferences, user-level skills, persona/user facts, and private observations. Server sync, when enabled, MUST use a dedicated owner-private route/table guarded by `mem.feature.user_private_sync`; it MUST NOT reuse `shared_context_projections` or project/workspace/org membership filters.
- `shared/memory-origin.ts`
  - `MEMORY_ORIGINS = ['chat_compacted', 'user_note', 'skill_import', 'manual_pin', 'agent_learned', 'md_ingest'] as const`
  - `quick_search_cache` and other cache origins are reserved and MUST NOT be emitted in this milestone.
  - New origin values require an OpenSpec delta and migration.
- `shared/send-origin.ts`
  - `SEND_ORIGINS = ['user_keyboard', 'user_voice', 'user_resend', 'agent_output', 'tool_output', 'system_inject'] as const`
  - Missing `session.send.origin` defaults to `system_inject`, which is untrusted for preference writes and may only preserve legacy send/ack compatibility.
  - `TRUSTED_PREF_WRITE_ORIGINS = ['user_keyboard', 'user_voice', 'user_resend'] as const`.
- `shared/memory-fingerprint.ts`
  - Canonical API: `computeMemoryFingerprint({ kind, content, scopeKey?, version?: 'v1' }): string`.
  - `FingerprintKind = 'summary' | 'preference' | 'skill' | 'decision' | 'note'`.
  - Legacy helpers must be deprecated or marked internal and must not be used by new call sites.
- `shared/memory-namespace.ts`
  - Defines canonical namespace key constructors and binds namespace records to `MemoryScope` policies from `shared/memory-scope.ts`; it MUST NOT introduce parallel authorization tiers.
  - For project-bound namespaces, `project_id` MUST be the canonical remote-backed `canonicalRepoId`; session tree ids are only optional binding/provenance within that project.
- `shared/memory-observation.ts`
  - Defines `ObservationClass = 'fact' | 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'preference' | 'skill_candidate' | 'workflow' | 'code_pattern' | 'note'` and typed observation payload validation.
  - `note` is the canonical class for markdown/manual note durable content; do not introduce a parallel `memory_note` spelling.
- `shared/feature-flags.ts`
  - Defines the memory feature flag registry listed below, including dependencies and disabled behavior.
- `shared/memory-counters.ts`
  - Defines the closed telemetry counter enum and label constraints.
- `shared/skill-envelope.ts`
  - `SKILL_ENVELOPE_OPEN = '<<<imcodes-skill v1>>>'`
  - `SKILL_ENVELOPE_CLOSE = '<<<imcodes-skill-end>>>'`
  - `SKILL_ENVELOPE_COLLISION_PATTERN = /<<<imcodes-skill/gi`
  - `SKILL_MAX_BYTES = 4096`
- `shared/skill-review-triggers.ts`
  - `SKILL_REVIEW_TRIGGERS = ['tool_iteration_count', 'manual_review'] as const`.
- `shared/builtin-skill-manifest.ts`
  - Manifest schema for `dist/builtin-skills/manifest.json`, initially `{ "version": 1, "skills": [] }`.
- `shared/memory-defaults.ts`
  - Mirrors current defaults from the `design-defaults` block below.
- `web/src/i18n/locales/index.ts`
  - `SUPPORTED_LOCALES = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'] as const`.

## Feature Flag Registry

`shared/feature-flags.ts` is the registry source of truth for flag names, defaults, dependencies, owners, and disabled behavior. Runtime values come from the applicable config plane: local daemon config for daemon-local features, server config for server/web features, and environment variables only as startup defaults. Precedence is runtime config override > persisted local/server config > environment startup default > registry default. Daemon-side management UI toggles persist local overrides in the daemon config store and therefore beat environment startup defaults without requiring a restart; enabling a flag through this operator surface also request-enables its dependency closure, while dependency evaluation still reports requested-vs-effective state so a child flag does not partially run while a parent is later disabled. Flag read failure fails closed for new features. Runtime disablement MUST stop new work within the documented propagation target.

| Flag | Default | Runtime source | Dependencies | Observed by | Disabled behavior |
| --- | --- | --- | --- | --- | --- |
| `mem.feature.scope_registry_extensions` | `false` | local/server config + env startup default | none | daemon/server/web scope validators, namespace registry | legacy scopes remain accepted; new `user_private` writes fail closed except migration/backfill reads. |
| `mem.feature.user_private_sync` | `false` | local/server config + env startup default | scope registry extensions, namespace registry, observation store | daemon replication runner, server owner-private sync API/table, startup/search selection | `user_private` remains daemon-local owner-only; no owner-private server writes, replication jobs, or server reads are attempted. |
| `mem.feature.self_learning` | `false` | local daemon config + env startup default | namespace registry, observation store | materialization/compression pipeline | classification/dedup/durable extraction skipped; projection still commits without classification. |
| `mem.feature.namespace_registry` | `false` | local/server config + env startup default | none | daemon/server storage | no new namespace records outside migration/backfill; legacy projection reads remain available. |
| `mem.feature.observation_store` | `false` | local/server config + env startup default | namespace registry | daemon/server storage, materialization, preferences, skills | no new observation rows; projections remain readable. |
| `mem.feature.quick_search` | `false` | server config | namespace registry | web search UI, server/daemon search RPC | palette hidden; search endpoint returns same disabled envelope without search jobs. |
| `mem.feature.citation` | `false` | server config | quick search | web composer/citation RPC | citation UI hidden and RPC rejects with same disabled envelope; no citation rows. |
| `mem.feature.cite_count` | `false` | server config | citation | citation store, ranking/search | no new count increments; existing counts ignored in ranking without deleting data. |
| `mem.feature.cite_drift_badge` | `false` | server config | citation | web citation renderer | drift badge hidden; citation identity still preserved if citations are enabled. |
| `mem.feature.md_ingest` | `false` | local daemon config + env startup default | namespace registry, observation store | session bootstrap/MD ingest worker | no MD reads, parses, or ingest jobs. |
| `mem.feature.preferences` | `false` | local daemon config + env startup default | namespace registry, observation store | daemon send handler, preference store | `@pref:` lines pass through as text and are not persisted, stripped, or rendered into provider preference context. |
| `mem.feature.skills` | `false` | local/server config + env startup default | namespace registry, observation store | skill loader/render policy/admin API | loader returns empty set; render policy skips skills; admin writes rejected or disabled. |
| `mem.feature.skill_auto_creation` | `false` | local daemon config + env startup default | skills, self_learning | background skill review worker | no skill-review jobs claimed or created; existing skills still load if `mem.feature.skills` is enabled. |
| `mem.feature.org_shared_authored_standards` | `false` | server config + env startup default | scope registry extensions, shared-context document/version/binding migrations | server shared-context routes, authored-context resolver, web diagnostics | org-wide authored standard creation/binding is rejected with the documented disabled envelope; runtime selection skips org-wide bindings without blocking send ack or leaking inventory; project/workspace authored context remains governed by its existing controls. |

In-flight work MAY finish only if it cannot corrupt state, block shutdown/upgrade, leak data, or violate authorization. Disabled-feature user-facing responses MUST preserve safe/same-shape envelopes where feature existence or object existence could otherwise leak.

Enterprise authored standards are server shared-context control-plane objects, not daemon self-learning observations. They are still a post-1.1 Wave 5 feature and therefore have the explicit `mem.feature.org_shared_authored_standards` kill switch above. Disabling that flag MUST stop new org-wide authored-standard mutation/selection without disabling unrelated project/workspace bindings that already exist under the shared-context control plane.

## Telemetry Registry

Telemetry MUST be non-blocking, bounded, and type-safe. Counters MUST come from `shared/memory-counters.ts`. Initial counter set:

- `mem.startup.silent_failure`, `mem.startup.budget_exceeded`, `mem.startup.stage_dropped`
- `mem.search.empty_results`, `mem.search.scope_filter_hit`, `mem.search.unauthorized_lookup`, `mem.search.disabled`
- `mem.citation.created`, `mem.citation.drift_observed`, `mem.citation.count_incremented`, `mem.citation.count_deduped`, `mem.citation.count_rejected`, `mem.citation.count_rate_limited`
- `mem.ingest.skipped_unsafe`, `mem.ingest.size_capped`, `mem.ingest.section_count_capped`
- `mem.skill.sanitize_rejected`, `mem.skill.collision_escaped`, `mem.skill.layer_conflict_resolved`, `mem.skill.review_throttled`, `mem.skill.review_deduped`, `mem.skill.review_failed`
- `mem.classify.failed`, `mem.classify.dedup_merge`
- `mem.preferences.untrusted_origin`, `mem.preferences.persisted`, `mem.preferences.duplicate_ignored`, `mem.preferences.rejected_untrusted`
- `mem.observation.duplicate_ignored`, `mem.observation.unauthorized_promotion_attempt`, `mem.observation.backfill_repaired`
- `mem.bridge.unrouted_response`, `mem.management.unauthorized`
- `mem.materialization.repair_triggered`, `mem.telemetry.buffer_overflow`

Allowed label values are closed enums such as `MemoryOrigin`, `SendOrigin`, `MemoryFeatureFlag`, `FingerprintKind`, `ObservationClass`, and `SkillReviewTrigger`. Free-form session ids, project ids, user ids, file paths, raw text, and secrets are forbidden as metric labels.

## Enterprise Shared Standards Model

Enterprise-global sharing is represented by `org_shared`, not by a new `global` scope or namespace tier. There are two distinct enterprise sharing surfaces:

1. **Authored standards / policies / playbooks** use the existing shared-context document model (`shared_context_documents`, `shared_context_document_versions`, `shared_context_document_bindings`). An org-wide binding has `enterprise_id` set, `workspace_id = NULL`, `enrollment_id = NULL`, and derived scope `org_shared`. It is visible only to members of that enterprise. Owner/admin roles may create, update, activate, deactivate, or delete versions/bindings; members may read only the bindings selected for their session.
2. **Processed project experience** uses `shared_context_projections` with scope `project_shared`, `workspace_shared`, or `org_shared`. Even when scope is `org_shared`, each projection MUST retain canonical `project_id` / `canonicalRepoId` as provenance and ranking input; org-shared processed memory is not an unowned global pool.

`org_shared` authored context MAY include optional filters: `applicability_repo_id`, `applicability_language`, and `applicability_path_pattern`. Filters only narrow applicability inside the enterprise; they MUST NOT widen visibility outside the enterprise. `binding_mode = required` means the context must be preserved in the compiled payload or dispatch fails with the existing required-authored-context error. `binding_mode = advisory` may be dropped by budget/render policy with telemetry/diagnostics.

Runtime selection order for authored standards is: project binding, workspace binding, then org binding, with required bindings preserved before advisory bindings. If multiple org-shared standards match, stable ordering MUST be deterministic by active version/binding metadata. User-visible diagnostics must distinguish org/workspace/project authored layers without leaking documents to non-members.

## Storage and Schema Invariants

The exact migration numbers are assigned at implementation time, but the following invariants are mandatory on both daemon SQLite and server PostgreSQL equivalents where applicable.

### Authorization scope registry

- Shared module: `shared/memory-scope.ts`.
- Required scopes:
  - `user_private`: owner user across projects/workspaces, visible only to that user, suitable for preferences, user-level skills, persona/user facts, and user-private observations. When `mem.feature.user_private_sync=true`, it replicates through a dedicated owner-private sync route/table; when false it remains daemon-local. It MUST NOT be stored in or queried through shared projection membership filters.
  - `personal`: legacy/project-bound private memory for the owner user and current project; remains supported for compatibility.
  - `project_shared`: enterprise project members.
  - `workspace_shared`: enterprise workspace members.
  - `org_shared`: enterprise/team members only. Requires `enterprise_id`; `workspace_id` and enrollment-specific project binding are null for enterprise-wide authored standards. It is not public/global and never crosses enterprise boundaries.
- Every scope policy MUST define required identity fields, nullable fields, replication target, authorization predicate, allowed promotion targets, and search/default-selection behavior.
- Scope policy migration MUST replace hard-coded scope unions/predicates across daemon/server/web with shared constants or generated validators.

### Namespace registry

- Table/model: `context_namespaces`.
- Required fields: `id`, `tenant_id` or local daemon tenant marker, `scope`, `user_id`, `root_session_id`/`session_tree_id`, `session_id`, `workspace_id`, `project_id`, `org_id`, `key`, `visibility`, `created_at`, `updated_at`. Per-scope policy determines which identity fields are required, optional-for-provenance, or forbidden. For `personal`, `project_shared`, `workspace_shared`, and `org_shared`, `project_id` MUST be the canonical remote-backed `canonicalRepoId` when a remote exists so the same user's same project is visible across devices. `ContextNamespace.projectId` MUST NOT be globally required for `user_private`; session-tree context uses `root_session_id` / `session_tree_id` as binding metadata rather than a scope.
- `scope` MUST be one of `user_private`, `personal`, `project_shared`, `workspace_shared`, `org_shared` and must validate against the per-scope policy.
- `key` MUST be built only through `shared/memory-namespace.ts` canonical constructors.
- Unique constraint/index MUST prevent duplicate canonical namespace keys within the same tenant/scope context.
- Namespace migration MUST bind each legacy projection to exactly one namespace/scope policy and MUST NOT widen visibility. Legacy `personal` rows remain project-bound `personal` keyed by canonical project identity; same owner + same canonical remote across devices may see them when personal sync is enabled, but other projects/users may not. Automatic backfill MUST NOT reclassify them to `user_private`; any `personal` -> `user_private` movement requires explicit audited user/admin action.

### Observation store

- Table/model: `context_observations`.
- Required fields: `id`, `namespace_id`, `scope`, `class`, `origin`, `fingerprint`, `content_json`, `text_hash`, `source_event_ids_json`, `projection_id`, `state`, `confidence`, `created_at`, `updated_at`, `promoted_at`.
- `class` MUST use `ObservationClass` from `shared/memory-observation.ts`.
- `state` MUST be a closed enum such as `candidate`, `active`, `superseded`, `rejected`, `promoted`.
- Unique/index constraints MUST make same-scope duplicate writes idempotent by at least `namespace_id`, `class`, `fingerprint`, and `text_hash`.
- Observation writes must be transactional with projection aggregate updates or written through an outbox/repair path that can reconcile projection/observation mismatch.

### Owner-private sync store

- Server shared projections MUST accept only `personal`, `project_shared`, `workspace_shared`, and `org_shared` and MUST have a database CHECK/validator preventing `user_private` from entering that path. Rows MUST be keyed by canonical `project_id`/`canonicalRepoId`, not device-local paths.
- Session-tree context is not replicated as a separate authorization scope; it is carried only as namespace/context provenance where needed.
- `user_private` server sync, when `mem.feature.user_private_sync=true`, uses a dedicated owner-private table/route with owner-user authorization predicates, same-shape disabled/unauthorized envelopes, idempotency keys, retention/repair, and tests for cross-project owner visibility and non-owner denial.
- If the sync flag is off or server sync is unavailable, `user_private` remains daemon-local and user delivery/startup MUST fail open without blocking ordinary send ack.

### Citation and idempotency store

- Citation rows MUST store projection id, namespace/scope, created_at, authoritative citing message identity, idempotency key, and actor/caller context needed for authorization auditing.
- Citation idempotency keys MUST be derived by the authoritative daemon/server store and MUST NOT be accepted from untrusted clients.
- If stable citing message identity exists, use `sha256("cite:v1:" + scope_namespace + ":" + projection_id + ":" + citing_message_id)`.
- If stable citing message identity is not available, implementation MUST first add it or block cite-count work until the identity property is satisfied.
- Idempotency rows are retained for at least `citationIdempotencyRetentionDays`; pruning must not allow normal retry/replay windows to inflate counts.
- Cite-count may be stored directly on projection rows or in an auxiliary counter table, but ranking must consume a bounded normalized signal after scope filtering.

### Promotion audit

- Table/model: `observation_promotion_audit`.
- Required fields: `id`, `observation_id`, `actor_id`, `action`, `from_scope`, `to_scope`, `reason`, `created_at`.
- Allowed promotion actions in this milestone: web UI Promote, CLI `imcodes mem promote`, admin API `POST /api/v1/mem/promote`.
- Background workers MUST NOT promote observations across scopes without one of those authorized actions.

## Data Flow and Interfaces

- Memory writes flow through projection APIs that attach `origin`, `summary_fingerprint` or kind-specific fingerprint, namespace/scope, source ids, observation class where applicable, and render kind. Projections may remain the render/search aggregate, but durable facts/decisions/preferences/skill candidates/notes MUST also have typed observation rows when `mem.feature.observation_store` is enabled.
- Startup context flow is `collect -> prioritize -> apply quotas -> trim to total budget -> dedup -> render`. Each stage is independently testable and may fail open by dropping that source with telemetry.
- Search/citation flow is `authorized caller -> shared scope filter -> ranked projection results -> render-policy-safe preview -> citation token -> authoritative cite idempotency key -> authorized same-shape source lookup`.
- MD/preferences flow is `trusted trigger -> bounded parser -> scope validation/fail-closed -> origin/fingerprint/provenance fingerprint -> projection-backed idempotent write -> linked observation -> startup/search selection`. Markdown sections classified as `preference` remain markdown-derived project/user memory and do not become trusted owner-private `@pref:` preferences unless a later explicit audited promotion path is added. Filesystem markdown must not silently downgrade `user_private`, workspace, or org namespaces into project scope; unsupported scopes are dropped with telemetry, while authorized workspace/org standards use authored-context bindings.
- Observation flow is `source event/projection -> classify -> typed observation row -> projection aggregate/update -> search/startup render`. Observation rows carry class, content JSON, source event ids, projection id, namespace id, scope, origin, and fingerprint.
- `@pref:` flow is `session.send(origin) -> trusted-origin check -> leading-line parser -> idempotent preference write + preference observation scheduled asynchronously -> strip trusted raw command lines from user-visible/provider-bound user text -> render same-turn preference records plus active persisted preferences through the shared preference render policy -> provider dispatch with a bounded session-level preference context preamble + remaining user text; the same rendered preference block MUST NOT be injected on every later turn, and MUST be re-sent only when the block changes or after SDK/provider compaction may have discarded prior context`. Ack remains daemon receipt and does not wait for preference persistence, preference lookup, bootstrap, recall, locks, relaunch, or provider send-start.
- Authored standards flow is `admin/owner writes document/version -> org/workspace/project binding -> member session resolves matching bindings by canonicalRepoId/language/path -> required/advisory render policy -> provider dispatch`; org-wide standards are `org_shared` bindings with enterprise-only visibility.
- Skills flow is `import/install/review/admin-sync -> lightweight skill registry/manifest -> precedence/enforcement resolution -> optional provider-visible registry hint -> on-demand resolver reads only selected skill bodies when relevant`. Ordinary startup/send must not scan or read the full skill corpus. Explicit full-body rendering must pass through the render-policy-safe skill envelope. Skill auto-creation/update is `completed non-hidden non-error tool-result evidence or manual review -> response delivered -> background compression/materialization review -> daemon-local production worker -> create/update deterministic user-level skill -> upsert registry -> repair/backoff/idempotency`, never ordinary send ack work.
- Telemetry flow is hot-path enqueue into a bounded async buffer; sink failure never changes user-visible memory behavior.

## Citation Ranking and Drift Model

- Citation insertion is by projection identity, not raw source snapshot.
- Each insertion creates a citation row with its own `created_at` and authoritative idempotency key.
- Same citing message retry/replay dedupes; a different citing message citing the same authorized projection increments cite-count once for that different message.
- Unauthorized or missing citation attempts must return the same user-facing envelope and must not increment or reveal counts.
- Cite-count ranking is enabled only when `mem.feature.cite_count=true`, after scope filtering, and as a bounded additive signal that does not replace existing semantic score or `hitCount` behavior.
- Drift detection MUST use a canonical persistent `content_hash` computed from normalized projection content. Daemon SQLite and server PostgreSQL projection write paths MUST persist this marker for content-changing writes; citation rows capture it at cite time. Routine maintenance/idempotent upserts that do not change normalized projection content MUST NOT change `content_hash` or create false drift.

## Skill Auto-Creation Model

Skill auto-creation/self-improvement is background memory work, not send work.

- Closed triggers: `tool_iteration_count` and `manual_review` only.
- `tool_iteration_count` trigger fires only after a completed user turn when completed, visible, non-error tool-result evidence reaches `skillReviewToolIterationThreshold`; hidden raw tool events, failed tool results, and below-threshold evidence are filtered or marked not-eligible outside the ordinary send ack/provider-delivery path. The threshold is reset only after a review job is accepted.
- `manual_review` trigger requires an explicit user/admin action.
- The worker MUST coalesce duplicate pending reviews per user/workspace/project/session scope.
- The worker MUST enforce per-scope concurrency, min-interval, daily caps, retry/backoff, idempotency, and cancellation on shutdown/disable.
- The worker MUST prefer updating an existing matching user-level skill before creating a new user-level skill.
- The worker MUST never create a project/workspace/org shared skill without the explicit admin paths in the promotion/admin model.

## Capacity and Performance Budgets

Current defaults are authoritative for shipped behavior until changed by a future OpenSpec delta and mirrored in `shared/memory-defaults.ts`.

```json5
// design-defaults
{
  startupTotalTokens: 8000,
  pinnedTokens: 1600,
  durableTokens: 4000,
  recentTokens: 2400,
  skillTokens: 1000,
  projectDocsTokens: 2000,
  markdownMaxBytes: 51200,
  markdownMaxSections: 30,
  markdownMaxSectionBytes: 16384,
  markdownParserBudgetMs: 5000,
  skillMaxBytes: 4096,
  featureFlagPropagationP99Ms: 60000,
  skillReviewToolIterationThreshold: 10,
  skillReviewMinIntervalMs: 600000,
  skillReviewDailyLimit: 6,
  skillReviewManualMinIntervalMs: 60000,
  skillReviewManualDailyLimit: 50,
  skillRegistryMaxBytes: 1048576,
  skillRegistryMaxEntries: 1024,
  citationIdempotencyRetentionDays: 180,
  preferenceIdempotencyRetentionDays: 180
}
```

Trim priority defaults to `recent`, then `project_docs`, then `durable`; pinned content has highest preservation priority. MD ingest has no `fs.watch` in this milestone and is wired as bounded bootstrap/manual-sync background work, but completed schedules must release their in-flight key so later session starts/manual sync can re-read changed files. Quick search, citation preview, skill load, MD ingest, classification, skill review, and telemetry must not delay ordinary send ack.

## Post-1.1 Management UI

The shared-context management panel is also the operator surface for local post-1.1 daemon memory features. It must not require users to edit SQLite rows or skill registry files by hand. The minimum UI/API contract is:

- **Feature status:** query daemon-resolved post-1.1 memory feature flags and show enabled/disabled/unknown state before exposing mutation actions. The same panel also sends shared `memory.features.set` requests so operators can enable/disable daemon-managed memory flags from the UI; the daemon requires server-derived/local-daemon management context, persists the requested value, cascades enable requests to dependencies, recomputes effective state with dependencies, returns source/dependency metadata, and rejects invalid or failed writes with shared error codes. Requested-on/effective-off states render as a distinct dependency-blocked warning instead of looking like an ordinary disabled flag. Disabled features may still show existing local records for inspection, but management writes/mutations/read-body actions MUST fail closed with shared error codes and localized web messages.
- **Project selector and memory index:** the Memory tab MUST default browsing to **All projects** and MUST NOT auto-select the current/local-tool project as a browse filter. The shared project picker is sourced from active/recent daemon sessions, enterprise enrolled canonical project identities, and `projects` indexes returned by local daemon, personal cloud, enterprise/shared, and semantic memory views. Each index entry carries canonical project id plus record counters and last-updated metadata so projects with memory remain selectable even when no current session exposes a local directory. The picker shows both canonical `canonicalRepoId` and local `projectDir` when known, searches name/id/directory, keeps canonical-only options usable for memory filtering, and routes directory-only entries through a daemon resolver before local filesystem tools run. Raw project id/path fields are advanced fallback/debug controls only and are not the primary UX.
- **Protocol routing and trust:** memory-management WebSocket requests use a closed request/response type set from `shared/memory-ws.ts`, MUST carry a unique `requestId`, and daemon responses MUST be single-cast back only to the pending browser socket for that `requestId`; unrouted or duplicate-pending responses are dropped and counted, never broadcast. The server bridge injects a server-derived management context (`actorId`, `userId`, role, requestId, and bound project hints). The role is derived from server-side membership data (`team_members` reached directly by `enterpriseId`/`orgId`, or through `shared_context_workspaces` / `shared_project_enrollments` when only workspace/project hints are present); browser-supplied role fields are ignored. Browser project/workspace/org fields are request hints only: they MUST NOT enter `boundProjects` unless the server verifies membership/enrollment for that exact canonical repo, workspace, or org. Daemon handlers ignore client-supplied owner/actor identity for preference, observation, and processed-memory mutations; client identity fields are display/input hints only and are never authorization inputs. Record-level `ownerUserId` / `createdByUserId` / `updatedByUserId` metadata is server/daemon-derived at create/update time and is distinct from management role: private records remain owner-only; shared records may be mutated by an authorized admin or by the record creator/owner when the namespace is otherwise visible. Legacy/display fields such as `userId`, `createdBy`, `authorUserId`, and `updatedBy` MAY be shown for old records, but MUST NOT grant mutation authority. Admin actions MUST preserve the original creator metadata and only update `updatedByUserId` / audit metadata.
- **Preferences:** query active `@pref` observations for the server-derived current user, create and update trusted explicit user-scoped preferences for that same current user, store creator/owner metadata derived from the authenticated actor, and delete only preferences owned by that user unless a future admin context explicitly authorizes otherwise. The UI uses daemon WebSocket message constants from `shared/memory-ws.ts`; user-visible labels and management errors live in all web locales. Preference create/update/delete is blocked when `mem.feature.preferences=false`, and every mutation invalidates provider-visible preference context so stale preferences are not reused.
- **Skills:** query the maintained skill registry/manifest, rebuild it only on an explicit operator action, preview one selected skill body on demand, and delete managed user/project skill files with path-root checks. Startup and ordinary sends still see only registry hints and never scan/read every skill body. Preview MUST reject non-file/symlink registry entries, and management registry writes MUST invalidate runtime registry cache. Rebuild/preview/delete are blocked when `mem.feature.skills=false` or the selected project lacks a validated `{ projectDir, canonicalRepoId }` pair.
- **Markdown ingest:** run a bounded manual ingest only when the selected project has a validated project directory and canonical project identity. The daemon must reject invalid project directories and canonical project identity mismatches before reading project files. Unsupported `user_private`/workspace/org filesystem scope continues to fail closed and the UI exposes only supported manual-ingest scopes (`personal`, `project_shared`). The UI surfaces files-checked and observations-written counters. Run is blocked when `mem.feature.md_ingest=false`.
- **Processed local memory:** local processed memory records are manageable, not read-only: the UI can manually add a project-bound personal memory, edit an existing visible record, archive/restore/delete it, and pin it into the pinned-note store. The daemon must authorize create/update/pin/delete/archive/restore from the server-derived management context, require explicit canonical project identity plus an authorized bound project for manual create, update linked projection/observation rows transactionally, delete linked observations when a processed projection is permanently deleted, clear stale embeddings on edits, and invalidate runtime memory caches with a projection-typed event after successful projection mutations. Manual create/edit stores `ownerUserId`, `createdByUserId`, and `updatedByUserId` in record content metadata; management lists display these fields so creator ownership is not confused with enterprise admin role. Pinning uses origin `manual_pin` and must be idempotent for the same projection id so repeated clicks do not create unbounded duplicates. All processed-memory management mutations are governed by `mem.feature.observation_store`; when it is effectively disabled, create/update/archive/restore/delete/pin fail closed with shared error codes and do not touch projection, observation, pinned-note, or cache state.
- **Observations:** list typed observations by scope/class with creator/owner metadata, edit/delete mutable observations, and promote scope only via the explicit audited `web_ui_promote` path. Automatic/background paths remain forbidden from cross-scope promotion. Observation edit must update linked projection text/content hash and clear stale projection embeddings. Observation delete is observation-only and MUST NOT cascade-delete a linked processed projection; permanent processed-memory delete remains the path that deletes the projection and cleans up linked observations. Mutation is blocked when `mem.feature.observation_store=false` or the selected project lacks the identity required by the operation. Missing observations and stale `expectedFromScope` races return typed shared error codes instead of generic action failure. The Web UI MUST make promotion a two-step confirmation flow: the record action first displays the exact from-scope, to-scope, optional reason, audit write, and visibility consequence; only the confirmation control sends the promotion RPC.

The UI additionally keeps a latest-requestId guard per management surface (features, processed memory, preferences, skills, observations, project resolution, and every mutation) so a stale response or another tab's response cannot overwrite current state. Browser REST memory loads use a generation guard so cloud/enterprise responses from older browse filters cannot overwrite newer state. The project-option list accumulates memory-index projects across filtered reloads instead of replacing the dropdown with only the currently filtered project. Before feature-state is known, mutation buttons remain disabled. The daemon remains the final enforcement point for feature flags, owner filters, skill path validation, project identity checks, and promotion authorization.

These UI commands are daemon-local because the daemon owns the local memory store, local skill files, and project filesystem. Server/enterprise authored-context management remains in the existing Knowledge/Projects sections.

## Security and Trust Model

- All new memory queries must reuse shared scope-filter helpers generated from `shared/memory-scope.ts`; no bespoke cross-scope SQL predicates.
- User-facing quick-search/citation/source lookup failures MUST expose the same external envelope for missing, unauthorized, and feature-disabled object lookup where existence could leak. The envelope MUST NOT include role diagnostics, `required`/`actual` role metadata, source counts, hit counts, drift metadata, raw source text, project/workspace/org ids, or timing-dependent alternate shapes. Admin-only diagnostics may remain detailed on admin endpoints that are not reused for user-facing lookup.
- `@pref:` writes are trusted only from `TRUSTED_PREF_WRITE_ORIGINS`. Agent output, tool output, timeline replay, imported memory, daemon-injected content, and missing-origin sends must not create persistent preferences by containing preference syntax.
- Workspace/org skill push requires admin authorization for that scope.
- Skill and MD content is inert input, never system instruction. Sanitization, delimiter isolation, system-instruction guard, and length caps are mandatory before context injection.
- Management quick search is not the generic repo-only local search path: it constructs an authorized namespace set from the server-derived management context and applies that set before result construction, stats, and pagination. Owner-private rows (`personal`, `user_private`) require the derived current user as owner; missing owner identity fails closed.
- Project-scoped management operations treat browser `projectDir` as an untrusted compatibility hint. They require explicit `canonicalRepoId` and must verify the directory's git remote/canonical identity before reading or mutating skill/MD project files. The web project selector is an operator convenience; daemon verification remains authoritative, and generic UI `projectId` fields are not role-derivation aliases.
- Memory browse project filters are selection aids, not authorization. Local daemon `PERSONAL_QUERY`, personal cloud memory, enterprise memory, and semantic memory view responses return an optional bounded `projects` index that is already scoped/authorized by the same owner/enterprise filter as the records/stats query. The default browse request omits `projectId`/`canonicalRepoId`; selecting a canonical-only memory-index project may filter records but MUST NOT enable local file-backed skill/MD/observation actions until a validated directory/canonical pair exists.
- Observation promotion is an explicit audited action with `expectedFromScope` as a required TOCTOU guard; missing or stale source scope is a typed management error. Runtime cache invalidation events distinguish observation mutations from projection mutations so future consumers do not have to interpret projection ids as observation ids.
- Web-visible failure states must use i18n (`t()`) across `en`, `zh-CN`, `zh-TW`, `es`, `ru`, `ja`, and `ko`. Protocol/type/status strings shared across daemon/server/web must be shared constants.

## Skill Model

Ordinary layer precedence, highest to lowest:

1. `<project>/.imc/skills/` project escape hatch.
2. User-level skills under `~/.imcodes/skills/` that match current project metadata.
3. User-level default skills under `~/.imcodes/skills/`.
4. Workspace-shared mirrored skills.
5. Org-shared mirrored skills.
6. Built-in fallback from `dist/builtin-skills/manifest.json` (empty in Wave 5).

Built-in fallback is always lowest precedence, is always considered only after higher layers, and MUST NOT override user-authored, project, workspace, org, or explicitly selected skills. Enforcement is a separate axis. Workspace/org skills with `enforcement: 'enforced'` are always selected and override or hide same-name lower-layer skills according to documented conflict rules. Workspace/org skills with `enforcement: 'additive'` do not shadow project/user skills; they coexist and must show loaded-layer diagnostics. Wave 5 implements safe storage/import/render/admin foundations, the empty built-in loader, and post-response skill auto-creation/self-improvement through the existing isolated compression/materialization background path. Runtime startup dispatch exposes at most a bounded skill registry hint (key/layer/safe descriptor/redacted path or `skill://` URI) sourced from a maintained registry, not by scanning/reading every `SKILL.md`; full-body rendering remains available only through explicit on-demand resolver paths using the skill envelope sanitizer. Auto-creation always writes user-level skill candidates or updates existing user skills; it must not run in the send ack path or create a new foreground agent/session. The automatic `tool_iteration_count` path requires real completed, visible, non-error tool-result evidence meeting `skillReviewToolIterationThreshold`; `manual_review` may bypass that threshold. Runtime dispatch must have an actual production loader for project/user skill references; shared selection/render helpers alone are not sufficient acceptance evidence.

## Migration and Rollback Plan

- Schema changes are additive but Wave 1-5 are expected to introduce real migrations in dev. Migration/backfill work is explicitly in scope and MUST NOT be used as the reason to defer a post-1.1 requirement.
- Migration filenames MUST use the next available number after the current repository head at implementation time; stale plan numbers are non-authoritative.
- Fingerprint/origin columns, scope registry fields, namespace registry tables, typed observation tables, citation/idempotency tables, cite-count storage, promotion audit tables, and preference idempotency support start nullable or safely defaulted where needed and are lazily backfilled.
- Eager backfill, if implemented, must be an explicit CLI/admin action using bounded restartable batches.
- Rollback path is feature-flag disablement, returning to pre-feature behavior without deleting stored data.
- Destructive rollback is out of scope unless a later task explicitly designs it.
- New background workers must define stale in-progress recovery, bounded retry/backoff, idempotent reprocessing, and retention/pruning behavior. Scope and observation migrations must preserve existing projections, must not widen visibility automatically, and must not cross-promote scopes automatically.
- Acceptance scripts must validate this change id directly; validating only `memory-system-1.1-foundations` is insufficient for post-1.1 readiness.

## Risks / Trade-offs

- **Large change surface** -> ordered waves, finite milestone, feature flags, and per-wave gates.
- **OpenSpec capability timing** -> hold foundations deltas here until `daemon-memory-pipeline` exists, then migrate before archive.
- **Ack/stop regression** -> foundations regression matrix mandatory for every wave.
- **Scope leak / side channel** -> shared scope filters plus identical user-facing missing/unauthorized/disabled envelopes.
- **Citation replay inflation** -> authoritative idempotency key, stable citing message identity requirement, retention, and replay tests.
- **Hot-row cite-count contention** -> bounded ranking signal and option for auxiliary counters/rollups if direct projection updates become contentious.
- **Prompt injection via skills/MD/preferences** -> trust markers, line stripping, fail-closed sanitizer, delimiter collision tests, and render-policy layer.
- **Migration drift across daemon/server** -> shared fingerprint/namespace/observation implementations and byte-identical fixtures.
- **Telemetry overload** -> bounded buffer, sampling, closed counter names, and closed label values.
- **Defaults drift** -> `design-defaults` block plus shared constants coverage test.
