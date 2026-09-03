import type { AttachmentRef } from './transport/file-transfer.js';
import { FILE_TRANSFER_PATH_MAX_BYTES, validateAttachmentRef } from './transport/file-transfer.js';

/**
 * Full daemons auto-upgrade, so this is a clean v2 protocol.  Do not add v1
 * message validators here: HTTP is the only fallback when v2 is unavailable.
 * ICE/candidate helpers remain in this module because the remote-desktop
 * transport deliberately shares their DOM-free representation.
 */
export const DIRECT_FILE_TRANSFER_PROTOCOL_VERSION = 2 as const;
export const DIRECT_FILE_TRANSFER_RESUME_TICKET_TYPE = 'direct_file.v2.resume_ticket' as const;

export const DIRECT_FILE_TRANSFER_LEASE_CAPABILITY = 'file.transfer.direct.lease.v2' as const;
export const DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY = 'file.transfer.direct.upload_recovery.v2' as const;
export const DIRECT_FILE_TRANSFER_PREVIEW_DOWNLOAD_CAPABILITY = 'file.transfer.direct.preview_download.v2' as const;
/** Optional rolling capability for direct uploads committed into a selected controlled-node directory. */
export const DIRECT_FILE_TRANSFER_DIRECTORY_UPLOAD_CAPABILITY = 'file.transfer.direct.directory_upload.v1' as const;
export const DIRECT_FILE_TRANSFER_HEALTH_CHANNEL_PREFIX = 'imcodes-health-' as const;

export const DIRECT_FILE_TRANSFER_REQUIRED_CAPABILITIES = [
  DIRECT_FILE_TRANSFER_LEASE_CAPABILITY,
  DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY,
  DIRECT_FILE_TRANSFER_PREVIEW_DOWNLOAD_CAPABILITY,
] as const;

export type DirectFileTransferCapability = typeof DIRECT_FILE_TRANSFER_REQUIRED_CAPABILITIES[number]
  | typeof DIRECT_FILE_TRANSFER_DIRECTORY_UPLOAD_CAPABILITY;

export const DIRECT_FILE_TRANSFER_DIRECTION = {
  UPLOAD: 'upload',
  DOWNLOAD: 'download',
} as const;

export type DirectFileTransferDirection = typeof DIRECT_FILE_TRANSFER_DIRECTION[keyof typeof DIRECT_FILE_TRANSFER_DIRECTION];

export const DIRECT_FILE_TRANSFER_MSG = {
  LEASE_INIT: 'direct_file.v2.lease_init',
  LEASE_READY: 'direct_file.v2.lease_ready',
  LEASE_PREPARED: 'direct_file.v2.lease_prepared',
  LEASE_REBIND: 'direct_file.v2.lease_rebind',
  LEASE_REBOUND: 'direct_file.v2.lease_rebound',
  OPERATION_INIT: 'direct_file.v2.operation_init',
  AUTHORIZED: 'direct_file.v2.authorized',
  PREPARE: 'direct_file.v2.prepare',
  LEASE_PREPARE: 'direct_file.v2.lease_prepare',
  LEASE_OFFER: 'direct_file.v2.lease_offer',
  LEASE_ANSWER: 'direct_file.v2.lease_answer',
  LEASE_ICE: 'direct_file.v2.lease_ice',
  CANCEL: 'direct_file.v2.cancel',
  STATUS_QUERY: 'direct_file.v2.status_query',
  STATUS: 'direct_file.v2.status',
  TERMINAL: 'direct_file.v2.terminal',
  ERROR: 'direct_file.v2.error',
} as const;

export const DIRECT_FILE_TRANSFER_DATA_MSG = {
  START: 'direct_file.v2.data.start',
  ACCEPTED: 'direct_file.v2.data.accepted',
  CREDIT: 'direct_file.v2.data.credit',
  FINISH: 'direct_file.v2.data.finish',
  UPLOAD_COMMITTED: 'direct_file.v2.data.upload_committed',
  DOWNLOAD_COMMITTED: 'direct_file.v2.data.download_committed',
  HEALTH_PROBE: 'direct_file.v2.data.health_probe',
  HEALTH_PONG: 'direct_file.v2.data.health_pong',
  ERROR: 'direct_file.v2.data.error',
} as const;

export const DIRECT_FILE_TRANSFER_OPERATION_STATE = {
  AUTHORIZING: 'authorizing',
  ATTEMPTING: 'attempting',
  STREAMING: 'streaming',
  SOURCE_FINISHED_AWAITING_ACK: 'source_finished_awaiting_ack',
  COMMITTED: 'committed',
  FAILED: 'failed',
  CANCELED: 'canceled',
  NOT_FOUND: 'not_found',
} as const;

export type DirectFileTransferOperationState = typeof DIRECT_FILE_TRANSFER_OPERATION_STATE[keyof typeof DIRECT_FILE_TRANSFER_OPERATION_STATE];

export const DIRECT_FILE_TRANSFER_TERMINAL_STATE = {
  COMMITTED: DIRECT_FILE_TRANSFER_OPERATION_STATE.COMMITTED,
  FAILED: DIRECT_FILE_TRANSFER_OPERATION_STATE.FAILED,
  CANCELED: DIRECT_FILE_TRANSFER_OPERATION_STATE.CANCELED,
} as const;

export type DirectFileTransferTerminalState = typeof DIRECT_FILE_TRANSFER_TERMINAL_STATE[keyof typeof DIRECT_FILE_TRANSFER_TERMINAL_STATE];

