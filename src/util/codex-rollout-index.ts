import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const CODEX_ROLLOUT_INDEX = {
  /** A file whose last-seen mtime is older than the caller's floor is re-checked at most this often. */
  COLD_RESTAT_MS: 10_000,
  /** A directory listing is only trusted once its mtime is older than this at read time (coarse-mtime filesystems). */
  DIR_SETTLE_MS: 2_000,
} as const;

export interface CodexRolloutIndexDeps {
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  now(): number;
}

export interface CodexRolloutHit {
  path: string;
  mtimeMs: number;
}

interface DirEntry {
  mtimeMs: number;
  readAt: number;
  names: string[];
}

interface FileEntry {
  mtimeMs: number;
  statAt: number;
}

interface HomeState {
  dirs: Map<string, DirEntry>;
  files: Map<string, FileEntry>;
  inflight?: { floor: number; promise: Promise<CodexRolloutHit[]> };
}

const defaultDeps: CodexRolloutIndexDeps = {
  readdir: (path) => readdir(path),
  stat: (path) => stat(path),
  now: () => Date.now(),
};

function isRolloutName(name: string): boolean {
  return name.startsWith('rollout-') && name.endsWith('.jsonl');
}

/**
 * Which rollout files were touched since a floor, without re-listing every
 * day-directory and re-stat'ing every file on every poll.
 *
 * The child-subagent poll runs every 2s per Codex session over ~30 day
 * directories holding thousands of rollouts, and used to `readdir` each
 * directory and `stat` every file each time (~2.2 s of main-thread `stat` per
 * 120 s in a real profile). Directory listings are reused while the directory
 * mtime is unchanged (a new rollout changes it); files already known to be
 * older than the floor are re-checked at most every COLD_RESTAT_MS; files at
 * or above the floor are stat'd every pass so appends are seen at once.
 * Concurrent callers for one CODEX_HOME share a single pass.
 */
export class CodexRolloutIndex {
  private readonly homes = new Map<string, HomeState>();

  constructor(private readonly deps: CodexRolloutIndexDeps = defaultDeps) {}

  async listSince(codexHome: string, dirs: readonly string[], floorMs: number): Promise<string[]> {
    let state = this.homes.get(codexHome);
    if (!state) {
      state = { dirs: new Map(), files: new Map() };
      this.homes.set(codexHome, state);
    }
    let hits: CodexRolloutHit[];
    const shared = state.inflight;
    if (shared && shared.floor <= floorMs) {
      hits = await shared.promise;
    } else {
      const homeState = state;
      const promise = this.pass(homeState, dirs, floorMs);
      const record = { floor: floorMs, promise };
      homeState.inflight = record;
      try {
        hits = await promise;
      } finally {
        if (homeState.inflight === record) homeState.inflight = undefined;
      }
    }
    return hits.filter((hit) => hit.mtimeMs >= floorMs).map((hit) => hit.path);
  }

  private async pass(state: HomeState, dirs: readonly string[], floorMs: number): Promise<CodexRolloutHit[]> {
    const hits: CodexRolloutHit[] = [];
    for (const dir of dirs) {
      let dirMtimeMs: number;
      try {
        dirMtimeMs = (await this.deps.stat(dir)).mtimeMs;
      } catch {
        this.forgetDir(state, dir);
        continue;
      }
      let entry = state.dirs.get(dir);
      const settled = entry !== undefined
        && entry.mtimeMs === dirMtimeMs
        && entry.readAt - dirMtimeMs > CODEX_ROLLOUT_INDEX.DIR_SETTLE_MS;
      if (!settled) {
        let names: string[];
        try {
          names = (await this.deps.readdir(dir)).filter(isRolloutName);
        } catch {
          this.forgetDir(state, dir);
          continue;
        }
        if (entry) {
          const current = new Set(names);
          for (const previous of entry.names) {
            if (!current.has(previous)) state.files.delete(join(dir, previous));
          }
        }
        entry = { mtimeMs: dirMtimeMs, readAt: this.deps.now(), names };
        state.dirs.set(dir, entry);
      }
      for (const name of entry!.names) {
        const path = join(dir, name);
        const known = state.files.get(path);
        const now = this.deps.now();
        if (known && known.mtimeMs < floorMs && now - known.statAt < CODEX_ROLLOUT_INDEX.COLD_RESTAT_MS) continue;
        let mtimeMs: number;
        try {
          mtimeMs = (await this.deps.stat(path)).mtimeMs;
        } catch {
          state.files.delete(path);
          continue;
        }
        state.files.set(path, { mtimeMs, statAt: now });
        if (mtimeMs >= floorMs) hits.push({ path, mtimeMs });
      }
    }
    const inWindow = new Set(dirs);
    for (const dir of [...state.dirs.keys()]) {
      if (!inWindow.has(dir)) this.forgetDir(state, dir);
    }
    return hits;
  }

  private forgetDir(state: HomeState, dir: string): void {
    const entry = state.dirs.get(dir);
    if (!entry) return;
    for (const name of entry.names) state.files.delete(join(dir, name));
    state.dirs.delete(dir);
  }
}

export const codexRolloutIndex = new CodexRolloutIndex();
