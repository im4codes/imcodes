## ADDED Requirements

### Requirement: Daemon SHALL route valid fs.read requests through the preview-read coordinator
The daemon SHALL route every valid protocol-level `fs.read` request received by `handleFsRead` through a main-process preview-read coordinator backed by daemon-local workers. The external `fs.read` / `fs.read_response` protocol SHALL remain backward compatible.

#### Scenario: valid fs.read enters coordinator
- **WHEN** the daemon receives `fs.read` with a non-empty string `path` and string `requestId`
- **THEN** the daemon MUST schedule the request through the preview-read coordinator
- **AND** it MUST NOT perform uncached path expansion, `realpath`, `stat`, preview classification, content read, binary detection, or base64 conversion directly in `handleFsRead`

#### Scenario: request without requestId is suppressed
- **WHEN** an `fs.read` request has no string `requestId`
- **THEN** the daemon MUST NOT enqueue worker work
- **AND** it MAY suppress the request because no response can be routed

#### Scenario: invalid path with requestId returns invalid_request
- **WHEN** an `fs.read` request has a string `requestId`
- **AND** `path` is missing, not a string, or an empty string
- **THEN** the daemon MUST send exactly one terminal `fs.read_response`
- **AND** the response MUST use the shared `invalid_request` error code
- **AND** the request MUST NOT be enqueued to the preview worker

#### Scenario: response contract remains compatible
- **WHEN** a worker-backed `fs.read` completes
- **THEN** the daemon MUST send `fs.read_response` with the original external `requestId`
- **AND** the response MUST use existing public fields only where those fields already apply
- **AND** the public `path` field MUST be the original raw path for that external request
- **AND** `resolvedPath` MUST be the canonical path from worker preflight or snapshot metadata

#### Scenario: existing server bridge remains sufficient
- **WHEN** the server bridge receives a worker-backed `fs.read_response`
- **THEN** it MUST be able to single-cast the response using its existing `requestId` pending map
- **AND** this change MUST NOT require a new server routing protocol or new endpoint

### Requirement: Worker-backed fs.read SHALL preserve public response compatibility
Worker-backed reads SHALL preserve current public `fs.read_response` wire values and field presence for existing success and error cases.

#### Scenario: text preview omits encoding
- **WHEN** a supported text file is returned inline
- **THEN** the daemon MUST return `status: "ok"` with `content`
- **AND** the public response MUST NOT include an `encoding` field

#### Scenario: image and office preview returns base64
- **WHEN** the canonical path passes policy validation and the file is a supported image or office preview type within the size limit
- **THEN** the daemon MUST return `status: "ok"` with `encoding: "base64"`, `content`, `mimeType`, `downloadId`, and `mtime`

#### Scenario: video preview remains stream-mode
- **WHEN** the canonical path passes policy validation and the file is a supported video preview type within the size limit
- **THEN** the daemon MUST return `status: "ok"` with `previewMode: "stream"`, `mimeType`, `size`, `downloadId`, and `mtime`
- **AND** it MUST NOT base64-encode the video content into the WebSocket response
- **AND** it MUST NOT include inline `content`

#### Scenario: binary preview keeps existing public error code
- **WHEN** the canonical path passes policy validation but binary detection rejects inline text preview
- **THEN** the daemon MUST return `status: "error"` with the shared `binary_file` error code and `previewReason: "binary"`
- **AND** the response MUST include a `downloadId` governed by the existing file-transfer handle TTL

#### Scenario: oversized preview keeps downloadable handle
- **WHEN** the canonical path passes policy validation and the file exceeds the preview read size limit
- **THEN** the daemon MUST return `status: "error"` with the shared `file_too_large` error code and `previewReason: "too_large"`
- **AND** the response MUST include a `downloadId` governed by the existing file-transfer handle TTL

### Requirement: Worker-backed fs.read SHALL use two-phase worker execution
Uncached worker-backed reads SHALL use a worker preflight phase before any content snapshot phase so canonical freshness fan-out remains possible without doing uncached `realpath` or `stat` in `handleFsRead`.

