import { describe, expect, it, vi } from 'vitest';
import {
  clearSessionIdentityProfile,
  listSessionIdentityProfiles,
  setSessionIdentityProfile,
} from '../../src/daemon/session-identity-mcp-client.js';

const endpoint = { workerUrl: 'https://im.example.test/', serverId: 'srv-1', token: 'secret-token' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('session identity online client', () => {
  it('loads one user-scoped snapshot for cross-machine daemon convergence', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ profiles: [{
      scope: 'user', scopeKey: '', content: 'global identity', contentHash: 'hash', revision: 2, updatedAt: 3, source: 'mcp',
    }] }));
    const result = await listSessionIdentityProfiles({ endpoint, fetchImpl });
    expect(result).toMatchObject({ status: 'ok', serverId: 'srv-1', profiles: [{ content: 'global identity' }] });
    expect(fetchImpl).toHaveBeenCalledWith('https://im.example.test/api/session-identities/all', expect.objectContaining({
      headers: { Authorization: 'Bearer secret-token', 'X-Server-Id': 'srv-1' },
    }));
  });

  it('ignores legacy optimistic revisions and sends a last-write-wins update', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ profile: {
      scope: 'session', scopeKey: 'srv-1:deck_proj_cc1', content: 'identity',
      contentHash: 'hash', revision: 5, updatedAt: 1, source: 'mcp',
    } }));
    const result = await setSessionIdentityProfile({
      scope: 'session',
      scopeKey: 'srv-1:deck_proj_cc1',
      content: 'identity',
      expectedRevision: 4,
    }, { endpoint, fetchImpl });
    expect(result).toMatchObject({ status: 'ok', profile: { revision: 5 } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain('scope=session');
    expect(String(url)).toContain('scopeKey=srv-1%3Adeck_proj_cc1');
    expect(JSON.parse(String(init.body))).toEqual({
      scope: 'session', scopeKey: 'srv-1:deck_proj_cc1', content: 'identity',
    });
  });

  it('ignores the legacy expected revision when clearing one scope', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ deleted: true }));
    await expect(clearSessionIdentityProfile('project', 'repo-1', 7, { endpoint, fetchImpl }))
      .resolves.toEqual({ status: 'ok', deleted: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).not.toContain('expectedRevision');
    expect(init.method).toBe('DELETE');
  });
});
