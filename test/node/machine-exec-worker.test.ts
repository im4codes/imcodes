import { describe, it, expect, vi } from 'vitest';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import type { RemoteExecRequest, RemoteExecResult } from '../../shared/remote-exec.js';
import { DEFAULT_MACHINE_EXEC_CONCURRENCY, MachineExecWorker } from '../../src/node/machine-exec-worker.js';

const frame = (correlationId: string, command: string, extra: Record<string, unknown> = {}) =>
  ({ type: DAEMON_COMMAND_TYPES.MACHINE_EXEC, correlationId, idempotencyKey: correlationId, command, ...extra });

describe('MachineExecWorker (10.8)', () => {
  it('validates the envelope and rejects an unknown shell without spawning', async () => {
    const w = new MachineExecWorker();
    const r = await w.handle(frame('c1', 'echo hi', { shell: 'zsh' }));
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(/invalid_exec/);
  });

  it('runs a valid command and echoes the correlationId', async () => {
    const w = new MachineExecWorker();
    const r = await w.handle(frame('c2', 'echo hi', { shell: 'sh' }));
    expect(r?.correlationId).toBe('c2');
    expect(r?.ok).toBe(true);
    expect(r?.stdout.trim()).toBe('hi');
  });

  it('forwards ordered live chunks and still returns the complete terminal output', async () => {
    const w = new MachineExecWorker();
    const chunks: Array<{ seq: number; stream: string; chunk: string }> = [];
    const r = await w.handle(
      frame('stream-worker', 'printf one; sleep 0.1; printf two', { shell: 'sh' }),
      (chunk) => chunks.push(chunk),
    );

    expect(chunks.map((chunk) => chunk.seq)).toEqual(chunks.map((_, index) => index));
    expect(chunks.map((chunk) => chunk.chunk).join('')).toBe('onetwo');
    expect(r?.stdout).toBe('onetwo');
  });

  it('supports 10 concurrent commands by default, rejects the 11th, and reuses a released slot', async () => {
    const releases = new Map<string, () => void>();
    const run = vi.fn((request: RemoteExecRequest) => new Promise<RemoteExecResult>((resolve) => {
      releases.set(request.requestId, () => {
        releases.delete(request.requestId);
        resolve({
          requestId: request.requestId,
          ok: true,
          exitCode: 0,
          stdout: request.command,
          stderr: '',
          durationMs: 1,
        });
      });
    }));
    const w = new MachineExecWorker(run);
    const running = Array.from({ length: DEFAULT_MACHINE_EXEC_CONCURRENCY }, (_, index) => (
      w.handle(frame(`parallel-${index}`, `command-${index}`, { shell: 'sh' }))
    ));

    expect(w.inFlightCount).toBe(10);
    expect(w.isBusy).toBe(true);
    const busy = await w.handle(frame('parallel-10', 'command-10', { shell: 'sh' }));
    expect(busy?.error).toBe('busy');
    expect(run).toHaveBeenCalledTimes(10);

    releases.get('parallel-0')?.();
    await running[0];
    expect(w.inFlightCount).toBe(9);
    expect(w.isBusy).toBe(false);

    const replacement = w.handle(frame('parallel-11', 'command-11', { shell: 'sh' }));
    expect(run).toHaveBeenCalledTimes(11);
    expect(w.inFlightCount).toBe(10);

    for (const release of [...releases.values()]) release();
    await Promise.all([...running.slice(1), replacement]);
    expect(w.inFlightCount).toBe(0);
  });

  it('honors an explicit single-command concurrency cap', async () => {
    const w = new MachineExecWorker(undefined, undefined, 1);
    const slow = w.handle(frame('c3', 'sleep 1', { shell: 'sh' }));
    // Second arrives while the first is in flight.
    const busy = await w.handle(frame('c4', 'echo hi', { shell: 'sh' }));
    expect(busy?.error).toBe('busy');
    expect(busy?.ok).toBe(false);
    w.abortAll(); // free the first
    const first = await slow;
    expect(first?.ok).toBe(false); // aborted
  });

  it('abortAll aborts every concurrent command', async () => {
    const run = vi.fn((request: RemoteExecRequest, options: { signal?: AbortSignal }) => new Promise<RemoteExecResult>((resolve) => {
      options.signal?.addEventListener('abort', () => resolve({
        requestId: request.requestId,
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 1,
        error: 'aborted',
      }), { once: true });
    }));
    const w = new MachineExecWorker(run);
    const running = [0, 1, 2].map((index) => w.handle(frame(`abort-${index}`, 'wait', { shell: 'sh' })));

    expect(w.inFlightCount).toBe(3);
    w.abortAll();
    const results = await Promise.all(running);
    expect(results.map((result) => result?.error)).toEqual(['aborted', 'aborted', 'aborted']);
    expect(w.inFlightCount).toBe(0);
  });

  it('abortAll kills the in-flight command (disconnect)', async () => {
    const w = new MachineExecWorker();
    const p = w.handle(frame('c5', 'sleep 5', { shell: 'sh' }));
    setTimeout(() => w.abortAll(), 50);
    const r = await p;
    expect(r?.ok).toBe(false);
    expect(r?.error).toBe('aborted');
    expect(r?.durationMs).toBeLessThan(4000);
  });
});
