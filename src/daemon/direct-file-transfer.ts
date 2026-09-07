/**
 * Main-thread proxy for the direct file transfer data plane.
 *
 * The transfer state machine itself lives in `direct-file-transfer-worker.ts`
 * and runs in an OS child process: RTC/ICE/DataChannel callbacks, no-progress and
 * lease timers, sha256 hashing and every file read/write execute there. A
 * blocked daemon event loop therefore cannot starve them, which is the failure
 * this split exists to remove — transfers previously died because the loop was
 * busy, not because the peer connection was broken.
 *
 * This file owns only what must stay on the main thread: the WebSocket senders,
 * child lifecycle, and a bounded capability projection. File bytes never cross
 * the boundary; only control envelopes do.
 */
import logger from '../util/logger.js';
import {
  DIRECT_CONNECTIVITY_RUNTIME_STATE,
  DIRECT_FILE_TRANSFER_ERROR,
  DIRECT_FILE_TRANSFER_ERROR_SCOPE,
  DIRECT_FILE_TRANSFER_HOST_METHOD,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
  DIRECT_FILE_TRANSFER_WORKER_KIND,
  DIRECT_FILE_TRANSFER_WORKER_MSG,
  DIRECT_FILE_TRANSFER_WORKER_PROTOCOL_VERSION,
  isCurrentDirectFileTransferWorkerGeneration,
  validateDirectFileTransferDaemonCommand,
  validateDirectFileTransferDaemonMessage,
  validateDirectFileTransferWorkerEnvelope,
  type DirectConnectivityRuntimeStatus,
  type DirectFileTransferDaemonCommand,
} from '../../shared/direct-file-transfer.js';
import {
  spawnDirectFileTransferChild,
  type DirectFileTransferIsolate,
  type DirectFileTransferIsolateOptions,
} from './direct-file-transfer-ipc.js';
import type { FileTransferSender } from './file-transfer-handler.js';
import {
  lookupAttachmentByClientUploadId,
  releaseClientUploadClaim,
  resolveDirectFileDownloadSource,
  tryClaimClientUpload,
} from './file-transfer-handler.js';

export { toNodeDataChannelIceServers } from './direct-file-transfer-worker.js';

export const DIRECT_FILE_TRANSFER_RESTART_BASE_MS = 100;
export const DIRECT_FILE_TRANSFER_RESTART_MAX_MS = 10_000;
export const DIRECT_FILE_TRANSFER_STABLE_WINDOW_MS = 60_000;
export const DIRECT_FILE_TRANSFER_READY_TIMEOUT_MS = 15_000;
export const SHUTDOWN_ACK_TIMEOUT_MS = 5_000;

interface WorkerHandle {
  worker: DirectFileTransferIsolate;
  generation: number;
  ready: Promise<boolean>;
  state: 'pending' | 'ready' | 'failed';
  settleReady: (ready: boolean) => void;
  retirement: Promise<number> | null;
}

let handle: WorkerHandle | null = null;
let generationCounter = 0;
let restarts = 0;
let shuttingDown = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let stableTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Availability is projected, not queried.
 *
 * `server-link` asks for this synchronously while building a capability
 * payload, and the answer lives in another process. Caching the child's last
 * declaration keeps that call synchronous without blocking the loop on IPC —
 * which would reintroduce exactly the stall being removed.
 */
let availableProjection = false;
let runtimeStatusProjection: DirectConnectivityRuntimeStatus = {
  state: DIRECT_CONNECTIVITY_RUNTIME_STATE.RUNTIME_UNAVAILABLE,
};

const sendersById = new Map<string, FileTransferSender>();
const idsBySender = new WeakMap<FileTransferSender, string>();
let senderSeq = 0;
const MAX_PROXY_SENDERS = DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_CAPACITY * 2;

/** Stable opaque id per transport, so the worker can address it without holding it. */
function senderIdFor(sender: FileTransferSender): string {
  const existing = idsBySender.get(sender);
  if (existing) {
    sendersById.set(existing, sender);
    return existing;
  }
  senderSeq += 1;
  const id = `dft-sender-${senderSeq}`;
  idsBySender.set(sender, id);
  sendersById.set(id, sender);
  while (sendersById.size > MAX_PROXY_SENDERS) {
    const oldest = sendersById.keys().next().value as string | undefined;
    if (!oldest) break;
    sendersById.delete(oldest);
  }
  return id;
}

// Keep the relative path in a variable. Vite rewrites a literal
// `new URL('./asset', import.meta.url)` to its browser dev-server URL even when
// this daemon module is imported by Node integration tests; Worker rejects
// that http: URL. The runtime expression remains a file: URL in Node while
// production builds still copy the bootstrap beside this module.
const DIRECT_FILE_TRANSFER_WORKER_BOOTSTRAP = './direct-file-transfer-worker-bootstrap.mjs';

