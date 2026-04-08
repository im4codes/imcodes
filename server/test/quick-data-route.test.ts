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
});
