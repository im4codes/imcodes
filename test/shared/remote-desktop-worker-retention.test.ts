import { describe, expect, it } from 'vitest';
import {
  REMOTE_DESKTOP_WORKER_ENTRY_KIND,
  REMOTE_DESKTOP_WORKER_RETENTION,
  planRemoteDesktopWorkerPrune,
  type RemoteDesktopWorkerStoreEntry,
} from '../../shared/remote-desktop-worker-retention.js';

const HOUR = 60 * 60_000;
const NOW = 1_000_000 * HOUR;
const release = (index: number, ageHours: number): RemoteDesktopWorkerStoreEntry => ({
  name: `sha256-${index.toString(16).padStart(64, '0')}`,
  kind: REMOTE_DESKTOP_WORKER_ENTRY_KIND.RELEASE,
  mtimeMs: NOW - ageHours * HOUR,
});
const temporary = (name: string, ageHours: number): RemoteDesktopWorkerStoreEntry => ({
  name, kind: REMOTE_DESKTOP_WORKER_ENTRY_KIND.TEMPORARY, mtimeMs: NOW - ageHours * HOUR,
});

describe('remote-desktop worker release retention policy', () => {
  it('keeps the selected releases, the newest few and the young; removes the rest oldest first', () => {
    const entries = [release(1, 500), release(2, 400), release(3, 300), release(4, 200), release(5, 100), release(6, 50), release(7, 1)];
    const plan = planRemoteDesktopWorkerPrune({
      entries, nowMs: NOW,
      protectedNames: new Set([entries[0]!.name, entries[1]!.name]), // the two selectors are the OLDEST releases
    });
    // release 7 is young and newest, 6 and 5 are among the newest three; 1 and 2 are selected
    expect(plan.remove.map((entry) => entry.name)).toEqual([entries[2]!.name, entries[3]!.name]);
    expect(plan.moreWork).toBe(false);
  });

  it('never plans a protected release, whatever its age, and never more than the cap', () => {
    const entries = Array.from({ length: 334 }, (_, index) => release(index + 1, 1_000 + index));
    const protectedNames = new Set([entries[333]!.name, entries[200]!.name, entries[7]!.name]);
    const plan = planRemoteDesktopWorkerPrune({ entries, nowMs: NOW, protectedNames });
    expect(plan.remove).toHaveLength(REMOTE_DESKTOP_WORKER_RETENTION.MAX_REMOVALS_PER_PASS);
    expect(plan.moreWork).toBe(true);
    for (const entry of plan.remove) expect(protectedNames.has(entry.name)).toBe(false);
    // oldest (largest age) first
    const ages = plan.remove.map((entry) => NOW - entry.mtimeMs);
    expect([...ages].sort((a, b) => b - a)).toEqual(ages);
  });

  it('drains any backlog in ceil(removable / cap) passes and ends with exactly the kept set', () => {
    let entries = Array.from({ length: 334 }, (_, index) => release(index + 1, 100 + index));
    const protectedNames = new Set([entries[0]!.name, entries[333]!.name]);
    const keptExpected = 2 + REMOTE_DESKTOP_WORKER_RETENTION.KEEP_NEWEST_RELEASES - 1; // entries[0] is also among the newest
    let passes = 0;
    for (;;) {
      const plan = planRemoteDesktopWorkerPrune({ entries, nowMs: NOW, protectedNames });
      passes += 1;
      const gone = new Set(plan.remove.map((entry) => entry.name));
      entries = entries.filter((entry) => !gone.has(entry.name));
      if (!plan.moreWork) break;
    }
    expect(entries).toHaveLength(keptExpected);
    expect(passes).toBe(Math.ceil((334 - keptExpected) / REMOTE_DESKTOP_WORKER_RETENTION.MAX_REMOVALS_PER_PASS));
    expect(entries.some((entry) => entry.name === Array.from(protectedNames)[0])).toBe(true);
    expect(entries.some((entry) => entry.name === Array.from(protectedNames)[1])).toBe(true);
  });

  it('keeps a release younger than the minimum age and treats exactly the minimum age as old enough', () => {
    const young = release(1, REMOTE_DESKTOP_WORKER_RETENTION.MIN_RELEASE_AGE_MS / HOUR - 0.01);
    const boundary = release(2, REMOTE_DESKTOP_WORKER_RETENTION.MIN_RELEASE_AGE_MS / HOUR);
    const filler = [release(3, 900), release(4, 901), release(5, 902)];
    const plan = planRemoteDesktopWorkerPrune({ entries: [young, boundary, ...filler], nowMs: NOW, protectedNames: new Set() });
    const names = plan.remove.map((entry) => entry.name);
    expect(names).not.toContain(young.name);
    // the newest three (young, boundary, release 3) are kept anyway; the two oldest go
    expect(names).toEqual([filler[2]!.name, filler[1]!.name]);
  });

  it('removes temporary directories only after the temporary age, before any release', () => {
    const entries = [
      temporary('.staging-aaaaaa', 0.2),
      temporary('.staging-bbbbbb', 3),
      temporary('.pruning-cccccc', 40),
      release(1, 900), release(2, 800), release(3, 700), release(4, 600),
    ];
    const plan = planRemoteDesktopWorkerPrune({ entries, nowMs: NOW, protectedNames: new Set() });
    expect(plan.remove.map((entry) => entry.name)).toEqual([
      '.pruning-cccccc', '.staging-bbbbbb', entries[3]!.name, // the oldest release; the newest three are kept
    ]);
  });

  it('does not plan skipped entries and does not count them as remaining work', () => {
    const entries = [release(1, 900), release(2, 800), release(3, 700), release(4, 600), release(5, 500)];
    const plan = planRemoteDesktopWorkerPrune({
      entries, nowMs: NOW, protectedNames: new Set(), skipNames: new Set([entries[0]!.name, entries[1]!.name]),
    });
    expect(plan.remove).toEqual([]);
    expect(plan.moreWork).toBe(false);
  });

  it('is a pure function of its inputs (no clock, no I/O) and honours explicit limits', () => {
    const entries = [release(1, 90), release(2, 80), release(3, 70), release(4, 60)];
    const input = { entries, nowMs: NOW, protectedNames: new Set<string>(), keepNewest: 1, minReleaseAgeMs: HOUR, maxRemovals: 2 };
    const first = planRemoteDesktopWorkerPrune(input);
    expect(planRemoteDesktopWorkerPrune(input)).toEqual(first);
    expect(first.remove).toHaveLength(2);
    expect(first.moreWork).toBe(true);
  });
});
