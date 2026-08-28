import { createHash } from 'node:crypto';
import {
  DELEGATION_AVAILABILITY,
  resolveDelegationTargets,
} from '../../shared/delegation-availability.js';
import { isTransportSessionAgentType } from '../../shared/agent-types.js';
import { resolveEffectiveSessionModel } from '../../shared/session-model.js';
import {
  normalizeSupervisionExecutionPools,
  normalizeSupervisionExecutionModel,
  type SupervisionAuditDegradedReason,
  type SupervisionExecutionConfig,
  type SupervisionProvisionFailureReason,
  type SupervisionProvisionPool,
  type SupervisionProvisioningEvidence,
} from '../../shared/supervision-execution-pool.js';
import {
  SUPERVISION_TRANSPORT_CONFIG_KEY,
  extractSessionSupervisionSnapshot,
  isAutomaticSupervisionEnabled,
} from '../../shared/supervision-config.js';
import type { SessionRecord } from '../store/session-store.js';
import { getSession, listSessions } from '../store/session-store.js';
import { resolvePeerAuditProviderFamily } from './peer-audit-candidates.js';
import { delegationTargetInputs } from './delegation-admission.js';
import { startSubSession, type SubSessionRecord } from './subsession-manager.js';

const AUTO_SESSION_ID_PREFIX = 'sup_auto_';
export const SUPERVISION_AUTO_PROVISION_COOLDOWN_MS = 30_000;
export const SUPERVISION_AUTO_PROVISION_READY_TIMEOUT_MS = 15_000;
const SUPERVISION_AUTO_PROVISION_POLL_MS = 50;

export interface SupervisionAutoProvisionRequest {
  parentSessionName: string;
  pool: 'primary' | 'economy';
  requestedCapabilityId?: string;
  idempotencyKey: string;
  auditedSessionName?: string;
  strictCrossVendor?: boolean;
  /** Explicit tool calls are manual; daemon-owned callers must opt into this provenance. */
  provenance?: 'manual_explicit' | 'automatic_supervision';
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
  wait?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  cooldownMs?: number;
}

const inFlight = new Map<string, Promise<SupervisionAutoProvisionResult>>();
const cooldownUntil = new Map<string, number>();

export function clearSupervisionAutoProvisionStateForTests(): void {
  inFlight.clear();
  cooldownUntil.clear();
}

function configuredPools(parent: SessionRecord) {
  const raw = parent.transportConfig?.[SUPERVISION_TRANSPORT_CONFIG_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const executionPools = (raw as Record<string, unknown>).executionPools;
  const normalized = normalizeSupervisionExecutionPools(executionPools);
  return normalized.state === 'configured' ? normalized : undefined;
}

function poolDefinition(parent: SessionRecord, pool: SupervisionAutoProvisionRequest['pool']) {
  const pools = configuredPools(parent);
  if (!pools) return undefined;
  return pool === 'primary' ? pools.primaryDevelopmentPool : pools.economyTaskPool;
}

function supportedConfigs(
  parent: SessionRecord,
  request: SupervisionAutoProvisionRequest,
): SupervisionExecutionConfig[] {
  const definition = poolDefinition(parent, request.pool);
  if (!definition) return [];
  const supported = definition.configs.filter((config) => (
    config.runtimeType === 'transport'
    && isTransportSessionAgentType(config.agentType)
  ));
  return request.requestedCapabilityId
    ? supported.filter((config) => config.capabilityId === request.requestedCapabilityId)
    : supported;
}

function configMatchesSession(config: SupervisionExecutionConfig, session: SessionRecord): boolean {
  const model = resolveEffectiveSessionModel(session);
  return session.agentType === config.agentType
    && (session.runtimeType ?? 'process') === config.runtimeType
    && resolvePeerAuditProviderFamily(session) === config.providerFamily
    && typeof model === 'string'
    && normalizeSupervisionExecutionModel(session.agentType, model) === config.model;
}

function matchingChildren(
  sessions: readonly SessionRecord[],
  parent: SessionRecord,
  config: SupervisionExecutionConfig,
): SessionRecord[] {
  return sessions.filter((session) => (
    session.parentSession === parent.name
    && session.role !== 'brain'
    && !session.executionCloneMetadata
    && configMatchesSession(config, session)
  ));
}

function readyChildren(
  sessions: readonly SessionRecord[],
  parent: SessionRecord,
  config: SupervisionExecutionConfig,
  now: number,
): SessionRecord[] {
  const availability = resolveDelegationTargets(delegationTargetInputs(sessions), now);
  return matchingChildren(sessions, parent, config)
    .filter((session) => session.state === 'idle'
      && Boolean(session.sessionInstanceId)
      && Boolean(session.runtimeEpoch)
      && availability.get(session.name)?.availability === DELEGATION_AVAILABILITY.READY)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function configurationAvailability(
  sessions: readonly SessionRecord[],
  parent: SessionRecord,
  config: SupervisionExecutionConfig,
  now: number,
): 'available' | 'limited' | 'offline' {
  const matches = matchingChildren(sessions, parent, config);
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
  })).digest('hex');
  const suffix = digest.slice(0, 16);
  const subId = `${AUTO_SESSION_ID_PREFIX}${suffix}`;
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

