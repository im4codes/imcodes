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
import {
  SUPERVISION_DEFAULT_EXCLUDED_DEVELOPMENT_SESSIONS,
  isExcludedDevelopmentModel,
  type SupervisionExecutionConfig,
  type SupervisionExecutionPoolKind,
} from '../../../shared/supervision-execution-pool.js';
import { matchesTaskPairAllowlist, type TaskPairAllowlistEntry } from '../../../shared/task-pair.js';
import { delegationTargetInputs } from '../delegation-admission.js';
import { configMatchesSession, configuredPools, poolDefinition } from '../supervision-auto-provision.js';
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

function allowlisted(session: SessionRecord, role: TaskPairPickRole, allowlist: readonly TaskPairAllowlistEntry[]): boolean {
  return matchesTaskPairAllowlist(allowlist, role, session.agentType, resolveEffectiveSessionModel(session) ?? undefined);
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
}, deps: TaskPairPoolDeps = {}): SessionRecord[] {
  const sessions = (deps.listSessions ?? (() => listSessions()))();
  const parent = sessions.find((session) => session.name === input.brain) ?? (deps.getSession ?? getSession)(input.brain);
  if (!parent) return [];
  const pools = configuredPools(parent);
  const definition = pools ? poolDefinition(parent, input.role === 'auditor' ? 'primary' : input.pool) : undefined;
  const availability = resolveDelegationTargets(delegationTargetInputs(sessions), (deps.now ?? Date.now)());
  const hasPending = deps.hasPendingMessages ?? defaultHasPendingMessages;
  const store = getTaskPairStore();
  return sessions
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
      && allowlisted(session, input.role, input.allowlist)
      && session.state === 'idle'
      && availability.get(session.name)?.availability === DELEGATION_AVAILABILITY.READY
      && !hasPending(session.name)
      && !store.isParticipantOfOpenPair(session.name)
    ))
    .sort((a, b) => a.updatedAt - b.updatedAt || a.name.localeCompare(b.name));
}

/** First allowlisted pool config for auto-provisioning a role, if any. */
export function allowlistedProvisionConfig(input: {
  brain: string;
  role: TaskPairPickRole;
  pool: SupervisionExecutionPoolKind;
  allowlist: readonly TaskPairAllowlistEntry[];
}, deps: TaskPairPoolDeps = {}): SupervisionExecutionConfig | undefined {
  const parent = (deps.getSession ?? getSession)(input.brain);
  if (!parent) return undefined;
  const definition = poolDefinition(parent, input.role === 'auditor' ? 'primary' : input.pool);
  return definition?.configs.find((config) => (
    matchesTaskPairAllowlist(input.allowlist, input.role, config.agentType, config.model)
  ));
}

/** Provider rate/usage limit as seen by delegation availability. */
export function isSessionProviderLimited(sessionName: string, deps: TaskPairPoolDeps = {}): boolean {
  const sessions = (deps.listSessions ?? (() => listSessions()))();
  const availability = resolveDelegationTargets(delegationTargetInputs(sessions), (deps.now ?? Date.now)());
  return availability.get(sessionName)?.availability === DELEGATION_AVAILABILITY.LIMITED;
}

/** Running, or with messages still queued: not a moment to nudge. */
export function isSessionBusy(sessionName: string, deps: TaskPairPoolDeps = {}): boolean {
  const session = (deps.getSession ?? getSession)(sessionName);
  if (!session) return false;
  if (session.state === 'running') return true;
  return (deps.hasPendingMessages ?? defaultHasPendingMessages)(sessionName);
}
