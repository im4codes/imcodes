import { describe, it, expect } from 'vitest';
import { cronApiRoutes } from '../../src/routes/cron-api.js';

describe('cronApiRoutes', () => {
  it('is exported from cron-api module', () => {
    expect(cronApiRoutes).toBeDefined();
  });

  it('is a Hono instance with HTTP method handlers', () => {
    expect(typeof cronApiRoutes.get).toBe('function');
    expect(typeof cronApiRoutes.post).toBe('function');
    expect(typeof cronApiRoutes.put).toBe('function');
    expect(typeof cronApiRoutes.delete).toBe('function');
  });

  it('has a fetch handler (is a valid ASGI-like app)', () => {
    // Hono apps expose a .fetch method for the runtime
    expect(typeof cronApiRoutes.fetch).toBe('function');
  });

  it('has routes registered (routes array is non-empty)', () => {
    // Hono instances expose internal routes via .routes
    const routes = (cronApiRoutes as unknown as { routes: unknown[] }).routes;
    expect(Array.isArray(routes)).toBe(true);
    expect(routes.length).toBeGreaterThan(0);
  });

  it('registers GET / route for listing cron jobs', () => {
    const routes = (cronApiRoutes as unknown as { routes: Array<{ method: string; path: string }> }).routes;
    const getRoot = routes.find((r) => r.method === 'GET' && r.path === '/');
    expect(getRoot).toBeDefined();
  });

  it('registers POST / route for creating cron jobs', () => {
    const routes = (cronApiRoutes as unknown as { routes: Array<{ method: string; path: string }> }).routes;
    const postRoot = routes.find((r) => r.method === 'POST' && r.path === '/');
    expect(postRoot).toBeDefined();
  });

  it('registers PUT /:id route for updating cron jobs', () => {
    const routes = (cronApiRoutes as unknown as { routes: Array<{ method: string; path: string }> }).routes;
    const putId = routes.find((r) => r.method === 'PUT' && r.path === '/:id');
    expect(putId).toBeDefined();
  });

  it('registers DELETE /:id route for deleting cron jobs', () => {
    const routes = (cronApiRoutes as unknown as { routes: Array<{ method: string; path: string }> }).routes;
    const deleteId = routes.find((r) => r.method === 'DELETE' && r.path === '/:id');
    expect(deleteId).toBeDefined();
  });
});
