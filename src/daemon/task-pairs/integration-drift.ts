/**
 * Integration drift: make it visible to Brain, automatically, when
 *  (1) a finished (DONE) pair's final head never reached the integration branch (the owner's rule is that Brain merges every
 *      PASSed pair; tsk_cd_upgrade_auto_resume sat unmerged for 2 h 40 min and drifted 131 commits behind dev), and
 *  (2) a head handed to audit / PASSed builds on a base that is far behind the integration branch ("rebase before the final round").
 *
 * Both are advisory: nothing is blocked, nothing is merged.
 *
 * Cost model (heartbeat every 6 min, ~200 closed and ~30 open pairs): the pass starts from a bounded SQL listing of pairs that
 * finished in the last 7 days, and every gate that needs no git runs first (dismissed, not a git worktree, outside the window,
 * already found integrated, grace not over, next reminder not due). Git runs only for a pair whose reminder is due, so a pair costs
 * at most one check per 10-15 minutes, an integrated pair is never checked again, and results are cached per head + integration
 * tip. The integration ref is fetched at most once per repository per 5 minutes (single flight, bounded, a failure backs off and is
 * logged once). All git goes through the off-main exec helper; the patch-equivalence logic is the worktree GC's own
 * (`listTaskPairCommitsNotInIntegration`), so a cherry-pick into dev (a different SHA, the same patch) counts as integrated.
 *
 * Skipped by design: non-git and `dir` workspaces and daemon-made local repos (no integration ref exists), a project without any
 * integration ref, a fetch or git failure (no reminder is claimed when git cannot tell).
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  TASK_PAIR_EVIDENCE_COMMIT_PREFIX,
  TASK_PAIR_INTEGRATION_REF_ENV,
  resolveTaskPairBrainReminderInterval,
  TASK_PAIR_INTEGRATION_REMINDER_GRACE_MS,
  TASK_PAIR_INTEGRATION_REMINDER_MAX_PAIRS,
  TASK_PAIR_INTEGRATION_REMINDER_WINDOW_MS,
  TASK_PAIR_STALE_BASE_MAX_AGE_MS,
  TASK_PAIR_STALE_BASE_MAX_COMMITS,
  type TaskPairState,
} from '../../../shared/task-pair.js';
import { execFileOffMain } from '../../util/exec-helper.js';
import logger from '../../util/logger.js';
import { listTaskPairCommitsNotInIntegration } from '../supervision-worktree-gc.js';
import { sendTaskPairMessage, type TaskPairDeliveryResult } from './delivery.js';
import { isPairsEngineProject } from './engine.js';
import { getTaskPairStore, type StoredTaskPair, type TaskPairLiveness } from './store.js';
import { buildIntegrationDriftDigest, buildStaleBaseBrainLine, buildStaleBaseExecutorNotice } from './messages.js';

const GIT_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MIN_INTERVAL_MS = 5 * 60_000;
const FETCH_FAILURE_BACKOFF_MS = 30 * 60_000;
/** A fetch this recent makes the private ref the measuring ref; older (fetch failing), the user's own origin/<branch> is the better local knowledge. */
const PRIVATE_REF_FRESH_MS = 30 * 60_000;
/** ssh must not wait for a password or host-key answer either; only added when the user has no ssh command of their own (see fetchEnvFor). */
const BATCH_MODE_SSH_COMMAND = 'ssh -o BatchMode=yes';
const MAX_RANGE_COMMITS = 3_000;
const RANGE_MAX_BUFFER = 8 * 1024 * 1024;
const PICKED_FROM_RE = /\(cherry picked from commit ([0-9a-f]{7,64})\)/giu;
const REF_CACHE_MS = 10 * 60_000;
const UNKNOWN_CACHE_MS = 30 * 60_000;
const MAX_CACHE_ENTRIES = 500;
const MAX_SUBJECT_LOOKUP = 100;
const INTEGRATION_CANDIDATE_REFS = ['origin/dev', 'origin/main', 'origin/master', 'dev', 'main', 'master'] as const;
/** Digest and notice id of the aggregate integration reminder (`__` ids are not pair-bound instructions). */
export const TASK_PAIR_INTEGRATION_DIGEST_ID = '__integration__' as const;
export const TASK_PAIR_INTEGRATION_DIGEST_REASON = 'integration-drift' as const;

