/**
 * Where "Desktop", "Downloads" and "Documents" actually are on this machine.
 *
 * Joining them onto the home directory is wrong often enough to matter, and it
 * is wrong DIFFERENTLY on each platform:
 *
 * - Windows lets the user relocate any known folder (Downloads onto D:\ is a
 *   common way to save SSD space). The on-disk name stays English, so the
 *   join looks plausible and silently points at a directory that may not even
 *   exist. Explorer records the truth under `Shell Folders`.
 * - Linux has no fixed names at all. freedesktop's `user-dirs.dirs` is
 *   authoritative and is routinely LOCALIZED -- `XDG_DOWNLOAD_DIR` is
 *   "$HOME/Téléchargements" on a French desktop -- so the English join finds
 *   nothing.
 * - macOS is the easy one: the on-disk names are always English and only the
 *   Finder display is localized, so the join is correct.
 *
 * Every lookup still falls back to the English join, and finally to the home
 * directory, so a machine without a registry hive or an XDG config is degraded
 * rather than broken.
 *
 * SECURITY: this module only turns a NAME into a path. It performs no access
 * check and grants no reach. Callers must keep feeding the result through the
 * same `resolveCanonical` / `isFilePreviewPathAllowed` gate as any other path;
 * see `handleFileDirectoryList`.
 */
import { execFile } from 'node:child_process';
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const WELL_KNOWN_DIRECTORY = {
  HOME: 'home',
  DESKTOP: 'desktop',
  DOWNLOADS: 'downloads',
  DOCUMENTS: 'documents',
} as const;

export type WellKnownDirectoryKind =
  (typeof WELL_KNOWN_DIRECTORY)[keyof typeof WELL_KNOWN_DIRECTORY];

/** The English on-disk names, used as the last resort on every platform. */
const ENGLISH_DIRECTORY_NAMES: Record<Exclude<WellKnownDirectoryKind, 'home'>, string> = {
  [WELL_KNOWN_DIRECTORY.DESKTOP]: 'Desktop',
  [WELL_KNOWN_DIRECTORY.DOWNLOADS]: 'Downloads',
  [WELL_KNOWN_DIRECTORY.DOCUMENTS]: 'Documents',
};

/**
 * Registry value names under `Explorer\Shell Folders`.
 *
 * Documents is stored as `Personal` for backwards compatibility with Windows
 * 95, and Downloads only ever had a GUID name -- it postdates the friendly-name
 * scheme. Neither is guessable, which is why they are spelled out here.
 */
const WINDOWS_SHELL_FOLDER_VALUES: Record<Exclude<WellKnownDirectoryKind, 'home'>, string> = {
  [WELL_KNOWN_DIRECTORY.DESKTOP]: 'Desktop',
  [WELL_KNOWN_DIRECTORY.DOWNLOADS]: '{374DE290-123F-4565-9164-39C4925E467B}',
  [WELL_KNOWN_DIRECTORY.DOCUMENTS]: 'Personal',
};

/**
 * `Shell Folders` holds already-expanded paths and is what Explorer reads;
 * `User Shell Folders` is the authoring copy and holds `%USERPROFILE%\...`.
 * Prefer the expanded one, fall back to expanding the other.
 *
 * The hive is a PARAMETER because `HKCU` is merely whoever this process
 * happens to be. Installed as a scheduled task under `S-1-5-18` (installer.ts
 * writes that UserId), the process is LocalSystem, whose `HKCU` is the
 * systemprofile hive -- which is why every folder resolved to
 * `C:\Windows\System32\config\systemprofile\...` instead of the real desktop.
 */
function windowsShellFolderKeys(hiveRoot: string): readonly string[] {
  const base = `${hiveRoot}\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer`;
  return [`${base}\\Shell Folders`, `${base}\\User Shell Folders`];
}

const WINDOWS_PROFILE_LIST_KEY =
  'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList';

/** This process's own profile when it is a service account, not a person. */
const WINDOWS_SERVICE_PROFILE_RE =
  /(?:config[\\/]systemprofile|ServiceProfiles[\\/](?:LocalService|NetworkService))[\\/]?$/i;

