## Context

`fs.read` is a daemon protocol message, not a FileBrowser-only message. Web callers use `ws.fsReadFile(path)`, which sends `{ type: "fs.read", path, requestId }`. FileBrowser uses this path for preview open, auto-refresh, and fresh download-handle recovery. ChatView also uses it to obtain a `downloadId` before calling download logic.

Today `handleFsRead` performs all read/preview work in the main daemon process: path expansion, `realpath`, sensitive-directory policy, `stat`, MIME/video classification, download-handle registration, size cap checks, cache lookup, content read, binary detection, base64 conversion, and response sending. Existing `fsReadCache`, `fsReadInflight`, and `fsReadGenerations` are main-process state.

Binding constraints:

- Filesystem policy is not an allow-root model. The daemon runs as the user, permits broad user-readable filesystem access, and deny-lists sensitive home directories such as `.ssh`, `.gnupg`, and `.pki` after canonical `realpath`.
- Download handles are short-lived path handles, not immutable content snapshots.
- Public `fs.read_response` shape is observable: binary preview failure uses `binary_file`, text success omits `encoding`, image/office base64 uses `encoding: "base64"`, and video stream mode omits inline content.
- Server bridge holds `fs.read` pending entries for 20 seconds and single-casts by external `requestId`. Daemon terminal responses must arrive before that pending entry expires.

## Goals / Non-Goals

Goals:

- Move uncached `fs.read` preflight and snapshot work into daemon-local worker threads.
- Preserve the external `fs.read` / `fs.read_response` protocol and server bridge routing.
- Preserve current broad filesystem-access semantics while fixing sensitive-directory case-comparison gaps on Windows and default macOS.
- Preserve text, binary, image, office, video stream-mode, too-large, `downloadId`, and `mtime` behavior.
- Preserve existing wire error values and public response fields.
- Prevent frontend-visible raw filesystem/worker errors.
- Keep cache, inflight, generation, fan-out, deadlines, and response assembly in the main daemon coordinator.
- Provide bounded dev-version parallelism without unbounded worker creation.
- Make deadline, queue, fan-out, worker identity, restart, shutdown, packaging, and fallback behavior deterministic and testable.

Non-goals:

- New public preview protocol, endpoint, or `fs.read_cancel` in v1.
- Runtime auto-scaling or worker-count hot reload.
- `UV_THREADPOOL_SIZE` tuning.
- Moving non-`fs.read` filesystem/git operations into this worker pool.
- Broad non-`fs.read` error sanitization, except local file-transfer download errors.
- Immutable content snapshots for `downloadId`.
- Inline streaming of text/image/office previews.

## Quick Reference

- D1: bounded static worker pool
- D2: two-phase canonical keying
- D3: public protocol compatibility
- D4: coordinator entry and no uncached FS I/O in `handleFsRead`
- D5: main-owned cache/inflight/generation
- D6: restrictive worker IPC and identity
- D7: strict/lenient filesystem policy helper
- D8: validated download handles and local download sanitization
- D9: shared fs-read error codes
- D10: admission deadline and deterministic fail-fast formula
- D11: startup fallback and runtime failure rules
- D12: freshness validation and fan-out semantics
- D13: memory bounds and payload handling
- D14: build/dist worker bootstrap
- D15: shutdown drain
- D16: worker recycle observability
- D17: coordinator module boundaries
- D18: scope controls for non-`fs.read` callers
- D19: late-result cache guard and terminal cleanup
- D20: minimal generic fs error codes for `fs.write`

## Decisions

### D1: Use a bounded static daemon worker pool in v1

Use `node:worker_threads` with a bounded daemon-local worker pool. The coordinator lazily starts exactly `workersTarget` workers on first uncached `fs.read` work and keeps those workers alive until shutdown, restart, or optional recycle.

Default v1 pool settings:

- `workersTarget`: 2
- accepted range: `1..4`
- hard maximum: 4
- active jobs per worker: 1
- auto-scaling: out of scope

Configuration is read when the coordinator is created. Values below 1 clamp to 1; values above 4 clamp to 4 and produce a warning/metric. Tests must use constructor overrides instead of mutating process-global environment unless the parser itself is under test.

Rationale:

- The user explicitly wants multi-worker behavior in the dev version.
- A static pool makes admission and tests deterministic.
- Four is a hard v1 cap because 100 MB base64 payloads can multiply memory use quickly.
- Worker threads share the process libuv filesystem pool; more workers do not guarantee more filesystem throughput.