#### Scenario: preflight resolves canonical freshness
- **WHEN** a valid uncached `fs.read` enters the coordinator
- **THEN** the coordinator MUST schedule a preflight worker job
- **AND** the preflight job MUST perform path expansion, strict canonical `realpath`, filesystem policy check, `stat`, signature computation, and preview classification
- **AND** the preflight job MUST NOT read inline file content or create `downloadId`

#### Scenario: snapshot job reads one canonical freshness
- **WHEN** preflight succeeds for a canonical path and freshness signature
- **THEN** the coordinator MUST key snapshot work by canonical path, freshness signature, and current resource generation
- **AND** it MUST schedule at most one active snapshot worker job for that key
- **AND** the snapshot job MUST perform content read, binary detection, text/base64 preparation, or video stream metadata as needed

#### Scenario: raw aliases attach to one canonical snapshot
- **WHEN** multiple raw paths canonicalize to the same file with the same freshness signature and resource generation
- **THEN** the coordinator MUST attach those external requestIds to one snapshot job
- **AND** each final response MUST preserve that request's own raw `path`
- **AND** every final response MUST use the same canonical `resolvedPath`

### Requirement: Worker-backed fs.read SHALL preserve filesystem policy and classification
Worker-backed reads SHALL preserve the current daemon filesystem policy: broad user-readable filesystem access with a sensitive home-directory deny-list after canonical `realpath`. This change SHALL NOT introduce a new allow-root model.

#### Scenario: denied sensitive path is rejected
- **WHEN** a requested path canonicalizes under a denied sensitive directory
- **THEN** the daemon MUST return `fs.read_response` with `status: "error"` and the shared `forbidden_path` error code
- **AND** the daemon MUST NOT return file content
- **AND** the daemon MUST NOT create a `downloadId`

#### Scenario: symlink into denied path is rejected
- **WHEN** a requested path is a symlink or indirect path that canonicalizes under a denied sensitive directory
- **THEN** the daemon MUST reject it according to the same `forbidden_path` policy
- **AND** it MUST NOT create a `downloadId`

#### Scenario: Windows sensitive directory comparison is case-insensitive
- **WHEN** the policy helper evaluates a Windows canonical path under `.SSH`, `.GnuPG`, or `.PKI` with any casing
- **THEN** it MUST treat that path as under the corresponding denied directory
- **AND** it MUST reject the path

#### Scenario: macOS sensitive directory comparison defaults to case-insensitive
- **WHEN** the policy helper evaluates a macOS canonical path under `.SSH`, `.GnuPG`, or `.PKI` with any casing
- **THEN** it SHOULD treat that path as under the corresponding denied directory
- **AND** default tests MUST cover the case-insensitive deny behavior

#### Scenario: Linux sensitive directory comparison remains case-sensitive
- **WHEN** the policy helper evaluates a Linux path under `.SSH`
- **AND** that path is distinct from `.ssh` on a case-sensitive filesystem
- **THEN** the helper MUST preserve current behavior and not reject solely because of the uppercase spelling

#### Scenario: home directory is read per invocation
- **WHEN** the home directory source changes between two policy helper calls in tests
- **THEN** the second call MUST observe the new home directory
- **AND** the helper MUST NOT cache `homedir()` or `process.env.HOME` at module load

### Requirement: Canonical path helper SHALL expose strict and lenient modes
The extracted canonical helper SHALL expose strict and lenient modes so `fs.read` remains fail-closed while `fs.ls includeMetadata` can preserve existing best-effort behavior where appropriate.

#### Scenario: strict mode rejects realpath failure
- **WHEN** worker-backed `fs.read` calls strict canonical helper
- **AND** `fs.realpath` rejects
- **THEN** the helper MUST return no canonical path
- **AND** the daemon MUST emit a sanitized terminal error
- **AND** the daemon MUST NOT create a `downloadId`

#### Scenario: strict mode never uses fallback paths
- **WHEN** strict mode succeeds
- **THEN** it MUST return a canonical real path with `usedFallback: false`
- **AND** strict mode MUST NOT use platform-specific resolved-path fallback

