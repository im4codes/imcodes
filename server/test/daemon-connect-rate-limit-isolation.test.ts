import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { setupWebSocketUpgrade } from '../src/index.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';

/**
 * One daemon must never be able to rate-limit another off the server.
 *
 * This budget was keyed on the client IP. In production `TRUSTED_PROXIES` is
 * empty, so `proxyAddr` returns the reverse proxy's own address and every
 * daemon collapsed onto a single key — one shared bucket of 5 upgrades per 10s
 * for the entire fleet. A controlled node whose token had been revoked retried
 * roughly twice a second and consumed ~17 attempts per 10s on its own, so every
 * other daemon was answered 429. That is a non-101 status, which the client
 * reports as WebSocket close 1002, and the whole fleet went offline while each
 * node's log showed only "Received network error or non-101 status code".
 *
 * The fixture keeps `TRUSTED_PROXIES: ''` precisely because that is the
 * production condition that made the bug reachable.
 */

const db = {
  queryOne: async () => null,
  query: async () => [],
  execute: async () => undefined,
} as unknown as Database;

function makeEnv(): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '0',
    NODE_ENV: 'development',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
  } as Env;
}

type Attempt = { opened: boolean; statusCode?: number; retryAfter?: string };

function attempt(port: number, serverId: string): Promise<Attempt> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/server/${serverId}/ws`);
    let settled = false;
    const done = (result: Attempt) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* already closed */ }
      resolve(result);
    };
    ws.on('unexpected-response', (_req, res) => done({
      opened: false,
      statusCode: res.statusCode,
      retryAfter: res.headers['retry-after'] as string | undefined,
    }));
    ws.on('error', () => done({ opened: false }));
    ws.on('open', () => done({ opened: true }));
    setTimeout(() => done({ opened: false }), 2_000);
  });
}

/** Drive one daemon past its per-daemon budget (5 per 10s). */
async function exhaust(port: number, serverId: string, times = 8): Promise<Attempt[]> {
  const out: Attempt[] = [];
  for (let i = 0; i < times; i++) out.push(await attempt(port, serverId));
  return out;
}

describe('daemon connect rate limit is per daemon, not per IP', () => {
  let httpServer: HttpServer;
  let port: number;

  beforeEach(async () => {
    httpServer = createServer();
    setupWebSocketUpgrade(httpServer, makeEnv());
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = (httpServer.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('a daemon that exhausts its budget does not lock out a different daemon on the same IP', async () => {
    const noisy = `aaaaaaaa${Date.now().toString(16)}`.slice(0, 32);
    const quiet = `bbbbbbbb${Date.now().toString(16)}`.slice(0, 32);

    const noisyAttempts = await exhaust(port, noisy);
    expect(
      noisyAttempts.some((a) => a.statusCode === 429),
      'the noisy daemon must still be rate limited — isolation is not an exemption',
    ).toBe(true);

    // Same source address, different daemon. This is the whole property.
    const victim = await attempt(port, quiet);
    expect(
      victim.statusCode,
      'a well-behaved daemon must not inherit another daemon exhausted budget',
    ).not.toBe(429);
  });

  it('answers a refused upgrade with Retry-After so the client can back off', async () => {
    const noisy = `cccccccc${Date.now().toString(16)}`.slice(0, 32);
    const attempts = await exhaust(port, noisy);
    const refused = attempts.find((a) => a.statusCode === 429);
    expect(refused, 'expected at least one refusal to inspect').toBeTruthy();
    // Without this the daemon cannot tell a rate-limit refusal from a network
    // fault, so it retries on its short reconnect backoff and keeps the budget
    // exhausted — the feedback loop that made a single bad node fleet-fatal.
    expect(refused!.retryAfter, 'a 429 must tell the client when to return').toBeTruthy();
  });

  it('still bounds abuse from one source across rotating daemon ids', async () => {
    // serverId is unauthenticated at upgrade time, so per-daemon isolation
    // alone would let one source rotate ids forever. The per-IP ceiling is what
    // keeps that bounded; it sits far above any real fleet's steady state.
    let refusals = 0;
    for (let i = 0; i < 130; i++) {
      const rotating = `d${i.toString().padStart(31, '0')}`;
      const a = await attempt(port, rotating);
      if (a.statusCode === 429) refusals++;
    }
    expect(refusals, 'rotating ids from one source must eventually be refused').toBeGreaterThan(0);
  });
});