### D2: Use two-phase worker jobs for canonical freshness keying

All uncached `fs.read` work uses two worker phases:

1. **Preflight job**: expands the raw path, performs strict canonical `realpath`, applies the filesystem policy, runs `stat`, computes `startSignature`, and classifies size/MIME/video/too-large metadata. It does not read inline content or create a `downloadId`.
2. **Snapshot job**: runs for one canonical freshness key, reads content when needed, performs binary detection, prepares text/base64 or stream-mode metadata, and returns `startSignature` plus `endSignature`.

The coordinator stores each external request separately and uses the preflight result to build the canonical snapshot key:

```text
realPath::startSignature::resourceGeneration
```

Requests that arrive with different raw paths but resolve to the same canonical freshness attach to the same snapshot job. Public response assembly still uses each external request's original raw `path` field.

Rationale:

- The spec requires `handleFsRead` not to perform uncached `realpath` or `stat`.
- The cache/fan-out model requires canonical freshness reuse.
- Two-phase worker execution is the only v1 design that satisfies both constraints without weakening symlink/canonical behavior.

### D3: Preserve the public fs transport contract

The browser continues to send `fs.read` with `requestId` and `path`; daemon responses remain `fs.read_response`. The server bridge remains requestId-based and unaware of worker phases.

Public response compatibility rules:

- Text success responses MUST omit `encoding`.
- Image/office inline payloads MUST expose `encoding: "base64"`.
- Video stream-mode responses MUST expose `previewMode: "stream"` and MUST NOT include inline base64 content or `content`.
- Binary preview failure MUST keep `error: "binary_file"` and `previewReason: "binary"`.
- Existing public values `forbidden_path` and `file_too_large` MUST remain unchanged.

### D4: Route all valid daemon `fs.read` through the coordinator

All valid protocol-level `fs.read` requests enter `PreviewReadCoordinator`.

`handleFsRead` may:

- validate request shape and response addressability,
- return/suppress invalid requests according to D9,
- perform no-FS-I/O cache-hit checks if the coordinator exposes one,
- call the coordinator,
- assemble and send already validated responses if that responsibility remains in `command-handler.ts`.

`handleFsRead` MUST NOT perform uncached path expansion, `realpath`, `stat`, preview classification, content read, binary detection, or base64 conversion.

Production startup direct-read fallback is not part of v1. Worker startup failure in v1 must return the configured stable worker-unavailable terminal response instead of invoking a direct-loader path.

### D5: Keep cache, inflight fan-out, and generations in the main daemon

The main coordinator owns:

- `fsReadCache`,
- `fsReadInflight`,
- `fsReadGenerations`,
- external request records,
- preflight and snapshot job records,
- per-request deadline timers,
- fan-out maps,
- stale-completion suppression.

Workers are stateless per job. Workers must not own durable read cache, generation maps, external request IDs, server links, or download registry state.

### D6: Worker IPC schema is explicit and restrictive

Add `src/daemon/file-preview-read-types.ts`.

Worker request envelope fields:

- `phase: "preflight" | "snapshot"`
- `workerRequestId`
- `workerSlotId`
- `workerGeneration`

Preflight payload fields:

- `rawPath`

Snapshot payload fields:

- validated canonical `realPath`
- `startSignature`
- `size`
- classification metadata needed to avoid duplicate MIME/video decisions

Worker result fields:

- `phase`
- `workerRequestId`
- `workerSlotId`
- `workerGeneration`
- `kind: "success" | "error"`
- success metadata appropriate for the phase
- stable `FsReadErrorCode` on error
- optional `previewReason` using shared constants

The request/result schema MUST NOT include external `requestId`, `serverLink`, browser sockets, attachment IDs, download registry objects, `downloadId`, raw `Error.message`, stack traces, errno detail, or frontend-visible absolute path diagnostics.

The main coordinator MUST verify `workerSlotId` and `workerGeneration` on every result before routing or cache writeback.

`policyVersion` is not part of v1 IPC. Runtime policy hot reload is out of scope.

### D7: Use strict and lenient canonical path helper modes

Add `src/daemon/file-preview-path-policy.ts`.

The canonical helper exposes two modes:

```ts
type CanonicalMode = "strict" | "lenient";

async function resolveCanonical(
  rawPath: string,
  mode: CanonicalMode,
): Promise<{ realPath: string; usedFallback: boolean } | null>;
```

Strict mode:

- used by worker-backed `fs.read` and download-handle creation,
- MUST call `fs.realpath`,
- MUST fail closed on `realpath` rejection,
- MUST NOT use fallback to non-canonical paths,
- always returns `usedFallback: false` on success.

