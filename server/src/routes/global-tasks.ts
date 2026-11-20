import { Hono } from 'hono';
import { GLOBAL_TASK_WS_TICKET_TYPE } from '../../../shared/global-task-mode.js';
import { listGlobalTaskSnapshotForUser } from '../db/global-task-summaries.js';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { randomHex, signJwt } from '../security/crypto.js';

export const globalTasksRoutes = new Hono<{ Bindings: Env }>();

globalTasksRoutes.use('/*', requireAuth());

function parseMutedServerIds(values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  const out = new Set<string>();
  for (const raw of values) {
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (trimmed) out.add(trimmed);
    }
  }
  return [...out];
}

// GET /api/global-tasks — snapshot of all authorized unmuted FULL servers, tasks, and Brain sessions
globalTasksRoutes.get('/', async (c) => {
  const userId = c.get('userId' as never) as string;
  const mutedServerIds = parseMutedServerIds(c.req.queries('mutedServerIds'));
  const snapshot = await listGlobalTaskSnapshotForUser(c.env.DB, userId, mutedServerIds);
  return c.json(snapshot);
});

// POST /api/global-tasks/ws-ticket — issue a 15-second single-use WebSocket ticket
globalTasksRoutes.post('/ws-ticket', async (c) => {
  const userId = c.get('userId' as never) as string;
  const jti = randomHex(16);
  const ticket = signJwt(
    { sub: userId, type: GLOBAL_TASK_WS_TICKET_TYPE, jti },
    c.env.JWT_SIGNING_KEY,
    15,
  );
  return c.json({ ticket });
});
