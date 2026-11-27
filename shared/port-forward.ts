import { isIP } from 'node:net';
import type { DirectFileTransferIceServerConfig } from './direct-file-transfer.js';
import {
  isLocalComputerUseAlias,
  MACHINE_TARGET_MAX,
  MACHINE_TARGET_PATTERN,
  normalizeMachineTarget,
} from './machine-reference.js';

export const PORT_FORWARD_API_PATH = '/api/port-forwards' as const;

export const PORT_FORWARD_TRANSPORT = {
  DIRECT_TCP: 'direct_tcp',
  DIRECT_UDP_P2P: 'direct_udp_p2p',
  RELAY: 'relay',
} as const;

export type PortForwardTransport =
  (typeof PORT_FORWARD_TRANSPORT)[keyof typeof PORT_FORWARD_TRANSPORT];

export const PORT_FORWARD_TRANSPORTS = [
  PORT_FORWARD_TRANSPORT.DIRECT_TCP,
  PORT_FORWARD_TRANSPORT.DIRECT_UDP_P2P,
  PORT_FORWARD_TRANSPORT.RELAY,
] as const;

export const PORT_FORWARD_TRANSPORT_PREF = {
  AUTO: 'auto',
  P2P_ONLY: 'p2p_only',
  RELAY: 'relay',
} as const;

export type PortForwardTransportPref =
  (typeof PORT_FORWARD_TRANSPORT_PREF)[keyof typeof PORT_FORWARD_TRANSPORT_PREF];

export const PORT_FORWARD_TRANSPORT_PREFS = [
  PORT_FORWARD_TRANSPORT_PREF.AUTO,
  PORT_FORWARD_TRANSPORT_PREF.P2P_ONLY,
  PORT_FORWARD_TRANSPORT_PREF.RELAY,
] as const;

export const PORT_FORWARD_ROLE = {
  LISTEN: 'listen',
  TARGET: 'target',
} as const;

export type PortForwardRole =
  (typeof PORT_FORWARD_ROLE)[keyof typeof PORT_FORWARD_ROLE];

export const PORT_FORWARD_MSG = {
  PREPARE: 'port_forward.prepare',
  READY: 'port_forward.ready',
  CONNECT: 'port_forward.connect',
  ESTABLISHED: 'port_forward.established',
  CLOSE: 'port_forward.close',
  ERROR: 'port_forward.error',
  RELAY_FRAME: 'port_forward.relay_frame',
  STATS: 'port_forward.stats',
} as const;

export type PortForwardMsgType =
  (typeof PORT_FORWARD_MSG)[keyof typeof PORT_FORWARD_MSG];

const PORT_FORWARD_MSG_SET: ReadonlySet<string> = new Set(Object.values(PORT_FORWARD_MSG));

export function isPortForwardMessageType(value: unknown): value is PortForwardMsgType {
  return typeof value === 'string' && PORT_FORWARD_MSG_SET.has(value);
}

