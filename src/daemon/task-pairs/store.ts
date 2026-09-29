/**
 * Durable store for marker-driven task pairs (`~/.imcodes/task-pairs.sqlite`).
 *
 * Deliberately separate from the legacy supervision registry so the legacy
 * engine can be removed without touching pair data. The full pair state is a
 * JSON column; the columns beside it exist only for lookups.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  TASK_PAIR_DEFAULT_MAX_CONCURRENCY,
  TASK_PAIR_PARTICIPANT_STATUSES,
  TASK_PAIR_TERMINAL_STATUSES,
  type TaskPairEngine,
  type TaskPairEventSource,
  type TaskPairRole,
  type TaskPairState,
  type TaskPairStatus,
  type TaskPairResourceClaim,
  type TaskPairResourceMode,
} from '../../../shared/task-pair.js';
import { assertNotRealImcodesPathInTests } from '../../util/test-home-guard.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

export const TASK_PAIRS_DB_PATH_ENV = 'IMCODES_TASK_PAIRS_DB_PATH' as const;
const TERMINAL_PAIR_RETENTION_MS = 30 * 24 * 60 * 60_000;
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60_000;

export function resolveTaskPairsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[TASK_PAIRS_DB_PATH_ENV]?.trim() || join(homedir(), '.imcodes', 'task-pairs.sqlite');
}

/** Per-side liveness bookkeeping kept beside the pure pair state. */
export interface TaskPairLiveness {
  silenceExecutor: number;
  silenceAuditor: number;
  /** Last progress (marker or final assistant output) per side, epoch ms. */
  progressExecutorAt: number;
  progressAuditorAt: number;
  /** Any visible participant activity (messages, tool calls, or markers). */
  activityExecutorAt?: number;
  activityAuditorAt?: number;
  /** Last time the fast both-idle check (scheduler.ts) sent a nudge; dedupes against the ordinary heartbeat tick's own check of the same idle spell. */
  bothIdleNudgedAt?: number;
  /** Durable Brain reminder state; survives daemon restart and retries while busy. */
  brainWaitKey?: string;
  brainWaitStartedAt?: number;
  brainReminderCount?: number;
  brainReminderLastAt?: number;
  brainReminderDue?: boolean;
  brainReminderResolvedAt?: number;
  brainLastActivityAt?: number;
  brainReminderLastDecisionAt?: number;
  brainReminderLastDecisionReason?: string;
  /** Last aggregate Brain heartbeat/reminder delivery for this Brain session. */
  brainGlobalLastDeliveryAt?: number;
  /** Last participant nudge shown in the task console. */
  lastNudgedAt?: number;
  lastTickAt: number;
  /** Escalations already sent, so each is sent once. */
  notified: string[];
  /** Last daemon-authored instruction delivered to each participant. */
  lastInstructionExecutor?: string;
  lastInstructionExecutorAt?: number;
  lastInstructionAuditor?: string;
  lastInstructionAuditorAt?: number;
  /** Participant recovery/stall state; all fields are durable for restart idempotency. */
  participantRecoveryAt?: number;
  participantRecoverySession?: string;
  participantRecoveryCount?: number;
  participantRecoveryAttempts?: number;
  participantRecoveryLastAt?: number;
  participantRecoveryEscalatedAt?: number;
  phase?: string;
  phaseStartedAt?: number;
  lastMaterialAt?: number;
  stageStallPromptAt?: number;
  stageStallEscalatedAt?: number;
}

export interface StoredTaskPair {
  project: string;
  state: TaskPairState;
  liveness: TaskPairLiveness;
  queueOrder: number;
  legacyTaskId?: string;
}

export interface TaskPairEventRecord {
  id: string;
  project: string;
  taskId: string;
  writer: string;
  role: TaskPairRole;
  verb: string;
  attrs: Record<string, string>;
  effect: string;
  unusual: boolean;
  source: TaskPairEventSource;
  fromStatus?: TaskPairStatus;
  toStatus?: TaskPairStatus;
  at: number;
}

export interface TaskPairProjectSettings {
  engine?: TaskPairEngine;
}

function emptyLiveness(now: number): TaskPairLiveness {
  return {
    silenceExecutor: 0,
    silenceAuditor: 0,
    progressExecutorAt: now,
    progressAuditorAt: now,
    activityExecutorAt: now,
    activityAuditorAt: now,
    lastTickAt: now,
    notified: [],
  };
}

