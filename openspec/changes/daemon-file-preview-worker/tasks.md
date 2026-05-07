## 0. OpenSpec Consistency Gate

- [x] 0.1 Verify `proposal.md`, `design.md`, `specs/daemon-file-preview-worker/spec.md`, `specs/daemon-fs-cache/spec.md`, and `tasks.md` all describe the same v1 model: two-phase worker preflight/snapshot, static worker pool, hard max four workers, no auto-scale, no runtime policy hot reload
- [x] 0.2 Run `openspec validate daemon-file-preview-worker --strict` before implementation begins

## 1. Protocol Constants And Compatibility

- [x] 1.1 Add `shared/fs-read-error-codes.ts` with `FS_READ_ERROR_CODES`, `FsReadErrorCode`, `FS_READ_PREVIEW_REASONS`, `FsReadPreviewReason`, and type guards
- [x] 1.2 Preserve existing public wire values in shared constants: `binary_file`, `forbidden_path`, and `file_too_large`
- [x] 1.3 Add stable worker/control codes: `preview_worker_queue_full`, `preview_worker_timeout`, `preview_worker_unavailable`, `preview_worker_crashed`, `stale_read`, `invalid_request`, and `internal_error`
- [x] 1.4 Replace production hardcoded fs-read error and preview-reason literals in `src/daemon/command-handler.ts`, `web/src/components/FileBrowser.tsx`, and any server/web consumers with shared imports
- [x] 1.5 Add shared tests proving exported values are stable, type-safe, and preserve legacy wire strings
- [x] 1.6 Add a grep gate that scans production sources only (`src/`, `web/src/`, `server/src/`) and excludes `shared/fs-read-error-codes.ts`, `**/*.test.ts`, `**/test/**`, `**/__fixtures__/**`, and `openspec/**`; production code outside the shared module MUST NOT define fs-read wire error literals
- [x] 1.7 Add a contract test proving UI/server consumers handle unknown shared worker error codes as generic failures without treating them as success

## 2. Extract Preview Policy And Classification Primitives

- [x] 2.1 Add `src/daemon/file-preview-path-policy.ts` with strict/lenient canonical helper modes and a branded/opaque `ValidatedRealPath` or equivalent type
- [x] 2.2 Implement strict mode for worker-backed `fs.read` and handle creation: call `fs.realpath`, fail closed on rejection, never use fallback paths
- [x] 2.3 Implement lenient mode for `fs.ls includeMetadata`: call `fs.realpath` first and allow only documented Windows reparse fallback paths with `usedFallback: true`
- [x] 2.4 Ensure fallback paths cannot create download handles
- [x] 2.5 Preserve current broad user-permission filesystem policy: no allow-root model; deny sensitive home directories `.ssh`, `.gnupg`, and `.pki`
- [x] 2.6 Fix deny-list comparison to be case-insensitive on Windows; default macOS behavior SHOULD also be case-insensitive; Linux and other platforms remain case-sensitive
- [x] 2.7 Ensure policy helpers read `homedir()` at call time and do not cache `homedir()` or `process.env.HOME` at module load
- [x] 2.8 Add policy unit tests for allowed paths, denied paths, symlink into denied paths, Windows mixed-case `.SSH/.GnuPG/.PKI`, default macOS mixed-case deny behavior, Linux case-sensitive `.SSH`, strict realpath failure, lenient fallback, and per-call home directory freshness
- [x] 2.9 Add `src/daemon/file-preview-classifier.ts` for MIME classification, video stream-mode detection, office/image detection, size limit constants, binary detection helpers, and file-signature helpers
- [x] 2.10 Add classifier tests for text, binary, image, office, video, too-large, unknown extension, and signature helper behavior
- [x] 2.11 If non-`fs.read` callers are touched while extracting helpers, add focused regression tests proving their public error behavior remains unchanged except for local download error sanitization

## 3. Download Handle And File Transfer Hardening