export type PairIntegrationState = 'integrated' | 'unintegrated' | 'unknown';

export interface PairIntegration {
  state: PairIntegrationState;
  ref?: string;
  /** integrated: why (`ancestor`, `patch_equivalent`, `evidence_only`); unknown: why git could not tell. */
  reason?: string;
  /** unintegrated: commits still missing (evidence commits excluded). */
  missing?: number;
}

export interface StaleBase {
  ref: string;
  behind: number;
  ageMs: number;
  stale: boolean;
}

interface GitOutcome { ok: boolean; stdout: string; exitCode?: number }
interface GitOptions { env?: Record<string, string>; maxBuffer?: number }

export interface IntegrationDriftDeps {
  now?: () => number;
  git?: (cwd: string, args: readonly string[], timeoutMs: number, options?: GitOptions) => Promise<GitOutcome>;
  send?: (target: string, taskId: string, reason: string, text: string) => Promise<TaskPairDeliveryResult>;
}

let testDeps: IntegrationDriftDeps = {};

export function setIntegrationDriftDepsForTests(deps: IntegrationDriftDeps | undefined): void {
  testDeps = deps ?? {};
  resetIntegrationDriftCachesForTests();
}

const now = (): number => (testDeps.now ?? Date.now)();

async function defaultGit(cwd: string, args: readonly string[], timeoutMs: number, options: GitOptions = {}): Promise<GitOutcome> {
  try {
    const result = await execFileOffMain('git', ['-C', cwd, ...args], {
      timeout: timeoutMs, maxBuffer: options.maxBuffer ?? 1024 * 1024, windowsHide: true,
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });
    return { ok: true, stdout: String(result.stdout ?? '') };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { ok: false, stdout: '', ...(typeof code === 'number' ? { exitCode: code } : {}) };
  }
}

const git = (cwd: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS, options?: GitOptions): Promise<GitOutcome> => (testDeps.git ?? defaultGit)(cwd, args, timeoutMs, options);

// ---- per-repository state ---------------------------------------------------------------------------------------------------

interface RepoState {
  ref?: { name: string | undefined; at: number };
  fetchedAt: number;
  /** The private integration ref was fetched successfully at this time (see refreshIntegrationRef). */
  privateAt?: number;
  /** Whether the user's git config names an ssh command (core.sshCommand), read once per repository. */
  hasSshCommandConfig?: boolean;
  fetchFailedAt?: number;
  fetching?: Promise<void>;
  loggedFailure: boolean;
}

const repos = new Map<string, RepoState>();
const commonDirs = new Map<string, string>();
const tips = new Map<string, { sha: string | undefined; at: number }>();
const TIP_CACHE_MS = 30_000;
const results = new Map<string, { value: PairIntegration; at: number }>();
const staleResults = new Map<string, { value: StaleBase | undefined; at: number }>();

export function resetIntegrationDriftCachesForTests(): void {
  repos.clear();
  commonDirs.clear();
  tips.clear();
  results.clear();
  ranges.clear();
  staleResults.clear();
}

/**
 * The repository a worktree belongs to (its git common dir), cached per worktree path: every pair worktree of one project shares
 * one integration ref, one fetch and one tip, instead of each paying for its own.
 */
async function repoKeyOf(repoPath: string): Promise<string> {
  const known = commonDirs.get(repoPath);
  if (known) return known;
  const out = await git(repoPath, ['rev-parse', '--git-common-dir']);
  const key = out.ok && out.stdout.trim() ? resolve(repoPath, out.stdout.trim()) : repoPath;
  remember(commonDirs, repoPath, key);
  return key;
}

async function repoState(repoPath: string): Promise<{ key: string; state: RepoState }> {
  const key = await repoKeyOf(repoPath);
  let state = repos.get(key);
  if (!state) {
    state = { fetchedAt: 0, loggedFailure: false };
    repos.set(key, state);
  }
  return { key, state };
}

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  return (await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok;
}

/**
 * The ref finished work is measured against: `IMCODES_PAIR_INTEGRATION_REF` when set (used as is, so a renamed integration
 * branch needs no code change), else the first of origin/dev, origin/main, origin/master, dev, main, master that exists.
 * Cached per repository for ten minutes.
 */
