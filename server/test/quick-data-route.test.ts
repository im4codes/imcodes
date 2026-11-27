import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const getQuickDataMock = vi.fn();
const upsertQuickDataMock = vi.fn();

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: any, next: any) => {
    c.set('userId', 'test-user');
    return next();
  },
}));

vi.mock('../src/db/queries.js', () => ({
  getQuickData: (...args: unknown[]) => getQuickDataMock(...args),
  upsertQuickData: (...args: unknown[]) => upsertQuickDataMock(...args),
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
    getQuickDataMock.mockResolvedValue({
      history: ['keep history'],
      sessionHistory: { 'deck_a': ['keep session'] },
      commands: ['/status'],
      phrases: ['old phrase', 'keep phrase'],
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
});
