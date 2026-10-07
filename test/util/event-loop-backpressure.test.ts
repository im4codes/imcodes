/**
 * 158 (2026-10-07): the main thread was blocked ~100 % of the time (1.2 s drifts every 1.3 s, a 10 s stall at the
 * end) while child processes kept writing and the in-process readers kept decoding, until the heap was gone.
 * While the loop is overloaded the daemon stops READING from children (their pipes fill and they wait - nothing is
 * dropped), holds back optional loops and paces a warm restore; all of it resumes on recovery, and none of it can
 * starve a child for good.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  BACKPRESSURE_MAX_PAUSE_MS,
  BACKPRESSURE_RESUME_GRACE_MS,
  EVENT_LOOP_BACKPRESSURE_ENV,
  EVENT_LOOP_HEALTHY_LAG_MS,
  EVENT_LOOP_LAG_WINDOW_MS,
  EVENT_LOOP_OVERLOADED_LAG_MS,
} from '../../shared/event-loop-backpressure.js';
import {
  EventLoopHealth,
  backpressureYield,
  eventLoopHealth,
  gateChildStream,
  paceByEventLoopHealth,
  resetEventLoopHealthForTests,
} from '../../src/util/event-loop-backpressure.js';

const ROOT = resolve(__dirname, '..', '..');

/** Real time plus a jump: the wait loops still end, and the window can be "waited out" instantly. */
function clocked() {
  let offset = 0;
  const health = new EventLoopHealth({ now: () => performance.now() + offset, autoStart: false });
  return { health, advance: (ms: number) => { offset += ms; } };
}
const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => resetEventLoopHealthForTests());

/** True when `promise` settled before the next macrotask: it needed microtasks only, no timer, so the speed of the machine cannot change the answer. */
async function settlesWithoutATimer(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return settled;
}

describe('event-loop health', () => {
  it('is overloaded at the high line and healthy only below the low line, after the window forgets the spike (no flapping)', () => {
    const { health, advance } = clocked();
    health.recordProbe(20);
    expect(health.isOverloaded()).toBe(false);
    health.recordProbe(EVENT_LOOP_OVERLOADED_LAG_MS);
    expect(health.isOverloaded()).toBe(true);
    advance(500); health.recordProbe(EVENT_LOOP_HEALTHY_LAG_MS + 20); // lower, but not under the healthy line
    expect(health.isOverloaded()).toBe(true);
    advance(500); health.recordProbe(5);
    expect(health.isOverloaded()).toBe(true); // the 400 ms spike is still inside the window
    advance(EVENT_LOOP_LAG_WINDOW_MS); health.recordProbe(5);
    expect(health.isOverloaded()).toBe(false);
  });
});

