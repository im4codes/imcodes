import { describe, it, expect } from 'vitest';
import { execRemote, listMachines, MachineControlPlaneError } from '../../src/daemon/machine-exec-client.js';
import {
  encodeMachineExecHttpEnvelope,
  encodeMachineExecHttpStreamChunk,
  encodeMachineExecHttpStreamResult,
  MACHINE_EXEC_HTTP_ENVELOPE_VERSION,
  MACHINE_EXEC_HTTP_RESPONSE_MAX_BYTES,
  MACHINE_EXEC_HTTP_STREAM_CONTENT_TYPE,
  MACHINE_LIST_MAX_ITEMS,
  REMOTE_EXEC_MAX_OUTPUT_BYTES,
  type RemoteExecResult,
} from '../../shared/remote-exec.js';

// Build a valid server envelope exactly as the server route encodes it.
function envelope(outcome: Parameters<typeof encodeMachineExecHttpEnvelope>[0], result?: RemoteExecResult): typeof fetch {
  const body = JSON.stringify(encodeMachineExecHttpEnvelope(outcome, result));
  return (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}
function raw(status: number, text: string): typeof fetch {
  return (async () => new Response(text, { status })) as unknown as typeof fetch;
}
const completed: RemoteExecResult = { requestId: 'r', ok: true, exitCode: 7, stdout: 'hi', stderr: '', durationMs: 3 };
const base = { serverUrl: 'https://app.im.codes/', sourceServerId: 's1', sourceToken: 't1', targetServerId: 'tgt' };

function streamed(frames: unknown[], delayAfterFirst = false): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('accept')).toBe(MACHINE_EXEC_HTTP_STREAM_CONTENT_TYPE);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (frame: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        if (!delayAfterFirst) {
          frames.forEach(write);
          controller.close();
          return;
        }
        write(frames[0]);
        setTimeout(() => {
          frames.slice(1).forEach(write);
          controller.close();
        }, 25);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': `${MACHINE_EXEC_HTTP_STREAM_CONTENT_TYPE}; charset=utf-8` },
    });
  }) as unknown as typeof fetch;
}

