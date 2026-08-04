import { createHash } from 'node:crypto';
import { open, statfs, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import logger from '../util/logger.js';
import {
  DIRECT_CONNECTIVITY_RUNTIME_ERROR,
  DIRECT_CONNECTIVITY_RUNTIME_STATE,
  DIRECT_FILE_TRANSFER_CAPABILITY,
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_ERROR,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PURPOSE,
  DIRECT_FILE_TRANSFER_STATE,
  validateDirectFileTransferDaemonCommand,
  validateDirectFileTransferDataMessage,
  type DirectFileTransferDaemonCommand,
  type DirectFileTransferError,
  type DirectFileTransferIceServerConfig,
  type DirectFileTransferPrepare,
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
  resolveUploadPath,
  tryClaimClientUpload,
  type FileTransferSender,
} from './file-transfer-handler.js';

type NodeDataChannel = typeof import('node-datachannel');
type PeerConnection = import('node-datachannel').PeerConnection;
type DataChannel = import('node-datachannel').DataChannel;
type NodeDataChannelIceServer = string | import('node-datachannel').IceServer;

interface ActiveDirectTransfer {
  authority: DirectFileTransferPrepare;
  peer: PeerConnection;
  channel: DataChannel | null;
  fileHandle: FileHandle | null;
  partPath: string | null;
  finalPath: string | null;
  finalFilename: string | null;
  received: number;
  pendingBytes: number;
  hash: ReturnType<typeof createHash>;
  writeChain: Promise<void>;
  started: boolean;
  settled: boolean;
  lastProgressAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  remoteDescriptionSet: boolean;
  pendingRemoteCandidates: Array<{ candidate: string; mid: string }>;
  uploadClaim: symbol | null;
}

let rtc: NodeDataChannel | null = null;
let loadAttempted = false;
let rtcLoadError: DirectConnectivityRuntimeError | undefined;
const active = new Map<string, ActiveDirectTransfer>();

const TURN_URL_RE = /^(turn|turns):(\[[^\]]+\]|[^:?]+)(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/i;

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
      if (!match || !entry.username || !entry.credential) {
        throw new Error('Invalid authenticated TURN server configuration');
      }
      const secure = match[1].toLowerCase() === 'turns';
      const port = Number(match[3] ?? (secure ? 5349 : 3478));
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error('Invalid TURN server port');
      }
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
    rtc.initLogger('Warning', (_level, message) => logger.debug({ message }, 'node-datachannel'));
    rtcLoadError = undefined;
    logger.info({ capability: DIRECT_FILE_TRANSFER_CAPABILITY }, 'Direct file transfer available');
  } catch (error) {
    rtc = null;
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    rtcLoadError = detail.includes('node_datachannel.node') || detail.includes('MODULE_NOT_FOUND')
      ? DIRECT_CONNECTIVITY_RUNTIME_ERROR.NATIVE_MODULE_MISSING
      : DIRECT_CONNECTIVITY_RUNTIME_ERROR.LOAD_FAILED;
    logger.info({ error }, 'Direct file transfer unavailable; relay upload remains enabled');
  }
  return rtc !== null;
}

export function isDirectFileTransferAvailable(): boolean {
  return rtc !== null;
}

export function getDirectConnectivityRuntimeStatus(): DirectConnectivityRuntimeStatus {
  return rtc
    ? { state: DIRECT_CONNECTIVITY_RUNTIME_STATE.AVAILABLE }
    : {
        state: DIRECT_CONNECTIVITY_RUNTIME_STATE.RUNTIME_UNAVAILABLE,
        ...(rtcLoadError ? { error: rtcLoadError } : {}),
      };
}

function sendError(
  sender: FileTransferSender,
  requestId: string,
  capability: string | undefined,
  error: DirectFileTransferError,
  retryable: boolean,
  detail?: string,
): void {
  sender.send({
    type: DIRECT_FILE_TRANSFER_MSG.ERROR,
    requestId,
    ...(capability ? { capability } : {}),
    error,
    retryable,
    ...(detail ? { detail: detail.slice(0, DIRECT_FILE_TRANSFER_LIMITS.ERROR_DETAIL_BYTES) } : {}),
  });
}

