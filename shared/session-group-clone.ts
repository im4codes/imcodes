import { sanitizeProjectName } from './sanitize-project-name.js';
import type { P2pContextReducerConfig } from './p2p-advanced.js';
import type { P2pSavedConfig } from './p2p-modes.js';

export const SESSION_GROUP_CLONE_CAPABILITY_V1 = 'session-group-clone:v1' as const;

export const SESSION_GROUP_CLONE_MSG = {
  START: 'session.group_clone',
  EVENT: 'session.group_clone.event',
  CANCEL: 'session.group_clone.cancel',
} as const;

export type SessionGroupCloneMsgType =
  typeof SESSION_GROUP_CLONE_MSG[keyof typeof SESSION_GROUP_CLONE_MSG];

export const SESSION_GROUP_CLONE_STATES = [
  'validating',
  'reserving',
  'creating_main',
  'creating_subs',
  'writing_db',
  'provider_create',
  'writing_pref',
  'committing',
  'rolling_back',
  'succeeded',
  'failed',
  'cancelled',
  'cleanup_required',
] as const;

export type SessionGroupCloneState = typeof SESSION_GROUP_CLONE_STATES[number];

export type SessionGroupCloneErrorCode =
  | 'invalid_request'
  | 'forbidden'
  | 'unsupported_command'
  | 'source_not_found'
  | 'source_not_role_compatible'
  | 'blank_target_project'
  | 'name_taken'
  | 'invalid_cwd'
  | 'incomplete_clone_spec'
  | 'unsupported_session_type'
  | 'p2p_config_invalid'
  | 'persist_failed'
  | 'idempotency_conflict'
  | 'server_commit_failed'
  | 'server_p2p_commit_failed'
  | 'cancelled'
  | 'cleanup_required'
  | 'internal_error';

export type SessionGroupCloneWarningCode =
  | 'running_source_excluded_state'
  | 'p2p_prompt_session_reference'
  | 'p2p_skipped_participant_dropped'
  | 'skipped_member'
  | 'scheduled_work_skipped'
  | 'p2p_config_missing'
  | 'rollback_partial';

export interface SessionGroupCloneWarning {
  code: SessionGroupCloneWarningCode;
  fieldPath?: string;
  sourceSessionName?: string;
  message?: string;
}

export interface SessionGroupCloneSkippedMember {
  sessionName: string;
  reason:
    | 'stopped'
    | 'error'
    | 'closed'
    | 'hidden'
    | 'nested'
    | 'server_only_orphan'
    | 'unsupported'
    | 'incomplete_spec';
}

export interface SessionGroupCloneCleanupResource {
  kind:
    | 'daemon_session'
    | 'daemon_p2p_scope'
    | 'server_db_session'
    | 'server_p2p_pref'
    | 'provider_session';
  id: string;
  sessionName?: string;
  serverId?: string;
  providerId?: string;
  retriable?: boolean;
}

export interface SessionGroupCloneRequest {
  type: typeof SESSION_GROUP_CLONE_MSG.START;
  serverId?: string;
  sourceMainSessionName: string;
  idempotencyKey: string;
  targetProjectName?: string | null;
  cwdOverride?: string | null;
  /** Server-supplied, internal-only names unavailable for target allocation. */
  unavailableSessionNames?: string[];
}

export interface SessionGroupCloneCancelRequest {
  type: typeof SESSION_GROUP_CLONE_MSG.CANCEL;
  serverId?: string;
  operationId?: string | null;
  idempotencyKey?: string | null;
}

export interface SessionGroupCloneOptions {
  idempotencyKey: string;
  targetProjectName?: string | null;
  cwdOverride?: string | null;
}

export interface CloneableMainSessionSpec {
  sourceSessionName: string;
  sourceProjectName: string;
  targetProjectName: string;
  targetProjectSlug: string;
  targetMainSessionName: string;
  agentType: string;
  runtimeType?: 'process' | 'transport' | null;
  providerId?: string | null;
  projectDir: string;
  label?: string | null;
  description?: string | null;
  requestedModel?: string | null;
  activeModel?: string | null;
  qwenModel?: string | null;
  effort?: string | null;
  ccPreset?: string | null;
  presetContextWindow?: number | null;
  transportConfig?: Record<string, unknown> | null;
  shellBin?: string | null;
}

