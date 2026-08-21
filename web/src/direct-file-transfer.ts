import {
  DIRECT_CONNECTIVITY_PROBE_STAGE,
  DIRECT_CONNECTIVITY_ROUTE,
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_DIRECTION,
  DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION,
  DIRECT_FILE_TRANSFER_ERROR,
  DIRECT_FILE_TRANSFER_LEASE_CAPABILITY,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_OPERATION_STATE,
  DIRECT_FILE_TRANSFER_PREVIEW_DOWNLOAD_CAPABILITY,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
  DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY,
  classifyDirectConnectivityRoute,
  classifyDirectFileTransferFailure,
  validateDirectFileTransferAuthorized,
  validateDirectFileTransferServerMessage,
  validateDirectFileTransferDataMessage,
  type DirectConnectivityProbeDiagnostics,
  type DirectConnectivityProbeResult,
  type DirectConnectivityRoute,
  type DirectFileTransferAuthorized,
  type DirectFileTransferDataMessage,
  type DirectFileTransferDirection,
  type DirectFileTransferError,
  type DirectFileTransferIceServerConfig,
  type DirectFileTransferLeaseAnswer,
  type DirectFileTransferLeaseReady,
  type DirectFileTransferOperationInit,
  type DirectFileTransferServerMessage,
} from '@shared/direct-file-transfer.js';
import {
  PendingWebRtcCandidates,
  toWebRtcIceServers,
} from '@shared/webrtc-connectivity.js';
import { FILE_TRANSFER_LIMITS } from '@shared/transport/file-transfer.js';
import {
  downloadAttachment,
  streamAttachmentDownloadToWritable,
  uploadFile,
  type AttachmentRefResponse,
} from './api.js';
import type { ServerMessage, WsClient } from './ws-client.js';

/**
 * Presentation states only.  They are intentionally browser-local rather than
 * shared protocol states: the daemon never receives these values.
 */
export const FILE_UPLOAD_TRANSPORT_MODE = {
  CONNECTING: 'connecting',
  DIRECT: 'direct',
  FALLING_BACK: 'falling_back',
  RELAY: 'relay',
} as const;

export type FileUploadTransportMode = typeof FILE_UPLOAD_TRANSPORT_MODE[keyof typeof FILE_UPLOAD_TRANSPORT_MODE];

export const FILE_DOWNLOAD_TRANSPORT_MODE = {
  CONNECTING: 'connecting',
  DIRECT: 'direct',
  FALLING_BACK: 'falling_back',
  HTTP: 'http',
  BROWSER: 'browser',
} as const;

export type FileDownloadTransportMode = typeof FILE_DOWNLOAD_TRANSPORT_MODE[keyof typeof FILE_DOWNLOAD_TRANSPORT_MODE];
export type FileDownloadProgress = { loadedBytes: number; totalBytes: number | null };

/** Redacted browser observability: never include ids, names, paths, SDP, or authority. */
export const DIRECT_FILE_TRANSFER_CLIENT_METRIC = {
  LEASE_REUSED: 'lease_reused',
  REBIND: 'rebind',
  STATUS_RECOVERED: 'status_recovered',
  ATTEMPT: 'attempt',
  RETRY_EXHAUSTED: 'retry_exhausted',
  CANCELED: 'canceled',
  DIRECT_SUCCESS: 'direct_success',
  BYTES: 'bytes',
  ROUTE: 'route',
} as const;

type DirectFileTransferClientMetric = typeof DIRECT_FILE_TRANSFER_CLIENT_METRIC[keyof typeof DIRECT_FILE_TRANSFER_CLIENT_METRIC];

type DirectFileTransferMetricFields = {
  direction?: DirectFileTransferDirection;
  attempt?: number;
  bytes?: number;
  /** Candidate type only; never an address, port, id, or URL. */
  route?: DirectConnectivityRoute | 'unknown';
  reused?: boolean;
};

function recordDirectFileTransferMetric(metric: DirectFileTransferClientMetric, fields: DirectFileTransferMetricFields = {}): void {
  // Best-effort local telemetry only; failure to log must never affect transfer.
  try { console.debug('[direct-file-transfer]', { metric, ...fields }); } catch { /* no console */ }
}

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

