import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';

const mocks = vi.hoisted(() => ({
  browserSession: vi.fn(),
  nativeSession: vi.fn(),
  mutatePassword: vi.fn(),
}));

vi.mock('../src/services/remote-desktop-account-auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/remote-desktop-account-auth.js')>();
  return {
    ...original,
    nativeShellIssuer: () => 'https://imcodes.test',
    resolveBrowserAccountSession: (...args: unknown[]) => mocks.browserSession(...args),
    resolveNativeShellSession: (...args: unknown[]) => mocks.nativeSession(...args),
  };
});

vi.mock('../src/services/remote-desktop-unattended-password.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/remote-desktop-unattended-password.js')>();
  return {
    ...original,
    selectUnattendedPasswordServerSecret: () => 'server-secret-at-least-32-bytes-long',
    createServerUnattendedPasswordPepperRing: () => ({ currentVersion: 'test' }),
    mutateUnattendedPassword: (...args: unknown[]) => mocks.mutatePassword(...args),
  };
});

import { remoteDesktopUnattendedPasswordRoutes } from '../src/routes/remote-desktop-unattended-password.js';
import {
  UNATTENDED_PASSWORD_MUTATION_ERROR,
  UnattendedPasswordMutationError,
} from '../src/services/remote-desktop-unattended-password.js';

const HOST_ID = 'host_00000000001';
const PASSWORD = 'Correct horse 4! battery';
const NEXT_PASSWORD = 'Different horse 5! battery';
const PRIVACY_EPOCH = { epochId: 'epoch_00000000001', revision: 7 };
const NATIVE_SESSION = { kind: 'native' as const, id: 'native-session', userId: 'owner-1' };
const DB = {};
const ENV = {
  DB,
  BOT_ENCRYPTION_KEY: 'bot-secret-at-least-32-bytes-long',
  JWT_SIGNING_KEY: 'jwt-secret-at-least-32-bytes-long',
  SERVER_URL: 'https://imcodes.test',
} as unknown as Env;

function app() {
  const value = new Hono<{ Bindings: Env }>();
  value.route('/api', remoteDesktopUnattendedPasswordRoutes);
  return value;
}

function mutate(
  mutation: Record<string, unknown>,
  stepUpGrant: string,
  headers: Record<string, string> = { authorization: 'Bearer rdsn_native' },
) {
  return app().request('/api/remote-desktop/unattended-password', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ mutation, privacyEpoch: PRIVACY_EPOCH, stepUpGrant }),
  }, ENV);
}