function workerModuleUrl(): URL {
  return new URL(DIRECT_FILE_TRANSFER_WORKER_BOOTSTRAP, import.meta.url);
}

type DirectFileTransferWorkerFactory = (
  url: URL,
  options: DirectFileTransferIsolateOptions,
) => DirectFileTransferIsolate;

const spawnRealWorker: DirectFileTransferWorkerFactory = spawnDirectFileTransferChild;
let workerFactory: DirectFileTransferWorkerFactory = spawnRealWorker;
type FinalizeDirectUploadedFile = typeof import('./file-transfer-handler.js').finalizeDirectUploadedFile;

/**
 * Keep the newly added finalization authority out of this module's eager import
 * surface. A large set of command-handler tests intentionally replaces
 * file-transfer-handler with a narrow mock that predates direct P2P uploads;
 * eagerly reading the new named export makes Vitest abort those suites during
 * module evaluation even though they never execute a direct upload. Production
 * still resolves the exact authority module at the first real finalization.
 */
const finalizeDirectUploadedFileOnDemand: FinalizeDirectUploadedFile = async (params) => {
  const handler = await import('./file-transfer-handler.js');
  return await handler.finalizeDirectUploadedFile(params);
};

let finalizeUploadedFileOnHost: FinalizeDirectUploadedFile = finalizeDirectUploadedFileOnDemand;

/**
 * Test seam for the worker factory.
 *
 * Crash retry/backoff and stale-generation behaviour must be provable
 * deterministically. Racing a real thread to die on cue would make those tests
 * timing-dependent, so tests substitute a controllable double here. Production
 * always uses the real spawn.
 */
export function __setDirectFileTransferWorkerFactoryForTests(
  factory: DirectFileTransferWorkerFactory | null,
): void {
  workerFactory = factory ?? spawnRealWorker;
}

export function __setDirectFileTransferFinalizeForTests(
  finalize: FinalizeDirectUploadedFile | null,
): void {
  finalizeUploadedFileOnHost = finalize ?? finalizeDirectUploadedFileOnDemand;
}

/** Reset all module state between tests so cases cannot leak into each other. */
export function __resetDirectFileTransferForTests(): void {
  if (restartTimer) clearTimeout(restartTimer);
  if (stableTimer) clearTimeout(stableTimer);
  restartTimer = null;
  stableTimer = null;
  void handle?.worker.terminate().catch(() => undefined);
  nativeAdmissionClosed = false;
  nativeQuiesceCompleted = false;
  inFlightNativeQuiesce = null;
  handle = null;
  generationCounter = 0;
  restarts = 0;
  shuttingDown = false;
  availableProjection = false;
  runtimeStatusProjection = { state: DIRECT_CONNECTIVITY_RUNTIME_STATE.RUNTIME_UNAVAILABLE };
  sendersById.clear();
  senderSeq = 0;
  controlEnvelopeObserver = null;
  pendingByKey.clear();
  claimTokensByHandle.clear();
  claimHandleSeq = 0;
  inFlightHostMutations.clear();
  finalizeUploadedFileOnHost = finalizeDirectUploadedFileOnDemand;
}

/**
 * Test observer for inbound control envelopes.
 *
 * The worker-stamped emission time is the only way to prove the worker kept
 * working while this thread was blocked; delivery time cannot show it, because
 * delivery necessarily happens after the loop frees. Production ignores this.
 */
let controlEnvelopeObserver: ((emittedAt: number) => void) | null = null;

export function __observeDirectFileTransferControlForTests(
  observer: ((emittedAt: number) => void) | null,
): void {
  controlEnvelopeObserver = observer;
}

/** Current worker generation, or 0 when no worker is running. */
export function __directFileTransferWorkerGenerationForTests(): number {
  return handle?.generation ?? 0;
}

export function __directFileTransferChildPidForTests(): number | undefined {
  return handle?.worker.pid;
}

function postToWorker(active: WorkerHandle, envelope: Record<string, unknown>): void {
  active.worker.postMessage({
    v: DIRECT_FILE_TRANSFER_WORKER_PROTOCOL_VERSION,
    generation: active.generation,
    ...envelope,
  });
}

interface PendingDispatch {
  senderId: string;
  failure: Record<string, unknown>;
}

const pendingByKey = new Map<string, PendingDispatch>();

function pendingKey(senderId: string, requestId: string): string {
  return `${senderId}\u0000${requestId}`;
}

