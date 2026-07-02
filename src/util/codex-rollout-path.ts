// Canonical codex rollout-file path resolution, shared by the codex-sdk
// transport provider (app-server) and the codex-watcher (CLI/process agent).
//
// Codex persists every thread's rollout under `sessions/YYYY/MM/DD` keyed on the
// thread's CREATION date, and never moves the file — a long-lived thread keeps
// appending to that same original-date file for weeks. Any lookup that guesses
// the directory from a fixed recent-day window therefore silently misses threads
// older than the window, which are exactly the long-lived brains and
// sub-sessions most prone to app-server "zombie" turns. It is also wrong to
// derive the directory from a timestamp: codex names the dir/file in LOCAL time
// while the rollout's own `session_meta.timestamp` is UTC, so the two diverge by
// a day near midnight in non-UTC zones.
//
// `findCodexRolloutPathByUuid` avoids both traps by enumerating the real
// `YYYY/MM/DD` directories newest-first and matching the thread uuid embedded in
// the filename — locating threads of ANY age, immune to date/timezone skew.
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROLLOUT_UUID_RE =
  /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Resolve CODEX_HOME (env override) or the default `~/.codex`. */
export function getCodexHome(env?: Record<string, string | undefined>): string {
  const raw = env?.CODEX_HOME;
  return typeof raw === 'string' && raw.trim() ? resolve(raw.trim()) : resolve(homedir(), '.codex');
}

/**
 * `<codexHome>/sessions/YYYY/MM/DD` for a wall-clock date (UTC components, to
 * match how codex-cli's own session-file creation is emulated). Kept for callers
 * that create or window-scan by date; for LOCATING an existing thread by id,
 * prefer {@link findCodexRolloutPathByUuid}, which does not depend on dates.
 */
export function codexSessionDir(codexHome: string, date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return join(codexHome, 'sessions', String(yyyy), mm, dd);
}

/**
 * A bounded window (default 30) of recent day-dirs — appropriate ONLY for
 * discovering FRESH files (by mtime/cwd) whose creation is recent. Do NOT use
 * this to locate a long-lived thread by id; use {@link findCodexRolloutPathByUuid}.
 */
export function recentCodexSessionDirs(codexHome: string = getCodexHome(), days = 30): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < days; i += 1) {
    dirs.push(codexSessionDir(codexHome, new Date(Date.now() - i * 86_400_000)));
  }
  return dirs;
}

/** Extract the codex thread/session uuid embedded in a rollout filename. */
export function extractCodexRolloutUuid(path: string): string | null {
  const m = ROLLOUT_UUID_RE.exec(path);
  return m ? m[1] : null;
}

/** Existing numeric subdirectory names of `parent`, sorted newest (largest) first. */
async function numericChildDirsDesc(parent: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(b) - Number(a));
}

/**
 * Locate the rollout file for a codex thread/session uuid, regardless of the
 * thread's age. Enumerates the real `sessions/YYYY/MM/DD` directories
 * newest-first and returns the first (most recent) directory's matching file.
 * Returns `null` if no rollout for the uuid exists.
 *
 * Real thread uuids map 1:1 to a rollout file, so the newest-first scan is both
 * correct and fast (recent threads resolve in the first directory); the
 * mtime tiebreak only guards the degenerate case of a duplicated uuid.
 */
export async function findCodexRolloutPathByUuid(
  uuid: string,
  opts: { env?: Record<string, string | undefined>; codexHome?: string } = {},
): Promise<string | null> {
  const sessionsRoot = join(opts.codexHome ?? getCodexHome(opts.env), 'sessions');
  for (const y of await numericChildDirsDesc(sessionsRoot)) {
    for (const m of await numericChildDirsDesc(join(sessionsRoot, y))) {
      for (const d of await numericChildDirsDesc(join(sessionsRoot, y, m))) {
        const dir = join(sessionsRoot, y, m, d);
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
          continue;
        }
        let latestPath: string | null = null;
        let latestMtime = -1;
        for (const name of entries) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl') || !name.includes(uuid)) continue;
          const candidate = join(dir, name);
          try {
            const info = await stat(candidate);
            if (info.mtimeMs > latestMtime) {
              latestMtime = info.mtimeMs;
              latestPath = candidate;
            }
          } catch {
            continue;
          }
        }
        if (latestPath) return latestPath;
      }
    }
  }
  return null;
}
