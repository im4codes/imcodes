/**
 * Sub-sessions that pair_create creates for a pair.
 *
 * One deterministic rule, no judgement call: for every role the caller did not settle (a named session, a named model, or an explicit
 * create), when NO execution pool is configured, pair_create counts the idle default sessions (same provider family as the Brain,
 * secondary tier, not in an open pair) and creates exactly the missing number (`planDefaultCreations`). An explicit
 * `createExecutor` / `createAuditor` always creates. A configured pool never auto-creates. Creations are capped per project
 * (TASK_PAIR_AUTO_CREATED_SESSION_MAX_PER_PROJECT); beyond the cap pair_create reuses idle sessions or queues. The caller serializes
 * plan + create + persist per Brain (runExclusive), so two simultaneous pair_creates neither over-create nor share one session.
 * A failure removes every session created in the call and reports why, with nothing persisted.
 */
import { getSession, listSessions, type SessionRecord } from '../../store/session-store.js';
import {
  TASK_PAIR_AUTO_CREATED_PAIR_MAX_PER_PROJECT,
  TASK_PAIR_AUTO_CREATED_SESSION_MAX_PER_PROJECT,
  TASK_PAIR_CREATED_SESSION_REASONS,
  TASK_PAIR_NO_AUDITOR,
  type TaskPairCreatedSessionReason,
} from '../../../shared/task-pair.js';
import { supervisionSecondaryLaunchModelOfFamily, type SupervisionExecutionConfig } from '../../../shared/supervision-execution-pool.js';
import { autoCreatedCount, configuredPools, createPairSubSession, type PairSubSessionFailureReason, type PairSubSessionRequest, type PairSubSessionResult } from '../supervision-auto-provision.js';
import {
  describeNoPoolDefaultShortfall,
  listTaskPairCandidates,
  resolveRequestedModelProvisionConfig,
  sessionProviderFamily,
  type TaskPairPoolDeps,
} from './pool.js';

export type PairSessionRole = 'executor' | 'auditor';

/** What an explicit create asks for; both absent = the Brain's own provider family, secondary tier. */
export interface PairSessionCreateSpec {
  providerFamily?: string;
  model?: string;
}

export interface EnsurePairSessionsInput {
  brain: string;
  project: string;
  taskId: string;
  title?: string;
  executor?: string;
  auditor?: string;
  executorModel?: string;
  auditorModel?: string;
  createExecutor?: PairSessionCreateSpec;
  createAuditor?: PairSessionCreateSpec;
}

export interface CreatedPairSession { session: string; role: PairSessionRole; reason: TaskPairCreatedSessionReason }

export type EnsurePairSessionsResult =
  | { ok: true; executor?: string; auditor?: string; created: CreatedPairSession[] }
  | { ok: false; error: string };

export interface PairSessionCreationDeps extends TaskPairPoolDeps {
  createSession?: (request: PairSubSessionRequest) => Promise<PairSubSessionResult>;
  stopSession?: (sessionName: string) => Promise<boolean>;
  maxPerProject?: number;
}

/** The launch config for a created session: an explicit model, an explicit family's secondary model, or the Brain's own family's. */
export function resolveCreationConfig(parent: SessionRecord, spec: PairSessionCreateSpec | undefined): { ok: true; config: SupervisionExecutionConfig } | { ok: false; error: string } {
  if (spec?.model) {
    const config = resolveRequestedModelProvisionConfig(spec.model);
    if (!config) return { ok: false, error: `model ${spec.model} cannot be launched (no known runtime for it); name a model such as sonnet or gpt-6-sol` };
    if (spec.providerFamily && config.providerFamily !== spec.providerFamily) {
      return { ok: false, error: `model ${spec.model} belongs to provider family ${config.providerFamily}, not ${spec.providerFamily}` };
    }
    return { ok: true, config };
  }
  const family = spec?.providerFamily ?? sessionProviderFamily(parent);
  const model = supervisionSecondaryLaunchModelOfFamily(family);
  if (!model) return { ok: false, error: `provider family ${family} has no default secondary model that can be created automatically; name a model in createExecutor/createAuditor or create the sub-session yourself` };
  const config = resolveRequestedModelProvisionConfig(model);
  if (!config || config.providerFamily !== family) return { ok: false, error: `the default ${family} secondary model ${model} has no launchable runtime here` };
  return { ok: true, config };
}