function rememberPending(senderId: string, command: DirectFileTransferDaemonCommand): boolean {
  // ICE is an event, not a request: the child intentionally emits no matching
  // acknowledgement. Retaining it would fill the bounded proxy ledger during
  // a long negotiation and eventually reject real work even though nothing is
  // in flight. Every other command has a correlated response or terminal.
  if (command.type === DIRECT_FILE_TRANSFER_MSG.LEASE_ICE) return true;
  const requestId = (command as { requestId?: unknown }).requestId;
  if (typeof requestId === 'string') {
    const key = pendingKey(senderId, requestId);
    if (!pendingByKey.has(key)
      && pendingByKey.size >= DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_CAPACITY) return false;
    pendingByKey.set(key, { senderId, failure: runtimeRecoveringMessage(command) });
  }
  return true;
}

function settlePending(senderId: string, message: Record<string, unknown>): void {
  if (typeof message.requestId === 'string') {
    pendingByKey.delete(pendingKey(senderId, message.requestId));
  }
}

function runtimeRecoveringMessage(command: DirectFileTransferDaemonCommand): Record<string, unknown> {
  const value = command as unknown as Record<string, unknown>;
  const operation = typeof value.attemptId === 'string'
    && typeof value.operationId === 'string'
    && typeof value.direction === 'string';
  if (operation) {
    return {
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.OPERATION,
      serverId: value.serverId,
      browserTabId: value.browserTabId,
      leaseId: value.leaseId,
      leaseGeneration: value.leaseGeneration,
      daemonGeneration: value.daemonGeneration,
      requestId: value.requestId,
      attemptId: value.attemptId,
      attempt: value.attempt,
      direction: value.direction,
      operationId: value.operationId,
      error: DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
      retryable: true,
      detail: 'direct_runtime_child_recovering',
    };
  }
  return {
    type: DIRECT_FILE_TRANSFER_MSG.ERROR,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.LEASE,
    requestId: value.requestId,
    error: DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
    retryable: true,
    detail: 'direct_runtime_child_recovering',
  };
}

function sendRuntimeRecovering(sender: FileTransferSender, command: DirectFileTransferDaemonCommand): void {
  const message = runtimeRecoveringMessage(command);
  sendFailClosedMessage(sender, message);
}

function sendFailClosedMessage(sender: FileTransferSender, message: Record<string, unknown>): void {
  if (!validateDirectFileTransferDaemonMessage(message).ok) return;
  try { sender.send(message); } catch { /* disconnected sender */ }
}

function failPendingForLostWorker(): void {
  for (const pending of pendingByKey.values()) {
    const sender = sendersById.get(pending.senderId);
    if (sender) sendFailClosedMessage(sender, pending.failure);
  }
  pendingByKey.clear();
}

/* --------------------------------------------------------------------------
 * Host authority dispatcher.
 *
 * The attachment registry and client-upload claims live here, on the one thread
 * that also runs the relay path, so direct and relay contend for the SAME
 * authority instead of two per-isolate copies. The worker calls in; nothing but
 * metadata crosses, and the claim symbol never leaves this thread.
 * ------------------------------------------------------------------------ */

/**
 * Claim symbols are not cloneable, so the worker holds an opaque handle.
 *
 * The claimed id is kept beside the token because releasing requires both, and
 * a worker that dies takes its handles with it: without the id here, a crashed
 * transfer's claim would stay held in the registry forever and the relay could
 * never take over that upload.
 */
const claimTokensByHandle = new Map<string, {
  clientUploadId: string;
  token: symbol;
  generation: number;
}>();
let claimHandleSeq = 0;

/**
 * Mutating host calls that have crossed the child boundary and started on the
 * daemon thread. A dead child cannot cancel such a continuation: finalization
 * may already have renamed a file and be committing attachment metadata. The
 * claim must therefore remain authoritative until that admitted mutation has
 * settled, even though its HOST_RESULT is no longer deliverable.
 */
const inFlightHostMutations = new Map<string, number>();

function hostMutationKey(generation: number, clientUploadId: string): string {
  return `${generation}\u0000${clientUploadId}`;
}

function finalizationClientUploadId(method: string, args: unknown[]): string | null {
  if (method !== DIRECT_FILE_TRANSFER_HOST_METHOD.FINALIZE_DIRECT_UPLOADED_FILE) return null;
  const value = args[0];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const clientUploadId = (value as { clientUploadId?: unknown }).clientUploadId;
  return typeof clientUploadId === 'string' && clientUploadId ? clientUploadId : null;
}

