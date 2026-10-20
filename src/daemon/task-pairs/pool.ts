/**
 * Execution-pool membership and daemon picks for task pairs (design D12).
 *
 * The execution pool is kept exactly as configured on the Brain (primary /
 * economy pools, eligibility, capacity, auto-provisioning, and a per-entry
 * role -- executor, auditor, or both); the pairs engine only reads it. The
 * daemon picks a participant itself only for an AUTOMATIC dispatch or
 * auditor replacement (no named session/model), filtered by pool membership
 * and the matching entry's role.
 *
 * Owner rule (2026-10): a project with no execution pool configured does not
 * wait for the user. Its automatic picks use the Brain's idle sub-sessions of
 * the SAME provider family that run that family's secondary model (sonnet,
 * gpt-6-sol, deepseek-pro: the `auditor` column of SUPERVISION_TIER_PAIRS) --
 * never another vendor, never the family's flagship, and no session is created
 * for it (see `isDefaultSecondarySession`). With none of those the scheduler
 * asks the user (`brainHasConfiguredPools`, `describeDefaultPoolGap`).
 * What the user or Brain names explicitly (an exact session, or
 * `executormodel=`/`auditormodel=`) is used as-is and provisioned if it does
 * not exist yet, even outside the pool and regardless of any entry's role --
 * the pool governs only automatic picks, never a named one.
 */
import { getSession, listSessions, type SessionRecord } from '../../store/session-store.js';
import { resolveEffectiveSessionModel } from '../../../shared/session-model.js';
import {
  DELEGATION_AVAILABILITY,
  resolveDelegationTargets,
} from '../../../shared/delegation-availability.js';
import { resolvePeerAuditProviderFamily } from '../../../shared/peer-audit.js';
import { getSessionRuntimeType } from '../../../shared/agent-types.js';
import { inferSharedContextRuntimeBackend } from '../../../shared/shared-context-runtime-config.js';
import {
  SUPERVISION_DEFAULT_EXCLUDED_DEVELOPMENT_SESSIONS,
  SUPERVISION_EXECUTION_SELECTION_SOURCES,
  type SupervisionExecutionSelectionSource,
  buildSupervisionExecutionCapabilityId,
  isExcludedDevelopmentModel,
  isDefaultSecondaryTierTarget,
  supervisionSecondaryModelOfFamily,
  normalizeSupervisionExecutionModel,
  supervisionTierPriority,
  supervisionExecutionConfigAllowsRole,
  type SupervisionExecutionConfig,
  type SupervisionExecutionPoolKind,
} from '../../../shared/supervision-execution-pool.js';
import { delegationTargetInputs } from '../delegation-admission.js';
import { configMatchesSession, configuredPools, poolDefinition } from '../supervision-auto-provision.js';
import { describeSupervisorDefaultsSyncGap } from '../supervisor-defaults-cache.js';
import { getTransportRuntime } from '../../agent/session-manager.js';
import { describeSessionWork, isSessionWorking } from '../session-working.js';
import type { TransportRuntimeDiagnosticSnapshot } from '../../agent/transport-session-runtime.js';
import { TASK_PAIR_CREATED_SESSION_REASONS, TASK_PAIR_NO_AUDITOR, TASK_PAIR_STALE_RESIDUAL_WORK_MS, type TaskPairState } from '../../../shared/task-pair.js';
import { getTaskPairStore } from './store.js';

export type TaskPairPickRole = 'executor' | 'auditor';

export interface TaskPairPoolDeps {
  listSessions?: () => SessionRecord[];
  getSession?: (name: string) => SessionRecord | undefined;
  now?: () => number;
  hasPendingMessages?: (sessionName: string) => boolean;
  /** Test seam for the shared live-work predicate used by automatic picks. */
  isWorking?: (sessionName: string) => boolean;
  /** Test seam: the transport runtime's diagnostic snapshot, for {@link describeSessionBusy}. */
  getDiagnosticSnapshot?: (sessionName: string) => TransportRuntimeDiagnosticSnapshot | undefined;
}