async function provisionConfig(
  parent: SessionRecord,
  request: SupervisionAutoProvisionRequest,
  config: SupervisionExecutionConfig,
  deps: Required<Pick<SupervisionAutoProvisionDeps, 'now' | 'listSessions' | 'getSession' | 'startSubSession' | 'wait' | 'readyTimeoutMs' | 'cooldownMs'>>,
  selectedPool: SupervisionProvisionPool,
): Promise<SupervisionAutoProvisionResult> {
  const reservationKey = `${parent.name}\0${request.pool}\0${config.capabilityId}`;
  const existingReservation = inFlight.get(reservationKey);
  if (existingReservation) return existingReservation;

  const operation = (async (): Promise<SupervisionAutoProvisionResult> => {
    const now = deps.now();
    const existingReady = readyChildren(deps.listSessions(), parent, config, now)[0];
    if (existingReady) {
      return { ok: true, target: existingReady, evidence: { selectedPool, selectedConfig: config } };
    }

    const until = cooldownUntil.get(`${parent.name}\0${request.pool}`) ?? 0;
    if (until > now) {
      return { ok: false, reason: 'cooldown', evidence: failureEvidence(selectedPool, 'cooldown', config) };
    }
    const definition = poolDefinition(parent, request.pool);
    if (!definition) {
      return { ok: false, reason: 'pool_unconfigured', evidence: failureEvidence(selectedPool, 'pool_unconfigured', config) };
    }
    const identity = attemptIdentity(request, config);
    const existing = deps.getSession(identity.sessionName);
    if (existing && (!configMatchesSession(config, existing)
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

    const spawnedCount = deps.listSessions().filter((session) => (
      session.parentSession === parent.name
      && session.name.startsWith(`deck_sub_${AUTO_SESSION_ID_PREFIX}`)
      && session.label === `Auto ${selectedPool}`
    )).length;
    if (!existing && spawnedCount >= definition.controls.maxSpawned) {
      return { ok: false, reason: 'max_spawned', evidence: failureEvidence(selectedPool, 'max_spawned', config) };
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
          parentSession: parent.name,
          fresh: true,
          label: `Auto ${selectedPool}`,
        });
      } catch {
        cooldownUntil.set(`${parent.name}\0${request.pool}`, deps.now() + deps.cooldownMs);
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
      const current = readyChildren(deps.listSessions(), parent, config, deps.now())
        .find((candidate) => candidate.name === identity.sessionName);
      if (current) {
        cooldownUntil.set(`${parent.name}\0${request.pool}`, deps.now() + deps.cooldownMs);
        return {
          ok: true,
          target: current,
          evidence: {
            selectedPool,
            selectedConfig: config,
            provisionAttemptId: identity.attemptId,
            createdSessionName: identity.sessionName,
          },
        };
      }
      await deps.wait(SUPERVISION_AUTO_PROVISION_POLL_MS);
    }
    cooldownUntil.set(`${parent.name}\0${request.pool}`, deps.now() + deps.cooldownMs);
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
    wait: injected.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    readyTimeoutMs: injected.readyTimeoutMs ?? SUPERVISION_AUTO_PROVISION_READY_TIMEOUT_MS,
    cooldownMs: injected.cooldownMs ?? SUPERVISION_AUTO_PROVISION_COOLDOWN_MS,
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
  if (!definition) {
    return { ok: false, reason: 'pool_unconfigured', evidence: failureEvidence(selectedPool, 'pool_unconfigured') };
  }
  const configs = supportedConfigs(parent, request);
  if (configs.length === 0) {
    const reason: SupervisionProvisionFailureReason = definition.configs.length === 0
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
    const ready = configs.flatMap((config) => readyChildren(sessions, parent, config, deps.now()))[0];
    if (ready) {
      const config = configs.find((candidate) => configMatchesSession(candidate, ready))!;
      return { ok: true, target: ready, evidence: { selectedPool, selectedConfig: config } };
    }
    const config = configs[0]!;
    const status = configurationAvailability(sessions, parent, config, deps.now());
    if (status === 'limited' || status === 'offline') {
      const reason = status === 'limited' ? 'provider_limited' : 'provider_offline';
      return { ok: false, reason, evidence: failureEvidence(selectedPool, reason, config) };
    }
    return provisionConfig(parent, request, config, deps, selectedPool);
  }

  const auditedFamily = resolvePeerAuditProviderFamily(audited);
  const crossConfigs = configs.filter((config) => config.providerFamily !== auditedFamily);
  const sameConfigs = configs.filter((config) => config.providerFamily === auditedFamily);
  const crossReady = crossConfigs.flatMap((config) => readyChildren(sessions, parent, config, deps.now()))[0];
  if (crossReady) {
    const config = crossConfigs.find((candidate) => configMatchesSession(candidate, crossReady))!;
    return {
      ok: true,
      target: crossReady,
      evidence: { selectedPool, selectedConfig: config },
      auditRoutingReason: 'cross_vendor_preferred',
    };
  }

  const crossStatuses = crossConfigs.map((config) => configurationAvailability(sessions, parent, config, deps.now()));
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

  const sameReady = sameConfigs.flatMap((config) => readyChildren(deps.listSessions(), parent, config, deps.now()))
    .filter((session) => session.name !== audited.name)[0];
  if (sameReady) {
    const config = sameConfigs.find((candidate) => configMatchesSession(candidate, sameReady))!;
    return {
      ok: true,
      target: sameReady,
      evidence: { ...(crossEvidence ?? { selectedPool, selectedConfig: config }), selectedConfig: config, degradedReason },
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
