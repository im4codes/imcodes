import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { imcodesStatePath } from '../util/imcodes-state-dir.js';
import logger from '../util/logger.js';
import { assertNotRealImcodesPathInTests } from '../util/test-home-guard.js';

export const SHELL_HISTORY_DIR_NAME = 'shell-history' as const;
const IMCODES_SHELL_HISTFILE_ENV = 'IMCODES_SHELL_HISTFILE' as const;
const BASH_RC_FILENAME = 'bash-rc.sh';
const ZDOTDIR_NAME = 'zdotdir';
const FISH_DATA_DIR_NAME = 'fish-data';
const IMCODES_ZSH_WRAPPER_DIR_ENV = 'IMCODES_ZSH_WRAPPER_DIR' as const;
const IMCODES_FISH_DATA_DIR_ENV = 'IMCODES_FISH_DATA_DIR' as const;
const IMCODES_ORIG_XDG_DATA_SET_ENV = 'IMCODES_ORIG_XDG_DATA_SET' as const;
const IMCODES_ORIG_XDG_DATA_HOME_ENV = 'IMCODES_ORIG_XDG_DATA_HOME' as const;

const SAFE_SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;
const FISH_SAFE_SESSION_NAME_RE = /^[A-Za-z0-9_]{1,72}$/;
const WINDOWS_NATIVE_SHELLS = new Set(['cmd', 'powershell', 'pwsh']);
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'ash', 'dash', 'ksh', 'mksh']);

const BASH_RC_WRAPPER = `# Managed by IM.codes — loads user bash startup config then enforces per-session HISTFILE.
[ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
[ -r "\${HOME}/.bashrc" ] && . "\${HOME}/.bashrc"
if [ -n "\${${IMCODES_SHELL_HISTFILE_ENV}:-}" ]; then
  HISTFILE="\${${IMCODES_SHELL_HISTFILE_ENV}}" 2>/dev/null || true
  export HISTFILE 2>/dev/null || true
fi
`;

const ZSH_RESTORE_ZDOTDIR = `if [ -n "\${IMCODES_ORIG_ZDOTDIR:-}" ]; then export ZDOTDIR="\${IMCODES_ORIG_ZDOTDIR}"; else unset ZDOTDIR; fi`;

function buildZshWrapper(rcFile: '.zshenv' | '.zprofile' | '.zshrc' | '.zlogin'): string {
  const lines = [
    '# Managed by IM.codes — forwards Zsh startup config then enforces per-session HISTFILE.',
    `if [ "\${ZDOTDIR:-}" = "\${${IMCODES_ZSH_WRAPPER_DIR_ENV}:-}" ]; then`,
    `  ${ZSH_RESTORE_ZDOTDIR}`,
    'fi',
    '_imcodes_dir="${IMCODES_ORIG_ZDOTDIR:-$HOME}"',
    `[ -r "\${_imcodes_dir}/${rcFile}" ] && . "\${_imcodes_dir}/${rcFile}"`,
    'unset _imcodes_dir',
    `if [ -n "\${ZDOTDIR:-}" ] && [ "\${ZDOTDIR}" != "\${${IMCODES_ZSH_WRAPPER_DIR_ENV}:-}" ]; then`,
    '  IMCODES_ORIG_ZDOTDIR="${ZDOTDIR}"',
    '  export IMCODES_ORIG_ZDOTDIR',
    'elif [ -z "${ZDOTDIR:-}" ]; then',
    '  unset IMCODES_ORIG_ZDOTDIR',
    'fi',
    `if [ -n "\${${IMCODES_SHELL_HISTFILE_ENV}:-}" ]; then`,
    `  HISTFILE="\${${IMCODES_SHELL_HISTFILE_ENV}}" 2>/dev/null || true`,
    '  export HISTFILE 2>/dev/null || true',
    'fi',
  ];

  if (rcFile === '.zshenv') {
    lines.push(
      'if [ ! -o interactive ] && [ ! -o login ]; then',
      `  ${ZSH_RESTORE_ZDOTDIR}`,
      `elif [ -n "\${${IMCODES_ZSH_WRAPPER_DIR_ENV}:-}" ]; then`,
      `  export ZDOTDIR="\${${IMCODES_ZSH_WRAPPER_DIR_ENV}}"`,
      'fi',
    );
  } else if (rcFile === '.zprofile') {
    lines.push(
      `if [ -n "\${${IMCODES_ZSH_WRAPPER_DIR_ENV}:-}" ]; then`,
      `  export ZDOTDIR="\${${IMCODES_ZSH_WRAPPER_DIR_ENV}}"`,
      'fi',
    );
  } else if (rcFile === '.zshrc') {
    lines.push(
      'if [ ! -o login ]; then',
      `  ${ZSH_RESTORE_ZDOTDIR}`,
      `elif [ -n "\${${IMCODES_ZSH_WRAPPER_DIR_ENV}:-}" ]; then`,
      `  export ZDOTDIR="\${${IMCODES_ZSH_WRAPPER_DIR_ENV}}"`,
      'fi',
    );
  } else {
    lines.push(ZSH_RESTORE_ZDOTDIR);
  }

  return `${lines.join('\n')}\n`;
}