function sendStatus(sender: FileTransferSender, authority: DirectFileTransferPrepare, state: string, attachment?: AttachmentRef): void {
  sender.send({
    type: DIRECT_FILE_TRANSFER_MSG.STATUS,
    requestId: authority.requestId,
    capability: authority.capability,
    clientUploadId: authority.clientUploadId,
    state,
    ...(attachment ? { attachment } : {}),
  });
}

function resetIdleTimer(transfer: ActiveDirectTransfer, sender: FileTransferSender): void {
  if (transfer.idleTimer) clearTimeout(transfer.idleTimer);
  transfer.idleTimer = setTimeout(() => {
    void failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED, true, 'Direct transfer timed out');
  }, DIRECT_FILE_TRANSFER_LIMITS.IDLE_TIMEOUT_MS);
  transfer.idleTimer.unref?.();
}

async function closeTransferResources(transfer: ActiveDirectTransfer, removePart: boolean): Promise<void> {
  if (transfer.idleTimer) clearTimeout(transfer.idleTimer);
  transfer.idleTimer = null;
  try { transfer.channel?.close(); } catch { /* already closed */ }
  try { transfer.peer.close(); } catch { /* already closed */ }
  await transfer.writeChain.catch(() => {});
  if (transfer.fileHandle) await transfer.fileHandle.close().catch(() => {});
  transfer.fileHandle = null;
  if (removePart && transfer.partPath) await unlink(transfer.partPath).catch(() => {});
  if (removePart && transfer.finalPath) await unlink(transfer.finalPath).catch(() => {});
  active.delete(transfer.authority.requestId);
  if (transfer.uploadClaim) releaseClientUploadClaim(transfer.authority.clientUploadId, transfer.uploadClaim);
}

async function failTransfer(
  transfer: ActiveDirectTransfer,
  sender: FileTransferSender,
  error: DirectFileTransferError,
  retryable: boolean,
  detail?: string,
): Promise<void> {
  if (transfer.settled) return;
  transfer.settled = true;
  sendError(sender, transfer.authority.requestId, transfer.authority.capability, error, retryable, detail);
  await closeTransferResources(transfer, true);
}

function authorityMatchesStart(authority: DirectFileTransferPrepare, message: Record<string, unknown>): boolean {
  return message.requestId === authority.requestId
    && message.clientUploadId === authority.clientUploadId
    && message.filename === authority.filename
    && message.mime === authority.mime
    && message.size === authority.size
    && message.sha256 === authority.sha256
    && message.capability === authority.capability;
}

async function ensureDiskCapacity(size: number, targetPath: string): Promise<void> {
  const stats = await statfs(path.dirname(targetPath));
  const free = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(free) || free - DIRECT_FILE_TRANSFER_LIMITS.DISK_RESERVE_BYTES < size) {
    throw new Error(DIRECT_FILE_TRANSFER_ERROR.INSUFFICIENT_CAPACITY);
  }
}

async function startDataTransfer(
  transfer: ActiveDirectTransfer,
  channel: DataChannel,
  raw: string,
  sender: FileTransferSender,
): Promise<void> {
  if (transfer.started || transfer.settled) return;
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(raw); } catch { parsedJson = null; }
  const parsed = validateDirectFileTransferDataMessage(parsedJson);
  if (!parsed.ok || parsed.value.type !== DIRECT_FILE_TRANSFER_DATA_MSG.START
    || !authorityMatchesStart(transfer.authority, parsed.value as unknown as Record<string, unknown>)) {
    await failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false);
    return;
  }
  if (Date.now() >= transfer.authority.expiresAt) {
    await failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.AUTHORITY_EXPIRED, true);
    return;
  }

  const existing = lookupAttachmentByClientUploadId(transfer.authority.clientUploadId);
  if (existing) {
    transfer.settled = true;
    sender.send({
      type: DIRECT_FILE_TRANSFER_MSG.DONE,
      requestId: transfer.authority.requestId,
      capability: transfer.authority.capability,
      clientUploadId: transfer.authority.clientUploadId,
      attachment: existing,
    });
    channel.sendMessage(JSON.stringify({ type: DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED, requestId: transfer.authority.requestId }));
    await closeTransferResources(transfer, false);
    return;
  }

  await initFileTransfer();
  const filename = createDirectUploadFilename(transfer.authority.filename);
  const finalPath = resolveUploadPath(filename);
  const partPath = `${finalPath}.${transfer.authority.requestId}.part`;
  await ensureDiskCapacity(transfer.authority.size, finalPath);
  transfer.fileHandle = await open(partPath, 'wx');
  transfer.finalFilename = filename;
  transfer.finalPath = finalPath;
  transfer.partPath = partPath;
  transfer.started = true;
  resetIdleTimer(transfer, sender);
  channel.sendMessage(JSON.stringify({
    type: DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED,
    requestId: transfer.authority.requestId,
  }));
}

