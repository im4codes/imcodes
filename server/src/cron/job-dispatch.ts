/**
 * Cron handler: every minute — find due cron_jobs, dispatch via WsBridge.
 */
import { activeUserExistsSql } from '../security/user-status.js';
import { Cron } from 'croner';
import type { Env } from '../env.js';
import type { DbCronJob } from '../db/queries.js';
import { WsBridge } from '../ws/bridge.js';
import { logAudit } from '../security/audit.js';
import { randomHex } from '../security/crypto.js';
import {
  listActiveSharesForUser,
  resolveEffectiveShareCoverage,
  shareTargetFromSessionName,
  type ShareAuthorizationSnapshot,
  type ShareTarget,
} from '../db/tab-sharing.js';
import { resolveServerMemberAccessOrShareDeny, resolveHttpShareAccessForCoveredSession } from '../routes/share-http-auth.js';
import { isWholeServerShareUser } from '../security/server-share-boundary.js';
import { issueOwnerMachineAuthorityForSession, issueSharedMachineAuthorityForSession } from '../share/shared-machine-authority.js';
import type { Database } from '../db/client.js';
import {
  CRON_EXACT_SEND_CAPABILITY_V1,
  CRON_MSG,
  CRON_STATUS,
  normalizeCronCompletionPolicy,
  registerCronControlAction,
  type CronAction,
  type CronDispatchMessage,
} from '../../../shared/cron-types.js';
import { OWNER_MACHINE_AUTHORITY_FIELD, SHARED_MACHINE_AUTHORITY_FIELD } from '../../../shared/shared-machine-authority.js';
import { IMCODES_EXTERNAL_CLI_SENDER } from '../../../shared/imcodes-send.js';
import type { SharedActorEnvelope } from '../../../shared/tab-sharing.js';
import logger from '../util/logger.js';

type PreparedCronAction =
  | { ok: true; action: CronAction }
  | { ok: false; reason: string };

type ClaimedCronJob = DbCronJob & {
  previous_run_at?: number | null;
  /** Stable outbox id; present for transactional claims and recovery. */
  execution_id?: string;
  /** Provenance read inside the same DB snapshot/transaction as the job row. */
  snapshotProvenance?: CronProvenanceLookup;
};

/** Parse, validate and durably register legacy self-managed actions before use. */
async function prepareCronAction(env: Env, job: DbCronJob): Promise<PreparedCronAction> {
  let action: CronAction;
  try {
    action = JSON.parse(job.action) as CronAction;
  } catch {
    return { ok: false, reason: 'invalid_action' };
  }
  if (action.type !== 'command' || action.selfManaged !== true) return { ok: true, action };
  if (typeof action.command !== 'string') return { ok: false, reason: 'missing_authoritative_body' };
  const registered = registerCronControlAction(
    action,
    job.id,
    normalizeCronCompletionPolicy(job.completion_policy),
  );
  if (!registered.ok) return registered;
  if (registered.migrated) {
    const nextAction = JSON.stringify(registered.action);
    const result = await env.DB.execute(
      'UPDATE cron_jobs SET action = $1, updated_at = $2 WHERE id = $3 AND action = $4',
      [nextAction, Date.now(), job.id, job.action],
    );
    if (result.changes !== 1) return { ok: false, reason: 'cron_control_migration_conflict' };
    job.action = nextAction;
  }
  return { ok: true, action: registered.action };
}

export type CronProvenanceRow = { creator_user_id: string; shared: boolean };
export type CronProvenanceLookup =
  | { ok: true; row: CronProvenanceRow | null }
  | { ok: false; error: unknown };

export type DispatchJobNowOptions = {
  verifiedProvenance?: CronProvenanceLookup;
  skipReload?: boolean;
};

type CronJobWithJoinedProvenance = DbCronJob & {
  prov_present?: boolean;
  prov_creator_user_id?: string | null;
  prov_shared?: boolean | null;
};

function extractJoinedProvenance(row: CronJobWithJoinedProvenance): CronProvenanceLookup | undefined {
  if (row.prov_present === undefined) return undefined;
  return {
    ok: true,
    row: row.prov_present && row.prov_creator_user_id
      ? { creator_user_id: row.prov_creator_user_id, shared: Boolean(row.prov_shared) }
      : null,
  };
}

async function readCronJobProvenance(db: Database, jobId: string): Promise<CronProvenanceLookup> {
  if (typeof (db as { queryOne?: unknown })?.queryOne !== 'function') {
    return { ok: true, row: null };
  }
  try {
    const row = await db.queryOne<CronProvenanceRow>(
      'SELECT creator_user_id, shared FROM cron_job_provenance WHERE job_id = $1',
      [jobId],
    );
    return { ok: true, row: row ?? null };
  } catch (error) {
    return { ok: false, error };
  }
}

