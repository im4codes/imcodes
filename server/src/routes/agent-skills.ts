/**
 * Agent Skills on one machine: the skills in its `~/.agents/skills`, and one
 * add, update or remove through the pinned `skills` CLI.
 *
 * Both routes carry `?serverId=` so the ingress sends them to the pod holding
 * that daemon's WebSocket. Running the CLI installs software on the machine,
 * so both are its owner's (or a whole-server participant's) alone. Installing
 * on several machines is one request per machine, made by the browser.
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Env } from '../env.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import { WsBridge } from '../ws/bridge.js';
import {
  AGENT_SKILLS_DIRECTORY,
  AGENT_SKILLS_DIRECTORY_ERROR,
  AGENT_SKILLS_ERROR,
  AGENT_SKILLS_LIMITS,
  AGENT_SKILLS_MSG,
  isAgentSkillName,
  isAgentSkillRepository,
  readAgentSkillsRunRequest,
} from '../../../shared/agent-skills.js';
import { createAgentSkillsDirectory } from '../services/agent-skills-directory.js';
import { NODE_ROLE } from '../../../shared/remote-exec.js';

/** Listing reads a directory; a daemon that has not answered by now will not. */
const LIST_TIMEOUT_MS = 15_000;
/** The daemon bounds the CLI itself; this only has to outlast that. */
const RUN_TIMEOUT_MS = AGENT_SKILLS_LIMITS.RUN_TIMEOUT_MS + 30_000;

export const agentSkillsRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

async function ownedDaemon(c: { env: Env }, serverId: string, userId: string): Promise<'ok' | 'forbidden' | 'not_a_daemon'> {
  if (await resolveServerRole(c.env.DB, serverId, userId) !== 'owner') return 'forbidden';
  const row = await c.env.DB.queryOne<{ node_role: string | null }>(
    'SELECT node_role FROM servers WHERE id = $1 AND revoked_at IS NULL',
    [serverId],
  );
  // A controlled node runs no agents and has no CLI to run.
  return row && row.node_role !== NODE_ROLE.CONTROLLED ? 'ok' : 'not_a_daemon';
}

function failure(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  return message === 'timeout' ? AGENT_SKILLS_ERROR.TIMEOUT : AGENT_SKILLS_ERROR.DAEMON_OFFLINE;
}

agentSkillsRoutes.get('/agent-skills', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.query('serverId')?.trim();
  if (!serverId) return c.json({ error: 'server_id_required' }, 400);
  const access = await ownedDaemon(c, serverId, userId);
  if (access === 'forbidden') return c.json({ error: 'forbidden' }, 403);
  if (access === 'not_a_daemon') return c.json({ error: 'not_found' }, 404);
  const requestId = `agent-skills-${randomUUID()}`;
  try {
    const reply = await WsBridge.get(serverId).sendAgentSkillsRequest(
      { type: AGENT_SKILLS_MSG.LIST_REQUEST, requestId },
      LIST_TIMEOUT_MS,
    );
    return c.json({ skills: Array.isArray(reply.skills) ? reply.skills : [] });
  } catch (err) {
    return c.json({ error: failure(err) }, 409);
  }
});

agentSkillsRoutes.post('/agent-skills/run', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.query('serverId')?.trim();
  if (!serverId) return c.json({ error: 'server_id_required' }, 400);
  const request = readAgentSkillsRunRequest(await c.req.json().catch(() => null));
  if (!request) return c.json({ error: AGENT_SKILLS_ERROR.INVALID_REQUEST }, 400);
  const access = await ownedDaemon(c, serverId, userId);
  if (access === 'forbidden') return c.json({ error: 'forbidden' }, 403);
  if (access === 'not_a_daemon') return c.json({ error: 'not_found' }, 404);
  const requestId = `agent-skills-${randomUUID()}`;
  try {
    const reply = await WsBridge.get(serverId).sendAgentSkillsRequest(
      { type: AGENT_SKILLS_MSG.RUN_REQUEST, requestId, ...request },
      RUN_TIMEOUT_MS,
    );
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { requestId: _r, type: _t, ...result } = reply;
    return c.json(result);
  } catch (err) {
    return c.json({ ok: false, error: failure(err) }, 409);
  }
});

const directory = createAgentSkillsDirectory();

/**
 * Search the skills.sh directory. Not tied to a machine, so no serverId: any
 * signed-in user may search; installing still goes through the owner-only run.
 */
agentSkillsRoutes.get('/agent-skills/directory/search', requireAuth(), async (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  if (!query || query.length > AGENT_SKILLS_DIRECTORY.QUERY_CHARS) {
    return c.json({ error: AGENT_SKILLS_ERROR.INVALID_REQUEST }, 400);
  }
  try {
    return c.json({ results: await directory.search(query) });
  } catch {
    return c.json({ error: AGENT_SKILLS_DIRECTORY_ERROR.UNAVAILABLE }, 502);
  }
});

/** skills.sh's security audits for named skills of one owner/repo. */
agentSkillsRoutes.get('/agent-skills/directory/audit', requireAuth(), async (c) => {
  const source = c.req.query('source')?.trim() ?? '';
  const skills = (c.req.query('skills') ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  if (!isAgentSkillRepository(source)
    || skills.length === 0 || skills.length > AGENT_SKILLS_DIRECTORY.AUDIT_SKILLS || !skills.every(isAgentSkillName)) {
    return c.json({ error: AGENT_SKILLS_ERROR.INVALID_REQUEST }, 400);
  }
  try {
    return c.json({ audits: await directory.audit(source, skills) });
  } catch {
    return c.json({ error: AGENT_SKILLS_DIRECTORY_ERROR.UNAVAILABLE }, 502);
  }
});