function enqueueChunk(transfer: ActiveDirectTransfer, bytes: Uint8Array, sender: FileTransferSender): void {
  if (!transfer.started || transfer.settled || !transfer.fileHandle) return;
  if (transfer.received + transfer.pendingBytes + bytes.byteLength > transfer.authority.size) {
    void failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.SIZE_MISMATCH, false);
    return;
  }
  transfer.pendingBytes += bytes.byteLength;
  if (transfer.pendingBytes > DIRECT_FILE_TRANSFER_LIMITS.DATA_BUFFER_HIGH_WATER_BYTES) {
    void failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, true, 'Receiver disk backlog exceeded');
    return;
  }
  const copy = Buffer.from(bytes);
  transfer.writeChain = transfer.writeChain.then(async () => {
    if (!transfer.fileHandle || transfer.settled) return;
    await transfer.fileHandle.write(copy);
    transfer.hash.update(copy);
    transfer.received += copy.byteLength;
    transfer.pendingBytes -= copy.byteLength;
    resetIdleTimer(transfer, sender);
    const now = Date.now();
    if (now - transfer.lastProgressAt >= 250 || transfer.received === transfer.authority.size) {
      transfer.lastProgressAt = now;
      sender.send({
        type: DIRECT_FILE_TRANSFER_MSG.PROGRESS,
        requestId: transfer.authority.requestId,
        capability: transfer.authority.capability,
        loaded: transfer.received,
        total: transfer.authority.size,
      });
    }
  }).catch((error) => {
    transfer.pendingBytes = Math.max(0, transfer.pendingBytes - copy.byteLength);
    void failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, true, error instanceof Error ? error.message : String(error));
  });
}

async function finishDataTransfer(
  transfer: ActiveDirectTransfer,
  raw: string,
  sender: FileTransferSender,
): Promise<void> {
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(raw); } catch { parsedJson = null; }
  const parsed = validateDirectFileTransferDataMessage(parsedJson);
  if (!parsed.ok || parsed.value.type !== DIRECT_FILE_TRANSFER_DATA_MSG.FINISH
    || parsed.value.requestId !== transfer.authority.requestId) return;
  await transfer.writeChain;
  if (transfer.settled) return;
  if (!transfer.started || !transfer.fileHandle || !transfer.partPath || !transfer.finalPath || !transfer.finalFilename
    || parsed.value.totalBytes !== transfer.received || transfer.received !== transfer.authority.size) {
    await failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.SIZE_MISMATCH, false);
    return;
  }
  const digest = transfer.hash.digest('hex');
  const expectedHash = parsed.value.sha256 ?? transfer.authority.sha256;
  if (expectedHash && digest !== expectedHash) {
    await failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.CHECKSUM_MISMATCH, false);
    return;
  }
  await transfer.fileHandle.sync();
  await transfer.fileHandle.close();
  transfer.fileHandle = null;
  const { rename } = await import('node:fs/promises');
  await rename(transfer.partPath, transfer.finalPath);
  const attachment = await finalizeDirectUploadedFile({
    clientUploadId: transfer.authority.clientUploadId,
    filename: transfer.finalFilename,
    originalName: transfer.authority.filename,
    mime: transfer.authority.mime,
    resolved: transfer.finalPath,
    size: transfer.received,
  });
  transfer.settled = true;
  sender.send({
    type: DIRECT_FILE_TRANSFER_MSG.DONE,
    requestId: transfer.authority.requestId,
    capability: transfer.authority.capability,
    clientUploadId: transfer.authority.clientUploadId,
    attachment,
  });
  await closeTransferResources(transfer, false);
}

