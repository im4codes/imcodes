/**
 * Execution-pool membership and daemon picks for task pairs (design D12).
 *
 * The execution pool is kept exactly as configured on the Brain (primary /
 * economy pools, eligibility, capacity, auto-provisioning); the pairs engine
 * only reads it. The daemon picks a participant itself only for automatic
 * dispatch and automatic auditor replacement, and then also applies the
 * project allowlist. What Brain names explicitly is never refused.
 */
import { getSession, listSessions, type SessionRecord } from '../../store/session-store.js';
import { resolveEffectiveSessionModel } from '../../../shared/session-model.js';
import {
  DELEGATION_AVAILABILITY,
  resolveDelegationTargets,
} from '../../../shared/delegation-availability.js';
import { resolvePeerAuditProviderFamily } from '../../../shared/peer-audit.js';
import {
  SUPERVISION_DEFAULT_EXCLUDED_DEVELOPMENT_SESSIONS,
  isExcludedDevelopmentModel,
  type SupervisionExecutionConfig,
  type SupervisionExecutionPoolKind,
} from '../../../shared/supervision-execution-pool.js';
import { matchesTaskPairAllowlist, type TaskPairAllowlistEntry } from '../../../shared/task-pair.js';
import { delegationTargetInputs } from '../delegation-admission.js';
import { configMatchesSession, configuredPools, poolDefinition } from '../supervision-auto-provision.js';
import { describeSupervisorDefaultsSyncGap } from '../supervisor-defaults-cache.js';
import { getTransportRuntime } from '../../agent/session-manager.js';
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

function allowlisted(session: SessionRecord, role: TaskPairPickRole, allowlist: readonly TaskPairAllowlistEntry[]): boolean {
  return matchesTaskPairAllowlist(allowlist, role, session.agentType, resolveEffectiveSessionModel(session) ?? undefined);
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
  allowlist: readonly TaskPairAllowlistEntry[];
  exclude: ReadonlySet<string>;
  /**
   * Owner rule (design D-pool-sync): the human or Brain explicitly named
   * this model for the role (`executormodel=`/`auditormodel=`, or a bound
   * `send_message task.requestedExecutionType.model`). A candidate matches
   * by model alone; the allowlist -- which governs only an automatic pick --
   * is not consulted.
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
  const eligibleForRole = (session: SessionRecord): boolean => (
    input.requestedModel
      ? sameModelId(resolveEffectiveSessionModel(session), input.requestedModel)
      : allowlisted(session, input.role, input.allowlist)
  );
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
      && (!pools || !!definition?.configs.some((config: SupervisionExecutionConfig) => configMatchesSession(config, session)))
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
 * Why the pool can never yield an auditor: the Brain's primary pool is
 * configured, but none of its configs is on the auditor allowlist, so no pool
 * member qualifies and nothing can be provisioned. Undefined when some config
 * qualifies (a shortage is then temporary) or no pools are configured.
 */
export function describeAuditorAllowlistGap(input: {
  brain: string;
  allowlist: readonly TaskPairAllowlistEntry[];
}, deps: TaskPairPoolDeps = {}): string | undefined {
  const parent = (deps.getSession ?? getSession)(input.brain);
  const definition = parent ? poolDefinition(parent, 'primary') : undefined;
  if (!definition) return undefined;
  if (definition.configs.some((config) => matchesTaskPairAllowlist(input.allowlist, 'auditor', config.agentType, config.model))) {
    return undefined;
  }
  const pool = definition.configs.map((config) => `${config.agentType}/${config.model}`).join(', ') || 'none';
  const wanted = input.allowlist
    .filter((entry) => entry.role === 'auditor' || entry.role === 'both')
    .map((entry) => `${entry.agentType}/${entry.modelPattern || '*'}`)
    .join(', ') || 'none';
  const syncGap = describeSupervisorDefaultsSyncGap();
  return `the auditor allowlist (${wanted}) matches none of the primary pool's configs (${pool}). Add an allowlisted auditor config to the primary pool, or widen the project's pair allowlist${syncGap ? ` (${syncGap})` : ''}`;
}

/** First allowlisted pool config for auto-provisioning a role, if any. */
export function allowlistedProvisionConfig(input: {
  brain: string;
  role: TaskPairPickRole;
  pool: SupervisionExecutionPoolKind;
  allowlist: readonly TaskPairAllowlistEntry[];
  /** Owner rule: see {@link listTaskPairCandidates}. */
  requestedModel?: string;
  /** See {@link listTaskPairCandidates}. */
  avoidProviderFamily?: string;
}, deps: TaskPairPoolDeps = {}): SupervisionExecutionConfig | undefined {
  const parent = (deps.getSession ?? getSession)(input.brain);
  if (!parent) return undefined;
  const definition = poolDefinition(parent, input.role === 'auditor' ? 'primary' : input.pool);
  const matches = definition?.configs.filter((config) => (
    input.requestedModel
      ? sameModelId(config.model, input.requestedModel)
      : matchesTaskPairAllowlist(input.allowlist, input.role, config.agentType, config.model)
  )) ?? [];
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
  allowlist: readonly TaskPairAllowlistEntry[];
  exclude: ReadonlySet<string>;
  requestedModel?: string;
}, deps: TaskPairPoolDeps = {}): { text: string; families: TaskPairLimitedFamily[] } | undefined {
  const sessions = (deps.listSessions ?? (() => listSessions()))();
  const parent = sessions.find((session) => session.name === input.brain) ?? (deps.getSession ?? getSession)(input.brain);
  if (!parent) return undefined;
  const pools = configuredPools(parent);
  const definition = pools ? poolDefinition(parent, input.role === 'auditor' ? 'primary' : input.pool) : undefined;
  const availability = resolveDelegationTargets(delegationTargetInputs(sessions), (deps.now ?? Date.now)());
  const eligibleForRole = (session: SessionRecord): boolean => (
    input.requestedModel
      ? sameModelId(resolveEffectiveSessionModel(session), input.requestedModel)
      : allowlisted(session, input.role, input.allowlist)
  );
  const eligible = sessions.filter((session) => (
    session.parentSession === parent.name
    && session.role !== 'brain'
    && !session.executionCloneMetadata
    && !input.exclude.has(session.name)
    && !SUPERVISION_DEFAULT_EXCLUDED_DEVELOPMENT_SESSIONS.includes(session.name)
    && !isExcludedDevelopmentModel(resolveEffectiveSessionModel(session) ?? '')
    && (!pools || !!definition?.configs.some((config: SupervisionExecutionConfig) => configMatchesSession(config, session)))
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
  if (session.state === 'running') return true;
  return (deps.hasPendingMessages ?? defaultHasPendingMessages)(sessionName);
}
