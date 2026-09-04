import {
  directFileTransferAttemptBindingMatches,
  type DirectFileTransferAttemptBinding,
  DIRECT_CONNECTIVITY_PROBE_STAGE,
  DIRECT_CONNECTIVITY_ROUTE,
  DIRECT_FILE_CONNECTION_STATUS,
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_DIRECTION,
  DIRECT_FILE_TRANSFER_DIRECTORY_UPLOAD_CAPABILITY,
  DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION,
  DIRECT_FILE_TRANSFER_ERROR,
  DIRECT_FILE_TRANSFER_HEALTH_CHANNEL_PREFIX,
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
  type DirectConnectivityCandidateType,
  type DirectFileConnectionStatus,
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
  readWebRtcCandidateType,
  toWebRtcIceServers,
} from '@shared/webrtc-connectivity.js';
import { FILE_TRANSFER_LIMITS } from '@shared/transport/file-transfer.js';
import {
  downloadAttachment,
  streamAttachmentDownloadToWritable,
  uploadFile,
  type AttachmentRefResponse,
} from './api.js';
import { canUseNativeFileShare, shareBlobOrDownload } from './browser-download.js';
import { isNative } from './native.js';
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
  /** Why a lease peer was reused, restarted or rebuilt for an operation. */
  PEER: 'peer',
  /** Wall time of one establishment stage, so a slow upload can be attributed. */
  STAGE: 'stage',
} as const;

/**
 * Why `ensureLeasePeer` took the branch it did.
 *
 * Establishment previously reported nothing between "lease reused" and "bytes
 * flowing", so a slow upload could not be attributed: an operation waiting on
 * authorization looked exactly like one waiting on ICE. These reasons name the
 * decision itself.
 */
export const DIRECT_FILE_TRANSFER_PEER_REASON = {
  /** Live peer from a previous probe/operation carried the new channel. */
  REUSED: 'reused',
  /** Another caller was already building it; we joined that attempt. */
  JOINED_PENDING: 'joined_pending',
  /** No peer yet, or the old one was closed. */
  BUILT_COLD: 'built_cold',
  /** Peer was failed/disconnected; bounded ICE restart on the same lease. */
  ICE_RESTART: 'ice_restart',
  /** ICE restart already spent on this generation; full lease re-init. */
  LEASE_REINIT: 'lease_reinit',
} as const;

/** Establishment stages, in the order an operation passes through them. */
export const DIRECT_FILE_TRANSFER_STAGE = {
  OPERATION_AUTHORIZE: 'operation_authorize',
  PEER_READY: 'peer_ready',
  CHANNEL_OPEN: 'channel_open',
  FIRST_CHUNK: 'first_chunk',
} as const;

type DirectFileTransferClientMetric = typeof DIRECT_FILE_TRANSFER_CLIENT_METRIC[keyof typeof DIRECT_FILE_TRANSFER_CLIENT_METRIC];

type DirectFileTransferMetricFields = {
  direction?: DirectFileTransferDirection;
  attempt?: number;
  bytes?: number;
  /** Candidate type only; never an address, port, id, or URL. */
  route?: DirectConnectivityRoute | 'unknown';
  reused?: boolean;
  /** One of DIRECT_FILE_TRANSFER_PEER_REASON; never free text. */
  reason?: string;
  /** One of DIRECT_FILE_TRANSFER_STAGE. */
  stage?: string;
  elapsedMs?: number;
};

function recordDirectFileTransferMetric(metric: DirectFileTransferClientMetric, fields: DirectFileTransferMetricFields = {}): void {
  // Best-effort local telemetry only; failure to log must never affect transfer.
  try { console.debug('[direct-file-transfer]', { metric, ...fields }); } catch { /* no console */ }
}

function reportProbeStage(
  onDiagnostics: ((diagnostics: DirectConnectivityProbeDiagnostics) => void) | undefined,
  stage: DirectConnectivityProbeDiagnostics['stage'],
  lease?: Lease,
): void {
  onDiagnostics?.({
    stage,
    browserCandidateTypes: [...(lease?.browserCandidateTypes ?? [])],
    daemonCandidateTypes: [...(lease?.daemonCandidateTypes ?? [])],
  });
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
  bootstrapChannel: RTCDataChannel | null;
  /** Live subscription to the daemon's trickled ICE, torn down with the peer. */
  leaseIceOff: (() => void) | null;
  /** Redacted candidate kinds retained for diagnostics; never addresses. */
  browserCandidateTypes: Set<DirectConnectivityCandidateType>;
  daemonCandidateTypes: Set<DirectConnectivityCandidateType>;
  peerState: RTCPeerConnectionState | null;
  refs: number;
  /** Mounted attachment surfaces waiting for (or retaining) a warm peer. */
  prewarmRefs: number;
  connectionStatus: DirectFileConnectionStatus;
  connectionStatusListeners: Set<(status: DirectFileConnectionStatus) => void>;
  warming: Promise<void> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  creating: Promise<void> | null;
  rebinding: Promise<void> | null;
  iceRestartedGeneration: number | null;
  peerCreating: Promise<void> | null;
  /** Daemon generation the live peer was negotiated against. A warm transport
   *  is valid only for the lease that created it. After lease expiry or a
   *  daemon restart the far side is gone and reusing it would hang every new
   *  channel. */
  peerDaemonGeneration: number | null;
  leaseSignalRequestId: string | null;
  /**
   * Browser WebSocket lifecycle generation. Any lease/SDP wait started on an
   * older control socket must be rejected when that socket is torn down;
   * otherwise a resumed mobile app keeps awaiting a promise that can only be
   * satisfied by frames from the dead socket.
   */
  controlEpoch: number;
  controlAbort: AbortController;
  unsubscribeCapability: (() => void) | null;
  unsubscribeTerminalObserver: (() => void) | null;
  active: Map<string, ActiveAttempt>;
  terminalGrace: Map<string, TerminalGrace>;
};

/**
 * Receiver-confirmed progress for an upload attempt.
 *
 * The upload direction had no receiver-to-sender signal during transfer:
 * UPLOAD_COMMITTED is a terminal message carrying the finished attachment, and
 * CREDIT was validated for DOWNLOAD only. So the sender judged liveness purely
 * from its own `bufferedAmount`, which cannot separate "the peer is committing
 * steadily but slowly" from "the peer is gone" — and a single drain slower than
 * the no-progress budget killed a transfer that was in fact advancing.
 */