#### Scenario: lenient mode may preserve Windows fs.ls best effort
- **WHEN** `fs.ls includeMetadata` calls lenient mode on a Windows reparse path
- **AND** `fs.realpath` rejects with an expected reparse-point failure
- **THEN** the helper MAY return a resolved path with `usedFallback: true`
- **AND** that fallback path MUST NOT be accepted for download-handle creation

#### Scenario: ordinary fs.ls remains strict
- **WHEN** `fs.ls` runs without `includeMetadata`
- **THEN** it MUST use strict canonical resolution
- **AND** it MUST NOT use Windows lenient fallback to list a non-canonical path

#### Scenario: generic Windows errors do not trigger lenient fallback
- **WHEN** lenient mode receives a Windows realpath error with generic `EPERM` or `UNKNOWN`
- **AND** the error does not identify a reparse, junction, symlink, or symlink-loop condition
- **THEN** the helper MUST fail closed

### Requirement: fs.read errors SHALL be stable, shared, and sanitized
Every frontend-visible `fs.read_response.error` SHALL use a stable code from a shared module. Daemon, web, and server production code SHALL NOT duplicate cross-boundary fs-read error string literals outside that shared module.

#### Scenario: existing wire errors are preserved
- **WHEN** shared fs-read error constants are introduced
- **THEN** public wire values for existing errors MUST remain `binary_file`, `forbidden_path`, and `file_too_large`
- **AND** implementation-specific constant names MUST NOT change those wire values

#### Scenario: raw filesystem error is sanitized
- **WHEN** `realpath`, `stat`, `readFile`, worker startup, or worker execution fails with an internal error containing an absolute path, errno, or stack trace
- **THEN** the daemon MUST log the detailed internal error locally
- **AND** the `fs.read_response.error` field sent to the browser MUST be a shared stable code
- **AND** the response MUST NOT include raw `Error.message`, stack trace, errno text, or absolute host paths in any frontend-visible field

#### Scenario: worker operational errors use stable codes
- **WHEN** the coordinator rejects a request because the queue or fan-out cap is full
- **THEN** it MUST return `preview_worker_queue_full`
- **WHEN** the worker request times out
- **THEN** it MUST return `preview_worker_timeout`
- **WHEN** the worker cannot start and startup fallback is disabled
- **THEN** it MUST return `preview_worker_unavailable`
- **WHEN** the worker crashes while requests are pending
- **THEN** affected requests MUST receive `preview_worker_crashed`

### Requirement: Main daemon SHALL own download-handle registration and revalidation
The worker SHALL never create or return a `downloadId`. The main daemon SHALL create download handles only from validated canonical paths.

#### Scenario: worker success is revalidated before handle creation
- **WHEN** the worker returns a successful snapshot for a canonical path
- **THEN** the main daemon MUST revalidate that path or accept an equivalent `ValidatedRealPath`
- **AND** it MUST refuse handle creation if the path fails policy validation

#### Scenario: direct handle creation cannot bypass policy
- **WHEN** daemon code attempts to create a local file handle for a denied sensitive path
- **THEN** handle creation MUST fail
- **AND** it MUST NOT register an attachment handle

#### Scenario: tolerant fs.ls metadata caller preserves allowed handles
- **WHEN** `fs.ls` runs with `includeMetadata: true` for a directory containing an allowed normal file
- **THEN** handle hardening MUST NOT prevent that allowed file from receiving a metadata `downloadId`

#### Scenario: denied or fallback metadata entry does not register handle
- **WHEN** `fs.ls includeMetadata` encounters a denied path or a lenient fallback path
- **THEN** the entry MAY remain visible in the listing
- **AND** the entry MUST omit `downloadId`
- **AND** the listing MUST NOT expose raw deny-list details or raw filesystem errors

#### Scenario: download handle remains a short-lived path handle
- **WHEN** a response includes `downloadId`
- **THEN** that handle MUST use existing short-lived file-transfer TTL and cleanup behavior
- **AND** the system MUST NOT claim the handle represents an immutable content snapshot