export const PORT_FORWARD_ERRORS = {
  INVALID_REQUEST: 'invalid_request',
  TARGET_FORBIDDEN: 'target_forbidden',
  EXEC_DISABLED: 'exec_disabled',
  SCOPED_AUTH: 'scoped_auth',
  RATE_LIMITED: 'rate_limited',
  NODE_NOT_FOUND: 'node_not_found',
  NODE_AMBIGUOUS: 'node_ambiguous',
  NODE_OFFLINE: 'node_offline',
  LISTEN_PORT_IN_USE: 'listen_port_in_use',
  LIMIT_EXCEEDED: 'tunnel_limit_exceeded',
  TARGET_UNSUPPORTED: 'target_unsupported',
  P2P_FAILED: 'p2p_failed',
  TIMEOUT: 'timeout',
  TUNNEL_NOT_FOUND: 'tunnel_not_found',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type PortForwardErrorCode =
  (typeof PORT_FORWARD_ERRORS)[keyof typeof PORT_FORWARD_ERRORS];

export const PORT_FORWARD_ERROR_CODES = Object.values(PORT_FORWARD_ERRORS) as readonly PortForwardErrorCode[];

const PORT_FORWARD_ERROR_SET: ReadonlySet<string> = new Set(PORT_FORWARD_ERROR_CODES);

export const PORT_FORWARD_LIMITS = {
  MAX_TUNNELS_PER_USER: 16,
  MAX_TUNNELS_PER_NODE: 16,
  MAX_CONCURRENT_STREAMS_PER_TUNNEL: 64,
  DEFAULT_TTL_SECONDS: 1800,
  MIN_TTL_SECONDS: 30,
  MAX_TTL_SECONDS: 86_400,
  STREAM_WINDOW_BYTES: 256 * 1024,
  STREAM_WINDOW_REFILL_THRESHOLD_BYTES: 128 * 1024,
  MAX_DATA_CHUNK_BYTES: 32 * 1024,
  MAX_UDP_PAYLOAD_BYTES: 1200,
  MAX_UDP_CHUNK_BYTES: 1080,
  UDP_HEARTBEAT_INTERVAL_MS: 15_000,
  UDP_DEAD_LINK_TIMEOUT_MS: 45_000,
  UDP_PUNCH_INTERVAL_MS: 150,
  UDP_PUNCH_TIMEOUT_MS: 3_000,
  STUN_PROBE_TIMEOUT_MS: 1_500,
  DIRECT_TCP_CONNECT_TIMEOUT_MS: 1_200,
  DIRECT_TCP_PREFERENCE_WAIT_MS: 200,
  DIRECT_TCP_TARGET_DIAL_DELAY_MS: 60,
  PREPARE_TIMEOUT_MS: 5_000,
  ESTABLISH_TIMEOUT_MS: 10_000,
  HTTP_OPEN_TIMEOUT_MS: 20_000,
  HANDSHAKE_TIMEOUT_MS: 5_000,
  HANDSHAKE_LINE_MAX_BYTES: 2 * 1024,
  MAX_CANDIDATES: 24,
  MAX_CONTROL_BYTES: 64 * 1024,
  MAX_LABEL_LENGTH: 128,
  LISTEN_HOST: '127.0.0.1',
  DEFAULT_TARGET_HOST: '127.0.0.1',
  MAX_HOST_LENGTH: 253,
  FRAME_AUTH_TAG_BYTES: 16,
  MAX_TCP_ENCRYPTED_FRAME_BYTES: 64 * 1024,
  MAX_RELAY_FRAME_B64_BYTES: 128 * 1024,
  MAX_LIST_TUNNELS: 64,
  MAX_STREAM_RECV_BUFFER_BYTES: 512 * 1024,
  CARRIER_HIGH_WATER_BYTES: 1024 * 1024,
  CARRIER_HARD_CAP_BYTES: 8 * 1024 * 1024,
  UDP_HIGH_WATER_PACKETS: 256,
  UDP_LOW_WATER_PACKETS: 128,
  UDP_HARD_CAP_PACKETS: 1024,
  RELAY_WS_HIGH_WATER_BYTES: 2 * 1024 * 1024,
  RELAY_WS_LOW_WATER_BYTES: 512 * 1024,
  RELAY_WS_HARD_CAP_BYTES: 8 * 1024 * 1024,
  MAX_PRECONNECT_TCP_SOCKETS: 32,
} as const;

export const PORT_FORWARD_SELF_ALIASES = ['self', 'local', 'localhost', 'this'] as const;

export const PORT_FORWARD_MUX_VERSION = 1 as const;
export const PORT_FORWARD_MUX_HEADER_BYTES = 10 as const;

export const PORT_FORWARD_MUX_TYPE = {
  OPEN: 1,
  OPEN_OK: 2,
  OPEN_ERR: 3,
  DATA: 4,
  EOF: 5,
  RST: 6,
  WINDOW_UPDATE: 7,
  PING: 8,
  PONG: 9,
  KEY_CONFIRM: 10,
  KEY_CONFIRM_ACK: 11,
} as const;

export type PortForwardMuxType =
  (typeof PORT_FORWARD_MUX_TYPE)[keyof typeof PORT_FORWARD_MUX_TYPE];

const MUX_TYPE_SET = new Set<number>(Object.values(PORT_FORWARD_MUX_TYPE));

export interface PortForwardMuxFrame {
  type: PortForwardMuxType;
  streamId: number;
  payload: Buffer;
}

export function encodePortForwardMuxFrame(
  type: PortForwardMuxType,
  streamId: number,
  payload: Buffer = Buffer.alloc(0),
): Buffer {
  if (!MUX_TYPE_SET.has(type)) throw new Error('invalid_mux_type');
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffff_ffff) {
    throw new Error('invalid_mux_stream_id');
  }
  if (payload.length > PORT_FORWARD_LIMITS.MAX_DATA_CHUNK_BYTES + 64) {
    throw new Error('mux_payload_too_large');
  }
  const frame = Buffer.allocUnsafe(PORT_FORWARD_MUX_HEADER_BYTES + payload.length);
  frame[0] = PORT_FORWARD_MUX_VERSION;
  frame[1] = type;
  frame.writeUInt32BE(streamId >>> 0, 2);
  frame.writeUInt32BE(payload.length >>> 0, 6);
  if (payload.length > 0) payload.copy(frame, PORT_FORWARD_MUX_HEADER_BYTES);
  return frame;
}

