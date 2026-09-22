import { execFile } from 'node:child_process';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { normalizeChatFileReference } from '../../shared/chat-local-path.js';
import { FS_GENERIC_ERROR_CODES, type FsGenericErrorCode } from '../../shared/fs-error-codes.js';
import { isFilePreviewPathAllowed } from './file-preview-path-policy.js';

const execFileAsync = promisify(execFile);
const SEARCH_MAX_DEPTH = 4;
const SEARCH_MAX_ENTRIES = 2_000;
const ATTEMPT_REPORT_LIMIT = 16;

export interface ChatFileReferenceResolution {
  ok: true;
  realPath: string;
  attemptedLocations: string[];
  matchCount: number;
}

export interface ChatFileReferenceResolutionError {
  ok: false;
  error: FsGenericErrorCode;
  attemptedLocations: string[];
}

export type ChatFileReferenceResolutionResult = ChatFileReferenceResolution | ChatFileReferenceResolutionError;

interface CandidateRoot {
  label: 'cwd' | 'worktree' | 'project' | 'home';
  path: string;
}

function sameOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeForCompare(value: string): string {
  return value.normalize('NFC');
}

function safeAttemptLabel(label: string, relative: string): string {
  const cleaned = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  return `${label}:${cleaned || '.'}`;
}

function uniqueRoots(input: Array<CandidateRoot | null | undefined>): CandidateRoot[] {
  const seen = new Set<string>();
  const roots: CandidateRoot[] = [];
  for (const item of input) {
    if (!item) continue;
    const resolved = path.resolve(item.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push({ ...item, path: resolved });
  }
  return roots;
}

export async function resolveGitWorktreeRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeout: 3_000,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
    });
    return await realpath(String(stdout).trim());
  } catch {
    return null;
  }
}

function isPermissionError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  return code === 'EACCES' || code === 'EPERM';
}

async function unicodeEquivalentPath(candidate: string): Promise<{ path: string | null; forbidden: boolean }> {
  const resolved = path.resolve(candidate);
  try {
    await lstat(resolved);
    return { path: resolved, forbidden: false };
  } catch (error) {
    if (isPermissionError(error)) return { path: null, forbidden: true };
    // Continue with a bounded component-by-component NFC/NFD lookup. This is
    // needed when an AI emits NFC but the Linux filesystem entry is NFD (or the
    // inverse). It does not perform a recursive search.
  }
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    let names: string[];
    try {
      names = await readdir(current);
    } catch (error) {
      return { path: null, forbidden: isPermissionError(error) };
    }
    const exact = names.find((name) => name === segment);
    const equivalent = exact ?? names.find((name) => normalizeForCompare(name) === normalizeForCompare(segment));
    if (!equivalent) return { path: null, forbidden: false };
    current = path.join(current, equivalent);
  }
  return { path: current, forbidden: false };
}

async function inspectCandidate(
  candidate: string,
  allowedRoots: string[],
  allowPublishedAbsolute: boolean,
): Promise<{ ok: true; realPath: string; mtimeMs: number } | { ok: false; forbidden: boolean }> {
  const equivalent = await unicodeEquivalentPath(candidate);
  if (!equivalent.path) return { ok: false, forbidden: equivalent.forbidden };
  const lexical = path.resolve(equivalent.path);
  if (!allowPublishedAbsolute && !allowedRoots.some((root) => sameOrInside(root, lexical))) {
    return { ok: false, forbidden: true };
  }
  try {
    const link = await lstat(lexical);
    if (link.isSymbolicLink() || !link.isFile()) return { ok: false, forbidden: true };
    const canonical = await realpath(lexical);
    if (!isFilePreviewPathAllowed(canonical)) return { ok: false, forbidden: true };
    const canonicalRoots = await Promise.all(allowedRoots.map(async (root) => {
      try { return await realpath(root); } catch { return root; }
    }));
    if (!allowPublishedAbsolute && !canonicalRoots.some((root) => sameOrInside(root, canonical))) {
      return { ok: false, forbidden: true };
    }
    const metadata = await stat(canonical);
    return { ok: true, realPath: canonical, mtimeMs: metadata.mtimeMs };
  } catch {
    return { ok: false, forbidden: false };
  }
}

