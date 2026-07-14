import { describe, it, expect } from 'vitest';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { MachineExecWorker } from '../../src/node/machine-exec-worker.js';

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

  it('rejects a second concurrent command as busy (no double-spawn)', async () => {
    const w = new MachineExecWorker();
    const slow = w.handle(frame('c3', 'sleep 1', { shell: 'sh' }));
    // Second arrives while the first is in flight.
    const busy = await w.handle(frame('c4', 'echo hi', { shell: 'sh' }));
    expect(busy?.error).toBe('busy');
    expect(busy?.ok).toBe(false);
    w.abortAll(); // free the first
    const first = await slow;
    expect(first?.ok).toBe(false); // aborted
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
