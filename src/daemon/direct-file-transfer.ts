/**
 * Main-thread proxy for the direct file transfer data plane.
 *
 * The transfer state machine itself lives in `direct-file-transfer-worker.ts`
 * and runs on a worker thread: RTC/ICE/DataChannel callbacks, no-progress and
 * lease timers, sha256 hashing and every file read/write execute there. A
 * blocked daemon event loop therefore cannot starve them, which is the failure
 * this split exists to remove — transfers previously died because the loop was
 * busy, not because the peer connection was broken.
 *
 * This file owns only what must stay on the main thread: the WebSocket senders,
 * worker lifecycle, and a bounded capability projection. File bytes never cross
 * the boundary; only control envelopes do.
 */
import { Worker } from 'node:worker_threads';
import logger from '../util/logger.js';
import {
  DIRECT_CONNECTIVITY_RUNTIME_STATE,
  DIRECT_FILE_TRANSFER_HOST_METHOD,
  DIRECT_FILE_TRANSFER_WORKER_KIND,
  DIRECT_FILE_TRANSFER_WORKER_MSG,
  DIRECT_FILE_TRANSFER_WORKER_PROTOCOL_VERSION,
  isCurrentDirectFileTransferWorkerGeneration,
  validateDirectFileTransferDaemonCommand,
  validateDirectFileTransferDaemonMessage,
  validateDirectFileTransferWorkerEnvelope,
  type DirectConnectivityRuntimeStatus,
} from '../../shared/direct-file-transfer.js';
import type { FileTransferSender } from './file-transfer-handler.js';
import {
  finalizeDirectUploadedFile,
  lookupAttachmentByClientUploadId,
  releaseClientUploadClaim,
  resolveDirectFileDownloadSource,
  tryClaimClientUpload,
} from './file-transfer-handler.js';

export { toNodeDataChannelIceServers } from './direct-file-transfer-worker.js';

/** Bounded so a worker that crashes on every boot cannot spin the daemon. */
const MAX_WORKER_RESTARTS = 5;
const READY_TIMEOUT_MS = 15_000;
export const SHUTDOWN_ACK_TIMEOUT_MS = 5_000;

interface WorkerHandle {
  worker: Worker;
  generation: number;
  ready: Promise<void>;
}

let handle: WorkerHandle | null = null;
let generationCounter = 0;
let restarts = 0;
let shuttingDown = false;

/**
 * Availability is projected, not queried.
 *
 * `server-link` asks for this synchronously while building a capability
 * payload, and the answer lives in another thread. Caching the worker's last
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
  options: { workerData: { kind: typeof DIRECT_FILE_TRANSFER_WORKER_KIND; generation: number } },
) => Worker;

const spawnRealWorker: DirectFileTransferWorkerFactory = (url, options) => new Worker(url, options);
let workerFactory: DirectFileTransferWorkerFactory = spawnRealWorker;

/**
 * Test seam for the worker factory.
 *
 * Crash, restart-budget and stale-generation behaviour must be provable
 * deterministically. Racing a real thread to die on cue would make those tests
 * timing-dependent, so tests substitute a controllable double here. Production
 * always uses the real spawn.
 */
export function __setDirectFileTransferWorkerFactoryForTests(
  factory: DirectFileTransferWorkerFactory | null,
): void {
  workerFactory = factory ?? spawnRealWorker;
}

/** Reset all module state between tests so cases cannot leak into each other. */
export function __resetDirectFileTransferForTests(): void {
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

function postToWorker(active: WorkerHandle, envelope: Record<string, unknown>): void {
  active.worker.postMessage({
    v: DIRECT_FILE_TRANSFER_WORKER_PROTOCOL_VERSION,
    generation: active.generation,
    ...envelope,
  });
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
const claimTokensByHandle = new Map<string, { clientUploadId: string; token: symbol }>();
let claimHandleSeq = 0;

async function invokeHostMethod(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case DIRECT_FILE_TRANSFER_HOST_METHOD.TRY_CLAIM_CLIENT_UPLOAD: {
      const clientUploadId = String(args[0] ?? '');
      const token = tryClaimClientUpload(clientUploadId);
      if (!token) return null;
      claimHandleSeq += 1;
      const handle = `dft-claim-${claimHandleSeq}`;
      claimTokensByHandle.set(handle, { clientUploadId, token });
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
      return await finalizeDirectUploadedFile(
        args[0] as Parameters<typeof finalizeDirectUploadedFile>[0],
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
function releaseClaimsForLostWorker(): void {
  for (const [handle, claim] of [...claimTokensByHandle]) {
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
    try {
      sender.send(envelope.message);
    } catch (error) {
      logger.debug({ err: error, event: 'direct_file_v2.control_send_failed' }, 'control send failed');
    }
    return;
  }

  if (envelope.type === DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_CALL) {
    void invokeHostMethod(envelope.method, envelope.args)
      .then((value) => postToWorker(active, {
        type: DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_RESULT, callId: envelope.callId, ok: true, value,
      }))
      .catch((error: unknown) => postToWorker(active, {
        type: DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_RESULT,
        callId: envelope.callId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
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

function spawnWorker(): WorkerHandle {
  generationCounter += 1;
  const generation = generationCounter;
  const worker = workerFactory(workerModuleUrl(), {
    workerData: { kind: DIRECT_FILE_TRANSFER_WORKER_KIND, generation },
  });
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), READY_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    markReady = () => { clearTimeout(timer); resolve(); };
  });
  const active: WorkerHandle = { worker, generation, ready };

  worker.on('message', (raw: unknown) => handleWorkerMessage(active, raw, () => markReady()));
  worker.on('error', (error) => {
    logger.warn({ err: error, event: 'direct_file_v2.worker_error', generation }, 'transfer worker error');
  });
  worker.on('exit', (code) => {
    markReady();
    // Only the CURRENT worker's exit may recycle state; a late exit from an
    // already-replaced generation must not clobber the live one.
    if (!handle || handle.generation !== generation) return;
    handle = null;
    // A dead worker's claims must not outlive it: leaving them held would block
    // the relay path from ever claiming the same client upload id again.
    releaseClaimsForLostWorker();
    // Availability is worker-owned; with no worker there is nothing to project.
    availableProjection = false;
    runtimeStatusProjection = { state: DIRECT_CONNECTIVITY_RUNTIME_STATE.RUNTIME_UNAVAILABLE };
    if (shuttingDown || nativeAdmissionClosed) return;
    if (restarts >= MAX_WORKER_RESTARTS) {
      logger.error({ event: 'direct_file_v2.worker_restart_exhausted', code, generation },
        'transfer worker restart budget exhausted; direct transfer stays unavailable and relay remains enabled');
      return;
    }
    restarts += 1;
    logger.warn({ event: 'direct_file_v2.worker_restart', code, generation, restarts }, 'restarting transfer worker');
    handle = spawnWorker();
  });

  handle = active;
  return active;
}

function ensureWorker(): WorkerHandle {
  if (handle) return handle;
  return spawnWorker();
}

export async function initializeDirectFileTransfer(): Promise<boolean> {
  shuttingDown = false;
  restarts = 0;
  const active = ensureWorker();
  await active.ready;
  return availableProjection;
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
  postToWorker(active, {
    type: DIRECT_FILE_TRANSFER_WORKER_MSG.COMMAND,
    senderId: senderIdFor(sender),
    command: parsed.value,
  });
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
    // Ending the thread is what turns "drained" into "unreachable".
    await active.worker.terminate();
    releaseClaimsForLostWorker();
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
  releaseClaimsForLostWorker();
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
