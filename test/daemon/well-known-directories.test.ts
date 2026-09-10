import { afterEach, describe, expect, it } from 'vitest';
import {
  clearWellKnownDirectoryCache,
  expandWindowsEnvironmentPath,
  parseWindowsRegistryValue,
  parseWindowsRegistrySubkeys,
  parseXdgUserDirs,
  isWindowsServiceProfile,
  resolveWellKnownDirectory,
  wellKnownDirectoryCandidates,
  WELL_KNOWN_DIRECTORY,
} from '../../src/daemon/well-known-directories.js';

/**
 * These assert the cases where "just join it onto $HOME" is WRONG, because
 * that is the only reason this module exists. A test that only checks the
 * happy English-name path would pass against the naive implementation too.
 */

afterEach(() => { clearWellKnownDirectoryCache(); });

const exists = (...present: string[]) => async (candidate: string) => present.includes(candidate);

describe('Windows known folders', () => {
  it('follows a Downloads folder the user relocated off the system drive', async () => {
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DOWNLOADS, {
      platform: 'win32',
      homedir: () => 'C:\\Users\\k',
      env: { USERPROFILE: 'C:\\Users\\k' },
      // Explorer records the redirect; the English join would miss it entirely.
      readWindowsShellFolder: async (valueName) => (
        valueName === '{374DE290-123F-4565-9164-39C4925E467B}' ? 'D:\\Downloads' : null
      ),
      directoryExists: exists('D:\\Downloads', 'C:\\Users\\k'),
    });
    expect(resolved).toBe('D:\\Downloads');
  });

  it('looks Documents up under its legacy value name', async () => {
    // Documents is stored as `Personal`; querying "Documents" finds nothing.
    const seen: string[] = [];
    await wellKnownDirectoryCandidates(WELL_KNOWN_DIRECTORY.DOCUMENTS, {
      platform: 'win32',
      homedir: () => 'C:\\Users\\k',
      env: {},
      readWindowsShellFolder: async (valueName) => { seen.push(valueName); return null; },
    });
    expect(seen).toEqual(['Personal']);
  });

  it('expands %USERPROFILE% from User Shell Folders', async () => {
    // A OneDrive-redirected Desktop, which is the default on a lot of Windows
    // installs. The target deliberately differs from the plain `$HOME\Desktop`
    // join and that join deliberately does NOT exist, so this can only pass if
    // the variable was actually expanded -- otherwise the unexpanded candidate
    // is skipped and the fallback would answer instead.
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DESKTOP, {
      platform: 'win32',
      homedir: () => 'C:\\Users\\k',
      env: { USERPROFILE: 'C:\\Users\\k' },
      readWindowsShellFolder: async () => '%USERPROFILE%\\OneDrive\\Desktop',
      directoryExists: exists('C:\\Users\\k\\OneDrive\\Desktop', 'C:\\Users\\k'),
    });
    expect(resolved).toBe('C:\\Users\\k\\OneDrive\\Desktop');
  });

  /**
   * Verbatim `reg.exe` output, captured over SSH from a real Windows host
   * (172.16.253.201) rather than written from memory. The separator really is
   * four spaces, lines really are CRLF, and there really is a leading blank
   * line and a trailing one — none of which is documented anywhere, and all of
   * which the parser depends on.
   */
  const REAL_REG_OUTPUT = {
    desktop: '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders\r\n'
      + '    Desktop    REG_SZ    C:\\Users\\admin\\Desktop\r\n\r\n',
    documents: '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders\r\n'
      + '    Personal    REG_SZ    C:\\Users\\admin\\Documents\r\n\r\n',
    downloads: '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders\r\n'
      + '    {374DE290-123F-4565-9164-39C4925E467B}    REG_SZ    C:\\Users\\admin\\Downloads\r\n\r\n',
    desktopUnexpanded: '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n'
      + '    Desktop    REG_EXPAND_SZ    %USERPROFILE%\\Desktop\r\n\r\n',
  } as const;

  it('parses real reg.exe output for all three known folders', () => {
    expect(parseWindowsRegistryValue(REAL_REG_OUTPUT.desktop, 'Desktop'))
      .toBe('C:\\Users\\admin\\Desktop');
    expect(parseWindowsRegistryValue(REAL_REG_OUTPUT.documents, 'Personal'))
      .toBe('C:\\Users\\admin\\Documents');
    expect(parseWindowsRegistryValue(
      REAL_REG_OUTPUT.downloads,
      '{374DE290-123F-4565-9164-39C4925E467B}',
    )).toBe('C:\\Users\\admin\\Downloads');
  });

  it('parses the REG_EXPAND_SZ copy and expands it', () => {
    // `User Shell Folders` really does store the unexpanded form, confirmed on
    // the same host — so the expansion branch is reachable in production.
    const raw = parseWindowsRegistryValue(REAL_REG_OUTPUT.desktopUnexpanded, 'Desktop');
    expect(raw).toBe('%USERPROFILE%\\Desktop');
    expect(expandWindowsEnvironmentPath(raw!, { USERPROFILE: 'C:\\Users\\admin' }))
      .toBe('C:\\Users\\admin\\Desktop');
  });

  it('does not mistake the key header line for the value row', () => {
    // The header contains the literal text "Shell Folders"; a looser match
    // that scanned for the value name anywhere would trip over it.
    expect(parseWindowsRegistryValue(REAL_REG_OUTPUT.desktop, 'Shell')).toBeNull();
  });

  it('parses a reg query row whose data contains spaces', () => {
    const stdout = [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
      '    Personal    REG_SZ    D:\\My Documents\\Work',
      '',
    ].join('\r\n');
    expect(parseWindowsRegistryValue(stdout, 'Personal')).toBe('D:\\My Documents\\Work');
  });

  it('does not mistake a different value whose name merely starts the same', () => {
    const stdout = '    DesktopBackup    REG_SZ    D:\\Backup\r\n';
    expect(parseWindowsRegistryValue(stdout, 'Desktop')).toBeNull();
  });

  it('leaves an unknown variable untouched rather than emitting "undefined"', () => {
    expect(expandWindowsEnvironmentPath('%NOPE%\\x', {})).toBe('%NOPE%\\x');
  });

  it('expands case-insensitively, as the Windows environment is', () => {
    expect(expandWindowsEnvironmentPath('%userprofile%\\Desktop', { USERPROFILE: 'C:\\Users\\k' }))
      .toBe('C:\\Users\\k\\Desktop');
  });
});

