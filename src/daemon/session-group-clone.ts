import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { getSessionRuntimeType, isSessionAgentType } from '../../shared/agent-types.js';
import type { TransportEffortLevel } from '../../shared/effort-levels.js';
import { p2pScopedSessionKey } from '../../shared/p2p-config-scope.js';
import {
  SESSION_GROUP_CLONE_MSG,
  SessionGroupCloneValidationError,
  cloneP2pConfigWithSessionRemap,
  defaultCloneTargetProjectName,
  isRoleCompatibleMainSession,
  resolveCloneTargetProject,
  type CloneableMainSessionSpec,
  type CloneableSessionGroupSpec,
  type CloneableSubSessionSpec,
  type SessionGroupCloneErrorCode,
  type SessionGroupCloneCleanupResource,
  type SessionGroupCloneEvent,
  type SessionGroupCloneRequest,
  type SessionGroupCloneResult,
  type SessionGroupCloneSkippedMember,
  type SessionGroupCloneState,
  type SessionGroupCloneWarning,
} from '../../shared/session-group-clone.js';
import { launchSession, persistSessionRecord, persistSessionRecordAwaited, stopProject } from '../agent/session-manager.js';
import { getSession, listSessions, removeSession, upsertSession, type SessionRecord } from '../store/session-store.js';
import {
  getSavedP2pConfig,
  removeSavedP2pConfig,
  upsertSavedP2pConfig,
} from '../store/p2p-config-store.js';
import logger from '../util/logger.js';
import type { ServerLink } from './server-link.js';
import { startSubSession, stopSubSession } from './subsession-manager.js';
import { sendSubSessionSync } from './subsession-sync.js';
import { getPaneCwd } from '../agent/tmux.js';
import { GitRemoteCloneError, cloneGitRemoteToDirectory } from './git-remote-clone.js';
import { normalizeOptionalGitRemoteUrl } from '../../shared/git-remote-url.js';

const OPERATION_RETENTION_MS = 10 * 60 * 1000;

interface CloneOperationSnapshot {
  operationId: string;
  idempotencyKey: string;
  sourceMainSessionName: string;
  requestFingerprint: string;
  state: SessionGroupCloneState;
  createdAt: number;
  updatedAt: number;
  result?: SessionGroupCloneResult;
  errorCode?: SessionGroupCloneErrorCode;
  cleanupResources?: SessionGroupCloneCleanupResource[];
  reservedTargetName?: string;
}

interface CreatedResources {
  targetProjectSlug?: string;
  reservedMainSessionName?: string;
  clonedMainSessionName?: string;
  clonedSubSessionNames: string[];
  persistedSessionNames: string[];
  providerSessions: SessionGroupCloneCleanupResource[];
  cleanupResources: SessionGroupCloneCleanupResource[];
  wroteDaemonP2pConfig?: boolean;
  targetP2pScope?: string;
  targetP2pBackup?: import('../../shared/p2p-modes.js').P2pSavedConfig;
}

const operationsByIdempotencyKey = new Map<string, CloneOperationSnapshot>();
const activeTargetReservations = new Set<string>();
const cancelledOperationIds = new Set<string>();
const CLONE_TRANSPORT_IDENTITY_KEY_NORMALIZED = new Set([
  'bindexistingkey',
  'ccsessionid',
  'codexsessionid',
  'conversationid',
  'geminisessionid',
  'opencodesessionid',
  'providersessionid',
  'providerresumeid',
  'resumeid',
  'sessionid',
  'sessionkey',
  'threadid',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCloneTransportIdentityKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase();
  return CLONE_TRANSPORT_IDENTITY_KEY_NORMALIZED.has(normalized)
    || normalized.endsWith('sessionid')
    || normalized.endsWith('sessionkey')
    || normalized.endsWith('resumeid')
    || normalized.endsWith('threadid');
}

function scrubCloneTransportIdentity(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubCloneTransportIdentity(item));
  }
  if (!isPlainRecord(value)) return value;

  const cleaned: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isCloneTransportIdentityKey(key)) continue;
    cleaned[key] = scrubCloneTransportIdentity(nestedValue);
  }
  return cleaned;
}

function cloneTransportConfigWithoutRuntimeIdentity(config: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!isPlainRecord(config)) return null;
  const cleaned = scrubCloneTransportIdentity(config);
  return isPlainRecord(cleaned) ? cleaned : null;
}

function pruneOperations(now = Date.now()): void {
  for (const [key, operation] of operationsByIdempotencyKey.entries()) {
    if (now - operation.updatedAt > OPERATION_RETENTION_MS) operationsByIdempotencyKey.delete(key);
  }
}

