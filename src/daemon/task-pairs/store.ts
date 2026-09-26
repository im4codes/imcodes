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
  TASK_PAIR_MAX_CONCURRENCY_CAP,
  TASK_PAIR_OPEN_STATUSES,
  TASK_PAIR_TERMINAL_STATUSES,
  type TaskPairEngine,
  type TaskPairEventSource,
  type TaskPairRole,
  type TaskPairState,
  type TaskPairStatus,
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
  lastTickAt: number;
  /** Escalations already sent, so each is sent once. */
  notified: string[];
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
    `);
  }

  close(): void {
    this.#db.close();
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

  isParticipantOfOpenPair(sessionName: string): boolean {
    return this.listActivePairs().some((pair) => (
      TASK_PAIR_OPEN_STATUSES.includes(pair.state.status)
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
    // Clamped on read too: a row written before TASK_PAIR_MAX_CONCURRENCY_CAP
    // existed (or restored from an older backup) must still read back capped.
    return row ? Math.min(TASK_PAIR_MAX_CONCURRENCY_CAP, Number(row.max_concurrency)) : TASK_PAIR_DEFAULT_MAX_CONCURRENCY;
  }

  setMaxConcurrency(brain: string, max: number): void {
    this.#db.prepare(`
      INSERT INTO task_pair_queue_settings (brain, max_concurrency) VALUES (?, ?)
      ON CONFLICT (brain) DO UPDATE SET max_concurrency = excluded.max_concurrency
    `).run(brain, Math.min(TASK_PAIR_MAX_CONCURRENCY_CAP, Math.max(1, Math.floor(max))));
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
    lastTickAt: Number(raw.lastTickAt ?? 0),
    notified: Array.isArray(raw.notified) ? raw.notified.map(String) : [],
  };
  return {
    project: String(row.project),
    state: JSON.parse(String(row.state_json)) as TaskPairState,
    liveness,
    queueOrder: Number(row.queue_order),
    ...(row.legacy_task_id ? { legacyTaskId: String(row.legacy_task_id) } : {}),
  };
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