export const DIRECT_FILE_TRANSFER_ERROR = {
  CAPABILITY_UNAVAILABLE: 'capability_unavailable',
  DAEMON_OFFLINE: 'daemon_offline',
  INVALID_REQUEST: 'invalid_request',
  INVALID_AUTHORITY: 'invalid_authority',
  AUTHORITY_EXPIRED: 'authority_expired',
  LEASE_EXPIRED: 'lease_expired',
  LEASE_REBIND_FAILED: 'lease_rebind_failed',
  STALE_DAEMON_GENERATION: 'stale_daemon_generation',
  STALE_ATTEMPT: 'stale_attempt',
  OPERATION_NOT_FOUND: 'operation_not_found',
  NEGOTIATION_TIMEOUT: 'negotiation_timeout',
  CONNECTION_FAILED: 'connection_failed',
  ICE_RESTART_FAILED: 'ice_restart_failed',
  CHANNEL_CLOSED: 'channel_closed',
  NO_PROGRESS_TIMEOUT: 'no_progress_timeout',
  TOO_MANY_CHANNELS: 'too_many_channels',
  PREVIEW_HANDLE_INVALID: 'preview_handle_invalid',
  PREVIEW_POLICY_DENIED: 'preview_policy_denied',
  SIZE_MISMATCH: 'size_mismatch',
  CHECKSUM_MISMATCH: 'checksum_mismatch',
  WRITE_FAILED: 'write_failed',
  CANCELED: 'canceled',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type DirectFileTransferError = typeof DIRECT_FILE_TRANSFER_ERROR[keyof typeof DIRECT_FILE_TRANSFER_ERROR];

export const DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION = {
  RETRY_DIRECT: 'retry_direct',
  HTTP_FALLBACK: 'http_fallback',
  TERMINAL: 'terminal',
} as const;

export type DirectFileTransferFailureDisposition = typeof DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION[keyof typeof DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION];

const DIRECT_FILE_TRANSFER_RETRYABLE_TRANSPORT_ERRORS = new Set<DirectFileTransferError>([
  DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE,
  DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED,
  DIRECT_FILE_TRANSFER_ERROR.LEASE_REBIND_FAILED,
  DIRECT_FILE_TRANSFER_ERROR.STALE_DAEMON_GENERATION,
  DIRECT_FILE_TRANSFER_ERROR.NEGOTIATION_TIMEOUT,
  DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
  DIRECT_FILE_TRANSFER_ERROR.ICE_RESTART_FAILED,
  DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED,
  DIRECT_FILE_TRANSFER_ERROR.NO_PROGRESS_TIMEOUT,
  DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR,
]);

export const DIRECT_FILE_TRANSFER_ERROR_SCOPE = {
  LEASE: 'lease',
  OPERATION: 'operation',
} as const;

export type DirectFileTransferErrorScope = typeof DIRECT_FILE_TRANSFER_ERROR_SCOPE[keyof typeof DIRECT_FILE_TRANSFER_ERROR_SCOPE];

/**
 * The browser uses this shared policy after every nonterminal direct failure.
 * It deliberately never converts a local/security/integrity failure to HTTP,
 * because a fallback must not mask a denied/changed file or user cancellation.
 */
export function classifyDirectFileTransferFailure(
  error: DirectFileTransferError,
  attemptsUsed: number,
): DirectFileTransferFailureDisposition {
  if (error === DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE) {
    return DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.HTTP_FALLBACK;
  }
  if (!DIRECT_FILE_TRANSFER_RETRYABLE_TRANSPORT_ERRORS.has(error)) {
    return DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.TERMINAL;
  }
  return attemptsUsed < DIRECT_FILE_TRANSFER_LIMITS.MAX_ATTEMPTS
    ? DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.RETRY_DIRECT
    : DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.HTTP_FALLBACK;
}

export const DIRECT_FILE_TRANSFER_LIMITS = {
  REQUEST_ID_BYTES: 128,
  ATTEMPT_ID_BYTES: 128,
  OPERATION_ID_BYTES: 128,
  CLIENT_UPLOAD_ID_BYTES: 128,
  CLIENT_DOWNLOAD_ID_BYTES: 128,
  SERVER_ID_BYTES: 256,
  USER_ID_BYTES: 256,
  BROWSER_TAB_ID_BYTES: 128,
  LEASE_ID_BYTES: 128,
  AUTHORITY_BYTES: 1024,
  RESUME_TICKET_BYTES: 4096,
  CHANNEL_LABEL_BYTES: 256,
  PREVIEW_HANDLE_BYTES: 1024,
  FILENAME_BYTES: 1024,
  MIME_BYTES: 256,
  SESSION_NAME_BYTES: 256,
  SDP_BYTES: 256 * 1024,
  ICE_CANDIDATE_BYTES: 16 * 1024,
  ICE_MID_BYTES: 256,
  /** Bounded trickle queue while an SDP exchange is not yet accepted. */
  PENDING_ICE_CANDIDATE_LIMIT: 128,
  ICE_SERVER_URL_BYTES: 2048,
  ICE_SERVER_USERNAME_BYTES: 256,
  ICE_SERVER_CREDENTIAL_BYTES: 512,
  ICE_SERVER_URLS_PER_ENTRY: 4,
  ICE_SERVER_ENTRIES: 8,
  ERROR_DETAIL_BYTES: 512,
  DATA_CHUNK_BYTES: 64 * 1024,
  DATA_CREDIT_BYTES: 8 * 1024 * 1024,
  DATA_BUFFER_HIGH_WATER_BYTES: 8 * 1024 * 1024,
  DATA_BUFFER_LOW_WATER_BYTES: 2 * 1024 * 1024,
  // Keep daemon-to-browser bulk data from filling the shared SCTP send queue.
  // Operation START/ACCEPTED frames use sibling channels on the same peer and
  // must not wait behind the full upload/receiver backpressure window.
  DOWNLOAD_CHANNEL_BUFFER_HIGH_WATER_BYTES: 256 * 1024,
  DOWNLOAD_CHANNEL_BUFFER_LOW_WATER_BYTES: 64 * 1024,
  DISK_RESERVE_BYTES: 64 * 1024 * 1024,
  /** Attempt authority is deliberately longer-lived than a resume ticket. */
  AUTHORITY_TTL_MS: 2 * 60 * 60 * 1000,
  MAX_ATTEMPTS: 3,
  RETRY_BACKOFF_MS: [250, 1_000] as const,
  RETRY_MAX_POSITIVE_JITTER_RATIO: 0.25,
  NO_PROGRESS_TIMEOUT_MS: 45 * 1000,
  LEASE_IDLE_TTL_MS: 5 * 60 * 1000,
  RESUME_TICKET_TTL_MS: 10 * 60 * 1000,
  STATUS_RECOVERY_DEADLINE_MS: 15 * 1000,
  OPERATION_LEDGER_TTL_MS: 60 * 60 * 1000,
  OPERATION_LEDGER_CAPACITY: 256,
  MAX_ACTIVE_CHANNELS_PER_LEASE: 4,
  /**
   * Uploads are direct-first, but the composer must not remain stuck in the
   * connection phase on a path that is still negotiating. This deadline is
   * measured only until the direct data plane accepts the upload; once bytes
   * start flowing, the normal no-progress watchdog owns the transfer.
   */
  UPLOAD_DIRECT_CONNECT_FALLBACK_MS: 20 * 1000,
  NEGOTIATION_TIMEOUT_MS: 8 * 1000,
  /**
   * How long a data channel may take to report `open`.
   *
   * This is deliberately NOT `NEGOTIATION_TIMEOUT_MS`. That budget covers a
   * signalling round trip through the Server, which is fast and bounded by the
   * websocket. Opening a channel additionally requires ICE connectivity checks
   * and a DTLS handshake over whichever path wins. On a LAN the host pair is
   * nominated in tens of milliseconds; a relayed path — TURN, which is what a
   * phone on a carrier network actually gets — routinely needs several seconds
   * for the allocation, permission, checks and handshake. Reusing the eight
   * second signalling budget therefore worked on a LAN and timed out over
   * relay, which is the same asymmetry `REMOTE_DESKTOP_LIMITS` documents when
   * it allows 45s for negotiation and 30s for first media.
   *
   * A long budget does not delay the HTTP fallback, because the wait also ends
   * as soon as the peer connection reports `failed`: a path that cannot work
   * says so in well under a second, and only a path still making progress ever
   * reaches the tail of this window.
   */
  CHANNEL_OPEN_TIMEOUT_MS: 30 * 1000,
  PROBE_NONCE_BYTES: 128,
  PROBE_CANDIDATE_ADDRESS_BYTES: 512,
  PROBE_CANDIDATE_TYPE_BYTES: 64,
  PROBE_TIMEOUT_MS: 8 * 1000,
} as const;

export const DIRECT_FILE_TRANSFER_ICE_SERVERS = [
  'stun:stun.cloudflare.com:3478',
] as const;

export interface DirectFileTransferIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export type DirectFileTransferIceServerConfig = string | DirectFileTransferIceServer;

export const DIRECT_CONNECTIVITY_ROUTE = {
  LAN_DIRECT: 'lan_direct',
  DIRECT: 'direct',
  RELAY: 'relay',
} as const;

export type DirectConnectivityRoute = typeof DIRECT_CONNECTIVITY_ROUTE[keyof typeof DIRECT_CONNECTIVITY_ROUTE];

export const DIRECT_CONNECTIVITY_PROBE_STAGE = {
  AUTHORIZING: 'authorizing',
  CREATING_OFFER: 'creating_offer',
  EXCHANGING_CANDIDATES: 'exchanging_candidates',
  CHECKING: 'checking',
  DATA_CHANNEL_OPEN: 'data_channel_open',
  VERIFYING: 'verifying',
  COMPLETE: 'complete',
} as const;

export type DirectConnectivityProbeStage = typeof DIRECT_CONNECTIVITY_PROBE_STAGE[keyof typeof DIRECT_CONNECTIVITY_PROBE_STAGE];

export const DIRECT_CONNECTIVITY_CANDIDATE_TYPE = {
  HOST: 'host',
  SERVER_REFLEXIVE: 'srflx',
  PEER_REFLEXIVE: 'prflx',
  RELAY: DIRECT_CONNECTIVITY_ROUTE.RELAY,
} as const;

export type DirectConnectivityCandidateType = typeof DIRECT_CONNECTIVITY_CANDIDATE_TYPE[keyof typeof DIRECT_CONNECTIVITY_CANDIDATE_TYPE];

export const DIRECT_CONNECTIVITY_ENDPOINT_KIND = {
  PRIVATE_ROUTED: 'private_routed',
  PUBLIC_DIRECT: 'public_direct',
  NAT_MAPPED: 'nat_mapped',
  PEER_REFLEXIVE: 'peer_reflexive',
  TURN_RELAY: 'turn_relay',
  HOST_CANDIDATE: 'host_candidate',
  UNKNOWN: 'unknown',
} as const;

export type DirectConnectivityEndpointKind = typeof DIRECT_CONNECTIVITY_ENDPOINT_KIND[keyof typeof DIRECT_CONNECTIVITY_ENDPOINT_KIND];

export const DIRECT_CONNECTIVITY_RUNTIME_STATE = {
  AVAILABLE: 'available',
  RUNTIME_UNAVAILABLE: 'runtime_unavailable',
} as const;

export const DIRECT_CONNECTIVITY_RUNTIME_ERROR = {
  NATIVE_MODULE_MISSING: 'native_module_missing',
  LOAD_FAILED: 'load_failed',
} as const;

export type DirectConnectivityRuntimeError = typeof DIRECT_CONNECTIVITY_RUNTIME_ERROR[keyof typeof DIRECT_CONNECTIVITY_RUNTIME_ERROR];

export interface DirectConnectivityRuntimeStatus {
  state: typeof DIRECT_CONNECTIVITY_RUNTIME_STATE[keyof typeof DIRECT_CONNECTIVITY_RUNTIME_STATE];
  error?: DirectConnectivityRuntimeError;
}

export interface DirectConnectivityCandidateInfo {
  address: string;
  port: number;
  type: string;
  transportType: string;
}

export interface DirectConnectivityProbeResult {
  route: DirectConnectivityRoute;
  rttMs: number;
  localCandidate: DirectConnectivityCandidateInfo;
  remoteCandidate: DirectConnectivityCandidateInfo;
}

export interface DirectConnectivityProbeDiagnostics {
  stage: DirectConnectivityProbeStage;
  browserCandidateTypes: DirectConnectivityCandidateType[];
  daemonCandidateTypes: DirectConnectivityCandidateType[];
}

export interface DirectFileTransferLeaseBinding {
  serverId: string;
  browserTabId: string;
  leaseId: string;
  leaseGeneration: number;
  daemonGeneration: number;
}

export interface DirectFileTransferAttemptBinding extends DirectFileTransferLeaseBinding {
  requestId: string;
  attemptId: string;
  attempt: number;
  direction: DirectFileTransferDirection;
  operationId: string;
}

/**
 * Every data-plane frame must echo the EXACT attempt tuple it belongs to.
 *
 * The correlation pair (requestId, attemptId) is not sufficient on its own: a
 * frame can be well formed and carry the right pair while belonging to another
 * daemon generation, another lease, another operation, another direction or an
 * earlier attempt of the same operation. For uploads that is not cosmetic —
 * the offset such a frame carries becomes the resume boundary a later attempt
 * starts from, i.e. the value that decides which bytes are never sent again.
 *
 * Shared so the two ends cannot drift: the daemon validated the full tuple
 * while the browser checked only two fields, and that asymmetry WAS the
 * bypass. One definition, used by both.
 */
export function directFileTransferAttemptBindingMatches(
  expected: DirectFileTransferAttemptBinding,
  value: Record<string, unknown>,
): boolean {
  return value.serverId === expected.serverId
    && value.browserTabId === expected.browserTabId
    && value.leaseId === expected.leaseId
    && value.leaseGeneration === expected.leaseGeneration
    && value.daemonGeneration === expected.daemonGeneration
    && value.requestId === expected.requestId
    && value.attemptId === expected.attemptId
    && value.attempt === expected.attempt
    && value.direction === expected.direction
    && value.operationId === expected.operationId;
}

export interface DirectFileTransferLeaseInit {
  type: typeof DIRECT_FILE_TRANSFER_MSG.LEASE_INIT;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  requestId: string;
  serverId: string;
  browserTabId: string;
}

export interface DirectFileTransferLeaseReady extends DirectFileTransferLeaseBinding {
  type: typeof DIRECT_FILE_TRANSFER_MSG.LEASE_READY;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  requestId: string;
  resumeTicket: string;
  /** Server-authoritative idle deadline; distinct from the 10-minute ticket expiry. */
  idleExpiresAt: number;
  expiresAt: number;
  iceServers: DirectFileTransferIceServerConfig[];
}

/** Daemon acknowledgement for LEASE_PREPARE; only Server mints resume tickets. */
export interface DirectFileTransferLeasePrepared extends DirectFileTransferLeaseBinding {
  type: typeof DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  requestId: string;
}

export interface DirectFileTransferLeaseRebind {
  type: typeof DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  requestId: string;
  serverId: string;
  browserTabId: string;
  leaseId: string;
  leaseGeneration: number;
  resumeTicket: string;
}

export interface DirectFileTransferLeaseRebound extends DirectFileTransferLeaseBinding {
  type: typeof DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  requestId: string;
  resumeTicket: string;
  /** Server-authoritative idle deadline; distinct from the 10-minute ticket expiry. */
  idleExpiresAt: number;
  expiresAt: number;
  iceServers: DirectFileTransferIceServerConfig[];
}

/** Server-to-daemon only. It creates or reuses an inert peer before any offer. */
export interface DirectFileTransferLeasePrepare extends DirectFileTransferLeaseBinding {
  type: typeof DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  requestId: string;
  expiresAt: number;
  iceServers: DirectFileTransferIceServerConfig[];
}

/** Signed by the persistent Server secret; never a transferable file authority. */
export interface DirectFileTransferResumeTicketClaims {
  type: typeof DIRECT_FILE_TRANSFER_RESUME_TICKET_TYPE;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  userId: string;
  browserTabId: string;
  serverId: string;
  leaseId: string;
  leaseGeneration: number;
  expiresAt: number;
  /** JWT standard claims emitted by the Server signer; never supplied by a browser. */
  iat?: number;
  exp?: number;
}

interface DirectFileTransferOperationInitBase extends DirectFileTransferAttemptBinding {
  type: typeof DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  sessionName?: string;
}

export interface DirectFileTransferUploadInit extends DirectFileTransferOperationInitBase {
  direction: typeof DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD;
  clientUploadId: string;
  filename: string;
  size: number;
  mime?: string;
  sha256?: string;
  destinationDirectory?: string;
}

export interface DirectFileTransferDownloadInit extends DirectFileTransferOperationInitBase {
  direction: typeof DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD;
  clientDownloadId: string;
  previewHandle: string;
}

export type DirectFileTransferOperationInit = DirectFileTransferUploadInit | DirectFileTransferDownloadInit;

interface DirectFileTransferAuthorizedBase extends DirectFileTransferAttemptBinding {
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  authority: string;
  authorityExpiresAt: number;
  channelLabel: string;
  iceServers: DirectFileTransferIceServerConfig[];
}

type DirectFileTransferOperationWithoutControlType =
  | Omit<DirectFileTransferUploadInit, 'type'>
  | Omit<DirectFileTransferDownloadInit, 'type'>;

export type DirectFileTransferAuthorized = DirectFileTransferOperationWithoutControlType
  & DirectFileTransferAuthorizedBase
  & { type: typeof DIRECT_FILE_TRANSFER_MSG.AUTHORIZED };

export type DirectFileTransferPrepare = DirectFileTransferOperationWithoutControlType
  & DirectFileTransferAuthorizedBase
  & { type: typeof DIRECT_FILE_TRANSFER_MSG.PREPARE };

export interface DirectFileTransferLeaseOffer extends DirectFileTransferLeaseBinding {
  type: typeof DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  requestId: string;
  sdp: string;
}

export interface DirectFileTransferLeaseAnswer extends Omit<DirectFileTransferLeaseOffer, 'type'> {
  type: typeof DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER;
}

export interface DirectFileTransferLeaseIce extends DirectFileTransferLeaseBinding {
  type: typeof DIRECT_FILE_TRANSFER_MSG.LEASE_ICE;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  requestId: string;
  candidate: string;
  mid: string;
}

export interface DirectFileTransferCancel extends DirectFileTransferAttemptBinding {
  type: typeof DIRECT_FILE_TRANSFER_MSG.CANCEL;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  authority: string;
  reason: DirectFileTransferError;
}

export interface DirectFileTransferStatusQuery extends DirectFileTransferAttemptBinding {
  type: typeof DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
}

export interface DirectFileTransferStatus extends DirectFileTransferAttemptBinding {
  type: typeof DIRECT_FILE_TRANSFER_MSG.STATUS;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  state: DirectFileTransferOperationState;
  attachment?: AttachmentRef;
}

export interface DirectFileTransferTerminal extends DirectFileTransferAttemptBinding {
  type: typeof DIRECT_FILE_TRANSFER_MSG.TERMINAL;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  state: DirectFileTransferTerminalState;
  attachment?: AttachmentRef;
  error?: DirectFileTransferError;
}

/**
 * Daemon terminal/status frames have no lease lifetime metadata.  The Server
 * attaches this absolute, authoritative deadline only after it has removed
 * the last active attempt and re-armed the reusable lease's idle window.
 */
export interface DirectFileTransferServerTerminal extends DirectFileTransferTerminal {
  idleExpiresAt: number;
}

type DirectFileTransferNonterminalState = Exclude<
  DirectFileTransferOperationState,
  DirectFileTransferTerminalState
>;

export type DirectFileTransferServerStatus =
  | (Omit<DirectFileTransferStatus, 'state'> & { state: DirectFileTransferNonterminalState })
  | (Omit<DirectFileTransferStatus, 'state'> & {
    state: DirectFileTransferTerminalState;
    idleExpiresAt: number;
  });

export interface DirectFileTransferLeaseError {
  type: typeof DIRECT_FILE_TRANSFER_MSG.ERROR;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  scope: typeof DIRECT_FILE_TRANSFER_ERROR_SCOPE.LEASE;
  requestId: string;
  error: DirectFileTransferError;
  retryable: boolean;
  detail?: string;
}

export interface DirectFileTransferOperationError extends DirectFileTransferAttemptBinding {
  type: typeof DIRECT_FILE_TRANSFER_MSG.ERROR;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  scope: typeof DIRECT_FILE_TRANSFER_ERROR_SCOPE.OPERATION;
  error: DirectFileTransferError;
  retryable: boolean;
  detail?: string;
}

export type DirectFileTransferErrorMessage = DirectFileTransferLeaseError | DirectFileTransferOperationError;

/**
 * A daemon error is exact and never selects lease lifetime.  When Server has
 * terminally removed the routed attempt, it may attach its freshly re-armed
 * idle deadline to the browser-facing copy while preserving retryability.
 */
export interface DirectFileTransferServerOperationError extends DirectFileTransferOperationError {
  idleExpiresAt?: number;
}

export type DirectFileTransferServerErrorMessage =
  | DirectFileTransferLeaseError
  | DirectFileTransferServerOperationError;

export interface DirectFileTransferDataStart extends DirectFileTransferAttemptBinding {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.START;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  authority: string;
  /**
   * UPLOAD only: byte offset this attempt wants to continue from.
   *
   * A transient DataChannel/ICE replacement used to cost the whole file: the
   * next attempt started at zero, or the operation gave up and re-sent
   * everything over the HTTP relay. The sender already learns a durable offset
   * from the receiver (see `committedBytes` on CREDIT), so it can ask to
   * continue from exactly that point.
   *
   * Advisory, never authority. The receiver accepts it only when the operation,
   * authorized identity, declared size and the actual length of its own partial
   * file all agree; anything else fails closed. Absent or 0 means "from the
   * beginning", which is the only shape older senders can produce.
   */
  resumeOffset?: number;
}

export type DirectFileTransferDataAccepted = DirectFileTransferAttemptBinding & {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
} & ({ direction: typeof DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD } | {
  direction: typeof DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD;
  filename: string;
  mime?: string;
  size: number;
});

export interface DirectFileTransferDataCredit extends DirectFileTransferAttemptBinding {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  creditBytes: number;
  /**
   * UPLOAD only: bytes the receiver has durably written, monotonic per attempt.
   *
   * The upload direction had no receiver-to-sender signal at all — CREDIT was
   * validated for DOWNLOAD exclusively — so a browser sending a file could only
   * judge liveness from its own `RTCDataChannel.bufferedAmount`. That cannot
   * distinguish "the peer is committing steadily but slowly" from "the peer is
   * gone", and a single drain slower than the no-progress budget killed a
   * transfer that was in fact advancing the whole time.
   *
   * Emitted by the daemon AFTER the write resolves, so it is a commit point and
   * never a promise. Absent from DOWNLOAD credits, which carry only a window.
   */
  committedBytes?: number;
}

export interface DirectFileTransferDataFinish extends DirectFileTransferAttemptBinding {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.FINISH;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  totalBytes: number;
  sha256?: string;
}

export interface DirectFileTransferDataUploadCommitted extends DirectFileTransferAttemptBinding {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.UPLOAD_COMMITTED;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  attachment: AttachmentRef;
}

export interface DirectFileTransferDataDownloadCommitted extends DirectFileTransferAttemptBinding {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.DOWNLOAD_COMMITTED;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  totalBytes: number;
}

export interface DirectFileTransferDataHealthProbe extends DirectFileTransferLeaseBinding {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.HEALTH_PROBE;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  nonce: string;
}

export interface DirectFileTransferDataHealthPong extends DirectFileTransferLeaseBinding {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.HEALTH_PONG;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  nonce: string;
  rttMs: number;
  localCandidate: DirectConnectivityCandidateInfo;
  remoteCandidate: DirectConnectivityCandidateInfo;
}

export interface DirectFileTransferDataError extends DirectFileTransferAttemptBinding {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.ERROR;
  protocolVersion: typeof DIRECT_FILE_TRANSFER_PROTOCOL_VERSION;
  error: DirectFileTransferError;
}

export type DirectFileTransferBrowserMessage =
  | DirectFileTransferLeaseInit
  | DirectFileTransferLeaseRebind
  | DirectFileTransferOperationInit
  | DirectFileTransferLeaseOffer
  | DirectFileTransferLeaseIce
  | DirectFileTransferCancel
  | DirectFileTransferStatusQuery;

export type DirectFileTransferDaemonCommand =
  | DirectFileTransferLeasePrepare
  | DirectFileTransferLeaseRebind
  | DirectFileTransferPrepare
  | DirectFileTransferLeaseOffer
  | DirectFileTransferLeaseIce
  | DirectFileTransferCancel
  | DirectFileTransferStatusQuery;

export type DirectFileTransferDaemonMessage =
  | DirectFileTransferLeasePrepared
  | DirectFileTransferLeaseRebound
  | DirectFileTransferLeaseAnswer
  | DirectFileTransferLeaseIce
  | DirectFileTransferStatus
  | DirectFileTransferTerminal
  | DirectFileTransferErrorMessage;

export type DirectFileTransferServerMessage =
  | DirectFileTransferLeaseReady
  | DirectFileTransferLeaseRebound
  | DirectFileTransferAuthorized
  | DirectFileTransferLeaseAnswer
  | DirectFileTransferLeaseIce
  | DirectFileTransferServerStatus
  | DirectFileTransferServerTerminal
  | DirectFileTransferServerErrorMessage;

export type DirectFileTransferDataMessage =
  | DirectFileTransferDataStart
  | DirectFileTransferDataAccepted
  | DirectFileTransferDataCredit
  | DirectFileTransferDataFinish
  | DirectFileTransferDataUploadCommitted
  | DirectFileTransferDataDownloadCommitted
  | DirectFileTransferDataHealthProbe
  | DirectFileTransferDataHealthPong
  | DirectFileTransferDataError;

export type DirectFileTransferValidationResult<T> = { ok: true; value: T } | { ok: false; error: typeof DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };

const IDENTIFIER_RE = /^[A-Za-z0-9_-]{8,128}$/;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{16,4096}$/;
const JWT_TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DIRECTIONS = new Set<string>(Object.values(DIRECT_FILE_TRANSFER_DIRECTION));
const OPERATION_STATES = new Set<string>(Object.values(DIRECT_FILE_TRANSFER_OPERATION_STATE));
const TERMINAL_STATES = new Set<string>(Object.values(DIRECT_FILE_TRANSFER_TERMINAL_STATE));
const ERRORS = new Set<string>(Object.values(DIRECT_FILE_TRANSFER_ERROR));
const RUNTIME_STATES = new Set<string>(Object.values(DIRECT_CONNECTIVITY_RUNTIME_STATE));
const RUNTIME_ERRORS = new Set<string>(Object.values(DIRECT_CONNECTIVITY_RUNTIME_ERROR));

function invalid<T>(): DirectFileTransferValidationResult<T> {
  return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBoundedString(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && utf8Bytes(value) <= maxBytes;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is number {
  return isPositiveSafeInteger(value);
}

function isOpaqueToken(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && utf8Bytes(value) <= maxBytes && OPAQUE_TOKEN_RE.test(value);
}

export function isDirectFileTransferRequestId(value: unknown): value is string {
  return typeof value === 'string' && utf8Bytes(value) <= DIRECT_FILE_TRANSFER_LIMITS.REQUEST_ID_BYTES && IDENTIFIER_RE.test(value);
}

export function isDirectFileTransferAttemptId(value: unknown): value is string {
  return typeof value === 'string' && utf8Bytes(value) <= DIRECT_FILE_TRANSFER_LIMITS.ATTEMPT_ID_BYTES && IDENTIFIER_RE.test(value);
}

export function isDirectFileTransferOperationId(value: unknown): value is string {
  return typeof value === 'string' && utf8Bytes(value) <= DIRECT_FILE_TRANSFER_LIMITS.OPERATION_ID_BYTES && IDENTIFIER_RE.test(value);
}

export function isDirectFileTransferClientUploadId(value: unknown): value is string {
  return typeof value === 'string' && utf8Bytes(value) <= DIRECT_FILE_TRANSFER_LIMITS.CLIENT_UPLOAD_ID_BYTES && IDENTIFIER_RE.test(value);
}

export function isDirectFileTransferClientDownloadId(value: unknown): value is string {
  return typeof value === 'string' && utf8Bytes(value) <= DIRECT_FILE_TRANSFER_LIMITS.CLIENT_DOWNLOAD_ID_BYTES && IDENTIFIER_RE.test(value);
}

export function isDirectFileTransferSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isDirectConnectivityRuntimeStatus(value: unknown): value is DirectConnectivityRuntimeStatus {
  return isRecord(value)
    && hasExactKeys(value, ['state'], ['error'])
    && typeof value.state === 'string'
    && RUNTIME_STATES.has(value.state)
    && (value.error === undefined || (typeof value.error === 'string' && RUNTIME_ERRORS.has(value.error)));
}

function directIceUrlKind(value: unknown): 'stun' | 'turn' | undefined {
  if (!isBoundedString(value, DIRECT_FILE_TRANSFER_LIMITS.ICE_SERVER_URL_BYTES) || /\s/.test(value)) return undefined;
  if (/^stuns?:[^:]/i.test(value)) return 'stun';
  if (/^turns?:[^:]/i.test(value)) return 'turn';
  return undefined;
}

export function isDirectFileTransferIceServerConfig(value: unknown): value is DirectFileTransferIceServerConfig {
  if (typeof value === 'string') return directIceUrlKind(value) !== undefined;
  if (!isRecord(value) || !hasExactKeys(value, ['urls'], ['username', 'credential'])) return false;
  if (!Array.isArray(value.urls) || value.urls.length === 0 || value.urls.length > DIRECT_FILE_TRANSFER_LIMITS.ICE_SERVER_URLS_PER_ENTRY) return false;
  const kinds = value.urls.map(directIceUrlKind);
  if (kinds.some((kind) => kind === undefined)) return false;
  const hasTurn = kinds.includes('turn');
  const hasStun = kinds.includes('stun');
  if (hasTurn && hasStun) return false;
  return hasTurn
    ? isBoundedString(value.username, DIRECT_FILE_TRANSFER_LIMITS.ICE_SERVER_USERNAME_BYTES)
      && isBoundedString(value.credential, DIRECT_FILE_TRANSFER_LIMITS.ICE_SERVER_CREDENTIAL_BYTES)
    : value.username === undefined && value.credential === undefined;
}

function isIceServers(value: unknown): value is DirectFileTransferIceServerConfig[] {
  return Array.isArray(value)
    && value.length <= DIRECT_FILE_TRANSFER_LIMITS.ICE_SERVER_ENTRIES
    && value.every(isDirectFileTransferIceServerConfig);
}

function isDirectConnectivityCandidateInfo(value: unknown): value is DirectConnectivityCandidateInfo {
  return isRecord(value)
    && hasExactKeys(value, ['address', 'port', 'type', 'transportType'])
    && isBoundedString(value.address, DIRECT_FILE_TRANSFER_LIMITS.PROBE_CANDIDATE_ADDRESS_BYTES)
    && typeof value.port === 'number'
    && Number.isInteger(value.port)
    && value.port >= 0 && value.port <= 65_535
    && isBoundedString(value.type, DIRECT_FILE_TRANSFER_LIMITS.PROBE_CANDIDATE_TYPE_BYTES)
    && isBoundedString(value.transportType, DIRECT_FILE_TRANSFER_LIMITS.PROBE_CANDIDATE_TYPE_BYTES);
}

export function isPrivateNetworkAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = normalized.split('.').map((part) => Number(part));
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return ipv4[0] === 10
      || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168)
      || ipv4[0] === 127
      || (ipv4[0] === 169 && ipv4[1] === 254);
  }
  return normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb');
}

