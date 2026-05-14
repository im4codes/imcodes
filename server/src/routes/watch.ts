import { Hono } from 'hono';
import type { Env } from '../env.js';
import {
  getServersByUserId,
  getDbSessionsByServer,
  getSubSessionsByServer,
  getUserPref,
  getSessionTextTailCache,
  collectSessionTextTailCacheItems,
  mergeSessionTextTailCacheItems,
  replaceSessionTextTailCache,
  SESSION_TEXT_TAIL_CACHE_LIMIT,
} from '../db/queries.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import { WsBridge } from '../ws/bridge.js';
import { IMCODES_POD_HEADER } from '../../../shared/http-header-names.js';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '../../../shared/timeline-payload-budget.js';
import { TIMELINE_RESPONSE_STATUS } from '../../../shared/timeline-protocol.js';
import { getPodIdentity } from '../util/pod-identity.js';
import logger from '../util/logger.js';

export const watchRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();
const TEXT_TAIL_HISTORY_PAGE_LIMIT = 500;
const TEXT_TAIL_HISTORY_MAX_PAGES = 6;
const TEXT_TAIL_HISTORY_TIMEOUT_MS = 1500;
const TEXT_TAIL_MAX_ENCODED_BYTES = 64 * 1024;
const textTailBackfills = new Map<string, Promise<Awaited<ReturnType<typeof getSessionTextTailCache>>>>();

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

async function backfillSessionTextTailFromDaemon(
  serverId: string,
  sessionName: string,
  cached: Awaited<ReturnType<typeof getSessionTextTailCache>>,
): Promise<Awaited<ReturnType<typeof getSessionTextTailCache>>> {
  let events = cached;
  let beforeTs: number | undefined;
  const seenPages = new Set<string>();

  for (let page = 0; page < TEXT_TAIL_HISTORY_MAX_PAGES; page++) {
    if (events.length >= SESSION_TEXT_TAIL_CACHE_LIMIT) break;

    const response = await WsBridge.get(serverId).requestTimelineHistory({
      sessionName,
      limit: TEXT_TAIL_HISTORY_PAGE_LIMIT,
      timeoutMs: TEXT_TAIL_HISTORY_TIMEOUT_MS,
      budgetBytes: TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE,
      ...(beforeTs !== undefined ? { beforeTs } : {}),
    });
    const rawEvents = Array.isArray(response.events)
      ? response.events.filter((event): event is Record<string, unknown> => !!event && typeof event === 'object')
      : [];
    if (rawEvents.length === 0) break;

    const fingerprint = JSON.stringify([
      rawEvents.length,
      rawEvents[0]?.eventId,
      rawEvents[0]?.ts,
      rawEvents.at(-1)?.eventId,
      rawEvents.at(-1)?.ts,
    ]);
    if (seenPages.has(fingerprint)) break;
    seenPages.add(fingerprint);

    const live = collectSessionTextTailCacheItems(sessionName, rawEvents);
    if (live.length > 0) {
      events = trimTextTailToBudget(mergeSessionTextTailCacheItems(events, live));
    }

    if (rawEvents.length < TEXT_TAIL_HISTORY_PAGE_LIMIT) break;
    if (encodedJsonBytes(events) >= TEXT_TAIL_MAX_ENCODED_BYTES) break;

    let oldestTs: number | undefined;
    for (const event of rawEvents) {
      if (typeof event.ts !== 'number' || !Number.isFinite(event.ts)) continue;
      oldestTs = oldestTs === undefined ? event.ts : Math.min(oldestTs, event.ts);
    }
    if (oldestTs === undefined) break;

    // Keep a 1ms overlap on the page boundary so same-ts events are not
    // skipped when the next page is requested.
    beforeTs = oldestTs + 1;
  }

  return events;
}

function getBackfillSessionTextTailFromDaemon(
  serverId: string,
  sessionName: string,
  cached: Awaited<ReturnType<typeof getSessionTextTailCache>>,
): Promise<Awaited<ReturnType<typeof getSessionTextTailCache>>> {
  const key = `${serverId}\0${sessionName}`;
  const existing = textTailBackfills.get(key);
  if (existing) return existing;
  const promise = backfillSessionTextTailFromDaemon(serverId, sessionName, cached)
    .finally(() => {
      if (textTailBackfills.get(key) === promise) textTailBackfills.delete(key);
    });
  textTailBackfills.set(key, promise);
  return promise;
}

function encodedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function withHttpActualPayloadBytes<T extends Record<string, unknown>>(body: T): T & { actualPayloadBytes: number } {
  let actualPayloadBytes = 0;
  let next = { ...body, actualPayloadBytes };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const encodedBytes = encodedJsonBytes(next);
    if (encodedBytes === actualPayloadBytes) break;
    actualPayloadBytes = encodedBytes;
    next = { ...body, actualPayloadBytes };
  }
  return next as T & { actualPayloadBytes: number };
}