function sendCloneEvent(
  serverLink: ServerLink,
  operation: CloneOperationSnapshot,
  patch: Omit<Partial<SessionGroupCloneEvent>, 'type' | 'operationId' | 'idempotencyKey'> = {},
): void {
  const event: SessionGroupCloneEvent = {
    type: SESSION_GROUP_CLONE_MSG.EVENT,
    operationId: operation.operationId,
    idempotencyKey: operation.idempotencyKey,
    state: patch.state ?? operation.state,
    sourceMainSessionName: operation.sourceMainSessionName,
    ...(patch.clonedMainSessionName ? { clonedMainSessionName: patch.clonedMainSessionName } : {}),
    ...(typeof patch.totalSubSessions === 'number' ? { totalSubSessions: patch.totalSubSessions } : {}),
    ...(typeof patch.subSessionsCreated === 'number' ? { subSessionsCreated: patch.subSessionsCreated } : {}),
    ...(patch.skippedMembers ? { skippedMembers: patch.skippedMembers } : {}),
    ...(typeof patch.skippedCronJobs === 'number' ? { skippedCronJobs: patch.skippedCronJobs } : {}),
    ...(typeof patch.skippedOrchestrationRuns === 'number' ? { skippedOrchestrationRuns: patch.skippedOrchestrationRuns } : {}),
    ...(patch.warnings ? { warnings: patch.warnings } : {}),
    ...(patch.errorCode ? { errorCode: patch.errorCode } : {}),
    ...(patch.cleanupRequired ? { cleanupRequired: true } : {}),
    ...(patch.cleanupResources?.length ? { cleanupResources: patch.cleanupResources } : {}),
    ...(patch.result ? { result: patch.result } : {}),
  };
  serverLink.send(event);
}

function transition(
  serverLink: ServerLink,
  operation: CloneOperationSnapshot,
  state: SessionGroupCloneState,
  patch: Omit<Partial<SessionGroupCloneEvent>, 'type' | 'operationId' | 'idempotencyKey' | 'state'> = {},
): void {
  operation.state = state;
  operation.updatedAt = Date.now();
  sendCloneEvent(serverLink, operation, { ...patch, state });
}

export function getP2pConfigStoreScope(serverLink: Pick<ServerLink, 'getServerId'> | null | undefined, scopeSession: string): string {
  const serverId = typeof serverLink?.getServerId === 'function' ? serverLink.getServerId() : undefined;
  return p2pScopedSessionKey(scopeSession, serverId);
}

function isHiddenSession(record: SessionRecord): boolean {
  return (record as unknown as { hidden?: unknown }).hidden === true;
}

function skippedReasonForState(state: string): SessionGroupCloneSkippedMember['reason'] {
  if (state === 'error') return 'error';
  if (state === 'closed') return 'closed';
  return 'stopped';
}

function assertNotCancelled(operation: CloneOperationSnapshot): void {
  if (!cancelledOperationIds.has(operation.operationId)) return;
  throw new SessionGroupCloneValidationError('cancelled', 'Session group clone cancelled');
}

function requestFingerprint(request: Pick<SessionGroupCloneRequest, 'sourceMainSessionName' | 'targetProjectName' | 'cwdOverride' | 'gitRemoteUrl' | 'serverId'>): string {
  return JSON.stringify({
    serverId: request.serverId ?? null,
    sourceMainSessionName: request.sourceMainSessionName.trim(),
    targetProjectName: typeof request.targetProjectName === 'string'
      ? request.targetProjectName.trim()
      : request.targetProjectName ?? null,
    cwdOverride: typeof request.cwdOverride === 'string'
      ? request.cwdOverride.trim()
      : request.cwdOverride ?? null,
    gitRemoteUrl: typeof request.gitRemoteUrl === 'string'
      ? request.gitRemoteUrl.trim()
      : request.gitRemoteUrl ?? null,
  });
}

function pushCleanupResource(resources: CreatedResources, resource: SessionGroupCloneCleanupResource): void {
  const key = `${resource.kind}:${resource.id}:${resource.sessionName ?? ''}:${resource.providerId ?? ''}`;
  if (resources.cleanupResources.some((entry) => `${entry.kind}:${entry.id}:${entry.sessionName ?? ''}:${entry.providerId ?? ''}` === key)) return;
  resources.cleanupResources.push(resource);
}

function pushProviderSessionResource(resources: CreatedResources, record: SessionRecord): void {
  if (!record.providerSessionId) return;
  const resource: SessionGroupCloneCleanupResource = {
    kind: 'provider_session',
    id: record.providerSessionId,
    sessionName: record.name,
    providerId: record.providerId,
    retriable: false,
  };
  if (resources.providerSessions.some((entry) => entry.id === resource.id && entry.sessionName === resource.sessionName)) return;
  resources.providerSessions.push(resource);
}

async function resolveUsableDirectory(rawPath: string, fieldPath: string): Promise<string> {
  const trimmed = rawPath.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new SessionGroupCloneValidationError('invalid_cwd', `${fieldPath} must be an absolute directory path`);
  }
  let resolved: string;
  try {
    resolved = await realpath(trimmed);
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new SessionGroupCloneValidationError('invalid_cwd', `${fieldPath} is not a directory`);
    }
  } catch (err) {
    if (err instanceof SessionGroupCloneValidationError) throw err;
    throw new SessionGroupCloneValidationError('invalid_cwd', `${fieldPath} is not usable on the daemon host`);
  }
  return resolved;
}

