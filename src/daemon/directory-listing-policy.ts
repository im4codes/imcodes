/**
 * One decision for "may this directory be listed, and what does the listing look like", used by both ways the node can read a
 * directory: with its own filesystem calls (the direct provider) and through the aiDesk.to app on macOS when the node itself is denied
 * (the delegated provider, see shared/macos-fs-delegate.ts).
 *
 * The providers only supply the syscalls (`realpath`, read the entries); the path policy (`resolveCanonical`: the denylist of sensitive
 * home directories, applied to the REAL path), the "a directory, not a symlink" rule, the file/directory filter, the ordering and the
 * entry cap are written once, here. Delegating therefore can neither read more than the node would nor less restrictively.
 */
import { lstat, readdir, realpath as fsRealpath } from 'node:fs/promises';
import * as path from 'node:path';
import {
  FILE_TRANSFER_DIRECTORY_MAX_ENTRIES,
  type FileDirectoryEntry,
  type FileDirectoryListQuery,
} from '../../shared/transport/file-transfer.js';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';
import { buildQueriedDirectoryListing, type DirectoryQueryInput } from './file-directory-query.js';
import { resolveCanonical, type FilePreviewPathPolicyOptions } from './file-preview-path-policy.js';
import { isPermissionDeniedError } from './well-known-directories.js';

/** The two facts the listing needs about an entry (what `fs.Dirent` offers, and what the app's answer can supply). */
export interface DirectoryEntryLike {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface DirectoryListingProvider {
  /** Resolve symlinks. Rejects when the path cannot be resolved. */
  realpath(requestedPath: string): Promise<string>;
  /** The entries of an already-resolved real path; rejects `not_directory` for a symlink or non-directory. */
  readEntries(realPath: string): Promise<readonly DirectoryEntryLike[]>;
  /** Set when a filesystem call of this provider was refused for permission (EPERM/EACCES), so a caller can tell that from "not allowed". */
  permissionError?: unknown;
  /** Extra inputs for the query shaping (where entry metadata comes from); absent = the node stats the entries itself. */
  queryInputs?(): Partial<Pick<DirectoryQueryInput, 'statEntry' | 'metadataUnavailable'>>;
}

export interface DirectoryListing {
  realPath: string;
  entries: FileDirectoryEntry[];
  /** Only for a request WITH a query (the browser filtered/ordered on the node): the answer was cut, there were `total` matches. */
  truncated?: true;
  total?: number;
  /** The ordering could not use every entry's metadata (time/size budget, too many entries, or no metadata at all). */
  partial?: true;
}

export const DIRECTORY_LISTING_NOT_DIRECTORY = 'not_directory';

/**
 * A `realpath` the node was refused for permission. To a caller that cannot do anything about it, this is exactly what it always was:
 * a path that cannot be resolved, i.e. `forbidden_path` (that is the message). It also keeps the original `code` (EPERM/EACCES), so a
 * caller that CAN do something about it (the macOS app delegate) recognises it as a permission refusal.
 */
export class DirectoryListingPermissionDenied extends Error {
  readonly code: string | undefined;
  constructor(cause: unknown) {
    super(FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH);
    this.name = 'DirectoryListingPermissionDenied';
    this.code = (cause as NodeJS.ErrnoException | undefined)?.code;
  }
}

/**
 * The error the node's OWN read produces for what the app reported about a path: a path that cannot be resolved is judged "not allowed"
 * (that is what `resolveCanonical` makes of a failing `realpath`), a resolved non-directory is `not_directory`. One mapping, so the two
 * ways of reading cannot disagree about the wording the browser sees.
 */
export function directoryListingErrorForAppAnswer(reason: 'not_found' | 'not_directory'): Error {
  return new Error(reason === 'not_directory' ? DIRECTORY_LISTING_NOT_DIRECTORY : FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH);
}

/**
 * The node's own reads. `surfacePermissionErrors` (macOS only, where the app can retry) makes a `realpath` refused for permission reach
 * the caller as that error; everywhere else it stays what it always was, an unresolvable path judged as not allowed.
 */
export function createDirectListingProvider(options: { surfacePermissionErrors?: boolean } = {}): DirectoryListingProvider {
  const provider: DirectoryListingProvider = {
    async realpath(requestedPath) {
      try {
        return await fsRealpath(requestedPath);
      } catch (error) {
        if (options.surfacePermissionErrors && isPermissionDeniedError(error)) provider.permissionError = error;
        throw error;
      }
    },
    async readEntries(realPath) {
      const directoryStat = await lstat(realPath);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new Error(DIRECTORY_LISTING_NOT_DIRECTORY);
      }
      return await readdir(realPath, { withFileTypes: true });
    },
  };
  return provider;
}

