import { CACHE_CONTROL_HEADER, CACHE_CONTROL_NO_STORE } from '../../../shared/http-header-names.js';
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { resolveSharedMachineAuthority } from '../share/shared-machine-authority.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../../shared/shared-machine-authority.js';
import { NODE_ROLE } from '../../../shared/remote-exec.js';

/** Reuse the signed turn + live share verifier, not a client-supplied user id. No task data leaves this route. */
export const taskPairTitleAuthorityRoutes = new Hono<{
  Bindings: Env;
  Variables: { userId: string; role: string; nodeRole?: string; authServerId?: string };
}>();

taskPairTitleAuthorityRoutes.get('/', requireAuth(), async (c) => {
  c.header(CACHE_CONTROL_HEADER, CACHE_CONTROL_NO_STORE);
  const serverId = c.get('authServerId');
  if (c.get('nodeRole') !== NODE_ROLE.FULL || !serverId) return c.json({ error: 'forbidden' }, 403);
  const actor = await resolveSharedMachineAuthority(c.env.DB, {
    token: c.req.header(SHARED_MACHINE_AUTHORITY_HEADER),
    signingKey: c.env.JWT_SIGNING_KEY,
    authenticatedSourceServerId: serverId,
    now: Date.now(),
  });
  if (actor.kind !== 'participant') return c.json({ error: 'forbidden' }, 403);
  return c.json({ serverId, userId: actor.actorUserId, sessionName: actor.sessionName, projectName: actor.projectName });
});
