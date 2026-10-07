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
import {
  TASK_PAIR_BRAIN_NOTICE_STATUSES,
  TASK_PAIR_DEFAULT_MAX_CONCURRENCY,
  TASK_PAIR_PARTICIPANT_STATUSES,
  TASK_PAIR_TERMINAL_STATUSES,
  type TaskPairBrainNoticeStatus,
  type TaskPairEngine,
  type TaskPairEventSource,
  type TaskPairRole,
  type TaskPairState,
  type TaskPairStatus,
  type TaskPairResourceClaim,
  type TaskPairResourceMode,
} from '../../../shared/task-pair.js';
import { assertNotRealImcodesPathInTests } from '../../util/test-home-guard.js';
import { imcodesStateDir } from '../../util/imcodes-state-dir.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

export const TASK_PAIRS_DB_PATH_ENV = 'IMCODES_TASK_PAIRS_DB_PATH' as const;
const TERMINAL_PAIR_RETENTION_MS = 30 * 24 * 60 * 60_000;
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60_000;

export function resolveTaskPairsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[TASK_PAIRS_DB_PATH_ENV]?.trim() || join(imcodesStateDir(env), 'task-pairs.sqlite');
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
  /** Number of both-idle fast nudges in the current idle spell.  This durable
   * watermark survives an activity timestamp rewrite/race, so a fast poll
   * cannot reopen the same spell every threshold interval. */
  bothIdleNudgeCount?: number;
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
  /** Outcome of the last daemon notice addressed to Brain for this pair (what the pair card shows). */
  brainNoticeStatus?: TaskPairBrainNoticeStatus;
  brainNoticeAt?: number;
  brainNoticeReason?: string;
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
  /** Runtime/restart identity for the last recovery state message delivered. */
  participantRecoveryRestartId?: string;
  /** Last healthy runtime epoch observed for each participant. */
  participantObservedExecutorEpoch?: string;
  participantObservedAuditorEpoch?: string;
  participantObservedExecutorSession?: string;
  participantObservedAuditorSession?: string;
  /** Restart handoff watermark per participant (manual/external restarts too). */
  participantRecoveryExecutorRestartId?: string;
  participantRecoveryAuditorRestartId?: string;
  /** Executor-silence escalation watermark and reminder backoff. */
  executorEscalationAt?: number;
  executorEscalationReminderCount?: number;
  executorEscalationLastAt?: number;
  phase?: string;
  phaseStartedAt?: number;
  lastMaterialAt?: number;
  stageStallPromptAt?: number;
  stageStallEscalatedAt?: number;
  /**
   * Unintegrated-DONE reminders (integration-drift.ts), durable so a restart neither repeats a burst nor restarts the grace.
   * `integrationKey` names what they concern (`<head>@<ended at>`): a different head or a reopened-and-finished-again pair starts over.
   */
  integrationKey?: string;
  integrationReminderCount?: number;
  integrationReminderLastAt?: number;
  /** The head was found integrated (ancestor or patch-equivalent) at this time: nothing more to remind or check. */
  integrationIntegratedAt?: number;
  /** Bounded retry state for a workspace-kept/unreadable notice. */
  workspaceKeptReminderKey?: string;
  workspaceKeptReminderCount?: number;
  workspaceKeptReminderLastAt?: number;
  workspaceKeptReminderDeliveredAt?: number;
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

/**
 * Liveness fields that only record "something happened at time T". A liveness
 * update that changes nothing else is an activity stamp: it is kept in memory
 * on every event and written to SQLite at most once per interval.
 */
const LIVENESS_ACTIVITY_TIMESTAMP_KEYS: ReadonlySet<string> = new Set([
  'lastMaterialAt', 'activityExecutorAt', 'activityAuditorAt', 'progressExecutorAt', 'progressAuditorAt',
  'brainLastActivityAt', 'brainReminderResolvedAt',
]);

/** Default minimum spacing of SQLite writes for a pure activity stamp of one pair. */
export const TASK_PAIR_LIVENESS_ACTIVITY_WRITE_INTERVAL_MS = 5_000;

