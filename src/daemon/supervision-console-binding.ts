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
import { SupervisionConsoleProducer } from './supervision-console-producer.js';
import { SupervisionConsoleSessionRegistry } from './supervision-console-session.js';
import { migrateSupervisionStore, type SupervisionMigrationDb } from './supervision-store-migrations.js';
import type { SupervisionTaskConsoleScope } from '../../shared/supervision-task-console.js';

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
}

export interface SupervisionConsoleBinding {
  producer: SupervisionConsoleProducer;
  sessions: SupervisionConsoleSessionRegistry;
  projectionEpoch: string;
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
  });

  sessions = new SupervisionConsoleSessionRegistry({
    producer,
    send: (frame) => { deps.serverLink.send(frame); },
    authorize: deps.authorize ?? (() => false),
    now: deps.now,
  });

  deps.serverLink.onMessage((message) => { sessions?.handleFrame(message); });

  return { producer, sessions, projectionEpoch };
}
