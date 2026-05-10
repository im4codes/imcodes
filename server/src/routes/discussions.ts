import { Hono } from 'hono';
import type { Env } from '../env.js';
import {
  getDiscussionsByServer,
  getDiscussionById,
  getDiscussionRounds,
  getOrchestrationRunsByDiscussion,
  getOrchestrationRunById,
  getRecentOrchestrationRuns,
  type DbOrchestrationRun,
} from '../db/queries.js';
import { sanitizeLegacyP2pProgressSnapshot } from '../p2p-workflow-sanitize.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';

type SanitizedDbOrchestrationRun = DbOrchestrationRun & {
  progress_snapshot_diagnostics: string[];
};

/**
 * Sanitize a single DB row's `progress_snapshot` JSON string at read time
 * (read-only — does not mutate the row in the database). Replaces the row's
 * `progress_snapshot` field with the sanitized persisted snapshot JSON, and
 * attaches a sibling `progress_snapshot_diagnostics: string[]` listing any
 * diagnostic codes (currently only `legacy_progress_snapshot_sanitized`).
 */
function sanitizeRunRow(row: DbOrchestrationRun): SanitizedDbOrchestrationRun {
  const result = sanitizeLegacyP2pProgressSnapshot(row.progress_snapshot ?? '', {
    runId: row.id,
    workflowId: row.discussion_id,
  });
  return {
    ...row,
    progress_snapshot: JSON.stringify(result.snapshot),
    progress_snapshot_diagnostics: result.diagnostic ? [result.diagnostic.code] : [],
  };
}

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

  const discussion = await getDiscussionById(c.env.DB, discussionId, serverId);
  if (!discussion) {
    return c.json({ error: 'not_found' }, 404);
  }

  const rounds = await getDiscussionRounds(c.env.DB, discussionId, serverId);
  return c.json({ discussion, rounds });
});

/** GET /api/server/:id/discussions/:discussionId/runs — list orchestration runs */
discussionRoutes.get('/:id/discussions/:discussionId/runs', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const discussionId = c.req.param('discussionId')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const runs = await getOrchestrationRunsByDiscussion(c.env.DB, discussionId, serverId);
  return c.json({ runs: runs.map(sanitizeRunRow) });
});

/** GET /api/server/:id/p2p/runs — list recent P2P orchestration runs */
discussionRoutes.get('/:id/p2p/runs', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const runs = await getRecentOrchestrationRuns(c.env.DB, serverId, 50);
  return c.json({ runs: runs.map(sanitizeRunRow) });
});

/** GET /api/server/:id/p2p/runs/:runId — get single orchestration run */
discussionRoutes.get('/:id/p2p/runs/:runId', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const runId = c.req.param('runId')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const run = await getOrchestrationRunById(c.env.DB, runId, serverId);
  if (!run) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ run: sanitizeRunRow(run) });
});
