/**
 * Routes that read or change one machine's agent configuration go through its
 * daemon, and only for the machine's owner (or a whole-server participant),
 * only on a full daemon -- a controlled node runs no agents.
 */
import type { Context } from 'hono';
import type { Env } from '../env.js';
import { resolveServerRole } from '../security/authorization.js';
import { WsBridge } from '../ws/bridge.js';
import { NODE_ROLE } from '../../../shared/remote-exec.js';
import { MACHINE_CONFIG_REQUEST_ERROR } from '../../../shared/machine-config-request.js';

type AppContext = Context<{ Bindings: Env; Variables: { userId: string; role: string } }>;

/**
 * The serverId this request may act on, or the response refusing it. The
 * serverId comes from the query string, which is also what routes the request
 * to the pod holding that daemon's WebSocket.
 */
export async function ownedDaemonServerId(c: AppContext): Promise<{ serverId: string } | { response: Response }> {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.query('serverId')?.trim();
  if (!serverId) return { response: c.json({ error: 'server_id_required' }, 400) };
  if (await resolveServerRole(c.env.DB, serverId, userId) !== 'owner') {
    return { response: c.json({ error: 'forbidden' }, 403) };
  }
  const row = await c.env.DB.queryOne<{ node_role: string | null }>(
    'SELECT node_role FROM servers WHERE id = $1 AND revoked_at IS NULL',
    [serverId],
  );
  if (!row || row.node_role === NODE_ROLE.CONTROLLED) return { response: c.json({ error: 'not_found' }, 404) };
  return { serverId };
}

/** Send one frame to the daemon and return its reply without the correlation fields. */
export async function askOwnedDaemon(
  serverId: string,
  frame: Record<string, unknown> & { requestId: string },
  timeoutMs: number,
): Promise<{ reply: Record<string, unknown> } | { error: string }> {
  try {
    const reply = await WsBridge.get(serverId).sendMachineConfigRequest(frame, timeoutMs);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { requestId: _r, type: _t, ...rest } = reply;
    return { reply: rest };
  } catch (err) {
    return {
      error: err instanceof Error && err.message === 'timeout'
        ? MACHINE_CONFIG_REQUEST_ERROR.TIMEOUT
        : MACHINE_CONFIG_REQUEST_ERROR.DAEMON_OFFLINE,
    };
  }
}
