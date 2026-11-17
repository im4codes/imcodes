import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VERIFICATION_MACHINE_API_PATH, type VerificationMachineProfile } from '@shared/verification-machine.js';

const apiFetchMock = vi.fn();

vi.mock('../../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const { listVerificationMachines, listVerificationMachinesPage } = await import('../../src/api/verification-machines.js');

function makeProfile(index: number, scopeKey: string): VerificationMachineProfile {
  return {
    id: index.toString(16).padStart(32, '0'),
    scope: 'project',
    scopeKey,
    alias: `machine-${index}`,
    kind: 'controlled_node',
    target: '1234567890',
    enabled: true,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    lastVerificationStatus: 'unverified',
    source: 'web',
  };
}

describe('verification-machines API client pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps default scoped listVerificationMachines as a single project-scoped request without includeAllProjects', async () => {
    const p = makeProfile(1, 'repo-a');
    apiFetchMock.mockResolvedValueOnce({ profiles: [p] });

    const res = await listVerificationMachines('repo-a');
    expect(res).toEqual([p]);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(`${VERIFICATION_MACHINE_API_PATH}?projectKey=repo-a`);
  });

  it('aggregates all management pages via nextCursor across >100 multi-project profiles and deduplicates/guards cursor loops', async () => {
    const page1Items = Array.from({ length: 100 }, (_, i) => makeProfile(i + 1, i < 51 ? 'repo-a' : '😀'.repeat(512)));
    const page2Items = [makeProfile(101, '😀'.repeat(512))];
    const longCursor = 'A'.repeat(2840);
    apiFetchMock
      .mockResolvedValueOnce({ profiles: page1Items, nextCursor: longCursor })
      .mockResolvedValueOnce({ profiles: page2Items });

    const all = await listVerificationMachines(undefined, { includeAllProjects: true });
    expect(all).toHaveLength(101);
    expect(all[100]!.id).toBe(page2Items[0]!.id);
    expect(apiFetchMock).toHaveBeenNthCalledWith(1, `${VERIFICATION_MACHINE_API_PATH}?includeAllProjects=1`);
    expect(apiFetchMock).toHaveBeenNthCalledWith(2, `${VERIFICATION_MACHINE_API_PATH}?includeAllProjects=1&cursor=${longCursor}`);
  });

  it('listVerificationMachinesPage preserves optional nextCursor and rejects infinite cursor loops safely', async () => {
    const p1 = makeProfile(1, 'repo-a');
    apiFetchMock.mockResolvedValueOnce({ profiles: [p1], nextCursor: 'cur-a' });
    const single = await listVerificationMachinesPage('repo-a', { includeAllProjects: true, limit: 50 });
    expect(single).toEqual({ profiles: [p1], nextCursor: 'cur-a' });
    expect(apiFetchMock).toHaveBeenCalledWith(`${VERIFICATION_MACHINE_API_PATH}?projectKey=repo-a&includeAllProjects=1&limit=50`);

    apiFetchMock.mockReset();
    apiFetchMock
      .mockResolvedValueOnce({ profiles: [p1], nextCursor: 'loop' })
      .mockResolvedValueOnce({ profiles: [p1], nextCursor: 'loop' });
    const guarded = await listVerificationMachines('repo-a', { includeAllProjects: true });
    expect(guarded).toEqual([p1]);
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});