/** True when `next` differs from `prev` in anything other than an activity timestamp. */
export function livenessChangedBeyondActivityTimestamps(prev: TaskPairLiveness, next: TaskPairLiveness): boolean {
  const before = prev as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (LIVENESS_ACTIVITY_TIMESTAMP_KEYS.has(key)) continue;
    const a = before[key];
    const b = after[key];
    if (a === b) continue;
    if (JSON.stringify(a) !== JSON.stringify(b)) return true;
  }
  return false;
}

interface ActivePairIndex {
  byKey: Map<string, StoredTaskPair>;
  bySession: Map<string, StoredTaskPair[]>;
  /** Every non-terminal pair in `listActivePairs` order (queue_order, updated_at). */
  ordered: StoredTaskPair[];
}

const compareActivePairs = (a: StoredTaskPair, b: StoredTaskPair): number => (
  a.queueOrder - b.queueOrder || a.state.updatedAt - b.state.updatedAt
);

let freezeSharedPairsForTests = false;
/** Tests: deep-freeze what the shared index hands out, so an accidental in-place mutation by a reader throws. */
export function setTaskPairSharedFreezeForTests(enabled: boolean): void {
  freezeSharedPairsForTests = enabled;
}
function freezeShared(pair: StoredTaskPair): StoredTaskPair {
  if (!freezeSharedPairsForTests) return pair;
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) freeze(inner);
  };
  freeze(pair.state);
  freeze(pair.liveness);
  return pair;
}

function participantsOf(pair: StoredTaskPair): string[] {
  return [...new Set([pair.state.executor, pair.state.auditor, pair.state.brain])].filter((session): session is string => !!session);
}

function pairKey(project: string, taskId: string): string {
  return `${project}\u0000${taskId}`;
}

export class TaskPairStore {
  readonly #db: DatabaseSyncInstance;
  readonly #listeners = new Set<TaskPairChangeListener>();
  /**
   * The non-terminal pairs by session, kept in memory so the per-timeline-event
   * paths (which run for every streamed delta and tool event of every session)
   * never query SQLite or parse JSON. Every write path of this class either
   * invalidates it (savePair, prune) or patches the cached liveness in place
   * (saveLiveness), so it cannot outlive the row it mirrors.
   */
  #activeIndex: ActivePairIndex | undefined;
  readonly #livenessDbWriteAt = new Map<string, number>();
  /**
   * Activity stamps not yet written: the newest liveness of each pair whose
   * last stamp was deferred. Every read overlays it, so a reader (or a state
   * change that re-reads the pair) never sees an older stamp than memory has;
   * a timer flushes it within one interval, and close()/flushPendingLiveness()
   * flush it on shutdown. A crash loses at most the stamps of one interval.
   */
  readonly #pendingLiveness = new Map<string, TaskPairLiveness>();
  #livenessFlushTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #projectSettingsCache = new Map<string, TaskPairProjectSettings>();

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
    try { this.flushPendingLiveness(); } catch { /* the database may already be gone */ }
    if (this.#livenessFlushTimer) clearTimeout(this.#livenessFlushTimer);
    this.#livenessFlushTimer = undefined;
    this.#activeIndex = undefined;
    this.#livenessDbWriteAt.clear();
    this.#pendingLiveness.clear();
    this.#db.close();
  }

