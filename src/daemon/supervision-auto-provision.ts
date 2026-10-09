import { createHash } from 'node:crypto';
import { identityContentHash } from '../util/identity-prompt-hash.js';
import {
  DELEGATION_AVAILABILITY,
  resolveDelegationTargets,
} from '../../shared/delegation-availability.js';
import { isTransportSessionAgentType } from '../../shared/agent-types.js';
import { resolveEffectiveSessionModel } from '../../shared/session-model.js';
import {
  DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS,
  normalizeSupervisionExecutionPools,
  normalizeSupervisionExecutionConfig,
  normalizeSupervisionExecutionModel,
  type SupervisionAuditDegradedReason,
  type SupervisionExecutionConfig,
  type SupervisionProvisionFailureReason,
  type SupervisionProvisionPool,
  type SupervisionProvisioningEvidence,
} from '../../shared/supervision-execution-pool.js';
import { resolvePeerAuditProviderFamily as resolveSharedPeerAuditProviderFamily } from '../../shared/peer-audit.js';
import {
  SUPERVISION_TASK_HOUSEKEEPING_MAX_BATCH_SIZE,
  SUPERVISION_TRANSPORT_CONFIG_KEY,
  extractSessionSupervisionSnapshot,
  isAutomaticSupervisionEnabled,
  isTerminalSupervisionTaskStatus,
} from '../../shared/supervision-config.js';
import type { SessionRecord } from '../store/session-store.js';
import { getSession, listSessions } from '../store/session-store.js';
import { resolvePeerAuditProviderFamily } from './peer-audit-candidates.js';
import { delegationTargetInputs } from './delegation-admission.js';
import { startSubSession, stopSubSession, type SubSessionRecord } from './subsession-manager.js';
import { getActiveServerLink } from './active-server-link.js';
import { announceSubSession, type SubSessionAnnounceOutcome } from './subsession-sync.js';
import { isNonDaemonProcess } from './process-role.js';
import { getTransportRuntime } from '../agent/session-manager.js';
import { closeSubSession } from './session-close.js';
import { overlayCachedExecutionPools } from './supervisor-defaults-cache.js';
import logger from '../util/logger.js';
import type { SupervisionTaskRegistry } from './supervision-state-store.js';
import {
  SEND_AUTO_PROVISION_CREATED_SESSION_SOURCE,
  TASK_PAIR_AUTO_CREATED_SESSION_MAX_PER_PROJECT,
  TASK_PAIR_CREATED_SESSION_REASONS,
  TASK_PAIR_CREATED_SESSION_SOURCE,
  type TaskPairCreatedSessionMetadata,
  type TaskPairCreatedSessionReason,
} from '../../shared/task-pair.js';

const AUTO_SESSION_ID_PREFIX = 'sup_auto_';
/** Sessions an explicit `task.autoProvision` call creates. Not `sup_auto_`: the automatic pool reaps its own children and must never touch these. */
const FORCED_SESSION_ID_PREFIX = 'send_auto_';
export const SUPERVISION_AUTO_PROVISION_COOLDOWN_MS = 30_000;
export const SUPERVISION_AUTO_PROVISION_READY_TIMEOUT_MS = 15_000;
export const SUPERVISION_AUTO_PROVISION_IDLE_REAP_MS = 30 * 60_000;
export const SUPERVISION_AUTO_PROVISION_MAX_REAPS_PER_ATTEMPT = 1;
const SUPERVISION_AUTO_PROVISION_POLL_MS = 50;
const SUPERVISION_AUTO_PROVISION_REGISTRY_PAGE_SIZE = SUPERVISION_TASK_HOUSEKEEPING_MAX_BATCH_SIZE + 1;

export interface SupervisionAutoProvisionRequest {
  parentSessionName: string;
  pool: 'primary' | 'economy';
  requestedCapabilityId?: string;
  /**
   * A complete execution identity explicitly selected by a human/MCP caller.
   * Manual explicit provisioning may use this without a configured automatic
   * execution pool. Daemon-owned automatic supervision never may.
   */
  requestedExecutionConfig?: SupervisionExecutionConfig;
  /** Exact session-scoped identity contract for the provisioned Agent. */
  identityPrompt?: string;
  idempotencyKey: string;
  auditedSessionName?: string;
  strictCrossVendor?: boolean;
  /** Explicit tool calls are manual; daemon-owned callers must opt into this provenance. */
  provenance?: 'manual_explicit' | 'automatic_supervision';
  /**
   * An explicit `task.autoProvision` call: ALWAYS create a new session for this idempotency key, never reuse another one. No pool reuse,
   * no cooldown, no idle reaping, no pool work-concurrency or spawn gate; only the per-project cap of auto-created sessions applies.
   * The daemon's automatic supervision keeps its pool behaviour (it never sets this).
   */
  forceCreate?: boolean;
  /** Why the created session exists, recorded in its creation marker (default: explicit_create). */
  createdReason?: TaskPairCreatedSessionReason;
}

export type SupervisionAutoProvisionResult =
  | {
      ok: true;
      target: SessionRecord;
      evidence: SupervisionProvisioningEvidence;
      auditRoutingReason?: 'cross_vendor_preferred' | 'same_family_degraded';
      auditDegradedReason?: SupervisionAuditDegradedReason;
    }
  | {
      ok: false;
      reason: SupervisionProvisionFailureReason;
      evidence: SupervisionProvisioningEvidence;
      auditDegradedReason?: SupervisionAuditDegradedReason;
    };

