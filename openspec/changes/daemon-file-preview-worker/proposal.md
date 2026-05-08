## Why

Daemon `fs.read` requests currently run through the normal WebSocket command path and `handleFsRead` performs path expansion, canonical `realpath`, sensitive-path policy checks, metadata lookup, MIME classification, file reading, binary detection, base64/text preparation, video stream-mode classification, download-handle registration, cache handling, and response sending in the daemon main process.

Slow disks, network mounts, large base64 previews, repeated preview refreshes, and preview-triggered download-handle recovery can therefore add visible latency to unrelated daemon work. Moving uncached preview/read snapshot work into daemon-local worker threads gives preview work a bounded execution lane while preserving the existing browser/server/daemon protocol.

The previous draft left several implementation-critical ambiguities: how canonical freshness fan-out works when `realpath/stat` move out of the main path, whether the worker pool may auto-scale beyond the default, how local download errors are identified and sanitized, how worker restart generations are correlated, and how queue/admission deadlines are tested. This change closes those gaps before implementation.

## What Changes

- Route every valid protocol-level daemon `fs.read` request through a main-process preview-read coordinator.
- Use a two-phase worker execution model:
  - preflight job: path expansion, strict canonical `realpath`, policy check, `stat`, signature, size/MIME/video/too-large classification.
  - snapshot job: content read, binary detection, text/base64 preparation, video stream metadata, and start/end freshness verification.
- Keep uncached `realpath`, `stat`, content read, binary detection, and base64 conversion out of `handleFsRead`; main-process fast paths are limited to no-FS-I/O cache hits, already-validated response assembly, deadline/queue management, generation checks, and handle registration.
- Keep cache, inflight fan-out, resource generations, per-request deadlines, stale-completion suppression, and public response assembly in the main daemon coordinator.
- Use a bounded static worker pool in v1: default `workersTarget=2`, accepted range `1..4`, hard maximum `4`, one active worker job per worker, no auto-scaling, no more than thirty-two queued worker jobs, and no more than thirty-two attached external requestIds per worker job.
- Use deterministic admission control with an 18 second daemon deadline that starts at coordinator admission and remains below the server bridge 20 second `fs.read` pending timeout.
- Preserve the external `fs.read` / `fs.read_response` protocol; no browser/server migration, no new WebSocket message type, and no new endpoint are introduced.
- Preserve public wire error values and response shapes:
  - `binary_file`, `forbidden_path`, and `file_too_large` remain unchanged.
  - text success responses omit `encoding`.
  - image/office inline responses use `encoding: "base64"`.
  - video stream-mode responses omit inline `content`.
- Add shared fs-read error/preview-reason constants and prohibit production duplicate wire-string literals outside the shared module.
- Add stable worker failure codes for queue full, timeout, unavailable, crash, stale read, invalid request, and internal error.
- Sanitize frontend-visible `fs.read_response.error` values and all local file-transfer download errors so raw host paths, errno text, stack traces, and raw `Error.message` are not exposed.
- Extract a strict/lenient canonical path policy helper:
  - strict mode is used by worker-backed `fs.read` and download-handle creation and fails closed on `realpath` failure.
  - lenient mode preserves existing `fs.ls includeMetadata` best-effort behavior where appropriate, but fallback paths cannot create download handles.
- Harden local download-handle creation with a validated canonical path boundary while preserving `fs.ls includeMetadata` behavior for allowed files.
- Preserve short-lived path-handle semantics for `downloadId`; this change does not make download handles immutable content snapshots.
- Add explicit worker identity and generation fields so late completions from crashed/restarted workers cannot route to newer requests or update cache.
- Document v1 production fallback-disabled behavior and forbid runtime direct-read fallback for startup failure, timeout, crash, restart, and late completion paths.
- Fail fast with `preview_worker_unavailable` when the worker pool has no executable worker during startup/restart backoff and fallback is disabled.
- Prevent late snapshot completions from writing active cache entries after every attached external request has timed out or reached terminal state.
- Delete terminal coordinator/fan-out request records so long-running daemons do not retain completed preview metadata indefinitely.
- Wire production daemon shutdown into preview coordinator drain before the daemon disconnects from the server link.
- Reuse the shared lenient canonical helper for `fs.ls` metadata listings instead of ad hoc Windows realpath fallback.
- Add generic fs error constants, minimally sanitize `fs.write_response.error` catch-all failures, and fail closed when a new-file write target appears as a symlink before creation without moving `fs.write` into the preview worker pool.
- Add dev and compiled `dist/` worker-pool smoke coverage, not just a single-worker happy path.
- Add compiled `dist/` default daemon coordinator smoke coverage that runs outside Vitest/test-mode shims, starts real worker threads, proves success plus sanitized worker-visible errors reach the public `fs.read_response` send path, and locks non-preview command responsiveness while real preview workers are delayed.

## Scope

In scope:

- Every daemon `fs.read` request received by `handleFsRead`, including FileBrowser preview open, FileBrowser auto-refresh, download-handle recovery, and ChatView download-trigger behavior.
- Minimal shared-code and sanitization hardening for `fs.write_response.error` catch-all failures so non-preview filesystem commands do not keep using read-preview-specific constant names.
- Minimal `fs.write` new-target hardening for symlink races detected before exclusive creation; broader no-follow/open-by-fd write semantics remain out of scope.
- The v1 coordinator model: two-phase preflight/snapshot worker jobs, static worker pool, one active job per worker, bounded queueing, bounded attached requestIds, deterministic admission control, and per-request admission deadlines.
- Shared fs-read error/preview constants used by daemon, web, and server consumers.
- Daemon-local worker lifecycle, worker identity/generation, restart/backoff, optional job-count recycle, shutdown drain, timeout, crash handling, stale suppression, and dist packaging.
- Strict/lenient canonical path policy extraction, including Windows case-insensitive deny-list comparisons and macOS default case-insensitive deny-list behavior.
- Defense-in-depth local download-handle registration using validated canonical paths, with `fs.ls includeMetadata` regression coverage.
- Sanitized local file-transfer download errors for all `source: "local"` handles.
- Tests that lock protocol compatibility, security, freshness, fan-out, queue/admission, timeout, worker failure, packaging, and FileBrowser/ChatView no-regression behavior.

Out of scope:

- Adding `fs.read_cancel`, `fs.preview_read`, or any new public preview protocol in v1.
- Adding any new HTTP or WebSocket endpoint, including worker health or queue endpoints.
- Auto-scaling worker instances at runtime; v1 reads `workersTarget` once at coordinator creation and clamps it to `1..4`.
- Raising the hard worker cap above four without a separate OpenSpec change and memory/concurrency evidence.
- Running more than one active preview job inside a single worker.
- Tuning `UV_THREADPOOL_SIZE`; worker threads still share the process libuv filesystem pool.
- Moving `fs.ls`, `fs.git_status`, `fs.git_diff`, `fs.write`, file upload transfer, or local web-preview relay into this worker pool.
- Broadly sanitizing non-`fs.read` filesystem command errors beyond the minimal `fs.write_response.error` catch-all hardening in this change; only local file-transfer download errors are intentionally widened because the current local handle registry cannot reliably distinguish worker-backed origins.
- Providing content-snapshot download guarantees for `downloadId`.
- Replacing FileBrowser rendering or adding streaming inline text/image/office previews.
- Runtime policy hot reload; `policyVersion` is not part of v1 IPC.

## Capabilities

### New Capabilities

- `daemon-file-preview-worker`: Defines daemon-owned two-phase worker-pool execution for protocol-level `fs.read`, bounded static concurrency, deterministic admission, response routing, protocol compatibility, error-code, filesystem policy, download-handle, packaging, failure-mode, and validation requirements.

### Modified Capabilities

- `daemon-fs-cache`: `fs.read` freshness-safe cache, canonical alias fan-out, inflight reuse, per-request metadata, per-request deadlines, start/end signature validation, and memory-bound fan-out requirements must remain valid when preview execution moves behind daemon workers.

## Impact

- Daemon:
  - `src/daemon/command-handler.ts` `handleFsRead`
  - new `src/daemon/file-preview-read-coordinator.ts`
  - new `src/daemon/file-preview-read-pool.ts`
  - new `src/daemon/file-preview-read-admission.ts`
  - new `src/daemon/file-preview-read-fanout.ts`
  - new `src/daemon/file-preview-read-cache-facade.ts`
  - new `src/daemon/file-preview-read-worker.ts`
  - new `src/daemon/file-preview-read-worker-bootstrap.mjs`
  - new `src/daemon/file-preview-read-types.ts`
  - new `src/daemon/file-preview-path-policy.ts`
  - new `src/daemon/file-preview-classifier.ts`
  - `src/daemon/file-transfer-handler.ts` local handle validation and local download error sanitization
- Shared:
  - new `shared/fs-read-error-codes.ts` as the single source for fs-read error and preview-reason wire constants.
- Web/server:
  - `web/src/ws-client.ts` public `fsReadFile(path)` contract remains unchanged.
  - FileBrowser and ChatView continue to consume existing `fs.read_response` fields.
  - `server/src/ws/bridge.ts` requestId single-cast routing remains unchanged; tests cover timeout margin if constants are exported for verification.
- Tests:
  - shared constants and grep-gate tests
  - daemon policy, classifier, worker, coordinator, fan-out, cache, invalidation, file-transfer, fallback, and shutdown tests
  - fake-worker/fake-clock queue and admission tests
  - dist worker-pool smoke test
  - FileBrowser/ChatView no-regression tests
  - test-session hygiene tests if integration/e2e tests create sessions or projects

## Concurrency Answer

Multiple file-read workers are part of v1, but v1 is a static bounded pool, not an auto-scaling service. The coordinator lazily starts exactly `workersTarget` workers, defaulting to two. Configuration is clamped to the accepted range `1..4`; four is a hard v1 maximum. Each worker runs one active preflight or snapshot job at a time.

Different canonical files or different freshness states can run concurrently up to `workersTarget`. Additional distinct-freshness jobs queue, fail fast under the deterministic admission formula, or time out before the server bridge drops its 20 second pending entry. Identical canonical file plus identical freshness requests attach to one snapshot job and fan out one accepted snapshot instead of duplicating reads.

Worker threads share the daemon process libuv filesystem pool, so this improves JS event-loop and CPU/base64 isolation but does not guarantee unlimited filesystem throughput. The design intentionally keeps the default pool small and requires metrics before any future worker-cap increase.

## Pod-sticky Compatibility

This change introduces no daemon-dependent endpoint:

- `fs.read` and `fs.read_response` continue to flow over the existing server-id routed daemon WebSocket bridge.
- Download HTTP for stream-mode video and binary/too-large handles continues to use existing server-id routed download paths.
- The preview-read worker is daemon-local via `node:worker_threads`; it owns no cross-pod state.

Verification must confirm no new frontend fetch/WebSocket path bypasses `/api/server/:serverId/...` and no worker health/queue endpoint is added in v1.