type UploadCommitTracker = {
  committedBytes: number;
  /** Incremented on every advance so a sleeping waiter can tell it moved. */
  advances: number;
  /** Bytes this attempt has actually handed to the channel, resume prefix
   *  included. A receiver cannot have committed more than was sent. */
  sentBytes: number;
  /** Total size of the file, so an ACK past the end is rejected. */
  totalBytes: number;
  /** Set once an ACK proves impossible; the pump stops rather than trusting it. */
  fatal?: DirectFileTransferFailure;
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
  /** Present for uploads only; fed by the daemon's committed-offset reports. */
  uploadCommit?: UploadCommitTracker;
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
  /**
   * Byte offset the NEXT attempt of this operation may continue from.
   *
   * Only ever set from an offset the previous attempt saw confirmed on its own
   * live channel, so a replacement never inherits a number it could not verify.
   * A transient channel/ICE loss then costs the remaining bytes instead of the
   * whole file (and instead of falling back to the relay with all of them).
   */
  resumeFromBytes?: number;
  sessionName?: string;
  destinationDirectory?: string;
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

function supportsDirectoryUpload(ws: WsClient): boolean {
  return supportsCapabilities(ws, [
    DIRECT_FILE_TRANSFER_LEASE_CAPABILITY,
    DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY,
    DIRECT_FILE_TRANSFER_DIRECTORY_UPLOAD_CAPABILITY,
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
    bootstrapChannel: null,
    leaseIceOff: null,
    browserCandidateTypes: new Set(),
    daemonCandidateTypes: new Set(),
    peerState: null,
    refs: 0,
    prewarmRefs: 0,
    connectionStatus: DIRECT_FILE_CONNECTION_STATUS.NONE,
    connectionStatusListeners: new Set(),
    warming: null,
    idleTimer: null,
    creating: null,
    rebinding: null,
    iceRestartedGeneration: null,
    peerCreating: null,
    peerDaemonGeneration: null,
    leaseSignalRequestId: null,
    controlEpoch: 0,
    controlAbort: new AbortController(),
    unsubscribeCapability: null,
    unsubscribeTerminalObserver: null,
    active: new Map(),
    terminalGrace: new Map(),
  };
  // Capability state is scoped to one browser WebSocket. In particular, a
  // null snapshot is not merely a UI hint: every request/SDP waiter registered
  // on the old socket is now impossible to satisfy. Invalidate it immediately
  // so a foregrounded mobile app can create a fresh lease without being held
  // behind a suspended pre-background promise.
  lease.unsubscribeCapability = ws.onDaemonCapabilitySnapshot((snapshot) => {
    if (!snapshot || !snapshot.capabilities.includes(DIRECT_FILE_TRANSFER_LEASE_CAPABILITY)) {
      invalidateLeaseControl(lease);
      return;
    }
    // SessionControls commonly mounts before daemon.hello arrives. The old
    // prewarm path inspected the empty snapshot once and returned forever, so
    // clicking Upload still paid the full cold ICE/DTLS setup. A retained
    // attachment surface is an explicit request to warm as soon as this WS
    // generation advertises the capability.
    if (!lease.leaseId) {
      warmRetainedLease(lease);
      return;
    }
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

function setConnectionStatus(lease: Lease, status: DirectFileConnectionStatus): void {
  if (lease.connectionStatus === status) return;
  lease.connectionStatus = status;
  for (const listener of lease.connectionStatusListeners) listener(status);
}

function disposeLease(lease: Lease): void {
  clearLeaseTimer(lease);
  lease.controlEpoch++;
  lease.controlAbort.abort(directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED));
  lease.creating = null;
  lease.rebinding = null;
  lease.peerCreating = null;
  lease.warming = null;
  for (const active of lease.active.values()) {
    try { active.channel?.close(); } catch { /* best effort */ }
  }
  lease.active.clear();
  for (const grace of lease.terminalGrace.values()) clearTimeout(grace.timer);
  lease.terminalGrace.clear();
  closePeer(lease);
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
  if (lease.active.size !== 0 || lease.terminalGrace.size !== 0
    || lease.creating || lease.rebinding || lease.peerCreating) return;
  clearLeaseTimer(lease);
  // A verified TURN route deliberately retires its lease while retaining the
  // yellow presentation state. There is no authority deadline left to arm;
  // treating the zeroed timestamp as an expiry would immediately erase that
  // truthful route status.
  if (!lease.leaseId) return;
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
    // The daemon destroys the peer together with this lease. The browser must
    // do the same: an apparently-open SCTP channel from the expired lease
    // cannot carry a HEALTH_PROBE for the next lease identity. Rewarm now when
    // an attachment surface is still mounted so the next click remains hot.
    clearLeaseBinding(lease);
    if (lease.prewarmRefs > 0) queueMicrotask(() => warmRetainedLease(lease));
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

function warmRetainedLease(lease: Lease): void {
  if (lease.prewarmRefs === 0 || !supportsLease(lease.ws)) return;
  // Both resolved states are stable until the control socket/network changes.
  // DIRECT retains its peer; RELAY deliberately retains only the result and
  // must not allocate another idle TURN connection on every surface mount.
  if (lease.connectionStatus !== DIRECT_FILE_CONNECTION_STATUS.NONE || lease.warming) return;
  let warming!: Promise<void>;
  warming = (async () => {
    await ensureLease(lease);
    const result = await probeLeasePeer(lease);
    if (result.route === DIRECT_CONNECTIVITY_ROUTE.RELAY) {
      // TURN is a valid P2P path for IPv6/mobile clients, but it must not stay
      // prewarmed while idle. Retire the whole lease rather than only the
      // browser peer: node-datachannel cannot ICE-restart the still-bound
      // daemon peer, so reusing that split lease makes the real upload fail.
      if (lease.active.size === 0) clearLeaseBinding(lease);
      setConnectionStatus(lease, DIRECT_FILE_CONNECTION_STATUS.RELAY);
      return;
    }
    setConnectionStatus(lease, DIRECT_FILE_CONNECTION_STATUS.DIRECT);
  })().catch(() => {
    if (lease.active.size === 0) closePeer(lease);
    setConnectionStatus(lease, DIRECT_FILE_CONNECTION_STATUS.NONE);
  }).finally(() => {
    if (lease.warming === warming) lease.warming = null;
    armLeaseIdleTimer(lease);
  });
  lease.warming = warming;
}

/**
 * Retain and prewarm the inert lease. No file handle, session scope or file
 * authority is sent. If daemon.hello has not arrived yet, the broker waits for
 * that handshake and warms immediately when the capability becomes visible.
 */
export function prewarmDirectFileLease(ws: WsClient, serverId: string): () => void {
  const { lease, release } = acquireLease(ws, serverId);
  lease.prewarmRefs++;
  warmRetainedLease(lease);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lease.prewarmRefs = Math.max(0, lease.prewarmRefs - 1);
    release();
  };
}

export function subscribeDirectFileConnectionStatus(
  ws: WsClient,
  serverId: string,
  listener: (status: DirectFileConnectionStatus) => void,
): () => void {
  const { lease, release } = acquireLease(ws, serverId);
  lease.connectionStatusListeners.add(listener);
  listener(lease.connectionStatus);
  return () => {
    lease.connectionStatusListeners.delete(listener);
    release();
  };
}

/**
 * Retire idle browser WebRTC state after an OS background/foreground cycle.
 *
 * iOS may thaw JavaScript and the control WebSocket while leaving the native
 * ICE/SCTP objects permanently frozen. Their JS-visible state can still say
 * `connected`, so connectionState is not an authority signal on resume. A
 * retained surface is warmed again immediately; a previously verified relay
 * remains yellow and intentionally is not prewarmed.
 */
export function resumeDirectFileTransfers(ws: WsClient, serverId?: string): void {
  const byServer = brokers.get(ws);
  if (!byServer) return;
  for (const lease of byServer.values()) {
    if (serverId && lease.serverId !== serverId) continue;
    if (lease.active.size !== 0 || lease.connectionStatus === DIRECT_FILE_CONNECTION_STATUS.RELAY) continue;
    invalidateLeaseControl(lease);
    if (lease.prewarmRefs > 0) queueMicrotask(() => warmRetainedLease(lease));
  }
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

function startControlWait<T extends DirectFileTransferServerMessage>(
  lease: Lease,
  requestId: string,
  predicate: (message: DirectFileTransferServerMessage) => message is T,
  timeoutMs: number,
  signal?: AbortSignal,
  abortFailure?: DirectFileTransferFailure,
): { promise: Promise<T>; cancel: (error: unknown) => void } {
  let cancel: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: unknown, message?: T) => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      off();
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(message!);
    };
    const onAbort = () => finish(abortFailure ?? directError(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false));
    cancel = (error) => finish(error);
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
  return { promise, cancel };
}

/**
 * Bound browser-native WebRTC promises independently of Server signalling.
 *
 * WebKit can leave createOffer/setLocalDescription/setRemoteDescription
 * pending forever after a long background suspension. The shared
 * peerCreating slot then poisons every later probe and upload until the app is
 * killed, because there is no Server response waiter yet to enforce a
 * deadline. Keep the deadline owned by the shared peer setup (rather than by
 * one upload caller) so timeout always releases that slot and closes the stale
 * RTCPeerConnection for the next attempt.
 */
function waitForPeerNegotiation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(directError(DIRECT_FILE_TRANSFER_ERROR.NEGOTIATION_TIMEOUT)),
      DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS,
    );
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value as T);
    };
    const onAbort = () => finish(directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED));
    signal.addEventListener('abort', onAbort, { once: true });
    // Attaching both continuations also consumes a native promise that settles
    // after our timeout, preventing a late WebKit rejection from becoming an
    // unhandled promise rejection.
    pending.then((value) => finish(undefined, value), (error) => finish(error));
  });
}