async function resolveCloneableSubSessionCwd(
  child: SessionRecord,
  cwdOverride: string | null,
): Promise<string> {
  if (cwdOverride) return cwdOverride;

  const persistedCwd = child.projectDir?.trim();
  if (persistedCwd) return resolveUsableDirectory(persistedCwd, `${child.name}.cwd`);

  if (getSessionRuntimeType(child.agentType) !== 'process') {
    throw new SessionGroupCloneValidationError('incomplete_clone_spec', `Active sub-session ${child.name} is missing cwd`);
  }

  let paneCwd = '';
  try {
    paneCwd = (await getPaneCwd(child.name)).trim();
  } catch {
    throw new SessionGroupCloneValidationError('incomplete_clone_spec', `Active sub-session ${child.name} is missing cwd`);
  }
  if (!paneCwd) {
    throw new SessionGroupCloneValidationError('incomplete_clone_spec', `Active sub-session ${child.name} is missing cwd`);
  }
  return resolveUsableDirectory(paneCwd, `${child.name}.cwd`);
}

function isActiveDirectChild(record: SessionRecord, sourceMainSessionName: string): boolean {
  return record.parentSession === sourceMainSessionName
    && !isHiddenSession(record)
    && (record.state === 'running' || record.state === 'idle');
}

function skippedMembersForVisibleNonCandidates(sourceMainSessionName: string): SessionGroupCloneSkippedMember[] {
  const skipped: SessionGroupCloneSkippedMember[] = [];
  const records = listSessions();
  const byName = new Map(records.map((record) => [record.name, record]));
  const directChildNames = new Set(records.filter((record) => record.parentSession === sourceMainSessionName).map((record) => record.name));

  for (const record of records) {
    if (record.parentSession === sourceMainSessionName && isHiddenSession(record)) {
      skipped.push({ sessionName: record.name, reason: 'hidden' });
      continue;
    }
    if (record.parentSession === sourceMainSessionName && record.state !== 'running' && record.state !== 'idle') {
      skipped.push({
        sessionName: record.name,
        reason: skippedReasonForState(record.state),
      });
      continue;
    }
    let parentName = record.parentSession;
    const seen = new Set<string>();
    if (parentName && parentName !== sourceMainSessionName && !byName.has(parentName)) {
      skipped.push({ sessionName: record.name, reason: 'server_only_orphan' });
      continue;
    }
    while (parentName && !seen.has(parentName)) {
      if (directChildNames.has(parentName)) {
        skipped.push({ sessionName: record.name, reason: 'nested' });
        break;
      }
      if (parentName === sourceMainSessionName) break;
      seen.add(parentName);
      parentName = byName.get(parentName)?.parentSession;
    }
  }
  return skipped;
}

function assertCloneableAgent(record: SessionRecord): void {
  if (!isSessionAgentType(record.agentType)) {
    throw new SessionGroupCloneValidationError('unsupported_session_type', `Unsupported session type for ${record.name}`);
  }
}

function buildSessionNameMap(
  sourceMainSessionName: string,
  targetMainSessionName: string,
  subSessions: CloneableSubSessionSpec[],
): Record<string, string> {
  return {
    [sourceMainSessionName]: targetMainSessionName,
    ...Object.fromEntries(subSessions.map((sub) => [sub.sourceSessionName, sub.clonedSessionName])),
  };
}

function newSubSessionId(existingNames: Set<string>): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    if (!existingNames.has(`deck_sub_${id}`)) return id;
  }
  throw new SessionGroupCloneValidationError('name_taken', 'Unable to allocate cloned sub-session id');
}