describe('execRemote client — shared strict decoder (transport-safe)', () => {
  it('passes through a completed envelope + fields (nonzero exit still completed)', async () => {
    const r = await execRemote({ ...base, command: 'echo hi', fetchImpl: envelope('completed', completed) });
    expect(r.outcome).toBe('completed'); expect(r.stdout).toBe('hi'); expect(r.exitCode).toBe(7); expect(r.ok).toBe(true);
  });
  it('preserves a valid not_dispatched envelope (retry-safe, no result fields)', async () => {
    const r = await execRemote({ ...base, command: 'x', fetchImpl: envelope('not_dispatched') });
    expect(r.outcome).toBe('not_dispatched'); expect(r.stdout).toBeUndefined(); expect(r.ok).toBeUndefined();
  });
  it('preserves a valid dispatched_no_result envelope (indeterminate)', async () => {
    const r = await execRemote({ ...base, command: 'x', fetchImpl: envelope('dispatched_no_result') });
    expect(r.outcome).toBe('dispatched_no_result');
  });
  it('a fetch rejection is INDETERMINATE, never retry-safe not_dispatched', async () => {
    const failing = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    expect((await execRemote({ ...base, command: 'x', fetchImpl: failing })).outcome).toBe('dispatched_no_result');
  });
  it('non-envelope 4xx/5xx (proxy/gateway) are INDETERMINATE, not not_dispatched', async () => {
    expect((await execRemote({ ...base, command: 'x', fetchImpl: raw(403, JSON.stringify({ error: 'forbidden', reason: 'exec_disabled' })) })).outcome).toBe('dispatched_no_result');
    expect((await execRemote({ ...base, command: 'x', fetchImpl: raw(502, 'Bad Gateway') })).outcome).toBe('dispatched_no_result');
    expect((await execRemote({ ...base, command: 'x', fetchImpl: raw(504, '<html>gw timeout</html>') })).outcome).toBe('dispatched_no_result');
  });
  it('rejects wrong protocol/version, illegal outcome, forged not_dispatched result, and non-json as indeterminate', async () => {
    const V = MACHINE_EXEC_HTTP_ENVELOPE_VERSION;
    expect((await execRemote({ ...base, command: 'x', fetchImpl: raw(200, JSON.stringify({ version: V, outcome: 'completed', reason: 'completed', ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 })) })).outcome).toBe('dispatched_no_result'); // missing protocol
    expect((await execRemote({ ...base, command: 'x', fetchImpl: raw(200, JSON.stringify({ protocol: 'machine_exec_http', version: 999, outcome: 'completed', reason: 'completed' })) })).outcome).toBe('dispatched_no_result');
    expect((await execRemote({ ...base, command: 'x', fetchImpl: raw(200, JSON.stringify({ protocol: 'machine_exec_http', version: V, outcome: 'retry_me', reason: 'completed' })) })).outcome).toBe('dispatched_no_result');
    // A not_dispatched envelope carrying result fields is rejected by the shared cross-field check → indeterminate.
    expect((await execRemote({ ...base, command: 'x', fetchImpl: raw(200, JSON.stringify({ protocol: 'machine_exec_http', version: V, outcome: 'not_dispatched', reason: 'target_offline', ok: true, stdout: 'forged' })) })).outcome).toBe('dispatched_no_result');
    expect((await execRemote({ ...base, command: 'x', fetchImpl: raw(200, 'not json') })).outcome).toBe('dispatched_no_result');
  });
  it('rejects an over-cap response body (escaping-aware shared cap, not buffered whole)', async () => {
    const huge = JSON.stringify({ protocol: 'machine_exec_http', version: MACHINE_EXEC_HTTP_ENVELOPE_VERSION, outcome: 'completed', reason: 'completed', ok: true, exitCode: 0, stdout: 'x'.repeat(13 * REMOTE_EXEC_MAX_OUTPUT_BYTES), stderr: '', durationMs: 1 });
    expect((await execRemote({ ...base, command: 'x', fetchImpl: raw(200, huge) })).outcome).toBe('dispatched_no_result');
  });
  it('cancels a chunked response immediately after crossing the shared byte cap', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let reads = 0;
    let cancelled = false;
    const response = {
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: chunk }),
          cancel: async () => { cancelled = true; },
        }),
      },
    } as unknown as Response;
    const fetchImpl = (async () => {
      reads += 1;
      return response;
    }) as unknown as typeof fetch;
    const result = await execRemote({ ...base, command: 'x', fetchImpl });
    expect(result.outcome).toBe('dispatched_no_result');
    expect(cancelled).toBe(true);
    expect(reads).toBe(1);
    expect(MACHINE_EXEC_HTTP_RESPONSE_MAX_BYTES).toBeGreaterThan(chunk.byteLength);
  });
  it('does NOT send a caller idempotencyKey in the request body', async () => {
    let sentBody = '';
    const capturing = (async (_u: string, init: RequestInit) => { sentBody = String(init.body); return new Response(JSON.stringify(encodeMachineExecHttpEnvelope('dispatched_no_result')), { status: 200 }); }) as unknown as typeof fetch;
    await execRemote({ ...base, command: 'echo', shell: 'bash', timeoutMs: 5000, fetchImpl: capturing });
    expect(sentBody).not.toMatch(/idempotencyKey/);
    expect(JSON.parse(sentBody)).toEqual({ command: 'echo', shell: 'bash', timeoutMs: 5000 });
  });

  it('delivers stdout/stderr fragments before resolving the complete terminal result', async () => {
    const output: Array<{ seq: number; stream: string; chunk: string }> = [];
    let settled = false;
    const terminal = encodeMachineExecHttpEnvelope('completed', {
      ...completed,
      stdout: 'firstsecond',
      stderr: 'warn',
    });
    const pending = execRemote({
      ...base,
      command: 'long task',
      fetchImpl: streamed([
        encodeMachineExecHttpStreamChunk({ seq: 0, stream: 'stdout', chunk: 'first' }),
        encodeMachineExecHttpStreamChunk({ seq: 1, stream: 'stderr', chunk: 'warn' }),
        encodeMachineExecHttpStreamChunk({ seq: 2, stream: 'stdout', chunk: 'second' }),
        encodeMachineExecHttpStreamResult(terminal),
      ], true),
      onOutput: (chunk) => {
        expect(settled).toBe(false);
        output.push(chunk);
      },
    });

    await expect.poll(() => output.length).toBeGreaterThan(0);
    expect(settled).toBe(false);
    const result = await pending;
    settled = true;
    expect(output).toEqual([
      { seq: 0, stream: 'stdout', chunk: 'first' },
      { seq: 1, stream: 'stderr', chunk: 'warn' },
      { seq: 2, stream: 'stdout', chunk: 'second' },
    ]);
    expect(result).toMatchObject({ outcome: 'completed', stdout: 'firstsecond', stderr: 'warn', exitCode: 7 });
  });

  it('treats malformed, out-of-order, or unterminated streams as indeterminate', async () => {
    const terminal = encodeMachineExecHttpStreamResult(encodeMachineExecHttpEnvelope('completed', completed));
    const cases = [
      [encodeMachineExecHttpStreamChunk({ seq: 1, stream: 'stdout', chunk: 'late' }), terminal],
      [{ injected: true }, terminal],
      [encodeMachineExecHttpStreamChunk({ seq: 0, stream: 'stdout', chunk: 'only' })],
      [terminal, terminal],
    ];
    for (const frames of cases) {
      const result = await execRemote({ ...base, command: 'x', fetchImpl: streamed(frames), onOutput: () => {} });
      expect(result).toEqual({ outcome: 'dispatched_no_result' });
    }
  });

  it('keeps the terminal result authoritative when a progress consumer throws', async () => {
    const terminal = encodeMachineExecHttpStreamResult(encodeMachineExecHttpEnvelope('completed', completed));
    const result = await execRemote({
      ...base,
      command: 'x',
      fetchImpl: streamed([
        encodeMachineExecHttpStreamChunk({ seq: 0, stream: 'stdout', chunk: 'hi' }),
        terminal,
      ]),
      onOutput: () => { throw new Error('consumer disconnected'); },
    });
    expect(result).toMatchObject({ outcome: 'completed', stdout: 'hi', exitCode: 7 });
  });
});