function selectedEventIds(events: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const eventId = (event as Record<string, unknown>).eventId;
    if (typeof eventId === 'string') ids.add(eventId);
  }
  return ids;
}

function withBoundedHttpTimelinePayload<T extends Record<string, unknown>>(
  body: T,
  budgetBytes: number,
): T & { actualPayloadBytes: number } {
  let measured = withHttpActualPayloadBytes(body);
  if (measured.actualPayloadBytes <= budgetBytes || !Array.isArray(body.events)) return measured;

  const originalEvents = [...body.events];
  const buildCandidate = (startIndex: number): T & { actualPayloadBytes: number } => {
    const events = originalEvents.slice(startIndex);
    const ids = selectedEventIds(events);
    const detailRefs = Array.isArray(body.detailRefs)
      ? body.detailRefs.filter((ref) => {
        if (!ref || typeof ref !== 'object') return false;
        const eventId = (ref as Record<string, unknown>).eventId;
        return typeof eventId === 'string' && ids.has(eventId);
      })
      : undefined;
    const earliestTs = events.length > 0 && typeof (events[0] as Record<string, unknown> | undefined)?.ts === 'number'
      ? (events[0] as Record<string, unknown>).ts as number
      : null;
    return withHttpActualPayloadBytes({
      ...body,
      events,
      ...(detailRefs && detailRefs.length > 0 ? { detailRefs } : { detailRefs: undefined }),
      status: TIMELINE_RESPONSE_STATUS.PARTIAL,
      payloadTruncated: true,
      hasMore: true,
      earliestTs,
      legacyBeforeTs: earliestTs,
    });
  };

  let low = 0;
  let high = originalEvents.length;
  let best: (T & { actualPayloadBytes: number }) | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = buildCandidate(mid);
    if (candidate.actualPayloadBytes <= budgetBytes) {
      best = candidate;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return best ?? buildCandidate(originalEvents.length);
}

function trimTextTailToBudget<T extends Array<{ eventId: string; ts: number; text: string }>>(events: T): T {
  let next = [...events];
  while (next.length > 0 && encodedJsonBytes(next) > TEXT_TAIL_MAX_ENCODED_BYTES) {
    next = next.slice(1);
  }
  return next as T;
}

function textTailSignature(events: Array<{ eventId: string; ts: number; type?: string; text?: string; source?: string; confidence?: string }>): string {
  const first = events[0];
  const last = events.at(-1);
  let rolling = 0;
  for (const event of events) {
    const part = `${event.eventId}\0${event.ts}\0${event.type ?? ''}\0${event.text?.length ?? 0}\0${event.text ?? ''}\0${event.source ?? ''}\0${event.confidence ?? ''}`;
    for (let index = 0; index < part.length; index += 1) {
      rolling = ((rolling << 5) - rolling + part.charCodeAt(index)) | 0;
    }
  }
  return [
    events.length,
    first?.eventId ?? '',
    first?.ts ?? '',
    last?.eventId ?? '',
    last?.ts ?? '',
    rolling >>> 0,
  ].join(':');
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

function timelineResponseMetadata(response: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of ['status', 'errorReason', 'source'] as const) {
    if (typeof response[key] === 'string') metadata[key] = response[key];
  }
  for (const key of ['payloadBytes', 'actualPayloadBytes', 'droppedEvents', 'truncatedEvents'] as const) {
    if (typeof response[key] === 'number' && Number.isFinite(response[key])) metadata[key] = response[key];
  }
  for (const key of ['payloadTruncated', 'cursorReset'] as const) {
    if (typeof response[key] === 'boolean') metadata[key] = response[key];
  }
  if (Array.isArray(response.detailRefs)) metadata.detailRefs = response.detailRefs;
  if (response.nextCursor && typeof response.nextCursor === 'object') metadata.timelineCursor = response.nextCursor;
  return metadata;
}

async function verifyWatchSessionOwnership(db: Env['DB'], serverId: string, sessionName: string): Promise<boolean> {
  try {
    const mainRow = await db.queryOne<Record<string, unknown>>(
      'SELECT 1 FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
      [serverId, sessionName],
    );
    if (mainRow) return true;

    const subMatch = sessionName.match(/^deck_sub_(.+)$/);
    if (!subMatch) return false;
    const subRow = await db.queryOne<Record<string, unknown>>(
      'SELECT 1 FROM sub_sessions WHERE server_id = $1 AND id = $2 LIMIT 1',
      [serverId, subMatch[1]],
    );
    return !!subRow;
  } catch (err) {
    logger.warn({ serverId, sessionName, err }, 'watch timeline session ownership check failed');
    return false;
  }
}

function structuredTimelineCursor(response: Record<string, unknown>): Record<string, unknown> | null {
  return response.nextCursor && typeof response.nextCursor === 'object' && !Array.isArray(response.nextCursor)
    ? response.nextCursor as Record<string, unknown>
    : null;
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
  if (!await verifyWatchSessionOwnership(c.env.DB, serverId, sessionName)) {
    return c.json({ error: 'forbidden' }, 403);
  }

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
      budgetBytes: TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE,
      abortSignal: c.req.raw.signal,
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
    const responseHasMore = typeof response.hasMore === 'boolean' ? response.hasMore : hasMore;
    const nextCursor = structuredTimelineCursor(response);

    const body = {
      sessionName,
      epoch: typeof response.epoch === 'number' ? response.epoch : null,
      events,
      ...timelineResponseMetadata(response),
      hasMore: responseHasMore,
      nextCursor,
      earliestTs,
      legacyBeforeTs: responseHasMore ? earliestTs : null,
    };
    return c.json(withBoundedHttpTimelinePayload(body, TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'daemon_offline') return c.json({ error: 'daemon_offline' }, 503);
    if (message === 'timeout') return c.json({ error: 'timeline_timeout' }, 504);
    return c.json({ error: 'relay_failed' }, 502);
  }
});