export interface CloneableSubSessionSpec {
  sourceSessionName: string;
  sourceId: string;
  clonedId: string;
  clonedSessionName: string;
  agentType: string;
  runtimeType?: 'process' | 'transport' | null;
  providerId?: string | null;
  cwd: string;
  label?: string | null;
  description?: string | null;
  requestedModel?: string | null;
  activeModel?: string | null;
  qwenModel?: string | null;
  effort?: string | null;
  ccPreset?: string | null;
  presetContextWindow?: number | null;
  transportConfig?: Record<string, unknown> | null;
  shellBin?: string | null;
  sortOrder?: number | null;
}

export interface CloneableSessionGroupSpec {
  operationId: string;
  idempotencyKey: string;
  main: CloneableMainSessionSpec;
  subSessions: CloneableSubSessionSpec[];
  skippedMembers: SessionGroupCloneSkippedMember[];
  warnings: SessionGroupCloneWarning[];
  sessionNameMap: Record<string, string>;
}

export interface SessionGroupCloneResult {
  operationId: string;
  idempotencyKey: string;
  sourceMainSession: string;
  clonedMainSession: string;
  targetProjectName: string;
  targetProjectSlug: string;
  sessionNameMap: Record<string, string>;
  copiedSubSessionIds: Array<{ sourceId: string; clonedId: string }>;
  skippedMembers: SessionGroupCloneSkippedMember[];
  skippedCronJobs: number;
  skippedOrchestrationRuns: number;
  warnings: SessionGroupCloneWarning[];
}

export interface SessionGroupCloneEvent {
  type: typeof SESSION_GROUP_CLONE_MSG.EVENT;
  operationId: string;
  idempotencyKey: string;
  state: SessionGroupCloneState;
  sourceMainSessionName?: string;
  clonedMainSessionName?: string;
  totalSubSessions?: number;
  subSessionsCreated?: number;
  skippedMembers?: SessionGroupCloneSkippedMember[];
  skippedCronJobs?: number;
  skippedOrchestrationRuns?: number;
  warnings?: SessionGroupCloneWarning[];
  errorCode?: SessionGroupCloneErrorCode;
  cleanupRequired?: boolean;
  cleanupResources?: SessionGroupCloneCleanupResource[];
  result?: SessionGroupCloneResult;
}

export interface RoleCompatibleMainSessionInput {
  name: string;
  projectName: string;
  role: string;
}

export interface TargetProjectResolution {
  rawTargetProjectName: string;
  targetProjectSlug: string;
  targetMainSessionName: string;
}

export function mainSessionNameForProjectSlug(projectSlug: string): string {
  return `deck_${projectSlug}_brain`;
}

export function isRoleCompatibleMainSession(record: RoleCompatibleMainSessionInput): boolean {
  return record.role === 'brain'
    && !record.name.startsWith('deck_sub_')
    && record.name === mainSessionNameForProjectSlug(record.projectName);
}

export function resolveCloneTargetProject(rawTargetProjectName: string | null | undefined): TargetProjectResolution {
  const trimmed = rawTargetProjectName?.trim() ?? '';
  if (!trimmed) {
    throw new SessionGroupCloneValidationError('blank_target_project', 'Target project name is required');
  }
  const targetProjectSlug = sanitizeProjectName(trimmed);
  return {
    rawTargetProjectName: trimmed,
    targetProjectSlug,
    targetMainSessionName: mainSessionNameForProjectSlug(targetProjectSlug),
  };
}

export function defaultCloneTargetProjectName(
  sourceProjectName: string,
  isSessionNameAvailable: (sessionName: string) => boolean,
): string {
  let suffix = 1;
  while (suffix < 10_000) {
    const candidate = `${sourceProjectName}_${suffix}`;
    if (isSessionNameAvailable(mainSessionNameForProjectSlug(sanitizeProjectName(candidate)))) {
      return candidate;
    }
    suffix += 1;
  }
  throw new SessionGroupCloneValidationError('name_taken', 'No available default target project name');
}

export class SessionGroupCloneValidationError extends Error {
  readonly code: SessionGroupCloneErrorCode;

  constructor(code: SessionGroupCloneErrorCode, message: string) {
    super(message);
    this.name = 'SessionGroupCloneValidationError';
    this.code = code;
  }
}