async function ensureLease(
  lease: Lease,
  onDiagnostics?: (diagnostics: DirectConnectivityProbeDiagnostics) => void,
): Promise<void> {
  // A fresh daemon capability snapshot starts rebind asynchronously. Do not
  // race a new offer/operation against the Server's PREPARE acknowledgement.
  if (lease.rebinding) await lease.rebinding;
  if (lease.leaseId && lease.leaseGeneration && lease.daemonGeneration
    && lease.expiresAt > Date.now() && lease.idleExpiresAt > Date.now()) {
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.LEASE_REUSED, { reused: true });
    await ensureLeasePeer(lease, onDiagnostics);
    return;
  }
  if (lease.creating) {
    await lease.creating;
    return ensureLeasePeer(lease, onDiagnostics);
  }
  const epoch = lease.controlEpoch;
  const signal = lease.controlAbort.signal;
  let creating!: Promise<void>;
  creating = (async () => {
    if (!supportsLease(lease.ws)) throw directError(DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE, false);
    // retryDirect owns the three-attempt transport budget. Retrying here as
    // well multiplied one stalled lease negotiation into nine long waits
    // before HTTP was allowed (3 lease attempts × 3 operation attempts).
    // One LEASE_INIT/offer per direct attempt keeps the total bounded and
    // guarantees the documented three attempts then exactly one relay path.
    const requestId = crypto.randomUUID();
    const ready = startControlWait(
      lease,
      requestId,
      (candidate): candidate is DirectFileTransferLeaseReady => candidate.type === DIRECT_FILE_TRANSFER_MSG.LEASE_READY,
      DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS,
      signal,
      directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED),
    );
    try {
      sendControl(lease, {
        type: DIRECT_FILE_TRANSFER_MSG.LEASE_INIT,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        requestId,
        serverId: lease.serverId,
        browserTabId: lease.browserTabId,
      });
    } catch (error) {
      ready.cancel(error);
      await ready.promise;
      throw error; // unreachable; preserves narrowing if cancellation changes
    }
    const message = await ready.promise;
    assertCurrentControl(lease, epoch);
    leaseFromReady(lease, message);
    if (!lease.leaseId) throw directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED);
    await ensureLeasePeer(lease, onDiagnostics);
  })().finally(() => {
    if (lease.creating === creating) lease.creating = null;
  });
  lease.creating = creating;
  return creating;
}

async function rebindLease(lease: Lease): Promise<void> {
  if (!lease.leaseId || !lease.leaseGeneration || !lease.resumeTicket) return ensureLease(lease);
  if (lease.rebinding) return lease.rebinding;
  const epoch = lease.controlEpoch;
  const signal = lease.controlAbort.signal;
  let rebinding!: Promise<void>;
  rebinding = (async () => {
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.REBIND);
    const requestId = crypto.randomUUID();
    const rebound = startControlWait(
      lease,
      requestId,
      (candidate): candidate is DirectFileTransferLeaseReady => candidate.type === DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND,
      DIRECT_FILE_TRANSFER_LIMITS.STATUS_RECOVERY_DEADLINE_MS,
      signal,
      directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED),
    );
    try {
      sendControl(lease, {
        type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        requestId,
        serverId: lease.serverId,
        browserTabId: lease.browserTabId,
        leaseId: lease.leaseId,
        leaseGeneration: lease.leaseGeneration,
        resumeTicket: lease.resumeTicket,
      });
    } catch (error) {
      rebound.cancel(error);
      await rebound.promise;
      throw error; // unreachable; preserves narrowing if cancellation changes
    }
    const message = await rebound.promise;
    assertCurrentControl(lease, epoch);
    leaseFromReady(lease, message);
    await ensureLeasePeer(lease);
    for (const active of lease.active.values()) {
      if (!active.authority || !lease.leaseId || !lease.leaseGeneration || !lease.daemonGeneration) continue;
      sendControl(lease, {
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
    if (lease.rebinding === rebinding) lease.rebinding = null;
  });
  lease.rebinding = rebinding;
  return rebinding;
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
  try { lease.leaseIceOff?.(); } catch { /* best effort */ }
  lease.leaseIceOff = null;
  try { lease.bootstrapChannel?.close(); } catch { /* best effort */ }
  lease.bootstrapChannel = null;
  try { lease.peer?.close(); } catch { /* best effort */ }
  lease.peer = null;
  lease.peerState = null;
  lease.peerDaemonGeneration = null;
  lease.browserCandidateTypes.clear();
  lease.daemonCandidateTypes.clear();
  setConnectionStatus(lease, DIRECT_FILE_CONNECTION_STATUS.NONE);
}

/**
 * Retire one lease identity and the transport negotiated for it.
 *
 * The daemon scopes its RTCPeerConnection to leaseId + leaseGeneration and
 * destroys both at idle expiry. Keeping the browser peer while clearing only
 * those fields creates a split identity: the channel still opens locally, but
 * the old daemon peer rejects the next lease's HEALTH_PROBE. On a long-lived
 * mobile app that presented as a permanent 6/7 "verifying" stall until the app
 * was restarted. A new lease must always negotiate a new peer.
 */
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

function invalidateLeaseControl(lease: Lease): void {
  lease.controlEpoch++;
  const stale = lease.controlAbort;
  lease.controlAbort = new AbortController();
  // Clear the ownership slots synchronously. The stale promises use
  // identity-guarded finally handlers below, so they cannot erase a newer
  // request that starts before their rejection microtask runs.
  lease.creating = null;
  lease.rebinding = null;
  lease.peerCreating = null;
  stale.abort(directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED));

  if (lease.active.size === 0) {
    // No data plane has to survive this control reconnect. A clean lease and
    // RTCPeerConnection is both cheaper and safer than trying to infer whether
    // a mobile WebView's old association is still viable.
    //
    clearLeaseBinding(lease);
    return;
  }

  // Active byte streams retain their immutable attempt binding and peer. Only
  // old-socket signalling listeners are impossible to recover; the fresh
  // daemon capability snapshot will rebind the control generation.
  try { lease.leaseIceOff?.(); } catch { /* best effort */ }
  lease.leaseIceOff = null;
  lease.leaseSignalRequestId = null;
}

