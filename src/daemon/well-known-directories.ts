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
 */
const WINDOWS_SHELL_FOLDER_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
] as const;

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
  /** Resolves one `Shell Folders` value, or null when it is absent. */
  readWindowsShellFolder?: (valueName: string) => Promise<string | null>;
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

async function defaultReadWindowsShellFolder(valueName: string): Promise<string | null> {
  for (const key of WINDOWS_SHELL_FOLDER_KEYS) {
    try {
      // Fixed key and a value name from a closed map above -- never caller
      // input -- and execFile takes an argv array, so there is no shell to
      // inject into.
      const { stdout } = await execFileAsync(
        'reg',
        ['query', key, '/v', valueName],
        { timeout: WINDOWS_REGISTRY_TIMEOUT_MS, windowsHide: true },
      );
      const parsed = parseWindowsRegistryValue(stdout, valueName);
      if (parsed) return parsed;
    } catch {
      // Missing value, missing hive, or reg.exe unavailable: try the next key.
    }
  }
  return null;
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
export async function wellKnownDirectoryCandidates(
  kind: WellKnownDirectoryKind,
  deps: WellKnownDirectoryDeps = {},
): Promise<string[]> {
  const platform = deps.platform ?? process.platform;
  const homeDir = deps.homedir?.() ?? osHomedir();
  if (kind === WELL_KNOWN_DIRECTORY.HOME) return [homeDir];

  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((filePath: string) => fsReadFile(filePath, 'utf8'));
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const candidates: string[] = [];

  if (platform === 'win32') {
    const readShellFolder = deps.readWindowsShellFolder ?? defaultReadWindowsShellFolder;
    const recorded = await readShellFolder(WINDOWS_SHELL_FOLDER_VALUES[kind]);
    if (recorded) candidates.push(expandWindowsEnvironmentPath(recorded, env));
  } else if (platform !== 'darwin') {
    const configured = await resolveLinuxDirectory(kind, homeDir, env, readFile);
    if (configured) candidates.push(configured);
  }

  // macOS always lands here, and it is the correct answer there: the on-disk
  // names are English and only the Finder display is localized.
  candidates.push(platformPath.join(homeDir, ENGLISH_DIRECTORY_NAMES[kind]));
  candidates.push(homeDir);
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
  const homeDir = deps.homedir?.() ?? osHomedir();
  if (kind === WELL_KNOWN_DIRECTORY.HOME) return homeDir;

  // Cache per (kind, home) so a test that swaps homedir is not served another
  // test's answer, and a real user switching accounts cannot be either.
  const cacheKey = `${deps.platform ?? process.platform}:${homeDir}:${kind}`;
  const cached = resolutionCache.get(cacheKey);
  if (cached) return cached;

  const directoryExists = deps.directoryExists ?? defaultDirectoryExists;
  const pending = (async () => {
    const candidates = await wellKnownDirectoryCandidates(kind, deps);
    for (const candidate of candidates) {
      if (await directoryExists(candidate)) return candidate;
    }
    return homeDir;
  })().catch(() => homeDir);

  resolutionCache.set(cacheKey, pending);
  return pending;
}