- [x] 3.1 Update `src/daemon/file-transfer-handler.ts` so local file handles are created only from `ValidatedRealPath` or an equivalent validated canonical boundary
- [x] 3.2 Add `createProjectFileHandleFromValidatedPath` or equivalent throwing helper for already revalidated paths
- [x] 3.3 Add `tryCreateProjectFileHandle` or equivalent non-throwing helper for tolerant callers such as `fs.ls includeMetadata`
- [x] 3.4 Preserve existing short-lived path-handle semantics; document that `downloadId` does not represent an immutable content snapshot
- [x] 3.5 Sanitize all frontend-visible `file.download_error` responses for `source: "local"` handles to stable values such as `not_found`, `expired`, or `download_failed`
- [x] 3.6 Ensure raw paths, errno text, stack traces, and raw `Error.message` appear only in logs, not frontend-visible download errors
- [x] 3.7 Add tests proving denied canonical paths cannot register handles, fallback paths cannot register handles, direct denied handle creation fails without registry entry, too-large/binary validated paths keep downloadable handles, and local download errors are sanitized
- [x] 3.8 Add `fs.ls includeMetadata=true` regression tests proving allowed normal files still receive `downloadId` and denied/fallback entries omit `downloadId` without failing the full listing

## 4. Worker IPC And Bootstrap

- [x] 4.1 Add `src/daemon/file-preview-read-types.ts` with strict request/result unions for preflight and snapshot phases
- [x] 4.2 Include `phase`, `workerRequestId`, `workerSlotId`, and `workerGeneration` in worker envelopes and results
- [x] 4.3 Ensure worker IPC types explicitly forbid `serverLink`, browser sockets, external requestIds, download registry objects, `downloadId`, raw `Error.message`, stack traces, and errno details
- [x] 4.4 Do not include `policyVersion` in v1 IPC; runtime policy hot reload remains out of scope
- [x] 4.5 Add `src/daemon/file-preview-read-worker.ts` implementing stateless preflight and snapshot job handlers using the extracted policy/classifier helpers
- [x] 4.6 Preflight job MUST perform path expansion, strict canonical `realpath`, policy check, `stat`, signature, size/MIME/video/too-large classification, and return no content/downloadId
- [x] 4.7 Snapshot job MUST perform content read, binary detection, text/base64 preparation or stream metadata, and start/end signature reporting
- [x] 4.8 Prefer transferable `ArrayBuffer` or equivalent single-copy payload strategy for large content IPC; if not implemented in v1, document measured copy/memory behavior
- [x] 4.9 Add `src/daemon/file-preview-read-worker-bootstrap.mjs` using the same dev/dist bootstrap pattern as `src/daemon/jsonl-parse-worker-bootstrap.mjs`
- [x] 4.10 Verify `scripts/copy-worker-bootstraps.mjs` copies the new bootstrap into `dist/src/daemon/` after `npm run build`
- [x] 4.11 Ensure fake-worker fixtures live under `test/` or are excluded from production `.mjs` bootstrap copying
- [x] 4.12 Add worker tests covering preflight success/error, snapshot text/image/office/video/too-large/binary/stale, strict policy rejection, sanitized errors, and no forbidden IPC fields
- [x] 4.13 Add a dist worker-pool smoke test that runs after build, starts the default worker count, and completes at least two representative concurrent jobs

## 5. Coordinator Submodules And State Model