describe('running as a Windows service', () => {
  /**
   * The reported bug. The controlled node installs itself as a scheduled task
   * under S-1-5-18, so `os.homedir()` is
   * `C:\Windows\System32\config\systemprofile` and `HKCU` is the systemprofile
   * hive -- every single shortcut landed there instead of on the real desktop.
   *
   * Fixtures below are verbatim from a real Windows host (172.16.253.201).
   */
  const SYSTEM_PROFILE = 'C:\\Windows\\System32\\config\\systemprofile';
  const USER_SID = 'S-1-5-21-3538260842-503494245-3046904370-1001';

  // Real `reg query HKU`: service SIDs, the user, and their _Classes companion.
  const REAL_HKU = [
    '',
    'HKEY_USERS\\S-1-5-19',
    'HKEY_USERS\\S-1-5-20',
    `HKEY_USERS\\${USER_SID}`,
    `HKEY_USERS\\${USER_SID}_Classes`,
    'HKEY_USERS\\S-1-5-18',
    '',
  ].join('\r\n');

  const serviceDeps = (over: Partial<Parameters<typeof resolveWellKnownDirectory>[1]> = {}) => ({
    platform: 'win32' as const,
    homedir: () => SYSTEM_PROFILE,
    env: { USERPROFILE: SYSTEM_PROFILE },
    listWindowsRegistrySubkeys: async () => parseWindowsRegistrySubkeys(REAL_HKU),
    readWindowsRegistryValue: async (key: string) => (
      key.endsWith(USER_SID) ? 'C:\\Users\\admin' : null
    ),
    ...over,
  });

  it('identifies the service profile it is running under', () => {
    expect(isWindowsServiceProfile(SYSTEM_PROFILE)).toBe(true);
    expect(isWindowsServiceProfile(`${SYSTEM_PROFILE}\\`)).toBe(true);
    expect(isWindowsServiceProfile('C:\\Windows\\ServiceProfiles\\LocalService')).toBe(true);
    expect(isWindowsServiceProfile('C:\\Windows\\ServiceProfiles\\NetworkService')).toBe(true);
    expect(isWindowsServiceProfile('C:\\Users\\admin'), 'a real person').toBe(false);
    // Must not be fooled by a user who merely has such a folder name.
    expect(isWindowsServiceProfile('C:\\Users\\systemprofile-backup')).toBe(false);
  });

  it('picks the one signed-in human out of a real HKU listing', () => {
    const names = parseWindowsRegistrySubkeys(REAL_HKU);
    expect(names).toContain(USER_SID);
    expect(names, 'the _Classes companion is listed too').toContain(`${USER_SID}_Classes`);
  });

  it('reads Downloads from the interactive user hive, not HKCU', async () => {
    let hiveAsked = '';
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DOWNLOADS, serviceDeps({
      readWindowsShellFolder: async (_valueName: string, hiveRoot: string) => {
        hiveAsked = hiveRoot;
        return hiveRoot === `HKU\\${USER_SID}` ? 'C:\\Users\\admin\\Downloads' : SYSTEM_PROFILE;
      },
      directoryExists: exists('C:\\Users\\admin\\Downloads', 'C:\\Users\\admin'),
    }));
    expect(hiveAsked, 'HKCU is the systemprofile hive here').toBe(`HKU\\${USER_SID}`);
    expect(resolved).toBe('C:\\Users\\admin\\Downloads');
  });

  it('expands %USERPROFILE% to the human, not to systemprofile', async () => {
    // `User Shell Folders` stores the unexpanded form. Expanding it against
    // OUR environment puts it straight back under the service profile -- the
    // exact shape of the reported bug.
    // The target is OneDrive-redirected so it differs from the plain
    // `$HOME\Desktop` join, and that join deliberately does not exist. Without
    // this the English-join fallback would rescue a wrong expansion and the
    // test would pass for the wrong reason.
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DESKTOP, serviceDeps({
      readWindowsShellFolder: async () => '%USERPROFILE%\\OneDrive\\Desktop',
      directoryExists: exists('C:\\Users\\admin\\OneDrive\\Desktop', 'C:\\Users\\admin'),
    }));
    expect(resolved).toBe('C:\\Users\\admin\\OneDrive\\Desktop');
    expect(resolved).not.toContain('systemprofile');
  });

  it('falls back to the human home, not the service profile, when nothing exists', async () => {
    // The whole point of the fix: even total failure must not put the user
    // back in C:\Windows\System32\config\systemprofile.
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DOCUMENTS, serviceDeps({
      readWindowsShellFolder: async () => null,
      directoryExists: async () => false,
    }));
    expect(resolved).toBe('C:\\Users\\admin');
    expect(resolved).not.toContain('systemprofile');
  });

  it('returns the human home for HOME, never the service profile', async () => {
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.HOME, serviceDeps());
    expect(resolved).toBe('C:\\Users\\admin');
  });

  it('refuses to guess when two people are signed in', async () => {
    const second = 'S-1-5-21-3538260842-503494245-3046904370-1002';
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.HOME, serviceDeps({
      listWindowsRegistrySubkeys: async () => [USER_SID, second],
    }));
    // Silently picking one would put ANOTHER user's Desktop behind the button.
    expect(resolved).toBe(SYSTEM_PROFILE);
  });

  it('falls back when ProfileList has no path for the SID', async () => {
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.HOME, serviceDeps({
      readWindowsRegistryValue: async () => null,
    }));
    expect(resolved).toBe(SYSTEM_PROFILE);
  });

  it('leaves an ordinary interactive Windows session alone', async () => {
    // A daemon a person started themselves must keep using HKCU.
    let hiveAsked = '';
    await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DESKTOP, {
      platform: 'win32',
      homedir: () => 'C:\\Users\\k',
      env: { USERPROFILE: 'C:\\Users\\k' },
      listWindowsRegistrySubkeys: async () => { throw new Error('must not probe HKU'); },
      readWindowsShellFolder: async (_v: string, hiveRoot: string) => {
        hiveAsked = hiveRoot; return 'C:\\Users\\k\\Desktop';
      },
      directoryExists: exists('C:\\Users\\k\\Desktop'),
    });
    expect(hiveAsked).toBe('HKCU');
  });
});

