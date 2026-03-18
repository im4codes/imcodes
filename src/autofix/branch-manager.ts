/**
 * Git branch management for auto-fix pipeline.
 * Creates feature branches, tracks commits, merges to base branch.
 */
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import logger from '../util/logger.js';

const exec = promisify(execCb);

export interface BranchInfo {
  name: string;
  baseBranch: string;
  created: boolean;
  sha?: string;
}

/**
 * Create a feature branch for an issue.
 * Branch name: fix/<issue-id>-<slug>
 */
export async function createBranch(opts: {
  issueId: string;
  title: string;
  baseBranch: string;
  cwd: string;
}): Promise<BranchInfo> {
  const branchName = buildBranchName(opts.issueId, opts.title);

  try {
    // Ensure we're on the base branch and up to date
    await gitExec(opts.cwd, `checkout ${opts.baseBranch}`);
    await gitExec(opts.cwd, 'pull --ff-only').catch(() => {}); // best-effort

    // Create and switch to feature branch
    await gitExec(opts.cwd, `checkout -b ${branchName}`);
    logger.info({ branch: branchName, base: opts.baseBranch }, 'Created feature branch');

    return { name: branchName, baseBranch: opts.baseBranch, created: true };
  } catch (err) {
    // Branch may already exist
    await gitExec(opts.cwd, `checkout ${branchName}`).catch(() => {});
    logger.warn({ branch: branchName, err }, 'Branch may already exist — switched to it');
    return { name: branchName, baseBranch: opts.baseBranch, created: false };
  }
}

/**
 * Get the current HEAD commit SHA.
 */
export async function getCurrentSha(cwd: string): Promise<string> {
  const { stdout } = await exec('git rev-parse HEAD', { cwd });
  return stdout.trim();
}

/**
 * Merge the feature branch into the base branch.
 * Uses --no-ff to preserve branch history.
 */
export async function mergeBranch(opts: {
  branchName: string;
  baseBranch: string;
  cwd: string;
}): Promise<void> {
  await gitExec(opts.cwd, `checkout ${opts.baseBranch}`);
  try {
    await gitExec(opts.cwd, `merge --no-ff ${opts.branchName} -m "Auto-fix: merge ${opts.branchName}"`);
    logger.info({ branch: opts.branchName, base: opts.baseBranch }, 'Branch merged');
  } catch (err) {
    logger.error({ branch: opts.branchName, err }, 'Merge failed — conflict detected');
    await gitExec(opts.cwd, 'merge --abort').catch(() => {});
    throw new Error(`Merge conflict: ${opts.branchName} → ${opts.baseBranch}`);
  }
}

/**
 * Check if there are uncommitted changes in the working tree.
 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const { stdout } = await exec('git status --porcelain', { cwd });
  return stdout.trim().length > 0;
}

/**
 * Push branch to remote origin.
 */
export async function pushBranch(branchName: string, cwd: string): Promise<void> {
  await gitExec(cwd, `push origin ${branchName} --set-upstream`);
  logger.info({ branch: branchName }, 'Branch pushed to origin');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a git branch name from issue ID and title.
 * Format: fix/<issue-id>-<slug>
 * Slug: lowercase, special chars → hyphens, max 50 chars total.
 */
export function buildBranchName(issueId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  return `fix/${issueId}-${slug}`;
}

async function gitExec(cwd: string, args: string): Promise<string> {
  const { stdout } = await exec(`git ${args}`, { cwd });
  return stdout.trim();
}
