/** Bounded, warning-only guard for silent reverts across pair rebases. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { ResolvedTaskPairMaterial } from './material.js';

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 4_000;
const TOTAL_BUDGET_MS = 5_000;
const MAX_OUTPUT = 256 * 1024;
const MAX_FILES = 80;
const MAX_REMOVED = 400;
const RECENT_DAYS = 120;

export interface PossibleSilentRevert {
  files: Array<{ path: string; removedLines: number; origins: Array<{ commit: string; subject: string; count: number }> }>;
  truncated?: boolean;
}

export type RewrittenHeadProbe = (worktree: string, previousHead: string, nextHead: string) => Promise<boolean>;

async function defaultIsRewrittenHead(worktree: string, previousHead: string, nextHead: string): Promise<boolean> {
  if (!previousHead || previousHead === nextHead) return false;
  try {
    await execFileAsync('git', ['-C', worktree, 'merge-base', '--is-ancestor', previousHead, nextHead], {
      timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
    });
    return false;
  } catch {
    return true;
  }
}

type SilentRevertInspector = (material: ResolvedTaskPairMaterial) => Promise<PossibleSilentRevert | undefined>;
let rewrittenHeadProbe: RewrittenHeadProbe = defaultIsRewrittenHead;

export async function isRewrittenHead(worktree: string, previousHead: string, nextHead: string): Promise<boolean> {
  return rewrittenHeadProbe(worktree, previousHead, nextHead);
}

/** Test-only seams for proving advisory probes cannot delay durable head writes. */
export function setRebaseRevertGuardDepsForTests(deps?: {
  isRewrittenHead?: RewrittenHeadProbe;
  inspectPossibleSilentRevert?: SilentRevertInspector;
}): void {
  rewrittenHeadProbe = deps?.isRewrittenHead ?? defaultIsRewrittenHead;
  silentRevertInspector = deps?.inspectPossibleSilentRevert ?? defaultInspectPossibleSilentRevert;
}

interface Budget { deadline: number; }

function remaining(budget: Budget): number {
  return Math.max(0, budget.deadline - Date.now());
}

async function git(worktree: string, args: string[], budget: Budget): Promise<string | undefined> {
  const timeout = Math.min(COMMAND_TIMEOUT_MS, remaining(budget));
  if (timeout <= 0) return undefined;
  try {
    const result = await execFileAsync('git', ['-C', worktree, ...args], {
      timeout, maxBuffer: MAX_OUTPUT, windowsHide: true,
    });
    return String(result.stdout ?? '');
  } catch {
    return undefined;
  }
}

function intentional(subject: string): boolean {
  return /\brevert\b/i.test(subject);
}

function normalizeLine(line: string): string {
  return line.replace(/[ \t]+$/g, '').trim();
}

/** Return recent commits on an integration ref after the pair's original base. */
async function integrationCommits(material: ResolvedTaskPairMaterial, budget: Budget): Promise<Map<string, string>> {
  if (!material.worktree || !material.ownershipBase) return new Map();
  const refs = (await git(material.worktree, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], budget) ?? '')
    .split('\n').map((ref) => ref.trim())
    .filter((ref) => /(?:^|\/)(?:dev|main|master)$/.test(ref)).slice(0, 8);
  const subjects = new Map<string, string>();
  for (const ref of refs) {
    if (remaining(budget) <= 0) break;
    const log = await git(material.worktree, [
      'log', '--max-count=5000', `--since=${RECENT_DAYS}.days`, '--format=%H%x09%s', `${material.ownershipBase}..${ref}`,
    ], budget);
    for (const line of (log ?? '').split('\n')) {
      const [hash, ...subject] = line.split('\t');
      if (hash && subject.length) subjects.set(hash, subject.join('\t'));
    }
  }
  return subjects;
}

/**
 * Inspect only a confirmed rewritten-head transition. `ownershipBase` and
 * `ownershipHead` are required, so ordinary READY deletions never warn.
 * Every git operation shares one five-second budget and fails open.
 */
async function defaultInspectPossibleSilentRevert(material: ResolvedTaskPairMaterial): Promise<PossibleSilentRevert | undefined> {
  const worktree = material.worktree;
  const base = material.base;
  const head = material.head;
  if (!worktree || !base || !head || !material.ownershipBase || !material.ownershipHead || !existsSync(worktree)) return undefined;
  if (material.intentionalNote && /intentional|revert|expected|by\s+design/i.test(material.intentionalNote)) return undefined;
  const budget: Budget = { deadline: Date.now() + TOTAL_BUDGET_MS };
  const integration = await integrationCommits(material, budget);
  if (integration.size === 0 || remaining(budget) <= 0) return undefined;
  const diff = await git(worktree, ['diff', '--find-renames', '--unified=0', `${base}..${head}`], budget);
  if (diff === undefined || diff.length > MAX_OUTPUT || remaining(budget) <= 0) return undefined;
  const candidates: Array<{ path: string; text: string }> = [];
  let path = '';
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      path = match?.[2] ?? '';
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('-') && !line.startsWith('---')) {
      const text = normalizeLine(line.slice(1));
      if (text && removed < MAX_REMOVED) candidates.push({ path, text });
      removed++;
    }
  }
  if (removed === 0 || candidates.length === 0 || remaining(budget) <= 0) return undefined;

  const byFile = new Map<string, Map<string, { subject: string; count: number }>>();
  const blameByPath = new Map<string, Map<string, string[]>>();
  for (const candidate of candidates) {
    if (!candidate.path || blameByPath.has(candidate.path) || remaining(budget) <= 0) continue;
    const blame = await git(worktree, ['blame', '--line-porcelain', base, '--', candidate.path], budget);
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
    if (remaining(budget) <= 0) break;
    const origins = blameByPath.get(candidate.path)?.get(candidate.text) ?? [];
    for (const origin of origins) {
      const subject = integration.get(origin);
      if (!subject || intentional(subject)) continue;
      const file = byFile.get(candidate.path) ?? new Map<string, { subject: string; count: number }>();
      const entry = file.get(origin) ?? { subject, count: 0 };
      entry.count++;
      file.set(origin, entry);
      byFile.set(candidate.path, file);
      break;
    }
  }
  if (byFile.size === 0 || remaining(budget) <= 0) return undefined;
  return {
    files: [...byFile.entries()].slice(0, MAX_FILES).map(([file, origins]) => ({
      path: file,
      removedLines: [...origins.values()].reduce((sum, value) => sum + value.count, 0),
      origins: [...origins.entries()].map(([commit, value]) => ({ commit, ...value })),
    })),
    ...(byFile.size > MAX_FILES || removed > MAX_REMOVED ? { truncated: true } : {}),
  };
}

let silentRevertInspector: SilentRevertInspector = defaultInspectPossibleSilentRevert;

export async function inspectPossibleSilentRevert(material: ResolvedTaskPairMaterial): Promise<PossibleSilentRevert | undefined> {
  return silentRevertInspector(material);
}

export function formatPossibleSilentRevertWarning(result: PossibleSilentRevert | undefined): string | undefined {
  if (!result || result.files.length === 0) return undefined;
  const files = result.files.map((file) => `${file.path} (${file.removedLines} removed; ${file.origins.map((origin) => `${origin.commit.slice(0, 12)} ${origin.subject}`).join(', ')})`).join('; ');
  return `Possible silent rebase revert warning (advisory only; READY is not blocked): ${files}${result.truncated ? '; diff was bounded/truncated' : ''}. Verify these deletions against recent integration commits.`;
}
