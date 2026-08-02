import {
  DIRECT_CONNECTIVITY_CANDIDATE_TYPE,
  DIRECT_CONNECTIVITY_PROBE_STAGE,
  classifyDirectConnectivityRoute,
  DIRECT_FILE_TRANSFER_CAPABILITY,
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_ERROR,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
  DIRECT_FILE_TRANSFER_PURPOSE,
  DIRECT_FILE_TRANSFER_STATE,
  validateDirectFileTransferAuthorized,
  validateDirectFileTransferDataMessage,
  type DirectConnectivityCandidateType,
  type DirectConnectivityProbeDiagnostics,
  type DirectConnectivityProbeResult,
  type DirectFileTransferIceServerConfig,
  type DirectFileTransferServerMessage,
} from '@shared/direct-file-transfer.js';
import { FILE_TRANSFER_LIMITS } from '@shared/transport/file-transfer.js';
import { uploadFile, type AttachmentRefResponse } from './api.js';
import type { ServerMessage, WsClient } from './ws-client.js';

export type FileUploadTransportMode =
  | typeof DIRECT_FILE_TRANSFER_STATE.CONNECTING
  | typeof DIRECT_FILE_TRANSFER_STATE.DIRECT
  | typeof DIRECT_FILE_TRANSFER_STATE.FALLING_BACK
  | typeof DIRECT_FILE_TRANSFER_STATE.RELAY;

export class DirectFileTransferFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable = true,
    message = code,
  ) {
    super(message);
    this.name = 'DirectFileTransferFailure';
  }
}

export function toBrowserIceServers(
  iceServers: readonly DirectFileTransferIceServerConfig[],
): RTCIceServer[] {
  return iceServers.map((entry) => typeof entry === 'string'
    ? { urls: entry }
    : {
        urls: [...entry.urls],
        ...(entry.username ? { username: entry.username } : {}),
        ...(entry.credential ? { credential: entry.credential } : {}),
      });
}

function isDirectMessage(message: ServerMessage, requestId: string): message is DirectFileTransferServerMessage {
  return typeof (message as { requestId?: unknown }).requestId === 'string'
    && (message as { requestId: string }).requestId === requestId
    && typeof message.type === 'string'
    && message.type.startsWith('direct_file.');
}

function supportsDirectUpload(ws: WsClient): boolean {
  if (typeof RTCPeerConnection === 'undefined') return false;
  const snapshot = ws.getDaemonCapabilitySnapshot();
  return Boolean(snapshot?.capabilities.includes(DIRECT_FILE_TRANSFER_CAPABILITY));
}

function waitForBufferedAmount(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount <= DIRECT_FILE_TRANSFER_LIMITS.DATA_BUFFER_HIGH_WATER_BYTES) return Promise.resolve();
  channel.bufferedAmountLowThreshold = DIRECT_FILE_TRANSFER_LIMITS.DATA_BUFFER_LOW_WATER_BYTES;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED));
    }, DIRECT_FILE_TRANSFER_LIMITS.IDLE_TIMEOUT_MS);
    const onLow = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED)); };
    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener('bufferedamountlow', onLow);
      channel.removeEventListener('close', onClose);
    };
    channel.addEventListener('bufferedamountlow', onLow, { once: true });
    channel.addEventListener('close', onClose, { once: true });
  });
}

async function pumpFile(
  channel: RTCDataChannel,
  file: File,
  requestId: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  let offset = 0;
  while (offset < file.size) {
    await waitForBufferedAmount(channel);
    const end = Math.min(file.size, offset + DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES);
    channel.send(await file.slice(offset, end).arrayBuffer());
    offset = end;
    onProgress?.(file.size > 0 ? Math.round((offset / file.size) * 100) : 100);
  }
  channel.send(JSON.stringify({
    type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
    requestId,
    totalBytes: file.size,
  }));
}

type DirectOperation = {
  kind: 'upload';
  file: File;
  clientUploadId: string;
  onProgress?: (pct: number) => void;
  onConnected?: () => void;
} | {
  kind: 'probe';
  nonce: string;
  onDiagnostics?: (diagnostics: DirectConnectivityProbeDiagnostics) => void;
};

type DirectOperationResult =
  | { kind: 'upload'; attachment: AttachmentRefResponse }
  | { kind: 'probe'; result: DirectConnectivityProbeResult };