async function buildCloneSpec(
  cmd: SessionGroupCloneRequest,
  operation: CloneOperationSnapshot,
): Promise<CloneableSessionGroupSpec> {
  transitionNoSend(operation, 'validating');
  const source = getSession(cmd.sourceMainSessionName);
  if (!source) throw new SessionGroupCloneValidationError('source_not_found', 'Source main session not found');
  if (!isRoleCompatibleMainSession(source)) {
    throw new SessionGroupCloneValidationError('source_not_role_compatible', 'Source session is not a role-compatible main session');
  }
  assertCloneableAgent(source);

  const currentNames = new Set(listSessions().map((session) => session.name));
  for (const name of cmd.unavailableSessionNames ?? []) {
    if (typeof name === 'string' && name.trim()) currentNames.add(name.trim());
  }
  const rawTargetProjectName = cmd.targetProjectName == null
    ? defaultCloneTargetProjectName(source.projectName, (name) => !currentNames.has(name) && !activeTargetReservations.has(name))
    : cmd.targetProjectName;
  const target = resolveCloneTargetProject(rawTargetProjectName);
  if (currentNames.has(target.targetMainSessionName) || activeTargetReservations.has(target.targetMainSessionName)) {
    throw new SessionGroupCloneValidationError('name_taken', 'Target main session name is already in use');
  }
  activeTargetReservations.add(target.targetMainSessionName);
  operation.reservedTargetName = target.targetMainSessionName;

  const gitRemoteUrl = normalizeOptionalGitRemoteUrl(cmd.gitRemoteUrl);
  if (gitRemoteUrl && !cmd.cwdOverride?.trim()) {
    throw new SessionGroupCloneValidationError('invalid_cwd', 'gitRemoteUrl requires cwdOverride');
  }
  const cwdOverride = cmd.cwdOverride?.trim()
    ? gitRemoteUrl
      ? await cloneGitRemoteToDirectory({ gitRemoteUrl, targetDir: cmd.cwdOverride.trim() })
      : await resolveUsableDirectory(cmd.cwdOverride, 'cwdOverride')
    : null;
  const mainProjectDir = cwdOverride ?? await resolveUsableDirectory(source.projectDir, `${source.name}.projectDir`);
  assertNotCancelled(operation);

  const activeDirectChildren = listSessions().filter((record) => isActiveDirectChild(record, source.name));
  const existingNamesWithAllocated = new Set(currentNames);
  const subSessions: CloneableSubSessionSpec[] = [];
  const skippedMembers = skippedMembersForVisibleNonCandidates(source.name);
  const warnings: SessionGroupCloneWarning[] = [];

  if (source.state === 'running') {
    warnings.push({ code: 'running_source_excluded_state', sourceSessionName: source.name });
  }

  for (const child of activeDirectChildren) {
    assertCloneableAgent(child);
    const cwd = await resolveCloneableSubSessionCwd(child, cwdOverride);
    const clonedId = newSubSessionId(existingNamesWithAllocated);
    const clonedSessionName = `deck_sub_${clonedId}`;
    existingNamesWithAllocated.add(clonedSessionName);
    subSessions.push({
      sourceSessionName: child.name,
      sourceId: child.name.replace(/^deck_sub_/, ''),
      clonedId,
      clonedSessionName,
      agentType: child.agentType,
      runtimeType: child.runtimeType ?? null,
      providerId: child.providerId ?? null,
      cwd,
      label: child.label ?? null,
      description: child.description ?? null,
      requestedModel: child.requestedModel ?? null,
      activeModel: child.activeModel ?? null,
      qwenModel: child.qwenModel ?? null,
      effort: child.effort ?? null,
      ccPreset: child.ccPreset ?? null,
      presetContextWindow: child.presetContextWindow ?? null,
      transportConfig: cloneTransportConfigWithoutRuntimeIdentity(child.transportConfig),
      shellBin: child.agentType === 'shell' || child.agentType === 'script'
        ? ((child as unknown as { shellBin?: string | null }).shellBin ?? null)
        : null,
      sortOrder: null,
    });
    if (child.state === 'running') {
      warnings.push({ code: 'running_source_excluded_state', sourceSessionName: child.name });
    }
  }

  const main: CloneableMainSessionSpec = {
    sourceSessionName: source.name,
    sourceProjectName: source.projectName,
    targetProjectName: target.rawTargetProjectName,
    targetProjectSlug: target.targetProjectSlug,
    targetMainSessionName: target.targetMainSessionName,
    agentType: source.agentType,
    runtimeType: source.runtimeType ?? null,
    providerId: source.providerId ?? null,
    projectDir: mainProjectDir,
    label: target.rawTargetProjectName,
    description: source.description ?? null,
    requestedModel: source.requestedModel ?? null,
    activeModel: source.activeModel ?? null,
    qwenModel: source.qwenModel ?? null,
    effort: source.effort ?? null,
    ccPreset: source.ccPreset ?? null,
    presetContextWindow: source.presetContextWindow ?? null,
    transportConfig: cloneTransportConfigWithoutRuntimeIdentity(source.transportConfig),
    shellBin: source.agentType === 'shell' || source.agentType === 'script'
      ? ((source as unknown as { shellBin?: string | null }).shellBin ?? null)
      : null,
  };

  return {
    operationId: operation.operationId,
    idempotencyKey: operation.idempotencyKey,
    main,
    subSessions,
    skippedMembers,
    warnings,
    sessionNameMap: buildSessionNameMap(source.name, target.targetMainSessionName, subSessions),
  };
}

function transitionNoSend(operation: CloneOperationSnapshot, state: SessionGroupCloneState): void {
  operation.state = state;
  operation.updatedAt = Date.now();
}

async function copyDaemonLocalP2pConfig(
  serverLink: ServerLink,
  spec: CloneableSessionGroupSpec,
  resources: CreatedResources,
): Promise<SessionGroupCloneWarning[]> {
  const sourceSessionCandidates = [
    spec.main.sourceSessionName,
    ...spec.subSessions.map((sub) => sub.sourceSessionName),
    ...spec.skippedMembers.map((member) => member.sessionName),
  ];
  const targetScope = getP2pConfigStoreScope(serverLink, spec.main.targetMainSessionName);
  let sourceConfig: import('../../shared/p2p-modes.js').P2pSavedConfig | undefined;
  for (const sourceSessionName of sourceSessionCandidates) {
    const sourceScope = getP2pConfigStoreScope(serverLink, sourceSessionName);
    sourceConfig = await getSavedP2pConfig(sourceScope)
      ?? (sourceScope === sourceSessionName ? undefined : await getSavedP2pConfig(sourceSessionName));
    if (sourceConfig) break;
  }
  if (!sourceConfig) return [{ code: 'p2p_config_missing' }];
  const remapped = cloneP2pConfigWithSessionRemap(sourceConfig, spec.sessionNameMap, Date.now(), {
    sourceGroupSessionNames: [
      spec.main.sourceSessionName,
      ...spec.subSessions.map((sub) => sub.sourceSessionName),
      ...spec.skippedMembers.map((member) => member.sessionName),
    ],
  });
  resources.targetP2pScope = targetScope;
  resources.targetP2pBackup = await getSavedP2pConfig(targetScope);
  await upsertSavedP2pConfig(targetScope, remapped.config);
  return remapped.warnings;
}

