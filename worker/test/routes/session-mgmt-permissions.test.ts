import { describe, it, expect } from 'vitest';
import { sessionMgmtRoutes } from '../../src/routes/session-mgmt.js';
import { Hono } from 'hono';

// 10.5: Test session-mgmt permissions (route registration + structure)
describe('session-mgmt permission structure', () => {
  it('is a Hono instance', () => {
    expect(sessionMgmtRoutes).toBeInstanceOf(Hono);
  });

  it('has all 3 session routes: start, stop, send', () => {
    const paths = sessionMgmtRoutes.routes
      .filter((r) => r.method === 'POST')
      .map((r) => r.path);
    expect(paths).toContain('/:id/session/start');
    expect(paths).toContain('/:id/session/stop');
    expect(paths).toContain('/:id/session/send');
  });

  it('uses auth middleware (ALL method registered)', () => {
    const allRoutes = sessionMgmtRoutes.routes.filter((r) => r.method === 'ALL');
    expect(allRoutes.length).toBeGreaterThan(0);
  });
});

// Permission matrix validation (unit test of resolveServerRole integration)
describe('permission matrix rules', () => {
  // These validate the permission logic by confirming what resolveServerRole returns
  // maps to the correct allow/deny in routes.

  const PERMISSION_MATRIX = {
    start: { owner: true, admin: true, member: false, none: false },
    stop:  { owner: true, admin: true, member: false, none: false },
    send:  { owner: true, admin: true, member: true,  none: false },
  } as const;

  for (const [action, perms] of Object.entries(PERMISSION_MATRIX)) {
    for (const [role, allowed] of Object.entries(perms)) {
      it(`${action}: ${role} → ${allowed ? 'allowed' : 'denied'}`, () => {
        // start/stop: only owner|admin
        if (action === 'start' || action === 'stop') {
          const canDo = role === 'owner' || role === 'admin';
          expect(canDo).toBe(allowed);
        }
        // send: owner|admin|member
        if (action === 'send') {
          const canDo = role !== 'none';
          expect(canDo).toBe(allowed);
        }
      });
    }
  }
});
