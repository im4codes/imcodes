import type { Context } from 'hono';
import type { Env } from '../env.js';
import { sha256Hex } from './crypto.js';
import { USAGE_INGEST_PATH_HEADER } from '../../../shared/usage-analytics.js';

export interface DaemonServerAuth {
  serverId: string;
  userId: string;
}

export type DaemonServerAuthResult =
  | { ok: true; auth: DaemonServerAuth }
  | { ok: false; status: 400 | 401; error: 'path_header_mismatch' | 'unauthorized' };

export async function verifyDaemonServerAuth(
  c: Context<{ Bindings: Env }>,
  pathServerId: string,
): Promise<DaemonServerAuthResult> {
  const headerServerId = c.req.header(USAGE_INGEST_PATH_HEADER);
  if (headerServerId && headerServerId !== pathServerId) {
    return { ok: false, status: 400, error: 'path_header_mismatch' };
  }

  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }

  const tokenHash = sha256Hex(auth.slice(7));
  const server = await c.env.DB.queryOne<{ id: string; user_id: string }>(
    'SELECT id, user_id FROM servers WHERE id = $1 AND token_hash = $2',
    [pathServerId, tokenHash],
  );
  if (!server) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true, auth: { serverId: server.id, userId: server.user_id } };
}
