import { createHash, randomBytes } from 'node:crypto';
import { open, readdir, readFile, stat, statfs, unlink, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import logger from '../util/logger.js';
import {
  DIRECT_CONNECTIVITY_RUNTIME_ERROR,
  DIRECT_CONNECTIVITY_RUNTIME_STATE,
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_DIRECTION,
  DIRECT_FILE_TRANSFER_ERROR,
  directFileTransferAttemptBindingMatches,
  DIRECT_FILE_TRANSFER_HEALTH_CHANNEL_PREFIX,
  DIRECT_FILE_TRANSFER_ERROR_SCOPE,
  DIRECT_FILE_TRANSFER_LEASE_CAPABILITY,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_OPERATION_CHANNEL_PREFIX,
  DIRECT_FILE_TRANSFER_OPERATION_STATE,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
  DIRECT_FILE_TRANSFER_TERMINAL_STATE,
  validateDirectFileTransferDaemonCommand,
  validateDirectFileTransferDataMessage,
  type DirectFileTransferAttemptBinding,
  type DirectFileTransferDaemonCommand,
  type DirectFileTransferDirection,
  type DirectFileTransferError,
  type DirectFileTransferIceServerConfig,
  type DirectFileTransferLeaseIce,
  type DirectFileTransferLeaseOffer,
  type DirectFileTransferLeasePrepare,
  type DirectConnectivityCandidateInfo,
  type DirectFileTransferPrepare,
  type DirectFileTransferTerminalState,
  type DirectConnectivityRuntimeError,
  type DirectConnectivityRuntimeStatus,
} from '../../shared/direct-file-transfer.js';
import type { AttachmentRef } from '../../shared/transport/file-transfer.js';
import {
  createDirectUploadFilename,
  ensureUploadDirectory,
  resolveUploadPath,
  type DirectFileDownloadSource,
} from './file-transfer-handler.js';

import { parentPort, workerData } from 'node:worker_threads';
import {
  DIRECT_FILE_TRANSFER_COMMIT_INTENT_SUFFIX,
  DIRECT_FILE_TRANSFER_HOST_METHOD,
  DIRECT_FILE_TRANSFER_WORKER_KIND,
  DIRECT_FILE_TRANSFER_WORKER_MSG,
  DIRECT_FILE_TRANSFER_WORKER_PROTOCOL_VERSION,
  validateDirectFileTransferWorkerEnvelope,
} from '../../shared/direct-file-transfer.js';

/**
 * The worker's stand-in for a main-thread transport.
 *
 * The socket stays on the main thread; the worker addresses it only by opaque
 * id. Keeping the `.send()` shape means every existing call site is unchanged,
 * so moving this module across the thread boundary did not rewrite its logic.
 */
interface WorkerControlSender {
  send(message: unknown): unknown;
}

/**
 * Spawn-scoped identity, supplied by the parent at boot. Every envelope this
 * worker emits carries it so a reply that outlives a crash-and-replace is
 * recognisably stale on arrival and is dropped by the parent.
 */
const directWorkerData = workerData as { kind?: unknown; generation?: unknown } | undefined;
const directWorkerPort = directWorkerData?.kind === DIRECT_FILE_TRANSFER_WORKER_KIND
  ? parentPort
  : null;
let activeWorkerGeneration: number = Number(directWorkerPort ? directWorkerData?.generation ?? 0 : 0);
let inProcessPost: ((envelope: Record<string, unknown>) => void) | null = null;

function post(envelope: Record<string, unknown>): void {
  const stamped = {
    v: DIRECT_FILE_TRANSFER_WORKER_PROTOCOL_VERSION,
    generation: activeWorkerGeneration,
    ...envelope,
  };
  if (directWorkerPort) directWorkerPort.postMessage(stamped);
  else inProcessPost?.(stamped);
}

/* --------------------------------------------------------------------------
 * Host authority calls.
 *
 * Attachment registration and client-upload claims are single-authority state
 * shared with the RELAY path, which runs on the main thread. Keeping a second
 * copy in this isolate is what let a direct and a relay upload claim the same
 * id independently, and hid worker-registered attachments from the main thread.
 * The worker therefore owns none of it and asks the host instead.
 *
 * Only metadata crosses. File contents are read, hashed and written here and
 * never appear in a host call.
 * ------------------------------------------------------------------------ */

interface PendingHostCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const pendingHostCalls = new Map<string, PendingHostCall>();
let hostCallSeq = 0;

/**
 * In-process host, for tests that exercise the state machine directly.
 *
 * Deliberately an explicit seam rather than an implicit "no parentPort means I
 * am the host" fallback: that fallback would silently reinstate the two-copy
 * authority bug the host call exists to remove, in any future path where
 * parentPort happened to be absent. Production must fail closed instead.
 */
let inProcessHost: ((method: string, args: unknown[]) => Promise<unknown>) | null = null;

export function __setDirectFileTransferWorkerHostForTests(
  host: ((method: string, args: unknown[]) => Promise<unknown>) | null,
): void {
  inProcessHost = host;
}

function callHost(method: string, args: unknown[]): Promise<unknown> {
  if (inProcessHost) return inProcessHost(method, args);
  if (!directWorkerPort && !inProcessPost) {
    return Promise.reject(new Error('direct_file_transfer_host_unavailable'));
  }
  hostCallSeq += 1;
  const callId = `dft-host-${activeWorkerGeneration}-${hostCallSeq}`;
  return new Promise<unknown>((resolve, reject) => {
    pendingHostCalls.set(callId, { resolve, reject });
    post({ type: DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_CALL, callId, method, args });
  });
}

function settleHostCall(callId: string, ok: boolean, value: unknown, error?: string): void {
  const pending = pendingHostCalls.get(callId);
  if (!pending) return;
  pendingHostCalls.delete(callId);
  if (ok) pending.resolve(value);
  else pending.reject(new Error(error ?? 'direct_file_transfer_host_call_failed'));
}

/**
 * Fail every in-flight host call.
 *
 * A host that will never answer must not leave upload/download paths awaiting
 * forever; failing closed surfaces the error to the existing transfer error
 * handling instead of stranding the attempt.
 */
function rejectAllHostCalls(reason: string): void {
  for (const [callId, pending] of [...pendingHostCalls]) {
    pendingHostCalls.delete(callId);
    pending.reject(new Error(reason));
  }
}

/**
 * Opaque claim handle.
 *
 * The real claim token is a symbol, which structured clone cannot carry, so the
 * host keeps the symbol and the worker holds only this string handle.
 */
type UploadClaimHandle = string;

async function tryClaimClientUpload(operationId: string): Promise<UploadClaimHandle | null> {
  const value = await callHost(DIRECT_FILE_TRANSFER_HOST_METHOD.TRY_CLAIM_CLIENT_UPLOAD, [operationId]);
  return typeof value === 'string' ? value : null;
}

async function releaseClientUploadClaim(operationId: string, handle: UploadClaimHandle): Promise<void> {
  await callHost(DIRECT_FILE_TRANSFER_HOST_METHOD.RELEASE_CLIENT_UPLOAD_CLAIM, [operationId, handle]);
}

async function lookupAttachmentByClientUploadId(clientUploadId: string): Promise<AttachmentRef | undefined> {
  const value = await callHost(
    DIRECT_FILE_TRANSFER_HOST_METHOD.LOOKUP_ATTACHMENT_BY_CLIENT_UPLOAD_ID, [clientUploadId],
  );
  return (value ?? undefined) as AttachmentRef | undefined;
}

async function resolveDirectFileDownloadSource(previewHandle: string): Promise<DirectFileDownloadSource> {
  return await callHost(
    DIRECT_FILE_TRANSFER_HOST_METHOD.RESOLVE_DIRECT_FILE_DOWNLOAD_SOURCE, [previewHandle],
  ) as DirectFileDownloadSource;
}

async function finalizeDirectUploadedFile(params: Record<string, unknown>): Promise<AttachmentRef> {
  return await callHost(
    DIRECT_FILE_TRANSFER_HOST_METHOD.FINALIZE_DIRECT_UPLOADED_FILE, [params],
  ) as AttachmentRef;
}

const senderCache = new Map<string, WorkerControlSender>();

/** One stable shim per sender id, so lease rebinding keeps object identity. */
function senderFor(senderId: string): WorkerControlSender {
  const existing = senderCache.get(senderId);
  if (existing) return existing;
  const created: WorkerControlSender = {
    send: (message: unknown) => {
      post({
        type: DIRECT_FILE_TRANSFER_WORKER_MSG.CONTROL,
        senderId,
        message: message as Record<string, unknown>,
        emittedAt: Date.now(),
      });
      return undefined;
    },
  };
  senderCache.set(senderId, created);
  return created;
};

type NodeDataChannel = typeof import('node-datachannel');
type PeerConnection = import('node-datachannel').PeerConnection;
type DataChannel = import('node-datachannel').DataChannel;
type NodeDataChannelIceServer = string | import('node-datachannel').IceServer;

interface PendingLeaseCandidate {
  requestId: string;
  candidate: string;
  mid: string;
}

interface PendingOperationChannel {
  channel: DataChannel;
  timer: ReturnType<typeof setTimeout>;
  /** The browser sends only START before waiting for ACCEPTED. */
  startMessage: string | null;
}

interface DirectLease {
  binding: Omit<DirectFileTransferLeasePrepare, 'type' | 'protocolVersion' | 'requestId' | 'iceServers'>;
  peer: PeerConnection;
  /** Retained so an abandoned browser peer can be replaced on the same lease. */
  iceServers: NodeDataChannelIceServer[];
  sender: WorkerControlSender;
  expiresAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  remoteDescriptionSet: boolean;
  /** Candidates are scoped to the SDP exchange that produced them. */
  pendingRemoteCandidates: PendingLeaseCandidate[];
  negotiationRequestId: string | null;
  activeAttempts: Set<string>;
  /** Channels that reached an already-warm peer just before their PREPARE. */
  pendingOperationChannels: Map<string, PendingOperationChannel>;
}

interface ActiveDirectTransfer {
  authority: DirectFileTransferPrepare;
  lease: DirectLease;
  channel: DataChannel | null;
  uploadFileHandle: FileHandle | null;
  downloadFileHandle: FileHandle | null;
  partPath: string | null;
  finalPath: string | null;
  finalFilename: string | null;
  /** Opaque host-issued claim handle; the real symbol stays on the main thread. */
  uploadClaim: string | null;
  received: number;
  /** Last `received` value already reported to the sender as a commit point. */
  committedReported: number;
  pendingBytes: number;
  downloadCredit: number;
  downloadSource: DirectFileDownloadSource | null;
  downloadPumping: boolean;
  hash: ReturnType<typeof createHash>;
  writeChain: Promise<void>;
  started: boolean;
  sourceFinished: boolean;
  settled: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface LedgerRecord {
  serverId: string;
  browserTabId: string;
  leaseId: string;
  leaseGeneration: number;
  direction: DirectFileTransferDirection;
  operationId: string;
  state: typeof DIRECT_FILE_TRANSFER_OPERATION_STATE[keyof typeof DIRECT_FILE_TRANSFER_OPERATION_STATE];
  terminalState?: DirectFileTransferTerminalState;
  attachment?: AttachmentRef;
  error?: DirectFileTransferError;
  expiresAt: number;
}

/**
 * Server-owned resume state for an in-progress upload, keyed by operationId.
 *
 * A transient DataChannel/ICE replacement used to cost the whole file. The
 * receiver already knows how many bytes it durably wrote, so the next attempt
 * for the SAME logical upload can continue from there — but only if the
 * partial file survives and can be proven to belong to that operation.
 *
 * The path is generated here from `randomBytes` and never contains anything
 * the client supplied: an operationId or filename interpolated into a path is
 * a traversal/collision surface, and the client must not be able to point the
 * daemon at a file of its choosing. The client only ever sends a byte offset,
 * which is checked against `stat()` of this path.
 */
interface UploadResumeState {
  partPath: string;
  finalPath: string;
  finalFilename: string;
  size: number;
  /** Authorized identity this partial belongs to; a mismatch fails closed. */
  serverId: string;
  browserTabId: string;
  leaseId: string;
  expiresAt: number;
}

const uploadResumeStates = new Map<string, UploadResumeState>();

/**
 * Partials this daemon created: `<final>.<32 hex>.part`. Nothing else in the
 * upload directory is ever a sweep candidate — an operator's own `.part` file
 * or any committed upload must survive untouched.
 */
const ORPHAN_PARTIAL_RE = /\.[0-9a-f]{32}\.part$/;

/**
 * One sweep is bounded work. A directory that has somehow grown very large
 * must not turn daemon startup into an unbounded stall.
 */
const ORPHAN_SWEEP_MAX_ENTRIES = 1_000;

/** A partial still owned by a live resume state or an in-flight transfer. */
function partialIsInUse(partPath: string, exceptOperationId?: string): boolean {
  for (const [operationId, state] of uploadResumeStates) {
    // The entry being released must not count as its own reason to survive.
    if (operationId === exceptOperationId) continue;
    if (state.partPath === partPath) return true;
  }
  for (const transfer of activeAttempts.values()) {
    // A settled transfer no longer owns its partial even if its entry has not
    // been reaped yet. Treating it as an owner is what makes the orphan
    // permanent: the state expires, the file is judged "in use" forever, and
    // nothing can ever name it again.
    if (!transfer.settled && transfer.partPath === partPath) return true;
  }
  return false;
}

/**
 * Drop a resume state AND the file it was the only reference to.
 *
 * The part path is `randomBytes(16)` and is recorded nowhere but this map, so
 * deleting the entry alone leaves a file that no later request can name, prove
 * ownership of, or resume from: a permanent orphan. The file is kept only when
 * an in-flight transfer still holds it, which stays true after a capacity
 * eviction races a live upload.
 */
async function releaseUploadResumeState(operationId: string, state: UploadResumeState): Promise<boolean> {
  // Asked BEFORE the entry is dropped, not after. A live transfer owns both
  // the state and the bytes; deleting the entry and keeping the file would
  // leave that upload holding a file it can no longer name — unable to resume,
  // and an orphan the moment it settles.
  if (partialIsInUse(state.partPath, operationId)) return false;
  uploadResumeStates.delete(operationId);
  await unlink(state.partPath).catch(() => {});
  return true;
}

/**
 * @param resumingOperationId the operation this prune is running on behalf of,
 *   which must survive CAPACITY eviction.
 *
 * Capacity eviction picks the oldest entry, and between an interruption and
 * its retry the interrupted operation is legitimately settled — so "skip live
 * states" alone does not protect it. Without this, a busy ledger silently
 * evicts the exact state the retry is about to resume from, and the retry
 * fails closed with invalid_authority having done nothing wrong. TTL expiry is
 * deliberately NOT overridden: an expired state is expired, and the resume
 * identity check rejects it anyway.
 */
async function pruneUploadResumeStates(resumingOperationId?: string): Promise<void> {
  const now = Date.now();
  for (const [key, state] of uploadResumeStates) {
    if (state.expiresAt <= now) await releaseUploadResumeState(key, state);
  }
  if (uploadResumeStates.size > DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_CAPACITY) {
    // Oldest first, skipping anything still live, and stopping as soon as the
    // ledger is back within capacity. One pass over the map, so the work stays
    // bounded even when every entry is live — in which case the bound is the
    // number of concurrent in-flight uploads, which is the honest limit: a
    // live upload cannot be evicted without breaking it.
    for (const [key, state] of uploadResumeStates) {
      if (uploadResumeStates.size <= DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_CAPACITY) break;
      if (key === resumingOperationId) continue;
      await releaseUploadResumeState(key, state);
    }
  }
}

/**
 * Reclaim partials whose in-memory resume state died with a previous process.
 *
 * Event-driven, never polled: one bounded pass at startup. A crash or restart
 * is the only way a partial can outlive its state now that eviction unlinks,
 * and startup is exactly when that backlog is visible.
 *
 * Deliberately conservative about what it will delete. Only files matching
 * this daemon's own random-suffix pattern are candidates, never a committed
 * upload (which carries no `.part`) and never one still referenced by a live
 * state or in-flight transfer. Age is the deciding test: within the resume
 * window a partial may still be legitimately recoverable, so only files older
 * than that window — which no surviving authority could still resume — are
 * removed.
 */
export async function scavengeOrphanUploadPartials(now = Date.now()): Promise<number> {
  let directory: string;
  try {
    directory = path.dirname(resolveUploadPath('probe.bin'));
  } catch { return 0; }
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch { return 0; }
  let removed = 0;
  for (const entry of entries.slice(0, ORPHAN_SWEEP_MAX_ENTRIES)) {
    if (!ORPHAN_PARTIAL_RE.test(entry)) continue;
    const candidate = path.join(directory, entry);
    if (partialIsInUse(candidate)) continue;
    const info = await stat(candidate).catch(() => null);
    if (!info || !info.isFile()) continue;
    if (now - info.mtimeMs <= DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_TTL_MS) continue;
    await unlink(candidate).catch(() => {});
    removed += 1;
  }
  if (removed > 0) {
    logger.info({ event: 'direct_file_v2.orphan_partials_reclaimed', removed }, 'Reclaimed orphaned upload partials');
  }
  return removed;
}

/**
 * Write-ahead commit intent: `<final>.commit-intent.json`.
 *
 * Publishing a finished upload takes two steps that cannot be made one atomic
 * one: the rename that moves `<final>.<hex>.part` into place, and the registry
 * write that makes the file discoverable. A crash between them leaves a file
 * that is neither resumable — its partial is gone, so `scavengeOrphanUploadPartials`
 * will never see it — nor terminal, because nothing references it. It is
 * invisible forever.
 *
 * The intent is written and fsynced BEFORE the rename and removed after the
 * registry write, so a later boot can always tell which side of that window the
 * process died on and finish the job.
 */
interface UploadCommitIntent {
  clientUploadId: string;
  filename: string;
  originalName: string;
  mime?: string;
  resolved: string;
  size: number;
  destinationDirectory?: string;
}

function commitIntentPathFor(finalPath: string): string {
  return `${finalPath}${DIRECT_FILE_TRANSFER_COMMIT_INTENT_SUFFIX}`;
}

/** Durably record the intent to publish. Must complete before the rename. */
async function writeUploadCommitIntent(intent: UploadCommitIntent): Promise<void> {
  const handle = await open(commitIntentPathFor(intent.resolved), 'w');
  try {
    await handle.writeFile(JSON.stringify(intent), 'utf8');
    // fsync: an intent that is only in the page cache is exactly the intent a
    // power loss destroys, which is the case it exists to survive.
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Parse a persisted intent. Fail closed on anything unexpected: this is disk
 * input, and a malformed record must never be coerced into a registry write.
 */
function parseUploadCommitIntent(raw: string): UploadCommitIntent | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const strings = ['clientUploadId', 'filename', 'originalName', 'resolved'] as const;
  for (const key of strings) {
    if (typeof record[key] !== 'string' || !record[key]) return null;
  }
  if (record.mime !== undefined && typeof record.mime !== 'string') return null;
  if (typeof record.size !== 'number' || !Number.isSafeInteger(record.size) || record.size < 0) return null;
  if (record.destinationDirectory !== undefined && typeof record.destinationDirectory !== 'string') return null;
  return record as unknown as UploadCommitIntent;
}

/**
 * Resolve every upload the previous process left mid-publish.
 *
 * Each intent ends in exactly one of two states, never a third:
 *   - the file was published  -> register it, so it is durable and discoverable
 *   - the file was not        -> drop the intent, so the operation is terminal
 *     and its partial (if any) stays under the ordinary resume/scavenge path
 *
 * A registry write that FAILS keeps its intent on disk, so the next boot tries
 * again rather than stranding the published file the way a swallowed error
 * would.
 */
export async function recoverInterruptedUploadCommits(): Promise<number> {
  let directory: string;
  try {
    directory = path.dirname(resolveUploadPath('probe.bin'));
  } catch { return 0; }
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch { return 0; }
  let recovered = 0;
  for (const entry of entries.slice(0, ORPHAN_SWEEP_MAX_ENTRIES)) {
    if (!entry.endsWith(DIRECT_FILE_TRANSFER_COMMIT_INTENT_SUFFIX)) continue;
    const intentPath = path.join(directory, entry);
    // The file to publish is the one this record sits beside, taken from the
    // directory entry rather than from the record's contents. A record is disk
    // input; trusting a path inside it would let a corrupted or tampered one
    // aim the attachment registry at any file on the machine.
    const resolved = path.join(directory, entry.slice(0, -DIRECT_FILE_TRANSFER_COMMIT_INTENT_SUFFIX.length));
    const raw = await readFile(intentPath, 'utf8').catch(() => null);
    const intent = raw === null ? null : parseUploadCommitIntent(raw);
    if (!intent || intent.resolved !== resolved || intent.filename !== path.basename(resolved)) {
      // Unreadable, malformed, or describing a file other than its own: it
      // names nothing we may act on.
      await unlink(intentPath).catch(() => {});
      continue;
    }
    const published = await stat(resolved).catch(() => null);
    if (!published?.isFile()) {
      // Died before the rename. Nothing was published, so the operation is
      // terminal; the partial remains owned by resume/scavenge.
      await unlink(intentPath).catch(() => {});
      continue;
    }
    try {
      const existing = await lookupAttachmentByClientUploadId(intent.clientUploadId);
      if (!existing) {
        await finalizeDirectUploadedFile({
          clientUploadId: intent.clientUploadId,
          filename: intent.filename,
          originalName: intent.originalName,
          resolved,
          size: intent.size,
          ...(intent.mime ? { mime: intent.mime } : {}),
          ...(intent.destinationDirectory ? { destinationDirectory: intent.destinationDirectory } : {}),
        });
        recovered += 1;
      }
    } catch (error) {
      // Fail closed: keep the intent so the next boot retries.
      logger.warn(
        { err: error, event: 'direct_file_v2.commit_intent_replay_failed' },
        'Interrupted upload commit could not be replayed; intent retained for retry',
      );
      continue;
    }
    await unlink(intentPath).catch(() => {});
  }
  if (recovered > 0) {
    logger.info(
      { event: 'direct_file_v2.upload_commits_recovered', recovered },
      'Republished uploads interrupted between rename and registry write',
    );
  }
  return recovered;
}

/** Drop resume state and its partial file. Only for terminal outcomes. */
async function discardUploadResumeState(operationId: string): Promise<void> {
  const state = uploadResumeStates.get(operationId);
  if (!state) return;
  uploadResumeStates.delete(operationId);
  await unlink(state.partPath).catch(() => {});
}



/* --------------------------------------------------------------------------
 * Upgrade quiesce.
 *
 * Ported unchanged from the main-thread implementation on dev: every piece of
 * state it reasons about — the addon handle, `leases`, `closeLease`, the
 * operation ledger — now lives on this side of the boundary, so this is where
 * the proof of native idleness has to be produced. The proxy asks; only this
 * isolate can answer.
 * ------------------------------------------------------------------------ */

/**
 * Admission is closed and the native addon must never be entered again.
 *
 * Set BEFORE any draining so nothing new can be admitted while we drain.
 */
let nativeAdmissionClosed = false;
/**
 * Quiesce COMPLETED: drained AND cleaned up. Distinct from admission closure on
 * purpose — closing admission is the first step, not proof that the addon is
 * safe to replace. Treating the admission flag as completion let a repeat call
 * authorize a package replacement while leases were still live.
 */
let nativeQuiesceCompleted = false;
/**
 * The addon reference, preserved across retries. `rtc` is cleared on the first
 * attempt to shut admission, so a later attempt would otherwise find null and
 * skip cleanup entirely while reporting success.
 */
let quiescedNativeRef: NodeDataChannel | null = null;
/** In-flight quiesce, so concurrent callers share the real outcome. */
let inFlightNativeQuiesce: Promise<{ ok: boolean; reason?: string; closedLeases: number }> | null = null;
/**
 * The REAL drain, retained across deadline responses.
 *
 * closeLease() removes a lease from `leases` BEFORE awaiting active transfer
 * shutdown, and it still calls into the addon afterwards
 * (pendingOperationChannels close, lease.peer.close). So a drain that outran
 * its deadline leaves `leases` empty while native calls are still pending: a
 * retry that re-snapshotted the map would see nothing to drain, clean up
 * immediately, and report success while the original close was still running —
 * re-creating the native-entry-after-replacement hazard this whole path exists
 * to remove. Every attempt therefore joins THIS promise instead of taking a
 * fresh snapshot.
 */
let inFlightNativeDrain: Promise<void> | null = null;
/** Count captured with the drain, so a joining retry reports the same number. */
let inFlightNativeDrainLeases = 0;

/**
 * Deadline for draining peers during an upgrade quiesce.
 *
 * Deliberately local rather than in `shared/`: this is an internal drain
 * deadline for this module, not a protocol value exchanged with the server or
 * the browser, so it has no cross-boundary contract to keep in sync.
 */
const DIRECT_FILE_TRANSFER_NATIVE_QUIESCE_TIMEOUT_MS = 10_000;

let rtc: NodeDataChannel | null = null;
let loadAttempted = false;
let rtcLoadError: DirectConnectivityRuntimeError | undefined;
const leases = new Map<string, DirectLease>();
const activeAttempts = new Map<string, ActiveDirectTransfer>();
const recentOperations = new Map<string, LedgerRecord>();

const TURN_URL_RE = /^(turn|turns):(\[[^\]]+\]|[^:?]+)(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/i;

/**
 * Transport-only observability.  Keep this deliberately small and structural:
 * values here describe lifecycle, route and byte counts, never user supplied
 * names/paths/content or any credential-bearing control-plane field.
 */
function directFileMetric(
  event: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  logger.info(
    { event: `direct_file_v2.${event}`, ...fields },
    'Direct file transfer v2 metric',
  );
}

function leaseKey(leaseId: string, generation: number): string {
  return `${leaseId}:${generation}`;
}

function ledgerKey(binding: Pick<DirectFileTransferAttemptBinding, 'serverId' | 'browserTabId' | 'leaseId' | 'leaseGeneration' | 'direction' | 'operationId'>): string {
  return [binding.serverId, binding.browserTabId, binding.leaseId, binding.leaseGeneration, binding.direction, binding.operationId].join(':');
}

function attemptBinding(authority: DirectFileTransferPrepare): DirectFileTransferAttemptBinding {
  return {
    serverId: authority.serverId,
    browserTabId: authority.browserTabId,
    leaseId: authority.leaseId,
    leaseGeneration: authority.leaseGeneration,
    daemonGeneration: authority.daemonGeneration,
    requestId: authority.requestId,
    attemptId: authority.attemptId,
    attempt: authority.attempt,
    direction: authority.direction,
    operationId: authority.operationId,
  };
}

function sameAttempt(authority: DirectFileTransferPrepare, value: Record<string, unknown>): boolean {
  return directFileTransferAttemptBindingMatches(authority, value);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toNodeDataChannelIceServers(
  iceServers: readonly DirectFileTransferIceServerConfig[],
): NodeDataChannelIceServer[] {
  const resolved: NodeDataChannelIceServer[] = [];
  for (const entry of iceServers) {
    if (typeof entry === 'string') {
      resolved.push(entry);
      continue;
    }
    for (const url of entry.urls) {
      if (/^stuns?:/i.test(url)) {
        resolved.push(url);
        continue;
      }
      const match = TURN_URL_RE.exec(url);
      if (!match || !entry.username || !entry.credential) throw new Error('Invalid authenticated TURN server configuration');
      const secure = match[1].toLowerCase() === 'turns';
      const port = Number(match[3] ?? (secure ? 5349 : 3478));
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid TURN server port');
      resolved.push({
        hostname: match[2].replace(/^\[|\]$/g, ''),
        port,
        username: entry.username,
        password: entry.credential,
        relayType: secure ? 'TurnTls' : match[4]?.toLowerCase() === 'tcp' ? 'TurnTcp' : 'TurnUdp',
      });
    }
  }
  return resolved;
}

export async function initializeDirectFileTransfer(): Promise<boolean> {
  if (loadAttempted) return rtc !== null;
  loadAttempted = true;
  try {
    rtc = await import('node-datachannel');
    // Native transport diagnostics can include SDP/candidate material.  Keep
    // this lifecycle signal structural rather than forwarding that payload.
    rtc.initLogger('Warning', () => logger.debug({ event: 'direct_file_v2.native_warning' }, 'node-datachannel warning'));
    rtcLoadError = undefined;
    logger.info({ capability: DIRECT_FILE_TRANSFER_LEASE_CAPABILITY }, 'Direct file transfer v2 available');
  } catch (error) {
    rtc = null;
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    rtcLoadError = detail.includes('node_datachannel.node') || detail.includes('MODULE_NOT_FOUND')
      ? DIRECT_CONNECTIVITY_RUNTIME_ERROR.NATIVE_MODULE_MISSING
      : DIRECT_CONNECTIVITY_RUNTIME_ERROR.LOAD_FAILED;
    logger.info({ event: 'direct_file_v2.runtime_unavailable', reason: rtcLoadError }, 'Direct file transfer unavailable; HTTP transfer remains enabled');
  }
  // Reclaim what a previous process left behind. Bounded, one pass, and it
  // runs whether or not the native transport loaded: the orphans exist either
  // way, and this must never be the reason startup fails.
  try { await scavengeOrphanUploadPartials(); } catch { /* startup must not fail on cleanup */ }
  return rtc !== null;
}

export function isDirectFileTransferAvailable(): boolean {
  return rtc !== null;
}

export function getDirectConnectivityRuntimeStatus(): DirectConnectivityRuntimeStatus {
  return rtc
    ? { state: DIRECT_CONNECTIVITY_RUNTIME_STATE.AVAILABLE }
    : { state: DIRECT_CONNECTIVITY_RUNTIME_STATE.RUNTIME_UNAVAILABLE, ...(rtcLoadError ? { error: rtcLoadError } : {}) };
}

function sendControl(lease: DirectLease, message: Record<string, unknown>): void {
  lease.sender.send(message);
}

function sendAttemptError(
  transfer: ActiveDirectTransfer,
  error: DirectFileTransferError,
  retryable: boolean,
  detail?: string,
): void {
  sendControl(transfer.lease, {
    type: DIRECT_FILE_TRANSFER_MSG.ERROR,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.OPERATION,
    ...attemptBinding(transfer.authority),
    error,
    retryable,
    ...(detail ? { detail: detail.slice(0, DIRECT_FILE_TRANSFER_LIMITS.ERROR_DETAIL_BYTES) } : {}),
  });
  if (transfer.channel) {
    try {
      transfer.channel.sendMessage(JSON.stringify({
        type: DIRECT_FILE_TRANSFER_DATA_MSG.ERROR,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        ...attemptBinding(transfer.authority),
        error,
      }));
    } catch { /* peer already closed */ }
  }
}

function putLedger(
  authority: DirectFileTransferPrepare,
  state: LedgerRecord['state'],
  terminalState?: DirectFileTransferTerminalState,
  attachment?: AttachmentRef,
  error?: DirectFileTransferError,
): void {
  const key = ledgerKey(authority);
  recentOperations.set(key, {
    serverId: authority.serverId,
    browserTabId: authority.browserTabId,
    leaseId: authority.leaseId,
    leaseGeneration: authority.leaseGeneration,
    direction: authority.direction,
    operationId: authority.operationId,
    state,
    ...(terminalState ? { terminalState } : {}),
    ...(attachment ? { attachment } : {}),
    ...(error ? { error } : {}),
    expiresAt: Date.now() + DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_TTL_MS,
  });
  while (recentOperations.size > DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_CAPACITY) {
    const oldest = recentOperations.keys().next().value as string | undefined;
    if (!oldest) break;
    recentOperations.delete(oldest);
  }
}

function findLedger(binding: DirectFileTransferAttemptBinding): LedgerRecord | undefined {
  const record = recentOperations.get(ledgerKey(binding));
  if (!record) return undefined;
  if (record.expiresAt <= Date.now()) {
    recentOperations.delete(ledgerKey(binding));
    return undefined;
  }
  return record;
}

function resetLeaseIdleTimer(lease: DirectLease): void {
  if (lease.idleTimer) clearTimeout(lease.idleTimer);
  if (lease.activeAttempts.size > 0) {
    lease.idleTimer = null;
    return;
  }
  lease.idleTimer = setTimeout(() => { void closeLease(lease, true); }, DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS);
  lease.idleTimer.unref?.();
}

function resetTransferIdleTimer(transfer: ActiveDirectTransfer): void {
  if (transfer.idleTimer) clearTimeout(transfer.idleTimer);
  transfer.idleTimer = setTimeout(() => {
    void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.NO_PROGRESS_TIMEOUT, true, 'Direct file attempt made no progress');
  }, DIRECT_FILE_TRANSFER_LIMITS.NO_PROGRESS_TIMEOUT_MS);
  transfer.idleTimer.unref?.();
}

function routeMetricClass(lease: DirectLease): 'direct' | 'relay' | 'unknown' {
  try {
    const selected = lease.peer.getSelectedCandidatePair();
    const localType = typeof selected?.local?.type === 'string' ? selected.local.type.toLowerCase() : '';
    const remoteType = typeof selected?.remote?.type === 'string' ? selected.remote.type.toLowerCase() : '';
    if (!localType || !remoteType) return 'unknown';
    return localType === 'relay' || remoteType === 'relay' ? 'relay' : 'direct';
  } catch {
    return 'unknown';
  }
}

async function closeTransferResources(transfer: ActiveDirectTransfer, removePart: boolean): Promise<void> {
  if (transfer.idleTimer) clearTimeout(transfer.idleTimer);
  transfer.idleTimer = null;
  await transfer.writeChain.catch(() => {});
  if (transfer.uploadFileHandle) await transfer.uploadFileHandle.close().catch(() => {});
  if (transfer.downloadFileHandle) await transfer.downloadFileHandle.close().catch(() => {});
  transfer.uploadFileHandle = null;
  transfer.downloadFileHandle = null;
  try { transfer.channel?.close(); } catch { /* already closed */ }
  if (removePart) {
    // `removePart` marks a terminal outcome — explicit cancel, expiry, or a
    // final integrity failure — so the resume state goes with the bytes. A
    // transient channel/ICE failure passes false and deliberately keeps both,
    // which is what makes resuming from the confirmed offset possible.
    await discardUploadResumeState(transfer.authority.operationId);
    if (transfer.partPath) await unlink(transfer.partPath).catch(() => {});
    // After the atomic staging rename, directory validation/commit can still
    // fail (missing directory, symlink, existing target). Do not strand the
    // promoted upload or metadata when that attempt terminalizes as failed.
    if (transfer.finalPath && transfer.finalPath !== transfer.partPath) {
      await unlink(transfer.finalPath).catch(() => {});
      await unlink(`${transfer.finalPath}.meta.json`).catch(() => {});
      // The write-ahead record dies with the file it described. Recovery would
      // reach the same verdict from the missing file alone, but leaving the
      // record behind until the next boot is needless litter.
      await unlink(commitIntentPathFor(transfer.finalPath)).catch(() => {});
    }
  }
  activeAttempts.delete(transfer.authority.attemptId);
  transfer.lease.activeAttempts.delete(transfer.authority.attemptId);
  if (transfer.uploadClaim) {
    await releaseClientUploadClaim(transfer.authority.operationId, transfer.uploadClaim)
      .catch(() => undefined);
  }
  resetLeaseIdleTimer(transfer.lease);
}

async function closeLease(lease: DirectLease, cancelActive: boolean): Promise<void> {
  if (lease.idleTimer) clearTimeout(lease.idleTimer);
  lease.idleTimer = null;
  leases.delete(leaseKey(lease.binding.leaseId, lease.binding.leaseGeneration));
  directFileMetric('lease_evicted', { activeAttempts: lease.activeAttempts.size, canceled: cancelActive });
  if (cancelActive) {
    const transfers = [...activeAttempts.values()].filter((transfer) => transfer.lease === lease);
    await Promise.all(transfers.map((transfer) => failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED, true, undefined, false)));
  }
  for (const pending of lease.pendingOperationChannels.values()) {
    clearTimeout(pending.timer);
    try { pending.channel.close(); } catch { /* already closed */ }
  }
  lease.pendingOperationChannels.clear();
  try { lease.peer.close(); } catch { /* already closed */ }
}

/**
 * The transport went away and the same operation can pick up where it stopped.
 *
 * Deliberately narrower than `retryable`: a failed write or a failed commit is
 * also retryable, but it is a LOCAL failure whose half-written staging must be
 * cleaned up rather than preserved. Only these three describe "the connection
 * died", which is the case resuming exists for.
 */
const RETRYABLE_TRANSPORT_LOSS: ReadonlySet<string> = new Set([
  DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED,
  DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
  DIRECT_FILE_TRANSFER_ERROR.NO_PROGRESS_TIMEOUT,
]);

function isRetryableTransportLoss(error: DirectFileTransferError, retryable: boolean): boolean {
  return retryable && RETRYABLE_TRANSPORT_LOSS.has(error);
}

/**
 * @param discardPartial whether this outcome also destroys the partial file.
 *
 * Only terminal outcomes should: an explicit cancel, an expired lease/resume
 * window, or a final integrity failure. A transient channel/ICE loss, or a
 * resume request whose offset does not match, must leave the partial intact —
 * otherwise one dropped channel (or one malformed request) throws away bytes a
 * legitimate sender could have continued from, which is exactly the whole-file
 * restart this work exists to remove.
 */
/**
 * @param discardPartial whether this outcome also destroys the partial file.
 *
 * Defaults to "keep it exactly when this was retryable TRANSPORT LOSS". The
 * point of resuming is that losing the connection costs the remaining bytes
 * rather than the whole file, so those outcomes must keep BOTH the resume map
 * entry and the bytes on disk. Everything else — terminal outcomes like
 * cancel, lease/authority expiry, size or checksum failure, and equally a
 * retryable LOCAL failure such as a failed write or a failed commit, which is
 * not transport loss at all — takes the partial with it.
 *
 * This was previously defaulted to `true`, so every retryable path that did
 * not remember to pass the argument — `channel.onError`, every peer
 * failed/closed/disconnected transition, the no-progress timeout, write
 * failures — silently destroyed exactly what the next attempt needed. Only the
 * clean-close path happened to pass it, which is why a resume test that only
 * closed the channel could not see the defect.
 *
 * Call sites that are non-retryable but must still NOT destroy the file (a
 * wrong or hostile resume request) keep passing `false` explicitly.
 */
async function failTransfer(
  transfer: ActiveDirectTransfer,
  error: DirectFileTransferError,
  retryable: boolean,
  detail?: string,
  discardPartial = !isRetryableTransportLoss(error, retryable),
): Promise<void> {
  if (transfer.settled) return;
  transfer.settled = true;
  // `error` and `detail` are the whole reason this metric exists. Without them
  // every failure looked identical in the logs -- direction, attempt, retryable,
  // zero bytes -- so a 3ms channel_closed and a 20s no_progress_timeout, which
  // have nothing in common and need opposite fixes, were indistinguishable.
  directFileMetric(
    error === DIRECT_FILE_TRANSFER_ERROR.CANCELED ? 'canceled' : 'attempt_failed',
    {
      direction: transfer.authority.direction,
      attempt: transfer.authority.attempt,
      retryable,
      bytes: transfer.received,
      // The enum only. `detail` is deliberately NOT logged: on the write-failure
      // paths it carries an underlying error string that can contain a
      // filesystem path, and this metric is asserted elsewhere to leak neither
      // paths nor authority. The enum is a closed vocabulary and is all the
      // diagnosis needed.
      error,
    },
  );
  putLedger(transfer.authority, DIRECT_FILE_TRANSFER_OPERATION_STATE.FAILED, DIRECT_FILE_TRANSFER_TERMINAL_STATE.FAILED, undefined, error);
  sendAttemptError(transfer, error, retryable, detail);
  sendControl(transfer.lease, {
    type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    ...attemptBinding(transfer.authority),
    state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.FAILED,
    error,
  });
  await closeTransferResources(transfer, discardPartial);
}

async function ensureDiskCapacity(size: number, targetPath: string): Promise<void> {
  const stats = await statfs(path.dirname(targetPath));
  const free = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(free) || free - DIRECT_FILE_TRANSFER_LIMITS.DISK_RESERVE_BYTES < size) throw new Error(DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED);
}

function makeDataBinding(authority: DirectFileTransferPrepare): DirectFileTransferAttemptBinding {
  return attemptBinding(authority);
}

function channelMatches(transfer: ActiveDirectTransfer, channel: DataChannel): boolean {
  try { return channel.getLabel() === transfer.authority.channelLabel; } catch { return false; }
}

function isLeaseHealthChannel(channel: DataChannel): boolean {
  try { return channel.getLabel().startsWith(DIRECT_FILE_TRANSFER_HEALTH_CHANNEL_PREFIX); } catch { return false; }
}

function channelLabel(channel: DataChannel): string | null {
  try { return channel.getLabel(); } catch { return null; }
}

function takePendingOperationChannel(lease: DirectLease, label: string): PendingOperationChannel | null {
  const pending = lease.pendingOperationChannels.get(label);
  if (!pending) return null;
  clearTimeout(pending.timer);
  lease.pendingOperationChannels.delete(label);
  try {
    if (!pending.channel.isOpen()) return null;
    directFileMetric('channel_bound_after_prepare');
    return pending;
  } catch { return null; }
}

/**
 * PREPARE and the data channel travel over independent transports. On a warm
 * peer the channel can arrive first, so retain only a recognized operation
 * label for one signalling window. START still has to prove the full opaque
 * authority before the channel can touch a file.
 */
function retainPendingOperationChannel(lease: DirectLease, channel: DataChannel): boolean {
  const label = channelLabel(channel);
  if (!label?.startsWith(DIRECT_FILE_TRANSFER_OPERATION_CHANNEL_PREFIX)) return false;
  if (lease.pendingOperationChannels.has(label)
    || lease.pendingOperationChannels.size + lease.activeAttempts.size >= DIRECT_FILE_TRANSFER_LIMITS.MAX_ACTIVE_CHANNELS_PER_LEASE) return false;

  const pending = {} as PendingOperationChannel;
  const discard = () => {
    if (lease.pendingOperationChannels.get(label) !== pending) return;
    lease.pendingOperationChannels.delete(label);
    clearTimeout(pending.timer);
  };
  pending.channel = channel;
  pending.startMessage = null;
  pending.timer = setTimeout(() => {
    discard();
    directFileMetric('channel_prepare_timeout');
    try { channel.close(); } catch { /* already closed */ }
  }, DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS);
  lease.pendingOperationChannels.set(label, pending);
  channel.onMessage((message) => {
    if (lease.pendingOperationChannels.get(label) !== pending) return;
    if (typeof message !== 'string' || pending.startMessage !== null) {
      discard();
      try { channel.close(); } catch { /* invalid early payload */ }
      return;
    }
    let raw: unknown;
    try { raw = JSON.parse(message); } catch { raw = null; }
    const parsed = validateDirectFileTransferDataMessage(raw);
    if (!parsed.ok || parsed.value.type !== DIRECT_FILE_TRANSFER_DATA_MSG.START) {
      discard();
      try { channel.close(); } catch { /* invalid early payload */ }
      return;
    }
    pending.startMessage = message;
  });
  channel.onClosed(discard);
  channel.onError(discard);
  directFileMetric('channel_held_before_prepare');
  return true;
}

function toCandidateInfo(value: unknown): DirectConnectivityCandidateInfo | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.address !== 'string' || typeof candidate.port !== 'number'
    || !Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65_535
    || typeof candidate.type !== 'string' || typeof candidate.transportType !== 'string') return null;
  return {
    address: candidate.address,
    port: candidate.port,
    type: candidate.type,
    transportType: candidate.transportType,
  };
}

