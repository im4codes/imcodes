import { describe, expect, it, vi } from 'vitest';
import { execRemote } from '../../src/daemon/machine-exec-client.js';
import { computerUseCall } from '../../src/daemon/computer-use-client.js';
import { encodeMachineExecHttpEnvelope } from '../../shared/remote-exec.js';
import { encodeComputerUseHttpEnvelope } from '../../shared/computer-use.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';

describe('daemon shared machine authority clients', () => {
  it('carries the opaque authority in a header, never in exec body', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(
      JSON.stringify(encodeMachineExecHttpEnvelope('completed', {
        requestId: 'request-12345678', ok: true, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1,
      })),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await execRemote({
      serverUrl: 'https://server.example', sourceServerId: 'source', sourceToken: 'owner-token',
      targetServerId: 'target', command: 'hostname', sharedMachineAuthority: 'signed-authority',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ [SHARED_MACHINE_AUTHORITY_HEADER]: 'signed-authority' });
    expect(String(init.body)).not.toContain('signed-authority');
  });

  it('carries the same authority header for computer use', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(encodeComputerUseHttpEnvelope(
      'completed',
      { correlationId: 'request-12345678', ok: true, tool: 'list_apps', content: [], durationMs: 1 },
    )), { status: 200, headers: { 'content-type': 'application/json' } }));
    await computerUseCall({
      serverUrl: 'https://server.example', sourceServerId: 'source', sourceToken: 'owner-token',
      targetServerId: 'target', tool: 'list_apps', sharedMachineAuthority: 'signed-authority',
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(fetchImpl.mock.calls[0]![1]!.headers)
      .toMatchObject({ [SHARED_MACHINE_AUTHORITY_HEADER]: 'signed-authority' });
  });
});
