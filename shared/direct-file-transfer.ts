import type { AttachmentRef } from './transport/file-transfer.js';
import { validateAttachmentRef } from './transport/file-transfer.js';

export const DIRECT_FILE_TRANSFER_CAPABILITY = 'file.transfer.direct.v1' as const;
export const DIRECT_FILE_TRANSFER_PROTOCOL_VERSION = 1;

export const DIRECT_FILE_TRANSFER_PURPOSE = {
  UPLOAD: 'upload',
  PROBE: 'probe',
} as const;

export type DirectFileTransferPurpose = typeof DIRECT_FILE_TRANSFER_PURPOSE[keyof typeof DIRECT_FILE_TRANSFER_PURPOSE];

export const DIRECT_CONNECTIVITY_ROUTE = {
  LAN_DIRECT: 'lan_direct',
  DIRECT: 'direct',
  RELAY: 'relay',
} as const;

export type DirectConnectivityRoute = typeof DIRECT_CONNECTIVITY_ROUTE[keyof typeof DIRECT_CONNECTIVITY_ROUTE];

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

export const DIRECT_FILE_TRANSFER_MSG = {
  INIT: 'direct_file.init',
  AUTHORIZED: 'direct_file.authorized',
  PREPARE: 'direct_file.prepare',
  OFFER: 'direct_file.offer',
  ANSWER: 'direct_file.answer',
  ICE: 'direct_file.ice',
  CANCEL: 'direct_file.cancel',
  STATUS_QUERY: 'direct_file.status_query',
  STATUS: 'direct_file.status',
  PROGRESS: 'direct_file.progress',
  DONE: 'direct_file.done',
  ERROR: 'direct_file.error',
} as const;

export const DIRECT_FILE_TRANSFER_DATA_MSG = {
  START: 'direct_file.data.start',
  ACCEPTED: 'direct_file.data.accepted',
  FINISH: 'direct_file.data.finish',
  PROBE: 'direct_file.data.probe',
  PONG: 'direct_file.data.pong',
  ERROR: 'direct_file.data.error',
} as const;

export const DIRECT_FILE_TRANSFER_STATE = {
  CONNECTING: 'connecting',
  DIRECT: 'direct',
  FALLING_BACK: 'falling_back',
  RELAY: 'relay',
  PARTIAL: 'partial',
  COMMITTED: 'committed',
  CANCELED: 'canceled',
  FAILED: 'failed',
  NOT_FOUND: 'not_found',
} as const;

export type DirectFileTransferState = typeof DIRECT_FILE_TRANSFER_STATE[keyof typeof DIRECT_FILE_TRANSFER_STATE];