function beginHostMutation(generation: number, method: string, args: unknown[]): string | null {
  const clientUploadId = finalizationClientUploadId(method, args);
  if (!clientUploadId) return null;
  const key = hostMutationKey(generation, clientUploadId);
  inFlightHostMutations.set(key, (inFlightHostMutations.get(key) ?? 0) + 1);
  return clientUploadId;
}

function finishHostMutation(generation: number, clientUploadId: string | null): void {
  if (!clientUploadId) return;
  const key = hostMutationKey(generation, clientUploadId);
  const remaining = (inFlightHostMutations.get(key) ?? 1) - 1;
  if (remaining > 0) inFlightHostMutations.set(key, remaining);
  else inFlightHostMutations.delete(key);
  // If this generation died while the mutation was running, its claim was
  // deliberately retained. Release it now that no admitted mutation can still
  // publish under that authority.
  if (!handle || handle.generation !== generation) releaseClaimsForLostWorker(generation);
}

async function invokeHostMethod(generation: number, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case DIRECT_FILE_TRANSFER_HOST_METHOD.TRY_CLAIM_CLIENT_UPLOAD: {
      const clientUploadId = String(args[0] ?? '');
      const token = tryClaimClientUpload(clientUploadId);
      if (!token) return null;
      claimHandleSeq += 1;
      const handle = `dft-claim-${claimHandleSeq}`;
      claimTokensByHandle.set(handle, { clientUploadId, token, generation });
      return handle;
    }
    case DIRECT_FILE_TRANSFER_HOST_METHOD.RELEASE_CLIENT_UPLOAD_CLAIM: {
      const handle = String(args[1] ?? '');
      const claim = claimTokensByHandle.get(handle);
      // Unknown handle is a no-op rather than an error: release must stay
      // idempotent across a worker restart that lost its handles.
      if (!claim) return null;
      claimTokensByHandle.delete(handle);
      releaseClientUploadClaim(claim.clientUploadId, claim.token);
      return null;
    }
    case DIRECT_FILE_TRANSFER_HOST_METHOD.LOOKUP_ATTACHMENT_BY_CLIENT_UPLOAD_ID:
      return lookupAttachmentByClientUploadId(String(args[0] ?? '')) ?? null;
    case DIRECT_FILE_TRANSFER_HOST_METHOD.RESOLVE_DIRECT_FILE_DOWNLOAD_SOURCE:
      return await resolveDirectFileDownloadSource(String(args[0] ?? ''));
    case DIRECT_FILE_TRANSFER_HOST_METHOD.FINALIZE_DIRECT_UPLOADED_FILE:
      return await finalizeUploadedFileOnHost(
        args[0] as Parameters<FinalizeDirectUploadedFile>[0],
      );
    default:
      // Unreachable: the validator allowlists the method before we get here.
      throw new Error(`unsupported_host_method:${method}`);
  }
}

/**
 * Release every claim a dead worker generation still held.
 *
 * Forgetting the handles is not releasing the claims: the registry lives on
 * this thread and would keep every dead transfer's id locked, blocking both the
 * relay path and any retry for the lifetime of the daemon. Each one is handed
 * back explicitly.
 */
function releaseClaimsForLostWorker(generation?: number): void {
  for (const [handle, claim] of [...claimTokensByHandle]) {
    if (generation !== undefined && claim.generation !== generation) continue;
    if ((inFlightHostMutations.get(hostMutationKey(claim.generation, claim.clientUploadId)) ?? 0) > 0) {
      continue;
    }
    claimTokensByHandle.delete(handle);
    try {
      releaseClientUploadClaim(claim.clientUploadId, claim.token);
    } catch (error) {
      logger.warn(
        { err: error, event: 'direct_file_v2.claim_release_failed' },
        'Could not release a lost worker claim',
      );
    }
  }
}