export class PortForwardMuxAccumulator {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): PortForwardMuxFrame[] {
    if (chunk.length === 0) return [];
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: PortForwardMuxFrame[] = [];
    while (this.buffer.length >= PORT_FORWARD_MUX_HEADER_BYTES) {
      const version = this.buffer[0]!;
      const type = this.buffer[1]!;
      const streamId = this.buffer.readUInt32BE(2);
      const payloadLen = this.buffer.readUInt32BE(6);
      if (version !== PORT_FORWARD_MUX_VERSION || !MUX_TYPE_SET.has(type)) {
        throw new Error('invalid_mux_header');
      }
      if (payloadLen > PORT_FORWARD_LIMITS.MAX_DATA_CHUNK_BYTES + 64) {
        throw new Error('mux_frame_too_large');
      }
      const totalLen = PORT_FORWARD_MUX_HEADER_BYTES + payloadLen;
      if (this.buffer.length < totalLen) break;
      const payload = payloadLen === 0
        ? Buffer.alloc(0)
        : Buffer.from(this.buffer.subarray(PORT_FORWARD_MUX_HEADER_BYTES, totalLen));
      this.buffer = this.buffer.subarray(totalLen);
      frames.push({ type: type as PortForwardMuxType, streamId, payload });
    }
    return frames;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

export interface PortForwardCandidate {
  host: string;
  port: number;
  transport: 'tcp' | 'udp';
  kind: 'host' | 'srflx';
}

export interface PortForwardPrepareMessage {
  type: typeof PORT_FORWARD_MSG.PREPARE;
  tunnelId: string;
  role: PortForwardRole;
  /** Server-minted admission token (punch/TCP hello proof & HKDF salt; never alone derives traffic keys). */
  capability: string;
  selfServerId: string;
  peerServerId: string;
  listenHost?: typeof PORT_FORWARD_LIMITS.LISTEN_HOST;
  listenPort?: number;
  targetHost?: string;
  targetPort?: number;
  transport: PortForwardTransportPref;
  iceServers: DirectFileTransferIceServerConfig[];
  ttlMs: number;
}

export interface PortForwardReadyMessage {
  type: typeof PORT_FORWARD_MSG.READY;
  tunnelId: string;
  role: PortForwardRole;
  listenPort?: number;
  candidates: PortForwardCandidate[];
  /** Ephemeral X25519 SPKI DER public key (base64url) generated locally by the node. */
  publicKey: string;
  /** HMAC proof under admission key binding (tunnelId, role, selfServerId, peerServerId, publicKey). */
  keyProof: string;
}

export interface PortForwardConnectMessage {
  type: typeof PORT_FORWARD_MSG.CONNECT;
  tunnelId: string;
  role: PortForwardRole;
  peerCandidates: PortForwardCandidate[];
  peerPublicKey: string;
  peerKeyProof: string;
  transport: PortForwardTransportPref;
}

export interface PortForwardEstablishedMessage {
  type: typeof PORT_FORWARD_MSG.ESTABLISHED;
  tunnelId: string;
  role: PortForwardRole;
  transportMode: PortForwardTransport;
  listenPort?: number;
}

export interface PortForwardCloseMessage {
  type: typeof PORT_FORWARD_MSG.CLOSE;
  tunnelId: string;
  reason?: string;
}

export interface PortForwardErrorMessage {
  type: typeof PORT_FORWARD_MSG.ERROR;
  tunnelId: string;
  reason: PortForwardErrorCode;
  error?: string;
}

export interface PortForwardRelayFrameMessage {
  type: typeof PORT_FORWARD_MSG.RELAY_FRAME;
  tunnelId: string;
  /** Base64-encoded AES-256-GCM encrypted frame; opaque to the relay server. */
  data: string;
}

export interface PortForwardStatsMessage {
  type: typeof PORT_FORWARD_MSG.STATS;
  tunnelId: string;
  activeConnections: number;
  bytesSent: number;
  bytesReceived: number;
}

export type PortForwardWireMessage =
  | PortForwardPrepareMessage
  | PortForwardReadyMessage
  | PortForwardConnectMessage
  | PortForwardEstablishedMessage
  | PortForwardCloseMessage
  | PortForwardErrorMessage
  | PortForwardRelayFrameMessage
  | PortForwardStatsMessage;

export interface PortForwardOpenRequest {
  listenNode: string;
  targetNode: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  ttlSeconds: number;
  transport: PortForwardTransportPref;
  label?: string;
}

export interface PortForwardTunnelSummary {
  tunnelId: string;
  listenNode: string;
  listenServerId: string;
  listenNodeId?: string;
  listenHost: typeof PORT_FORWARD_LIMITS.LISTEN_HOST;
  listenPort: number;
  localEndpoint: string;
  targetNode: string;
  targetServerId: string;
  targetNodeId?: string;
  targetHost: string;
  targetPort: number;
  transportMode: PortForwardTransport;
  activeConnections: number;
  bytesSent: number;
  bytesReceived: number;
  createdAt: number;
  expiresAt: number;
  label?: string;
}

const TUNNEL_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CAPABILITY_RE = /^[A-Za-z0-9_-]{43}$/;
const SERVER_ID_RE = /^[A-Za-z0-9._:-]{2,128}$/;
const ECDH_PUB_RE = /^[A-Za-z0-9_-]{40,128}$/;
const KEY_PROOF_RE = /^[A-Za-z0-9_-]{32,64}$/;
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
const B64_RE = /^[A-Za-z0-9+/=_-]+$/;
const TRANSPORT_PREF_SET: ReadonlySet<string> = new Set(PORT_FORWARD_TRANSPORT_PREFS);
const TRANSPORT_SET: ReadonlySet<string> = new Set(PORT_FORWARD_TRANSPORTS);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasAllowedKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
    && Object.keys(obj).every((k) => allowed.has(k));
}

