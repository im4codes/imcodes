import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  createDirectListingProvider,
  createDelegatedListingProvider,
  directoryListingErrorForAppAnswer,
  resolvePermittedRequestedPath,
  listDirectoryUnderPolicy,
  type DirectoryListingProvider,
} from '../../src/daemon/directory-listing-policy.js';
import { buildQueriedDirectoryListing } from '../../src/daemon/file-directory-query.js';
import { FILE_TRANSFER_DIRECTORY_MAX_ENTRIES, type FileDirectoryListQuery } from '../../shared/transport/file-transfer.js';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';

// The node can read a directory itself, or (macOS, when the node's own executable lacks Full Disk Access) ask the aiDesk.to app to.
// The decision about WHAT may be listed must be identical either way. Every case below runs through both providers over the same
// fake filesystem and must produce the same listing or the same refusal.

const HOME = '/Users/tester';
const policy = { platform: 'darwin' as const, homedir: () => HOME };

type Kind = 'd' | 'f' | 'o';
interface FakeFs {
  /** requested path -> real path (symlinks resolved); a missing key means the path does not exist */
  real: Record<string, string>;
  /** real path -> entries; a real path that is absent from here is a non-directory */
  dirs: Record<string, Array<{ name: string; kind: Kind }>>;
}

const dirEntry = (name: string, kind: Kind) => ({ name, kind });

/** What the node's own filesystem would do. */
function directProvider(fs: FakeFs): DirectoryListingProvider {
  return {
    async realpath(target) {
      const real = fs.real[target];
      if (real === undefined) throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
      return real;
    },
    async readEntries(real) {
      const entries = fs.dirs[real];
      if (!entries) throw new Error('not_directory');
      return entries.map((entry) => ({ name: entry.name, isDirectory: () => entry.kind === 'd', isFile: () => entry.kind === 'f' }));
    },
  };
}

/** What the app would answer (it resolves and lists as the user), then judged by the node. */
async function viaDelegate(fs: FakeFs, requested: string) {
  const absolute = await resolvePermittedRequestedPath(requested, policy);
  if (absolute === null) throw new Error(FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH);
  const real = fs.real[absolute];
  const entries = real === undefined ? undefined : fs.dirs[real];
  // the app answers an error for a missing/non-directory path; the node's own read throws for the same
  if (real === undefined) throw directoryListingErrorForAppAnswer('not_found');
  if (!entries) throw directoryListingErrorForAppAnswer('not_directory');
  return await listDirectoryUnderPolicy(requested, createDelegatedListingProvider({ realPath: real, entries }), policy);
}

