import { Hono } from 'hono';
import type { Env } from '../env.js';
import { getServersByUserId, getDbSessionsByServer, getSubSessionsByServer, getUserPref, getSessionTextTailCache } from '../db/queries.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import { WsBridge } from '../ws/bridge.js';
import { IMCODES_POD_HEADER } from '../../../shared/http-header-names.js';
import { getPodIdentity } from '../util/pod-identity.js';
import logger from '../util/logger.js';

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

function sanitizeWatchTimelineEvent(raw: unknown): {
  eventId: string;
  sessionId: string;
  ts: number;
  type: string;
  payload: { text?: string };
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as Record<string, unknown>;
  const eventId = typeof event.eventId === 'string' ? event.eventId : null;
  const sessionId = typeof event.sessionId === 'string' ? event.sessionId : null;
  const ts = typeof event.ts === 'number' ? event.ts : null;
  const type = typeof event.type === 'string' ? event.type : null;
  if (!eventId || !sessionId || ts === null || !type) return null;
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : null;
  const text = typeof payload?.text === 'string' ? payload.text : undefined;
  return {
    eventId,
    sessionId,
    ts,
    type,
    payload: text !== undefined ? { text } : {},
  };
}


async function loadTabPreferences(db: Env['DB'], userId: string): Promise<{ order: string[]; pinned: Set<string> }> {
  const [rawOrder, rawPinned] = await Promise.all([
    getUserPref(db, userId, 'tab_order'),
    getUserPref(db, userId, 'tab_pinned'),
  ]);

  const parseList = (raw: string | null): string[] => {
    if (!raw) return [];
    try {
      let parsed = JSON.parse(raw) as unknown;
      // Handle double-encoded JSON (saveUserPref stores JSON.stringify of {v,t})
      if (typeof parsed === 'string') parsed = JSON.parse(parsed) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { v?: unknown }).v)
          ? (parsed as { v: unknown[] }).v
          : [];
      return list.filter((item): item is string => typeof item === 'string' && item.length > 0);
    } catch {
      return [];
    }
  };

  return {
    order: parseList(rawOrder),
    pinned: new Set(parseList(rawPinned)),
  };
}

function orderMainSessions<T extends { sessionName: string; isPinned?: boolean | null }>(sessions: T[], order: string[], pinned: Set<string>): T[] {
  const orderIndex = new Map(order.map((name, idx) => [name, idx]));
  return [...sessions].sort((a, b) => {
    const aPinned = pinned.has(a.sessionName);
    const bPinned = pinned.has(b.sessionName);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    const aOrder = orderIndex.get(a.sessionName);
    const bOrder = orderIndex.get(b.sessionName);
    if (aOrder != null && bOrder != null) return aOrder - bOrder;
    if (aOrder != null) return -1;
    if (bOrder != null) return 1;
    return a.sessionName.localeCompare(b.sessionName);
  });
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

  const bridge = WsBridge.get(serverId);
  const [dbMainSessions, subSessions, tabPrefs] = await Promise.all([
    getDbSessionsByServer(c.env.DB, serverId),
    getSubSessionsByServer(c.env.DB, serverId),
    loadTabPreferences(c.env.DB, userId),
  ]);

  const liveMainSessions = bridge.hasReceivedActiveMainSessionSnapshot()
    ? bridge.getActiveMainSessions().map((session) => ({
        name: session.name,
        project_name: session.project,
        label: session.label ?? null,
        state: session.state,
        agent_type: session.agentType,
      }))
    : null;

  const mainSessions = (liveMainSessions ?? dbMainSessions)
    .filter((session) => !session.name.startsWith('deck_sub_'));

  const mainTitleBySession = new Map<string, string>();
  const mainRows = await Promise.all(mainSessions.map(async (session) => {
    const recentText = await bridge.getRecentTextForWatch(session.name);
    const latest = recentText.at(-1);
    const row = {
      serverId,
      sessionName: session.name,
      title: titleForMainSession(session),
      state: normalizeState(session.state),
      agentBadge: badgeForType(session.agent_type),
      isSubSession: false,
      parentTitle: undefined,
      parentSessionName: undefined,
      isPinned: tabPrefs.pinned.has(session.name),
      previewText: latest?.text ?? undefined,
      previewUpdatedAt: latest?.ts ?? undefined,
      recentText,
    };
    mainTitleBySession.set(session.name, row.title);
    return row;
  }));

  const activeMainNames = new Set(mainRows.map((row) => row.sessionName));
  const subRows = await Promise.all(subSessions
    .filter((sub) => sub.parent_session && activeMainNames.has(sub.parent_session))
    .map(async (sub) => {
      const sessionName = `deck_sub_${sub.id}`;
      const recentText = await bridge.getRecentTextForWatch(sessionName);
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
        isPinned: false,
        previewText: latest?.text ?? undefined,
        previewUpdatedAt: latest?.ts ?? undefined,
        recentText,
      };
    }));

  const orderedMainRows = orderMainSessions(mainRows, tabPrefs.order, tabPrefs.pinned);
  const sessions = [...orderedMainRows, ...subRows];

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

    const events = (Array.isArray(response.events) ? response.events : [])
      .map((event) => sanitizeWatchTimelineEvent(event))
      .filter((event): event is NonNullable<typeof event> => event !== null);
    const earliestTs = events.length > 0 && typeof events[0].ts === 'number'
      ? events[0].ts
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