export function isPortForwardSelfAlias(value: unknown): boolean {
  return isLocalComputerUseAlias(value);
}

export function validatePortForwardNodeRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > Math.max(MACHINE_TARGET_MAX, 128)) return null;
  if (isPortForwardSelfAlias(trimmed)) return trimmed.toLowerCase();
  if (MACHINE_TARGET_PATTERN.test(trimmed)) {
    return normalizeMachineTarget(trimmed) ?? trimmed;
  }
  // Exact serverId values use safe ASCII identifiers (e.g. UUID or srv_xxx).
  if (/^[A-Za-z0-9._:-]{2,128}$/.test(trimmed)) return trimmed;
  return null;
}

export function validatePortForwardHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > PORT_FORWARD_LIMITS.MAX_HOST_LENGTH) return null;
  if (/[\s\u0000-\u001F\u007F]/.test(trimmed)) return null;
  const unbracketed = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  const ipVer = isIP(unbracketed);
  if (ipVer === 4 || ipVer === 6) return unbracketed;
  if (trimmed.includes('..') || !HOSTNAME_RE.test(trimmed)) return null;
  return trimmed;
}

export function validatePortForwardPort(raw: unknown, allowZero = false): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  const min = allowZero ? 0 : 1;
  return raw >= min && raw <= 65_535 ? raw : null;
}

export function validatePortForwardTtlSeconds(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  return raw >= PORT_FORWARD_LIMITS.MIN_TTL_SECONDS && raw <= PORT_FORWARD_LIMITS.MAX_TTL_SECONDS
    ? raw
    : null;
}

export function validatePortForwardTransportPref(raw: unknown): PortForwardTransportPref | null {
  return typeof raw === 'string' && TRANSPORT_PREF_SET.has(raw)
    ? (raw as PortForwardTransportPref)
    : null;
}