export interface FileSystemWritableFileStreamLike {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface FileSystemFileHandleLike {
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStreamLike>;
}

export interface DirectPreviewDownloadDestination {
  readonly handle: FileSystemFileHandleLike;
}

type SavePicker = (options?: {
  suggestedName?: string;
  excludeAcceptAllOption?: boolean;
}) => Promise<FileSystemFileHandleLike>;

type Lease = {
  readonly ws: WsClient;
  readonly serverId: string;
  readonly browserTabId: string;
  leaseId: string | null;
  leaseGeneration: number | null;
  daemonGeneration: number | null;
  resumeTicket: string | null;
  /** Server-authoritative idle deadline, measured from lease init/activity. */
  idleExpiresAt: number;
  expiresAt: number;
  iceServers: readonly DirectFileTransferIceServerConfig[];
  peer: RTCPeerConnection | null;
  peerState: RTCPeerConnectionState | null;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  creating: Promise<void> | null;
  rebinding: Promise<void> | null;
  iceRestartedGeneration: number | null;
  peerCreating: Promise<void> | null;
  leaseSignalRequestId: string | null;
  unsubscribeCapability: (() => void) | null;
  unsubscribeTerminalObserver: (() => void) | null;
  active: Map<string, ActiveAttempt>;
  terminalGrace: Map<string, TerminalGrace>;
};

type ActiveAttempt = {
  readonly requestId: string;
  readonly attemptId: string;
  readonly operationId: string;
  readonly direction: DirectFileTransferDirection;
  readonly attempt: number;
  /** Frozen from AUTHORIZED; data-plane frames survive a control rebind. */
  daemonGeneration: number | null;
  authority: string | null;
  channel: RTCDataChannel | null;
  signal?: AbortSignal;
};

/**
 * Data ACK/FINISH is deliberately faster than the Server control terminal.
 * Keep only this redacted correlation tuple until the Server returns its
 * freshly re-armed idle deadline (or the bounded recovery grace elapses).
 */
type TerminalGrace = {
  readonly requestId: string;
  readonly attemptId: string;
  readonly operationId: string;
  readonly direction: DirectFileTransferDirection;
  readonly attempt: number;
  readonly timer: ReturnType<typeof setTimeout>;
};

type DirectUploadAttempt = {
  kind: 'upload';
  file: File;
  operationId: string;
  sessionName?: string;
  onProgress?: (pct: number) => void;
  onConnected?: () => void;
  signal?: AbortSignal;
};

type DirectDownloadAttempt = {
  kind: 'download';
  previewHandle: string;
  operationId: string;
  sessionName?: string;
  writer: FileSystemWritableFileStreamLike;
  onProgress?: (progress: FileDownloadProgress) => void;
  onConnected?: () => void;
  signal?: AbortSignal;
};

type DirectAttempt = DirectUploadAttempt | DirectDownloadAttempt;

type OperationSuccess = { kind: 'upload'; attachment: AttachmentRefResponse } | { kind: 'download' };

const brokers = new WeakMap<WsClient, Map<string, Lease>>();
const TAB_ID_STORAGE_KEY = 'imcodes.direct_file.browser_tab.v2';

function browserTabId(): string {
  try {
    const existing = sessionStorage.getItem(TAB_ID_STORAGE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(TAB_ID_STORAGE_KEY, created);
    return created;
  } catch {
    // A blocked storage environment remains isolated to this document; the
    // opaque id still never carries file authority.
    return crypto.randomUUID();
  }
}

function directError(code: DirectFileTransferError | string, retryable = true, detail?: string): DirectFileTransferFailure {
  return new DirectFileTransferFailure(code, retryable, detail ?? code);
}

function supportsCapabilities(ws: WsClient, required: readonly string[]): boolean {
  if (typeof RTCPeerConnection === 'undefined') return false;
  const snapshot = ws.getDaemonCapabilitySnapshot();
  return !!snapshot && required.every((capability) => snapshot.capabilities.includes(capability));
}

function supportsLease(ws: WsClient): boolean {
  return supportsCapabilities(ws, [DIRECT_FILE_TRANSFER_LEASE_CAPABILITY]);
}

function supportsUpload(ws: WsClient): boolean {
  return supportsCapabilities(ws, [
    DIRECT_FILE_TRANSFER_LEASE_CAPABILITY,
    DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY,
  ]);
}

function supportsPreviewDownload(ws: WsClient): boolean {
  return supportsCapabilities(ws, [
    DIRECT_FILE_TRANSFER_LEASE_CAPABILITY,
    DIRECT_FILE_TRANSFER_PREVIEW_DOWNLOAD_CAPABILITY,
  ]);
}

export function toBrowserIceServers(iceServers: readonly DirectFileTransferIceServerConfig[]): RTCIceServer[] {
  return toWebRtcIceServers(iceServers);
}

function parseMatchingControl(
  raw: ServerMessage,
  requestId: string,
): DirectFileTransferServerMessage | null {
  if (typeof (raw as { requestId?: unknown }).requestId !== 'string'
    || (raw as { requestId: string }).requestId !== requestId) return null;
  const parsed = validateDirectFileTransferServerMessage(raw);
  return parsed.ok ? parsed.value : null;
}

function getBroker(ws: WsClient, serverId: string): Lease {
  let byServer = brokers.get(ws);
  if (!byServer) {
    byServer = new Map();
    brokers.set(ws, byServer);
  }
  const existing = byServer.get(serverId);
  if (existing) return existing;
  const lease: Lease = {
    ws,
    serverId,
    browserTabId: browserTabId(),
    leaseId: null,
    leaseGeneration: null,
    daemonGeneration: null,
    resumeTicket: null,
    idleExpiresAt: 0,
    expiresAt: 0,
    iceServers: [],
    peer: null,
    peerState: null,
    refs: 0,
    idleTimer: null,
    creating: null,
    rebinding: null,
    iceRestartedGeneration: null,
    peerCreating: null,
    leaseSignalRequestId: null,
    unsubscribeCapability: null,
    unsubscribeTerminalObserver: null,
    active: new Map(),
    terminalGrace: new Map(),
  };
  // A Server/WebSocket restart clears and then repopulates this snapshot.  A
  // healthy peer is deliberately left alone; rebind only restores the control
  // path and terminal status recovery.
  lease.unsubscribeCapability = ws.onDaemonCapabilitySnapshot((snapshot) => {
    if (!snapshot || !snapshot.capabilities.includes(DIRECT_FILE_TRANSFER_LEASE_CAPABILITY) || !lease.leaseId) return;
    void rebindLease(lease).catch(() => undefined);
  });
  lease.unsubscribeTerminalObserver = ws.onMessage((raw) => {
    observeLateTerminalDeadline(lease, raw);
  });
  byServer.set(serverId, lease);
  return lease;
}

function clearLeaseTimer(lease: Lease): void {
  if (lease.idleTimer) clearTimeout(lease.idleTimer);
  lease.idleTimer = null;
}

function disposeLease(lease: Lease): void {
  clearLeaseTimer(lease);
  for (const active of lease.active.values()) {
    try { active.channel?.close(); } catch { /* best effort */ }
  }
  lease.active.clear();
  for (const grace of lease.terminalGrace.values()) clearTimeout(grace.timer);
  lease.terminalGrace.clear();
  try { lease.peer?.close(); } catch { /* best effort */ }
  lease.peer = null;
  lease.peerState = null;
  lease.leaseId = null;
  lease.leaseGeneration = null;
  lease.daemonGeneration = null;
  lease.resumeTicket = null;
  lease.idleExpiresAt = 0;
  lease.expiresAt = 0;
  lease.iceServers = [];
  lease.leaseSignalRequestId = null;
  lease.unsubscribeCapability?.();
  lease.unsubscribeCapability = null;
  lease.unsubscribeTerminalObserver?.();
  lease.unsubscribeTerminalObserver = null;
  brokers.get(lease.ws)?.delete(lease.serverId);
}

function armLeaseIdleTimer(lease: Lease): void {
  // The bounded grace owns the binding after data ACK/local cancel until the
  // Server returns its re-armed deadline. Do not let an outer release arm the
  // stale pre-operation deadline in that interval.
  if (lease.active.size !== 0 || lease.terminalGrace.size !== 0) return;
  clearLeaseTimer(lease);
  // Unlike the browser's old relative five-minute timer, this deadline starts
  // when the server accepts LEASE_INIT. A delayed LEASE_READY/SDP exchange
  // therefore cannot extend a ticket the authority has already retired.
  const delay = lease.idleExpiresAt - Date.now();
  if (!Number.isFinite(delay) || delay <= 0) {
    if (lease.refs === 0) disposeLease(lease);
    else clearLeaseBinding(lease);
    return;
  }
  lease.idleTimer = setTimeout(() => {
    if (lease.active.size !== 0) return;
    if (lease.refs === 0) {
      disposeLease(lease);
      return;
    }
    // A mounted File Browser keeps only the broker reference alive. Its inert
    // peer/lease must still match the daemon's five-minute lease TTL, so the
    // next explicit click re-initializes rather than hitting an expired lease.
    clearLeaseBinding(lease);
  }, delay);
}

function releaseLease(lease: Lease): void {
  lease.refs = Math.max(0, lease.refs - 1);
  if (lease.active.size === 0) armLeaseIdleTimer(lease);
}

function acquireLease(ws: WsClient, serverId: string): { lease: Lease; release: () => void } {
  const lease = getBroker(ws, serverId);
  lease.refs++;
  clearLeaseTimer(lease);
  let released = false;
  return {
    lease,
    release: () => {
      if (released) return;
      released = true;
      releaseLease(lease);
    },
  };
}

/** Prewarm only the inert lease.  No file handle, session scope or authority is sent. */
export function prewarmDirectFileLease(ws: WsClient, serverId: string): (() => void) | undefined {
  if (!supportsLease(ws)) return undefined;
  const { lease, release } = acquireLease(ws, serverId);
  void ensureLease(lease).then(
    () => armLeaseIdleTimer(lease),
    () => release(),
  );
  return release;
}

function leaseFromReady(lease: Lease, message: DirectFileTransferLeaseReady): void {
  lease.leaseId = message.leaseId;
  lease.leaseGeneration = message.leaseGeneration;
  lease.daemonGeneration = message.daemonGeneration;
  lease.resumeTicket = message.resumeTicket;
  lease.idleExpiresAt = message.idleExpiresAt;
  lease.expiresAt = message.expiresAt;
  lease.iceServers = message.iceServers;
  // Arm as soon as the authority becomes visible, before SDP negotiation.
  // A malformed or already-expired deadline never leaves a usable binding.
  if (!Number.isFinite(lease.idleExpiresAt) || lease.idleExpiresAt <= Date.now()) {
    clearLeaseBinding(lease);
    return;
  }
  armLeaseIdleTimer(lease);
}

/**
 * A completed long-running operation re-arms idle expiry on the Server and
 * daemon. Terminal status is the first browser-visible point at which that
 * new authoritative deadline exists; retain it before attempt cleanup arms
 * the local idle timer. Non-terminal status deliberately has no such field.
 */
function refreshLeaseIdleDeadline(lease: Lease, message: DirectFileTransferServerMessage): void {
  if (!('idleExpiresAt' in message) || typeof message.idleExpiresAt !== 'number') return;
  lease.idleExpiresAt = message.idleExpiresAt;
  if (!Number.isFinite(lease.idleExpiresAt) || lease.idleExpiresAt <= Date.now()) {
    clearLeaseBinding(lease);
  }
}

function terminalGraceMatches(message: DirectFileTransferServerMessage, grace: TerminalGrace): boolean {
  return 'requestId' in message && message.requestId === grace.requestId
    && 'attemptId' in message && message.attemptId === grace.attemptId
    && 'operationId' in message && message.operationId === grace.operationId
    && 'direction' in message && message.direction === grace.direction
    && 'attempt' in message && message.attempt === grace.attempt;
}

function settleTerminalGrace(lease: Lease, grace: TerminalGrace): void {
  if (lease.terminalGrace.get(grace.requestId) !== grace) return;
  clearTimeout(grace.timer);
  lease.terminalGrace.delete(grace.requestId);
  if (lease.active.size === 0 && lease.terminalGrace.size === 0) armLeaseIdleTimer(lease);
}

function retainTerminalGrace(lease: Lease, active: ActiveAttempt): void {
  if (lease.terminalGrace.has(active.requestId)) return;
  // Never let the original idle deadline dispose a healthy peer while the
  // Server is still relaying the post-data terminal/status control frame.
  clearLeaseTimer(lease);
  const grace = {} as TerminalGrace;
  const timer = setTimeout(() => {
    if (lease.terminalGrace.get(active.requestId) !== grace) return;
    lease.terminalGrace.delete(active.requestId);
    if (lease.active.size === 0 && lease.terminalGrace.size === 0) armLeaseIdleTimer(lease);
  }, DIRECT_FILE_TRANSFER_LIMITS.STATUS_RECOVERY_DEADLINE_MS);
  Object.assign(grace, {
    requestId: active.requestId,
    attemptId: active.attemptId,
    operationId: active.operationId,
    direction: active.direction,
    attempt: active.attempt,
    timer,
  });
  lease.terminalGrace.set(active.requestId, grace);
}

/**
 * Attempt-local listeners must be removed as soon as an ACK/FINISH succeeds.
 * This lease-scoped observer is intentionally retained for the bounded grace
 * window, so a late validated Server terminal/status/error can refresh the
 * authority's idle deadline without replaying an operation.
 */
function observeLateTerminalDeadline(lease: Lease, raw: ServerMessage): void {
  const parsed = validateDirectFileTransferServerMessage(raw);
  if (!parsed.ok) return;
  const message = parsed.value;
  if (message.type !== DIRECT_FILE_TRANSFER_MSG.TERMINAL
    && message.type !== DIRECT_FILE_TRANSFER_MSG.STATUS
    && message.type !== DIRECT_FILE_TRANSFER_MSG.ERROR) return;
  if (!('requestId' in message)) return;
  const grace = lease.terminalGrace.get(message.requestId);
  if (!grace || !terminalGraceMatches(message, grace)) return;
  if (!('idleExpiresAt' in message)) return;
  refreshLeaseIdleDeadline(lease, message);
  settleTerminalGrace(lease, grace);
}

function waitForControl<T extends DirectFileTransferServerMessage>(
  lease: Lease,
  requestId: string,
  predicate: (message: DirectFileTransferServerMessage) => message is T,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: unknown, message?: T) => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      off();
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(message!);
    };
    const onAbort = () => finish(directError(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false));
    const off = lease.ws.onMessage((raw) => {
      const message = parseMatchingControl(raw, requestId);
      if (!message) return;
      if (message.type === DIRECT_FILE_TRANSFER_MSG.ERROR) {
        finish(directError(message.error, message.retryable, message.detail));
        return;
      }
      if (predicate(message)) finish(undefined, message);
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => finish(directError(DIRECT_FILE_TRANSFER_ERROR.NEGOTIATION_TIMEOUT)), timeoutMs);
  });
}