export interface SupervisionAutoProvisionDeps {
  now?: () => number;
  listSessions?: () => SessionRecord[];
  getSession?: (name: string) => SessionRecord | undefined;
  startSubSession?: (sub: SubSessionRecord) => Promise<void>;
  stopSubSession?: (sessionName: string) => Promise<boolean>;
  hasActiveSupervisionLease?: (sessionName: string) => boolean | Promise<boolean>;
  countActiveSupervisionAssignments?: (
    parent: SessionRecord,
    pool: SupervisionAutoProvisionRequest['pool'],
  ) => number | Promise<number>;
  wait?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  cooldownMs?: number;
  idleReapMs?: number;
}

const inFlight = new Map<string, Promise<SupervisionAutoProvisionResult>>();
const cooldownUntil = new Map<string, number>();

export function clearSupervisionAutoProvisionStateForTests(): void {
  inFlight.clear();
  cooldownUntil.clear();
  creationsInFlight.clear();
}

export function configuredPools(parent: SessionRecord) {
  // Execution pools are account-level policy. The session snapshot remains a
  // compatibility mirror, but the daemon's supervisor-defaults cache is the
  // authoritative source after Settings saves (and survives daemon restart).
  // Task-pair selection and auto-provisioning must use the same overlay as
  // send_message; otherwise the UI can show a checked pool while the pair
  // engine still reads an old sessions.json mirror.
  //
  // Read the raw field directly rather than through the strict snapshot
  // parser/extractor: a session's transportConfig can carry a perfectly
  // usable executionPools value while failing snapshot validation for an
  // unrelated reason (e.g. no `mode` set at all on an older/partial mirror).
  // Routing through the strict extractor here would silently discard a real
  // pool whenever that happens.
  const raw = parent.transportConfig?.[SUPERVISION_TRANSPORT_CONFIG_KEY];
  const rawExecutionPools = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).executionPools
    : undefined;
  const local = normalizeSupervisionExecutionPools(rawExecutionPools);
  const executionPools = overlayCachedExecutionPools({ executionPools: local }).executionPools;
  const normalized = normalizeSupervisionExecutionPools(executionPools);
  return normalized.state === 'configured' ? normalized : undefined;
}

export function poolDefinition(parent: SessionRecord, pool: SupervisionAutoProvisionRequest['pool']) {
  const pools = configuredPools(parent);
  if (!pools) return undefined;
  return pool === 'primary' ? pools.primaryDevelopmentPool : pools.economyTaskPool;
}

function supportedConfigs(
  parent: SessionRecord,
  request: SupervisionAutoProvisionRequest,
): SupervisionExecutionConfig[] {
  if (request.provenance === 'manual_explicit' && request.requestedExecutionConfig) {
    const explicit = normalizeSupervisionExecutionConfig(request.requestedExecutionConfig);
    if (!explicit || (request.requestedCapabilityId && explicit.capabilityId !== request.requestedCapabilityId)) {
      return [];
    }
    return explicit.runtimeType === 'transport'
      && isTransportSessionAgentType(explicit.agentType)
      && resolveSharedPeerAuditProviderFamily({ providerId: explicit.agentType }) === explicit.providerFamily
      ? [explicit]
      : [];
  }
  const definition = poolDefinition(parent, request.pool);
  if (!definition) return [];
  const supported = definition.configs.filter((config) => (
    config.runtimeType === 'transport'
    && isTransportSessionAgentType(config.agentType)
    // The visible transport launcher selects its provider adapter by agentType.
    // Reject a mismatched claimed family up front instead of spawning a child
    // that can never satisfy the requested execution identity.
    && resolveSharedPeerAuditProviderFamily({ providerId: config.agentType }) === config.providerFamily
  ));
  return request.requestedCapabilityId
    ? supported.filter((config) => config.capabilityId === request.requestedCapabilityId)
    : supported;
}

function hasManualExplicitConfig(request: SupervisionAutoProvisionRequest): boolean {
  return request.provenance === 'manual_explicit'
    && Boolean(normalizeSupervisionExecutionConfig(request.requestedExecutionConfig));
}

function provisionedIdentityHash(identityPrompt?: string): string | undefined {
  return identityPrompt ? identityContentHash(identityPrompt) : undefined;
}

/** A session is the Agent for this identity when it was provisioned with it (the hash is stamped at creation; the text is never stored). */
function sessionMatchesProvisionedIdentity(session: SessionRecord, identityPrompt?: string): boolean {
  if (identityPrompt === undefined) return true;
  return session.provisionedIdentityHash === provisionedIdentityHash(identityPrompt);
}

export function configMatchesSession(
  config: SupervisionExecutionConfig,
  session: SessionRecord,
  identityPrompt?: string,
): boolean {
  const model = resolveEffectiveSessionModel(session);
  return session.agentType === config.agentType
    && (session.runtimeType ?? 'process') === config.runtimeType
    && resolvePeerAuditProviderFamily(session) === config.providerFamily
    && typeof model === 'string'
    && normalizeSupervisionExecutionModel(session.agentType, model) === config.model
    && session.ccPreset === config.ccPresetId
    && sessionMatchesProvisionedIdentity(session, identityPrompt);
}

function matchingChildren(
  sessions: readonly SessionRecord[],
  parent: SessionRecord,
  config: SupervisionExecutionConfig,
  identityPrompt?: string,
): SessionRecord[] {
  return sessions.filter((session) => (
    session.parentSession === parent.name
    && session.role !== 'brain'
    && !session.executionCloneMetadata
    && configMatchesSession(config, session, identityPrompt)
  ));
}

