import { createHash, randomBytes } from 'node:crypto';
import { open, readdir, stat, statfs, unlink, rename } from 'node:fs/promises';
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
  finalizeDirectUploadedFile,
  initFileTransfer,
  lookupAttachmentByClientUploadId,
  releaseClientUploadClaim,
  resolveDirectFileDownloadSource,
  resolveUploadPath,
  tryClaimClientUpload,
  type DirectFileDownloadSource,
  type FileTransferSender,
} from './file-transfer-handler.js';

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
  sender: FileTransferSender;
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
  uploadClaim: symbol | null;
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

/** Drop resume state and its partial file. Only for terminal outcomes. */
async function discardUploadResumeState(operationId: string): Promise<void> {
  const state = uploadResumeStates.get(operationId);
  if (!state) return;
  uploadResumeStates.delete(operationId);
  await unlink(state.partPath).catch(() => {});
}



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
    }
  }
  activeAttempts.delete(transfer.authority.attemptId);
  transfer.lease.activeAttempts.delete(transfer.authority.attemptId);
  if (transfer.uploadClaim) releaseClientUploadClaim(transfer.authority.operationId, transfer.uploadClaim);
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
  const existing = lookupAttachmentByClientUploadId(authority.clientUploadId);
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
  await initFileTransfer();
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
  const digest = transfer.hash.digest('hex');
  if ((sha256 ?? authority.sha256) && digest !== (sha256 ?? authority.sha256)) {
    await failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.CHECKSUM_MISMATCH, false);
    return;
  }
  await transfer.uploadFileHandle.sync();
  await transfer.uploadFileHandle.close();
  transfer.uploadFileHandle = null;
  await rename(transfer.partPath, transfer.finalPath);
  // Committed: the partial no longer exists, so neither should the resume state.
  uploadResumeStates.delete(transfer.authority.operationId);
  const attachment = await finalizeDirectUploadedFile({
    clientUploadId: authority.clientUploadId,
    filename: transfer.finalFilename,
    originalName: authority.filename,
    mime: authority.mime,
    resolved: transfer.finalPath,
    size: transfer.received,
    ...(authority.destinationDirectory ? { destinationDirectory: authority.destinationDirectory } : {}),
  });
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

async function prepareLease(command: DirectFileTransferLeasePrepare, sender: FileTransferSender): Promise<void> {
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
  sender: FileTransferSender,
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

async function prepareOperation(authority: DirectFileTransferPrepare, sender: FileTransferSender): Promise<void> {
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
    const existing = lookupAttachmentByClientUploadId(authority.clientUploadId);
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
  const transfer: ActiveDirectTransfer = {
    authority,
    lease,
    channel: null,
    uploadFileHandle: null,
    downloadFileHandle: null,
    partPath: null,
    finalPath: null,
    finalFilename: null,
    uploadClaim: authority.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD ? tryClaimClientUpload(authority.operationId) : null,
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

export async function handleDirectFileTransferCommand(message: unknown, sender: FileTransferSender): Promise<boolean> {
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
  if (rtc) {
    try { rtc.cleanup(); } catch { /* native runtime already cleaned */ }
  }
  rtc = null;
}