function handleWorkerMessage(active: WorkerHandle, raw: unknown, markReady: () => void): void {
  const envelope = validateDirectFileTransferWorkerEnvelope(raw);
  if (!envelope) return;
  // An error/timeout can precede OS-process exit. The failed generation stays
  // registered only as a reap fence; it has no authority to drive transports
  // or start new host mutations while termination is pending.
  if (active.state === 'failed') return;
  // Fail closed on identity: a reply from a worker that has since crashed and
  // been replaced carries the previous generation. Applying it would let a dead
  // worker drive live transports, so it is dropped.
  if (!handle || active.generation !== handle.generation) return;
  if (!isCurrentDirectFileTransferWorkerGeneration(envelope, handle.generation)) return;

  if (envelope.type === DIRECT_FILE_TRANSFER_WORKER_MSG.CONTROL) {
    controlEnvelopeObserver?.(envelope.emittedAt);
    const sender = sendersById.get(envelope.senderId);
    if (!sender) return;
    // The transport is a shared, authenticated channel to the browser. A worker
    // may only put a message on it that the daemon protocol actually describes;
    // "it is a plain object" is not the same statement.
    if (!validateDirectFileTransferDaemonMessage(envelope.message).ok) {
      logger.warn(
        { event: 'direct_file_v2.control_rejected', messageType: (envelope.message as { type?: unknown }).type },
        'worker control message failed daemon protocol validation and was not forwarded',
      );
      return;
    }
    if (envelope.message.type === DIRECT_FILE_TRANSFER_MSG.ERROR
      || envelope.message.type === DIRECT_FILE_TRANSFER_MSG.TERMINAL
      || envelope.message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED
      || envelope.message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER
      || envelope.message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND
      || envelope.message.type === DIRECT_FILE_TRANSFER_MSG.STATUS) {
      settlePending(envelope.senderId, envelope.message);
    }
    try {
      sender.send(envelope.message);
    } catch (error) {
      logger.debug({ err: error, event: 'direct_file_v2.control_send_failed' }, 'control send failed');
    }
    return;
  }

  if (envelope.type === DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_CALL) {
    const mutationClientUploadId = beginHostMutation(active.generation, envelope.method, envelope.args);
    void invokeHostMethod(active.generation, envelope.method, envelope.args)
      .then((value) => {
        if (handle?.generation !== active.generation || active.state === 'failed') return;
        try {
          postToWorker(active, {
            type: DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_RESULT, callId: envelope.callId, ok: true, value,
          });
        } catch {
          failWorkerGeneration(active, 'ipc_send_failed', null, null, true);
        }
      })
      .catch((error: unknown) => {
        if (handle?.generation !== active.generation || active.state === 'failed') return;
        try {
          postToWorker(active, {
            type: DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_RESULT,
            callId: envelope.callId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          failWorkerGeneration(active, 'ipc_send_failed', null, null, true);
        }
      })
      .finally(() => finishHostMutation(active.generation, mutationClientUploadId));
    return;
  }

  if (envelope.type === DIRECT_FILE_TRANSFER_WORKER_MSG.READY) {
    // The worker publishes STATUS_REPLY immediately before READY, so the
    // projection is already current when the boot promise resolves.
    markReady();
    return;
  }

  if (envelope.type === DIRECT_FILE_TRANSFER_WORKER_MSG.STATUS_REPLY) {
    availableProjection = envelope.available;
    runtimeStatusProjection = envelope.available
      ? { state: DIRECT_CONNECTIVITY_RUNTIME_STATE.AVAILABLE }
      : { state: DIRECT_CONNECTIVITY_RUNTIME_STATE.RUNTIME_UNAVAILABLE };
  }
}

function armStableWorkerWindow(active: WorkerHandle): void {
  if (stableTimer) clearTimeout(stableTimer);
  stableTimer = setTimeout(() => {
    stableTimer = null;
    if (!handle || handle.generation !== active.generation) return;
    restarts = 0;
  }, DIRECT_FILE_TRANSFER_STABLE_WINDOW_MS);
  stableTimer.unref?.();
}

function finalizeWorkerGenerationFailure(
  active: WorkerHandle,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  if (!handle || handle.generation !== active.generation || active.state !== 'failed') return;
  handle = null;
  releaseClaimsForLostWorker(active.generation);
  scheduleWorkerRestart(code, signal, active.generation);
}

function failWorkerGeneration(
  active: WorkerHandle,
  reason: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  terminate: boolean,
): void {
  if (!handle || handle.generation !== active.generation) return;
  if (active.state !== 'failed') {
    active.state = 'failed';
    active.settleReady(false);
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = null;
    failPendingForLostWorker();
    availableProjection = true;
    runtimeStatusProjection = { state: DIRECT_CONNECTIVITY_RUNTIME_STATE.AVAILABLE };
    logger.warn(
      { event: 'direct_file_v2.child_generation_failed', generation: active.generation, reason },
      'transfer child generation failed',
    );
  }
  if (!terminate) {
    // An exit event is the authority that this OS generation can no longer
    // mutate files. Only now may its claims be released and a successor spawn.
    finalizeWorkerGenerationFailure(active, code, signal);
    return;
  }
  if (active.retirement) return;
  // IPC/error/READY-timeout paths observe a still-live process. Keep the
  // failed handle and its claims authoritative until terminate() has reaped
  // that exact child; otherwise old and replacement generations can overlap.
  active.retirement = active.worker.terminate();
  void active.retirement
    .then((exitCode) => finalizeWorkerGenerationFailure(active, exitCode, signal))
    .catch((error: unknown) => {
      logger.error(
        { err: error, event: 'direct_file_v2.child_reap_failed', generation: active.generation },
        'transfer child could not be reaped; refusing an overlapping replacement',
      );
    });
}

function scheduleWorkerRestart(code: number | null, signal: NodeJS.Signals | null, generation: number): void {
  if (shuttingDown || nativeAdmissionClosed || restartTimer) return;
  restarts = Math.min(Number.MAX_SAFE_INTEGER, restarts + 1);
  const delayMs = Math.min(
    DIRECT_FILE_TRANSFER_RESTART_MAX_MS,
    DIRECT_FILE_TRANSFER_RESTART_BASE_MS * (2 ** Math.min(7, restarts - 1)),
  );
  logger.warn(
    { event: 'direct_file_v2.child_crash', code, signal, generation, crashCount: restarts },
    'transfer child exited; daemon and sessions remain online',
  );
  logger.warn(
    { event: 'direct_file_v2.retry_scheduled', generation, crashCount: restarts, delayMs },
    'scheduling transfer child recovery',
  );
  logger.info(
    { event: 'direct_file_v2.recovering', generation, delayMs },
    'direct transfer child recovering; capability remains advertised',
  );
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (handle || shuttingDown || nativeAdmissionClosed) return;
    try {
      spawnWorker();
    } catch (error) {
      availableProjection = true;
      runtimeStatusProjection = { state: DIRECT_CONNECTIVITY_RUNTIME_STATE.AVAILABLE };
      logger.warn(
        { err: error, event: 'direct_file_v2.child_spawn_failed', generation },
        'transfer child spawn failed; recovery remains scheduled',
      );
      scheduleWorkerRestart(null, null, generation);
    }
  }, delayMs);
  restartTimer.unref?.();
}