function readyChildren(
  sessions: readonly SessionRecord[],
  parent: SessionRecord,
  config: SupervisionExecutionConfig,
  now: number,
  identityPrompt?: string,
): SessionRecord[] {
  const availability = resolveDelegationTargets(delegationTargetInputs(sessions), now);
  return matchingChildren(sessions, parent, config, identityPrompt)
    .filter((session) => sessionIsReady(session, availability.get(session.name)?.availability))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A launched session that can take work now: idle, with a logical identity and runtime epoch, and its provider not limited. */
function sessionIsReady(session: SessionRecord, availability: string | undefined): boolean {
  return session.state === 'idle'
    && Boolean(session.sessionInstanceId)
    && Boolean(session.runtimeEpoch)
    && availability === DELEGATION_AVAILABILITY.READY;
}

function configurationAvailability(
  sessions: readonly SessionRecord[],
  parent: SessionRecord,
  config: SupervisionExecutionConfig,
  now: number,
  identityPrompt?: string,
): 'available' | 'limited' | 'offline' {
  const matches = matchingChildren(sessions, parent, config, identityPrompt);
  if (matches.length > 0 && matches.every((session) => session.state === 'stopped' || session.state === 'error')) {
    return 'offline';
  }
  const syntheticKey = `__supervision_config_${config.capabilityId}`;
  const availability = resolveDelegationTargets([
    ...delegationTargetInputs(sessions),
    { key: syntheticKey, agentType: config.agentType, sessionState: 'unknown' as const },
  ], now).get(syntheticKey);
  return availability?.availability === DELEGATION_AVAILABILITY.LIMITED ? 'limited' : 'available';
}

function attemptIdentity(request: SupervisionAutoProvisionRequest, config: SupervisionExecutionConfig): {
  attemptId: string;
  sessionName: string;
  subId: string;
} {
  const digest = createHash('sha256').update(JSON.stringify({
    parent: request.parentSessionName,
    pool: request.pool,
    capabilityId: config.capabilityId,
    idempotencyKey: request.idempotencyKey,
    identityHash: provisionedIdentityHash(request.identityPrompt) ?? null,
  })).digest('hex');
  const suffix = digest.slice(0, 16);
  const subId = `${request.forceCreate ? FORCED_SESSION_ID_PREFIX : AUTO_SESSION_ID_PREFIX}${suffix}`;
  return {
    attemptId: `supervision_provision_${digest.slice(0, 32)}`,
    sessionName: `deck_sub_${subId}`,
    subId,
  };
}

function failureEvidence(
  pool: SupervisionProvisionPool,
  reason: SupervisionProvisionFailureReason,
  config?: SupervisionExecutionConfig,
  extra: Partial<SupervisionProvisioningEvidence> = {},
): SupervisionProvisioningEvidence {
  return { selectedPool: pool, ...(config ? { selectedConfig: config } : {}), failureReason: reason, ...extra };
}

function isAutomaticChildOf(parent: SessionRecord, session: SessionRecord): boolean {
  return session.parentSession === parent.name
    && session.name.startsWith(`deck_sub_${AUTO_SESSION_ID_PREFIX}`);
}

/** Audit workers consume the primary development pool even though their label
 * is `Auto audit`. Labels are presentation, never capacity authority. */
function childConsumesPool(
  parent: SessionRecord,
  session: SessionRecord,
  pool: SupervisionAutoProvisionRequest['pool'],
): boolean {
  if (!isAutomaticChildOf(parent, session)) return false;
  return pool === 'economy' ? session.label === 'Auto economy' : session.label !== 'Auto economy';
}

export async function defaultHasActiveSupervisionLease(
  sessionName: string,
  registryOverride?: Pick<SupervisionTaskRegistry, 'list'>,
): Promise<boolean> {
  // On the `pairs` engine a session is leased while it is the executor or
  // auditor of an open pair, so pool controls keep bounding provisioning.
  const pairs = await import('./task-pairs/engine.js');
  if (!registryOverride && pairs.isPairsEngineSession(sessionName)) {
    const { getTaskPairStore } = await import('./task-pairs/store.js');
    return getTaskPairStore().isParticipantOfOpenPair(sessionName);
  }
  const registry = registryOverride
    ?? (await import('./supervision-state-store.js')).getSupervisionTaskRegistry();
  let cursor: string | undefined;
  do {
    const page = registry.list({
      ownerSessionName: sessionName,
      includeArchived: true,
      cursor,
      limit: SUPERVISION_AUTO_PROVISION_REGISTRY_PAGE_SIZE,
    });
    for (const task of page) {
      if (task.assignments.some((assignment) => (
        assignment.identity.sessionName === sessionName
        && Boolean(assignment.leaseId)
        && !isTerminalSupervisionTaskStatus(assignment.status)
      ))) return true;
    }
    cursor = page.length === SUPERVISION_AUTO_PROVISION_REGISTRY_PAGE_SIZE
      ? page[page.length - 1]?.taskId
      : undefined;
  } while (cursor);
  return false;
}

export async function defaultCountActiveSupervisionAssignments(
  parent: SessionRecord,
  pool: SupervisionAutoProvisionRequest['pool'],
  registryOverride?: Pick<SupervisionTaskRegistry, 'countActiveLeasedAssignmentsByPool'>,
): Promise<number> {
  const pairs = await import('./task-pairs/engine.js');
  if (!registryOverride && pairs.isPairsEngineProject(parent.projectName)) {
    const { getTaskPairStore } = await import('./task-pairs/store.js');
    const { TASK_PAIR_OPEN_STATUSES } = await import('../../shared/task-pair.js');
    return getTaskPairStore().listActivePairs(parent.projectName).filter((pair) => (
      TASK_PAIR_OPEN_STATUSES.includes(pair.state.status)
      && (pair.state.executorPool ?? 'primary') === pool
    )).length;
  }
  const registry = registryOverride
    ?? (await import('./supervision-state-store.js')).getSupervisionTaskRegistry();
  return registry.countActiveLeasedAssignmentsByPool({
    projectName: parent.projectName,
    pool,
  });
}

async function reapOneIdleAutomaticChild(
  parent: SessionRecord,
  request: SupervisionAutoProvisionRequest,
  deps: Required<Pick<SupervisionAutoProvisionDeps,
    'now' | 'listSessions' | 'stopSubSession' | 'hasActiveSupervisionLease' | 'idleReapMs'>>,
): Promise<void> {
  const cutoff = deps.now() - deps.idleReapMs;
  const candidates = deps.listSessions()
    .filter((session) => childConsumesPool(parent, session, request.pool)
      && session.state === 'idle'
      && session.updatedAt <= cutoff)
    .sort((a, b) => a.updatedAt - b.updatedAt || a.name.localeCompare(b.name));
  let reaped = 0;
  for (const candidate of candidates) {
    if (await deps.hasActiveSupervisionLease(candidate.name)) continue;
    if (await deps.stopSubSession(candidate.name)) reaped += 1;
    if (reaped >= SUPERVISION_AUTO_PROVISION_MAX_REAPS_PER_ATTEMPT) break;
  }
}

async function discardHalfMade(
  deps: Required<Pick<SupervisionAutoProvisionDeps, 'stopSubSession'>>,
  sessionName: string,
): Promise<void> {
  try { await deps.stopSubSession(sessionName); } catch (error) {
    logger.warn({ err: error, sessionName }, 'forced auto-provision: could not remove a half-made session');
  }
}

async function provisionConfig(
  parent: SessionRecord,
  request: SupervisionAutoProvisionRequest,
  config: SupervisionExecutionConfig,
  deps: Required<Pick<SupervisionAutoProvisionDeps, 'now' | 'listSessions' | 'getSession' | 'startSubSession'
    | 'stopSubSession' | 'hasActiveSupervisionLease' | 'countActiveSupervisionAssignments'
    | 'wait' | 'readyTimeoutMs' | 'cooldownMs' | 'idleReapMs'>>,
  selectedPool: SupervisionProvisionPool,
): Promise<SupervisionAutoProvisionResult> {
  const requestedIdentityHash = provisionedIdentityHash(request.identityPrompt) ?? '';
  const force = request.forceCreate === true;
  // Forced creations share an in-flight launch only with a retry of the SAME idempotency key; two different keys are two sessions.
  const reservationKey = `${parent.name}\0${request.pool}\0${config.capabilityId}\0${requestedIdentityHash}${force ? `\0force:${request.idempotencyKey}` : ''}`;
  const existingReservation = inFlight.get(reservationKey);
  if (existingReservation) return existingReservation;

  const operation = (async (): Promise<SupervisionAutoProvisionResult> => {
    const now = deps.now();
    // Forced: only the session THIS key already made counts as ready; any other idle session is none of this call's business.
    const forcedName = force ? attemptIdentity(request, config).sessionName : undefined;
    const existingReady = readyChildren(deps.listSessions(), parent, config, now, request.identityPrompt)
      .find((candidate) => forcedName === undefined || candidate.name === forcedName);
    if (existingReady) {
      return {
        ok: true,
        target: existingReady,
        evidence: { selectedPool, selectedConfig: config, origin: 'reused' },
      };
    }

    const until = force ? 0 : cooldownUntil.get(`${parent.name}\0${request.pool}`) ?? 0;
    if (until > now) {
      return { ok: false, reason: 'cooldown', evidence: failureEvidence(selectedPool, 'cooldown', config) };
    }
    const definition = poolDefinition(parent, request.pool);
    if (!definition && !hasManualExplicitConfig(request)) {
      return { ok: false, reason: 'pool_unconfigured', evidence: failureEvidence(selectedPool, 'pool_unconfigured', config) };
    }
    const identity = attemptIdentity(request, config);
    const existing = deps.getSession(identity.sessionName);
    if (existing && (!configMatchesSession(config, existing, request.identityPrompt)
      || existing.parentSession !== parent.name || existing.role === 'brain')) {
      return {
        ok: false,
        reason: 'identity_collision',
        evidence: failureEvidence(selectedPool, 'identity_collision', config, {
          provisionAttemptId: identity.attemptId,
          createdSessionName: identity.sessionName,
        }),
      };
    }

    if (force) {
      // An explicit creation is not pool work: the pool's work-concurrency and spawn gates, and reaping another session to make room,
      // do not apply. The one bound is the per-project cap of auto-created sessions, counted with the launches still in flight and
      // reserved right here (no await between the check and the reservation); a retry of the same key never counts against it.
      if (!existing && !reserveAutoCreatedSlot(parent.projectName, identity.sessionName, deps.listSessions(), TASK_PAIR_AUTO_CREATED_SESSION_MAX_PER_PROJECT)) {
        return { ok: false, reason: 'auto_created_cap_reached', evidence: failureEvidence(selectedPool, 'auto_created_cap_reached', config) };
      }
    } else {
      let spawnedCount = deps.listSessions().filter((session) => (
        childConsumesPool(parent, session, request.pool)
      )).length;
      const controls = definition?.controls ?? DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS[request.pool];
      if (await deps.countActiveSupervisionAssignments(parent, request.pool) >= controls.maxConcurrency) {
        return { ok: false, reason: 'max_concurrency', evidence: failureEvidence(selectedPool, 'max_concurrency', config) };
      }
      if (!existing && spawnedCount >= controls.maxSpawned) {
        await reapOneIdleAutomaticChild(parent, request, deps);
        spawnedCount = deps.listSessions().filter((session) => (
          childConsumesPool(parent, session, request.pool)
        )).length;
      }
      if (!existing && spawnedCount >= controls.maxSpawned) {
        return { ok: false, reason: 'max_spawned', evidence: failureEvidence(selectedPool, 'max_spawned', config) };
      }
    }

    if (!existing) {
      try {
        await deps.startSubSession({
          id: identity.subId,
          type: config.agentType,
          cwd: parent.projectDir,
          runtimeType: config.runtimeType,
          providerId: config.agentType,
          requestedModel: config.model,
          ...(config.ccPresetId ? { ccPreset: config.ccPresetId } : {}),
          ...(request.identityPrompt ? { identityPrompt: request.identityPrompt } : {}),
          ...(requestedIdentityHash ? { provisionedIdentityHash: requestedIdentityHash } : {}),
          parentSession: parent.name,
          fresh: true,
          label: `Auto ${selectedPool}`,
          ...(force
            ? {
              pairCreatedMetadata: {
                autoCreated: true,
                createdBy: parent.name,
                source: SEND_AUTO_PROVISION_CREATED_SESSION_SOURCE,
                reason: request.createdReason ?? TASK_PAIR_CREATED_SESSION_REASONS.EXPLICIT,
                createdAt: deps.now(),
              } satisfies TaskPairCreatedSessionMetadata,
            }
            : {}),
        });
        releaseAutoCreatedSlot(identity.sessionName);
      } catch (error) {
        logger.warn({
          err: error,
          parentSessionName: parent.name,
          createdSessionName: identity.sessionName,
          agentType: config.agentType,
          providerFamily: config.providerFamily,
          runtimeType: config.runtimeType,
          model: config.model,
        }, 'Supervision target auto-provision launch failed');
        if (!force) cooldownUntil.set(`${parent.name}\0${request.pool}`, deps.now() + deps.cooldownMs);
        // A launch that threw may still have left a record behind: no failure leaves a half-made session. The slot is released only
        // after it is gone, so a half-made session never makes room for one more.
        if (force) await discardHalfMade(deps, identity.sessionName);
        releaseAutoCreatedSlot(identity.sessionName);
        return {
          ok: false,
          reason: 'launch_failed',
          evidence: failureEvidence(selectedPool, 'launch_failed', config, {
            provisionAttemptId: identity.attemptId,
            createdSessionName: identity.sessionName,
          }),
        };
      }
    }

    const deadline = deps.now() + deps.readyTimeoutMs;
    while (deps.now() <= deadline) {
      const current = readyChildren(deps.listSessions(), parent, config, deps.now(), request.identityPrompt)
        .find((candidate) => candidate.name === identity.sessionName);
      if (current) {
        if (!force) cooldownUntil.set(`${parent.name}\0${request.pool}`, deps.now() + deps.cooldownMs);
        return {
          ok: true,
          target: current,
          evidence: {
            selectedPool,
            selectedConfig: config,
            origin: 'spawned',
            provisionAttemptId: identity.attemptId,
            createdSessionName: identity.sessionName,
          },
        };
      }
      await deps.wait(SUPERVISION_AUTO_PROVISION_POLL_MS);
    }
    if (!force) cooldownUntil.set(`${parent.name}\0${request.pool}`, deps.now() + deps.cooldownMs);
    if (force) await discardHalfMade(deps, identity.sessionName);
    return {
      ok: false,
      reason: 'readiness_timeout',
      evidence: failureEvidence(selectedPool, 'readiness_timeout', config, {
        provisionAttemptId: identity.attemptId,
        createdSessionName: identity.sessionName,
      }),
    };
  })();

  inFlight.set(reservationKey, operation);
  try {
    return await operation;
  } finally {
    if (inFlight.get(reservationKey) === operation) inFlight.delete(reservationKey);
  }
}

// ---- the per-project cap of auto-created sessions -------------------------------------------------------------------------------------

/**
 * Sessions an auto-creation has started whose creation marker is not on the session record yet, keyed by session name. A transport
 * launch takes seconds and the marker is written only when it finishes, so counting marked sessions alone lets parallel creations all
 * see the same room and overshoot the cap. Each creation reserves its slot here, in the same synchronous run as the cap check and
 * before its first await, and releases it once the launch has settled (the marker is then on the record, or the half-made session is gone).
 */
const creationsInFlight = new Map<string, string>();

/** Every auto-created session of this project: those whose record carries the marker, plus those still being launched. */
export function autoCreatedCount(projectName: string, sessions: readonly SessionRecord[]): number {
  const names = new Set(listPairCreatedSessions(projectName, sessions).map((session) => session.name));
  for (const [sessionName, project] of creationsInFlight) if (project === projectName) names.add(sessionName);
  return names.size;
}

/** Check the cap and take a slot in one synchronous step; false means the project is full. A name already holding a slot keeps it. */
function reserveAutoCreatedSlot(projectName: string, sessionName: string, sessions: readonly SessionRecord[], max: number): boolean {
  if (creationsInFlight.has(sessionName)) return true;
  if (autoCreatedCount(projectName, sessions) >= max) return false;
  creationsInFlight.set(sessionName, projectName);
  return true;
}

function releaseAutoCreatedSlot(sessionName: string): void {
  creationsInFlight.delete(sessionName);
}

/** Test seam: how many creations currently hold a slot. */
export function autoCreatedSlotsInFlightForTests(): number { return creationsInFlight.size; }

// ---- sessions created by pair_create ------------------------------------------------------------------------------------------------

const PAIR_SESSION_ID_PREFIX = 'pair_auto_';

export type PairSubSessionFailureReason =
  | 'parent_unavailable' | 'cap_reached' | 'provider_limited' | 'provider_offline' | 'launch_failed' | 'readiness_timeout' | 'identity_collision'
  | 'not_daemon_process' | 'announce_failed' | 'session_not_live';

export interface PairSubSessionRequest {
  parentSessionName: string;
  config: SupervisionExecutionConfig;
  /** Marker stored on the new session record: who created it for which pair and role. `autoCreated` and `createdAt` are stamped here; `source` defaults to pair_create. */
  metadata: Omit<TaskPairCreatedSessionMetadata, 'autoCreated' | 'source' | 'createdAt'> & { source?: TaskPairCreatedSessionMetadata['source'] };
  label: string;
  /** Stable per pair and role: a retry derives the same session name and reuses the session instead of creating a second. */
  idempotencyKey: string;
}

/**
 * `live: true` is a verified fact, not a hope: the record is in the daemon's store, it is ready, a transport session has its runtime in
 * THIS process, and the server was told (`announced`) - or there is no open server link, in which case the reconnect resync tells it
 * (`announced: false`). A result that cannot say this is a failure and the half-made session has been removed.
 */
export type PairSubSessionResult =
  | { ok: true; target: SessionRecord; created: boolean; live: true; announced: boolean }
  | { ok: false; reason: PairSubSessionFailureReason; detail?: string };

/**
 * Why this session is not a live pair participant right now, or undefined when it is: missing from the store, stopped/errored, or a
 * transport session without a runtime in this process. The one definition pair_create, the delivery receipts and the heartbeat share.
 */
export function pairSessionNotLiveReason(
  record: SessionRecord | undefined,
  hasRuntime: (session: SessionRecord) => boolean = defaultHasRuntime,
): string | undefined {
  if (!record) return 'the session does not exist';
  if (record.state === 'stopped' || record.state === 'error') return `the session is ${record.state}`;
  if (record.runtimeType === 'transport' && !hasRuntime(record)) return 'the session has no running runtime';
  return undefined;
}

function defaultHasRuntime(session: SessionRecord): boolean {
  return getTransportRuntime(session.name) !== undefined;
}

/** Every sub-session of this project that pair_create created (the recycling selector, and the cap's count). */
export function listPairCreatedSessions(projectName: string, sessions: readonly SessionRecord[]): SessionRecord[] {
  return sessions.filter((session) => session.projectName === projectName && session.pairCreatedMetadata?.autoCreated === true);
}

function pairSessionIdentity(request: PairSubSessionRequest): { subId: string; sessionName: string } {
  const digest = createHash('sha256').update(JSON.stringify({
    parent: request.parentSessionName,
    capabilityId: request.config.capabilityId,
    idempotencyKey: request.idempotencyKey,
    role: request.metadata.role ?? null,
  })).digest('hex');
  const subId = `${PAIR_SESSION_ID_PREFIX}${digest.slice(0, 16)}`;
  return { subId, sessionName: `deck_sub_${subId}` };
}

/**
 * Create ONE sub-session for a pair (deterministic, never "decide whether to": the caller's rule already did). Shares the supervision
 * auto-provision launch path (`startSubSession`), its readiness test and its provider-availability check, but none of its policy that
 * assumes a daemon-owned automatic pool: no cooldown (a pair needs two sessions back to back), no in-flight sharing (two pairs must
 * never be handed one session), no idle reaping (closing is the recycling feature's job) and no pool controls. The session carries
 * `pairCreatedMetadata` from its first write. A failed launch or a readiness timeout stops the half-made session, so no failure leaves
 * one behind; the project cap (TASK_PAIR_AUTO_CREATED_SESSION_MAX_PER_PROJECT) is checked before anything is launched.
 */
export async function createPairSubSession(
  request: PairSubSessionRequest,
  injected: SupervisionAutoProvisionDeps & {
    maxPerProject?: number;
    /** Test seams: what tells the server, whether a transport session has its runtime here, and whether this is a helper process. */
    announce?: (sessionName: string, id: string) => Promise<SubSessionAnnounceOutcome>;
    hasRuntime?: (session: SessionRecord) => boolean;
    nonDaemonProcess?: boolean;
  } = {},
): Promise<PairSubSessionResult> {
  // Only the daemon may create a pair's session: a stdio MCP child or CLI has a private session map and provider registry, so a session
  // it launches is invisible to the daemon and the server and dies with that process (the pair then names a session that does not exist).
  if (injected.nonDaemonProcess ?? isNonDaemonProcess()) {
    return { ok: false, reason: 'not_daemon_process', detail: 'pair sub-sessions are created by the daemon process only' };
  }
  const deps = {
    now: injected.now ?? Date.now,
    listSessions: injected.listSessions ?? (() => listSessions()),
    getSession: injected.getSession ?? getSession,
    startSubSession: injected.startSubSession ?? startSubSession,
    // The server link is passed so that, when the session had already been announced, the server and browsers hear `subsession.closed`.
    stopSubSession: injected.stopSubSession ?? (async (sessionName: string) => (await stopSubSession(sessionName, getActiveServerLink())).ok),
    wait: injected.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    readyTimeoutMs: injected.readyTimeoutMs ?? SUPERVISION_AUTO_PROVISION_READY_TIMEOUT_MS,
    maxPerProject: injected.maxPerProject ?? TASK_PAIR_AUTO_CREATED_SESSION_MAX_PER_PROJECT,
    announce: injected.announce ?? ((_sessionName: string, id: string) => announceSubSession(getActiveServerLink(), id)),
    hasRuntime: injected.hasRuntime ?? defaultHasRuntime,
  };
  const parent = deps.getSession(request.parentSessionName);
  if (!parent || parent.role !== 'brain') return { ok: false, reason: 'parent_unavailable' };
  const { subId, sessionName } = pairSessionIdentity(request);
  const discard = async (): Promise<void> => {
    try { await deps.stopSubSession(sessionName); } catch (error) {
      logger.warn({ err: error, sessionName }, 'pair session creation: could not remove a half-made session');
    }
  };
  // The last gate before "created": the record is still in the store and has its runtime, then the server is told. Any miss removes the
  // session (a session this call did not create is left alone) and reports it, so no caller ever holds a name that is not a live session.
  const finishLive = async (ready: SessionRecord, created: boolean): Promise<PairSubSessionResult> => {
    const notLive = pairSessionNotLiveReason(deps.getSession(sessionName) ?? undefined, deps.hasRuntime);
    if (notLive) {
      if (created) await discard();
      return { ok: false, reason: 'session_not_live', detail: `${sessionName}: ${notLive}` };
    }
    const outcome = await deps.announce(sessionName, subId);
    if (outcome === 'failed') {
      if (created) await discard();
      return { ok: false, reason: 'announce_failed', detail: sessionName };
    }
    return { ok: true, target: deps.getSession(sessionName) ?? ready, created, live: true, announced: outcome === 'announced' };
  };
  const sessions = deps.listSessions();
  const existing = deps.getSession(sessionName);
  if (existing) {
    // A retry of the same create: the same pair and role already made this session.
    if (existing.parentSession !== parent.name || existing.role === 'brain'
      || existing.pairCreatedMetadata?.pairTaskId !== request.metadata.pairTaskId) {
      return { ok: false, reason: 'identity_collision', detail: sessionName };
    }
    const availability = resolveDelegationTargets(delegationTargetInputs(sessions), deps.now());
    if (sessionIsReady(existing, availability.get(existing.name)?.availability)) {
      // A retry finds the session already there: it is still verified and announced again (idempotent on the server) before it is called live.
      return finishLive(existing, false);
    }
  }
  const status = configurationAvailability(sessions, parent, request.config, deps.now());
  if (status === 'limited') return { ok: false, reason: 'provider_limited' };
  if (status === 'offline') return { ok: false, reason: 'provider_offline' };
  // The slot is reserved here, in the same synchronous run as the cap check and before the first await: parallel creations (two
  // pairs, or a pair and a task.autoProvision) must not all see the room that the launches still in flight are about to use.
  if (!existing && !reserveAutoCreatedSlot(parent.projectName, sessionName, sessions, deps.maxPerProject)) {
    return { ok: false, reason: 'cap_reached', detail: `${deps.maxPerProject}` };
  }

  if (!existing) {
    try {
      await deps.startSubSession({
        id: subId,
        type: request.config.agentType,
        cwd: parent.projectDir,
        runtimeType: request.config.runtimeType,
        providerId: request.config.agentType,
        requestedModel: request.config.model,
        ...(request.config.ccPresetId ? { ccPreset: request.config.ccPresetId } : {}),
        parentSession: parent.name,
        fresh: true,
        label: request.label,
        pairCreatedMetadata: { ...request.metadata, autoCreated: true, source: request.metadata.source ?? TASK_PAIR_CREATED_SESSION_SOURCE, createdAt: deps.now() },
      });
      releaseAutoCreatedSlot(sessionName);
    } catch (error) {
      logger.warn({ err: error, parentSessionName: parent.name, sessionName, model: request.config.model }, 'pair session creation: launch failed');
      await discard();
      releaseAutoCreatedSlot(sessionName);
      return { ok: false, reason: 'launch_failed', detail: error instanceof Error ? error.message : String(error) };
    }
  }
  const deadline = deps.now() + deps.readyTimeoutMs;
  while (deps.now() <= deadline) {
    const current = deps.getSession(sessionName);
    if (current && sessionIsReady(current, resolveDelegationTargets(delegationTargetInputs(deps.listSessions()), deps.now()).get(sessionName)?.availability)) {
      return finishLive(current, !existing);
    }
    await deps.wait(SUPERVISION_AUTO_PROVISION_POLL_MS);
  }
  await discard();
  return { ok: false, reason: 'readiness_timeout', detail: sessionName };
}

function degradationFor(
  crossConfigs: readonly SupervisionExecutionConfig[],
  statuses: readonly ('available' | 'limited' | 'offline')[],
  provisionFailure?: SupervisionProvisionFailureReason,
): SupervisionAuditDegradedReason {
  if (provisionFailure === 'readiness_timeout') return 'cross_vendor_provision_timeout';
  if (provisionFailure) return 'cross_vendor_provision_failed';
  if (crossConfigs.length === 0) return 'no_cross_vendor_configured';
  if (statuses.length > 0 && statuses.every((status) => status === 'limited')) return 'cross_vendor_limited';
  if (statuses.length > 0 && statuses.every((status) => status === 'offline')) return 'cross_vendor_offline';
  return 'cross_vendor_unavailable';
}

export async function provisionSupervisionTarget(
  request: SupervisionAutoProvisionRequest,
  injected: SupervisionAutoProvisionDeps = {},
): Promise<SupervisionAutoProvisionResult> {
  const deps = {
    now: injected.now ?? Date.now,
    listSessions: injected.listSessions ?? (() => listSessions()),
    getSession: injected.getSession ?? getSession,
    startSubSession: injected.startSubSession ?? startSubSession,
    // The shared close also tells the server, so a discarded or reaped session leaves the browser's list too.
    stopSubSession: injected.stopSubSession ?? (async (sessionName: string) => (
      await closeSubSession(sessionName)
    ).ok),
    hasActiveSupervisionLease: injected.hasActiveSupervisionLease ?? defaultHasActiveSupervisionLease,
    countActiveSupervisionAssignments: injected.countActiveSupervisionAssignments
      ?? defaultCountActiveSupervisionAssignments,
    wait: injected.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    readyTimeoutMs: injected.readyTimeoutMs ?? SUPERVISION_AUTO_PROVISION_READY_TIMEOUT_MS,
    cooldownMs: injected.cooldownMs ?? SUPERVISION_AUTO_PROVISION_COOLDOWN_MS,
    idleReapMs: injected.idleReapMs ?? SUPERVISION_AUTO_PROVISION_IDLE_REAP_MS,
  };
  const parent = deps.getSession(request.parentSessionName);
  const selectedPool: SupervisionProvisionPool = request.auditedSessionName ? 'audit' : request.pool;
  if (!parent || parent.role !== 'brain') {
    return { ok: false, reason: 'parent_unavailable', evidence: failureEvidence(selectedPool, 'parent_unavailable') };
  }
  if (request.provenance === 'automatic_supervision'
    && !isAutomaticSupervisionEnabled(extractSessionSupervisionSnapshot(parent.transportConfig ?? null))) {
    return { ok: false, reason: 'no_selected_config', evidence: failureEvidence(selectedPool, 'no_selected_config') };
  }
  const definition = poolDefinition(parent, request.pool);
  if (!definition && !hasManualExplicitConfig(request)) {
    return { ok: false, reason: 'pool_unconfigured', evidence: failureEvidence(selectedPool, 'pool_unconfigured') };
  }
  const configs = supportedConfigs(parent, request);
  if (configs.length === 0) {
    const reason: SupervisionProvisionFailureReason = definition && definition.configs.length === 0
      ? 'no_selected_config' : 'unsupported_config';
    return { ok: false, reason, evidence: failureEvidence(selectedPool, reason) };
  }

  const sessions = deps.listSessions();
  const audited = request.auditedSessionName ? deps.getSession(request.auditedSessionName) : undefined;
  if (request.auditedSessionName && !audited) {
    return {
      ok: false,
      reason: 'audited_unavailable',
      evidence: failureEvidence(selectedPool, 'audited_unavailable'),
      auditDegradedReason: 'no_independent_session',
    };
  }
  if (!audited) {
    const ready = request.forceCreate
      ? undefined
      : configs.flatMap((config) => readyChildren(sessions, parent, config, deps.now(), request.identityPrompt))[0];
    if (ready) {
      const config = configs.find((candidate) => configMatchesSession(candidate, ready, request.identityPrompt))!;
      return {
        ok: true,
        target: ready,
        evidence: { selectedPool, selectedConfig: config, origin: 'reused' },
      };
    }
    const config = configs[0]!;
    const status = configurationAvailability(sessions, parent, config, deps.now(), request.identityPrompt);
    if (status === 'limited' || status === 'offline') {
      const reason = status === 'limited' ? 'provider_limited' : 'provider_offline';
      return { ok: false, reason, evidence: failureEvidence(selectedPool, reason, config) };
    }
    return provisionConfig(parent, request, config, deps, selectedPool);
  }

  const auditedFamily = resolvePeerAuditProviderFamily(audited);
  const crossConfigs = configs.filter((config) => config.providerFamily !== auditedFamily);
  const sameConfigs = configs.filter((config) => config.providerFamily === auditedFamily);
  const crossReady = request.forceCreate
    ? undefined
    : crossConfigs.flatMap((config) => readyChildren(sessions, parent, config, deps.now(), request.identityPrompt))[0];
  if (crossReady) {
    const config = crossConfigs.find((candidate) => configMatchesSession(candidate, crossReady, request.identityPrompt))!;
    return {
      ok: true,
      target: crossReady,
      evidence: { selectedPool, selectedConfig: config, origin: 'reused' },
      auditRoutingReason: 'cross_vendor_preferred',
    };
  }

  const crossStatuses = crossConfigs.map((config) => configurationAvailability(
    sessions,
    parent,
    config,
    deps.now(),
    request.identityPrompt,
  ));
  const provisionableCross = crossConfigs.find((_config, index) => crossStatuses[index] === 'available');
  let crossFailure: SupervisionProvisionFailureReason | undefined;
  let crossEvidence: SupervisionProvisioningEvidence | undefined;
  if (provisionableCross) {
    const provisioned = await provisionConfig(parent, request, provisionableCross, deps, selectedPool);
    if (provisioned.ok) return { ...provisioned, auditRoutingReason: 'cross_vendor_preferred' };
    crossFailure = provisioned.reason;
    crossEvidence = provisioned.evidence;
  }

  const degradedReason = degradationFor(crossConfigs, crossStatuses, crossFailure);
  if (request.strictCrossVendor) {
    return {
      ok: false,
      reason: crossFailure ?? (crossStatuses.includes('limited') ? 'provider_limited'
        : crossStatuses.includes('offline') ? 'provider_offline' : 'no_selected_config'),
      evidence: { ...(crossEvidence ?? failureEvidence(selectedPool, 'no_selected_config')), degradedReason },
      auditDegradedReason: degradedReason,
    };
  }

  const sameReady = request.forceCreate
    ? undefined
    : sameConfigs.flatMap((config) => readyChildren(deps.listSessions(), parent, config, deps.now(), request.identityPrompt))
      .filter((session) => session.name !== audited.name)[0];
  if (sameReady) {
    const config = sameConfigs.find((candidate) => configMatchesSession(candidate, sameReady, request.identityPrompt))!;
    return {
      ok: true,
      target: sameReady,
      evidence: {
        ...(crossEvidence ?? { selectedPool, selectedConfig: config }),
        selectedConfig: config,
        origin: 'reused',
        createdSessionName: undefined,
        degradedReason,
      },
      auditRoutingReason: 'same_family_degraded',
      auditDegradedReason: degradedReason,
    };
  }

  const sameConfig = sameConfigs[0];
  if (sameConfig) {
    const status = configurationAvailability(deps.listSessions(), parent, sameConfig, deps.now());
    if (status === 'available') {
      const provisioned = await provisionConfig(parent, request, sameConfig, deps, selectedPool);
      if (provisioned.ok && provisioned.target.name !== audited.name) {
        return {
          ...provisioned,
          evidence: { ...provisioned.evidence, degradedReason },
          auditRoutingReason: 'same_family_degraded',
          auditDegradedReason: degradedReason,
        };
      }
    }
  }

  return {
    ok: false,
    reason: crossFailure ?? 'no_selected_config',
    evidence: {
      ...(crossEvidence ?? failureEvidence(selectedPool, 'no_selected_config')),
      degradedReason: 'no_independent_session',
    },
    auditDegradedReason: 'no_independent_session',
  };
}