export function validatePortForwardCandidate(raw: unknown): PortForwardCandidate | null {
  if (!isObject(raw)) return null;
  if (!hasAllowedKeys(raw, ['host', 'port', 'transport', 'kind'])) return null;
  const host = validatePortForwardHost(raw.host);
  const port = validatePortForwardPort(raw.port, false);
  const transport = raw.transport === 'tcp' || raw.transport === 'udp' ? raw.transport : null;
  const kind = raw.kind === 'host' || raw.kind === 'srflx' ? raw.kind : null;
  if (!host || !port || !transport || !kind) return null;
  // Never advertise unspecified/loopback addresses as peer candidates except when explicitly host-loopback in unit tests? Wait: loopback 127.0.0.1 IS excluded in OS scan, reject 0.0.0.0 / ::.
  if (host === '0.0.0.0' || host === '::') return null;
  return { host, port, transport, kind };
}

function validateIceServerConfig(raw: unknown): DirectFileTransferIceServerConfig | null {
  if (typeof raw === 'string') {
    return raw.length > 0 && raw.length <= 256 ? raw : null;
  }
  if (!isObject(raw)) return null;
  if (!hasAllowedKeys(raw, ['urls'], ['username', 'credential'])) return null;
  const urls = Array.isArray(raw.urls)
    ? raw.urls.filter((u): u is string => typeof u === 'string' && u.length > 0 && u.length <= 256)
    : typeof raw.urls === 'string' && raw.urls.length > 0 && raw.urls.length <= 256
      ? [raw.urls]
      : null;
  if (!urls || urls.length === 0) return null;
  if (raw.username !== undefined && (typeof raw.username !== 'string' || raw.username.length > 256)) return null;
  if (raw.credential !== undefined && (typeof raw.credential !== 'string' || raw.credential.length > 256)) return null;
  return {
    urls,
    ...(typeof raw.username === 'string' ? { username: raw.username } : {}),
    ...(typeof raw.credential === 'string' ? { credential: raw.credential } : {}),
  };
}

export function validatePortForwardOpenRequest(
  raw: unknown,
): { ok: true; value: PortForwardOpenRequest } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: 'request body must be an object' };
  const allowed = new Set([
    'listenNode',
    'targetNode',
    'listenPort',
    'targetHost',
    'targetPort',
    'ttlSeconds',
    'transport',
    'label',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return { ok: false, error: `unexpected field: ${key}` };
  }
  const listenNode = raw.listenNode === undefined
    ? 'self'
    : validatePortForwardNodeRef(raw.listenNode);
  if (!listenNode) return { ok: false, error: 'invalid listenNode' };
  const targetNode = validatePortForwardNodeRef(raw.targetNode);
  if (!targetNode) return { ok: false, error: 'invalid targetNode' };
  const listenPort = raw.listenPort === undefined
    ? 0
    : validatePortForwardPort(raw.listenPort, true);
  if (listenPort === null) return { ok: false, error: 'listenPort must be an integer in [0, 65535]' };
  const targetHost = raw.targetHost === undefined
    ? PORT_FORWARD_LIMITS.DEFAULT_TARGET_HOST
    : validatePortForwardHost(raw.targetHost);
  if (!targetHost) return { ok: false, error: 'invalid targetHost' };
  const targetPort = validatePortForwardPort(raw.targetPort, false);
  if (targetPort === null) return { ok: false, error: 'targetPort must be an integer in [1, 65535]' };
  const ttlSeconds = raw.ttlSeconds === undefined
    ? PORT_FORWARD_LIMITS.DEFAULT_TTL_SECONDS
    : validatePortForwardTtlSeconds(raw.ttlSeconds);
  if (ttlSeconds === null) {
    return {
      ok: false,
      error: `ttlSeconds must be an integer in [${PORT_FORWARD_LIMITS.MIN_TTL_SECONDS}, ${PORT_FORWARD_LIMITS.MAX_TTL_SECONDS}]`,
    };
  }
  const transport = raw.transport === undefined
    ? PORT_FORWARD_TRANSPORT_PREF.AUTO
    : validatePortForwardTransportPref(raw.transport);
  if (!transport) return { ok: false, error: 'transport must be auto, p2p_only, or relay' };
  let label: string | undefined;
  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string') return { ok: false, error: 'label must be a string' };
    const trimmed = raw.label.trim();
    if (trimmed.length > PORT_FORWARD_LIMITS.MAX_LABEL_LENGTH) {
      return { ok: false, error: `label must be at most ${PORT_FORWARD_LIMITS.MAX_LABEL_LENGTH} characters` };
    }
    if (trimmed.length > 0) label = trimmed;
  }
  return {
    ok: true,
    value: {
      listenNode,
      targetNode,
      listenPort,
      targetHost,
      targetPort,
      ttlSeconds,
      transport,
      ...(label !== undefined ? { label } : {}),
    },
  };
}

