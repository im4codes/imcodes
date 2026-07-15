import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { COOKIE_SESSION } from '../../shared/cookie-names.js';
import type { Env } from '../src/env.js';
import { csrfMiddleware } from '../src/security/csrf.js';

const env = {
  NODE_ENV: 'production',
  SERVER_URL: 'https://im.codes',
  ALLOWED_ORIGINS: 'https://im.codes',
} as Env;

function buildCsrfTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('/api/*', csrfMiddleware());
  app.post('/api/enroll/v2/download', (c) => c.json({ reached: 'download' }));
  app.post('/api/preferences/test', (c) => c.json({ reached: 'preferences' }));
  return app;
}

describe('CSRF capability endpoint exemptions', () => {
  it('allows the form-based controlled-node download despite an isolated null origin', async () => {
    const response = await buildCsrfTestApp().request('/api/enroll/v2/download', {
      method: 'POST',
      headers: {
        cookie: `${COOKIE_SESSION}=browser-session-cookie`,
        origin: 'null',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'ticket=short-lived-capability',
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reached: 'download' });
  });

  it('continues to reject an invalid origin on cookie-authenticated writes', async () => {
    const response = await buildCsrfTestApp().request('/api/preferences/test', {
      method: 'POST',
      headers: {
        cookie: `${COOKIE_SESSION}=browser-session-cookie`,
        origin: 'null',
      },
    }, env);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'csrf_rejected', reason: 'invalid_origin' });
  });
});