async function runDirectOperation(ws: WsClient, operation: DirectOperation): Promise<DirectOperationResult> {
  if (!supportsDirectUpload(ws)) {
    throw new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE);
  }
  const requestId = crypto.randomUUID();
  const probe = operation.kind === 'probe';
  const clientUploadId = probe ? crypto.randomUUID() : operation.clientUploadId;
  const filename = probe ? 'connectivity-probe' : (operation.file.name || 'file');
  const mime = probe ? undefined : operation.file.type;
  const size = probe ? 0 : operation.file.size;
  let peer: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let capability: string | null = null;
  let settled = false;
  let unsubscribe: (() => void) | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let pumping = false;
  const pendingCandidates: RTCIceCandidateInit[] = [];
  const browserCandidateTypes = new Set<DirectConnectivityCandidateType>();
  const daemonCandidateTypes = new Set<DirectConnectivityCandidateType>();
  let probeStage: DirectConnectivityProbeDiagnostics['stage'] = DIRECT_CONNECTIVITY_PROBE_STAGE.AUTHORIZING;
  const probeStageOrder: DirectConnectivityProbeDiagnostics['stage'][] = [
    DIRECT_CONNECTIVITY_PROBE_STAGE.AUTHORIZING,
    DIRECT_CONNECTIVITY_PROBE_STAGE.CREATING_OFFER,
    DIRECT_CONNECTIVITY_PROBE_STAGE.EXCHANGING_CANDIDATES,
    DIRECT_CONNECTIVITY_PROBE_STAGE.CHECKING,
    DIRECT_CONNECTIVITY_PROBE_STAGE.DATA_CHANNEL_OPEN,
    DIRECT_CONNECTIVITY_PROBE_STAGE.VERIFYING,
    DIRECT_CONNECTIVITY_PROBE_STAGE.COMPLETE,
  ];

  const readCandidateType = (candidate: string, declaredType?: string | null): DirectConnectivityCandidateType | null => {
    const rawType = declaredType?.toLowerCase() ?? /\btyp\s+([a-z0-9_-]+)/i.exec(candidate)?.[1]?.toLowerCase();
    return Object.values(DIRECT_CONNECTIVITY_CANDIDATE_TYPE).includes(rawType as DirectConnectivityCandidateType)
      ? rawType as DirectConnectivityCandidateType
      : null;
  };
  const emitProbeDiagnostics = (stage?: DirectConnectivityProbeDiagnostics['stage']) => {
    if (operation.kind !== 'probe') return;
    if (stage && probeStageOrder.indexOf(stage) >= probeStageOrder.indexOf(probeStage)) probeStage = stage;
    operation.onDiagnostics?.({
      stage: probeStage,
      browserCandidateTypes: [...browserCandidateTypes],
      daemonCandidateTypes: [...daemonCandidateTypes],
    });
  };

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      unsubscribe?.();
      unsubscribe = null;
      try { channel?.close(); } catch { /* already closed */ }
      try { peer?.close(); } catch { /* already closed */ }
      channel = null;
      peer = null;
    };
    const cancel = (reason: typeof DIRECT_FILE_TRANSFER_ERROR[keyof typeof DIRECT_FILE_TRANSFER_ERROR]) => {
      if (!capability) return;
      ws.send({ type: DIRECT_FILE_TRANSFER_MSG.CANCEL, requestId, capability, reason });
    };
    const finishError = (error: unknown) => {
      if (settled) return;
      settled = true;
      cancel(DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED);
      cleanup();
      reject(error instanceof DirectFileTransferFailure
        ? error
        : new DirectFileTransferFailure(
          DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
          true,
          error instanceof Error ? error.message : String(error),
        ));
    };
    const armTimeout = (ms = DIRECT_FILE_TRANSFER_LIMITS.IDLE_TIMEOUT_MS) => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => finishError(new DirectFileTransferFailure(
        DIRECT_FILE_TRANSFER_ERROR.NEGOTIATION_TIMEOUT,
      )), ms);
    };
    const flushRemoteCandidates = async () => {
      if (!peer?.remoteDescription) return;
      while (pendingCandidates.length > 0) {
        const candidate = pendingCandidates.shift();
        if (candidate) await peer.addIceCandidate(candidate);
      }
    };
    const handleAuthorized = async (message: ServerMessage) => {
      const parsed = validateDirectFileTransferAuthorized(message);
      if (!parsed.ok || parsed.value.requestId !== requestId || settled) return;
      const authorizedProbe = parsed.value.purpose === DIRECT_FILE_TRANSFER_PURPOSE.PROBE;
      if (authorizedProbe !== probe) {
        finishError(new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false));
        return;
      }
      capability = parsed.value.capability;
      emitProbeDiagnostics(DIRECT_CONNECTIVITY_PROBE_STAGE.CREATING_OFFER);
      peer = new RTCPeerConnection({
        iceServers: toBrowserIceServers(parsed.value.iceServers),
      });
      channel = peer.createDataChannel(probe ? 'imcodes-connectivity-probe' : 'imcodes-file-upload', { ordered: true });
      channel.binaryType = 'arraybuffer';
      channel.addEventListener('open', () => {
        if (!channel || settled) return;
        emitProbeDiagnostics(DIRECT_CONNECTIVITY_PROBE_STAGE.DATA_CHANNEL_OPEN);
        channel.send(JSON.stringify(probe
          ? {
              type: DIRECT_FILE_TRANSFER_DATA_MSG.PROBE,
              protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
              requestId,
              capability: parsed.value.capability,
              nonce: operation.nonce,
            }
          : {
              type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
              protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
              requestId,
              clientUploadId,
              filename,
              ...(mime ? { mime } : {}),
              size,
              capability: parsed.value.capability,
            }));
        emitProbeDiagnostics(DIRECT_CONNECTIVITY_PROBE_STAGE.VERIFYING);
        armTimeout(probe ? DIRECT_FILE_TRANSFER_LIMITS.PROBE_TIMEOUT_MS : DIRECT_FILE_TRANSFER_LIMITS.IDLE_TIMEOUT_MS);
      });
      channel.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        let raw: unknown;
        try { raw = JSON.parse(event.data); } catch { raw = null; }
        const parsedData = validateDirectFileTransferDataMessage(raw);
        if (!parsedData.ok || parsedData.value.requestId !== requestId) return;
        if (probe) {
          if (parsedData.value.type !== DIRECT_FILE_TRANSFER_DATA_MSG.PONG || parsedData.value.nonce !== operation.nonce) return;
          settled = true;
          cancel(DIRECT_FILE_TRANSFER_ERROR.CANCELED);
          const result: DirectConnectivityProbeResult = {
            route: classifyDirectConnectivityRoute(parsedData.value.localCandidate, parsedData.value.remoteCandidate),
            rttMs: parsedData.value.rttMs,
            localCandidate: parsedData.value.localCandidate,
            remoteCandidate: parsedData.value.remoteCandidate,
          };
          emitProbeDiagnostics(DIRECT_CONNECTIVITY_PROBE_STAGE.COMPLETE);
          cleanup();
          resolve({ kind: 'probe', result });
          return;
        }
        if (parsedData.value.type !== DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED || !channel || pumping) return;
        pumping = true;
        operation.onConnected?.();
        armTimeout();
        void pumpFile(channel, operation.file, requestId, (pct) => {
          armTimeout();
          operation.onProgress?.(pct);
        }).catch(finishError);
      });
      channel.addEventListener('error', () => finishError(new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED)));
      channel.addEventListener('close', () => {
        if (!settled) finishError(new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED));
      });
      peer.addEventListener('icecandidate', (event) => {
        if (!event.candidate || !capability) return;
        const candidateType = readCandidateType(
          event.candidate.candidate,
          (event.candidate as RTCIceCandidate & { type?: string | null }).type,
        );
        if (candidateType) browserCandidateTypes.add(candidateType);
        emitProbeDiagnostics();
        ws.send({
          type: DIRECT_FILE_TRANSFER_MSG.ICE,
          requestId,
          capability,
          candidate: event.candidate.candidate,
          mid: event.candidate.sdpMid ?? '',
        });
      });
      peer.addEventListener('connectionstatechange', () => {
        if (!peer || settled) return;
        if (peer.connectionState === 'connecting' || peer.connectionState === 'connected') {
          emitProbeDiagnostics(DIRECT_CONNECTIVITY_PROBE_STAGE.CHECKING);
        }
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
          finishError(new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED));
        }
      });
      const offer = await peer.createOffer();
      emitProbeDiagnostics(DIRECT_CONNECTIVITY_PROBE_STAGE.EXCHANGING_CANDIDATES);
      await peer.setLocalDescription(offer);
      ws.send({
        type: DIRECT_FILE_TRANSFER_MSG.OFFER,
        requestId,
        capability: parsed.value.capability,
        sdp: offer.sdp ?? '',
      });
      armTimeout(DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS);
    };

    unsubscribe = ws.onMessage((message) => {
      if (!isDirectMessage(message, requestId) || settled) return;
      if (message.type === DIRECT_FILE_TRANSFER_MSG.AUTHORIZED) {
        void handleAuthorized(message).catch(finishError);
        return;
      }
      if (message.type === DIRECT_FILE_TRANSFER_MSG.ANSWER && peer && capability === message.capability) {
        emitProbeDiagnostics(DIRECT_CONNECTIVITY_PROBE_STAGE.CHECKING);
        void peer.setRemoteDescription({ type: 'answer', sdp: message.sdp })
          .then(flushRemoteCandidates)
          .catch(finishError);
        return;
      }
      if (message.type === DIRECT_FILE_TRANSFER_MSG.ICE && peer && capability === message.capability) {
        const candidateType = readCandidateType(message.candidate);
        if (candidateType) daemonCandidateTypes.add(candidateType);
        emitProbeDiagnostics();
        const candidate = { candidate: message.candidate, sdpMid: message.mid };
        if (peer.remoteDescription) void peer.addIceCandidate(candidate).catch(finishError);
        else pendingCandidates.push(candidate);
        return;
      }
      if (message.type === DIRECT_FILE_TRANSFER_MSG.PROGRESS && capability === message.capability) {
        if (probe) return;
        armTimeout();
        operation.onProgress?.(message.total > 0 ? Math.round((message.loaded / message.total) * 100) : 100);
        return;
      }
      if (message.type === DIRECT_FILE_TRANSFER_MSG.DONE && (!capability || capability === message.capability)) {
        if (probe) return;
        capability = message.capability;
        settled = true;
        cleanup();
        operation.onProgress?.(100);
        resolve({ kind: 'upload', attachment: message.attachment as AttachmentRefResponse });
        return;
      }
      if (message.type === DIRECT_FILE_TRANSFER_MSG.STATUS
        && (!capability || capability === message.capability)
        && message.state === DIRECT_FILE_TRANSFER_STATE.COMMITTED
        && message.attachment) {
        if (probe) return;
        capability = message.capability;
        settled = true;
        cleanup();
        operation.onProgress?.(100);
        resolve({ kind: 'upload', attachment: message.attachment as AttachmentRefResponse });
        return;
      }
      if (message.type === DIRECT_FILE_TRANSFER_MSG.ERROR
        && (!message.capability || !capability || message.capability === capability)) {
        finishError(new DirectFileTransferFailure(message.error, message.retryable, message.detail ?? message.error));
      }
    });
    emitProbeDiagnostics(DIRECT_CONNECTIVITY_PROBE_STAGE.AUTHORIZING);
    armTimeout(DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS);
    ws.send({
      type: DIRECT_FILE_TRANSFER_MSG.INIT,
      ...(probe ? { purpose: DIRECT_FILE_TRANSFER_PURPOSE.PROBE } : {}),
      requestId,
      clientUploadId,
      filename,
      ...(mime ? { mime } : {}),
      size,
    });
  });
}

