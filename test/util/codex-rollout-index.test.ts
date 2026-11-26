import { describe, expect, it } from 'vitest';
import { CODEX_ROLLOUT_INDEX, CodexRolloutIndex, type CodexRolloutIndexDeps } from '../../src/util/codex-rollout-index.js';

/**
 * The child-subagent poll used to `readdir` every day-directory and `stat`
 * every rollout file on every tick, for every Codex session. These tests
 * count the filesystem calls of that old algorithm (`naiveList`, a faithful
 * copy of the previous traversal) against the index on identical trees, and
 * then prove the index still sees every change the old traversal saw.
 */

interface FakeFs {
  deps: CodexRolloutIndexDeps;
  calls: { readdir: number; stat: number };
  advance(ms: number): void;
  dir(path: string, mtimeMs: number, names: string[]): void;
  file(path: string, mtimeMs: number): void;
  removeFile(dir: string, name: string): void;
}

function makeFs(startMs = 1_000_000): FakeFs {
  let clock = startMs;
  const dirs = new Map<string, { mtimeMs: number; names: string[] }>();
  const files = new Map<string, number>();
  const calls = { readdir: 0, stat: 0 };
  const deps: CodexRolloutIndexDeps = {
    now: () => clock,
    async readdir(path) {
      calls.readdir += 1;
      const entry = dirs.get(path);
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [...entry.names];
    },
    async stat(path) {
      calls.stat += 1;
      const dir = dirs.get(path);
      if (dir) return { mtimeMs: dir.mtimeMs };
      const mtimeMs = files.get(path);
      if (mtimeMs === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mtimeMs };
    },
  };
  return {
    deps,
    calls,
    advance: (ms) => { clock += ms; },
    dir: (path, mtimeMs, names) => { dirs.set(path, { mtimeMs, names }); },
    file: (path, mtimeMs) => { files.set(path, mtimeMs); },
    removeFile: (dir, name) => {
      const entry = dirs.get(dir);
      if (entry) entry.names = entry.names.filter((candidate) => candidate !== name);
      files.delete(`${dir}/${name}`);
    },
  };
}

/** The previous traversal, unchanged: list every dir, stat every file. */
async function naiveList(deps: CodexRolloutIndexDeps, dirs: string[], floorMs: number): Promise<string[]> {
  const out: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try { names = await deps.readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const path = `${dir}/${name}`;
      try {
        const info = await deps.stat(path);
        if (info.mtimeMs < floorMs) continue;
      } catch { continue; }
      out.push(path);
    }
  }
  return out;
}

const DAYS = 30;
const FILES_PER_DAY = 150;
const dirPaths = Array.from({ length: DAYS }, (_, i) => `/codex/sessions/2026/09/${String(30 - i).padStart(2, '0')}`);

function seedArchive(fake: FakeFs, hotDay = 0): { hot: string } {
  const old = fake.deps.now() - 10 * 86_400_000;
  dirPaths.forEach((dir, dayIndex) => {
    const names = Array.from({ length: FILES_PER_DAY }, (_, n) => `rollout-2026-09-${dayIndex}-${n}.jsonl`);
    fake.dir(dir, old, names);
    for (const name of names) fake.file(`${dir}/${name}`, old);
  });
  const hot = `${dirPaths[hotDay]}/rollout-2026-09-${hotDay}-0.jsonl`;
  fake.file(hot, fake.deps.now());
  return { hot };
}