export async function resolveIntegrationRef(repoPath: string): Promise<string | undefined> {
  const { state } = await repoState(repoPath);
  if (state.ref && now() - state.ref.at < REF_CACHE_MS) return state.ref.name;
  const override = process.env[TASK_PAIR_INTEGRATION_REF_ENV]?.trim();
  const candidates = override ? [override] : INTEGRATION_CANDIDATE_REFS;
  let found: string | undefined;
  for (const candidate of candidates) {
    if (await refExists(repoPath, candidate)) { found = candidate; break; }
  }
  state.ref = { name: found, at: now() };
  return found;
}

/** `origin/dev` -> `dev`; a local ref has no remote to fetch. */
function remoteBranchOf(ref: string): string | undefined {
  return ref.startsWith('origin/') ? ref.slice('origin/'.length) : undefined;
}

/**
 * The daemon's own copy of the remote branch. Fetching into it (not into the user's refs/remotes/origin/<branch>) never contends for
 * a ref lock with Brain's own push/fetch in the main checkout, and never moves what the owner sees as origin/<branch> (`--refmap=`
 * switches off git's opportunistic update of the configured remote-tracking refs).
 */
function privateRefOf(branch: string): string {
  return `refs/imcodes/integration/${branch}`;
}

/**
 * The environment of the fetch. A detached daemon must never wait for a prompt: `GIT_TERMINAL_PROMPT=0` always (an HTTPS remote
 * without cached credentials fails at once). For ssh, `-o BatchMode=yes` is added through GIT_SSH_COMMAND ONLY when the user has no
 * ssh command of their own: `GIT_SSH_COMMAND` in the environment wins over `core.sshCommand` in the config, so setting it would throw
 * away a configured `ssh -i ~/.ssh/key` and the fetch would fail. Their command (from the environment or from `core.sshCommand`,
 * repository, global or system config, read once per repository through `git config`) is left untouched; a detached process has no
 * terminal for ssh to prompt on anyway.
 */
async function fetchEnvFor(repoPath: string, state: RepoState): Promise<Record<string, string>> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (process.env.GIT_SSH_COMMAND?.trim()) return env;
  if (state.hasSshCommandConfig === undefined) {
    const configured = await git(repoPath, ['config', '--get', 'core.sshCommand']);
    state.hasSshCommandConfig = configured.ok && configured.stdout.trim().length > 0;
  }
  if (!state.hasSshCommandConfig) env.GIT_SSH_COMMAND = BATCH_MODE_SSH_COMMAND;
  return env;
}

/**
 * Bring the integration ref up to date: at most one fetch per repository per five minutes, one in flight at a time, bounded.
 * A failure (no remote, offline, a lock held by another daemon on the same repository) is logged once and not retried for
 * thirty minutes; the checks then use the ref as it is.
 */
async function refreshIntegrationRef(repoPath: string, ref: string): Promise<void> {
  const branch = remoteBranchOf(ref);
  if (!branch) return;
  const { key, state } = await repoState(repoPath);
  const current = now();
  if (state.fetching) return state.fetching;
  if (current - state.fetchedAt < FETCH_MIN_INTERVAL_MS) return;
  if (state.fetchFailedAt !== undefined && current - state.fetchFailedAt < FETCH_FAILURE_BACKOFF_MS) return;
  state.fetching = (async () => {
    const outcome = await git(repoPath, ['fetch', '--quiet', '--no-tags', '--refmap=', 'origin', `+refs/heads/${branch}:${privateRefOf(branch)}`], FETCH_TIMEOUT_MS, { env: await fetchEnvFor(repoPath, state) });
    if (outcome.ok) {
      tips.delete(`${key}\u0000${privateRefOf(branch)}`);
      tips.delete(`${key}\u0000${ref}`);
      state.fetchedAt = now();
      state.privateAt = now();
      state.fetchFailedAt = undefined;
      state.loggedFailure = false;
    } else {
      state.fetchFailedAt = now();
      if (!state.loggedFailure) {
        state.loggedFailure = true;
        logger.warn({ repoPath, ref }, 'task-pair: could not fetch the integration ref; integration checks use the ref as it is');
      }
    }
  })().finally(() => { state.fetching = undefined; });
  return state.fetching;
}