const REASON_TEXT: Record<PairSubSessionFailureReason, string> = {
  parent_unavailable: 'the Brain session is not available',
  cap_reached: `the per-project limit of pair-created sub-sessions is reached (${TASK_PAIR_AUTO_CREATED_PAIR_MAX_PER_PROJECT} pairs)`,
  provider_limited: 'the provider is rate/usage limited right now',
  provider_offline: 'the provider is offline',
  launch_failed: 'the session failed to launch',
  readiness_timeout: 'the session did not become ready in time',
  identity_collision: 'a different session already uses the derived name',
};

function shortTitle(title: string | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? `: ${trimmed.length > 40 ? `${trimmed.slice(0, 37)}...` : trimmed}` : '';
}

/**
 * How many sessions the default rule creates: the unsettled roles minus the idle default sessions that can serve them (never negative),
 * limited by the cap room left. Pure arithmetic over counts, so the rule is one testable line.
 */
export function planDefaultCreations(input: { unsettledRoles: number; idleDefaultSessions: number; capRoom: number }): number {
  return Math.max(0, Math.min(input.unsettledRoles - input.idleDefaultSessions, input.capRoom));
}

let testDeps: PairSessionCreationDeps = {};
/** Test seam: replaces the launch/stop/session-listing dependencies of every ensurePairSessions call (pair_create included). */
export function setPairSessionCreationDepsForTests(deps: PairSessionCreationDeps | undefined): void { testDeps = deps ?? {}; }