type SharedCronDispatchAuth =
  | { authorized: false }
  | {
      authorized: true;
      exactTargetSessionName?: string;
      participantActorUserId?: string;
      participantSnapshot?: ShareAuthorizationSnapshot;
    };

export async function readCronJobAndProvenanceLocked(
  db: Database,
  jobId: string,
): Promise<{ job: DbCronJob | null; provenance: CronProvenanceLookup }> {
  if (typeof (db as { queryOne?: unknown })?.queryOne !== 'function') {
    return { job: null, provenance: { ok: true, row: null } };
  }
  // Consistent lock order: lock cron_jobs row FIRST (blocking behind any concurrent
  // writer that already locked cron_jobs before mutating cron_job_provenance),
  // then start a fresh READ COMMITTED statement to read cron_job_provenance so
  // EvalPlanQual on a single LEFT JOIN ... FOR UPDATE OF j can never pair a
  // refetched j with a statement-start snapshot of provenance.
  const job = await db.queryOne<DbCronJob>(
    'SELECT * FROM cron_jobs WHERE id = $1 FOR UPDATE',
    [jobId],
  );
  if (!job) return { job: null, provenance: { ok: true, row: null } };
  const provenance = await readCronJobProvenance(db, job.id);
  return { job, provenance };
}

async function readCronJobAndProvenanceSnapshot(
  db: Database,
  jobId: string,
): Promise<{ job: DbCronJob | null; provenance: CronProvenanceLookup }> {
  if (typeof (db as { queryOne?: unknown })?.queryOne !== 'function') {
    return { job: null, provenance: { ok: true, row: null } };
  }
  const row = await db.queryOne<CronJobWithJoinedProvenance>(
    `SELECT j.*,
            p.creator_user_id AS prov_creator_user_id,
            p.shared AS prov_shared,
            (p.job_id IS NOT NULL) AS prov_present
       FROM cron_jobs j
       LEFT JOIN cron_job_provenance p ON p.job_id = j.id
      WHERE j.id = $1`,
    [jobId],
  );
  if (!row) return { job: null, provenance: { ok: true, row: null } };
  const joinedProv = extractJoinedProvenance(row);
  if (joinedProv) return { job: row, provenance: joinedProv };
  const provenance = await readCronJobProvenance(db, row.id);
  return { job: row, provenance };
}

