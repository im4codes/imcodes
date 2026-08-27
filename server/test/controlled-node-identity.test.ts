import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/db/client.js';
import {
  generateControlledNodeId,
  insertControlledServerWithNodeId,
} from '../src/services/controlled-node-identity.js';
import {
  CONTROLLED_NODE_ID_COLLISION_RETRY_LIMIT,
  CONTROLLED_NODE_ID_MAX,
  CONTROLLED_NODE_ID_MIN,
  isControlledNodeId,
} from '../../shared/controlled-node-identity.js';

function fiveBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(5);
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

describe('controlled-node nodeId generation', () => {
  it('maps the uniform sample bounds onto the exact string ID bounds', () => {
    expect(generateControlledNodeId(() => fiveBytes(0n))).toBe(CONTROLLED_NODE_ID_MIN);
    expect(generateControlledNodeId(() => fiveBytes(8_999_999_999n))).toBe(CONTROLLED_NODE_ID_MAX);
  });

  it('rejects the high tail before modulo, proving the implementation is unbiased', () => {
    const sampleSpace = 1n << 40n;
    const idSpace = 9_000_000_000n;
    const rejectionCeiling = (sampleSpace / idSpace) * idSpace;
    const samples = [fiveBytes(rejectionCeiling), fiveBytes(0n)];
    let calls = 0;
    const value = generateControlledNodeId(() => samples[calls++]!);
    expect(value).toBe(CONTROLLED_NODE_ID_MIN);
    expect(calls).toBe(2);
  });

  it('never emits a zero first digit across deterministic coverage of the space', () => {
    for (let i = 0n; i < 9_000n; i += 1n) {
      const value = generateControlledNodeId(() => fiveBytes(i * 1_000_003n));
      expect(isControlledNodeId(value)).toBe(true);
      expect(value[0]).not.toBe('0');
    }
  });

  it('retries database collisions without creating a partial row', async () => {
    const candidates = [0n, 1n, 2n];
    let randomCall = 0;
    const queries: { sql: string; params: unknown[] }[] = [];
    const tx = {
      async queryOne(_sql: string, params: unknown[]) {
        queries.push({ sql: _sql, params });
        return queries.length < 3 ? null : { node_id: params.at(-1) as string };
      },
    } as unknown as Database;
    const nodeId = await insertControlledServerWithNodeId(tx, {
      serverId: 'internal-high-entropy-id', userId: 'owner', tokenHash: 'hash',
      displayName: 'mutable host', refName: 'legacy-host-abcdef', os: 'linux', arch: 'x64',
      hostServerId: null, createdAt: 1,
    }, () => fiveBytes(candidates[randomCall++]!));
    expect(nodeId).toBe('1000000002');
    expect(queries).toHaveLength(3);
    expect(queries.every(({ sql }) => sql.includes('ON CONFLICT (node_id)') && sql.includes('DO NOTHING'))).toBe(true);
    expect(queries.map(({ params }) => params.at(-1))).toEqual(['1000000000', '1000000001', '1000000002']);
    expect(queries.every(({ params }) => params[0] === 'internal-high-entropy-id')).toBe(true);
  });

  it('fails closed after the shared bounded collision budget', async () => {
    let calls = 0;
    const tx = { queryOne: async () => null } as unknown as Database;
    await expect(insertControlledServerWithNodeId(tx, {
      serverId: 'internal', userId: 'owner', tokenHash: 'hash', displayName: 'name',
      refName: 'legacy', os: 'linux', arch: 'x64', hostServerId: null, createdAt: 1,
    }, () => fiveBytes(BigInt(calls++))))
      .rejects.toThrow('controlled_node_id_collision_retry_exhausted');
    expect(calls).toBe(CONTROLLED_NODE_ID_COLLISION_RETRY_LIMIT);
  });

  it('migration uses TEXT, a controlled-only global unique index, safe backfill, and a legacy collision stop', async () => {
    const sql = await readFile(new URL('../src/db/migrations/085_controlled_node_identity.sql', import.meta.url), 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS node_id TEXT');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_controlled_node_id');
    expect(sql).toContain("WHERE node_role = 'controlled'");
    expect(sql).toContain("node_id ~ '^[1-9][0-9]{9}$'");
    expect(sql).toContain("ref_name ~ '^[1-9][0-9]{9}$'");
    expect(sql).toContain("md5(controlled.id || ':' || attempt::text)");
    expect(sql).not.toMatch(/hostname\s*\|\||os\s*\|\|/i);
  });
});