#### Scenario: local download errors are sanitized
- **WHEN** a download of any `source: "local"` handle fails with an internal filesystem error
- **THEN** the frontend-visible file-transfer error MUST be sanitized to a stable message or code
- **AND** it MUST NOT include raw host paths, stack traces, errno text, or raw `Error.message`

### Requirement: Preview-read coordinator SHALL use bounded static worker-pool execution
The coordinator SHALL enforce a bounded static worker pool, one active job per worker, bounded queueing, bounded fan-out, deadline-based terminal responses, worker identity validation, and stale completion suppression.

Default v1 bounds SHALL be:

- `workersTarget`: two worker instances
- accepted worker range: one to four worker instances
- hard maximum: four worker instances
- active jobs: one active preflight or snapshot job per worker
- queued worker jobs: at most thirty-two
- attached external requestIds per snapshot job: at most thirty-two
- daemon deadline: eighteen seconds from coordinator admission

#### Scenario: pool starts static target count
- **WHEN** the coordinator starts under default configuration
- **THEN** it MUST lazily start exactly two worker instances
- **AND** it MUST NOT create four worker instances unless configuration explicitly sets `workersTarget` to four

#### Scenario: worker count is clamped
- **WHEN** configuration requests fewer than one worker
- **THEN** the coordinator MUST clamp to one worker and emit a diagnostic
- **WHEN** configuration requests more than four workers
- **THEN** the coordinator MUST clamp to four workers and emit a diagnostic

#### Scenario: v1 dispatches concurrent jobs through bounded pool
- **WHEN** multiple valid uncached `fs.read` worker jobs are ready
- **THEN** the coordinator MUST dispatch jobs concurrently up to `workersTarget`
- **AND** it MUST NOT run more than one active read job on the same worker
- **AND** additional jobs MUST wait in the bounded queue or fail with a terminal error

#### Scenario: deterministic projected wait fail-fast
- **WHEN** a new valid `fs.read` enters the coordinator
- **AND** `((queueDepth + 1) * tEstimateMs) / workersTarget + tEstimateMs > deadlineMs - safetyMarginMs`
- **THEN** the coordinator MUST send exactly one terminal `fs.read_response` for that requestId
- **AND** the response MUST use `preview_worker_queue_full`
- **AND** the request MUST NOT be enqueued

#### Scenario: admission constants are test-overridable
- **WHEN** coordinator is constructed in tests
- **THEN** worker count, queue cap, attached cap, deadline, safety margin, fake clock, and `tEstimateMs` MUST be overridable
- **AND** tests MUST be able to deterministically trigger both admission and rejection

#### Scenario: queue full returns terminal error
- **WHEN** the preview worker queue is full and another distinct-freshness job arrives
- **THEN** the daemon MUST send exactly one terminal `fs.read_response`
- **AND** the response MUST use `preview_worker_queue_full`

#### Scenario: attached request cap returns terminal error
- **WHEN** a snapshot job already has the maximum allowed attached external requestIds
- **AND** another identical-freshness request tries to attach
- **THEN** the daemon MUST send exactly one terminal `fs.read_response`
- **AND** the response MUST use `preview_worker_queue_full`

#### Scenario: timeout returns before bridge pending expiry
- **WHEN** a worker-backed `fs.read` exceeds the daemon deadline, including queue wait and active execution
- **THEN** the daemon MUST send exactly one terminal `fs.read_response`
- **AND** the response MUST use `preview_worker_timeout`
- **AND** the configured daemon timeout MUST leave transfer margin before the server bridge pending expiry

#### Scenario: worker active watchdog uses remaining admission budget
- **WHEN** a preflight or snapshot job waits in the worker queue before entering a worker
- **THEN** the active job watchdog MUST use the remaining admission deadline budget rather than a fresh full active timeout
- **AND** an expired job MUST NOT be posted to a worker
- **AND** the admission deadline metadata MUST NOT be included in the worker IPC payload

