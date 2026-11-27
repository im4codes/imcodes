import { createHash } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { imcodesStatePath } from '../util/imcodes-state-dir.js';
import { assertNotRealImcodesPathInTests } from '../util/test-home-guard.js';

export const SHELL_HISTORY_DIR_NAME = 'shell-history' as const;

const SAFE_SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;
const WINDOWS_NATIVE_SHELLS = new Set(['cmd', 'powershell', 'pwsh']);
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'ash', 'dash', 'ksh', 'mksh']);

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
 * (cmd.exe / PowerShell, or default Windows shell when no POSIX binary was requested).
 */
export function shouldSkipShellHistoryEnv(shellBin?: string | null): boolean {
  const base = shellBinBaseName(shellBin);
  if (base && WINDOWS_NATIVE_SHELLS.has(base)) return true;
  if (process.platform === 'win32') {
    return !(base && POSIX_SHELLS.has(base));
  }
  return false;
}

/**
 * Build isolated `HISTFILE` environment entry for `shell` sessions.
 * Non-shell sessions and Windows native shells return `{}`.
 */
export function shellHistoryEnv(
  sessionName: string,
  agentType: string,
  shellBin?: string | null,
): Record<string, string> {
  if (agentType !== 'shell' || shouldSkipShellHistoryEnv(shellBin)) return {};
  const filePath = resolveShellHistoryFilePath(sessionName);
  if (!filePath) return {};
  const dir = resolveShellHistoryDir();
  assertNotRealImcodesPathInTests(dir, 'shell history directory');
  assertNotRealImcodesPathInTests(filePath, 'shell history file');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { HISTFILE: filePath };
}

/**
 * Best-effort cleanup of a permanently closed/removed shell session's isolated history file.
 * Never throws if the file or directory is absent.
 */
export function cleanupShellHistoryFile(sessionName: string): void {
  const filePath = resolveShellHistoryFilePath(sessionName);
  if (!filePath) return;
  assertNotRealImcodesPathInTests(filePath, 'shell history file');
  try {
    unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw err;
  }
}
