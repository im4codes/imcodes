import {
  SUPERVISION_HEARTBEAT_STATE,
  parseSupervisionHeartbeatSnapshot,
  type SupervisionHeartbeatSnapshot,
} from '../../shared/supervision-heartbeat.js';

type ProjectionListener = (sessionName: string, snapshot: SupervisionHeartbeatSnapshot) => void;

export const SUPERVISION_HEARTBEAT_PROJECTION_SOURCE = {
  AUTOMATION: 'automation',
  ASSIGNMENT: 'assignment',
  /** Marker-driven task pairs: the pair heartbeat of an executor or auditor. */
  PAIR: 'pair',
} as const;
type ProjectionSource = (typeof SUPERVISION_HEARTBEAT_PROJECTION_SOURCE)[keyof typeof SUPERVISION_HEARTBEAT_PROJECTION_SOURCE];

const snapshots = new Map<string, SupervisionHeartbeatSnapshot>();
const sourceSnapshots = new Map<string, Map<ProjectionSource, SupervisionHeartbeatSnapshot>>();
let listener: ProjectionListener | null = null;

function semanticallyEqual(
  left: SupervisionHeartbeatSnapshot | undefined,
  right: SupervisionHeartbeatSnapshot | undefined,
): boolean {
  return left?.state === right?.state
    && left?.kind === right?.kind
    && left?.nextHeartbeatAt === right?.nextHeartbeatAt;
}

function resolveProjection(
  values: Iterable<SupervisionHeartbeatSnapshot>,
): SupervisionHeartbeatSnapshot | undefined {
  const all = [...values];
  const paused = all.find((snapshot) => snapshot.state === SUPERVISION_HEARTBEAT_STATE.PAUSED_NEEDS_INPUT);
  if (paused) return paused;
  const armed = all
    .filter((snapshot) => snapshot.state === SUPERVISION_HEARTBEAT_STATE.ARMED)
    .sort((left, right) => (left.nextHeartbeatAt ?? Infinity) - (right.nextHeartbeatAt ?? Infinity))[0];
  if (armed) return armed;
  return all.find((snapshot) => snapshot.state === SUPERVISION_HEARTBEAT_STATE.IDLE)
    ?? all.find((snapshot) => snapshot.state === SUPERVISION_HEARTBEAT_STATE.OFF);
}

export function getSupervisionHeartbeatProjection(
  sessionName: string,
): SupervisionHeartbeatSnapshot | undefined {
  return snapshots.get(sessionName);
}

/** Rebase daemon time whenever a snapshot is replayed after reconnect. */
export function getSupervisionHeartbeatProjectionForWire(
  sessionName: string,
  now = Date.now(),
): SupervisionHeartbeatSnapshot | undefined {
  const snapshot = snapshots.get(sessionName);
  return snapshot ? { ...snapshot, updatedAt: now } : undefined;
}

export function setSupervisionHeartbeatProjectionListener(next: ProjectionListener | null): void {
  listener = next;
}

/**
 * Store and publish only semantic schedule changes. `updatedAt` is metadata,
 * not a reason to rebroadcast an otherwise identical projection.
 */
export function setSupervisionHeartbeatProjection(
  sessionName: string,
  input: SupervisionHeartbeatSnapshot,
  source: ProjectionSource = SUPERVISION_HEARTBEAT_PROJECTION_SOURCE.AUTOMATION,
): boolean {
  const snapshot = parseSupervisionHeartbeatSnapshot(input);
  if (!sessionName.trim() || !snapshot) return false;
  const sources = sourceSnapshots.get(sessionName) ?? new Map<ProjectionSource, SupervisionHeartbeatSnapshot>();
  if (semanticallyEqual(sources.get(source), snapshot)) return false;
  sources.set(source, snapshot);
  sourceSnapshots.set(sessionName, sources);
  const previous = snapshots.get(sessionName);
  const selected = resolveProjection(sources.values());
  const resolved = selected ? { ...selected, updatedAt: snapshot.updatedAt } : undefined;
  if (!resolved || semanticallyEqual(previous, resolved)) return false;
  snapshots.set(sessionName, resolved);
  listener?.(sessionName, resolved);
  return true;
}

export function clearSupervisionHeartbeatProjectionSource(
  sessionName: string,
  source: ProjectionSource,
): boolean {
  const sources = sourceSnapshots.get(sessionName);
  if (!sources?.delete(source)) return false;
  if (sources.size === 0) sourceSnapshots.delete(sessionName);
  const previous = snapshots.get(sessionName);
  const selected = resolveProjection(sources.values());
  const resolved = selected
    ? { ...selected, updatedAt: Date.now() }
    : { state: SUPERVISION_HEARTBEAT_STATE.OFF, updatedAt: Date.now() };
  if (semanticallyEqual(previous, resolved)) return false;
  snapshots.set(sessionName, resolved);
  listener?.(sessionName, resolved);
  return true;
}

export function clearSupervisionHeartbeatProjectionsForTests(): void {
  snapshots.clear();
  sourceSnapshots.clear();
  listener = null;
}