/**
 * The explicit connectivity diagnostic is allowed on a ready lease, but is
 * deliberately incapable of opening a file operation: it has no authority,
 * no operation binding, and accepts only a bounded nonce probe.
 */
function attachLeaseHealthChannel(lease: DirectLease, channel: DataChannel): void {
  channel.onMessage((message) => {
    if (typeof message !== 'string') {
      try { channel.close(); } catch { /* invalid health payload */ }
      return;
    }
    let raw: unknown;
    try { raw = JSON.parse(message); } catch { raw = null; }
    const parsed = validateDirectFileTransferDataMessage(raw);
    if (!parsed.ok || parsed.value.type !== DIRECT_FILE_TRANSFER_DATA_MSG.HEALTH_PROBE
      || parsed.value.serverId !== lease.binding.serverId
      || parsed.value.browserTabId !== lease.binding.browserTabId
      || parsed.value.leaseId !== lease.binding.leaseId
      || parsed.value.leaseGeneration !== lease.binding.leaseGeneration
      || parsed.value.daemonGeneration !== lease.binding.daemonGeneration) {
      try { channel.close(); } catch { /* invalid health payload */ }
      return;
    }
    const selected = lease.peer.getSelectedCandidatePair();
    const localCandidate = toCandidateInfo(selected?.local);
    const remoteCandidate = toCandidateInfo(selected?.remote);
    if (!localCandidate || !remoteCandidate) {
      try { channel.close(); } catch { /* no route to report */ }
      return;
    }
    try {
      channel.sendMessage(JSON.stringify({
        type: DIRECT_FILE_TRANSFER_DATA_MSG.HEALTH_PONG,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        serverId: lease.binding.serverId,
        browserTabId: lease.binding.browserTabId,
        leaseId: lease.binding.leaseId,
        leaseGeneration: lease.binding.leaseGeneration,
        daemonGeneration: lease.binding.daemonGeneration,
        nonce: parsed.value.nonce,
        rttMs: Math.max(0, lease.peer.rtt()),
        localCandidate,
        remoteCandidate,
      }));
    } finally {
      try { channel.close(); } catch { /* diagnostic complete */ }
    }
  });
}

