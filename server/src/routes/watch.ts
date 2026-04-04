import { Hono } from 'hono';
import type { Env } from '../env.js';
import { getServersByUserId, getDbSessionsByServer, getSubSessionsByServer } from '../db/queries.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import { WsBridge } from '../ws/bridge.js';
import { IMCODES_POD_HEADER } from '../../../shared/http-header-names.js';
import { getPodIdentity } from '../util/pod-identity.js';

export const watchRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

type WatchSessionState = 'working' | 'idle' | 'error' | 'stopped';

const BADGE_MAP: Record<string, string> = {
  'claude-code': 'cc',
  'codex': 'cx',
  'opencode': 'oc',
  'openclaw': 'oc',
  'qwen': 'qw',
  'gemini': 'gm',
  'shell': 'sh',
  'script': 'sc',
};

function resolveBaseUrl(reqUrl: string, configuredBaseUrl?: string): string {
  if (configuredBaseUrl) return configuredBaseUrl;
  return new URL(reqUrl).origin;
}

function badgeForType(agentType?: string | null): string {
  if (!agentType) return '??';
  const known = BADGE_MAP[agentType];
  if (known) return known;
  const compact = agentType.replace(/[^a-z0-9]/gi, '').slice(0, 2).toLowerCase();
  return compact || '??';
}

function normalizeState(state: string | null | undefined): WatchSessionState {
  const lower = (state ?? '').toLowerCase();
  if (lower === 'working' || lower === 'running' || lower === 'busy') return 'working';
  if (lower === 'idle' || lower === 'waiting') return 'idle';
  if (lower === 'error' || lower === 'failed') return 'error';
  return 'stopped';
}

function titleForMainSession(session: { project_name: string; label: string | null }): string {
  return session.label?.trim() || session.project_name || 'session';
}

function titleForSubSession(sub: { id: string; label: string | null; type: string }): string {
  if (sub.label?.trim()) return sub.label.trim();
  return sub.type || sub.id;
}

watchRoutes.get('/watch/servers', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const servers = await getServersByUserId(c.env.DB, userId);
  const baseUrl = resolveBaseUrl(c.req.url, c.env.SERVER_URL);
  return c.json({
    servers: servers.map((server) => ({
      id: server.id,
      name: server.name,
      baseUrl,
    })),
  });
});

watchRoutes.get('/watch/sessions', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.query('serverId')?.trim();
  if (!serverId) return c.json({ error: 'server_id_required' }, 400);

  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const [mainSessions, subSessions] = await Promise.all([
    getDbSessionsByServer(c.env.DB, serverId),
    getSubSessionsByServer(c.env.DB, serverId),
  ]);

  const bridge = WsBridge.get(serverId);
  const mainTitleBySession = new Map<string, string>();
  for (const session of mainSessions) {
    mainTitleBySession.set(session.name, titleForMainSession(session));
  }

  const sessions = [
    ...mainSessions.map((session) => {
      const recentText = bridge.getRecentText(session.name);
      const latest = recentText.at(-1);
      return {
        serverId,
        sessionName: session.name,
        title: titleForMainSession(session),
        state: normalizeState(session.state),
        agentBadge: badgeForType(session.agent_type),
        isSubSession: false,
        parentTitle: undefined,
        parentSessionName: undefined,
        previewText: latest?.text ?? undefined,
        previewUpdatedAt: latest?.ts ?? undefined,
        recentText,
      };
    }),
    ...subSessions.map((sub) => {
      const sessionName = `deck_sub_${sub.id}`;
      const recentText = bridge.getRecentText(sessionName);
      const latest = recentText.at(-1);
      return {
        serverId,
        sessionName,
        title: titleForSubSession(sub),
        state: normalizeState(sub.closed_at ? 'stopped' : 'running'),
        agentBadge: badgeForType(sub.type),
        isSubSession: true,
        parentTitle: sub.parent_session ? mainTitleBySession.get(sub.parent_session) : undefined,
        parentSessionName: sub.parent_session ?? undefined,
        previewText: latest?.text ?? undefined,
        previewUpdatedAt: latest?.ts ?? undefined,
        recentText,
      };
    }),
  ];

  return c.json({ serverId, sessions });
});

watchRoutes.get('/server/:id/timeline/history', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const sessionName = c.req.query('sessionName')?.trim();
  if (!sessionName) return c.json({ error: 'session_name_required' }, 400);

  const rawLimit = Number(c.req.query('limit') ?? '50');
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 200) : 50;
  const rawBeforeTs = c.req.query('beforeTs');
  const beforeTs = rawBeforeTs !== undefined ? Number(rawBeforeTs) : undefined;
  const rawAfterTs = c.req.query('afterTs');
  const afterTs = rawAfterTs !== undefined ? Number(rawAfterTs) : undefined;

  try {
    const response = await WsBridge.get(serverId).requestTimelineHistory({
      sessionName,
      limit,
      ...(beforeTs !== undefined && Number.isFinite(beforeTs) ? { beforeTs } : {}),
      ...(afterTs !== undefined && Number.isFinite(afterTs) ? { afterTs } : {}),
    });
    c.header(IMCODES_POD_HEADER, getPodIdentity());

    const events = Array.isArray(response.events) ? response.events : [];
    const earliestTs = events.length > 0 && typeof (events[0] as { ts?: unknown }).ts === 'number'
      ? (events[0] as { ts: number }).ts
      : null;
    const hasMore = earliestTs !== null && events.length >= limit;

    return c.json({
      sessionName,
      epoch: typeof response.epoch === 'number' ? response.epoch : null,
      events,
      hasMore,
      nextCursor: hasMore ? earliestTs : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'daemon_offline') return c.json({ error: 'daemon_offline' }, 503);
    if (message === 'timeout') return c.json({ error: 'timeline_timeout' }, 504);
    return c.json({ error: 'relay_failed' }, 502);
  }
});