export async function uploadFileDirect(
  ws: WsClient,
  file: File,
  clientUploadId: string,
  onProgress?: (pct: number) => void,
  onConnected?: () => void,
): Promise<{ ok: true; attachment: AttachmentRefResponse }> {
  const result = await runDirectOperation(ws, { kind: 'upload', file, clientUploadId, onProgress, onConnected });
  if (result.kind !== 'upload') throw new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR, false);
  return { ok: true, attachment: result.attachment };
}

export async function probeDirectConnectivity(
  ws: WsClient,
  onDiagnostics?: (diagnostics: DirectConnectivityProbeDiagnostics) => void,
): Promise<DirectConnectivityProbeResult> {
  const result = await runDirectOperation(ws, { kind: 'probe', nonce: crypto.randomUUID(), onDiagnostics });
  if (result.kind !== 'probe') throw new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR, false);
  return result.result;
}

export async function uploadFileWithDirectFallback(options: {
  ws: WsClient | null;
  serverId: string;
  file: File;
  onProgress?: (pct: number) => void;
  onMode?: (mode: FileUploadTransportMode) => void;
}): Promise<{ ok: boolean; attachment: AttachmentRefResponse }> {
  const clientUploadId = crypto.randomUUID();
  if (options.ws && supportsDirectUpload(options.ws)) {
    options.onMode?.(DIRECT_FILE_TRANSFER_STATE.CONNECTING);
    try {
      const result = await uploadFileDirect(
        options.ws,
        options.file,
        clientUploadId,
        options.onProgress,
        () => options.onMode?.(DIRECT_FILE_TRANSFER_STATE.DIRECT),
      );
      return result;
    } catch (error) {
      if (options.file.size > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
        throw new DirectFileTransferFailure(
          DIRECT_FILE_TRANSFER_ERROR.RELAY_SIZE_LIMIT,
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
      options.onMode?.(DIRECT_FILE_TRANSFER_STATE.FALLING_BACK);
    }
  } else if (options.file.size > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
    throw new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.RELAY_SIZE_LIMIT, false);
  }
  options.onMode?.(DIRECT_FILE_TRANSFER_STATE.RELAY);
  return uploadFile(options.serverId, options.file, options.onProgress, clientUploadId);
}
