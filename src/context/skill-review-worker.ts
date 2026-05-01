import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import type {
  MaterializationSkillReviewJob,
  MaterializationSkillReviewScheduler,
} from './materialization-coordinator.js';
import {
  MEMORY_FEATURE_FLAGS,
  MEMORY_FEATURE_FLAGS_BY_NAME,
  memoryFeatureFlagEnvKey,
  type MemoryFeatureFlag,
  resolveEffectiveMemoryFeatureFlagValue,
} from '../../shared/feature-flags.js';
import {
  decideSkillReviewClaim,
  makeSkillReviewDailyCountKey,
  nextSkillReviewRetryAt,
  type SkillReviewJobState,
  type SkillReviewSchedulerPolicy,
  type SkillReviewState,
} from '../../shared/skill-review-scheduler.js';
import { computeMemoryFingerprint } from '../../shared/memory-fingerprint.js';
import {
  chooseSkillReviewWriteTarget,
  getUserSkillPath,
  makeSkillKey,
} from '../../shared/skill-store.js';
import { skillRegistryEntryToSource } from '../../shared/skill-registry-types.js';
import { sanitizeSkillEnvelopeContent } from '../../shared/skill-envelope.js';
import { getProcessedProjectionById } from '../store/context-store.js';
import { incrementCounter } from '../util/metrics.js';
import { warnOncePerHour } from '../util/rate-limited-warn.js';
import { getSkillRegistrySnapshot, upsertUserSkillRegistryEntry } from './skill-registry.js';
import { buildSkillRegistryEntryForWrittenUserSkill } from './skill-registry-builder.js';

type StoredSkillReviewJob = MaterializationSkillReviewJob & {
  state: SkillReviewJobState;
  attempt: number;
  updatedAt: number;
};

function readEnvFlag(flag: MemoryFeatureFlag): boolean | undefined {
  const raw = process.env[memoryFeatureFlagEnvKey(flag)];
  if (raw == null) return undefined;
  return raw === 'true' || raw === '1';
}

function effectiveSkillAutoCreationEnabled(): boolean {
  const environmentStartupDefault = Object.fromEntries(
    MEMORY_FEATURE_FLAGS.flatMap((flag): Array<[MemoryFeatureFlag, boolean]> => {
      const value = readEnvFlag(flag);
      return value === undefined ? [] : [[flag, value]];
    }),
  ) as Partial<Record<MemoryFeatureFlag, boolean>>;
  return resolveEffectiveMemoryFeatureFlagValue(MEMORY_FEATURE_FLAGS_BY_NAME.skillAutoCreation, {
    environmentStartupDefault,
  });
}

export class LocalSkillReviewWorker implements MaterializationSkillReviewScheduler {
  readonly policy?: Partial<SkillReviewSchedulerPolicy>;
  private readonly jobs = new Map<string, StoredSkillReviewJob>();
  private readonly lastRunByScope = new Map<string, number>();
  private readonly dailyCountByScope = new Map<string, number>();
  private readonly runningCountByScope = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  constructor(private readonly options: {
    homeDir?: string;
    featureEnabled?: boolean | (() => boolean);
    policy?: Partial<SkillReviewSchedulerPolicy>;
  } = {}) {
    this.policy = options.policy;
  }

  get featureEnabled(): boolean | (() => boolean) {
    return this.options.featureEnabled ?? effectiveSkillAutoCreationEnabled;
  }

