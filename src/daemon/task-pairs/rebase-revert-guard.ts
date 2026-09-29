/** Bounded warning-only guard for silent reverts across pair rebases. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { ResolvedTaskPairMaterial } from './material.js';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 4_000;
const MAX_OUTPUT = 256 * 1024;
const MAX_FILES = 80;
const MAX_REMOVED = 400;
const RECENT_DAYS = 120;

export interface PossibleSilentRevert {
  files: Array<{ path: string; removedLines: number; origins: Array<{ commit: string; subject: string; count: number }> }>;
  truncated?: boolean;
}

export async function isRewrittenHead(worktree: string, previousHead: string, nextHead: string): Promise<boolean> {
  if (!previousHead || previousHead === nextHead) return false;
  // git exits with no stdout on both success and failure; run the command
  // directly so the distinction remains observable to callers.
  try {
    await execFileAsync('git', ['-C', worktree, 'merge-base', '--is-ancestor', previousHead, nextHead], { timeout: TIMEOUT_MS, windowsHide: true });
    return false;
  } catch { return true; }
}

async function git(worktree: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', ['-C', worktree, ...args], {
      timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true,
    });
    return String(result.stdout ?? '');
  } catch { return undefined; }
}

function intentional(subject: string): boolean {
  return /\brevert\b/i.test(subject);
}

function normalizeLine(line: string): string {
  return line.replace(/[ \t]+$/g, '').trim();
}

/**
 * During a rewrite the old head contains both the pair's own commits and
 * integration commits that arrived while the pair was in flight.  A plain
 * `originalBase..oldHead` range cannot distinguish those two classes.  Use
 * the integration refs as the ownership boundary: commits reachable from a
 * dev/main/master ref are foreign integration history; old commits outside
 * those refs are the pair's stale branch history and must not trigger a
 * warning merely because the rewrite drops one of their lines.
 */