describe('listMachines client — bounded strict, typed control-plane failure', () => {
  const items = [
    { serverId: 'a', name: 'a', refName: 'a', displayName: 'A', online: true, nodeRole: 'controlled', execEnabled: true, os: 'linux' },
    { serverId: 'b', name: 'b', refName: 'b', displayName: 'B', online: false, nodeRole: 'controlled', execEnabled: true },
    { serverId: 'c', name: 'c', refName: 'c', displayName: 'C', online: true, nodeRole: 'controlled', execEnabled: false },
  ];
  const list200 = (machines: unknown) => (async () => new Response(JSON.stringify({ machines }), { status: 200 })) as unknown as typeof fetch;
  const opts = { serverUrl: base.serverUrl, sourceServerId: 's1', sourceToken: 't1' };
  it('excludes offline + exec-disabled by default; forwards canonical os', async () => {
    const r = await listMachines({ ...opts, fetchImpl: list200(items) });
    expect(r.map((m) => m.serverId)).toEqual(['a']); expect(r[0]!.os).toBe('linux');
  });
  it('includes all when includeOffline is set', async () => {
    expect((await listMachines({ ...opts, includeOffline: true, fetchImpl: list200(items) })).length).toBe(3);
  });
  it('throws on non-2xx / transport / non-json (never a silent empty list)', async () => {
    await expect(listMachines({ ...opts, fetchImpl: raw(401, '{}') })).rejects.toBeInstanceOf(MachineControlPlaneError);
    await expect(listMachines({ ...opts, fetchImpl: raw(503, 'unavailable') })).rejects.toBeInstanceOf(MachineControlPlaneError);
    const failing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(listMachines({ ...opts, fetchImpl: failing })).rejects.toBeInstanceOf(MachineControlPlaneError);
  });
  it('throws on strict-item violations: unknown key, non-canonical os, non-controlled role, over-limit', async () => {
    await expect(listMachines({ ...opts, fetchImpl: list200([{ ...items[0], bogus: 1 }]) })).rejects.toBeInstanceOf(MachineControlPlaneError);
    await expect(listMachines({ ...opts, fetchImpl: list200([{ ...items[0], os: 'solaris' }]) })).rejects.toBeInstanceOf(MachineControlPlaneError);
    await expect(listMachines({ ...opts, fetchImpl: list200([{ ...items[0], nodeRole: 'full' }]) })).rejects.toBeInstanceOf(MachineControlPlaneError);
    const tooMany = Array.from({ length: MACHINE_LIST_MAX_ITEMS + 1 }, (_v, i) => ({ ...items[0], serverId: `s${i}`, refName: `r${i}` }));
    await expect(listMachines({ ...opts, fetchImpl: list200(tooMany) })).rejects.toBeInstanceOf(MachineControlPlaneError);
  });
  it('only a valid empty {machines:[]} is a real empty account', async () => {
    expect(await listMachines({ ...opts, fetchImpl: list200([]) })).toEqual([]);
    await expect(listMachines({
      ...opts,
      fetchImpl: (async () => new Response(JSON.stringify({ machines: [], extra: true }), { status: 200 })) as unknown as typeof fetch,
    })).rejects.toBeInstanceOf(MachineControlPlaneError);
  });
});