const ZSH_ENV_WRAPPER = buildZshWrapper('.zshenv');
const ZSH_PROFILE_WRAPPER = buildZshWrapper('.zprofile');
const ZSH_RC_WRAPPER = buildZshWrapper('.zshrc');
const ZSH_LOGIN_WRAPPER = buildZshWrapper('.zlogin');

/** True for non-agent raw terminal sessions (`shell` or `script`) that must never receive AI prompts. */
export function isShellLikeAgentType(agentType?: string | null): boolean {
  return agentType === 'shell' || agentType === 'script';
}

/** Resolve the effective shell binary shared by ShellDriver and shell-history isolation. */
export function resolveShellBin(shellBin?: string | null): string {
  const trimmed = shellBin?.trim();
  if (trimmed) return trimmed;
  return process.env.SHELL?.trim()
    || (process.platform === 'win32' ? (process.env.COMSPEC?.trim() || 'powershell.exe') : '/bin/bash');
}

/**
 * Sanitize an arbitrary session name into a collision-resistant filename stem
 * inside `<imcodesDir>/shell-history/`.
 */
export function sanitizeShellHistorySessionName(sessionName: string): string {
  const trimmed = sessionName.trim();
  if (SAFE_SESSION_NAME_RE.test(trimmed)) return trimmed;
  const cleaned = trimmed
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  const hash8 = createHash('sha256').update(sessionName).digest('hex').slice(0, 8);
  return `${cleaned || 'session'}-${hash8}`;
}

/** Resolve the shell-history directory inside IM.codes' state directory. */
export function resolveShellHistoryDir(): string {
  return imcodesStatePath(SHELL_HISTORY_DIR_NAME);
}

function isPathInsideDir(dir: string, target: string): boolean {
  const rel = relative(dir, target);
  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes('/') && !rel.includes('\\'));
}

/**
 * Resolve the path-confined isolated history file for `sessionName`.
 * Returns `undefined` if containment fails or `sessionName` is unusable.
 */
export function resolveShellHistoryFilePath(sessionName: string): string | undefined {
  if (!sessionName || !sessionName.trim()) return undefined;
  const dir = resolve(resolveShellHistoryDir());
  const fileName = `${sanitizeShellHistorySessionName(sessionName)}.history`;
  const target = resolve(join(dir, fileName));
  return isPathInsideDir(dir, target) ? target : undefined;
}

/**
 * Deterministic, collision-resistant Fish `fish_history` session identifier
 * (`^[A-Za-z_][A-Za-z0-9_]*$`, never Fish's default `fish`).
 */
export function resolveFishHistoryName(sessionName: string): string | undefined {
  if (!sessionName || !sessionName.trim()) return undefined;
  const trimmed = sessionName.trim();
  if (FISH_SAFE_SESSION_NAME_RE.test(trimmed)) return `imcodes_${trimmed}`;
  const cleaned = trimmed
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56);
  const hash8 = createHash('sha256').update(sessionName).digest('hex').slice(0, 8);
  return `imcodes_${cleaned || 'session'}_${hash8}`;
}

/** Resolve IM.codes' isolated XDG_DATA_HOME root for Fish shell history. */
export function resolveFishDataDir(): string {
  return join(resolveShellHistoryDir(), FISH_DATA_DIR_NAME);
}

