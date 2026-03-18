import { describe, it, expect } from 'vitest';
import { teamRoutes } from '../../src/routes/team.js';
import { randomHex } from '../../src/security/crypto.js';
import { Hono } from 'hono';

describe('teamRoutes', () => {
  it('is a Hono instance', () => {
    expect(teamRoutes).toBeInstanceOf(Hono);
  });

  it('has POST / route for team creation', () => {
    const routes = teamRoutes.routes;
    const route = routes.find((r) => r.method === 'POST' && r.path === '/');
    expect(route).toBeDefined();
  });

  it('has GET /:id route for team details', () => {
    const routes = teamRoutes.routes;
    const route = routes.find((r) => r.method === 'GET' && r.path === '/:id');
    expect(route).toBeDefined();
  });

  it('has POST /:id/invite route for invite creation', () => {
    const routes = teamRoutes.routes;
    const route = routes.find(
      (r) => r.method === 'POST' && r.path === '/:id/invite',
    );
    expect(route).toBeDefined();
  });

  it('has POST /join/:token route for accepting invites', () => {
    const routes = teamRoutes.routes;
    const route = routes.find(
      (r) => r.method === 'POST' && r.path === '/join/:token',
    );
    expect(route).toBeDefined();
  });

  it('has POST /:id/join route (legacy join)', () => {
    const routes = teamRoutes.routes;
    const route = routes.find(
      (r) => r.method === 'POST' && r.path === '/:id/join',
    );
    expect(route).toBeDefined();
  });

  it('has PUT /:id/member/:memberId/role route for role changes', () => {
    const routes = teamRoutes.routes;
    const route = routes.find(
      (r) => r.method === 'PUT' && r.path === '/:id/member/:memberId/role',
    );
    expect(route).toBeDefined();
  });

  it('has DELETE /:id/member/:memberId route for removing members', () => {
    const routes = teamRoutes.routes;
    const route = routes.find(
      (r) =>
        r.method === 'DELETE' && r.path === '/:id/member/:memberId',
    );
    expect(route).toBeDefined();
  });
});

describe('randomHex for invite tokens', () => {
  it('generates a 32-char hex string for teamId (16 bytes)', () => {
    const teamId = randomHex(16);
    expect(teamId).toHaveLength(32);
    expect(teamId).toMatch(/^[0-9a-f]+$/);
  });

  it('generates a 48-char hex string for invite token (24 bytes)', () => {
    const token = randomHex(24);
    expect(token).toHaveLength(48);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it('invite token is unique per call', () => {
    const token1 = randomHex(24);
    const token2 = randomHex(24);
    expect(token1).not.toBe(token2);
  });

  it('teamId is unique per call', () => {
    const id1 = randomHex(16);
    const id2 = randomHex(16);
    expect(id1).not.toBe(id2);
  });
});