function assertAgentType(agentType: string): asserts agentType is import('../agent/detect.js').AgentType {
  if (!isSessionAgentType(agentType)) {
    throw new SessionGroupCloneValidationError('unsupported_session_type', `Unsupported session type ${agentType}`);
  }
}

async function launchCloneMembers(
  serverLink: ServerLink,
  operation: CloneOperationSnapshot,
  spec: CloneableSessionGroupSpec,
  resources: CreatedResources,
): Promise<void> {
  transition(serverLink, operation, 'reserving', {
    clonedMainSessionName: spec.main.targetMainSessionName,
    totalSubSessions: spec.subSessions.length,
    subSessionsCreated: 0,
    skippedMembers: spec.skippedMembers,
    warnings: spec.warnings,
  });
  resources.targetProjectSlug = spec.main.targetProjectSlug;
  resources.reservedMainSessionName = spec.main.targetMainSessionName;
  assertNotCancelled(operation);
  const recordsToPersist: SessionRecord[] = [];

  assertAgentType(spec.main.agentType);
  transition(serverLink, operation, 'creating_main', {
    clonedMainSessionName: spec.main.targetMainSessionName,
    totalSubSessions: spec.subSessions.length,
    subSessionsCreated: 0,
  });
  await launchSession({
    name: spec.main.targetMainSessionName,
    projectName: spec.main.targetProjectSlug,
    role: 'brain',
    agentType: spec.main.agentType,
    projectDir: spec.main.projectDir,
    fresh: true,
    userCreated: true,
    label: spec.main.label ?? undefined,
    description: spec.main.description ?? undefined,
    requestedModel: spec.main.requestedModel ?? spec.main.activeModel ?? spec.main.qwenModel ?? undefined,
    qwenModel: spec.main.qwenModel ?? undefined,
    effort: spec.main.effort as TransportEffortLevel | undefined,
    transportConfig: spec.main.transportConfig ?? undefined,
    ccPreset: spec.main.ccPreset ?? undefined,
  });
  resources.clonedMainSessionName = spec.main.targetMainSessionName;
  const clonedMainRecord = patchClonedMainRecord(spec.main);
  recordsToPersist.push(clonedMainRecord);
  pushProviderSessionResource(resources, clonedMainRecord);
  assertNotCancelled(operation);

  transition(serverLink, operation, 'creating_subs', {
    clonedMainSessionName: spec.main.targetMainSessionName,
    totalSubSessions: spec.subSessions.length,
    subSessionsCreated: 0,
  });
  let subSessionsCreated = 0;
  for (const sub of spec.subSessions) {
    assertNotCancelled(operation);
    assertAgentType(sub.agentType);
    await startSubSession({
      id: sub.clonedId,
      type: sub.agentType,
      cwd: sub.cwd,
      label: sub.label ?? undefined,
      description: sub.description ?? undefined,
      requestedModel: sub.requestedModel ?? sub.activeModel ?? sub.qwenModel ?? undefined,
      transportConfig: sub.transportConfig ?? undefined,
      ccPreset: sub.ccPreset ?? undefined,
      effort: sub.effort as TransportEffortLevel | undefined,
      shellBin: sub.shellBin ?? undefined,
      fresh: true,
      parentSession: spec.main.targetMainSessionName,
    });
    resources.clonedSubSessionNames.push(sub.clonedSessionName);
    const clonedSubRecord = patchClonedSubSessionRecord(sub, spec.main.targetMainSessionName);
    recordsToPersist.push(clonedSubRecord);
    pushProviderSessionResource(resources, clonedSubRecord);
    await sendSubSessionSync(serverLink, sub.clonedId, clonedSubRecord);
    subSessionsCreated += 1;
    transition(serverLink, operation, 'creating_subs', {
      clonedMainSessionName: spec.main.targetMainSessionName,
      totalSubSessions: spec.subSessions.length,
      subSessionsCreated,
    });
  }
  assertNotCancelled(operation);

  transition(serverLink, operation, 'writing_db', {
    clonedMainSessionName: spec.main.targetMainSessionName,
    totalSubSessions: spec.subSessions.length,
    subSessionsCreated,
  });
  for (const record of recordsToPersist) {
    try {
      await persistSessionRecordAwaited(record, record.name);
      resources.persistedSessionNames.push(record.name);
    } catch (err) {
      throw new SessionGroupCloneValidationError(
        serverCommitErrorCode(err),
        err instanceof Error ? err.message : 'Failed to persist cloned session',
      );
    }
  }
  assertNotCancelled(operation);

  transition(serverLink, operation, 'provider_create', {
    clonedMainSessionName: spec.main.targetMainSessionName,
    totalSubSessions: spec.subSessions.length,
    subSessionsCreated,
  });
  for (const record of recordsToPersist) {
    pushProviderSessionResource(resources, record);
  }
  assertNotCancelled(operation);

  transition(serverLink, operation, 'writing_pref', {
    clonedMainSessionName: spec.main.targetMainSessionName,
    totalSubSessions: spec.subSessions.length,
    subSessionsCreated,
  });
  const p2pWarnings = await copyDaemonLocalP2pConfig(serverLink, spec, resources);
  resources.wroteDaemonP2pConfig = true;
  spec.warnings.push(...p2pWarnings);
  assertNotCancelled(operation);
}