async function searchByBasename(
  cwd: string,
  basename: string,
  allowedRoots: string[],
): Promise<Array<{ realPath: string; mtimeMs: number }>> {
  const target = normalizeForCompare(basename);
  const matches: Array<{ realPath: string; mtimeMs: number }> = [];
  let visited = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > SEARCH_MAX_DEPTH || visited >= SEARCH_MAX_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++visited > SEARCH_MAX_ENTRIES) return;
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && normalizeForCompare(entry.name) === target) {
        const inspected = await inspectCandidate(candidate, allowedRoots, false);
        if (inspected.ok) matches.push({ realPath: inspected.realPath, mtimeMs: inspected.mtimeMs });
      } else if (entry.isDirectory() && depth < SEARCH_MAX_DEPTH && entry.name !== '.git' && entry.name !== 'node_modules') {
        await walk(candidate, depth + 1);
      }
    }
  };
  await walk(cwd, 0);
  return matches.sort((left, right) => right.mtimeMs - left.mtimeMs || left.realPath.localeCompare(right.realPath));
}

export async function resolveChatFileReference(input: {
  reference: string;
  cwd: string;
  worktreeRoot?: string | null;
  projectRoot?: string | null;
  homeDir?: string;
}): Promise<ChatFileReferenceResolutionResult> {
  const reference = normalizeChatFileReference(input.reference);
  if (!reference) return { ok: false, error: FS_GENERIC_ERROR_CODES.INVALID_REQUEST, attemptedLocations: [] };
  const home = path.resolve(input.homeDir ?? homedir());
  const roots = uniqueRoots([
    { label: 'cwd', path: input.cwd },
    input.worktreeRoot ? { label: 'worktree', path: input.worktreeRoot } : null,
    input.projectRoot ? { label: 'project', path: input.projectRoot } : null,
    { label: 'home', path: home },
  ]);
  const allowedRoots = roots.map((root) => root.path);
  const attempts: string[] = [];
  let sawForbidden = false;
  const tryCandidate = async (
    candidate: string,
    label: string,
    reportValue: string,
    allowPublishedAbsolute: boolean,
  ) => {
    if (attempts.length < ATTEMPT_REPORT_LIMIT) attempts.push(safeAttemptLabel(label, reportValue));
    const inspected = await inspectCandidate(candidate, allowedRoots, allowPublishedAbsolute);
    if (!inspected.ok) {
      sawForbidden ||= inspected.forbidden;
      return null;
    }
    return inspected;
  };

  const tildeExpanded = reference.startsWith('~/') || reference.startsWith('~\\')
    ? path.join(home, reference.slice(2))
    : reference;
  const absolute = path.isAbsolute(tildeExpanded) || /^[A-Za-z]:[/\\]/.test(tildeExpanded);
  if (absolute) {
    const directLabel = sameOrInside(home, path.resolve(tildeExpanded))
      ? path.relative(home, path.resolve(tildeExpanded))
      : path.basename(tildeExpanded);
    const direct = await tryCandidate(
      tildeExpanded,
      sameOrInside(home, path.resolve(tildeExpanded)) ? 'home' : 'absolute',
      directLabel,
      true,
    );
    if (direct) return { ok: true, realPath: direct.realPath, attemptedLocations: attempts, matchCount: 1 };
  }

  // AI output such as `/src/a.pdf` often means project-relative. If the direct
  // absolute lookup misses, retry without its root prefix under each authority
  // root. For Windows input on another platform, also remove the drive prefix.
  const relative = absolute
    ? tildeExpanded.replace(/^[A-Za-z]:[/\\]*/, '').replace(/^[/\\]+/, '')
    : tildeExpanded;
  for (const root of roots) {
    const candidate = path.resolve(root.path, relative);
    // A relative `../` may move from cwd into its containing worktree/project,
    // but it may never escape every authorized root.
    if (!allowedRoots.some((allowed) => sameOrInside(allowed, candidate))) {
      sawForbidden = true;
      if (attempts.length < ATTEMPT_REPORT_LIMIT) attempts.push(safeAttemptLabel(root.label, relative));
      continue;
    }
    const found = await tryCandidate(candidate, root.label, relative, false);
    if (found) return { ok: true, realPath: found.realPath, attemptedLocations: attempts, matchCount: 1 };
  }

  const basename = path.basename(relative.replace(/\\/g, path.sep));
  if (basename && basename !== '.' && basename !== '..') {
    if (attempts.length < ATTEMPT_REPORT_LIMIT) attempts.push(safeAttemptLabel('cwd-search', basename));
    const matches = await searchByBasename(path.resolve(input.cwd), basename, allowedRoots);
    if (matches.length > 0) {
      return {
        ok: true,
        realPath: matches[0].realPath,
        attemptedLocations: attempts,
        matchCount: matches.length,
      };
    }
  }

  return {
    ok: false,
    error: sawForbidden ? FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH : FS_GENERIC_ERROR_CODES.PARENT_NOT_FOUND,
    attemptedLocations: attempts,
  };
}