async function ensureLease(lease: Lease): Promise<void> {
  if (lease.leaseId && lease.leaseGeneration && lease.daemonGeneration
    && lease.expiresAt > Date.now() && lease.idleExpiresAt > Date.now()) {
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.LEASE_REUSED, { reused: true });
    await ensureLeasePeer(lease);
    return;
  }
  if (lease.creating) return lease.creating;
  lease.creating = (async () => {
    if (!supportsLease(lease.ws)) throw directError(DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE, false);
    const requestId = crypto.randomUUID();
    const ready = waitForControl(
      lease,
      requestId,
      (message): message is DirectFileTransferLeaseReady => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_READY,
      DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS,
    );
    lease.ws.send({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_INIT,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId,
      serverId: lease.serverId,
      browserTabId: lease.browserTabId,
    });
    leaseFromReady(lease, await ready);
    if (!lease.leaseId) throw directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED);
    await ensureLeasePeer(lease);
  })().finally(() => {
    lease.creating = null;
  });
  return lease.creating;
}

async function rebindLease(lease: Lease): Promise<void> {
  if (!lease.leaseId || !lease.leaseGeneration || !lease.resumeTicket) return ensureLease(lease);
  if (lease.rebinding) return lease.rebinding;
  lease.rebinding = (async () => {
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.REBIND);
    const requestId = crypto.randomUUID();
    const rebound = waitForControl(
      lease,
      requestId,
      (message): message is DirectFileTransferLeaseReady => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND,
      DIRECT_FILE_TRANSFER_LIMITS.STATUS_RECOVERY_DEADLINE_MS,
    );
    lease.ws.send({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId,
      serverId: lease.serverId,
      browserTabId: lease.browserTabId,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      resumeTicket: lease.resumeTicket,
    });
    leaseFromReady(lease, await rebound);
    await ensureLeasePeer(lease);
    for (const active of lease.active.values()) {
      if (!active.authority || !lease.leaseId || !lease.leaseGeneration || !lease.daemonGeneration) continue;
      lease.ws.send({
        type: DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        serverId: lease.serverId,
        browserTabId: lease.browserTabId,
        leaseId: lease.leaseId,
        leaseGeneration: lease.leaseGeneration,
        daemonGeneration: lease.daemonGeneration,
        requestId: active.requestId,
        attemptId: active.attemptId,
        attempt: active.attempt,
        direction: active.direction,
        operationId: active.operationId,
      });
    }
  })().finally(() => {
    lease.rebinding = null;
  });
  return lease.rebinding;
}