function assertCurrentControl(lease: Lease, epoch: number): void {
  if (lease.controlEpoch !== epoch || lease.controlAbort.signal.aborted) {
    throw directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED);
  }
}

/**
 * File-transfer control messages are request/response traffic and must never
 * use WsClient.send(), whose fire-and-forget contract intentionally drops
 * frames while a foreground liveness probe has `_connected=false`. The OS
 * socket can still be OPEN in that window; sendUrgent writes to it directly
 * and throws on a genuinely absent socket so retry/HTTP fallback can run.
 */
function sendControl(lease: Lease, message: object): void {
  try {
    lease.ws.sendUrgent(message);
  } catch (error) {
    throw directError(
      DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
      true,
      error instanceof Error ? error.message : undefined,
    );
  }
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
async function ensureLeasePeer(
  lease: Lease,
  onDiagnostics?: (diagnostics: DirectConnectivityProbeDiagnostics) => void,
): Promise<void> {
  if (!hasLeaseBinding(lease)) throw directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED);
  // A second caller must join the negotiation already in flight. The cold
  // peer is assigned before its offer/answer settles, so inspecting it first
  // would mistake `new` plus a connecting bootstrap channel for reusable
  // transport and open an operation channel on an unnegotiated association.
  if (lease.peerCreating) {
    reportProbeStage(onDiagnostics, DIRECT_CONNECTIVITY_PROBE_STAGE.CREATING_OFFER, lease);
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.PEER, {
      reason: DIRECT_FILE_TRANSFER_PEER_REASON.JOINED_PENDING,
    });
    await lease.peerCreating;
    reportProbeStage(onDiagnostics, DIRECT_CONNECTIVITY_PROBE_STAGE.DATA_CHANNEL_OPEN, lease);
    return;
  }
  // Mobile WebViews commonly leave a WebRTC peer in `disconnected` after a
  // long background suspension while the browser-server WebSocket recovers.
  // Reusing that peer makes every new data channel wait on an association that
  // no longer has a viable path; killing the app appeared to fix the issue
  // only because it constructed a fresh RTCPeerConnection. Treat an explicit
  // operation/probe against a disconnected peer as a bounded ICE restart.
  // A warm transport may carry a new operation only when it is both healthy
  // AND still facing the same daemon it was negotiated against.
  const generationMatches = lease.peerDaemonGeneration === null
    || lease.peerDaemonGeneration === lease.daemonGeneration;
  const bootstrapCanCarryData = lease.bootstrapChannel?.readyState === 'open';
  if (lease.peer
    && generationMatches
    && bootstrapCanCarryData
    && lease.peer.connectionState !== 'failed'
    && lease.peer.connectionState !== 'disconnected'
    && lease.peer.connectionState !== 'closed') {
    if (lease.peerDaemonGeneration === null) lease.peerDaemonGeneration = lease.daemonGeneration;
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.PEER, {
      reason: DIRECT_FILE_TRANSFER_PEER_REASON.REUSED,
    });
    reportProbeStage(onDiagnostics, DIRECT_CONNECTIVITY_PROBE_STAGE.DATA_CHANNEL_OPEN, lease);
    return;
  }
  if (lease.peer && (!generationMatches
    || (lease.peer.connectionState !== 'failed'
      && lease.peer.connectionState !== 'disconnected'
      && lease.peer.connectionState !== 'closed'
      && !bootstrapCanCarryData))) {
    // WebKit can retain `connected` after SCTP has closed. The inert bootstrap
    // channel belongs to that same association and is therefore the earliest
    // reliable signal that a new operation channel would wait out the entire
    // open budget. Rebuild now; do not spend a retry on the known-dead peer.
    closePeer(lease);
  }
  const peerNeedsIceRestart = lease.peer?.connectionState === 'failed'
    || lease.peer?.connectionState === 'disconnected';
  if (peerNeedsIceRestart && lease.iceRestartedGeneration === lease.leaseGeneration) {
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.PEER, {
      reason: DIRECT_FILE_TRANSFER_PEER_REASON.LEASE_REINIT,
    });
    // Re-enter before claiming peerCreating. The old implementation did this
    // inside the peerCreating promise; the replacement ensureLeasePeer then
    // joined that same promise and awaited itself forever. On a mobile app's
    // second background disconnect this left diagnostics stuck at 1/7 until
    // the process was killed.
    clearLeaseBinding(lease);
    return ensureLease(lease, onDiagnostics);
  }
  const epoch = lease.controlEpoch;
  const signal = lease.controlAbort.signal;
  let peerCreating!: Promise<void>;
  peerCreating = (async () => {
    assertCurrentControl(lease, epoch);
    if (!hasLeaseBinding(lease)) throw directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED);
    const restarting = lease.peer?.connectionState === 'failed'
      || lease.peer?.connectionState === 'disconnected';
    let peer = lease.peer;
    reportProbeStage(onDiagnostics, DIRECT_CONNECTIVITY_PROBE_STAGE.CREATING_OFFER, lease);
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.PEER, {
      reason: restarting
        ? DIRECT_FILE_TRANSFER_PEER_REASON.ICE_RESTART
        : DIRECT_FILE_TRANSFER_PEER_REASON.BUILT_COLD,
    });
    if (!peer || peer.connectionState === 'closed') {
      closePeer(lease);
      peer = new RTCPeerConnection({ iceServers: toBrowserIceServers(lease.iceServers) });
      const createdPeer = peer;
      lease.peer = createdPeer;
      lease.peerState = createdPeer.connectionState;
      lease.peerDaemonGeneration = lease.daemonGeneration;
      // A cold RTCPeerConnection has no application m-line until a data
      // channel exists. Creating this authority-free lease channel before the
      // first offer makes the initial SDP acceptable to node-datachannel and
      // lets later operation channels open without a second negotiation.
      lease.bootstrapChannel = createdPeer.createDataChannel(
        `${DIRECT_FILE_TRANSFER_HEALTH_CHANNEL_PREFIX}${crypto.randomUUID()}`,
        { ordered: true },
      );
      createdPeer.addEventListener('connectionstatechange', () => { lease.peerState = createdPeer.connectionState; });
      createdPeer.addEventListener('icecandidate', (event) => {
        // Firefox emits an RTCIceCandidate object with an empty candidate
        // before the final null event. It is an end-of-candidates marker, not
        // a candidate node-datachannel can parse.
        if (!event.candidate?.candidate || lease.peer !== createdPeer || !hasLeaseBinding(lease)) return;
        const candidateType = readWebRtcCandidateType(
          event.candidate.candidate,
          'type' in event.candidate ? event.candidate.type : undefined,
        );
        if (candidateType) lease.browserCandidateTypes.add(candidateType);
        try {
          sendControl(lease, {
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
        } catch {
          // The outstanding answer waiter/reconnect lifecycle owns recovery.
        }
      });
    }
    if (!peer) throw directError(DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED);
    const leasePeer = peer;
    const requestId = crypto.randomUUID();
    lease.leaseSignalRequestId = requestId;
    const candidates = new PendingWebRtcCandidates<RTCIceCandidateInit>();
    // This subscription must outlive the answer. Host candidates come from
    // local interfaces and arrive at once, but a server-reflexive candidate
    // costs a STUN round trip and a relay candidate a TURN allocation, so both
    // land well after the answer has been applied. Unsubscribing there dropped
    // exactly the candidates a relayed path depends on, leaving the remote peer
    // with nothing but unroutable private addresses — which is why a LAN
    // connected and a phone never could.
    lease.leaseIceOff?.();
    const off = lease.ws.onMessage((raw) => {
      const message = parseMatchingControl(raw, requestId);
      if (!message || message.type !== DIRECT_FILE_TRANSFER_MSG.LEASE_ICE || !leaseSignalMatches(message, lease, requestId)) return;
      const candidateType = readWebRtcCandidateType(message.candidate);
      if (candidateType) lease.daemonCandidateTypes.add(candidateType);
      const candidate = { candidate: message.candidate, sdpMid: message.mid };
      if (leasePeer.remoteDescription) void leasePeer.addIceCandidate(candidate).catch(() => undefined);
      else candidates.push(candidate);
    });
    lease.leaseIceOff = off;
    try {
      if (restarting) {
        lease.iceRestartedGeneration = lease.leaseGeneration;
        leasePeer.restartIce();
      }
      const offer = await waitForPeerNegotiation((async () => {
        const createdOffer = await leasePeer.createOffer(restarting ? { iceRestart: true } : undefined);
        assertCurrentControl(lease, epoch);
        if (lease.peer !== leasePeer || !hasLeaseBinding(lease)) {
          throw directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED);
        }
        await leasePeer.setLocalDescription(createdOffer);
        assertCurrentControl(lease, epoch);
        if (lease.peer !== leasePeer || !hasLeaseBinding(lease)) {
          throw directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED);
        }
        return createdOffer;
      })(), signal);
      assertCurrentControl(lease, epoch);
      if (!hasLeaseBinding(lease)) throw directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED);
      const answer = startControlWait(
        lease,
        requestId,
        (message): message is DirectFileTransferLeaseAnswer => (
          message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER && leaseSignalMatches(message, lease, requestId)
        ),
        DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS,
        signal,
        directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED),
      );
      try {
        sendControl(lease, {
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
        reportProbeStage(onDiagnostics, DIRECT_CONNECTIVITY_PROBE_STAGE.EXCHANGING_CANDIDATES, lease);
      } catch (error) {
        answer.cancel(error);
        await answer.promise;
        throw error; // unreachable; preserves narrowing if cancellation changes
      }
      const remote = await answer.promise;
      assertCurrentControl(lease, epoch);
      await waitForPeerNegotiation((async () => {
        await leasePeer.setRemoteDescription({ type: 'answer', sdp: remote.sdp });
        assertCurrentControl(lease, epoch);
        if (lease.peer !== leasePeer || !hasLeaseBinding(lease)) {
          throw directError(DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED);
        }
        await candidates.flush((candidate) => leasePeer.addIceCandidate(candidate));
      })(), signal);
      reportProbeStage(onDiagnostics, DIRECT_CONNECTIVITY_PROBE_STAGE.CHECKING, lease);
      const bootstrap = lease.bootstrapChannel;
      if (!bootstrap) throw directError(DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED);
      // SDP/ICE signalling completion is not transport readiness. The old
      // prewarm resolved here while SCTP was still connecting, so uploads
      // appeared "prewarmed" but paid the full channel-open timeout anyway.
      await waitForChannelOpen(bootstrap, leasePeer, signal);
      reportProbeStage(onDiagnostics, DIRECT_CONNECTIVITY_PROBE_STAGE.DATA_CHANNEL_OPEN, lease);
    } catch (error) {
      if (lease.controlEpoch === epoch) {
        closePeer(lease);
        if (restarting) clearLeaseBinding(lease);
      }
      throw error instanceof DirectFileTransferFailure
        ? error
        : directError(restarting ? DIRECT_FILE_TRANSFER_ERROR.ICE_RESTART_FAILED : DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED);
    }
  })().finally(() => {
    if (lease.peerCreating === peerCreating) lease.peerCreating = null;
  });
  lease.peerCreating = peerCreating;
  return peerCreating;
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
      ...(op.destinationDirectory ? { destinationDirectory: op.destinationDirectory } : {}),
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