async function startUpload(transfer: ActiveDirectTransfer, requestedResumeOffset = 0): Promise<void> {
  const authority = transfer.authority;
  if (authority.direction !== DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD || transfer.started) return;
  const existing = await lookupAttachmentByClientUploadId(authority.clientUploadId);
  if (existing) {
    transfer.started = true;
    transfer.settled = true;
    putLedger(authority, DIRECT_FILE_TRANSFER_OPERATION_STATE.COMMITTED, DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED, existing);
    transfer.channel?.sendMessage(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.UPLOAD_COMMITTED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...makeDataBinding(authority),
      attachment: existing,
    }));
    sendControl(transfer.lease, {
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...makeDataBinding(authority),
      state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED,
      attachment: existing,
    });
    await closeTransferResources(transfer, false);
    return;
  }
  await ensureUploadDirectory();
  await pruneUploadResumeStates(authority.operationId);
  const resumeOffset = requestedResumeOffset;
  const priorResume = uploadResumeStates.get(authority.operationId);
  // Identity is checked before anything is opened. A partial file belongs to
  // one operation under one authorized identity; a request that does not match
  // must never be able to read, extend or destroy it.
  const resumeIdentityMatches = !!priorResume
    && priorResume.serverId === authority.serverId
    && priorResume.browserTabId === authority.browserTabId
    && priorResume.leaseId === authority.leaseId
    && priorResume.size === authority.size
    && priorResume.expiresAt > Date.now();

  if (resumeOffset > 0) {
    if (!resumeIdentityMatches || !priorResume || resumeOffset > authority.size) {
      // Fail closed WITHOUT deleting the partial: a wrong or hostile request
      // must not be able to destroy data a legitimate sender can still resume.
      void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false, undefined, false);
      return;
    }
    const actual = await stat(priorResume.partPath).catch(() => null);
    if (!actual || !actual.isFile() || actual.size !== resumeOffset) {
      void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.SIZE_MISMATCH, false, undefined, false);
      return;
    }
    transfer.partPath = priorResume.partPath;
    transfer.finalPath = priorResume.finalPath;
    transfer.finalFilename = priorResume.finalFilename;
    // Re-derive the digest by streaming [0, resumeOffset) back. The hash state
    // cannot be serialised across attempts, and a per-chunk hash ledger would
    // be a second source of truth; a bounded re-read keeps one.
    transfer.uploadFileHandle = await open(transfer.partPath, 'r+');
    const rehash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES);
    let read = 0;
    while (read < resumeOffset) {
      const want = Math.min(buffer.length, resumeOffset - read);
      const result = await transfer.uploadFileHandle.read(buffer, 0, want, read);
      if (result.bytesRead <= 0) break;
      rehash.update(buffer.subarray(0, result.bytesRead));
      read += result.bytesRead;
    }
    if (read !== resumeOffset) {
      await transfer.uploadFileHandle.close().catch(() => {});
      transfer.uploadFileHandle = null;
      void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.SIZE_MISMATCH, false, undefined, false);
      return;
    }
    transfer.hash = rehash;
    transfer.received = resumeOffset;
    // Left at zero on purpose: `committedReported` tracks what has been SENT to
    // this sender, and the replacement attempt has been told nothing yet.
    // Pre-seeding it would make the first report look like zero progress and
    // the throttle would swallow it, leaving the resumed sender unable to see
    // that its offset was accepted.
    transfer.committedReported = 0;
    priorResume.expiresAt = Date.now() + DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_TTL_MS;
    transfer.started = true;
    resetTransferIdleTimer(transfer);
    reportUploadCommit(transfer);
    transfer.channel?.sendMessage(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...makeDataBinding(authority),
    }));
    return;
  }

  const filename = priorResume && resumeIdentityMatches
    ? priorResume.finalFilename
    : createDirectUploadFilename(authority.filename);
  const finalPath = priorResume && resumeIdentityMatches
    ? priorResume.finalPath
    : resolveUploadPath(filename);
  await ensureDiskCapacity(authority.size, finalPath);
  // Suffix is server-random; nothing the client sent reaches the path.
  const partPath = priorResume && resumeIdentityMatches
    ? priorResume.partPath
    : `${finalPath}.${randomBytes(16).toString('hex')}.part`;
  transfer.partPath = partPath;
  transfer.finalPath = finalPath;
  transfer.finalFilename = filename;
  // Starting from zero always begins a fresh file, so an existing partial for
  // this operation is replaced rather than silently appended to.
  await unlink(partPath).catch(() => {});
  transfer.uploadFileHandle = await open(partPath, 'wx');
  uploadResumeStates.set(authority.operationId, {
    partPath,
    finalPath,
    finalFilename: filename,
    size: authority.size,
    serverId: authority.serverId,
    browserTabId: authority.browserTabId,
    leaseId: authority.leaseId,
    expiresAt: Date.now() + DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_TTL_MS,
  });
  transfer.started = true;
  resetTransferIdleTimer(transfer);
  transfer.channel?.sendMessage(JSON.stringify({
    type: DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    ...makeDataBinding(authority),
    direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
  }));
}