/** A listing the aiDesk.to app already produced, offered to the same decision as if it were a filesystem. */
export function createDelegatedListingProvider(answer: {
  realPath: string;
  entries: ReadonlyArray<{ name: string; kind: 'd' | 'f' | 'o' }>;
}): DirectoryListingProvider {
  return {
    async realpath() {
      return answer.realPath;
    },
    async readEntries(realPath) {
      if (realPath !== answer.realPath) throw new Error(FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH);
      return answer.entries.map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.kind === 'd',
        isFile: () => entry.kind === 'f',
      }));
    },
  };
}

/**
 * The lexical gate: the path policy applied to the requested path as written (`~` expanded, made absolute), before anything asks the app
 * to read it. Returns that absolute path when the policy allows it, `null` otherwise. (The app reports the real path afterwards and
 * `listDirectoryUnderPolicy` judges that too.)
 */
export async function resolvePermittedRequestedPath(
  requestedPath: string,
  policy: FilePreviewPathPolicyOptions = {},
): Promise<string | null> {
  const lexical = await resolveCanonical(requestedPath, 'strict', { ...policy, realpath: async (target) => target });
  return lexical ? lexical.resolvedPath : null;
}

export async function listDirectoryUnderPolicy(
  requestedPath: string,
  provider: DirectoryListingProvider,
  policy: FilePreviewPathPolicyOptions = {},
  query?: FileDirectoryListQuery,
): Promise<DirectoryListing> {
  const canonical = await resolveCanonical(requestedPath, 'strict', { ...policy, realpath: (target) => provider.realpath(target) });
  if (!canonical) {
    // A refusal for permission is not a refusal by policy: the caller may have another way to read it.
    if (provider.permissionError) throw new DirectoryListingPermissionDenied(provider.permissionError);
    throw new Error(FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH);
  }
  const dirents = (await provider.readEntries(canonical.realPath)).filter((entry) => entry.isDirectory() || entry.isFile());
  // A request WITH a query is from a peer that advertised the capability and gets the filtered/ordered/metadata form (one function,
  // shared with the node's own reads, shapes it); one without gets the plain listing exactly as before.
  if (query) {
    const queried = await buildQueriedDirectoryListing({
      realPath: canonical.realPath,
      dirents,
      query,
      ...(provider.queryInputs ? provider.queryInputs() : {}),
    });
    return {
      realPath: canonical.realPath,
      entries: queried.entries,
      ...(queried.truncated ? { truncated: true as const, total: queried.total as number } : {}),
      ...(queried.partial ? { partial: true as const } : {}),
    };
  }
  const entries = dirents
    .map((entry): FileDirectoryEntry => ({
      name: entry.name,
      path: path.join(canonical.realPath, entry.name),
      isDir: entry.isDirectory(),
      hidden: entry.name.startsWith('.'),
    }))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name === b.name ? 0 : a.name < b.name ? -1 : 1;
    })
    .slice(0, FILE_TRANSFER_DIRECTORY_MAX_ENTRIES);
  return { realPath: canonical.realPath, entries };
}