describe('Linux XDG user dirs', () => {
  it('uses the localized directory name from user-dirs.dirs', async () => {
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DOWNLOADS, {
      platform: 'linux',
      homedir: () => '/home/k',
      env: {},
      // A French desktop: the English join finds nothing at all.
      readFile: async (filePath) => {
        expect(filePath).toBe('/home/k/.config/user-dirs.dirs');
        return 'XDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n';
      },
      directoryExists: exists('/home/k/Téléchargements', '/home/k'),
    });
    expect(resolved).toBe('/home/k/Téléchargements');
  });

  it('honours XDG_CONFIG_HOME when locating the config', async () => {
    const seen: string[] = [];
    await wellKnownDirectoryCandidates(WELL_KNOWN_DIRECTORY.DESKTOP, {
      platform: 'linux',
      homedir: () => '/home/k',
      env: { XDG_CONFIG_HOME: '/custom/cfg' },
      readFile: async (filePath) => { seen.push(filePath); throw new Error('missing'); },
    });
    expect(seen).toEqual(['/custom/cfg/user-dirs.dirs']);
  });

  it('lets an explicit environment override beat the config file', async () => {
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DESKTOP, {
      platform: 'linux',
      homedir: () => '/home/k',
      env: { XDG_DESKTOP_DIR: '/mnt/desk' },
      readFile: async () => 'XDG_DESKTOP_DIR="$HOME/Desktop"\n',
      directoryExists: exists('/mnt/desk', '/home/k/Desktop', '/home/k'),
    });
    expect(resolved).toBe('/mnt/desk');
  });

  /**
   * Verbatim `~/.config/user-dirs.dirs`, captured from a real desktop Ubuntu
   * (172.16.253.215) rather than written from memory. Note `XDG_DOWNLOAD_DIR`
   * is SINGULAR while the folder is "Downloads" — guessing the plural silently
   * finds nothing — and that the file ships a comment line that is `#` plus a
   * trailing space.
   */
  const REAL_USER_DIRS = [
    '# This file is written by xdg-user-dirs-update',
    "# If you want to change or add directories, just edit the line you're",
    '# interested in. All local changes will be retained on the next run.',
    '# Format is XDG_xxx_DIR="$HOME/yyy", where yyy is a shell-escaped',
    '# homedir-relative path, or XDG_xxx_DIR="/yyy", where /yyy is an',
    '# absolute path. No other format is supported.',
    '# ',
    'XDG_DESKTOP_DIR="$HOME/Desktop"',
    'XDG_DOWNLOAD_DIR="$HOME/Downloads"',
    'XDG_TEMPLATES_DIR="$HOME/Templates"',
    'XDG_PUBLICSHARE_DIR="$HOME/Public"',
    'XDG_DOCUMENTS_DIR="$HOME/Documents"',
    'XDG_MUSIC_DIR="$HOME/Music"',
    'XDG_PICTURES_DIR="$HOME/Pictures"',
    'XDG_VIDEOS_DIR="$HOME/Videos"',
    '',
  ].join('\n');

  it('reads all three directories out of a real user-dirs.dirs', async () => {
    for (const [kind, expected] of [
      [WELL_KNOWN_DIRECTORY.DESKTOP, '/home/ai/Desktop'],
      [WELL_KNOWN_DIRECTORY.DOWNLOADS, '/home/ai/Downloads'],
      [WELL_KNOWN_DIRECTORY.DOCUMENTS, '/home/ai/Documents'],
    ] as const) {
      clearWellKnownDirectoryCache();
      const resolved = await resolveWellKnownDirectory(kind, {
        platform: 'linux',
        homedir: () => '/home/ai',
        env: {},
        readFile: async () => REAL_USER_DIRS,
        directoryExists: exists('/home/ai/Desktop', '/home/ai/Downloads', '/home/ai/Documents'),
      });
      expect(resolved, `${kind} from real user-dirs.dirs`).toBe(expected);
    }
  });

  it('does not confuse XDG_DOCUMENTS_DIR with the neighbouring XDG_ keys', () => {
    // Seven other XDG_*_DIR lines surround the three we want; a loose match
    // would happily return Templates or Videos.
    expect(parseXdgUserDirs(REAL_USER_DIRS, 'XDG_DOWNLOAD_DIR', '/home/ai')).toBe('/home/ai/Downloads');
    expect(parseXdgUserDirs(REAL_USER_DIRS, 'XDG_DOCUMENTS_DIR', '/home/ai')).toBe('/home/ai/Documents');
    // The plural spelling does not exist; it must not silently match.
    expect(parseXdgUserDirs(REAL_USER_DIRS, 'XDG_DOWNLOADS_DIR', '/home/ai')).toBeNull();
  });

  it('ignores comments and takes the last assignment', () => {
    const contents = [
      '# generated by xdg-user-dirs-update',
      '#XDG_DESKTOP_DIR="$HOME/Ignored"',
      'XDG_DESKTOP_DIR="$HOME/First"',
      'XDG_DESKTOP_DIR="$HOME/Second"',
    ].join('\n');
    expect(parseXdgUserDirs(contents, 'XDG_DESKTOP_DIR', '/home/k')).toBe('/home/k/Second');
  });

  it('accepts an absolute path that does not mention $HOME', () => {
    expect(parseXdgUserDirs('XDG_DOWNLOAD_DIR="/data/dl"\n', 'XDG_DOWNLOAD_DIR', '/home/k'))
      .toBe('/data/dl');
  });
});

