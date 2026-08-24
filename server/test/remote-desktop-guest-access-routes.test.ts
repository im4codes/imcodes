import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';

const mocks = vi.hoisted(() => ({
  challenge: vi.fn(), resolve: vi.fn(), list: vi.fn(), create: vi.fn(), mutate: vi.fn(),
  browserSession: vi.fn(), nativeSession: vi.fn(), hostSummary: vi.fn(), rotate: vi.fn(), clock: vi.fn(),
  executionEndpoint: vi.fn(), beginPrivacy: vi.fn(), endPrivacy: vi.fn(),
  beginPrivacyTx: vi.fn(), dispatchPrivacy: vi.fn(), endSignedPrivacy: vi.fn(),
  privacyState: vi.fn(), markRecovery: vi.fn(), redeemLaunch: vi.fn(),
}));

vi.mock('../src/services/remote-desktop-guest-bootstrap.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/remote-desktop-guest-bootstrap.js')>();
  return {
    ...original,
    issueClaimChallenge: (...args: unknown[]) => mocks.challenge(...args),
    resolveLinkProof: (...args: unknown[]) => mocks.resolve(...args),
  };
});

vi.mock('../src/services/remote-desktop-guest-links.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/remote-desktop-guest-links.js')>();
  return {
    ...original,
    listOwnerLinks: (...args: unknown[]) => mocks.list(...args),
    createGuestLink: (...args: unknown[]) => mocks.create(...args),
    mutateGuestLink: (...args: unknown[]) => mocks.mutate(...args),
  };
});

vi.mock('../src/services/remote-desktop-account-auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/remote-desktop-account-auth.js')>();
  return {
    ...original,
    nativeShellIssuer: () => 'https://issuer.test',
    resolveBrowserAccountSession: (...args: unknown[]) => mocks.browserSession(...args),
    resolveNativeShellSession: (...args: unknown[]) => mocks.nativeSession(...args),
  };
});

vi.mock('../src/services/remote-desktop-owner-management.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/remote-desktop-owner-management.js')>();
  return {
    ...original,
    getOwnerRemoteDesktopHostSummary: (...args: unknown[]) => mocks.hostSummary(...args),
    rotateOwnerPublicNodeId: (...args: unknown[]) => mocks.rotate(...args),
  };
});

vi.mock('../src/services/remote-desktop-guest-due-worker.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/remote-desktop-guest-due-worker.js')>();
  return { ...original, readDatabaseClock: (...args: unknown[]) => mocks.clock(...args) };
});

vi.mock('../src/services/remote-desktop-host-identity.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/remote-desktop-host-identity.js')>();
  return { ...original, resolveExecutionEndpoint: (...args: unknown[]) => mocks.executionEndpoint(...args) };
});

vi.mock('../src/services/remote-desktop-management-privacy.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/remote-desktop-management-privacy.js')>();
  return {
    ...original,
    beginPrivacyEpoch: (...args: unknown[]) => mocks.beginPrivacy(...args),
    beginPrivacyEpochTx: (...args: unknown[]) => mocks.beginPrivacyTx(...args),
    dispatchBeginPrivacyEpochEffects: (...args: unknown[]) => mocks.dispatchPrivacy(...args),
    endManagementWebPrivacy: (...args: unknown[]) => mocks.endPrivacy(...args),
    endSignedShellPrivacy: (...args: unknown[]) => mocks.endSignedPrivacy(...args),
    getPrivacyState: (...args: unknown[]) => mocks.privacyState(...args),
    markRecoveryRequired: (...args: unknown[]) => mocks.markRecovery(...args),
  };
});

vi.mock('../src/services/remote-desktop-shell-launch-context.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/remote-desktop-shell-launch-context.js')>();
  return {
    ...original,
    getRemoteDesktopShellLaunchContextDispatcher: () => ({
      currentControlledEndpoint: vi.fn(), dispatch: vi.fn(),
    }),
    redeemRemoteDesktopShellLaunchContext: (...args: unknown[]) => mocks.redeemLaunch(...args),
  };
});

import { remoteDesktopGuestAccessRoutes } from '../src/routes/remote-desktop-guest-access.js';
import { PUBLIC_UNAVAILABLE } from '../src/services/remote-desktop-guest-bootstrap.js';
import { LINK_REFUSAL, LinkAuthorityError } from '../src/services/remote-desktop-guest-links.js';
import {
  OWNER_HOST_MANAGEMENT_ERROR,
  OwnerHostManagementError,
} from '../src/services/remote-desktop-owner-management.js';