  /** Writes every deferred activity stamp now (shutdown, or before something reads the file directly). */
  flushPendingLiveness(): number {
    if (this.#livenessFlushTimer) clearTimeout(this.#livenessFlushTimer);
    this.#livenessFlushTimer = undefined;
    let written = 0;
    for (const [key, liveness] of [...this.#pendingLiveness]) {
      const [project, taskId] = key.split('\u0000');
      this.saveLiveness(project!, taskId!, liveness);
      written += 1;
    }
    return written;
  }

  #scheduleLivenessFlush(minIntervalMs: number): void {
    if (this.#livenessFlushTimer || this.#pendingLiveness.size === 0) return;
    const now = Date.now();
    let due = Infinity;
    for (const key of this.#pendingLiveness.keys()) {
      due = Math.min(due, (this.#livenessDbWriteAt.get(key) ?? 0) + minIntervalMs);
    }
    const timer = setTimeout(() => {
      this.#livenessFlushTimer = undefined;
      try { this.flushPendingLiveness(); } catch { /* closed database: nothing left to write */ }
    }, Math.max(50, due - now));
    timer.unref?.();
    this.#livenessFlushTimer = timer;
  }

  /** A pair as read from its row, carrying the newest deferred activity stamp. */
  #hydrate(row: Record<string, unknown>): StoredTaskPair {
    const pair = rowToPair(row);
    const pending = this.#pendingLiveness.get(pairKey(pair.project, pair.state.taskId));
    return pending ? { ...pair, liveness: pending } : pair;
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
    return row ? this.#hydrate(row) : undefined;
  }

  /** Pairs with this task id in any project (a worktree's metadata names only the task). */
  findPairsByTaskId(taskId: string): StoredTaskPair[] {
    const rows = this.#db.prepare('SELECT * FROM task_pairs WHERE task_id = ?').all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.#hydrate(row));
  }

  getPairByLegacyTaskId(legacyTaskId: string): StoredTaskPair | undefined {
    const row = this.#db.prepare('SELECT * FROM task_pairs WHERE legacy_task_id = ?').get(legacyTaskId) as Record<string, unknown> | undefined;
    return row ? this.#hydrate(row) : undefined;
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
    return rows.map((row) => this.#hydrate(row));
  }

  /**
   * The console window of a project: at most `limit` pairs, open pairs first
   * and then the most recently finished ones, returned newest first. A plain
   * recency `LIMIT` let a long-quiet working pair fall out of the window behind
   * a long history of finished pairs, so the console silently omitted live work.
   */
  #windowQuery(columns: string): string {
    const terminal = TASK_PAIR_TERMINAL_STATUSES.map((status) => `'${status}'`).join(',');
    return `SELECT ${columns} FROM task_pairs WHERE project = ? AND task_id IN (`
      + `SELECT task_id FROM task_pairs WHERE project = ? ORDER BY (status IN (${terminal})) ASC, updated_at DESC LIMIT ?) `
      + 'ORDER BY updated_at DESC';
  }

  /** The console window of a project (see {@link #windowQuery}), newest first. */
  listPairs(project: string, limit = 200): StoredTaskPair[] {
    const rows = this.#db.prepare(this.#windowQuery('*')).all(project, project, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.#hydrate(row));
  }

  /**
   * Task ids of the pairs `listPairs` would return, in the same order, without
   * parsing any pair JSON (the console delta path only needs set membership).
   */
  listPairWindowIds(project: string, limit = 200): string[] {
    const rows = this.#db.prepare(this.#windowQuery('task_id')).all(project, project, limit) as Array<{ task_id: string }>;
    return rows.map((row) => String(row.task_id));
  }

  /** How many pairs the store holds for a project, any status (one indexed count, no JSON parsing). */
  countPairs(project: string): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM task_pairs WHERE project = ?').get(project) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Queued pairs of a project (few); the console recomputes their queue positions. */
  listQueuedPairs(project: string): StoredTaskPair[] {
    const rows = this.#db.prepare("SELECT * FROM task_pairs WHERE project = ? AND status = 'queued'").all(project) as Array<Record<string, unknown>>;
    return rows.map((row) => this.#hydrate(row));
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
    return rows.map((row) => this.#hydrate(row));
  }

  /** Ended pairs whose workspace still exists (ended or kept): the workspace sweep's input. */
  listEndedWorkspacePairs(): StoredTaskPair[] {
    const terminal = TASK_PAIR_TERMINAL_STATUSES.map(() => '?').join(',');
    const rows = this.#db.prepare(
      `SELECT * FROM task_pairs WHERE status IN (${terminal}) AND json_extract(state_json, '$.workspace.status') IN ('ended', 'kept')`,
    ).all(...TASK_PAIR_TERMINAL_STATUSES) as Array<Record<string, unknown>>;
    return rows.map((row) => this.#hydrate(row));
  }

  /**
   * Finished (done) git-worktree pairs since `sinceMs`, newest first, that still need the unintegrated-DONE check: not dismissed and
   * not already found integrated. Filtered in SQL, so the input of the reminder pass is bounded by the pairs that can still matter,
   * never by every recently closed pair (each row carries its brief).
   */
  listRecentDonePairs(sinceMs: number, limit: number): StoredTaskPair[] {
    const rows = this.#db.prepare(
      `SELECT * FROM task_pairs WHERE status = 'done' AND updated_at >= ?
         AND json_extract(state_json, '$.workspace.kind') = 'worktree'
         AND json_extract(state_json, '$.integrationDismissedAt') IS NULL
         AND json_extract(liveness_json, '$.integrationIntegratedAt') IS NULL
       ORDER BY updated_at DESC LIMIT ?`,
    ).all(sinceMs, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.#hydrate(row));
  }

  /** Non-terminal pairs in which a session takes part. */
  pairsForSession(sessionName: string): StoredTaskPair[] {
    // Served from memory. The returned pairs are shared with the cache: read
    // them, never mutate them (copy `liveness` before changing it).
    return [...(this.#ensureActiveIndex().bySession.get(sessionName) ?? [])];
  }

  #ensureActiveIndex(): ActivePairIndex {
    if (this.#activeIndex) return this.#activeIndex;
    const byKey = new Map<string, StoredTaskPair>();
    const bySession = new Map<string, StoredTaskPair[]>();
    const ordered = this.listActivePairs().map(freezeShared);
    for (const pair of ordered) {
      byKey.set(pairKey(pair.project, pair.state.taskId), pair);
      for (const session of participantsOf(pair)) {
        const bucket = bySession.get(session);
        if (bucket) bucket.push(pair); else bySession.set(session, [pair]);
      }
    }
    this.#activeIndex = { byKey, bySession, ordered };
    return this.#activeIndex;
  }

  /**
   * Re-read ONE pair into the index after it was written. A write used to drop
   * the whole index, so the next per-event lookup re-read and re-parsed every
   * open pair (each carrying its full brief); now only the changed row moves.
   */
  #refreshIndexEntry(project: string, taskId: string): void {
    const index = this.#activeIndex;
    if (!index) return;
    const key = pairKey(project, taskId);
    const previous = index.byKey.get(key);
    if (previous) {
      index.byKey.delete(key);
      index.ordered.splice(index.ordered.indexOf(previous), 1);
      for (const session of participantsOf(previous)) {
        const bucket = index.bySession.get(session);
        if (!bucket) continue;
        const rest = bucket.filter((entry) => entry !== previous);
        if (rest.length > 0) index.bySession.set(session, rest); else index.bySession.delete(session);
      }
    }
    const row = this.#db.prepare('SELECT * FROM task_pairs WHERE project = ? AND task_id = ?').get(project, taskId) as Record<string, unknown> | undefined;
    const pair = row ? freezeShared(this.#hydrate(row)) : undefined;
    if (!pair || TASK_PAIR_TERMINAL_STATUSES.includes(pair.state.status)) return;
    index.byKey.set(key, pair);
    index.ordered.push(pair);
    index.ordered.sort(compareActivePairs);
    for (const session of participantsOf(pair)) {
      const bucket = [...(index.bySession.get(session) ?? []), pair].sort(compareActivePairs);
      index.bySession.set(session, bucket);
    }
  }

  /**
   * The non-terminal pairs from memory, in `listActivePairs` order. The pairs
   * are shared with the index: read them, never mutate them. For per-event and
   * per-second callers; everyone else keeps `listActivePairs` (fresh copies).
   */
  listActivePairsShared(project?: string): readonly StoredTaskPair[] {
    const all = this.#ensureActiveIndex().ordered;
    return project ? all.filter((pair) => pair.project === project) : all;
  }

  /** True when a session is reserved by an actively started pair. Queued
   * work is deliberately not a reservation: it is only a scheduling intent
   * and must not block dispatch or REASSIGN of another pair. */
  isParticipantOfOpenPair(sessionName: string, exceptTaskId?: string): boolean {
    return (this.#ensureActiveIndex().bySession.get(sessionName) ?? []).some((pair) => (
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
    this.#pendingLiveness.delete(pairKey(project, state.taskId));
    this.#livenessDbWriteAt.delete(pairKey(project, state.taskId));
    this.#refreshIndexEntry(project, state.taskId);
    for (const listener of this.#listeners) {
      try { listener(project, state.taskId); } catch { /* observers never break a write */ }
    }
    return { project, state, liveness, queueOrder, ...(legacyTaskId ? { legacyTaskId } : {}) };
  }

  saveLiveness(project: string, taskId: string, liveness: TaskPairLiveness): void {
    this.#db.prepare('UPDATE task_pairs SET liveness_json = ? WHERE project = ? AND task_id = ?')
      .run(JSON.stringify(liveness), project, taskId);
    const key = pairKey(project, taskId);
    this.#livenessDbWriteAt.set(key, Date.now());
    this.#pendingLiveness.delete(key);
    const cached = this.#activeIndex?.byKey.get(key);
    if (cached) cached.liveness = liveness;
  }

  /**
   * Record an activity stamp for a pair on the per-event path. The in-memory
   * pair always takes `liveness`, so every reader of pairsForSession sees it;
   * SQLite is rewritten only when something beyond an activity timestamp
   * changed (a reminder cleared, a flag reset...) or the last write of this
   * pair is older than `minIntervalMs`. A crash can lose at most one interval
   * of activity timestamps, far below any heartbeat threshold.
   */
  saveLivenessActivityStamp(
    project: string,
    taskId: string,
    liveness: TaskPairLiveness,
    minIntervalMs = TASK_PAIR_LIVENESS_ACTIVITY_WRITE_INTERVAL_MS,
  ): boolean {
    const key = pairKey(project, taskId);
    const cached = this.#ensureActiveIndex().byKey.get(key);
    const previous = cached?.liveness ?? this.getPair(project, taskId)?.liveness;
    const material = !previous || livenessChangedBeyondActivityTimestamps(previous, liveness);
    const now = Date.now();
    const last = this.#livenessDbWriteAt.get(key);
    if (!material && last !== undefined && now - last < minIntervalMs) {
      if (cached) cached.liveness = liveness;
      this.#pendingLiveness.set(key, liveness);
      this.#scheduleLivenessFlush(minIntervalMs);
      return false;
    }
    this.saveLiveness(project, taskId, liveness);
    return true;
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
    // Consulted by every engine check (isPairsEngineProject), including the
    // per-event paths: setProjectEngine is the only writer, so it is cached.
    const cached = this.#projectSettingsCache.get(project);
    if (cached) return { ...cached };
    const row = this.#db.prepare('SELECT engine FROM task_pair_project_settings WHERE project = ?').get(project) as
      { engine: string | null } | undefined;
    const engine = row?.engine === 'pairs' || row?.engine === 'legacy' ? row.engine : undefined;
    const settings: TaskPairProjectSettings = { ...(engine ? { engine } : {}) };
    this.#projectSettingsCache.set(project, settings);
    return { ...settings };
  }

  setProjectEngine(project: string, engine: TaskPairEngine, now = Date.now()): void {
    this.#db.prepare(`
      INSERT INTO task_pair_project_settings (project, engine, allowlist_json, updated_at) VALUES (?, ?, NULL, ?)
      ON CONFLICT (project) DO UPDATE SET engine = excluded.engine, updated_at = excluded.updated_at
    `).run(project, engine, now);
    this.#projectSettingsCache.delete(project);
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
    this.#activeIndex = undefined;
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
    ...(Number.isFinite(Number(raw.bothIdleNudgeCount)) ? { bothIdleNudgeCount: Number(raw.bothIdleNudgeCount) } : {}),
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
    ...((TASK_PAIR_BRAIN_NOTICE_STATUSES as readonly unknown[]).includes(raw.brainNoticeStatus) ? { brainNoticeStatus: raw.brainNoticeStatus } : {}),
    ...(Number.isFinite(Number(raw.brainNoticeAt)) ? { brainNoticeAt: Number(raw.brainNoticeAt) } : {}),
    ...(typeof raw.brainNoticeReason === 'string' ? { brainNoticeReason: raw.brainNoticeReason } : {}),
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
    ...(typeof raw.participantRecoveryRestartId === 'string' ? { participantRecoveryRestartId: raw.participantRecoveryRestartId } : {}),
    ...(typeof raw.participantObservedExecutorEpoch === 'string' ? { participantObservedExecutorEpoch: raw.participantObservedExecutorEpoch } : {}),
    ...(typeof raw.participantObservedAuditorEpoch === 'string' ? { participantObservedAuditorEpoch: raw.participantObservedAuditorEpoch } : {}),
    ...(typeof raw.participantObservedExecutorSession === 'string' ? { participantObservedExecutorSession: raw.participantObservedExecutorSession } : {}),
    ...(typeof raw.participantObservedAuditorSession === 'string' ? { participantObservedAuditorSession: raw.participantObservedAuditorSession } : {}),
    ...(typeof raw.participantRecoveryExecutorRestartId === 'string' ? { participantRecoveryExecutorRestartId: raw.participantRecoveryExecutorRestartId } : {}),
    ...(typeof raw.participantRecoveryAuditorRestartId === 'string' ? { participantRecoveryAuditorRestartId: raw.participantRecoveryAuditorRestartId } : {}),
    ...(Number.isFinite(Number(raw.executorEscalationAt)) ? { executorEscalationAt: Number(raw.executorEscalationAt) } : {}),
    ...(Number.isFinite(Number(raw.executorEscalationReminderCount)) ? { executorEscalationReminderCount: Number(raw.executorEscalationReminderCount) } : {}),
    ...(Number.isFinite(Number(raw.executorEscalationLastAt)) ? { executorEscalationLastAt: Number(raw.executorEscalationLastAt) } : {}),
    ...(typeof raw.phase === 'string' ? { phase: raw.phase } : {}),
    ...(Number.isFinite(Number(raw.phaseStartedAt)) ? { phaseStartedAt: Number(raw.phaseStartedAt) } : {}),
    ...(Number.isFinite(Number(raw.lastMaterialAt)) ? { lastMaterialAt: Number(raw.lastMaterialAt) } : {}),
    ...(Number.isFinite(Number(raw.stageStallPromptAt)) ? { stageStallPromptAt: Number(raw.stageStallPromptAt) } : {}),
    ...(Number.isFinite(Number(raw.stageStallEscalatedAt)) ? { stageStallEscalatedAt: Number(raw.stageStallEscalatedAt) } : {}),
    ...(typeof raw.integrationKey === 'string' ? { integrationKey: raw.integrationKey } : {}),
    ...(Number.isFinite(Number(raw.integrationReminderCount)) ? { integrationReminderCount: Number(raw.integrationReminderCount) } : {}),
    ...(Number.isFinite(Number(raw.integrationReminderLastAt)) ? { integrationReminderLastAt: Number(raw.integrationReminderLastAt) } : {}),
    ...(Number.isFinite(Number(raw.integrationIntegratedAt)) ? { integrationIntegratedAt: Number(raw.integrationIntegratedAt) } : {}),
    ...(typeof raw.workspaceKeptReminderKey === 'string' ? { workspaceKeptReminderKey: raw.workspaceKeptReminderKey } : {}),
    ...(Number.isFinite(Number(raw.workspaceKeptReminderCount)) ? { workspaceKeptReminderCount: Number(raw.workspaceKeptReminderCount) } : {}),
    ...(Number.isFinite(Number(raw.workspaceKeptReminderLastAt)) ? { workspaceKeptReminderLastAt: Number(raw.workspaceKeptReminderLastAt) } : {}),
    ...(Number.isFinite(Number(raw.workspaceKeptReminderDeliveredAt)) ? { workspaceKeptReminderDeliveredAt: Number(raw.workspaceKeptReminderDeliveredAt) } : {}),
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

/** Writes the current store's deferred activity stamps (daemon shutdown); a no-op when no store was ever opened. */
export function flushTaskPairStoreLiveness(): void {
  try { singleton?.flushPendingLiveness(); } catch { /* the database may already be closed */ }
}

export function setTaskPairStoreForTests(store: TaskPairStore | undefined): void {
  singleton?.close?.();
  singleton = store;
}
