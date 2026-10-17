/**
 * A real daemon-side console (producer + session registry over in-memory
 * SQLite) wired to the web side through a JSON round-trip, so web tests compare
 * what a viewer really ends up with. Nothing is mocked below the WS boundary.
 */
import { DatabaseSync } from 'node:sqlite';
import { SupervisionConsoleSessionRegistry } from '../../../src/daemon/supervision-console-session.js';
import { SupervisionConsoleProducer } from '../../../src/daemon/supervision-console-producer.js';
import { migrateSupervisionStore, type SupervisionMigrationDb } from '../../../src/daemon/supervision-store-migrations.js';
import type { SupervisionTaskConsoleSocket } from '../../src/supervision-task-console-controller.js';

export interface PairConsoleDaemon {
  registry: SupervisionConsoleSessionRegistry;
  producer: SupervisionConsoleProducer;
  /** The legacy-registry database behind the producer (to seed legacy tasks/events). */
  db: DatabaseSync;
  /** Frames the daemon pushed, in order (already JSON round-tripped, as on the wire). */
  frames: any[];
  bytes: () => number;
  connect(): { socket: SupervisionTaskConsoleSocket };
}

export const LEGACY_REGISTRY_DDL = `
  CREATE TABLE supervision_tasks (task_id TEXT PRIMARY KEY, top_level_task_id TEXT NOT NULL,
    classification TEXT NOT NULL, status TEXT NOT NULL, current_revision TEXT, commit_sha TEXT,
    push_remote_ref TEXT, blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL);
  CREATE TABLE supervision_task_assignments (assignment_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
    role TEXT NOT NULL, status TEXT NOT NULL, session_name TEXT NOT NULL, session_instance_id TEXT NOT NULL,
    runtime_epoch TEXT NOT NULL, agent_type TEXT NOT NULL, provider_family TEXT NOT NULL,
    lease_id TEXT NOT NULL, generation INTEGER NOT NULL, audit_attempt_id TEXT, audit_revision TEXT,
    verdict TEXT, blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE supervision_task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
    assignment_id TEXT, event_type TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL);
`;

export function createPairConsoleDaemon(options: { epoch: string }): PairConsoleDaemon {
  const db = new DatabaseSync(':memory:');
  db.exec(LEGACY_REGISTRY_DDL);
  migrateSupervisionStore(db as unknown as SupervisionMigrationDb);
  const handlers = new Set<(message: unknown) => void>();
  const frames: any[] = [];
  let total = 0;
  let registry!: SupervisionConsoleSessionRegistry;
  const producer = new SupervisionConsoleProducer(db as unknown as SupervisionMigrationDb, {
    projectionEpoch: options.epoch, now: () => 5_000, snapshotCacheTtlMs: 0,
    broadcast: (frame) => registry.broadcast(frame),
  });
  registry = new SupervisionConsoleSessionRegistry({
    producer, authorize: () => true, now: () => 5_000,
    send: (frame) => {
      const wire = JSON.stringify(frame);
      total += wire.length;
      const parsed = JSON.parse(wire);
      frames.push(parsed);
      for (const handler of handlers) handler(parsed);
    },
  });
  return {
    registry, producer, db, frames, bytes: () => total,
    connect: () => ({
      socket: {
        send: (message: object) => { registry.handleFrame(JSON.parse(JSON.stringify(message))); },
        onMessage: (handler) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
      },
    }),
  };
}
