import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';
import type { MessagePin } from '../../shared/message-pins.js';

const listMessagePinsMock = vi.fn();
const getMessagePinMock = vi.fn();
const upsertMessagePinMock = vi.fn();
const deleteMessagePinMock = vi.fn();
const authorizeTimelineSessionMock = vi.fn();

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'member');
    await next();
  },
}));

vi.mock('../src/routes/timeline-session-access.js', () => ({
  authorizeTimelineSession: (...args: unknown[]) => authorizeTimelineSessionMock(...args),
}));

vi.mock('../src/db/message-pins.js', () => ({
  listMessagePins: (...args: unknown[]) => listMessagePinsMock(...args),
  getMessagePin: (...args: unknown[]) => getMessagePinMock(...args),
  upsertMessagePin: (...args: unknown[]) => upsertMessagePinMock(...args),
  deleteMessagePin: (...args: unknown[]) => deleteMessagePinMock(...args),
}));

function pin(id: string, sessionName: string): MessagePin {
  return {
    id,
    serverId: 'srv-1',
    sessionName,
    eventId: `event-${id}`,
    eventTs: 123,
    eventType: 'assistant.text',
    text: `text ${id}`,
    createdAt: 456,
    updatedAt: 456,
  };
}

async function makeApp() {
  const { messagePinRoutes } = await import('../src/routes/message-pins.js');
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    if (!c.env) (c as unknown as { env: Env }).env = {} as Env;
    Object.assign(c.env, { DB: {} });
    await next();
  });
  app.route('/api', messagePinRoutes);
  return app;
}

describe('message pin routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeTimelineSessionMock.mockResolvedValue({ ok: true });
    listMessagePinsMock.mockResolvedValue([]);
    getMessagePinMock.mockResolvedValue(null);
    deleteMessagePinMock.mockResolvedValue(true);
  });

  it('lists only the requested current session when sessionName is present', async () => {
    const app = await makeApp();
    listMessagePinsMock.mockResolvedValue([pin('one', 'deck_main')]);
    const response = await app.request('/api/message-pins?serverId=srv-1&sessionName=deck_main');
    expect(response.status).toBe(200);
    expect(listMessagePinsMock).toHaveBeenCalledWith(expect.anything(), {
      userId: 'user-1', serverId: 'srv-1', sessionName: 'deck_main',
    });
    expect(authorizeTimelineSessionMock).toHaveBeenCalledTimes(1);
  });

  it('re-authorizes and removes revoked sessions from the unified all list', async () => {
    const app = await makeApp();
    listMessagePinsMock.mockResolvedValue([
      pin('allowed-1', 'deck_allowed'),
      pin('allowed-2', 'deck_allowed'),
      pin('revoked', 'deck_revoked'),
    ]);
    authorizeTimelineSessionMock.mockImplementation(async (_db: unknown, scope: { sessionName: string }) => (
      scope.sessionName === 'deck_allowed' ? { ok: true } : { ok: false }
    ));

    const response = await app.request('/api/message-pins?serverId=srv-1');
    expect(response.status).toBe(200);
    const body = await response.json() as { pins: MessagePin[] };
    expect(body.pins.map((item) => item.id)).toEqual(['allowed-1', 'allowed-2']);
    expect(authorizeTimelineSessionMock).toHaveBeenCalledTimes(2);
    expect(listMessagePinsMock).toHaveBeenCalledWith(expect.anything(), {
      userId: 'user-1', serverId: 'srv-1',
    });
  });

  it('searches authorized pins by text or session and filters by event type', async () => {
    const app = await makeApp();
    listMessagePinsMock.mockResolvedValue([
      pin('assistant', 'deck_other'),
      { ...pin('user', 'deck_matching'), eventType: 'user.message', text: 'different' },
      { ...pin('ignored', 'deck_other'), text: 'unrelated' },
    ]);
    const response = await app.request('/api/message-pins?serverId=srv-1&q=matching&eventType=user.message&limit=1');
    expect(response.status).toBe(200);
    const body = await response.json() as { pins: MessagePin[] };
    expect(body.pins.map((item) => item.id)).toEqual(['user']);
  });

  it('persists a validated pin under its current session scope', async () => {
    const app = await makeApp();
    const saved = pin('saved', 'deck_main');
    upsertMessagePinMock.mockResolvedValue({ status: 'ok', pin: saved });
    const response = await app.request('/api/message-pins?serverId=srv-1&sessionName=deck_main', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId: saved.eventId,
        eventTs: saved.eventTs,
        eventType: saved.eventType,
        text: saved.text,
      }),
    });
    expect(response.status).toBe(201);
    expect(upsertMessagePinMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 'user-1', serverId: 'srv-1', sessionName: 'deck_main',
      pin: expect.objectContaining({ eventId: saved.eventId }),
    }));
  });

  it('gets and deletes only after re-authorizing the pin original session', async () => {
    const app = await makeApp();
    const saved = pin('pin-1', 'deck_original');
    getMessagePinMock.mockResolvedValue(saved);
    const getResponse = await app.request('/api/message-pins/pin-1?serverId=srv-1');
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual({ pin: saved });

    const response = await app.request('/api/message-pins/pin-1?serverId=srv-1', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(authorizeTimelineSessionMock).toHaveBeenLastCalledWith(expect.anything(), {
      userId: 'user-1', serverId: 'srv-1', sessionName: 'deck_original',
    });
    expect(deleteMessagePinMock).toHaveBeenCalledWith(expect.anything(), {
      id: 'pin-1', userId: 'user-1', serverId: 'srv-1',
    });
  });

  it('does not expose or delete a pin after its original session access is revoked', async () => {
    const app = await makeApp();
    getMessagePinMock.mockResolvedValue(pin('pin-1', 'deck_revoked'));
    authorizeTimelineSessionMock.mockResolvedValue({ ok: false });
    const response = await app.request('/api/message-pins/pin-1?serverId=srv-1', { method: 'DELETE' });
    expect(response.status).toBe(403);
    expect(deleteMessagePinMock).not.toHaveBeenCalled();
  });
});