function spawnWorker(): WorkerHandle {
  generationCounter += 1;
  const generation = generationCounter;
  const worker = workerFactory(workerModuleUrl(), {
    workerData: { kind: DIRECT_FILE_TRANSFER_WORKER_KIND, generation },
  });
  let resolveReady: (ready: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
  let readySettled = false;
  let readyTimer: ReturnType<typeof setTimeout>;
  const active: WorkerHandle = {
    worker,
    generation,
    ready,
    state: 'pending',
    retirement: null,
    settleReady(workerBecameReady) {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(readyTimer);
      if (workerBecameReady) active.state = 'ready';
      resolveReady(workerBecameReady);
      if (!workerBecameReady) return;
      armStableWorkerWindow(active);
      if (restarts > 0 && availableProjection) {
        logger.info(
          { event: 'direct_file_v2.recovered', generation: active.generation, crashCount: restarts },
          'direct transfer child recovered',
        );
      }
    },
  };
  readyTimer = setTimeout(() => {
    if (!handle || handle.generation !== generation || active.state !== 'pending') return;
    failWorkerGeneration(active, 'ready_timeout', null, null, true);
  }, DIRECT_FILE_TRANSFER_READY_TIMEOUT_MS);
  readyTimer.unref?.();

  worker.on('message', (raw: unknown) => handleWorkerMessage(active, raw, () => active.settleReady(true)));
  worker.on('error', (error) => {
    logger.warn({ err: error, event: 'direct_file_v2.worker_error', generation }, 'transfer worker error');
    failWorkerGeneration(active, 'child_process_error', null, null, true);
  });
  worker.on('exit', (code: number | null, signal: NodeJS.Signals | null = null) => {
    failWorkerGeneration(active, 'child_exit', code, signal, false);
  });

  handle = active;
  return active;
}

function ensureWorker(): WorkerHandle | null {
  if (handle) return handle;
  if (restartTimer) return null;
  try {
    return spawnWorker();
  } catch (error) {
    availableProjection = true;
    runtimeStatusProjection = { state: DIRECT_CONNECTIVITY_RUNTIME_STATE.AVAILABLE };
    logger.warn({ err: error, event: 'direct_file_v2.child_spawn_failed' }, 'transfer child spawn failed');
    scheduleWorkerRestart(null, null, generationCounter);
    return null;
  }
}

export async function initializeDirectFileTransfer(): Promise<boolean> {
  shuttingDown = false;
  const active = ensureWorker();
  if (!active) return false;
  const ready = await active.ready;
  return ready && availableProjection;
}

export function isDirectFileTransferAvailable(): boolean {
  return availableProjection;
}

export function getDirectConnectivityRuntimeStatus(): DirectConnectivityRuntimeStatus {
  return runtimeStatusProjection;
}

export async function handleDirectFileTransferCommand(
  message: unknown,
  sender: FileTransferSender,
): Promise<boolean> {
  // Once the addon is quiesced the worker is gone and must not come back: a
  // fresh one would map the very file the upgrade is about to replace.
  if (shuttingDown || nativeAdmissionClosed) return false;
  // Validated HERE, before the structured clone, not after it in the worker.
  // The worker checks again on receipt and must, but by the time it can the
  // main thread has already paid to copy whatever it was handed — and that copy
  // is precisely the main-loop cost this split exists to remove.
  const parsed = validateDirectFileTransferDaemonCommand(message);
  if (!parsed.ok) return false;
  const active = ensureWorker();
  if (!active) {
    sendRuntimeRecovering(sender, parsed.value);
    return false;
  }
  if (active.state === 'failed') {
    sendRuntimeRecovering(sender, parsed.value);
    return false;
  }
  // The initial child may accept a bounded command while bootstrapping, but a
  // replacement generation is not trusted until it has emitted READY. During
  // recovery callers receive the explicit retryable outcome instead of writing
  // into a live-but-mute child.
  if (active.state !== 'ready' && restarts > 0) {
    sendRuntimeRecovering(sender, parsed.value);
    return false;
  }
  const senderId = senderIdFor(sender);
  if (!rememberPending(senderId, parsed.value)) {
    sendRuntimeRecovering(sender, parsed.value);
    return false;
  }
  try {
    postToWorker(active, {
      type: DIRECT_FILE_TRANSFER_WORKER_MSG.COMMAND,
      senderId,
      command: parsed.value,
    });
  } catch {
    const requestId = (parsed.value as { requestId?: unknown }).requestId;
    if (typeof requestId === 'string') pendingByKey.delete(pendingKey(senderId, requestId));
    failWorkerGeneration(active, 'ipc_send_failed', null, null, true);
    sendRuntimeRecovering(sender, parsed.value);
    return false;
  }
  // Handing the command to the worker is the main thread's whole job here; the
  // reply arrives asynchronously as a CONTROL envelope.
  return true;
}

/* --------------------------------------------------------------------------
 * Upgrade quiesce, across the boundary.
 *
 * The upgrade path replaces node_datachannel.node in place while this daemon
 * may still have it mapped; calling into the addon afterwards faults. The
 * mapping now lives in the worker, so the main thread cannot inspect it — it
 * asks the isolate that owns it to drain its peers and clean up, and only a
 * real answer authorizes replacement.
 *
 * This is strictly stronger than draining in-process was: on success the thread
 * itself is ended, so the old mapping is not merely idle, it is unreachable.
 * ------------------------------------------------------------------------ */

const DIRECT_FILE_TRANSFER_NATIVE_QUIESCE_TIMEOUT_MS = 10_000;

/** Admission closed: no command is accepted and no worker may be spawned. */
let nativeAdmissionClosed = false;
/**
 * Quiesce COMPLETED: the worker proved it drained and cleaned up, and its
 * thread is gone. Distinct from admission closure on purpose — closing
 * admission is the first step, not proof that the addon is safe to replace.
 */
let nativeQuiesceCompleted = false;
/** In-flight quiesce, so concurrent callers share the one real outcome. */
let inFlightNativeQuiesce: Promise<{ ok: boolean; reason?: string; closedLeases: number }> | null = null;

/** Ask the worker for the real outcome, bounded so a mute worker cannot hang the upgrade. */
function requestWorkerQuiesce(
  active: WorkerHandle,
  timeoutMs: number,
): Promise<{ ok: boolean; reason?: string; closedLeases: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; reason?: string; closedLeases: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.worker.off('message', onMessage);
      active.worker.off('exit', onExit);
      resolve(result);
    };
    // The worker owns the drain deadline; this outer one only covers a worker
    // that never answers at all. Silence is not proof, so it fails closed.
    const timer = setTimeout(
      () => finish({ ok: false, reason: 'quiesce_result_timeout', closedLeases: 0 }),
      timeoutMs + SHUTDOWN_ACK_TIMEOUT_MS,
    );
    if (typeof timer.unref === 'function') timer.unref();
    const onMessage = (raw: unknown) => {
      const envelope = validateDirectFileTransferWorkerEnvelope(raw);
      if (!envelope || envelope.type !== DIRECT_FILE_TRANSFER_WORKER_MSG.QUIESCE_RESULT) return;
      if (envelope.generation !== active.generation) return;
      finish({
        ok: envelope.ok,
        closedLeases: envelope.closedLeases,
        ...(envelope.reason ? { reason: envelope.reason } : {}),
      });
    };
    // A worker that died mid-quiesce proved nothing about the mapping it held.
    const onExit = () => finish({ ok: false, reason: 'quiesce_worker_exited', closedLeases: 0 });
    active.worker.on('message', onMessage);
    active.worker.on('exit', onExit);
    postToWorker(active, { type: DIRECT_FILE_TRANSFER_WORKER_MSG.QUIESCE, timeoutMs });
  });
}