async function outcome(run: () => Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

const fixture: FakeFs = {
  real: {
    [`${HOME}/Documents`]: `${HOME}/Documents`,
    [`${HOME}/Documents/proj`]: `${HOME}/Documents/proj`,
    [`${HOME}/Documents/report.txt`]: `${HOME}/Documents/report.txt`,
    [`${HOME}/.ssh`]: `${HOME}/.ssh`,
    [`${HOME}/.ssh/keys`]: `${HOME}/.ssh/keys`,
    [`${HOME}/.SSH`]: `${HOME}/.ssh`,
    [`${HOME}/.gnupg`]: `${HOME}/.gnupg`,
    [`${HOME}/.pki/nssdb`]: `${HOME}/.pki/nssdb`,
    [`${HOME}/Documents/link-to-ssh`]: `${HOME}/.ssh`,
    [`${HOME}/Documents/link-to-docs`]: `${HOME}/Documents`,
    [`${HOME}/Documents/proj/../../.ssh`]: `${HOME}/.ssh`,
    '/Users/other/Documents': '/Users/other/Documents',
    [`${HOME}/Big`]: `${HOME}/Big`,
    [`${HOME}/Mixed`]: `${HOME}/Mixed`,
  },
  dirs: {
    [`${HOME}/Documents`]: [dirEntry('proj', 'd'), dirEntry('report.txt', 'f'), dirEntry('.DS_Store', 'f'), dirEntry('link-to-ssh', 'o')],
    [`${HOME}/Documents/proj`]: [dirEntry('main.c', 'f')],
    [`${HOME}/.ssh`]: [dirEntry('id_ed25519', 'f')],
    [`${HOME}/.ssh/keys`]: [dirEntry('k', 'f')],
    [`${HOME}/.gnupg`]: [dirEntry('secring', 'f')],
    [`${HOME}/.pki/nssdb`]: [dirEntry('cert9.db', 'f')],
    '/Users/other/Documents': [dirEntry('theirs.txt', 'f')],
    [`${HOME}/Big`]: Array.from({ length: FILE_TRANSFER_DIRECTORY_MAX_ENTRIES + 40 }, (_, index) => dirEntry(`f${String(index).padStart(5, '0')}.txt`, 'f')),
    [`${HOME}/Mixed`]: [dirEntry('b-file', 'f'), dirEntry('a-file', 'f'), dirEntry('z-dir', 'd'), dirEntry('a-dir', 'd'), dirEntry('socket', 'o'), dirEntry('.hidden-dir', 'd')],
  },
};

describe('directory listing: direct reads and app-delegated reads share one decision', () => {
  const requests: Array<[string, string]> = [
    ['an ordinary directory', `${HOME}/Documents`],
    ['a nested directory', `${HOME}/Documents/proj`],
    ['a regular file', `${HOME}/Documents/report.txt`],
    ['a path that does not exist', `${HOME}/Documents/nope`],
    ['~/.ssh', `${HOME}/.ssh`],
    ['below ~/.ssh', `${HOME}/.ssh/keys`],
    ['~/.SSH (the filesystem is case-insensitive)', `${HOME}/.SSH`],
    ['~/.gnupg', `${HOME}/.gnupg`],
    ['below ~/.pki', `${HOME}/.pki/nssdb`],
    ['a symlink whose target is ~/.ssh', `${HOME}/Documents/link-to-ssh`],
    ['a symlink to an allowed directory', `${HOME}/Documents/link-to-docs`],
    ['a lexical detour into ~/.ssh', `${HOME}/Documents/proj/../../.ssh`],
    ['another user\'s directory outside the home', '/Users/other/Documents'],
    ['a directory above the entry cap', `${HOME}/Big`],
    ['mixed entry kinds (sorting, hidden, non file/dir entries)', `${HOME}/Mixed`],
    ['the tilde form', '~/Documents'],
    ['an empty path', ''],
  ];

  it.each(requests)('identical result for %s', async (_label, requested) => {
    const direct = await outcome(() => listDirectoryUnderPolicy(requested, directProvider(fixture), policy));
    const delegated = await outcome(() => viaDelegate(fixture, requested));
    expect(delegated).toEqual(direct);
  });

  it('actually produces listings and refusals (the comparison above is not vacuous)', async () => {
    const ok = await outcome(() => viaDelegate(fixture, `${HOME}/Documents`));
    expect(ok.ok).toBe(true);
    const denied = await outcome(() => viaDelegate(fixture, `${HOME}/.ssh`));
    expect(denied).toEqual({ ok: false, message: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH });
    const viaSymlink = await outcome(() => viaDelegate(fixture, `${HOME}/Documents/link-to-ssh`));
    expect(viaSymlink).toEqual({ ok: false, message: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH });
    const big = await outcome(() => viaDelegate(fixture, `${HOME}/Big`));
    expect(big.ok && (big.value as { entries: unknown[] }).entries.length).toBe(FILE_TRANSFER_DIRECTORY_MAX_ENTRIES);
  });

  it('judges the REAL path the app reports even when the requested path looks harmless', async () => {
    // the app resolved `~/Documents/innocent` to ~/.ssh; the lexical gate passes, the post-gate on the real path must not
    const provider = createDelegatedListingProvider({ realPath: `${HOME}/.ssh`, entries: [dirEntry('id_ed25519', 'f')] });
    expect(await resolvePermittedRequestedPath(`${HOME}/Documents/innocent`, policy)).toBe(`${HOME}/Documents/innocent`);
    await expect(listDirectoryUnderPolicy(`${HOME}/Documents/innocent`, provider, policy)).rejects.toThrow(FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH);
  });

  it('refuses an app answer for a real path other than the one it reported (it cannot smuggle a second directory)', async () => {
    const provider = createDelegatedListingProvider({ realPath: `${HOME}/Documents`, entries: [dirEntry('x', 'f')] });
    await expect(provider.readEntries(`${HOME}/Documents/other`)).rejects.toThrow(FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH);
  });
});

// CC15's node-side query (filter -> order -> truncate, with size/time metadata) must give the SAME answer whether the node read the
// directory itself or the aiDesk.to app did. Real files, real direct provider, and a delegated provider fed with what the app's helper
// would answer (integer milliseconds, sizes of regular files): every query below must produce identical entries, truncated/total/partial.
describe('query shaping is identical through the direct and the delegated provider', () => {
  const query = (key: FileDirectoryListQuery['sort']['key'], direction: 'asc' | 'desc' = 'asc', nameFilter?: string): FileDirectoryListQuery => ({
    sort: { key, direction, dirsFirst: true },
    ...(nameFilter === undefined ? {} : { nameFilter }),
  });
  let dir = '';

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(nodePath.join(tmpdir(), 'imcodes-query-parity-')));
    const base = Date.UTC(2026, 0, 1) / 1000;
    const total = FILE_TRANSFER_DIRECTORY_MAX_ENTRIES + 90;
    for (let start = 0; start < total; start += 200) {
      await Promise.all(Array.from({ length: Math.min(200, total - start) }, async (_, offset) => {
        const index = start + offset;
        const file = nodePath.join(dir, `item-${String(index).padStart(4, '0')}${index % 5 === 0 ? '.md' : '.txt'}`);
        await writeFile(file, 'x'.repeat((index * 7) % 113));
        await utimes(file, base + ((index * 31) % 997), base + ((index * 31) % 997));
      }));
    }
    // Whole-second times everywhere: the app reports integer milliseconds, so a sub-millisecond fraction (which only a freshly created
    // directory has) is the one thing the two reads could legitimately differ on.
    for (const [index, name] of ['alpha-dir', 'zeta-dir'].entries()) {
      await mkdir(nodePath.join(dir, name));
      await utimes(nodePath.join(dir, name), base + 2000 + index, base + 2000 + index);
    }
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  /** What the helper's `list_meta` would answer for this directory. */
  async function appAnswer(withMetadata: boolean) {
    const entries = [];
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      const stat = await lstat(nodePath.join(dir, dirent.name));
      entries.push({
        name: dirent.name,
        kind: (dirent.isDirectory() ? 'd' : dirent.isFile() ? 'f' : 'o') as 'd' | 'f' | 'o',
        ...(withMetadata ? { meta: { size: stat.isFile() ? stat.size : 0, mtimeMs: Math.floor(stat.mtimeMs), birthtimeMs: Math.floor(stat.birthtimeMs) } } : {}),
      });
    }
    return { realPath: dir, entries, hasMetadata: withMetadata };
  }

  const queries: Array<[string, FileDirectoryListQuery]> = [
    ['name ascending', query('name')],
    ['name descending', query('name', 'desc')],
    ['newest first', query('modified', 'desc')],
    ['oldest first', query('modified')],
    ['largest first', query('size', 'desc')],
    ['smallest first', query('size')],
    ['by kind', query('kind')],
    ['name filter that matches many (then truncated)', query('modified', 'desc', 'item')],
    ['name filter that matches few', query('size', 'desc', '.md 00')],
    ['name filter that matches nothing', query('name', 'asc', 'no-such-name')],
  ];

  it.each(queries)('identical for %s', async (_label, q) => {
    const direct = await listDirectoryUnderPolicy(dir, createDirectListingProvider(), {}, q);
    const delegated = await listDirectoryUnderPolicy(dir, createDelegatedListingProvider(await appAnswer(true)), {}, q);
    expect(delegated).toEqual(direct);
  });

  it('the comparison is not vacuous: ordering, truncation and metadata are really there', async () => {
    const delegated = await listDirectoryUnderPolicy(dir, createDelegatedListingProvider(await appAnswer(true)), {}, query('size', 'desc', 'item'));
    expect(delegated.entries).toHaveLength(FILE_TRANSFER_DIRECTORY_MAX_ENTRIES);
    expect(delegated.truncated).toBe(true);
    expect(delegated.total).toBe(FILE_TRANSFER_DIRECTORY_MAX_ENTRIES + 90);
    const sizes = delegated.entries.map((entry) => entry.size ?? -1);
    expect(sizes[0]).toBeGreaterThanOrEqual(sizes[sizes.length - 1]!);
    expect(delegated.entries.every((entry) => typeof entry.mtimeMs === 'number')).toBe(true);
  });

  // On Linux the shaping never reports a creation time, so a helper answer that left one out looked identical to the direct read there and
  // the difference only showed on macOS (where the direct read has a real creation time). This pins it on every platform: what the helper
  // answers per entry (size, modified, created) must reach the entries the browser gets, creation time included, on the platforms that show it.
  it.each(['darwin', 'win32'] as const)('the created time the app answers reaches the listing on %s, and an unknown one is left out (not shown as 1970)', async (platform) => {
    const provider = createDelegatedListingProvider({
      realPath: '/Users/tester/Documents',
      hasMetadata: true,
      entries: [
        { name: 'known.txt', kind: 'f', meta: { size: 5, mtimeMs: 2_000, birthtimeMs: 1_000 } },
        { name: 'unknown.txt', kind: 'f', meta: { size: 6, mtimeMs: 3_000 } },
      ],
    });
    const dirents = await provider.readEntries('/Users/tester/Documents');
    const queried = await buildQueriedDirectoryListing({
      realPath: '/Users/tester/Documents', dirents, query: query('created'), platform, ...provider.queryInputs!(),
    });
    const byName = new Map(queried.entries.map((entry) => [entry.name, entry]));
    expect(byName.get('known.txt')).toMatchObject({ size: 5, mtimeMs: 2_000, birthtimeMs: 1_000 });
    expect(byName.get('unknown.txt')?.birthtimeMs).toBeUndefined();
    expect(byName.get('unknown.txt')).toMatchObject({ size: 6, mtimeMs: 3_000 });
  });

  it('an app without metadata (older app): a size/time ordering is reported partial and never passed off as ordered; a name ordering is exact', async () => {
    const noMeta = createDelegatedListingProvider(await appAnswer(false));
    const bySize = await listDirectoryUnderPolicy(dir, noMeta, {}, query('size', 'desc'));
    expect(bySize.partial).toBe(true);
    expect(bySize.entries.every((entry) => entry.size === undefined && entry.mtimeMs === undefined)).toBe(true);
    const byTime = await listDirectoryUnderPolicy(dir, noMeta, {}, query('modified', 'desc'));
    expect(byTime.partial).toBe(true);
    // a name ordering needs no metadata: same names in the same order as the direct read, nothing flagged
    const byName = await listDirectoryUnderPolicy(dir, noMeta, {}, query('name'));
    const direct = await listDirectoryUnderPolicy(dir, createDirectListingProvider(), {}, query('name'));
    expect(byName.partial).toBeUndefined();
    expect(byName.entries.map((entry) => entry.name)).toEqual(direct.entries.map((entry) => entry.name));
    expect(byName.truncated).toBe(direct.truncated);
    expect(byName.total).toBe(direct.total);
  });

  it('without a query nothing changes: the plain listing, no truncated/total/partial', async () => {
    const delegated = await listDirectoryUnderPolicy(dir, createDelegatedListingProvider(await appAnswer(true)));
    const direct = await listDirectoryUnderPolicy(dir, createDirectListingProvider());
    expect(delegated).toEqual(direct);
    expect(Object.keys(delegated).sort()).toEqual(['entries', 'realPath']);
  });
});
