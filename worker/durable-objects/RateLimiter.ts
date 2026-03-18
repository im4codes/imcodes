import type { Env } from '../src/types.js';

const MSG_LIMIT = 30;
const MSG_WINDOW_MS = 60_000;
const BIND_LIMIT = 3;
const BIND_WINDOW_MS = 3_600_000;
const AUTH_LOCKOUT_ATTEMPTS = 5;
const AUTH_LOCKOUT_MS = 15 * 60_000;

interface RateWindow {
  timestamps: number[];
  lockedUntil?: number;
}

export class RateLimiter implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Path-based routing takes priority over type-based routing
    if (url.pathname === '/jti-consume' && req.method === 'POST') {
      const body = await req.json() as { jti: string };
      return Response.json(await this.consumeJti(body.jti));
    }

    const key = url.searchParams.get('key') ?? 'default';
    const type = url.searchParams.get('type') ?? 'msg';

    if (type === 'msg') {
      const allowed = await this.checkWindow(key, MSG_LIMIT, MSG_WINDOW_MS);
      return Response.json({ allowed, retryAfter: allowed ? 0 : Math.ceil(MSG_WINDOW_MS / 1000) });
    }

    if (type === 'bind') {
      const allowed = await this.checkWindow(key, BIND_LIMIT, BIND_WINDOW_MS);
      return Response.json({ allowed, retryAfter: allowed ? 0 : Math.ceil(BIND_WINDOW_MS / 1000) });
    }

    if (type === 'auth_fail') {
      const result = await this.recordAuthFailure(key);
      return Response.json(result);
    }

    if (type === 'auth_check') {
      const result = await this.checkAuthLockout(key);
      return Response.json(result);
    }

    return new Response('Unknown type', { status: 400 });
  }

  private async checkWindow(key: string, limit: number, windowMs: number): Promise<boolean> {
    const data = (await this.state.storage.get<RateWindow>(key)) ?? { timestamps: [] };
    const now = Date.now();
    const windowStart = now - windowMs;
    data.timestamps = data.timestamps.filter((t) => t > windowStart);

    if (data.timestamps.length >= limit) {
      await this.state.storage.put(key, data);
      return false;
    }

    data.timestamps.push(now);
    await this.state.storage.put(key, data);
    return true;
  }

  private async recordAuthFailure(key: string): Promise<{ locked: boolean; lockedUntil?: number }> {
    const storeKey = `auth:${key}`;
    const data = (await this.state.storage.get<{ attempts: number; lockedUntil?: number }>(storeKey)) ?? { attempts: 0 };

    if (data.lockedUntil && data.lockedUntil > Date.now()) {
      return { locked: true, lockedUntil: data.lockedUntil };
    }

    data.attempts++;
    if (data.attempts >= AUTH_LOCKOUT_ATTEMPTS) {
      data.lockedUntil = Date.now() + AUTH_LOCKOUT_MS;
      data.attempts = 0;
    }

    await this.state.storage.put(storeKey, data);
    return { locked: !!data.lockedUntil && data.lockedUntil > Date.now(), lockedUntil: data.lockedUntil };
  }

  private async consumeJti(jti: string): Promise<{ consumed: boolean }> {
    const storeKey = `jti:${jti}`;
    const existing = await this.state.storage.get<number>(storeKey);
    if (existing) {
      return { consumed: true }; // already used
    }
    // Mark as consumed, set alarm for cleanup (30s TTL)
    await this.state.storage.put(storeKey, Date.now() + 30_000);
    // Clean up expired jti entries
    const allEntries = await this.state.storage.list<number>({ prefix: 'jti:' });
    const now = Date.now();
    const expired: string[] = [];
    for (const [key, expiresAt] of allEntries) {
      if (expiresAt < now) expired.push(key);
    }
    if (expired.length > 0) await this.state.storage.delete(expired);
    return { consumed: false }; // first use, now consumed
  }

  private async checkAuthLockout(key: string): Promise<{ locked: boolean; lockedUntil?: number }> {
    const storeKey = `auth:${key}`;
    const data = await this.state.storage.get<{ attempts: number; lockedUntil?: number }>(storeKey);
    if (!data) return { locked: false };
    const locked = !!data.lockedUntil && data.lockedUntil > Date.now();
    return { locked, lockedUntil: locked ? data.lockedUntil : undefined };
  }
}
