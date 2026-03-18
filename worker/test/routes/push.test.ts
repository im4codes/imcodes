import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pushRoutes, dispatchPush } from '../../src/routes/push.js';
import { Hono } from 'hono';

describe('pushRoutes', () => {
  it('is exported and is a Hono instance', () => {
    expect(pushRoutes).toBeInstanceOf(Hono);
  });

  it('has POST /register route', () => {
    const route = pushRoutes.routes.find(
      (r) => r.method === 'POST' && r.path === '/register',
    );
    expect(route).toBeDefined();
  });

  it('has only one route registered', () => {
    const postRoutes = pushRoutes.routes.filter((r) => r.method === 'POST');
    expect(postRoutes).toHaveLength(1);
  });
});

describe('dispatchPush', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('is exported as a function', () => {
    expect(typeof dispatchPush).toBe('function');
  });

  it('skips push when FCM_SERVER_KEY not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const mockEnv = { FCM_SERVER_KEY: undefined, DB: { prepare: vi.fn() } };
    await dispatchPush({ userId: 'u1', title: 'Test', body: 'Body' }, mockEnv as any);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('skips push when FCM_SERVER_KEY is empty string', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const mockEnv = { FCM_SERVER_KEY: '', DB: { prepare: vi.fn() } };
    await dispatchPush({ userId: 'u1', title: 'Test', body: 'Body' }, mockEnv as any);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('queries DB for tokens when FCM_SERVER_KEY is set', async () => {
    const allMock = vi.fn().mockResolvedValue({ results: [] });
    const bindMock = vi.fn().mockReturnValue({ all: allMock });
    const prepareMock = vi.fn().mockReturnValue({ bind: bindMock });
    const mockEnv = {
      FCM_SERVER_KEY: 'valid-key',
      DB: { prepare: prepareMock },
    };
    await dispatchPush({ userId: 'u1', title: 'T', body: 'B' }, mockEnv as any);
    expect(prepareMock).toHaveBeenCalledWith(
      expect.stringContaining('push_tokens'),
    );
    expect(bindMock).toHaveBeenCalledWith('u1');
  });

  it('calls FCM endpoint for android tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const allMock = vi.fn().mockResolvedValue({
      results: [{ token: 'device-token-123', platform: 'android' }],
    });
    const bindMock = vi.fn().mockReturnValue({ all: allMock });
    const prepareMock = vi.fn().mockReturnValue({ bind: bindMock });
    const mockEnv = {
      FCM_SERVER_KEY: 'my-fcm-key',
      DB: { prepare: prepareMock },
    };
    await dispatchPush({ userId: 'u1', title: 'Hello', body: 'World' }, mockEnv as any);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://fcm.googleapis.com/fcm/send',
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
  });
});
