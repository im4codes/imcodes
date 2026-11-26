import { describe, expect, it, vi } from 'vitest';
import { resolveTaskPairTitleTurn } from '../../src/daemon/task-pair-title-authority.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';

const actor = { serverId: 'server-a', userId: 'alice', sessionName: 'brain', projectName: 'project' };
const credential = { serverUrl: 'https://example.test', serverId: 'server-a', token: 'scoped-test-token' };
const hook = async () => ({ ok: true, required: true, authority: 'opaque-turn-authority' });
const input = { postAuthorityHook: hook, sessionName: 'brain', loadCredential: async () => credential };

describe('per-call trusted title actor', () => {
  it('uses the signed authority and daemon credential, never the runtime caller owner id', async () => {
    const fetchImpl = vi.fn(async () => Response.json(actor));
    expect(await resolveTaskPairTitleTurn({ ...input, fetchImpl })).toEqual({ participantView: true, actor });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('?serverId=server-a'), expect.objectContaining({ headers: expect.objectContaining({ [SHARED_MACHINE_AUTHORITY_HEADER]: 'opaque-turn-authority' }), redirect: 'error' }));
  });
  it('rechecks the same origin and does not retain authority across calls', async () => {
    const postAuthorityHook = vi.fn().mockResolvedValueOnce(await hook()).mockResolvedValueOnce(await hook()).mockResolvedValueOnce({ ok: true, required: false });
    const fetchImpl = vi.fn(async () => Response.json(actor));
    expect((await resolveTaskPairTitleTurn({ ...input, postAuthorityHook, fetchImpl })).actor).toEqual(actor);
    expect(await resolveTaskPairTitleTurn({ ...input, postAuthorityHook, fetchImpl })).toEqual({ participantView: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ok: false }, {}, { ok: true }, { ok: true, required: true },
  ])('fails closed on ambiguous/mixed/old hook replies: %j', async (answer) => {
    const fetchImpl = vi.fn();
    expect(await resolveTaskPairTitleTurn({ ...input, postAuthorityHook: async () => answer, fetchImpl })).toEqual({ participantView: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([{ ok: true, required: true, authority: 'different-turn' }, { ok: true, required: false }, { ok: false }])('rejects a late actor result after turn replacement/mixed origin: %j', async (current) => {
    const postAuthorityHook = vi.fn().mockResolvedValueOnce(await hook()).mockResolvedValueOnce(current);
    expect(await resolveTaskPairTitleTurn({ ...input, postAuthorityHook, fetchImpl: async () => Response.json(actor) })).toEqual({ participantView: true });
  });
  it.each([403, 404, 500])('keeps titles private for revoked/old/unavailable server (%i)', async (status) => {
    expect(await resolveTaskPairTitleTurn({ ...input, fetchImpl: async () => new Response('', { status }) })).toEqual({ participantView: true });
  });
  it.each([{ ...actor, serverId: 'other' }, { ...actor, sessionName: 'other' }, { ...actor, userId: '' }, { ...actor, projectName: '' }, null])('rejects incoherent server identity %j', async (response) => {
    expect(await resolveTaskPairTitleTurn({ ...input, fetchImpl: async () => Response.json(response) })).toEqual({ participantView: true });
  });
  it('bounds response size and handles network/hook failures', async () => {
    for (const fetchImpl of [async () => new Response('x'.repeat(16_385)), async () => { throw new Error('timeout'); }]) {
      expect(await resolveTaskPairTitleTurn({ ...input, fetchImpl })).toEqual({ participantView: true });
    }
    expect(await resolveTaskPairTitleTurn({ ...input, postAuthorityHook: async () => { throw new Error('stale epoch'); } })).toEqual({ participantView: true });
    expect(await resolveTaskPairTitleTurn({ ...input, loadCredential: async () => null })).toEqual({ participantView: true });
  });
});