function defaultHasPendingMessages(sessionName: string): boolean {
  return (getTransportRuntime(sessionName)?.pendingEntries.length ?? 0) > 0;
}

/** Pool of a session under a Brain's configured pools, or undefined when not a member. */
export function poolOfSession(brain: string, sessionName: string, deps: TaskPairPoolDeps = {}): SupervisionExecutionPoolKind | undefined {
  const parent = (deps.getSession ?? getSession)(brain);
  const session = (deps.getSession ?? getSession)(sessionName);
  if (!parent || !session) return undefined;
  for (const pool of ['primary', 'economy'] as const) {
    const definition = poolDefinition(parent, pool);
    if (definition?.configs.some((config) => configMatchesSession(config, session))) return pool;
  }
  return undefined;
}

/** True when the Brain has configured execution pools at all. */
export function brainHasConfiguredPools(brain: string, deps: TaskPairPoolDeps = {}): boolean {
  const parent = (deps.getSession ?? getSession)(brain);
  return !!parent && !!configuredPools(parent);
}

/**
 * The no-pool default: a sub-session of this Brain that runs the SECONDARY model of the Brain's own provider family (anthropic ->
 * sonnet, openai -> gpt-6-sol, deepseek -> deepseek-pro). Same vendor, secondary tier -- a different vendor or the family's flagship
 * would spend quota the owner did not name.
 */
export function isDefaultSecondarySession(parent: SessionRecord, session: SessionRecord): boolean {
  if (session.parentSession !== parent.name || session.role === 'brain' || session.executionCloneMetadata) return false;
  return isDefaultSecondaryTierTarget({
    brainFamily: sessionProviderFamily(parent),
    targetFamily: sessionProviderFamily(session),
    targetModel: resolveEffectiveSessionModel(session),
  });
}

/** The Brain's default-eligible sub-sessions (busy ones included: availability is the pick's concern, not the default's), minus `exclude`. */
export function listDefaultPoolSessions(brain: string, exclude: ReadonlySet<string> = new Set(), deps: TaskPairPoolDeps = {}): SessionRecord[] {
  const sessions = (deps.listSessions ?? (() => listSessions()))();
  const parent = sessions.find((session) => session.name === brain) ?? (deps.getSession ?? getSession)(brain);
  if (!parent) return [];
  return sessions.filter((session) => !exclude.has(session.name) && isDefaultSecondarySession(parent, session));
}

/**
 * Why a project with no pool cannot start a pair on its default, with the fix. `needed` is how many distinct default sessions the
 * pair needs (an executor and an auditor are two); `found` how many exist.
 */
export function describeDefaultPoolGap(brain: string, needed: number, found: number, deps: TaskPairPoolDeps = {}): string {
  const parent = (deps.getSession ?? getSession)(brain);
  const family = parent ? sessionProviderFamily(parent) : undefined;
  const model = family ? supervisionSecondaryModelOfFamily(family) : undefined;
  const fix = 'Fix: create the missing sub-session(s), name executor/auditor (or executormodel=/auditormodel=) on the task, or configure the pool with execution_pool_set (Settings → execution pool).';
  if (!family || !model) {
    return `no execution pool is configured and the Brain's provider family${family ? ` (${family})` : ''} has no default secondary model. ${fix}`;
  }
  return `no execution pool is configured, so the default is idle ${family} sub-sessions running ${model} (same vendor, secondary tier); a pair needs ${needed} distinct one(s) (executor and auditor are different sessions) and ${found} exist. ${fix}`;
}

/** The recorded reason for a default pick: which session, and why it qualified. */
export function describeDefaultSelection(brain: string, sessionName: string, deps: TaskPairPoolDeps = {}): string {
  const parent = (deps.getSession ?? getSession)(brain);
  const session = (deps.getSession ?? getSession)(sessionName);
  const family = parent ? sessionProviderFamily(parent) : 'unknown';
  const model = session ? resolveEffectiveSessionModel(session) : undefined;
  return `${sessionName}: no execution pool configured, so the default applies (idle, same vendor ${family}, secondary tier ${model ?? supervisionSecondaryModelOfFamily(family) ?? 'unknown'})`;
}

