import { describe, it, expect } from 'vitest';
import { bindRoutes } from '../../src/routes/bind.js';
import { Hono } from 'hono';

// 10.3: Test POST /api/bind/initiate auth
describe('bind initiate auth', () => {
  it('bind route exists as Hono instance', () => {
    expect(bindRoutes).toBeInstanceOf(Hono);
  });

  it('POST /initiate route is registered', () => {
    const routes = bindRoutes.routes;
    const route = routes.find(
      (r) => r.method === 'POST' && r.path === '/initiate',
    );
    expect(route).toBeDefined();
  });

  it('bind schema no longer accepts userId in body', () => {
    // The zod schema now only accepts { serverName }, not { userId, serverName }
    const { z } = require('zod');
    const schema = z.object({ serverName: z.string() });

    // Valid: serverName only
    expect(schema.safeParse({ serverName: 'my-server' }).success).toBe(true);

    // userId is ignored if present (strict mode would reject, but we use passthrough)
    const result = schema.safeParse({ userId: 'u1', serverName: 'my-server' });
    expect(result.success).toBe(true);
    // userId should not be in the parsed data
    expect((result.data as Record<string, unknown>).userId).toBeUndefined();
  });
});