export function classifyDirectConnectivityRoute(localCandidate: DirectConnectivityCandidateInfo, remoteCandidate: DirectConnectivityCandidateInfo): DirectConnectivityRoute {
  if (localCandidate.type === DIRECT_CONNECTIVITY_ROUTE.RELAY || remoteCandidate.type === DIRECT_CONNECTIVITY_ROUTE.RELAY) return DIRECT_CONNECTIVITY_ROUTE.RELAY;
  return isPrivateNetworkAddress(localCandidate.address) && isPrivateNetworkAddress(remoteCandidate.address)
    ? DIRECT_CONNECTIVITY_ROUTE.LAN_DIRECT
    : DIRECT_CONNECTIVITY_ROUTE.DIRECT;
}

export function inferDirectConnectivityEndpointKind(candidate: DirectConnectivityCandidateInfo): DirectConnectivityEndpointKind {
  if (candidate.type === DIRECT_CONNECTIVITY_CANDIDATE_TYPE.RELAY) return DIRECT_CONNECTIVITY_ENDPOINT_KIND.TURN_RELAY;
  if (candidate.type === DIRECT_CONNECTIVITY_CANDIDATE_TYPE.PEER_REFLEXIVE) return DIRECT_CONNECTIVITY_ENDPOINT_KIND.PEER_REFLEXIVE;
  if (candidate.type === DIRECT_CONNECTIVITY_CANDIDATE_TYPE.SERVER_REFLEXIVE) return DIRECT_CONNECTIVITY_ENDPOINT_KIND.NAT_MAPPED;
  if (candidate.type === DIRECT_CONNECTIVITY_CANDIDATE_TYPE.HOST) {
    return isPrivateNetworkAddress(candidate.address)
      ? DIRECT_CONNECTIVITY_ENDPOINT_KIND.PRIVATE_ROUTED
      : DIRECT_CONNECTIVITY_ENDPOINT_KIND.PUBLIC_DIRECT;
  }
  return DIRECT_CONNECTIVITY_ENDPOINT_KIND.UNKNOWN;
}

