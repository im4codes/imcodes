/**
 * Retention of the macOS worker release store. Real directories, real renames and deletes; the clock, the "in use" probe and the
 * failure of a rename are injected (no wall-clock thresholds). A fabricated release is an empty `sha256-<64 hex>` directory with a
 * file in it: pruning decides from names, selectors, ages and ownership, never from the signed contents.
 */
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMOTE_DESKTOP_WORKER_RETENTION } from '../../shared/remote-desktop-worker-retention.js';
import {
  MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS,
  defaultMacosRemoteDesktopReleasesInUse,
  pruneMacosRemoteDesktopArtifactStore,
  pruneMacosRemoteDesktopArtifactStoreBacklog,
  type MacosRemoteDesktopPruneDependencies,
} from '../../src/node/macos-remote-desktop-artifact.js';

const HOUR = 60 * 60_000;
const NOW = 2_000_000 * HOUR;
const CAP = REMOTE_DESKTOP_WORKER_RETENTION.MAX_REMOVALS_PER_PASS;

let root: string;
let storeRoot: string;
let releases: string;

const nameOf = (index: number): string => `sha256-${index.toString(16).padStart(64, '0')}`;

function makeRelease(index: number, ageHours: number): string {
  const dir = join(releases, nameOf(index));
  mkdirSync(dir, { mode: 0o755 });
  writeFileSync(join(dir, 'imcodes-remote-desktop-worker'), `worker ${index}`);
  const when = new Date(NOW - ageHours * HOUR);
  utimesSync(dir, when, when);
  return dir;
}

function select(selector: keyof typeof MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS, index: number): void {
  writeFileSync(join(storeRoot, MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS[selector]), `${nameOf(index)}\n`);
}

