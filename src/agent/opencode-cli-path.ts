import { execFileSync } from 'node:child_process';
import { constants as fsConstants, statSync, accessSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const WIN_ADMIN_CHECK = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -eq "S-1-5-18")',
] as const;

let cachedWin32Elevated: boolean | null = null;

export interface ResolveOpenCodeCliOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  isElevated?: boolean | (() => boolean);
  isExecutableFile?: (filePath: string) => Promise<boolean>;
  isExecutableFileSync?: (filePath: string) => boolean;
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

export function isOpenCodeCallerElevated(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'linux' || platform === 'darwin') {
    return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  }
  if (platform === 'win32') {
    if (process.platform !== 'win32') return false;
    if (cachedWin32Elevated !== null) return cachedWin32Elevated;
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    const candidates = [
      path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      'powershell.exe',
    ];
    for (const ps of candidates) {
      try {
        const out = execFileSync(ps, [...WIN_ADMIN_CHECK], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        cachedWin32Elevated = out.trim().toLowerCase() === 'true';
        return cachedWin32Elevated;
      } catch {
        // Try next candidate
      }
    }
    cachedWin32Elevated = true;
    return true;
  }
  return false;
}

function canUseOpenCodeHomeFallback(
  platform: NodeJS.Platform,
  homeDir: string,
  isElevatedOption?: boolean | (() => boolean),
): boolean {
  if (!homeDir || !homeDir.trim()) return false;
  const elevated = typeof isElevatedOption === 'function'
    ? isElevatedOption()
    : typeof isElevatedOption === 'boolean'
      ? isElevatedOption
      : isOpenCodeCallerElevated(platform);
  if (!elevated) return true;
  return platform !== 'win32' && homeDir === '/root';
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

  if (canUseOpenCodeHomeFallback(platform, homeDir, opts.isElevated)) {
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

  if (canUseOpenCodeHomeFallback(platform, homeDir, opts.isElevated)) {
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