function currentBinding(lease: Lease, active: ActiveAttempt) {
  if (!lease.leaseId || !lease.leaseGeneration || !lease.daemonGeneration) {
    throw directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED);
  }
  return {
    serverId: lease.serverId,
    browserTabId: lease.browserTabId,
    leaseId: lease.leaseId,
    leaseGeneration: lease.leaseGeneration,
    daemonGeneration: lease.daemonGeneration,
    requestId: active.requestId,
    attemptId: active.attemptId,
    attempt: active.attempt,
    direction: active.direction,
    operationId: active.operationId,
  };
}

function closePeer(lease: Lease): void {
  try { lease.peer?.close(); } catch { /* best effort */ }
  lease.peer = null;
  lease.peerState = null;
}

function clearLeaseBinding(lease: Lease): void {
  closePeer(lease);
  lease.leaseId = null;
  lease.leaseGeneration = null;
  lease.daemonGeneration = null;
  lease.resumeTicket = null;
  lease.idleExpiresAt = 0;
  lease.expiresAt = 0;
  lease.iceServers = [];
  lease.iceRestartedGeneration = null;
  lease.leaseSignalRequestId = null;
}

function hasLeaseBinding(lease: Lease): lease is Lease & {
  leaseId: string;
  leaseGeneration: number;
  daemonGeneration: number;
} {
  return !!lease.leaseId && !!lease.leaseGeneration && !!lease.daemonGeneration;
}

function leaseSignalMatches(
  message: DirectFileTransferServerMessage,
  lease: Lease,
  requestId: string,
): boolean {
  return message.requestId === requestId
    && hasLeaseBinding(lease)
    && 'leaseId' in message && message.leaseId === lease.leaseId
    && message.leaseGeneration === lease.leaseGeneration
    && message.daemonGeneration === lease.daemonGeneration;
}

/**
 * Establish the file-agnostic lease peer.  This is deliberately separate from
 * operation authorization: File Browser prewarming sends only a tab/daemon
 * lease binding and SDP/ICE, never a path, preview handle, session name, or
 * file authority.
 */
async function ensureLeasePeer(lease: Lease): Promise<void> {
  if (!hasLeaseBinding(lease)) throw directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED);
  if (lease.peer && lease.peer.connectionState !== 'failed' && lease.peer.connectionState !== 'closed') return;
  if (lease.peerCreating) return lease.peerCreating;
  lease.peerCreating = (async () => {
    if (!hasLeaseBinding(lease)) throw directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED);
    const restarting = lease.peer?.connectionState === 'failed';
    if (restarting && lease.iceRestartedGeneration === lease.leaseGeneration) {
      clearLeaseBinding(lease);
      return ensureLease(lease);
    }
    let peer = lease.peer;
    if (!peer || peer.connectionState === 'closed') {
      closePeer(lease);
      peer = new RTCPeerConnection({ iceServers: toBrowserIceServers(lease.iceServers) });
      const createdPeer = peer;
      lease.peer = createdPeer;
      lease.peerState = createdPeer.connectionState;
      createdPeer.addEventListener('connectionstatechange', () => { lease.peerState = createdPeer.connectionState; });
      createdPeer.addEventListener('icecandidate', (event) => {
        if (!event.candidate || !hasLeaseBinding(lease)) return;
        lease.ws.send({
          type: DIRECT_FILE_TRANSFER_MSG.LEASE_ICE,
          protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
          serverId: lease.serverId,
          browserTabId: lease.browserTabId,
          leaseId: lease.leaseId,
          leaseGeneration: lease.leaseGeneration,
          daemonGeneration: lease.daemonGeneration,
          requestId: lease.leaseSignalRequestId ?? crypto.randomUUID(),
          candidate: event.candidate.candidate,
          mid: event.candidate.sdpMid ?? '',
        });
      });
    }
    if (!peer) throw directError(DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED);
    const leasePeer = peer;
    const requestId = crypto.randomUUID();
    lease.leaseSignalRequestId = requestId;
    const candidates = new PendingWebRtcCandidates<RTCIceCandidateInit>();
    const answer = waitForControl(
      lease,
      requestId,
      (message): message is DirectFileTransferLeaseAnswer => (
        message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER && leaseSignalMatches(message, lease, requestId)
      ),
      DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS,
    );
    const off = lease.ws.onMessage((raw) => {
      const message = parseMatchingControl(raw, requestId);
      if (!message || message.type !== DIRECT_FILE_TRANSFER_MSG.LEASE_ICE || !leaseSignalMatches(message, lease, requestId)) return;
      const candidate = { candidate: message.candidate, sdpMid: message.mid };
      if (leasePeer.remoteDescription) void leasePeer.addIceCandidate(candidate).catch(() => undefined);
      else candidates.push(candidate);
    });
    try {
      if (restarting) {
        lease.iceRestartedGeneration = lease.leaseGeneration;
        leasePeer.restartIce();
      }
      const offer = await leasePeer.createOffer(restarting ? { iceRestart: true } : undefined);
      await leasePeer.setLocalDescription(offer);
      if (!hasLeaseBinding(lease)) throw directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED);
      lease.ws.send({
        type: DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        serverId: lease.serverId,
        browserTabId: lease.browserTabId,
        leaseId: lease.leaseId,
        leaseGeneration: lease.leaseGeneration,
        daemonGeneration: lease.daemonGeneration,
        requestId,
        sdp: offer.sdp ?? '',
      });
      const remote = await answer;
      await leasePeer.setRemoteDescription({ type: 'answer', sdp: remote.sdp });
      await candidates.flush((candidate) => leasePeer.addIceCandidate(candidate));
    } catch (error) {
      closePeer(lease);
      if (restarting) clearLeaseBinding(lease);
      throw error instanceof DirectFileTransferFailure
        ? error
        : directError(restarting ? DIRECT_FILE_TRANSFER_ERROR.ICE_RESTART_FAILED : DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED);
    } finally {
      off();
    }
  })().finally(() => {
    lease.peerCreating = null;
  });
  return lease.peerCreating;
}

/**
 * Keep direct-transfer telemetry redacted. WebRTC stats expose the selected
 * candidate *type* without requiring us to retain or report either endpoint.
 * A missing/unsupported report is intentionally reported as unknown rather
 * than pretending every successful peer was direct: TURN-selected pairs must
 * remain visible as relay in aggregate diagnostics.
 */