export interface P2pSessionRemapResult {
  config: P2pSavedConfig;
  warnings: SessionGroupCloneWarning[];
  remappedPaths: string[];
}

export interface P2pSessionRemapOptions {
  /**
   * Session names known to belong to the source group. Entries present in
   * config.sessions but absent from sessionNameMap are dropped with a warning
   * when they are in this set, because preserving them would point the cloned
   * group back at the source group.
   */
  sourceGroupSessionNames?: readonly string[];
}

export const P2P_SESSION_REFERENCE_REMAP_PATHS = [
  'sessions.*',
  'contextReducer.sessionName',
  'contextReducer.templateSession',
  'workflowLaunchEnvelope.launchContext.sessionName',
  'workflowLaunchEnvelope.oldAdvanced.contextReducer.sessionName',
  'workflowLaunchEnvelope.oldAdvanced.contextReducer.templateSession',
] as const;

export const P2P_SESSION_REFERENCE_PRESERVE_PATHS = [
  'workflowLaunchEnvelope.oldAdvanced.advancedRounds[*]',
  'workflowLaunchEnvelope.advancedDraft',
  'workflowDraft',
  'workflowLibrary[*]',
  'activeWorkflowId',
  'advancedRounds',
  'allowedExecutables',
  'workflowLaunchEnvelope.allowedExecutables',
  'workflowLaunchEnvelope.requiredDaemonCapabilities',
  'workflowLaunchEnvelope.legacy.*',
] as const;

export const P2P_SESSION_REFERENCE_WARNING_ONLY_PATHS = [
  'extraPrompt',
  'advancedRounds[*].promptAppend',
  'workflowDraft.nodes[*].promptAppend',
  'workflowDraft.nodes[*].summaryPromptOverride',
  'workflowLibrary[*].nodes[*].promptAppend',
  'workflowLibrary[*].nodes[*].summaryPromptOverride',
  'workflowLaunchEnvelope.advancedDraft.nodes[*].promptAppend',
  'workflowLaunchEnvelope.advancedDraft.nodes[*].summaryPromptOverride',
  'workflowLaunchEnvelope.oldAdvanced.advancedRounds[*].promptAppend',
] as const;

export const P2P_SESSION_REFERENCE_CLASSIFIED_PATHS = [
  ...P2P_SESSION_REFERENCE_REMAP_PATHS,
  ...P2P_SESSION_REFERENCE_PRESERVE_PATHS,
  ...P2P_SESSION_REFERENCE_WARNING_ONLY_PATHS,
] as const;

function clonePlain<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isContextReducerConfig(value: unknown): value is P2pContextReducerConfig {
  if (!isRecord(value)) return false;
  const mode = value.mode;
  return mode === 'reuse_existing_session' || mode === 'clone_sdk_session';
}

function remapOptionalSessionName(
  owner: Record<string, unknown>,
  key: 'sessionName' | 'templateSession',
  sessionNameMap: Record<string, string>,
  fieldPath: string,
  remappedPaths: string[],
): void {
  const value = owner[key];
  if (typeof value !== 'string') return;
  const mapped = sessionNameMap[value];
  if (!mapped) return;
  owner[key] = mapped;
  remappedPaths.push(fieldPath);
}

function scanWarningOnlyString(
  value: unknown,
  fieldPath: string,
  sourceSessionNames: readonly string[],
  warnings: SessionGroupCloneWarning[],
): void {
  if (typeof value !== 'string') return;
  for (const sourceSessionName of sourceSessionNames) {
    if (!value.includes(sourceSessionName)) continue;
    warnings.push({
      code: 'p2p_prompt_session_reference',
      fieldPath,
      sourceSessionName,
    });
  }
}

function scanWorkflowPromptWarnings(
  value: unknown,
  fieldPath: string,
  sourceSessionNames: readonly string[],
  warnings: SessionGroupCloneWarning[],
): void {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanWorkflowPromptWarnings(entry, `${fieldPath}[${index}]`, sourceSessionNames, warnings));
    return;
  }
  if (!isRecord(value)) return;
  scanWarningOnlyString(value.promptAppend, `${fieldPath}.promptAppend`, sourceSessionNames, warnings);
  scanWarningOnlyString(value.summaryPromptOverride, `${fieldPath}.summaryPromptOverride`, sourceSessionNames, warnings);
  if (Array.isArray(value.nodes)) {
    value.nodes.forEach((node, index) => scanWorkflowPromptWarnings(node, `${fieldPath}.nodes[${index}]`, sourceSessionNames, warnings));
  }
}