function attachDataChannel(transfer: ActiveDirectTransfer, channel: DataChannel, sender: FileTransferSender): void {
  transfer.channel = channel;
  channel.onMessage((message) => {
    if (typeof message === 'string') {
      if (transfer.authority.purpose === DIRECT_FILE_TRANSFER_PURPOSE.PROBE) {
        if (transfer.started || transfer.settled) return;
        let raw: unknown;
        try { raw = JSON.parse(message); } catch { raw = null; }
        const parsed = validateDirectFileTransferDataMessage(raw);
        if (!parsed.ok || parsed.value.type !== DIRECT_FILE_TRANSFER_DATA_MSG.PROBE
          || parsed.value.requestId !== transfer.authority.requestId
          || parsed.value.capability !== transfer.authority.capability) {
          void failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false);
          return;
        }
        const selected = transfer.peer.getSelectedCandidatePair();
        if (!selected) {
          void failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED, true, 'No selected ICE candidate pair');
          return;
        }
        transfer.started = true;
        resetIdleTimer(transfer, sender);
        channel.sendMessage(JSON.stringify({
          type: DIRECT_FILE_TRANSFER_DATA_MSG.PONG,
          requestId: transfer.authority.requestId,
          nonce: parsed.value.nonce,
          rttMs: Math.max(0, transfer.peer.rtt()),
          localCandidate: {
            address: selected.local.address,
            port: selected.local.port,
            type: selected.local.type,
            transportType: selected.local.transportType,
          },
          remoteCandidate: {
            address: selected.remote.address,
            port: selected.remote.port,
            type: selected.remote.type,
            transportType: selected.remote.transportType,
          },
        }));
        return;
      }
      if (!transfer.started) void startDataTransfer(transfer, channel, message, sender).catch((error) => {
        void failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, true, error instanceof Error ? error.message : String(error));
      });
      else void finishDataTransfer(transfer, message, sender).catch((error) => {
        void failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, true, error instanceof Error ? error.message : String(error));
      });
      return;
    }
    const bytes = message instanceof ArrayBuffer
      ? new Uint8Array(message)
      : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    enqueueChunk(transfer, bytes, sender);
  });
  channel.onClosed(() => {
    if (!transfer.settled) void failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED, true);
  });
  channel.onError((error) => {
    void failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED, true, error);
  });
}

