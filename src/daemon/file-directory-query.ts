import type { Dirent } from 'node:fs';
import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import {
  FILE_BROWSER_SORT_KEYS,
  fileBrowserNameMatches,
  parseFileBrowserFilter,
  sortFileBrowserEntriesAsync,
} from '../../shared/file-browser-sort.js';
import {
  FILE_TRANSFER_DIRECTORY_MAX_ENTRIES,
  FILE_TRANSFER_DIRECTORY_QUERY_BUDGET_MS,
  FILE_TRANSFER_DIRECTORY_QUERY_MAX_STAT_ENTRIES,
  type FileDirectoryEntry,
  type FileDirectoryListDone,
  type FileDirectoryListQuery,
} from '../../shared/transport/file-transfer.js';
import { mapWithConcurrency } from '../util/concurrency.js';

/** A turn of the event loop, so a big directory's ordering never holds up the node's other traffic. */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Stat calls in flight at once: enough to overlap disk waits, few enough not to starve the node's other work. */
const QUERY_STAT_CONCURRENCY = 32;

export interface DirectoryQueryResult {
  entries: FileDirectoryEntry[];
  truncated?: true;
  total?: number;
  partial?: true;
}

export interface DirectoryQueryInput {
  realPath: string;
  /** Directories and regular files only; the caller has already dropped everything else. */
  dirents: readonly Pick<Dirent, 'name' | 'isDirectory'>[];
  query: FileDirectoryListQuery;
  /** Test seams. */
  statEntry?: (fullPath: string) => Promise<{ size: number; mtimeMs: number; birthtimeMs: number } | null>;
  platform?: NodeJS.Platform;
  maxStatEntries?: number;
  budgetMs?: number;
  now?: () => number;
}

async function defaultStat(fullPath: string): Promise<{ size: number; mtimeMs: number; birthtimeMs: number } | null> {
  try {
    const stats = await lstat(fullPath);
    return { size: stats.size, mtimeMs: stats.mtimeMs, birthtimeMs: stats.birthtimeMs };
  } catch {
    // Vanished, or not readable: the entry stays in the listing without metadata.
    return null;
  }
}

/**
 * Whether this OS reports a real creation time. Linux does not through Node:
 * the value is 0 or the ctime depending on the kernel and filesystem, and a
 * ctime must never be passed off as a creation time.
 */
function reportsBirthtime(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/**
 * A directory listing as the browser asked for it: names filtered, ordered by
 * the requested key, THEN cut to FILE_TRANSFER_DIRECTORY_MAX_ENTRIES. Cutting
 * before ordering would hand back the first 512 names and call them "the newest".
 *
 * Name filtering and ordering use the same shared functions as the browser, so
 * a listing that fits is ordered identically on both sides.
 *
 * Cost: a name sort stats only the entries it returns; a size/time sort has to
 * stat every match, so that pass is bounded in entries and wall-clock time.
 * Whatever it could not stat sorts last and the answer says `partial`.
 */
export async function buildQueriedDirectoryListing(input: DirectoryQueryInput): Promise<DirectoryQueryResult> {
  const statEntry = input.statEntry ?? defaultStat;
  const platform = input.platform ?? process.platform;
  const maxStat = input.maxStatEntries ?? FILE_TRANSFER_DIRECTORY_QUERY_MAX_STAT_ENTRIES;
  const budgetMs = input.budgetMs ?? FILE_TRANSFER_DIRECTORY_QUERY_BUDGET_MS;
  const now = input.now ?? Date.now;
  const { sort } = input.query;

  const terms = parseFileBrowserFilter(input.query.nameFilter ?? '');
  const matched: FileDirectoryEntry[] = [];
  for (const dirent of input.dirents) {
    if (!fileBrowserNameMatches(dirent.name, terms)) continue;
    matched.push({
      name: dirent.name,
      path: path.join(input.realPath, dirent.name),
      isDir: dirent.isDirectory(),
      hidden: dirent.name.startsWith('.'),
    });
  }

  const deadline = now() + budgetMs;
  let partial = false;
  const withMetadata = async (entries: FileDirectoryEntry[]): Promise<void> => {
    await mapWithConcurrency(entries, QUERY_STAT_CONCURRENCY, async (entry) => {
      if (now() > deadline) { partial = true; return; }
      const stats = await statEntry(entry.path);
      if (!stats) return;
      if (!entry.isDir && Number.isFinite(stats.size) && stats.size >= 0) entry.size = stats.size;
      if (Number.isFinite(stats.mtimeMs) && stats.mtimeMs >= 0) entry.mtimeMs = stats.mtimeMs;
      if (reportsBirthtime(platform) && Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0) entry.birthtimeMs = stats.birthtimeMs;
    });
  };

  // Name and kind come from the name alone, so only the entries that are
  // returned need their metadata. Time and size decide the order, so every
  // match has to be stat'd before any can be dropped.
  const orderedByName = sort.key === FILE_BROWSER_SORT_KEYS.NAME || sort.key === FILE_BROWSER_SORT_KEYS.KIND;
  let ordered: FileDirectoryEntry[];
  if (orderedByName) {
    ordered = (await sortFileBrowserEntriesAsync(matched, sort, yieldToEventLoop)).slice(0, FILE_TRANSFER_DIRECTORY_MAX_ENTRIES);
    await withMetadata(ordered);
  } else {
    const candidates = matched.length > maxStat ? matched.slice(0, maxStat) : matched;
    if (candidates.length < matched.length) partial = true;
    await withMetadata(candidates);
    ordered = (await sortFileBrowserEntriesAsync(candidates, sort, yieldToEventLoop)).slice(0, FILE_TRANSFER_DIRECTORY_MAX_ENTRIES);
  }

  const truncated = matched.length > ordered.length;
  return {
    entries: ordered,
    ...(truncated ? { truncated: true as const, total: matched.length } : {}),
    // Only worth saying when it can change what the user sees: a complete
    // listing that merely lacks a few stats is not "partial" in any useful way.
    ...(partial && !orderedByName ? { partial: true as const } : {}),
  };
}

export type { FileDirectoryListDone };