export type TaskPairChangeListener = (project: string, taskId: string) => void;

export class TaskPairStore {
  readonly #db: DatabaseSyncInstance;
  readonly #listeners = new Set<TaskPairChangeListener>();

  /** Every pair write notifies listeners (badges, task console); a throwing listener is ignored. */
  onPairSaved(listener: TaskPairChangeListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  constructor(dbPath: string = resolveTaskPairsDbPath()) {
    assertNotRealImcodesPathInTests(dbPath, 'task-pairs.sqlite');
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS task_pairs (
        project TEXT NOT NULL,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        brain TEXT NOT NULL,
        executor TEXT,
        auditor TEXT,
        queue_order INTEGER NOT NULL DEFAULT 0,
        legacy_task_id TEXT,
        state_json TEXT NOT NULL,
        liveness_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project, task_id)
      );
      CREATE INDEX IF NOT EXISTS task_pairs_status_idx ON task_pairs (status);
      CREATE UNIQUE INDEX IF NOT EXISTS task_pairs_legacy_idx ON task_pairs (legacy_task_id) WHERE legacy_task_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS task_pair_events (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        task_id TEXT NOT NULL,
        writer TEXT NOT NULL,
        role TEXT NOT NULL,
        verb TEXT NOT NULL,
        attrs_json TEXT NOT NULL,
        effect TEXT NOT NULL,
        unusual INTEGER NOT NULL,
        source TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_pair_events_task_idx ON task_pair_events (project, task_id, at);
      CREATE TABLE IF NOT EXISTS task_pair_queue_settings (
        brain TEXT PRIMARY KEY,
        max_concurrency INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_pair_project_settings (
        project TEXT PRIMARY KEY,
        engine TEXT,
        allowlist_json TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_pair_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_pair_resource_claims (
        claim_id TEXT PRIMARY KEY, project TEXT NOT NULL, task_id TEXT NOT NULL, owner TEXT NOT NULL, resource TEXT NOT NULL, mode TEXT NOT NULL, claimed_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, released_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS task_pair_resource_active_idx ON task_pair_resource_claims (resource, expires_at, released_at);
    `);
  }

  close(): void {
    this.#db.close();
  }

  listActiveResourceClaims(now = Date.now()): TaskPairResourceClaim[] {
    this.#db.prepare('DELETE FROM task_pair_resource_claims WHERE released_at IS NOT NULL OR expires_at <= ?').run(now);
    const rows = this.#db.prepare('SELECT * FROM task_pair_resource_claims WHERE released_at IS NULL AND expires_at > ? ORDER BY claimed_at').all(now) as Array<Record<string, unknown>>;
    return rows.map(resourceClaimFromRow);
  }
  listResourceClaimsForPair(project: string, taskId: string, now = Date.now()): TaskPairResourceClaim[] {
    return this.listActiveResourceClaims(now).filter((claim) => claim.project === project && claim.taskId === taskId);
  }
  tryClaimResource(input: { project: string; taskId: string; owner: string; resource: string; mode: TaskPairResourceMode; ttlMs: number; now?: number }): { ok: true; claim: TaskPairResourceClaim } | { ok: false; conflict: TaskPairResourceClaim } {
    const now = input.now ?? Date.now(); const resource = input.resource.trim();
    const active = this.listActiveResourceClaims(now);
    const existing = active.find((claim) => claim.resource === resource && !(claim.project === input.project && claim.taskId === input.taskId && claim.owner === input.owner));
    if (existing && (existing.mode === 'exclusive' || input.mode === 'exclusive')) return { ok: false, conflict: existing };
    const same = active.find((claim) => claim.resource === resource && claim.project === input.project && claim.taskId === input.taskId && claim.owner === input.owner);
    const claim = same ? { ...same, renewedAt: now, expiresAt: now + input.ttlMs } : { claimId: input.project + ':' + input.taskId + ':' + resource + ':' + input.owner, project: input.project, taskId: input.taskId, owner: input.owner, resource, mode: input.mode, claimedAt: now, renewedAt: now, expiresAt: now + input.ttlMs };
    this.#db.prepare('INSERT INTO task_pair_resource_claims (claim_id, project, task_id, owner, resource, mode, claimed_at, renewed_at, expires_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(claim_id) DO UPDATE SET renewed_at=excluded.renewed_at, expires_at=excluded.expires_at, released_at=NULL').run(claim.claimId, claim.project, claim.taskId, claim.owner, claim.resource, claim.mode, claim.claimedAt, claim.renewedAt, claim.expiresAt);
    return { ok: true, claim };
  }
  releaseResourceClaims(project: string, taskId: string, now = Date.now()): TaskPairResourceClaim[] {
    const claims = this.listResourceClaimsForPair(project, taskId, now);
    this.#db.prepare('UPDATE task_pair_resource_claims SET released_at = ? WHERE project = ? AND task_id = ? AND released_at IS NULL').run(now, project, taskId);
    return claims;
  }

  getPair(project: string, taskId: string): StoredTaskPair | undefined {
    const row = this.#db.prepare('SELECT * FROM task_pairs WHERE project = ? AND task_id = ?').get(project, taskId) as Record<string, unknown> | undefined;
    return row ? rowToPair(row) : undefined;
  }

  /** Pairs with this task id in any project (a worktree's metadata names only the task). */
  findPairsByTaskId(taskId: string): StoredTaskPair[] {
    const rows = this.#db.prepare('SELECT * FROM task_pairs WHERE task_id = ?').all(taskId) as Array<Record<string, unknown>>;
    return rows.map(rowToPair);
  }

  getPairByLegacyTaskId(legacyTaskId: string): StoredTaskPair | undefined {
    const row = this.#db.prepare('SELECT * FROM task_pairs WHERE legacy_task_id = ?').get(legacyTaskId) as Record<string, unknown> | undefined;
    return row ? rowToPair(row) : undefined;
  }

  /** Non-terminal pairs, optionally for one project. */
  listActivePairs(project?: string): StoredTaskPair[] {
    const terminal = TASK_PAIR_TERMINAL_STATUSES.map(() => '?').join(',');
    const sql = project
      ? `SELECT * FROM task_pairs WHERE status NOT IN (${terminal}) AND project = ? ORDER BY queue_order, updated_at`
      : `SELECT * FROM task_pairs WHERE status NOT IN (${terminal}) ORDER BY queue_order, updated_at`;
    const rows = (project
      ? this.#db.prepare(sql).all(...TASK_PAIR_TERMINAL_STATUSES, project)
      : this.#db.prepare(sql).all(...TASK_PAIR_TERMINAL_STATUSES)) as Array<Record<string, unknown>>;
    return rows.map(rowToPair);
  }

  /** Every pair of a project, newest first (for the console). */
  listPairs(project: string, limit = 200): StoredTaskPair[] {
    const rows = this.#db.prepare('SELECT * FROM task_pairs WHERE project = ? ORDER BY updated_at DESC LIMIT ?').all(project, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToPair);
  }

  /** All pairs owned by one Brain, optionally including terminal history. */
  listPairsForBrain(brain: string, project?: string, includeFinished = false, limit = 500): StoredTaskPair[] {
    const terminal = TASK_PAIR_TERMINAL_STATUSES.map(() => '?').join(',');
    const filters = includeFinished ? 'brain = ?' : `brain = ? AND status NOT IN (${terminal})`;
    const values = includeFinished
      ? [brain, limit]
      : [brain, ...TASK_PAIR_TERMINAL_STATUSES, limit];
    const sql = project
      ? `SELECT * FROM task_pairs WHERE ${filters} AND project = ? ORDER BY CASE WHEN status = 'queued' THEN 0 ELSE 1 END, queue_order, updated_at DESC LIMIT ?`
      : `SELECT * FROM task_pairs WHERE ${filters} ORDER BY CASE WHEN status = 'queued' THEN 0 ELSE 1 END, queue_order, updated_at DESC LIMIT ?`;
    const queryValues = project
      ? (includeFinished ? [brain, project, limit] : [brain, ...TASK_PAIR_TERMINAL_STATUSES, project, limit])
      : values;
    const rows = this.#db.prepare(sql).all(...queryValues) as Array<Record<string, unknown>>;
    return rows.map(rowToPair);
  }

  /** Ended pairs whose workspace still exists (ended or kept): the workspace sweep's input. */
  listEndedWorkspacePairs(): StoredTaskPair[] {
    const terminal = TASK_PAIR_TERMINAL_STATUSES.map(() => '?').join(',');
    const rows = this.#db.prepare(
      `SELECT * FROM task_pairs WHERE status IN (${terminal}) AND json_extract(state_json, '$.workspace.status') IN ('ended', 'kept')`,
    ).all(...TASK_PAIR_TERMINAL_STATUSES) as Array<Record<string, unknown>>;
    return rows.map(rowToPair);
  }

  /** Non-terminal pairs in which a session takes part. */
  pairsForSession(sessionName: string): StoredTaskPair[] {
    return this.listActivePairs().filter((pair) => (
      pair.state.executor === sessionName || pair.state.auditor === sessionName || pair.state.brain === sessionName
    ));
  }

  /** True when a session is reserved by an actively started pair. Queued
   * work is deliberately not a reservation: it is only a scheduling intent
   * and must not block dispatch or REASSIGN of another pair. */
  isParticipantOfOpenPair(sessionName: string, exceptTaskId?: string): boolean {
    return this.listActivePairs().some((pair) => (
      pair.state.taskId !== exceptTaskId
      && TASK_PAIR_PARTICIPANT_STATUSES.includes(pair.state.status)
      && (pair.state.executor === sessionName || pair.state.auditor === sessionName)
    ));
  }

  savePair(project: string, state: TaskPairState, options: { liveness?: TaskPairLiveness; legacyTaskId?: string } = {}): StoredTaskPair {
    const existing = this.getPair(project, state.taskId);
    const liveness = options.liveness ?? existing?.liveness ?? emptyLiveness(state.updatedAt);
    const queueOrder = existing?.queueOrder ?? this.#nextQueueOrder();
    const legacyTaskId = options.legacyTaskId ?? existing?.legacyTaskId;
    this.#db.prepare(`
      INSERT INTO task_pairs (project, task_id, status, brain, executor, auditor, queue_order, legacy_task_id, state_json, liveness_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project, task_id) DO UPDATE SET
        status = excluded.status, brain = excluded.brain, executor = excluded.executor, auditor = excluded.auditor,
        legacy_task_id = excluded.legacy_task_id, state_json = excluded.state_json,
        liveness_json = excluded.liveness_json, updated_at = excluded.updated_at
    `).run(
      project, state.taskId, state.status, state.brain, state.executor ?? null, state.auditor ?? null,
      queueOrder, legacyTaskId ?? null, JSON.stringify(state), JSON.stringify(liveness), state.updatedAt,
    );
    for (const listener of this.#listeners) {
      try { listener(project, state.taskId); } catch { /* observers never break a write */ }
    }
    return { project, state, liveness, queueOrder, ...(legacyTaskId ? { legacyTaskId } : {}) };
  }

  saveLiveness(project: string, taskId: string, liveness: TaskPairLiveness): void {
    this.#db.prepare('UPDATE task_pairs SET liveness_json = ? WHERE project = ? AND task_id = ?')
      .run(JSON.stringify(liveness), project, taskId);
  }

  #nextQueueOrder(): number {
    const row = this.#db.prepare('SELECT COALESCE(MAX(queue_order), 0) + 1 AS next FROM task_pairs').get() as { next: number };
    return Number(row.next);
  }

  /** Insert an event once; returns false when this id was already recorded (replayed turn). */
  recordEvent(event: TaskPairEventRecord): boolean {
    const result = this.#db.prepare(`
      INSERT OR IGNORE INTO task_pair_events (id, project, task_id, writer, role, verb, attrs_json, effect, unusual, source, from_status, to_status, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.project, event.taskId, event.writer, event.role, event.verb, JSON.stringify(event.attrs),
      event.effect, event.unusual ? 1 : 0, event.source, event.fromStatus ?? null, event.toStatus ?? null, event.at,
    );
    return Number(result.changes) > 0;
  }

  hasEvent(id: string): boolean {
    return !!this.#db.prepare('SELECT 1 FROM task_pair_events WHERE id = ?').get(id);
  }

  listEvents(project: string, taskId: string, limit = 100): TaskPairEventRecord[] {
    const rows = this.#db.prepare('SELECT * FROM task_pair_events WHERE project = ? AND task_id = ? ORDER BY at DESC LIMIT ?')
      .all(project, taskId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      project: String(row.project),
      taskId: String(row.task_id),
      writer: String(row.writer),
      role: String(row.role) as TaskPairRole,
      verb: String(row.verb),
      attrs: JSON.parse(String(row.attrs_json)) as Record<string, string>,
      effect: String(row.effect),
      unusual: Number(row.unusual) === 1,
      source: String(row.source) as TaskPairEventSource,
      ...(row.from_status ? { fromStatus: String(row.from_status) as TaskPairStatus } : {}),
      ...(row.to_status ? { toStatus: String(row.to_status) as TaskPairStatus } : {}),
      at: Number(row.at),
    }));
  }

  getMaxConcurrency(brain: string): number {
    const row = this.#db.prepare('SELECT max_concurrency FROM task_pair_queue_settings WHERE brain = ?').get(brain) as { max_concurrency: number } | undefined;
    return row ? Number(row.max_concurrency) : TASK_PAIR_DEFAULT_MAX_CONCURRENCY;
  }

  setMaxConcurrency(brain: string, max: number): void {
    this.#db.prepare(`
      INSERT INTO task_pair_queue_settings (brain, max_concurrency) VALUES (?, ?)
      ON CONFLICT (brain) DO UPDATE SET max_concurrency = excluded.max_concurrency
    `).run(brain, Math.max(1, Math.floor(max)));
  }

  getProjectSettings(project: string): TaskPairProjectSettings {
    const row = this.#db.prepare('SELECT engine FROM task_pair_project_settings WHERE project = ?').get(project) as
      { engine: string | null } | undefined;
    const engine = row?.engine === 'pairs' || row?.engine === 'legacy' ? row.engine : undefined;
    return { ...(engine ? { engine } : {}) };
  }

  setProjectEngine(project: string, engine: TaskPairEngine, now = Date.now()): void {
    this.#db.prepare(`
      INSERT INTO task_pair_project_settings (project, engine, allowlist_json, updated_at) VALUES (?, ?, NULL, ?)
      ON CONFLICT (project) DO UPDATE SET engine = excluded.engine, updated_at = excluded.updated_at
    `).run(project, engine, now);
  }

  getMeta(key: string): string | undefined {
    const row = this.#db.prepare('SELECT value FROM task_pair_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare('INSERT INTO task_pair_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Drop terminal pairs older than 30 days and events older than 90 days. */
  prune(now = Date.now()): void {
    const terminal = TASK_PAIR_TERMINAL_STATUSES.map(() => '?').join(',');
    this.#db.prepare(`DELETE FROM task_pairs WHERE status IN (${terminal}) AND updated_at < ?`)
      .run(...TASK_PAIR_TERMINAL_STATUSES, now - TERMINAL_PAIR_RETENTION_MS);
    this.#db.prepare('DELETE FROM task_pair_events WHERE at < ?').run(now - EVENT_RETENTION_MS);
  }
}

function rowToPair(row: Record<string, unknown>): StoredTaskPair {
  const raw = JSON.parse(String(row.liveness_json)) as Partial<TaskPairLiveness>;
  const progressExecutorAt = Number(raw.progressExecutorAt ?? 0);
  const progressAuditorAt = Number(raw.progressAuditorAt ?? 0);
  const liveness: TaskPairLiveness = {
    silenceExecutor: Number(raw.silenceExecutor ?? 0),
    silenceAuditor: Number(raw.silenceAuditor ?? 0),
    progressExecutorAt,
    progressAuditorAt,
    activityExecutorAt: Number(raw.activityExecutorAt ?? progressExecutorAt),
    activityAuditorAt: Number(raw.activityAuditorAt ?? progressAuditorAt),
    ...(Number.isFinite(Number(raw.bothIdleNudgedAt)) ? { bothIdleNudgedAt: Number(raw.bothIdleNudgedAt) } : {}),
    ...(typeof raw.brainWaitKey === 'string' ? { brainWaitKey: raw.brainWaitKey } : {}),
    ...(Number.isFinite(Number(raw.brainWaitStartedAt)) ? { brainWaitStartedAt: Number(raw.brainWaitStartedAt) } : {}),
    ...(Number.isFinite(Number(raw.brainReminderCount)) ? { brainReminderCount: Number(raw.brainReminderCount) } : {}),
    ...(Number.isFinite(Number(raw.brainReminderLastAt)) ? { brainReminderLastAt: Number(raw.brainReminderLastAt) } : {}),
    ...(raw.brainReminderDue === true ? { brainReminderDue: true } : {}),
    ...(Number.isFinite(Number(raw.brainReminderResolvedAt)) ? { brainReminderResolvedAt: Number(raw.brainReminderResolvedAt) } : {}),
    ...(Number.isFinite(Number(raw.brainLastActivityAt)) ? { brainLastActivityAt: Number(raw.brainLastActivityAt) } : {}),
    ...(Number.isFinite(Number(raw.brainReminderLastDecisionAt)) ? { brainReminderLastDecisionAt: Number(raw.brainReminderLastDecisionAt) } : {}),
    ...(typeof raw.brainReminderLastDecisionReason === 'string' ? { brainReminderLastDecisionReason: raw.brainReminderLastDecisionReason } : {}),
    ...(Number.isFinite(Number(raw.brainGlobalLastDeliveryAt)) ? { brainGlobalLastDeliveryAt: Number(raw.brainGlobalLastDeliveryAt) } : {}),
    ...(Number.isFinite(Number(raw.lastNudgedAt)) ? { lastNudgedAt: Number(raw.lastNudgedAt) } : {}),
    lastTickAt: Number(raw.lastTickAt ?? 0),
    notified: Array.isArray(raw.notified) ? raw.notified.map(String) : [],
    ...(typeof raw.lastInstructionExecutor === 'string' ? { lastInstructionExecutor: raw.lastInstructionExecutor } : {}),
    ...(Number.isFinite(Number(raw.lastInstructionExecutorAt)) ? { lastInstructionExecutorAt: Number(raw.lastInstructionExecutorAt) } : {}),
    ...(typeof raw.lastInstructionAuditor === 'string' ? { lastInstructionAuditor: raw.lastInstructionAuditor } : {}),
    ...(Number.isFinite(Number(raw.lastInstructionAuditorAt)) ? { lastInstructionAuditorAt: Number(raw.lastInstructionAuditorAt) } : {}),
    ...(Number.isFinite(Number(raw.participantRecoveryAt)) ? { participantRecoveryAt: Number(raw.participantRecoveryAt) } : {}),
    ...(typeof raw.participantRecoverySession === 'string' ? { participantRecoverySession: raw.participantRecoverySession } : {}),
    ...(Number.isFinite(Number(raw.participantRecoveryCount)) ? { participantRecoveryCount: Number(raw.participantRecoveryCount) } : {}),
    ...(Number.isFinite(Number(raw.participantRecoveryAttempts)) ? { participantRecoveryAttempts: Number(raw.participantRecoveryAttempts) } : {}),
    ...(Number.isFinite(Number(raw.participantRecoveryLastAt)) ? { participantRecoveryLastAt: Number(raw.participantRecoveryLastAt) } : {}),
    ...(Number.isFinite(Number(raw.participantRecoveryEscalatedAt)) ? { participantRecoveryEscalatedAt: Number(raw.participantRecoveryEscalatedAt) } : {}),
    ...(typeof raw.phase === 'string' ? { phase: raw.phase } : {}),
    ...(Number.isFinite(Number(raw.phaseStartedAt)) ? { phaseStartedAt: Number(raw.phaseStartedAt) } : {}),
    ...(Number.isFinite(Number(raw.lastMaterialAt)) ? { lastMaterialAt: Number(raw.lastMaterialAt) } : {}),
    ...(Number.isFinite(Number(raw.stageStallPromptAt)) ? { stageStallPromptAt: Number(raw.stageStallPromptAt) } : {}),
    ...(Number.isFinite(Number(raw.stageStallEscalatedAt)) ? { stageStallEscalatedAt: Number(raw.stageStallEscalatedAt) } : {}),
  };
  return {
    project: String(row.project),
    state: JSON.parse(String(row.state_json)) as TaskPairState,
    liveness,
    queueOrder: Number(row.queue_order),
    ...(row.legacy_task_id ? { legacyTaskId: String(row.legacy_task_id) } : {}),
  };
}

function resourceClaimFromRow(row: Record<string, unknown>): TaskPairResourceClaim {
  return { claimId: String(row.claim_id), project: String(row.project), taskId: String(row.task_id), owner: String(row.owner), resource: String(row.resource), mode: String(row.mode) as TaskPairResourceMode, claimedAt: Number(row.claimed_at), renewedAt: Number(row.renewed_at), expiresAt: Number(row.expires_at) };
}

let singleton: TaskPairStore | undefined;

export function getTaskPairStore(): TaskPairStore {
  singleton ??= new TaskPairStore();
  return singleton;
}

export function setTaskPairStoreForTests(store: TaskPairStore | undefined): void {
  singleton?.close?.();
  singleton = store;
}