export function inferDirectConnectivityEndpointKindFromTypes(candidateTypes: readonly DirectConnectivityCandidateType[]): DirectConnectivityEndpointKind {
  if (candidateTypes.includes(DIRECT_CONNECTIVITY_CANDIDATE_TYPE.RELAY)) return DIRECT_CONNECTIVITY_ENDPOINT_KIND.TURN_RELAY;
  if (candidateTypes.includes(DIRECT_CONNECTIVITY_CANDIDATE_TYPE.PEER_REFLEXIVE)) return DIRECT_CONNECTIVITY_ENDPOINT_KIND.PEER_REFLEXIVE;
  if (candidateTypes.includes(DIRECT_CONNECTIVITY_CANDIDATE_TYPE.SERVER_REFLEXIVE)) return DIRECT_CONNECTIVITY_ENDPOINT_KIND.NAT_MAPPED;
  if (candidateTypes.includes(DIRECT_CONNECTIVITY_CANDIDATE_TYPE.HOST)) return DIRECT_CONNECTIVITY_ENDPOINT_KIND.HOST_CANDIDATE;
  return DIRECT_CONNECTIVITY_ENDPOINT_KIND.UNKNOWN;
}

function isLeaseBinding(value: Record<string, unknown>, requireDaemonGeneration = true): boolean {
  return isBoundedString(value.serverId, DIRECT_FILE_TRANSFER_LIMITS.SERVER_ID_BYTES)
    && isBoundedString(value.browserTabId, DIRECT_FILE_TRANSFER_LIMITS.BROWSER_TAB_ID_BYTES)
    && IDENTIFIER_RE.test(value.browserTabId as string)
    && isBoundedString(value.leaseId, DIRECT_FILE_TRANSFER_LIMITS.LEASE_ID_BYTES)
    && IDENTIFIER_RE.test(value.leaseId as string)
    && isPositiveSafeInteger(value.leaseGeneration)
    && (!requireDaemonGeneration || isPositiveSafeInteger(value.daemonGeneration));
}

