import { describe, it, expect } from 'vitest';
import {
  runRemoteExec,
  defaultRemoteExecShell,
  shellInvocation,
  utf8ExecEnvironment,
} from '../../src/node/exec-runner.js';
import {
  REMOTE_EXEC_MAX_CHUNK_BYTES,
  REMOTE_EXEC_MAX_OUTPUT_BYTES,
  REMOTE_EXEC_MIN_TIMEOUT_MS,
  type RemoteExecOutputChunk,
} from '../../shared/remote-exec.js';

// Cross-platform: tests drive `sh` explicitly so they run on the CI/dev Mac.
// (On the real Windows target the node defaults to powershell.)
const SH = 'sh' as const;

describe('runRemoteExec', () => {
  it('captures stdout and a zero exit code for a successful command', async () => {
    const r = await runRemoteExec({ requestId: 'r1', command: 'echo hello', shell: SH });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hello');
    expect(r.stderr).toBe('');
    expect(r.timedOut).toBeUndefined();
  });

  it('reports a non-zero exit code but still ok (process ran to completion)', async () => {
    const r = await runRemoteExec({ requestId: 'r2', command: 'exit 3', shell: SH });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(3);
  });

  it('captures stderr', async () => {
    const r = await runRemoteExec({ requestId: 'r3', command: 'echo oops 1>&2; exit 1', shell: SH });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.trim()).toBe('oops');
  });

  it('preserves non-ASCII text on both UTF-8 output streams', async () => {
    const r = await runRemoteExec({
      requestId: 'utf8-streams',
      command: `printf '中文✓'; printf '错误✓' >&2`,
      shell: SH,
    });
    expect(r).toMatchObject({ ok: true, exitCode: 0, stdout: '中文✓', stderr: '错误✓' });
  });

  it('emits ordered stdout/stderr chunks before returning the terminal result', async () => {
    const chunks: RemoteExecOutputChunk[] = [];
    let settled = false;
    const promise = runRemoteExec({
      requestId: 'stream',
      command: "printf first; sleep 0.1; printf err >&2; printf second",
      shell: SH,
    }, {
      onChunk: (chunk) => {
        expect(settled).toBe(false);
        chunks.push(chunk);
      },
    });
    const result = await promise;
    settled = true;

    expect(chunks.map((chunk) => chunk.seq)).toEqual(chunks.map((_, index) => index));
    expect(chunks.filter((chunk) => chunk.stream === 'stdout').map((chunk) => chunk.chunk).join('')).toBe(result.stdout);
    expect(chunks.filter((chunk) => chunk.stream === 'stderr').map((chunk) => chunk.chunk).join('')).toBe(result.stderr);
    expect(result.stdout).toBe('firstsecond');
    expect(result.stderr).toBe('err');
  });

  it('splits large live fragments at the per-frame UTF-8 byte cap', async () => {
    const chunks: RemoteExecOutputChunk[] = [];
    const result = await runRemoteExec({
      requestId: 'stream-cap',
      command: `yes 你 | head -c ${REMOTE_EXEC_MAX_CHUNK_BYTES * 2}`,
      shell: SH,
      timeoutMs: 15_000,
    }, { onChunk: (chunk) => chunks.push(chunk) });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk.chunk, 'utf8') <= REMOTE_EXEC_MAX_CHUNK_BYTES)).toBe(true);
    expect(chunks.map((chunk) => chunk.chunk).join('')).toBe(result.stdout);
  });

  it('preserves a UTF-8 code point split across process data events', async () => {
    const chunks: RemoteExecOutputChunk[] = [];
    const result = await runRemoteExec({
      requestId: 'split-utf8',
      command: `node -e "process.stdout.write(Buffer.from([0xe4,0xbd])); setTimeout(() => process.stdout.write(Buffer.from([0xa0])), 50)"`,
      shell: SH,
    }, { onChunk: (chunk) => chunks.push(chunk) });

    expect(result.stdout).toBe('你');
    expect(chunks.map((chunk) => chunk.chunk).join('')).toBe('你');
  });

  it('reports an incomplete trailing UTF-8 sequence instead of dropping it', async () => {
    const r = await runRemoteExec({
      requestId: 'incomplete-utf8',
      command: `node -e "process.stdout.write(Buffer.from([0xe4,0xbd]))"`,
      shell: SH,
    });
    expect(r.stdout).toBe('\uFFFD');
  });

  it('kills and flags a command that exceeds its timeout', async () => {
    const r = await runRemoteExec({ requestId: 'r4', command: 'sleep 5', shell: SH, timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(true);
    expect(r.error).toMatch(/timed out/);
    expect(r.durationMs).toBeLessThan(4000);
  });

  it('reports a spawn failure as ok:false with an error (no throw)', async () => {
    const r = await runRemoteExec({ requestId: 'r5', command: 'noop', shell: 'bash', cwd: '/nonexistent-dir-xyz' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('never reports signal termination as a completed result with a null exit code', async () => {
    const r = await runRemoteExec({ requestId: 'signal', command: 'kill -TERM $$', shell: SH });
    expect(r).toMatchObject({ ok: false, exitCode: null });
    expect(r.error).toMatch(/signal/i);
  });

  it('rejects a timeout below the shared minimum instead of silently clamping it', async () => {
    const r = await runRemoteExec({
      requestId: 'invalid-timeout', command: 'echo must-not-run', shell: SH,
      timeoutMs: REMOTE_EXEC_MIN_TIMEOUT_MS - 1,
    });
    expect(r).toMatchObject({ ok: false, exitCode: null, stdout: '', error: 'invalid timeoutMs' });
  });

  it('caps and flags oversized output as truncated', async () => {
    // Emit well over the cap; the result must be bounded and flagged.
    const r = await runRemoteExec({
      requestId: 'r6',
      command: `yes X | head -c ${REMOTE_EXEC_MAX_OUTPUT_BYTES * 2}`,
      shell: SH,
      timeoutMs: 15_000,
    });
    expect(r.stdout.length).toBeLessThanOrEqual(REMOTE_EXEC_MAX_OUTPUT_BYTES);
    expect(r.truncated).toBe(true);
  });

  it('applies the output cap in bytes rather than UTF-16 characters', async () => {
    const r = await runRemoteExec({
      requestId: 'r7',
      command: `yes 你 | head -c ${REMOTE_EXEC_MAX_OUTPUT_BYTES * 2}`,
      shell: SH,
      timeoutMs: 15_000,
    });
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(REMOTE_EXEC_MAX_OUTPUT_BYTES);
    expect(r.truncated).toBe(true);
  });

  it('defaults to powershell on win32 and sh elsewhere', () => {
    expect(defaultRemoteExecShell('win32')).toBe('powershell');
    expect(defaultRemoteExecShell('darwin')).toBe('sh');
    expect(defaultRemoteExecShell('linux')).toBe('sh');
  });

  it('normalizes child-process locale and common runtime output to UTF-8', () => {
    const base = { PATH: '/bin', LANG: 'zh_CN.GBK', PYTHONUTF8: '0' };
    const env = utf8ExecEnvironment(base);
    expect(env).toMatchObject({
      PATH: '/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    });
    expect(base).toEqual({ PATH: '/bin', LANG: 'zh_CN.GBK', PYTHONUTF8: '0' });
  });

  it('builds a non-interactive, no-profile, UTF-8-forced powershell invocation', () => {
    const { file, args } = shellInvocation('powershell', 'Get-Date');
    expect(file).toBe('powershell.exe');
    expect(args).toContain('-NonInteractive');
    expect(args).toContain('-NoProfile');
    // UTF-8 preamble prepended (verified on real Windows: fixes gb2312 mojibake),
    // user command preserved at the end.
    const command = args[args.length - 1];
    expect(command.match(/\[System\.Text\.Encoding\]::UTF8/g)).toHaveLength(3);
    expect(command).toContain('[Console]::InputEncoding=');
    expect(command).toContain('[Console]::OutputEncoding=');
    expect(command.endsWith('Get-Date')).toBe(true);
  });

  it('delays cmd command parsing until after its Windows console is UTF-8', () => {
    const command = 'echo 中文✓ & echo 错误✓ 1>&2';
    const { file, args, env } = shellInvocation('cmd', command);
    expect(file).toBe('powershell.exe');
    expect(args).toContain('-NonInteractive');
    expect(args.at(-1)).toContain('& cmd.exe /d /s /c $env:IMCODES_REMOTE_EXEC_COMMAND');
    expect(args.at(-1)).toContain('exit $LASTEXITCODE');
    expect(args.join('')).not.toContain(command);
    expect(env).toEqual({ IMCODES_REMOTE_EXEC_COMMAND: command });
  });

  it.skipIf(process.platform !== 'win32')('preserves cmd Unicode input, both output streams, and exit status on Windows', async () => {
    const r = await runRemoteExec({
      requestId: 'cmd-utf8',
      command: 'echo 中文✓ & echo 错误✓ 1>&2 & exit 7',
      shell: 'cmd',
    });
    expect(r).toMatchObject({ ok: true, exitCode: 7 });
    expect(r.stdout.trim()).toBe('中文✓');
    expect(r.stderr.trim()).toBe('错误✓');
    expect(r.stdout).not.toMatch(/Active code page|活动代码页/);
  });
});
