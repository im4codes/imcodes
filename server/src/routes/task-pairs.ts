import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Env } from '../env.js';
import { requireAuth, resolveServerMembershipRole } from '../security/authorization.js';
import { askOwnedDaemon } from './owned-daemon-request.js';
import { NODE_ROLE } from '../../../shared/remote-exec.js';
import {
  TASK_PAIR_CLOSE_ERROR,
  TASK_PAIR_CLOSE_MSG,
  TASK_PAIR_CLOSE_TIMEOUT_MS,
  readTaskPairCloseBody,
} from '../../../shared/task-pair-close.js';
import {
  TASK_PAIR_BRIEF_ERROR,
  TASK_PAIR_BRIEF_MSG,
  TASK_PAIR_BRIEF_TIMEOUT_MS,
} from '../../../shared/task-pair-brief.js';
import { resolveAuthorizedFullServersForUser, upsertGlobalTaskSummaryWithChange } from '../db/global-task-summaries.js';
import { globalTaskHub } from '../services/global-task-hub.js';
import { IMCODES_POD_HEADER } from '../../../shared/http-header-names.js';
import { getPodIdentity } from '../util/pod-identity.js';

export const taskPairsRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

function httpStatusForPairError(code: unknown): 400 | 403 | 404 | 409 | 503 | 504 {
  switch (code) {
    case TASK_PAIR_CLOSE_ERROR.INVALID_REQUEST:
      return 400;
    case TASK_PAIR_CLOSE_ERROR.FORBIDDEN:
      return 403;
    case TASK_PAIR_CLOSE_ERROR.NOT_FOUND:
      return 404;
    case TASK_PAIR_CLOSE_ERROR.DAEMON_OFFLINE:
      return 503;
    case TASK_PAIR_CLOSE_ERROR.TIMEOUT:
      return 504;
    default:
      return 409;
  }
}

taskPairsRoutes.get('/:id/task-pairs/:taskId/brief', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')?.trim();
  const taskId = c.req.param('taskId')?.trim();
  if (!serverId || !taskId) {
    return c.json({ ok: false, error: TASK_PAIR_BRIEF_ERROR.INVALID_REQUEST }, 400);
  }

  const membership = await resolveServerMembershipRole(c.env.DB, serverId, userId);
  if (membership === 'none') {
    return c.json({ ok: false, error: TASK_PAIR_BRIEF_ERROR.FORBIDDEN }, 403);
  }

  const authorizedServers = await resolveAuthorizedFullServersForUser(c.env.DB, userId);
  if (!authorizedServers.some((server) => server.id === serverId)) {
    return c.json({ ok: false, error: TASK_PAIR_BRIEF_ERROR.NOT_FOUND }, 404);
  }

  const answer = await askOwnedDaemon(
    serverId,
    {
      type: TASK_PAIR_BRIEF_MSG.REQUEST,
      requestId: `task-pair-brief-${randomUUID()}`,
      taskId,
    },
    TASK_PAIR_BRIEF_TIMEOUT_MS,
  );
  if ('error' in answer) {
    return c.json({ ok: false, error: answer.error }, httpStatusForPairError(answer.error));
  }

  const reply = answer.reply;
  if (reply.ok !== true) {
    return c.json(reply, httpStatusForPairError(reply.error));
  }

  c.header(IMCODES_POD_HEADER, getPodIdentity());
  return c.json(reply);
});

taskPairsRoutes.post('/:id/task-pairs/:taskId/close', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')?.trim();
  const taskId = c.req.param('taskId')?.trim();
  if (!serverId || !taskId) {
    return c.json({ ok: false, error: TASK_PAIR_CLOSE_ERROR.INVALID_REQUEST }, 400);
  }

  if (await resolveServerMembershipRole(c.env.DB, serverId, userId) !== 'owner') {
    return c.json({ ok: false, error: TASK_PAIR_CLOSE_ERROR.FORBIDDEN }, 403);
  }

  const row = await c.env.DB.queryOne<{ node_role: string | null }>(
    'SELECT node_role FROM servers WHERE id = $1 AND revoked_at IS NULL',
    [serverId],
  );
  if (!row || row.node_role === NODE_ROLE.CONTROLLED) {
    return c.json({ ok: false, error: TASK_PAIR_CLOSE_ERROR.NOT_FOUND }, 404);
  }

  const body = readTaskPairCloseBody(await c.req.json().catch(() => null));
  if (!body) {
    return c.json({ ok: false, error: TASK_PAIR_CLOSE_ERROR.INVALID_REQUEST }, 400);
  }

  const answer = await askOwnedDaemon(
    serverId,
    {
      type: TASK_PAIR_CLOSE_MSG.REQUEST,
      requestId: `task-pair-close-${randomUUID()}`,
      taskId,
      ...body,
    },
    TASK_PAIR_CLOSE_TIMEOUT_MS,
  );
  if ('error' in answer) {
    return c.json({ ok: false, error: answer.error }, httpStatusForPairError(answer.error));
  }

  const reply = answer.reply;
  if (reply.ok !== true) {
    return c.json(reply, httpStatusForPairError(reply.error));
  }

  if (typeof reply.status === 'string' && reply.status.trim()) {
    try {
      const { row: saved, changed } = await upsertGlobalTaskSummaryWithChange(c.env.DB, {
        serverId,
        taskId,
        status: reply.status,
        ...(typeof reply.projectName === 'string' && reply.projectName.trim() ? { projectName: reply.projectName } : {}),
        ...(typeof reply.brainSession === 'string' && reply.brainSession.trim() ? { brainSession: reply.brainSession } : {}),
        ...(typeof reply.title === 'string' && reply.title.trim() ? { title: reply.title } : {}),
        updatedAt: typeof reply.updatedAt === 'number' && Number.isFinite(reply.updatedAt) ? reply.updatedAt : Date.now(),
        ...(typeof reply.endedAt === 'number' && Number.isFinite(reply.endedAt) ? { endedAt: reply.endedAt } : {}),
      });
      if (saved && changed) {
        await globalTaskHub.notifyTaskUpdated(c.env.DB, serverId, saved.taskId, saved);
      }
    } catch {
      // Non-fatal: daemon timeline events also sync global task summaries.
    }
  }

  c.header(IMCODES_POD_HEADER, getPodIdentity());
  return c.json(reply);
});
