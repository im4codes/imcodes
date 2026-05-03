## Why

`memory-system-1.1-foundations` is the stability baseline for daemon memory: durable provenance, bounded materialization, redaction, immediate daemon-receipt send ack, SDK-native `/compact`, `/stop` and approval/feedback priority, fail-open recall/bootstrap, provider send-start watchdogs, and local repair. Post-foundations work must build on that baseline without reintroducing the instability previously seen in memory branches.

`docs/plan/mem1.1.md` contains the original roadmap for Phase 1.5, 1.6, 1.7, 1.8, 1.9, 1.7-O, and later Phase 2/3 candidates. Keeping those as implicit fragments makes scope, sequencing, failure handling, security review, and acceptance ambiguous. This change is the single authoritative OpenSpec contract for post-1.1 memory work.

## Completion Boundary

The current completion milestone is **Wave 1 through Wave 5**:

1. Wave 1 — operational foundations, authorization scope registry, and hardening gates.
2. Wave 2 — self-learning memory.
3. Wave 3 — quick search, citations, drift, and cite-count ranking.
4. Wave 4 — markdown ingest, preferences, and unified bootstrap.
5. Wave 5 — enterprise org-shared authored standards plus safe skill storage/import/render/admin foundations and post-response skill auto-creation/self-improvement through the existing background compression/materialization path.

Later candidates are tracked for continuity but do **not** block this milestone until promoted by a future OpenSpec delta with concrete requirements, tasks, and tests. Deferred candidates include drift recompaction loops, prompt caching, autonomous prefetch/LRU, topic-focused compact/context-selection behavior that still must not daemon-intercept `/compact`, LLM redaction, built-in skill content harvest, and quick-search result caching. These are deferred for behavioral/product/security reasons only, not because they require migrations. No post-1.1 item may be deferred merely because it requires schema migration, data backfill, or server/daemon migration coordination. Authorization scope registry extensions, namespace registry extensions, the multi-class observation store, cite-count storage/ranking, preference storage/idempotency, skill storage, enterprise org-shared authored standards, and skill auto-creation are included in Wave 1-5 because dev can carry the required migrations and safety gates. Wave 1 must add concrete scope policies for `user_private`, existing `personal`, `project_shared`, `workspace_shared`, and `org_shared`; these are not deferred backlog. Enterprise-wide shared standards MUST use existing `org_shared` semantics, not a new `global` or `namespace_tier=global`: `org_shared` is visible only inside the current enterprise/team, requires `enterprise_id`, and never crosses enterprise boundaries. Main sessions and sub-sessions already belong to one project/session tree and MUST share the same project/session context through namespace/context binding, not through a new authorization scope. Same signed-in user on different devices MUST see the same project-scoped memory when the project resolves to the same canonical remote repository identity (`canonicalRepoId`, derived from normalized git remote/remote aliases); local path or machine id must not split that project. `user_private` means owner-only cross-project memory and, when sync is enabled, MUST use a dedicated owner-private sync path rather than the shared projection authorization path. Skill auto-creation/self-improvement is part of Wave 5 only as post-response background compression/materialization work, never as send-path work.

## Capability Bridging

This change has one change id and two capability surfaces:

- **New capability:** `daemon-memory-post-foundations`, containing all current Wave 1-5 runtime requirements and acceptance gates.
- **Archive-time modified capability migration:** `daemon-memory-pipeline`. Some requirements preserve or tighten behavior originally described by `memory-system-1.1-foundations` / `daemon-memory-pipeline`, especially send ack timing, priority controls, startup selection, render-policy payloads, and citation-aware recall. Because `memory-system-1.1-foundations` is still represented as an active change in this workspace, these deltas remain documented here until foundations is archived. Before this change is archived, they MUST be migrated into `specs/daemon-memory-pipeline/spec.md` as `## MODIFIED Requirements` when the cumulative capability exists.

## What Changes