async function startDownload(transfer: ActiveDirectTransfer): Promise<void> {
  const authority = transfer.authority;
  if (authority.direction !== DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD || transfer.started) return;
  let source: DirectFileDownloadSource;
  try {
    source = await resolveDirectFileDownloadSource(authority.previewHandle);
  } catch (error) {
    const detail = errorDetail(error);
    await failTransfer(
      transfer,
      // A preview handle expiring is distinct from the per-attempt authority
      // expiring.  The browser is permitted to mint one fresh preview handle
      // for this former case, so both registry expiry and disappearance use
      // the stable, non-sensitive preview-handle error code.
      detail === 'expired' || detail === 'not_found' ? DIRECT_FILE_TRANSFER_ERROR.PREVIEW_HANDLE_INVALID
          : DIRECT_FILE_TRANSFER_ERROR.PREVIEW_POLICY_DENIED,
      false,
    );
    return;
  }
  transfer.downloadSource = source;
  transfer.downloadFileHandle = await open(source.readPath, 'r');
  transfer.started = true;
  resetTransferIdleTimer(transfer);
  transfer.channel?.sendMessage(JSON.stringify({
    type: DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    ...makeDataBinding(authority),
    direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD,
    filename: source.filename,
    ...(source.mime ? { mime: source.mime } : {}),
    size: source.size,
  }));
}

