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

const SAFE_SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;
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

const ZSH_ENV_WRAPPER = `# Managed by IM.codes — forwards Zsh env/profile startup then enforces per-session HISTFILE.
_imcodes_dir="\${IMCODES_ORIG_ZDOTDIR:-$HOME}"
[ -r "\${_imcodes_dir}/.zshenv" ] && . "\${_imcodes_dir}/.zshenv"
unset _imcodes_dir
if [ -n "\${${IMCODES_SHELL_HISTFILE_ENV}:-}" ]; then
  HISTFILE="\${${IMCODES_SHELL_HISTFILE_ENV}}" 2>/dev/null || true
  export HISTFILE 2>/dev/null || true
fi
`;

const ZSH_PROFILE_WRAPPER = `# Managed by IM.codes
_imcodes_dir="\${IMCODES_ORIG_ZDOTDIR:-$HOME}"
[ -r "\${_imcodes_dir}/.zprofile" ] && . "\${_imcodes_dir}/.zprofile"
unset _imcodes_dir
if [ -n "\${${IMCODES_SHELL_HISTFILE_ENV}:-}" ]; then
  HISTFILE="\${${IMCODES_SHELL_HISTFILE_ENV}}" 2>/dev/null || true
  export HISTFILE 2>/dev/null || true
fi
`;

const ZSH_RC_WRAPPER = `# Managed by IM.codes
_imcodes_dir="\${IMCODES_ORIG_ZDOTDIR:-$HOME}"
[ -r "\${_imcodes_dir}/.zshrc" ] && . "\${_imcodes_dir}/.zshrc"
unset _imcodes_dir
if [ -n "\${${IMCODES_SHELL_HISTFILE_ENV}:-}" ]; then
  HISTFILE="\${${IMCODES_SHELL_HISTFILE_ENV}}" 2>/dev/null || true
  export HISTFILE 2>/dev/null || true
fi
if [ ! -o login ]; then
  if [ -n "\${IMCODES_ORIG_ZDOTDIR:-}" ]; then export ZDOTDIR="\${IMCODES_ORIG_ZDOTDIR}"; else unset ZDOTDIR; fi
fi
`;

const ZSH_LOGIN_WRAPPER = `# Managed by IM.codes
_imcodes_dir="\${IMCODES_ORIG_ZDOTDIR:-$HOME}"
[ -r "\${_imcodes_dir}/.zlogin" ] && . "\${_imcodes_dir}/.zlogin"
unset _imcodes_dir
if [ -n "\${${IMCODES_SHELL_HISTFILE_ENV}:-}" ]; then
  HISTFILE="\${${IMCODES_SHELL_HISTFILE_ENV}}" 2>/dev/null || true
  export HISTFILE 2>/dev/null || true
fi
if [ -n "\${IMCODES_ORIG_ZDOTDIR:-}" ]; then export ZDOTDIR="\${IMCODES_ORIG_ZDOTDIR}"; else unset ZDOTDIR; fi
`;

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

/**
 * Resolve the path-confined isolated history file for `sessionName`.
 * Returns `undefined` if containment fails or `sessionName` is unusable.
 */
export function resolveShellHistoryFilePath(sessionName: string): string | undefined {
  if (!sessionName || !sessionName.trim()) return undefined;
  const dir = resolve(resolveShellHistoryDir());
  const fileName = `${sanitizeShellHistorySessionName(sessionName)}.history`;
  const target = resolve(join(dir, fileName));
  const rel = relative(dir, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) {
    return undefined;
  }
  return target;
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

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Extra launch arguments for interactive POSIX bash so user startup config runs
 * while IM.codes' isolated `IMCODES_SHELL_HISTFILE` overrides any RC `HISTFILE` assignment
 * before bash loads or saves history. Returns `''` for non-bash or Windows spawns.
 */
export function buildShellHistoryLaunchArgs(shellBin?: string | null): string {
  if (process.platform === 'win32') return '';
  const base = shellBinBaseName(resolveShellBin(shellBin));
  if (base !== 'bash') return '';
  const rcPath = ensureBashRcWrapper();
  return ` --rcfile ${shellSingleQuote(rcPath)}`;
}

/**
 * Build isolated `HISTFILE` environment entry (plus bash/zsh startup enforcement vars)
 * for `shell` sessions. Non-shell sessions and Windows native shells return `{}`.
 */
export function shellHistoryEnv(
  sessionName: string,
  agentType: string,
  shellBin?: string | null,
): Record<string, string> {
  if (agentType !== 'shell' || shouldSkipShellHistoryEnv(shellBin)) return {};
  const filePath = resolveShellHistoryFilePath(sessionName);
  if (!filePath) return {};
  ensureHistoryDir();
  assertNotRealImcodesPathInTests(filePath, 'shell history file');

  const base = shellBinBaseName(resolveShellBin(shellBin));
  const env: Record<string, string> = {
    HISTFILE: filePath,
    [IMCODES_SHELL_HISTFILE_ENV]: filePath,
  };
  if (process.platform !== 'win32') {
    if (base === 'bash') {
      ensureBashRcWrapper();
    } else if (base === 'zsh') {
      const zdotDir = ensureZshZdotDirWrapper();
      if (process.env.ZDOTDIR?.trim()) {
        env.IMCODES_ORIG_ZDOTDIR = process.env.ZDOTDIR.trim();
      }
      env.ZDOTDIR = zdotDir;
    }
  }
  return env;
}

/**
 * Best-effort cleanup of a permanently closed/removed shell session's isolated history file.
 * Logs a bounded warning on non-ENOENT I/O errors and continues cleanly so session close stays committed.
 */
export function cleanupShellHistoryFile(sessionName: string): void {
  const filePath = resolveShellHistoryFilePath(sessionName);
  if (!filePath) return;
  assertNotRealImcodesPathInTests(filePath, 'shell history file');
  try {
    unlinkSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      logger.warn({ err, code, sessionName, filePath }, 'Failed to remove isolated shell history file');
    }
  }
}