async function selectedPeerRoute(peer: RTCPeerConnection | null): Promise<DirectConnectivityRoute | 'unknown'> {
  if (!peer) return 'unknown';
  try {
    const stats = await peer.getStats();
    type CandidatePairStat = {
      type?: string;
      selected?: boolean;
      nominated?: boolean;
      state?: string;
      localCandidateId?: string;
      remoteCandidateId?: string;
    };
    type CandidateStat = { candidateType?: string };
    const selectedPairs: CandidatePairStat[] = [];
    stats.forEach((report) => {
      const pair = report as unknown as CandidatePairStat;
      if (pair.type !== 'candidate-pair') return;
      if (pair.selected || (pair.nominated && pair.state === 'succeeded')) selectedPairs.push(pair);
    });
    const selected = selectedPairs[0];
    if (!selected?.localCandidateId || !selected.remoteCandidateId) return 'unknown';
    const local = stats.get(selected.localCandidateId) as unknown as CandidateStat | undefined;
    const remote = stats.get(selected.remoteCandidateId) as unknown as CandidateStat | undefined;
    if (!local?.candidateType || !remote?.candidateType) return 'unknown';
    return local.candidateType === DIRECT_CONNECTIVITY_ROUTE.RELAY || remote.candidateType === DIRECT_CONNECTIVITY_ROUTE.RELAY
      ? DIRECT_CONNECTIVITY_ROUTE.RELAY
      : DIRECT_CONNECTIVITY_ROUTE.DIRECT;
  } catch {
    return 'unknown';
  }
}

function attemptMessageMatches(message: DirectFileTransferServerMessage, active: ActiveAttempt): boolean {
  return message.requestId === active.requestId
    && 'attemptId' in message && message.attemptId === active.attemptId
    && 'operationId' in message && message.operationId === active.operationId;
}


function makeOperationInit(lease: Lease, active: ActiveAttempt, op: DirectAttempt): DirectFileTransferOperationInit {
  const base = currentBinding(lease, active);
  if (op.kind === 'upload') {
    return {
      type: DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...base,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      clientUploadId: op.operationId,
      filename: op.file.name || 'file',
      ...(op.file.type ? { mime: op.file.type } : {}),
      ...(op.sessionName ? { sessionName: op.sessionName } : {}),
      size: op.file.size,
    };
  }
  return {
    type: DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    ...base,
    direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD,
    clientDownloadId: op.operationId,
    previewHandle: op.previewHandle,
    ...(op.sessionName ? { sessionName: op.sessionName } : {}),
  };
}

function waitForChannelOpen(channel: RTCDataChannel, signal?: AbortSignal): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(directError(DIRECT_FILE_TRANSFER_ERROR.NEGOTIATION_TIMEOUT)), DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS);
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onOpen = () => finish();
    const onClose = () => finish(directError(DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED));
    const onAbort = () => finish(directError(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false));
    channel.addEventListener('open', onOpen, { once: true });
    channel.addEventListener('close', onClose, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForBufferedAmount(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount <= DIRECT_FILE_TRANSFER_LIMITS.DATA_BUFFER_HIGH_WATER_BYTES) return Promise.resolve();
  channel.bufferedAmountLowThreshold = DIRECT_FILE_TRANSFER_LIMITS.DATA_BUFFER_LOW_WATER_BYTES;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(directError(DIRECT_FILE_TRANSFER_ERROR.NO_PROGRESS_TIMEOUT)), DIRECT_FILE_TRANSFER_LIMITS.NO_PROGRESS_TIMEOUT_MS);
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      channel.removeEventListener('bufferedamountlow', onLow);
      channel.removeEventListener('close', onClose);
      if (error) reject(error); else resolve();
    };
    const onLow = () => finish();
    const onClose = () => finish(directError(DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED));
    channel.addEventListener('bufferedamountlow', onLow, { once: true });
    channel.addEventListener('close', onClose, { once: true });
  });
}

function sendData(channel: RTCDataChannel, message: object): void {
  channel.send(JSON.stringify(message));
}

function makeDataBinding(lease: Lease, active: ActiveAttempt) {
  const current = currentBinding(lease, active);
  if (active.daemonGeneration === null) throw directError(DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false);
  // A control-plane rebind can switch the lease's current daemon generation
  // while this already-authorized channel is still carrying FINISH/CREDIT or
  // CANCEL. Its one-time authority remains bound to the original generation.
  return { ...current, daemonGeneration: active.daemonGeneration };
}

async function pumpUpload(
  channel: RTCDataChannel,
  lease: Lease,
  active: ActiveAttempt,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  let offset = 0;
  while (offset < file.size) {
    await waitForBufferedAmount(channel);
    const end = Math.min(file.size, offset + DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES);
    channel.send(await file.slice(offset, end).arrayBuffer());
    offset = end;
    onProgress?.(file.size ? Math.round((offset / file.size) * 100) : 100);
  }
  recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.BYTES, {
    direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
    bytes: file.size,
  });
  sendData(channel, {
    type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    ...makeDataBinding(lease, active),
    totalBytes: file.size,
  });
}