/** The ref the checks measure against: the private (freshly fetched) copy while the fetches work, else the candidate itself. */
async function measuringRef(repoPath: string, ref: string): Promise<string> {
  const branch = remoteBranchOf(ref);
  if (!branch) return ref;
  const { state } = await repoState(repoPath);
  return state.privateAt !== undefined && now() - state.privateAt < PRIVATE_REF_FRESH_MS ? privateRefOf(branch) : ref;
}

/** The integration ref's tip, cached for 30 s per repository (and dropped when a fetch moved it): one rev-parse per pass, not per pair. */
async function tipOf(repoPath: string, ref: string): Promise<string | undefined> {
  const cacheKey = `${await repoKeyOf(repoPath)}\u0000${ref}`;
  const cached = tips.get(cacheKey);
  if (cached && now() - cached.at < TIP_CACHE_MS) return cached.sha;
  const out = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = out.stdout.trim();
  const value = out.ok && /^[0-9a-f]{40}$/u.test(sha) ? sha : undefined;
  remember(tips, cacheKey, { sha: value, at: now() });
  return value;
}

/** Subjects of the given commits, bounded. */
async function subjectsOf(repoPath: string, hashes: readonly string[]): Promise<Map<string, string> | undefined> {
  const out = await git(repoPath, ['show', '-s', '--format=%H%x09%s', ...hashes.slice(0, MAX_SUBJECT_LOOKUP)]);
  if (!out.ok) return undefined;
  const map = new Map<string, string>();
  for (const line of out.stdout.split(/\r?\n/u)) {
    const [hash, ...subject] = line.split('\t');
    if (hash) map.set(hash, subject.join('\t'));
  }
  return map;
}

// ---- (1) is a finished head integrated? ---------------------------------------------------------------------------------------

/**
 * Has `head` (a pair's final commit) reached the integration ref? Integrated when it is an ancestor, or every commit of the
 * pair (after `base`) is patch-equivalent to one in the ref (Brain cherry-picks), ignoring `evidence:` commits, which are never
 * integrated. Cached per head and integration tip: an integrated head is never re-checked, an unintegrated one only after the ref
 * moved, and an unknown answer is remembered for thirty minutes so a broken repository costs no git per heartbeat.
 */
export async function inspectPairIntegration(repoPath: string, head: string, base: string | undefined): Promise<PairIntegration> {
  const ref = await resolveIntegrationRef(repoPath);
  if (!ref) return { state: 'unknown', reason: 'no_integration_ref' };
  const repoKey = await repoKeyOf(repoPath);
  const permanentKey = `${repoKey}\u0000${head}\u0000integrated`;
  const permanent = results.get(permanentKey);
  if (permanent) return permanent.value;
  await refreshIntegrationRef(repoPath, ref);
  const measure = await measuringRef(repoPath, ref);
  const tip = await tipOf(repoPath, measure);
  if (!tip) return { state: 'unknown', ref, reason: 'no_integration_tip' };
  const key = `${repoKey}\u0000${head}\u0000${tip}`;
  const cached = results.get(key);
  if (cached && (cached.value.state !== 'unknown' || now() - cached.at < UNKNOWN_CACHE_MS)) return cached.value;
  const value = await computeIntegration(repoPath, head, base, ref, measure, tip);
  remember(results, value.state === 'integrated' ? permanentKey : key, { value, at: now() });
  return value;
}

/**
 * What the integration ref gained since the pair branched: the trimmed subject of every commit and the source of every
 * `(cherry picked from commit <sha>)` line. Cached per repository, branch point and tip; bounded (3000 commits, 8 MB).
 */
interface RangeIndex { subjects: Set<string>; pickedFrom: string[] }
const ranges = new Map<string, { value: RangeIndex | undefined; at: number }>();

async function rangeIndex(repoPath: string, from: string, measure: string, tip: string): Promise<RangeIndex | undefined> {
  const key = `${await repoKeyOf(repoPath)}\u0000${from}\u0000${tip}`;
  const cached = ranges.get(key);
  if (cached && (cached.value !== undefined || now() - cached.at < UNKNOWN_CACHE_MS)) return cached.value;
  const out = await git(repoPath, ['log', `--max-count=${MAX_RANGE_COMMITS}`, '--format=%s%x1f%b%x1e', `${from}..${measure}`], GIT_TIMEOUT_MS, { maxBuffer: RANGE_MAX_BUFFER });
  let value: RangeIndex | undefined;
  if (out.ok) {
    value = { subjects: new Set(), pickedFrom: [] };
    for (const record of out.stdout.split('\x1e')) {
      const [subject = '', body = ''] = record.split('\x1f');
      const trimmed = subject.trim();
      if (trimmed) value.subjects.add(trimmed);
      for (const match of body.matchAll(PICKED_FROM_RE)) value.pickedFrom.push(match[1]!.toLowerCase());
    }
  }
  remember(ranges, key, { value, at: now() });
  return value;
}