export function validatePortForwardWireMessage(
  raw: unknown,
): { ok: true; value: PortForwardWireMessage } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: 'invalid_object' };
  const type = raw.type;
  if (!isPortForwardMessageType(type)) return { ok: false, error: 'invalid_type' };
  const tunnelId = raw.tunnelId;
  if (typeof tunnelId !== 'string' || !TUNNEL_ID_RE.test(tunnelId)) {
    return { ok: false, error: 'invalid_tunnel_id' };
  }

  switch (type) {
    case PORT_FORWARD_MSG.PREPARE: {
      if (!hasAllowedKeys(
        raw,
        ['type', 'tunnelId', 'role', 'capability', 'selfServerId', 'peerServerId', 'transport', 'iceServers', 'ttlMs'],
        ['listenHost', 'listenPort', 'targetHost', 'targetPort'],
      )) {
        return { ok: false, error: 'invalid_keys' };
      }
      if (raw.role !== PORT_FORWARD_ROLE.LISTEN && raw.role !== PORT_FORWARD_ROLE.TARGET) {
        return { ok: false, error: 'invalid_role' };
      }
      if (typeof raw.capability !== 'string' || !CAPABILITY_RE.test(raw.capability)) {
        return { ok: false, error: 'invalid_capability' };
      }
      if (typeof raw.selfServerId !== 'string'
        || !SERVER_ID_RE.test(raw.selfServerId)
        || typeof raw.peerServerId !== 'string'
        || !SERVER_ID_RE.test(raw.peerServerId)
        || raw.selfServerId === raw.peerServerId) {
        return { ok: false, error: 'invalid_endpoint_server_id' };
      }
      const transport = validatePortForwardTransportPref(raw.transport);
      if (!transport) return { ok: false, error: 'invalid_transport' };
      if (!Array.isArray(raw.iceServers) || raw.iceServers.length > 16) {
        return { ok: false, error: 'invalid_ice_servers' };
      }
      const iceServers: DirectFileTransferIceServerConfig[] = [];
      for (const entry of raw.iceServers) {
        const validated = validateIceServerConfig(entry);
        if (!validated) return { ok: false, error: 'invalid_ice_server' };
        iceServers.push(validated);
      }
      if (typeof raw.ttlMs !== 'number'
        || !Number.isInteger(raw.ttlMs)
        || raw.ttlMs < PORT_FORWARD_LIMITS.MIN_TTL_SECONDS * 1000
        || raw.ttlMs > PORT_FORWARD_LIMITS.MAX_TTL_SECONDS * 1000) {
        return { ok: false, error: 'invalid_ttl_ms' };
      }
      if (raw.role === PORT_FORWARD_ROLE.LISTEN) {
        if (raw.listenHost !== PORT_FORWARD_LIMITS.LISTEN_HOST) {
          return { ok: false, error: 'invalid_listen_host' };
        }
        const listenPort = validatePortForwardPort(raw.listenPort, true);
        if (listenPort === null) return { ok: false, error: 'invalid_listen_port' };
        if (raw.targetHost !== undefined || raw.targetPort !== undefined) {
          return { ok: false, error: 'unexpected_target_fields' };
        }
        return {
          ok: true,
          value: {
            type,
            tunnelId,
            role: PORT_FORWARD_ROLE.LISTEN,
            capability: raw.capability,
            selfServerId: raw.selfServerId,
            peerServerId: raw.peerServerId,
            listenHost: PORT_FORWARD_LIMITS.LISTEN_HOST,
            listenPort,
            transport,
            iceServers,
            ttlMs: raw.ttlMs,
          },
        };
      }
      const targetHost = validatePortForwardHost(raw.targetHost);
      const targetPort = validatePortForwardPort(raw.targetPort, false);
      if (!targetHost || targetPort === null) return { ok: false, error: 'invalid_target_endpoint' };
      if (raw.listenHost !== undefined || raw.listenPort !== undefined) {
        return { ok: false, error: 'unexpected_listen_fields' };
      }
      return {
        ok: true,
        value: {
          type,
          tunnelId,
          role: PORT_FORWARD_ROLE.TARGET,
          capability: raw.capability,
          selfServerId: raw.selfServerId,
          peerServerId: raw.peerServerId,
          targetHost,
          targetPort,
          transport,
          iceServers,
          ttlMs: raw.ttlMs,
        },
      };
    }

    case PORT_FORWARD_MSG.READY: {
      if (!hasAllowedKeys(raw, ['type', 'tunnelId', 'role', 'candidates', 'publicKey', 'keyProof'], ['listenPort'])) {
        return { ok: false, error: 'invalid_keys' };
      }
      if (raw.role !== PORT_FORWARD_ROLE.LISTEN && raw.role !== PORT_FORWARD_ROLE.TARGET) {
        return { ok: false, error: 'invalid_role' };
      }
      if (typeof raw.publicKey !== 'string' || !ECDH_PUB_RE.test(raw.publicKey)) {
        return { ok: false, error: 'invalid_public_key' };
      }
      if (typeof raw.keyProof !== 'string' || !KEY_PROOF_RE.test(raw.keyProof)) {
        return { ok: false, error: 'invalid_key_proof' };
      }
      let listenPort: number | undefined;
      if (raw.role === PORT_FORWARD_ROLE.LISTEN) {
        const parsedPort = validatePortForwardPort(raw.listenPort, false);
        if (parsedPort === null) return { ok: false, error: 'invalid_listen_port' };
        listenPort = parsedPort;
      } else if (raw.listenPort !== undefined) {
        return { ok: false, error: 'unexpected_listen_port' };
      }
      if (!Array.isArray(raw.candidates) || raw.candidates.length > PORT_FORWARD_LIMITS.MAX_CANDIDATES) {
        return { ok: false, error: 'invalid_candidates' };
      }
      const candidates: PortForwardCandidate[] = [];
      for (const candidate of raw.candidates) {
        const parsed = validatePortForwardCandidate(candidate);
        if (!parsed) return { ok: false, error: 'invalid_candidate' };
        candidates.push(parsed);
      }
      return {
        ok: true,
        value: {
          type,
          tunnelId,
          role: raw.role,
          ...(listenPort !== undefined ? { listenPort } : {}),
          candidates,
          publicKey: raw.publicKey,
          keyProof: raw.keyProof,
        },
      };
    }

    case PORT_FORWARD_MSG.CONNECT: {
      if (!hasAllowedKeys(raw, ['type', 'tunnelId', 'role', 'peerCandidates', 'peerPublicKey', 'peerKeyProof', 'transport'])) {
        return { ok: false, error: 'invalid_keys' };
      }
      if (raw.role !== PORT_FORWARD_ROLE.LISTEN && raw.role !== PORT_FORWARD_ROLE.TARGET) {
        return { ok: false, error: 'invalid_role' };
      }
      if (typeof raw.peerPublicKey !== 'string' || !ECDH_PUB_RE.test(raw.peerPublicKey)) {
        return { ok: false, error: 'invalid_peer_public_key' };
      }
      if (typeof raw.peerKeyProof !== 'string' || !KEY_PROOF_RE.test(raw.peerKeyProof)) {
        return { ok: false, error: 'invalid_peer_key_proof' };
      }
      const transport = validatePortForwardTransportPref(raw.transport);
      if (!transport) return { ok: false, error: 'invalid_transport' };
      if (!Array.isArray(raw.peerCandidates) || raw.peerCandidates.length > PORT_FORWARD_LIMITS.MAX_CANDIDATES) {
        return { ok: false, error: 'invalid_candidates' };
      }
      const peerCandidates: PortForwardCandidate[] = [];
      for (const candidate of raw.peerCandidates) {
        const parsed = validatePortForwardCandidate(candidate);
        if (!parsed) return { ok: false, error: 'invalid_candidate' };
        peerCandidates.push(parsed);
      }
      return {
        ok: true,
        value: {
          type,
          tunnelId,
          role: raw.role,
          peerCandidates,
          peerPublicKey: raw.peerPublicKey,
          peerKeyProof: raw.peerKeyProof,
          transport,
        },
      };
    }

    case PORT_FORWARD_MSG.ESTABLISHED: {
      if (!hasAllowedKeys(raw, ['type', 'tunnelId', 'role', 'transportMode'], ['listenPort'])) {
        return { ok: false, error: 'invalid_keys' };
      }
      if (raw.role !== PORT_FORWARD_ROLE.LISTEN && raw.role !== PORT_FORWARD_ROLE.TARGET) {
        return { ok: false, error: 'invalid_role' };
      }
      if (typeof raw.transportMode !== 'string' || !TRANSPORT_SET.has(raw.transportMode)) {
        return { ok: false, error: 'invalid_transport_mode' };
      }
      let listenPort: number | undefined;
      if (raw.role === PORT_FORWARD_ROLE.LISTEN) {
        const parsed = validatePortForwardPort(raw.listenPort, false);
        if (parsed === null) return { ok: false, error: 'invalid_listen_port' };
        listenPort = parsed;
      } else if (raw.listenPort !== undefined) {
        return { ok: false, error: 'unexpected_listen_port' };
      }
      return {
        ok: true,
        value: {
          type,
          tunnelId,
          role: raw.role,
          transportMode: raw.transportMode as PortForwardTransport,
          ...(listenPort !== undefined ? { listenPort } : {}),
        },
      };
    }

    case PORT_FORWARD_MSG.CLOSE: {
      if (!hasAllowedKeys(raw, ['type', 'tunnelId'], ['reason'])) {
        return { ok: false, error: 'invalid_keys' };
      }
      if (raw.reason !== undefined && (typeof raw.reason !== 'string' || raw.reason.length > 128)) {
        return { ok: false, error: 'invalid_reason' };
      }
      return {
        ok: true,
        value: {
          type,
          tunnelId,
          ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
        },
      };
    }

    case PORT_FORWARD_MSG.ERROR: {
      if (!hasAllowedKeys(raw, ['type', 'tunnelId', 'reason'], ['error'])) {
        return { ok: false, error: 'invalid_keys' };
      }
      if (typeof raw.reason !== 'string' || !PORT_FORWARD_ERROR_SET.has(raw.reason)) {
        return { ok: false, error: 'invalid_reason' };
      }
      if (raw.error !== undefined && (typeof raw.error !== 'string' || raw.error.length > 512)) {
        return { ok: false, error: 'invalid_error' };
      }
      return {
        ok: true,
        value: {
          type,
          tunnelId,
          reason: raw.reason as PortForwardErrorCode,
          ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
        },
      };
    }

    case PORT_FORWARD_MSG.RELAY_FRAME: {
      if (!hasAllowedKeys(raw, ['type', 'tunnelId', 'data'])) {
        return { ok: false, error: 'invalid_keys' };
      }
      if (typeof raw.data !== 'string'
        || raw.data.length === 0
        || raw.data.length > PORT_FORWARD_LIMITS.MAX_RELAY_FRAME_B64_BYTES
        || !B64_RE.test(raw.data)) {
        return { ok: false, error: 'invalid_relay_data' };
      }
      return { ok: true, value: { type, tunnelId, data: raw.data } };
    }

    case PORT_FORWARD_MSG.STATS: {
      if (!hasAllowedKeys(raw, ['type', 'tunnelId', 'activeConnections', 'bytesSent', 'bytesReceived'])) {
        return { ok: false, error: 'invalid_keys' };
      }
      if (typeof raw.activeConnections !== 'number'
        || !Number.isInteger(raw.activeConnections)
        || raw.activeConnections < 0
        || raw.activeConnections > PORT_FORWARD_LIMITS.MAX_CONCURRENT_STREAMS_PER_TUNNEL
        || typeof raw.bytesSent !== 'number'
        || !Number.isSafeInteger(raw.bytesSent)
        || raw.bytesSent < 0
        || typeof raw.bytesReceived !== 'number'
        || !Number.isSafeInteger(raw.bytesReceived)
        || raw.bytesReceived < 0) {
        return { ok: false, error: 'invalid_stats' };
      }
      return {
        ok: true,
        value: {
          type,
          tunnelId,
          activeConnections: raw.activeConnections,
          bytesSent: raw.bytesSent,
          bytesReceived: raw.bytesReceived,
        },
      };
    }
  }
}

export function isPrivateRoutableIpv4(host: string): boolean {
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b! >= 64 && b! <= 127);
}