/**
 * Structurally copy and remap root-scoped P2P config. This intentionally
 * touches only the modeled registry paths from the OpenSpec; broad string
 * replacement would corrupt prompt text, artifact paths, and executable paths.
 */
export function cloneP2pConfigWithSessionRemap(
  sourceConfig: P2pSavedConfig,
  sessionNameMap: Record<string, string>,
  now = Date.now(),
  options: P2pSessionRemapOptions = {},
): P2pSessionRemapResult {
  const config = clonePlain(sourceConfig);
  const warnings: SessionGroupCloneWarning[] = [];
  const remappedPaths: string[] = [];
  const sourceSessionNames = [...new Set([
    ...Object.keys(sessionNameMap),
    ...(options.sourceGroupSessionNames ?? []),
  ])];
  const sourceGroupSessionNames = new Set(sourceSessionNames);

  const remappedSessions: P2pSavedConfig['sessions'] = {};
  for (const [sourceSessionName, entry] of Object.entries(config.sessions)) {
    const mapped = sessionNameMap[sourceSessionName];
    if (mapped) {
      remappedSessions[mapped] = { ...entry };
      remappedPaths.push(`sessions.${sourceSessionName}`);
      continue;
    }
    if (sourceGroupSessionNames.has(sourceSessionName)) {
      warnings.push({
        code: 'p2p_skipped_participant_dropped',
        fieldPath: `sessions.${sourceSessionName}`,
        sourceSessionName,
      });
      continue;
    }
    remappedSessions[sourceSessionName] = { ...entry };
  }
  config.sessions = remappedSessions;

  if (isRecord(config.contextReducer) && isContextReducerConfig(config.contextReducer)) {
    remapOptionalSessionName(config.contextReducer, 'sessionName', sessionNameMap, 'contextReducer.sessionName', remappedPaths);
    remapOptionalSessionName(config.contextReducer, 'templateSession', sessionNameMap, 'contextReducer.templateSession', remappedPaths);
  }

  if (isRecord(config.workflowLaunchEnvelope)) {
    const envelope = config.workflowLaunchEnvelope as Record<string, unknown>;
    if (isRecord(envelope.launchContext)) {
      remapOptionalSessionName(
        envelope.launchContext,
        'sessionName',
        sessionNameMap,
        'workflowLaunchEnvelope.launchContext.sessionName',
        remappedPaths,
      );
    }
    if (isRecord(envelope.oldAdvanced)) {
      const oldAdvanced = envelope.oldAdvanced;
      if (isContextReducerConfig(oldAdvanced.contextReducer)) {
        const reducer = oldAdvanced.contextReducer as unknown as Record<string, unknown>;
        remapOptionalSessionName(
          reducer,
          'sessionName',
          sessionNameMap,
          'workflowLaunchEnvelope.oldAdvanced.contextReducer.sessionName',
          remappedPaths,
        );
        remapOptionalSessionName(
          reducer,
          'templateSession',
          sessionNameMap,
          'workflowLaunchEnvelope.oldAdvanced.contextReducer.templateSession',
          remappedPaths,
        );
      }
      scanWorkflowPromptWarnings(oldAdvanced.advancedRounds, 'workflowLaunchEnvelope.oldAdvanced.advancedRounds', sourceSessionNames, warnings);
    }
    scanWorkflowPromptWarnings(envelope.advancedDraft, 'workflowLaunchEnvelope.advancedDraft', sourceSessionNames, warnings);
  }

  scanWarningOnlyString(config.extraPrompt, 'extraPrompt', sourceSessionNames, warnings);
  scanWorkflowPromptWarnings(config.advancedRounds, 'advancedRounds', sourceSessionNames, warnings);
  scanWorkflowPromptWarnings(config.workflowDraft, 'workflowDraft', sourceSessionNames, warnings);
  scanWorkflowPromptWarnings(config.workflowLibrary, 'workflowLibrary', sourceSessionNames, warnings);

  config.updatedAt = now;
  return { config, warnings, remappedPaths };
}