const FAIL = { ok: false as const, body: PUBLIC_UNAVAILABLE };
const THUMBPRINT = 'a'.repeat(43);
const HOST_ID = 'host_00000000001';
const LINK_ID = 'link_00000000001';
const PROOF = {
  keyAlgorithm: 'ECDSA_P256_SHA256',
  challengeId: 'b'.repeat(43),
  challenge: 'c'.repeat(43),
  browserPublicKeySpki: 'd'.repeat(122),
  browserKeyThumbprint: THUMBPRINT,
  signature: 'e'.repeat(86),
};

function app() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api', remoteDesktopGuestAccessRoutes);
  return app;
}

const DB = {
  queryOne: vi.fn(async (sql: string) => (
    sql.includes('FROM api_keys') ? { id: 'mobile-key-1', user_id: 'owner-1' } : null
  )),
  transaction: async (fn: (db: unknown) => Promise<unknown>) => fn({}),
};
const ENV = {
  DB,
  JWT_SIGNING_KEY: 'jwt-secret',
  SERVER_URL: 'https://imcodes.test',
} as unknown as Env;

function post(body: unknown, path = 'resolve') {
  return app().request(`/api/remote-desktop/guest/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, ENV);
}

describe('remote desktop guest access routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue(FAIL);
    mocks.challenge.mockResolvedValue({
      keyAlgorithm: PROOF.keyAlgorithm,
      challengeId: PROOF.challengeId,
      challenge: PROOF.challenge,
      expiresAt: 1_000,
    });
    mocks.nativeSession.mockResolvedValue(null);
    mocks.browserSession.mockResolvedValue({ kind: 'web', id: 'web-session', userId: 'owner-1' });
    mocks.clock.mockResolvedValue(1_700_000_000_000);
    mocks.hostSummary.mockResolvedValue({ hostId: HOST_ID, publicNodeId: '5000000001', mergeState: 'resolved' });
    mocks.executionEndpoint.mockResolvedValue({ serverId: 'server-1', role: 'controlled' });
    mocks.beginPrivacy.mockResolvedValue({ epochId: 'epoch_00000000001', revision: 4, phase: 'active' });
    mocks.endPrivacy.mockResolvedValue({ phase: 'idle', admissionOpen: true });
    mocks.beginPrivacyTx.mockResolvedValue({
      epochId: 'epoch_00000000001', revision: 5, phase: 'active',
      cancelledPending: [], shieldedActive: [],
    });
    mocks.dispatchPrivacy.mockResolvedValue(undefined);
    mocks.endSignedPrivacy.mockResolvedValue({ phase: 'ending', admissionOpen: false });
    mocks.privacyState.mockResolvedValue({
      epochId: 'epoch_00000000001', revision: 5, phase: 'active', admissionOpen: false,
      presentationSource: 'signed_shell', daemonGeneration: 7,
    });
    mocks.markRecovery.mockResolvedValue(undefined);
    mocks.redeemLaunch.mockImplementation(async (input: {
      onRedeemedTx: (tx: unknown, binding: unknown) => Promise<unknown>;
    }) => {
      const binding = {
        ownerUserId: 'owner-1', nativeSessionId: 'native-session', hostId: HOST_ID,
        executionServerId: 'server-1', endpointGeneration: 7,
        issuedAt: 1_700_000_000_000, expiresAt: 1_700_000_060_000,
      };
      return { binding, result: await input.onRedeemedTx({}, binding) };
    });
    mocks.create.mockResolvedValue({ link: { id: LINK_ID, hostId: HOST_ID }, replayed: false });
    mocks.mutate.mockResolvedValue({ link: { id: LINK_ID, hostId: HOST_ID }, effectsEmitted: 0 });
  });

  it('issues the same bounded challenge shape without disclosing link identity', async () => {
    const response = await post({ token: 'x'.repeat(43) }, 'challenge');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      keyAlgorithm: PROOF.keyAlgorithm,
      challengeId: PROOF.challengeId,
      challenge: PROOF.challenge,
      expiresAt: 1_000,
    });
    expect(mocks.challenge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ token: 'x'.repeat(43) }),
    );
  });

  it('serves the pre-app fragment bootstrap path with the same bounded challenge', async () => {
    const response = await post({ token: 'x'.repeat(43) }, 'link/bootstrap');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      keyAlgorithm: PROOF.keyAlgorithm,
      challengeId: PROOF.challengeId,
      challenge: PROOF.challenge,
      expiresAt: 1_000,
    });
    expect(mocks.challenge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ token: 'x'.repeat(43) }),
    );
  });

  it('returns one identical body for every pre-proof failure', async () => {
    // Bad shape, absent link, revoked link and expired link must be
    // indistinguishable — including by status code, which is why each is
    // asserted rather than just the JSON.
    const cases: unknown[] = [
      'not json at all',
      {},
      { ...PROOF, signature: '' },
      { ...PROOF, browserKeyThumbprint: '' },
      PROOF,
    ];
    const seen = new Set<string>();
    for (const body of cases) {
      const response = await post(body);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      seen.add(`${response.status}|${JSON.stringify(await response.json())}`);
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe(`200|${JSON.stringify(PUBLIC_UNAVAILABLE)}`);
  });

  it('never leaks a target through a widened failure body', async () => {
    // A future edit that returns richer failure detail must be caught here, not
    // in production. The route re-checks the body against the shared predicate.
    mocks.resolve.mockResolvedValue({
      ok: false,
      body: { status: 'unavailable', serverId: 'srv-secret', hostId: 'host-secret' },
    });
    const response = await post(PROOF);
    expect(await response.json()).toEqual(PUBLIC_UNAVAILABLE);
    expect(JSON.stringify(await post(PROOF).then(r => r.json())))
      .not.toContain('srv-secret');
  });

  it('discloses the routing key and a one-shot ticket only after proof succeeds', async () => {
    mocks.resolve.mockResolvedValue({
      ok: true,
      serverId: 'srv-1', hostId: 'host-1', bootstrapTicket: 'ticket-raw',
      expiresAt: 1000, mode: 'view', source: 'attended_link',
    });
    const response = await post(PROOF);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ready', serverId: 'srv-1', hostId: 'host-1',
      bootstrapTicket: 'ticket-raw', expiresAt: 1000, mode: 'view', source: 'attended_link',
    });
  });

  it('passes only the exact key proof without trusting caller-supplied identity', async () => {
    await post(PROOF);
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ proof: PROOF }),
    );
    expect(mocks.resolve.mock.calls[0][1]).not.toHaveProperty('serverId');
  });

  it('scopes the Owner inventory to the authenticated user', async () => {
    mocks.list.mockResolvedValue([{
      id: LINK_ID, label: 'laptop', tokenHash: 'forbidden-hash', browserPrivateKey: 'forbidden-key',
      connectionAudit: {
        connectionCount: 1,
        totalDurationMs: 60_000,
        lastConnectedAt: 1_700_000_000_000,
        recentConnections: [{
          ipAddress: '203.0.113.42',
          connectedAt: 1_700_000_000_000,
          disconnectedAt: 1_700_000_060_000,
          durationMs: 60_000,
          sessionId: 'forbidden-session-id',
        }],
      },
    }]);
    const response = await app().request(`/api/remote-desktop/guest/links?hostId=${HOST_ID}`, {}, ENV);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ links: [{
      id: LINK_ID,
      label: 'laptop',
      connectionAudit: {
        connectionCount: 1,
        totalDurationMs: 60_000,
        lastConnectedAt: 1_700_000_000_000,
        recentConnections: [{
          ipAddress: '203.0.113.42',
          connectedAt: 1_700_000_000_000,
          disconnectedAt: 1_700_000_060_000,
          durationMs: 60_000,
        }],
      },
    }] });
    expect(mocks.list).toHaveBeenCalledWith(expect.anything(), { ownerUserId: 'owner-1', hostId: HOST_ID });
  });

  it('begins and ends the production management-Web no-route privacy gate', async () => {
    const beginResponse = await post({ hostId: HOST_ID }, 'privacy/begin');
    expect(beginResponse.status).toBe(200);
    expect(beginResponse.headers.get('cache-control')).toBe('no-store');
    expect(await beginResponse.json()).toEqual({ epochId: 'epoch_00000000001', revision: 4 });
    expect(mocks.beginPrivacy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      hostId: HOST_ID,
      presentationSource: 'management_web',
      executionServerId: 'server-1',
      daemonGeneration: null,
      initiatingSessionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));

    const endResponse = await post({
      hostId: HOST_ID,
      epochId: 'epoch_00000000001',
      revision: 4,
    }, 'privacy/end');
    expect(endResponse.status).toBe(200);
    expect(await endResponse.json()).toEqual({ status: 'ended' });
    expect(mocks.endPrivacy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      hostId: HOST_ID,
      epochId: 'epoch_00000000001',
      revision: 4,
    }));
  });

  it('fails privacy begin closed and never falls back from invalid Bearer to Cookie', async () => {
    mocks.nativeSession.mockResolvedValue(null);
    const unauthorized = await app().request('/api/remote-desktop/guest/privacy/begin', {
      method: 'POST',
      headers: { authorization: 'Bearer node-credential', 'content-type': 'application/json' },
      body: JSON.stringify({ hostId: HOST_ID }),
    }, ENV);
    expect(unauthorized.status).toBe(401);
    expect(mocks.browserSession).not.toHaveBeenCalled();
    expect(mocks.beginPrivacy).not.toHaveBeenCalled();
  });

  it('binds native signed-shell privacy begin to one exact launch context', async () => {
    mocks.nativeSession.mockResolvedValue({ kind: 'native', id: 'native-session', userId: 'owner-1' });
    const launchContext = {
      hostId: HOST_ID,
      launchId: 'launch_00000000001',
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_060_000,
      endpointGeneration: 7,
    };
    const response = await app().request('/api/remote-desktop/guest/privacy/begin', {
      method: 'POST',
      headers: { authorization: 'Bearer native', 'content-type': 'application/json' },
      body: JSON.stringify({ hostId: HOST_ID, launchContext }),
    }, ENV);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      epochId: 'epoch_00000000001', revision: 5, phase: 'active',
    });
    expect(mocks.redeemLaunch).toHaveBeenCalledWith(expect.objectContaining({
      accountSession: expect.objectContaining({ kind: 'native' }),
      context: launchContext,
    }));
    expect(mocks.beginPrivacyTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      hostId: HOST_ID,
      presentationSource: 'signed_shell',
      executionServerId: 'server-1',
      daemonGeneration: 7,
    }));
    expect(mocks.dispatchPrivacy).toHaveBeenCalledOnce();

    const status = await app().request(
      `/api/remote-desktop/guest/privacy/status?hostId=${HOST_ID}&epochId=epoch_00000000001&revision=5`,
      { headers: { authorization: 'Bearer native' } },
      ENV,
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: 'active' });

    const end = await app().request('/api/remote-desktop/guest/privacy/end', {
      method: 'POST',
      headers: { authorization: 'Bearer native', 'content-type': 'application/json' },
      body: JSON.stringify({ hostId: HOST_ID, epochId: 'epoch_00000000001', revision: 5 }),
    }, ENV);
    expect(end.status).toBe(200);
    expect(await end.json()).toEqual({ status: 'ending' });
    expect(mocks.endSignedPrivacy).toHaveBeenCalledOnce();
  });

  it('lets only the current native signed-shell epoch enter durable recovery-required', async () => {
    const nativeSession = { kind: 'native' as const, id: 'native-session', userId: 'owner-1' };
    mocks.nativeSession.mockResolvedValue(nativeSession);
    const response = await app().request('/api/remote-desktop/guest/privacy/recovery', {
      method: 'POST',
      headers: { authorization: 'Bearer rdsn_native', 'content-type': 'application/json' },
      body: JSON.stringify({
        hostId: HOST_ID,
        epochId: 'epoch_00000000001',
        revision: 5,
        endpointGeneration: 7,
        reason: 'clipboard_cleanup_uncertain',
      }),
    }, ENV);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'recovery_required' });
    expect(mocks.hostSummary).toHaveBeenCalledWith(expect.anything(), {
      accountSession: nativeSession, hostId: HOST_ID,
    });
    expect(mocks.markRecovery).toHaveBeenCalledWith(expect.anything(), {
      hostId: HOST_ID,
      epochId: 'epoch_00000000001',
      reason: 'clipboard_cleanup_uncertain',
      now: 1_700_000_000_000,
      expectedRevision: 5,
      expectedDaemonGeneration: 7,
      expectedPresentationSource: 'signed_shell',
    });
  });

  it('rejects browser, node, foreign-owner, malformed and stale recovery reports', async () => {
    const exactBody = {
      hostId: HOST_ID,
      epochId: 'epoch_00000000001',
      revision: 5,
      endpointGeneration: 7,
      reason: 'clipboard_watchdog_crashed',
    };
    const request = (body: unknown, headers: Record<string, string>) => app().request(
      '/api/remote-desktop/guest/privacy/recovery',
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      ENV,
    );

    mocks.nativeSession.mockResolvedValue(null);
    expect((await request(exactBody, { cookie: 'session=browser' })).status).toBe(401);
    expect((await request(exactBody, {
      authorization: 'Bearer controlled-node-credential', cookie: 'session=browser',
    })).status).toBe(401);
    expect(mocks.browserSession).toHaveBeenCalledTimes(1);

    mocks.nativeSession.mockResolvedValue({ kind: 'native', id: 'native-session', userId: 'owner-2' });
    mocks.hostSummary.mockRejectedValueOnce(
      new OwnerHostManagementError(OWNER_HOST_MANAGEMENT_ERROR.UNAUTHORIZED),
    );
    const foreignOwner = await request(exactBody, { authorization: 'Bearer rdsn_foreign' });
    expect(foreignOwner.status).toBe(404);
    expect(await foreignOwner.json()).toEqual({ error: 'not_found_or_unauthorized' });

    mocks.nativeSession.mockResolvedValue({ kind: 'native', id: 'native-session', userId: 'owner-1' });
    for (const malformed of [
      { ...exactBody, extra: true },
      { ...exactBody, reason: 'caller_chosen_reason' },
      { ...exactBody, revision: 0 },
      { ...exactBody, endpointGeneration: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect((await request(malformed, { authorization: 'Bearer rdsn_native' })).status).toBe(400);
    }

    mocks.privacyState.mockResolvedValueOnce({
      epochId: exactBody.epochId,
      revision: exactBody.revision,
      phase: 'active',
      admissionOpen: false,
      presentationSource: 'signed_shell',
      daemonGeneration: exactBody.endpointGeneration + 1,
    });
    expect((await request(exactBody, { authorization: 'Bearer rdsn_native' })).status).toBe(409);

    mocks.privacyState.mockResolvedValueOnce({
      epochId: exactBody.epochId,
      revision: exactBody.revision + 1,
      phase: 'active',
      admissionOpen: false,
      presentationSource: 'signed_shell',
      daemonGeneration: exactBody.endpointGeneration,
    });
    expect((await request(exactBody, { authorization: 'Bearer rdsn_native' })).status).toBe(409);
    expect(mocks.markRecovery).not.toHaveBeenCalled();
  });

  it('answers a foreign host the same way it answers a missing one', async () => {
    mocks.list.mockRejectedValue(new LinkAuthorityError(LINK_REFUSAL.UNAUTHORIZED));
    const response = await app().request('/api/remote-desktop/guest/links?hostId=foreign_host_001', {}, ENV);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found_or_unauthorized' });
  });

  it('rejects daemon/local/guest authority because only account sessions are accepted', async () => {
    mocks.nativeSession.mockResolvedValue(null);
    const response = await app().request(`/api/remote-desktop/guest/links?hostId=${HOST_ID}`, {
      headers: { authorization: 'Bearer node-credential' },
    }, ENV);
    expect(response.status).toBe(401);
    expect(mocks.browserSession).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('creates from the exact shared hash-only request and never accepts a raw token field', async () => {
    mocks.create.mockResolvedValue({
      link: { id: LINK_ID, hostId: HOST_ID, rawToken: 'service-secret', tokenHash: 'b'.repeat(64) },
      replayed: false,
    });
    const request = {
      hostId: HOST_ID, creationRequestId: 'r'.repeat(43), tokenHashVersion: 'v1',
      tokenHash: 'a'.repeat(64), kind: 'attended', mode: 'control', label: 'desk',
    };
    const privacyEpoch = { epochId: 'epoch-1', revision: 3 };
    const response = await post({ request, privacyEpoch, stepUpGrant: 'rdsg_grant' }, 'links');
    expect(response.status).toBe(201);
    const responseBody = await response.json();
    expect(responseBody).toEqual({ link: { id: LINK_ID, hostId: HOST_ID }, replayed: false });
    expect(JSON.stringify(responseBody)).not.toContain('service-secret');
    expect(mocks.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: 'owner-1', accountSession: { kind: 'web', id: 'web-session', userId: 'owner-1' },
      ...request, privacy: privacyEpoch, stepUpToken: 'rdsg_grant', now: 1_700_000_000_000,
    }));
    expect(JSON.stringify(await post({ request: { ...request, token: 'raw-secret' }, privacyEpoch, stepUpGrant: 'x' }, 'links')
      .then((r) => r.json()))).not.toContain('raw-secret');
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('returns an exact retry as non-secret metadata without creating a second authority', async () => {
    mocks.create.mockResolvedValue({ link: { id: 'same-link', hostId: HOST_ID }, replayed: true });
    const response = await post({
      request: {
        hostId: HOST_ID, creationRequestId: 'r'.repeat(43), tokenHashVersion: 'v1',
        tokenHash: 'a'.repeat(64), kind: 'attended', mode: 'view', label: 'desk',
      },
      privacyEpoch: { epochId: 'epoch-1', revision: 1 }, stepUpGrant: 'same-grant',
    }, 'links');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ link: { id: 'same-link', hostId: HOST_ID }, replayed: true });
  });

  it('accepts only narrowing PATCH shapes and passes the current privacy epoch', async () => {
    const requestId = 'm'.repeat(43);
    const response = await app().request(`/api/remote-desktop/guest/links/${LINK_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostId: HOST_ID, requestId, mutation: 'reduce_to_view',
        privacyEpoch: { epochId: 'epoch-1', revision: 2 }, stepUpGrant: 'rdsg_reduce',
      }),
    }, ENV);
    expect(response.status).toBe(200);
    expect(mocks.mutate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: 'owner-1', hostId: HOST_ID, linkId: LINK_ID,
      mutation: 'reduce_to_view', requestId, stepUpToken: 'rdsg_reduce',
      privacy: { epochId: 'epoch-1', revision: 2 },
    }));

    const broaden = await app().request(`/api/remote-desktop/guest/links/${LINK_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostId: HOST_ID, requestId, mutation: 'reduce_to_view', mode: 'control',
        privacyEpoch: { epochId: 'epoch-1', revision: 2 }, stepUpGrant: 'rdsg_reduce',
      }),
    }, ENV);
    expect(broaden.status).toBe(400);
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  it('maps DELETE to revoke and preserves account-session parity for native shell', async () => {
    mocks.nativeSession.mockResolvedValue({ kind: 'native', id: 'native-session', userId: 'owner-1' });
    const response = await app().request(`/api/remote-desktop/guest/links/${LINK_ID}`, {
      method: 'DELETE', headers: { 'content-type': 'application/json', authorization: 'Bearer rdsn_token' },
      body: JSON.stringify({
        hostId: HOST_ID, requestId: 'd'.repeat(43),
        privacyEpoch: { epochId: 'epoch-1', revision: 4 }, stepUpGrant: 'rdsg_revoke',
      }),
    }, ENV);
    expect(response.status).toBe(200);
    expect(mocks.mutate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accountSession: { kind: 'native', id: 'native-session', userId: 'owner-1' },
      mutation: 'revoke', stepUpToken: 'rdsg_revoke',
    }));
  });

  it('routes the signed shell through the same Owner host/link APIs with controlled-host privacy', async () => {
    const nativeSession = { kind: 'native' as const, id: 'native-session', userId: 'owner-1' };
    const authorization = { authorization: 'Bearer rdsn_native' };
    mocks.nativeSession.mockResolvedValue(nativeSession);
    mocks.hostSummary.mockResolvedValue({
      hostId: HOST_ID, publicNodeId: '5837462190', mergeState: 'resolved',
    });
    mocks.list.mockResolvedValue([{
      id: LINK_ID, hostId: HOST_ID, label: 'desk', rawToken: 'must-not-render',
      tokenHash: 'f'.repeat(64), browserPrivateKey: 'must-not-render',
    }]);
    mocks.create.mockResolvedValue({
      link: {
        id: LINK_ID, hostId: HOST_ID, label: 'desk', rawToken: 'must-not-render',
        tokenHash: 'f'.repeat(64), password: 'must-not-render',
      },
      replayed: false,
    });

    const host = await app().request(
      `/api/remote-desktop/guest/host?hostId=${HOST_ID}`,
      { headers: authorization },
      ENV,
    );
    expect(host.status).toBe(200);
    expect(mocks.hostSummary).toHaveBeenCalledWith(expect.anything(), {
      accountSession: nativeSession, hostId: HOST_ID,
    });

    const rotateGrant = 'rdsg_native_rotate';
    const rotate = await app().request('/api/remote-desktop/guest/host/rotate', {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        hostId: HOST_ID, requestId: 'q'.repeat(43), stepUpGrant: rotateGrant,
      }),
    }, ENV);
    expect(rotate.status).toBe(200);
    expect(mocks.rotate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accountSession: nativeSession, stepUpToken: rotateGrant,
    }));

    const listed = await app().request(
      `/api/remote-desktop/guest/links?hostId=${HOST_ID}`,
      { headers: authorization },
      ENV,
    );
    expect(listed.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(expect.anything(), {
      ownerUserId: 'owner-1', hostId: HOST_ID,
    });
    expect(JSON.stringify(await listed.json())).not.toMatch(/must-not-render|tokenHash|privateKey/i);

    const privacyEpoch = { epochId: 'epoch-controlled-host', revision: 9 };
    const createGrant = 'rdsg_native_create';
    const created = await app().request('/api/remote-desktop/guest/links', {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        request: {
          hostId: HOST_ID, creationRequestId: 'c'.repeat(43), tokenHashVersion: 'v1',
          tokenHash: 'a'.repeat(64), kind: 'attended', mode: 'control', label: 'desk',
        },
        privacyEpoch,
        stepUpGrant: createGrant,
      }),
    }, ENV);
    expect(created.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accountSession: nativeSession,
      ownerUserId: 'owner-1',
      privacy: privacyEpoch,
      stepUpToken: createGrant,
    }));
    expect(JSON.stringify(await created.json())).not.toMatch(/must-not-render|tokenHash|password/i);

    const reduceGrant = 'rdsg_native_reduce';
    const reduced = await app().request(`/api/remote-desktop/guest/links/${LINK_ID}`, {
      method: 'PATCH',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        hostId: HOST_ID, requestId: 'm'.repeat(43), mutation: 'reduce_to_view',
        privacyEpoch, stepUpGrant: reduceGrant,
      }),
    }, ENV);
    expect(reduced.status).toBe(200);
    expect(mocks.mutate).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      accountSession: nativeSession,
      mutation: 'reduce_to_view',
      privacy: privacyEpoch,
      stepUpToken: reduceGrant,
    }));

    const revokeGrant = 'rdsg_native_revoke';
    const revoked = await app().request(`/api/remote-desktop/guest/links/${LINK_ID}`, {
      method: 'DELETE',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        hostId: HOST_ID, requestId: 'd'.repeat(43), privacyEpoch, stepUpGrant: revokeGrant,
      }),
    }, ENV);
    expect(revoked.status).toBe(200);
    expect(mocks.mutate).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      accountSession: nativeSession,
      mutation: 'revoke',
      privacy: privacyEpoch,
      stepUpToken: revokeGrant,
    }));

    expect(new Set([rotateGrant, createGrant, reduceGrant, revokeGrant]).size).toBe(4);
  });

  it('fails native Owner mutations closed for stale privacy, wrong action, non-owner and logged-out callers', async () => {
    const authorization = { authorization: 'Bearer rdsn_native' };
    mocks.nativeSession.mockResolvedValue({ kind: 'native', id: 'native-session', userId: 'owner-1' });
    mocks.create.mockRejectedValueOnce(new LinkAuthorityError(LINK_REFUSAL.PRIVACY_REQUIRED));
    const stalePrivacy = await app().request('/api/remote-desktop/guest/links', {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        request: {
          hostId: HOST_ID, creationRequestId: 'c'.repeat(43), tokenHashVersion: 'v1',
          tokenHash: 'a'.repeat(64), kind: 'attended', mode: 'view', label: 'desk',
        },
        privacyEpoch: { epochId: 'stale-epoch', revision: 1 },
        stepUpGrant: 'rdsg_native_create',
      }),
    }, ENV);
    expect(stalePrivacy.status).toBe(409);
    expect(await stalePrivacy.json()).toEqual({ error: 'privacy_required' });

    mocks.rotate.mockRejectedValueOnce(
      new OwnerHostManagementError(OWNER_HOST_MANAGEMENT_ERROR.STEP_UP_REQUIRED),
    );
    const wrongAction = await app().request('/api/remote-desktop/guest/host/rotate', {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        hostId: HOST_ID, requestId: 'q'.repeat(43), stepUpGrant: 'rdsg_for_other_action',
      }),
    }, ENV);
    expect(wrongAction.status).toBe(403);
    expect(await wrongAction.json()).toEqual({ error: 'step_up_required' });

    mocks.list.mockRejectedValueOnce(new LinkAuthorityError(LINK_REFUSAL.UNAUTHORIZED));
    const nonOwner = await app().request(
      `/api/remote-desktop/guest/links?hostId=${HOST_ID}`,
      { headers: authorization },
      ENV,
    );
    expect(nonOwner.status).toBe(404);
    expect(await nonOwner.json()).toEqual({ error: 'not_found_or_unauthorized' });

    mocks.nativeSession.mockResolvedValue(null);
    mocks.browserSession.mockResolvedValue(null);
    const loggedOut = await app().request(
      `/api/remote-desktop/guest/links?hostId=${HOST_ID}`,
      {},
      ENV,
    );
    expect(loggedOut.status).toBe(401);

    mocks.browserSession.mockResolvedValue({ kind: 'web', id: 'web-session', userId: 'owner-1' });
    mocks.browserSession.mockClear();
    const nodeBearer = await app().request(
      `/api/remote-desktop/guest/links?hostId=${HOST_ID}`,
      { headers: { authorization: 'Bearer controlled-node-credential', cookie: 'session=browser' } },
      ENV,
    );
    expect(nodeBearer.status).toBe(401);
    expect(mocks.browserSession).not.toHaveBeenCalled();
  });

  it('serves Owner host summary and action-bound public-ID rotation only', async () => {
    mocks.hostSummary.mockResolvedValue({ hostId: HOST_ID, publicNodeId: '5837462190', mergeState: 'resolved' });
    const summary = await app().request(`/api/remote-desktop/guest/host?hostId=${HOST_ID}`, {}, ENV);
    expect(await summary.json()).toEqual({
      host: { hostId: HOST_ID, publicNodeId: '5837462190', mergeState: 'resolved' },
    });

    mocks.rotate.mockResolvedValue({
      host: { hostId: HOST_ID, publicNodeId: '6837462190', mergeState: 'resolved' },
      previousPublicNodeId: '5837462190', replayed: false,
    });
    const rotated = await post({
      hostId: HOST_ID, requestId: 'q'.repeat(43), stepUpGrant: 'rdsg_rotate',
    }, 'host/rotate');
    expect(rotated.status).toBe(200);
    expect(mocks.rotate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accountSession: { kind: 'web', id: 'web-session', userId: 'owner-1' },
      hostId: HOST_ID, requestId: 'q'.repeat(43), stepUpToken: 'rdsg_rotate',
    }));
  });

  it('accepts the mobile deck_ API key as an account session without cookie fallback', async () => {
    const response = await app().request(
      `/api/remote-desktop/guest/host?hostId=${HOST_ID}`,
      { headers: { authorization: 'Bearer deck_mobile_account_key' } },
      ENV,
    );

    expect(response.status).toBe(200);
    expect(mocks.browserSession).not.toHaveBeenCalled();
    expect(mocks.hostSummary).toHaveBeenCalledWith(expect.anything(), {
      accountSession: {
        kind: 'web',
        id: 'remote-desktop-api-key:mobile-key-1',
        userId: 'owner-1',
      },
      hostId: HOST_ID,
    });
  });

  it('fails stale or cross-action step-up grants closed without mutation', async () => {
    mocks.rotate.mockRejectedValue(new OwnerHostManagementError(OWNER_HOST_MANAGEMENT_ERROR.STEP_UP_REQUIRED));
    const response = await post({
      hostId: HOST_ID, requestId: 'q'.repeat(43), stepUpGrant: 'rdsg_wrong_action',
    }, 'host/rotate');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'step_up_required' });
  });
});
