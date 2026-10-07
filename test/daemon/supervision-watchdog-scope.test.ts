import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supervisionAutomation } from '../../src/daemon/supervision-automation.js';
import { getSupervisionTaskRegistry, resetSupervisionTaskRegistryForTests } from '../../src/daemon/supervision-state-store.js';
import { isLegacySupervisionInertProject } from '../../src/daemon/task-pairs/engine.js';
import { runSupervisionConvergenceTick } from '../../src/daemon/send-tool.js';

const PAIRS_PROJECT = 'scopeproj';

/**
 * The 60 s watchdog tick used to run lifecycle convergence over every live legacy
 * task, including those of projects the pairs engine owns (the send-path tick and
 * the watchdog loop already skipped them). On a machine with a large legacy
 * history that was ~2.7 s of synchronous SQLite reads on the daemon main thread
 * every minute: Stop and typing froze for that long.
 */
describe('supervision watchdog tick scope', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    resetSupervisionTaskRegistryForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
    resetSupervisionTaskRegistryForTests();
  });

  it('the watchdog tick tells lifecycle convergence to skip pairs-engine projects, like the send-path tick', async () => {
    const registry = getSupervisionTaskRegistry();
    const converge = vi.spyOn(registry, 'convergeLifecycle').mockResolvedValue([]);
    await (supervisionAutomation as unknown as { checkImplementationAssignments(now: number): Promise<void> }).checkImplementationAssignments(Date.now());
    expect(converge).toHaveBeenCalledTimes(1);
    const options = converge.mock.calls[0]![1] as { skipProject?: (project: string) => boolean };
    expect(options.skipProject).toBeTypeOf('function');
    expect(options.skipProject!(PAIRS_PROJECT)).toBe(true);
  });

  it('the send-path tick and the watchdog tick share one predicate, so neither can scan what the other skips', async () => {
    const registry = getSupervisionTaskRegistry();
    const converge = vi.spyOn(registry, 'convergeLifecycle').mockResolvedValue([]);
    await (supervisionAutomation as unknown as { checkImplementationAssignments(now: number): Promise<void> }).checkImplementationAssignments(Date.now());
    const watchdogSkip = (converge.mock.calls[0]![1] as { skipProject: (p: string) => boolean }).skipProject;
    // The watchdog tick also starts the send-path pass in the background; let it finish.
    await new Promise((resolve) => setTimeout(resolve, 100));
    converge.mockClear();
    await runSupervisionConvergenceTick({ registry: registry as never });
    expect(converge).toHaveBeenCalled();
    const sendSkip = (converge.mock.calls[0]![1] as { skipProject: (p: string) => boolean }).skipProject;
    for (const project of [PAIRS_PROJECT, 'other', undefined as unknown as string]) {
      expect(watchdogSkip(project)).toBe(isLegacySupervisionInertProject(project));
      expect(sendSkip(project)).toBe(isLegacySupervisionInertProject(project));
    }
  });

  it('legacy supervision is inert under either engine value (legacy resolves to off), so no project is converged by the legacy pass', () => {
    for (const engine of ['pairs', 'legacy']) {
      process.env.IMCODES_SUPERVISION_ENGINE = engine;
      expect(isLegacySupervisionInertProject(PAIRS_PROJECT)).toBe(true);
    }
    expect(isLegacySupervisionInertProject(undefined)).toBe(true);
  });
});

describe('lifecycle convergence lets the event loop run between tasks', () => {
  it('serves pending I/O (a macrotask) after each candidate instead of running the whole pass back to back', async () => {
    resetSupervisionTaskRegistryForTests();
    const registry = getSupervisionTaskRegistry();
    for (let i = 0; i < 12; i += 1) {
      const created = registry.createOrGet({
        taskId: `yield-task-${i}`, projectName: 'yieldproj', classification: 'independent_top_level',
        objective: `objective ${i}`, currentRevision: `rev-${i}`, auditPolicy: 'auto_allow_degraded',
      });
      expect((created as { ok?: boolean }).ok).toBe(true);
    }
    let turns = 0;
    const timer = setInterval(() => { turns += 1; }, 0);
    // Count macrotask turns the pass leaves room for.
    let immediates = 0;
    const tick = () => { immediates += 1; if (!done) setImmediate(tick); };
    let done = false;
    setImmediate(tick);
    await registry.convergeLifecycle(Date.now(), { skipProject: () => false, resolveAuthoritativeBrain: () => undefined } as never);
    done = true;
    clearInterval(timer);
    // One yield per candidate: with 12 live tasks the loop ran at least 12 macrotask turns.
    expect(immediates).toBeGreaterThanOrEqual(12);
    resetSupervisionTaskRegistryForTests();
  });
});
