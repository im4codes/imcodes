/**
 * The bounded history of local-panel open requests (`imcodes-node --local-panel-timing`): what it keeps, that it stays small and
 * holds no personal data, and that a broken file never gets in the way.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_PANEL_PHASE, LOCAL_PANEL_TIMING } from '../../shared/local-panel-window.js';
import {
  appendLocalPanelTiming,
  createLocalPanelPhaseTimer,
  formatLocalPanelTiming,
  readLocalPanelTiming,
  timingFilePath,
  type LocalPanelTimingEntry,
} from '../../src/node/local-panel-timing.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'imcodes-panel-timing-')); dirs.push(dir); return dir; };
const entry = (n: number, over: Partial<LocalPanelTimingEntry> = {}): LocalPanelTimingEntry => ({ atMs: 1_790_000_000_000 + n, platform: 'win32', totalMs: n, phases: { panel_probe: n }, reason: 'opened_native_window', ...over });

describe('local panel phase timer', () => {
  it('sums repeated phases, counts a failing phase, and rounds to whole milliseconds', async () => {
    let clock = 100.4;
    const timer = createLocalPanelPhaseTimer({ monotonicMs: () => clock, wallMs: () => 1_790_000_000_000 });
    await timer.measure(LOCAL_PANEL_PHASE.LOCATE, async () => { clock += 10.2; });
    await timer.measure(LOCAL_PANEL_PHASE.LOCATE, async () => { clock += 20; });
    await expect(timer.measure(LOCAL_PANEL_PHASE.FOCUS, async () => { clock += 3; throw new Error('x'); })).rejects.toThrow('x');
    timer.note('verify', 'record');
    timer.note('verify', 'has spaces and a /path');
    clock += 1;
    expect(timer.finish({ platform: 'win32', reason: 'focused_existing_window' })).toEqual({
      atMs: 1_790_000_000_000, platform: 'win32', totalMs: 34, phases: { locate_window: 30, focus: 3 }, reason: 'focused_existing_window', verify: 'record',
    });
  });
});

describe('the bounded timing history', () => {
  it('keeps only the newest MAX_LINES requests, oldest first, in a small file', () => {
    const dir = temp();
    for (let n = 1; n <= LOCAL_PANEL_TIMING.MAX_LINES + 25; n += 1) appendLocalPanelTiming(dir, entry(n));
    const entries = readLocalPanelTiming(dir);
    expect(entries).toHaveLength(LOCAL_PANEL_TIMING.MAX_LINES);
    expect(entries[0]!.totalMs).toBe(26);
    expect(entries.at(-1)!.totalMs).toBe(75);
    expect(readFileSync(timingFilePath(dir), 'utf8').length).toBeLessThan(LOCAL_PANEL_TIMING.MAX_LINES * 300);
  });

  it('skips unreadable lines, ignores unknown phases, and survives a missing or unwritable directory', () => {
    const dir = temp();
    writeFileSync(timingFilePath(dir), `garbage\n${JSON.stringify(entry(1, { phases: { panel_probe: 4, evil_phase: 9 } as never }))}\n{"atMs":"x"}\n`);
    const entries = readLocalPanelTiming(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.phases).toEqual({ panel_probe: 4 });
    expect(readLocalPanelTiming(join(dir, 'missing'))).toEqual([]);
    writeFileSync(join(dir, 'a-file-not-a-dir'), 'x');
    expect(() => appendLocalPanelTiming(join(dir, 'a-file-not-a-dir', 'x'), entry(2))).not.toThrow();
  });

  it('reads as one line per request, phases in click order, with the reason and the verify source', () => {
    const text = formatLocalPanelTiming([entry(1, { totalMs: 2_345, mechanism: 'native', verify: 'full', phases: { launch_native: 1_800, panel_probe: 5, native_verify: 500 } })]);
    expect(text).toBe(`${new Date(1_790_000_000_001).toISOString()} win32 total=2345ms opened_native_window (native) verify=full panel_probe=5ms native_verify=500ms launch_native=1800ms`);
    expect(formatLocalPanelTiming([])).toBe('');
  });
});