async function verifySharedCronCreatorStillAuthorized(
  db: Database,
  job: DbCronJob,
  now: number,
  prov: CronProvenanceRow | null,
): Promise<SharedCronDispatchAuth> {
  if (!prov || !prov.shared || prov.creator_user_id === job.user_id) return { authorized: true };

  const member = await resolveServerMemberAccessOrShareDeny(db, {
    serverId: job.server_id,
    userId: prov.creator_user_id,
  });
  if (member.ok) {
    if (await isWholeServerShareUser(db, job.server_id, prov.creator_user_id, now)) {
      const coverage = await resolveEffectiveShareCoverage(db, {
        userId: prov.creator_user_id,
        target: { kind: 'server', serverId: job.server_id },
        now,
      });
      if (!coverage || coverage.effectiveRole !== 'participant') return { authorized: false };
      return {
        authorized: true,
        participantActorUserId: prov.creator_user_id,
        participantSnapshot: coverage,
      };
    }
    return { authorized: true };
  }

  const shares = await listActiveSharesForUser(db, prov.creator_user_id, now);
  const participantShares = shares.filter((s) => s.serverId === job.server_id && s.role === 'participant');
  if (participantShares.length === 0) return { authorized: false };

  let matchingMainShareTarget: ShareTarget | null = null;
  for (const s of participantShares) {
    if (s.target.kind === 'main' && s.target.sessionName && job.project_name) {
      const sess = await db.queryOne<{ project_name: string }>(
        'SELECT project_name FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
        [job.server_id, s.target.sessionName],
      );
      if (sess?.project_name === job.project_name) {
        matchingMainShareTarget = s.target;
        break;
      }
    }
  }
  const hasMatchingMainShare = matchingMainShareTarget !== null;

  let parsedAction: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(job.action);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsedAction = parsed as Record<string, unknown>;
    }
  } catch {
    return { authorized: false };
  }

  // Non-whole-server shared crons must never use broadcast send semantics,
  // which fan out across all project candidates regardless of target.
  if (parsedAction?.type === 'send' && parsedAction.broadcast === true) {
    return { authorized: false };
  }

  const resolveExactSendTarget = async (allowedPinnedSession: string | null): Promise<string | null> => {
    if (parsedAction?.type !== 'send') return null;
    const rawTarget = typeof parsedAction.target === 'string' ? parsedAction.target.trim() : '';
    if (!rawTarget) return null;
    let canonical: string | null = null;
    if (rawTarget.startsWith('deck_')) {
      canonical = rawTarget;
    } else if (/^(brain|w\d+)$/.test(rawTarget) && job.project_name) {
      canonical = `deck_${job.project_name}_${rawTarget}`;
    } else {
      // Never accept arbitrary label / agentType strings on non-whole-server shared crons.
      return null;
    }
    if (allowedPinnedSession && canonical !== allowedPinnedSession) {
      return null;
    }
    const coveredTarget = shareTargetFromSessionName(job.server_id, canonical);
    if (!coveredTarget) return null;
    const access = await resolveHttpShareAccessForCoveredSession(db, {
      serverId: job.server_id,
      userId: prov.creator_user_id,
      target: coveredTarget,
    });
    if (access.actor.kind === 'share' && access.actor.effectiveActorRole === 'participant') {
      return canonical;
    }
    if (!allowedPinnedSession && hasMatchingMainShare && job.project_name) {
      if (coveredTarget.kind === 'main') {
        const sess = await db.queryOne<{ project_name: string }>(
          'SELECT project_name FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
          [job.server_id, coveredTarget.sessionName],
        );
        if (sess?.project_name === job.project_name) return canonical;
      } else if (coveredTarget.kind === 'subsession') {
        const sub = await db.queryOne<{ parent_session: string | null; closed_at: number | null; execution_clone_metadata: unknown }>(
          'SELECT parent_session, closed_at, execution_clone_metadata FROM sub_sessions WHERE id = $1 AND server_id = $2 LIMIT 1',
          [coveredTarget.subSessionId, job.server_id],
        );
        if (sub && sub.closed_at === null && !sub.execution_clone_metadata && sub.parent_session) {
          const parent = await db.queryOne<{ project_name: string }>(
            'SELECT project_name FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
            [job.server_id, sub.parent_session],
          );
          if (parent?.project_name === job.project_name) return canonical;
        }
      }
    }
    return null;
  };

  if (job.target_session_name) {
    const target = shareTargetFromSessionName(job.server_id, job.target_session_name);
    if (!target) return { authorized: false };
    const access = await resolveHttpShareAccessForCoveredSession(db, {
      serverId: job.server_id,
      userId: prov.creator_user_id,
      target,
    });
    if (access.actor.kind !== 'share' || access.actor.effectiveActorRole !== 'participant') {
      return { authorized: false };
    }
    let exactSendTarget: string | undefined;
    if (parsedAction?.type === 'send') {
      const resolved = await resolveExactSendTarget(hasMatchingMainShare ? null : job.target_session_name);
      if (!resolved) return { authorized: false };
      if (!hasMatchingMainShare && resolved !== job.target_session_name) return { authorized: false };
      exactSendTarget = resolved;
    }
    if (!hasMatchingMainShare && parsedAction?.type === 'p2p') {
      if (Array.isArray(parsedAction.participants) && parsedAction.participants.length > 0) {
        return { authorized: false };
      }
      const entries = Array.isArray(parsedAction.participantEntries) ? parsedAction.participantEntries : [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object'
          || (entry as Record<string, unknown>).type !== 'session'
          || (entry as Record<string, unknown>).value !== job.target_session_name) {
          return { authorized: false };
        }
      }
    }
    return {
      authorized: true,
      ...(exactSendTarget ? { exactTargetSessionName: exactSendTarget } : {}),
      participantActorUserId: prov.creator_user_id,
      participantSnapshot: access.actor.coverage,
    };
  }

  if (!hasMatchingMainShare || !matchingMainShareTarget) return { authorized: false };

  let exactMainSendTarget: string | undefined;
  if (parsedAction?.type === 'send') {
    const resolved = await resolveExactSendTarget(null);
    if (!resolved) return { authorized: false };
    exactMainSendTarget = resolved;
  }
  if (parsedAction?.type === 'p2p') {
    const entries = Array.isArray(parsedAction.participantEntries) ? parsedAction.participantEntries : [];
    for (const entry of entries) {
      if (entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'session') {
        const value = (entry as Record<string, unknown>).value;
        if (typeof value !== 'string') return { authorized: false };
        const entryTarget = shareTargetFromSessionName(job.server_id, value);
        if (!entryTarget) return { authorized: false };
        const access = await resolveHttpShareAccessForCoveredSession(db, {
          serverId: job.server_id,
          userId: prov.creator_user_id,
          target: entryTarget,
        });
        if (access.actor.kind !== 'share' || access.actor.effectiveActorRole !== 'participant') {
          return { authorized: false };
        }
      }
    }
  }

  const coverage = await resolveEffectiveShareCoverage(db, {
    userId: prov.creator_user_id,
    target: matchingMainShareTarget,
    now,
  });
  if (!coverage || coverage.effectiveRole !== 'participant') return { authorized: false };
  return {
    authorized: true,
    ...(exactMainSendTarget ? { exactTargetSessionName: exactMainSendTarget } : {}),
    participantActorUserId: prov.creator_user_id,
    participantSnapshot: coverage,
  };
}

