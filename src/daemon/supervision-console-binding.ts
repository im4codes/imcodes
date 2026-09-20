/**
 * Attaches the supervision console producer to the authenticated server link.
 *
 * Capability injection, not a process global: the caller hands in the link and
 * the database, so the binding is fully constructible in a test without a
 * daemon, and nothing reaches for an ambient registry.
 *
 * Wire path:
 *   producer (SQLite + outbox) -> session registry -> serverLink.send -> WsBridge -> browser
 *   browser -> serverLink.onMessage -> session registry -> producer
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SupervisionConsoleProducer, type SupervisionProducerOptions } from './supervision-console-producer.js';
import { SupervisionConsoleSessionRegistry } from './supervision-console-session.js';
import { migrateSupervisionStore, type SupervisionMigrationDb } from './supervision-store-migrations.js';
import {
  SupervisionTaskRegistry,
  resolveSupervisionTaskRegistryDbPath,
} from './supervision-state-store.js';
import { isAuthorizedSupervisionProjectBrain } from './supervision-registry-port.js';
import type { SupervisionTaskConsoleScope } from '../../shared/supervision-task-console.js';
import type { SessionRecord } from '../store/session-store.js';

export interface SupervisionConsoleLink {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
}

export interface SupervisionConsoleBindingDeps {
  serverLink: SupervisionConsoleLink;
  database: SupervisionMigrationDb;
  /** Fail-closed authorization. Absent means deny everything. */
  authorize?: (scope: SupervisionTaskConsoleScope) => boolean;
  now?: () => number;
  newEpoch?: () => string;
  onError?: (error: unknown) => void;
  onActiveSubscriptionCountChanged?: (count: number) => void;
  resolveSessionPresentation?: SupervisionProducerOptions['resolveSessionPresentation'];
}

export interface SupervisionConsoleBinding {
  producer: SupervisionConsoleProducer;
  sessions: SupervisionConsoleSessionRegistry;
  projectionEpoch: string;
}

export interface ProductionSupervisionConsoleBinding extends SupervisionConsoleBinding {
  databasePath: string;
  close(): void;
}

/** Exact live-session authorization for a browser-requested console scope. */
export function isAuthorizedSupervisionConsoleScope(
  scope: SupervisionTaskConsoleScope,
  sessions: readonly SessionRecord[],
): boolean {
  return isAuthorizedSupervisionProjectBrain(scope, sessions);
}

/**
 * Resolve the projection authority epoch.
 *
 * Deliberately STABLE across restarts: it is read back from
 * supervision_projection_state when any scope already has one. Minting a fresh
 * epoch on every boot would force every browser into a full resync after every
 * daemon restart, which is precisely the behaviour the cursor exists to avoid.
 * A new epoch therefore means only one thing -- the projection store is new or
 * was rebuilt -- which is exactly when a resync IS correct.
 */
export function resolveSupervisionProjectionEpoch(
  db: SupervisionMigrationDb,
  newEpoch: () => string = () => randomUUID(),
): string {
  const row = db.prepare(
    'SELECT projection_epoch AS epoch FROM supervision_projection_state WHERE projection_epoch IS NOT NULL LIMIT 1',
  ).get() as { epoch?: string } | undefined;
  const existing = typeof row?.epoch === 'string' ? row.epoch.trim() : '';
  return existing || newEpoch();
}

export function createSupervisionConsoleBinding(
  deps: SupervisionConsoleBindingDeps,
): SupervisionConsoleBinding {
  migrateSupervisionStore(deps.database);
  const projectionEpoch = resolveSupervisionProjectionEpoch(deps.database, deps.newEpoch);

  // The two objects are mutually referential: the producer broadcasts through
  // the session registry, which sends through the link. Declared first so the
  // producer's callback can close over it.
  let sessions: SupervisionConsoleSessionRegistry | undefined;

  const producer = new SupervisionConsoleProducer(deps.database, {
    projectionEpoch,
    now: deps.now,
    broadcast: (frame) => { sessions?.broadcast(frame); },
    resolveSessionPresentation: deps.resolveSessionPresentation,
  });

  sessions = new SupervisionConsoleSessionRegistry({
    producer,
    send: (frame) => { deps.serverLink.send(frame); },
    authorize: deps.authorize ?? (() => false),
    now: deps.now,
    onError: deps.onError,
    onActiveSubscriptionCountChanged: deps.onActiveSubscriptionCountChanged,
  });

  deps.serverLink.onMessage((message) => { sessions?.handleFrame(message); });

  return { producer, sessions, projectionEpoch };
}