/**
 * With no execution pool configured, whether the roles a pair_create leaves to the daemon can be filled by the no-pool default at all
 * (busy sessions count: they free up). `undefined` when they can, or when a pool is configured; otherwise the reason and the fix.
 * An executor and an auditor are always two different sessions, so a single default session cannot fill both.
 */
export function describeNoPoolDefaultShortfall(input: {
  brain: string;
  /** The role is settled by the caller: a named session or a named model. */
  executorNamed: boolean;
  auditorNamed: boolean;
  /** Sessions the caller named (they are not available to the default). */
  named: readonly string[];
}, deps: TaskPairPoolDeps = {}): string | undefined {
  const parent = (deps.getSession ?? getSession)(input.brain);
  if (!parent || configuredPools(parent)) return undefined;
  const needed = (input.executorNamed ? 0 : 1) + (input.auditorNamed ? 0 : 1);
  if (needed === 0) return undefined;
  const found = listDefaultPoolSessions(input.brain, new Set([input.brain, ...input.named]), deps).length;
  return found >= needed ? undefined : describeDefaultPoolGap(input.brain, needed, found, deps);
}

export interface TaskPairParticipantSelection {
  session?: string;
  source: SupervisionExecutionSelectionSource;
  reason: string;
}

/**
 * What a pair_create resolved for each role and why: `explicit` (a named session or model), `configured_pool`, or
 * `default_same_vendor_secondary` (no pool configured: the daemon took an idle same-vendor secondary-tier sub-session). A role still
 * unfilled reports no session and says what it waits for.
 */
export function describeExecutionSelection(
  brain: string,
  pair: Pick<TaskPairState, 'executor' | 'auditor'>,
  named: { executorNamed: boolean; auditorNamed: boolean },
  deps: TaskPairPoolDeps = {},
  created: ReadonlyArray<{ session: string; role: TaskPairPickRole; reason: string }> = [],
): { executor: TaskPairParticipantSelection; auditor: TaskPairParticipantSelection } {
  const unconfigured = !brainHasConfiguredPools(brain, deps);
  const select = (session: string | undefined, isNamed: boolean, role: TaskPairPickRole): TaskPairParticipantSelection => {
    // A session pair_create created for this pair: the reason says so (default rule, or the caller asked for it).
    const made = created.find((entry) => entry.role === role && entry.session === session);
    if (made) {
      const source = made.reason === TASK_PAIR_CREATED_SESSION_REASONS.EXPLICIT ? SUPERVISION_EXECUTION_SELECTION_SOURCES.EXPLICIT : SUPERVISION_EXECUTION_SELECTION_SOURCES.DEFAULT_SAME_VENDOR_SECONDARY;
      return { session: made.session, source, reason: `${made.session}: created for this pair (${made.reason}: ${describeDefaultSelection(brain, made.session, deps).replace(/^[^:]+: /u, '')}), recorded as autoCreated by ${brain}` };
    }
    if (isNamed) return { ...(session ? { session } : {}), source: SUPERVISION_EXECUTION_SELECTION_SOURCES.EXPLICIT, reason: session ? `${session}: named by the caller` : 'named model, session still being picked' };
    const source = unconfigured ? SUPERVISION_EXECUTION_SELECTION_SOURCES.DEFAULT_SAME_VENDOR_SECONDARY : SUPERVISION_EXECUTION_SELECTION_SOURCES.CONFIGURED_POOL;
    if (!session) return { source, reason: `${role} not assigned yet: waiting for an idle ${unconfigured ? 'same-vendor secondary-tier sub-session' : 'pool session'}` };
    if (session === TASK_PAIR_NO_AUDITOR) return { session, source: SUPERVISION_EXECUTION_SELECTION_SOURCES.EXPLICIT, reason: 'audit disabled by the caller' };
    return { session, source, reason: unconfigured ? describeDefaultSelection(brain, session, deps) : `${session}: configured ${poolOfSession(brain, session, deps) ?? 'execution'} pool member` };
  };
  return {
    executor: select(pair.executor, named.executorNamed, 'executor'),
    auditor: select(pair.auditor, named.auditorNamed, 'auditor'),
  };
}