type CronDispatchAuthorityFields = {
  [OWNER_MACHINE_AUTHORITY_FIELD]?: string;
  [SHARED_MACHINE_AUTHORITY_FIELD]?: string;
  sharedActor?: SharedActorEnvelope;
};

function buildExternalCliCronActorEnvelope(
  job: DbCronJob,
  targetSessionName: string,
  actionId: string,
): SharedActorEnvelope {
  const target = targetSessionName.startsWith('deck_sub_')
    ? { kind: 'subsession' as const, serverId: job.server_id, subSessionId: targetSessionName }
    : { kind: 'main' as const, serverId: job.server_id, sessionName: targetSessionName };
  return {
    actorUserId: IMCODES_EXTERNAL_CLI_SENDER,
    actorDisplayName: IMCODES_EXTERNAL_CLI_SENDER,
    snapshot: {
      target,
      effectiveRole: 'participant',
      historyCutoffAt: 0,
      nextCoverageRecheckAt: null,
      coveringShareIds: [],
      primaryShareId: null,
      authorizedAt: job.created_at,
    },
    primaryShareId: null,
    effectiveActorRole: 'participant',
    actionId,
    origin: 'server-member',
    authorizedAt: job.created_at,
  };
}

async function issueCronDispatchAuthority(
  env: Env,
  job: DbCronJob,
  executionId: string,
  prov: CronProvenanceRow | null,
  auth: Extract<SharedCronDispatchAuth, { authorized: true }>,
): Promise<CronDispatchAuthorityFields> {
  const targetSessionName = job.target_session_name?.trim()
    || (job.project_name ? `deck_${job.project_name}_${job.target_role ?? 'brain'}` : '');
  const actionId = `cron-${job.id}-${executionId}`;

  if (prov?.creator_user_id === IMCODES_EXTERNAL_CLI_SENDER) {
    // External-CLI restricted crons always run under least-privilege participant restriction
    // with zero owner or shared-machine authority, never elevating back into owner turns.
    return targetSessionName
      ? { sharedActor: buildExternalCliCronActorEnvelope(job, targetSessionName, actionId) }
      : {};
  }

  if (!env.JWT_SIGNING_KEY || typeof (env.DB as { queryOne?: unknown })?.queryOne !== 'function') {
    return {};
  }
  if (!targetSessionName) return {};

  if (auth.participantActorUserId && auth.participantSnapshot) {
    const shareTarget = auth.participantSnapshot.target;
    const token = await issueSharedMachineAuthorityForSession(env.DB, {
      actorUserId: auth.participantActorUserId,
      sourceServerId: job.server_id,
      sessionName: targetSessionName,
      shareTarget,
      actionId,
      signingKey: env.JWT_SIGNING_KEY,
    });
    const sharedActor: SharedActorEnvelope = {
      actorUserId: auth.participantActorUserId,
      actorDisplayName: auth.participantActorUserId,
      snapshot: auth.participantSnapshot,
      primaryShareId: auth.participantSnapshot.primaryShareId ?? null,
      effectiveActorRole: 'participant',
      actionId,
      origin: shareTarget.kind === 'server' ? 'shared-server' : 'shared-tab',
      authorizedAt: auth.participantSnapshot.authorizedAt,
    };
    return {
      sharedActor,
      ...(token ? { [SHARED_MACHINE_AUTHORITY_FIELD]: token } : {}),
    };
  }

  if (prov?.shared && prov.creator_user_id !== job.user_id) return {};
  const token = await issueOwnerMachineAuthorityForSession(env.DB, {
    actorUserId: job.user_id,
    sourceServerId: job.server_id,
    sessionName: targetSessionName,
    actionId,
    signingKey: env.JWT_SIGNING_KEY,
  });
  return token ? { [OWNER_MACHINE_AUTHORITY_FIELD]: token } : {};
}