async function computeIntegration(repoPath: string, head: string, base: string | undefined, ref: string, measure: string, tip: string): Promise<PairIntegration> {
  const ancestor = await git(repoPath, ['merge-base', '--is-ancestor', head, measure]);
  if (ancestor.ok) return { state: 'integrated', ref, reason: 'ancestor' };
  if (ancestor.exitCode !== 1) return { state: 'unknown', ref, reason: 'git_failed' };
  const branchPoint = (await git(repoPath, ['merge-base', head, measure])).stdout.trim();
  const from = base ?? (branchPoint || undefined);
  if (!from) return { state: 'unknown', ref, reason: 'no_base' };
  const missing = await listTaskPairCommitsNotInIntegration(repoPath, from, { integrationRef: measure, head });
  if (missing === undefined) return { state: 'unknown', ref, reason: 'git_failed' };
  if (missing.length === 0) return { state: 'integrated', ref, reason: 'patch_equivalent' };
  const subjects = await subjectsOf(repoPath, missing);
  if (!subjects) return { state: 'unknown', ref, reason: 'git_failed' };
  let real = missing.filter((hash) => !(subjects.get(hash) ?? '').toLowerCase().startsWith(TASK_PAIR_EVIDENCE_COMMIT_PREFIX));
  if (real.length === 0) return { state: 'integrated', ref, reason: 'evidence_only' };
  // Brain's cherry-picks onto a dev that has moved change the hunk context, so the patch-id differs (git cherry says "not merged")
  // although the commit is in dev: recognise it by the `(cherry picked from commit <sha>)` line of `-x`, or by the identical subject
  // among the commits the ref gained since the pair branched. (Subject equivalence can hide a genuinely unmerged commit that reuses
  // another commit's subject; the pair subjects are descriptive and a stream of false reminders is the worse failure.)
  if (branchPoint) {
    const index = await rangeIndex(repoPath, branchPoint, measure, tip);
    if (!index) return { state: 'unknown', ref, reason: 'git_failed' };
    real = real.filter((hash) => !index.subjects.has((subjects.get(hash) ?? '').trim()) && !index.pickedFrom.some((source) => hash.startsWith(source) || source.startsWith(hash)));
    if (real.length === 0) return { state: 'integrated', ref, reason: 'subject_equivalent' };
  }
  return { state: 'unintegrated', ref, missing: real.length };
}

// ---- (2) is a head's base far behind the integration ref? ---------------------------------------------------------------------

/**
 * How far behind the integration ref the base of `head` is (merge-base .. ref commits, and the age between the two). Cached per
 * head and integration tip. `undefined` when git cannot tell.
 */
export async function inspectStaleBase(repoPath: string, head: string): Promise<StaleBase | undefined> {
  const ref = await resolveIntegrationRef(repoPath);
  if (!ref) return undefined;
  await refreshIntegrationRef(repoPath, ref);
  const measure = await measuringRef(repoPath, ref);
  const tip = await tipOf(repoPath, measure);
  if (!tip) return undefined;
  const key = `${await repoKeyOf(repoPath)}\u0000${head}\u0000${tip}`;
  const cached = staleResults.get(key);
  if (cached && (cached.value !== undefined || now() - cached.at < UNKNOWN_CACHE_MS)) return cached.value;
  const value = await computeStaleBase(repoPath, head, ref, measure);
  remember(staleResults, key, { value, at: now() });
  return value;
}

