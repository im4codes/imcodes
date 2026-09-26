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
 * Owner rule: a project with no execution pool configured at all has NO
 * built-in default -- an automatic pick there returns nothing (see
 * `brainHasConfiguredPools`); the scheduler asks the user instead of
 * guessing (shared/task-pair.ts's marker contract states the same rule).
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
  buildSupervisionExecutionCapabilityId,
  isExcludedDevelopmentModel,
  normalizeSupervisionExecutionModel,
  supervisionExecutionConfigAllowsRole,
  type SupervisionExecutionConfig,
  type SupervisionExecutionPoolKind,
} from '../../../shared/supervision-execution-pool.js';
import { delegationTargetInputs } from '../delegation-admission.js';
import { configMatchesSession, configuredPools, poolDefinition } from '../supervision-auto-provision.js';
import { describeSupervisorDefaultsSyncGap } from '../supervisor-defaults-cache.js';
import { getTransportRuntime } from '../../agent/session-manager.js';
import { isSessionWorking } from '../session-working.js';
import { getTaskPairStore } from './store.js';

export type TaskPairPickRole = 'executor' | 'auditor';

export interface TaskPairPoolDeps {
  listSessions?: () => SessionRecord[];
  getSession?: (name: string) => SessionRecord | undefined;
  now?: () => number;
  hasPendingMessages?: (sessionName: string) => boolean;
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
 * has no configured pools, its own sub-sessions stand in for the pool and the
 * allowlist alone decides eligibility.
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
  const store = getTaskPairStore();
  const poolConfigOf = (session: SessionRecord): SupervisionExecutionConfig | undefined => (
    definition?.configs.find((config: SupervisionExecutionConfig) => configMatchesSession(config, session))
  );
  // Owner rule: a named model is never confined to the pool at all -- not
  // just its role. Only an AUTOMATIC pick (no requestedModel) is filtered by
  // pool membership and role, and has no built-in default when no pool is
  // configured at all -- see brainHasConfiguredPools in the exclusion filter.
  const eligibleForRole = (session: SessionRecord): boolean => {
    if (input.requestedModel) return sameModelId(resolveEffectiveSessionModel(session), input.requestedModel);
    if (!pools) return false;
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
      && availability.get(session.name)?.availability === DELEGATION_AVAILABILITY.READY
      && !hasPending(session.name)
      && !store.isParticipantOfOpenPair(session.name)
    ))
    .sort((a, b) => a.updatedAt - b.updatedAt || a.name.localeCompare(b.name));
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
  if (!input.avoidProviderFamily) return matches[0];
  return matches.find((config) => config.providerFamily !== input.avoidProviderFamily) ?? matches[0];
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
    if (!pools) return false;
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

/** Running, or with messages still queued: not a moment to nudge. */
export function isSessionBusy(sessionName: string, deps: TaskPairPoolDeps = {}): boolean {
  const session = (deps.getSession ?? getSession)(sessionName);
  if (!session) return false;
  if (!deps.getSession && isSessionWorking(sessionName)) return true;
  if (session.state === 'running') return true;
  return (deps.hasPendingMessages ?? defaultHasPendingMessages)(sessionName);
}