export const DIRECT_FILE_TRANSFER_ERROR = {
  CAPABILITY_UNAVAILABLE: 'capability_unavailable',
  DAEMON_OFFLINE: 'daemon_offline',
  INVALID_REQUEST: 'invalid_request',
  INVALID_AUTHORITY: 'invalid_authority',
  AUTHORITY_EXPIRED: 'authority_expired',
  NEGOTIATION_TIMEOUT: 'negotiation_timeout',
  CONNECTION_FAILED: 'connection_failed',
  CHANNEL_CLOSED: 'channel_closed',
  TOO_MANY_TRANSFERS: 'too_many_transfers',
  INSUFFICIENT_CAPACITY: 'insufficient_capacity',
  SIZE_MISMATCH: 'size_mismatch',
  CHECKSUM_MISMATCH: 'checksum_mismatch',
  WRITE_FAILED: 'write_failed',
  RELAY_SIZE_LIMIT: 'relay_size_limit',
  CANCELED: 'canceled',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type DirectFileTransferError = typeof DIRECT_FILE_TRANSFER_ERROR[keyof typeof DIRECT_FILE_TRANSFER_ERROR];

export const DIRECT_FILE_TRANSFER_LIMITS = {
  REQUEST_ID_BYTES: 128,
  CLIENT_UPLOAD_ID_BYTES: 128,
  CAPABILITY_BYTES: 128,
  FILENAME_BYTES: 1024,
  MIME_BYTES: 256,
  SDP_BYTES: 256 * 1024,
  ICE_CANDIDATE_BYTES: 16 * 1024,
  ICE_MID_BYTES: 256,
  ERROR_DETAIL_BYTES: 512,
  DATA_CHUNK_BYTES: 64 * 1024,
  DATA_BUFFER_HIGH_WATER_BYTES: 8 * 1024 * 1024,
  DATA_BUFFER_LOW_WATER_BYTES: 2 * 1024 * 1024,
  AUTHORITY_TTL_MS: 2 * 60 * 1000,
  NEGOTIATION_TIMEOUT_MS: 8 * 1000,
  IDLE_TIMEOUT_MS: 45 * 1000,
  STATUS_TIMEOUT_MS: 5 * 1000,
  MAX_PER_BROWSER: 4,
  MAX_PER_DAEMON: 16,
  RECENT_RESULT_CAPACITY: 256,
  RECENT_RESULT_TTL_MS: 30 * 60 * 1000,
  DISK_RESERVE_BYTES: 64 * 1024 * 1024,
  PROBE_NONCE_BYTES: 128,
  PROBE_CANDIDATE_ADDRESS_BYTES: 512,
  PROBE_CANDIDATE_TYPE_BYTES: 64,
  PROBE_TIMEOUT_MS: 8 * 1000,
} as const;

export const DIRECT_FILE_TRANSFER_ICE_SERVERS = [
  'stun:stun.cloudflare.com:3478',
] as const;

export interface DirectFileTransferInit {
  type: typeof DIRECT_FILE_TRANSFER_MSG.INIT;
  purpose?: DirectFileTransferPurpose;
  requestId: string;
  clientUploadId: string;
  filename: string;
  mime?: string;
  size: number;
  sha256?: string;
}

export interface DirectFileTransferAuthority extends Omit<DirectFileTransferInit, 'type'> {
  capability: string;
  expiresAt: number;
  iceServers: string[];
}

export interface DirectFileTransferAuthorized extends DirectFileTransferAuthority {
  type: typeof DIRECT_FILE_TRANSFER_MSG.AUTHORIZED;
}

export interface DirectFileTransferPrepare extends DirectFileTransferAuthority {
  type: typeof DIRECT_FILE_TRANSFER_MSG.PREPARE;
}

export interface DirectFileTransferOffer {
  type: typeof DIRECT_FILE_TRANSFER_MSG.OFFER;
  requestId: string;
  capability: string;
  sdp: string;
}

export interface DirectFileTransferAnswer {
  type: typeof DIRECT_FILE_TRANSFER_MSG.ANSWER;
  requestId: string;
  capability: string;
  sdp: string;
}

export interface DirectFileTransferIce {
  type: typeof DIRECT_FILE_TRANSFER_MSG.ICE;
  requestId: string;
  capability: string;
  candidate: string;
  mid: string;
}

export interface DirectFileTransferCancel {
  type: typeof DIRECT_FILE_TRANSFER_MSG.CANCEL;
  requestId: string;
  capability: string;
  reason: DirectFileTransferError;
}

export interface DirectFileTransferStatusQuery {
  type: typeof DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY;
  requestId: string;
  capability: string;
  clientUploadId: string;
}

export interface DirectFileTransferStatus {
  type: typeof DIRECT_FILE_TRANSFER_MSG.STATUS;
  requestId: string;
  capability: string;
  clientUploadId: string;
  state: DirectFileTransferState;
  attachment?: AttachmentRef;
}

export interface DirectFileTransferProgress {
  type: typeof DIRECT_FILE_TRANSFER_MSG.PROGRESS;
  requestId: string;
  capability: string;
  loaded: number;
  total: number;
}

export interface DirectFileTransferDone {
  type: typeof DIRECT_FILE_TRANSFER_MSG.DONE;
  requestId: string;
  capability: string;
  clientUploadId: string;
  attachment: AttachmentRef;
}

export interface DirectFileTransferErrorMessage {
  type: typeof DIRECT_FILE_TRANSFER_MSG.ERROR;
  requestId: string;
  capability?: string;
  error: DirectFileTransferError;
  retryable: boolean;
  detail?: string;
}

export interface DirectFileTransferDataStart extends Omit<DirectFileTransferAuthority, 'expiresAt' | 'iceServers'> {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.START;
  protocolVersion: number;
}

export interface DirectFileTransferDataAccepted {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED;
  requestId: string;
}

export interface DirectFileTransferDataFinish {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.FINISH;
  requestId: string;
  totalBytes: number;
  sha256?: string;
}

export interface DirectConnectivityCandidateInfo {
  address: string;
  port: number;
  type: string;
  transportType: string;
}

export interface DirectFileTransferDataProbe {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.PROBE;
  protocolVersion: number;
  requestId: string;
  capability: string;
  nonce: string;
}

export interface DirectFileTransferDataPong {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.PONG;
  requestId: string;
  nonce: string;
  rttMs: number;
  localCandidate: DirectConnectivityCandidateInfo;
  remoteCandidate: DirectConnectivityCandidateInfo;
}

export interface DirectConnectivityProbeResult {
  route: DirectConnectivityRoute;
  rttMs: number;
  localCandidate: DirectConnectivityCandidateInfo;
  remoteCandidate: DirectConnectivityCandidateInfo;
}

export interface DirectFileTransferDataError {
  type: typeof DIRECT_FILE_TRANSFER_DATA_MSG.ERROR;
  requestId: string;
  error: DirectFileTransferError;
}

export type DirectFileTransferBrowserMessage =
  | DirectFileTransferInit
  | DirectFileTransferOffer
  | DirectFileTransferIce
  | DirectFileTransferCancel
  | DirectFileTransferStatusQuery;

export type DirectFileTransferDaemonCommand =
  | DirectFileTransferPrepare
  | DirectFileTransferOffer
  | DirectFileTransferIce
  | DirectFileTransferCancel
  | DirectFileTransferStatusQuery;

export type DirectFileTransferDaemonMessage =
  | DirectFileTransferAnswer
  | DirectFileTransferIce
  | DirectFileTransferProgress
  | DirectFileTransferDone
  | DirectFileTransferErrorMessage
  | DirectFileTransferStatus;

export type DirectFileTransferServerMessage =
  | DirectFileTransferAuthorized
  | DirectFileTransferAnswer
  | DirectFileTransferIce
  | DirectFileTransferProgress
  | DirectFileTransferDone
  | DirectFileTransferErrorMessage
  | DirectFileTransferStatus;

export type DirectFileTransferDataMessage =
  | DirectFileTransferDataStart
  | DirectFileTransferDataAccepted
  | DirectFileTransferDataFinish
  | DirectFileTransferDataProbe
  | DirectFileTransferDataPong
  | DirectFileTransferDataError;

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const CAPABILITY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DIRECT_STATES = new Set<string>(Object.values(DIRECT_FILE_TRANSFER_STATE));
const DIRECT_ERRORS = new Set<string>(Object.values(DIRECT_FILE_TRANSFER_ERROR));
const DIRECT_PURPOSES = new Set<string>(Object.values(DIRECT_FILE_TRANSFER_PURPOSE));
const DIRECT_RUNTIME_STATES = new Set<string>(Object.values(DIRECT_CONNECTIVITY_RUNTIME_STATE));
const DIRECT_RUNTIME_ERRORS = new Set<string>(Object.values(DIRECT_CONNECTIVITY_RUNTIME_ERROR));

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isDirectConnectivityRuntimeStatus(value: unknown): value is DirectConnectivityRuntimeStatus {
  if (!isRecord(value) || !hasExactKeys(value, ['state'], ['error'])) return false;
  return typeof value.state === 'string'
    && DIRECT_RUNTIME_STATES.has(value.state)
    && (value.error === undefined || (typeof value.error === 'string' && DIRECT_RUNTIME_ERRORS.has(value.error)));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBoundedString(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && utf8Bytes(value) <= maxBytes;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

export function isDirectFileTransferRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_RE.test(value);
}

export function isDirectFileTransferClientUploadId(value: unknown): value is string {
  return isDirectFileTransferRequestId(value);
}

export function isDirectFileTransferCapability(value: unknown): value is string {
  return typeof value === 'string' && CAPABILITY_RE.test(value);
}

export function isDirectFileTransferSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateMetadata(value: Record<string, unknown>): boolean {
  return isDirectFileTransferRequestId(value.requestId)
    && (value.purpose === undefined || (typeof value.purpose === 'string' && DIRECT_PURPOSES.has(value.purpose)))
    && isDirectFileTransferClientUploadId(value.clientUploadId)
    && isBoundedString(value.filename, DIRECT_FILE_TRANSFER_LIMITS.FILENAME_BYTES)
    && (value.mime === undefined || isBoundedString(value.mime, DIRECT_FILE_TRANSFER_LIMITS.MIME_BYTES))
    && isDirectFileTransferSize(value.size)
    && (value.sha256 === undefined || (typeof value.sha256 === 'string' && SHA256_RE.test(value.sha256)));
}

function isDirectConnectivityCandidateInfo(value: unknown): value is DirectConnectivityCandidateInfo {
  if (!isRecord(value) || !hasExactKeys(value, ['address', 'port', 'type', 'transportType'])) return false;
  return isBoundedString(value.address, DIRECT_FILE_TRANSFER_LIMITS.PROBE_CANDIDATE_ADDRESS_BYTES)
    && typeof value.port === 'number'
    && Number.isInteger(value.port)
    && value.port >= 0
    && value.port <= 65_535
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

export function classifyDirectConnectivityRoute(
  localCandidate: DirectConnectivityCandidateInfo,
  remoteCandidate: DirectConnectivityCandidateInfo,
): DirectConnectivityRoute {
  if (localCandidate.type === DIRECT_CONNECTIVITY_ROUTE.RELAY || remoteCandidate.type === DIRECT_CONNECTIVITY_ROUTE.RELAY) {
    return DIRECT_CONNECTIVITY_ROUTE.RELAY;
  }
  return isPrivateNetworkAddress(localCandidate.address) && isPrivateNetworkAddress(remoteCandidate.address)
    ? DIRECT_CONNECTIVITY_ROUTE.LAN_DIRECT
    : DIRECT_CONNECTIVITY_ROUTE.DIRECT;
}

function validateAuthorityFields(value: Record<string, unknown>): boolean {
  return validateMetadata(value)
    && isDirectFileTransferCapability(value.capability)
    && typeof value.expiresAt === 'number'
    && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt > 0
    && Array.isArray(value.iceServers)
    && value.iceServers.length <= 8
    && value.iceServers.every((entry) => isBoundedString(entry, 2048));
}

export function validateDirectFileTransferBrowserMessage(value: unknown): ValidationResult<DirectFileTransferBrowserMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
  if (value.type === DIRECT_FILE_TRANSFER_MSG.INIT) {
    if (!hasExactKeys(value, ['type', 'requestId', 'clientUploadId', 'filename', 'size'], ['purpose', 'mime', 'sha256']) || !validateMetadata(value)) {
      return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    }
    return { ok: true, value: value as unknown as DirectFileTransferInit };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.OFFER) {
    if (!hasExactKeys(value, ['type', 'requestId', 'capability', 'sdp'])
      || !isDirectFileTransferRequestId(value.requestId)
      || !isDirectFileTransferCapability(value.capability)
      || !isBoundedString(value.sdp, DIRECT_FILE_TRANSFER_LIMITS.SDP_BYTES)) {
      return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    }
    return { ok: true, value: value as unknown as DirectFileTransferOffer };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.ICE) {
    if (!hasExactKeys(value, ['type', 'requestId', 'capability', 'candidate', 'mid'])
      || !isDirectFileTransferRequestId(value.requestId)
      || !isDirectFileTransferCapability(value.capability)
      || !isBoundedString(value.candidate, DIRECT_FILE_TRANSFER_LIMITS.ICE_CANDIDATE_BYTES)
      || !isBoundedString(value.mid, DIRECT_FILE_TRANSFER_LIMITS.ICE_MID_BYTES, true)) {
      return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    }
    return { ok: true, value: value as unknown as DirectFileTransferIce };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.CANCEL) {
    if (!hasExactKeys(value, ['type', 'requestId', 'capability', 'reason'])
      || !isDirectFileTransferRequestId(value.requestId)
      || !isDirectFileTransferCapability(value.capability)
      || typeof value.reason !== 'string' || !DIRECT_ERRORS.has(value.reason)) {
      return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    }
    return { ok: true, value: value as unknown as DirectFileTransferCancel };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY) {
    if (!hasExactKeys(value, ['type', 'requestId', 'capability', 'clientUploadId'])
      || !isDirectFileTransferRequestId(value.requestId)
      || !isDirectFileTransferCapability(value.capability)
      || !isDirectFileTransferClientUploadId(value.clientUploadId)) {
      return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    }
    return { ok: true, value: value as unknown as DirectFileTransferStatusQuery };
  }
  return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
}

export function validateDirectFileTransferDaemonCommand(value: unknown): ValidationResult<DirectFileTransferDaemonCommand> {
  if (!isRecord(value) || typeof value.type !== 'string') return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
  if (value.type === DIRECT_FILE_TRANSFER_MSG.PREPARE) {
    if (!hasExactKeys(
      value,
      ['type', 'requestId', 'clientUploadId', 'filename', 'size', 'capability', 'expiresAt', 'iceServers'],
      ['purpose', 'mime', 'sha256'],
    ) || !validateAuthorityFields(value)) return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    return { ok: true, value: value as unknown as DirectFileTransferPrepare };
  }
  const browser = validateDirectFileTransferBrowserMessage(value);
  if (!browser.ok || browser.value.type === DIRECT_FILE_TRANSFER_MSG.INIT) {
    return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
  }
  return { ok: true, value: browser.value };
}

export function validateDirectFileTransferDaemonMessage(value: unknown): ValidationResult<DirectFileTransferDaemonMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
  if (value.type === DIRECT_FILE_TRANSFER_MSG.ANSWER) {
    if (!hasExactKeys(value, ['type', 'requestId', 'capability', 'sdp'])
      || !isDirectFileTransferRequestId(value.requestId)
      || !isDirectFileTransferCapability(value.capability)
      || !isBoundedString(value.sdp, DIRECT_FILE_TRANSFER_LIMITS.SDP_BYTES)) {
      return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    }
    return { ok: true, value: value as unknown as DirectFileTransferAnswer };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.ICE) {
    const parsed = validateDirectFileTransferBrowserMessage(value);
    return parsed.ok && parsed.value.type === DIRECT_FILE_TRANSFER_MSG.ICE
      ? { ok: true, value: parsed.value }
      : { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.PROGRESS) {
    if (!hasExactKeys(value, ['type', 'requestId', 'capability', 'loaded', 'total'])
      || !isDirectFileTransferRequestId(value.requestId)
      || !isDirectFileTransferCapability(value.capability)
      || !isDirectFileTransferSize(value.loaded) || !isDirectFileTransferSize(value.total)
      || value.loaded > value.total) return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    return { ok: true, value: value as unknown as DirectFileTransferProgress };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.DONE) {
    const attachment = validateAttachmentRef(value.attachment, { maxSize: Number.MAX_SAFE_INTEGER });
    if (!hasExactKeys(value, ['type', 'requestId', 'capability', 'clientUploadId', 'attachment'])
      || !isDirectFileTransferRequestId(value.requestId)
      || !isDirectFileTransferCapability(value.capability)
      || !isDirectFileTransferClientUploadId(value.clientUploadId)
      || !attachment) return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    return { ok: true, value: { ...value, attachment } as unknown as DirectFileTransferDone };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.ERROR) {
    if (!hasExactKeys(value, ['type', 'requestId', 'error', 'retryable'], ['capability', 'detail'])
      || !isDirectFileTransferRequestId(value.requestId)
      || (value.capability !== undefined && !isDirectFileTransferCapability(value.capability))
      || typeof value.error !== 'string' || !DIRECT_ERRORS.has(value.error)
      || typeof value.retryable !== 'boolean'
      || (value.detail !== undefined && !isBoundedString(value.detail, DIRECT_FILE_TRANSFER_LIMITS.ERROR_DETAIL_BYTES))) {
      return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    }
    return { ok: true, value: value as unknown as DirectFileTransferErrorMessage };
  }
  if (value.type === DIRECT_FILE_TRANSFER_MSG.STATUS) {
    const attachment = value.attachment === undefined
      ? undefined
      : validateAttachmentRef(value.attachment, { maxSize: Number.MAX_SAFE_INTEGER });
    if (!hasExactKeys(value, ['type', 'requestId', 'capability', 'clientUploadId', 'state'], ['attachment'])
      || !isDirectFileTransferRequestId(value.requestId)
      || !isDirectFileTransferCapability(value.capability)
      || !isDirectFileTransferClientUploadId(value.clientUploadId)
      || typeof value.state !== 'string' || !DIRECT_STATES.has(value.state)
      || (value.attachment !== undefined && !attachment)) return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    return { ok: true, value: { ...value, ...(attachment ? { attachment } : {}) } as unknown as DirectFileTransferStatus };
  }
  return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
}

export function validateDirectFileTransferAuthorized(value: unknown): ValidationResult<DirectFileTransferAuthorized> {
  if (!isRecord(value)
    || value.type !== DIRECT_FILE_TRANSFER_MSG.AUTHORIZED
    || !hasExactKeys(
      value,
      ['type', 'requestId', 'clientUploadId', 'filename', 'size', 'capability', 'expiresAt', 'iceServers'],
      ['purpose', 'mime', 'sha256'],
    )
    || !validateAuthorityFields(value)) return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
  return { ok: true, value: value as unknown as DirectFileTransferAuthorized };
}

export function validateDirectFileTransferDataMessage(value: unknown): ValidationResult<DirectFileTransferDataMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.START) {
    if (!hasExactKeys(
      value,
      ['type', 'protocolVersion', 'requestId', 'clientUploadId', 'filename', 'size', 'capability'],
      ['purpose', 'mime', 'sha256'],
    )
      || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
      || !validateMetadata(value)
      || !isDirectFileTransferCapability(value.capability)) return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    return { ok: true, value: value as unknown as DirectFileTransferDataStart };
  }
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED) {
    if (!hasExactKeys(value, ['type', 'requestId']) || !isDirectFileTransferRequestId(value.requestId)) {
      return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    }
    return { ok: true, value: value as unknown as DirectFileTransferDataAccepted };
  }
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.FINISH) {
    if (!hasExactKeys(value, ['type', 'requestId', 'totalBytes'], ['sha256'])
      || !isDirectFileTransferRequestId(value.requestId)
      || !isDirectFileTransferSize(value.totalBytes)
      || (value.sha256 !== undefined && (typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)))) {
      return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    }
    return { ok: true, value: value as unknown as DirectFileTransferDataFinish };
  }
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.PROBE) {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'requestId', 'capability', 'nonce'])
      || value.protocolVersion !== DIRECT_FILE_TRANSFER_PROTOCOL_VERSION
      || !isDirectFileTransferRequestId(value.requestId)
      || !isDirectFileTransferCapability(value.capability)
      || !isBoundedString(value.nonce, DIRECT_FILE_TRANSFER_LIMITS.PROBE_NONCE_BYTES)) {
      return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    }
    return { ok: true, value: value as unknown as DirectFileTransferDataProbe };
  }
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.PONG) {
    if (!hasExactKeys(value, ['type', 'requestId', 'nonce', 'rttMs', 'localCandidate', 'remoteCandidate'])
      || !isDirectFileTransferRequestId(value.requestId)
      || !isBoundedString(value.nonce, DIRECT_FILE_TRANSFER_LIMITS.PROBE_NONCE_BYTES)
      || typeof value.rttMs !== 'number'
      || !Number.isFinite(value.rttMs)
      || value.rttMs < 0
      || value.rttMs > 3_600_000
      || !isDirectConnectivityCandidateInfo(value.localCandidate)
      || !isDirectConnectivityCandidateInfo(value.remoteCandidate)) {
      return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    }
    return { ok: true, value: value as unknown as DirectFileTransferDataPong };
  }
  if (value.type === DIRECT_FILE_TRANSFER_DATA_MSG.ERROR) {
    if (!hasExactKeys(value, ['type', 'requestId', 'error'])
      || !isDirectFileTransferRequestId(value.requestId)
      || typeof value.error !== 'string' || !DIRECT_ERRORS.has(value.error)) {
      return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
    }
    return { ok: true, value: value as unknown as DirectFileTransferDataError };
  }
  return { ok: false, error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST };
}

export function isDirectFileTransferMessageType(value: unknown): value is string {
  return typeof value === 'string' && (Object.values(DIRECT_FILE_TRANSFER_MSG) as string[]).includes(value);
}

export function isDirectFileTransferDaemonMessageType(value: unknown): boolean {
  return value === DIRECT_FILE_TRANSFER_MSG.ANSWER
    || value === DIRECT_FILE_TRANSFER_MSG.ICE
    || value === DIRECT_FILE_TRANSFER_MSG.PROGRESS
    || value === DIRECT_FILE_TRANSFER_MSG.DONE
    || value === DIRECT_FILE_TRANSFER_MSG.ERROR
    || value === DIRECT_FILE_TRANSFER_MSG.STATUS;
}