/**
 * Production composition over the same SQLite file as SupervisionTaskRegistry.
 *
 * Constructing the registry against this connection first is load-bearing: it
 * creates/validates the authoritative core tables before the console migration
 * adds its projection/outbox tables.  The producer then reads both families on
 * the same connection and can return an authoritative empty snapshot when the
 * registry genuinely contains no tasks.
 */
export function createProductionSupervisionConsoleBinding(
  deps: Omit<SupervisionConsoleBindingDeps, 'database' | 'onActiveSubscriptionCountChanged'> & {
    databasePath?: string;
    /** Exact registry writer whose committed events drive live projection. */
    registry?: SupervisionTaskRegistry;
    /** Short, bounded foreign-writer probe; production defaults to one second. */
    externalPollIntervalMs?: number;
  },
): ProductionSupervisionConsoleBinding {
  const databasePath = deps.databasePath ?? resolveSupervisionTaskRegistryDbPath();
  const database = new DatabaseSync(databasePath);
  try {
    // Production uses the process-wide writer. Tests with an explicit path may
    // inject their exact writer; otherwise this local instance is schema-only.
    const registry = deps.registry ?? new SupervisionTaskRegistry({ database });
    const {
      registry: _registry,
      databasePath: _databasePath,
      externalPollIntervalMs: configuredPollInterval,
      ...bindingDeps
    } = deps;
    const pollIntervalMs = Number.isFinite(configuredPollInterval) && (configuredPollInterval ?? 0) > 0
      ? Math.max(1, Math.floor(configuredPollInterval!))
      : 1_000;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let pollRunning = false;
    let busyBackoffTicks = 1;
    let busyWaitTicks = 0;
    let observedDataVersion = readSqliteDataVersion(database);
    let binding: SupervisionConsoleBinding;

    const stopExternalPoll = () => {
      if (!pollTimer) return;
      clearInterval(pollTimer);
      pollTimer = undefined;
      busyBackoffTicks = 1;
      busyWaitTicks = 0;
    };
    const pollExternalWriters = () => {
      if (pollRunning || binding.sessions.activeSubscriptionCount === 0) return;
      if (busyWaitTicks > 0) { busyWaitTicks -= 1; return; }
      pollRunning = true;
      try {
        const currentDataVersion = readSqliteDataVersion(database);
        if (currentDataVersion === observedDataVersion) {
          busyBackoffTicks = 1;
          return;
        }
        // The durable cursor, not data_version, decides what is emitted. If an
        // in-process callback already tailed the same commit this is a no-op,
        // preserving dense, duplicate-free projection versions.
        binding.sessions.refreshActiveSubscriptions();
        observedDataVersion = currentDataVersion;
        busyBackoffTicks = 1;
      } catch (error) {
        if (isSqliteBusy(error)) {
          busyWaitTicks = busyBackoffTicks;
          busyBackoffTicks = Math.min(busyBackoffTicks * 2, 16);
        } else {
          deps.onError?.(error);
        }
      } finally {
        pollRunning = false;
      }
    };
    const updateExternalPoll = (activeCount: number) => {
      if (activeCount === 0) { stopExternalPoll(); return; }
      if (pollTimer) return;
      pollTimer = setInterval(pollExternalWriters, pollIntervalMs);
      pollTimer.unref?.();
    };

    binding = createSupervisionConsoleBinding({
      ...bindingDeps,
      database,
      onActiveSubscriptionCountChanged: updateExternalPoll,
    });
    const unsubscribe = registry.subscribeDurableEvents(() => {
      try { binding.sessions.refreshActiveSubscriptions(); }
      catch (error) { deps.onError?.(error); }
    });
    return {
      ...binding,
      databasePath,
      close: () => { stopExternalPoll(); unsubscribe(); database.close(); },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

function readSqliteDataVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA data_version').get() as { data_version?: unknown } | undefined;
  return typeof row?.data_version === 'number' ? row.data_version : 0;
}

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /database is (?:busy|locked)/i.test(message);
}
