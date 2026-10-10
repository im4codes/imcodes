/**
 * Back pressure by event-loop health. See shared/event-loop-backpressure.ts for why.
 *
 * `EventLoopHealth` probes the loop with a timer that should fire on time; the drift is the load. While it is
 * overloaded, gated child stdout streams are PAUSED (the child's pipe fills and the child waits: lossless), the pacing
 * helpers hold back optional work, and everything resumes once the drift is back under the healthy line. No stream is
 * held longer than BACKPRESSURE_MAX_PAUSE_MS in one stretch, and none is paused again before BACKPRESSURE_RESUME_GRACE_MS
 * of flow, so a permanently loaded daemon slows its children down instead of starving them.
 */
import { clearInterval, setInterval, setTimeout } from 'node:timers';
import type { Readable } from 'node:stream';
// node:timers, not the globals: a test that installs fake timers (jumping minutes ahead, running every timer) must not
// fast-forward or exhaust the health probe, and the probe measures against the real clock anyway.
import {
  BACKPRESSURE_MAX_PAUSE_MS,
  BACKPRESSURE_RESUME_GRACE_MS,
  EVENT_LOOP_HEALTHY_LAG_MS,
  EVENT_LOOP_LAG_WINDOW_MS,
  EVENT_LOOP_OVERLOADED_LAG_MS,
  EVENT_LOOP_PROBE_INTERVAL_MS,
  EVENT_LOOP_BACKPRESSURE_ENV,
  RESTORE_PACING_MAX_WAIT_MS,
  RESTORE_PACING_MIN_GAP_MS,
} from '../../shared/event-loop-backpressure.js';
import { registerMemoryProbe } from '../daemon/memory-probes.js';

/**
 * Monotonic wall time that test fake timers do not touch: the drift of a (faked) timer against the REAL clock is
 * zero, so a test that jumps the fake clock minutes ahead is not mistaken for an overloaded daemon.
 */
function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000n) / 1_000;
}

interface GatedStream { stream: Readable; pausedByUsAt: number | null; graceUntil: number; pauses: number }

export interface EventLoopHealthOptions {
  now?: () => number;
  /** Start the probe timer on first use (default). Tests drive `recordProbe` themselves. */
  autoStart?: boolean;
}

export class EventLoopHealth {
  private readonly now: () => number;
  private readonly autoStart: boolean;
  private probes: Array<{ at: number; driftMs: number }> = [];
  private overloaded = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private readonly gated = new Set<GatedStream>();
  private totalPauses = 0;

  constructor(options: EventLoopHealthOptions = {}) {
    this.now = options.now ?? monotonicNowMs;
    this.autoStart = options.autoStart ?? true;
  }

  /** Record one probe (the timer's drift past its due time). Public so tests can drive it. */
  recordProbe(driftMs: number): void {
    const at = this.now();
    this.probes.push({ at, driftMs: Math.max(0, driftMs) });
    const since = at - EVENT_LOOP_LAG_WINDOW_MS;
    while (this.probes.length > 0 && this.probes[0]!.at < since) this.probes.shift();
    const lag = this.lagMs();
    if (!this.overloaded && lag >= EVENT_LOOP_OVERLOADED_LAG_MS) this.overloaded = true;
    else if (this.overloaded && lag < EVENT_LOOP_HEALTHY_LAG_MS) this.overloaded = false;
    this.applyToStreams();
  }

  /** The worst recent drift. */
  lagMs(): number {
    const since = this.now() - EVENT_LOOP_LAG_WINDOW_MS;
    let worst = 0;
    for (const probe of this.probes) if (probe.at >= since && probe.driftMs > worst) worst = probe.driftMs;
    return worst;
  }

  isOverloaded(): boolean {
    return this.overloaded;
  }

  ensureStarted(): void {
    if (this.timer || !this.autoStart) return;
    this.lastTickAt = this.now();
    this.timer = setInterval(() => {
      const at = this.now();
      this.recordProbe(at - this.lastTickAt - EVENT_LOOP_PROBE_INTERVAL_MS);
      this.lastTickAt = at;
    }, EVENT_LOOP_PROBE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const entry of this.gated) this.release(entry);
    this.gated.clear();
  }

  /** Pause `stream` while the loop is overloaded. Returns the disposer. */
  gate(stream: Readable | null | undefined): () => void {
    if (!stream) return () => undefined;
    this.ensureStarted();
    const entry: GatedStream = { stream, pausedByUsAt: null, graceUntil: 0, pauses: 0 };
    this.gated.add(entry);
    const dispose = (): void => { this.release(entry); this.gated.delete(entry); };
    // No 'error' listener on purpose: one would swallow an unhandled stream error the owner relies on to surface.
    // A failed stream is always followed by 'close' (autoDestroy), which releases it.
    stream.once('close', dispose);
    stream.once('end', dispose);
    return dispose;
  }

