/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const directMocks = vi.hoisted(() => ({
  getSessionIdentityDirect: vi.fn(),
  setSessionIdentityDirect: vi.fn(),
  deleteSessionIdentityDirect: vi.fn(),
}));

vi.mock('../src/direct-file-transfer.js', () => directMocks);

describe('session identity direct-first (phase 2), with the phase-1 WS-relayed HTTP path as fallback', () => {
  beforeEach(() => {
    vi.resetModules();
    directMocks.getSessionIdentityDirect.mockReset();
    directMocks.setSessionIdentityDirect.mockReset();
    directMocks.deleteSessionIdentityDirect.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  const ws = {} as never;
  const context = { serverId: 'srv-1', sessionName: 'deck_proj_brain' };

  it('reads over the lease and never falls back to HTTP when the lease succeeds', async () => {
    directMocks.getSessionIdentityDirect.mockResolvedValue({
      content: 'session rules', contentHash: 'a'.repeat(64), revision: 3, updatedAt: 10,
    });
    const { fetchSessionIdentityProfileDirectFirst } = await import('../src/session-identity-direct.js');

    const profile = await fetchSessionIdentityProfileDirectFirst('srv-1:deck_proj_brain', context, ws);

    expect(profile).toMatchObject({ scope: 'session', content: 'session rules', revision: 3 });
    expect(directMocks.getSessionIdentityDirect).toHaveBeenCalledWith(ws, 'srv-1', 'session', 'srv-1:deck_proj_brain');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to the HTTP relay path when the direct lease read rejects', async () => {
    directMocks.getSessionIdentityDirect.mockRejectedValue(new Error('capability_unavailable'));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      profile: { scope: 'session', scopeKey: 'srv-1:deck_proj_brain', content: 'from relay', contentHash: 'h', revision: 1, updatedAt: 1, source: 'web' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const { fetchSessionIdentityProfileDirectFirst } = await import('../src/session-identity-direct.js');

    const profile = await fetchSessionIdentityProfileDirectFirst('srv-1:deck_proj_brain', context, ws);

    expect(profile).toMatchObject({ content: 'from relay' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('goes straight to HTTP when no ws is supplied (never attempts the lease)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ profile: null }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const { fetchSessionIdentityProfileDirectFirst } = await import('../src/session-identity-direct.js');

    await fetchSessionIdentityProfileDirectFirst('srv-1:deck_proj_brain', context, null);

    expect(directMocks.getSessionIdentityDirect).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('saves over the lease and never falls back to HTTP when the lease succeeds', async () => {
    directMocks.setSessionIdentityDirect.mockResolvedValue({
      content: 'new rules', contentHash: 'b'.repeat(64), revision: 2, updatedAt: 20,
    });
    const { saveSessionIdentityProfileDirectFirst } = await import('../src/session-identity-direct.js');

    const profile = await saveSessionIdentityProfileDirectFirst({ scopeKey: 'srv-1:deck_proj_brain', content: 'new rules' }, context, ws);

    expect(profile).toMatchObject({ content: 'new rules', revision: 2 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to the HTTP relay path when the direct lease write rejects', async () => {
    directMocks.setSessionIdentityDirect.mockRejectedValue(new Error('no_progress_timeout'));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      profile: { scope: 'session', scopeKey: 'srv-1:deck_proj_brain', content: 'new rules', contentHash: 'h', revision: 2, updatedAt: 20, source: 'web' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const { saveSessionIdentityProfileDirectFirst } = await import('../src/session-identity-direct.js');

    const profile = await saveSessionIdentityProfileDirectFirst({ scopeKey: 'srv-1:deck_proj_brain', content: 'new rules' }, context, ws);

    expect(profile).toMatchObject({ content: 'new rules' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('clears over the lease and never falls back to HTTP when the lease succeeds', async () => {
    directMocks.deleteSessionIdentityDirect.mockResolvedValue(undefined);
    const { clearSessionIdentityProfileDirectFirst } = await import('../src/session-identity-direct.js');

    const deleted = await clearSessionIdentityProfileDirectFirst('srv-1:deck_proj_brain', context, ws);

    expect(deleted).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to the HTTP relay path when the direct lease delete rejects', async () => {
    directMocks.deleteSessionIdentityDirect.mockRejectedValue(new Error('channel_closed'));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const { clearSessionIdentityProfileDirectFirst } = await import('../src/session-identity-direct.js');

    const deleted = await clearSessionIdentityProfileDirectFirst('srv-1:deck_proj_brain', context, ws);

    expect(deleted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