/**
 * The account-pool sync gap, but only worth surfacing once there IS a
 * configured pool to have possibly gone stale -- a project that never
 * configured pools at all (mirror or cache) has nothing to sync, so showing
 * this there would be noise rather than a diagnostic.
 */
export function describePoolSyncGap(brain: string, deps: TaskPairPoolDeps = {}): string | undefined {
  if (!brainHasConfiguredPools(brain, deps)) return undefined;
  return describeSupervisorDefaultsSyncGap();
}

/**
 * "no session/config for requested model X", with the sync gap appended when
 * one exists. Unlike {@link describePoolSyncGap}, this is not gated on the
 * Brain already having a configured pool: a stale/never-synced cache can be
 * exactly why a named model's config is missing even when the local mirror
 * itself shows no pool at all.
 */
export function describeRequestedModelMiss(requestedModel: string): string {
  const gap = describeSupervisorDefaultsSyncGap();
  return `no session/config for requested model ${requestedModel}${gap ? ` (${gap})` : ''}`;
}

/** A named model (`executormodel=`/`auditormodel=`) matches by exact id, case-insensitively. */
function sameModelId(a: string | null | undefined, b: string): boolean {
  return !!a && a.toLowerCase() === b.toLowerCase();
}

/**
 * Idle, eligible pool members for a role, longest idle first. When the Brain
 * has no configured pools, its idle same-vendor secondary-tier sub-sessions
 * stand in for the pool (isDefaultSecondarySession).
 */
export function listTaskPairCandidates(input: {
  brain: string;
  role: TaskPairPickRole;
  pool: SupervisionExecutionPoolKind;
  exclude: ReadonlySet<string>;
  /**
   * Owner rule (design D-pool-sync): the human or Brain explicitly named
   * this model for the role (`executormodel=`/`auditormodel=`, or a bound
   * `send_message task.requestedExecutionType.model`). A candidate matches
   * by model alone, regardless of pool membership or role -- the pool
   * governs only an automatic pick, when neither a session nor a model was
   * named.
   */
  requestedModel?: string;
  /**
   * A limit-triggered reassignment prefers a session from a DIFFERENT
   * provider family than the one that just failed (anthropic <-> openai),
   * so a whole-family outage does not just hand the pair to another session
   * behind the very same limit. Preference only: a same-family candidate is
   * still returned (last) rather than leaving the role unfilled when it is
   * the only option.
   */
  avoidProviderFamily?: string;
}, deps: TaskPairPoolDeps = {}): SessionRecord[] {
  const sessions = (deps.listSessions ?? (() => listSessions()))();
  const parent = sessions.find((session) => session.name === input.brain) ?? (deps.getSession ?? getSession)(input.brain);
  if (!parent) return [];
  const pools = configuredPools(parent);
  const definition = pools ? poolDefinition(parent, input.role === 'auditor' ? 'primary' : input.pool) : undefined;
  const availability = resolveDelegationTargets(delegationTargetInputs(sessions), (deps.now ?? Date.now)());
  const hasPending = deps.hasPendingMessages ?? defaultHasPendingMessages;
  const isWorking = deps.isWorking ?? (deps.listSessions || deps.getSession ? (() => false) : isSessionWorking);
  const store = getTaskPairStore();
  const poolConfigOf = (session: SessionRecord): SupervisionExecutionConfig | undefined => (
    definition?.configs.find((config: SupervisionExecutionConfig) => configMatchesSession(config, session))
  );
  // Owner rule: a named model is never confined to the pool at all -- not
  // just its role. Only an AUTOMATIC pick (no requestedModel) is filtered by
  // pool membership and role; with no pool configured it falls back to the
  // same-vendor secondary-tier default (isDefaultSecondarySession).
  const eligibleForRole = (session: SessionRecord): boolean => {
    if (input.requestedModel) return sameModelId(resolveEffectiveSessionModel(session), input.requestedModel);
    if (!pools) return isDefaultSecondarySession(parent, session);
    const config = poolConfigOf(session);
    return !!config && supervisionExecutionConfigAllowsRole(config, input.role);
  };
  const candidates = sessions
    .filter((session) => (
      // Only the Brain's own sub-sessions: the daemon never commandeers an
      // owner-facing main session (design D12).
      session.parentSession === parent.name
      && session.role !== 'brain'
      && !session.executionCloneMetadata
      && !input.exclude.has(session.name)
      && !SUPERVISION_DEFAULT_EXCLUDED_DEVELOPMENT_SESSIONS.includes(session.name)
      && !isExcludedDevelopmentModel(resolveEffectiveSessionModel(session) ?? '')
      && (!!input.requestedModel || !pools || !!poolConfigOf(session))
      && eligibleForRole(session)
      && session.state === 'idle'
      && !isWorking(session.name)
      && availability.get(session.name)?.availability === DELEGATION_AVAILABILITY.READY
      && !hasPending(session.name)
      && !store.isParticipantOfOpenPair(session.name)
    ))
    .sort((a, b) => {
      // Tier policy is only an automatic preference. Named models return
      // through the explicit override path above and are never reordered.
      if (!input.requestedModel) {
        const ar = poolConfigOf(a);
        const br = poolConfigOf(b);
        const tier = (ar ? supervisionTierPriority(ar, input.role) : 99)
          - (br ? supervisionTierPriority(br, input.role) : 99);
        if (tier !== 0) return tier;
      }
      return a.updatedAt - b.updatedAt || a.name.localeCompare(b.name);
    });
  if (!input.avoidProviderFamily) return candidates;
  const otherFamily = candidates.filter((session) => sessionProviderFamily(session) !== input.avoidProviderFamily);
  const sameFamily = candidates.filter((session) => sessionProviderFamily(session) === input.avoidProviderFamily);
  return [...otherFamily, ...sameFamily];
}

