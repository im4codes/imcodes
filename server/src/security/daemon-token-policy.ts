import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { DAEMON_TOKEN_ROUTE_NOT_ALLOWED, matchDaemonTokenRoute } from '../../../shared/daemon-token-routes.js';
import { NODE_ROLE, type NodeRole } from '../../../shared/remote-exec.js';
import logger from '../util/logger.js';

let deniedCount = 0;

/** Applies to verified FULL daemon tokens only. Controlled-node policy is unchanged. */
export function enforceDaemonTokenRoute(
  req: Context['req'],
  serverId: string,
  role: NodeRole,
): void {
  if (role !== NODE_ROLE.FULL || matchDaemonTokenRoute(req.method, req.path, role)) return;
  // Never log bearer, query, body or arbitrary path parameters. For an unknown
  // route, the declared '*' is enough to diagnose that no handler was mounted.
  logger.warn({ method: req.method, route: [...req.matchedRoutes].reverse().find(r => r.method === req.method && !r.path.includes('*'))?.path ?? '[unregistered]', serverId, deniedCount: ++deniedCount,
    reason: DAEMON_TOKEN_ROUTE_NOT_ALLOWED }, 'Denied daemon-token route');
  throw new HTTPException(403, {
    res: Response.json({ error: 'forbidden', reason: DAEMON_TOKEN_ROUTE_NOT_ALLOWED }, { status: 403 }),
  });
}
