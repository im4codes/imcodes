import { afterEach, describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers';
import { VitestTestRunner } from 'vitest/runners';
import CooperativeRunner from './cooperative-runner.js';
import config from '../../vitest.config.js';

// Test the extension hooks without constructing a second runner/snapshot state
// inside this live worker. The inherited implementation is separately exercised
// by every daemon file and the real subprocess causal probe.
const task = {} as Parameters<VitestTestRunner['onAfterRunTask']>[0];
const suite = {} as Parameters<VitestTestRunner['onAfterRunSuite']>[0];
const receiver = {} as CooperativeRunner;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cooperative daemon runner', () => {
  it('delegates stock task completion and yields an actual IO turn', async () => {
    const stock = vi.spyOn(VitestTestRunner.prototype, 'onAfterRunTask').mockImplementation(() => {});
    let serviced = false;
    setImmediate(() => { serviced = true; });
    const finished = CooperativeRunner.prototype.onAfterRunTask.call(receiver, task);
    expect(stock).toHaveBeenCalledWith(task);
    expect(serviced).toBe(false);
    await finished;
    expect(serviced).toBe(true);
  });

  it('yields without advancing or depending on fake timers', async () => {
    vi.spyOn(VitestTestRunner.prototype, 'onAfterRunTask').mockImplementation(() => {});
    vi.useFakeTimers();
    const frozen = Date.now();
    let fired = false;
    setTimeout(() => { fired = true; }, 1);
    await CooperativeRunner.prototype.onAfterRunTask.call(receiver, task);
    expect(Date.now()).toBe(frozen);
    expect(fired).toBe(false);
  });

  it('awaits stock suite completion before yielding', async () => {
    let complete!: () => void;
    const stock = vi.spyOn(VitestTestRunner.prototype, 'onAfterRunSuite')
      .mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    let finished = false;
    const pending = CooperativeRunner.prototype.onAfterRunSuite.call(receiver, suite)
      .then(() => { finished = true; });
    await Promise.resolve();
    expect(stock).toHaveBeenCalledWith(suite);
    expect(finished).toBe(false);
    complete();
    await pending;
    expect(finished).toBe(true);
  });

  it('propagates stock task errors', async () => {
    const failure = new Error('stock task failure');
    vi.spyOn(VitestTestRunner.prototype, 'onAfterRunTask').mockImplementation(() => { throw failure; });
    await expect(CooperativeRunner.prototype.onAfterRunTask.call(receiver, task)).rejects.toBe(failure);
  });

  it('propagates stock suite errors', async () => {
    const failure = new Error('stock suite failure');
    vi.spyOn(VitestTestRunner.prototype, 'onAfterRunSuite').mockRejectedValue(failure);
    await expect(CooperativeRunner.prototype.onAfterRunSuite.call(receiver, suite)).rejects.toBe(failure);
  });

  it('only changes the daemon runner, not collection, timeouts or error policy', () => {
    const projects = config.test!.projects!;
    const daemon = projects[0] as { test: Record<string, unknown> };
    expect(daemon.test.runner).toBe('./test/setup/cooperative-runner.ts');
    expect(daemon.test.testTimeout).toBe(20_000);
    expect(daemon.test.include).toEqual(['src/**/*.test.ts', 'test/**/*.test.ts']);
    expect(daemon.test.ignoreUnhandledErrors).not.toBe(true);
    expect(config.test!.ignoreUnhandledErrors).not.toBe(true);
    for (const project of projects.slice(1)) {
      if (typeof project !== 'string') expect(project).not.toHaveProperty('test.runner');
    }
  });
});