export async function quiesceDirectFileTransferNative(
  timeoutMs = DIRECT_FILE_TRANSFER_NATIVE_QUIESCE_TIMEOUT_MS,
): Promise<{ ok: boolean; reason?: string; closedLeases: number }> {
  // Only a COMPLETED quiesce is standing authority. Admission closure is not.
  if (nativeQuiesceCompleted) return { ok: true, closedLeases: 0 };
  // Concurrent callers must observe the REAL outcome, not a second half-run.
  if (inFlightNativeQuiesce) return inFlightNativeQuiesce;
  const run = (async () => {
    // Closed first and synchronously, so nothing is admitted mid-drain and a
    // worker that dies during it is not replaced by a fresh one that would map
    // the addon all over again.
    nativeAdmissionClosed = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const active = handle;
    if (!active) {
      // No isolate holds the mapping, so there is nothing that could fault.
      nativeQuiesceCompleted = true;
      return { ok: true, closedLeases: 0 };
    }
    const result = await requestWorkerQuiesce(active, timeoutMs);
    // Fail closed: the caller must not replace anything. Admission stays shut,
    // so the daemon keeps running with direct transfer degraded to relay.
    if (!result.ok) return result;
    handle = null;
    availableProjection = false;
    runtimeStatusProjection = { state: DIRECT_CONNECTIVITY_RUNTIME_STATE.RUNTIME_UNAVAILABLE };
    // Ending the child process is what turns "drained" into "unreachable".
    await active.worker.terminate();
    releaseClaimsForLostWorker(active.generation);
    sendersById.clear();
    nativeQuiesceCompleted = true;
    logger.info(
      { event: 'direct_file_v2.native_quiesced', closedLeases: result.closedLeases },
      'Direct file transfer native runtime quiesced',
    );
    return result;
  })();
  inFlightNativeQuiesce = run;
  try {
    return await run;
  } finally {
    inFlightNativeQuiesce = null;
  }
}

