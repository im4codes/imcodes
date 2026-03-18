import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../durable-objects/RateLimiter.js';

describe('RateLimiter', () => {
  it('is exported as a class', () => {
    expect(typeof RateLimiter).toBe('function');
    expect(RateLimiter.prototype).toBeDefined();
  });

  it('has a fetch method', () => {
    expect(typeof RateLimiter.prototype.fetch).toBe('function');
  });

  it('can be instantiated with a mock state and env', () => {
    const mockStorage = {
      get: () => Promise.resolve(undefined),
      put: () => Promise.resolve(),
    };
    const mockState = { storage: mockStorage } as any;
    const mockEnv = {} as any;
    const limiter = new RateLimiter(mockState, mockEnv);
    expect(limiter).toBeInstanceOf(RateLimiter);
  });

  it('returns 400 for unknown type param', async () => {
    const mockStorage = {
      get: () => Promise.resolve(undefined),
      put: () => Promise.resolve(),
    };
    const mockState = { storage: mockStorage } as any;
    const limiter = new RateLimiter(mockState, {} as any);
    const req = new Request('https://dummy/?type=unknown&key=test');
    const res = await limiter.fetch(req);
    expect(res.status).toBe(400);
  });

  it('allows msg request when under limit', async () => {
    const store = new Map<string, unknown>();
    const mockState = {
      storage: {
        get: (key: string) => Promise.resolve(store.get(key)),
        put: (key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); },
      },
    } as any;
    const limiter = new RateLimiter(mockState, {} as any);
    const req = new Request('https://dummy/?type=msg&key=user1');
    const res = await limiter.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { allowed: boolean; retryAfter: number };
    expect(body.allowed).toBe(true);
    expect(body.retryAfter).toBe(0);
  });

  it('allows bind request when under limit', async () => {
    const store = new Map<string, unknown>();
    const mockState = {
      storage: {
        get: (key: string) => Promise.resolve(store.get(key)),
        put: (key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); },
      },
    } as any;
    const limiter = new RateLimiter(mockState, {} as any);
    const req = new Request('https://dummy/?type=bind&key=user1');
    const res = await limiter.fetch(req);
    const body = await res.json() as { allowed: boolean };
    expect(body.allowed).toBe(true);
  });

  it('returns allowed:false when msg limit is exhausted', async () => {
    // Pre-fill 30 timestamps within the window to hit MSG_LIMIT
    const now = Date.now();
    const timestamps = Array.from({ length: 30 }, () => now - 1000);
    const store = new Map<string, unknown>([['user-x', { timestamps }]]);
    const mockState = {
      storage: {
        get: (key: string) => Promise.resolve(store.get(key)),
        put: (key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); },
      },
    } as any;
    const limiter = new RateLimiter(mockState, {} as any);
    const req = new Request('https://dummy/?type=msg&key=user-x');
    const res = await limiter.fetch(req);
    const body = await res.json() as { allowed: boolean; retryAfter: number };
    expect(body.allowed).toBe(false);
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('POST /jti-consume returns consumed:false on first use', async () => {
    const store = new Map<string, unknown>();
    const mockState = {
      storage: {
        get: (key: string) => Promise.resolve(store.get(key)),
        put: (key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); },
        list: () => Promise.resolve(new Map()),
        delete: () => Promise.resolve(),
      },
    } as any;
    const limiter = new RateLimiter(mockState, {} as any);
    const req = new Request('https://dummy/jti-consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jti: 'ticket-abc' }),
    });
    const res = await limiter.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { consumed: boolean };
    expect(body.consumed).toBe(false);
  });

  it('POST /jti-consume returns consumed:true on second use (replay blocked)', async () => {
    const store = new Map<string, unknown>();
    const mockState = {
      storage: {
        get: (key: string) => Promise.resolve(store.get(key)),
        put: (key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); },
        list: () => Promise.resolve(new Map()),
        delete: () => Promise.resolve(),
      },
    } as any;
    const limiter = new RateLimiter(mockState, {} as any);
    const makeReq = () => new Request('https://dummy/jti-consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jti: 'ticket-xyz' }),
    });

    // First use
    const res1 = await limiter.fetch(makeReq());
    const body1 = await res1.json() as { consumed: boolean };
    expect(body1.consumed).toBe(false);

    // Replay attempt
    const res2 = await limiter.fetch(makeReq());
    const body2 = await res2.json() as { consumed: boolean };
    expect(body2.consumed).toBe(true);
  });

  it('POST /jti-consume is not shadowed by default type=msg routing', async () => {
    // Regression: without ?type= param, type defaults to "msg" — ensure /jti-consume
    // path-based routing takes priority and returns { consumed } not { allowed }
    const store = new Map<string, unknown>();
    const mockState = {
      storage: {
        get: (key: string) => Promise.resolve(store.get(key)),
        put: (key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); },
        list: () => Promise.resolve(new Map()),
        delete: () => Promise.resolve(),
      },
    } as any;
    const limiter = new RateLimiter(mockState, {} as any);
    const req = new Request('https://dummy/jti-consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jti: 'no-type-param' }),
    });
    const res = await limiter.fetch(req);
    const body = await res.json() as Record<string, unknown>;
    // Must have 'consumed' key, NOT 'allowed' key
    expect('consumed' in body).toBe(true);
    expect('allowed' in body).toBe(false);
  });

  it('records auth_fail and returns locked state after threshold', async () => {
    // Pre-fill 4 attempts so the 5th triggers lockout
    const storeKey = 'auth:ip-1';
    const store = new Map<string, unknown>([[storeKey, { attempts: 4 }]]);
    const mockState = {
      storage: {
        get: (key: string) => Promise.resolve(store.get(key)),
        put: (key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); },
      },
    } as any;
    const limiter = new RateLimiter(mockState, {} as any);
    const req = new Request('https://dummy/?type=auth_fail&key=ip-1');
    const res = await limiter.fetch(req);
    const body = await res.json() as { locked: boolean; lockedUntil?: number };
    expect(body.locked).toBe(true);
    expect(body.lockedUntil).toBeGreaterThan(Date.now());
  });
});