- [x] 5.1 Add `src/daemon/file-preview-read-pool.ts` with `WorkerPool` lifecycle, dispatch, slot identity, generation validation, restart/backoff, shutdown, and optional job-count recycle hooks
- [x] 5.2 Add `src/daemon/file-preview-read-admission.ts` with deterministic admission formula, queue cap, `workersTarget`, `tEstimateMs` rolling median, deadline, safety margin, and fake-clock/test overrides
- [x] 5.3 Add `src/daemon/file-preview-read-fanout.ts` with per-request timers, exactly-once terminal responses, sequential send or equivalent memory bounds, and timeout-before-send behavior
- [x] 5.4 Add `src/daemon/file-preview-read-cache-facade.ts` owning `fsReadCache`, `fsReadInflight`, `fsReadGenerations`, cache keys, invalidation, and cache writeback eligibility
- [x] 5.5 Add `src/daemon/file-preview-read-shutdown.ts` or equivalent drain controller for bounded graceful shutdown responses
- [x] 5.6 Compose the submodules in `src/daemon/file-preview-read-coordinator.ts`; submodules MUST NOT import each other directly, and only `WorkerPool` talks to worker threads
- [x] 5.7 Define `ExternalRequestRecord` with external requestId, rawPath, admittedAt, deadlineAt, terminal state, and attachment state
- [x] 5.8 Define preflight job records keyed by raw admission groups and snapshot job records keyed by `realPath::signature::resourceGeneration`
- [x] 5.9 Define worker slot state with slotId, generation, state (`idle`, `busy`, `restarting`, `dead`), current job, and job count
- [x] 5.10 Add tests for each submodule with fake clocks and fake collaborators before coordinator integration tests

## 6. Two-Phase Coordinator Behavior

- [x] 6.1 Implement request admission: missing requestId suppresses; invalid path with requestId returns exactly one `invalid_request`; valid requests receive an admission deadline immediately
- [x] 6.2 Implement preflight queueing/dispatch through `WorkerPool`; queued preflight time counts against the external request deadline
- [x] 6.3 Implement canonical snapshot key migration after preflight; raw aliases that canonicalize to identical freshness attach to one snapshot job
- [x] 6.4 Ensure each final public response uses the request's original raw `path` and the worker canonical `resolvedPath`
- [x] 6.5 Implement changed-freshness behavior: changed signature or resource generation starts a new snapshot job rather than attaching to old work
- [x] 6.6 Implement start/end signature validation; changed signatures return `stale_read` and never cache mixed results
- [x] 6.7 Implement generation-aware cache writeback and invalidation for successful `fs.write` or other daemon mutations
- [x] 6.8 Implement queue full, fan-out cap, deterministic admission fail-fast, timeout, unavailable, crashed, stale, invalid, and internal terminal responses using shared codes
- [x] 6.9 Implement worker restart generation suppression: stale `workerSlotId`/`workerGeneration` results are ignored and cannot route or update cache
- [x] 6.10 Implement shutdown drain that sends `preview_worker_unavailable` for active/queued requestIds within a bounded budget
- [x] 6.11 Add fake-worker/fake-clock integration tests for canonical aliases, same freshness fan-out, changed freshness, invalidation during preflight, invalidation during snapshot, queue cap, deterministic admission boundary, timeout from admission, worker crash, worker restart generation, late completion, fan-out cap, shutdown drain, exactly-once responses, and raw path preservation
- [x] 6.12 Add responsiveness tests proving at least one non-`fs.read` daemon dispatch path completes while all fake worker slots are blocked; document that filesystem throughput isolation is not guaranteed because workers share libuv

## 7. Command Handler And Public Response Assembly

- [x] 7.1 Update `handleFsRead` in `src/daemon/command-handler.ts` to validate request shape and delegate valid protocol-level `fs.read` requests to the coordinator
- [x] 7.2 Remove uncached filesystem I/O and preview classification from the main `handleFsRead` path; allow only validation, no-FS-I/O cache hits if exposed by the coordinator, deadline/queue orchestration, result revalidation, handle creation, and response assembly
- [x] 7.3 Add `src/daemon/file-preview-read-response.ts` or equivalent response assembler if needed to keep `command-handler.ts` small
- [x] 7.4 Assemble final public `fs.read_response` with current fields preserved for text, image, office, video stream-mode, too-large, binary, stale, invalid, and generic worker errors
- [x] 7.5 Add response assembly tests proving text success omits `encoding`, image/office include only `encoding: "base64"`, video stream-mode omits inline `content`, binary uses `binary_file` with `previewReason: "binary"`, too-large includes `downloadId`, stale uses `stale_read`, and invalid uses `invalid_request`
- [x] 7.6 Ensure late responses for timed-out external requestIds are ignored and do not update UI-visible state or active cache

