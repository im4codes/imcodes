/**
 * Daemon status frames as browsers see them.
 *
 * Two producers reach the bridge: the daemon main thread sends a full
 * `daemon.stats` (system numbers, disks, embedding...), and the core-lane link
 * worker sends heartbeats that carry only event-loop liveness. The bridge
 * forwards the second kind as `daemon.liveness`, never as a `daemon.stats`
 * with every number missing -- a viewer that replaces its last stats with such
 * a frame shows NaN and "unknown" until the next full frame.
 *
 * Viewers merge frames onto the last full snapshot (see mergeDaemonStats), so
 * a partial or malformed frame can only ever add information.
 */
import { isCoreLaneStatus } from './core-lane-status.js';

export const DAEMON_STATS_MSG = 'daemon.stats' as const;
export const DAEMON_LIVENESS_MSG = 'daemon.liveness' as const;

/** System numbers a full stats frame always carries. */
export const DAEMON_STATS_NUMERIC_KEYS = ['cpu', 'memUsed', 'memTotal', 'load1', 'load5', 'load15', 'uptime'] as const;
export type DaemonStatsNumericKey = typeof DAEMON_STATS_NUMERIC_KEYS[number];

/** Event-loop liveness numbers, carried by heartbeats and full frames alike. */
export const DAEMON_LIVENESS_NUMERIC_KEYS = ['mainEventLoopLagMs', 'mainEventLoopBlockedMs'] as const;

/** A busy flag older than this is not shown: liveness arrives every few seconds. */
export const DAEMON_LIVENESS_FRESH_MS = 15_000;

export interface DaemonLivenessView {
  mainEventLoopLagMs?: number;
  mainEventLoopBlockedMs?: number;
  mainEventLoopBusy?: boolean;
  /** Browser clock time the liveness fields were last received. */
  mainEventLoopObservedAt?: number;
}

export interface DaemonStatsView extends DaemonLivenessView {
  daemonVersion?: string | null;
  latestDaemonVersion?: string | null;
  cpu?: number;
  memUsed?: number;
  memTotal?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  uptime?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isFiniteStat(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** True when a frame carries any system number, i.e. it is a stats frame rather than liveness only. */
export function hasAnyDaemonSystemStats(msg: Record<string, unknown>): boolean {
  return DAEMON_STATS_NUMERIC_KEYS.some((key) => msg[key] !== undefined);
}

/** True when a frame carries at least one core-lane liveness field. */
export function hasDaemonLiveness(msg: Record<string, unknown>): boolean {
  return isCoreLaneStatus(msg) && (
    msg.mainEventLoopLagMs !== undefined
    || msg.mainEventLoopBlockedMs !== undefined
    || msg.mainEventLoopBusy !== undefined
  );
}

/** The liveness fields of a frame, validated; empty when it carries none. */
export function pickDaemonLiveness(msg: Record<string, unknown>): DaemonLivenessView {
  const out: DaemonLivenessView = {};
  if (isFiniteStat(msg.mainEventLoopLagMs)) out.mainEventLoopLagMs = msg.mainEventLoopLagMs;
  if (isFiniteStat(msg.mainEventLoopBlockedMs)) out.mainEventLoopBlockedMs = msg.mainEventLoopBlockedMs;
  if (typeof msg.mainEventLoopBusy === 'boolean') out.mainEventLoopBusy = msg.mainEventLoopBusy;
  return out;
}

/** Whether the "main thread busy" hint should show right now. */
export function isDaemonMainLoopBusy(view: DaemonLivenessView | null | undefined, now: number = Date.now()): boolean {
  if (!view?.mainEventLoopBusy) return false;
  return view.mainEventLoopObservedAt === undefined
    || now - view.mainEventLoopObservedAt <= DAEMON_LIVENESS_FRESH_MS;
}

function mergeLiveness<S extends DaemonLivenessView>(next: S, frame: Record<string, unknown>, now: number): S {
  const liveness = pickDaemonLiveness(frame);
  if (Object.keys(liveness).length === 0) return next;
  // One heartbeat states the whole liveness picture: a frame that reports only
  // the flag must not keep an older lag figure next to it.
  return {
    ...next,
    mainEventLoopLagMs: undefined,
    mainEventLoopBlockedMs: undefined,
    mainEventLoopBusy: undefined,
    ...liveness,
    mainEventLoopObservedAt: now,
  };
}

/**
 * Fold a `daemon.stats` frame into the last snapshot.
 *
 * A frame carrying at least one finite system number is a real stats frame and
 * authoritative for the whole snapshot: an optional object it omits (or sends
 * malformed) means "none" -- the daemon reports shortRefHealth only while
 * persistence is failing, and a viewer must see that clear on recovery. Only a
 * number-less frame is degraded (an older server relaying a link-worker
 * heartbeat) and keeps the previous objects. Numbers replace only when finite,
 * so NaN or a missing value can never overwrite a good one.
 */
export function mergeDaemonStats<S extends DaemonStatsView>(
  previous: S | null,
  frame: Record<string, unknown>,
  now: number = Date.now(),
): S {
  let next: Record<string, unknown> = { ...(previous ?? {}) };
  for (const key of DAEMON_STATS_NUMERIC_KEYS) {
    if (isFiniteStat(frame[key])) next[key] = frame[key];
  }
  for (const key of ['daemonVersion', 'latestDaemonVersion'] as const) {
    const value = frame[key];
    if (typeof value === 'string' || value === null) next[key] = value;
  }
  if (DAEMON_STATS_NUMERIC_KEYS.some((key) => isFiniteStat(frame[key]))) {
    next.embedding = isRecord(frame.embedding) ? frame.embedding : null;
    next.disks = Array.isArray(frame.disks) ? frame.disks : null;
    next.shortRefHealth = isRecord(frame.shortRefHealth) ? frame.shortRefHealth : null;
    next.directConnectivity = isRecord(frame.directConnectivity) ? frame.directConnectivity : null;
  }
  next = mergeLiveness(next as DaemonLivenessView, frame, now) as Record<string, unknown>;
  return next as S;
}

/** Fold a `daemon.liveness` frame in: liveness (and version) only, nothing else. */
export function mergeDaemonLiveness<S extends DaemonStatsView>(
  previous: S | null,
  frame: Record<string, unknown>,
  now: number = Date.now(),
): S {
  const base: Record<string, unknown> = { ...(previous ?? {}) };
  if (typeof frame.daemonVersion === 'string') base.daemonVersion = frame.daemonVersion;
  return mergeLiveness(base as DaemonLivenessView, frame, now) as S;
}
