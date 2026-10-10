import { setImmediate } from 'node:timers';
import { VitestTestRunner } from 'vitest/runners';

// Capture before tests install fake timers or stub globals. A microtask yield
// (Promise.resolve) does not service the worker's IPC responses.
const scheduleIo = setImmediate;
const yieldToIo = () => new Promise<void>((resolve) => scheduleIo(resolve));

/**
 * Keep synchronous fixture chains from starving Vitest's result-update RPC.
 * Individual tests can finish within testTimeout while their uninterrupted
 * microtask chain exceeds birpc's separate 60s deadline. Yield between tasks,
 * not inside assertions; retain the stock runner's snapshots, retries, mocks,
 * cancellation and error handling. No RPC/test timeout or failure is relaxed.
 */
export default class CooperativeRunner extends VitestTestRunner {
  override async onAfterRunTask(task: Parameters<VitestTestRunner['onAfterRunTask']>[0]): Promise<void> {
    super.onAfterRunTask(task);
    await yieldToIo();
  }

  override async onAfterRunSuite(suite: Parameters<VitestTestRunner['onAfterRunSuite']>[0]): Promise<void> {
    await super.onAfterRunSuite(suite);
    await yieldToIo();
  }
}