/** Whether new peers/leases are refused because the addon was quiesced. */
export function isDirectTransferNativeQuiesced(): boolean {
  return nativeAdmissionClosed;
}

export async function shutdownDirectFileTransfers(): Promise<void> {
  shuttingDown = true;
  nativeAdmissionClosed = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  failPendingForLostWorker();
  const active = handle;
  if (!active) {
    // Nothing holds the addon, which is exactly what completion means here.
    nativeQuiesceCompleted = true;
    return;
  }
  // Fail closed on absence as well as on failure: a missing ack is strictly
  // less evidence of a clean stop than a failing one, so the timeout resolves
  // to "not ok" rather than to silence.
  const acked = new Promise<{ cleanupOk: boolean; detail?: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ cleanupOk: false, detail: 'shutdown_ack_timeout' }), SHUTDOWN_ACK_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    const onMessage = (raw: unknown) => {
      const envelope = validateDirectFileTransferWorkerEnvelope(raw);
      if (!envelope || envelope.type !== DIRECT_FILE_TRANSFER_WORKER_MSG.SHUTDOWN_ACK) return;
      if (envelope.generation !== active.generation) return;
      clearTimeout(timer);
      active.worker.off('message', onMessage);
      resolve({ cleanupOk: envelope.cleanupOk, ...(envelope.detail ? { detail: envelope.detail } : {}) });
    };
    active.worker.on('message', onMessage);
  });
  postToWorker(active, { type: DIRECT_FILE_TRANSFER_WORKER_MSG.SHUTDOWN });
  const outcome = await acked;
  // Terminate unconditionally after the ack window: the native RTC runtime does
  // not always release the worker's loop, so waiting for a natural exit can hang
  // daemon shutdown indefinitely.
  handle = null;
  availableProjection = false;
  runtimeStatusProjection = { state: DIRECT_CONNECTIVITY_RUNTIME_STATE.RUNTIME_UNAVAILABLE };
  await active.worker.terminate();
  releaseClaimsForLostWorker(active.generation);
  sendersById.clear();
  nativeQuiesceCompleted = true;
  if (!outcome.cleanupOk) {
    // Teardown of local state is complete, but the worker did not reach a safe
    // resting point. Surfacing this is the whole point: the caller decides, and
    // it must never be able to mistake this for an orderly stop.
    throw new Error(
      `direct file transfer worker shutdown cleanup failed: ${outcome.detail ?? 'unknown'}`,
    );
  }
}