/** Immediately dispatch a single cron job (for manual "Run Now" trigger). */
export async function dispatchJobNow(
  env: Env,
  passedJob: DbCronJob,
  opts?: DispatchJobNowOptions,
): Promise<void> {
  let job = passedJob;
  let provenance: CronProvenanceLookup;
  if (opts?.skipReload && opts.verifiedProvenance) {
    provenance = opts.verifiedProvenance;
  } else if (typeof (env.DB as { queryOne?: unknown })?.queryOne === 'function') {
    const loaded = await readCronJobAndProvenanceSnapshot(env.DB, passedJob.id);
    if (!loaded.job) {
      throw new Error('cron_not_found');
    }
    job = loaded.job;
    provenance = loaded.provenance;
  } else {
    provenance = await readCronJobProvenance(env.DB, passedJob.id);
  }
  if (!provenance.ok) {
    throw provenance.error instanceof Error ? provenance.error : new Error('cron_provenance_read_failed');
  }
  const auth = await verifySharedCronCreatorStillAuthorized(env.DB, job, Date.now(), provenance.row);
  if (!auth.authorized) {
    await env.DB.execute('UPDATE cron_jobs SET status = $1, updated_at = $2 WHERE id = $3', [CRON_STATUS.PAUSED, Date.now(), job.id]).catch(() => {});
    await logExecution(env, randomHex(12), job.id, 'error', 'share_revoked');
    throw new Error('share_revoked');
  }
  const prepared = await prepareCronAction(env, job);
  if (!prepared.ok) {
    await logExecution(env, randomHex(12), job.id, 'error', prepared.reason);
    throw new Error(prepared.reason);
  }
  const action = auth.exactTargetSessionName && prepared.action.type === 'send'
    ? { ...prepared.action, target: auth.exactTargetSessionName }
    : prepared.action;

  const bridge = WsBridge.get(job.server_id);
  if (!bridge.isDaemonConnected()) {
    await logExecution(env, randomHex(12), job.id, 'skipped_offline');
    throw new Error('daemon_offline');
  }
  if (auth.exactTargetSessionName && action.type === 'send') {
    const supportsExact = typeof (bridge as { hasDaemonCapability?: unknown }).hasDaemonCapability === 'function'
      && (bridge as { hasDaemonCapability: (cap: string) => boolean }).hasDaemonCapability(CRON_EXACT_SEND_CAPABILITY_V1);
    if (!supportsExact) {
      await logExecution(env, randomHex(12), job.id, 'error', 'daemon_upgrade_required_exact_cron_send');
      throw new Error('daemon_upgrade_required_exact_cron_send');
    }
  }

  if (!job.target_role) {
    logger.warn({ jobId: job.id }, 'Cron manual trigger: target_role is NULL, defaulting to brain');
  }
  const executionId = randomHex(12);
  const authorityFields = await issueCronDispatchAuthority(env, job, executionId, provenance.row, auth);
  const msg: CronDispatchMessage = {
    type: CRON_MSG.DISPATCH,
    jobId: job.id,
    executionId,
    jobName: job.name,
    serverId: job.server_id,
    projectName: job.project_name ?? '',
    targetRole: job.target_role ?? 'brain',
    cronExpr: job.cron_expr,
    timezone: job.timezone,
    expiresAt: job.expires_at,
    completionPolicy: normalizeCronCompletionPolicy(job.completion_policy),
    previousRunAt: job.last_run_at,
    nextRunAt: job.next_run_at,
    ...(job.target_session_name ? { targetSessionName: job.target_session_name } : {}),
    ...(auth.exactTargetSessionName ? { exactTargetSessionName: auth.exactTargetSessionName } : {}),
    ...authorityFields,
    action,
  };
  bridge.sendToDaemon(JSON.stringify(msg));

  await logExecution(env, executionId, job.id, 'manual_trigger');
  logger.info({ jobId: job.id, jobName: job.name }, 'Cron job manually triggered');
}

/**
 * Claim due occurrences before doing any external work.
 *
 * The old dispatcher only advanced `last_run_at` in the claim statement and
 * advanced `next_run_at` after sending to the daemon.  A process crash (or a
 * pod restart) in that window left the same occurrence due, so the next tick
 * sent it again.  Keep the lock, schedule advancement, and returned claim in
 * one transaction; once it commits, a restart can only observe the following
 * occurrence.  The send itself remains outside the transaction so a slow or
 * disconnected daemon never holds a row lock.
 */