function patchClonedMainRecord(spec: CloneableMainSessionSpec): SessionRecord {
  const created = getSession(spec.targetMainSessionName);
  if (!created) {
    throw new SessionGroupCloneValidationError('persist_failed', `Cloned main session ${spec.targetMainSessionName} was not persisted`);
  }
  const patched: SessionRecord = {
    ...created,
    projectName: spec.targetProjectSlug,
    role: 'brain',
    agentType: spec.agentType,
    projectDir: spec.projectDir,
    runtimeType: spec.runtimeType ?? created.runtimeType,
    providerId: created.providerId ?? spec.providerId ?? undefined,
    label: spec.label ?? undefined,
    description: spec.description ?? undefined,
    requestedModel: spec.requestedModel ?? created.requestedModel,
    activeModel: spec.activeModel ?? created.activeModel,
    qwenModel: spec.qwenModel ?? created.qwenModel,
    effort: (spec.effort as SessionRecord['effort'] | null) ?? created.effort,
    transportConfig: spec.transportConfig ?? undefined,
    ccPreset: spec.ccPreset ?? undefined,
    presetContextWindow: spec.presetContextWindow ?? created.presetContextWindow,
    parentSession: undefined,
    userCreated: true,
    updatedAt: Date.now(),
  };
  upsertSession(patched);
  persistSessionRecord(patched, patched.name);
  return patched;
}

function patchClonedSubSessionRecord(spec: CloneableSubSessionSpec, parentSession: string): SessionRecord {
  const created = getSession(spec.clonedSessionName);
  if (!created) {
    throw new SessionGroupCloneValidationError('persist_failed', `Cloned sub-session ${spec.clonedSessionName} was not persisted`);
  }
  const patched: SessionRecord = {
    ...created,
    projectName: spec.clonedSessionName,
    role: 'w1',
    agentType: spec.agentType,
    projectDir: spec.cwd,
    runtimeType: spec.runtimeType ?? created.runtimeType,
    providerId: created.providerId ?? spec.providerId ?? undefined,
    label: spec.label ?? undefined,
    description: spec.description ?? undefined,
    requestedModel: spec.requestedModel ?? created.requestedModel,
    activeModel: spec.activeModel ?? created.activeModel,
    qwenModel: spec.qwenModel ?? created.qwenModel,
    effort: (spec.effort as SessionRecord['effort'] | null) ?? created.effort,
    transportConfig: spec.transportConfig ?? undefined,
    ccPreset: spec.ccPreset ?? undefined,
    presetContextWindow: spec.presetContextWindow ?? created.presetContextWindow,
    parentSession,
    userCreated: true,
    updatedAt: Date.now(),
  };
  upsertSession(patched);
  persistSessionRecord(patched, patched.name);
  return patched;
}

