import { describe, it, expect } from 'vitest';
import { sessionMgmtRoutes } from '../../src/routes/session-mgmt.js';
import { Hono } from 'hono';

describe('sessionMgmtRoutes', () => {
  it('is exported and is a Hono instance', () => {
    expect(sessionMgmtRoutes).toBeInstanceOf(Hono);
  });

  it('has POST /:id/session/start route', () => {
    const routes = sessionMgmtRoutes.routes;
    const route = routes.find(
      (r) => r.method === 'POST' && r.path === '/:id/session/start',
    );
    expect(route).toBeDefined();
  });

  it('has POST /:id/session/stop route', () => {
    const routes = sessionMgmtRoutes.routes;
    const route = routes.find(
      (r) => r.method === 'POST' && r.path === '/:id/session/stop',
    );
    expect(route).toBeDefined();
  });

  it('has POST /:id/session/send route', () => {
    const routes = sessionMgmtRoutes.routes;
    const route = routes.find(
      (r) => r.method === 'POST' && r.path === '/:id/session/send',
    );
    expect(route).toBeDefined();
  });

  it('has exactly 3 routes registered', () => {
    // start, stop, send — each as POST
    const postRoutes = sessionMgmtRoutes.routes.filter(
      (r) => r.method === 'POST',
    );
    expect(postRoutes).toHaveLength(3);
  });

  it('all session routes use the :id param pattern', () => {
    const routes = sessionMgmtRoutes.routes.filter((r) => r.method === 'POST');
    for (const route of routes) {
      expect(route.path).toMatch(/^\/:id\/session\//);
    }
  });

  it('route paths cover start, stop, and send commands', () => {
    const paths = sessionMgmtRoutes.routes
      .filter((r) => r.method === 'POST')
      .map((r) => r.path);
    expect(paths).toContain('/:id/session/start');
    expect(paths).toContain('/:id/session/stop');
    expect(paths).toContain('/:id/session/send');
  });
});