describe('macOS', () => {
  it('uses the English on-disk name and never consults a config', async () => {
    let consulted = false;
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DOCUMENTS, {
      platform: 'darwin',
      homedir: () => '/Users/k',
      env: {},
      readFile: async () => { consulted = true; return ''; },
      directoryExists: exists('/Users/k/Documents'),
    });
    // Finder localizes the DISPLAY name only; the directory really is English.
    expect(resolved).toBe('/Users/k/Documents');
    expect(consulted, 'macOS has no user-dirs.dirs to read').toBe(false);
  });
});

describe('degradation', () => {
  it('falls back to the English join when the registry has nothing', async () => {
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DESKTOP, {
      platform: 'win32',
      homedir: () => 'C:\\Users\\k',
      env: {},
      readWindowsShellFolder: async () => null,
      directoryExists: exists('C:\\Users\\k\\Desktop'),
    });
    expect(resolved).toBe('C:\\Users\\k\\Desktop');
  });

  it('lands in the home directory when no candidate exists', async () => {
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DOWNLOADS, {
      platform: 'linux',
      homedir: () => '/home/k',
      env: {},
      readFile: async () => { throw new Error('missing'); },
      directoryExists: async () => false,
    });
    expect(resolved).toBe('/home/k');
  });

  it('never rejects when the lookup itself throws', async () => {
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DESKTOP, {
      platform: 'win32',
      homedir: () => 'C:\\Users\\k',
      env: {},
      readWindowsShellFolder: async () => { throw new Error('reg.exe missing'); },
      directoryExists: async () => false,
    });
    expect(resolved).toBe('C:\\Users\\k');
  });

  it('resolves home without touching the filesystem at all', async () => {
    const resolved = await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.HOME, {
      platform: 'linux',
      homedir: () => '/home/k',
      directoryExists: async () => { throw new Error('must not be consulted'); },
    });
    expect(resolved).toBe('/home/k');
  });
});

describe('caching', () => {
  it('memoizes per home directory, so a different user is not served the first answer', async () => {
    const deps = (home: string, target: string) => ({
      platform: 'linux' as const,
      homedir: () => home,
      env: {},
      readFile: async () => `XDG_DESKTOP_DIR="${target}"\n`,
      directoryExists: exists(target),
    });
    expect(await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DESKTOP, deps('/home/a', '/home/a/D')))
      .toBe('/home/a/D');
    expect(await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DESKTOP, deps('/home/b', '/home/b/D')))
      .toBe('/home/b/D');
  });

  it('does not repeat the lookup for the same home directory', async () => {
    let lookups = 0;
    const deps = {
      platform: 'linux' as const,
      homedir: () => '/home/k',
      env: {},
      readFile: async () => { lookups += 1; return 'XDG_DESKTOP_DIR="$HOME/Desktop"\n'; },
      directoryExists: exists('/home/k/Desktop'),
    };
    await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DESKTOP, deps);
    await resolveWellKnownDirectory(WELL_KNOWN_DIRECTORY.DESKTOP, deps);
    expect(lookups).toBe(1);
  });
});
