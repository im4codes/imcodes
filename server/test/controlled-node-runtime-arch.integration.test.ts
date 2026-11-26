import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, updateServerHeartbeat } from '../src/db/queries.js';
import { generateControlledNodeId } from '../src/services/controlled-node-identity.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

let db: Database;
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => { await db.close?.(); });

async function macNode(enrolledArch: string): Promise<string> {
  const userId = `u_${hex(4)}`;
  const serverId = hex(8);
  await createUser(db, userId);
  await db.execute(
    `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, os, arch, node_id)
     VALUES ($1, $2, 'mac-node', $3, 'online', $4, $5, TRUE, 'mac', $6, $7)`,
    [serverId, userId, hex(16), Date.now(), NODE_ROLE.CONTROLLED, enrolledArch, generateControlledNodeId()],
  );
  return serverId;
}

const storedArch = async (serverId: string): Promise<string> => (
  (await db.query<{ arch: string }>('SELECT arch FROM servers WHERE id = $1', [serverId]))[0]!.arch
);

/**
 * The enrolled architecture is a snapshot of which slice of a universal
 * executable happened to run the installer. On an Apple Silicon Mac installed
 * under Rosetta that is `x64`, and nothing corrected it -- so the machine was
 * labelled x64 everywhere it was shown, on an M3.
 */
describe('controlled node runtime architecture', () => {
  it('corrects an architecture recorded from a Rosetta install', async () => {
    const serverId = await macNode('x64');
    await updateServerHeartbeat(db, serverId, '2026.9.1-dev.1', ['cap.a'], 'arm64');
    expect(await storedArch(serverId)).toBe('arm64');
  });

  it('keeps what it has when a node reports nothing', async () => {
    // Older nodes do not send one. Erasing the column for them would be worse
    // than the staleness this exists to fix.
    const serverId = await macNode('arm64');
    await updateServerHeartbeat(db, serverId, '2026.9.1-dev.1', ['cap.a']);
    expect(await storedArch(serverId)).toBe('arm64');
    await updateServerHeartbeat(db, serverId, '2026.9.1-dev.1', ['cap.a'], null);
    expect(await storedArch(serverId)).toBe('arm64');
  });

  it('still records the capabilities and version it was given', async () => {
    const serverId = await macNode('x64');
    await updateServerHeartbeat(db, serverId, '2026.9.2-dev.2', ['cap.b'], 'arm64');
    const row = (await db.query<{ daemon_version: string; controlled_capabilities: unknown }>(
      'SELECT daemon_version, controlled_capabilities FROM servers WHERE id = $1', [serverId],
    ))[0]!;
    expect(row.daemon_version).toBe('2026.9.2-dev.2');
    expect(row.controlled_capabilities).toEqual(['cap.b']);
  });
});