describe('a gated child stream', () => {
  it('is paused while the loop is overloaded, loses nothing, and flows again on recovery', async () => {
    const { health, advance } = clocked();
    const stream = new PassThrough();
    const received: string[] = [];
    stream.on('data', (chunk: Buffer) => received.push(chunk.toString()));
    health.gate(stream);
    stream.write('one');
    await nextTick();
    expect(received).toEqual(['one']);

    health.recordProbe(1_000);
    expect(stream.isPaused()).toBe(true);
    stream.write('two'); stream.write('three');
    expect(received).toEqual(['one']); // held back, not dropped

    advance(EVENT_LOOP_LAG_WINDOW_MS + 100); health.recordProbe(0);
    expect(stream.isPaused()).toBe(false);
    stream.write('four');
    await nextTick();
    expect(received.join('')).toBe('onetwothreefour'); // everything, in order
    health.stop();
  });

  it('is never held longer than the pause cap, then gets a grace period before it can be paused again', () => {
    const { health, advance } = clocked();
    const stream = new PassThrough();
    stream.on('data', () => undefined);
    health.gate(stream);
    health.recordProbe(1_000);
    expect(stream.isPaused()).toBe(true);
    advance(BACKPRESSURE_MAX_PAUSE_MS + 1); health.recordProbe(1_000); // still overloaded
    expect(stream.isPaused()).toBe(false);
    advance(100); health.recordProbe(1_000);
    expect(stream.isPaused()).toBe(false); // inside the grace
    advance(BACKPRESSURE_RESUME_GRACE_MS + 1); health.recordProbe(1_000);
    expect(stream.isPaused()).toBe(true);
    health.stop();
  });

  it('adds no error listener: an unhandled stream error still surfaces to its owner instead of being swallowed by the gate', () => {
    const { health } = clocked();
    const stream = new PassThrough();
    expect(stream.listenerCount('error')).toBe(0);
    health.gate(stream);
    expect(stream.listenerCount('error')).toBe(0);
    health.stop();
  });

  it('never resumes a stream somebody else paused, and forgets a closed stream', async () => {
    const { health, advance } = clocked();
    const mine = new PassThrough();
    mine.on('data', () => undefined);
    mine.pause(); // paused by its owner
    health.gate(mine);
    health.recordProbe(1_000);
    advance(EVENT_LOOP_LAG_WINDOW_MS + 100); health.recordProbe(0);
    expect(mine.isPaused()).toBe(true);
    mine.destroy();
    await nextTick();
    expect(health.stats().gatedStreams).toBe(0);
    health.stop();
  });

  it('REAL CHILD: a child writing 24 MB is held back while overloaded (the pipe fills, the child waits) and delivers every byte afterwards', async () => {
    const { health, advance } = clocked();
    const child = spawn(process.execPath, ['-e', "const chunk = Buffer.alloc(64 * 1024, 97); let left = 384; const write = () => { while (left > 0) { left -= 1; if (!process.stdout.write(chunk)) { process.stdout.once('drain', write); return; } } process.exit(0); }; write();"], { stdio: ['ignore', 'pipe', 'ignore'] });
    let received = 0;
    child.stdout.on('data', (chunk: Buffer) => { received += chunk.length; });
    health.gate(child.stdout);
    health.recordProbe(1_000); // overloaded from the start
    await new Promise((r) => setTimeout(r, 400));
    const heldAt = received;
    await new Promise((r) => setTimeout(r, 400));
    expect(received).toBe(heldAt); // nothing more was read: the child is blocked on its pipe
    expect(heldAt).toBeLessThan(8 * 1024 * 1024); // at most what the pipe and stream buffers hold
    advance(EVENT_LOOP_LAG_WINDOW_MS + 100); health.recordProbe(0);
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    expect(received).toBe(384 * 64 * 1024);
    health.stop();
  }, 30_000);
});

describe('waiting for a healthy loop', () => {
  it('returns at once while healthy, waits while overloaded, and gives up at the cap', async () => {
    const { health, advance } = clocked();
    // "At once" = settled by microtasks alone: no timer was needed, so no clock speed can change the answer.
    expect(await settlesWithoutATimer(health.waitUntilHealthy())).toBe(true);

    health.recordProbe(1_000);
    let released = false;
    const waiting = health.waitUntilHealthy({ maxWaitMs: 60_000 }).then(() => { released = true; });
    await new Promise((r) => setTimeout(r, 450));
    expect(released).toBe(false);
    advance(EVENT_LOOP_LAG_WINDOW_MS + 100); health.recordProbe(0);
    await waiting;
    expect(released).toBe(true);

    health.recordProbe(1_000);
    advance(0);
    // the cap, not the recovery, ended the wait: it settles with the loop still overloaded and no timer
    expect(await settlesWithoutATimer(health.waitUntilHealthy({ maxWaitMs: 0 }))).toBe(true);
    expect(health.isOverloaded()).toBe(true);
    health.stop();
  });

  it('the shared yield used by provider message loops is free while healthy', async () => {
    expect(await settlesWithoutATimer((async () => { for (let i = 0; i < 1_000; i += 1) await backpressureYield(); })())).toBe(true);
    expect(eventLoopHealth().isOverloaded()).toBe(false);
  });
});

