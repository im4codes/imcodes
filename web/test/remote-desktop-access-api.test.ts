/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRemoteDesktopAccessApi,
  remoteDesktopGuestSessionStateFromSnapshot,
  remoteDesktopManagementWebPrivacyCoordinator,
} from '../src/api/remote-desktop-access.js';
import { REMOTE_DESKTOP_ACTOR_SOURCE } from '../../shared/remote-desktop-access.js';
import { REMOTE_DESKTOP_ERROR, REMOTE_DESKTOP_STATE } from '../../shared/remote-desktop.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('remote desktop management Web privacy API', () => {
  it('keeps denied, timeout and cancelled consent outcomes distinct', () => {
    const source = REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK;
    expect(remoteDesktopGuestSessionStateFromSnapshot({
      state: REMOTE_DESKTOP_STATE.FAILED,
      error: REMOTE_DESKTOP_ERROR.ACCESS_DENIED,
    }, source)).toBe('denied');
    expect(remoteDesktopGuestSessionStateFromSnapshot({
      state: REMOTE_DESKTOP_STATE.FAILED,
      error: REMOTE_DESKTOP_ERROR.NEGOTIATION_TIMEOUT,
    }, source)).toBe('timeout');
    expect(remoteDesktopGuestSessionStateFromSnapshot({
      state: REMOTE_DESKTOP_STATE.FAILED,
      error: REMOTE_DESKTOP_ERROR.CONSENT_CANCELLED,
    }, source)).toBe('cancelled');
  });

  it('uses the production begin/end routes and carries only the opaque epoch ref', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith('/privacy/begin')) {
        return new Response(JSON.stringify({ epochId: 'epoch_00000000001', revision: 7 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ status: 'ended' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const epoch = await remoteDesktopManagementWebPrivacyCoordinator.begin('host_00000000001');
    expect(epoch).toEqual({ epochId: 'epoch_00000000001', revision: 7 });
    await remoteDesktopManagementWebPrivacyCoordinator.end('host_00000000001', epoch);

    expect(requests.map((request) => request.url)).toEqual([
      '/api/remote-desktop/guest/privacy/begin',
      '/api/remote-desktop/guest/privacy/end',
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ hostId: 'host_00000000001' });
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      hostId: 'host_00000000001',
      epochId: 'epoch_00000000001',
      revision: 7,
    });
  });

  it('rejects a widened or malformed epoch response instead of enabling secret UI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      epochId: 'epoch_00000000001',
      revision: 1,
      accountSession: 'must-not-cross',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(createRemoteDesktopAccessApi().beginPrivacy('host_00000000001'))
      .rejects.toThrow('invalid_remote_desktop_privacy_epoch');
  });
});
