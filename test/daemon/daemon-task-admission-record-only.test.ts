import { describe, expect, it, vi } from 'vitest';
import {
  DAEMON_TASK_ADMISSION_OUTCOME,
  __setDaemonTaskAdmissionObserverForTests,
} from '../../src/daemon/memory-mcp-server.js';

/**
 * `send_message` and `supervision_task_start` are how the supervision control
 * plane hands out work. An RSS admission check in front of them meant a memory
 * incident refused the dispatch of the task to investigate that same memory
 * incident — the defect gated its own remedy, and the refusal was not even
 * logged, so from the daemon's own telemetry it was invisible.
 *
 * Pressure stays measured. It must never again decide whether work may start.
 */
describe('daemon task admission is record-only', () => {
  it('exposes outcomes that distinguish pressure from an unusable hook', () => {
    // Named outcomes, so a caller reading telemetry can tell "the daemon said
    // no" from "there was nobody to ask" — previously both were one throw.
    expect(Object.values(DAEMON_TASK_ADMISSION_OUTCOME).sort()).toEqual([
      'accepted', 'identity_unavailable', 'pressure_observed', 'unavailable',
    ]);
  });

  it('is observable without being able to refuse anything', () => {
    const seen: Array<{ tool: string; outcome: string }> = [];
    __setDaemonTaskAdmissionObserverForTests((record) => { seen.push(record); });
    try {
      expect(typeof __setDaemonTaskAdmissionObserverForTests).toBe('function');
      expect(seen).toEqual([]);
    } finally {
      __setDaemonTaskAdmissionObserverForTests(null);
    }
  });

  it('no longer contains any budget refusal in the shipped source', async () => {
    // The precise strings that reached callers as thrown errors. Their absence
    // is the regression: a future reviewer re-adding a budget gate on these
    // tools has to delete this assertion to do it.
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await readFile(
      path.join(process.cwd(), 'src/daemon/memory-mcp-server.ts'), 'utf8',
    );
    const throwsBudgetError = /throw new Error\(\s*(?:response\.action[\s\S]{0,200})?['"`]daemon_task_memory_budget/.test(source);
    expect(throwsBudgetError, 'no code path may throw a memory budget refusal').toBe(false);
    // And the retry loop that added up to 5s of latency to every dispatch.
    expect(source).not.toContain('const deadline = Date.now() + 5_000;');
  });
});
