import { Hono } from 'hono';
import type { Env } from '../env.js';
import {
  getDiscussionsByServer,
  getDiscussionById,
  getDiscussionRounds,
} from '../db/queries.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';

export const discussionRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

discussionRoutes.use('/*', requireAuth());

/** GET /api/server/:id/discussions — list discussions for a server */
discussionRoutes.get('/:id/discussions', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const discussions = await getDiscussionsByServer(c.env.DB, serverId);
  return c.json({ discussions });
});

/** GET /api/server/:id/discussions/:discussionId — get discussion detail with rounds */
discussionRoutes.get('/:id/discussions/:discussionId', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const discussionId = c.req.param('discussionId')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const discussion = await getDiscussionById(c.env.DB, discussionId);
  if (!discussion || discussion.server_id !== serverId) {
    return c.json({ error: 'not_found' }, 404);
  }

  const rounds = await getDiscussionRounds(c.env.DB, discussionId);
  return c.json({ discussion, rounds });
});