export function sessionProviderFamily(session: SessionRecord): string {
  return resolvePeerAuditProviderFamily({ providerId: session.providerId, agentType: session.agentType });
}

/** Provider family of a named session (for limit-triggered failover), or undefined if the session is unknown. */
export function providerFamilyOfSession(sessionName: string, deps: TaskPairPoolDeps = {}): string | undefined {
  const session = (deps.getSession ?? getSession)(sessionName);
  return session ? sessionProviderFamily(session) : undefined;
}

/**
 * Why the pool can never yield an auditor right now, once pick+provision have
 * already both failed. Distinguishes a structural config gap (no entry
 * carries the auditor role at all -- nothing can ever be provisioned) from a
 * transient one (some entry qualifies, so the gap is every qualifying session
 * being busy, limited, or absent right now). Undefined when no pools are
 * configured at all -- that case is the scheduler's "ask the user" path
 * instead (see `brainHasConfiguredPools`), not a pool gap.
 */
export function describeAuditorPoolGap(input: {
  brain: string;
}, deps: TaskPairPoolDeps = {}): string | undefined {
  const parent = (deps.getSession ?? getSession)(input.brain);
  const definition = parent ? poolDefinition(parent, 'primary') : undefined;
  if (parent && !configuredPools(parent)) return describeDefaultPoolGap(input.brain, 2, listDefaultPoolSessions(input.brain, new Set(), deps).length, deps);
  if (!definition) return undefined;
  const syncGap = describeSupervisorDefaultsSyncGap();
  const suffix = syncGap ? ` (${syncGap})` : '';
  if (definition.configs.some((config) => supervisionExecutionConfigAllowsRole(config, 'auditor'))) {
    return `every auditor-role session in the primary pool is busy, limited, or otherwise unavailable right now. Check Settings → execution pool if this persists${suffix}`;
  }
  const pool = definition.configs.map((config) => `${config.agentType}/${config.model}`).join(', ') || 'none';
  return `no pool entry has the auditor role (primary pool configs: ${pool}). Give an entry the auditor role in Settings → execution pool${suffix}`;
}

