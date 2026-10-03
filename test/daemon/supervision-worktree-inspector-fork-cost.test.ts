import { execFileSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSupervisionWorktreeInspectionCacheForTests,
  inspectSupervisionAssignmentWorktree,
} from '../../src/daemon/supervision-worktree-inspector.js';

/**
 * Production-shaped cost contract for the supervision worktree inspector.
 *
 * Measured on 172.16.253.215 (PID 6092, V8 sampling profiler, 12s/22286 samples):
 *   98.0% of MAIN-THREAD self time in `spawn` (native), reached from
 *   supervision-worktree-inspector `matchingRemoteDelivery` / `inspect...`,
 *   sustained 30-59 forks/s, ~100MB/s RssAnon churn, event-loop stalls logged
 *   1157x, and delegation_reply hook timeouts at 10s.
 *
 * Cost is measured by counting REAL `git` process creations through a PATH
 * shim rather than by spying on `node:child_process`. A spy can be defeated by
 * switching sync->async or by importing a different helper; a process that
 * actually forks always goes through PATH.
 */

const roots: string[] = [];
let realGit = '';
let originalPath = '';

beforeEach(() => {
  originalPath = process.env.PATH ?? '';
  realGit = execFileSync('/usr/bin/env', ['sh', '-c', 'command -v git'], { encoding: 'utf8' }).trim();
});
afterEach(() => {
  vi.useRealTimers();
  __resetSupervisionWorktreeInspectionCacheForTests();
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Shape {
  root: string;
  repo: string;
  counter: string;
  gitCalls: () => string[];
  resetCalls: () => void;
}

/**
 * A production-shaped assignment worktree: real git, real remote refs, real
 * dirty working tree. 4 remote refs matches what every one of the 138 live
 * worktrees on 215 carries.
 */
function shape(options: { changedFiles: number; refs?: number }): Shape {
  const root = mkdtempSync(join(tmpdir(), 'imcodes-fork-cost-'));
  roots.push(root);
  const repo = join(root, 'imcodes', 'deck_worker', 'assignment_one', 'repo');
  mkdirSync(repo, { recursive: true });
  const run = (args: string[]) => execFileSync(realGit, ['-C', repo, ...args], { encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.invalid']);
  run(['config', 'user.name', 'Test']);
  for (let i = 0; i < options.changedFiles; i += 1) {
    writeFileSync(join(repo, `src-${i}.txt`), `committed ${i}\n`);
  }
  run(['add', '-A']);
  run(['commit', '-qm', 'base']);
  for (let i = 0; i < (options.refs ?? 4); i += 1) {
    run(['update-ref', `refs/remotes/origin/branch-${i}`, 'HEAD']);
  }
  // Dirty every tracked file so `files` is exactly changedFiles.
  for (let i = 0; i < options.changedFiles; i += 1) {
    writeFileSync(join(repo, `src-${i}.txt`), `worktree edit ${i}\n`);
  }

  // PATH shim: every `git` process creation appends one line, then execs real git.
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const counter = join(root, 'git-calls.log');
  writeFileSync(counter, '');
  const shim = join(bin, 'git');
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(counter)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(shim, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;

  return {
    root,
    repo,
    counter,
    gitCalls: () => readFileSync(counter, 'utf8').split('\n').filter(Boolean),
    resetCalls: () => writeFileSync(counter, ''),
  };
}

/** Runs `fn` while sampling how long the event loop is unable to schedule. */
async function withEventLoopStall<T>(fn: () => Promise<T> | T): Promise<{ value: T; maxStallMs: number; elapsedMs: number }> {
  let last = process.hrtime.bigint();
  let maxStallMs = 0;
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    maxStallMs = Math.max(maxStallMs, Number(now - last) / 1e6);
    last = now;
  }, 5);
  try {
    const start = process.hrtime.bigint();
    last = start;
    const value = await fn();
    const now = process.hrtime.bigint();
    maxStallMs = Math.max(maxStallMs, Number(now - last) / 1e6);
    return { value, maxStallMs, elapsedMs: Number(now - start) / 1e6 };
  } finally {
    clearInterval(timer);
  }
}

const inspect = (repo: string) => inspectSupervisionAssignmentWorktree({
  sessionName: 'deck_worker', assignmentId: 'assignment_one', worktreePath: repo,
});

describe('supervision worktree inspection cost (production-shaped)', () => {
  it('cold inspection spawns a bounded, constant number of git processes', async () => {
    const small = shape({ changedFiles: 2 });
    small.resetCalls();
    expect((await inspect(small.repo)).ok).toBe(true);
    const smallCalls = small.gitCalls().length;

    const large = shape({ changedFiles: 12 });
    large.resetCalls();
    expect((await inspect(large.repo)).ok).toBe(true);
    const largeCalls = large.gitCalls().length;

    // 2 -> 12 changed files with 4 refs each. The sync implementation pays
    // 1 `git diff --quiet` per tracked path plus refs x files `git show`,
    // so it goes from ~19 to ~79. Cost must not track content volume.
    expect(smallCalls, `small=${smallCalls} calls: ${small.gitCalls().join(' | ')}`).toBeLessThanOrEqual(12);
    expect(largeCalls, `large=${largeCalls} calls: ${large.gitCalls().join(' | ')}`).toBeLessThanOrEqual(12);
    expect(largeCalls, 'git process count must not grow with refs x files').toBe(smallCalls);
  });

  it('never spawns one git process per changed path (no refs x files amplification)', async () => {
    const s = shape({ changedFiles: 12, refs: 8 });
    s.resetCalls();
    expect((await inspect(s.repo)).ok).toBe(true);
    const shows = s.gitCalls().filter((line) => line.includes(' show '));
    const quiets = s.gitCalls().filter((line) => line.includes('--quiet'));
    expect(shows.length, `per-file git show calls: ${shows.length}`).toBe(0);
    expect(quiets.length, `per-file git diff --quiet calls: ${quiets.length}`).toBe(0);
  });

  it('does not block the daemon event loop while inspecting', async () => {
    // A single sample of a real wall-clock stall on a shared CI runner is
    // noisy: this test previously asserted a lone run under 60ms and flaked
    // on macOS CI at 61.2ms -- a scheduler hiccup on an otherwise-compliant
    // async implementation, not a regression. `no synchronous child process
    // survives on the inspection path` below already proves the structural
    // contract (no execFileSync/spawnSync/execSync can even be present in the
    // source); this test adds a load-tolerant confirmation on top of that
    // rather than trying to be the sole line of defense.
    //
    // An earlier revision of this fix used median-of-5 against a FIXED
    // absolute ceiling (150ms), derived from one machine's measured
    // synchronous-fork cost. That is not load-independent: a sync fork's
    // stall is simply the inspection's own duration, so a faster or quieter
    // machine (or CI's Linux runners, generally faster at process spawn than
    // this one) drives that duration below any fixed ceiling picked on a
    // slower/louder one. Confirmed by measurement: the same execFileSync
    // mutant that produced a 278ms median stall on a loaded machine produced
    // ~117ms on a quieter one -- comfortably under the old 150ms ceiling.
    //
    // The load-independent signal is the STALL-TO-ELAPSED RATIO, not an
    // absolute number. A synchronous fork blocks the loop for essentially the
    // whole call: stall/elapsed ~= 1.0, on any machine, at any speed, because
    // the operation and the stall are the same event. An async
    // implementation yields the loop between every git call, so its stall is
    // bounded by scheduling noise (the 5ms sampling interval, plus whatever
    // else is running) regardless of how long the whole inspection took to
    // return -- measured at stall/elapsed ~= 0.07-0.09 on both a quiet and a
    // loaded machine.
    //
    // Ceiling = max(ABSOLUTE_FLOOR_MS, STALL_TO_ELAPSED_RATIO * elapsed).
    // The floor exists only so scheduling noise on a near-instant inspection
    // can't trip a false positive; it is far above the 5ms sampling
    // resolution and, per the ratio, is exceeded by a sync fork on any
    // inspection slower than ABSOLUTE_FLOOR_MS / STALL_TO_ELAPSED_RATIO = 40ms
    // -- every real measurement here, sync or async, loaded or quiet, has
    // been at least 70ms (8+ real `git` process creations do not complete
    // in under 40ms total on any machine this ran on). Below that floor the
    // test could in principle miss an implausibly fast full synchronous
    // fork chain; that bound is stated here rather than hidden.
    //
    // Sample several independent cold inspections of the SAME shaped repo
    // (cache reset between each, so every one actually walks git rather than
    // serving a hit) and take the median of both stall and elapsed, which
    // absorbs one noisy sample the way a single run cannot. A genuine
    // synchronous fork keeps stall/elapsed ~= 1.0 on every iteration, so it
    // cannot hide behind the median either.
    const STALL_SAMPLES = 5;
    const ABSOLUTE_FLOOR_MS = 20;
    const STALL_TO_ELAPSED_RATIO = 0.5;
    const s = shape({ changedFiles: 12 });
    const stallSamples: number[] = [];
    const elapsedSamples: number[] = [];
    for (let i = 0; i < STALL_SAMPLES; i += 1) {
      __resetSupervisionWorktreeInspectionCacheForTests();
      const { value, maxStallMs, elapsedMs } = await withEventLoopStall(() => inspect(s.repo));
      expect(value.ok).toBe(true);
      stallSamples.push(maxStallMs);
      elapsedSamples.push(elapsedMs);
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const medianStallMs = median(stallSamples);
    const medianElapsedMs = median(elapsedSamples);
    const ceilingMs = Math.max(ABSOLUTE_FLOOR_MS, STALL_TO_ELAPSED_RATIO * medianElapsedMs);
    expect(
      medianStallMs,
      `median stall ${medianStallMs.toFixed(1)}ms vs ceiling ${ceilingMs.toFixed(1)}ms `
        + `(median elapsed ${medianElapsedMs.toFixed(1)}ms); `
        + `stall samples: ${stallSamples.map((ms) => ms.toFixed(1)).join(', ')}; `
        + `elapsed samples: ${elapsedSamples.map((ms) => ms.toFixed(1)).join(', ')}`,
    ).toBeLessThan(ceilingMs);
  });

  it('re-inspects an unchanged worktree with a single bounded probe', async () => {
    const s = shape({ changedFiles: 6 });
    const first = await inspect(s.repo);
    expect(first.ok).toBe(true);
    s.resetCalls();
    const second = await inspect(s.repo);
    expect(second).toEqual(first);
    // Reuse is not free, and deliberately so: a fork-free key cannot see a
    // path that was clean when the snapshot was taken, and serving a stale
    // manifest is how a positive delivery authority survives an undelivered
    // file. One `git status` proves the dirty set instead.
    const calls = s.gitCalls();
    expect(calls.length, `reuse spawned: ${calls.join(' | ')}`).toBe(1);
    expect(calls[0]).toContain('status --porcelain');
  });

  it('coalesces concurrent identical inspections into one underlying pass', async () => {
    const s = shape({ changedFiles: 6 });
    s.resetCalls();
    const results = await Promise.all(Array.from({ length: 8 }, () => inspect(s.repo)));
    for (const result of results) expect(result).toEqual(results[0]);
    const calls = s.gitCalls().length;
    expect(calls, `8 concurrent inspections spawned ${calls} git processes`).toBeLessThanOrEqual(12);
  });
});

describe('cached inspection invalidates precisely', () => {
  const readSnapshot = async (repo: string) => {
    const result = await inspect(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    return result.snapshot;
  };

  it('re-reads when a reported file changes on disk', async () => {
    const s = shape({ changedFiles: 3 });
    const before = await readSnapshot(s.repo);
    writeFileSync(join(s.repo, 'src-1.txt'), 'edited after the snapshot\n');
    s.resetCalls();
    const after = await readSnapshot(s.repo);
    expect(s.gitCalls().length, 'a content change must not be served from cache').toBeGreaterThan(0);
    const digest = (snap: typeof before) => snap.files.find((file) => file.path === 'src-1.txt')?.sha256;
    expect(digest(after)).not.toBe(digest(before));
  });

  it('re-reads when a previously CLEAN tracked file becomes dirty', async () => {
    // This is the case a fork-free key structurally cannot see: editing a
    // clean tracked file touches neither the index nor any reported path.
    // It is now caught by the dirty-set probe, immediately, with no TTL wait.
    const s = shape({ changedFiles: 2 });
    execFileSync(realGit, ['-C', s.repo, 'checkout', '-q', '--', 'src-1.txt']);
    __resetSupervisionWorktreeInspectionCacheForTests();
    const before = await readSnapshot(s.repo);
    expect(before.files.map((file) => file.path)).toEqual(['src-0.txt']);

    writeFileSync(join(s.repo, 'src-1.txt'), 'newly dirty\n');
    const after = await readSnapshot(s.repo);
    expect(
      after.files.map((file) => file.path),
      'a newly dirty path must never be hidden by a cache hit',
    ).toEqual(['src-0.txt', 'src-1.txt']);
  });

  it('re-reads when a NEW untracked file appears', async () => {
    const s = shape({ changedFiles: 2 });
    const before = await readSnapshot(s.repo);
    expect(before.untrackedPaths).toEqual([]);
    writeFileSync(join(s.repo, 'brand-new.txt'), 'appeared\n');
    const after = await readSnapshot(s.repo);
    expect(after.untrackedPaths).toEqual(['brand-new.txt']);
  });

  it('re-reads when staging changes', async () => {
    const s = shape({ changedFiles: 3 });
    const before = await readSnapshot(s.repo);
    expect(before.stagedPaths).toEqual([]);
    execFileSync(realGit, ['-C', s.repo, 'add', 'src-0.txt']);
    const after = await readSnapshot(s.repo);
    expect(after.stagedPaths).toEqual(['src-0.txt']);
  });

  it('re-reads when HEAD moves', async () => {
    const s = shape({ changedFiles: 2 });
    const before = await readSnapshot(s.repo);
    execFileSync(realGit, ['-C', s.repo, 'commit', '-qam', 'advance']);
    const after = await readSnapshot(s.repo);
    expect(after.headSha).not.toBe(before.headSha);
    expect(after.files).toEqual([]);
  });

  it('re-reads when a remote ref moves', async () => {
    const s = shape({ changedFiles: 2 });
    await readSnapshot(s.repo);
    execFileSync(realGit, ['-C', s.repo, 'update-ref', 'refs/remotes/origin/added', 'HEAD']);
    s.resetCalls();
    await readSnapshot(s.repo);
    expect(s.gitCalls().length, 'a moved remote ref must invalidate the cached match').toBeGreaterThan(0);
  });

  it('expires by TTL even when nothing observable changed', async () => {
    const s = shape({ changedFiles: 2 });
    await readSnapshot(s.repo);
    s.resetCalls();
    await readSnapshot(s.repo);
    expect(s.gitCalls().length, 'inside the TTL reuse costs only the dirty-set probe').toBe(1);
    s.resetCalls();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    await readSnapshot(s.repo);
    expect(
      s.gitCalls().length,
      'past the TTL the worktree must be fully re-read, not merely probed',
    ).toBeGreaterThan(1);
  });
});

describe('no synchronous child process survives on the inspection path', () => {
  it('neither the inspector nor any production caller uses execFileSync/spawnSync', () => {
    const offenders: string[] = [];
    for (const file of [
      'src/daemon/supervision-worktree-inspector.ts',
      'src/daemon/send-tool.ts',
      'src/daemon/supervision-automation.ts',
      'src/daemon/supervision-registry-port.ts',
      'src/daemon/memory-mcp-tools.ts',
      'src/daemon/delegation-reply-ingress.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      for (const banned of ['execFileSync', 'spawnSync', 'execSync']) {
        if (source.includes(banned)) offenders.push(`${file}: ${banned}`);
      }
    }
    expect(offenders, 'the daemon inspection path must never fork synchronously').toEqual([]);
  });
});
