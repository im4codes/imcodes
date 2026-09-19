import type { Context } from 'hono';
import type { Env } from '../env.js';
import { sha256Hex } from './crypto.js';
import { USAGE_INGEST_PATH_HEADER } from '../../../shared/usage-analytics.js';
import { NODE_ROLE, NODE_ROLE_REFUSAL, type NodeRole } from '../../../shared/remote-exec.js';

/**
 * Bearer authentication for daemon-token routes.
 *
 * A handful of routes cannot use `requireAuth()`, because they are called by a
 * daemon holding a server token rather than by a browser holding a session.
 * Those routes previously each did their own `SELECT ... WHERE token_hash = $1`,
 * and every one of them silently skipped the two checks `requireAuth()` performs:
 * the node's role, and whether the credential has been revoked.
 *
 * The consequence was not theoretical. A controlled node — a machine whose whole
 * contract is that it can be controlled and can control nothing — could read and
 * write the OWNER'S account-scoped memory, because those handlers scope their
 * queries by `user_id` rather than by server. Revoking the machine did not stop
 * it, because revocation was only enforced at the WebSocket and in `requireAuth`.
 *
 * This module is the single place that resolves such a token, so a route cannot
 * opt out of the checks by forgetting them. It fails closed: a controlled node is
 * rejected unless the route explicitly declares that it serves one.
 */

export interface DaemonServerAuth {
  serverId: string;
  userId: string;
  teamId: string | null;
  nodeRole: NodeRole;
}

export type DaemonServerAuthResult =
  | { ok: true; auth: DaemonServerAuth }
  | { ok: false; status: 400; error: 'path_header_mismatch' }
  | { ok: false; status: 401; error: 'unauthorized' }
  | { ok: false; status: 403; error: 'forbidden'; reason: typeof NODE_ROLE_REFUSAL.CONTROLLED_NODE };

export interface DaemonServerAuthOptions {
  /**
   * Serve controlled nodes too. Off by default so a route added later is safe
   * before anyone thinks about roles.
   *
   * Only a surface whose entire payload belongs to the calling machine may set
   * this. Anything scoped by `user_id` never qualifies, because a controlled
   * node has no claim on the account that owns it.
   */
  allowControlledNode?: boolean;
  /**
   * Cross-check the usage-ingest path header against the path parameter, for
   * the routes that carry it.
   */
  verifyPathHeader?: boolean;
}

/**
 * Resolve a `Bearer <server-token>` to its server row.
 *
 * `serverId` is optional because one caller authenticates by token alone. When
 * given, it is matched in the same query, so a token cannot address a server it
 * does not belong to.
 */
export async function authenticateDaemonServer<E extends { Bindings: Env }>(
  c: Context<E>,
  serverId: string | null,
  options: DaemonServerAuthOptions = {},
): Promise<DaemonServerAuthResult> {
  if (options.verifyPathHeader && serverId) {
    const headerServerId = c.req.header(USAGE_INGEST_PATH_HEADER);
    if (headerServerId && headerServerId !== serverId) {
      return { ok: false, status: 400, error: 'path_header_mismatch' };
    }
  }

  const authorization = c.req.header('Authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  const tokenHash = sha256Hex(authorization.slice(7));

  const row = serverId
    ? await c.env.DB.queryOne<ServerAuthRow>(
      `SELECT id, user_id, team_id, node_role, revoked_at
         FROM servers WHERE id = $1 AND token_hash = $2`,
      [serverId, tokenHash],
    )
    : await c.env.DB.queryOne<ServerAuthRow>(
      `SELECT id, user_id, team_id, node_role, revoked_at
         FROM servers WHERE token_hash = $1`,
      [tokenHash],
    );

  // A revoked credential is indistinguishable from an unknown one. Saying
  // "revoked" would confirm to whoever holds it that it was once real.
  if (!row || row.revoked_at != null) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }

  // The role is read from the database, never from anything the caller sent.
  const nodeRole: NodeRole = row.node_role === NODE_ROLE.CONTROLLED
    ? NODE_ROLE.CONTROLLED
    : NODE_ROLE.FULL;
  if (nodeRole === NODE_ROLE.CONTROLLED && !options.allowControlledNode) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden',
      reason: NODE_ROLE_REFUSAL.CONTROLLED_NODE,
    };
  }

  return {
    ok: true,
    auth: {
      serverId: row.id,
      userId: row.user_id,
      teamId: row.team_id,
      nodeRole,
    },
  };
}

interface ServerAuthRow {
  id: string;
  user_id: string;
  team_id: string | null;
  node_role: string | null;
  revoked_at: number | null;
}

/** Render a failure verbatim, so every route refuses in the same shape. */
export function daemonAuthFailure<E extends { Bindings: Env }>(
  c: Context<E>,
  failure: Extract<DaemonServerAuthResult, { ok: false }>,
): Response {
  if (failure.status === 403) {
    return c.json({ error: failure.error, reason: failure.reason }, 403);
  }
  return c.json({ error: failure.error }, failure.status);
}

/**
 * Back-compatible wrapper for the usage-ingest route.
 *
 * Kept because that caller reports `auth.error` into its own metrics and relies
 * on the path-header cross-check.
 */
export async function verifyDaemonServerAuth<E extends { Bindings: Env }>(
  c: Context<E>,
  pathServerId: string,
): Promise<DaemonServerAuthResult> {
  return authenticateDaemonServer(c, pathServerId, { verifyPathHeader: true });
}
