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

/** One bounded snapshot lets every daemon synchronize all of its local sessions. */
sessionIdentityRoutes.get('/all', async (c) => {
  const profiles = await listSessionIdentityProfiles(c.env.DB, c.get('userId' as never) as string);
  return c.json({ profiles });
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
