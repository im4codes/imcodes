## ADDED Requirements

### Requirement: Main daemon SHALL own worker-backed fs.read freshness state
The daemon SHALL preserve freshness-safe `fs.read` cache and inflight reuse semantics when preview execution moves behind workers. The main daemon coordinator SHALL own cache, inflight state, resource generations, external request records, fan-out, per-request deadlines, and invalidation state. Workers SHALL be stateless per job and SHALL NOT own durable fs-read cache or generations.

#### Scenario: worker module does not hold cache maps
- **WHEN** the worker implementation is inspected
- **THEN** it MUST NOT import, mutate, or persist `fsReadCache`, `fsReadInflight`, or `fsReadGenerations`
- **AND** cache writes MUST occur only in the main coordinator after freshness validation

#### Scenario: successful write invalidates worker-backed read state
- **WHEN** a successful `fs.write` or other daemon mutation invalidates a file path
- **THEN** the main coordinator MUST bump the affected resource generation
- **AND** it MUST invalidate any worker-backed cached `fs.read` snapshot for that path
- **AND** it MUST detach, mark stale, or prevent cache writeback for older inflight worker read work for that path

#### Scenario: late completion after invalidation is not cached
- **WHEN** older worker-backed `fs.read` work completes after the relevant file generation has changed
- **THEN** the main coordinator MUST NOT write that stale result into active `fs.read` cache
- **AND** future `fs.read` requests for the file MUST observe the newer freshness state

#### Scenario: late completion is not cached when no eligible request remains
- **WHEN** a worker snapshot completes after all attached requestIds have reached terminal state or exceeded their per-request deadlines
- **THEN** the main coordinator MUST NOT write the result into active `fs.read` cache
- **AND** future `fs.read` requests for the file MUST perform fresh worker-backed work or use only a previously valid cache entry

### Requirement: Two-phase worker keying SHALL preserve canonical freshness reuse
The coordinator SHALL use worker preflight results to key snapshot work by canonical path, freshness signature, and resource generation.

#### Scenario: identical canonical freshness reuses one snapshot job
- **WHEN** two `fs.read` requests target the same canonical file and the file's current freshness state has not changed
- **THEN** the main coordinator MUST attach both external requestIds to one current snapshot worker job
- **AND** both requesters MUST receive compatible `fs.read_response` results with their own external `requestId`

#### Scenario: raw aliases attach after preflight
- **WHEN** two different raw paths canonicalize to the same real path and freshness signature
- **THEN** the coordinator MUST attach them to the same canonical snapshot job
- **AND** the worker MUST NOT run duplicate snapshot content reads for those aliases

#### Scenario: changed freshness starts a new snapshot job
- **WHEN** a later `fs.read` request targets the same canonical file after its freshness state has changed
- **THEN** the main coordinator MUST NOT attach that request to an older worker-backed inflight snapshot
- **AND** it MUST start fresh worker-backed snapshot work for the newer freshness state

#### Scenario: preflight failure does not poison canonical cache
- **WHEN** a preflight job fails because of policy, invalid path, or sanitized filesystem error
- **THEN** the coordinator MUST send terminal errors only to the attached external requestIds
- **AND** it MUST NOT write any snapshot cache entry for that raw path or unresolved canonical path

### Requirement: Per-request metadata SHALL be preserved under fan-out
The coordinator SHALL keep external request metadata separate from canonical worker job metadata.

#### Scenario: attached request stores original raw path
- **WHEN** an external request attaches to preflight or snapshot work
- **THEN** the coordinator MUST store that request's external `requestId`, original raw `path`, admission time, deadline, and terminal state

#### Scenario: fan-out response keeps each raw path
- **WHEN** one canonical snapshot fans out to multiple external requestIds from different raw paths
- **THEN** each `fs.read_response.path` MUST equal that requester's original raw path
- **AND** each `fs.read_response.resolvedPath` MUST equal the canonical worker path

#### Scenario: timed-out request is skipped without affecting active siblings
- **WHEN** one attached requestId times out before a shared snapshot is ready
- **THEN** that requestId MUST receive or already have received its terminal timeout response
- **AND** other attached requestIds whose deadlines have not expired MUST remain eligible for the shared snapshot

### Requirement: Worker-backed reads SHALL verify start and end freshness
Worker-backed reads SHALL protect against files changing while a worker reads them. Snapshot results SHALL include both the freshness signature observed before reading and the freshness signature observed after reading.

