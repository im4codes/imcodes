import type {
  RemoteDesktopLocalAction,
  RemoteDesktopLocalConnection,
} from './remote-desktop-local-management.js';

/** Stable wire vocabulary for the native aiDesk UI <-> controlled-node runtime. */
export const AIDESK_LOCAL_IPC = Object.freeze({
  PROTOCOL_VERSION: 1,
  MAX_FRAME_BYTES: 1024 * 1024,
  HANDSHAKE_TIMEOUT_MS: 5_000,
  ACTION_TIMEOUT_MS: 3_000,
  CAPABILITY_TTL_MS: 5 * 60_000,
  REFRESH_INTERVAL_MS: 1_000,
  SOCKET_FILE: 'aidesk-local-management-v1.sock',
  BOOTSTRAP_FILE: 'aidesk-local-management-v1.json',
  WINDOWS_PIPE: String.raw`\\.\pipe\aidesk-local-management-v1`,
} as const);

export const AIDESK_LOCAL_IPC_MESSAGE = Object.freeze({
  HELLO: 'aidesk_local.hello',
  WELCOME: 'aidesk_local.welcome',
  SNAPSHOT: 'aidesk_local.snapshot',
  ACTION: 'aidesk_local.action',
  ACK: 'aidesk_local.ack',
  REFRESH: 'aidesk_local.refresh',
  ERROR: 'aidesk_local.error',
} as const);

export const AIDESK_LOCAL_IPC_SERVICE_STATE = Object.freeze({
  READY: 'ready',
  STARTING: 'starting',
  STOPPED: 'stopped',
  REPAIR_REQUIRED: 'repair_required',
  VERSION_MISMATCH: 'version_mismatch',
} as const);

export const AIDESK_LOCAL_IPC_ACCESS_STATE = Object.freeze({
  READY: 'ready',
  PAUSED: 'paused',
  STOPPING: 'stopping',
  UNAVAILABLE: 'unavailable',
} as const);

export const AIDESK_LOCAL_IPC_ERROR = Object.freeze({
  UNAUTHORIZED: 'unauthorized',
  INVALID_FRAME: 'invalid_frame',
  FRAME_TOO_LARGE: 'frame_too_large',
  VERSION_MISMATCH: 'version_mismatch',
  INVALID_CAPABILITY: 'invalid_capability',
  STALE_REVISION: 'stale_revision',
  INVALID_ACTION: 'invalid_action',
  NOT_FOUND: 'not_found',
  REQUEST_CONFLICT: 'request_conflict',
  ACTION_FAILED: 'action_failed',
} as const);

export type AideskLocalIpcServiceState = typeof AIDESK_LOCAL_IPC_SERVICE_STATE[
  keyof typeof AIDESK_LOCAL_IPC_SERVICE_STATE
];

export type AideskLocalIpcAccessState = typeof AIDESK_LOCAL_IPC_ACCESS_STATE[
  keyof typeof AIDESK_LOCAL_IPC_ACCESS_STATE
];

export interface AideskLocalIpcBootstrap {
  version: 1;
  protocolVersion: number;
  endpoint: string;
  bootstrapSecret: string;
  runtimeVersion: string;
  productVersion: string;
}

export interface AideskLocalIpcConnection extends RemoteDesktopLocalConnection {
  durationMs: number;
}

export interface AideskLocalIpcSnapshot {
  type: typeof AIDESK_LOCAL_IPC_MESSAGE.SNAPSHOT;
  protocolVersion: number;
  revision: number;
  publicNodeId: string;
  serviceState: AideskLocalIpcServiceState;
  accessState: AideskLocalIpcAccessState;
  paused: boolean;
  connections: readonly AideskLocalIpcConnection[];
}

export interface AideskLocalIpcHello {
  type: typeof AIDESK_LOCAL_IPC_MESSAGE.HELLO;
  protocolVersion: number;
  bootstrapSecret: string;
  clientNonce: string;
  uiVersion: string;
  productVersion: string;
}

export interface AideskLocalIpcAction {
  type: typeof AIDESK_LOCAL_IPC_MESSAGE.ACTION;
  protocolVersion: number;
  requestId: string;
  capability: string;
  expectedRevision: number;
  action: RemoteDesktopLocalAction;
  connectionId?: string;
}

export interface AideskLocalIpcRefresh {
  type: typeof AIDESK_LOCAL_IPC_MESSAGE.REFRESH;
  protocolVersion: number;
  requestId: string;
  capability: string;
}

export function encodeAideskLocalIpcFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length === 0 || payload.length > AIDESK_LOCAL_IPC.MAX_FRAME_BYTES) {
    throw new Error(AIDESK_LOCAL_IPC_ERROR.FRAME_TOO_LARGE);
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class AideskLocalIpcFrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > AIDESK_LOCAL_IPC.MAX_FRAME_BYTES) {
        throw new Error(AIDESK_LOCAL_IPC_ERROR.FRAME_TOO_LARGE);
      }
      if (this.buffer.length < length + 4) break;
      const encoded = this.buffer.subarray(4, length + 4).toString('utf8');
      this.buffer = this.buffer.subarray(length + 4);
      let parsed: unknown;
      try {
        parsed = JSON.parse(encoded);
      } catch {
        throw new Error(AIDESK_LOCAL_IPC_ERROR.INVALID_FRAME);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(AIDESK_LOCAL_IPC_ERROR.INVALID_FRAME);
      }
      frames.push(parsed);
    }
    return frames;
  }
}