/**
 * A provisionable config for a named model (owner rule) that no pool entry
 * matches -- the pool never confines a named session/model, only an
 * automatic pick. Undefined only when the model cannot be resolved to a
 * known backend at all (an unsupported/unrecognized model id).
 */
export function resolveRequestedModelProvisionConfig(requestedModel: string): SupervisionExecutionConfig | undefined {
  const agentType = inferSharedContextRuntimeBackend(requestedModel);
  if (!agentType) return undefined;
  const providerFamily = resolvePeerAuditProviderFamily({ agentType });
  const runtimeType = getSessionRuntimeType(agentType);
  const model = normalizeSupervisionExecutionModel(agentType, requestedModel);
  const config = { agentType, providerFamily, runtimeType, model };
  return { ...config, capabilityId: buildSupervisionExecutionCapabilityId(config) };
}

/**
 * First role-eligible pool config for auto-provisioning a role, if any. A
 * requested model that matches nothing in the pool still resolves via
 * {@link resolveRequestedModelProvisionConfig} (owner rule) rather than
 * confining it to the pool -- only an automatic pick (no requestedModel) is
 * pool-scoped.
 */
export function roleEligibleProvisionConfig(input: {
  brain: string;
  role: TaskPairPickRole;
  pool: SupervisionExecutionPoolKind;
  /** Owner rule: see {@link listTaskPairCandidates}. */
  requestedModel?: string;
  /** See {@link listTaskPairCandidates}. */
  avoidProviderFamily?: string;
}, deps: TaskPairPoolDeps = {}): SupervisionExecutionConfig | undefined {
  const parent = (deps.getSession ?? getSession)(input.brain);
  if (!parent) return input.requestedModel ? resolveRequestedModelProvisionConfig(input.requestedModel) : undefined;
  const definition = poolDefinition(parent, input.role === 'auditor' ? 'primary' : input.pool);
  const matches = definition?.configs.filter((config) => (
    input.requestedModel
      ? sameModelId(config.model, input.requestedModel)
      : supervisionExecutionConfigAllowsRole(config, input.role)
  )) ?? [];
  if (matches.length === 0) {
    return input.requestedModel ? resolveRequestedModelProvisionConfig(input.requestedModel) : undefined;
  }
  const ordered = [...matches].sort((a, b) => supervisionTierPriority(a, input.role) - supervisionTierPriority(b, input.role));
  if (!input.avoidProviderFamily) return ordered[0];
  return ordered.find((config) => config.providerFamily !== input.avoidProviderFamily) ?? ordered[0];
}

/** Provider rate/usage limit as seen by delegation availability. */
export function isSessionProviderLimited(sessionName: string, deps: TaskPairPoolDeps = {}): boolean {
  const sessions = (deps.listSessions ?? (() => listSessions()))();
  const availability = resolveDelegationTargets(delegationTargetInputs(sessions), (deps.now ?? Date.now)());
  return availability.get(sessionName)?.availability === DELEGATION_AVAILABILITY.LIMITED;
}

export interface TaskPairLimitedFamily {
  family: string;
  retryAt?: number;
}

/**
 * Every eligible (allowlist/model + pool membership) session for a role that
 * is CURRENTLY provider-limited, grouped by family with the latest known
 * retry time per family. Undefined when the pick failed for some other
 * reason (no eligible session at all, or all just busy) -- the daemon must
 * not claim "every provider is limited" when the real gap is a missing or
 * empty pool.
 */