function isAttemptBinding(value: Record<string, unknown>): boolean {
  return isLeaseBinding(value)
    && isDirectFileTransferRequestId(value.requestId)
    && isDirectFileTransferAttemptId(value.attemptId)
    && isPositiveSafeInteger(value.attempt)
    && value.attempt <= DIRECT_FILE_TRANSFER_LIMITS.MAX_ATTEMPTS
    && typeof value.direction === 'string' && DIRECTIONS.has(value.direction)
    && isDirectFileTransferOperationId(value.operationId);
}

function isAuthority(value: unknown): value is string {
  return isOpaqueToken(value, DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_BYTES);
}

function isResumeTicket(value: unknown): value is string {
  return typeof value === 'string'
    && utf8Bytes(value) <= DIRECT_FILE_TRANSFER_LIMITS.RESUME_TICKET_BYTES
    && JWT_TOKEN_RE.test(value);
}

function isUploadInit(value: Record<string, unknown>, type: string): boolean {
  return hasExactKeys(value,
    ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'clientUploadId', 'filename', 'size'],
    ['sessionName', 'mime', 'sha256', 'destinationDirectory'],
  )
    && value.type === type
    && value.protocolVersion === DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
    && isAttemptBinding(value)
    && value.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD
    && isDirectFileTransferClientUploadId(value.clientUploadId)
    && value.clientUploadId === value.operationId
    && isBoundedString(value.filename, DIRECT_FILE_TRANSFER_LIMITS.FILENAME_BYTES)
    && isDirectFileTransferSize(value.size)
    && (value.sessionName === undefined || isBoundedString(value.sessionName, DIRECT_FILE_TRANSFER_LIMITS.SESSION_NAME_BYTES))
    && (value.mime === undefined || isBoundedString(value.mime, DIRECT_FILE_TRANSFER_LIMITS.MIME_BYTES))
    && (value.sha256 === undefined || (typeof value.sha256 === 'string' && SHA256_RE.test(value.sha256)))
    && (value.destinationDirectory === undefined
      || isBoundedString(value.destinationDirectory, FILE_TRANSFER_PATH_MAX_BYTES));
}