/**
 * Tell the sender how many bytes are durably on disk.
 *
 * Uploads previously had no receiver-to-sender signal whatsoever, so the
 * browser judged the transfer's health purely from its own
 * `RTCDataChannel.bufferedAmount`. A receiver that was committing steadily but
 * draining slower than one no-progress window was indistinguishable from a dead
 * peer, and the transfer was killed mid-flight and re-sent whole over the HTTP
 * relay.
 *
 * Called only AFTER `write()` resolves, so the number is a commit point rather
 * than an intent, and it is monotonic by construction (`received` only grows).
 * Reports are throttled to one per chunk-sized advance: the sender needs
 * evidence of progress, not a frame per write. Send failures are ignored — this
 * is advisory liveness, and losing one must never fail a healthy transfer.
 */
function reportUploadCommit(transfer: ActiveDirectTransfer): void {
  if (transfer.settled || !transfer.channel) return;
  if (transfer.authority.direction !== DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD) return;
  const advanced = transfer.received - transfer.committedReported;
  if (advanced < DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES && transfer.received < transfer.authority.size) return;
  transfer.committedReported = transfer.received;
  try {
    transfer.channel.sendMessage(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...attemptBinding(transfer.authority),
      creditBytes: DIRECT_FILE_TRANSFER_LIMITS.DATA_CREDIT_BYTES,
      committedBytes: transfer.received,
    }));
  } catch { /* peer already closed; the sender's own watchdog still applies */ }
}

function enqueueUploadChunk(transfer: ActiveDirectTransfer, bytes: Uint8Array): void {
  if (!transfer.started || transfer.settled || !transfer.uploadFileHandle) return;
  const authority = transfer.authority;
  if (authority.direction !== DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD
    || transfer.received + transfer.pendingBytes + bytes.byteLength > authority.size) {
    void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.SIZE_MISMATCH, false);
    return;
  }
  transfer.pendingBytes += bytes.byteLength;
  if (transfer.pendingBytes > DIRECT_FILE_TRANSFER_LIMITS.DATA_BUFFER_HIGH_WATER_BYTES) {
    void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, true, 'Receiver disk backlog exceeded');
    return;
  }
  const copy = Buffer.from(bytes);
  transfer.writeChain = transfer.writeChain.then(async () => {
    if (!transfer.uploadFileHandle || transfer.settled) return;
    await transfer.uploadFileHandle.write(copy);
    transfer.hash.update(copy);
    transfer.received += copy.byteLength;
    transfer.pendingBytes -= copy.byteLength;
    resetTransferIdleTimer(transfer);
    reportUploadCommit(transfer);
  }).catch((error) => {
    transfer.pendingBytes = Math.max(0, transfer.pendingBytes - copy.byteLength);
    void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, true, errorDetail(error));
  });
}

async function finishUpload(transfer: ActiveDirectTransfer, totalBytes: number, sha256?: string): Promise<void> {
  const authority = transfer.authority;
  if (authority.direction !== DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD) return;
  await transfer.writeChain;
  if (transfer.settled) return;
  if (!transfer.started || !transfer.uploadFileHandle || !transfer.partPath || !transfer.finalPath || !transfer.finalFilename
    || totalBytes !== transfer.received || transfer.received !== authority.size) {
    await failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.SIZE_MISMATCH, false);
    return;
  }
  // Captured while the guard above still narrows them: the awaits below can
  // interleave with mutation of `transfer`, and a publish must never be
  // described by a name or path that changed underneath it.
  const { partPath, finalPath, finalFilename } = transfer;
  const digest = transfer.hash.digest('hex');
  if ((sha256 ?? authority.sha256) && digest !== (sha256 ?? authority.sha256)) {
    await failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.CHECKSUM_MISMATCH, false);
    return;
  }
  await transfer.uploadFileHandle.sync();
  await transfer.uploadFileHandle.close();
  transfer.uploadFileHandle = null;
  const intent: UploadCommitIntent = {
    clientUploadId: authority.clientUploadId,
    filename: finalFilename,
    originalName: authority.filename,
    resolved: finalPath,
    size: transfer.received,
    ...(authority.mime ? { mime: authority.mime } : {}),
    ...(authority.destinationDirectory ? { destinationDirectory: authority.destinationDirectory } : {}),
  };
  // Written BEFORE the rename: from here on, a crash is recoverable in one
  // direction or the other, never into an unreferenced published file.
  await writeUploadCommitIntent(intent);
  await rename(partPath, finalPath);
  // Committed: the partial no longer exists, so neither should the resume state.
  uploadResumeStates.delete(transfer.authority.operationId);
  const attachment = await finalizeDirectUploadedFile({ ...intent });
  // The registry now references the file; the write-ahead record has done its
  // job. A leftover here is harmless — replay is idempotent via lookup.
  await unlink(commitIntentPathFor(intent.resolved)).catch(() => {});
  transfer.settled = true;
  directFileMetric('direct_success', {
    direction: authority.direction,
    attempt: authority.attempt,
    bytes: transfer.received,
    route: routeMetricClass(transfer.lease),
  });
  putLedger(authority, DIRECT_FILE_TRANSFER_OPERATION_STATE.COMMITTED, DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED, attachment);
  transfer.channel?.sendMessage(JSON.stringify({
    type: DIRECT_FILE_TRANSFER_DATA_MSG.UPLOAD_COMMITTED,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    ...makeDataBinding(authority),
    attachment,
  }));
  sendControl(transfer.lease, {
    type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    ...makeDataBinding(authority),
    state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED,
    attachment,
  });
  await closeTransferResources(transfer, false);
}

async function waitForChannelBuffer(channel: DataChannel): Promise<void> {
  if (channel.bufferedAmount() <= DIRECT_FILE_TRANSFER_LIMITS.DOWNLOAD_CHANNEL_BUFFER_HIGH_WATER_BYTES) return;
  channel.setBufferedAmountLowThreshold(DIRECT_FILE_TRANSFER_LIMITS.DOWNLOAD_CHANNEL_BUFFER_LOW_WATER_BYTES);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('buffer_timeout')), DIRECT_FILE_TRANSFER_LIMITS.NO_PROGRESS_TIMEOUT_MS);
    timer.unref?.();
    channel.onBufferedAmountLow(() => { clearTimeout(timer); resolve(); });
  });
}