/**
 * Real human accounts only. `S-1-5-18/19/20` (System, LocalService,
 * NetworkService) and `S-1-5-80-*` (service SIDs) deliberately do not match.
 */
const WINDOWS_USER_SID_RE = /^S-1-5-21-\d+-\d+-\d+-\d+$/;

/**
 * Whether this process's profile belongs to a service account, in which case
 * its folders are not the ones any human is looking at.
 */
export function isWindowsServiceProfile(home: string): boolean {
  return WINDOWS_SERVICE_PROFILE_RE.test(home.replace(/[\\/]+$/, ''));
}

const XDG_CONFIG_KEYS: Record<Exclude<WellKnownDirectoryKind, 'home'>, string> = {
  [WELL_KNOWN_DIRECTORY.DESKTOP]: 'XDG_DESKTOP_DIR',
  [WELL_KNOWN_DIRECTORY.DOWNLOADS]: 'XDG_DOWNLOAD_DIR',
  [WELL_KNOWN_DIRECTORY.DOCUMENTS]: 'XDG_DOCUMENTS_DIR',
};

/** `reg.exe` is on the critical path of a UI click; do not let it hang one. */
const WINDOWS_REGISTRY_TIMEOUT_MS = 3_000;

export interface WellKnownDirectoryDeps {
  platform?: NodeJS.Platform;
  homedir?: () => string;
  env?: NodeJS.ProcessEnv;
  readFile?: (filePath: string) => Promise<string>;
  /** Resolves one `Shell Folders` value under `hiveRoot`, or null if absent. */
  readWindowsShellFolder?: (valueName: string, hiveRoot: string) => Promise<string | null>;
  /** Leaf subkey names under a registry key. */
  listWindowsRegistrySubkeys?: (key: string) => Promise<string[]>;
  /** One registry value, or null. */
  readWindowsRegistryValue?: (key: string, valueName: string) => Promise<string | null>;
  /** True when the path exists and is a directory. */
  directoryExists?: (candidate: string) => Promise<boolean>;
}

async function defaultDirectoryExists(candidate: string): Promise<boolean> {
  try {
    return (await fsStat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * One registry value, or null.
 *
 * Keys and value names come from the closed sets above, or from a SID this
 * module itself matched against WINDOWS_USER_SID_RE -- never from caller
 * input -- and execFile takes an argv array, so there is no shell to inject
 * into.
 */
async function readWindowsRegistryValue(key: string, valueName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', key, '/v', valueName],
      { timeout: WINDOWS_REGISTRY_TIMEOUT_MS, windowsHide: true },
    );
    return parseWindowsRegistryValue(stdout, valueName);
  } catch {
    return null;
  }
}

/** Leaf names of the subkeys `reg query <key>` lists. */
export function parseWindowsRegistrySubkeys(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('HKEY_')) continue;
    const leaf = trimmed.slice(trimmed.lastIndexOf('\\') + 1);
    if (leaf) names.push(leaf);
  }
  return names;
}

async function defaultListWindowsRegistrySubkeys(key: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', key],
      { timeout: WINDOWS_REGISTRY_TIMEOUT_MS, windowsHide: true },
    );
    return parseWindowsRegistrySubkeys(stdout);
  } catch {
    return [];
  }
}

