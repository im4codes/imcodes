import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import type { SessionSupervisionSnapshot } from '../../shared/supervision-config.js';
import type { SupervisionAuditDepth } from './supervision-broker.js';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const DEFAULT_DB_PATH = join(homedir(), '.imcodes', 'supervision-state.sqlite');
export const SUPERVISION_STATE_VERSION = 1;

export type PersistedSupervisionWaitPhase = 'waiting' | 'auditing';

export interface PersistedSupervisionSessionIdentity {
  sessionName: string;
  sessionInstanceId: string;
  agentType: string;
  runtimeType: 'process' | 'transport';
  runtimeEpoch?: string;
  providerId?: string;
  providerSessionId?: string;
  providerResumeId?: string;
}

export interface PersistedSupervisionWaitState {
  version: typeof SUPERVISION_STATE_VERSION;
  owner: PersistedSupervisionSessionIdentity;
  commandId: string;
  snapshot: SessionSupervisionSnapshot;
  userText: string;
  phase: PersistedSupervisionWaitPhase;
  requiresAudit: boolean;
  freshAuditRequiredAfterRework: boolean;
  continueLoops: number;
  continueStreakCount: number;
  lastContinueBucket?: string;
  reworkDispatches: number;
  startedAt: number;
  auditDepth?: SupervisionAuditDepth;
  deferredFinalization?: {
    reason: string;
    nextAction: string;
    gap?: string;
  };
  waitingStartedAt?: number;
  waitingDeadlineAt?: number;
  waitingNextHeartbeatAt?: number;
  auditAttemptId?: string;
  auditDelegationId?: string;
  auditStartedAt?: number;
  auditDeadlineAt?: number;
  auditReplyObserved: boolean;
  auditTarget?: PersistedSupervisionSessionIdentity;
  auditTargetDispatchObservedAt?: number;
  auditTargetObservedActive: boolean;
  auditTargetRecoveryAttempts: number;
  auditTargetRecoveryLimitNotified: boolean;
  auditVerdictCorrectionAttempts: number;
  auditMarkerWarningEmitted: boolean;
  pendingAssistantText?: string;
  pendingAssistantCompletionKey?: string;
  updatedAt: number;
}

export interface SupervisionStateStoreOptions {
  dbPath?: string;
  database?: DatabaseSyncInstance;
  busyTimeoutMs?: number;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseRecord(payload: string): PersistedSupervisionWaitState | undefined {
  try {
    const value = JSON.parse(payload) as Partial<PersistedSupervisionWaitState>;
    if (value.version !== SUPERVISION_STATE_VERSION) return undefined;
    if (!value.owner || typeof value.owner.sessionName !== 'string' || !value.owner.sessionName) return undefined;
    if (typeof value.owner.sessionInstanceId !== 'string' || !value.owner.sessionInstanceId) return undefined;
    if (typeof value.owner.agentType !== 'string' || !value.owner.agentType) return undefined;
    if (value.owner.runtimeType !== 'process' && value.owner.runtimeType !== 'transport') return undefined;
    if (typeof value.commandId !== 'string' || !value.commandId) return undefined;
    if (!value.snapshot || typeof value.snapshot !== 'object') return undefined;
    if (typeof value.userText !== 'string') return undefined;
    if (value.phase !== 'waiting' && value.phase !== 'auditing') return undefined;
    if (!isFiniteTimestamp(value.startedAt) || !isFiniteTimestamp(value.updatedAt)) return undefined;
    return value as PersistedSupervisionWaitState;
  } catch {
    return undefined;
  }
}

export class SupervisionStateStore {
  readonly #db: DatabaseSyncInstance;
  readonly #ownsDb: boolean;
  #closed = false;

  constructor(options: SupervisionStateStoreOptions = {}) {
    if (options.database) {
      this.#db = options.database;
      this.#ownsDb = false;
    } else {
      const dbPath = options.dbPath?.trim()
        || process.env.IMCODES_SUPERVISION_STATE_DB_PATH?.trim()
        || (process.env.VITEST ? ':memory:' : DEFAULT_DB_PATH);
      if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
      this.#db = new DatabaseSync(dbPath);
      this.#ownsDb = true;
    }
    const timeout = Math.max(0, Math.min(60_000, Math.floor(options.busyTimeoutMs ?? 5_000)));
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = ${timeout};
      CREATE TABLE IF NOT EXISTS supervision_wait_states (
        session_name TEXT PRIMARY KEY,
        session_instance_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('waiting', 'auditing')),
        deadline_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS supervision_wait_states_deadline_idx
        ON supervision_wait_states(deadline_at);
    `);
  }

  close(): void {
    if (this.#ownsDb && !this.#closed) this.#db.close();
    this.#closed = true;
  }

  upsert(state: PersistedSupervisionWaitState): void {
    if (this.#closed) throw new Error('supervision state store is closed');
    const deadlineAt = state.phase === 'waiting' ? state.waitingDeadlineAt : state.auditDeadlineAt;
    if (!isFiniteTimestamp(deadlineAt)) throw new Error('supervision wait state requires a finite deadline');
    this.#db.prepare(`
      INSERT INTO supervision_wait_states (
        session_name, session_instance_id, command_id, phase,
        deadline_at, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_name) DO UPDATE SET
        session_instance_id = excluded.session_instance_id,
        command_id = excluded.command_id,
        phase = excluded.phase,
        deadline_at = excluded.deadline_at,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      state.owner.sessionName,
      state.owner.sessionInstanceId,
      state.commandId,
      state.phase,
      deadlineAt,
      JSON.stringify(state),
      state.updatedAt,
    );
  }

  get(sessionName: string): PersistedSupervisionWaitState | undefined {
    if (this.#closed) return undefined;
    const row = this.#db.prepare(`
      SELECT payload_json AS payloadJson
      FROM supervision_wait_states
      WHERE session_name = ?
    `).get(sessionName) as { payloadJson?: unknown } | undefined;
    return typeof row?.payloadJson === 'string' ? parseRecord(row.payloadJson) : undefined;
  }

  list(): PersistedSupervisionWaitState[] {
    if (this.#closed) return [];
    const rows = this.#db.prepare(`
      SELECT payload_json AS payloadJson
      FROM supervision_wait_states
      ORDER BY updated_at ASC
    `).all() as Array<{ payloadJson?: unknown }>;
    return rows
      .map((row) => typeof row.payloadJson === 'string' ? parseRecord(row.payloadJson) : undefined)
      .filter((row): row is PersistedSupervisionWaitState => row !== undefined);
  }

  delete(sessionName: string): void {
    if (this.#closed) return;
    this.#db.prepare('DELETE FROM supervision_wait_states WHERE session_name = ?').run(sessionName);
  }

  clear(): void {
    if (this.#closed) return;
    this.#db.exec('DELETE FROM supervision_wait_states');
  }
}

let supervisionStateStore: SupervisionStateStore | undefined;

export function getSupervisionStateStore(): SupervisionStateStore {
  supervisionStateStore ??= new SupervisionStateStore();
  return supervisionStateStore;
}

export function resetSupervisionStateStoreForTests(): void {
  supervisionStateStore?.close();
  supervisionStateStore = undefined;
}