/** Resolve the path-confined Fish history file (`<fish-data>/fish/<fish_history>_history`). */
export function resolveFishHistoryFilePath(sessionName: string): string | undefined {
  const fishHistoryName = resolveFishHistoryName(sessionName);
  if (!fishHistoryName) return undefined;
  const fishDir = resolve(join(resolveFishDataDir(), 'fish'));
  const target = resolve(join(fishDir, `${fishHistoryName}_history`));
  return isPathInsideDir(fishDir, target) ? target : undefined;
}

function shellBinBaseName(shellBin?: string | null): string | undefined {
  if (!shellBin || !shellBin.trim()) return undefined;
  const segments = shellBin.trim().split(/[/\\]/);
  const last = segments[segments.length - 1] ?? '';
  if (!last) return undefined;
  return basename(last).toLowerCase().replace(/\.exe$/, '');
}

/**
 * True when launching this shell does not consume POSIX `HISTFILE`
 * (cmd.exe / PowerShell, or default Windows shell when no POSIX binary was requested/configured).
 */
export function shouldSkipShellHistoryEnv(shellBin?: string | null): boolean {
  const effectiveBin = resolveShellBin(shellBin);
  const base = shellBinBaseName(effectiveBin);
  if (base && WINDOWS_NATIVE_SHELLS.has(base)) return true;
  if (process.platform === 'win32') {
    return !(base && POSIX_SHELLS.has(base));
  }
  return false;
}

function writeIfChanged(filePath: string, content: string): void {
  assertNotRealImcodesPathInTests(filePath, 'shell history wrapper file');
  try {
    if (readFileSync(filePath, 'utf8') === content) return;
  } catch {
    // Missing or unreadable — write fresh wrapper.
  }
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
}