/**
 * Wait for a data channel to open, on a budget that a relayed path can meet.
 *
 * `peer` is watched as well as the channel: ICE reports `failed` as soon as
 * every candidate pair is exhausted, so a genuinely dead path surfaces at once
 * instead of holding the caller until the timeout. That is what makes the long
 * window safe — it is spent only on connections still making progress, and the
 * HTTP fallback is still reached promptly when direct cannot work at all.
 */
function waitForChannelOpen(
  channel: RTCDataChannel,
  peer: RTCPeerConnection,
  signal?: AbortSignal,
): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(directError(DIRECT_FILE_TRANSFER_ERROR.NEGOTIATION_TIMEOUT)), DIRECT_FILE_TRANSFER_LIMITS.CHANNEL_OPEN_TIMEOUT_MS);
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('close', onClose);
      peer.removeEventListener('connectionstatechange', onPeerState);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onOpen = () => finish();
    const onClose = () => finish(directError(DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED));
    const onAbort = () => finish(directError(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false));
    const onPeerState = () => {
      if (peer.connectionState === 'failed'
        || peer.connectionState === 'disconnected'
        || peer.connectionState === 'closed') {
        finish(directError(DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED));
      }
    };
    channel.addEventListener('open', onOpen, { once: true });
    channel.addEventListener('close', onClose, { once: true });
    peer.addEventListener('connectionstatechange', onPeerState);
    signal?.addEventListener('abort', onAbort, { once: true });
    onPeerState();
  });
}

function waitForBufferedAmount(channel: RTCDataChannel, commit?: UploadCommitTracker): Promise<void> {
  // Two bounds, both on existing water marks. `bufferedAmount` covers what SCTP
  // still holds locally; unacknowledged bytes cover what the receiver has not
  // yet durably written. Watching only the first lets a peer that accepts fast
  // but commits slowly pull an unbounded amount of the file into flight.
  const unacknowledged = commit ? commit.sentBytes - commit.committedBytes : 0;
  if (channel.bufferedAmount <= DIRECT_FILE_TRANSFER_LIMITS.DATA_BUFFER_HIGH_WATER_BYTES
    && unacknowledged <= DIRECT_FILE_TRANSFER_LIMITS.DATA_CREDIT_BYTES) return Promise.resolve();
  channel.bufferedAmountLowThreshold = DIRECT_FILE_TRANSFER_LIMITS.DATA_BUFFER_LOW_WATER_BYTES;
  return new Promise((resolve, reject) => {
    // The budget is about PROGRESS, not drain speed. Each expiry re-arms if the
    // receiver committed more bytes while we slept, so a slow-but-advancing
    // transfer is never killed, while one that genuinely stops still fails
    // within the same NO_PROGRESS_TIMEOUT_MS. With no tracker (an older daemon
    // that never reports commits) this is byte-for-byte the previous behaviour.
    let seenAdvances = commit?.advances ?? 0;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => {
        if (commit && commit.advances !== seenAdvances) {
          seenAdvances = commit.advances;
          arm();
          return;
        }
        finish(directError(DIRECT_FILE_TRANSFER_ERROR.NO_PROGRESS_TIMEOUT));
      }, DIRECT_FILE_TRANSFER_LIMITS.NO_PROGRESS_TIMEOUT_MS);
    };
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
    arm();
  });
}