async function claimDueJobs(
  env: Env,
  now: number,
): Promise<ClaimedCronJob[]> {
  const selectDue = async (db: typeof env.DB): Promise<ClaimedCronJob[]> => (
    db.query<ClaimedCronJob>(
      `SELECT *, last_run_at AS previous_run_at
         FROM cron_jobs
        WHERE status = $2 AND next_run_at <= $1
          AND (expires_at IS NULL OR expires_at >= $1)
          AND ${activeUserExistsSql('cron_jobs.user_id')}
        ORDER BY next_run_at ASC
        LIMIT 50
        FOR UPDATE SKIP LOCKED`,
      [now, CRON_STATUS.ACTIVE],
    )
  );

  // Production Database always exposes transaction().  Keep the direct path
  // for the small database-shaped test seams and older embedders; it still
  // advances each occurrence before its external send (see the loop below).
  const transaction = (env.DB as typeof env.DB & {
    transaction?: <T>(fn: (tx: typeof env.DB) => Promise<T>) => Promise<T>;
  }).transaction;
  if (typeof transaction === 'function') {
    return await transaction.call(env.DB, async (tx) => {
      const jobs = await selectDue(tx);
      const claimed: ClaimedCronJob[] = [];
      for (const job of jobs) {
        const snapshotProvenance = await readCronJobProvenance(tx, job.id);
        const nextRun = calculateNextRun(job.cron_expr, now, job.timezone);
        const result = await tx.execute(
          'UPDATE cron_jobs SET last_run_at = $1, next_run_at = $2 WHERE id = $3 AND status = $4 AND next_run_at <= $1',
          [now, nextRun, job.id, CRON_STATUS.ACTIVE],
        );
        if (result.changes !== 1) continue;
        const executionId = randomHex(12);
        // cron_executions doubles as a small durable outbox.  The schedule
        // claim and its dispatch intent commit together, so a restart can
        // recover the intent even if it dies before the WS send.
        await tx.execute(
          'INSERT INTO cron_executions (id, job_id, status, detail, created_at) VALUES ($1, $2, $3, $4, $5)',
          [executionId, job.id, 'pending_dispatch', JSON.stringify({ previousRunAt: job.last_run_at, nextRunAt: nextRun }), now],
        );
        claimed.push({ ...job, last_run_at: now, next_run_at: nextRun, execution_id: executionId, snapshotProvenance });
      }
      return claimed;
    }) as ClaimedCronJob[];
  }

  // Compatibility fallback: the query's row lock is released when the query
  // returns, so advance each row immediately before it is sent.  Real
  // deployments use the transactional path above.
  const jobs = await env.DB.query<DbCronJob & { previous_run_at?: number | null }>(
    `WITH due AS (
       SELECT id, last_run_at AS previous_run_at FROM cron_jobs
       WHERE status = $2 AND next_run_at <= $1
         AND (expires_at IS NULL OR expires_at >= $1)
         AND ${activeUserExistsSql('cron_jobs.user_id')}
       ORDER BY next_run_at ASC
       LIMIT 50
       FOR UPDATE SKIP LOCKED
     )
     UPDATE cron_jobs SET last_run_at = $1
     FROM due WHERE cron_jobs.id = due.id
     RETURNING cron_jobs.*, due.previous_run_at`,
    [now, CRON_STATUS.ACTIVE],
  );
  return jobs;
}

async function recoverPendingDispatches(env: Env): Promise<ClaimedCronJob[]> {
  // Older database-shaped test seams and embedders do not have the
  // transaction/outbox contract; their CTE claim remains the compatibility
  // path and has no recoverable intent rows.
  if (typeof (env.DB as typeof env.DB & { transaction?: unknown }).transaction !== 'function') return [];
  const transaction = (env.DB as typeof env.DB & {
    transaction?: <T>(fn: (tx: typeof env.DB) => Promise<T>) => Promise<T>;
  }).transaction!;
  const now = Date.now();
  return transaction.call<typeof env.DB, [(tx: typeof env.DB) => Promise<ClaimedCronJob[]>], Promise<ClaimedCronJob[]>>(env.DB, async (tx) => {
    const rows = await tx.query<ClaimedCronJob & { execution_detail?: string | null }>(
      `SELECT j.*,
              e.id AS execution_id,
              e.detail AS execution_detail
         FROM cron_executions e
         JOIN cron_jobs j ON j.id = e.job_id
        WHERE (e.status = 'pending_dispatch'
           OR (e.status = 'dispatching' AND e.created_at <= $1))
          AND ${activeUserExistsSql('j.user_id')}
        ORDER BY e.created_at ASC
        LIMIT 50
        FOR UPDATE OF e, j SKIP LOCKED`,
      [now - 60_000],
    );
    const claimed: ClaimedCronJob[] = [];
    for (const row of rows.filter((candidate) => typeof candidate.execution_id === 'string' && candidate.execution_id.length > 0)) {
      const snapshotProvenance = await readCronJobProvenance(tx, row.id);
      let detail: { previousRunAt?: number | null; nextRunAt?: number } = {};
      try {
        detail = row.execution_detail ? JSON.parse(row.execution_detail) as typeof detail : {};
      } catch { /* malformed outbox detail is handled as the current job */ }
      await tx.execute(
        'UPDATE cron_executions SET status = $1, detail = $2 WHERE id = $3 AND status IN ($4, $5)',
        ['dispatching', JSON.stringify({ ...detail, claimedAt: now }), row.execution_id, 'pending_dispatch', 'dispatching'],
      );
      claimed.push({
        ...row,
        ...(detail.previousRunAt !== undefined ? { previous_run_at: detail.previousRunAt } : {}),
        ...(detail.nextRunAt !== undefined ? { next_run_at: detail.nextRunAt } : {}),
        snapshotProvenance,
      });
    }
    return claimed;
  });
}