  getState(scopeKey: string): SkillReviewState {
    const pendingKeys = new Set<string>();
    for (const job of this.jobs.values()) {
      if (job.scopeKey !== scopeKey) continue;
      if (job.state === 'pending' || job.state === 'retry_wait' || job.state === 'running') {
        pendingKeys.add(job.idempotencyKey);
      }
    }
    return {
      pendingKeys,
      lastRunByScope: this.lastRunByScope,
      dailyCountByScope: this.dailyCountByScope,
      runningCountByScope: this.runningCountByScope,
    };
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  stop(): void {
    this.shuttingDown = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  enqueue(job: MaterializationSkillReviewJob): void {
    if (!this.jobs.has(job.idempotencyKey)) {
      this.jobs.set(job.idempotencyKey, {
        ...job,
        state: 'pending',
        attempt: 0,
        updatedAt: job.createdAt,
      });
    }
    this.schedulePump(0);
  }

  async drainDueJobsForTests(now = Date.now()): Promise<void> {
    await this.pump(now);
  }

  private isEnabled(): boolean {
    const enabled = this.featureEnabled;
    return typeof enabled === 'function' ? enabled() : enabled;
  }

  private schedulePump(delayMs: number): void {
    if (this.timer || this.shuttingDown) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump(Date.now()).catch((error) => {
        incrementCounter('mem.skill.review_failed', { source: 'worker_pump' });
        warnOncePerHour('skill_review.worker_pump', { error: error instanceof Error ? error.message : String(error) });
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async pump(now: number): Promise<void> {
    const enabled = this.isEnabled();
    let nextDelay: number | undefined;
    for (const job of this.jobs.values()) {
      const claim = decideSkillReviewClaim({
        featureEnabled: enabled,
        shuttingDown: this.shuttingDown,
        job,
        now,
        runningCountByScope: this.runningCountByScope,
        policy: this.policy,
      });
      if (claim.action === 'skip') {
        if (job.state === 'retry_wait' && job.nextAttemptAt !== undefined) {
          const delay = Math.max(0, job.nextAttemptAt - now);
          nextDelay = nextDelay === undefined ? delay : Math.min(nextDelay, delay);
        }
        continue;
      }
      await this.runClaimedJob(job, now);
    }
    if (nextDelay !== undefined) this.schedulePump(nextDelay);
  }

  private async runClaimedJob(job: StoredSkillReviewJob, now: number): Promise<void> {
    job.state = 'running';
    job.attempt += 1;
    job.updatedAt = now;
    this.runningCountByScope.set(job.scopeKey, (this.runningCountByScope.get(job.scopeKey) ?? 0) + 1);
    try {
      await this.writeSkill(job);
      job.state = 'succeeded';
      job.updatedAt = Date.now();
      this.lastRunByScope.set(job.scopeKey, job.updatedAt);
      const dailyCountKey = makeSkillReviewDailyCountKey({ scopeKey: job.scopeKey, now: job.updatedAt });
      this.dailyCountByScope.set(dailyCountKey, (this.dailyCountByScope.get(dailyCountKey) ?? 0) + 1);
    } catch (error) {
      incrementCounter('mem.skill.review_failed', { source: 'worker_write' });
      warnOncePerHour('skill_review.worker_write', { error: error instanceof Error ? error.message : String(error) });
      if (job.attempt >= job.maxAttempts) {
        job.state = 'failed';
      } else {
        job.state = 'retry_wait';
        job.nextAttemptAt = nextSkillReviewRetryAt(Date.now(), job.attempt, this.policy);
        this.schedulePump(Math.max(0, job.nextAttemptAt - Date.now()));
      }
      job.updatedAt = Date.now();
    } finally {
      const running = Math.max(0, (this.runningCountByScope.get(job.scopeKey) ?? 1) - 1);
      if (running === 0) this.runningCountByScope.delete(job.scopeKey);
      else this.runningCountByScope.set(job.scopeKey, running);
    }
  }

  private async writeSkill(job: MaterializationSkillReviewJob): Promise<void> {
    const projection = getProcessedProjectionById(job.projectionId);
    if (!projection) throw new Error(`skill review projection not found: ${job.projectionId}`);
    const candidateText = [
      '# Learned workflow',
      '',
      projection.summary,
      '',
      `Source projection: ${job.projectionId}`,
    ].join('\n');
    const sanitized = sanitizeSkillEnvelopeContent(candidateText);
    if (!sanitized.ok) {
      incrementCounter('mem.skill.sanitize_rejected', { source: 'skill_review_worker' });
      throw new Error(sanitized.reason ?? 'skill review content rejected');
    }
    const skillHash = computeMemoryFingerprint({ kind: 'skill', content: projection.summary });
    const skillName = `imcodes-learned-${skillHash.slice(0, 12)}`;
    const homeDir = this.options.homeDir ?? homedir();
    const context = {
      canonicalRepoId: job.target.namespace.projectId,
      projectId: job.target.namespace.projectId,
      workspaceId: job.target.namespace.workspaceId,
      orgId: job.target.namespace.enterpriseId,
    };
    const target = chooseSkillReviewWriteTarget({
      candidateKey: makeSkillKey('learned', skillName),
      userSkillSources: getSkillRegistrySnapshot({ namespace: job.target.namespace, homeDir }).entries.map((entry) => skillRegistryEntryToSource(entry)),
      context,
    });
    const path = target.action === 'update_user_skill' && target.source.path
      ? target.source.path
      : getUserSkillPath({
        homeDir,
        category: 'learned',
        skillName,
      });
    const projectFrontMatter = [
      'project:',
      ...(context.canonicalRepoId ? [`  canonicalRepoId: ${JSON.stringify(context.canonicalRepoId)}`] : []),
      ...(context.projectId ? [`  projectId: ${JSON.stringify(context.projectId)}`] : []),
      ...(context.workspaceId ? [`  workspaceId: ${JSON.stringify(context.workspaceId)}`] : []),
      ...(context.orgId ? [`  orgId: ${JSON.stringify(context.orgId)}`] : []),
    ];
    const markdown = [
      '---',
      'schemaVersion: 1',
      `name: ${JSON.stringify(skillName)}`,
      'category: learned',
      'description: "Auto-created from post-response memory review."',
      ...projectFrontMatter,
      '---',
      sanitized.content,
      '',
    ].join('\n');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, markdown, 'utf8');
    upsertUserSkillRegistryEntry(buildSkillRegistryEntryForWrittenUserSkill({
      homeDir,
      path,
      skillName,
      category: 'learned',
      description: 'Auto-created from post-response memory review.',
      project: context,
    }), { homeDir });
  }
}
