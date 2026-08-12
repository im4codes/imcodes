import { Hono } from 'hono';
import {
  MESSAGE_PIN_ERRORS,
  MESSAGE_PIN_LIMITS,
  isMessagePinEventType,
  type CreateMessagePinInput,
} from '../../../shared/message-pins.js';
import type { Env } from '../env.js';
import { deleteMessagePin, getMessagePin, listMessagePins, upsertMessagePin } from '../db/message-pins.js';
import { requireAuth } from '../security/authorization.js';
import { authorizeTimelineSession } from './timeline-session-access.js';

export const messagePinRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

function readServerId(c: { req: { query: (name: string) => string | undefined } }): string | null {
  const serverId = c.req.query('serverId')?.trim() ?? '';
  return serverId || null;
}

function readScope(c: { req: { query: (name: string) => string | undefined } }): { serverId: string; sessionName: string } | null {
  const serverId = readServerId(c) ?? '';
  const sessionName = c.req.query('sessionName')?.trim() ?? '';
  if (!serverId || !sessionName || sessionName.length > MESSAGE_PIN_LIMITS.SESSION_NAME_CHARS) return null;
  return { serverId, sessionName };
}

async function authorizeScope(
  db: Env['DB'],
  userId: string,
  scope: { serverId: string; sessionName: string },
): Promise<boolean> {
  const access = await authorizeTimelineSession(db, { userId, ...scope });
  return access.ok;
}

function readPinId(raw: string | undefined): string | null {
  const id = raw?.trim() ?? '';
  return id && id.length <= MESSAGE_PIN_LIMITS.ID_CHARS ? id : null;
}

function filterPins<T extends { sessionName: string; eventType: string; text: string }>(
  pins: T[],
  query: string,
  eventType: string | undefined,
  limit: number | undefined,
): T[] {
  const needle = query.toLocaleLowerCase();
  const filtered = pins.filter((pin) => (
    (!eventType || pin.eventType === eventType)
    && (!needle || pin.text.toLocaleLowerCase().includes(needle) || pin.sessionName.toLocaleLowerCase().includes(needle))
  ));
  return limit === undefined ? filtered : filtered.slice(0, limit);
}

messagePinRoutes.get('/message-pins', requireAuth(), async (c) => {
  const serverId = readServerId(c);
  if (!serverId) return c.json({ error: MESSAGE_PIN_ERRORS.SCOPE_REQUIRED }, 400);
  const userId = c.get('userId' as never) as string;
  const sessionName = c.req.query('sessionName')?.trim() || undefined;
  const query = c.req.query('q')?.trim() ?? '';
  const eventType = c.req.query('eventType')?.trim() || undefined;
  const rawLimit = c.req.query('limit')?.trim();
  const limit = rawLimit ? Number(rawLimit) : undefined;
  if (sessionName && sessionName.length > MESSAGE_PIN_LIMITS.SESSION_NAME_CHARS) {
    return c.json({ error: MESSAGE_PIN_ERRORS.SCOPE_REQUIRED }, 400);
  }
  if (
    query.length > MESSAGE_PIN_LIMITS.QUERY_CHARS
    || (eventType !== undefined && !isMessagePinEventType(eventType))
    || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MESSAGE_PIN_LIMITS.MCP_LIST_RESULTS))
  ) {
    return c.json({ error: MESSAGE_PIN_ERRORS.INVALID_PAYLOAD }, 400);
  }

  if (sessionName) {
    const scope = { serverId, sessionName };
    if (!await authorizeScope(c.env.DB, userId, scope)) return c.json({ error: 'forbidden' }, 403);
    const pins = await listMessagePins(c.env.DB, { userId, ...scope });
    return c.json({ pins: filterPins(pins, query, eventType, limit) });
  }

  // "All" is still scoped to the signed-in user and selected server. A pin
  // may outlive a revoked share, so re-check every distinct session before
  // returning its saved text snapshot instead of treating ownership of the
  // pin row as permanent read authorization.
  const pins = await listMessagePins(c.env.DB, { userId, serverId });
  const sessionNames = [...new Set(pins.map((pin) => pin.sessionName))];
  const access = new Map<string, boolean>();
  // A long-lived account may have pins from many sessions. Re-authorize all
  // of them, but do not turn one list request into an unbounded burst of PG
  // share-coverage queries.
  let nextSessionIndex = 0;
  const workerCount = Math.min(8, sessionNames.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextSessionIndex < sessionNames.length) {
      const candidate = sessionNames[nextSessionIndex++]!;
      access.set(candidate, await authorizeScope(c.env.DB, userId, { serverId, sessionName: candidate }));
    }
  }));
  return c.json({
    pins: filterPins(pins.filter((pin) => access.get(pin.sessionName) === true), query, eventType, limit),
  });
});