function isDownloadInit(value: Record<string, unknown>, type: string): boolean {
  return hasExactKeys(value,
    ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'clientDownloadId', 'previewHandle'],
    ['sessionName'],
  )
    && value.type === type
    && value.protocolVersion === DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
    && isAttemptBinding(value)
    && value.direction === DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD
    && isDirectFileTransferClientDownloadId(value.clientDownloadId)
    && value.clientDownloadId === value.operationId
    && isBoundedString(value.previewHandle, DIRECT_FILE_TRANSFER_LIMITS.PREVIEW_HANDLE_BYTES)
    && (value.sessionName === undefined || isBoundedString(value.sessionName, DIRECT_FILE_TRANSFER_LIMITS.SESSION_NAME_BYTES));
}

function isOperationInit(value: Record<string, unknown>, type: string): boolean {
  return isUploadInit(value, type) || isDownloadInit(value, type);
}

function authorityKeysFor(value: Record<string, unknown>, type: string): boolean {
  const common = ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'authority', 'authorityExpiresAt', 'channelLabel', 'iceServers'];
  if (value.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD) {
    const { authority: _authority, authorityExpiresAt: _authorityExpiresAt, channelLabel: _channelLabel, iceServers: _iceServers, ...operation } = value;
    return hasExactKeys(value, [...common, 'clientUploadId', 'filename', 'size'], ['sessionName', 'mime', 'sha256', 'destinationDirectory'])
      && isUploadInit(operation, type);
  }
  if (value.direction === DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD) {
    const { authority: _authority, authorityExpiresAt: _authorityExpiresAt, channelLabel: _channelLabel, iceServers: _iceServers, ...operation } = value;
    return hasExactKeys(value, [...common, 'clientDownloadId', 'previewHandle'], ['sessionName'])
      && isDownloadInit(operation, type);
  }
  return false;
}

function isAuthorized(value: Record<string, unknown>, type: string): boolean {
  return authorityKeysFor(value, type)
    && isAuthority(value.authority)
    && isTimestamp(value.authorityExpiresAt)
    && isBoundedString(value.channelLabel, DIRECT_FILE_TRANSFER_LIMITS.CHANNEL_LABEL_BYTES)
    && isIceServers(value.iceServers);
}

function isLeaseOfferOrAnswer(value: Record<string, unknown>, type: string): boolean {
  return hasExactKeys(value, ['type', 'protocolVersion', 'requestId', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'sdp'])
    && value.type === type
    && value.protocolVersion === DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
    && isDirectFileTransferRequestId(value.requestId)
    && isLeaseBinding(value)
    && isBoundedString(value.sdp, DIRECT_FILE_TRANSFER_LIMITS.SDP_BYTES);
}

function isLeaseIce(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['type', 'protocolVersion', 'requestId', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'candidate', 'mid'])
    && value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_ICE
    && value.protocolVersion === DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
    && isDirectFileTransferRequestId(value.requestId)
    && isLeaseBinding(value)
    && isBoundedString(value.candidate, DIRECT_FILE_TRANSFER_LIMITS.ICE_CANDIDATE_BYTES)
    && isBoundedString(value.mid, DIRECT_FILE_TRANSFER_LIMITS.ICE_MID_BYTES, true);
}

function isCancel(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'authority', 'reason'])
    && value.type === DIRECT_FILE_TRANSFER_MSG.CANCEL
    && value.protocolVersion === DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
    && isAttemptBinding(value)
    && isAuthority(value.authority)
    && typeof value.reason === 'string' && ERRORS.has(value.reason);
}

function isStatusQuery(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId'])
    && value.type === DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY
    && value.protocolVersion === DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
    && isAttemptBinding(value);
}

function validateLeaseReady(value: Record<string, unknown>, type: string): boolean {
  return hasExactKeys(value, ['type', 'protocolVersion', 'requestId', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'resumeTicket', 'idleExpiresAt', 'expiresAt', 'iceServers'])
    && value.type === type
    && value.protocolVersion === DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
    && isDirectFileTransferRequestId(value.requestId)
    && isLeaseBinding(value)
    && isResumeTicket(value.resumeTicket)
    && isTimestamp(value.idleExpiresAt)
    && isTimestamp(value.expiresAt)
    && isIceServers(value.iceServers);
}

export function validateDirectFileTransferBrowserMessage(value: unknown): DirectFileTransferValidationResult<DirectFileTransferBrowserMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') return invalid();
  if (value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT) {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'requestId', 'serverId', 'browserTabId'])
      || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
      || !isDirectFileTransferRequestId(value.requestId)
      || !isBoundedString(value.serverId, DIRECT_FILE_TRANSFER_LIMITS.SERVER_ID_BYTES)
      || !isBoundedString(value.browserTabId, DIRECT_FILE_TRANSFER_LIMITS.BROWSER_TAB_ID_BYTES)
      || !IDENTIFIER_RE.test(value.browserTabId)) return invalid();
    return { ok: true, value: value as unknown as DirectFileTransferLeaseInit };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND) {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'requestId', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'resumeTicket'])
      || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
      || !isDirectFileTransferRequestId(value.requestId)
      || !isLeaseBinding({ ...value, daemonGeneration: 1 }, false)
      || !isResumeTicket(value.resumeTicket)) return invalid();
    return { ok: true, value: value as unknown as DirectFileTransferLeaseRebind };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT && isOperationInit(value, DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT)) {
    return { ok: true, value: value as unknown as DirectFileTransferOperationInit };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER && isLeaseOfferOrAnswer(value, DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER)) return { ok: true, value: value as unknown as DirectFileTransferLeaseOffer };
  if (value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_ICE && isLeaseIce(value)) return { ok: true, value: value as unknown as DirectFileTransferLeaseIce };
  if (value.type === DIRECT_FILE_TRANSFER_MSG.CANCEL && isCancel(value)) return { ok: true, value: value as unknown as DirectFileTransferCancel };
  if (value.type === DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY && isStatusQuery(value)) return { ok: true, value: value as unknown as DirectFileTransferStatusQuery };
  return invalid();
}

export function validateDirectFileTransferDaemonCommand(value: unknown): DirectFileTransferValidationResult<DirectFileTransferDaemonCommand> {
  if (!isRecord(value) || typeof value.type !== 'string') return invalid();
  if (value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE) {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'requestId', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'expiresAt', 'iceServers'])
      || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
      || !isDirectFileTransferRequestId(value.requestId)
      || !isLeaseBinding(value)
      || !isTimestamp(value.expiresAt)
      || !isIceServers(value.iceServers)) return invalid();
    return { ok: true, value: value as unknown as DirectFileTransferLeasePrepare };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND) {
    const parsed = validateDirectFileTransferBrowserMessage(value);
    return parsed.ok && parsed.value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND
      ? { ok: true, value: parsed.value }
      : invalid();
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.PREPARE && isAuthorized(value, DIRECT_FILE_TRANSFER_MSG.PREPARE)) return { ok: true, value: value as unknown as DirectFileTransferPrepare };
  const browser = validateDirectFileTransferBrowserMessage(value);
  if (!browser.ok
    || browser.value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT
    || browser.value.type === DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT) return invalid();
  return { ok: true, value: browser.value };
}