async function defaultReadWindowsShellFolder(
  valueName: string,
  hiveRoot: string,
): Promise<string | null> {
  for (const key of windowsShellFolderKeys(hiveRoot)) {
    const parsed = await readWindowsRegistryValue(key, valueName);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * The signed-in human whose folders we should be resolving, when we are a
 * service and therefore are not that human.
 *
 * A logged-on user has their hive mounted under `HKEY_USERS\<SID>`, and
 * `ProfileList` maps that SID to the profile directory. Only one qualifying
 * hive is accepted: with two people signed in there is no single right answer,
 * and silently picking one would put another user's Desktop behind a button
 * labelled "Desktop". `windows-user-session.ts` refuses ambiguity the same way
 * ("ambiguous active user sessions").
 */
export async function resolveWindowsInteractiveUser(
  deps: WellKnownDirectoryDeps = {},
): Promise<{ sid: string; home: string } | null> {
  const listSubkeys = deps.listWindowsRegistrySubkeys ?? defaultListWindowsRegistrySubkeys;
  const readValue = deps.readWindowsRegistryValue ?? readWindowsRegistryValue;

  const candidates = (await listSubkeys('HKU')).filter((name) => WINDOWS_USER_SID_RE.test(name));
  // `_Classes` companions are already excluded by the SID pattern.
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) return null;

  const sid = unique[0]!;
  const profile = await readValue(`${WINDOWS_PROFILE_LIST_KEY}\\${sid}`, 'ProfileImagePath');
  if (!profile) return null;
  return { sid, home: expandWindowsEnvironmentPath(profile, deps.env ?? process.env) };
}

/**
 * Pull the data column out of `reg query` output.
 *
 * A row looks like `    Downloads    REG_EXPAND_SZ    %USERPROFILE%\Downloads`,
 * separated by runs of whitespace. The data itself may contain spaces, so the
 * split is bounded to three fields rather than greedy.
 */
export function parseWindowsRegistryValue(stdout: string, valueName: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(valueName)) continue;
    const match = /^(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(trimmed);
    if (!match || match[1] !== valueName) continue;
    const data = match[3].trim();
    if (data) return data;
  }
  return null;
}

/** Expand `%USERPROFILE%`-style references using the supplied environment. */
export function expandWindowsEnvironmentPath(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const replacement = key ? env[key] : undefined;
    return replacement ?? whole;
  });
}

/**
 * Read one directory out of freedesktop's `user-dirs.dirs`.
 *
 * The file is shell-syntax, e.g. `XDG_DOWNLOAD_DIR="$HOME/Téléchargements"`.
 * Only the `$HOME`/`${HOME}` prefix form is expanded, which is the only form
 * `xdg-user-dirs-update` ever writes.
 */
export function parseXdgUserDirs(
  contents: string,
  configKey: string,
  homeDir: string,
): string | null {
  let found: string | null = null;
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = new RegExp(`^${configKey}\\s*=\\s*"(.*)"\\s*$`).exec(trimmed);
    if (!match) continue;
    const raw = match[1];
    if (!raw) continue;
    // Later assignments win, matching shell sourcing semantics.
    found = raw.startsWith('$HOME')
      ? path.posix.join(homeDir, raw.slice('$HOME'.length))
      : raw.startsWith('${HOME}')
        ? path.posix.join(homeDir, raw.slice('${HOME}'.length))
        : raw;
  }
  return found;
}

async function resolveLinuxDirectory(
  kind: Exclude<WellKnownDirectoryKind, 'home'>,
  homeDir: string,
  env: NodeJS.ProcessEnv,
  readFile: (filePath: string) => Promise<string>,
): Promise<string | null> {
  const configKey = XDG_CONFIG_KEYS[kind];

  // An explicit environment override beats the config file, matching how
  // xdg-user-dir itself resolves.
  const fromEnv = env[configKey];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const configHome = env.XDG_CONFIG_HOME?.trim() || path.posix.join(homeDir, '.config');
  try {
    const contents = await readFile(path.posix.join(configHome, 'user-dirs.dirs'));
    return parseXdgUserDirs(contents, configKey, homeDir);
  } catch {
    return null;
  }
}

/**
 * Candidate paths for one kind, most authoritative first.
 *
 * Exported so a test can assert the ORDER without spawning `reg.exe` or
 * touching a real home directory.
 */
/** Whose folders we are resolving, which is not always who we are. */
interface TargetUser {
  home: string;
  /** Registry root holding this user's per-user settings. */
  windowsHive: string;
  /** Environment to expand `%VAR%` against; `%USERPROFILE%` must be theirs. */
  env: NodeJS.ProcessEnv;
}

/**
 * Resolve the account whose Desktop/Downloads/Documents the caller means.
 *
 * Normally that is this process. But the controlled node installs itself as a
 * scheduled task running as LocalSystem, and a LaunchDaemon/systemd unit runs
 * as root -- none of which is the person at the keyboard. On Windows we can
 * recover the real account; elsewhere we currently cannot, and say so rather
 * than pretending.
 */
