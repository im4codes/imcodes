import { describe, expect, it } from 'vitest';
import {
  createDelegatedListingProvider,
  directoryListingErrorForAppAnswer,
  resolvePermittedRequestedPath,
  listDirectoryUnderPolicy,
  type DirectoryListingProvider,
} from '../../src/daemon/directory-listing-policy.js';
import { FILE_TRANSFER_DIRECTORY_MAX_ENTRIES } from '../../shared/transport/file-transfer.js';
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