export async function jobDispatchCron(env: Env): Promise<void> {
  const now = Date.now();
  // Replay durable intents first.  They were claimed by a prior tick but may
  // not have reached the daemon before a server restart.
  const pendingJobs = await recoverPendingDispatches(env);
  const dueJobs = [...pendingJobs, ...(await claimDueJobs(env, now))];

  // Periodic cleanup of old execution history (~1% of ticks)
  if (Math.random() < 0.01) {
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    await env.DB.execute('DELETE FROM cron_executions WHERE created_at < $1', [thirtyDaysAgo]).catch(() => {});
  }

  for (const job of dueJobs) {
    try {
      const provenance = job.snapshotProvenance ?? await readCronJobProvenance(env.DB, job.id);
      if (!provenance.ok) {
        logger.error({ jobId: job.id, err: provenance.error }, 'Cron provenance read failed; refusing dispatch and keeping pending for retry');
        if (job.execution_id) {
          await env.DB.execute('UPDATE cron_executions SET status = $1 WHERE id = $2 AND status = $3', [
            'pending_dispatch', job.execution_id, 'dispatching',
          ]).catch(() => {});
        } else {
          await logExecution(env, randomHex(12), job.id, 'error', 'provenance_read_failed');
        }
        continue;
      }
      const auth = await verifySharedCronCreatorStillAuthorized(env.DB, job, now, provenance.row);
      if (!auth.authorized) {
        logger.info({ jobId: job.id }, 'Pausing shared cron job because creator access was revoked');
        await env.DB.execute('UPDATE cron_jobs SET status = $1, updated_at = $2 WHERE id = $3', [CRON_STATUS.PAUSED, now, job.id]).catch(() => {});
        if (job.execution_id) {
          await env.DB.execute('UPDATE cron_executions SET status = $1, detail = $2 WHERE id = $3 AND status = $4', [
            'error', 'share_revoked', job.execution_id, 'dispatching',
          ]);
        }
        await logExecution(env, randomHex(12), job.id, 'error', 'share_revoked');
        continue;
      }
      const prepared = await prepareCronAction(env, job);
      if (!prepared.ok) {
        logger.error({ jobId: job.id, reason: prepared.reason }, 'Cron job has invalid action/control state, marking as error');
        await env.DB.execute('UPDATE cron_jobs SET status = $1 WHERE id = $2', [CRON_STATUS.ERROR, job.id]);
        if (job.execution_id) {
          await env.DB.execute('UPDATE cron_executions SET status = $1, detail = $2 WHERE id = $3 AND status = $4', [
            'error', prepared.reason, job.execution_id, 'dispatching',
          ]);
        }
        await logExecution(env, randomHex(12), job.id, 'error', prepared.reason);
        continue;
      }
      const action = auth.exactTargetSessionName && prepared.action.type === 'send'
        ? { ...prepared.action, target: auth.exactTargetSessionName }
        : prepared.action;

      // Skip if daemon offline (fire-and-forget)
      const bridge = WsBridge.get(job.server_id);
      if (!bridge.isDaemonConnected()) {
        logger.debug({ jobId: job.id }, 'Cron skipped: daemon offline');
        const nextRun = job.next_run_at ?? calculateNextRun(job.cron_expr, now, job.timezone);
        await env.DB.execute('UPDATE cron_jobs SET next_run_at = $1 WHERE id = $2', [nextRun, job.id]);
        if (job.execution_id) {
          await env.DB.execute('UPDATE cron_executions SET status = $1 WHERE id = $2 AND status = $3', [
            'pending_dispatch', job.execution_id, 'dispatching',
          ]);
        } else {
          await logExecution(env, randomHex(12), job.id, 'skipped_offline');
        }
        continue;
      }
      if (auth.exactTargetSessionName && action.type === 'send') {
        const supportsExact = typeof (bridge as { hasDaemonCapability?: unknown }).hasDaemonCapability === 'function'
          && (bridge as { hasDaemonCapability: (cap: string) => boolean }).hasDaemonCapability(CRON_EXACT_SEND_CAPABILITY_V1);
        if (!supportsExact) {
          logger.error({ jobId: job.id }, 'Daemon does not support exact scoped cron send; refusing dispatch');
          if (job.execution_id) {
            await env.DB.execute('UPDATE cron_executions SET status = $1, detail = $2 WHERE id = $3 AND status = $4', [
              'error', 'daemon_upgrade_required_exact_cron_send', job.execution_id, 'dispatching',
            ]);
          }
          await logExecution(env, randomHex(12), job.id, 'error', 'daemon_upgrade_required_exact_cron_send');
          continue;
        }
      }

      // Dispatch to daemon.  Transactional claims already advanced the
      // schedule.  Database-shaped fallback callers claim only last_run_at,
      // so advance next_run_at immediately before this external side effect.
      if (!(env.DB as typeof env.DB & { transaction?: unknown }).transaction) {
        const fallbackNextRun = calculateNextRun(job.cron_expr, now, job.timezone);
        const fallbackExecutionId = randomHex(12);
        // Compatibility databases without Database.transaction still get one
        // PostgreSQL statement for schedule advancement + outbox insertion;
        // there is no update→insert crash gap. Production always takes the
        // stronger transaction path above.
        await env.DB.execute(
          `WITH claimed AS (
             UPDATE cron_jobs SET next_run_at = $1
              WHERE id = $2 AND last_run_at = $3
              RETURNING id
           )
           INSERT INTO cron_executions (id, job_id, status, detail, created_at)
           SELECT $4, id, $5, $6, $7 FROM claimed`,
          [fallbackNextRun, job.id, now, fallbackExecutionId, 'pending_dispatch', JSON.stringify({ previousRunAt: job.previous_run_at ?? job.last_run_at, nextRunAt: fallbackNextRun }), now],
        );
        job.next_run_at = fallbackNextRun;
        job.execution_id = fallbackExecutionId;
      }
      if (!job.target_role) {
        logger.warn({ jobId: job.id }, 'Cron: target_role is NULL, defaulting to brain');
      }
      // Use the value written by the claim, rather than recalculating it after
      // the claim, so the payload always describes the durable occurrence.
      const nextRun = job.next_run_at ?? calculateNextRun(job.cron_expr, now, job.timezone);
      const executionId = job.execution_id ?? randomHex(12);
      const authorityFields = await issueCronDispatchAuthority(env, job, executionId, provenance.row, auth);
      const msg: CronDispatchMessage = {
        type: CRON_MSG.DISPATCH,
        jobId: job.id,
        executionId,
        jobName: job.name,
        serverId: job.server_id,
        projectName: job.project_name ?? '',
        targetRole: job.target_role ?? 'brain',
        cronExpr: job.cron_expr,
        timezone: job.timezone,
        expiresAt: job.expires_at,
        completionPolicy: normalizeCronCompletionPolicy(job.completion_policy),
        previousRunAt: Object.prototype.hasOwnProperty.call(job, 'previous_run_at')
          ? job.previous_run_at
          : job.last_run_at,
        nextRunAt: nextRun,
        ...(job.target_session_name ? { targetSessionName: job.target_session_name } : {}),
        ...(auth.exactTargetSessionName ? { exactTargetSessionName: auth.exactTargetSessionName } : {}),
        ...authorityFields,
        action,
      };
      bridge.sendToDaemon(JSON.stringify(msg));

      // Transactional claims advanced the schedule before this send.  The
      // fallback advanced it immediately above; do not leave a post-send
      // write window in which a restart can redispatch the same occurrence.

      // Auto-expire if next run is past expiration
      if (job.expires_at && nextRun > job.expires_at) {
        await env.DB.execute('UPDATE cron_jobs SET status = $1 WHERE id = $2', [CRON_STATUS.EXPIRED, job.id]);
      }

      if (job.execution_id) {
        await env.DB.execute('UPDATE cron_executions SET status = $1, detail = $2 WHERE id = $3 AND status = $4', [
          'dispatched', null, job.execution_id, 'dispatching',
        ]);
      } else {
        await logExecution(env, msg.executionId!, job.id, 'dispatched');
      }

      await logAudit(
        { userId: job.user_id, serverId: job.server_id, action: 'cron.job.dispatched', details: { jobId: job.id, jobName: job.name } },
        env.DB,
      );
    } catch (err) {
      logger.error({ jobId: job.id, err }, 'Cron job dispatch failed');
    }
  }

  if (dueJobs.length > 0) {
    logger.info({ dispatched: dueJobs.length }, 'Job dispatch cron complete');
  }
}

async function logExecution(env: Env, executionId: string, jobId: string, status: string, detail?: string): Promise<void> {
  await env.DB.execute(
    'INSERT INTO cron_executions (id, job_id, status, detail, created_at) VALUES ($1, $2, $3, $4, $5)',
    [executionId, jobId, status, detail ?? null, Date.now()],
  ).catch((err) => logger.error({ jobId, err }, 'Failed to log cron execution'));
}

function calculateNextRun(cronExpr: string, fromMs: number, timezone?: string | null): number {
  try {
    const opts = timezone ? { timezone } : undefined;
    const job = new Cron(cronExpr, opts);
    const next = job.nextRun(new Date(fromMs));
    return next ? next.getTime() : fromMs + 60_000;
  } catch {
    return fromMs + 60_000;
  }
}