async function pumpDownload(transfer: ActiveDirectTransfer): Promise<void> {
  if (transfer.downloadPumping || transfer.settled || !transfer.started || !transfer.channel || !transfer.downloadSource || !transfer.downloadFileHandle) return;
  transfer.downloadPumping = true;
  try {
    while (!transfer.settled && transfer.downloadCredit > 0 && transfer.received < transfer.downloadSource.size) {
      await waitForChannelBuffer(transfer.channel);
      const count = Math.min(
        DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES,
        transfer.downloadCredit,
        transfer.downloadSource.size - transfer.received,
      );
      const buffer = Buffer.allocUnsafe(count);
      const result = await transfer.downloadFileHandle.read(buffer, 0, count, transfer.received);
      if (result.bytesRead <= 0) throw new Error('source_short_read');
      const chunk = buffer.subarray(0, result.bytesRead);
      transfer.channel.sendMessageBinary(new Uint8Array(chunk));
      transfer.downloadCredit -= result.bytesRead;
      transfer.received += result.bytesRead;
      resetTransferIdleTimer(transfer);
    }
    if (!transfer.settled && transfer.downloadSource && transfer.received === transfer.downloadSource.size && !transfer.sourceFinished) {
      transfer.sourceFinished = true;
      await transfer.downloadFileHandle?.close().catch(() => {});
      transfer.downloadFileHandle = null;
      putLedger(transfer.authority, DIRECT_FILE_TRANSFER_OPERATION_STATE.SOURCE_FINISHED_AWAITING_ACK);
      transfer.channel.sendMessage(JSON.stringify({
        type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        ...makeDataBinding(transfer.authority),
        totalBytes: transfer.received,
      }));
      resetTransferIdleTimer(transfer);
    }
  } catch (error) {
    await failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, true, errorDetail(error));
  } finally {
    transfer.downloadPumping = false;
  }
}

async function completeDownload(transfer: ActiveDirectTransfer, totalBytes: number): Promise<void> {
  if (transfer.authority.direction !== DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD || !transfer.sourceFinished
    || !transfer.downloadSource || totalBytes !== transfer.received || totalBytes !== transfer.downloadSource.size) {
    await failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.SIZE_MISMATCH, false);
    return;
  }
  transfer.settled = true;
  directFileMetric('direct_success', {
    direction: transfer.authority.direction,
    attempt: transfer.authority.attempt,
    bytes: transfer.received,
    route: routeMetricClass(transfer.lease),
  });
  putLedger(transfer.authority, DIRECT_FILE_TRANSFER_OPERATION_STATE.COMMITTED, DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED);
  sendControl(transfer.lease, {
    type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    ...makeDataBinding(transfer.authority),
    state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED,
  });
  await closeTransferResources(transfer, false);
}

function attachChannel(transfer: ActiveDirectTransfer, channel: DataChannel, earlyStartMessage?: string | null): void {
  if (!channelMatches(transfer, channel)) {
    try { channel.close(); } catch { /* invalid channel */ }
    return;
  }
  transfer.channel = channel;
  // A channel arriving is progress, so the no-progress window restarts here.
  // It is armed at authorization, before any channel exists, which means the
  // browser's ICE and DTLS work was being charged against a timer meant to
  // measure a stalled transfer. That was harmless while the browser gave up
  // after a few seconds; now that a relayed path is allowed to take longer to
  // open, keep the two independent rather than merely far enough apart.
  resetTransferIdleTimer(transfer);
  const onMessage = (message: string | Buffer | ArrayBuffer) => {
    if (typeof message !== 'string') {
      const bytes = message instanceof ArrayBuffer
        ? new Uint8Array(message)
        : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      enqueueUploadChunk(transfer, bytes);
      return;
    }
    let raw: unknown;
    try { raw = JSON.parse(message); } catch { raw = null; }
    const parsed = validateDirectFileTransferDataMessage(raw);
    if (!parsed.ok || !sameAttempt(transfer.authority, parsed.value as unknown as Record<string, unknown>)) {
      void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false);
      return;
    }
    if (parsed.value.type === DIRECT_FILE_TRANSFER_DATA_MSG.START) {
      if (parsed.value.authority !== transfer.authority.authority || Date.now() >= transfer.authority.authorityExpiresAt) {
        void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false);
      } else if (transfer.authority.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD) {
        void startUpload(transfer, parsed.value.resumeOffset ?? 0)
          .catch((error) => void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, true, errorDetail(error)));
      } else {
        void startDownload(transfer).catch((error) => void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.PREVIEW_POLICY_DENIED, false, errorDetail(error)));
      }
      return;
    }
    if (parsed.value.type === DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT) {
      if (transfer.authority.direction !== DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD || !transfer.started || transfer.sourceFinished) return;
      transfer.downloadCredit = Math.min(
        DIRECT_FILE_TRANSFER_LIMITS.DATA_CREDIT_BYTES,
        transfer.downloadCredit + parsed.value.creditBytes,
      );
      resetTransferIdleTimer(transfer);
      void pumpDownload(transfer);
      return;
    }
    if (parsed.value.type === DIRECT_FILE_TRANSFER_DATA_MSG.FINISH) {
      void finishUpload(transfer, parsed.value.totalBytes, parsed.value.sha256).catch((error) => {
        void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, true, errorDetail(error));
      });
      return;
    }
    if (parsed.value.type === DIRECT_FILE_TRANSFER_DATA_MSG.DOWNLOAD_COMMITTED) {
      void completeDownload(transfer, parsed.value.totalBytes);
    }
  };
  channel.onMessage(onMessage);
  channel.onClosed(() => { if (!transfer.settled) void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED, true, undefined, false); });
  channel.onError((error) => { void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED, true, error); });
  if (earlyStartMessage) onMessage(earlyStartMessage);
}

function attachLeasePeer(lease: DirectLease): void {
  lease.peer.onDataChannel((channel) => {
    const transfer = [...activeAttempts.values()].find((candidate) => candidate.lease === lease && channelMatches(candidate, channel));
    if (!transfer) {
      if (isLeaseHealthChannel(channel)) {
        attachLeaseHealthChannel(lease, channel);
        return;
      }
      if (retainPendingOperationChannel(lease, channel)) return;
      try { channel.close(); } catch { /* unknown channel */ }
      return;
    }
    attachChannel(transfer, channel);
  });
  lease.peer.onLocalDescription((sdp, type) => {
    if (type !== 'answer') return;
    if (!lease.negotiationRequestId) return;
    sendControl(lease, {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: lease.negotiationRequestId,
      serverId: lease.binding.serverId,
      browserTabId: lease.binding.browserTabId,
      leaseId: lease.binding.leaseId,
      leaseGeneration: lease.binding.leaseGeneration,
      daemonGeneration: lease.binding.daemonGeneration,
      sdp,
    });
  });
  lease.peer.onLocalCandidate((candidate, mid) => {
    if (!lease.negotiationRequestId) return;
    sendControl(lease, {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_ICE,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: lease.negotiationRequestId,
      serverId: lease.binding.serverId,
      browserTabId: lease.binding.browserTabId,
      leaseId: lease.binding.leaseId,
      leaseGeneration: lease.binding.leaseGeneration,
      daemonGeneration: lease.binding.daemonGeneration,
      candidate,
      mid,
    });
  });
  lease.peer.onStateChange((state) => {
    if (state !== 'failed' && state !== 'closed' && state !== 'disconnected') return;
    for (const transfer of [...activeAttempts.values()]) {
      if (transfer.lease === lease && !transfer.settled) void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED, true, state);
    }
  });
}

async function prepareLease(command: DirectFileTransferLeasePrepare, sender: WorkerControlSender): Promise<void> {
  if (!rtc) return;
  const key = leaseKey(command.leaseId, command.leaseGeneration);
  const existing = leases.get(key);
  if (existing) {
    // A Server/WebSocket reconnect intentionally advances the *lease control*
    // generation while retaining this daemon's live peer.  Active data
    // channels retain their original, authority-bound generation until they
    // finish: the browser cannot safely switch an in-flight START/CREDIT/
    // FINISH binding before it receives LEASE_REBOUND.  New signalling and
    // status recovery use the fresh lease generation below.
    if (existing.binding.serverId !== command.serverId || existing.binding.browserTabId !== command.browserTabId) return;
    existing.sender = sender;
    existing.expiresAt = command.expiresAt;
    existing.binding.daemonGeneration = command.daemonGeneration;
    existing.binding.expiresAt = command.expiresAt;
    resetLeaseIdleTimer(existing);
    directFileMetric('lease_reuse', { activeAttempts: existing.activeAttempts.size });
    sender.send({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: command.requestId,
      serverId: command.serverId,
      browserTabId: command.browserTabId,
      leaseId: command.leaseId,
      leaseGeneration: command.leaseGeneration,
      daemonGeneration: command.daemonGeneration,
    });
    return;
  }
  const iceServers = toNodeDataChannelIceServers(command.iceServers);
  let peer: PeerConnection;
  try {
    peer = new rtc.PeerConnection(`imcodes-file-lease-${command.leaseId}`, {
      iceServers,
      maxMessageSize: DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES,
    });
  } catch {
    logger.warn({ event: 'direct_file_v2.lease_prepare_failed' }, 'Failed to prepare direct file lease');
    return;
  }
  const lease: DirectLease = {
    binding: {
      serverId: command.serverId,
      browserTabId: command.browserTabId,
      leaseId: command.leaseId,
      leaseGeneration: command.leaseGeneration,
      daemonGeneration: command.daemonGeneration,
      expiresAt: command.expiresAt,
    },
    peer,
    iceServers,
    sender,
    expiresAt: command.expiresAt,
    idleTimer: null,
    remoteDescriptionSet: false,
    pendingRemoteCandidates: [],
    negotiationRequestId: null,
    activeAttempts: new Set(),
    pendingOperationChannels: new Map(),
  };
  leases.set(key, lease);
  directFileMetric('lease_prepared');
  attachLeasePeer(lease);
  resetLeaseIdleTimer(lease);
  sender.send({
    type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    requestId: command.requestId,
    serverId: command.serverId,
    browserTabId: command.browserTabId,
    leaseId: command.leaseId,
    leaseGeneration: command.leaseGeneration,
    daemonGeneration: command.daemonGeneration,
  });
}

/**
 * Refuse an operation the daemon has decided not to run, out loud.
 *
 * Every guard below used to `return` silently. The browser has already been
 * told AUTHORIZED by the server — the server does not wait for the daemon to
 * confirm PREPARE — so it goes on to open a data channel and send START into
 * a daemon that is never going to answer. With nothing coming back, its only
 * way to discover this is to burn its whole connect budget and then fall back,
 * which is precisely the "connecting, 0 bytes, for twenty seconds" report.
 *
 * Refusing explicitly turns that wait into an immediate fallback. It is sent
 * through `sender` rather than `sendControl` because most of these guards fire
 * exactly when there is no lease to send through.
 */
function refuseOperation(
  authority: DirectFileTransferPrepare,
  sender: WorkerControlSender,
  error: DirectFileTransferError,
  retryable: boolean,
): void {
  directFileMetric('attempt_refused', {
    direction: authority.direction,
    attempt: authority.attempt,
    error,
    retryable,
  });
  try {
    sender.send({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.OPERATION,
      ...attemptBinding(authority),
      error,
      retryable,
    });
  } catch { /* control socket already gone; the browser will time out as before */ }
}