async function computeStaleBase(repoPath: string, head: string, ref: string, measure: string): Promise<StaleBase | undefined> {
  const mergeBase = (await git(repoPath, ['merge-base', head, measure])).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(mergeBase)) return undefined;
  const behindOut = await git(repoPath, ['rev-list', '--count', `${mergeBase}..${measure}`]);
  const behind = Number.parseInt(behindOut.stdout.trim(), 10);
  if (!behindOut.ok || !Number.isFinite(behind)) return undefined;
  const times = await git(repoPath, ['show', '-s', '--format=%ct', mergeBase, `${measure}^{commit}`]);
  const [baseTime, tipTime] = times.stdout.split(/\s+/u).filter(Boolean).map((value) => Number.parseInt(value, 10));
  const ageMs = times.ok && Number.isFinite(baseTime) && Number.isFinite(tipTime) ? Math.max(0, (tipTime! - baseTime!) * 1000) : 0;
  return { ref, behind, ageMs, stale: behind > TASK_PAIR_STALE_BASE_MAX_COMMITS || ageMs > TASK_PAIR_STALE_BASE_MAX_AGE_MS };
}

/** The worktree and head a pair's audit material names, when it is a git worktree of a repository with an integration ref. */
function gitMaterialOf(pair: TaskPairState): { repoPath: string; head: string } | undefined {
  const workspace = pair.workspace;
  if (!workspace || workspace.kind !== 'worktree' || workspace.nonGit) return undefined;
  const repoPath = pair.material?.worktree ?? workspace.path;
  const head = pair.material?.head ?? workspace.lastHead;
  if (!repoPath || !head || !isAbsolute(repoPath) || !existsSync(repoPath)) return undefined;
  return { repoPath, head };
}

/**
 * At READY_FOR_AUDIT and at PASS: when the head's base is far behind the integration ref, tell the executor and Brain once per
 * stage and head ("rebase before the final round"). A warning, never a gate; fire-and-forget from the marker path.
 */
export async function checkStaleBaseNotice(project: string, taskId: string, stage: 'ready' | 'pass'): Promise<void> {
  try {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored || !isPairsEngineProject(project)) return;
    const material = gitMaterialOf(stored.state);
    if (!material) return;
    const key = `stale-base:${stage}:${material.head}`;
    if (stored.liveness.notified.includes(key)) return;
    const stale = await inspectStaleBase(material.repoPath, material.head);
    if (!stale?.stale) return;
    const latest = store.getPair(project, taskId);
    if (!latest || latest.liveness.notified.includes(key)) return;
    store.saveLiveness(project, taskId, { ...latest.liveness, notified: [...latest.liveness.notified, key] });
    const send = testDeps.send ?? sendTaskPairMessage;
    const pair = latest.state;
    if (pair.executor && pair.executor !== 'none') await send(pair.executor, taskId, 'stale-base', buildStaleBaseExecutorNotice(pair, material.head, stale, stage));
    await send(pair.brain, taskId, 'brain-stale-base', buildStaleBaseBrainLine(pair, material.head, stale, stage));
  } catch (error) {
    logger.warn({ err: error, taskId }, 'task-pair: stale-base check failed');
  }
}

// ---- the reminder pass ----------------------------------------------------------------------------------------------------------

interface Candidate {
  stored: StoredTaskPair;
  repoPath: string;
  head: string;
  base: string | undefined;
  endedAt: number;
  key: string;
}

function candidateOf(stored: StoredTaskPair, at: number): Candidate | undefined {
  const pair = stored.state;
  if (pair.status !== 'done' || pair.integrationDismissedAt !== undefined) return undefined;
  const workspace = pair.workspace;
  if (!workspace || workspace.kind !== 'worktree' || workspace.nonGit) return undefined;
  const endedAt = workspace.endedAt ?? pair.updatedAt;
  if (at - endedAt > TASK_PAIR_INTEGRATION_REMINDER_WINDOW_MS) return undefined;
  const head = pair.material?.head ?? workspace.lastHead;
  if (!head) return undefined;
  return { stored, repoPath: workspace.path, head, base: workspace.base, endedAt, key: `${head}@${endedAt}` };
}

/** Reminder state that still applies to this candidate (a different head, or a pair that finished again, starts over). */
function reminderStateOf(candidate: Candidate): Pick<TaskPairLiveness, 'integrationReminderCount' | 'integrationReminderLastAt' | 'integrationIntegratedAt'> {
  const live = candidate.stored.liveness;
  return live.integrationKey === candidate.key ? live : {};
}