async function resolveTargetUser(
  platform: NodeJS.Platform,
  ownHome: string,
  env: NodeJS.ProcessEnv,
  deps: WellKnownDirectoryDeps,
): Promise<TargetUser> {
  const own: TargetUser = { home: ownHome, windowsHive: 'HKCU', env };
  if (platform !== 'win32' || !isWindowsServiceProfile(ownHome)) return own;

  const interactive = await resolveWindowsInteractiveUser(deps);
  if (!interactive) return own;
  return {
    home: interactive.home,
    windowsHive: `HKU\\${interactive.sid}`,
    // `User Shell Folders` stores `%USERPROFILE%\Desktop`; expanding that
    // against OUR environment would put it straight back under systemprofile.
    env: { ...env, USERPROFILE: interactive.home },
  };
}

export async function wellKnownDirectoryCandidates(
  kind: WellKnownDirectoryKind,
  deps: WellKnownDirectoryDeps = {},
): Promise<string[]> {
  const platform = deps.platform ?? process.platform;
  const ownHome = deps.homedir?.() ?? osHomedir();
  const env = deps.env ?? process.env;
  const target = await resolveTargetUser(platform, ownHome, env, deps);
  if (kind === WELL_KNOWN_DIRECTORY.HOME) return [target.home];

  const readFile = deps.readFile ?? ((filePath: string) => fsReadFile(filePath, 'utf8'));
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const candidates: string[] = [];

  if (platform === 'win32') {
    const readShellFolder = deps.readWindowsShellFolder ?? defaultReadWindowsShellFolder;
    const recorded = await readShellFolder(WINDOWS_SHELL_FOLDER_VALUES[kind], target.windowsHive);
    if (recorded) candidates.push(expandWindowsEnvironmentPath(recorded, target.env));
  } else if (platform !== 'darwin') {
    const configured = await resolveLinuxDirectory(kind, target.home, target.env, readFile);
    if (configured) candidates.push(configured);
  }

  // macOS always lands here, and it is the correct answer there: the on-disk
  // names are English and only the Finder display is localized.
  candidates.push(platformPath.join(target.home, ENGLISH_DIRECTORY_NAMES[kind]));
  candidates.push(target.home);
  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
}

const resolutionCache = new Map<string, Promise<string>>();

/** Drop memoized lookups. Tests use this; production has no reason to. */
export function clearWellKnownDirectoryCache(): void {
  resolutionCache.clear();
}

/**
 * The first candidate that exists, or the home directory.
 *
 * Never rejects and never returns a path that does not exist: a shortcut
 * button that reports "not found" teaches the user nothing, whereas landing in
 * the home directory is recoverable and the resolved path is echoed back in
 * `resolvedPath` so the breadcrumb shows where they actually are.
 */
export async function resolveWellKnownDirectory(
  kind: WellKnownDirectoryKind,
  deps: WellKnownDirectoryDeps = {},
): Promise<string> {
  const ownHome = deps.homedir?.() ?? osHomedir();

  // Cache per (kind, own home) so a test that swaps homedir is not served
  // another test's answer, and a real user switching accounts cannot be
  // either. Keyed on OUR home rather than the target's, because the target is
  // what the lookup produces.
  const cacheKey = `${deps.platform ?? process.platform}:${ownHome}:${kind}`;
  const cached = resolutionCache.get(cacheKey);
  if (cached) return cached;

  const directoryExists = deps.directoryExists ?? defaultDirectoryExists;
  const pending = (async () => {
    const candidates = await wellKnownDirectoryCandidates(kind, deps);
    // HOME yields exactly one candidate and must not be existence-filtered
    // down to our own profile; an unreachable home is still the right answer.
    if (kind === WELL_KNOWN_DIRECTORY.HOME) return candidates[0] ?? ownHome;
    for (const candidate of candidates) {
      if (await directoryExists(candidate)) return candidate;
    }
    // Last resort is the TARGET's home, not ours -- falling back to the
    // service profile is the bug this whole path exists to avoid.
    return candidates.at(-1) ?? ownHome;
  })().catch(() => ownHome);

  resolutionCache.set(cacheKey, pending);
  return pending;
}