  private release(entry: GatedStream): void {
    if (entry.pausedByUsAt !== null) {
      entry.pausedByUsAt = null;
      try { if (!entry.stream.destroyed) entry.stream.resume(); } catch { /* the stream is already gone */ }
    }
  }

  private applyToStreams(): void {
    const at = this.now();
    for (const entry of this.gated) {
      if (entry.pausedByUsAt === null) {
        if (this.overloaded && at >= entry.graceUntil && entry.stream.readable && !entry.stream.isPaused()) {
          try { entry.stream.pause(); } catch { continue; }
          entry.pausedByUsAt = at;
          entry.pauses += 1;
          this.totalPauses += 1;
        }
      } else if (!this.overloaded || at - entry.pausedByUsAt >= BACKPRESSURE_MAX_PAUSE_MS) {
        const forced = this.overloaded;
        this.release(entry);
        // Forced out of a long pause while still overloaded: let it flow a while before it can be paused again.
        if (forced) entry.graceUntil = at + BACKPRESSURE_RESUME_GRACE_MS;
      }
    }
  }

  /** Numbers for the memory diagnostic. */
  stats(): { lagMs: number; overloaded: boolean; gatedStreams: number; pausedStreams: number; totalPauses: number } {
    let paused = 0;
    for (const entry of this.gated) if (entry.pausedByUsAt !== null) paused += 1;
    return { lagMs: this.lagMs(), overloaded: this.overloaded, gatedStreams: this.gated.size, pausedStreams: paused, totalPauses: this.totalPauses };
  }

  /**
   * Resolve at once while the loop is healthy; while it is overloaded, hold the caller back until it recovers or
   * `maxWaitMs` passes. `minGapMs` is waited first either way (pacing between optional pieces of work).
   */
  async waitUntilHealthy(options: { minGapMs?: number; maxWaitMs?: number } = {}): Promise<void> {
    this.ensureStarted();
    const minGap = options.minGapMs ?? 0;
    if (minGap > 0) await new Promise<void>((resolve) => { const t = setTimeout(resolve, minGap); t.unref?.(); });
    const deadline = this.now() + (options.maxWaitMs ?? BACKPRESSURE_MAX_PAUSE_MS);
    while (this.overloaded && this.now() < deadline) {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, EVENT_LOOP_PROBE_INTERVAL_MS); t.unref?.(); });
    }
  }
}

let shared: EventLoopHealth | null = null;

/** The process-wide health probe (created and started on first use, never keeps the process alive). */
export function eventLoopHealth(): EventLoopHealth {
  if (!shared) {
    shared = new EventLoopHealth();
    registerMemoryProbe('eventLoop', () => shared?.stats() ?? {});
  }
  return shared;
}

export function resetEventLoopHealthForTests(): void {
  yieldGraceUntil = 0;
  shared?.stop();
  shared = null;
}

/** Stop reading `child.stdout` while the loop is overloaded; resumes by itself. Returns the stream for chaining. */
export function gateChildStream<T extends Readable | null | undefined>(stream: T): T {
  if (stream && backpressureEnabled()) eventLoopHealth().gate(stream);
  return stream;
}

function backpressureEnabled(): boolean {
  return process.env[EVENT_LOOP_BACKPRESSURE_ENV] !== '0';
}

/** Hold an optional loop iteration (consuming a provider's message stream) back while the loop is overloaded. */
let yieldGraceUntil = 0;
export async function backpressureYield(): Promise<void> {
  if (!backpressureEnabled()) return;
  const health = eventLoopHealth();
  health.ensureStarted();
  if (!health.isOverloaded() || monotonicNowMs() < yieldGraceUntil) return;
  await health.waitUntilHealthy();
  // Still overloaded after the longest wait: let the next messages through for a while instead of stalling the stream forever.
  if (health.isOverloaded()) yieldGraceUntil = monotonicNowMs() + BACKPRESSURE_RESUME_GRACE_MS;
}

/** Between two session restores: the minimum gap, then until the loop is healthy (never longer than the cap). */
export async function paceByEventLoopHealth(minGapMs = RESTORE_PACING_MIN_GAP_MS, budget?: { leftMs: number }): Promise<void> {
  // One restore may wait for health for RESTORE_PACING_TOTAL_WAIT_BUDGET_MS in all; past it only the floor applies.
  const spent = budget && budget.leftMs <= 0;
  if (!backpressureEnabled() || spent) {
    await new Promise<void>((resolve) => { const timer = setTimeout(resolve, minGapMs); timer.unref?.(); });
    return;
  }
  const startedAt = monotonicNowMs();
  await eventLoopHealth().waitUntilHealthy({ minGapMs, maxWaitMs: Math.min(RESTORE_PACING_MAX_WAIT_MS, budget?.leftMs ?? RESTORE_PACING_MAX_WAIT_MS) });
  if (budget) budget.leftMs -= Math.max(0, monotonicNowMs() - startedAt - minGapMs);
}