async function rollbackClone(serverLink: ServerLink, resources: CreatedResources): Promise<boolean> {
  let cleanupOk = true;
  for (const sessionName of [...resources.clonedSubSessionNames].reverse()) {
    try {
      await stopSubSession(sessionName, serverLink);
    } catch (err) {
      cleanupOk = false;
      pushCleanupResource(resources, { kind: 'daemon_session', id: sessionName, sessionName, retriable: true });
      const provider = resources.providerSessions.find((resource) => resource.sessionName === sessionName);
      if (provider) pushCleanupResource(resources, provider);
      logger.warn({ err, sessionName }, 'session-group clone rollback failed for sub-session');
    }
    try {
      removeSession(sessionName);
      await persistSessionRecordAwaited(null, sessionName);
    } catch (err) {
      cleanupOk = false;
      pushCleanupResource(resources, { kind: 'server_db_session', id: sessionName, sessionName, serverId: serverLink.getServerId?.(), retriable: true });
      logger.warn({ err, sessionName }, 'session-group clone rollback failed for persisted sub-session record');
    }
  }
  if (resources.targetProjectSlug) {
    try {
      const result = await stopProject(resources.targetProjectSlug, serverLink);
      if (!result.ok) {
        cleanupOk = false;
        for (const failure of result.failed) {
          pushCleanupResource(resources, { kind: 'daemon_session', id: failure.sessionName, sessionName: failure.sessionName, retriable: true });
          const provider = resources.providerSessions.find((resource) => resource.sessionName === failure.sessionName);
          if (provider) pushCleanupResource(resources, provider);
        }
      }
    } catch (err) {
      cleanupOk = false;
      if (resources.clonedMainSessionName) {
        pushCleanupResource(resources, {
          kind: 'daemon_session',
          id: resources.clonedMainSessionName,
          sessionName: resources.clonedMainSessionName,
          retriable: true,
        });
        const provider = resources.providerSessions.find((resource) => resource.sessionName === resources.clonedMainSessionName);
        if (provider) pushCleanupResource(resources, provider);
      }
      logger.warn({ err, project: resources.targetProjectSlug }, 'session-group clone rollback failed for main project');
    }
    if (resources.clonedMainSessionName) {
      try {
        removeSession(resources.clonedMainSessionName);
        await persistSessionRecordAwaited(null, resources.clonedMainSessionName);
      } catch (err) {
        cleanupOk = false;
        pushCleanupResource(resources, {
          kind: 'server_db_session',
          id: resources.clonedMainSessionName,
          sessionName: resources.clonedMainSessionName,
          serverId: serverLink.getServerId?.(),
          retriable: true,
        });
        logger.warn({ err, sessionName: resources.clonedMainSessionName }, 'session-group clone rollback failed for persisted main session record');
      }
    }
  }
  if (resources.wroteDaemonP2pConfig && resources.clonedMainSessionName) {
    try {
      if (resources.targetP2pScope && resources.targetP2pBackup) {
        await upsertSavedP2pConfig(resources.targetP2pScope, resources.targetP2pBackup);
      } else {
        await removeSavedP2pConfig(resources.targetP2pScope ?? getP2pConfigStoreScope(serverLink, resources.clonedMainSessionName));
      }
    } catch (err) {
      cleanupOk = false;
      pushCleanupResource(resources, {
        kind: 'daemon_p2p_scope',
        id: resources.targetP2pScope ?? getP2pConfigStoreScope(serverLink, resources.clonedMainSessionName),
        sessionName: resources.clonedMainSessionName,
        retriable: true,
      });
      logger.warn({ err, sessionName: resources.clonedMainSessionName }, 'session-group clone rollback failed for p2p config');
    }
  }
  return cleanupOk;
}

function errorCodeFromUnknown(err: unknown): SessionGroupCloneErrorCode {
  if (err instanceof GitRemoteCloneError) return err.code;
  if (err instanceof SessionGroupCloneValidationError) return err.code;
  return 'internal_error';
}

function serverCommitErrorCode(err: unknown): SessionGroupCloneErrorCode {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b409\b/i.test(message) || /unique|conflict|duplicate/i.test(message)) return 'name_taken';
  return 'server_commit_failed';
}

