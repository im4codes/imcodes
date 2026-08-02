import { isIP } from 'node:net';
import type { AttachmentRef, FileTransferValidationResult } from './transport/file-transfer.js';

export const MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY = 'file.transfer.machine_direct.v1' as const;

export const MACHINE_FILE_TRANSFER_TRANSPORT = {
  DIRECT: 'direct',
  RELAY: 'relay',
} as const;

export type MachineFileTransferTransport = typeof MACHINE_FILE_TRANSFER_TRANSPORT[keyof typeof MACHINE_FILE_TRANSFER_TRANSPORT];

export const MACHINE_DIRECT_FILE_TRANSFER_MSG = {
  REQUEST: 'file.machine_direct.request',
  DONE: 'file.machine_direct.done',
  ERROR: 'file.machine_direct.error',
} as const;

export const MACHINE_DIRECT_HANDSHAKE_MSG = {
  TARGET_HELLO: 'target_hello',
  SOURCE_HELLO: 'source_hello',
} as const;

export const MACHINE_DIRECT_FRAME_TYPE = {
  DATA: 1,
  FINISH: 2,
} as const;

export const MACHINE_DIRECT_FILE_TRANSFER_ERROR = {
  CONNECT_FAILED: 'connect_failed',
  AUTH_FAILED: 'auth_failed',
  TIMEOUT: 'timeout',
  TRANSFER_FAILED: 'transfer_failed',
  SIZE_MISMATCH: 'size_mismatch',
  EXPIRED: 'expired',
} as const;

export const MACHINE_DIRECT_FILE_TRANSFER_LIMITS = {
  MAX_CANDIDATES: 16,
  MAX_CONTROL_BYTES: 32 * 1024,
  MAX_FRAME_PLAINTEXT_BYTES: 64 * 1024 + 1,
  MAX_BUFFERED_SOCKET_BYTES: 256 * 1024,
  FRAME_LENGTH_HEADER_BYTES: 4,
  FRAME_AUTH_TAG_BYTES: 16,
  FINISH_FRAME_PLAINTEXT_BYTES: 9,
  HANDSHAKE_LINE_MAX_BYTES: 2 * 1024,
  NONCE_BYTES: 18,
  CONNECT_TIMEOUT_MS: 4_000,
  HANDSHAKE_TIMEOUT_MS: 4_000,
  TRANSFER_TIMEOUT_MS: 300_000,
  AUTHORITY_TTL_MS: 15_000,
  MAX_ACCEPT_ATTEMPTS: 4,
  MAX_CONCURRENT_RECEIVERS: 2,
} as const;

export interface MachineDirectCandidate {
  host: string;
  port: number;
}

export interface MachineDirectUploadRequest {
  type: typeof MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST;
  requestId: string;
  clientUploadId: string;
  capability: string;
  candidates: MachineDirectCandidate[];
  originalName: string;
  mime?: string;
  size: number;
  expiresAt: number;
}

export interface MachineDirectUploadDone {
  type: typeof MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE;
  requestId: string;
  attachment: AttachmentRef;
}

export interface MachineDirectUploadError {
  type: typeof MACHINE_DIRECT_FILE_TRANSFER_MSG.ERROR;
  requestId: string;
  error: typeof MACHINE_DIRECT_FILE_TRANSFER_ERROR[keyof typeof MACHINE_DIRECT_FILE_TRANSFER_ERROR];
}

export type MachineDirectUploadResponse = MachineDirectUploadDone | MachineDirectUploadError;

export interface MachineDirectTargetHello {
  type: typeof MACHINE_DIRECT_HANDSHAKE_MSG.TARGET_HELLO;
  requestId: string;
  nonce: string;
  proof: string;
}

export interface MachineDirectSourceHello {
  type: typeof MACHINE_DIRECT_HANDSHAKE_MSG.SOURCE_HELLO;
  requestId: string;
  nonce: string;
  proof: string;
}

const ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const CAPABILITY_RE = /^[A-Za-z0-9_-]{43}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{24}$/;
const ERROR_SET = new Set<MachineDirectUploadError['error']>([
  ...Object.values(MACHINE_DIRECT_FILE_TRANSFER_ERROR),
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function isPrivateMachineDirectAddress(host: string): boolean {
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10
      || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b! >= 64 && b! <= 127);
  }
  if (isIP(host) === 6) {
    const normalized = host.toLowerCase();
    return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8')
      || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  return false;
}

export function validateMachineDirectCandidate(value: unknown): MachineDirectCandidate | null {
  if (!isObject(value) || !hasExactKeys(value, ['host', 'port'])) return null;
  if (typeof value.host !== 'string' || value.host.length > 64 || !isPrivateMachineDirectAddress(value.host)) return null;
  if (typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return null;
  return { host: value.host, port: value.port };
}

function isMachineDirectId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function isMachineDirectNonce(value: unknown): value is string {
  return typeof value === 'string'
    && NONCE_RE.test(value)
    && Buffer.from(value, 'base64url').length === MACHINE_DIRECT_FILE_TRANSFER_LIMITS.NONCE_BYTES;
}

function isMachineDirectProof(value: unknown): value is string {
  return typeof value === 'string' && CAPABILITY_RE.test(value);
}

export function validateMachineDirectTargetHello(value: unknown): MachineDirectTargetHello | null {
  if (!isObject(value) || !hasExactKeys(value, ['type', 'requestId', 'nonce', 'proof'])) return null;
  if (value.type !== MACHINE_DIRECT_HANDSHAKE_MSG.TARGET_HELLO
    || !isMachineDirectId(value.requestId)
    || !isMachineDirectNonce(value.nonce)
    || !isMachineDirectProof(value.proof)) return null;
  return value as unknown as MachineDirectTargetHello;
}

export function validateMachineDirectSourceHello(value: unknown): MachineDirectSourceHello | null {
  if (!isObject(value) || !hasExactKeys(value, ['type', 'requestId', 'nonce', 'proof'])) return null;
  if (value.type !== MACHINE_DIRECT_HANDSHAKE_MSG.SOURCE_HELLO
    || !isMachineDirectId(value.requestId)
    || !isMachineDirectNonce(value.nonce)
    || !isMachineDirectProof(value.proof)) return null;
  return value as unknown as MachineDirectSourceHello;
}

export function isValidMachineDirectEncryptedFrameLength(length: number): boolean {
  return Number.isInteger(length)
    && length >= MACHINE_DIRECT_FILE_TRANSFER_LIMITS.FRAME_AUTH_TAG_BYTES + 1
    && length <= MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_FRAME_PLAINTEXT_BYTES
      + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.FRAME_AUTH_TAG_BYTES;
}

export function validateMachineDirectUploadRequest(value: unknown): FileTransferValidationResult<MachineDirectUploadRequest> {
  if (!isObject(value) || !hasExactKeys(
    value,
    ['type', 'requestId', 'clientUploadId', 'capability', 'candidates', 'originalName', 'size', 'expiresAt'],
    ['mime'],
  )) return { ok: false, error: 'invalid_object' };
  if (value.type !== MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST) return { ok: false, error: 'invalid_type' };
  if (!isMachineDirectId(value.requestId)) return { ok: false, error: 'invalid_request_id' };
  if (!isMachineDirectId(value.clientUploadId)) return { ok: false, error: 'invalid_client_upload_id' };
  if (typeof value.capability !== 'string' || !CAPABILITY_RE.test(value.capability)) return { ok: false, error: 'invalid_capability' };
  if (!Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_CANDIDATES) {
    return { ok: false, error: 'invalid_candidates' };
  }
  const candidates = value.candidates.map(validateMachineDirectCandidate);
  if (candidates.some((candidate) => !candidate)) return { ok: false, error: 'invalid_candidate' };
  if (typeof value.originalName !== 'string' || value.originalName.length < 1 || utf8Bytes(value.originalName) > 1024) return { ok: false, error: 'invalid_name' };
  if (value.mime !== undefined && (typeof value.mime !== 'string' || utf8Bytes(value.mime) > 256)) return { ok: false, error: 'invalid_mime' };
  if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) return { ok: false, error: 'invalid_size' };
  if (typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) return { ok: false, error: 'invalid_expiry' };
  return { ok: true, value: { ...value, candidates: candidates as MachineDirectCandidate[] } as MachineDirectUploadRequest };
}

export function validateMachineDirectUploadResponse(
  value: unknown,
  validateAttachment: (value: unknown, options?: { maxSize?: number }) => AttachmentRef | null,
): FileTransferValidationResult<MachineDirectUploadResponse> {
  if (!isObject(value) || typeof value.type !== 'string') return { ok: false, error: 'invalid_object' };
  if (value.type === MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE) {
    if (!hasExactKeys(value, ['type', 'requestId', 'attachment'])
      || !isMachineDirectId(value.requestId)) return { ok: false, error: 'invalid_done' };
    const attachment = validateAttachment(value.attachment, { maxSize: Number.MAX_SAFE_INTEGER });
    return attachment
      ? { ok: true, value: { type: MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE, requestId: value.requestId, attachment } }
      : { ok: false, error: 'invalid_attachment' };
  }
  if (value.type === MACHINE_DIRECT_FILE_TRANSFER_MSG.ERROR) {
    if (!hasExactKeys(value, ['type', 'requestId', 'error'])
      || !isMachineDirectId(value.requestId)
      || typeof value.error !== 'string' || !ERROR_SET.has(value.error as MachineDirectUploadError['error'])) {
      return { ok: false, error: 'invalid_error' };
    }
    return { ok: true, value: value as unknown as MachineDirectUploadError };
  }
  return { ok: false, error: 'invalid_type' };
}
