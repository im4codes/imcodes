import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { Database } from '../src/db/client.js';
import {
  RemoteDesktopRouter,
  type RemoteDesktopRouteRegistry,
} from '../src/ws/remote-desktop-router.js';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_PROTOCOL_VERSION,
  REMOTE_DESKTOP_TERMINAL_REASON,
} from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_ACTOR_SOURCE,
  type RemoteDesktopActor,
  type RemoteDesktopOutboxEvent,
} from '../../shared/remote-desktop-access.js';

const proof = {
  ticket: 'A'.repeat(43),
  browserKeyThumbprint: 'B'.repeat(43),
  signature: 'C'.repeat(86),
};
const requestId = 'guest_request_123456';
const start = {
  type: REMOTE_DESKTOP_MSG.START,
  protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
  requestId,
} as const;

function actor(source: 'attended_link' | 'unattended_link' = 'unattended_link', mode = REMOTE_DESKTOP_ACCESS_MODE.CONTROL): RemoteDesktopActor {
  return {
    source,
    auditId: 'link-audit-1',
    hostId: 'host-1',
    endpointGeneration: 7,
    modeCeiling: mode,
    authorityGeneration: 1,
    expiryRevision: 1,
    expiresAt: Date.now() + 60_000,
    linkId: 'link-1',
    browserKeyThumbprint: proof.browserKeyThumbprint,
  };
}

function fixture(options: {
  actor?: RemoteDesktopActor;
  consent?: () => Promise<boolean | 'approved' | 'denied' | 'timeout' | 'cancelled' | 'unavailable'>;
} = {}) {
  const browser = { close: vi.fn() } as unknown as WebSocket;
  const secondBrowser = { close: vi.fn() } as unknown as WebSocket;
  const browserMessages = new Map<WebSocket, Record<string, unknown>[]>();
  const daemonMessages: Record<string, unknown>[] = [];
  const registryEvents: string[] = [];
  const consentCancellations: string[] = [];
  let currentActor: RemoteDesktopActor | null = options.actor ?? actor();
  const registry: RemoteDesktopRouteRegistry = {
    reserve: async () => { throw new Error('guest_must_not_double_reserve'); },
    activate: async (_db, input) => { registryEvents.push(`activate:${input.routeId}`); },
    close: async (_db, input) => { registryEvents.push(`close:${input.routeId}`); },
  };
  const router = new RemoteDesktopRouter({
    serverId: () => 'server-1',
    database: () => ({}) as Database,
    daemonAvailable: () => true,
    daemonSupportsRemoteDesktop: () => true,
    featureEnabled: () => true,
    daemonGeneration: () => 7,
    allocateRouteGeneration: async () => 7,
    iceServers: () => ({ iceServers: ['stun:example.test'] }),
    sendDaemon: (message) => { daemonMessages.push(message); return true; },
    sendBrowser: (socket, message) => {
      const values = browserMessages.get(socket) ?? [];
      values.push(message);
      browserMessages.set(socket, values);
    },
    routeRegistry: registry,
    redeemGuestBootstrap: async () => ({
      actor: currentActor!,
      sessionId: 'guest-session-123456',
      routeGeneration: 7,
      registryAuthority: {
        actorSource: currentActor!.source as 'attended_link' | 'unattended_link',
        actorAuditId: currentActor!.auditId,
        authorityGeneration: currentActor!.authorityGeneration,
        expiryRevision: currentActor!.expiryRevision,
        commitRevision: 1,
      },
    }),
    resolveGuestActor: async () => currentActor,
    requestAttendedConsent: options.consent,
    cancelPendingGuestConsent: async (_actor, cause) => { consentCancellations.push(cause); },
    cancelHostAttendedConsents: async (hostId) => { consentCancellations.push(`host:${hostId}`); },
  });
  return {
    router, browser, secondBrowser, browserMessages, daemonMessages, registryEvents,
    consentCancellations,
    setActor(value: RemoteDesktopActor | null) { currentActor = value; },
  };
}

