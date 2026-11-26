/**
 * 158 (2026-10-07): the daemon main process died twice of V8 heap exhaustion (1.2 GB -> 8.2 GB in under two
 * minutes), leaving nothing but a GC trace and a half-written sessions.json.tmp. The guard acts before the
 * limit: shed heavy reads, write a sanitised diagnostic, restart in a controlled way - and never loop.
 * (The 8 GB runaway itself was NOT reproduced; the guard is what captures it next time.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import v8 from 'node:v8';
import {
  DAEMON_DIAGNOSTICS_DIR,
  DAEMON_HEAP_RESTART_RATIO,
  DAEMON_HEAP_WARN_RATIO,
  DAEMON_MEMORY_DIAGNOSTIC_KEEP,
  DAEMON_MEMORY_GUARD_DIAGNOSTIC_MIN_INTERVAL_MS,
  DAEMON_FATAL_REPORT_SANITIZED_KEY,
  DAEMON_MEMORY_GUARD_EXIT_CODE,
  DAEMON_MEMORY_GUARD_GC_MAX_INTERVAL_MS,
  DAEMON_MEMORY_GUARD_GC_MIN_INTERVAL_MS,
  DAEMON_MEMORY_GUARD_MAX_RESTARTS_IN_WINDOW,
  DAEMON_MEMORY_GUARD_RESTART_WINDOW_MS,
  classifyDaemonHeap,
  daemonFatalReportNodeOptions,
} from '../../shared/daemon-memory-guard.js';
import {
  createMemoryGuard,
  isMemoryPressureShedding,
  isRunningUnderSupervisor,
  sanitizeFatalReports,
  readGuardRestarts,
  recordGuardRestart,
  setActiveMemoryGuardForTests,
  startMemoryGuard,
  stopMemoryGuard,
  writeMemoryDiagnostic,
  type MemoryGuardDeps,
} from '../../src/daemon/memory-guard.js';
import { collectMemoryProbes, registerMemoryProbe, resetMemoryProbesForTests } from '../../src/daemon/memory-probes.js';
import { excludeEnvironmentFromReports, reportExcludeEnvFlagUsable } from '../../src/util/report-privacy.js';

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

describe('collection back-off and supervision', () => {
  it('a collection that does not bring the heap down means live data: the next one waits twice as long, up to a cap, and resets when healthy', async () => {
    const gc = vi.fn();
    const h = harness({ gc });
    h.setUsed(0.7);
    await h.guard.tick(); // 1st collection
    expect(gc).toHaveBeenCalledTimes(1);
    h.advance(DAEMON_MEMORY_GUARD_GC_MIN_INTERVAL_MS + 1); await h.guard.tick();
    expect(gc).toHaveBeenCalledTimes(1); // the interval is 20 s now
    h.advance(DAEMON_MEMORY_GUARD_GC_MIN_INTERVAL_MS + 1); await h.guard.tick();
    expect(gc).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 12; i += 1) { h.advance(DAEMON_MEMORY_GUARD_GC_MAX_INTERVAL_MS + 1); await h.guard.tick(); }
    const before = gc.mock.calls.length;
    h.advance(DAEMON_MEMORY_GUARD_GC_MAX_INTERVAL_MS - 1_000); await h.guard.tick();
    expect(gc.mock.calls.length).toBe(before); // capped, never longer than the max
    h.setUsed(0.2); h.advance(DAEMON_MEMORY_GUARD_GC_MAX_INTERVAL_MS + 1); await h.guard.tick();
    h.setUsed(0.7); h.advance(DAEMON_MEMORY_GUARD_GC_MIN_INTERVAL_MS + 1); await h.guard.tick();
    expect(gc.mock.calls.length).toBe(before + 1); // healthy in between reset it to the minimum
  });

  it('without a supervisor that would restart it the guard does not exit at 85 %: it keeps serving, refuses heavy load, and says so', async () => {
    const h = harness({ canRestart: () => false });
    h.setUsed(0.95);
    await h.guard.tick();
    expect(h.state.restartReasons).toHaveLength(0);
    expect(h.guard.isRestartSuppressed()).toBe(true);
    expect(h.guard.isShedding()).toBe(true);
    expect(h.state.log.error).toHaveBeenCalledTimes(1);
  });

  it('knows a supervisor from the environment (systemd, launchd, Windows, explicit) and a bare run from none', () => {
    expect(isRunningUnderSupervisor({ INVOCATION_ID: 'abc' } as NodeJS.ProcessEnv, 'linux')).toBe(true);
    expect(isRunningUnderSupervisor({ JOURNAL_STREAM: '8:123' } as NodeJS.ProcessEnv, 'linux')).toBe(true);
    expect(isRunningUnderSupervisor({ XPC_SERVICE_NAME: 'com.imcodes.daemon' } as NodeJS.ProcessEnv, 'darwin')).toBe(true);
    expect(isRunningUnderSupervisor({ XPC_SERVICE_NAME: '0' } as NodeJS.ProcessEnv, 'darwin')).toBe(false);
    expect(isRunningUnderSupervisor({} as NodeJS.ProcessEnv, 'win32')).toBe(true);
    expect(isRunningUnderSupervisor({ IMCODES_SUPERVISED: '1' } as NodeJS.ProcessEnv, 'linux')).toBe(true);
    expect(isRunningUnderSupervisor({} as NodeJS.ProcessEnv, 'linux')).toBe(false);
  });
});

describe('the runtime fatal-error report is made safe (it holds the whole environment)', () => {
  const CANARY = 'sk-test-DO-NOT-LEAK-123';
  let dir = '';
  let stateDir = '';
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'imcodes-fatal-report-'));
    dir = join(stateDir, DAEMON_DIAGNOSTICS_DIR);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  const rawReport = () => ({
    header: { event: 'Allocation failed - JavaScript heap out of memory', trigger: 'FatalError', host: 'zjq-158', cwd: '/home/ai', commandLine: ['node', '--token', CANARY], networkInterfaces: [{ name: 'eth0', mac: 'aa:bb', address: '10.0.0.1' }], nodejsVersion: 'v24' },
    javascriptStack: { message: 'x', stack: ['at f (file.js:1:1)'] },
    javascriptHeap: { totalMemory: 8_589_934_592, usedMemory: 8_500_000_000 },
    resourceUsage: { userCpuSeconds: 1.5 },
    environmentVariables: { SECRET_API_KEY: CANARY },
  });

  it('removes the environment and the addresses/command line, keeps the heap numbers and stacks, makes the file 0600, and is idempotent', () => {
    const file = join(dir, 'report.20261007.171746.1.0.001.json');
    writeFileSync(file, JSON.stringify(rawReport()), { mode: 0o664 });
    chmodSync(file, 0o664);
    expect(sanitizeFatalReports(stateDir)).toEqual({ sanitized: 1, removed: 0 });
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('networkInterfaces');
    expect(text).not.toContain('commandLine');
    const parsed = JSON.parse(text) as Record<string, any>;
    expect(parsed.environmentVariables).toBeUndefined();
    expect(parsed.header).toMatchObject({ event: expect.stringContaining('heap out of memory'), trigger: 'FatalError', nodejsVersion: 'v24' });
    expect(parsed.header.host).toBeUndefined();
    expect(parsed.javascriptHeap).toEqual({ totalMemory: 8_589_934_592, usedMemory: 8_500_000_000 });
    expect(parsed.javascriptStack.stack).toEqual(['at f (file.js:1:1)']);
    expect(parsed[DAEMON_FATAL_REPORT_SANITIZED_KEY]).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(sanitizeFatalReports(stateDir)).toEqual({ sanitized: 0, removed: 0 });
  });

  it('deletes a report the crash cut short instead of leaving it unsanitised, keeps only the newest few, and ignores other files', () => {
    writeFileSync(join(dir, 'report.truncated.json'), `{"header":{"event":"x"},"environmentVariables":{"SECRET":"${CANARY}"`);
    for (let i = 0; i < DAEMON_MEMORY_DIAGNOSTIC_KEEP + 3; i += 1) writeFileSync(join(dir, `report.2026100${String(i).padStart(2, '0')}.json`), JSON.stringify(rawReport()));
    writeFileSync(join(dir, 'memory-guard-state.json'), '{"restarts":[]}');
    const result = sanitizeFatalReports(stateDir);
    expect(result.removed).toBe(1 + 3);
    const left = readdirSync(dir);
    expect(left.filter((name) => name.startsWith('report.'))).toHaveLength(DAEMON_MEMORY_DIAGNOSTIC_KEEP);
    expect(left).toContain('memory-guard-state.json');
    expect(left.some((name) => name.includes('truncated'))).toBe(false);
    for (const name of left.filter((entry) => entry.startsWith('report.'))) expect(readFileSync(join(dir, name), 'utf8')).not.toContain(CANARY);
  });

  it('REAL ABORT: a node process that dies of heap exhaustion with the daemon\'s report flags leaves a report that is safe after the sweep', () => {
    const run = spawnSync(process.execPath, [
      '--max-old-space-size=48', '--report-on-fatalerror', '--report-compact', `--report-directory=${dir}`,
      '-e', "const keep = []; for (;;) keep.push(new Array(100000).fill('x' + Math.random()));",
    ], { env: { ...process.env, SECRET_API_KEY: CANARY }, encoding: 'utf8', timeout: 60_000 });
    expect(run.status === null || run.status !== 0).toBe(true);
    const reports = readdirSync(dir).filter((name) => name.startsWith('report.'));
    expect(reports.length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, reports[0]!), 'utf8')).toContain(CANARY); // raw: the whole environment is in it (why the sweep exists)
    sanitizeFatalReports(stateDir);
    const text = readFileSync(join(dir, reports[0]!), 'utf8');
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('networkInterfaces');
    expect(text).toContain('javascriptHeap');
    expect(statSync(join(dir, reports[0]!)).mode & 0o777).toBe(0o600);
  }, 90_000);

  it('excludeEnv is switched on where the runtime has it and is a harmless no-op where it does not', () => {
    const fake = { excludeEnv: false };
    expect(excludeEnvironmentFromReports(fake)).toBe(true);
    expect(fake.excludeEnv).toBe(true);
    expect(excludeEnvironmentFromReports({})).toBe(false); // an older runtime: no such property
    expect(excludeEnvironmentFromReports(null)).toBe(false);
    expect(excludeEnvironmentFromReports({ get excludeEnv() { return false; }, set excludeEnv(_value: boolean) { throw new Error('read only'); } })).toBe(false);
    const real = (process as unknown as { report?: { excludeEnv?: boolean; getReport(): unknown } }).report;
    if (real && 'excludeEnv' in real) {
      const previous = real.excludeEnv;
      process.env.IMCODES_REPORT_CANARY = CANARY;
      try {
        expect(excludeEnvironmentFromReports()).toBe(true);
        expect(JSON.stringify(real.getReport())).not.toContain(CANARY);
      } finally {
        real.excludeEnv = previous;
        delete process.env.IMCODES_REPORT_CANARY;
      }
    }
  });

  it('--report-exclude-env is in the options iff the caller proves the node knows it; the generators prove it only for a direct launch of THIS node', () => {
    const known = new Set(['--report-exclude-env']);
    expect(daemonFatalReportNodeOptions('/home/u/.imcodes')).not.toContain('--report-exclude-env');
    expect(daemonFatalReportNodeOptions('/home/u/.imcodes', 'plain', true)).toContain('--report-exclude-env');
    expect(reportExcludeEnvFlagUsable('/usr/bin/node', '/usr/bin/node', known)).toBe(true);
    expect(reportExcludeEnvFlagUsable('/usr/bin/node', '/usr/bin/node', new Set())).toBe(false); // node 22.0-22.12: refuses to start with it
    expect(reportExcludeEnvFlagUsable('/opt/imcodes/bin/imcodes-launch.sh', '/usr/bin/node', known)).toBe(false); // the launcher picks node at start
    expect(reportExcludeEnvFlagUsable('/usr/local/bin/node', '/usr/bin/node', known)).toBe(false);
  });

  it('REAL ABORT with --report-exclude-env: the raw report already has no environment (on a node that knows the flag)', () => {
    if (!process.allowedNodeEnvironmentFlags.has('--report-exclude-env')) return;
    const run = spawnSync(process.execPath, [
      '--max-old-space-size=48', ...daemonFatalReportNodeOptions(stateDir, 'plain', true).split(' ').filter((arg) => !arg.startsWith('--report-directory')), `--report-directory=${dir}`,
      '-e', "const keep = []; for (;;) keep.push(new Array(100000).fill('x' + Math.random()));",
    ], { env: { ...process.env, SECRET_API_KEY: CANARY }, encoding: 'utf8', timeout: 60_000 });
    expect(run.status === null || run.status !== 0).toBe(true);
    const reports = readdirSync(dir).filter((name) => name.startsWith('report.'));
    expect(reports.length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, reports[0]!), 'utf8')).not.toContain(CANARY);
  }, 90_000);

  it('the unit options quote a state directory with a space', () => {
    expect(daemonFatalReportNodeOptions('/Users/Jane Doe/.imcodes')).toBe(`--report-on-fatalerror --report-compact --report-directory="/Users/Jane Doe/.imcodes/diagnostics"`);
    expect(daemonFatalReportNodeOptions('/Users/Jane Doe/.imcodes', 'systemd')).toBe('--report-on-fatalerror --report-compact --report-directory=\\"/Users/Jane Doe/.imcodes/diagnostics\\"');
    expect(daemonFatalReportNodeOptions('/srv/100%/home', 'systemd')).toContain('100%%');
  });
});