#### Scenario: unrelated command dispatch remains responsive
- **WHEN** all configured fake workers are blocked
- **THEN** at least one non-`fs.read` daemon command path MUST complete without waiting for the preview read to finish
- **AND** the design MUST NOT claim filesystem throughput isolation from libuv worker-pool contention
- **AND** dist or real-daemon coverage MUST prove a non-preview command remains visible while real preview workers are delayed

### Requirement: Worker startup and runtime failures SHALL have deterministic terminal behavior
The coordinator SHALL distinguish startup fallback from runtime worker failures.

#### Scenario: production startup fallback is disabled
- **WHEN** the worker pool cannot start
- **THEN** the daemon MUST send exactly one terminal `fs.read_response`
- **AND** the response MUST use `preview_worker_unavailable`
- **AND** it MUST NOT direct-read for that request

#### Scenario: all workers unavailable during restart backoff fails fast
- **WHEN** every configured preview worker slot is dead or restarting and no worker can execute the request immediately
- **AND** startup/runtime direct-read fallback is disabled
- **THEN** the daemon MUST send exactly one terminal `fs.read_response`
- **AND** the response MUST use `preview_worker_unavailable`
- **AND** it MUST NOT wait for the server bridge pending timeout

#### Scenario: queued jobs drain when live worker capacity disappears
- **WHEN** jobs are queued behind active worker jobs
- **AND** all active workers time out or crash
- **AND** replacement workers cannot start
- **THEN** queued jobs MUST be rejected with `preview_worker_unavailable`
- **AND** they MUST NOT remain pending until daemon shutdown or bridge timeout

#### Scenario: bare NODE_ENV test does not enable direct worker path
- **WHEN** the daemon runs with `NODE_ENV=test`
- **AND** Vitest-specific environment signals are absent
- **THEN** the default coordinator MUST use the real worker pool path
- **AND** it MUST NOT enable the in-process direct worker test shim

#### Scenario: active worker job watchdog releases the slot
- **WHEN** an active preview worker job exceeds the daemon preview deadline
- **THEN** the daemon MUST send or preserve exactly one terminal timeout response for affected requestIds
- **AND** the active worker slot MUST be terminated or otherwise made unavailable for stale completion
- **AND** a replacement worker MAY be started with bounded restart/backoff for future requests

#### Scenario: runtime failure does not direct-read fallback
- **WHEN** a request fails because of worker timeout, crash, restart, stale read, or late completion
- **THEN** the daemon MUST NOT synchronously fallback to direct read for that request
- **AND** urgent daemon command handling MUST remain independent of the failed preview read

#### Scenario: worker crash completes pending requests
- **WHEN** a preview worker exits or throws while jobs are pending
- **THEN** the daemon MUST send exactly one terminal `fs.read_response` to every affected external requestId
- **AND** each response MUST use `preview_worker_crashed`
- **AND** the daemon MUST restart the worker with bounded backoff for future requests

#### Scenario: graceful shutdown drains pending requests
- **WHEN** the daemon begins graceful shutdown while preview-read requests are active or queued
- **THEN** the coordinator MUST attempt to send `preview_worker_unavailable` terminal responses within a bounded shutdown budget
- **AND** it MUST NOT wait for slow preview reads to finish normally

### Requirement: Coordinator SHALL suppress stale and ghost completions
The coordinator SHALL ensure stale worker completions cannot create duplicate responses, update active cache incorrectly, or route to a newer request.

#### Scenario: each routable request receives at most one terminal response
- **WHEN** a routable external requestId enters the coordinator
- **THEN** the coordinator MUST schedule a deadline-bounded terminal response
- **AND** it MUST NOT send more than one terminal `fs.read_response` for that requestId

#### Scenario: late completion after timeout is ignored
- **WHEN** a worker completes a job after the coordinator has timed out attached requests
- **THEN** the daemon MUST NOT send a second response to timed-out requestIds
- **AND** it MUST NOT write the late result into active cache

#### Scenario: terminal preview records are not retained indefinitely
- **WHEN** a preview request reaches success, error, timeout, shutdown, or cancellation terminal state
- **THEN** fan-out and external request records for that requestId MUST be removed from the active coordinator maps
- **AND** late worker completions for that requestId MUST be ignored without re-creating terminal state

