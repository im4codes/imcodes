import { Hono } from 'hono';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import {
  listSessionIdentityProfiles,
} from '../db/session-identity-queries.js';
import {
  handleSessionIdentityDelete,
  handleSessionIdentityGet,
  handleSessionIdentityPut,
} from './session-identity-http.js';

export const sessionIdentityRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();
sessionIdentityRoutes.use('/*', requireAuth());

/** A bounded snapshot lets one daemon synchronize only its live sessions. */
sessionIdentityRoutes.get('/all', async (c) => {
  const serverId = c.req.query('serverId') || c.req.header('X-Server-Id') || undefined;
  const snapshot = await listSessionIdentityProfiles(
    c.env.DB,
    c.get('userId' as never) as string,
    serverId,
  );
  return c.json(snapshot);
});

sessionIdentityRoutes.get('/', async (c) => {
  return handleSessionIdentityGet(c, c.get('userId' as never) as string);
});

sessionIdentityRoutes.put('/', async (c) => {
  return handleSessionIdentityPut(c, c.get('userId' as never) as string);
});

sessionIdentityRoutes.delete('/', async (c) => {
  return handleSessionIdentityDelete(c, c.get('userId' as never) as string);
});
