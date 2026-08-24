import { describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_LINK_KIND,
  REMOTE_DESKTOP_LINK_TOKEN,
  REMOTE_DESKTOP_LINK_USE_POLICY,
} from '../../shared/remote-desktop-access.js';
import {
  prepareRemoteDesktopLink,
  proveRemoteDesktopPublicPassword,
  remoteDesktopLinkMutationAction,
  remoteDesktopPasswordMutationAction,
  unavailableRemoteDesktopGuestSessionStarter,
} from '../src/api/remote-desktop-access.js';
import { generateRemoteDesktopBrowserKeyPair, sha256RemoteDesktopLinkPolicy } from '../src/remote-desktop-access-crypto.js';

describe('remote desktop access wire contracts', () => {
  it('matches the Server link-policy digest and keeps the raw bearer client-only', async () => {
    await expect(sha256RemoteDesktopLinkPolicy({
      hostId: 'host-1', kind: REMOTE_DESKTOP_LINK_KIND.UNATTENDED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL, usePolicy: REMOTE_DESKTOP_LINK_USE_POLICY.REUSABLE,
      durationMs: 3_600_000, label: 'Ops',
    })).resolves.toMatch(/^[0-9a-f]{64}$/);

    const prepared = await prepareRemoteDesktopLink({
      hostId: 'host-1', kind: REMOTE_DESKTOP_LINK_KIND.UNATTENDED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL, usePolicy: REMOTE_DESKTOP_LINK_USE_POLICY.REUSABLE,
      durationMs: 3_600_000, label: 'Ops',
    });
    const rawToken = new URL(prepared.inviteUrl).hash.split('.').at(-1)!;
    expect(rawToken).toHaveLength(REMOTE_DESKTOP_LINK_TOKEN.ENCODED_LENGTH);
    expect(JSON.stringify(prepared.request)).not.toContain(rawToken);
    expect(JSON.stringify(prepared.action)).not.toContain(rawToken);
    expect(prepared.action).toEqual({
      kind: 'remote_desktop.link.create', hostId: 'host-1',
      creationRequestId: prepared.requestId, tokenHash: prepared.request.tokenHash,
      policyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('uses exact mutation action shapes expected by action-bound step-up', () => {
    expect(remoteDesktopLinkMutationAction({ hostId: 'host-1', linkId: 'link-1', mutation: 'reduce_to_view' })).toEqual({
      kind: 'remote_desktop.link.mutate', hostId: 'host-1', linkId: 'link-1', mutation: 'reduce_to_view', label: null, expiresAt: null,
    });
    expect(remoteDesktopPasswordMutationAction({ hostId: 'host-1', action: 'disable', requestId: 'request-1' })).toEqual({
      type: 'remote_desktop.unattended_password.mutation.v1', hostId: 'host-1', action: 'disable', requestId: 'request-1',
    });
  });

  it('sends public password proof without account credentials and keeps routing metadata post-proof', async () => {
    const browserKey = await generateRemoteDesktopBrowserKeyPair();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true, hostId: 'host-1', serverId: 'routing-only', bootstrapTicket: 'A'.repeat(43),
      expiresAt: Date.now() + 60_000, mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL, source: 'node_password',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await proveRemoteDesktopPublicPassword({
      publicNodeId: 5_123_456_789, password: 'a-long-unique-password', browserKey,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.status).toBe('ready');
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.credentials).toBe('omit');
    expect(JSON.parse(String(init?.body))).toEqual({
      publicNodeId: 5_123_456_789, password: 'a-long-unique-password',
      browserPublicKeySpki: browserKey.publicKeySpki,
      browserKeyThumbprint: browserKey.thumbprint,
    });
  });

  it('keeps the in-flight guest signaling seam fail closed', async () => {
    await expect(unavailableRemoteDesktopGuestSessionStarter.start({} as never, () => undefined))
      .rejects.toThrow('remote_desktop_guest_signaling_unavailable');
  });
});