Lenient mode:

- used by `fs.ls includeMetadata` where best-effort UX is required,
- MUST call `fs.realpath` first,
- MUST NOT be used by ordinary `fs.ls` calls without `includeMetadata`,
- MAY fall back to the resolved path only for Windows-specific reparse/junction/symlink-loop failures with explicit error-message evidence,
- MUST fail closed for generic Windows `EPERM` or `UNKNOWN` realpath failures that do not identify a reparse/junction/symlink-loop condition,
- MUST mark fallback results with `usedFallback: true`,
- fallback paths MUST NOT create download handles.

Deny-list comparisons:

- Windows MUST compare canonical real path and denied prefixes case-insensitively after `path.win32.normalize`.
- macOS SHOULD compare case-insensitively by default after POSIX normalization.
- Linux and other platforms MUST preserve current case-sensitive behavior.
- `os.homedir()` MUST be read at helper invocation time, not cached at module load.

### D8: Main daemon validates download handles and sanitizes local downloads

The worker never creates or returns `downloadId`.

Download handle creation must use a validated canonical path boundary:

- `ValidatedRealPath` or an equivalent branded/opaque type is created only by strict canonical policy helpers or explicit revalidation.
- `createProjectFileHandleFromValidatedPath` (or equivalent) registers trusted handles.
- `tryCreateProjectFileHandle` (or equivalent) is used by tolerant callers such as `fs.ls includeMetadata` and returns `null` on policy failure or fallback paths.

All `source: "local"` download errors sent to the frontend MUST be sanitized to stable messages/codes such as `not_found`, `expired`, or `download_failed`. Raw paths, errno text, stack traces, and raw `Error.message` are logged only.

Rationale:

- The current registry has no reliable origin field, so limiting sanitization only to worker-backed `fs.read` handles is not enforceable.
- A worker bug must not be sufficient to register a denied path.

### D9: Stable shared error codes preserve existing wire values

Add `shared/fs-read-error-codes.ts`.

Required values:

- `binary_file`
- `forbidden_path`
- `file_too_large`
- `preview_worker_queue_full`
- `preview_worker_timeout`
- `preview_worker_unavailable`
- `preview_worker_crashed`
- `stale_read`
- `invalid_request`
- `internal_error`

Invalid request behavior:

- Missing external `requestId`: suppress because no response can be routed.
- Present `requestId` but missing/non-string/empty `path`: send exactly one `fs.read_response` with `status: "error"` and `error: "invalid_request"`; do not enqueue worker work.

Production code outside the shared constants module must not define duplicate fs-read wire strings. Tests and specs may assert literal legacy values.

### D10: Worker deadlines start at coordinator admission with deterministic admission control

The daemon deadline is 18 seconds and starts when a valid external `fs.read` request enters the coordinator. It includes preflight queue wait, preflight execution, snapshot queue wait, snapshot execution, response assembly, and fan-out delay.

The coordinator uses this deterministic admission formula:

```text
projectedWaitMs = ((queueDepth + 1) * tEstimateMs) / workersTarget
reject if projectedWaitMs + tEstimateMs > deadlineMs - safetyMarginMs
```

Definitions:

- `workersTarget`: configured worker instance count, default 2, clamped to `[1, 4]`.
- `queueDepth`: queued jobs only; active jobs are not counted here.
- `tEstimateMs`: rolling median of the last 16 completed worker jobs' active execution durations; seed 1500 ms.
- `deadlineMs`: 18000.
- `safetyMarginMs`: 2000.

The bounded queue cap of 32 is an upper-bound safeguard; admission control may reject earlier.

Constructor options must allow tests to override worker count, queue cap, deadline, safety margin, fake clock, and `tEstimateMs`.

The admission deadline must be propagated to worker-pool scheduling as pool-local metadata, not as part of the worker IPC message. The worker pool must check the remaining deadline budget before enqueue, before dispatch from the queue, and when arming the active-job watchdog. Active watchdog duration must be `min(activeJobTimeoutMs, deadlineAt - now)` when a deadline exists. A job whose deadline has already expired must reject with timeout without entering the worker. Preflight and snapshot phases for a request share the same admission-time deadline.

### D11: Startup fallback is explicit; runtime fallback is forbidden

Startup fallback remains explicit and disabled in v1 production. If the real worker path cannot produce a terminal result, the request receives a stable worker error such as `preview_worker_unavailable`, `preview_worker_crashed`, or `preview_worker_timeout`; it does not synchronously re-enter the old main-process file-read path.