/**
 * Web-facing full-shape variant of the Watch timeline/history endpoint.
 *
 * The Watch endpoint above deliberately strips TimelineEvent down to
 * {eventId, sessionId, ts, type, payload.text} for bandwidth/complexity
 * on tiny Watch UIs. The web client needs the shaped event records
 * (tool previews, session.state fields, user.message pending flags, etc.)
 * so it can dedup via `mergeTimelineEvents` and render the same way as live
 * websocket timeline events.
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
 * Response schema mirrors the Watch variant except `events[]` preserves the
 * daemon-shaped TimelineEvent fields. It is still a bounded data-plane page,
 * not a raw unbounded history dump.
 */
watchRoutes.get('/server/:id/timeline/history/full', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const sessionName = c.req.query('sessionName')?.trim();
  if (!sessionName) return c.json({ error: 'session_name_required' }, 400);
  if (!await verifyWatchSessionOwnership(c.env.DB, serverId, sessionName)) {
    return c.json({ error: 'forbidden' }, 403);
  }

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
      budgetBytes: TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL,
      includeDetails: true,
      abortSignal: c.req.raw.signal,
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
    const responseHasMore = typeof response.hasMore === 'boolean' ? response.hasMore : hasMore;
    const nextCursor = structuredTimelineCursor(response);

    const totalMs = Date.now() - tStart;
    logger.info({
      serverId, sessionName, limit, afterTs, beforeTs,
      eventsReturned: events.length,
      payloadBytes: typeof response.payloadBytes === 'number' ? response.payloadBytes : undefined,
      payloadTruncated: typeof response.payloadTruncated === 'boolean' ? response.payloadTruncated : undefined,
      bridgeMs, totalMs,
    }, 'timeline.history/full served');

    const body = {
      sessionName,
      epoch: typeof response.epoch === 'number' ? response.epoch : null,
      events,
      ...timelineResponseMetadata(response),
      hasMore: responseHasMore,
      nextCursor,
      earliestTs,
      legacyBeforeTs: responseHasMore ? earliestTs : null,
    };
    return c.json(withBoundedHttpTimelinePayload(body, TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL));
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
  if (!await verifyWatchSessionOwnership(c.env.DB, serverId, sessionName)) {
    return c.json({ error: 'forbidden' }, 403);
  }

  try {
    const cached = await getSessionTextTailCache(c.env.DB, serverId, sessionName);
    let events = trimTextTailToBudget(cached);
    try {
      events = await getBackfillSessionTextTailFromDaemon(serverId, sessionName, cached);
      events = trimTextTailToBudget(events);
      if (textTailSignature(events) !== textTailSignature(cached)) {
        await replaceSessionTextTailCache(c.env.DB, serverId, sessionName, events);
      }
    } catch (err) {
      logger.info({
        serverId,
        sessionName,
        err: err instanceof Error ? err.message : String(err),
      }, 'timeline.text-tail backfill skipped');
    }
    c.header(IMCODES_POD_HEADER, getPodIdentity());
    return c.json(withHttpActualPayloadBytes({ sessionName, events, textTailTruncated: events.length < cached.length }));
  } catch (err) {
    logger.warn({
      serverId,
      sessionName,
      err: err instanceof Error ? err.message : String(err),
    }, 'timeline.text-tail failed');
    return c.json({ error: 'cache_read_failed' }, 500);
  }
});
