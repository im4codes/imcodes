import { describe, it, expect } from 'vitest';
import { execRemote, listMachines } from '../../src/daemon/machine-exec-client.js';

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}
const base = { serverUrl: 'https://app.im.codes/', sourceServerId: 's1', sourceToken: 't1', targetServerId: 'tgt' };

describe('execRemote client (5.2 core)', () => {
  it('passes through a completed outcome + fields', async () => {
    const r = await execRemote({ ...base, command: 'echo hi', fetchImpl: mockFetch(200, { outcome: 'completed', ok: true, exitCode: 0, stdout: 'hi' }) });
    expect(r.outcome).toBe('completed');
    expect(r.stdout).toBe('hi');
  });
  it('maps a 403 authz denial to not_dispatched (retry-safe)', async () => {
    const r = await execRemote({ ...base, command: 'x', fetchImpl: mockFetch(403, { error: 'forbidden', reason: 'exec_disabled' }) });
    expect(r.outcome).toBe('not_dispatched');
    expect(r.error).toBe('exec_disabled');
  });
  it('preserves an explicit dispatched_no_result (indeterminate) from the server', async () => {
    const r = await execRemote({ ...base, command: 'x', fetchImpl: mockFetch(200, { outcome: 'dispatched_no_result' }) });
    expect(r.outcome).toBe('dispatched_no_result');
  });
  it('reports an unreachable relay as not_dispatched', async () => {
    const failing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const r = await execRemote({ ...base, command: 'x', fetchImpl: failing });
    expect(r.outcome).toBe('not_dispatched');
    expect(r.error).toMatch(/relay_unreachable/);
  });
});

describe('listMachines client', () => {
  const machines = [
    { serverId: 'a', refName: 'a', displayName: 'A', online: true, nodeRole: 'controlled', execEnabled: true },
    { serverId: 'b', refName: 'b', displayName: 'B', online: false, nodeRole: 'controlled', execEnabled: true },
    { serverId: 'c', refName: 'c', displayName: 'C', online: true, nodeRole: 'controlled', execEnabled: false },
  ];
  it('excludes offline + exec-disabled by default (agent-facing)', async () => {
    const r = await listMachines({ serverUrl: base.serverUrl, sourceServerId: 's1', sourceToken: 't1', fetchImpl: mockFetch(200, { machines }) });
    expect(r.map((m) => m.serverId)).toEqual(['a']);
  });
  it('includes all when includeOffline is set', async () => {
    const r = await listMachines({ serverUrl: base.serverUrl, sourceServerId: 's1', sourceToken: 't1', includeOffline: true, fetchImpl: mockFetch(200, { machines }) });
    expect(r.length).toBe(3);
  });
});