describe('CodexRolloutIndex', () => {
  it('cuts the per-tick filesystem calls of an archive of thousands of rollouts to the directories plus the hot files', async () => {
    const fake = makeFs();
    const { hot } = seedArchive(fake);
    const floor = fake.deps.now() - 60_000;

    const baseline = makeFs();
    seedArchive(baseline);
    const naiveHits = await naiveList(baseline.deps, dirPaths, floor);
    const naivePerTick = baseline.calls.readdir + baseline.calls.stat;
    expect(naiveHits).toEqual([hot]);
    expect(naivePerTick).toBe(DAYS + DAYS * FILES_PER_DAY);

    const index = new CodexRolloutIndex(fake.deps);
    expect(await index.listSince('/codex', dirPaths, floor)).toEqual([hot]);
    const firstPass = fake.calls.readdir + fake.calls.stat;
    expect(firstPass).toBeGreaterThanOrEqual(naivePerTick);

    fake.calls.readdir = 0;
    fake.calls.stat = 0;
    fake.advance(2_000);
    expect(await index.listSince('/codex', dirPaths, floor)).toEqual([hot]);
    // Second tick: one stat per directory plus the single hot file, no readdir.
    expect(fake.calls.readdir).toBe(0);
    expect(fake.calls.stat).toBe(DAYS + 1);
    expect(naivePerTick / (fake.calls.readdir + fake.calls.stat)).toBeGreaterThan(100);
  });

  it('sees a rollout created after the index was warm (directory mtime changed)', async () => {
    const fake = makeFs();
    seedArchive(fake);
    const floor = fake.deps.now() - 60_000;
    const index = new CodexRolloutIndex(fake.deps);
    await index.listSince('/codex', dirPaths, floor);

    fake.advance(5_000);
    const created = `${dirPaths[3]}/rollout-brand-new.jsonl`;
    fake.dir(dirPaths[3], fake.deps.now(), [...(await fake.deps.readdir(dirPaths[3])), 'rollout-brand-new.jsonl']);
    fake.file(created, fake.deps.now());
    expect(await index.listSince('/codex', dirPaths, floor)).toContain(created);
  });

  it('picks up an append to a hot file on the very next pass', async () => {
    const fake = makeFs();
    const { hot } = seedArchive(fake);
    const floor = fake.deps.now() - 60_000;
    const index = new CodexRolloutIndex(fake.deps);
    await index.listSince('/codex', dirPaths, floor);

    fake.advance(1_000);
    const before = fake.calls.stat;
    fake.file(hot, fake.deps.now());
    expect(await index.listSince('/codex', dirPaths, floor)).toEqual([hot]);
    expect(fake.calls.stat - before).toBe(DAYS + 1);
  });

  it('notices an old rollout that becomes active again within COLD_RESTAT_MS, not never', async () => {
    const fake = makeFs();
    seedArchive(fake);
    const floor = fake.deps.now() - 60_000;
    const index = new CodexRolloutIndex(fake.deps);
    await index.listSince('/codex', dirPaths, floor);

    const cold = `${dirPaths[5]}/rollout-2026-09-5-7.jsonl`;
    fake.advance(1_000);
    fake.file(cold, fake.deps.now());
    // Inside the backoff window the file is not re-stat'd yet.
    expect(await index.listSince('/codex', dirPaths, floor)).not.toContain(cold);
    fake.advance(CODEX_ROLLOUT_INDEX.COLD_RESTAT_MS);
    expect(await index.listSince('/codex', dirPaths, floor)).toContain(cold);
  });

  it('never trusts a directory listing taken while the directory was still being written (coarse mtime)', async () => {
    const fake = makeFs();
    const dir = dirPaths[0];
    const now = fake.deps.now();
    fake.dir(dir, now, ['rollout-a.jsonl']);
    fake.file(`${dir}/rollout-a.jsonl`, now);
    const index = new CodexRolloutIndex(fake.deps);
    const floor = now - 60_000;
    expect(await index.listSince('/codex', [dir], floor)).toEqual([`${dir}/rollout-a.jsonl`]);

    // A second file lands inside the same mtime tick: directory mtime is unchanged.
    fake.dir(dir, now, ['rollout-a.jsonl', 'rollout-b.jsonl']);
    fake.file(`${dir}/rollout-b.jsonl`, now);
    fake.advance(100);
    expect(await index.listSince('/codex', [dir], floor)).toEqual([`${dir}/rollout-a.jsonl`, `${dir}/rollout-b.jsonl`]);
  });

  it('drops a deleted rollout and a vanished directory instead of returning stale paths', async () => {
    const fake = makeFs();
    seedArchive(fake);
    const floor = fake.deps.now() - 60_000;
    const index = new CodexRolloutIndex(fake.deps);
    const { hot } = { hot: `${dirPaths[0]}/rollout-2026-09-0-0.jsonl` };
    expect(await index.listSince('/codex', dirPaths, floor)).toEqual([hot]);
    fake.advance(5_000);
    fake.removeFile(dirPaths[0], 'rollout-2026-09-0-0.jsonl');
    fake.dir(dirPaths[0], fake.deps.now(), (await fake.deps.readdir(dirPaths[0])));
    expect(await index.listSince('/codex', dirPaths, floor)).toEqual([]);
  });

  it('keeps the old traversal order: directories as given, names as listed', async () => {
    const fake = makeFs();
    const now = fake.deps.now();
    fake.dir('/d/a', now, ['rollout-2.jsonl', 'rollout-1.jsonl', 'notes.txt']);
    fake.dir('/d/b', now, ['rollout-3.jsonl']);
    for (const path of ['/d/a/rollout-2.jsonl', '/d/a/rollout-1.jsonl', '/d/b/rollout-3.jsonl']) fake.file(path, now);
    const index = new CodexRolloutIndex(fake.deps);
    const paths = await index.listSince('/codex', ['/d/a', '/d/missing', '/d/b'], now - 1_000);
    expect(paths).toEqual(await naiveList(fake.deps, ['/d/a', '/d/missing', '/d/b'], now - 1_000));
  });

  it('lets concurrent callers for one CODEX_HOME share a single pass', async () => {
    const fake = makeFs();
    seedArchive(fake);
    const floor = fake.deps.now() - 60_000;
    const index = new CodexRolloutIndex(fake.deps);
    const results = await Promise.all(Array.from({ length: 5 }, () => index.listSince('/codex', dirPaths, floor)));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(fake.calls.readdir).toBe(DAYS);
    expect(fake.calls.stat).toBe(DAYS + DAYS * FILES_PER_DAY);
  });

  it('a caller with an older floor than a running pass still gets the files only its floor admits', async () => {
    const fake = makeFs();
    const { hot } = seedArchive(fake);
    const index = new CodexRolloutIndex(fake.deps);
    const recent = fake.deps.now() - 60_000;
    const ancient = fake.deps.now() - 30 * 86_400_000;
    const [recentHits, ancientHits] = await Promise.all([
      index.listSince('/codex', dirPaths, recent),
      index.listSince('/codex', dirPaths, ancient),
    ]);
    expect(recentHits).toEqual([hot]);
    expect(ancientHits.length).toBe(DAYS * FILES_PER_DAY);
  });
});