## 8. Startup Fallback And Runtime Failure Behavior

- [x] 8.1 Document v1 production fallback-disabled mode; no production direct-loader module is enabled for rollout
- [x] 8.2 Keep the direct in-process worker path test-only and gated to Vitest-specific environment signals, reusing the same policy/classifier/worker helpers as the worker path
- [x] 8.3 Return stable worker terminal errors for disabled fallback and runtime failure paths instead of re-entering main-process direct reads
- [x] 8.4 Ensure runtime timeout, crash, restart, stale completion, and late completion never direct-read fallback for the affected request
- [x] 8.5 Add tests for timeout, crash, stale/late completion, shutdown unavailable, test-only worker behavior, and dist real-worker default coordinator behavior

## 9. Worker Lifecycle Observability And Optional Recycle

- [x] 9.1 Add structured logs and metrics/counters for worker startup, shutdown, unavailable, queue full, timeout, crash, restart, stale read, shutdown drain, optional recycle, and sanitized internal errors
- [x] 9.2 Ensure diagnostics do not include raw paths, errno text, stack traces, or raw worker exception messages from preview jobs
- [x] 9.3 If job-count recycle is implemented, default `WORKER_RECYCLE_JOB_COUNT` to 50 and recycle only after the current job response is settled
- [x] 9.4 Add tests proving optional recycle does not cancel or duplicate jobs on other workers and replacement workers get a new generation

## 10. Web And Server No-Regression Coverage

- [x] 10.1 Keep `web/src/ws-client.ts` `fsReadFile(path)` public signature and wire format unchanged
- [x] 10.2 Update FileBrowser tests to use shared fs-read constants and prove existing UI states still handle text, image, office, video stream-mode, too-large, binary, stale read, invalid request, and generic worker errors
- [x] 10.3 Add or update FileBrowser stale-cycle tests proving late `fs.read_response` messages after rapid file switching are ignored
- [x] 10.4 Add ChatView download-trigger coverage proving `ws.fsReadFile(path)` can still obtain a `downloadId` and call the existing server-id routed download path
- [x] 10.5 Keep server bridge routing unchanged unless implementation changes duplicate-requestId or timeout behavior; if changed, add `server/test/bridge.test.ts` coverage
- [x] 10.6 Add bridge-margin coverage proving daemon timeout responses, including queued/preflight/snapshot timeouts, arrive before the server bridge 20 second pending deletion
- [x] 10.7 Verify no new daemon-dependent frontend fetch/WebSocket path bypasses `/api/server/:serverId/...`

## 11. Test Hygiene And Integration

- [x] 11.1 If worker integration or e2e tests create temporary projects/cwds or tmux sessions, add `imcodes-test-preview-*` and `deck_test_preview_*` coverage to `shared/test-session-guard.ts`
- [x] 11.2 Add `test/shared/test-session-guard.test.ts` coverage for any new preview-worker test prefixes
- [x] 11.3 Add real-worker integration tests under `test/daemon/` using guarded temporary paths and cleaning all fixtures
- [x] 11.4 Add a CI hygiene assertion or documented validation that `~/.imcodes/sessions.json` contains no `deck_test_preview_*` entries after tests

## 12. Validation And Rollout