async function runAttempt(lease: Lease, op: DirectAttempt, attempt: number): Promise<OperationSuccess> {
  await ensureLease(lease);
  const active: ActiveAttempt = {
    requestId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    operationId: op.operationId,
    direction: op.kind === 'upload' ? DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD : DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD,
    attempt,
    daemonGeneration: null,
    authority: null,
    channel: null,
    signal: op.signal,
  };
  lease.active.set(active.requestId, active);
  clearLeaseTimer(lease);
  recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.ATTEMPT, {
    direction: active.direction,
    attempt,
  });
  const cleanup = () => {
    lease.active.delete(active.requestId);
    try { active.channel?.close(); } catch { /* terminal/peer may already close it */ }
    active.channel = null;
    if (lease.active.size === 0 && lease.terminalGrace.size === 0) armLeaseIdleTimer(lease);
  };
  const cancel = () => {
    if (!active.authority) return;
    try {
      lease.ws.send({
        type: DIRECT_FILE_TRANSFER_MSG.CANCEL,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        ...makeDataBinding(lease, active),
        authority: active.authority,
        reason: DIRECT_FILE_TRANSFER_ERROR.CANCELED,
      });
    } catch { /* best effort */ }
  };
  let downloadWriterAborted = false;
  const abortDownloadWriter = async (error: unknown) => {
    if (op.kind !== 'download' || downloadWriterAborted) return;
    downloadWriterAborted = true;
    await op.writer.abort(error).catch(() => undefined);
  };
  try {
    const init = makeOperationInit(lease, active, op);
    const authorizedPromise = waitForControl(
      lease,
      active.requestId,
      (message): message is DirectFileTransferAuthorized => message.type === DIRECT_FILE_TRANSFER_MSG.AUTHORIZED && attemptMessageMatches(message, active),
      DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS,
      op.signal,
    );
    lease.ws.send(init);
    const authorized = await authorizedPromise;
    const parsed = validateDirectFileTransferAuthorized(authorized);
    if (!parsed.ok) throw directError(DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false);
    active.daemonGeneration = parsed.value.daemonGeneration;
    active.authority = parsed.value.authority;
    // The peer was established from lease-only SDP/ICE during File Browser
    // prewarm. Operation authorization merely allocates a data channel on that
    // reusable peer, so no file authority ever appears in an offer or ICE.
    await ensureLeasePeer(lease);
    const peer = lease.peer;
    if (!peer) throw directError(DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED);
    const channel = peer.createDataChannel(parsed.value.channelLabel, { ordered: true });
    channel.binaryType = 'arraybuffer';
    active.channel = channel;
    await waitForChannelOpen(channel, op.signal);

    const result = await new Promise<OperationSuccess>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      let started = false;
      let received = 0;
      let expected = -1;
      let writeChain: Promise<void> = Promise.resolve();
      const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => finish(directError(DIRECT_FILE_TRANSFER_ERROR.NO_PROGRESS_TIMEOUT)), DIRECT_FILE_TRANSFER_LIMITS.NO_PROGRESS_TIMEOUT_MS);
      };
      const finish = (error?: unknown, value?: OperationSuccess) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        offControl();
        channel.removeEventListener('message', onData);
        channel.removeEventListener('close', onClose);
        channel.removeEventListener('error', onError);
        op.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(value!);
      };
      const fail = (error: unknown) => {
        if (op.kind === 'download') {
          void abortDownloadWriter(error).finally(() => finish(error));
        } else finish(error);
      };
      const onAbort = () => fail(directError(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false));
      const onClose = () => fail(directError(DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED));
      const onError = () => fail(directError(DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED));
      const downloadOp = op.kind === 'download' ? op : null;
      const completeDownload = async (declaredTotalBytes: number) => {
        if (!downloadOp) throw directError(DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR, false);
        await writeChain;
        if (expected < 0 || declaredTotalBytes !== expected || received !== expected) {
          throw directError(DIRECT_FILE_TRANSFER_ERROR.SIZE_MISMATCH, false);
        }
        try {
          await downloadOp.writer.close();
        } catch (error) {
          throw directError(DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, false, error instanceof Error ? error.message : undefined);
        }
        recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.BYTES, {
          direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD,
          bytes: received,
        });
        downloadOp.onProgress?.({ loadedBytes: received, totalBytes: expected });
        sendData(channel, {
          type: DIRECT_FILE_TRANSFER_DATA_MSG.DOWNLOAD_COMMITTED,
          protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
          ...makeDataBinding(lease, active),
          totalBytes: received,
        });
        retainTerminalGrace(lease, active);
        finish(undefined, { kind: 'download' });
      };
      const onData = (event: MessageEvent) => {
        if (typeof event.data !== 'string') {
          if (op.kind !== 'download' || !started || expected < 0) {
            fail(directError(DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST, false));
            return;
          }
          const bytes = event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : ArrayBuffer.isView(event.data)
              ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
              : new Uint8Array(event.data as ArrayBuffer);
          if (received + bytes.byteLength > expected) {
            fail(directError(DIRECT_FILE_TRANSFER_ERROR.SIZE_MISMATCH, false));
            return;
          }
          writeChain = writeChain.then(async () => {
            try {
              // Copy into an ordinary ArrayBuffer.  DOM WebRTC can surface a
              // SharedArrayBuffer-backed view, while File System Access only
              // accepts the non-shared BufferSource union.
              const writableBytes = new Uint8Array(bytes.byteLength);
              writableBytes.set(bytes);
              await op.writer.write(writableBytes.buffer);
            } catch (error) {
              throw directError(DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, false, error instanceof Error ? error.message : undefined);
            }
            received += bytes.byteLength;
            op.onProgress?.({ loadedBytes: received, totalBytes: expected });
            arm();
            sendData(channel, {
              type: DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT,
              protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
              ...makeDataBinding(lease, active),
              creditBytes: bytes.byteLength,
            });
          }).catch(fail);
          return;
        }
        let raw: unknown;
        try { raw = JSON.parse(event.data); } catch { raw = null; }
        const parsedData = validateDirectFileTransferDataMessage(raw);
        if (!parsedData.ok) return;
        const data = parsedData.value as DirectFileTransferDataMessage;
        if (!('requestId' in data) || data.requestId !== active.requestId || data.attemptId !== active.attemptId) return;
        arm();
        if (data.type === DIRECT_FILE_TRANSFER_DATA_MSG.ERROR) {
          fail(directError(data.error));
          return;
        }
        if (op.kind === 'upload') {
          if (data.type === DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED && !started) {
            started = true;
            op.onConnected?.();
            void pumpUpload(channel, lease, active, op.file, op.onProgress).catch(fail);
            return;
          }
          if (data.type === DIRECT_FILE_TRANSFER_DATA_MSG.UPLOAD_COMMITTED) {
            op.onProgress?.(100);
            retainTerminalGrace(lease, active);
            finish(undefined, { kind: 'upload', attachment: data.attachment as AttachmentRefResponse });
          }
          return;
        }
        if (data.type === DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED && !started && data.direction === DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD) {
          started = true;
          expected = data.size;
          op.onConnected?.();
          op.onProgress?.({ loadedBytes: 0, totalBytes: expected });
          sendData(channel, {
            type: DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT,
            protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
            ...makeDataBinding(lease, active),
            creditBytes: Math.min(expected || 1, DIRECT_FILE_TRANSFER_LIMITS.DATA_CREDIT_BYTES),
          });
          return;
        }
        if (data.type === DIRECT_FILE_TRANSFER_DATA_MSG.FINISH && data.direction === DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD) {
          void completeDownload(data.totalBytes).catch(fail);
        }
      };
      const offControl = lease.ws.onMessage((raw) => {
        const message = parseMatchingControl(raw, active.requestId);
        if (!message) return;
        if (!attemptMessageMatches(message, active)) return;
        if (message.type === DIRECT_FILE_TRANSFER_MSG.ERROR) {
          refreshLeaseIdleDeadline(lease, message);
          fail(directError(message.error, message.retryable, message.detail));
          return;
        }
        if (message.type === DIRECT_FILE_TRANSFER_MSG.TERMINAL) {
          refreshLeaseIdleDeadline(lease, message);
          if (message.state === DIRECT_FILE_TRANSFER_OPERATION_STATE.COMMITTED && op.kind === 'upload' && message.attachment) {
            finish(undefined, { kind: 'upload', attachment: message.attachment as AttachmentRefResponse });
          } else if (message.state !== DIRECT_FILE_TRANSFER_OPERATION_STATE.COMMITTED) {
            fail(directError(message.error ?? DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR));
          }
          return;
        }
        if (message.type !== DIRECT_FILE_TRANSFER_MSG.STATUS) return;
        recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.STATUS_RECOVERED, {
          direction: active.direction,
          attempt: active.attempt,
        });
        // Status recovery is authoritative after a server reconnect. It must
        // settle the already-started operation, never create another channel
        // or replay START (which could duplicate an upload/download).
        if (message.state === DIRECT_FILE_TRANSFER_OPERATION_STATE.COMMITTED) {
          refreshLeaseIdleDeadline(lease, message);
          if (op.kind === 'upload' && message.attachment) {
            finish(undefined, { kind: 'upload', attachment: message.attachment as AttachmentRefResponse });
          } else if (op.kind === 'download') {
            finish(undefined, { kind: 'download' });
          } else {
            fail(directError(DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR));
          }
          return;
        }
        if (message.state === DIRECT_FILE_TRANSFER_OPERATION_STATE.NOT_FOUND) {
          refreshLeaseIdleDeadline(lease, message);
          fail(directError(DIRECT_FILE_TRANSFER_ERROR.OPERATION_NOT_FOUND, false));
        } else if (message.state === DIRECT_FILE_TRANSFER_OPERATION_STATE.CANCELED) {
          refreshLeaseIdleDeadline(lease, message);
          fail(directError(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false));
        } else if (message.state === DIRECT_FILE_TRANSFER_OPERATION_STATE.FAILED) {
          refreshLeaseIdleDeadline(lease, message);
          fail(directError(DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR));
        }
        // AUTHORIZING/ATTEMPTING/STREAMING/awaiting-ack remain in-flight;
        // their existing channel resumes naturally without retransmission.
      });
      channel.addEventListener('message', onData);
      channel.addEventListener('close', onClose, { once: true });
      channel.addEventListener('error', onError, { once: true });
      op.signal?.addEventListener('abort', onAbort, { once: true });
      sendData(channel, {
        type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        ...makeDataBinding(lease, active),
        authority: parsed.value.authority,
      });
      arm();
    });
    return result;
  } catch (error) {
    if (error instanceof DirectFileTransferFailure && error.code === DIRECT_FILE_TRANSFER_ERROR.CANCELED) {
      recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.CANCELED, { direction: active.direction, attempt });
      // Local abort settles the UI before the Server's synthetic canceled
      // terminal arrives. Preserve the binding long enough to accept its
      // fresh idle deadline instead of disposing the reusable peer at the
      // original pre-operation deadline.
      if (active.authority) retainTerminalGrace(lease, active);
    }
    cancel();
    await abortDownloadWriter(error);
    throw error;
  } finally {
    cleanup();
  }
}

