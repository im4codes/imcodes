import { createHash } from 'node:crypto';
import { open, statfs, unlink, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import logger from '../util/logger.js';
import {
  DIRECT_CONNECTIVITY_RUNTIME_ERROR,
  DIRECT_CONNECTIVITY_RUNTIME_STATE,
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_DIRECTION,
  DIRECT_FILE_TRANSFER_ERROR,
  DIRECT_FILE_TRANSFER_ERROR_SCOPE,
  DIRECT_FILE_TRANSFER_LEASE_CAPABILITY,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
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

interface DirectLease {
  binding: Omit<DirectFileTransferLeasePrepare, 'type' | 'protocolVersion' | 'requestId' | 'iceServers'>;
  peer: PeerConnection;
  sender: FileTransferSender;
  expiresAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  remoteDescriptionSet: boolean;
  pendingRemoteCandidates: Array<{ candidate: string; mid: string }>;
  negotiationRequestId: string | null;
  activeAttempts: Set<string>;
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
  return value.serverId === authority.serverId
    && value.browserTabId === authority.browserTabId
    && value.leaseId === authority.leaseId
    && value.leaseGeneration === authority.leaseGeneration
    && value.daemonGeneration === authority.daemonGeneration
    && value.requestId === authority.requestId
    && value.attemptId === authority.attemptId
    && value.attempt === authority.attempt
    && value.direction === authority.direction
    && value.operationId === authority.operationId;
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
  if (removePart && transfer.partPath) await unlink(transfer.partPath).catch(() => {});
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
    await Promise.all(transfers.map((transfer) => failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED, true)));
  }
  try { lease.peer.close(); } catch { /* already closed */ }
}

async function failTransfer(
  transfer: ActiveDirectTransfer,
  error: DirectFileTransferError,
  retryable: boolean,
  detail?: string,
): Promise<void> {
  if (transfer.settled) return;
  transfer.settled = true;
  directFileMetric(
    error === DIRECT_FILE_TRANSFER_ERROR.CANCELED ? 'canceled' : 'attempt_failed',
    {
      direction: transfer.authority.direction,
      attempt: transfer.authority.attempt,
      retryable,
      bytes: transfer.received,
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
  await closeTransferResources(transfer, true);
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
  try { return channel.getLabel().startsWith('imcodes-health-'); } catch { return false; }
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

async function startUpload(transfer: ActiveDirectTransfer): Promise<void> {
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
  const filename = createDirectUploadFilename(authority.filename);
  const finalPath = resolveUploadPath(filename);
  await ensureDiskCapacity(authority.size, finalPath);
  transfer.partPath = `${finalPath}.${authority.attemptId}.part`;
  transfer.finalPath = finalPath;
  transfer.finalFilename = filename;
  transfer.uploadFileHandle = await open(transfer.partPath, 'wx');
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
  const attachment = await finalizeDirectUploadedFile({
    clientUploadId: authority.clientUploadId,
    filename: transfer.finalFilename,
    originalName: authority.filename,
    mime: authority.mime,
    resolved: transfer.finalPath,
    size: transfer.received,
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
  if (channel.bufferedAmount() <= DIRECT_FILE_TRANSFER_LIMITS.DATA_BUFFER_HIGH_WATER_BYTES) return;
  channel.setBufferedAmountLowThreshold(DIRECT_FILE_TRANSFER_LIMITS.DATA_BUFFER_LOW_WATER_BYTES);
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

function attachChannel(transfer: ActiveDirectTransfer, channel: DataChannel): void {
  if (!channelMatches(transfer, channel)) {
    try { channel.close(); } catch { /* invalid channel */ }
    return;
  }
  transfer.channel = channel;
  channel.onMessage((message) => {
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
        void startUpload(transfer).catch((error) => void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, true, errorDetail(error)));
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
  });
  channel.onClosed(() => { if (!transfer.settled) void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED, true); });
  channel.onError((error) => { void failTransfer(transfer, DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED, true, error); });
}

function attachLeasePeer(lease: DirectLease): void {
  lease.peer.onDataChannel((channel) => {
    const transfer = [...activeAttempts.values()].find((candidate) => candidate.lease === lease && channelMatches(candidate, channel));
    if (!transfer) {
      if (isLeaseHealthChannel(channel)) {
        attachLeaseHealthChannel(lease, channel);
        return;
      }
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
  let peer: PeerConnection;
  try {
    peer = new rtc.PeerConnection(`imcodes-file-lease-${command.leaseId}`, {
      iceServers: toNodeDataChannelIceServers(command.iceServers),
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
    sender,
    expiresAt: command.expiresAt,
    idleTimer: null,
    remoteDescriptionSet: false,
    pendingRemoteCandidates: [],
    negotiationRequestId: null,
    activeAttempts: new Set(),
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

async function prepareOperation(authority: DirectFileTransferPrepare, sender: FileTransferSender): Promise<void> {
  if (!rtc) return;
  if (Date.now() >= authority.authorityExpiresAt) return;
  const lease = leases.get(leaseKey(authority.leaseId, authority.leaseGeneration));
  if (!lease || lease.binding.serverId !== authority.serverId || lease.binding.browserTabId !== authority.browserTabId
    || lease.binding.daemonGeneration !== authority.daemonGeneration) return;
  lease.sender = sender;
  if (lease.activeAttempts.size >= DIRECT_FILE_TRANSFER_LIMITS.MAX_ACTIVE_CHANNELS_PER_LEASE) return;
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
  if (authority.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD && !transfer.uploadClaim) return;
  activeAttempts.set(authority.attemptId, transfer);
  lease.activeAttempts.add(authority.attemptId);
  resetLeaseIdleTimer(lease);
  resetTransferIdleTimer(transfer);
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

async function receiveLeaseOffer(command: DirectFileTransferLeaseOffer): Promise<void> {
  const lease = findLeaseForSignal(command);
  if (!lease) return;
  try {
    lease.negotiationRequestId = command.requestId;
    lease.peer.setRemoteDescription(command.sdp, 'offer');
    lease.remoteDescriptionSet = true;
    for (const candidate of lease.pendingRemoteCandidates.splice(0)) {
      lease.peer.addRemoteCandidate(candidate.candidate, candidate.mid);
    }
  } catch {
    logger.warn({ event: 'direct_file_v2.lease_offer_failed' }, 'Failed to accept direct file lease offer');
  }
}

async function receiveLeaseIce(command: DirectFileTransferLeaseIce): Promise<void> {
  const lease = findLeaseForSignal(command);
  if (!lease) return;
  try {
    if (!lease.remoteDescriptionSet) lease.pendingRemoteCandidates.push({ candidate: command.candidate, mid: command.mid });
    else lease.peer.addRemoteCandidate(command.candidate, command.mid);
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
