import path from 'node:path';
import { accessSync, constants as fsConstants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

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
  if (process.platform === 'win32') return true;
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
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

function resolveWindowsBinaryInDirs(name: string, dirs: string[]): string | null {
  if (isAbsoluteSmart(name) || hasPathSeparator(name)) {
    return isRegularFileSync(name) ? name : null;
  }
  const pathExtRaw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const exts = uniqueNonEmpty(pathExtRaw.split(';').flatMap((e) => [e.toLowerCase(), e]));
  const hasExt = exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase()));
  const extsToTry = hasExt ? [''] : [...exts, ''];
  for (const dir of uniqueNonEmpty(dirs)) {
    for (const ext of extsToTry) {
      const candidate = path.join(dir, name + ext);
      if (isRegularFileSync(candidate)) return candidate;
    }
  }
  return null;
}

function findBundledNodeNear(scriptPath: string, dp0: string): string {
  const scriptDir = dirnameSmart(scriptPath);
  const siblingNode = joinSmart(scriptDir, 'node.exe');
  if (isRegularFileSync(siblingNode)) return siblingNode;
  const dp0Node = joinSmart(dp0, 'node.exe');
  if (isRegularFileSync(dp0Node)) return dp0Node;
  return process.execPath;
}

function expandCmdVars(rawValue: string, dp0: string, vars: Record<string, string>): string {
  let out = rawValue.replace(/%~dp0\\?/gi, `${dp0}${path.sep}`).replace(/%dp0%[\\/]?/gi, `${dp0}${path.sep}`);
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, key: string) => {
    const upper = key.toUpperCase();
    return vars[upper] ?? process.env[key] ?? process.env[upper] ?? _m;
  });
  return path.normalize(out);
}

function parseNativeCmdLauncher(cmdPath: string, depth = 0): ResolvedExecutable | null {
  if (depth > 3) return null;
  let content: string;
  try {
    content = readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  const dp0 = dirnameSmart(cmdPath);
  const vars: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const setMatch = line.match(/^\s*set\s+(?:"([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"|([A-Za-z_][A-Za-z0-9_]*)=([^\r\n]+?))\s*$/i);
    if (!setMatch) continue;
    const key = (setMatch[1] ?? setMatch[3] ?? '').toUpperCase();
    const rawVal = (setMatch[2] ?? setMatch[4] ?? '').trim();
    if (key && rawVal) vars[key] = expandCmdVars(rawVal, dp0, vars);
  }

  // Extract explicit quoted/unquoted .js/.mjs/.cjs or .exe/.cmd paths referenced in the launcher.
  const tokenRe = /"([^"\r\n]+?\.(?:js|mjs|cjs|exe|cmd|bat))"|((?:%~dp0|%dp0%|%[A-Za-z_][A-Za-z0-9_]*%|[A-Za-z]:\\|\.?[\\/])[^\s"\r\n]+?\.(?:js|mjs|cjs|exe|cmd|bat))/gi;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(content)) !== null) {
    const rawToken = match[1] ?? match[2];
    if (!rawToken) continue;
    const expanded = expandCmdVars(rawToken, dp0, vars);
    const lowerBase = path.basename(expanded).toLowerCase();
    if (!isRegularFileSync(expanded)) continue;
    if (/\.(?:js|mjs|cjs)$/i.test(expanded)) {
      return { executable: findBundledNodeNear(expanded, dp0), prependArgs: [expanded] };
    }
    if (/\.exe$/i.test(expanded) && lowerBase !== 'node.exe' && lowerBase !== 'powershell.exe' && lowerBase !== 'cmd.exe') {
      return { executable: expanded, prependArgs: [] };
    }
    if (/\.(?:cmd|bat)$/i.test(expanded) && lowerBase !== 'promote-staged.cmd' && expanded.toLowerCase() !== cmdPath.toLowerCase()) {
      const nested = unwrapWindowsCmdWrapper(expanded, depth + 1);
      if (nested) return nested;
    }
  }

  // Official Cursor Windows installer layout fallback (`agent.cmd` / `cursor-agent.cmd` + sibling/versions tree).
  const baseName = path.basename(cmdPath).toLowerCase();
  const isCursorWrapper = baseName === 'agent.cmd' || baseName === 'cursor-agent.cmd' || /cursor-agent|index\.js|versions/i.test(content);
  if (!isCursorWrapper) return null;

  for (const exeName of ['cursor-agent.exe', 'agent.exe']) {
    const exeCandidate = joinSmart(dp0, exeName);
    if (isRegularFileSync(exeCandidate)) return { executable: exeCandidate, prependArgs: [] };
  }
  const directIndex = joinSmart(dp0, 'index.js');
  if (isRegularFileSync(directIndex)) {
    return { executable: findBundledNodeNear(directIndex, dp0), prependArgs: [directIndex] };
  }

  const versionsDir = joinSmart(dp0, 'versions');
  try {
    const entries = readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.endsWith('.new') && !entry.name.endsWith('.previous') && entry.name !== 'pending-launchers')
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const ver of entries) {
      const verDir = joinSmart(versionsDir, ver);
      for (const exeName of ['cursor-agent.exe', 'agent.exe']) {
        const exeCandidate = joinSmart(verDir, exeName);
        if (isRegularFileSync(exeCandidate)) return { executable: exeCandidate, prependArgs: [] };
      }
      const verIndex = joinSmart(verDir, 'index.js');
      if (isRegularFileSync(verIndex)) {
        return { executable: findBundledNodeNear(verIndex, dp0), prependArgs: [verIndex] };
      }
    }
  } catch {
    // No versions directory.
  }

  return null;
}

function unwrapWindowsCmdWrapper(cmdPath: string, depth = 0): ResolvedExecutable | null {
  const npmScriptPath = parseNpmCmdShim(cmdPath);
  if (npmScriptPath) {
    return { executable: process.execPath, prependArgs: [npmScriptPath] };
  }
  return parseNativeCmdLauncher(cmdPath, depth);
}

/** Resolve a CLI path for Cursor Agent (`cursor-agent` or `agent`).
 *  Uses executable regular-file checks on Unix and mirrors agent-availability search order. */
export function resolveCursorPathForSdk(name = 'cursor-agent'): string {
  const trimmed = name.trim();
  if (!trimmed) return name;
  if (process.platform === 'win32') {
    const pathDirs = (process.env.PATH ?? '').split(';');
    const searchDirs = [...pathDirs, ...getWindowsCursorSearchDirs()];
    const bins = trimmed === 'cursor-agent' ? ['cursor-agent', 'agent'] : [trimmed];
    for (const bin of bins) {
      const resolved = resolveWindowsBinaryInDirs(bin, searchDirs);
      if (!resolved) continue;
      if (/\.(cmd|bat)$/i.test(resolved)) {
        const unwrapped = unwrapWindowsCmdWrapper(resolved);
        if (unwrapped) {
          return unwrapped.prependArgs.length === 0 ? unwrapped.executable : resolved;
        }
      }
      return resolved;
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
 *  - On Windows .cmd/.bat shim (npm OR native Cursor launcher): extracts the
 *    underlying `node script.js` or native `.exe` invocation so prompts pass
 *    via argv without `shell: true`. */
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
  // .cmd / .bat shim: unwrap npm or native launcher to an executable + script args.
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const unwrapped = unwrapWindowsCmdWrapper(resolved);
    if (unwrapped) return unwrapped;
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