- [x] 12.1 Run `openspec validate daemon-file-preview-worker --strict`
- [x] 12.2 Run daemon focused tests for fs-read constants, policy, classifier, worker IPC, worker implementation, coordinator submodules, cache freshness, write invalidation, public response assembly, file-transfer handle hardening, startup fallback, shutdown drain, and lifecycle observability
- [x] 12.3 Run web FileBrowser and ChatView focused tests
- [x] 12.4 Run `npx tsc --noEmit`
- [x] 12.5 Run `npx tsc -p server/tsconfig.json --noEmit`
- [x] 12.6 Run `cd web && npx tsc --noEmit`
- [x] 12.7 Run `npm run build` and verify dist worker bootstrap and implementation artifacts exist
- [x] 12.8 Run the dist worker-pool smoke test in CI after build without skipping
- [x] 12.9 Document final `workersTarget`, hard max, queue cap, attached cap, deadline, safety margin, t-estimate seed, fallback mode, local-download sanitization behavior, and non-blocking future decisions around base64 caps, `fs.read_cancel`, worker recycle, and `UV_THREADPOOL_SIZE`

## 13. Post-Audit Conformance Fixes

- [x] 13.1 Update OpenSpec artifacts for late snapshot cache suppression, terminal record cleanup, startup fail-fast unavailable, active job watchdog, production shutdown drain, fs.ls lenient canonical reuse, and minimal fs.write generic-code sanitization
- [x] 13.2 Add `shared/fs-error-codes.ts` with generic fs error codes and make `FS_READ_ERROR_CODES` extend the generic set without changing public wire values
- [x] 13.3 Ensure `fs.write` uses generic fs error codes for invalid, too-large, forbidden, and unexpected internal errors, and never returns raw `Error.message` in catch-all failures
- [x] 13.4 Ensure `fs.ls includeMetadata=true` uses bounded lenient canonical fallback, ordinary `fs.ls` remains strict, broad Windows fallback logging is removed, and fallback paths are non-downloadable
- [x] 13.5 Delete terminal fan-out and coordinator external request records while preserving exactly-once terminal response behavior
- [x] 13.6 Prevent snapshot results from writing active cache when no attached requestId remains eligible
- [x] 13.7 Add pool active-job watchdog and fail-fast unavailable behavior when no worker slot can execute requests
- [x] 13.8 Connect daemon lifecycle shutdown to default preview-read coordinator drain before server link disconnect
- [x] 13.9 Fix test-only direct worker canonicalization so denied paths map through the same worker policy branch as real worker execution
- [x] 13.10 Expand focused tests for late snapshot cache suppression, terminal record cleanup, startup unavailable, active worker timeout/restart, fs.write sanitization, production shutdown hook ordering, and production-source static error-code gate

## 14. Final Implementation Audit Closure

- [x] 14.1 Remove production direct-loader fallback requirements from proposal/design/specs and document v1 fallback-disabled behavior
- [x] 14.2 Gate the in-process direct worker shim on Vitest-specific signals only; bare `NODE_ENV=test` must use the real worker pool
- [x] 14.3 Restrict `fs.ls` lenient canonical fallback to `includeMetadata=true`; ordinary listings must remain strict
- [x] 14.4 Fail closed for generic Windows `EPERM`/`UNKNOWN` realpath errors unless the message identifies reparse/junction/symlink-loop fallback evidence
- [x] 14.5 Propagate admission deadline to worker-pool scheduling as pool-local metadata without adding it to worker IPC
- [x] 14.6 Enforce remaining deadline budget before enqueue, before worker post, and in active watchdog timers for both preflight and snapshot jobs
- [x] 14.7 Drain queued worker jobs with unavailable when all live worker capacity disappears and replacement workers cannot start
- [x] 14.8 Add required dist smoke mode, package script, and CI job so missing dist artifacts fail instead of silently skipping
- [x] 14.9 Add real dist/daemon responsiveness smoke coverage showing non-preview commands remain visible while preview workers are delayed
- [x] 14.10 Add minimal `fs.write` new-target symlink hardening and sanitized regression coverage
- [x] 14.11 Run final strict OpenSpec validation, focused tests, build, dist smoke, and full test suite
