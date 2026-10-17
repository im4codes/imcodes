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
import { requireAuth } from '../security/authorization.js';
import { askOwnedDaemon, ownedDaemonServerId } from './owned-daemon-request.js';
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

/** Listing reads a directory; a daemon that has not answered by now will not. */
const LIST_TIMEOUT_MS = 15_000;
/** The daemon bounds the CLI itself; this only has to outlast that. */
const RUN_TIMEOUT_MS = AGENT_SKILLS_LIMITS.RUN_TIMEOUT_MS + 30_000;

export const agentSkillsRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

agentSkillsRoutes.get('/agent-skills', requireAuth(), async (c) => {
  const target = await ownedDaemonServerId(c);
  if ('response' in target) return target.response;
  const answer = await askOwnedDaemon(
    target.serverId,
    { type: AGENT_SKILLS_MSG.LIST_REQUEST, requestId: `agent-skills-${randomUUID()}` },
    LIST_TIMEOUT_MS,
  );
  if ('error' in answer) return c.json({ error: answer.error }, 409);
  return c.json({ skills: Array.isArray(answer.reply.skills) ? answer.reply.skills : [] });
});

agentSkillsRoutes.post('/agent-skills/run', requireAuth(), async (c) => {
  const request = readAgentSkillsRunRequest(await c.req.json().catch(() => null));
  if (!request) return c.json({ error: AGENT_SKILLS_ERROR.INVALID_REQUEST }, 400);
  const target = await ownedDaemonServerId(c);
  if ('response' in target) return target.response;
  const answer = await askOwnedDaemon(
    target.serverId,
    { type: AGENT_SKILLS_MSG.RUN_REQUEST, requestId: `agent-skills-${randomUUID()}`, ...request },
    RUN_TIMEOUT_MS,
  );
  if ('error' in answer) return c.json({ ok: false, error: answer.error }, 409);
  return c.json(answer.reply);
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
