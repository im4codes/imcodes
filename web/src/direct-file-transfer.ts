import {
  DIRECT_FILE_TRANSFER_CAPABILITY,
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_ERROR,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_STATE,
  validateDirectFileTransferAuthorized,
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

export async function uploadFileDirect(
  ws: WsClient,
  file: File,
  clientUploadId: string,
  onProgress?: (pct: number) => void,
  onConnected?: () => void,
): Promise<{ ok: true; attachment: AttachmentRefResponse }> {
  if (!supportsDirectUpload(ws)) {
    throw new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE);
  }
  const requestId = crypto.randomUUID();
  let peer: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let capability: string | null = null;
  let settled = false;
  let unsubscribe: (() => void) | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let pumping = false;
  const pendingCandidates: RTCIceCandidateInit[] = [];

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
    const finishError = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (capability) {
        ws.send({
          type: DIRECT_FILE_TRANSFER_MSG.CANCEL,
          requestId,
          capability,
          reason: DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
        });
      }
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
      capability = parsed.value.capability;
      peer = new RTCPeerConnection({
        iceServers: parsed.value.iceServers.map((urls) => ({ urls })),
      });
      channel = peer.createDataChannel('imcodes-file-upload', { ordered: true });
      channel.binaryType = 'arraybuffer';
      channel.addEventListener('open', () => {
        if (!channel || settled) return;
        channel.send(JSON.stringify({
          type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
          protocolVersion: 1,
          requestId,
          clientUploadId,
          filename: file.name || 'file',
          ...(file.type ? { mime: file.type } : {}),
          size: file.size,
          capability: parsed.value.capability,
        }));
        armTimeout();
      });
      channel.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        let payload: { type?: unknown; requestId?: unknown } | null = null;
        try { payload = JSON.parse(event.data) as { type?: unknown; requestId?: unknown }; } catch { /* invalid control */ }
        if (payload?.type !== DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED || payload.requestId !== requestId || !channel || pumping) return;
        pumping = true;
        onConnected?.();
        armTimeout();
        void pumpFile(channel, file, requestId, (pct) => {
          armTimeout();
          onProgress?.(pct);
        }).catch(finishError);
      });
      channel.addEventListener('error', () => finishError(new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED)));
      channel.addEventListener('close', () => {
        if (!settled) finishError(new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED));
      });
      peer.addEventListener('icecandidate', (event) => {
        if (!event.candidate || !capability) return;
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
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
          finishError(new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED));
        }
      });
      const offer = await peer.createOffer();
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
        void peer.setRemoteDescription({ type: 'answer', sdp: message.sdp })
          .then(flushRemoteCandidates)
          .catch(finishError);
        return;
      }
      if (message.type === DIRECT_FILE_TRANSFER_MSG.ICE && peer && capability === message.capability) {
        const candidate = { candidate: message.candidate, sdpMid: message.mid };
        if (peer.remoteDescription) void peer.addIceCandidate(candidate).catch(finishError);
        else pendingCandidates.push(candidate);
        return;
      }
      if (message.type === DIRECT_FILE_TRANSFER_MSG.PROGRESS && capability === message.capability) {
        armTimeout();
        onProgress?.(message.total > 0 ? Math.round((message.loaded / message.total) * 100) : 100);
        return;
      }
      if (message.type === DIRECT_FILE_TRANSFER_MSG.DONE && (!capability || capability === message.capability)) {
        capability = message.capability;
        settled = true;
        cleanup();
        onProgress?.(100);
        resolve({ ok: true, attachment: message.attachment as AttachmentRefResponse });
        return;
      }
      if (message.type === DIRECT_FILE_TRANSFER_MSG.STATUS
        && (!capability || capability === message.capability)
        && message.state === DIRECT_FILE_TRANSFER_STATE.COMMITTED
        && message.attachment) {
        capability = message.capability;
        settled = true;
        cleanup();
        onProgress?.(100);
        resolve({ ok: true, attachment: message.attachment as AttachmentRefResponse });
        return;
      }
      if (message.type === DIRECT_FILE_TRANSFER_MSG.ERROR
        && (!message.capability || !capability || message.capability === capability)) {
        finishError(new DirectFileTransferFailure(message.error, message.retryable, message.detail ?? message.error));
      }
    });
    armTimeout(DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS);
    ws.send({
      type: DIRECT_FILE_TRANSFER_MSG.INIT,
      requestId,
      clientUploadId,
      filename: file.name || 'file',
      ...(file.type ? { mime: file.type } : {}),
      size: file.size,
    });
  });
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