/**
 * Web-facing full-fidelity variant of the Watch timeline/history endpoint.
 *
 * The Watch endpoint above deliberately strips TimelineEvent down to
 * {eventId, sessionId, ts, type, payload.text} for bandwidth/complexity
 * on tiny Watch UIs. The web client needs the full event shape (tool.call
 * payloads, session.state fields, user.message pending flags, etc.) so it
 * can dedup via `mergeTimelineEvents` and render the same way as live
 * WS timeline.event messages.
 *
 * Why a separate HTTP path when WS `timeline.history_request` already exists:
 * the WS request rides on the same socket whose subscription may still be
 * resolving an async ownership check (bridge.ts `terminal.subscribe`
 * handler). Live `timeline.event` messages emitted during that ~50ms resolve
 * window are silently dropped by `sendToSessionSubscribers`. A parallel
 * HTTP backfill fired ~500ms after reconnect reads the daemon store
 * directly and recovers those events — dedup by eventId makes it safe to
 * merge alongside the WS path.
 *
 * Response schema mirrors the Watch variant except `events[]` contains the
 * raw, unsanitized TimelineEvent records the daemon persisted.
 */
watchRoutes.get('/server/:id/timeline/history/full', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const sessionName = c.req.query('sessionName')?.trim();
  if (!sessionName) return c.json({ error: 'session_name_required' }, 400);

  const rawLimit = Number(c.req.query('limit') ?? '50');
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 500) : 50;
  const rawBeforeTs = c.req.query('beforeTs');
  const beforeTs = rawBeforeTs !== undefined ? Number(rawBeforeTs) : undefined;
  const rawAfterTs = c.req.query('afterTs');
  const afterTs = rawAfterTs !== undefined ? Number(rawAfterTs) : undefined;

  // Instrument the bridge relay latency (server ↔ daemon round-trip incl.
  // the daemon's disk read). Paired with the daemon-side `timeline.history
  // served` log — subtracting that from bridgeMs gives the network/WS
  // overhead isolated.
  const tStart = Date.now();
  try {
    const response = await WsBridge.get(serverId).requestTimelineHistory({
      sessionName,
      limit,
      ...(beforeTs !== undefined && Number.isFinite(beforeTs) ? { beforeTs } : {}),
      ...(afterTs !== undefined && Number.isFinite(afterTs) ? { afterTs } : {}),
    });
    const bridgeMs = Date.now() - tStart;
    c.header(IMCODES_POD_HEADER, getPodIdentity());

    const rawEvents = Array.isArray(response.events) ? response.events : [];
    // Only filter out obviously malformed records (missing eventId/ts/type).
    // Preserve every other field so the web merge path gets the full shape.
    const events = rawEvents.filter((event): event is Record<string, unknown> => {
      if (!event || typeof event !== 'object') return false;
      const e = event as Record<string, unknown>;
      return typeof e.eventId === 'string'
        && typeof e.sessionId === 'string'
        && typeof e.ts === 'number'
        && typeof e.type === 'string';
    });
    const earliestTs = events.length > 0 && typeof events[0].ts === 'number'
      ? events[0].ts as number
      : null;
    const hasMore = earliestTs !== null && events.length >= limit;

    const totalMs = Date.now() - tStart;
    logger.info({
      serverId, sessionName, limit, afterTs, beforeTs,
      eventsReturned: events.length,
      bridgeMs, totalMs,
    }, 'timeline.history/full served');

    return c.json({
      sessionName,
      epoch: typeof response.epoch === 'number' ? response.epoch : null,
      events,
      hasMore,
      nextCursor: hasMore ? earliestTs : null,
    });
  } catch (err) {
    const bridgeMs = Date.now() - tStart;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ serverId, sessionName, bridgeMs, err: message }, 'timeline.history/full failed');
    if (message === 'daemon_offline') return c.json({ error: 'daemon_offline' }, 503);
    if (message === 'timeout') return c.json({ error: 'timeline_timeout' }, 504);
    return c.json({ error: 'relay_failed' }, 502);
  }
});

watchRoutes.get('/server/:id/timeline/text-tail', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const sessionName = c.req.query('sessionName')?.trim();
  if (!sessionName) return c.json({ error: 'session_name_required' }, 400);

  try {
    const events = await getSessionTextTailCache(c.env.DB, serverId, sessionName);
    c.header(IMCODES_POD_HEADER, getPodIdentity());
    return c.json({ sessionName, events });
  } catch (err) {
    logger.warn({
      serverId,
      sessionName,
      err: err instanceof Error ? err.message : String(err),
    }, 'timeline.text-tail failed');
    return c.json({ error: 'cache_read_failed' }, 500);
  }
});
