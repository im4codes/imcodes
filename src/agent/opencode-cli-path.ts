import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
export const OPENCODE_PRIVILEGE_PROBE_TIMEOUT_MS = 2_000;

const WIN_ADMIN_CHECK = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -eq "S-1-5-18")',
] as const;

let cachedWin32Elevated: boolean | null = null;

export function __resetOpenCodeElevationCacheForTests(): void {
  cachedWin32Elevated = null;
}

export interface ResolveOpenCodeCliOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  isElevated?: boolean | (() => boolean);
  isExecutableFile?: (filePath: string) => Promise<boolean>;
  isExecutableFileSync?: (filePath: string) => boolean;
  runPrivilegeProbeSync?: (file: string, args: readonly string[], timeoutMs: number) => string;
  runPrivilegeProbeAsync?: (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;
}

export interface ResolvedOpenCodeCli {
  executable: string;
  resolvedPath?: string;
  source: 'path' | 'home_bin' | 'missing';
}

function readEnvCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (key in env) return env[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function defaultIsFileExecutableSync(filePath: string, platform: NodeJS.Platform): boolean {
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

async function defaultIsFileExecutable(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    if (platform === 'win32') return true;
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getTrustedWindowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = readEnvCaseInsensitive(env, 'SystemRoot') ?? readEnvCaseInsensitive(env, 'WINDIR') ?? 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function parseExplicitElevationOutput(rawOutput: unknown): boolean | null {
  if (typeof rawOutput !== 'string') return null;
  const normalized = rawOutput.trim().toLowerCase();
  if (normalized === 'false') return false;
  if (normalized === 'true') return true;
  return null;
}

export function isOpenCodeCallerElevated(
  platform: NodeJS.Platform = process.platform,
  opts: Pick<ResolveOpenCodeCliOptions, 'env' | 'runPrivilegeProbeSync'> = {},
): boolean {
  if (platform === 'linux' || platform === 'darwin') {
    return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  }
  if (platform === 'win32') {
    const useCache = !opts.runPrivilegeProbeSync && !opts.env;
    if (useCache && cachedWin32Elevated !== null) return cachedWin32Elevated;
    const psExe = getTrustedWindowsPowerShellPath(opts.env);
    const runSync = opts.runPrivilegeProbeSync ?? ((file, args, timeoutMs) =>
      execFileSync(file, [...args], {
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
    try {
      const parsed = parseExplicitElevationOutput(runSync(psExe, WIN_ADMIN_CHECK, OPENCODE_PRIVILEGE_PROBE_TIMEOUT_MS));
      if (parsed !== null) {
        if (useCache) cachedWin32Elevated = parsed;
        return parsed;
      }
      // Ambiguous/empty output fails closed (never grant user-dir fallback unless explicitly confirmed 'false')
      return true;
    } catch {
      return true;
    }
  }
  return false;
}

export async function isOpenCodeCallerElevatedAsync(
  platform: NodeJS.Platform = process.platform,
  opts: Pick<ResolveOpenCodeCliOptions, 'env' | 'runPrivilegeProbeAsync'> = {},
): Promise<boolean> {
  if (platform === 'linux' || platform === 'darwin') {
    return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  }
  if (platform === 'win32') {
    const useCache = !opts.runPrivilegeProbeAsync && !opts.env;
    if (useCache && cachedWin32Elevated !== null) return cachedWin32Elevated;
    const psExe = getTrustedWindowsPowerShellPath(opts.env);
    const runAsync = opts.runPrivilegeProbeAsync ?? (async (file, args, timeoutMs) => {
      const { stdout } = await execFileAsync(file, [...args], {
        encoding: 'utf8',
        timeout: timeoutMs,
      });
      return stdout;
    });
    try {
      const parsed = parseExplicitElevationOutput(await runAsync(psExe, WIN_ADMIN_CHECK, OPENCODE_PRIVILEGE_PROBE_TIMEOUT_MS));
      if (parsed !== null) {
        if (useCache) cachedWin32Elevated = parsed;
        return parsed;
      }
      return true;
    } catch {
      return true;
    }
  }
  return false;
}

function canUseHomeWithElevationResult(platform: NodeJS.Platform, homeDir: string, elevated: boolean): boolean {
  if (!homeDir || !homeDir.trim()) return false;
  if (!elevated) return true;
  return platform !== 'win32' && homeDir === '/root';
}

function canUseOpenCodeHomeFallbackSync(platform: NodeJS.Platform, homeDir: string, opts: ResolveOpenCodeCliOptions): boolean {
  if (!homeDir || !homeDir.trim()) return false;
  const elevated = typeof opts.isElevated === 'function'
    ? opts.isElevated()
    : typeof opts.isElevated === 'boolean'
      ? opts.isElevated
      : isOpenCodeCallerElevated(platform, opts);
  return canUseHomeWithElevationResult(platform, homeDir, elevated);
}

async function canUseOpenCodeHomeFallbackAsync(platform: NodeJS.Platform, homeDir: string, opts: ResolveOpenCodeCliOptions): Promise<boolean> {
  if (!homeDir || !homeDir.trim()) return false;
  const elevated = typeof opts.isElevated === 'function'
    ? opts.isElevated()
    : typeof opts.isElevated === 'boolean'
      ? opts.isElevated
      : await isOpenCodeCallerElevatedAsync(platform, opts);
  return canUseHomeWithElevationResult(platform, homeDir, elevated);
}

function listOpenCodePathCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const rawPath = (platform === 'win32' ? readEnvCaseInsensitive(env, 'PATH') : env.PATH) ?? '';
  const dirs = rawPath.split(delimiter).map((d) => d.trim()).filter(Boolean);
  if (platform === 'win32') {
    const rawExt = readEnvCaseInsensitive(env, 'PATHEXT') ?? DEFAULT_PATHEXT;
    const exts = rawExt.split(';').map((e) => e.trim()).filter(Boolean);
    const names = [...new Set(['opencode.exe', ...exts.map((e) => `opencode${e.toLowerCase()}`), 'opencode'])];
    const out: string[] = [];
    for (const dir of dirs) {
      for (const name of names) {
        out.push(p.join(dir, name));
      }
    }
    return out;
  }
  return dirs.map((dir) => p.join(dir, 'opencode'));
}

function getOpenCodeHomeBinaryPath(platform: NodeJS.Platform, homeDir: string): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(homeDir, '.opencode', 'bin', platform === 'win32' ? 'opencode.exe' : 'opencode');
}

export async function resolveOpenCodeCliAsync(opts: ResolveOpenCodeCliOptions = {}): Promise<ResolvedOpenCodeCli> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const isExec = opts.isExecutableFile ?? ((filePath: string) => defaultIsFileExecutable(filePath, platform));

  for (const candidate of listOpenCodePathCandidates(platform, env)) {
    if (await isExec(candidate)) {
      return { executable: 'opencode', resolvedPath: candidate, source: 'path' };
    }
  }

  if (await canUseOpenCodeHomeFallbackAsync(platform, homeDir, opts)) {
    const homeBin = getOpenCodeHomeBinaryPath(platform, homeDir);
    if (await isExec(homeBin)) {
      return { executable: homeBin, resolvedPath: homeBin, source: 'home_bin' };
    }
  }

  return { executable: 'opencode', source: 'missing' };
}

export function resolveOpenCodeCliSync(opts: ResolveOpenCodeCliOptions = {}): ResolvedOpenCodeCli {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const isExec = opts.isExecutableFileSync ?? ((filePath: string) => defaultIsFileExecutableSync(filePath, platform));

  for (const candidate of listOpenCodePathCandidates(platform, env)) {
    if (isExec(candidate)) {
      return { executable: 'opencode', resolvedPath: candidate, source: 'path' };
    }
  }

  if (canUseOpenCodeHomeFallbackSync(platform, homeDir, opts)) {
    const homeBin = getOpenCodeHomeBinaryPath(platform, homeDir);
    if (isExec(homeBin)) {
      return { executable: homeBin, resolvedPath: homeBin, source: 'home_bin' };
    }
  }

  return { executable: 'opencode', source: 'missing' };
}

export function quoteShellBinary(bin: string, platform: NodeJS.Platform = process.platform): string {
  if (bin === 'opencode') return 'opencode';
  if (platform === 'win32') return `"${bin}"`;
  return `'${bin.replace(/'/gu, `'\\''`)}'`;
}