describe('restore pacing', () => {
  const withBackpressure = async (run: () => Promise<void>) => {
    const previous = process.env[EVENT_LOOP_BACKPRESSURE_ENV];
    delete process.env[EVENT_LOOP_BACKPRESSURE_ENV];
    resetEventLoopHealthForTests();
    try { await run(); } finally { if (previous === undefined) delete process.env[EVENT_LOOP_BACKPRESSURE_ENV]; else process.env[EVENT_LOOP_BACKPRESSURE_ENV] = previous; }
  };

  it('under persistent overload the waits add up to a budget, after which only the floor applies', async () => {
    await withBackpressure(async () => {
      eventLoopHealth().recordProbe(5_000); // overloaded for the whole window
      const budget = { leftMs: 400 };
      const waits = vi.spyOn(eventLoopHealth(), 'waitUntilHealthy');
      const first = Date.now();
      await paceByEventLoopHealth(20, budget);
      expect(Date.now() - first).toBeGreaterThanOrEqual(380); // waited for health until the budget ran out (a slower machine only waits longer)
      expect(budget.leftMs).toBeLessThanOrEqual(30);
      expect(waits).toHaveBeenCalledTimes(1);
      // What is left of the budget (a few ms at most) is used up by the next call or two; after that the health wait is not entered AT ALL.
      for (let i = 0; i < 5 && budget.leftMs > 0; i += 1) await paceByEventLoopHealth(20, budget);
      expect(budget.leftMs).toBeLessThanOrEqual(0);
      const waitsBefore = waits.mock.calls.length;
      const floorStart = Date.now();
      await paceByEventLoopHealth(20, budget);
      expect(waits.mock.calls.length).toBe(waitsBefore); // budget spent: the floor only, no wait for health
      expect(Date.now() - floorStart).toBeGreaterThanOrEqual(18);
      waits.mockRestore();
    });
  });

  it('a healthy loop costs only the floor and spends no budget', async () => {
    await withBackpressure(async () => {
      const budget = { leftMs: 600_000 };
      const started = Date.now();
      await paceByEventLoopHealth(30, budget);
      expect(Date.now() - started).toBeGreaterThanOrEqual(25); // the floor is waited
      // Only lateness counts against the budget: ten seconds of it on a loaded runner would still leave this true.
      expect(budget.leftMs).toBeGreaterThan(590_000);
    });
  });
});

describe('the kill switch', () => {
  it('IMCODES_EVENT_LOOP_BACKPRESSURE=0 turns the process-wide helpers into no-ops (test workers run with it)', () => {
    const previous = process.env[EVENT_LOOP_BACKPRESSURE_ENV];
    try {
      process.env[EVENT_LOOP_BACKPRESSURE_ENV] = '0';
      resetEventLoopHealthForTests();
      const off = new PassThrough();
      expect(gateChildStream(off)).toBe(off);
      expect(eventLoopHealth().stats().gatedStreams).toBe(0);
      delete process.env[EVENT_LOOP_BACKPRESSURE_ENV];
      const on = new PassThrough();
      gateChildStream(on);
      expect(eventLoopHealth().stats().gatedStreams).toBe(1);
      on.destroy();
    } finally {
      if (previous === undefined) delete process.env[EVENT_LOOP_BACKPRESSURE_ENV]; else process.env[EVENT_LOOP_BACKPRESSURE_ENV] = previous;
    }
  });
});

describe('wiring (a class guard for every provider that reads a child process)', () => {
  const providers = join(ROOT, 'src/agent/providers');
  const READS_CHILD = /createInterface\(\{\s*input:\s*(?:child|proc|processHandle)\.stdout|(?:child|proc|processHandle)\.stdout\??\.on\('data'|filterAcpJsonLines\(\s*(?:child|proc|processHandle)\.stdout/;
  const providerFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? providerFiles(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []
  ));

  it('every provider that reads child.stdout wraps it in gateChildStream', () => {
    const offenders: string[] = [];
    for (const file of providerFiles(providers)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (READS_CHILD.test(line) && !line.includes('gateChildStream(')) offenders.push(`${file.slice(providers.length + 1)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the Claude SDK message loop yields to the loop, and the warm restore is paced by it with no fixed gap', () => {
    const claude = readFileSync(join(providers, 'claude-code-sdk.ts'), 'utf8');
    expect(claude).toMatch(/for await \(const msg of q\) \{\s*this\.handleMessage\(sessionId, state, msg, turnGeneration\);[^}]*await backpressureYield\(\);/);
    const lifecycle = readFileSync(join(ROOT, 'src/daemon/lifecycle.ts'), 'utf8');
    expect(lifecycle).toMatch(/interSessionDelayMs: 0,\s*paceByEventLoopHealth: true,/);
    expect(lifecycle).not.toMatch(/TRANSPORT_SLOW_RESTORE_INTER_SESSION_DELAY_MS/);
  });
});