The only direct in-process worker path in v1 is test-only and gated by Vitest-specific signals. A bare `NODE_ENV=test` is not sufficient to enable it, because dist/manual daemon runs may be misconfigured with that value. It is not a production startup fallback and must not be enabled by normal dist startup.

Future rollout direct fallback, if ever required, must be proposed in a separate OpenSpec change with its own direct-loader module, performance budget, and tests. It is intentionally not implemented by this v1 change.

Runtime timeout, worker crash, worker restart, stale result, and late completion MUST NOT synchronously fallback to direct read for the affected request. Those requests receive stable terminal errors and future requests may use restarted workers.

### D12: Freshness is verified with start and end signatures

Preflight returns a `startSignature`. Snapshot returns `startSignature` and `endSignature`. If signatures differ, the main coordinator MUST NOT cache the result and MUST return `stale_read` rather than a mixed success.

Once the coordinator accepts a snapshot for fan-out, currently active attached requestIds receive that accepted snapshot unless their own deadline has already fired. Later invalidation affects future requests and cache writeback decisions, not already accepted fan-out sends.

### D13: Fan-out and memory are bounded

Default coordinator settings:

- `workersTarget`: 2
- `hardMaxWorkers`: 4
- active worker jobs: one per worker instance
- queued worker jobs: 32
- attached external requestIds per worker job: 32
- daemon deadline: 18 seconds from coordinator admission

Queue entries store metadata only, not preview content. Identical-freshness fan-out retains one accepted worker snapshot before serialization. Fan-out sends MUST be serialized or otherwise prove equivalent peak-memory bounds.

Each external requestId has an independent timer armed at admission. If a timer fires before that request is sent, the coordinator MUST produce the terminal timeout response and MUST NOT wait for the fan-out queue to reach that request.

The main-worker IPC for large payloads SHOULD prefer transferable `ArrayBuffer` or equivalent single-copy transfer. If v1 cannot avoid copies, memory behavior must be documented before increasing any default cap.

Final v1 implementation keeps Node worker structured-clone payload transfer for strings and buffers instead of adding a transferable `ArrayBuffer` protocol. Peak memory is bounded by default two workers, hard maximum four workers, one active job per worker, queue metadata only, attached request cap thirty-two, serialized fan-out, video stream-mode avoiding base64, and default worker recycle after fifty completed jobs. A worst-case image/office/text preview can still duplicate a large payload across worker and main isolate during transfer and response serialization; the current 100 MB cap is therefore not raised in this change. Future cap increases or a higher worker maximum require measured RSS/heap evidence or a transferable-payload follow-up.

### D14: Build uses the existing worker bootstrap pattern

Add `src/daemon/file-preview-read-worker-bootstrap.mjs` and resolve it like `jsonl-parse-worker-bootstrap.mjs`. The existing postbuild copy script must copy this `.mjs` into `dist/src/daemon/`.

Dist smoke must start the default pool size and dispatch at least two representative concurrent jobs, not merely prove a single worker bootstrap can load.

Worker test fixtures must live under `test/` or be excluded from the bootstrap-copy path; `src/**/*.mjs` bootstrap copying must not accidentally package test fixtures.

### D15: Graceful shutdown drains pending preview requests

The coordinator exposes a shutdown/drain operation. During daemon graceful shutdown, active and queued preview reads should receive `preview_worker_unavailable` within a bounded shutdown budget, such as 1 second, instead of waiting for the server bridge pending timeout. Shutdown drain must not wait for slow preview reads to finish normally.

Production `lifecycle.shutdown()` must call the default preview-read coordinator drain before `serverLink.disconnect()` so terminal unavailable responses still have a live daemon/server transport.

### D16: Worker recycle is optional but lifecycle observability is required

The coordinator SHOULD support job-count recycle:

- default `WORKER_RECYCLE_JOB_COUNT`: 50,
- recycle after the current job completes,
- replacement starts before the next dispatch to that slot,
- recycle must not cancel or duplicate jobs on other workers.

Regardless of whether automatic recycle is implemented in v1, worker lifecycle logs/metrics MUST include worker startup, shutdown, restart, crash, recycle if present, job count, queue full, timeout, stale read, and sanitized internal errors. Lifecycle logs must not include raw paths or raw filesystem errors.

### D17: Coordinator module boundaries are explicit

The preview-read coordinator should be implemented as composed modules instead of one large class:

```text
file-preview-read-coordinator.ts     entry/orchestrator
file-preview-read-pool.ts            WorkerPool lifecycle, dispatch, restart, optional recycle
file-preview-read-admission.ts       AdmissionQueue formula and queue cap
file-preview-read-fanout.ts          FanOutDispatcher timers and sequential send
file-preview-read-cache-facade.ts    ReadCacheFacade for cache/inflight/generation
file-preview-read-shutdown.ts        DrainController for graceful shutdown
```

Dependency direction:

- coordinator mediates all submodules,
- submodules do not import each other directly,
- only `WorkerPool` talks to worker threads,
- each submodule is testable with fake clock and fake collaborators.

### D18: Scope controls for non-fs.read callers

Non-`fs.read` callers may reuse extracted policy helpers only when behavior stays compatible. This change must not quietly alter `fs.write`, `fs.git_status`, `fs.git_diff`, or `fs.mkdir` public error behavior. If those call sites are touched for helper reuse, focused regression tests must prove existing public behavior remains intact.

`fs.ls includeMetadata` is the intended non-`fs.read` caller affected by handle hardening. Allowed normal files must still receive `downloadId`; denied or fallback paths must omit `downloadId` without failing the entire directory listing.

### D19: Late completions and terminal records are cleaned up

The coordinator must treat request terminal state as the source of truth for cache writeback eligibility. A snapshot result whose attached requestIds have all timed out or otherwise reached terminal state must not be written into active `fs.read` cache. When at least one attached request remains eligible at completion time, the coordinator may write one active cache entry and fan out only to still-eligible requestIds.

Terminal fan-out records and external request records are deleted after their terminal transition. Late preflight/snapshot completions that reference deleted requestIds naturally skip response assembly and cannot send duplicate terminal responses.

### D20: Generic filesystem error codes are separated from read-preview-specific codes

`shared/fs-error-codes.ts` owns generic filesystem protocol codes used by more than one `fs.*` command: `forbidden_path`, `file_too_large`, `invalid_request`, and `internal_error`. `shared/fs-read-error-codes.ts` extends those generic values with preview/read-specific values such as `binary_file`, `preview_worker_timeout`, and `stale_read`.

`fs.write` remains outside the preview worker pool, but its catch-all error responses must use generic stable codes rather than raw `Error.message` or read-preview-specific constant names. New-target writes must fail closed if the target appears as a symlink after the initial existence check and before exclusive creation; a full no-follow/open-by-fd rewrite is left to a dedicated filesystem-write hardening change.

## Risks / Trade-offs

- Two-phase preflight adds one worker round trip. This is accepted to keep uncached `realpath/stat` out of `handleFsRead` while retaining canonical freshness fan-out.
- Worker threads share libuv filesystem threads. This isolates JS event-loop and CPU/base64 work, not physical filesystem throughput.
- Four workers with 100 MB base64 payloads can still cause high memory pressure. Hard cap, admission control, fan-out serialization, metrics, and optional recycle mitigate the risk.
- Strict/lenient policy modes introduce two behaviors. Tests must prove `fs.read` stays strict and `fs.ls includeMetadata` retains best-effort behavior without creating fallback download handles.
- All local download error sanitization intentionally widens scope. This avoids unverifiable origin inference and is safer than partial sanitization.

## Migration Plan

1. Freeze shared public wire constants and response compatibility tests.
2. Extract strict/lenient policy helpers and classifier helpers.
3. Harden local handle creation with validated canonical paths and sanitized local download errors.
4. Add worker IPC types, two-phase worker, and bootstrap.
5. Add coordinator submodules: worker pool, admission, fan-out, cache facade, shutdown drain.
6. Integrate `handleFsRead` with coordinator and public response assembly.
7. Add tests and validation gates listed in `tasks.md`.

Rollback:

- Set `workersTarget=1`.
- Worker startup fallback is already disabled in v1; rollback must not enable direct-read fallback.
- Keep shared constants, policy helper fixes, and local handle hardening because they close existing safety gaps.
- No database or external protocol rollback is required.

## Open Questions

These are follow-ups, not v1 blockers:

1. Should image/office base64 preview get a lower cap than the current general preview size limit after memory measurements?
2. Should future versions add `fs.read_cancel`?
3. Should future versions tune `UV_THREADPOOL_SIZE` for heavy preview deployments?
4. Should macOS case-insensitive deny-list behavior become a hard MUST after compatibility feedback?
5. Should worker recycle become mandatory after heap/RSS measurements?