export async function ensurePairSessions(input: EnsurePairSessionsInput, injected: PairSessionCreationDeps = {}): Promise<EnsurePairSessionsResult> {
  const deps: PairSessionCreationDeps = { ...testDeps, ...injected };
  if (input.createExecutor && (input.executor || input.executorModel)) {
    return { ok: false, error: 'createExecutor cannot be combined with executor or executorModel' };
  }
  if (input.createAuditor && (input.auditor || input.auditorModel)) {
    return { ok: false, error: 'createAuditor cannot be combined with auditor or auditorModel' };
  }
  const parent = (deps.getSession ?? getSession)(input.brain);
  if (!parent) return { ok: false, error: 'the Brain session was not found' };
  const sessions = (deps.listSessions ?? (() => listSessions()))();
  const unconfigured = !configuredPools(parent);
  const maxPerProject = deps.maxPerProject ?? TASK_PAIR_AUTO_CREATED_SESSION_MAX_PER_PROJECT;
  // Launches still in flight hold a slot too (the marker is written only when a launch finishes); createPairSubSession reserves atomically.
  const capRoom = Math.max(0, maxPerProject - autoCreatedCount(input.project, sessions));

  const wanted: Array<{ role: PairSessionRole; spec: PairSessionCreateSpec | undefined; reason: TaskPairCreatedSessionReason }> = [];
  if (input.createExecutor) wanted.push({ role: 'executor', spec: input.createExecutor, reason: TASK_PAIR_CREATED_SESSION_REASONS.EXPLICIT });
  if (input.createAuditor) wanted.push({ role: 'auditor', spec: input.createAuditor, reason: TASK_PAIR_CREATED_SESSION_REASONS.EXPLICIT });
  if (wanted.length > capRoom) {
    return { ok: false, error: `cannot create ${wanted.length} sub-session(s): ${maxPerProject - capRoom} of the ${maxPerProject} allowed pair-created sub-sessions (${TASK_PAIR_AUTO_CREATED_PAIR_MAX_PER_PROJECT} pairs of an executor and an auditor) already exist in this project. Name existing sessions instead, or close unused pair-created ones.` };
  }

  const named = [input.executor, input.auditor].filter((entry): entry is string => !!entry && entry !== TASK_PAIR_NO_AUDITOR);
  let executorSettled = !!input.executor || !!input.executorModel || !!input.createExecutor;
  let auditorSettled = !!input.auditor || !!input.auditorModel || !!input.createAuditor;
  if (unconfigured) {
    const unsettled: PairSessionRole[] = [];
    if (!executorSettled) unsettled.push('executor');
    if (!auditorSettled) unsettled.push('auditor');
    if (unsettled.length > 0) {
      const idle = listTaskPairCandidates({
        brain: input.brain, role: 'executor', pool: 'primary',
        exclude: new Set([input.brain, ...named]),
      }, deps).length;
      const count = planDefaultCreations({ unsettledRoles: unsettled.length, idleDefaultSessions: idle, capRoom: capRoom - wanted.length });
      // The roles served by an idle session are picked later by the normal pick; the LAST `count` roles get a created one.
      for (const role of unsettled.slice(unsettled.length - count)) {
        wanted.push({ role, spec: undefined, reason: TASK_PAIR_CREATED_SESSION_REASONS.DEFAULT });
      }
    }
  }

  const created: CreatedPairSession[] = [];
  const stop = async (): Promise<void> => {
    for (const entry of created.filter((item) => item.reason !== undefined)) {
      try { await (deps.stopSession ?? defaultStop)(entry.session); } catch { /* best effort: the error below is what matters */ }
    }
  };
  // Executor before auditor: a failure removes whatever was already created in this call.
  for (const entry of wanted.sort((a, b) => (a.role === 'executor' ? 0 : 1) - (b.role === 'executor' ? 0 : 1))) {
    const resolved = resolveCreationConfig(parent, entry.spec);
    if (!resolved.ok) { await stop(); return { ok: false, error: `cannot create the ${entry.role}: ${resolved.error}` }; }
    const result = await (deps.createSession ?? ((request) => createPairSubSession(request, deps.maxPerProject === undefined ? {} : { maxPerProject: deps.maxPerProject })))({
      parentSessionName: input.brain,
      config: resolved.config,
      label: `Pair ${input.taskId} ${entry.role}${shortTitle(input.title)}`,
      idempotencyKey: `${input.taskId}:${entry.role}`,
      metadata: { createdBy: input.brain, pairTaskId: input.taskId, role: entry.role, reason: entry.reason },
    });
    if (!result.ok) {
      await stop();
      return { ok: false, error: `cannot create the ${entry.role} sub-session: ${REASON_TEXT[result.reason]}${result.detail ? ` (${result.detail})` : ''}. Nothing was created for this pair. Name an existing session, free up quota, or configure the pool with execution_pool_set.` };
    }
    created.push({ session: result.target.name, role: entry.role, reason: entry.reason });
  }

  const executor = input.executor ?? created.find((entry) => entry.role === 'executor')?.session;
  const auditor = input.auditor ?? created.find((entry) => entry.role === 'auditor')?.session;
  executorSettled = executorSettled || !!executor;
  auditorSettled = auditorSettled || !!auditor;
  // The cap may have left roles the existing sessions cannot fill either: say so now, before anything is persisted.
  const shortfall = describeNoPoolDefaultShortfall({
    brain: input.brain, executorNamed: executorSettled, auditorNamed: auditorSettled,
    named: [executor, auditor].filter((entry): entry is string => !!entry && entry !== TASK_PAIR_NO_AUDITOR),
  }, deps);
  if (shortfall) {
    await stop();
    return { ok: false, error: `${shortfall} (pair-created sub-sessions are limited to ${TASK_PAIR_AUTO_CREATED_PAIR_MAX_PER_PROJECT} pairs, ${maxPerProject} sessions, per project; ${capRoom} slot(s) were free)` };
  }
  return { ok: true, ...(executor ? { executor } : {}), ...(auditor ? { auditor } : {}), created };
}

async function defaultStop(sessionName: string): Promise<boolean> {
  const { stopSubSession } = await import('../subsession-manager.js');
  const { getActiveServerLink } = await import('../active-server-link.js');
  return (await stopSubSession(sessionName, getActiveServerLink())).ok;
}
