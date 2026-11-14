import {
  CONTROLLED_NODE_ABI_MODERN,
  normalizeControlledNodeAbiProfile,
  type ControlledNodeAbiProfile,
} from './controlled-node-abi.js';
import {
  ENROLLMENT_BLOB_MAX_BODY_BYTES,
  sanitizeEnrollmentOwnerName,
  utf8ByteLength,
  type EnrollmentBlob,
  type EnvelopeValidation,
} from './remote-exec.js';

export const CONTROLLED_NODE_INSTALL_SUBCOMMAND = 'install' as const;
export const CONTROLLED_NODE_ENROLL_STDIN_FLAG = '--enroll-stdin' as const;

export const CONTROLLED_NODE_INSTALL_PAYLOAD_SUBPATH = '/v2/install-payload' as const;
export const CONTROLLED_NODE_INSTALL_PAYLOAD_PATH = `/api/enroll${CONTROLLED_NODE_INSTALL_PAYLOAD_SUBPATH}` as const;

export const CONTROLLED_NODE_INSTALL_EXECUTABLE_SUBPATH = '/v2/install-executable' as const;
export const CONTROLLED_NODE_INSTALL_EXECUTABLE_PATH = `/api/enroll${CONTROLLED_NODE_INSTALL_EXECUTABLE_SUBPATH}` as const;

export const CONTROLLED_NODE_INSTALL_EXECUTABLE_TOKEN_PARAM = 'token' as const;
export const CONTROLLED_NODE_INSTALL_TICKET_FIELD = 'ticket' as const;

export const CONTROLLED_NODE_ENROLL_STDIN_MAX_BYTES = ENROLLMENT_BLOB_MAX_BODY_BYTES;
export const CONTROLLED_NODE_ENROLL_TOKEN_MAX_BYTES = 4096;
export const CONTROLLED_NODE_SERVER_URL_MAX_CHARS = 512;

export const CONTROLLED_NODE_INSTALL_EXECUTABLE_TOKEN_TTL_MS = 5 * 60 * 1000;
export const CONTROLLED_NODE_INSTALL_EXECUTABLE_TOKEN_DOMAIN = 'imcodes-install-executable-v1:' as const;

export interface ControlledNodeInstallPayloadResponse {
  artifactUrl: string;
  sha256: string;
  sizeBytes: number;
  abiProfile: ControlledNodeAbiProfile;
  windowsAuthenticodeSignerSha256?: string;
  enrollment: EnrollmentBlob;
}

const ENROLLMENT_PAYLOAD_KEYS = new Set([
  'serverUrl',
  'enrollToken',
  'abiProfile',
  'ownerName',
]);

function normalizeEnrollmentServerOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > CONTROLLED_NODE_SERVER_URL_MAX_CHARS) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    if (parsed.origin === 'null') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Validate a decoded JSON enrollment payload received via CLI stdin or HTTP exchange. */
export function validateEnrollmentPayload(raw: unknown): EnvelopeValidation<EnrollmentBlob> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'not_an_object' };
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!ENROLLMENT_PAYLOAD_KEYS.has(key)) {
      return { ok: false, error: `unknown_field:${key}` };
    }
  }
  const serverUrl = normalizeEnrollmentServerOrigin(r.serverUrl);
  if (!serverUrl) {
    return { ok: false, error: 'invalid_serverUrl' };
  }
  if (
    typeof r.enrollToken !== 'string'
    || r.enrollToken.length === 0
    || r.enrollToken.trim() !== r.enrollToken
    || utf8ByteLength(r.enrollToken) > CONTROLLED_NODE_ENROLL_TOKEN_MAX_BYTES
    // eslint-disable-next-line no-control-regex
    || /[\u0000-\u001f\u007f]/.test(r.enrollToken)
  ) {
    return { ok: false, error: 'invalid_enrollToken' };
  }
  const abiProfile = normalizeControlledNodeAbiProfile(r.abiProfile);
  if (!abiProfile) {
    return { ok: false, error: 'invalid_abiProfile' };
  }
  if (r.ownerName !== undefined && typeof r.ownerName !== 'string') {
    return { ok: false, error: 'invalid_ownerName' };
  }
  const ownerName = typeof r.ownerName === 'string'
    ? sanitizeEnrollmentOwnerName(r.ownerName)
    : '';
  return {
    ok: true,
    value: {
      serverUrl,
      enrollToken: r.enrollToken,
      ...(abiProfile !== CONTROLLED_NODE_ABI_MODERN ? { abiProfile } : {}),
      ...(ownerName ? { ownerName } : {}),
    },
  };
}

/** Bounded UTF-8 JSON parser and schema validator for `--enroll-stdin`. */
export function parseEnrollmentPayloadJson(
  rawText: string,
  maxBytes = CONTROLLED_NODE_ENROLL_STDIN_MAX_BYTES,
): EnvelopeValidation<EnrollmentBlob> {
  if (typeof rawText !== 'string') {
    return { ok: false, error: 'not_a_string' };
  }
  const byteLen = utf8ByteLength(rawText);
  if (byteLen === 0 || rawText.trim().length === 0) {
    return { ok: false, error: 'empty_payload' };
  }
  if (byteLen > maxBytes) {
    return { ok: false, error: 'payload_too_large' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  return validateEnrollmentPayload(parsed);
}