async function prepareTransfer(authority: DirectFileTransferPrepare, sender: FileTransferSender): Promise<void> {
  if (!rtc) {
    sendError(sender, authority.requestId, authority.capability, DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE, true);
    return;
  }
  if (Date.now() >= authority.expiresAt) {
    sendError(sender, authority.requestId, authority.capability, DIRECT_FILE_TRANSFER_ERROR.AUTHORITY_EXPIRED, true);
    return;
  }
  if (active.size >= DIRECT_FILE_TRANSFER_LIMITS.MAX_PER_DAEMON) {
    sendError(sender, authority.requestId, authority.capability, DIRECT_FILE_TRANSFER_ERROR.TOO_MANY_TRANSFERS, true);
    return;
  }
  if ([...active.values()].some((transfer) => transfer.authority.clientUploadId === authority.clientUploadId)) {
    sendError(sender, authority.requestId, authority.capability, DIRECT_FILE_TRANSFER_ERROR.TOO_MANY_TRANSFERS, true, 'Upload already active');
    return;
  }
  const probe = authority.purpose === DIRECT_FILE_TRANSFER_PURPOSE.PROBE;
  if (!probe) {
    const existing = lookupAttachmentByClientUploadId(authority.clientUploadId);
    if (existing) {
      sendStatus(sender, authority, DIRECT_FILE_TRANSFER_STATE.COMMITTED, existing);
      return;
    }
  }
  const uploadClaim = probe ? null : tryClaimClientUpload(authority.clientUploadId);
  if (!probe && !uploadClaim) {
    sendError(sender, authority.requestId, authority.capability, DIRECT_FILE_TRANSFER_ERROR.TOO_MANY_TRANSFERS, true, 'Upload already active');
    return;
  }
  const prior = active.get(authority.requestId);
  if (prior) await closeTransferResources(prior, true);
  let peer: PeerConnection;
  try {
    peer = new rtc.PeerConnection(`imcodes-upload-${authority.requestId}`, {
      iceServers: toNodeDataChannelIceServers(authority.iceServers),
      maxMessageSize: DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES,
    });
  } catch (error) {
    if (uploadClaim) releaseClientUploadClaim(authority.clientUploadId, uploadClaim);
    sendError(
      sender,
      authority.requestId,
      authority.capability,
      DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
      true,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  const transfer: ActiveDirectTransfer = {
    authority,
    peer,
    channel: null,
    fileHandle: null,
    partPath: null,
    finalPath: null,
    finalFilename: null,
    received: 0,
    pendingBytes: 0,
    hash: createHash('sha256'),
    writeChain: Promise.resolve(),
    started: false,
    settled: false,
    lastProgressAt: 0,
    idleTimer: null,
    remoteDescriptionSet: false,
    pendingRemoteCandidates: [],
    uploadClaim,
  };
  active.set(authority.requestId, transfer);
  peer.onDataChannel((channel) => attachDataChannel(transfer, channel, sender));
  peer.onLocalDescription((sdp, type) => {
    if (type !== 'answer' || transfer.settled) return;
    sender.send({ type: DIRECT_FILE_TRANSFER_MSG.ANSWER, requestId: authority.requestId, capability: authority.capability, sdp });
  });
  peer.onLocalCandidate((candidate, mid) => {
    if (transfer.settled) return;
    sender.send({ type: DIRECT_FILE_TRANSFER_MSG.ICE, requestId: authority.requestId, capability: authority.capability, candidate, mid });
  });
  peer.onStateChange((state) => {
    if ((state === 'failed' || state === 'closed' || state === 'disconnected') && !transfer.settled) {
      void failTransfer(transfer, sender, DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED, true, state);
    }
  });
  resetIdleTimer(transfer, sender);
}

export async function handleDirectFileTransferCommand(message: unknown, sender: FileTransferSender): Promise<boolean> {
  const parsed = validateDirectFileTransferDaemonCommand(message);
  if (!parsed.ok) return false;
  const command: DirectFileTransferDaemonCommand = parsed.value;
  if (command.type === DIRECT_FILE_TRANSFER_MSG.PREPARE) {
    await prepareTransfer(command, sender);
    return true;
  }
  const transfer = active.get(command.requestId);
  if (!transfer || transfer.authority.capability !== command.capability) {
    sendError(sender, command.requestId, command.capability, DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false);
    return true;
  }
  if (command.type === DIRECT_FILE_TRANSFER_MSG.OFFER) {
    try {
      transfer.peer.setRemoteDescription(command.sdp, 'offer');
      transfer.remoteDescriptionSet = true;
      for (const candidate of transfer.pendingRemoteCandidates.splice(0)) {
        transfer.peer.addRemoteCandidate(candidate.candidate, candidate.mid);
      }
    } catch (error) {
      await failTransfer(
        transfer,
        sender,
        DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
        true,
        error instanceof Error ? error.message : String(error),
      );
    }
    return true;
  }
  if (command.type === DIRECT_FILE_TRANSFER_MSG.ICE) {
    if (!transfer.remoteDescriptionSet) {
      transfer.pendingRemoteCandidates.push({ candidate: command.candidate, mid: command.mid });
      return true;
    }
    try {
      transfer.peer.addRemoteCandidate(command.candidate, command.mid);
    } catch (error) {
      await failTransfer(
        transfer,
        sender,
        DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
        true,
        error instanceof Error ? error.message : String(error),
      );
    }
    return true;
  }
  if (command.type === DIRECT_FILE_TRANSFER_MSG.CANCEL) {
    await failTransfer(transfer, sender, command.reason, false);
    return true;
  }
  const attachment = lookupAttachmentByClientUploadId(command.clientUploadId);
  sendStatus(sender, transfer.authority, attachment ? DIRECT_FILE_TRANSFER_STATE.COMMITTED : DIRECT_FILE_TRANSFER_STATE.PARTIAL, attachment);
  return true;
}

export async function shutdownDirectFileTransfers(): Promise<void> {
  const transfers = [...active.values()];
  await Promise.all(transfers.map((transfer) => closeTransferResources(transfer, true)));
  if (rtc) {
    try { rtc.cleanup(); } catch { /* native runtime already cleaned */ }
  }
  rtc = null;
}