export function describeLimitedProviderFamilies(input: {
  brain: string;
  role: TaskPairPickRole;
  pool: SupervisionExecutionPoolKind;
  exclude: ReadonlySet<string>;
  requestedModel?: string;
}, deps: TaskPairPoolDeps = {}): { text: string; families: TaskPairLimitedFamily[] } | undefined {
  const sessions = (deps.listSessions ?? (() => listSessions()))();
  const parent = sessions.find((session) => session.name === input.brain) ?? (deps.getSession ?? getSession)(input.brain);
  if (!parent) return undefined;
  const pools = configuredPools(parent);
  const definition = pools ? poolDefinition(parent, input.role === 'auditor' ? 'primary' : input.pool) : undefined;
  const availability = resolveDelegationTargets(delegationTargetInputs(sessions), (deps.now ?? Date.now)());
  const eligibleForRole = (session: SessionRecord): boolean => {
    if (input.requestedModel) return sameModelId(resolveEffectiveSessionModel(session), input.requestedModel);
    if (!pools) return isDefaultSecondarySession(parent, session);
    const config = definition?.configs.find((candidate: SupervisionExecutionConfig) => configMatchesSession(candidate, session));
    return !!config && supervisionExecutionConfigAllowsRole(config, input.role);
  };
  const eligible = sessions.filter((session) => (
    session.parentSession === parent.name
    && session.role !== 'brain'
    && !session.executionCloneMetadata
    && !input.exclude.has(session.name)
    && !SUPERVISION_DEFAULT_EXCLUDED_DEVELOPMENT_SESSIONS.includes(session.name)
    && !isExcludedDevelopmentModel(resolveEffectiveSessionModel(session) ?? '')
    // Owner rule: see listTaskPairCandidates -- a named model is never pool-scoped.
    && (!!input.requestedModel || !pools || !!definition?.configs.some((config: SupervisionExecutionConfig) => configMatchesSession(config, session)))
    && eligibleForRole(session)
  ));
  const byFamily = new Map<string, TaskPairLimitedFamily>();
  for (const session of eligible) {
    const state = availability.get(session.name);
    if (state?.availability !== DELEGATION_AVAILABILITY.LIMITED) continue;
    const family = sessionProviderFamily(session);
    const retryAt = state.retryAt;
    const existing = byFamily.get(family);
    if (!existing) byFamily.set(family, { family, retryAt });
    else if (retryAt !== undefined && (existing.retryAt === undefined || retryAt > existing.retryAt)) existing.retryAt = retryAt;
  }
  if (byFamily.size === 0) return undefined;
  const families = [...byFamily.values()];
  const text = families
    .map((entry) => `${entry.family}${entry.retryAt ? ` (until ~${new Date(entry.retryAt).toISOString()})` : ' (no estimate)'}`)
    .join(', ');
  return { text, families };
}

/** Running, or with messages still queued: not a moment to nudge or to admit a queued pair. */
export function isSessionBusy(sessionName: string, deps: TaskPairPoolDeps = {}): boolean {
  return describeSessionBusy(sessionName, deps).length > 0;
}

/**
 * Why {@link isSessionBusy} is true (empty when idle). Deliberately stricter than
 * the transport runtime's own "can take a new turn" check, which ignores background
 * work entirely: admission still waits on FRESH background work (a subagent that
 * may be about to finish or report), but leftover background/tool counters of a
 * session that has been quiet for TASK_PAIR_STALE_RESIDUAL_WORK_MS no longer hold
 * a queued pair back.
 */
export function describeSessionBusy(sessionName: string, deps: TaskPairPoolDeps = {}): string[] {
  const session = (deps.getSession ?? getSession)(sessionName);
  if (!session) return [];
  const reasons: string[] = [];
  if (!deps.getSession || deps.getDiagnosticSnapshot) {
    const work = describeSessionWork(
      sessionName,
      { ...(deps.getSession ? { getSession: deps.getSession } : {}), ...(deps.getDiagnosticSnapshot ? { getDiagnosticSnapshot: deps.getDiagnosticSnapshot } : {}) },
      { staleResidualAfterMs: TASK_PAIR_STALE_RESIDUAL_WORK_MS },
    );
    if (work.working) reasons.push(...work.reasons);
  }
  if (session.state === 'running' && !reasons.includes('state_running')) reasons.push('state_running');
  if (reasons.length === 0 && (deps.hasPendingMessages ?? defaultHasPendingMessages)(sessionName)) reasons.push('pending_messages');
  return reasons;
}
