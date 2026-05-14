import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  RepoCommit,
  RepoCommitDetail,
  RepoCommitDetailFile,
  RepoError,
  RepoListResult,
} from './types.js';
import { DEFAULT_PAGE_SIZE } from './provider.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const TARGET_BRANCH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,255}$/;
const SHA_RE = /^[0-9a-fA-F]{7,40}$/;

export interface LocalBranch {
  name: string;
  isCurrent: boolean;
}

export interface WorktreeState {
  dirty: boolean;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  submoduleDirty: boolean;
  entries: string[];
}

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'bisect';

export interface CheckoutTarget {
  branch: string;
  ref: `refs/heads/${string}`;
}

function repoError(code: RepoError, message = code): Error {
  const error = new Error(message);
  (error as { code?: RepoError }).code = code;
  return error;
}

async function git(projectDir: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: projectDir,
      timeout,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    if (args[0] === 'rev-parse') throw repoError('not_a_git_repo');
    throw err;
  }
}

async function gitPath(projectDir: string, path: string): Promise<string> {
  const resolved = (await git(projectDir, ['rev-parse', '--git-path', path], 3000)).trim();
  return isAbsolute(resolved) ? resolved : join(projectDir, resolved);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function assertGitRepository(projectDir: string): Promise<void> {
  const output = (await git(projectDir, ['rev-parse', '--is-inside-work-tree'], 3000)).trim();
  if (output !== 'true') throw repoError('not_a_git_repo');
}

export async function getCurrentBranch(projectDir: string): Promise<string | undefined> {
  try {
    const branch = (await git(projectDir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 3000)).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

export async function listLocalBranches(projectDir: string): Promise<LocalBranch[]> {
  await assertGitRepository(projectDir);
  const currentBranch = await getCurrentBranch(projectDir);
  const output = await git(projectDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], 5000);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({ name, isCurrent: name === currentBranch }));
}

export async function getWorktreeState(projectDir: string): Promise<WorktreeState> {
  await assertGitRepository(projectDir);
  const output = await git(projectDir, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ], 5000);
  const entries = output.split('\0').filter(Boolean);
  let staged = false;
  let unstaged = false;
  let untracked = false;
  let submoduleDirty = false;

  for (const entry of entries) {
    const x = entry[0] ?? ' ';
    const y = entry[1] ?? ' ';
    if (x === '?' && y === '?') {
      untracked = true;
      continue;
    }
    if (x !== ' ' && x !== '?') staged = true;
    if (y !== ' ' && y !== '?') unstaged = true;
    if (entry.includes(' m ') || entry.includes(' ? ') || entry.startsWith(' M ') || entry.startsWith('M  ')) {
      submoduleDirty = true;
    }
  }

  return {
    dirty: staged || unstaged || untracked || submoduleDirty,
    staged,
    unstaged,
    untracked,
    submoduleDirty,
    entries,
  };
}

export async function detectInProgressOperation(projectDir: string): Promise<GitOperation | null> {
  await assertGitRepository(projectDir);
  const checks: Array<[GitOperation, string[]]> = [
    ['merge', ['MERGE_HEAD']],
    ['rebase', ['rebase-merge', 'rebase-apply']],
    ['cherry-pick', ['CHERRY_PICK_HEAD']],
    ['bisect', ['BISECT_LOG']],
  ];

  for (const [operation, paths] of checks) {
    for (const gitRelativePath of paths) {
      if (await pathExists(await gitPath(projectDir, gitRelativePath))) return operation;
    }
  }
  return null;
}

async function refExists(projectDir: string, ref: string): Promise<boolean> {
  try {
    await git(projectDir, ['show-ref', '--verify', '--quiet', ref], 3000);
    return true;
  } catch {
    return false;
  }
}

function isUnsafeTargetSyntax(branch: string): boolean {
  return !branch
    || branch.startsWith('-')
    || branch.startsWith('/')
    || branch.endsWith('/')
    || branch.includes('\\')
    || branch.includes('..')
    || branch.includes('@{')
    || branch.includes('//')
    || branch.includes('\0')
    || branch.includes(':')
    || SHA_RE.test(branch)
    || !TARGET_BRANCH_RE.test(branch);
}

