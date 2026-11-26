// Load-bearing regression coverage for the async native-exec helpers.
//
// These exist because converting the macOS/common native specs from
// spawnSync to an async helper silently changed two child-process
// semantics, and both produced confusing failures far from the cause:
//
//   1. execFile opens a stdin pipe and never closes it. spawnSync hands the
//      child an already-EOF stdin. A compiled probe CLI that reads stdin to
//      EOF therefore blocked FOREVER — the suite sat at 0% CPU with no
//      progress and no failing assertion.
//   2. The helper ignored `input`, so grants arrived empty and the native
//      parser rejected them with a domain error (grant_frame_unusable) that
//      looked like a production bug rather than a harness bug.
//
// Each test below fails if the corresponding semantic is dropped again.

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { runNative, runNativeOrThrow } from './native-exec.js';

describe('native-exec async child-process helpers', () => {
  it('closes stdin so a child that reads to EOF terminates', async () => {
    // Without `child.stdin.end()` this never resolves and the test times out.
    const result = await runNative('cat', []);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  }, 20_000);

  it('delivers `input` verbatim on stdin, like spawnSync', async () => {
    const payload = 'grant1 uid=501 asid=100003\nsecond-line\n';
    const asyncResult = await runNative('cat', [], { input: payload });
    const syncResult = spawnSync('cat', [], { input: payload, encoding: 'utf8' });
    expect(asyncResult.stdout).toBe(payload);
    // Parity with the synchronous form it replaced, not just self-consistency.
    expect(asyncResult.stdout).toBe(syncResult.stdout);
    expect(asyncResult.status).toBe(syncResult.status);
  }, 20_000);

  it('reports a non-zero exit through `status` without rejecting', async () => {
    const asyncResult = await runNative('sh', ['-c', 'echo out; echo err >&2; exit 3']);
    const syncResult = spawnSync('sh', ['-c', 'echo out; echo err >&2; exit 3'], {
      encoding: 'utf8',
    });
    expect(asyncResult.status).toBe(3);
    expect(asyncResult.status).toBe(syncResult.status);
    expect(asyncResult.stdout.trim()).toBe('out');
    expect(asyncResult.stderr.trim()).toBe('err');
  }, 20_000);

  it('preserves cwd and env exactly', async () => {
    const cwdResult = await runNative('sh', ['-c', 'pwd'], { cwd: '/tmp' });
    expect(cwdResult.stdout.trim()).toBe(spawnSync('sh', ['-c', 'pwd'], {
      cwd: '/tmp',
      encoding: 'utf8',
    }).stdout.trim());
    const envResult = await runNative('sh', ['-c', 'printf %s "$CDE_PROBE"'], {
      env: { ...process.env, CDE_PROBE: 'exact-value' },
    });
    expect(envResult.stdout).toBe('exact-value');
  }, 20_000);

  it('runNativeOrThrow rejects on non-zero and carries stdout/stderr', async () => {
    await expect(runNativeOrThrow('cat', [], { input: 'ok\n' })).resolves.toBe('ok\n');
    await expect(
      runNativeOrThrow('sh', ['-c', 'echo boom >&2; exit 7']),
    ).rejects.toMatchObject({ status: 7, stderr: expect.stringContaining('boom') });
  }, 20_000);
});