function retryDelay(attempt: number): number {
  const base = DIRECT_FILE_TRANSFER_LIMITS.RETRY_BACKOFF_MS[attempt - 1] ?? 0;
  return base + Math.round(base * DIRECT_FILE_TRANSFER_LIMITS.RETRY_MAX_POSITIVE_JITTER_RATIO * Math.random());
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(), ms);
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish(directError(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function failureDisposition(error: unknown, attemptsUsed: number) {
  if (!(error instanceof DirectFileTransferFailure)) {
    return attemptsUsed < DIRECT_FILE_TRANSFER_LIMITS.MAX_ATTEMPTS
      ? DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.RETRY_DIRECT
      : DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.HTTP_FALLBACK;
  }
  const directCode = Object.values(DIRECT_FILE_TRANSFER_ERROR).find((value) => value === error.code);
  if (!directCode || !error.retryable) return DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.TERMINAL;
  return classifyDirectFileTransferFailure(directCode, attemptsUsed);
}

function isTerminalDirectFailure(error: unknown, attemptsUsed = DIRECT_FILE_TRANSFER_LIMITS.MAX_ATTEMPTS): boolean {
  return failureDisposition(error, attemptsUsed) === DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.TERMINAL;
}

async function retryDirect<T>(
  lease: Lease,
  createOperation: (attempt: number) => Promise<DirectAttempt> | DirectAttempt,
  signal?: AbortSignal,
): Promise<T> {
  let last: unknown = directError(DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR);
  for (let attempt = 1; attempt <= DIRECT_FILE_TRANSFER_LIMITS.MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await wait(retryDelay(attempt - 1), signal);
    try {
      return await runAttempt(lease, await createOperation(attempt), attempt) as T;
    } catch (error) {
      last = error;
      const disposition = failureDisposition(error, attempt);
      if (disposition !== DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.RETRY_DIRECT) {
        if (disposition === DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.HTTP_FALLBACK) {
          recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.RETRY_EXHAUSTED, { attempt });
        }
        throw error;
      }
    }
  }
  throw last;
}

export async function uploadFileDirect(
  ws: WsClient,
  file: File,
  clientUploadId: string,
  onProgress?: (pct: number) => void,
  onConnected?: () => void,
  signal?: AbortSignal,
  sessionName?: string,
  serverId?: string,
): Promise<{ ok: true; attachment: AttachmentRefResponse }> {
  if (!serverId || !supportsUpload(ws)) throw directError(DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE, false);
  const { lease, release } = acquireLease(ws, serverId);
  try {
    const result = await retryDirect<OperationSuccess>(lease, () => ({
      kind: 'upload', file, operationId: clientUploadId, sessionName, onProgress, onConnected, signal,
    }), signal);
    if (result.kind !== 'upload') throw directError(DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR, false);
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.DIRECT_SUCCESS, {
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      route: await selectedPeerRoute(lease.peer),
    });
    return { ok: true, attachment: result.attachment };
  } finally {
    release();
  }
}

export async function uploadFileWithDirectFallback(options: {
  ws: WsClient | null;
  serverId: string;
  sessionName?: string;
  file: File;
  onProgress?: (pct: number) => void;
  onMode?: (mode: FileUploadTransportMode) => void;
  signal?: AbortSignal;
  destinationDirectory?: string;
}): Promise<{ ok: boolean; attachment: AttachmentRefResponse }> {
  const clientUploadId = crypto.randomUUID();
  if (options.ws && supportsUpload(options.ws) && !options.destinationDirectory) {
    options.onMode?.(FILE_UPLOAD_TRANSPORT_MODE.CONNECTING);
    try {
      const direct = await uploadFileDirect(
        options.ws,
        options.file,
        clientUploadId,
        options.onProgress,
        () => options.onMode?.(FILE_UPLOAD_TRANSPORT_MODE.DIRECT),
        options.signal,
        options.sessionName,
        options.serverId,
      );
      return direct;
    } catch (error) {
      if (options.signal?.aborted || isFileUploadCanceled(error) || isTerminalDirectFailure(error)) throw error;
      if (options.file.size > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
        throw directError(DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR, false, 'relay_size_limit');
      }
      options.onMode?.(FILE_UPLOAD_TRANSPORT_MODE.FALLING_BACK);
    }
  } else if (options.file.size > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
    throw directError(DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR, false, 'relay_size_limit');
  }
  options.onMode?.(FILE_UPLOAD_TRANSPORT_MODE.RELAY);
  if (options.destinationDirectory !== undefined) {
    return uploadFile(options.serverId, options.file, options.onProgress, clientUploadId, options.signal, options.sessionName, options.destinationDirectory);
  }
  return options.sessionName
    ? uploadFile(options.serverId, options.file, options.onProgress, clientUploadId, options.signal, options.sessionName)
    : uploadFile(options.serverId, options.file, options.onProgress, clientUploadId, options.signal);
}

export async function selectPreviewDownloadDestination(suggestedName?: string): Promise<DirectPreviewDownloadDestination | null> {
  const picker = (globalThis as typeof globalThis & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) return null;
  try {
    return { handle: await picker({ ...(suggestedName ? { suggestedName } : {}) }) };
  } catch (error) {
    // Picker cancellation is a user cancellation, never a retry or HTTP
    // fallback trigger.  The browser exposes AbortError for it.
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw directError(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false, 'save_picker_canceled');
    }
    throw directError(DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, false, error instanceof Error ? error.message : undefined);
  }
}

