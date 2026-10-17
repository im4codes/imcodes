import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';

const mocks = vi.hoisted(() => ({
  resolveNative: vi.fn(),
  issue: vi.fn(),
  redeem: vi.fn(),
}));

vi.mock('../src/services/remote-desktop-account-auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/remote-desktop-account-auth.js')>();
  return {
    ...original,
    resolveNativeShellSession: (...args: unknown[]) => mocks.resolveNative(...args),
    nativeShellIssuer: () => 'https://imcodes.test',
  };
});

vi.mock('../src/services/remote-desktop-shell-launch-context.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/remote-desktop-shell-launch-context.js')>();
  return {
    ...original,
    issueRemoteDesktopShellLaunchContext: (...args: unknown[]) => mocks.issue(...args),
    redeemRemoteDesktopShellLaunchContext: (...args: unknown[]) => mocks.redeem(...args),
  };
});

import { createRemoteDesktopShellLaunchContextRoutes } from '../src/routes/remote-desktop-shell-launch-context.js';

const dispatcher = {
  currentControlledEndpoint: vi.fn(async () => ({ serverId: 'controlled-1', endpointGeneration: 7 })),
  dispatch: vi.fn(async () => true),
};
const env = {
  DB: {},
  JWT_SIGNING_KEY: 'jwt',
  SERVER_URL: 'https://imcodes.test',
} as unknown as Env;

function app() {
  const value = new Hono<{ Bindings: Env }>();
  value.route('/api/auth/remote-desktop', createRemoteDesktopShellLaunchContextRoutes(dispatcher));
  return value;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app().request(`/api/auth/remote-desktop${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }, env);
}

describe('remote desktop shell launch-context routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveNative.mockResolvedValue(null);
    mocks.issue.mockResolvedValue({ status: 'accepted', expiresAt: 1234 });
  });

  it('rejects browser-cookie, node/local/guest bearer and missing authority without fallback', async () => {
    for (const headers of [
      { cookie: 'session=browser' },
      { authorization: 'Bearer node-token', cookie: 'session=browser' },
      { authorization: 'Bearer guest-bootstrap' },
      { authorization: 'Bearer local-admin' },
    ]) {
      const response = await post('/shell/launch-context/issue', { hostId: 'host-1' }, headers);
      expect(response.status).toBe(401);
    }
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.resolveNative).toHaveBeenCalledTimes(4);
  });

  it('returns no raw context even to the qualified native session', async () => {
    mocks.resolveNative.mockResolvedValue({ kind: 'native', id: 'native-1', userId: 'owner-1' });
    const response = await post('/shell/launch-context/issue', { hostId: 'host-1' }, {
      authorization: 'Bearer rdsn_native',
    });
    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ status: 'accepted', expiresAt: 1234 });
    expect(body).not.toHaveProperty('launchId');
    expect(body).not.toHaveProperty('context');
  });

  it('requires exact issue keys and exposes no standalone redemption endpoint', async () => {
    mocks.resolveNative.mockResolvedValue({ kind: 'native', id: 'native-1', userId: 'owner-1' });
    expect((await post('/shell/launch-context/issue', { hostId: 'host-1', admin: true }, {
      authorization: 'Bearer rdsn_native',
    })).status).toBe(400);
    const response = await post('/shell/launch-context/redeem', {
      hostId: 'host-1', launchId: 'launch-1', issuedAt: 1000,
      expiresAt: 2000, endpointGeneration: 7,
    }, {
      authorization: 'Bearer rdsn_native',
    });
    expect(response.status).toBe(404);
    expect(mocks.redeem).not.toHaveBeenCalled();
  });
});