#### Scenario: worker identity prevents restart misrouting
- **WHEN** a worker restart occurs while a request is pending
- **THEN** any completion whose `workerSlotId` or `workerGeneration` does not match the active pending job MUST be ignored
- **AND** it MUST NOT be routed to a newer request with the same `workerRequestId`

#### Scenario: daemon restart does not emit ghost responses
- **WHEN** the daemon restarts after losing pending `fs.read` state
- **THEN** it MUST NOT emit late `fs.read_response` messages for stale pre-restart requestIds

### Requirement: Worker packaging SHALL work in dev and dist
The preview worker SHALL use a plain `.mjs` bootstrap entry that works under both dev/tsx and compiled `dist/` execution.

#### Scenario: postbuild output contains worker bootstrap
- **WHEN** `npm run build` completes
- **THEN** `dist/src/daemon/file-preview-read-worker-bootstrap.mjs` MUST exist
- **AND** the compiled worker implementation MUST exist in the expected `dist/src/daemon/` location

#### Scenario: dist worker-pool smoke succeeds
- **WHEN** the dist worker-pool smoke test runs
- **THEN** it MUST start the default worker count
- **AND** it MUST dispatch at least two representative concurrent worker jobs
- **AND** the smoke test MUST run in CI after build rather than being silently skipped
- **AND** a required smoke mode MUST fail if dist artifacts are missing instead of skipping the suite

### Requirement: Worker lifecycle SHALL be observable and bounded
The coordinator SHALL expose sufficient diagnostics for worker lifecycle and memory-risk investigation. Job-count recycle is recommended but not required as a v1 blocker.

#### Scenario: worker lifecycle is logged without raw paths
- **WHEN** a worker starts, crashes, restarts, times out a job, is recycled, or terminates during shutdown
- **THEN** the coordinator MUST emit a structured log or metric with stable event labels
- **AND** that diagnostic MUST NOT include raw paths, errno text, or stack traces from preview jobs

#### Scenario: optional job-count recycle does not disrupt other workers
- **WHEN** job-count recycle is implemented and a worker completes its configured recycle-count job
- **THEN** the coordinator SHOULD terminate that worker after the response is sent
- **AND** it SHOULD spawn a replacement before the next dispatch to that slot
- **AND** in-flight jobs on other workers MUST complete normally

### Requirement: Pod-sticky compatibility SHALL be preserved
This change SHALL NOT introduce any daemon-dependent endpoint that bypasses server-id routed pod-sticky paths.

#### Scenario: no new endpoint is required
- **WHEN** the preview-read worker is implemented
- **THEN** browser requests and daemon responses MUST continue to use the existing server-id routed WebSocket bridge
- **AND** the system MUST NOT add a worker health, queue, or preview read endpoint in v1

#### Scenario: existing download paths remain server-id routed
- **WHEN** a browser downloads via a `downloadId` produced by worker-backed `fs.read`
- **THEN** it MUST use the existing server-id routed download path
- **AND** the worker MUST NOT create cross-pod or server-side shared state

### Requirement: fs.write errors SHALL use sanitized generic error codes
The daemon SHALL NOT include raw `Error.message`, stack traces, errno text, or absolute host paths in `fs.write_response.error`. `fs.write` SHALL use generic shared filesystem codes for `forbidden_path`, `file_too_large`, `invalid_request`, and unexpected `internal_error`, plus existing write-specific codes such as `file_exists` and `parent_not_found`.

#### Scenario: unexpected fs.write error is sanitized
- **WHEN** `fs.write` fails with an unhandled internal filesystem error
- **THEN** the daemon MUST send `fs.write_response` with `status: "error"`
- **AND** `error` MUST be `internal_error`
- **AND** the response MUST NOT include raw host paths, errno text, stack traces, or raw `Error.message`

#### Scenario: new fs.write target symlink is rejected
- **WHEN** `fs.write` initially observes that the target does not exist
- **AND** the target appears as a symlink before creation
- **THEN** the daemon MUST fail closed without writing through that symlink
- **AND** the frontend-visible response MUST remain sanitized
