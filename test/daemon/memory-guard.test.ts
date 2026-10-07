/**
 * 158 (2026-10-07): the daemon main process died twice of V8 heap exhaustion (1.2 GB -> 8.2 GB in under two
 * minutes), leaving nothing but a GC trace and a half-written sessions.json.tmp. The guard acts before the
 * limit: shed heavy reads, write a sanitised diagnostic, restart in a controlled way - and never loop.
 * (The 8 GB runaway itself was NOT reproduced; the guard is what captures it next time.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import v8 from 'node:v8';
import {
  DAEMON_DIAGNOSTICS_DIR,
  DAEMON_HEAP_RESTART_RATIO,
  DAEMON_HEAP_WARN_RATIO,
  DAEMON_MEMORY_DIAGNOSTIC_KEEP,
  DAEMON_MEMORY_GUARD_DIAGNOSTIC_MIN_INTERVAL_MS,
  DAEMON_MEMORY_GUARD_EXIT_CODE,
  DAEMON_MEMORY_GUARD_MAX_RESTARTS_IN_WINDOW,
  DAEMON_MEMORY_GUARD_RESTART_WINDOW_MS,
  classifyDaemonHeap,
  daemonFatalReportNodeOptions,
} from '../../shared/daemon-memory-guard.js';
import {
  createMemoryGuard,
  isMemoryPressureShedding,
  readGuardRestarts,
  recordGuardRestart,
  setActiveMemoryGuardForTests,
  startMemoryGuard,
  stopMemoryGuard,
  writeMemoryDiagnostic,
  type MemoryGuardDeps,
} from '../../src/daemon/memory-guard.js';
import { collectMemoryProbes, registerMemoryProbe, resetMemoryProbesForTests } from '../../src/daemon/memory-probes.js';

const LIMIT = 8_000_000_000;
const at = (ratio: number) => Math.round(LIMIT * ratio);

function harness(overrides: Partial<MemoryGuardDeps> = {}) {
  let now = 1_000_000_000;
  let used = at(0.2);
  const restarts: number[] = [];
  const state = {
    diagnostics: [] as Array<Record<string, unknown>>,
    restartReasons: [] as string[],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const deps: MemoryGuardDeps = {
    now: () => now,
    heap: () => ({ usedBytes: used, limitBytes: LIMIT }),
    writeDiagnostic: (data) => { state.diagnostics.push(data); return `/diag/${state.diagnostics.length}.json`; },
    probes: () => ({ sessionStore: { rows: 180 } }),
    restart: async (reason) => { state.restartReasons.push(reason); },
    readRestarts: () => [...restarts],
    recordRestart: (when) => { restarts.push(when); },
    log: state.log,
    ...overrides,
  };
  const guard = createMemoryGuard(deps);
  return { guard, state, restarts, setUsed: (ratio: number) => { used = at(ratio); }, advance: (ms: number) => { now += ms; } };
}

describe('heap classification', () => {
  it('warns at 60 % and restarts at 85 % of the limit (shared defaults)', () => {
    expect([DAEMON_HEAP_WARN_RATIO, DAEMON_HEAP_RESTART_RATIO]).toEqual([0.6, 0.85]);
    expect(classifyDaemonHeap(at(0.59), LIMIT)).toBe('ok');
    expect(classifyDaemonHeap(at(0.6), LIMIT)).toBe('warn');
    expect(classifyDaemonHeap(at(0.85), LIMIT)).toBe('critical');
    expect(classifyDaemonHeap(1, 0)).toBe('ok');
  });
});

describe('memory guard state machine', () => {
  it('does nothing while the heap is healthy', async () => {
    const h = harness();
    h.setUsed(0.3);
    expect(await h.guard.tick()).toBe('ok');
    expect(h.guard.isShedding()).toBe(false);
    expect(h.state.diagnostics).toHaveLength(0);
    expect(h.state.restartReasons).toHaveLength(0);
  });

  it('past 60 % it sheds heavy reads and writes ONE diagnostic, then stays quiet until the interval passes', async () => {
    const h = harness();
    h.setUsed(0.7);
    expect(await h.guard.tick()).toBe('warn');
    expect(h.guard.isShedding()).toBe(true);
    expect(h.state.diagnostics).toHaveLength(1);
    expect(h.state.diagnostics[0]).toMatchObject({ reason: 'heap_warn', heap: { usedBytes: at(0.7), limitBytes: LIMIT }, subsystems: { sessionStore: { rows: 180 } } });
    await h.guard.tick(); await h.guard.tick();
    expect(h.state.diagnostics).toHaveLength(1);
    h.advance(DAEMON_MEMORY_GUARD_DIAGNOSTIC_MIN_INTERVAL_MS + 1);
    await h.guard.tick();
    expect(h.state.diagnostics).toHaveLength(2);
    expect(h.state.restartReasons).toHaveLength(0);
  });

  it('a collection that brings the heap back down means garbage, not live data: no shedding, no diagnostic', async () => {
    let used = at(0.7);
    const gc = vi.fn(() => { used = at(0.3); });
    const h = harness({ heap: () => ({ usedBytes: used, limitBytes: LIMIT }), gc });
    expect(await h.guard.tick()).toBe('ok');
    expect(gc).toHaveBeenCalledTimes(1);
    expect(h.guard.isShedding()).toBe(false);
    expect(h.state.diagnostics).toHaveLength(0);
  });

  it('stops shedding only well below the warn line (no flapping on the edge)', async () => {
    const h = harness();
    h.setUsed(0.65); await h.guard.tick();
    h.setUsed(0.58); await h.guard.tick();
    expect(h.guard.isShedding()).toBe(true);
    h.setUsed(0.5); await h.guard.tick();
    expect(h.guard.isShedding()).toBe(false);
  });

  it('past 85 % it writes the diagnostic and restarts once, even if sampled again while the shutdown runs', async () => {
    let finish!: () => void;
    const restart = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const h = harness({ restart });
    h.setUsed(0.9);
    const first = h.guard.tick();
    await Promise.resolve();
    expect(await h.guard.tick()).toBe('critical'); // re-sampled during the shutdown: no second restart
    finish(); await first;
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart.mock.calls[0]![0]).toMatch(/heap \d+ MB of \d+ MB/);
    expect(h.restarts).toHaveLength(1);
    expect(h.state.diagnostics.map((entry) => entry.reason)).toContain('heap_restart');
  });

  it('a diagnostic that cannot be written does not stop the restart', async () => {
    const h = harness({ writeDiagnostic: () => undefined });
    h.setUsed(0.95);
    await h.guard.tick();
    expect(h.state.restartReasons).toHaveLength(1);
  });

  it('restart-loop protection: past the limit of restarts inside the window it does NOT restart again, refuses load and alerts once', async () => {
    const h = harness();
    for (let i = 0; i < DAEMON_MEMORY_GUARD_MAX_RESTARTS_IN_WINDOW; i += 1) h.restarts.push(1_000_000_000 - 60_000 * (i + 1));
    h.setUsed(0.95);
    expect(await h.guard.tick()).toBe('critical');
    await h.guard.tick();
    expect(h.state.restartReasons).toHaveLength(0);
    expect(h.guard.isRestartSuppressed()).toBe(true);
    expect(h.guard.isShedding()).toBe(true);
    expect(h.state.log.error).toHaveBeenCalledTimes(1); // the alert, not one per sample
    // The heap recovers: the suppression lifts.
    h.setUsed(0.2); await h.guard.tick();
    expect(h.guard.isRestartSuppressed()).toBe(false);
  });

  it('restarts older than the window do not count', async () => {
    const h = harness();
    h.restarts.push(1_000_000_000 - DAEMON_MEMORY_GUARD_RESTART_WINDOW_MS - 1, 1_000_000_000 - DAEMON_MEMORY_GUARD_RESTART_WINDOW_MS - 2);
    h.setUsed(0.95);
    await h.guard.tick();
    expect(h.state.restartReasons).toHaveLength(1);
  });

  it('a restart that fails can be retried on the next sample', async () => {
    let calls = 0;
    const h = harness({ restart: async () => { calls += 1; if (calls === 1) throw new Error('shutdown failed'); } });
    h.setUsed(0.95);
    await h.guard.tick(); await h.guard.tick();
    expect(calls).toBe(2);
  });

  it('SYNTHETIC ALLOCATION: a real heap growing past 85 % of an artificial limit triggers the controlled restart', async () => {
    const baseline = v8.getHeapStatistics().used_heap_size;
    const artificialLimit = baseline + 120 * 1024 * 1024;
    const restart = vi.fn(async () => undefined);
    const guard = createMemoryGuard({
      now: () => Date.now(),
      heap: () => ({ usedBytes: v8.getHeapStatistics().used_heap_size, limitBytes: artificialLimit }),
      writeDiagnostic: () => '/diag/real.json', probes: () => ({}), restart,
      readRestarts: () => [], recordRestart: () => undefined, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(await guard.tick()).toBe('ok');
    const hold: string[][] = [];
    for (let i = 0; i < 200 && guard.level() !== 'critical'; i += 1) {
      hold.push(Array.from({ length: 200_000 }, (_, k) => `synthetic-${i}-${k}`));
      await guard.tick();
    }
    expect(guard.level()).toBe('critical');
    expect(restart).toHaveBeenCalledTimes(1);
    hold.length = 0;
  }, 60_000);
});

describe('production wiring', () => {
  let stateDir = '';
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'imcodes-memory-guard-')); });
  afterEach(() => { stopMemoryGuard(); setActiveMemoryGuardForTests(null); resetMemoryProbesForTests(); rmSync(stateDir, { recursive: true, force: true }); });

  it('the shedding flag is process-wide and off by default', () => {
    expect(isMemoryPressureShedding()).toBe(false);
    setActiveMemoryGuardForTests({ tick: async () => 'warn', level: () => 'warn', isShedding: () => true, isRestartSuppressed: () => false, start() {}, stop() {} });
    expect(isMemoryPressureShedding()).toBe(true);
  });

  it('startMemoryGuard creates the diagnostics directory and stops cleanly', () => {
    const guard = startMemoryGuard({ stateDir, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, shutdown: async () => undefined });
    expect(existsSync(join(stateDir, DAEMON_DIAGNOSTICS_DIR))).toBe(true);
    expect(guard.level()).toBe('ok');
    stopMemoryGuard();
  });

  it('a diagnostic is 0600, keeps only the newest few, and carries numbers only', () => {
    registerMemoryProbe('leaky', () => ({ rows: 5, secret: 'sk-live-should-never-appear' as unknown as number, nan: Number.NaN, flag: true }));
    registerMemoryProbe('broken', () => { throw new Error('boom'); });
    const probes = collectMemoryProbes();
    expect(probes).toEqual({ leaky: { rows: 5, flag: 1 }, broken: { probeFailed: 1 } });
    let last: string | undefined;
    for (let i = 0; i < DAEMON_MEMORY_DIAGNOSTIC_KEEP + 4; i += 1) last = writeMemoryDiagnostic(stateDir, { reason: 'test', subsystems: probes }, 1_790_000_000_000 + i * 1000);
    const dir = join(stateDir, DAEMON_DIAGNOSTICS_DIR);
    expect(readdirSync(dir).filter((name) => name.startsWith('memory-'))).toHaveLength(DAEMON_MEMORY_DIAGNOSTIC_KEEP);
    expect(statSync(last!).mode & 0o777).toBe(0o600);
    expect(readFileSync(last!, 'utf8')).not.toContain('sk-live');
  });

  it('restarts persist across processes and age out of the window', () => {
    const now = 1_790_000_000_000;
    recordGuardRestart(stateDir, now - DAEMON_MEMORY_GUARD_RESTART_WINDOW_MS - 5_000);
    recordGuardRestart(stateDir, now - 1_000);
    expect(readGuardRestarts(stateDir)).toEqual([now - 1_000]); // the old one was pruned by the second write
    writeFileSync(join(stateDir, DAEMON_DIAGNOSTICS_DIR, 'memory-guard-state.json'), '{not json');
    expect(readGuardRestarts(stateDir)).toEqual([]);
    mkdirSync(join(stateDir, DAEMON_DIAGNOSTICS_DIR), { recursive: true });
  });

  it('the exit status is the shared guard code, and generated units ask the runtime for a fatal-error report', () => {
    expect(DAEMON_MEMORY_GUARD_EXIT_CODE).toBe(75);
    expect(daemonFatalReportNodeOptions('/home/u/.imcodes')).toBe('--report-on-fatalerror --report-compact --report-directory=/home/u/.imcodes/diagnostics');
  });
});
