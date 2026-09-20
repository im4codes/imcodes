/**
 * Daemon-authoritative supervision heartbeat schedule projected to clients.
 *
 * The daemon sends a deadline only when the schedule changes. Browsers derive
 * the visible countdown locally, so this contract never creates per-second
 * daemon/server traffic.
 */

export const SUPERVISION_HEARTBEAT_STATE = {
  ARMED: 'armed',
  IDLE: 'idle',
  PAUSED_NEEDS_INPUT: 'paused_needs_input',
  OFF: 'off',
} as const;

export type SupervisionHeartbeatState =
  (typeof SUPERVISION_HEARTBEAT_STATE)[keyof typeof SUPERVISION_HEARTBEAT_STATE];

export const SUPERVISION_HEARTBEAT_KIND = {
  WAITING: 'waiting',
  AUDIT: 'audit',
  IMPLEMENTATION: 'implementation',
} as const;

export type SupervisionHeartbeatKind =
  (typeof SUPERVISION_HEARTBEAT_KIND)[keyof typeof SUPERVISION_HEARTBEAT_KIND];

/** One source for every heartbeat/wait glyph used by the toolbar and chat. */
export const SUPERVISION_HEARTBEAT_GLYPH = {
  ARMED: '❤️',
  IDLE: '•',
  NEEDS_INPUT: '⏸️',
  WAITING: '⏳',
} as const;

export interface SupervisionHeartbeatSnapshot {
  state: SupervisionHeartbeatState;
  kind?: SupervisionHeartbeatKind;
  /** Epoch milliseconds. Present only while `state === armed`. */
  nextHeartbeatAt?: number;
  /** Epoch milliseconds of the daemon projection that produced this value. */
  updatedAt: number;
}

const STATES = new Set<string>(Object.values(SUPERVISION_HEARTBEAT_STATE));
const KINDS = new Set<string>(Object.values(SUPERVISION_HEARTBEAT_KIND));

/** Fail-closed wire parser shared by daemon, server and browser. */
export function parseSupervisionHeartbeatSnapshot(value: unknown): SupervisionHeartbeatSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.state !== 'string' || !STATES.has(record.state)) return null;
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt) || record.updatedAt < 0) return null;
  const state = record.state as SupervisionHeartbeatState;
  const kind = typeof record.kind === 'string' && KINDS.has(record.kind)
    ? record.kind as SupervisionHeartbeatKind
    : undefined;
  const nextHeartbeatAt = typeof record.nextHeartbeatAt === 'number'
    && Number.isFinite(record.nextHeartbeatAt)
    && record.nextHeartbeatAt >= 0
    ? record.nextHeartbeatAt
    : undefined;
  if (state === SUPERVISION_HEARTBEAT_STATE.ARMED && (!kind || nextHeartbeatAt === undefined)) return null;
  return {
    state,
    ...(kind ? { kind } : {}),
    ...(state === SUPERVISION_HEARTBEAT_STATE.ARMED ? { nextHeartbeatAt } : {}),
    updatedAt: record.updatedAt,
  };
}