function sendData(channel: RTCDataChannel, message: object): void {
  channel.send(JSON.stringify(message));
}

/**
 * The exact tuple every data-plane frame of this attempt must carry — both the
 * one we send and the one we will accept back. Returns null instead of
 * throwing so the inbound path can reject rather than fail the transfer.
 *
 * A control-plane rebind can switch the lease's current daemon generation
 * while this already-authorized channel is still carrying FINISH/CREDIT or
 * CANCEL, so the attempt's authority stays bound to the generation frozen at
 * AUTHORIZED rather than to whatever the lease holds now.
 */
function expectedDataBinding(lease: Lease, active: ActiveAttempt): DirectFileTransferAttemptBinding | null {
  if (!lease.leaseId || !lease.leaseGeneration || active.daemonGeneration === null) return null;
  return {
    serverId: lease.serverId,
    browserTabId: lease.browserTabId,
    leaseId: lease.leaseId,
    leaseGeneration: lease.leaseGeneration,
    daemonGeneration: active.daemonGeneration,
    requestId: active.requestId,
    attemptId: active.attemptId,
    attempt: active.attempt,
    direction: active.direction,
    operationId: active.operationId,
  };
}

function makeDataBinding(lease: Lease, active: ActiveAttempt) {
  // Keeps the pre-existing failure shapes: an unusable lease is LEASE_EXPIRED,
  // an attempt with no frozen generation is INVALID_AUTHORITY.
  currentBinding(lease, active);
  const expected = expectedDataBinding(lease, active);
  if (!expected) throw directError(DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false);
  return expected;
}