function ensureHistoryDir(): string {
  const dir = resolveShellHistoryDir();
  assertNotRealImcodesPathInTests(dir, 'shell history directory');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function ensureBashRcWrapper(): string {
  const dir = ensureHistoryDir();
  const rcPath = join(dir, BASH_RC_FILENAME);
  writeIfChanged(rcPath, BASH_RC_WRAPPER);
  return rcPath;
}

function ensureZshZdotDirWrapper(): string {
  const dir = ensureHistoryDir();
  const zdotDir = join(dir, ZDOTDIR_NAME);
  assertNotRealImcodesPathInTests(zdotDir, 'shell history zdotdir');
  mkdirSync(zdotDir, { recursive: true, mode: 0o700 });
  writeIfChanged(join(zdotDir, '.zshenv'), ZSH_ENV_WRAPPER);
  writeIfChanged(join(zdotDir, '.zprofile'), ZSH_PROFILE_WRAPPER);
  writeIfChanged(join(zdotDir, '.zshrc'), ZSH_RC_WRAPPER);
  writeIfChanged(join(zdotDir, '.zlogin'), ZSH_LOGIN_WRAPPER);
  return zdotDir;
}

function ensureFishDataDir(): string {
  const dataDir = resolveFishDataDir();
  const fishSubdir = join(dataDir, 'fish');
  assertNotRealImcodesPathInTests(fishSubdir, 'fish shell history directory');
  mkdirSync(fishSubdir, { recursive: true, mode: 0o700 });
  return dataDir;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellArgQuote(value: string): string {
  if (process.platform === 'win32') {
    return JSON.stringify(value.replace(/\\/g, '/'));
  }
  return shellSingleQuote(value);
}

function buildFishInitCommand(fishHistoryName: string): string {
  return [
    `set -g fish_history ${fishHistoryName}`,
    `if test "$XDG_DATA_HOME" = "$${IMCODES_FISH_DATA_DIR_ENV}"`,
    `if test "$${IMCODES_ORIG_XDG_DATA_SET_ENV}" = 1`,
    `set -gx XDG_DATA_HOME "$${IMCODES_ORIG_XDG_DATA_HOME_ENV}"`,
    'else',
    'set -e XDG_DATA_HOME',
    'end',
    'end',
    `set -e ${IMCODES_FISH_DATA_DIR_ENV} ${IMCODES_ORIG_XDG_DATA_SET_ENV} ${IMCODES_ORIG_XDG_DATA_HOME_ENV}`,
  ].join('; ');
}

/**
 * Extra launch arguments for interactive shells whose history isolation requires startup flags:
 * - POSIX / Windows Git Bash: `--rcfile` wrapper enforcing per-session `HISTFILE`
 * - Fish: `-C '...'` enforcing per-session `fish_history` and restoring original `XDG_DATA_HOME`
 *   before user commands run so child processes keep their normal XDG data path
 * Returns `''` for native Windows shells (`cmd`, `powershell`, `pwsh`) and other POSIX shells.
 */
export function buildShellHistoryLaunchArgs(shellBin?: string | null, sessionName?: string): string {
  const base = shellBinBaseName(resolveShellBin(shellBin));
  if (base === 'bash') {
    const rcPath = ensureBashRcWrapper();
    return ` --rcfile ${shellArgQuote(rcPath)}`;
  }
  if (base === 'fish' && sessionName) {
    const fishHistoryName = resolveFishHistoryName(sessionName);
    if (!fishHistoryName) return '';
    return ` -C ${shellArgQuote(buildFishInitCommand(fishHistoryName))}`;
  }
  return '';
}

/**
 * Build isolated history environment entries (plus shell-specific startup enforcement vars)
 * for `shell` sessions. Non-shell sessions and Windows native shells return `{}`.
 */
export function shellHistoryEnv(
  sessionName: string,
  agentType: string,
  shellBin?: string | null,
): Record<string, string> {
  if (agentType !== 'shell' || shouldSkipShellHistoryEnv(shellBin)) return {};
  const base = shellBinBaseName(resolveShellBin(shellBin));
  if (base === 'fish') {
    const fishHistPath = resolveFishHistoryFilePath(sessionName);
    if (!fishHistPath) return {};
    const fishDataDir = ensureFishDataDir();
    assertNotRealImcodesPathInTests(fishHistPath, 'fish shell history file');
    const origXdgDataHome = process.env.XDG_DATA_HOME;
    const fishEnv: Record<string, string> = {
      XDG_DATA_HOME: fishDataDir,
      [IMCODES_FISH_DATA_DIR_ENV]: fishDataDir,
      [IMCODES_ORIG_XDG_DATA_SET_ENV]: origXdgDataHome !== undefined ? '1' : '0',
    };
    if (origXdgDataHome !== undefined) {
      fishEnv[IMCODES_ORIG_XDG_DATA_HOME_ENV] = origXdgDataHome;
    }
    return fishEnv;
  }

  const filePath = resolveShellHistoryFilePath(sessionName);
  if (!filePath) return {};
  ensureHistoryDir();
  assertNotRealImcodesPathInTests(filePath, 'shell history file');

  const env: Record<string, string> = {
    HISTFILE: filePath,
    [IMCODES_SHELL_HISTFILE_ENV]: filePath,
  };
  if (base === 'bash') {
    ensureBashRcWrapper();
  } else if (process.platform !== 'win32' && base === 'zsh') {
    const zdotDir = ensureZshZdotDirWrapper();
    env[IMCODES_ZSH_WRAPPER_DIR_ENV] = zdotDir;
    if (process.env.ZDOTDIR?.trim()) {
      env.IMCODES_ORIG_ZDOTDIR = process.env.ZDOTDIR.trim();
    }
    env.ZDOTDIR = zdotDir;
  }
  return env;
}

function unlinkHistoryTarget(filePath: string | undefined, sessionName: string, label: string): void {
  if (!filePath) return;
  assertNotRealImcodesPathInTests(filePath, label);
  try {
    unlinkSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      logger.warn({ err, code, sessionName, filePath }, `Failed to remove isolated ${label}`);
    }
  }
}

/**
 * Best-effort cleanup of a permanently closed/removed shell session's isolated history file
 * (POSIX HISTFILE and/or Fish per-session history file).
 * Logs a bounded warning on non-ENOENT I/O errors and continues cleanly so session close stays committed.
 */
export function cleanupShellHistoryFile(sessionName: string): void {
  unlinkHistoryTarget(resolveShellHistoryFilePath(sessionName), sessionName, 'shell history file');
  unlinkHistoryTarget(resolveFishHistoryFilePath(sessionName), sessionName, 'fish shell history file');
}