#### Scenario: unchanged start and end signatures can be cached
- **WHEN** a worker snapshot result has matching `startSignature` and `endSignature`
- **AND** the main coordinator generation still matches the generation associated with the snapshot job
- **THEN** the main coordinator MUST treat the result as eligible for active `fs.read` cache storage

#### Scenario: changed signature returns stale_read instead of mixed success
- **WHEN** a worker snapshot result has different `startSignature` and `endSignature`
- **THEN** the main coordinator MUST NOT store the result in active `fs.read` cache
- **AND** it MUST NOT return a successful response that combines content from one file state with `mtime` from another file state
- **AND** v1 MUST return a terminal `fs.read_response` with the shared `stale_read` error code

#### Scenario: fan-out accepted before invalidation is deterministic
- **WHEN** the coordinator accepts a worker snapshot for fan-out to currently active requestIds
- **AND** a later invalidation occurs while those responses are being serialized
- **THEN** already accepted active requestIds MUST receive the same accepted snapshot unless their own deadline has already expired
- **AND** invalidation MUST affect future requests and cache writeback decisions

### Requirement: Worker-backed fan-out SHALL be memory bounded
The main coordinator SHALL avoid duplicating large preview payloads while reusing inflight worker work. Bounded queue length alone SHALL NOT be the only memory-control mechanism.

#### Scenario: queue stores metadata only
- **WHEN** a worker job is queued or waiting
- **THEN** the coordinator queue MUST store request and job metadata only
- **AND** it MUST NOT store preview content or base64 payloads in queued entries

#### Scenario: fan-out shares one snapshot object before serialization
- **WHEN** multiple external requestIds are attached to the same snapshot job
- **THEN** the coordinator MUST retain one accepted worker snapshot object for fan-out before WebSocket serialization
- **AND** it MUST NOT create one retained base64 payload copy per attached requester

#### Scenario: attached requestIds are bounded
- **WHEN** identical-freshness requests continue to arrive for an already inflight snapshot job
- **THEN** the coordinator MUST enforce a configured per-job attached requestId cap or global pending external request cap
- **AND** requests exceeding that cap MUST receive exactly one terminal error without attaching to the job

#### Scenario: per-request deadlines are independent under fan-out
- **WHEN** several external requestIds are attached to one snapshot job
- **THEN** each external requestId MUST keep its own admission-time deadline
- **AND** a requestId that times out MUST NOT receive a later success response from that job
- **AND** other still-active attached requestIds MUST remain eligible for the worker result if their deadlines have not expired

#### Scenario: fan-out timers are independent of send order
- **WHEN** fan-out sends are serialized to bound memory
- **THEN** each external requestId's deadline timer MUST still fire independently
- **AND** the coordinator MUST NOT wait for the serialized send queue to reach a request before timing it out

#### Scenario: fan-out sends avoid peak memory multiplication
- **WHEN** one worker snapshot fans out to multiple attached requestIds
- **THEN** the coordinator MUST avoid retaining one serialized response copy per requester
- **AND** implementation MUST serialize fan-out responses sequentially or prove equivalent peak-memory bounds

#### Scenario: video avoids base64 payloads
- **WHEN** a worker-backed read classifies a supported video file
- **THEN** the result MUST remain stream-mode metadata
- **AND** it MUST NOT create a base64 payload for the video content

### Requirement: Worker-backed cache behavior SHALL remain observable and testable
The worker-backed cache and fan-out behavior SHALL be testable with fake workers, fake clocks, deterministic freshness signatures, and deterministic admission inputs.

#### Scenario: fake workers can saturate the pool
- **WHEN** tests use fake workers that block every active read slot in the configured pool
- **THEN** coordinator tests MUST prove additional different-freshness jobs queue, identical-freshness jobs attach, and non-`fs.read` daemon dispatch remains responsive

#### Scenario: queue and deadline constants are validated together
- **WHEN** coordinator tests configure worker duration, queue size, and daemon deadline
- **THEN** tests MUST prove requests either complete or receive terminal errors before the bridge pending timeout budget is exceeded
- **AND** no request MUST remain pending only because it was queued behind active work

#### Scenario: admission formula is deterministic
- **WHEN** tests inject `workersTarget`, `queueDepth`, `tEstimateMs`, `deadlineMs`, and `safetyMarginMs`
- **THEN** the admission decision MUST match the documented formula exactly
- **AND** boundary tests MUST cover both admit and `preview_worker_queue_full` outcomes