export async function handleSessionGroupCloneCommand(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  pruneOperations();
  const request: SessionGroupCloneRequest = {
    type: SESSION_GROUP_CLONE_MSG.START,
    sourceMainSessionName: typeof cmd.sourceMainSessionName === 'string'
      ? cmd.sourceMainSessionName
      : (typeof cmd.sourceSessionName === 'string' ? cmd.sourceSessionName : ''),
    idempotencyKey: typeof cmd.idempotencyKey === 'string' ? cmd.idempotencyKey : '',
    targetProjectName: typeof cmd.targetProjectName === 'string' || cmd.targetProjectName === null
      ? cmd.targetProjectName
      : undefined,
    cwdOverride: typeof cmd.cwdOverride === 'string' || cmd.cwdOverride === null
      ? cmd.cwdOverride
      : undefined,
    gitRemoteUrl: typeof cmd.gitRemoteUrl === 'string' || cmd.gitRemoteUrl === null
      ? cmd.gitRemoteUrl
      : undefined,
    unavailableSessionNames: Array.isArray(cmd.unavailableSessionNames)
      ? cmd.unavailableSessionNames.filter((name): name is string => typeof name === 'string')
      : undefined,
    serverId: typeof cmd.serverId === 'string' ? cmd.serverId : undefined,
  };
  const fingerprint = requestFingerprint(request);
  if (!request.sourceMainSessionName || !request.idempotencyKey) {
    const operation: CloneOperationSnapshot = {
      operationId: randomUUID(),
      idempotencyKey: request.idempotencyKey || 'missing',
      sourceMainSessionName: request.sourceMainSessionName || 'missing',
      requestFingerprint: fingerprint,
      state: 'failed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorCode: 'invalid_request',
    };
    sendCloneEvent(serverLink, operation, { errorCode: 'invalid_request' });
    return;
  }

  const existing = operationsByIdempotencyKey.get(request.idempotencyKey);
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      const conflict: CloneOperationSnapshot = {
        ...existing,
        state: 'failed',
        errorCode: 'idempotency_conflict',
        updatedAt: Date.now(),
      };
      sendCloneEvent(serverLink, conflict, { errorCode: 'idempotency_conflict' });
      return;
    }
    sendCloneEvent(serverLink, existing, {
      ...(existing.result ? { result: existing.result } : {}),
      ...(existing.errorCode ? { errorCode: existing.errorCode } : {}),
      ...(existing.cleanupResources?.length ? { cleanupResources: existing.cleanupResources, cleanupRequired: existing.state === 'cleanup_required' } : {}),
    });
    return;
  }

  const operation: CloneOperationSnapshot = {
    operationId: randomUUID(),
    idempotencyKey: request.idempotencyKey,
    sourceMainSessionName: request.sourceMainSessionName,
    requestFingerprint: fingerprint,
    state: 'validating',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  operationsByIdempotencyKey.set(request.idempotencyKey, operation);
  const resources: CreatedResources = {
    clonedSubSessionNames: [],
    persistedSessionNames: [],
    providerSessions: [],
    cleanupResources: [],
  };

  try {
    sendCloneEvent(serverLink, operation);
    const spec = await buildCloneSpec(request, operation);
    assertNotCancelled(operation);
    await launchCloneMembers(serverLink, operation, spec, resources);
    assertNotCancelled(operation);
    transition(serverLink, operation, 'committing', {
      clonedMainSessionName: spec.main.targetMainSessionName,
      totalSubSessions: spec.subSessions.length,
      subSessionsCreated: spec.subSessions.length,
      skippedMembers: spec.skippedMembers,
      warnings: spec.warnings,
    });

    const result: SessionGroupCloneResult = {
      operationId: operation.operationId,
      idempotencyKey: operation.idempotencyKey,
      sourceMainSession: spec.main.sourceSessionName,
      clonedMainSession: spec.main.targetMainSessionName,
      targetProjectName: spec.main.targetProjectName,
      targetProjectSlug: spec.main.targetProjectSlug,
      sessionNameMap: spec.sessionNameMap,
      copiedSubSessionIds: spec.subSessions.map((sub) => ({ sourceId: sub.sourceId, clonedId: sub.clonedId })),
      skippedMembers: spec.skippedMembers,
      skippedCronJobs: 0,
      skippedOrchestrationRuns: 0,
      warnings: spec.warnings,
    };
    operation.result = result;
    transition(serverLink, operation, 'succeeded', {
      clonedMainSessionName: spec.main.targetMainSessionName,
      totalSubSessions: spec.subSessions.length,
      subSessionsCreated: spec.subSessions.length,
      skippedMembers: spec.skippedMembers,
      skippedCronJobs: 0,
      skippedOrchestrationRuns: 0,
      warnings: spec.warnings,
      result,
    });
  } catch (err) {
    const errorCode = cancelledOperationIds.has(operation.operationId) ? 'cancelled' : errorCodeFromUnknown(err);
    operation.errorCode = errorCode;
    logger.warn({ err, operationId: operation.operationId, sourceMainSessionName: request.sourceMainSessionName }, 'session-group clone failed');
    const createdAny = !!resources.clonedMainSessionName || resources.clonedSubSessionNames.length > 0 || resources.wroteDaemonP2pConfig;
    if (createdAny) {
      transition(serverLink, operation, 'rolling_back', { errorCode });
      const cleanupOk = await rollbackClone(serverLink, resources);
      operation.cleanupResources = resources.cleanupResources;
      transition(serverLink, operation, cleanupOk ? (errorCode === 'cancelled' ? 'cancelled' : 'failed') : 'cleanup_required', {
        errorCode: cleanupOk ? errorCode : 'cleanup_required',
        cleanupRequired: !cleanupOk,
        cleanupResources: resources.cleanupResources,
      });
    } else {
      transition(serverLink, operation, errorCode === 'cancelled' ? 'cancelled' : 'failed', { errorCode });
    }
  } finally {
    if (resources.reservedMainSessionName) activeTargetReservations.delete(resources.reservedMainSessionName);
    if (operation.reservedTargetName) activeTargetReservations.delete(operation.reservedTargetName);
    cancelledOperationIds.delete(operation.operationId);
  }
}

export function handleSessionGroupCloneCancel(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const idempotencyKey = typeof cmd.idempotencyKey === 'string' ? cmd.idempotencyKey : '';
  const operationId = typeof cmd.operationId === 'string' ? cmd.operationId : '';
  const operation = idempotencyKey
    ? operationsByIdempotencyKey.get(idempotencyKey)
    : [...operationsByIdempotencyKey.values()].find((candidate) => candidate.operationId === operationId);
  if (!operation) {
    const missing: CloneOperationSnapshot = {
      operationId: operationId || randomUUID(),
      idempotencyKey: idempotencyKey || 'missing',
      sourceMainSessionName: 'unknown',
      requestFingerprint: '',
      state: 'failed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorCode: 'invalid_request',
    };
    sendCloneEvent(serverLink, missing, { errorCode: 'invalid_request' });
    return;
  }
  if (['succeeded', 'failed', 'cancelled', 'cleanup_required'].includes(operation.state)) {
    sendCloneEvent(serverLink, operation, {
      ...(operation.result ? { result: operation.result } : {}),
      ...(operation.errorCode ? { errorCode: operation.errorCode } : {}),
      ...(operation.cleanupResources?.length ? { cleanupResources: operation.cleanupResources, cleanupRequired: operation.state === 'cleanup_required' } : {}),
    });
    return;
  }
  operation.errorCode = 'cancelled';
  cancelledOperationIds.add(operation.operationId);
  transition(serverLink, operation, 'rolling_back', { errorCode: 'cancelled' });
}
