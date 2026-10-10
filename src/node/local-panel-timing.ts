/**
 * Phase timing of one local-panel open request: where the time between the click and the window went. Injected clocks only, so the
 * numbers are deterministic in tests; the file it feeds is bounded (LOCAL_PANEL_TIMING.MAX_LINES) and holds no personal data.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOCAL_PANEL_PHASE,
  LOCAL_PANEL_TIMING,
  type LocalPanelPhase,
} from '../../shared/local-panel-window.js';

export interface LocalPanelTimingEntry {
  /** Wall clock of the click (ms since epoch). */
  atMs: number;
  /** Platform of the node that handled it. */
  platform: string;
  /** Click to outcome, whole milliseconds. */
  totalMs: number;
  /** Sum of the time spent in each phase (a phase that did not run is absent), whole milliseconds. */
  phases: Partial<Record<LocalPanelPhase, number>>;
  /** The reason code of the outcome (see LOCAL_PANEL_WINDOW_REASON). */
  reason: string;
  mechanism?: string;
  /** How the native host was trusted on this click (LOCAL_PANEL_VERIFY_SOURCE). */
  verify?: string;
}

export interface LocalPanelPhaseTimer {
  /** Runs `work`, adds its duration to `phase` (also when it throws) and returns its result. */
  measure<T>(phase: LocalPanelPhase, work: () => Promise<T>): Promise<T>;
  /** Free-form single-word facts about the click (e.g. verify source). */
  note(key: 'verify', value: string): void;
  finish(input: { platform: string; reason: string; mechanism?: string }): LocalPanelTimingEntry;
}

const KNOWN_PHASES: ReadonlySet<string> = new Set(Object.values(LOCAL_PANEL_PHASE));

export function createLocalPanelPhaseTimer(clock: { monotonicMs: () => number; wallMs: () => number } = {
  monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  wallMs: () => Date.now(),
}): LocalPanelPhaseTimer {
  const startedMono = clock.monotonicMs();
  const startedWall = clock.wallMs();
  const phases: Partial<Record<LocalPanelPhase, number>> = {};
  const notes: { verify?: string } = {};
  return {
    async measure(phase, work) {
      const before = clock.monotonicMs();
      try {
        return await work();
      } finally {
        phases[phase] = (phases[phase] ?? 0) + Math.max(0, Math.round(clock.monotonicMs() - before));
      }
    },
    note(key, value) { if (/^[a-z_]{1,24}$/u.test(value)) notes[key] = value; },
    finish({ platform, reason, mechanism }) {
      return {
        atMs: startedWall,
        platform,
        totalMs: Math.max(0, Math.round(clock.monotonicMs() - startedMono)),
        phases: { ...phases },
        reason,
        ...(mechanism ? { mechanism } : {}),
        ...(notes.verify ? { verify: notes.verify } : {}),
      };
    },
  };
}

export function timingFilePath(directory: string): string {
  return join(directory, LOCAL_PANEL_TIMING.FILE);
}

function parseEntry(line: string): LocalPanelTimingEntry | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (!value || typeof value !== 'object') return undefined;
    if (typeof value.atMs !== 'number' || typeof value.totalMs !== 'number' || typeof value.reason !== 'string' || typeof value.platform !== 'string') return undefined;
    const phases: Partial<Record<LocalPanelPhase, number>> = {};
    for (const [key, ms] of Object.entries((value.phases ?? {}) as Record<string, unknown>)) {
      if (KNOWN_PHASES.has(key) && typeof ms === 'number' && Number.isFinite(ms)) phases[key as LocalPanelPhase] = Math.round(ms);
    }
    return {
      atMs: value.atMs, platform: value.platform, totalMs: value.totalMs, phases, reason: value.reason,
      ...(typeof value.mechanism === 'string' ? { mechanism: value.mechanism } : {}),
      ...(typeof value.verify === 'string' ? { verify: value.verify } : {}),
    };
  } catch { return undefined; }
}

/** The recorded requests, oldest first; unreadable lines are skipped. */
export function readLocalPanelTiming(directory: string): LocalPanelTimingEntry[] {
  try {
    return readFileSync(timingFilePath(directory), 'utf8').split('\n').map((line) => parseEntry(line)).filter((entry): entry is LocalPanelTimingEntry => entry !== undefined);
  } catch { return []; }
}

/** Adds one request to the history, keeping only the newest MAX_LINES. A write failure only loses the history. */
export function appendLocalPanelTiming(directory: string, entry: LocalPanelTimingEntry): void {
  try {
    const kept = [...readLocalPanelTiming(directory), entry].slice(-LOCAL_PANEL_TIMING.MAX_LINES);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(timingFilePath(directory), `${kept.map((item) => JSON.stringify(item)).join('\n')}\n`, { mode: 0o600 });
  } catch { /* observability only */ }
}

/** One line per request for a terminal: when, total, the phases in click order. */
export function formatLocalPanelTiming(entries: readonly LocalPanelTimingEntry[]): string {
  const order = Object.values(LOCAL_PANEL_PHASE);
  return entries.map((entry) => {
    const phases = order.filter((phase) => entry.phases[phase] !== undefined).map((phase) => `${phase}=${entry.phases[phase]}ms`).join(' ');
    return `${new Date(entry.atMs).toISOString()} ${entry.platform} total=${entry.totalMs}ms ${entry.reason}${entry.mechanism ? ` (${entry.mechanism})` : ''}${entry.verify ? ` verify=${entry.verify}` : ''} ${phases}`.trimEnd();
  }).join('\n');
}