async function pumpUpload(
  channel: RTCDataChannel,
  lease: Lease,
  active: ActiveAttempt,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const commit = active.uploadCommit;
  const pumpStartedAt = Date.now();
  // Start where the receiver has already durably committed. The prefix is on
  // disk on the far side; re-sending it is exactly the whole-file restart this
  // exists to avoid.
  let offset = commit?.committedBytes ?? 0;
  while (offset < file.size) {
    if (commit?.fatal) throw commit.fatal;
    await waitForBufferedAmount(channel, commit);
    const end = Math.min(file.size, offset + DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES);
    channel.send(await file.slice(offset, end).arrayBuffer());
    if (commit) commit.sentBytes = end;
    if (offset === 0) {
      recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.STAGE, {
        direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
        stage: DIRECT_FILE_TRANSFER_STAGE.FIRST_CHUNK,
        elapsedMs: Date.now() - pumpStartedAt,
      });
    }
    offset = end;
    // 100% means the daemon has durably committed the attachment, not merely
    // that the browser filled the SCTP send queue. Keeping the byte phase at
    // 99 avoids a false-complete row while FINISH is being fsynced/renamed.
    onProgress?.(file.size ? Math.min(99, Math.round((offset / file.size) * 100)) : 99);
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
  // Lease creation used to ignore the upload AbortSignal. A user could press
  // Stop during negotiation, but the composer row survived until the shared
  // setup's full timeout elapsed.
  if (op.signal?.aborted) throw directError(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false);
  await waitForCaller(ensureLease(lease), op.signal);
  const active: ActiveAttempt = {
    requestId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    operationId: op.operationId,
    direction: op.kind === 'upload' ? DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD : DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD,
    attempt,
    daemonGeneration: null,
    authority: null,
    channel: null,
    ...(op.kind === 'upload'
      ? {
        uploadCommit: {
          // The prefix the daemon already holds is credited up front; this
          // attempt only has to prove the remainder.
          committedBytes: op.resumeFromBytes ?? 0,
          advances: 0,
          sentBytes: op.resumeFromBytes ?? 0,
          totalBytes: op.file.size,
        },
      }
      : {}),
    signal: op.signal,
  };
  const attemptStartedAt = Date.now();
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
      sendControl(lease, {
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
    const authorization = startControlWait(
      lease,
      active.requestId,
      (message): message is DirectFileTransferAuthorized => message.type === DIRECT_FILE_TRANSFER_MSG.AUTHORIZED && attemptMessageMatches(message, active),
      DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS,
      op.signal,
    );
    try {
      sendControl(lease, init);
    } catch (error) {
      authorization.cancel(error);
      await authorization.promise;
      throw error; // unreachable; preserves narrowing if cancellation changes
    }
    const authorized = await authorization.promise;
    const parsed = validateDirectFileTransferAuthorized(authorized);
    if (!parsed.ok) throw directError(DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false);
    active.daemonGeneration = parsed.value.daemonGeneration;
    active.authority = parsed.value.authority;
    // The peer was established from lease-only SDP/ICE during File Browser
    // prewarm. Operation authorization merely allocates a data channel on that
    // reusable peer, so no file authority ever appears in an offer or ICE.
    if (op.signal?.aborted) throw directError(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false);
    // Establishment is timed per stage. Without this, "the upload took ages to
    // connect" could not be attributed: waiting on operation authorization and
    // waiting on ICE/DTLS look identical from the outside, and the fast daemon
    // connectivity probe covers only part of the same path.
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.STAGE, {
      direction: active.direction,
      stage: DIRECT_FILE_TRANSFER_STAGE.OPERATION_AUTHORIZE,
      elapsedMs: Date.now() - attemptStartedAt,
    });
    const peerStartedAt = Date.now();
    await waitForCaller(ensureLeasePeer(lease), op.signal);
    const peer = lease.peer;
    if (!peer) throw directError(DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED);
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.STAGE, {
      direction: active.direction,
      stage: DIRECT_FILE_TRANSFER_STAGE.PEER_READY,
      elapsedMs: Date.now() - peerStartedAt,
    });
    const channelStartedAt = Date.now();
    const channel = peer.createDataChannel(parsed.value.channelLabel, { ordered: true });
    channel.binaryType = 'arraybuffer';
    active.channel = channel;
    await waitForChannelOpen(channel, peer, op.signal);
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.STAGE, {
      direction: active.direction,
      stage: DIRECT_FILE_TRANSFER_STAGE.CHANNEL_OPEN,
      elapsedMs: Date.now() - channelStartedAt,
    });

    const result = await new Promise<OperationSuccess>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      let started = false;
      let uploadSourceFinished = false;
      let uploadStatusRecoveryRequested = false;
      let received = 0;
      let expected = -1;
      let writeChain: Promise<void> = Promise.resolve();
      const requestUploadStatusRecovery = () => {
        if (op.kind !== 'upload' || uploadStatusRecoveryRequested) return false;
        uploadStatusRecoveryRequested = true;
        try {
          sendControl(lease, {
            type: DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY,
            protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
            ...currentBinding(lease, active),
          });
        } catch (error) {
          fail(error);
          return true;
        }
        arm(DIRECT_FILE_TRANSFER_LIMITS.STATUS_RECOVERY_DEADLINE_MS);
        return true;
      };
      const arm = (timeoutMs = DIRECT_FILE_TRANSFER_LIMITS.NO_PROGRESS_TIMEOUT_MS) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          // FINISH may have committed successfully while its data/control ACK
          // was lost during a mobile resume. Query the durable operation
          // ledger before retrying direct or uploading the same bytes by HTTP.
          if (uploadSourceFinished && requestUploadStatusRecovery()) return;
          finish(directError(DIRECT_FILE_TRANSFER_ERROR.NO_PROGRESS_TIMEOUT));
        }, timeoutMs);
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
        // A frame is only this attempt's if it echoes the WHOLE tuple. The
        // correlation pair alone let a well-formed frame from another daemon
        // generation, lease, operation, direction or attempt set the resume
        // boundary — the value that decides which bytes are never resent.
        const expectedBinding = expectedDataBinding(lease, active);
        if (!expectedBinding
          || !directFileTransferAttemptBindingMatches(expectedBinding, data as unknown as Record<string, unknown>)) return;
        arm();
        if (data.type === DIRECT_FILE_TRANSFER_DATA_MSG.ERROR) {
          fail(directError(data.error));
          return;
        }
        if (op.kind === 'upload') {
          if (data.type === DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED && !started) {
            started = true;
            op.onConnected?.();
            void pumpUpload(channel, lease, active, op.file, op.onProgress).then(() => {
              if (settled) return;
              uploadSourceFinished = true;
              arm(DIRECT_FILE_TRANSFER_LIMITS.STATUS_RECOVERY_DEADLINE_MS);
            }).catch(fail);
            return;
          }
          if (data.type === DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT
            && data.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD
            && typeof data.committedBytes === 'number') {
            const tracker = active.uploadCommit;
            if (!tracker) return;
            const committed = data.committedBytes;
            // Re-stating the current offset is a harmless duplicate.
            if (committed === tracker.committedBytes) return;
            // Everything else that is not forward progress within what this
            // attempt actually sent is impossible, so it is treated as a fault
            // rather than silently ignored: going backwards, claiming more than
            // the file holds, or claiming more than we have handed over would
            // all corrupt the resume boundary a later attempt depends on.
            if (committed < tracker.committedBytes
              || committed > tracker.totalBytes
              || committed > tracker.sentBytes) {
              tracker.fatal = directError(DIRECT_FILE_TRANSFER_ERROR.SIZE_MISMATCH, false);
              fail(tracker.fatal);
              return;
            }
            tracker.committedBytes = committed;
            tracker.advances += 1;
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
            op.onProgress?.(100);
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
            op.onProgress?.(100);
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
      const resumeOffset = op.kind === 'upload' ? (op.resumeFromBytes ?? 0) : 0;
      sendData(channel, {
        type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        ...makeDataBinding(lease, active),
        authority: parsed.value.authority,
        // Only sent when actually resuming, so an older daemon that does not
        // know the field keeps seeing exactly the frames it always saw.
        ...(resumeOffset > 0 ? { resumeOffset } : {}),
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
    // Hand this attempt's OWN confirmed offset to the next one. Each attempt
    // trusts only what it saw acknowledged on its own live channel, so a
    // replacement can never inherit an unverified boundary — and the boundary
    // can only move forward, never past the file.
    if (op.kind === 'upload') {
      const confirmed = active.uploadCommit?.committedBytes ?? 0;
      if (confirmed > (op.resumeFromBytes ?? 0) && confirmed <= op.file.size) {
        op.resumeFromBytes = confirmed;
      }
    }
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

/**
 * Lease/peer setup can be shared with a prewarm or another transfer, so
 * canceling one upload must not abort that authority-free shared work. Race
 * only this caller against its signal; the setup may finish for later reuse.
 */
function waitForCaller<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(directError(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value as T);
    };
    const onAbort = () => finish(directError(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false));
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then((value) => finish(undefined, value), (error) => finish(error));
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
  // Carried between attempts of the SAME operation: how far the receiver was
  // last seen to have durably committed. Only ever written from an offset the
  // finished attempt confirmed on its own live channel.
  let resumeFromBytes = 0;
  for (let attempt = 1; attempt <= DIRECT_FILE_TRANSFER_LIMITS.MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await wait(retryDelay(attempt - 1), signal);
    const attemptControlEpoch = lease.controlEpoch;
    const operation = await createOperation(attempt);
    if (operation.kind === 'upload' && resumeFromBytes > 0) operation.resumeFromBytes = resumeFromBytes;
    try {
      return await runAttempt(lease, operation, attempt) as T;
    } catch (error) {
      if (operation.kind === 'upload' && (operation.resumeFromBytes ?? 0) > resumeFromBytes) {
        resumeFromBytes = operation.resumeFromBytes ?? 0;
      }
      last = error;
      const disposition = failureDisposition(error, attempt);
      // A retryable channel/ICE failure must not feed the next attempt back
      // into the same apparently-connected but dead mobile WebRTC peer. Do not
      // disturb sibling transfers that still own channels on the shared lease.
      if (disposition !== DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.TERMINAL
        && lease.active.size === 0 && lease.controlEpoch === attemptControlEpoch) {
        closePeer(lease);
      }
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
  destinationDirectory?: string,
): Promise<{ ok: true; attachment: AttachmentRefResponse }> {
  if (!serverId || !supportsUpload(ws)) throw directError(DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE, false);
  const { lease, release } = acquireLease(ws, serverId);
  try {
    const result = await retryDirect<OperationSuccess>(lease, () => ({
      kind: 'upload', file, operationId: clientUploadId, sessionName, destinationDirectory, onProgress, onConnected, signal,
    }), signal);
    if (result.kind !== 'upload') throw directError(DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR, false);
    const route = await selectedPeerRoute(lease.peer);
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.DIRECT_SUCCESS, {
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      route,
    });
    if (route === DIRECT_CONNECTIVITY_ROUTE.RELAY) {
      if (lease.active.size === 0) clearLeaseBinding(lease);
      setConnectionStatus(lease, DIRECT_FILE_CONNECTION_STATUS.RELAY);
    } else if (route !== 'unknown') {
      setConnectionStatus(lease, DIRECT_FILE_CONNECTION_STATUS.DIRECT);
    }
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
  const broker = options.ws ? getBroker(options.ws, options.serverId) : null;
  if (options.ws && supportsUpload(options.ws)
    && (!options.destinationDirectory || supportsDirectoryUpload(options.ws))) {
    options.onMode?.(FILE_UPLOAD_TRANSPORT_MODE.CONNECTING);
    const directAbort = new AbortController();
    let directConnectTimedOut = false;
    let directConnected = false;
    const abortDirect = () => directAbort.abort();
    if (options.signal?.aborted) abortDirect();
    else options.signal?.addEventListener('abort', abortDirect, { once: true });
    const connectTimer = setTimeout(() => {
      if (directConnected) return;
      directConnectTimedOut = true;
      directAbort.abort();
    }, DIRECT_FILE_TRANSFER_LIMITS.UPLOAD_DIRECT_CONNECT_FALLBACK_MS);
    try {
      const direct = await uploadFileDirect(
        options.ws,
        options.file,
        clientUploadId,
        options.onProgress,
        () => {
          directConnected = true;
          clearTimeout(connectTimer);
          options.onMode?.(FILE_UPLOAD_TRANSPORT_MODE.DIRECT);
        },
        directAbort.signal,
        options.sessionName,
        options.serverId,
        options.destinationDirectory,
      );
      return direct;
    } catch (error) {
      // User cancellation is terminal. The internal 20-second deadline uses
      // the same abort machinery, but intentionally continues through HTTP.
      const forcedFallbackCancellation = directConnectTimedOut && isFileUploadCanceled(error);
      if (options.signal?.aborted
        || (!forcedFallbackCancellation
          && (isFileUploadCanceled(error) || isTerminalDirectFailure(error)))) throw error;
      if (options.file.size > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
        throw directError(DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR, false, 'relay_size_limit');
      }
      options.onMode?.(FILE_UPLOAD_TRANSPORT_MODE.FALLING_BACK);
    } finally {
      clearTimeout(connectTimer);
      options.signal?.removeEventListener('abort', abortDirect);
    }
  } else if (options.file.size > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
    throw directError(DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR, false, 'relay_size_limit');
  }
  if (broker) {
    if (broker.active.size === 0) closePeer(broker);
    setConnectionStatus(broker, DIRECT_FILE_CONNECTION_STATUS.RELAY);
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
  // Native WebViews must not use a coincidental/partial File System Access
  // surface. If embedded Filesystem+Share plugins are unavailable, the caller
  // falls back to the authenticated Browser.open download path instead of an
  // invisible hidden-anchor handoff.
  if (isNative()) return null;
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

type NativeBlobDownloadSink = {
  destination: DirectPreviewDownloadDestination;
  takeCompletedBlob(): Blob;
};

function createNativeBlobDownloadSink(): NativeBlobDownloadSink {
  let completedBlob: Blob | null = null;
  return {
    destination: {
      handle: {
        async createWritable() {
          const chunks: ArrayBuffer[] = [];
          let settled = false;
          completedBlob = null;
          return {
            async write(data) {
              if (settled) throw new Error('download_writer_closed');
              const bytes = data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
              const copy = new Uint8Array(bytes.byteLength);
              copy.set(bytes);
              chunks.push(copy.buffer);
            },
            async close() {
              if (settled) throw new Error('download_writer_closed');
              settled = true;
              completedBlob = new Blob(chunks);
              chunks.length = 0;
            },
            async abort() {
              settled = true;
              chunks.length = 0;
            },
          };
        },
      },
    },
    takeCompletedBlob() {
      if (!completedBlob) throw directError(DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED, false, 'download_blob_missing');
      const blob = completedBlob;
      completedBlob = null;
      return blob;
    },
  };
}

async function presentNativeDownloadedBlob(options: {
  blob: Blob;
  suggestedName?: string;
  onSaveReady?: (save: () => Promise<void>) => void;
}): Promise<void> {
  const fileName = options.suggestedName?.trim() || 'download';
  try {
    await shareBlobOrDownload(options.blob, fileName);
  } catch (error) {
    // Web Share requires a live user gesture. A direct or HTTP transfer
    // necessarily finishes after that gesture has expired in WKWebView. Keep
    // the completed payload and let the transfer center invoke the same save
    // operation from a fresh explicit tap instead of reporting transfer failure.
    if (!options.onSaveReady) throw error;
    options.onSaveReady(() => shareBlobOrDownload(options.blob, fileName).then(() => undefined));
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
  /** Kept for desktop browsers without File System Access. */
  httpFallback?: () => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (progress: FileDownloadProgress) => void;
  onMode?: (mode: FileDownloadTransportMode) => void;
  onSaveReady?: (save: () => Promise<void>) => void;
}): Promise<void> {
  // Mobile WebViews have no File System Access picker. Give the existing P2P
  // protocol an in-memory writable target, then pass the completed bytes to the
  // embedded Capacitor Filesystem/Share bridge (or a fresh Web Share tap). The
  // same sink is recreated for the one HTTP fallback, so partial P2P bytes are
  // never mixed with fallback bytes.
  const nativeBlobSink = isNative() && options.destination == null && canUseNativeFileShare()
    ? createNativeBlobDownloadSink()
    : null;
  const destination = nativeBlobSink?.destination ?? (options.destination === undefined
    ? await selectPreviewDownloadDestination(options.suggestedName)
    : options.destination);
  if (!destination) {
    // No File System Access API means no safe streaming sink.  Keep the
    // established HTTP browser download as the only fallback and do not start
    // an unbounded Blob/direct transfer.
    options.onMode?.(FILE_DOWNLOAD_TRANSPORT_MODE.BROWSER);
    await (options.httpFallback ?? (() => downloadAttachment(options.serverId, options.previewHandle, options.sessionName, options.signal)))();
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
    } catch (error) {
      if (isTerminalDirectFailure(error)) throw error;
      // Exactly one HTTP fallback after the full direct budget. It reuses the
      // same destination: desktop keeps streaming to its approved file handle,
      // while mobile rebuilds only the completed fallback payload for sharing.
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
      } catch (fallbackError) {
        await writer.abort(fallbackError).catch(() => undefined);
        throw fallbackError;
      }
      if (nativeBlobSink) {
        await presentNativeDownloadedBlob({
          blob: nativeBlobSink.takeCompletedBlob(),
          suggestedName: options.suggestedName,
          onSaveReady: options.onSaveReady,
        });
      }
      return;
    } finally {
      release();
    }
    if (nativeBlobSink) {
      await presentNativeDownloadedBlob({
        blob: nativeBlobSink.takeCompletedBlob(),
        suggestedName: options.suggestedName,
        onSaveReady: options.onSaveReady,
      });
    }
    return;
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
  if (nativeBlobSink) {
    await presentNativeDownloadedBlob({
      blob: nativeBlobSink.takeCompletedBlob(),
      suggestedName: options.suggestedName,
      onSaveReady: options.onSaveReady,
    });
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

async function probeLeasePeer(
  lease: Lease,
  onDiagnostics?: (diagnostics: DirectConnectivityProbeDiagnostics) => void,
): Promise<DirectConnectivityProbeResult> {
  const peer = lease.peer;
  if (!peer || !lease.leaseId || !lease.leaseGeneration || !lease.daemonGeneration) {
    throw directError(DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE, false);
  }
  reportProbeStage(onDiagnostics, DIRECT_CONNECTIVITY_PROBE_STAGE.VERIFYING, lease);
  const channel = peer.createDataChannel(`${DIRECT_FILE_TRANSFER_HEALTH_CHANNEL_PREFIX}${crypto.randomUUID()}`, { ordered: true });
  await waitForChannelOpen(channel, peer, lease.controlAbort.signal);
  const nonce = crypto.randomUUID();
  const started = performance.now();
  return new Promise<DirectConnectivityProbeResult>((resolve, reject) => {
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
  const probeControlEpoch = lease.controlEpoch;
  try {
    await ensureLease(lease, onDiagnostics);
    const result = await probeLeasePeer(lease, onDiagnostics);
    reportProbeStage(onDiagnostics, DIRECT_CONNECTIVITY_PROBE_STAGE.COMPLETE, lease);
    recordDirectFileTransferMetric(DIRECT_FILE_TRANSFER_CLIENT_METRIC.ROUTE, { route: result.route });
    if (result.route === DIRECT_CONNECTIVITY_ROUTE.RELAY) {
      if (lease.active.size === 0) clearLeaseBinding(lease);
      setConnectionStatus(lease, DIRECT_FILE_CONNECTION_STATUS.RELAY);
    } else {
      setConnectionStatus(lease, DIRECT_FILE_CONNECTION_STATUS.DIRECT);
    }
    return result;
  } catch (error) {
    // A failed explicit probe is itself proof that this idle peer should not be
    // offered to the next transfer. Drop only the peer (not the resumable
    // lease), so Refresh or the next upload renegotiates without requiring an
    // app restart. Active transfers, if any, retain ownership of their peer.
    if (error instanceof DirectFileTransferFailure && error.retryable
      && lease.active.size === 0 && lease.controlEpoch === probeControlEpoch) {
      closePeer(lease);
    }
    throw error;
  } finally {
    release();
  }
}