async function prepareOperation(authority: DirectFileTransferPrepare, sender: WorkerControlSender): Promise<void> {
  if (!rtc) {
    refuseOperation(authority, sender, DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE, false);
    return;
  }
  if (Date.now() >= authority.authorityExpiresAt) {
    refuseOperation(authority, sender, DIRECT_FILE_TRANSFER_ERROR.AUTHORITY_EXPIRED, false);
    return;
  }
  const lease = leases.get(leaseKey(authority.leaseId, authority.leaseGeneration));
  if (!lease || lease.binding.serverId !== authority.serverId || lease.binding.browserTabId !== authority.browserTabId
    || lease.binding.daemonGeneration !== authority.daemonGeneration) {
    // The daemon evicts an idle lease on its own timer without telling the
    // server, so the server can still hand out authority against one that is
    // gone here. Retryable: re-initialising the lease is exactly the recovery.
    refuseOperation(authority, sender, DIRECT_FILE_TRANSFER_ERROR.STALE_DAEMON_GENERATION, true);
    return;
  }
  lease.sender = sender;
  if (lease.activeAttempts.size >= DIRECT_FILE_TRANSFER_LIMITS.MAX_ACTIVE_CHANNELS_PER_LEASE) {
    refuseOperation(authority, sender, DIRECT_FILE_TRANSFER_ERROR.TOO_MANY_CHANNELS, true);
    return;
  }
  // Duplicate PREPARE for an attempt already running stays silent on purpose:
  // it is an idempotent replay, and answering it with an error would terminate
  // the live attempt it duplicates.
  if (activeAttempts.has(authority.attemptId)) return;
  directFileMetric('attempt_started', { direction: authority.direction, attempt: authority.attempt });
  if (authority.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD) {
    const existing = await lookupAttachmentByClientUploadId(authority.clientUploadId);
    if (existing) {
      putLedger(authority, DIRECT_FILE_TRANSFER_OPERATION_STATE.COMMITTED, DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED, existing);
      sendControl(lease, {
        type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        ...attemptBinding(authority),
        state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED,
        attachment: existing,
      });
      return;
    }
  }
  // Claimed through the host so a direct upload and a relay upload of the same
  // client upload id are serialized against ONE authority, not two per-isolate
  // copies that would both succeed.
  const uploadClaim = authority.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD
    ? await tryClaimClientUpload(authority.operationId).catch(() => null)
    : null;
  const transfer: ActiveDirectTransfer = {
    authority,
    lease,
    channel: null,
    uploadFileHandle: null,
    downloadFileHandle: null,
    partPath: null,
    finalPath: null,
    finalFilename: null,
    uploadClaim,
    received: 0,
    committedReported: 0,
    pendingBytes: 0,
    downloadCredit: 0,
    downloadSource: null,
    downloadPumping: false,
    hash: createHash('sha256'),
    writeChain: Promise.resolve(),
    started: false,
    sourceFinished: false,
    settled: false,
    idleTimer: null,
  };
  if (authority.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD && !transfer.uploadClaim) {
    // Another attempt for this same clientUploadId still owns the claim — and
    // clientUploadId is constant across all retries of one upload, so a leaked
    // claim silently no-ops every retry. Say so instead: the browser exhausts
    // its retries in milliseconds and takes HTTP.
    refuseOperation(authority, sender, DIRECT_FILE_TRANSFER_ERROR.STALE_ATTEMPT, true);
    return;
  }
  activeAttempts.set(authority.attemptId, transfer);
  lease.activeAttempts.add(authority.attemptId);
  resetLeaseIdleTimer(lease);
  resetTransferIdleTimer(transfer);
  const pendingChannel = takePendingOperationChannel(lease, authority.channelLabel);
  if (pendingChannel) attachChannel(transfer, pendingChannel.channel, pendingChannel.startMessage);
}

function findActive(command: { attemptId: string; authority: string }): ActiveDirectTransfer | undefined {
  const transfer = activeAttempts.get(command.attemptId);
  if (!transfer || transfer.authority.authority !== command.authority || !sameAttempt(transfer.authority, command as unknown as Record<string, unknown>)) return undefined;
  return transfer;
}

function findLeaseForSignal(command: DirectFileTransferLeaseOffer | DirectFileTransferLeaseIce): DirectLease | undefined {
  const lease = leases.get(leaseKey(command.leaseId, command.leaseGeneration));
  if (!lease
    || lease.binding.serverId !== command.serverId
    || lease.binding.browserTabId !== command.browserTabId
    || lease.binding.daemonGeneration !== command.daemonGeneration) return undefined;
  return lease;
}

/**
 * A browser refresh loses its RTCPeerConnection but intentionally retains the
 * tab id and lease ticket.  The next offer therefore belongs to the same
 * lease, not to the daemon's old peer.  Recreate the inert peer before
 * accepting it; never do this while a file channel is active.
 */
function replaceInactiveLeasePeer(lease: DirectLease): boolean {
  if (!rtc || lease.activeAttempts.size > 0) return false;
  let peer: PeerConnection;
  try {
    peer = new rtc.PeerConnection(`imcodes-file-lease-${lease.binding.leaseId}`, {
      iceServers: lease.iceServers,
      maxMessageSize: DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES,
    });
  } catch {
    return false;
  }
  const previous = lease.peer;
  for (const pending of lease.pendingOperationChannels.values()) {
    clearTimeout(pending.timer);
    try { pending.channel.close(); } catch { /* already closed */ }
  }
  lease.pendingOperationChannels.clear();
  lease.peer = peer;
  lease.remoteDescriptionSet = false;
  lease.negotiationRequestId = null;
  attachLeasePeer(lease);
  try { previous.close(); } catch { /* already closed */ }
  return true;
}

function sendLeaseSignalFailure(lease: DirectLease, requestId: string): void {
  sendControl(lease, {
    type: DIRECT_FILE_TRANSFER_MSG.ERROR,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.LEASE,
    requestId,
    error: DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
    retryable: true,
  });
}

async function receiveLeaseOffer(command: DirectFileTransferLeaseOffer): Promise<void> {
  const lease = findLeaseForSignal(command);
  if (!lease) return;
  if (lease.remoteDescriptionSet && lease.negotiationRequestId === command.requestId) return;
  if (lease.negotiationRequestId !== null && lease.negotiationRequestId !== command.requestId
    && !replaceInactiveLeasePeer(lease)) {
    // An active file channel cannot be silently replaced. Let the browser
    // retry after its authoritative operation outcome instead of stranding it
    // behind an 8-second answer timeout.
    sendLeaseSignalFailure(lease, command.requestId);
    return;
  }
  try {
    lease.negotiationRequestId = command.requestId;
    lease.peer.setRemoteDescription(command.sdp, 'offer');
    lease.remoteDescriptionSet = true;
    const pending = lease.pendingRemoteCandidates.splice(0)
      .filter((candidate) => candidate.requestId === command.requestId);
    for (const candidate of pending) {
      lease.peer.addRemoteCandidate(candidate.candidate, candidate.mid);
    }
  } catch {
    lease.remoteDescriptionSet = false;
    logger.warn({ event: 'direct_file_v2.lease_offer_failed' }, 'Failed to accept direct file lease offer');
    sendLeaseSignalFailure(lease, command.requestId);
  }
}

async function receiveLeaseIce(command: DirectFileTransferLeaseIce): Promise<void> {
  const lease = findLeaseForSignal(command);
  if (!lease) return;
  try {
    if (!lease.remoteDescriptionSet || lease.negotiationRequestId !== command.requestId) {
      // setLocalDescription() can emit a trickle candidate before the browser
      // has posted its matching offer. Preserve it for that request, but keep
      // the queue bounded and discard every nonmatching request at offer time.
      if (lease.pendingRemoteCandidates.length < DIRECT_FILE_TRANSFER_LIMITS.PENDING_ICE_CANDIDATE_LIMIT) {
        lease.pendingRemoteCandidates.push({ requestId: command.requestId, candidate: command.candidate, mid: command.mid });
      }
      return;
    }
    lease.peer.addRemoteCandidate(command.candidate, command.mid);
  } catch {
    logger.warn({ event: 'direct_file_v2.lease_ice_failed' }, 'Failed to add direct file lease ICE candidate');
  }
}

export async function handleDirectFileTransferCommand(message: unknown, sender: WorkerControlSender): Promise<boolean> {
  const parsed = validateDirectFileTransferDaemonCommand(message);
  if (!parsed.ok) return false;
  const command = parsed.value;
  if (command.type === DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE) {
    await prepareLease(command, sender);
    return true;
  }
  if (command.type === DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND) {
    const lease = leases.get(leaseKey(command.leaseId, command.leaseGeneration));
    if (lease) lease.sender = sender;
    return true;
  }
  if (command.type === DIRECT_FILE_TRANSFER_MSG.PREPARE) {
    await prepareOperation(command, sender);
    return true;
  }
  if (command.type === DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY) {
    const lease = leases.get(leaseKey(command.leaseId, command.leaseGeneration));
    if (!lease || lease.binding.serverId !== command.serverId || lease.binding.browserTabId !== command.browserTabId
      || lease.binding.daemonGeneration !== command.daemonGeneration) return true;
    lease.sender = sender;
    const ledger = findLedger(command);
    directFileMetric('status_recovery', {
      direction: command.direction,
      attempt: command.attempt,
      state: ledger?.state ?? DIRECT_FILE_TRANSFER_OPERATION_STATE.ATTEMPTING,
    });
    const {
      type: _type,
      protocolVersion: _protocolVersion,
      ...binding
    } = command;
    sendControl(lease, {
      type: DIRECT_FILE_TRANSFER_MSG.STATUS,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      // Status recovery is bound by the exact scope/operation tuple rather
      // than a consumed single-use authority.
      ...binding,
      state: ledger?.state ?? DIRECT_FILE_TRANSFER_OPERATION_STATE.ATTEMPTING,
      ...(ledger?.attachment ? { attachment: ledger.attachment } : {}),
    });
    return true;
  }
  if (command.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER) {
    await receiveLeaseOffer(command);
    return true;
  }
  if (command.type === DIRECT_FILE_TRANSFER_MSG.LEASE_ICE) {
    await receiveLeaseIce(command);
    return true;
  }
  const transfer = findActive(command);
  if (!transfer) return true;
  if (command.type === DIRECT_FILE_TRANSFER_MSG.CANCEL) {
    await failTransfer(transfer, command.reason, false);
    return true;
  }
  return true;
}

export async function shutdownDirectFileTransfers(): Promise<void> {
  const current = [...leases.values()];
  await Promise.all(current.map((lease) => closeLease(lease, true)));
  recentOperations.clear();
  // Exactly once, and `rtc === null` is what guarantees it. Quiesce clears the
  // reference before draining and keeps a local one, so a later SIGTERM sees
  // null and cannot re-enter a possibly-replaced mapping. A second concurrent
  // shutdown cannot slip through either: the tail after the await is
  // synchronous, so whichever resumes first clears the reference before the
  // other observes it. A separate "cleanup done" latch was tried here and
  // removed — it was provably redundant, and its only effect was to look
  // load-bearing while no test could distinguish it.
  const pending = rtc ?? (nativeQuiesceCompleted ? null : quiescedNativeRef);
  if (pending) {
    try { pending.cleanup(); } catch { /* native runtime already cleaned */ }
    nativeQuiesceCompleted = true;
  }
  quiescedNativeRef = null;
  rtc = null;
  nativeAdmissionClosed = true;
}

/**
 * Quiesce the native transport BEFORE anything may replace its files on disk.
 *
 * WHY THIS EXISTS — the upgrade SIGBUS.
 *
 * A detached upgrade replaces the global package, and therefore
 * node_datachannel.node, IN PLACE while this process still has the addon
 * mapped. The daemon then restarts and its shutdown path finally runs the
 * direct-transfer cleanup — by which time the pages behind that live mapping
 * belong to a different file, so the first call back into the addon faults.
 * Both production crashes landed at the same relative offset with addr2line
 * resolving inside rtc::Description::Media::RtpMap's copy constructor.
 *
 * The invariant is NOT "do not re-import after quiesce": `import()` is
 * ESM-cached, so a re-import would hand back the same module pointing at the
 * replaced mapping, and a guard built on re-import would fix nothing. The
 * invariant is that once the file may have been replaced, NOTHING may enter
 * the addon again.
 *
 * Ordering matters and is deliberate: `rtc` is cleared FIRST and
 * synchronously. Every admission gate in this module is `if (!rtc)`, so that
 * single assignment closes new leases and new PeerConnections immediately —
 * before draining begins, rather than after it finishes. The local reference
 * is what keeps `cleanup()` reachable exactly once, while the file is still
 * the original one.
 *
 * A caller that gets `ok: false` MUST NOT replace anything. Admission stays
 * closed, so the daemon keeps running with direct transfer degraded to relay
 * rather than risking a fault.
 *
 * @param timeoutMs bound on draining. This is a deadline for reporting
 *   failure, never a substitute for the acknowledgement itself.
 */
