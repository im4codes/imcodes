/**
 * MCP servers on one machine: those in its agents' own configs, and adding or
 * removing one there. `?serverId=` routes to the pod holding that daemon's
 * WebSocket; both are the machine owner's alone. Installing on several
 * machines is one request per machine, made by the browser. Values sent with
 * an install (API keys, tokens) pass through to the daemon and are not logged
 * or kept here.
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { askOwnedDaemon, ownedDaemonServerId } from './owned-daemon-request.js';
import { createAgentMcpRegistry } from '../services/agent-mcp-registry.js';
import {
  AGENT_MCP_ERROR,
  AGENT_MCP_MSG,
  AGENT_MCP_REGISTRY,
  AGENT_MCP_REGISTRY_ERROR,
  readAgentMcpRunRequest,
} from '../../../shared/agent-mcp.js';

/** Reading config files, and writing one entry to each: well inside this. */
const REQUEST_TIMEOUT_MS = 30_000;

export const agentMcpRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

agentMcpRoutes.get('/agent-mcp', requireAuth(), async (c) => {
  const target = await ownedDaemonServerId(c);
  if ('response' in target) return target.response;
  const answer = await askOwnedDaemon(
    target.serverId,
    { type: AGENT_MCP_MSG.LIST_REQUEST, requestId: `agent-mcp-${randomUUID()}` },
    REQUEST_TIMEOUT_MS,
  );
  if ('error' in answer) return c.json({ error: answer.error }, 409);
  return c.json({
    servers: Array.isArray(answer.reply.servers) ? answer.reply.servers : [],
    agents: Array.isArray(answer.reply.agents) ? answer.reply.agents : [],
  });
});

agentMcpRoutes.post('/agent-mcp/run', requireAuth(), async (c) => {
  const request = readAgentMcpRunRequest(await c.req.json().catch(() => null));
  if (!request) return c.json({ error: AGENT_MCP_ERROR.INVALID_REQUEST }, 400);
  const target = await ownedDaemonServerId(c);
  if ('response' in target) return target.response;
  const answer = await askOwnedDaemon(
    target.serverId,
    { type: AGENT_MCP_MSG.RUN_REQUEST, requestId: `agent-mcp-${randomUUID()}`, ...request },
    REQUEST_TIMEOUT_MS,
  );
  if ('error' in answer) return c.json({ ok: false, error: answer.error }, 409);
  return c.json(answer.reply);
});

const registry = createAgentMcpRegistry();

/** Search the official MCP Registry. Not tied to a machine: any signed-in user. */
agentMcpRoutes.get('/agent-mcp/registry/search', requireAuth(), async (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  if (!query || query.length > AGENT_MCP_REGISTRY.QUERY_CHARS) {
    return c.json({ error: AGENT_MCP_ERROR.INVALID_REQUEST }, 400);
  }
  try {
    return c.json({ results: await registry.search(query) });
  } catch {
    return c.json({ error: AGENT_MCP_REGISTRY_ERROR.UNAVAILABLE }, 502);
  }
});
