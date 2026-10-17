/**
 * Which entries of a controlled node's remote-desktop worker store may be removed.
 *
 * The macOS store keeps every published worker release as `releases/sha256-<set hash>` (a whole signed component set, about
 * 15-17 MB), one per distinct worker build, and nothing ever removed one: a Mac that updates often held 334 of them (4.9 GB) with
 * only `current` and `last-known-good` ever read. The Linux and Windows nodes replace their single worker in place, so they have no
 * history to prune; the policy is still platform-neutral so every store that grows releases answers the same way.
 *
 * This module decides ONLY from names, kinds and ages, with the clock passed in. Everything that touches a disk (listing, the
 * "is this release in use" test, renaming, deleting) is the platform's, so the rules below can be exercised exhaustively.
 */

export const REMOTE_DESKTOP_WORKER_RETENTION = {
  /** The newest releases kept whatever their selector state: the selected pair plus a margin for a rollback target in flight. */
  KEEP_NEWEST_RELEASES: 3,
  /** A release younger than this is never removed (a promotion in another process may be about to select it). */
  MIN_RELEASE_AGE_MS: 6 * 60 * 60_000,
  /** A half-built or half-removed directory is left alone this long, so a promotion that is still copying is never touched. */
  MIN_TEMPORARY_AGE_MS: 60 * 60_000,
  /** Directories removed per pass: the cost of one pass, whatever the backlog. */
  MAX_REMOVALS_PER_PASS: 16,
  /** Candidate directories examined per pass (names that look like ours); entries beyond it wait for a later pass. */
  MAX_CANDIDATES_PER_PASS: 4_096,
  /** Directory entries read per pass while looking for candidates (names only, no stat). */
  MAX_ENTRIES_SCANNED: 100_000,
  /** Pause between the passes that drain a backlog, and the most passes one drain may run. */
  BACKLOG_PASS_DELAY_MS: 5_000,
  BACKLOG_MAX_PASSES: 64,
  /** Passes an entry that could not be removed (in use, locked, permissions) is left alone for. */
  FAILED_ENTRY_SKIP_PASSES: 8,
} as const;

/** The kind of store entry: a published release, or a temporary directory the store itself makes while publishing or removing one. */
export const REMOTE_DESKTOP_WORKER_ENTRY_KIND = {
  RELEASE: 'release',
  TEMPORARY: 'temporary',
} as const;
export type RemoteDesktopWorkerEntryKind =
  (typeof REMOTE_DESKTOP_WORKER_ENTRY_KIND)[keyof typeof REMOTE_DESKTOP_WORKER_ENTRY_KIND];

export interface RemoteDesktopWorkerStoreEntry {
  name: string;
  kind: RemoteDesktopWorkerEntryKind;
  /** Modification time of the directory itself. */
  mtimeMs: number;
}

export interface RemoteDesktopWorkerPrunePlanInput {
  entries: readonly RemoteDesktopWorkerStoreEntry[];
  /** Releases that must stay: the selectors (`current`, `last-known-good`) and every release a running worker or journal names. */
  protectedNames: ReadonlySet<string>;
  /** Entries that could not be removed recently; they are neither planned nor counted as remaining work. */
  skipNames?: ReadonlySet<string>;
  nowMs: number;
  keepNewest?: number;
  minReleaseAgeMs?: number;
  minTemporaryAgeMs?: number;
  maxRemovals?: number;
}

export interface RemoteDesktopWorkerPrunePlan {
  /** Oldest first (temporary directories before releases); at most `maxRemovals`. */
  remove: RemoteDesktopWorkerStoreEntry[];
  /** More removable entries exist than this pass may remove. */
  moreWork: boolean;
}

/**
 * Releases: kept when protected, among the newest `keepNewest` of all releases, or younger than the minimum age; the rest are
 * removable, oldest first. Temporary directories: removable once older than the (shorter) temporary age. At most `maxRemovals`
 * entries are planned; `moreWork` says whether the cap hid any.
 */
export function planRemoteDesktopWorkerPrune(input: RemoteDesktopWorkerPrunePlanInput): RemoteDesktopWorkerPrunePlan {
  const keepNewest = input.keepNewest ?? REMOTE_DESKTOP_WORKER_RETENTION.KEEP_NEWEST_RELEASES;
  const minReleaseAge = input.minReleaseAgeMs ?? REMOTE_DESKTOP_WORKER_RETENTION.MIN_RELEASE_AGE_MS;
  const minTemporaryAge = input.minTemporaryAgeMs ?? REMOTE_DESKTOP_WORKER_RETENTION.MIN_TEMPORARY_AGE_MS;
  const maxRemovals = input.maxRemovals ?? REMOTE_DESKTOP_WORKER_RETENTION.MAX_REMOVALS_PER_PASS;

  const byAgeOldestFirst = (left: RemoteDesktopWorkerStoreEntry, right: RemoteDesktopWorkerStoreEntry): number =>
    left.mtimeMs - right.mtimeMs || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  const releases = input.entries.filter((entry) => entry.kind === REMOTE_DESKTOP_WORKER_ENTRY_KIND.RELEASE);
  const newest = new Set(
    [...releases].sort((left, right) => byAgeOldestFirst(right, left)).slice(0, Math.max(0, keepNewest)).map((entry) => entry.name),
  );
  const skip = input.skipNames;

  const temporary = input.entries
    .filter((entry) => entry.kind === REMOTE_DESKTOP_WORKER_ENTRY_KIND.TEMPORARY
      && !skip?.has(entry.name)
      && input.nowMs - entry.mtimeMs >= minTemporaryAge)
    .sort(byAgeOldestFirst);
  const removableReleases = releases
    .filter((entry) => !input.protectedNames.has(entry.name)
      && !newest.has(entry.name)
      && !skip?.has(entry.name)
      && input.nowMs - entry.mtimeMs >= minReleaseAge)
    .sort(byAgeOldestFirst);

  const all = [...temporary, ...removableReleases];
  return { remove: all.slice(0, Math.max(0, maxRemovals)), moreWork: all.length > Math.max(0, maxRemovals) };
}