export async function resolveCheckoutTarget(projectDir: string, requestedBranch: string): Promise<CheckoutTarget> {
  await assertGitRepository(projectDir);
  if (requestedBranch !== requestedBranch.trim()) throw repoError('invalid_checkout_target');
  const branch = requestedBranch.trim();
  if (isUnsafeTargetSyntax(branch)) throw repoError('invalid_checkout_target');

  try {
    await git(projectDir, ['check-ref-format', '--branch', branch], 3000);
  } catch {
    throw repoError('invalid_checkout_target');
  }

  const ref = `refs/heads/${branch}` as const;
  if (!(await refExists(projectDir, ref))) throw repoError('invalid_checkout_target');
  if (await refExists(projectDir, `refs/tags/${branch}`)) throw repoError('invalid_checkout_target');
  return { branch, ref };
}

export async function switchLocalBranch(projectDir: string, target: CheckoutTarget): Promise<void> {
  if (!target.ref.startsWith('refs/heads/') || target.branch !== target.ref.slice('refs/heads/'.length)) {
    throw repoError('invalid_checkout_target');
  }
  await git(projectDir, ['switch', '--no-guess', target.branch], 30_000);
}

export async function listLocalCommits(
  projectDir: string,
  branch?: string,
  page = 1,
  perPage = DEFAULT_PAGE_SIZE,
): Promise<RepoListResult<RepoCommit>> {
  await assertGitRepository(projectDir);
  const ref = branch ? (await resolveCheckoutTarget(projectDir, branch)).ref : 'HEAD';
  const skip = Math.max(0, page - 1) * perPage;
  const limit = perPage + 1;
  const output = await git(projectDir, [
    'log',
    `--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct`,
    `--max-count=${limit}`,
    `--skip=${skip}`,
    ref,
  ]);
  const rows = output.split('\n').filter(Boolean);
  const items = rows.slice(0, perPage).map((row) => {
    const [sha = '', shortSha = '', message = '', author = '', epoch = '0'] = row.split('\x1f');
    return {
      sha,
      shortSha,
      message,
      author,
      date: Number(epoch) * 1000,
      url: '',
    };
  });
  return { items, page, hasMore: rows.length > perPage, projectDir };
}

export async function getLocalCommitDetail(projectDir: string, sha: string): Promise<RepoCommitDetail> {
  await assertGitRepository(projectDir);
  if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) throw repoError('invalid_params');
  const output = await git(projectDir, [
    'show',
    '--no-ext-diff',
    '--format=%H%x1f%h%x1f%an%x1f%ct%x1f%B%x1e',
    '--numstat',
    '--no-renames',
    '--max-count=1',
    sha,
    '--',
  ]);
  const [header = '', statBlock = ''] = output.split('\x1e');
  const [fullSha = sha, shortSha = sha.slice(0, 7), author = '', epoch = '0', ...messageParts] = header.split('\x1f');
  const fullMessage = messageParts.join('\x1f').trimEnd();
  const [message = '', ...bodyParts] = fullMessage.split('\n');
  const files: RepoCommitDetailFile[] = [];
  let additions = 0;
  let deletions = 0;

  for (const line of statBlock.split('\n').filter(Boolean).slice(0, 100)) {
    const [addRaw = '0', delRaw = '0', filename = ''] = line.split('\t');
    const add = Number.parseInt(addRaw, 10);
    const del = Number.parseInt(delRaw, 10);
    const normalizedAdd = Number.isFinite(add) ? add : 0;
    const normalizedDel = Number.isFinite(del) ? del : 0;
    additions += normalizedAdd;
    deletions += normalizedDel;
    if (filename) {
      files.push({ filename, status: 'modified', additions: normalizedAdd, deletions: normalizedDel });
    }
  }

  return {
    sha: fullSha,
    shortSha,
    message,
    author,
    date: Number(epoch) * 1000,
    url: '',
    body: bodyParts.join('\n').replace(/^\n+/, ''),
    stats: { additions, deletions, filesChanged: files.length },
    files,
    hasMoreFiles: statBlock.split('\n').filter(Boolean).length > 100,
  };
}

export function __repoErrorForTests(code: RepoError): Error {
  return repoError(code);
}
