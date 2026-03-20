import { Hono } from 'hono';
import type { Env } from '../env.js';
import {
  getDiscussionsByServer,
  getDiscussionById,
  getDiscussionRounds,
  getOrchestrationRunsByDiscussion,
  getOrchestrationRunById,
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

/** GET /api/server/:id/discussions/:discussionId/runs — list orchestration runs */
discussionRoutes.get('/:id/discussions/:discussionId/runs', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const discussionId = c.req.param('discussionId')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const runs = await getOrchestrationRunsByDiscussion(c.env.DB, discussionId);
  return c.json({ runs });
});

/** GET /api/server/:id/p2p/runs/:runId — get single orchestration run */
discussionRoutes.get('/:id/p2p/runs/:runId', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const runId = c.req.param('runId')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const run = await getOrchestrationRunById(c.env.DB, runId);
  if (!run || run.server_id !== serverId) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ run });
});
