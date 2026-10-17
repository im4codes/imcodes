import { Hono } from 'hono';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import {
  validateRemoteDesktopWallMutation,
} from '../../../shared/remote-desktop-access.js';
import {
  getRemoteDesktopWall,
  mutateRemoteDesktopWall,
  RemoteDesktopWallAuthorizationError,
  RemoteDesktopWallConflictError,
  RemoteDesktopWallMutationError,
} from '../services/remote-desktop-wall.js';

export const remoteDesktopWallRoutes = new Hono<{
  Bindings: Env;
  Variables: { userId: string; role: string };
}>();

remoteDesktopWallRoutes.get('/remote-desktop/wall', requireAuth(), async (c) => {
  const snapshot = await getRemoteDesktopWall(c.env.DB, c.get('userId'));
  c.header('Cache-Control', 'no-store');
  return c.json(snapshot);
});

remoteDesktopWallRoutes.post('/remote-desktop/wall', requireAuth(), async (c) => {
  c.header('Cache-Control', 'no-store');
  const body = await c.req.json().catch(() => null);
  const parsed = validateRemoteDesktopWallMutation(body);
  if (!parsed.ok) return c.json({ error: 'invalid_wall_mutation' }, 400);
  try {
    const snapshot = await mutateRemoteDesktopWall(c.env.DB, c.get('userId'), parsed.value);
    return c.json(snapshot);
  } catch (error) {
    if (error instanceof RemoteDesktopWallConflictError) {
      return c.json({ error: error.message, snapshot: error.snapshot }, 409);
    }
    if (error instanceof RemoteDesktopWallAuthorizationError) {
      return c.json({ error: error.message, snapshot: error.snapshot }, 403);
    }
    if (error instanceof RemoteDesktopWallMutationError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});
