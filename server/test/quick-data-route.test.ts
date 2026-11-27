import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const getQuickDataSnapshotMock = vi.fn();
const upsertQuickDataMock = vi.fn();
const upsertQuickDataConditionalMock = vi.fn();

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: any, next: any) => {
    c.set('userId', 'test-user');
    return next();
  },
}));

vi.mock('../src/db/queries.js', () => ({
  getQuickDataSnapshot: (...args: unknown[]) => getQuickDataSnapshotMock(...args),
  getQuickData: async (...args: unknown[]) => (await getQuickDataSnapshotMock(...args)).data,
  upsertQuickData: (...args: unknown[]) => upsertQuickDataMock(...args),
  upsertQuickDataConditional: (...args: unknown[]) => upsertQuickDataConditionalMock(...args),
}));

import { quickDataRoutes } from '../src/routes/quick-data.js';

const app = new Hono();
app.use('/*', async (c, next) => {
  (c as any).env = { DB: {} };
  return next();
});
app.route('/api/quick-data', quickDataRoutes);

describe('quick-data routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getQuickDataSnapshotMock.mockResolvedValue({
      data: {
        history: ['keep history'],
        sessionHistory: { 'deck_a': ['keep session'] },
        commands: ['/status'],
        phrases: ['old phrase', 'keep phrase'],
      },
      version: 'v1:initial',
    });
  });

  it('replaces removed custom phrases instead of merging them back', async () => {
    const res = await app.request('/api/quick-data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          history: ['keep history'],
          sessionHistory: { 'deck_a': ['keep session'] },
          commands: ['/status'],
          phrases: ['keep phrase'],
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(upsertQuickDataMock).toHaveBeenCalledWith({}, 'test-user', {
      history: ['keep history'],
      sessionHistory: { 'deck_a': ['keep session'] },
      commands: ['/status'],
      phrases: ['keep phrase'],
    });
  });

  it('persists edited custom phrases as replacements', async () => {
    const res = await app.request('/api/quick-data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          history: ['keep history'],
          sessionHistory: { 'deck_a': ['keep session'] },
          commands: ['/status'],
          phrases: ['updated phrase'],
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(upsertQuickDataMock).toHaveBeenCalledWith({}, 'test-user', {
      history: ['keep history'],
      sessionHistory: { 'deck_a': ['keep session'] },
      commands: ['/status'],
      phrases: ['updated phrase'],
    });
  });

  it('accepts up to 200 global and per-session history entries and rejects 201', async () => {
    const entries200 = Array.from({ length: 200 }, (_, i) => `cmd-${i}`);
    const okRes = await app.request('/api/quick-data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          history: entries200,
          sessionHistory: { deck_a: entries200 },
          commands: [],
          phrases: [],
        },
      }),
    });
    expect(okRes.status).toBe(200);

    const overGlobalRes = await app.request('/api/quick-data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          history: [...entries200, 'cmd-200'],
          sessionHistory: {},
          commands: [],
          phrases: [],
        },
      }),
    });
    expect(overGlobalRes.status).toBe(400);

    const overSessionRes = await app.request('/api/quick-data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          history: [],
          sessionHistory: { deck_a: [...entries200, 'cmd-200'] },
          commands: [],
          phrases: [],
        },
      }),
    });
    expect(overSessionRes.status).toBe(400);
  });

  it('persists valid last-sent timestamps, prunes stale timestamp keys, and rejects invalid timestamps', async () => {
    const res = await app.request('/api/quick-data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          history: ['deploy'],
          sessionHistory: { deck_a: ['deploy'] },
          historyTimestamps: { deploy: 1700000001000, evicted: 1700000000000 },
          sessionHistoryTimestamps: {
            deck_a: { deploy: 1700000002000, stale: 1699999999000 },
            deck_removed: { gone: 1699999999000 },
          },
          commands: [],
          phrases: [],
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(upsertQuickDataMock).toHaveBeenCalledWith({}, 'test-user', {
      history: ['deploy'],
      sessionHistory: { deck_a: ['deploy'] },
      historyTimestamps: { deploy: 1700000001000 },
      sessionHistoryTimestamps: { deck_a: { deploy: 1700000002000 } },
      commands: [],
      phrases: [],
    });

    const badTs = await app.request('/api/quick-data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          history: ['deploy'],
          sessionHistory: {},
          historyTimestamps: { deploy: -5 },
          commands: [],
          phrases: [],
        },
      }),
    });
    expect(badTs.status).toBe(400);
  });

  it('preserves prototype-sensitive history keys (__proto__, constructor, toString) on PUT and GET roundtrip', async () => {
    const rawBody = JSON.stringify({
      data: {
        history: ['__proto__', 'constructor', 'toString'],
        sessionHistory: { audit: ['__proto__', 'constructor'] },
        historyTimestamps: JSON.parse('{"__proto__":1234,"constructor":5678,"toString":9012}'),
        sessionHistoryTimestamps: {
          audit: JSON.parse('{"__proto__":2345,"constructor":6789}'),
        },
        commands: [],
        phrases: [],
      },
    });
    expect(rawBody).toContain('"__proto__":1234');

    const putRes = await app.request('/api/quick-data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    });
    expect(putRes.status).toBe(200);
    const saved = upsertQuickDataMock.mock.calls[0][2] as Record<string, any>;
    expect(Object.hasOwn(saved.historyTimestamps, '__proto__')).toBe(true);
    expect(saved.historyTimestamps['__proto__']).toBe(1234);
    expect(saved.historyTimestamps['constructor']).toBe(5678);
    expect(saved.historyTimestamps['toString']).toBe(9012);
    expect(Object.hasOwn(saved.sessionHistoryTimestamps.audit, '__proto__')).toBe(true);
    expect(saved.sessionHistoryTimestamps.audit['__proto__']).toBe(2345);

    getQuickDataSnapshotMock.mockResolvedValueOnce({ data: saved, version: 'v1:proto' });
    const getRes = await app.request('/api/quick-data');
    expect(getRes.status).toBe(200);
    const getJsonText = await getRes.text();
    expect(getJsonText).toContain('"__proto__":1234');
    expect(getJsonText).toContain('"__proto__":2345');
  });

  it('returns version token on GET and enforces CAS version on PUT (200 on match, 409 with latest data/version on stale)', async () => {
    const getRes = await app.request('/api/quick-data');
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({ version: 'v1:initial' });

    const updatedData = {
      history: ['B', 'A'],
      sessionHistory: { s1: ['B', 'A'] },
      historyTimestamps: { B: 2000, A: 1000 },
      sessionHistoryTimestamps: { s1: { B: 2000, A: 1000 } },
      commands: [],
      phrases: [],
    };
    upsertQuickDataConditionalMock.mockResolvedValueOnce({
      ok: true,
      data: updatedData,
      version: 'v1:after-ba',
    });

    const casOk = await app.request('/api/quick-data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: updatedData, expectedVersion: 'v1:initial' }),
    });
    expect(casOk.status).toBe(200);
    expect(await casOk.json()).toEqual({ ok: true, version: 'v1:after-ba' });
    expect(upsertQuickDataConditionalMock).toHaveBeenCalledWith({}, 'test-user', updatedData, 'v1:initial');

    upsertQuickDataConditionalMock.mockResolvedValueOnce({
      ok: false,
      current: { data: updatedData, version: 'v1:after-ba' },
    });
    const stalePut = await app.request('/api/quick-data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: { history: ['B'], sessionHistory: { s1: ['B'] }, commands: [], phrases: [] },
        expectedVersion: 'v1:initial',
      }),
    });
    expect(stalePut.status).toBe(409);
    expect(await stalePut.json()).toEqual({
      error: 'version_conflict',
      data: updatedData,
      version: 'v1:after-ba',
    });
  });
});