function isDaemonTerminalBinding(value: Record<string, unknown>, type: string): boolean {
  return hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'state'], ['attachment', 'error'])
    && value.type === type
    && value.protocolVersion === DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
    && isAttemptBinding(value);
}

function isDaemonStatus(value: Record<string, unknown>): boolean {
  const attachment = value.attachment === undefined ? undefined : validateAttachmentRef(value.attachment, { maxSize: Number.MAX_SAFE_INTEGER });
  return hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'state'], ['attachment'])
    && value.type === DIRECT_FILE_TRANSFER_MSG.STATUS
    && value.protocolVersion === DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
    && isAttemptBinding(value)
    && typeof value.state === 'string' && OPERATION_STATES.has(value.state)
    && (value.attachment === undefined || !!attachment);
}

function isServerStatus(value: Record<string, unknown>): boolean {
  const attachment = value.attachment === undefined ? undefined : validateAttachmentRef(value.attachment, { maxSize: Number.MAX_SAFE_INTEGER });
  if (value.type !== DIRECT_FILE_TRANSFER_MSG.STATUS
    || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
    || !isAttemptBinding(value)
    || typeof value.state !== 'string' || !OPERATION_STATES.has(value.state)
    || (value.attachment !== undefined && !attachment)) return false;
  const terminal = TERMINAL_STATES.has(value.state);
  return terminal
    ? hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'state', 'idleExpiresAt'], ['attachment'])
      && isTimestamp(value.idleExpiresAt)
    : hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'state'], ['attachment']);
}

function isServerTerminal(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'state', 'idleExpiresAt'], ['attachment', 'error'])
    && value.type === DIRECT_FILE_TRANSFER_MSG.TERMINAL
    && value.protocolVersion === DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
    && isAttemptBinding(value)
    && isTimestamp(value.idleExpiresAt);
}

export function validateDirectFileTransferDaemonMessage(value: unknown): DirectFileTransferValidationResult<DirectFileTransferDaemonMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') return invalid();
  if (value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED) {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'requestId', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration'])
      || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
      || !isDirectFileTransferRequestId(value.requestId)
      || !isLeaseBinding(value)) return invalid();
    return { ok: true, value: value as unknown as DirectFileTransferLeasePrepared };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND && validateLeaseReady(value, DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND)) return { ok: true, value: value as unknown as DirectFileTransferLeaseRebound };
  if (value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER && isLeaseOfferOrAnswer(value, DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER)) return { ok: true, value: value as unknown as DirectFileTransferLeaseAnswer };
  if (value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_ICE && isLeaseIce(value)) return { ok: true, value: value as unknown as DirectFileTransferLeaseIce };
  if (value.type === DIRECT_FILE_TRANSFER_MSG.STATUS) {
    const attachment = value.attachment === undefined ? undefined : validateAttachmentRef(value.attachment, { maxSize: Number.MAX_SAFE_INTEGER });
    if (!isDaemonStatus(value)) return invalid();
    return { ok: true, value: { ...value, ...(attachment ? { attachment } : {}) } as unknown as DirectFileTransferStatus };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.TERMINAL) {
    const attachment = value.attachment === undefined ? undefined : validateAttachmentRef(value.attachment, { maxSize: Number.MAX_SAFE_INTEGER });
    if (!isDaemonTerminalBinding(value, DIRECT_FILE_TRANSFER_MSG.TERMINAL)
      || typeof value.state !== 'string' || !TERMINAL_STATES.has(value.state)
      || (value.error !== undefined && (typeof value.error !== 'string' || !ERRORS.has(value.error)))
      || (value.attachment !== undefined && !attachment)
      || (value.state === DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED && value.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD && !attachment)
      || (value.state === DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED && value.error !== undefined)
      || (value.state !== DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED && value.attachment !== undefined)) return invalid();
    return { ok: true, value: { ...value, ...(attachment ? { attachment } : {}) } as unknown as DirectFileTransferTerminal };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.ERROR) {
    const common = value.protocolVersion === DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
      && typeof value.error === 'string' && ERRORS.has(value.error)
      && typeof value.retryable === 'boolean'
      && (value.detail === undefined || isBoundedString(value.detail, DIRECT_FILE_TRANSFER_LIMITS.ERROR_DETAIL_BYTES));
    if (value.scope === DIRECT_FILE_TRANSFER_ERROR_SCOPE.LEASE) {
      if (!hasExactKeys(value, ['type', 'protocolVersion', 'scope', 'requestId', 'error', 'retryable'], ['detail'])
        || !common || !isDirectFileTransferRequestId(value.requestId)) return invalid();
      return { ok: true, value: value as unknown as DirectFileTransferLeaseError };
    }
    if (value.scope === DIRECT_FILE_TRANSFER_ERROR_SCOPE.OPERATION) {
      if (!hasExactKeys(value, ['type', 'protocolVersion', 'scope', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'error', 'retryable'], ['detail'])
        || !common || !isAttemptBinding(value)) return invalid();
      return { ok: true, value: value as unknown as DirectFileTransferOperationError };
    }
    return invalid();
  }
  return invalid();
}

export function validateDirectFileTransferAuthorized(value: unknown): DirectFileTransferValidationResult<DirectFileTransferAuthorized> {
  if (!isRecord(value) || value.type !== DIRECT_FILE_TRANSFER_MSG.AUTHORIZED || !isAuthorized(value, DIRECT_FILE_TRANSFER_MSG.AUTHORIZED)) return invalid();
  return { ok: true, value: value as unknown as DirectFileTransferAuthorized };
}

export function validateDirectFileTransferResumeTicketClaims(value: unknown): DirectFileTransferValidationResult<DirectFileTransferResumeTicketClaims> {
  if (!isRecord(value)
    || !hasExactKeys(value, ['type', 'protocolVersion', 'userId', 'browserTabId', 'serverId', 'leaseId', 'leaseGeneration', 'expiresAt'], ['iat', 'exp'])
    || value.type !== DIRECT_FILE_TRANSFER_RESUME_TICKET_TYPE
    || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
    || !isBoundedString(value.userId, DIRECT_FILE_TRANSFER_LIMITS.USER_ID_BYTES)
    || !isBoundedString(value.serverId, DIRECT_FILE_TRANSFER_LIMITS.SERVER_ID_BYTES)
    || !isBoundedString(value.browserTabId, DIRECT_FILE_TRANSFER_LIMITS.BROWSER_TAB_ID_BYTES)
    || !IDENTIFIER_RE.test(value.browserTabId)
    || !isBoundedString(value.leaseId, DIRECT_FILE_TRANSFER_LIMITS.LEASE_ID_BYTES)
    || !IDENTIFIER_RE.test(value.leaseId)
    || !isPositiveSafeInteger(value.leaseGeneration)
    || !isTimestamp(value.expiresAt)
    || (value.iat !== undefined && !isPositiveSafeInteger(value.iat))
    || (value.exp !== undefined && !isPositiveSafeInteger(value.exp))) return invalid();
  return { ok: true, value: value as unknown as DirectFileTransferResumeTicketClaims };
}