export async function quiesceDirectFileTransferNative(
  timeoutMs = DIRECT_FILE_TRANSFER_NATIVE_QUIESCE_TIMEOUT_MS,
): Promise<{ ok: boolean; reason?: string; closedLeases: number }> {
  // Only a COMPLETED quiesce is standing authority. Admission closure is not:
  // a first attempt whose drain timed out leaves admission shut with leases
  // still live, and inheriting that flag would authorize replacement without
  // ever proving the addon is idle.
  if (nativeQuiesceCompleted) return { ok: true, closedLeases: 0 };
  // Concurrent callers must observe the REAL outcome, not a second half-run.
  if (inFlightNativeQuiesce) return inFlightNativeQuiesce;
  const run = (async () => {
    if (rtc) {
      // Close admission first, synchronously, so nothing is admitted mid-drain.
      quiescedNativeRef = rtc;
      rtc = null;
    }
    nativeAdmissionClosed = true;
    if (!inFlightNativeDrain) {
      const current = [...leases.values()];
      inFlightNativeDrainLeases = current.length;
      // Started once and retained. A later attempt awaits this same promise
      // rather than re-snapshotting a map the first attempt has already emptied.
      inFlightNativeDrain = Promise.all(current.map((lease) => closeLease(lease, true)))
        .then(() => undefined);
    }
    const drain = inFlightNativeDrain;
    const current = { length: inFlightNativeDrainLeases };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        drain,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('quiesce_drain_timeout')), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      // Peers may still be live, so the addon must NOT be cleaned up here and
      // the caller must not replace it either. A later attempt re-drains.
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'quiesce_drain_failed',
        closedLeases: 0,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
    recentOperations.clear();
    if (quiescedNativeRef) {
      try {
        quiescedNativeRef.cleanup();
      } catch (error) {
        // Fail CLOSED. A cleanup that threw leaves the old mapping potentially
        // callable, so replacing the file underneath it is exactly the fault
        // this exists to prevent. Not completed, so a retry runs again.
        return {
          ok: false,
          reason: error instanceof Error ? `native_cleanup_failed: ${error.message}` : 'native_cleanup_failed',
          closedLeases: 0,
        };
      }
      quiescedNativeRef = null;
    }
    nativeQuiesceCompleted = true;
    logger.info({ event: 'direct_file_v2.native_quiesced', closedLeases: current.length }, 'Direct file transfer native runtime quiesced');
    return { ok: true, closedLeases: current.length };
  })();
  inFlightNativeQuiesce = run;
  try {
    return await run;
  } finally {
    inFlightNativeQuiesce = null;
  }
}

/**
 * Test seam: a PRODUCTION-SHAPED lease whose close blocks exactly where the
 * real one does — after `leases.delete`, inside closeTransferResources awaiting
 * `transfer.writeChain`, and therefore before the native `channel.close()` and
 * `lease.peer.close()` calls that follow it.
 *
 * The previous fixture was a bare cast with no `binding`, so production
 * closeLease threw on the first dereference and the drain rejected before it
 * ever removed the lease. Both quiesce calls then returned false for a fixture
 * TypeError rather than for the property under test — a false green.
 *
 * `nativeCallsAfterDrain` counts the addon entries that happen after the block
 * is released, which is the hazard: they must never run after a cleanup that a
 * retry authorized.
 */
export function __installBlockedLeaseForTests(): {
  release: () => void;
  nativeCallsAfterDrain: () => number;
} | null {
  if (process.env.NODE_ENV !== 'test') return null;
  let releaseWrite: (() => void) | undefined;
  let nativeCalls = 0;
  const writeChain = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const binding = {
    serverId: 'seam-server', browserTabId: 'seam-tab', leaseId: 'seam-lease',
    leaseGeneration: 1, daemonGeneration: 1, requestId: 'seam-request',
    expiresAt: Date.now() + 60_000,
  };
  const lease = {
    binding,
    sender: { send: () => {} },
    peer: { close: () => { nativeCalls += 1; } },
    activeAttempts: new Map(),
    pendingOperationChannels: new Map(),
    idleTimer: null,
    iceServers: [],
    controlEpoch: 0,
    terminalGrace: new Map(),
  } as unknown as DirectLease;
  const transfer = {
    lease,
    settled: false,
    received: 0,
    writeChain,
    idleTimer: null,
    uploadFileHandle: null,
    downloadFileHandle: null,
    partPath: null,
    finalPath: null,
    channel: { close: () => { nativeCalls += 1; }, getLabel: () => 'seam-channel' },
    authority: {
      ...binding, attemptId: 'seam-attempt', attempt: 1, operationId: 'seam-operation',
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD, clientUploadId: 'seam-upload',
      filename: 'seam.bin', size: 1, authority: 'seam', authorityExpiresAt: Date.now() + 60_000,
      channelLabel: 'seam-channel',
    },
  } as unknown as ActiveDirectTransfer;
  leases.set(leaseKey(binding.leaseId, binding.leaseGeneration), lease);
  activeAttempts.set('seam-attempt', transfer);
  return {
    release: () => releaseWrite?.(),
    nativeCallsAfterDrain: () => nativeCalls,
  };
}

/** Whether new peers/leases are refused because the addon was quiesced. */
export function isDirectTransferNativeQuiesced(): boolean {
  return nativeAdmissionClosed;
}

/* ------------------------------------------------------------------------- *
 * Worker dispatch.
 *
 * Everything above this line is the transfer state machine, unchanged by the
 * move: RTC/ICE/DataChannel callbacks, no-progress and lease timers, sha256
 * hashing and all file reads/writes execute here, on the worker's own event
 * loop. A stalled daemon loop therefore cannot delay them.
 *
 * Only control envelopes cross back. File bytes never do.
 * ------------------------------------------------------------------------- */

async function handleWorkerEnvelope(raw: unknown): Promise<void> {
  const envelope = validateDirectFileTransferWorkerEnvelope(raw);
  // Fail closed: an envelope that is not exactly well-formed, or that is
  // addressed to a different worker generation, is dropped rather than coerced.
  if (!envelope || envelope.generation !== activeWorkerGeneration) return;

  if (envelope.type === DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_RESULT) {
    settleHostCall(envelope.callId, envelope.ok, envelope.value, envelope.error);
    return;
  }

  if (envelope.type === DIRECT_FILE_TRANSFER_WORKER_MSG.COMMAND) {
    // The command is re-validated by the transfer state machine itself, so a
    // malformed payload cannot reach lease or attempt authority through IPC.
    await handleDirectFileTransferCommand(envelope.command, senderFor(envelope.senderId));
    return;
  }

  if (envelope.type === DIRECT_FILE_TRANSFER_WORKER_MSG.STATUS_REQUEST) {
    const status = getDirectConnectivityRuntimeStatus();
    post({
      type: DIRECT_FILE_TRANSFER_WORKER_MSG.STATUS_REPLY,
      available: isDirectFileTransferAvailable(),
      ...(status.error ? { detail: String(status.error) } : {}),
    });
    return;
  }

  if (envelope.type === DIRECT_FILE_TRANSFER_WORKER_MSG.QUIESCE) {
    // The answer is produced here because only this isolate holds the mapping.
    // Whatever it is — drained, timed out, cleanup threw — it goes back as the
    // real outcome; the proxy is not allowed to guess on our behalf.
    const result = await quiesceDirectFileTransferNative(envelope.timeoutMs);
    post({
      type: DIRECT_FILE_TRANSFER_WORKER_MSG.QUIESCE_RESULT,
      ok: result.ok,
      closedLeases: result.closedLeases,
      ...(result.reason ? { reason: result.reason } : {}),
    });
    return;
  }

  if (envelope.type === DIRECT_FILE_TRANSFER_WORKER_MSG.SHUTDOWN) {
    // Idempotent: closing an already-closed set of leases is a no-op, so a
    // repeated or duplicated shutdown cannot corrupt state or double-ack.
    let cleanupOk = true;
    let detail: string | undefined;
    try {
      await shutdownDirectFileTransfers();
    } catch (error) {
      // Report the failure instead of swallowing it. Leases or partial uploads
      // may still be held, so the host must not treat this as a safe quiesce.
      cleanupOk = false;
      detail = String(error instanceof Error ? error.message : error).slice(0, 512);
      logger.warn({ err: error, event: 'direct_file_v2.worker_shutdown_error' }, 'worker shutdown cleanup failed');
    } finally {
      // In-flight host calls are rejected either way: a cleanup failure must not
      // also leave the host holding promises that can never settle.
      rejectAllHostCalls('direct_file_transfer_worker_shutdown');
    }
    post({
      type: DIRECT_FILE_TRANSFER_WORKER_MSG.SHUTDOWN_ACK,
      cleanupOk,
      ...(detail ? { detail } : {}),
    });
  }
}

/**
 * In-process transport seam for integration tests whose value is the complete
 * browser↔daemon transfer protocol, not worker-thread isolation. Vite runs
 * those tests under jsdom and cannot carry its mocked native DataChannel
 * implementation into a new Node isolate. Production never calls this seam;
 * the real-worker stall proof continues to exercise the actual thread.
 */
export async function __startDirectFileTransferWorkerInProcessForTests(
  generation: number,
  emit: (envelope: Record<string, unknown>) => void,
): Promise<void> {
  if (process.env.NODE_ENV !== 'test') throw new Error('test-only direct transfer worker seam');
  activeWorkerGeneration = generation;
  inProcessPost = emit;
  await initializeDirectFileTransfer().catch(() => false);
  const status = getDirectConnectivityRuntimeStatus();
  post({
    type: DIRECT_FILE_TRANSFER_WORKER_MSG.STATUS_REPLY,
    available: isDirectFileTransferAvailable(),
    ...(status.error ? { detail: String(status.error) } : {}),
  });
  post({ type: DIRECT_FILE_TRANSFER_WORKER_MSG.READY });
  void recoverInterruptedUploadCommits().catch(() => {});
}

export async function __dispatchDirectFileTransferWorkerInProcessForTests(raw: unknown): Promise<void> {
  if (process.env.NODE_ENV !== 'test') throw new Error('test-only direct transfer worker seam');
  await handleWorkerEnvelope(raw);
}

if (directWorkerPort) {
  directWorkerPort.on('message', (raw: unknown) => {
    void handleWorkerEnvelope(raw).catch((error: unknown) => {
      // A thrown handler must never take the worker down silently: the parent
      // would see an opaque exit and fail every in-flight lease.
      logger.warn({ err: error, event: 'direct_file_v2.worker_dispatch_error' }, 'worker dispatch failed');
    });
  });
  void initializeDirectFileTransfer()
    .catch(() => false)
    .then(() => {
      // Availability is declared BEFORE ready. The parent resolves its boot
      // promise on READY, so publishing status first means a caller that awaits
      // initialization never observes a stale "unavailable" projection.
      const status = getDirectConnectivityRuntimeStatus();
      post({
        type: DIRECT_FILE_TRANSFER_WORKER_MSG.STATUS_REPLY,
        available: isDirectFileTransferAvailable(),
        ...(status.error ? { detail: String(status.error) } : {}),
      });
      post({ type: DIRECT_FILE_TRANSFER_WORKER_MSG.READY });
      // After READY on purpose. Replay needs the host RPC, and `callHost` has no
      // deadline, so awaiting it before READY would let an unresponsive host
      // wedge worker startup. Recovery is independent of live traffic.
      void recoverInterruptedUploadCommits().catch((error: unknown) => {
        logger.warn(
          { err: error, event: 'direct_file_v2.commit_recovery_failed' },
          'Upload commit recovery sweep failed',
        );
      });
    });
}
