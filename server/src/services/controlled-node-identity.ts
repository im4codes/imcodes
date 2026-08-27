import { randomBytes } from 'node:crypto';
import type { Database } from '../db/client.js';
import {
  CONTROLLED_NODE_ID_COLLISION_RETRY_LIMIT,
  CONTROLLED_NODE_ID_MIN,
  CONTROLLED_NODE_ID_SPACE_SIZE,
  isControlledNodeId,
  type ControlledNodeId,
} from '../../../shared/controlled-node-identity.js';

const SAMPLE_BYTES = 5;
const SAMPLE_SPACE = 1n << BigInt(SAMPLE_BYTES * 8);
const ID_SPACE = BigInt(CONTROLLED_NODE_ID_SPACE_SIZE);
const ID_MIN = BigInt(CONTROLLED_NODE_ID_MIN);
const UNBIASED_SAMPLE_CEILING = (SAMPLE_SPACE / ID_SPACE) * ID_SPACE;

export type SecureRandomBytes = (size: number) => Uint8Array;

/** Uniform rejection sampling across all canonical IDs; no modulo bias. */
export function generateControlledNodeId(
  secureRandomBytes: SecureRandomBytes = randomBytes,
): ControlledNodeId {
  for (;;) {
    const bytes = secureRandomBytes(SAMPLE_BYTES);
    if (bytes.length !== SAMPLE_BYTES) throw new Error('controlled_node_id_random_bytes_invalid');
    let sample = 0n;
    for (const byte of bytes) sample = (sample << 8n) | BigInt(byte);
    if (sample >= UNBIASED_SAMPLE_CEILING) continue;
    const candidate = String(ID_MIN + (sample % ID_SPACE));
    if (!isControlledNodeId(candidate)) throw new Error('controlled_node_id_generation_invalid');
    return candidate;
  }
}

export interface InsertControlledServerInput {
  serverId: string;
  userId: string;
  tokenHash: string;
  displayName: string;
  refName: string | null;
  os: string | null;
  arch: string | null;
  hostServerId: string | null;
  boundWithKeyId?: string | null;
  createdAt: number;
}

/** Insert exactly one server row, retrying only canonical nodeId collisions. */
export async function insertControlledServerWithNodeId(
  tx: Database,
  input: InsertControlledServerInput,
  secureRandomBytes: SecureRandomBytes = randomBytes,
): Promise<ControlledNodeId> {
  for (let attempt = 0; attempt < CONTROLLED_NODE_ID_COLLISION_RETRY_LIMIT; attempt += 1) {
    const nodeId = generateControlledNodeId(secureRandomBytes);
    const inserted = await tx.queryOne<{ node_id: string }>(
      `INSERT INTO servers
         (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled,
          ref_name, display_name, os, arch, host_server_id, bound_with_key_id, node_id)
       VALUES ($1, $2, $3, $4, 'offline', $5, 'controlled', true,
               $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (node_id) WHERE node_role = 'controlled' DO NOTHING
       RETURNING node_id`,
      [input.serverId, input.userId, input.displayName, input.tokenHash, input.createdAt,
        input.refName, input.displayName, input.os, input.arch, input.hostServerId,
        input.boundWithKeyId ?? null, nodeId],
    );
    if (inserted && isControlledNodeId(inserted.node_id)) return inserted.node_id;
  }
  throw new Error('controlled_node_id_collision_retry_exhausted');
}