export function validateDirectFileTransferServerMessage(value: unknown): DirectFileTransferValidationResult<DirectFileTransferServerMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') return invalid();
  if (value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_READY && validateLeaseReady(value, DIRECT_FILE_TRANSFER_MSG.LEASE_READY)) {
    return { ok: true, value: value as unknown as DirectFileTransferLeaseReady };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND && validateLeaseReady(value, DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND)) {
    return { ok: true, value: value as unknown as DirectFileTransferLeaseRebound };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.AUTHORIZED) return validateDirectFileTransferAuthorized(value);
  if (value.type === DIRECT_FILE_TRANSFER_MSG.STATUS) {
    const attachment = value.attachment === undefined ? undefined : validateAttachmentRef(value.attachment, { maxSize: Number.MAX_SAFE_INTEGER });
    if (!isServerStatus(value)) return invalid();
    return { ok: true, value: { ...value, ...(attachment ? { attachment } : {}) } as unknown as DirectFileTransferServerStatus };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.TERMINAL) {
    const attachment = value.attachment === undefined ? undefined : validateAttachmentRef(value.attachment, { maxSize: Number.MAX_SAFE_INTEGER });
    if (!isServerTerminal(value)
      || typeof value.state !== 'string' || !TERMINAL_STATES.has(value.state)
      || (value.error !== undefined && (typeof value.error !== 'string' || !ERRORS.has(value.error)))
      || (value.attachment !== undefined && !attachment)
      || (value.state === DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED && value.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD && !attachment)
      || (value.state === DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED && value.error !== undefined)
      || (value.state !== DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED && value.attachment !== undefined)) return invalid();
    return { ok: true, value: { ...value, ...(attachment ? { attachment } : {}) } as unknown as DirectFileTransferServerTerminal };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.ERROR) {
    const common = value.protocolVersion === DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
      && typeof value.error === 'string' && ERRORS.has(value.error)
      && typeof value.retryable === 'boolean'
      && (value.detail === undefined || isBoundedString(value.detail, DIRECT_FILE_TRANSFER_LIMITS.ERROR_DETAIL_BYTES));
    if (value.scope === DIRECT_FILE_TRANSFER_ERROR_SCOPE.LEASE) {
      if (!hasExactKeys(value, ['type', 'protocolVersion', 'scope', 'requestId', 'error', 'retryable'], ['detail'])
        || !common || !isDirectFileTransferRequestId(value.requestId)) return invalid();
      return { ok: true, value: value as unknown as DirectFileTransferLeaseError };
    }
    if (value.scope === DIRECT_FILE_TRANSFER_ERROR_SCOPE.OPERATION) {
      if (!hasExactKeys(value, ['type', 'protocolVersion', 'scope', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'error', 'retryable'], ['detail', 'idleExpiresAt'])
        || !common || !isAttemptBinding(value)
        || (value.idleExpiresAt !== undefined && !isTimestamp(value.idleExpiresAt))) return invalid();
      return { ok: true, value: value as unknown as DirectFileTransferServerOperationError };
    }
    return invalid();
  }
  const daemon = validateDirectFileTransferDaemonMessage(value);
  if (!daemon.ok || daemon.value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED
    || daemon.value.type === DIRECT_FILE_TRANSFER_MSG.STATUS
    || daemon.value.type === DIRECT_FILE_TRANSFER_MSG.TERMINAL) return invalid();
  return { ok: true, value: daemon.value };
}

function isDataAttemptBinding(value: Record<string, unknown>): boolean {
  return isAttemptBinding(value);
}

export function validateDirectFileTransferDataMessage(value: unknown): DirectFileTransferValidationResult<DirectFileTransferDataMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') return invalid();
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.START) {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'authority'], ['resumeOffset'])
      || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION || !isDataAttemptBinding(value) || !isAuthority(value.authority)) return invalid();
    if (value.resumeOffset !== undefined) {
      // Resuming is an upload-only notion, and a non-integer or negative offset
      // is malformed rather than merely unsatisfiable.
      if (value.direction !== DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD
        || !isDirectFileTransferSize(value.resumeOffset)) return invalid();
    }
    return { ok: true, value: value as unknown as DirectFileTransferDataStart };
  }
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED) {
    const baseKeys = ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId'];
    const upload = value.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD && hasExactKeys(value, baseKeys);
    const download = value.direction === DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD
      && hasExactKeys(value, [...baseKeys, 'filename', 'size'], ['mime'])
      && isBoundedString(value.filename, DIRECT_FILE_TRANSFER_LIMITS.FILENAME_BYTES)
      && isDirectFileTransferSize(value.size)
      && (value.mime === undefined || isBoundedString(value.mime, DIRECT_FILE_TRANSFER_LIMITS.MIME_BYTES));
    if (value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION || !isDataAttemptBinding(value) || (!upload && !download)) return invalid();
    return { ok: true, value: value as unknown as DirectFileTransferDataAccepted };
  }
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT) {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'creditBytes'], ['committedBytes'])
      || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION || !isDataAttemptBinding(value)
      || !isPositiveSafeInteger(value.creditBytes) || value.creditBytes > DIRECT_FILE_TRANSFER_LIMITS.DATA_CREDIT_BYTES) return invalid();
    // DOWNLOAD credit is a pure flow-control window and must not claim a commit
    // point; UPLOAD credit exists only to carry one, so it is required there.
    // Keeping the two shapes disjoint means a peer cannot smuggle a fabricated
    // offset in on the direction that has no receiver-side write behind it.
    if (value.direction === DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD) {
      if (value.committedBytes !== undefined) return invalid();
    } else if (value.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD) {
      if (!isDirectFileTransferSize(value.committedBytes)) return invalid();
    } else {
      return invalid();
    }
    return { ok: true, value: value as unknown as DirectFileTransferDataCredit };
  }
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.FINISH) {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'totalBytes'], ['sha256'])
      || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION || !isDataAttemptBinding(value)
      || !isDirectFileTransferSize(value.totalBytes)
      || (value.sha256 !== undefined && (typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)))) return invalid();
    return { ok: true, value: value as unknown as DirectFileTransferDataFinish };
  }
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.UPLOAD_COMMITTED) {
    const attachment = validateAttachmentRef(value.attachment, { maxSize: Number.MAX_SAFE_INTEGER });
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'attachment'])
      || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION || !isDataAttemptBinding(value)
      || value.direction !== DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD || !attachment) return invalid();
    return { ok: true, value: { ...value, attachment } as unknown as DirectFileTransferDataUploadCommitted };
  }
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.DOWNLOAD_COMMITTED) {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'totalBytes'])
      || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION || !isDataAttemptBinding(value)
      || value.direction !== DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD || !isDirectFileTransferSize(value.totalBytes)) return invalid();
    return { ok: true, value: value as unknown as DirectFileTransferDataDownloadCommitted };
  }
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.HEALTH_PROBE) {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'nonce'])
      || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION || !isLeaseBinding(value)
      || !isBoundedString(value.nonce, DIRECT_FILE_TRANSFER_LIMITS.PROBE_NONCE_BYTES)) return invalid();
    return { ok: true, value: value as unknown as DirectFileTransferDataHealthProbe };
  }
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.HEALTH_PONG) {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'nonce', 'rttMs', 'localCandidate', 'remoteCandidate'])
      || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION || !isLeaseBinding(value)
      || !isBoundedString(value.nonce, DIRECT_FILE_TRANSFER_LIMITS.PROBE_NONCE_BYTES)
      || typeof value.rttMs !== 'number' || !Number.isFinite(value.rttMs) || value.rttMs < 0 || value.rttMs > 3_600_000
      || !isDirectConnectivityCandidateInfo(value.localCandidate) || !isDirectConnectivityCandidateInfo(value.remoteCandidate)) return invalid();
    return { ok: true, value: value as unknown as DirectFileTransferDataHealthPong };
  }
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.ERROR) {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'serverId', 'browserTabId', 'leaseId', 'leaseGeneration', 'daemonGeneration', 'requestId', 'attemptId', 'attempt', 'direction', 'operationId', 'error'])
      || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION || !isDataAttemptBinding(value)
      || typeof value.error !== 'string' || !ERRORS.has(value.error)) return invalid();
    return { ok: true, value: value as unknown as DirectFileTransferDataError };
  }
  return invalid();
}

/** True only for v2 message names understood by this protocol. */
export function isDirectFileTransferMessageType(value: unknown): value is string {
  return typeof value === 'string' && (Object.values(DIRECT_FILE_TRANSFER_MSG) as string[]).includes(value);
}

/** Allows dispatchers to reject rather than accidentally forward any v1 frame. */
export function isLegacyDirectFileTransferMessageType(value: unknown): boolean {
  return typeof value === 'string'
    && value.startsWith('direct_file.')
    && !value.startsWith('direct_file.v2.');
}

export function isDirectFileTransferDaemonMessageType(value: unknown): boolean {
  return value === DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED
    || value === DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND
    || value === DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER
    || value === DIRECT_FILE_TRANSFER_MSG.LEASE_ICE
    || value === DIRECT_FILE_TRANSFER_MSG.STATUS
    || value === DIRECT_FILE_TRANSFER_MSG.TERMINAL
    || value === DIRECT_FILE_TRANSFER_MSG.ERROR;
}

/** Extracts the stable id after a direction-specific validator has succeeded. */
export function getDirectFileTransferOperationId(value: Pick<DirectFileTransferOperationInit, 'operationId'>): string {
  return value.operationId;
}