const present = (): string[] => readdirSync(releases).sort();
const deps = (extra: Partial<MacosRemoteDesktopPruneDependencies> = {}): MacosRemoteDesktopPruneDependencies => ({
  runtime: { platform: 'darwin', arch: 'arm64' },
  now: () => NOW,
  releasesInUse: async () => new Set(),
  ...extra,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'imcodes-macos-prune-test-'));
  storeRoot = join(root, 'node-state', 'remote-desktop-worker', 'darwin-arm64');
  releases = join(storeRoot, 'releases');
  mkdirSync(releases, { recursive: true, mode: 0o755 });
  chmodSync(storeRoot, 0o755);
  chmodSync(releases, 0o755);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('macOS worker release store retention', () => {
  it('drains a 334-release backlog in bounded passes and keeps current, last-known-good and the newest releases', async () => {
    // mini-2's store: 334 releases, the two SELECTED ones among the oldest (a rolled-back machine), all older than the minimum age
    for (let index = 1; index <= 334; index += 1) makeRelease(index, 100 + (334 - index));
    select('current', 2);
    select('lastKnownGood', 1);
    const passes: number[] = [];
    const summary = await pruneMacosRemoteDesktopArtifactStoreBacklog(storeRoot, deps(), {
      sleep: async () => {},
      onPass: (result) => passes.push(result.removed),
    });
    expect(Math.max(...passes)).toBeLessThanOrEqual(CAP);
    const kept = REMOTE_DESKTOP_WORKER_RETENTION.KEEP_NEWEST_RELEASES + 2;
    expect(passes.reduce((sum, value) => sum + value, 0)).toBe(334 - kept);
    expect(summary.passes).toBe(Math.ceil((334 - kept) / CAP));
    expect(summary.moreWork).toBe(false);
    expect(present()).toEqual([nameOf(1), nameOf(2), nameOf(332), nameOf(333), nameOf(334)].sort());
    // the selectors are untouched and still point at releases that exist
    expect(readFileSync(join(storeRoot, 'current'), 'utf8').trim()).toBe(nameOf(2));
    expect(existsSync(join(releases, readFileSync(join(storeRoot, 'last-known-good'), 'utf8').trim()))).toBe(true);
  });

  it('stops after a bounded number of passes and continues on the next call', async () => {
    for (let index = 1; index <= 100; index += 1) makeRelease(index, 100 + (100 - index));
    select('current', 100);
    const first = await pruneMacosRemoteDesktopArtifactStoreBacklog(storeRoot, deps(), { maxPasses: 2, sleep: async () => {} });
    expect(first.passes).toBe(2);
    expect(first.removed).toBe(2 * CAP);
    expect(first.moreWork).toBe(true);
    const second = await pruneMacosRemoteDesktopArtifactStoreBacklog(storeRoot, deps(), { sleep: async () => {} });
    expect(second.moreWork).toBe(false);
    expect(present()).toHaveLength(REMOTE_DESKTOP_WORKER_RETENTION.KEEP_NEWEST_RELEASES);
  });

  it('never removes a release a running worker or the launchd job names, a young release, or the newest', async () => {
    for (let index = 1; index <= 10; index += 1) makeRelease(index, 100 + (10 - index));
    makeRelease(11, 1); // young, and the newest
    select('current', 10);
    const result = await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps({
      releasesInUse: async () => new Set([nameOf(3), nameOf(4)]),
    }));
    expect(result.skipped).toBeUndefined();
    // kept: selected 10, in use 3 and 4, newest three (11, 10, 9), nothing else
    expect(present()).toEqual([nameOf(3), nameOf(4), nameOf(9), nameOf(10), nameOf(11)].sort());
  });

  it('removes nothing when the in-use probe fails, a selector is invalid, or the store is not trusted', async () => {
    for (let index = 1; index <= 8; index += 1) makeRelease(index, 100 + (8 - index));
    select('current', 8);
    const before = present();

    const probe = await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps({
      releasesInUse: async () => { throw new Error('ps failed'); },
    }));
    expect(probe).toMatchObject({ removed: 0, skipped: 'in_use_probe_failed' });

    writeFileSync(join(storeRoot, 'last-known-good'), 'not a release name\n');
    expect(await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps())).toMatchObject({ removed: 0, skipped: 'selector_invalid' });
    rmSync(join(storeRoot, 'last-known-good'));

    chmodSync(releases, 0o777);
    expect(await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps())).toMatchObject({ removed: 0, skipped: 'untrusted_store' });
    chmodSync(releases, 0o755);

    expect(await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps({ runtime: { platform: 'darwin', arch: 'arm64', uid: process.getuid!() + 4242 } })))
      .toMatchObject({ removed: 0, skipped: 'untrusted_store' });
    expect(present()).toEqual(before);
    // and with everything sound again it does prune
    expect((await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps())).removed).toBeGreaterThan(0);
  });

  it('is a no-op without a store (and creates nothing), and refuses another platform', async () => {
    const missing = join(root, 'elsewhere', 'darwin-arm64');
    expect(await pruneMacosRemoteDesktopArtifactStore(missing, deps())).toMatchObject({ removed: 0, skipped: 'no_store' });
    expect(existsSync(missing)).toBe(false);
    await expect(pruneMacosRemoteDesktopArtifactStore(storeRoot, deps({ runtime: { platform: 'linux', arch: 'x64' } })))
      .rejects.toThrow('wrong_os');
  });

  it('touches only plain release directories of its own shape inside releases/', async () => {
    for (let index = 1; index <= 6; index += 1) makeRelease(index, 200 + (6 - index));
    select('current', 6);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'precious'), 'x');
    symlinkSync(outside, join(releases, nameOf(900)));              // a symlink named like a release
    writeFileSync(join(releases, nameOf(901)), 'a file, not a directory');
    mkdirSync(join(releases, 'sha256-short'));
    mkdirSync(join(releases, 'Sha256-' + '0'.repeat(64)));
    mkdirSync(join(releases, `${nameOf(902)}.partial`));
    writeFileSync(join(storeRoot, 'notes.txt'), 'x');
    for (const name of ['sha256-short', 'Sha256-' + '0'.repeat(64), `${nameOf(902)}.partial`, nameOf(900), nameOf(901)]) {
      const old = new Date(NOW - 900 * HOUR);
      try { utimesSync(join(releases, name), old, old); } catch { /* a dangling link has no times to set */ }
    }
    await pruneMacosRemoteDesktopArtifactStoreBacklog(storeRoot, deps(), { sleep: async () => {} });
    expect(present()).toEqual([
      'Sha256-' + '0'.repeat(64), `${nameOf(902)}.partial`, nameOf(4), nameOf(5), nameOf(6), nameOf(900), nameOf(901), 'sha256-short',
    ].sort());
    expect(readFileSync(join(outside, 'precious'), 'utf8')).toBe('x');
    expect(existsSync(join(storeRoot, 'notes.txt'))).toBe(true);
    expect(readdirSync(root).sort()).toEqual(['node-state', 'outside']);
  });

  it('a selection that lands between the plan and the removal is honoured (the selectors are read again per removal)', async () => {
    for (let index = 1; index <= 8; index += 1) makeRelease(index, 100 + (8 - index));
    select('current', 8);
    await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps({
      // runs after the selectors were first read and before the removals: a promotion selects the OLDEST release
      releasesInUse: async () => { select('current', 1); return new Set(); },
    }));
    expect(existsSync(join(releases, nameOf(1)))).toBe(true);
    expect(existsSync(join(releases, nameOf(2)))).toBe(false);
  });

  it('a release removed half-way is never left under a release name: a crash mid-delete leaves only a .pruning- directory, and the next pass finishes it', async () => {
    for (let index = 1; index <= 8; index += 1) makeRelease(index, 100 + (8 - index));
    select('current', 8);
    const killedDuringDelete = async (): Promise<void> => { throw new Error('process died during rm -rf'); };
    const first = await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps({ removeEntry: killedDuringDelete }));
    expect(first.removed).toBe(5);
    expect(present().filter((name) => name.startsWith('sha256-'))).toEqual([nameOf(6), nameOf(7), nameOf(8)]);
    const leftovers = present().filter((name) => name.startsWith('.pruning-'));
    expect(leftovers).toHaveLength(5);
    // the second pass removes the leftovers (they are not releases, and nothing can select or verify them)
    const second = await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps());
    expect(second.removed).toBe(5);
    expect(present()).toEqual([nameOf(6), nameOf(7), nameOf(8)]);
  });

  it('an entry that cannot be removed (a locked worker on Windows, a permission error) does not stall the others and is left alone for a few passes', async () => {
    for (let index = 1; index <= 12; index += 1) makeRelease(index, 100 + (12 - index));
    select('current', 12);
    const locked = join(releases, nameOf(1));
    let failures = 0;
    const renameEntry = async (from: string, to: string): Promise<void> => {
      if (from === locked) { failures += 1; throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); }
      const { renameSync } = await import('node:fs');
      renameSync(from, to);
    };
    const first = await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps({ renameEntry }));
    expect(first.failed).toBe(1);
    expect(first.removed).toBe(8); // 12 - the newest three - itself
    expect(existsSync(locked)).toBe(true);
    // the locked one is not retried at once ...
    for (let pass = 0; pass < REMOTE_DESKTOP_WORKER_RETENTION.FAILED_ENTRY_SKIP_PASSES; pass += 1) {
      await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps({ renameEntry }));
    }
    expect(failures).toBe(1);
    // ... and is removed once the lock is gone, after the skip window
    await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps());
    expect(existsSync(locked)).toBe(false);
    expect(present()).toEqual([nameOf(10), nameOf(11), nameOf(12)]);
  });

  it('half-built staging directories are left alone while young and removed once old', async () => {
    for (let index = 1; index <= 4; index += 1) makeRelease(index, 100 + (4 - index));
    select('current', 4);
    const young = join(releases, '.staging-young001');
    const old = join(releases, '.staging-old00001');
    for (const dir of [young, old]) { mkdirSync(dir, { mode: 0o755 }); writeFileSync(join(dir, 'half'), 'x'); }
    const oldTime = new Date(NOW - 3 * HOUR);
    const youngTime = new Date(NOW - 600_000);
    utimesSync(old, oldTime, oldTime);
    utimesSync(young, youngTime, youngTime);
    await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps());
    expect(existsSync(young)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  it('waits while a promotion of this process is running, and a second pass on the same store does not overlap the first', async () => {
    for (let index = 1; index <= 8; index += 1) makeRelease(index, 100 + (8 - index));
    select('current', 8);
    expect(await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps({ isBusy: () => true })))
      .toMatchObject({ removed: 0, moreWork: true, skipped: 'busy' });
    expect(present()).toHaveLength(8);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = pruneMacosRemoteDesktopArtifactStore(storeRoot, deps({ releasesInUse: async () => { await gate; return new Set(); } }));
    expect(await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps())).toMatchObject({ removed: 0, skipped: 'already_running' });
    release();
    expect((await slow).removed).toBe(5);
  });

  it('ignores a store crowded with foreign names (only names shaped like a release or its temporaries are examined)', async () => {
    for (let index = 0; index < 5_000; index += 1) writeFileSync(join(releases, `unrelated-${index}`), '');
    for (let index = 1; index <= 6; index += 1) makeRelease(index, 100 + (6 - index));
    select('current', 6);
    const result = await pruneMacosRemoteDesktopArtifactStore(storeRoot, deps());
    expect(result.removed).toBe(3);
    expect(present().filter((name) => name.startsWith('sha256-'))).toEqual([nameOf(4), nameOf(5), nameOf(6)]);
    expect(present().filter((name) => name.startsWith('unrelated-'))).toHaveLength(5_000);
  });
  it('the default in-use probe sees a release a running process was started from', async () => {
    if (process.platform === 'win32') return;
    const running = nameOf(0xabc);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', join(releases, running, 'imcodes-remote-desktop-agent')], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await defaultMacosRemoteDesktopReleasesInUse()).has(running)).toBe(true);
      expect((await defaultMacosRemoteDesktopReleasesInUse()).has(nameOf(0xdef))).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
