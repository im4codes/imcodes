import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  getWindowsClaudeInstallCandidates,
  getWindowsEnvValue,
  omitWindowsEnvKeys,
  parseNpmCmdShim,
  resolveBinaryOnWindows,
  resolveBinaryWithWindowsFallbacks,
} from './transport-paths.js';
import { quoteShellArg } from '../util/shell-quote.js';

export interface WinExecutableCommand {
  program: string;
  args: string[];
}

export interface WinLaunchSpec {
  primary: WinExecutableCommand;
  fallback?: WinExecutableCommand;
}

export type ResolvedWindowsExecutable =
  | { kind: 'direct'; file: string; args: string[] }
  | { kind: 'cmd'; commandLine: string };

export interface ResolvedWindowsTarget {
  kind: 'direct' | 'cmd';
  /** Native .exe/.com path, Node binary for npm .cmd shim, or validated unparsed .cmd/.bat wrapper path. */
  executablePath: string;
  /** Parsed npm JS shim script when resolved from a .cmd/.bat wrapper. */
  npmShimScript?: string;
}

export interface ResolvedWinTargetPlan {
  primary: ResolvedWindowsTarget;
  fallback?: ResolvedWindowsTarget;
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getUserModelFlagValue(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === '--model' || args[i] === '-m') {
      return args[i + 1];
    }
  }
  return undefined;
}

function resolveCandidateOnExplicitPath(
  program: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  if (platform !== 'win32') return program;
  if (path.isAbsolute(program) && isRegularFile(program)) return program;
  // Prefer explicit PATH before fallback install dirs when PATH is populated.
  if (getWindowsEnvValue(env, 'PATH')?.trim()) {
    const fromPath = resolveBinaryOnWindows(program, omitWindowsEnvKeys(env, 'APPDATA', 'USERPROFILE'), platform);
    if (fromPath !== program) return fromPath;
  }
  const candidates = program === 'claude'
    ? getWindowsClaudeInstallCandidates(program, env)
    : [];
  return resolveBinaryWithWindowsFallbacks(program, candidates, env, platform);
}

export function resolveWindowsTargetForConpty(
  cmd: WinExecutableCommand,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedWindowsTarget {
  const resolved = resolveCandidateOnExplicitPath(cmd.program, env, platform);
  const modelValue = getUserModelFlagValue(cmd.args);

  if (/\.(cmd|bat)$/i.test(resolved)) {
    const shimScript = parseNpmCmdShim(resolved);
    if (shimScript && existsSync(shimScript)) {
      return {
        kind: 'direct',
        executablePath: getWindowsEnvValue(env, 'IMCODES_NODE_BIN') || process.execPath,
        npmShimScript: shimScript,
      };
    }
    if (modelValue !== undefined) {
      throw new Error(
        `Cannot safely forward model "${modelValue}" through unparsed Windows batch file "${resolved}" — cmd.exe cannot preserve literal special characters. Install the native Windows executable (.exe) or npm .cmd shim, or clear the custom model selection.`,
      );
    }
    return {
      kind: 'cmd',
      executablePath: resolved,
    };
  }

  if (/\.(exe|com)$/i.test(resolved)) {
    return {
      kind: 'direct',
      executablePath: resolved,
    };
  }

  // Never execute an extensionless Unix shim on Windows if one was resolved on disk.
  if (platform === 'win32' && (resolved !== cmd.program || path.isAbsolute(resolved) || resolved.includes('/') || resolved.includes('\\'))) {
    throw new Error(
      `Resolved Windows target "${resolved}" is not a launchable Windows executable (.exe, .com, .cmd, or .bat).`,
    );
  }

  return {
    kind: 'direct',
    executablePath: resolved,
  };
}

export function materializeWindowsExecutableForConpty(
  cmd: WinExecutableCommand,
  target: ResolvedWindowsTarget,
  platform: NodeJS.Platform = process.platform,
): ResolvedWindowsExecutable {
  const modelValue = getUserModelFlagValue(cmd.args);
  if (target.kind === 'cmd') {
    if (modelValue !== undefined) {
      throw new Error(
        `Cannot safely forward model "${modelValue}" through unparsed Windows batch file "${target.executablePath}" — cmd.exe cannot preserve literal special characters. Install the native Windows executable (.exe) or npm .cmd shim, or clear the custom model selection.`,
      );
    }
    return {
      kind: 'cmd',
      commandLine: [target.executablePath, ...cmd.args].map((arg) => quoteShellArg(arg, platform === 'win32' ? 'win32' : undefined)).join(' '),
    };
  }
  return {
    kind: 'direct',
    file: target.executablePath,
    args: target.npmShimScript ? [target.npmShimScript, ...cmd.args] : [...cmd.args],
  };
}

/**
 * Resolve a structured Windows command into direct executable argv without `cmd.exe`
 * when the target is a native `.exe`/`.com` binary or an npm `.cmd`/`.bat` shim wrapping
 * a JS entrypoint. Unparseable `.cmd`/`.bat` wrappers keep the `cmd.exe` compatibility
 * path when no user model value is present, and reject cleanly when a model flag is passed
 * so user model values never undergo `cmd.exe` `%VAR%` expansion or quote stripping.
 */
export function resolveWindowsExecutableForConpty(
  cmd: WinExecutableCommand,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedWindowsExecutable {
  const target = resolveWindowsTargetForConpty(cmd, env, platform);
  return materializeWindowsExecutableForConpty(cmd, target, platform);
}