- Consolidate all post-1.1 memory work under `memory-system-post-1-1-integration` instead of leaving phase-specific implicit plans.
- Establish Wave 1 primitives before product surfaces: stable kind-aware fingerprints, closed origin metadata, explicit authorization scope policy registry, first-class namespace registry, multi-class observation store, org-shared authored standards semantics, runtime feature flags, async telemetry, startup budget policy, named-stage selection, typed render policy, migration/backfill discipline, and cross-wave repair/backoff/idempotency gates.
- Implement Wave 2-5 in dependency order and keep every new surface disabled/fail-closed until its acceptance gates pass.
- Lock foundations regressions for every wave: ordinary `send` ack remains daemon receipt and never waits for memory/provider work; `/compact` stays SDK-native pass-through; `/stop` and approval/feedback remain priority-lane controls; recall/bootstrap failures still dispatch the original user message; redaction, scope filtering, source provenance, and materialization repair do not regress.
- Promote authorization-scope registry migration, cite-count ranking, namespace/observation migrations, enterprise org-shared authored standards, and skill auto-creation into current scope with concrete storage, identity, authorization, idempotency, backoff, and test gates instead of deferring them because they require migrations.
- Close the post-1.1 management UI/control-plane surface: server bridge single-casts management responses by `requestId`, daemon handlers authorize from server-derived context, Web mutation controls are disabled until feature state is known, daemon-managed feature flags can be enabled/disabled from the UI through persisted management RPCs, skill/MD management inputs are treated as untrusted, project browse defaults to all projects/no filter, project filter choices are populated from daemon/cloud/shared memory indexes plus known sessions/enrollments, and all management errors use shared codes plus localized UI strings.
- Replace ambiguous roadmap language with explicit requirements, failure modes, task ownership, and test anchors.

## Capabilities

### New Capabilities

- `daemon-memory-post-foundations`: Runtime contract for post-1.1 memory integration, including operational foundations, self-learning compression, quick search/citation/cite-count, MD/preference ingest, skills, safety gates, and future-candidate tracking.

### Modified Capabilities

- `daemon-memory-pipeline`: Archive-time migration target. Until `memory-system-1.1-foundations` is archived and the cumulative capability exists, foundations-touching behavior is captured as hard regression requirements in `daemon-memory-post-foundations` and in `tasks.md` archive gates. This is not a runtime deferral and does not weaken the current send/stop/compact contract.

## Acceptance Summary

The change is ready for implementation only when:

- `openspec validate memory-system-post-1-1-integration` passes.
- Every current-scope requirement has a stable ID, scenarios, implementation tasks, and test anchors; each test anchor is either an existing test path or an explicit task to create that path.
- Wave 1-5 tasks are present and later candidates are non-checkbox backlog items.
- Foundations regression tests for send ack, `/compact`, `/stop`, feedback/approval, recall/bootstrap failure, provider send-start, materialization repair, redaction, and scope/source safety are mandatory gates.
- Authorization-scope registry, org-shared authored standards, cite-count, namespace/observation, preference, and skill auto-creation behavior has explicit migration, idempotency, auth, backoff, disabled-feature, and replay tests.
- Management UI acceptance covers a searchable project selector/dropdown that defaults memory browsing to all projects, shows canonical ID plus directory when available, also lists canonical-only projects discovered from memory indexes, separates browse filtering from local file-backed action project selection, performs daemon-backed project resolution, and covers processed-memory manual add/edit/delete/archive/restore/pin, preference create/update/delete, skills, manual MD ingest, typed observation edit/delete/promotion with explicit from/to/effect confirmation before mutation, feature-state guards plus feature enable/disable controls, stale requestId rejection, bridge no-broadcast routing, record creator/owner metadata separate from management role, owner/scope authorization, symlink-safe skill preview, registry caps, and canonical project identity rejection.
- `docs/plan/mem1.1.md` remains historical rationale; these OpenSpec artifacts are the implementation authority.

## Impact

Future implementation will affect daemon memory modules (`src/context/*`, `src/store/context-store.ts`, `src/daemon/*`), shared utilities (`shared/*`), server migrations/search/scope surfaces (`server/src/*`), web quick-search/citation/skill UI (`web/src/*`), tests, and acceptance scripts. No breaking behavior is allowed for existing foundations flows.
