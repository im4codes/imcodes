import path from 'node:path';
import { accessSync, constants as fsConstants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { canUseOpenCodeHomeFallbackSync, type ResolveOpenCodeCliOptions } from './opencode-cli-path.js';

export function normalizeTransportCwd(cwd?: string): string | undefined {
  if (typeof cwd !== 'string' || !cwd.trim()) return undefined;
  if (process.platform === 'win32') {
    const absolute = path.win32.isAbsolute(cwd) ? path.win32.normalize(cwd) : path.win32.resolve(cwd);
    return absolute.replace(/\\/g, '/');
  }
  return path.resolve(cwd);
}

/** Canonical directory identity used when matching provider-owned sessions. */
export function canonicalizeTransportCwd(cwd?: string): string | undefined {
  const normalized = normalizeTransportCwd(cwd);
  if (!normalized) return undefined;
  let canonical = normalized;
  try {
    canonical = normalizeTransportCwd(realpathSync.native(normalized)) ?? normalized;
  } catch {
    // The project may be temporarily unavailable; the absolute normalized
    // path is still the safest fail-closed identity available.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** Resolve a CLI binary name to an absolute path on Windows.
 *
 *  Node's child_process.spawn(name, args) on Windows does NOT search PATH for
 *  `.cmd`/`.bat` extensions when `shell: false`.  npm-installed CLIs are
 *  almost always `.cmd` shims (e.g. `claude.cmd`, `codex.cmd`); npm also
 *  drops a Unix-style extensionless file in the same directory which Windows
 *  cannot execute.
 *
 *  This helper walks PATH manually and tries PATHEXT extensions FIRST so we
 *  prefer `codex.cmd` over the extensionless `codex` shim.  Returns the
 *  absolute path if found, or the original name if not. */
export function resolveBinaryOnWindows(name: string): string {
  if (process.platform !== 'win32') return name;
  // Already absolute and exists? Use as-is.
  if (path.isAbsolute(name) && existsSync(name)) return name;
  // Windows path/ext delimiter is always ';'.  Hard-code it instead of
  // importing `delimiter` from node:path because that constant is the host
  // OS delimiter (':' on Linux), which breaks tests that fake
  // `process.platform = 'win32'` on a posix CI runner.
  const WIN_DELIMITER = ';';
  const pathDirs = uniqueNonEmpty([
    ...(process.env.PATH ?? '').split(WIN_DELIMITER),
    ...getWindowsGlobalCliDirs(),
  ]);
  const pathExtRaw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const exts = uniqueNonEmpty(pathExtRaw.split(WIN_DELIMITER).flatMap((e) => [e.toLowerCase(), e]));
  const hasExt = exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase()));
  // If the user already gave a known extension, try it directly.  Otherwise
  // try every PATHEXT (so we hit `.cmd` before the extensionless Unix shim),
  // then fall back to the bare name as a last resort.
  const extsToTry = hasExt ? [''] : [...exts, ''];
  for (const dir of pathDirs) {
    for (const ext of extsToTry) {
      // Use path.join (native) — works on both Windows runtime and tests
      // that fake `process.platform = 'win32'` on a posix host.
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return name;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function getWindowsGlobalCliDirs(): string[] {
  return uniqueNonEmpty([
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : undefined,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm') : undefined,
  ]);
}

function getWindowsClaudeInstallCandidates(name: string): string[] {
  const basename = path.basename(name);
  const hasExt = /\.[^\\/]+$/.test(basename);
  const fileNames = hasExt ? [basename] : [basename, `${basename}.exe`, `${basename}.cmd`, `${basename}.bat`];
  const dirs = uniqueNonEmpty([
    ...getWindowsGlobalCliDirs(),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.local', 'bin') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Claude') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Claude Code') : undefined,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Claude') : undefined,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Claude Code') : undefined,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Claude') : undefined,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Claude Code') : undefined,
  ]);
  return dirs.flatMap((dir) => fileNames.map((fileName) => path.join(dir, fileName)));
}

export function resolveBinaryWithWindowsFallbacks(name: string, windowsCandidates: string[] = []): string {
  if (process.platform !== 'win32') return name;
  for (const candidate of windowsCandidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return resolveBinaryOnWindows(name);
}

/** Common per-user `claude` install locations on macOS/Linux, checked when the
 *  daemon's (systemd/launchd) PATH is too sparse to contain `claude`. */
function getUnixClaudeInstallCandidates(): string[] {
  const home = process.env.HOME;
  return uniqueNonEmpty([
    home ? path.join(home, '.local', 'bin', 'claude') : undefined,
    home ? path.join(home, '.claude', 'local', 'claude') : undefined,
    home ? path.join(home, '.npm-global', 'bin', 'claude') : undefined,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]);
}

function isAbsoluteSmart(filePath: string): boolean {
  return path.isAbsolute(filePath) || path.win32.isAbsolute(filePath);
}

function hasPathSeparator(filePath: string): boolean {
  return filePath.includes('/') || filePath.includes('\\');
}

function joinSmart(base: string, ...segments: string[]): string {
  if (base.includes('\\') || /^[A-Za-z]:/.test(base)) {
    return path.win32.join(base, ...segments);
  }
  return path.join(base, ...segments);
}

function dirnameSmart(filePath: string): string {
  if (filePath.includes('\\') || /^[A-Za-z]:/.test(filePath)) {
    return path.win32.dirname(filePath);
  }
  return path.dirname(filePath);
}

function findPackageRootUpwards(entryFilePath: string, packageName: string): string | null {
  let dir = dirnameSmart(entryFilePath);
  while (true) {
    const pkgJsonPath = joinSmart(dir, 'package.json');
    if (existsSync(pkgJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: unknown };
        if (parsed.name === packageName) return dir;
      } catch {
        return dir;
      }
    }
    const parent = dirnameSmart(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveExportTargetPath(pkgJson: Record<string, unknown>, subpathKey: string): string | null {
  const exportsField = pkgJson.exports;
  if (!exportsField || typeof exportsField !== 'object') {
    return subpathKey === '.' && typeof pkgJson.main === 'string' ? pkgJson.main : null;
  }
  const entry = (exportsField as Record<string, unknown>)[subpathKey];
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  for (const condition of ['node', 'import', 'default', 'require']) {
    const val = record[condition];
    if (typeof val === 'string') return val;
    if (val && typeof val === 'object') {
      const nested = (val as Record<string, unknown>).default;
      if (typeof nested === 'string') return nested;
    }
  }
  return null;
}

/** Resolve the installed root directory of a package via Node's standard
 *  module resolution (`import.meta.resolve`, `createRequire.resolve`, and
 *  `require.resolve.paths` + `exports` target validation). */
export function resolveNodePackageRoot(
  specifier: string,
  packageName = specifier,
): string | null {
  const checkSearchBase = (base: string): string | null => {
    const candidate = joinSmart(base, ...packageName.split('/'));
    const pkgJsonPath = joinSmart(candidate, 'package.json');
    if (!existsSync(pkgJsonPath)) return null;
    if (specifier === packageName) return candidate;
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
      const subpath = specifier.startsWith(`${packageName}/`)
        ? `./${specifier.slice(packageName.length + 1)}`
        : '.';
      const target = resolveExportTargetPath(pkgJson, subpath);
      if (target && existsSync(joinSmart(candidate, target))) {
        return candidate;
      }
    } catch {
      // Ignore malformed package.json and continue searching.
    }
    return null;
  };

  try {
    if (typeof import.meta.resolve === 'function') {
      const resolvedUrl = import.meta.resolve(specifier);
      if (resolvedUrl.startsWith('file:')) {
        const resolvedPath = fileURLToPath(resolvedUrl);
        if (existsSync(resolvedPath)) {
          const root = findPackageRootUpwards(resolvedPath, packageName);
          if (root) return root;
        }
      }
    }
  } catch {
    // Fall back to CJS / package.json exports inspection below.
  }

  try {
    const req = createRequire(import.meta.url);
    try {
      const entry = req.resolve(specifier);
      const root = findPackageRootUpwards(entry, packageName);
      if (root) return root;
    } catch {
      // Specifier has no CJS entry or blocks `./package.json` export; check `resolve.paths` + package.json directly.
    }

    const searchPaths = req.resolve.paths(packageName) ?? [];
    for (const base of searchPaths) {
      const matched = checkSearchBase(base);
      if (matched) return matched;
    }
  } catch {
    // Package is not installed in the dependency tree.
  }

  return null;
}

export function isBundledClaudeBinaryFileSync(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    const info = statSync(filePath);
    if (!info.isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface BundledClaudeCandidateOptions {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture | string;
  env?: NodeJS.ProcessEnv;
  resolvePackageRoot?: (specifier: string, packageName?: string) => string | null;
}

/** Discover platform-bundled native `claude` / `claude.exe` candidates inside
 *  `@anthropic-ai/claude-agent-sdk` and its sibling platform packages, with an
 *  explicit `NODE_PATH` native-asset fallback after standard resolution. */
export function getBundledClaudeBinaryCandidates(opts: BundledClaudeCandidateOptions = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const env = opts.env ?? process.env;
  const resolvePkg = opts.resolvePackageRoot ?? ((spec, pkg) => resolveNodePackageRoot(spec, pkg));
  const suffix = `${platform}-${arch}`;
  const binName = platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates: string[] = [];
  const pkgNames = platform === 'linux'
    ? [`@anthropic-ai/claude-agent-sdk-${suffix}`, `@anthropic-ai/claude-agent-sdk-${suffix}-musl`]
    : [`@anthropic-ai/claude-agent-sdk-${suffix}`];

  for (const pkgName of pkgNames) {
    const root = resolvePkg(pkgName, pkgName);
    if (root) candidates.push(joinSmart(root, binName));
  }
  const mainRoot = resolvePkg('@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk');
  if (mainRoot) {
    const scopeDir = dirnameSmart(mainRoot);
    candidates.push(joinSmart(scopeDir, `claude-agent-sdk-${suffix}`, binName));
  }
  const allowNodePathFallback = !opts.resolvePackageRoot || opts.resolvePackageRoot === resolveNodePackageRoot;
  if (allowNodePathFallback && typeof env.NODE_PATH === 'string' && env.NODE_PATH.trim()) {
    const nodePathEntries = uniqueNonEmpty(
      env.NODE_PATH.split(env.NODE_PATH.includes(';') ? ';' : path.delimiter),
    );
    for (const base of nodePathEntries) {
      for (const pkgName of pkgNames) {
        candidates.push(joinSmart(base, ...pkgName.split('/'), binName));
      }
    }
  }
  return uniqueNonEmpty(candidates);
}

/** Locate the native `claude` (`claude.exe` on Windows) binary that ships inside
 *  `@anthropic-ai/claude-agent-sdk`'s platform-specific sibling package. */
function resolveBundledClaudeBinary(
  opts: BundledClaudeCandidateOptions & { isBinaryFile?: (filePath: string) => boolean } = {},
): string | undefined {
  const platform = opts.platform ?? process.platform;
  const checkFile = opts.isBinaryFile ?? ((filePath: string) => isBundledClaudeBinaryFileSync(filePath, platform));
  for (const candidate of getBundledClaudeBinaryCandidates({ ...opts, platform })) {
    if (checkFile(candidate)) return candidate;
  }
  return undefined;
}

export interface ResolveClaudeCodePathOptions extends BundledClaudeCandidateOptions {
  isBinaryFile?: (filePath: string) => boolean;
}

/** Resolve a CLI path suitable for passing to an SDK option like
 *  `pathToClaudeCodeExecutable`.
 *
 *  Windows: preserves explicit paths, resolves bundled native `claude.exe` for
 *  the default `'claude'` binary name, then falls back to common install dirs /
 *  PATH and unwraps npm `.cmd`/`.bat` shims to their `.js` entrypoints.
 *
 *  macOS/Linux: a daemon launched by systemd/launchd has a sparse PATH that
 *  usually lacks `claude`, so for default `'claude'` we resolve the bundled
 *  binary, then common per-user install locations, then bare PATH lookup.
 *  An explicit caller-provided name/path is always honoured. */
export function resolveClaudeCodePathForSdk(
  name = 'claude',
  opts: ResolveClaudeCodePathOptions = {},
): string {
  const platform = opts.platform ?? process.platform;
  const checkFile = opts.isBinaryFile ?? ((filePath: string) => isBundledClaudeBinaryFileSync(filePath, platform));
  const isDefaultClaude = name === 'claude';

  if (platform === 'win32') {
    if (isAbsoluteSmart(name) || hasPathSeparator(name)) {
      if (/\.(cmd|bat)$/i.test(name)) {
        return parseNpmCmdShim(name) ?? name;
      }
      return name;
    }
    if (isDefaultClaude) {
      const bundled = resolveBundledClaudeBinary({ ...opts, platform, isBinaryFile: checkFile });
      if (bundled) return bundled;
    }
    const resolved = resolveBinaryWithWindowsFallbacks(name, getWindowsClaudeInstallCandidates(name));
    if (/\.(cmd|bat)$/i.test(resolved)) {
      return parseNpmCmdShim(resolved) ?? resolved;
    }
    return resolved;
  }
  if (!isDefaultClaude) return name;
  const bundled = resolveBundledClaudeBinary({ ...opts, platform, isBinaryFile: checkFile });
  if (bundled) return bundled;
  for (const candidate of getUnixClaudeInstallCandidates()) {
    if (checkFile(candidate)) return candidate;
  }
  return name;
}

function getWindowsAgyInstallCandidates(name: string): string[] {
  const basename = path.basename(name);
  const hasExt = /\.[^\\/]+$/.test(basename);
  const fileNames = hasExt ? [basename] : [basename, `${basename}.exe`, `${basename}.cmd`, `${basename}.bat`];
  const dirs = uniqueNonEmpty([
    ...getWindowsGlobalCliDirs(),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'bin') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'antigravity-cli', 'bin') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'bin') : undefined,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.gemini', 'antigravity-cli', 'bin') : undefined,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.local', 'bin') : undefined,
  ]);
  return dirs.flatMap((dir) => fileNames.map((fileName) => path.join(dir, fileName)));
}

/** Common per-user `agy` install locations on macOS/Linux, checked when the
 *  daemon's (systemd/launchd) PATH is too sparse to contain `agy`. */
function getUnixAgyInstallCandidates(): string[] {
  const home = process.env.HOME;
  return uniqueNonEmpty([
    home ? path.join(home, '.local', 'bin', 'agy') : undefined,
    home ? path.join(home, '.gemini', 'antigravity-cli', 'bin', 'agy') : undefined,
    home ? path.join(home, '.gemini', 'antigravity', 'bin', 'agy') : undefined,
    home ? path.join(home, '.npm-global', 'bin', 'agy') : undefined,
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
    '/usr/bin/agy',
    '/bin/agy',
  ]);
}

/** Resolve a CLI path for Google Antigravity (`agy`).
 *  Under systemd/launchd, PATH is often sparse and omits ~/.local/bin/agy.
 *  Checks explicit config, per-user paths, system paths, and PATH. */
export function resolveAgyPathForSdk(name = 'agy'): string {
  if (process.platform === 'win32') {
    const resolved = resolveBinaryWithWindowsFallbacks(name, getWindowsAgyInstallCandidates(name));
    if (/\.(cmd|bat)$/i.test(resolved)) {
      return parseNpmCmdShim(resolved) ?? resolved;
    }
    return resolved;
  }
  if (name !== 'agy') {
    if (path.isAbsolute(name)) return name;
    for (const candidate of getUnixAgyInstallCandidates()) {
      if (path.basename(candidate) === name && existsSync(candidate)) return candidate;
    }
    return name;
  }
  for (const candidate of getUnixAgyInstallCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

export type ResolveCodexPathOptions = Pick<ResolveOpenCodeCliOptions, 'env' | 'platform' | 'homeDir' | 'isElevated'>;

function findCodexOnWindowsDirs(dirs: readonly string[], env: NodeJS.ProcessEnv): string | null {
  const pathExtRaw = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const exts = uniqueNonEmpty(pathExtRaw.split(';').flatMap((e) => [e.toLowerCase(), e]));
  const extsToTry = [...exts, ''];
  for (const dir of dirs) {
    for (const ext of extsToTry) {
      const candidate = path.join(dir, `codex${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveCodexPath(name: string, mode: 'sdk' | 'pty', opts: ResolveCodexPathOptions = {}): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed !== 'codex') {
    return name;
  }
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform === 'win32') {
    const pathDirs = uniqueNonEmpty((env.PATH ?? '').split(';'));
    const onPath = findCodexOnWindowsDirs(pathDirs, env);
    if (onPath) {
      if (mode === 'pty') return trimmed;
      return /\.(cmd|bat)$/i.test(onPath) ? (parseNpmCmdShim(onPath) ?? onPath) : onPath;
    }
    const globalDirs = uniqueNonEmpty([
      env.APPDATA ? path.join(env.APPDATA, 'npm') : undefined,
      env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming', 'npm') : undefined,
    ]);
    const inGlobal = findCodexOnWindowsDirs(globalDirs, env);
    if (inGlobal) {
      if (mode === 'pty') return inGlobal;
      return /\.(cmd|bat)$/i.test(inGlobal) ? (parseNpmCmdShim(inGlobal) ?? inGlobal) : inGlobal;
    }
    const home = opts.homeDir ?? (env.USERPROFILE || env.HOME || homedir());
    if (home && canUseOpenCodeHomeFallbackSync('win32', home, { env, isElevated: opts.isElevated })) {
      const homeBin = path.win32.join(home, '.codex', 'bin', 'codex.exe');
      if (isBundledClaudeBinaryFileSync(homeBin, 'win32')) return homeBin;
    }
    return trimmed;
  }
  const pathDirs = (env.PATH ?? '').split(':').map((d) => d.trim()).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'codex');
    if (isBundledClaudeBinaryFileSync(candidate, platform)) {
      return trimmed;
    }
  }
  const home = opts.homeDir ?? (env.HOME || homedir());
  if (home && canUseOpenCodeHomeFallbackSync(platform, home, { env, isElevated: opts.isElevated })) {
    const homeBin = path.join(home, '.codex', 'bin', 'codex');
    if (isBundledClaudeBinaryFileSync(homeBin, platform)) {
      return homeBin;
    }
  }
  return trimmed;
}

export function resolveCodexPathForSdk(name = 'codex', opts: ResolveCodexPathOptions = {}): string {
  return resolveCodexPath(name, 'sdk', opts);
}

export function resolveCodexPathForPty(name = 'codex', opts: ResolveCodexPathOptions = {}): string {
  return resolveCodexPath(name, 'pty', opts);
}

function getUnixMuseCodeInstallCandidates(): string[] {
  const home = process.env.HOME;
  return uniqueNonEmpty([
    home ? path.join(home, '.local', 'bin', 'muse') : undefined,
    home ? path.join(home, '.muse', 'bin', 'muse') : undefined,
    home ? path.join(home, '.npm-global', 'bin', 'muse') : undefined,
    '/usr/local/bin/muse',
    '/opt/homebrew/bin/muse',
    '/usr/bin/muse',
    '/bin/muse',
  ]);
}

/** Resolve a CLI path for Muse Code (`muse`).
 *  Under systemd/launchd, PATH is often sparse and omits ~/.local/bin/muse.
 *  Checks explicit config, per-user paths, system paths, and PATH. */
export function resolveMuseCodePathForSdk(name = 'muse'): string {
  if (process.platform === 'win32') {
    return name;
  }
  if (name !== 'muse') {
    if (path.isAbsolute(name)) return name;
    for (const candidate of getUnixMuseCodeInstallCandidates()) {
      if (path.basename(candidate) === name && existsSync(candidate)) return candidate;
    }
    return name;
  }
  for (const candidate of getUnixMuseCodeInstallCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

function getWindowsGrokInstallCandidates(name: string): string[] {
  const basename = path.basename(name);
  const hasExt = /\.[^\\/]+$/.test(basename);
  const fileNames = hasExt ? [basename] : [basename, `${basename}.exe`, `${basename}.cmd`, `${basename}.bat`];
  const grokHome = process.env.GROK_HOME;
  const dirs = uniqueNonEmpty([
    ...getWindowsGlobalCliDirs(),
    grokHome ? path.join(grokHome, 'bin') : undefined,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.grok', 'bin') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'grok', 'bin') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'grok') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'grok', 'bin') : undefined,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.local', 'bin') : undefined,
  ]);
  return dirs.flatMap((dir) => fileNames.map((fileName) => path.join(dir, fileName)));
}

function getUnixGrokInstallCandidates(): string[] {
  const home = process.env.HOME;
  const grokHome = process.env.GROK_HOME;
  return uniqueNonEmpty([
    grokHome ? path.join(grokHome, 'bin', 'grok') : undefined,
    home ? path.join(home, '.grok', 'bin', 'grok') : undefined,
    home ? path.join(home, '.local', 'bin', 'grok') : undefined,
    home ? path.join(home, '.npm-global', 'bin', 'grok') : undefined,
    '/usr/local/bin/grok',
    '/opt/homebrew/bin/grok',
    '/usr/bin/grok',
    '/bin/grok',
  ]);
}

/** Resolve a CLI path for Grok (`grok`).
 *  Under systemd/launchd, PATH is often sparse and omits ~/.grok/bin or ~/.local/bin.
 *  Checks explicit config, per-user paths, system paths, and PATH. */
export function resolveGrokPathForSdk(name = 'grok'): string {
  if (process.platform === 'win32') {
    const resolved = resolveBinaryWithWindowsFallbacks(name, getWindowsGrokInstallCandidates(name));
    if (/\.(cmd|bat)$/i.test(resolved)) {
      return parseNpmCmdShim(resolved) ?? resolved;
    }
    return resolved;
  }
  if (name !== 'grok') {
    if (path.isAbsolute(name)) return name;
    for (const candidate of getUnixGrokInstallCandidates()) {
      if (path.basename(candidate) === name && existsSync(candidate)) return candidate;
    }
    return name;
  }
  for (const candidate of getUnixGrokInstallCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

function isRegularFileSync(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isExecutableFileSync(filePath: string): boolean {
  if (!isRegularFileSync(filePath)) return false;
  if (process.platform !== 'win32') {
    try {
      accessSync(filePath, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

function getWindowsCursorCandidateDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string | undefined = env.USERPROFILE,
  joinFn: (...parts: string[]) => string = path.join,
): string[] {
  return uniqueNonEmpty([
    env.LOCALAPPDATA ? joinFn(env.LOCALAPPDATA, 'cursor-agent') : undefined,
    env.LOCALAPPDATA ? joinFn(env.LOCALAPPDATA, 'Programs', 'cursor-agent') : undefined,
    home ? joinFn(home, '.local', 'bin') : undefined,
    home ? joinFn(home, '.cursor', 'bin') : undefined,
  ]);
}

export function getWindowsCursorSearchDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string | undefined = env.USERPROFILE,
  joinFn: (...parts: string[]) => string = path.join,
): string[] {
  return uniqueNonEmpty([
    ...getWindowsCursorCandidateDirs(env, home, joinFn),
    env.APPDATA ? joinFn(env.APPDATA, 'npm') : undefined,
    home ? joinFn(home, 'AppData', 'Roaming', 'npm') : undefined,
  ]);
}

/** Common install locations on macOS/Linux for Cursor Agent CLI (`cursor-agent` or `agent`).
 *  Newer Cursor CLI releases install `agent` alongside (or instead of) `cursor-agent`
 *  under `~/.local/bin`, which sparse systemd/launchd daemon PATHs omit. */
export function getUnixCursorCandidateDirs(
  home: string | undefined = process.env.HOME,
  joinFn: (...parts: string[]) => string = path.posix.join,
): string[] {
  return uniqueNonEmpty([
    home ? joinFn(home, '.local', 'bin') : undefined,
    home ? joinFn(home, '.cursor', 'bin') : undefined,
    home ? joinFn(home, '.npm-global', 'bin') : undefined,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]);
}

function findExecutableOnUnixDirs(binName: string, extraDirs: string[]): string | null {
  const pathEnv = process.env.PATH ?? '';
  const searchDirs = uniqueNonEmpty([
    ...pathEnv.split(':'),
    ...extraDirs,
  ]);
  for (const dir of searchDirs) {
    const candidate = path.join(dir, binName);
    if (isExecutableFileSync(candidate)) return candidate;
  }
  return null;
}

const SUPPORTED_CURSOR_WIN_EXTS = new Set(['.com', '.exe', '.bat', '.cmd']);

export function getSupportedCursorWindowsExts(pathExtRaw?: string): string[] {
  const raw = pathExtRaw ?? '.COM;.EXE;.BAT;.CMD';
  const filtered = uniqueNonEmpty(raw.split(';'))
    .filter((ext) => SUPPORTED_CURSOR_WIN_EXTS.has(ext.toLowerCase()));
  return uniqueNonEmpty(filtered.flatMap((ext) => [ext.toLowerCase(), ext]));
}

function listWindowsCandidateFilesInDir(dir: string, bin: string, exts: string[]): string[] {
  const hasSupportedExt = [...SUPPORTED_CURSOR_WIN_EXTS].some((ext) => bin.toLowerCase().endsWith(ext));
  const names = hasSupportedExt ? [bin] : exts.map((ext) => `${bin}${ext}`);
  const out: string[] = [];
  for (const fileName of names) {
    const candidate = path.join(dir, fileName);
    if (isRegularFileSync(candidate)) out.push(candidate);
  }
  return out;
}

function splitCmdTokens(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function expandBatchString(rawValue: string, dp0: string, vars: Record<string, string>): string {
  const resolveVar = (key: string): string | undefined => {
    const upper = key.toUpperCase();
    const direct = vars[upper] ?? process.env[key] ?? process.env[upper];
    if (direct !== undefined) return direct;
    if (upper === 'SYSTEMROOT') return 'C:\\Windows';
    return undefined;
  };
  const expanded = rawValue
    .replace(/%~dp0\\?/gi, `${dp0}${path.sep}`)
    .replace(/%dp0%[\\/]?/gi, `${dp0}${path.sep}`)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, key: string) => resolveVar(key) ?? m)
    .replace(/!([A-Za-z_][A-Za-z0-9_]*)!/g, (m, key: string) => resolveVar(key) ?? m);
  return expanded;
}

function normalizeBatchPath(rawPath: string): string {
  // Support Windows backslash script separators when tests fake platform='win32' on POSIX temp dirs.
  if (rawPath.startsWith('/')) {
    return path.normalize(rawPath.replace(/\\/g, '/'));
  }
  return path.normalize(rawPath);
}

function baseNameSmart(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? filePath;
}

function expandBatchPath(rawValue: string, dp0: string, vars: Record<string, string>): string {
  const expanded = expandBatchString(rawValue, dp0, vars);
  return normalizeBatchPath(expanded);
}

const CURSOR_PS1_VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i;

function compareCursorVersionDirsDesc(a: string, b: string): number {
  const toSortableParts = (ver: string): { dateNum: number; ver: string } => {
    const datePart = ver.split('-')[0] ?? '';
    const parts = datePart.split('.');
    if (parts.length !== 3) return { dateNum: 0, ver };
    const dateNum = Number(`${parts[0]}${parts[1]!.padStart(2, '0')}${parts[2]!.padStart(2, '0')}`);
    return { dateNum: Number.isFinite(dateNum) ? dateNum : 0, ver };
  };
  const pa = toSortableParts(a);
  const pb = toSortableParts(b);
  if (pb.dateNum !== pa.dateNum) return pb.dateNum - pa.dateNum;
  return b.localeCompare(a, undefined, { numeric: true });
}

function extractPs1FixedNodeFlags(ps1Content: string): string[] {
  const match = ps1Content.match(/&\s+["']?\$[A-Za-z_]\w*["']?\s+([^\r\n]+?)\s+["']?\$scriptPath[\\/][^"'\s]*index\.js["']?\s+\$args/i);
  if (!match?.[1]) return [];
  return splitCmdTokens(match[1]);
}

interface CursorPs1Resolution {
  active: ResolvedExecutable | null;
}

function resolveCursorVersionDirExecutable(verDir: string, fixedFlags: string[]): ResolvedExecutable | null {
  const verNode = joinSmart(verDir, 'node.exe');
  const verIndex = joinSmart(verDir, 'index.js');
  if (isRegularFileSync(verNode) && isRegularFileSync(verIndex)) {
    return { executable: verNode, prependArgs: [...fixedFlags, verIndex] };
  }
  for (const exeName of ['cursor-agent.exe', 'agent.exe']) {
    const exePath = joinSmart(verDir, exeName);
    if (isRegularFileSync(exePath)) return { executable: exePath, prependArgs: [] };
  }
  return null;
}

function sanitizeCursorVersionPinSegment(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[\\/:*?"<>|\0\s~]/.test(trimmed)) return null;
  if (trimmed === '.' || trimmed === '..' || trimmed.endsWith('.')) return null;
  if (/\.new$/i.test(trimmed)) return null;
  return trimmed;
}

function parseActiveCursorVersionPin(raw: string): string | null {
  const segment = sanitizeCursorVersionPinSegment(raw);
  if (!segment) return null;
  return CURSOR_PS1_VERSION_RE.test(segment) ? segment : null;
}

function resolveFormalVersionDirExecutable(versionsDir: string, activeVer: string, fixedFlags: string[]): ResolvedExecutable | null {
  const validPin = parseActiveCursorVersionPin(activeVer);
  if (!validPin) return null;
  let matchedName: string | null = null;
  try {
    const entries = readdirSync(versionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (!parseActiveCursorVersionPin(entry.name)) continue;
      if (entry.name.toLowerCase() === validPin.toLowerCase()) {
        matchedName = entry.name;
        break;
      }
    }
  } catch {
    return null;
  }
  if (!matchedName) return null;
  const verDir = joinSmart(versionsDir, matchedName);
  try {
    const resolvedBase = baseNameSmart(realpathSync(verDir));
    if (!parseActiveCursorVersionPin(resolvedBase)) return null;
  } catch {
    return null;
  }
  return resolveCursorVersionDirExecutable(verDir, fixedFlags);
}

function resolveCursorPs1LauncherPlan(ps1Path: string): CursorPs1Resolution | null {
  let content: string;
  try {
    content = readFileSync(ps1Path, 'utf8');
  } catch {
    return null;
  }
  const ps1Dir = dirnameSmart(ps1Path);
  const fixedFlags = extractPs1FixedNodeFlags(content);

  // Case 1: flat package layout with node.exe + index.js in scriptPath (cursor-agent.ps1)
  const flatNode = joinSmart(ps1Dir, 'node.exe');
  const flatIndex = joinSmart(ps1Dir, 'index.js');
  if (isRegularFileSync(flatNode) && isRegularFileSync(flatIndex)) {
    return { active: { executable: flatNode, prependArgs: [...fixedFlags, flatIndex] } };
  }

  const versionsDir = joinSmart(ps1Dir, 'versions');
  const hasPromoteHook = /promote-staged\.cmd/i.test(content) && isRegularFileSync(joinSmart(versionsDir, 'promote-staged.cmd'));

  // Case 2: active.txt version pin (check both scriptPath\active.txt and scriptPath\versions\active.txt)
  for (const activeFile of [joinSmart(ps1Dir, 'active.txt'), joinSmart(versionsDir, 'active.txt')]) {
    if (!isRegularFileSync(activeFile)) continue;
    let rawPin = '';
    try {
      rawPin = readFileSync(activeFile, 'utf8').trim();
    } catch {
      return null;
    }
    const activeVer = sanitizeCursorVersionPinSegment(rawPin);
    if (!activeVer) {
      // Pin points to a staged `.new` name or Windows synonym/traversal path:
      // ignore the invalid pin and fall through to validated formal/staged-promote resolution.
      continue;
    }
    const activeExec = resolveFormalVersionDirExecutable(versionsDir, activeVer, fixedFlags);
    if (activeExec) {
      return { active: activeExec };
    }
    // Never treat an unpromoted `.new` directory as an active direct executable;
    // when promote-staged hook is armed, allow promotion-only attempt (`active: null`).
    if (hasPromoteHook && resolveCursorVersionDirExecutable(joinSmart(versionsDir, `${activeVer}.new`), fixedFlags)) {
      return { active: null };
    }
    // Fail closed if formal pin points to an incomplete/missing directory.
    return null;
  }

  // Case 3: official dist-package cursor-agent.ps1 versioned lookup (only when .ps1 checks $scriptPath\versions + Parse-VersionString/version regex)
  const hasVersionsLookup = /\$scriptPath[\\/]versions/i.test(content) && (/Parse-VersionString/i.test(content) || /versions/i.test(content));
  if (!hasVersionsLookup) return null;

  try {
    const dirEntries = readdirSync(versionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
    const entries = dirEntries
      .filter((entry) => parseActiveCursorVersionPin(entry.name) !== null)
      .map((entry) => entry.name)
      .sort(compareCursorVersionDirsDesc);
    for (const ver of entries) {
      const activeExec = resolveFormalVersionDirExecutable(versionsDir, ver, fixedFlags);
      if (activeExec) {
        return { active: activeExec };
      }
    }
    // A staged `.new` update directory with promote-staged hook proves promotion may be attempted,
    // NEVER that `.new` itself can be launched directly when promotion fails or does not activate it.
    if (hasPromoteHook) {
      const stagedEntries = dirEntries
        .filter((entry) => /\.new$/i.test(entry.name) && parseActiveCursorVersionPin(entry.name.slice(0, -4)) !== null)
        .map((entry) => entry.name)
        .sort((a, b) => compareCursorVersionDirsDesc(a.slice(0, -4), b.slice(0, -4)));
      for (const stagedName of stagedEntries) {
        if (resolveCursorVersionDirExecutable(joinSmart(versionsDir, stagedName), fixedFlags)) {
          return { active: null };
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function isBatchForwardArgsToken(token: string): boolean {
  return /^%(?:\*|~?[0-9]+)$/i.test(token);
}

export interface CursorWindowsLaunchPlan {
  /** Direct Node/binary entrypoint to spawn with user prompts and arbitrary argv (zero PowerShell second hop).
   *  Null when only an unpromoted `.new` staged directory + promote hook exists with no active version yet. */
  direct: ResolvedExecutable | null;
  /** Official wrapper invocation (e.g. `powershell.exe -File cursor-agent.ps1`) used ONLY with
   *  trusted fixed args such as `--version` to execute staged `.new` promotion before re-resolving `direct`. */
  promoteStep?: ResolvedExecutable;
  /** Versions directory where staged `.new` updates live, if applicable. */
  stagedVersionsDir?: string;
}

export function hasPendingCursorStagedUpdate(plan: CursorWindowsLaunchPlan): boolean {
  if (!plan.promoteStep || !plan.stagedVersionsDir) return false;
  try {
    const entries = readdirSync(plan.stagedVersionsDir, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory() && entry.name.endsWith('.new'));
  } catch {
    return false;
  }
}

/** Resolve ONLY Cursor-specific Windows `.cmd`/`.bat` wrappers into `{ direct, promoteStep }`.
 *  Never guesses arbitrary `versions/` folders for unrecognized `.cmd` files,
 *  and never alters shared non-Cursor provider `resolveExecutableForSpawn()` paths. */
export function resolveCursorCmdLauncherPlan(cmdPath: string, depth = 0): CursorWindowsLaunchPlan | null {
  if (depth > 3) return null;
  const npmScript = parseNpmCmdShim(cmdPath);
  if (npmScript && isRegularFileSync(npmScript)) {
    return { direct: { executable: process.execPath, prependArgs: [npmScript] } };
  }
  let content: string;
  try {
    content = readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  const dp0 = dirnameSmart(cmdPath);
  const vars: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^(@?rem\b|::)/i.test(trimmed)) continue;

    // Handle trailing-backslash strip idiom from Cursor's official cursor-agent.cmd:
    //   if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
    const stripSlashMatch = trimmed.match(/^if\s+"%([A-Za-z_][A-Za-z0-9_]*):~-1%"\s*==\s*"\\"\s+set\s+"?\1=[^"]*"?/i);
    if (stripSlashMatch) {
      const key = stripSlashMatch[1]!.toUpperCase();
      if (vars[key]?.endsWith('\\') || vars[key]?.endsWith('/')) {
        vars[key] = vars[key]!.slice(0, -1);
      }
      continue;
    }

    // Read active version pin if the batch script explicitly reads active.txt into a var:
    //   set /p ACTIVE_VER=<"%~dp0versions\active.txt"
    const setPromptMatch = trimmed.match(/^set\s+\/p\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*<\s*"?([^"\r\n]+)"?$/i);
    if (setPromptMatch) {
      const varKey = setPromptMatch[1]!.toUpperCase();
      const activePath = expandBatchPath(setPromptMatch[2]!.trim(), dp0, vars);
      if (!isRegularFileSync(activePath)) return null;
      try {
        const val = parseActiveCursorVersionPin(readFileSync(activePath, 'utf8'));
        if (!val) return null;
        vars[varKey] = val;
      } catch {
        return null;
      }
      continue;
    }

    const setMatch = trimmed.match(/^set\s+(?:"([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"|([A-Za-z_][A-Za-z0-9_]*)=([^\r\n]+?))$/i);
    if (setMatch) {
      const key = (setMatch[1] ?? setMatch[3] ?? '').toUpperCase();
      const rawVal = (setMatch[2] ?? setMatch[4] ?? '').trim();
      if (key && rawVal) {
        vars[key] = expandBatchString(rawVal, dp0, vars);
      }
      continue;
    }

    // Skip installer staged-promote pre-hook (`if exist "%~dp0versions\promote-staged.cmd" call ...`)
    if (/promote-staged\.cmd/i.test(trimmed)) continue;
    if (/^(@?echo|setlocal|endlocal|goto|exit|if\s+errorlevel)\b/i.test(trimmed)) continue;

    // Inspect executable statements that forward CLI arguments (%* / %1) or invoke known launcher targets
    const rawTokens = splitCmdTokens(trimmed);
    if (rawTokens.length === 0) continue;
    const expandedTokens = rawTokens.map((t) => expandBatchString(t, dp0, vars));
    const hasForwardArgs = expandedTokens.some(isBatchForwardArgsToken);
    if (!hasForwardArgs && !/powershell(?:\.exe)?$/i.test(expandedTokens[0] ?? '') && !/(?:cursor-agent|agent)\.ps1$/i.test(expandedTokens.join(' '))) {
      continue;
    }

    const cmdTokens = expandedTokens.filter((t) => !isBatchForwardArgsToken(t));
    const headRaw = cmdTokens[0] ?? '';
    const headBase = baseNameSmart(headRaw).toLowerCase();

    // Case A: official Cursor `.cmd` delegating to `%SystemRoot%\...\powershell.exe ... -File "<ps1>" %*`
    // Use powershell.exe ONLY as `promoteStep` with trusted fixed `--version` when staged `.new` updates exist,
    // while `direct` invokes the resolved bundled node.exe + index.js directly via native Win32 argv.
    if (headBase === 'powershell.exe' || headBase === 'powershell') {
      const fileFlagIdx = cmdTokens.findIndex((t) => /^-file$/i.test(t));
      const ps1TokenIdx = fileFlagIdx >= 0 ? fileFlagIdx + 1 : cmdTokens.findIndex((t) => /\.ps1$/i.test(t));
      const ps1Raw = ps1TokenIdx >= 0 ? cmdTokens[ps1TokenIdx] : undefined;
      if (ps1Raw) {
        const ps1Path = normalizeBatchPath(ps1Raw);
        const ps1Plan = isRegularFileSync(ps1Path) ? resolveCursorPs1LauncherPlan(ps1Path) : null;
        if (ps1Plan) {
          const powershellExe = headRaw.includes('/') || headRaw.includes('\\')
            ? path.win32.normalize(headRaw)
            : headRaw;
          const psArgs = cmdTokens.slice(1).map((tok, i) => (i + 1 === ps1TokenIdx ? ps1Path : tok));
          return {
            direct: ps1Plan.active,
            promoteStep: { executable: powershellExe, prependArgs: psArgs },
            stagedVersionsDir: joinSmart(dirnameSmart(ps1Path), 'versions'),
          };
        }
      }
      continue;
    }

    // Case B: direct node invocation with optional fixed flags before `.js`/`.mjs`/`.cjs` entrypoint
    if (headBase === 'node.exe' || headBase === 'node') {
      const scriptIdx = cmdTokens.findIndex((t, idx) => idx >= 1 && /\.(?:js|mjs|cjs)$/i.test(t));
      if (scriptIdx >= 1) {
        const scriptPath = normalizeBatchPath(cmdTokens[scriptIdx]!);
        if (isRegularFileSync(scriptPath)) {
          const hasExplicitDir = headRaw.includes('/') || headRaw.includes('\\');
          const explicitNode = normalizeBatchPath(headRaw);
          if (hasExplicitDir && !isRegularFileSync(explicitNode)) {
            continue;
          }
          const nodeExe = hasExplicitDir ? explicitNode : process.execPath;
          const fixedArgs = cmdTokens.slice(1, scriptIdx);
          return { direct: { executable: nodeExe, prependArgs: [...fixedArgs, scriptPath] } };
        }
      }
      continue;
    }

    // Case C: direct binary `.exe` invocation with optional fixed flags
    if (/\.exe$/i.test(headRaw) && headBase !== 'cmd.exe') {
      const exePath = normalizeBatchPath(headRaw);
      if (isRegularFileSync(exePath)) {
        return { direct: { executable: exePath, prependArgs: cmdTokens.slice(1) } };
      }
      continue;
    }

    // Case D: nested `.cmd`/`.bat` call (`call "..." %*`)
    if (/^call$/i.test(headBase) && cmdTokens[1] && /\.(?:cmd|bat)$/i.test(cmdTokens[1])) {
      const nestedCmd = normalizeBatchPath(cmdTokens[1]);
      if (nestedCmd.toLowerCase() !== cmdPath.toLowerCase() && isRegularFileSync(nestedCmd)) {
        const nested = resolveCursorCmdLauncherPlan(nestedCmd, depth + 1);
        if (nested) {
          return {
            direct: nested.direct
              ? { executable: nested.direct.executable, prependArgs: [...nested.direct.prependArgs, ...cmdTokens.slice(2)] }
              : null,
            ...(nested.promoteStep ? { promoteStep: nested.promoteStep } : {}),
            ...(nested.stagedVersionsDir ? { stagedVersionsDir: nested.stagedVersionsDir } : {}),
          };
        }
      }
    }
  }

  return null;
}

export function resolveCursorCmdLauncher(cmdPath: string, depth = 0): ResolvedExecutable | null {
  return resolveCursorCmdLauncherPlan(cmdPath, depth)?.direct ?? null;
}

function resolveCursorExplicitWindowsPlan(target: string): CursorWindowsLaunchPlan | null {
  const trimmed = target.trim();
  if (!trimmed) return null;
  if (/\.(exe|com)$/i.test(trimmed)) {
    return isRegularFileSync(trimmed) ? { direct: { executable: trimmed, prependArgs: [] } } : null;
  }
  if (/\.(?:js|mjs|cjs)$/i.test(trimmed)) {
    return isRegularFileSync(trimmed) ? { direct: { executable: process.execPath, prependArgs: [trimmed] } } : null;
  }
  if (/\.(cmd|bat)$/i.test(trimmed)) {
    return resolveCursorCmdLauncherPlan(trimmed);
  }
  return null;
}

/** Resolve Cursor Agent into a launch plan: `direct` (native binary/Node entrypoint for safe argv prompt delivery)
 *  and optional `promoteStep` (official PowerShell wrapper for fixed `--version` / staged `.new` promotion). */
export function resolveCursorLaunchPlan(nameOrPath = 'cursor-agent'): CursorWindowsLaunchPlan {
  const trimmed = nameOrPath.trim();
  if (process.platform !== 'win32') {
    return { direct: { executable: trimmed || 'cursor-agent', prependArgs: [] } };
  }

  if (trimmed && (isAbsoluteSmart(trimmed) || hasPathSeparator(trimmed))) {
    const explicitPlan = resolveCursorExplicitWindowsPlan(trimmed);
    if (explicitPlan) return explicitPlan;
    return { direct: { executable: trimmed, prependArgs: [] } };
  }

  const exts = getSupportedCursorWindowsExts(process.env.PATHEXT);
  const pathDirs = (process.env.PATH ?? '').split(';');
  const searchDirs = [...pathDirs, ...getWindowsCursorSearchDirs()];
  const bins = !trimmed || trimmed === 'cursor-agent' ? ['cursor-agent', 'agent'] : [trimmed];

  for (const bin of bins) {
    for (const dir of uniqueNonEmpty(searchDirs)) {
      for (const candidate of listWindowsCandidateFilesInDir(dir, bin, exts)) {
        if (/\.(exe|com)$/i.test(candidate)) {
          return { direct: { executable: candidate, prependArgs: [] } };
        }
        if (/\.(?:js|mjs|cjs)$/i.test(candidate)) {
          return { direct: { executable: process.execPath, prependArgs: [candidate] } };
        }
        if (/\.(cmd|bat)$/i.test(candidate)) {
          const plan = resolveCursorCmdLauncherPlan(candidate);
          if (plan) return plan;
        }
      }
    }
  }

  return { direct: { executable: trimmed || 'cursor-agent', prependArgs: [] } };
}

/** Resolve Cursor Agent to a directly-launchable `(executable, prependArgs)` spec (always `direct`, never PowerShell). */
export function resolveCursorExecutableForSpawn(nameOrPath = 'cursor-agent'): ResolvedExecutable {
  return resolveCursorLaunchPlan(nameOrPath).direct ?? { executable: nameOrPath.trim() || 'cursor-agent', prependArgs: [] };
}

/** Resolve a CLI path/entry for Cursor Agent (`cursor-agent` or `agent`).
 *  Uses executable regular-file checks on Unix and grounded launchability checks on Windows,
 *  mirroring `probeCursorHeadless()` search order. */
export function resolveCursorPathForSdk(name = 'cursor-agent'): string {
  const trimmed = name.trim();
  if (!trimmed) return name;
  if (process.platform === 'win32') {
    if (isAbsoluteSmart(trimmed) || hasPathSeparator(trimmed)) {
      return trimmed;
    }
    const exts = getSupportedCursorWindowsExts(process.env.PATHEXT);
    const pathDirs = (process.env.PATH ?? '').split(';');
    const searchDirs = [...pathDirs, ...getWindowsCursorSearchDirs()];
    const bins = trimmed === 'cursor-agent' ? ['cursor-agent', 'agent'] : [trimmed];
    for (const bin of bins) {
      for (const dir of uniqueNonEmpty(searchDirs)) {
        for (const candidate of listWindowsCandidateFilesInDir(dir, bin, exts)) {
          if (/\.(exe|com)$/i.test(candidate)) return candidate;
          if (/\.(cmd|bat)$/i.test(candidate) && resolveCursorCmdLauncherPlan(candidate)) {
            return candidate;
          }
        }
      }
    }
    return name;
  }
  if (isAbsoluteSmart(trimmed) || hasPathSeparator(trimmed)) {
    return trimmed;
  }
  const candidateDirs = getUnixCursorCandidateDirs();
  const bins = trimmed === 'cursor-agent' ? ['cursor-agent', 'agent'] : [trimmed];
  for (const bin of bins) {
    const found = findExecutableOnUnixDirs(bin, candidateDirs);
    if (found) return found;
  }
  return name;
}

export const KIMI_CLI_PATH_ENV = 'KIMI_CLI_PATH';

function getWindowsKimiInstallCandidates(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const basename = path.win32.basename(name);
  const hasExt = /\.[^\\/]+$/.test(basename);
  const fileNames = hasExt ? [basename] : [basename, `${basename}.exe`, `${basename}.cmd`, `${basename}.bat`];
  const kimiCodeHome = env.KIMI_CODE_HOME?.trim();
  const dirs = uniqueNonEmpty([
    kimiCodeHome ? path.win32.join(kimiCodeHome, 'bin') : undefined,
    env.USERPROFILE ? path.win32.join(env.USERPROFILE, '.kimi-code', 'bin') : undefined,
    env.USERPROFILE ? path.win32.join(env.USERPROFILE, '.local', 'bin') : undefined,
    ...getWindowsGlobalCliDirs(),
    env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'Programs', 'kimi-code', 'bin') : undefined,
    env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'bin') : undefined,
  ]);
  return dirs.flatMap((dir) => fileNames.map((fileName) => path.win32.join(dir, fileName)));
}

function getUnixKimiInstallCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME?.trim();
  const kimiCodeHome = env.KIMI_CODE_HOME?.trim();
  return uniqueNonEmpty([
    kimiCodeHome ? path.join(kimiCodeHome, 'bin', 'kimi') : undefined,
    home ? path.join(home, '.kimi-code', 'bin', 'kimi') : undefined,
    home ? path.join(home, '.local', 'bin', 'kimi') : undefined,
    home ? path.join(home, '.npm-global', 'bin', 'kimi') : undefined,
    '/opt/homebrew/bin/kimi',
    '/usr/local/bin/kimi',
    '/usr/bin/kimi',
    '/bin/kimi',
  ]);
}

/** Resolve a CLI path for Kimi Code CLI (`kimi`).
 *  Supports both Kimi Code CLI v2 (`@moonshot-ai/kimi-code`, `~/.kimi-code/bin/kimi`, `$KIMI_CODE_HOME/bin/kimi`)
 *  and legacy Python `kimi-cli` 1.x (`~/.local/bin/kimi`) under sparse daemon PATHs. */
export function resolveKimiPathForSdk(name = 'kimi', env: NodeJS.ProcessEnv = process.env): string {
  const override = name === 'kimi' ? env[KIMI_CLI_PATH_ENV]?.trim() : undefined;
  if (override && existsSync(override)) {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(override)) {
      return parseNpmCmdShim(override) ?? override;
    }
    return override;
  }
  if (process.platform === 'win32') {
    if (isAbsoluteSmart(name) || hasPathSeparator(name)) {
      if (/\.(cmd|bat)$/i.test(name)) {
        return parseNpmCmdShim(name) ?? name;
      }
      return name;
    }
    const resolved = resolveBinaryWithWindowsFallbacks(name, getWindowsKimiInstallCandidates(name, env));
    if (/\.(cmd|bat)$/i.test(resolved)) {
      return parseNpmCmdShim(resolved) ?? resolved;
    }
    return resolved;
  }
  if (name !== 'kimi') {
    if (path.isAbsolute(name) || hasPathSeparator(name)) return name;
    for (const candidate of getUnixKimiInstallCandidates(env)) {
      if (path.basename(candidate) === name && existsSync(candidate)) return candidate;
    }
    return name;
  }
  for (const candidate of getUnixKimiInstallCandidates(env)) {
    if (existsSync(candidate)) return candidate;
  }
  return name;
}


/** Result of resolving a binary that may be an npm .cmd shim.
 *  When the resolved path is a real .exe, just `{ executable }`.
 *  When it's a Windows .cmd shim, returns the underlying node script so
 *  callers can spawn `node + scriptPath` directly (works with SDKs that don't
 *  use `shell: true`). */
export interface ResolvedExecutable {
  /** Path that is safe to pass to child_process.spawn without shell:true. */
  executable: string;
  /** Extra args to prepend (e.g. the .js path when executable is node). */
  prependArgs: string[];
}

/** Resolve a CLI to a `(executable, prependArgs)` pair that's safe to pass
 *  directly to `spawn(executable, [...prependArgs, ...userArgs])` without
 *  needing `shell: true`.
 *
 *  - On non-Windows: returns the input unchanged.
 *  - On Windows .exe: returns the .exe.
 *  - On Windows .cmd npm shim: parses the shim, extracts the underlying
 *    `node script.js` invocation, and returns `(node.exe, [scriptPath])`.
 *    This is what the @anthropic-ai/claude-agent-sdk needs because it spawns
 *    `pathToClaudeCodeExecutable` directly without `shell: true`. */
export function resolveExecutableForSpawn(name: string): ResolvedExecutable {
  if (process.platform !== 'win32') {
    return { executable: name, prependArgs: [] };
  }
  const resolved = resolveBinaryOnWindows(name);
  // Real binary (.exe / .com): use directly.
  if (/\.(exe|com)$/i.test(resolved)) {
    return { executable: resolved, prependArgs: [] };
  }
  // Node entrypoint (.js / .mjs / .cjs), e.g. unwrapped from an npm .cmd shim by resolveClaudeCodePathForSdk():
  if (/\.(?:js|mjs|cjs)$/i.test(resolved)) {
    return { executable: process.execPath, prependArgs: [resolved] };
  }
  // .cmd / .bat npm shim: parse out the underlying node script path.
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const scriptPath = parseNpmCmdShim(resolved);
    if (scriptPath) {
      return { executable: process.execPath, prependArgs: [scriptPath] };
    }
    // Couldn't parse the shim — return as-is. Caller (e.g. codex-sdk) can
    // still spawn it via shell:true as a fallback.
    return { executable: resolved, prependArgs: [] };
  }
  // Fallback: pass through.
  return { executable: resolved, prependArgs: [] };
}

export function terminateChildProcess(child: ChildProcess, escalationMs = 1_500): void {
  if (child.exitCode != null || child.signalCode != null) return;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const markClosed = () => {
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  child.once('close', markClosed);
  child.kill('SIGTERM');
  timer = setTimeout(() => {
    if (!closed) child.kill('SIGKILL');
  }, escalationMs);
  timer.unref?.();
}

/** Parse an npm-generated `.cmd` shim and return the absolute path of the
 *  node script it invokes. Returns null if the shim format isn't recognized. */
export function parseNpmCmdShim(cmdPath: string): string | null {
  let content: string;
  try {
    content = readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  // npm shims contain a line like:
  //   "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
  // We extract the "...js" path. The %dp0% expands to the directory of the .cmd.
  const dp0 = path.dirname(cmdPath);
  const match = content.match(/"%dp0%[\\/]([^"]+\.(?:js|mjs|cjs))"/i);
  if (!match) return null;
  // Convert any windows-style separators in the captured path to native, then join.
  const inner = match[1].split(/[\\/]/).join(path.sep);
  return path.normalize(path.join(dp0, inner));
}