async function oldPairOwnedCommits(material: ResolvedTaskPairMaterial): Promise<Set<string>> {
  if (!material.ownershipBase || !material.ownershipHead || !material.worktree) return new Set();
  const oldRange = new Set((await git(material.worktree, ['rev-list', `${material.ownershipBase}..${material.ownershipHead}`]) ?? '').split('\n').filter(Boolean));
  if (oldRange.size === 0) return oldRange;
  const refs = (await git(material.worktree, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']) ?? '')
    .split('\n').map((ref) => ref.trim()).filter((ref) => /(?:^|\/)(?:dev|main|master)$/.test(ref));
  if (refs.length === 0) return new Set();
  const integrated = new Set<string>();
  for (const ref of refs.slice(0, 8)) {
    for (const commit of (await git(material.worktree, ['rev-list', '--max-count=5000', ref]) ?? '').split('\n').filter(Boolean)) integrated.add(commit);
  }
  return new Set([...oldRange].filter((commit) => !integrated.has(commit)));
}

/**
 * Inspect only git worktree material. This is advisory and deliberately fails
 * open: unavailable git, task directories, large diffs and malformed refs
 * produce no warning rather than blocking READY_FOR_AUDIT.
 */
export async function inspectPossibleSilentRevert(material: ResolvedTaskPairMaterial): Promise<PossibleSilentRevert | undefined> {
  const worktree = material.worktree;
  const base = material.base;
  const head = material.head;
  if (!worktree || !base || !head || !existsSync(worktree)) return undefined;
  if (material.intentionalNote && /intentional|revert|expected|by\s+design/i.test(material.intentionalNote)) return undefined;
  const status = await git(worktree, ['status', '--porcelain']);
  if (status === undefined) return undefined;
  const headSubject = await git(worktree, ['show', '-s', '--format=%s', head]);
  if (headSubject && intentional(headSubject.trim())) return undefined;
  const pairCommits = new Set((await git(worktree, ['rev-list', `${base}..${head}`]) ?? '').split('\n').filter(Boolean));
  const stalePairCommits = await oldPairOwnedCommits(material);
  const diff = await git(worktree, ['diff', '--find-renames', '--unified=0', `${base}..${head}`]);
  if (diff === undefined || diff.length > MAX_OUTPUT) return { files: [], truncated: true };
  const lines = diff.split('\n');
  const candidates: Array<{ path: string; text: string; oldLine: number }> = [];
  let path = '';
  let oldLine = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      path = match?.[2] ?? '';
      continue;
    }
    const hunk = line.match(/^@@ -(?:(\d+)(?:,(\d+))?)? \+(?:\d+)(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1] ?? 0); continue; }
    if (line.startsWith('-') && !line.startsWith('---')) {
      const text = normalizeLine(line.slice(1));
      if (text && removed < MAX_REMOVED) candidates.push({ path, text, oldLine: oldLine++ });
      removed++;
      continue;
    }
    if (!line.startsWith('+') && !line.startsWith('\\')) oldLine++;
  }
  if (removed === 0 || candidates.length === 0) return undefined;
  const recent = await git(worktree, ['log', '--all', `--since=${RECENT_DAYS}.days`, '--format=%H%x09%s']);
  if (!recent) return undefined;
  const recentSubjects = new Map<string, string>();
  for (const line of recent.split('\n')) {
    const [hash, ...subject] = line.split('\t');
    if (hash && subject.length) recentSubjects.set(hash, subject.join('\t'));
  }
  const byFile = new Map<string, Map<string, { subject: string; count: number }>>();
  const blameByPath = new Map<string, Map<string, string[]>>();
  for (const candidate of candidates) {
    if (!candidate.path || blameByPath.has(candidate.path)) continue;
    const blame = await git(worktree, ['blame', '--line-porcelain', base, '--', candidate.path]);
    if (!blame) continue;
    const byText = new Map<string, string[]>();
    let origin: string | undefined;
    for (const line of blame.split('\n')) {
      const header = line.match(/^([0-9a-f]{7,40}) \d+ \d+/);
      if (header) { origin = header[1]; continue; }
      if (line.startsWith('\t') && origin) {
        const text = normalizeLine(line.slice(1));
        const origins = byText.get(text) ?? [];
        origins.push(origin);
        byText.set(text, origins);
      }
    }
    blameByPath.set(candidate.path, byText);
  }
  for (const candidate of candidates) {
    const origins = blameByPath.get(candidate.path)?.get(candidate.text) ?? [];
    for (const origin of origins) {
      const subject = recentSubjects.get(origin) ?? (await git(worktree, ['show', '-s', '--format=%s', origin]))?.trim();
      if (!subject || intentional(subject) || pairCommits.has(origin) || stalePairCommits.has(origin)) continue;
      const file = byFile.get(candidate.path) ?? new Map<string, { subject: string; count: number }>();
      const entry = file.get(origin) ?? { subject, count: 0 };
      entry.count++;
      file.set(origin, entry);
      byFile.set(candidate.path, file);
      break;
    }
  }
  if (byFile.size === 0) return undefined;
  return {
    files: [...byFile.entries()].slice(0, MAX_FILES).map(([file, origins]) => ({
      path: file,
      removedLines: [...origins.values()].reduce((sum, value) => sum + value.count, 0),
      origins: [...origins.entries()].map(([commit, value]) => ({ commit, ...value })),
    })),
    ...(byFile.size > MAX_FILES || removed > MAX_REMOVED ? { truncated: true } : {}),
  };
}

export function formatPossibleSilentRevertWarning(result: PossibleSilentRevert | undefined): string | undefined {
  if (!result || result.files.length === 0) return undefined;
  const files = result.files.map((file) => `${file.path} (${file.removedLines} removed; ${file.origins.map((origin) => `${origin.commit.slice(0, 12)} ${origin.subject}`).join(', ')})`).join('; ');
  return `Possible silent rebase revert warning (advisory only; READY is not blocked): ${files}${result.truncated ? '; diff was bounded/truncated' : ''}. Verify these deletions against recent integration commits.`;
}
