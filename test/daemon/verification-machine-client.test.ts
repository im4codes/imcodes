import { describe, expect, it, vi } from 'vitest';
import {
  listVerificationMachineProfiles,
  removeVerificationMachineProfile,
  setVerificationMachineProfile,
} from '../../src/daemon/verification-machine-mcp-client.js';

const endpoint = { workerUrl: 'https://im.example.test/', serverId: 'srv-1', token: 'secret-token' };
const profile = {
  id: 'a'.repeat(32), scope: 'project', scopeKey: 'repo-1', alias: '211 rig', kind: 'ssh', target: 'b'.repeat(32),
  enabled: true, revision: 1, createdAt: 1, updatedAt: 1, lastVerificationStatus: 'unverified', source: 'mcp',
};

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

describe('verification machine online client', () => {
  it('lists the effective user/project registry through the daemon credential', async () => {
    const fetchImpl = vi.fn(async () => response({ profiles: [profile] }));
    await expect(listVerificationMachineProfiles('repo-1', { endpoint, fetchImpl }))
      .resolves.toMatchObject({ status: 'ok', profiles: [{ id: profile.id }] });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://im.example.test/api/verification-machines?projectKey=repo-1',
      expect.objectContaining({ headers: { Authorization: 'Bearer secret-token', 'X-Server-Id': 'srv-1' } }),
    );
  });

  it('updates and removes by stable id without exposing credentials in errors', async () => {
    const conflict = vi.fn(async () => response({ error: 'revision_conflict' }, 409));
    const result = await setVerificationMachineProfile({ ...profile, expectedRevision: 1 }, { endpoint, fetchImpl: conflict });
    expect(result).toMatchObject({ status: 'error', reason: 'revision_conflict' });
    expect(JSON.stringify(result)).not.toContain('secret-token');

    const removeFetch = vi.fn(async () => response({ deleted: true }));
    await expect(removeVerificationMachineProfile(profile.id, 2, { endpoint, fetchImpl: removeFetch }))
      .resolves.toEqual({ status: 'ok', deleted: true });
    expect(String(removeFetch.mock.calls[0]![0])).toContain(`/${profile.id}?expectedRevision=2`);
  });
});