async function createPreviewWriter(destination: DirectPreviewDownloadDestination): Promise<FileSystemWritableFileStreamLike> {
  try {
    return await destination.handle.createWritable();
  } catch (error) {
    throw directError(DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, false, error instanceof Error ? error.message : undefined);
  }
}

export async function downloadPreviewWithDirectFallback(options: {
  ws: WsClient;
  serverId: string;
  previewHandle: string;
  suggestedName?: string;
  sessionName?: string;
  destination?: DirectPreviewDownloadDestination | null;
  /** Kept for the non-FSA/native browser fallback only. */
  httpFallback?: () => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (progress: FileDownloadProgress) => void;
  onMode?: (mode: FileDownloadTransportMode) => void;
}): Promise<void> {
  const destination = options.destination === undefined
    ? await selectPreviewDownloadDestination(options.suggestedName)
    : options.destination;
  if (!destination) {
    // No File System Access API means no safe streaming sink.  Keep the
    // established HTTP browser download as the only fallback and do not start
    // an unbounded Blob/direct transfer.
    options.onMode?.(FILE_DOWNLOAD_TRANSPORT_MODE.BROWSER);
    await (options.httpFallback ?? (() => downloadAttachment(options.serverId, options.previewHandle, options.sessionName, options.signal))());
    return;
  }
  if (supportsPreviewDownload(options.ws)) {
    options.onMode?.(FILE_DOWNLOAD_TRANSPORT_MODE.CONNECTING);
    const { lease, release } = acquireLease(options.ws, options.serverId);
    try {
      const operationId = crypto.randomUUID();
      await retryDirect<OperationSuccess>(lease, async () => ({
        kind: 'download',
        previewHandle: options.previewHandle,
        operationId,
        sessionName: options.sessionName,
        writer: await createPreviewWriter(destination),
        onProgress: options.onProgress,
        onConnected: () => options.onMode?.(FILE_DOWNLOAD_TRANSPORT_MODE.DIRECT),
        signal: options.signal,
      }), options.signal);
      recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.DIRECT_SUCCESS, {
        direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD,
        route: await selectedPeerRoute(lease.peer),
      });
      return;
    } catch (error) {
      if (isTerminalDirectFailure(error)) throw error;
      // Exactly one HTTP fallback after the full direct budget. It reuses the
      // already user-approved destination and streams response chunks instead
      // of constructing a Blob.
      const writer = await createPreviewWriter(destination);
      try {
        options.onMode?.(FILE_DOWNLOAD_TRANSPORT_MODE.FALLING_BACK);
        let httpStarted = false;
        await streamAttachmentDownloadToWritable(
          options.serverId,
          options.previewHandle,
          writer,
          options.sessionName,
          options.signal,
          (progress) => {
            if (!httpStarted) {
              httpStarted = true;
              options.onMode?.(FILE_DOWNLOAD_TRANSPORT_MODE.HTTP);
            }
            options.onProgress?.(progress);
          },
        );
        await writer.close();
        return;
      } catch (fallbackError) {
        await writer.abort(fallbackError).catch(() => undefined);
        throw fallbackError;
      }
    } finally {
      release();
    }
  }
  const writer = await createPreviewWriter(destination);
  try {
    options.onMode?.(FILE_DOWNLOAD_TRANSPORT_MODE.HTTP);
    await streamAttachmentDownloadToWritable(options.serverId, options.previewHandle, writer, options.sessionName, options.signal, options.onProgress);
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw error;
  }
}

export function isDirectFileTransferStaleHandleError(error: unknown): boolean {
  return error instanceof DirectFileTransferFailure
    && (error.code === DIRECT_FILE_TRANSFER_ERROR.PREVIEW_HANDLE_INVALID
      || error.code === DIRECT_FILE_TRANSFER_ERROR.OPERATION_NOT_FOUND);
}

export function isFileUploadCanceled(error: unknown): boolean {
  return (error instanceof DirectFileTransferFailure && error.code === DIRECT_FILE_TRANSFER_ERROR.CANCELED)
    || (error instanceof Error && error.name === 'AbortError');
}

/**
 * The legacy v1 connectivity probe was intentionally removed. A v2 health
 * probe establishes or reuses an inert lease only after the user opens the
 * diagnostics view; it never carries file authority or falls back to v1.
 */
export async function probeDirectConnectivity(
  ws: WsClient,
  onDiagnostics?: (diagnostics: DirectConnectivityProbeDiagnostics) => void,
  serverId?: string,
): Promise<DirectConnectivityProbeResult> {
  if (!serverId || !supportsLease(ws)) throw directError(DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE, false);
  const { lease, release } = acquireLease(ws, serverId);
  try {
    await ensureLease(lease);
    const peer = lease.peer;
    if (!peer || peer.connectionState !== 'connected' || !lease.leaseId || !lease.leaseGeneration || !lease.daemonGeneration) {
      throw directError(DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE, false);
    }
    onDiagnostics?.({
      stage: DIRECT_CONNECTIVITY_PROBE_STAGE.VERIFYING,
      browserCandidateTypes: [],
      daemonCandidateTypes: [],
    });
    const channel = peer.createDataChannel(`imcodes-health-${crypto.randomUUID()}`, { ordered: true });
    await waitForChannelOpen(channel);
    const nonce = crypto.randomUUID();
    const started = performance.now();
    const result = await new Promise<DirectConnectivityProbeResult>((resolve, reject) => {
      const timer = setTimeout(() => done(directError(DIRECT_FILE_TRANSFER_ERROR.NO_PROGRESS_TIMEOUT)), DIRECT_FILE_TRANSFER_LIMITS.PROBE_TIMEOUT_MS);
      const done = (error?: unknown, value?: DirectConnectivityProbeResult) => {
        clearTimeout(timer);
        channel.removeEventListener('message', onMessage);
        try { channel.close(); } catch { /* best effort */ }
        if (error) reject(error); else resolve(value!);
      };
      const onMessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return;
        let raw: unknown;
        try { raw = JSON.parse(event.data); } catch { raw = null; }
        const parsed = validateDirectFileTransferDataMessage(raw);
        if (!parsed.ok || parsed.value.type !== DIRECT_FILE_TRANSFER_DATA_MSG.HEALTH_PONG || parsed.value.nonce !== nonce) return;
        done(undefined, {
          route: classifyDirectConnectivityRoute(parsed.value.localCandidate, parsed.value.remoteCandidate),
          rttMs: Math.max(0, performance.now() - started),
          localCandidate: parsed.value.localCandidate,
          remoteCandidate: parsed.value.remoteCandidate,
        });
      };
      channel.addEventListener('message', onMessage);
      sendData(channel, {
        type: DIRECT_FILE_TRANSFER_DATA_MSG.HEALTH_PROBE,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        serverId: lease.serverId,
        browserTabId: lease.browserTabId,
        leaseId: lease.leaseId,
        leaseGeneration: lease.leaseGeneration,
        daemonGeneration: lease.daemonGeneration,
        nonce,
      });
    });
    onDiagnostics?.({ stage: DIRECT_CONNECTIVITY_PROBE_STAGE.COMPLETE, browserCandidateTypes: [], daemonCandidateTypes: [] });
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.ROUTE, { route: result.route });
    return result;
  } finally {
    release();
  }
}