messagePinRoutes.get('/message-pins/:id', requireAuth(), async (c) => {
  const serverId = readServerId(c);
  const id = readPinId(c.req.param('id'));
  if (!serverId) return c.json({ error: MESSAGE_PIN_ERRORS.SCOPE_REQUIRED }, 400);
  if (!id) return c.json({ error: MESSAGE_PIN_ERRORS.NOT_FOUND }, 404);
  const userId = c.get('userId' as never) as string;
  const pin = await getMessagePin(c.env.DB, { id, userId, serverId });
  if (!pin) return c.json({ error: MESSAGE_PIN_ERRORS.NOT_FOUND }, 404);
  if (!await authorizeScope(c.env.DB, userId, { serverId, sessionName: pin.sessionName })) {
    return c.json({ error: 'forbidden' }, 403);
  }
  return c.json({ pin });
});

messagePinRoutes.post('/message-pins', requireAuth(), async (c) => {
  const scope = readScope(c);
  if (!scope) return c.json({ error: MESSAGE_PIN_ERRORS.SCOPE_REQUIRED }, 400);
  const userId = c.get('userId' as never) as string;
  if (!await authorizeScope(c.env.DB, userId, scope)) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const eventId = typeof body?.eventId === 'string' ? body.eventId.trim() : '';
  const eventTs = body?.eventTs;
  const eventType = body?.eventType;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (
    !eventId
    || eventId.length > MESSAGE_PIN_LIMITS.EVENT_ID_CHARS
    || typeof eventTs !== 'number'
    || !Number.isSafeInteger(eventTs)
    || eventTs < 0
    || !isMessagePinEventType(eventType)
    || !text
    || text.length > MESSAGE_PIN_LIMITS.TEXT_CHARS
  ) {
    return c.json({ error: MESSAGE_PIN_ERRORS.INVALID_PAYLOAD }, 400);
  }

  const result = await upsertMessagePin(c.env.DB, {
    userId,
    ...scope,
    pin: { eventId, eventTs, eventType, text } satisfies CreateMessagePinInput,
  });
  if (result.status === 'limit_reached') {
    return c.json({ error: MESSAGE_PIN_ERRORS.LIMIT_REACHED, limit: MESSAGE_PIN_LIMITS.PER_SESSION }, 409);
  }
  return c.json({ pin: result.pin }, 201);
});

messagePinRoutes.delete('/message-pins/:id', requireAuth(), async (c) => {
  const serverId = readServerId(c);
  if (!serverId) return c.json({ error: MESSAGE_PIN_ERRORS.SCOPE_REQUIRED }, 400);
  const userId = c.get('userId' as never) as string;
  const id = readPinId(c.req.param('id'));
  if (!id) return c.json({ error: MESSAGE_PIN_ERRORS.NOT_FOUND }, 404);
  const pin = await getMessagePin(c.env.DB, { id, userId, serverId });
  if (!pin) return c.json({ error: MESSAGE_PIN_ERRORS.NOT_FOUND }, 404);
  if (!await authorizeScope(c.env.DB, userId, { serverId, sessionName: pin.sessionName })) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const deleted = await deleteMessagePin(c.env.DB, { id, userId, serverId });
  return deleted
    ? c.json({ ok: true })
    : c.json({ error: MESSAGE_PIN_ERRORS.NOT_FOUND }, 404);
});