describe('signed-shell Owner unattended-password route parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nativeSession.mockResolvedValue(NATIVE_SESSION);
    mocks.browserSession.mockResolvedValue(null);
    mocks.mutatePassword.mockImplementation(async (input: {
      mutation: { action: 'set' | 'change' | 'disable' };
    }) => ({
      ok: true,
      replayed: false,
      result: {
        hostId: HOST_ID,
        generation: input.mutation.action === 'set' ? 1 : 2,
        state: input.mutation.action === 'disable' ? 'disabled' : 'enabled',
        effectsEmitted: 0,
      },
    }));
  });

  it('uses the same Owner route for native set/change/disable with fresh grants and exact privacy', async () => {
    const cases = [
      {
        hostId: HOST_ID, action: 'set', requestId: 's'.repeat(43), password: PASSWORD,
        stepUpGrant: 'rdsg_native_password_set',
      },
      {
        hostId: HOST_ID, action: 'change', requestId: 'c'.repeat(43), password: NEXT_PASSWORD,
        stepUpGrant: 'rdsg_native_password_change',
      },
      {
        hostId: HOST_ID, action: 'disable', requestId: 'd'.repeat(43),
        stepUpGrant: 'rdsg_native_password_disable',
      },
    ] as const;

    for (const input of cases) {
      const { stepUpGrant, ...mutation } = input;
      const response = await mutate(mutation, stepUpGrant);
      const body = await response.json();
      expect(response.status, `${input.action}: ${JSON.stringify(body)}`).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(JSON.stringify(body)).not.toContain(PASSWORD);
      expect(JSON.stringify(body)).not.toContain(NEXT_PASSWORD);
      expect(body).not.toHaveProperty('password');
      expect(mocks.mutatePassword).toHaveBeenLastCalledWith(expect.objectContaining({
        db: DB,
        accountSession: NATIVE_SESSION,
        mutation,
        privacyEpoch: PRIVACY_EPOCH,
        stepUpGrant,
      }));
    }

    expect(new Set(cases.map((entry) => entry.stepUpGrant)).size).toBe(cases.length);
    expect(mocks.mutatePassword).toHaveBeenCalledTimes(cases.length);
  });

  it('fails wrong-action or replayed grants closed and never echoes password bytes', async () => {
    mocks.mutatePassword.mockResolvedValue({ ok: false, error: 'invalid_grant' });
    for (const stepUpGrant of ['rdsg_wrong_action', 'rdsg_replayed']) {
      const response = await mutate({
        hostId: HOST_ID, action: 'change', requestId: 'c'.repeat(43), password: NEXT_PASSWORD,
      }, stepUpGrant);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body).toEqual({ error: UNATTENDED_PASSWORD_MUTATION_ERROR.STEP_UP });
      expect(JSON.stringify(body)).not.toContain(NEXT_PASSWORD);
    }
  });

  it('rejects logged-out, node-bearer and non-owner callers before password mutation', async () => {
    mocks.nativeSession.mockResolvedValue(null);
    mocks.browserSession.mockResolvedValue(null);
    const loggedOut = await mutate({
      hostId: HOST_ID, action: 'disable', requestId: 'd'.repeat(43),
    }, 'rdsg_disable', {});
    expect(loggedOut.status).toBe(401);
    expect(mocks.mutatePassword).not.toHaveBeenCalled();

    mocks.browserSession.mockClear();
    mocks.browserSession.mockResolvedValue({ kind: 'web', id: 'web-session', userId: 'owner-1' });
    const nodeBearer = await mutate({
      hostId: HOST_ID, action: 'disable', requestId: 'd'.repeat(43),
    }, 'rdsg_disable', {
      authorization: 'Bearer controlled-node-credential',
      cookie: 'rcc_session=valid-browser-session',
    });
    expect(nodeBearer.status).toBe(401);
    expect(mocks.browserSession).not.toHaveBeenCalled();
    expect(mocks.mutatePassword).not.toHaveBeenCalled();

    mocks.nativeSession.mockResolvedValue(NATIVE_SESSION);
    mocks.mutatePassword.mockRejectedValueOnce(
      new UnattendedPasswordMutationError(UNATTENDED_PASSWORD_MUTATION_ERROR.NOT_OWNER),
    );
    const nonOwner = await mutate({
      hostId: HOST_ID, action: 'disable', requestId: 'd'.repeat(43),
    }, 'rdsg_disable');
    expect(nonOwner.status).toBe(403);
    expect(await nonOwner.json()).toEqual({
      error: UNATTENDED_PASSWORD_MUTATION_ERROR.NOT_OWNER,
    });
  });

  it('rejects malformed or unshielded controlled-host mutation inputs without secret disclosure', async () => {
    const malformed = await mutate({
      hostId: HOST_ID,
      action: 'disable',
      requestId: 'd'.repeat(43),
      password: PASSWORD,
    }, 'rdsg_disable');
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(await malformed.json())).not.toContain(PASSWORD);
    expect(mocks.mutatePassword).not.toHaveBeenCalled();

    mocks.mutatePassword.mockRejectedValueOnce(
      new UnattendedPasswordMutationError(UNATTENDED_PASSWORD_MUTATION_ERROR.HOST_UNAVAILABLE),
    );
    const unqualified = await mutate({
      hostId: HOST_ID, action: 'set', requestId: 's'.repeat(43), password: PASSWORD,
    }, 'rdsg_native_password_set');
    expect(unqualified.status).toBe(409);
    expect(JSON.stringify(await unqualified.json())).not.toContain(PASSWORD);
  });
});
