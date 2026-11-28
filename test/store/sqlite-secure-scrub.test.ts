import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskPairStore } from '../../src/daemon/task-pairs/store.js';
import { TransportQueueStore } from '../../src/daemon/transport-queue-store.js';

function assertBytesScrubbed(dbPath: string, sentinels: readonly string[]): void {
  const mainBytes = readFileSync(dbPath, 'utf8');
  let walSize = 0;
  let walBytes = '';
  try {
    walSize = statSync(`${dbPath}-wal`).size;
    walBytes = walSize > 0 ? readFileSync(`${dbPath}-wal`, 'utf8') : '';
  } catch {
    walSize = 0;
  }
  expect(walSize).toBe(0);
  for (const sentinel of sentinels) {
    expect(mainBytes).not.toContain(sentinel);
    expect(walBytes).not.toContain(sentinel);
  }
}

describe('SQLite legacy plaintext scrub checkpoint completion guard', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDb(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-scrub-ckpt-'));
    dirs.push(dir);
    return join(dir, name);
  }

  it('defers TaskPairStore scrub completion marker while a WAL read snapshot keeps checkpoint busy, then truncates and scrubs WAL + main DB after release', () => {
    const dbPath = makeTempDb('task-pairs.sqlite');
    const ownerSentinel = 'SENTINEL_TPS_BUSY_OWNER_TOKEN_XYZ';
    const partSentinel = 'SENTINEL_TPS_BUSY_PART_TOKEN_XYZ';

    // Bootstrap schema cleanly first, then seed legacy rows into WAL with secure_delete=OFF.
    const bootstrap = new TaskPairStore(dbPath);
    bootstrap.close();

    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = OFF;');
    writer.prepare('DELETE FROM task_pair_meta WHERE key = ?').run('private_authority_ram_only_scrub_v1');
    writer.prepare(`
      INSERT INTO task_pair_private_authority (project, task_id, kind, actor_user_id, authority, updated_at)
      VALUES (?, ?, 'owner', NULL, ?, ?)
    `).run('proj-busy', 'tsk-owner', ownerSentinel, 100);
    writer.prepare(`
      INSERT INTO task_pair_private_authority (project, task_id, kind, actor_user_id, authority, updated_at)
      VALUES (?, ?, 'participant', 'user-p1', ?, ?)
    `).run('proj-busy', 'tsk-part', partSentinel, 100);
    writer.close();

    // Hold a concurrent WAL read snapshot so PRAGMA wal_checkpoint(TRUNCATE) returns busy=1.
    const reader = new DatabaseSync(dbPath);
    reader.exec('BEGIN; SELECT 1 FROM sqlite_master;');
    try {
      const storeWhileBusy = new TaskPairStore(dbPath);
      try {
        expect(storeWhileBusy.getMeta('private_authority_ram_only_scrub_v1')).toBeUndefined();
        expect(storeWhileBusy.getPrivateAuthority('proj-busy', 'tsk-owner')).toBeUndefined();
        expect(storeWhileBusy.getPrivateAuthority('proj-busy', 'tsk-part')).toMatchObject({
          kind: 'participant',
          actorUserId: 'user-p1',
          authority: null,
        });
      } finally {
        storeWhileBusy.close();
      }
      // At least one sentinel remains visible in un-truncated WAL while reader held the snapshot.
      const walText = readFileSync(`${dbPath}-wal`, 'utf8');
      expect(walText.includes(ownerSentinel) || walText.includes(partSentinel)).toBe(true);
    } finally {
      reader.exec('COMMIT;');
      reader.close();
    }

    // Reopen after reader release: retry succeeds, marker is set, and both main DB & WAL are clean.
    const storeAfterRelease = new TaskPairStore(dbPath);
    try {
      expect(storeAfterRelease.getMeta('private_authority_ram_only_scrub_v1')).toBe('1');
    } finally {
      storeAfterRelease.close();
    }
    assertBytesScrubbed(dbPath, [ownerSentinel, partSentinel]);
  });

  it('defers TransportQueueStore scrub completion marker while a WAL read snapshot keeps checkpoint busy, then truncates and scrubs WAL + main DB after release', () => {
    const dbPath = makeTempDb('queue.sqlite');
    const ownerSentinel = 'SENTINEL_TQS_BUSY_OWNER_TOKEN_XYZ';
    const sharedSentinel = 'SENTINEL_TQS_BUSY_SHARED_TOKEN_XYZ';

    const bootstrap = new TransportQueueStore({ dbPath });
    bootstrap.close();

    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = OFF;');
    writer.prepare('DELETE FROM queue_security_migrations WHERE name = ?').run('authority_ram_only_scrub_v1');
    writer.prepare(`
      INSERT INTO queue_private_material (session_name, client_message_id, material_json, updated_at, recipient_session_instance_id, recipient_runtime_epoch)
      VALUES (?, ?, ?, ?, NULL, NULL)
    `).run('sess-busy', 'm-owner', JSON.stringify({ text: 'o', ownerMachineAuthority: ownerSentinel }), 100);
    writer.prepare(`
      INSERT INTO queue_private_material (session_name, client_message_id, material_json, updated_at, recipient_session_instance_id, recipient_runtime_epoch)
      VALUES (?, ?, ?, ?, NULL, NULL)
    `).run('sess-busy', 'm-part', JSON.stringify({
      text: 'p',
      sharedActorEnvelope: { actorUserId: 'part-1', effectiveActorRole: 'participant' },
      sharedMachineAuthority: sharedSentinel,
    }), 100);
    writer.close();

    const reader = new DatabaseSync(dbPath);
    reader.exec('BEGIN; SELECT 1 FROM sqlite_master;');
    try {
      const storeWhileBusy = new TransportQueueStore({ dbPath });
      try {
        const rawDb = (storeWhileBusy as unknown as { db: InstanceType<typeof DatabaseSync> }).db;
        const marker = rawDb.prepare('SELECT 1 FROM queue_security_migrations WHERE name = ?').get('authority_ram_only_scrub_v1');
        expect(marker).toBeUndefined();
      } finally {
        storeWhileBusy.close();
      }
      const walText = readFileSync(`${dbPath}-wal`, 'utf8');
      expect(walText.includes(ownerSentinel) || walText.includes(sharedSentinel)).toBe(true);
    } finally {
      reader.exec('COMMIT;');
      reader.close();
    }

    const storeAfterRelease = new TransportQueueStore({ dbPath });
    try {
      const rawDb = (storeAfterRelease as unknown as { db: InstanceType<typeof DatabaseSync> }).db;
      const marker = rawDb.prepare('SELECT 1 FROM queue_security_migrations WHERE name = ?').get('authority_ram_only_scrub_v1');
      expect(marker).toBeDefined();
      const restoredPart = JSON.parse(storeAfterRelease.readPrivateDispatchMaterial('sess-busy', 'm-part', null)!) as Record<string, unknown>;
      expect(restoredPart.sharedMachineAuthority).toBeUndefined();
      expect(restoredPart.sharedActorEnvelope).toEqual({ actorUserId: 'part-1', effectiveActorRole: 'participant' });
    } finally {
      storeAfterRelease.close();
    }
    assertBytesScrubbed(dbPath, [ownerSentinel, sharedSentinel]);
  });
});