/** When the next reminder for this candidate is due: after the grace for the first, then on the Brain-reminder pacing. */
function nextDueAt(candidate: Candidate): number {
  const state = reminderStateOf(candidate);
  const count = state.integrationReminderCount ?? 0;
  if (count <= 0) return candidate.endedAt + TASK_PAIR_INTEGRATION_REMINDER_GRACE_MS;
  return (state.integrationReminderLastAt ?? candidate.endedAt) + resolveTaskPairBrainReminderInterval(count);
}

function saveState(candidate: Candidate, patch: Partial<TaskPairLiveness>): void {
  const store = getTaskPairStore();
  const latest = store.getPair(candidate.stored.project, candidate.stored.state.taskId);
  if (!latest) return;
  const base = latest.liveness.integrationKey === candidate.key ? latest.liveness : { ...latest.liveness, integrationKey: candidate.key, integrationReminderCount: undefined, integrationReminderLastAt: undefined, integrationIntegratedAt: undefined };
  store.saveLiveness(candidate.stored.project, candidate.stored.state.taskId, { ...base, integrationKey: candidate.key, ...patch });
}

export interface IntegrationDriftPassResult { considered: number; checked: number; integrated: number; reminded: number }

/**
 * One heartbeat's pass: find finished, undismissed pairs whose reminder is due, ask git only for those, and send each Brain ONE
 * digest with one line per pair. State is persisted per pair only after the digest was accepted, so a restart neither repeats a
 * burst nor restarts the grace, and a busy Brain simply gets the digest on a later heartbeat.
 */
export function runIntegrationDriftPass(at: number = now()): Promise<IntegrationDriftPassResult> {
  // One pass at a time: a slow repository must not stack passes behind the heartbeat.
  passInFlight ??= runPass(at).finally(() => { passInFlight = undefined; });
  return passInFlight;
}

let passInFlight: Promise<IntegrationDriftPassResult> | undefined;

async function runPass(at: number): Promise<IntegrationDriftPassResult> {
  const result: IntegrationDriftPassResult = { considered: 0, checked: 0, integrated: 0, reminded: 0 };
  const store = getTaskPairStore();
  const due: Candidate[] = [];
  const listed = store.listRecentDonePairs(at - TASK_PAIR_INTEGRATION_REMINDER_WINDOW_MS, TASK_PAIR_INTEGRATION_REMINDER_MAX_PAIRS * 2);
  for (const stored of listed) {
    if (result.considered >= TASK_PAIR_INTEGRATION_REMINDER_MAX_PAIRS) break;
    const candidate = candidateOf(stored, at);
    if (!candidate) continue;
    result.considered += 1;
    if (reminderStateOf(candidate).integrationIntegratedAt !== undefined) continue;
    if (at < nextDueAt(candidate)) continue;
    if (!isPairsEngineProject(stored.project) || !existsSync(candidate.repoPath)) continue;
    due.push(candidate);
  }
  const unintegrated = new Map<string, Array<{ candidate: Candidate; integration: PairIntegration }>>();
  for (const candidate of due) {
    result.checked += 1;
    const integration = await inspectPairIntegration(candidate.repoPath, candidate.head, candidate.base);
    if (integration.state === 'integrated') {
      result.integrated += 1;
      saveState(candidate, { integrationIntegratedAt: at });
    } else if (integration.state === 'unintegrated') {
      const list = unintegrated.get(candidate.stored.state.brain) ?? [];
      list.push({ candidate, integration });
      unintegrated.set(candidate.stored.state.brain, list);
    }
  }
  const send = testDeps.send ?? sendTaskPairMessage;
  for (const [brain, entries] of unintegrated) {
    const text = buildIntegrationDriftDigest(entries.map(({ candidate, integration }) => ({
      taskId: candidate.stored.state.taskId,
      head: candidate.head,
      worktree: candidate.repoPath,
      ageMs: at - candidate.endedAt,
      ref: integration.ref ?? '',
      missing: integration.missing ?? 0,
    })));
    const delivered = await send(brain, TASK_PAIR_INTEGRATION_DIGEST_ID, TASK_PAIR_INTEGRATION_DIGEST_REASON, text);
    if (delivered !== 'sent' && delivered !== 'queued') continue;
    for (const { candidate } of entries) {
      const state = reminderStateOf(candidate);
      saveState(candidate, { integrationReminderCount: (state.integrationReminderCount ?? 0) + 1, integrationReminderLastAt: at });
      result.reminded += 1;
    }
  }
  return result;
}