describe('anonymous remote desktop guest actor routing', () => {
  it('never dispatches a start presented before bootstrap proof', async () => {
    const f = fixture();
    await f.router.handleGuestBrowser(f.browser, start);
    expect(f.daemonMessages).toEqual([]);
    expect(f.registryEvents).toEqual([]);
  });

  it('delivers an exact committed privacy cancellation to Router and consent before PREPARE', async () => {
    const f = fixture({ actor: actor('attended_link') });
    expect(await f.router.redeemGuestBootstrap(f.browser, proof)).toBe(true);
    expect(f.router.cancelPendingRoutes('other-host', [
      { routeId: 'guest-session-123456', routeGeneration: 7 },
    ])).toBe(0);
    expect(f.router.cancelPendingRoutes('host-1', [
      { routeId: 'guest-session-123456', routeGeneration: 8 },
    ])).toBe(0);
    expect(f.router.cancelPendingRoutes('host-1', [
      { routeId: 'guest-session-123456', routeGeneration: 7 },
    ])).toBe(1);
    expect(f.consentCancellations).toEqual(['privacy_epoch']);
    expect(f.daemonMessages).toEqual([]);
    expect(f.browserMessages.get(f.browser)).toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.ERROR,
      error: REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE,
      retryable: true,
    }));
  });

  it('does not dispatch PREPARE until attended consent resolves positively', async () => {
    let approve!: (value: boolean) => void;
    const consent = vi.fn(() => new Promise<boolean>((resolve) => { approve = resolve; }));
    const f = fixture({ actor: actor('attended_link'), consent });
    expect(await f.router.redeemGuestBootstrap(f.browser, proof)).toBe(true);
    const admission = f.router.handleGuestBrowser(f.browser, start);
    await vi.waitFor(() => expect(consent).toHaveBeenCalledOnce());
    expect(f.daemonMessages).toEqual([]);
    approve(true);
    await admission;
    expect(f.daemonMessages[0]?.type).toBe(REMOTE_DESKTOP_MSG.PREPARE);
    expect(f.registryEvents[0]).toBe('activate:guest-session-123456');
    expect(f.browserMessages.get(f.browser)?.some((m) => m.type === REMOTE_DESKTOP_MSG.AUTHORIZED)).toBe(true);
  });

  it('fails attended admission closed when consent is unavailable', async () => {
    const f = fixture({ actor: actor('attended_link') });
    expect(await f.router.redeemGuestBootstrap(f.browser, proof)).toBe(true);
    await f.router.handleGuestBrowser(f.browser, start);
    expect(f.daemonMessages).toEqual([]);
    expect(f.registryEvents).toContain('close:guest-session-123456');
    expect(f.browserMessages.get(f.browser)).toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.ERROR,
      error: 'capability_unavailable',
    }));
  });

  it.each([
    ['denied', 'access_denied'],
    ['timeout', 'negotiation_timeout'],
    ['cancelled', 'consent_cancelled'],
  ] as const)('reports attended consent %s without dispatching PREPARE', async (outcome, error) => {
    const f = fixture({ actor: actor('attended_link'), consent: async () => outcome });
    await f.router.redeemGuestBootstrap(f.browser, proof);
    await f.router.handleGuestBrowser(f.browser, start);
    expect(f.daemonMessages).toEqual([]);
    expect(f.browserMessages.get(f.browser)).toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.ERROR,
      error,
    }));
  });

  it('enforces a View link ceiling and never forwards a Control upgrade', async () => {
    const f = fixture({ actor: actor('unattended_link', REMOTE_DESKTOP_ACCESS_MODE.VIEW) });
    await f.router.redeemGuestBootstrap(f.browser, proof);
    await f.router.handleGuestBrowser(f.browser, start);
    const authorized = f.browserMessages.get(f.browser)?.find((m) => m.type === REMOTE_DESKTOP_MSG.AUTHORIZED)!;
    f.daemonMessages.length = 0;
    await f.router.handleGuestBrowser(f.browser, {
      type: REMOTE_DESKTOP_MSG.MODE_SET,
      requestId,
      sessionId: authorized.sessionId,
      capability: authorized.capability,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    });
    expect(f.daemonMessages).toEqual([]);
  });

  it('rejects a second live socket for the same durable guest session', async () => {
    const f = fixture();
    await f.router.redeemGuestBootstrap(f.browser, proof);
    await f.router.handleGuestBrowser(f.browser, start);
    await f.router.redeemGuestBootstrap(f.secondBrowser, proof);
    await f.router.handleGuestBrowser(f.secondBrowser, { ...start, requestId: 'guest_request_654321' });
    expect(f.daemonMessages.filter((m) => m.type === REMOTE_DESKTOP_MSG.PREPARE)).toHaveLength(1);
    expect(f.registryEvents).not.toContain('close:guest-session-123456');
  });

  it('cancels a pending attended consent when an exact authority outbox event arrives', async () => {
    let finishConsent!: (approved: boolean) => void;
    const consent = vi.fn(() => new Promise<boolean>((resolve) => { finishConsent = resolve; }));
    const f = fixture({
      actor: actor('attended_link'),
      consent,
    });
    await f.router.redeemGuestBootstrap(f.browser, proof);
    const admission = f.router.handleGuestBrowser(f.browser, start);
    await vi.waitFor(() => expect(consent).toHaveBeenCalledOnce());
    expect(f.daemonMessages).toEqual([]);
    const event: RemoteDesktopOutboxEvent = {
      idempotencyKey: 'pending-link-revoke',
      sequence: 1,
      authorityKind: 'link',
      effect: 'terminal',
      scope: 'route',
      hostId: 'host-1',
      targetServerId: 'server-1',
      actorAuditId: 'link-audit-1',
      authorityGeneration: 2,
      expiryRevision: 1,
      commitRevision: 2,
      routeGeneration: 7,
    };
    expect(f.router.applyGuestOutboxEffect(event, 'guest-session-123456', 7, {
      authorityKind: 'link',
      actorAuditId: 'link-audit-1',
      authorityGeneration: 2,
      expiryRevision: 1,
      commitRevision: 2,
    })).toEqual({ status: 'applied' });
    await vi.waitFor(() => expect(f.consentCancellations).toContain('authority_revoked'));
    await vi.waitFor(() => expect(f.registryEvents).toContain('close:guest-session-123456'));
    expect(f.browser.close).toHaveBeenCalledWith(1008, 'unavailable');
    finishConsent(true);
    await admission;
    expect(f.daemonMessages).toEqual([]);
  });

  it('cancels every host pending consent when the local user stops an active route', async () => {
    const f = fixture({ actor: actor('attended_link'), consent: async () => true });
    await f.router.redeemGuestBootstrap(f.browser, proof);
    await f.router.handleGuestBrowser(f.browser, start);
    const authorized = f.browserMessages.get(f.browser)?.find((m) => (
      m.type === REMOTE_DESKTOP_MSG.AUTHORIZED
    ))!;
    f.router.handleDaemon({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      requestId,
      sessionId: authorized.sessionId,
      capability: authorized.capability,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.STOPPED_BY_LOCAL_USER,
    }, 7);
    await vi.waitFor(() => expect(f.consentCancellations).toContain('host:host-1'));
  });

  it('terminates an ICE renewal after the durable guest authority is revoked', async () => {
    const f = fixture();
    await f.router.redeemGuestBootstrap(f.browser, proof);
    await f.router.handleGuestBrowser(f.browser, start);
    const authorized = f.browserMessages.get(f.browser)?.find((m) => m.type === REMOTE_DESKTOP_MSG.AUTHORIZED)!;
    const offer = (suffix: string) => ({
      type: REMOTE_DESKTOP_MSG.OFFER,
      requestId,
      sessionId: authorized.sessionId,
      capability: authorized.capability,
      sdp: `v=0\r\no=${suffix}`,
    });
    await f.router.handleGuestBrowser(f.browser, offer('first'));
    f.setActor(null);
    await f.router.handleGuestBrowser(f.browser, offer('renewal'));
    expect(f.browserMessages.get(f.browser)).toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED,
    }));
  });
});
