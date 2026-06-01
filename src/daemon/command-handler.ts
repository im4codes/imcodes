/**
 * Handle commands from the web UI and inbound chat messages via ServerLink.
 * Commands arrive as JSON objects with a `type` field.
 */
import { startProject, stopProject, teardownProject, getTransportRuntime, launchTransportSession, isProviderSessionBound, persistSessionRecord, relaunchSessionWithSettings, stopTransportRuntimeSession, type ProjectConfig } from '../agent/session-manager.js';
import { isTransportAgent } from '../agent/detect.js';
import { sendKeys, sendKeysDelayedEnter, sendRawInput, resizeSession, sendKey, getPaneStartCommand } from '../agent/tmux.js';
import { listSessions, getSession, upsertSession, removeSession, type SessionRecord } from '../store/session-store.js';
import { routeMessage, type InboundMessage, type RouterContext } from '../router/message-router.js';
import { terminalStreamer, type StreamSubscriber } from './terminal-streamer.js';
import type { ServerLink } from './server-link.js';
import { timelineEmitter } from './timeline-emitter.js';
import { TimelinePreferredReadError, timelineStore } from './timeline-store.js';
import {
  recordFsWorkerMetric,
  recordTimelineBudgetShape,
  recordTransportListModelsStaleCompletion,
  traceCommandAsync,
  traceSync,
  traceWebCommandReceived,
} from './latency-tracer.js';
import { getDefaultTimelineHistoryWorkerPool, shouldUseTimelineHistoryWorkerPool, TimelineHistoryPoolError } from './timeline-history-pool.js';
import { FsListPoolError, getDefaultFsListWorkerPool, shouldUseFsListWorkerPool } from './fs-list-pool.js';
import { scanFsListSnapshot } from './fs-list-worker.js';
import { FsGitStatusPoolError, getDefaultFsGitStatusWorkerPool, shouldUseFsGitStatusWorkerPool, __resetFsGitStatusWorkerPoolForTests } from './fs-git-status-pool.js';
import { scanFsGitStatusSnapshot } from './fs-git-status-worker.js';
import { shapeTimelineDetailValueForTransport, shapeTimelineEventsForTransport } from './timeline-response-shaper.js';
import { getDefaultTimelineDetailStore } from './timeline-detail-store.js';
import { TIMELINE_HISTORY_CONTENT_TYPES, TIMELINE_HISTORY_STATE_TYPES, type MemoryContextTimelinePayload, type TimelineEvent } from '../shared/timeline/types.js';
import { emitSessionInlineError } from './session-error.js';
import { enqueueResend, getResendEntries, clearResend } from './transport-resend-queue.js';
import {
  startSubSession,
  stopSubSession,
  rebuildSubSessions,
  detectShells,
  readSubSessionResponse,
  subSessionName,
  type SubSessionRecord,
} from './subsession-manager.js';
import { sendSubSessionSync } from './subsession-sync.js';
import logger from '../util/logger.js';
import { getDefaultAckOutbox } from './ack-outbox.js';
import { COMMAND_ACK_ERROR_DUPLICATE_COMMAND_ID, MSG_COMMAND_ACK } from '../../shared/ack-protocol.js';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '../../shared/timeline-payload-budget.js';
import { hashSessionName } from '../../shared/session-hash.js';
import { TIMELINE_DETAIL_ERROR_REASONS, TIMELINE_HISTORY_ERROR_REASONS, TIMELINE_REQUEST_ERROR_REASONS, type TimelineRequestErrorReason } from '../../shared/timeline-history-errors.js';
import {
  TIMELINE_CURSOR_DIRECTIONS,
  TIMELINE_MESSAGES,
  TIMELINE_RESPONSE_SOURCES,
  TIMELINE_RESPONSE_STATUS,
  type TimelinePayloadMetadata,
  type TimelineResponseSource,
  type TimelineResponseStatus,
} from '../../shared/timeline-protocol.js';
import { homedir } from 'os';
import { lstat as fsLstat, open as fsOpen, readdir as fsReaddir, realpath as fsRealpath, readFile as fsReadFileRaw, stat as fsStat, unlink as fsUnlink, writeFile as fsWriteFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { exec as execCb, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);
import { startP2pRun, cancelP2pRun, getP2pRun, listP2pRuns, serializeP2pRun, type P2pTarget } from './p2p-orchestrator.js';
import { buildSessionList } from './session-list.js';
import { setClaudeUsageQuotaOptIn, recordClaudeQuotaActivity } from '../agent/claude-usage-quota.js';
import { CLAUDE_QUOTA_MSG } from '../../shared/claude-quota.js';
import { supervisionAutomation } from './supervision-automation.js';
import { parseModePipeline, P2P_CONFIG_MODE, isP2pSavedConfig, type P2pSessionConfig } from '../../shared/p2p-modes.js';
import type { P2pAdvancedRound, P2pContextReducerConfig, P2pRoundPreset } from '../../shared/p2p-advanced.js';
import { CRON_MSG } from '../../shared/cron-types.js';
import {
  INSTALLER_CONFIG_BASENAME,
  INSTALLER_OFFICIAL_NPM_REGISTRY,
  normalizeRegistryBase,
  pickUpgradeRegistry,
  type InstallerConfig,
} from '../../shared/installer-contract.js';
import { executeCronJob } from './cron-executor.js';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';
import { copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ensureImcDir, imcSubDir } from '../util/imc-dir.js';
import {
  buildWindowsCleanupScript,
  buildWindowsCleanupVbs,
  buildWindowsUpgradeRunnerVbs,
  resolveWindowsUpgradeRunnerPath,
} from '../util/windows-upgrade-script.js';
import { buildBashSharpRepair } from '../util/sharp-repair-script.js';
import { encodeVbsAsUtf16, encodeCmdAsUtf8Bom } from '../util/windows-launch-artifacts.js';
import { registerTempFile, removeTrackedTempFile } from '../store/temp-file-store.js';
import { sanitizeProjectName } from '../../shared/sanitize-project-name.js';
import { isTemplatePrompt, isTemplateOriginSummary, isImperativeCommand } from '../../shared/template-prompt-patterns.js';
import { applyRecallCapRule } from '../../shared/memory-scoring.js';
import {
  filterRecentlyInjected,
  recordRecentInjection,
  clearRecentInjectionHistory,
} from '../context/recent-injection-history.js';
import { CODEX_MODEL_IDS, normalizeClaudeCodeModelId } from '../shared/models/options.js';
import { getClaudeSdkRuntimeConfig, normalizeClaudeSdkModelForProvider } from '../agent/sdk-runtime-config.js';
import { getCodexRuntimeConfig } from '../agent/codex-runtime-config.js';
import { mergeCodexDisplayMetadata } from '../agent/codex-display.js';
import { P2P_TERMINAL_RUN_STATUSES } from '../../shared/p2p-status.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { DAEMON_UPGRADE_TARGET_LATEST, normalizeDaemonUpgradeTargetVersion } from '../../shared/daemon-upgrade.js';
import { CC_PRESET_MSG, normalizeCcPresetName, type CcPreset } from '../../shared/cc-presets.js';
import {
  MEMORY_MCP_PROVIDER_IDS,
  MEMORY_MCP_PROVIDER_STATUS_REASON,
  MEMORY_MCP_DEGRADED_REASON,
  MEMORY_MCP_STATUS,
  MEMORY_MCP_TOOL_FAMILY,
  MEMORY_WS,
  type MemoryMcpProviderStatusView,
  type MemoryMcpToolFamilyGateView,
} from '../../shared/memory-ws.js';
import { buildMemoryProjectionFallbackSource } from '../../shared/memory-projection-source-fallback.js';
import { FS_WRITE_ERROR } from '../shared/transport/fs.js';
import { P2P_CONFIG_ERROR, P2P_CONFIG_MSG, MAX_P2P_PARTICIPANTS } from '../../shared/p2p-config-events.js';
import { P2P_PRESET_DEFAULT_SUMMARY_PROMPT, P2P_WORKFLOW_SCHEMA_VERSION } from '../../shared/p2p-workflow-constants.js';
import { makeP2pWorkflowDiagnostic, type P2pWorkflowDiagnostic } from '../../shared/p2p-workflow-diagnostics.js';
import { compileP2pWorkflowDraft } from '../../shared/p2p-workflow-compiler.js';
import { materializeOldAdvancedConfigToWorkflowDraft } from '../../shared/p2p-workflow-materialize.js';
import { P2P_WORKFLOW_MSG } from '../../shared/p2p-workflow-messages.js';
import { SESSION_GROUP_CLONE_MSG } from '../../shared/session-group-clone.js';
import { getP2pConfigStoreScope, handleSessionGroupCloneCancel, handleSessionGroupCloneCommand } from './session-group-clone.js';
import { buildDefaultP2pStaticPolicy } from '../../shared/p2p-workflow-policy.js';
import {
  validateP2pWorkflowDraft,
  validateP2pWorkflowLaunchEnvelope,
} from '../../shared/p2p-workflow-validators.js';
import type {
  P2pBindRuntimeContext,
  P2pBoundWorkflow,
  P2pCompiledEdge,
  P2pCompiledNode,
  P2pCompiledWorkflow,
  P2pStaticPolicy,
  P2pWorkflowDraft,
  P2pWorkflowLaunchEnvelope,
  P2pWorkflowNodeDraft,
} from '../../shared/p2p-workflow-types.js';
import { bindP2pCompiledWorkflow } from './p2p-workflow-bind.js';
import { readP2pDiscussionWithOffset } from './p2p-workflow-discussion-offsets.js';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import {
  CLAUDE_SDK_EFFORT_LEVELS,
  CODEX_SDK_EFFORT_LEVELS,
  COPILOT_SDK_EFFORT_LEVELS,
  DEFAULT_TRANSPORT_EFFORT,
  OPENCLAW_THINKING_LEVELS,
  QWEN_EFFORT_LEVELS,
  isTransportEffortLevel,
  type TransportEffortLevel,
} from '../../shared/effort-levels.js';
import { getSavedP2pConfig, upsertSavedP2pConfig } from '../store/p2p-config-store.js';
import {
  deleteContextObservation,
  ensureContextNamespace,
  getProcessedProjectionStats,
  getProcessedProjectionById,
  listMemoryProjectSummaries,
  listContextNamespaces,
  listContextObservations,
  queryPendingContextEvents,
  promoteContextObservation,
  queryProcessedProjections,
  recordMemoryHits,
  updateProcessedProjectionSummary,
  upsertPinnedNote,
  updateContextObservationText,
  writeContextObservation,
  writeProcessedProjection,
} from '../store/context-store.js';
import { serializeContextNamespace } from '../context/context-keys.js';
import {
  isKnownTestProjectName,
  isKnownTestSessionName,
} from '../../shared/test-session-guard.js';
import {
  normalizeSharedContextRuntimeConfig,
  normalizeSharedContextRuntimeBackend,
  SHARED_CONTEXT_RUNTIME_CONFIG_MSG,
} from '../../shared/shared-context-runtime-config.js';
import { getContextModelConfig } from '../context/context-model-config.js';
import { getCompressionQueueState, resumeAcceptingCompression, stopAcceptingCompression } from '../context/summary-compressor.js';
import { closeLiveContextMaterializationAdmission, reopenLiveContextMaterializationAdmission } from '../context/live-context-ingestion.js';
import { getInflightMasterCompactionCount, resumeAcceptingMasterCompactions, stopAcceptingMasterCompactions } from './master-compaction-registry.js';
import { detectRepo, parseRemotes } from '../repo/detector.js';
import { GitOriginRepositoryIdentityService } from '../agent/repository-identity-service.js';
import {
  SUPERVISION_MODE,
  extractSessionSupervisionSnapshot,
  isSupportedSupervisionTargetSessionType,
} from '../../shared/supervision-config.js';
import {
  PREFERENCE_FEATURE_FLAG,
  PREFERENCE_INGEST_OBSERVATION_CLASS,
  PREFERENCE_INGEST_OBSERVATION_STATE,
  PREFERENCE_INGEST_ORIGIN,
  PREFERENCE_INGEST_SCOPE,
  PREFERENCE_IDEMPOTENCY_PREFIX,
  prependPreferenceProviderContext,
  processPreferenceLines,
  renderPreferenceProviderContext,
  type PreferenceIngestRecord,
  type PreferenceProviderContextRecord,
} from '../../shared/preference-ingest.js';
import { normalizeSendOrigin, type SendOrigin } from '../../shared/send-origin.js';
import {
  getMemoryFeatureFlagDefinition,
  computeEffectiveMemoryFeatureFlags,
  isMemoryFeatureFlag,
  MEMORY_FEATURE_CONFIG_MSG,
  MEMORY_FEATURE_FLAGS,
  MEMORY_FEATURE_FLAGS_BY_NAME,
  memoryFeatureFlagEnvKey,
  resolveMemoryFeatureFlagValue,
  sanitizeMemoryFeatureFlagValues,
  type FeatureFlagValueSource,
  type MemoryFeatureFlagValues,
  type MemoryFeatureFlag,
  type MemoryFeatureFlagResolutionLayers,
} from '../../shared/feature-flags.js';
import { incrementCounter } from '../util/metrics.js';
import { computeMemoryFingerprint } from '../../shared/memory-fingerprint.js';
import { isMemoryScope, isOwnerPrivateMemoryScope, isSharedProjectionScope, type MemoryScope } from '../../shared/memory-scope.js';
import { isObservationClass } from '../../shared/memory-observation.js';
import { SKILL_MAX_BYTES } from '../../shared/skill-envelope.js';
import { MD_INGEST_FEATURE_FLAG } from '../../shared/md-ingest.js';
import { MEMORY_MANAGEMENT_ERROR_CODES, type MemoryManagementErrorCode } from '../../shared/memory-management.js';
import type { MemoryProjectResolutionStatus } from '../../shared/memory-project-options.js';
import {
  MEMORY_MANAGEMENT_CONTEXT_FIELD,
  isAuthenticatedMemoryManagementContext,
  type AuthenticatedMemoryManagementContext,
  type MemoryManagementBoundProject,
} from '../../shared/memory-management-context.js';
import {
  getSessionControlTimelineFeedbackById,
  isDaemonHandledSessionControlSend,
  isSessionControlCommandText,
  shouldHideTimelineUserMessageForSessionControl,
  shouldResetProcessPreferenceContextForSessionControl,
} from '../../shared/session-control-commands.js';
import type { ContextMemoryStatsView, ContextNamespace } from '../../shared/context-types.js';
import { publishRuntimeMemoryCacheInvalidation } from '../context/runtime-memory-cache-bus.js';
import { assertManagedSkillPathSync, ManagedSkillPathError } from '../context/managed-skill-path.js';
import {
  getMemoryFeatureConfigStoreDiagnostics,
  getPersistedMemoryFeatureFlagValues,
  getRuntimeMemoryFeatureFlagValues,
  setPersistedMemoryFeatureFlagValues,
  setRuntimeMemoryFeatureFlagValues,
} from '../store/memory-feature-config-store.js';
import {
  MEMORY_MCP_DISABLED_FLAGS,
  MEMORY_MCP_TOOL_NAMES,
} from '../../shared/memory-mcp-contracts.js';
import {
  MCP_FEATURE_FLAGS_BY_NAME,
  isMcpFeatureEnabled,
} from '../../shared/memory-mcp-feature-flags.js';
import { getProvider } from '../agent/provider-registry.js';

const MAX_P2P_FILE_PULL_COUNT = 20;
const processRecallRepositoryIdentityService = new GitOriginRepositoryIdentityService();
const DAEMON_LOCAL_PREFERENCE_USER_ID = 'daemon-local';

function isEligibleSupervisionTaskText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !trimmed.startsWith('/');
}

function readBooleanEnv(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  return value === 'true' || value === '1';
}

function isMemoryFeatureEnabled(flag: MemoryFeatureFlag): boolean {
  return getEffectiveMemoryFeatureFlags()[flag];
}

function readMemoryFeatureEnvironmentDefaults(): MemoryFeatureFlagValues {
  const environmentStartupDefault: MemoryFeatureFlagValues = {};
  for (const flag of MEMORY_FEATURE_FLAGS) {
    const envValue = readBooleanEnv(process.env[memoryFeatureFlagEnvKey(flag)]);
    if (envValue !== undefined) environmentStartupDefault[flag] = envValue;
  }
  return environmentStartupDefault;
}

function readMemoryFeatureResolutionLayers(): MemoryFeatureFlagResolutionLayers {
  const persistedConfig = getPersistedMemoryFeatureFlagValues();
  return {
    runtimeConfigOverride: getRuntimeMemoryFeatureFlagValues(),
    persistedConfig,
    environmentStartupDefault: readMemoryFeatureEnvironmentDefaults(),
    readFailed: !!getMemoryFeatureConfigStoreDiagnostics().lastLoadIssue,
  };
}

function readRequestedMemoryFeatureFlags(layers: MemoryFeatureFlagResolutionLayers = readMemoryFeatureResolutionLayers()): MemoryFeatureFlagValues {
  const requested: MemoryFeatureFlagValues = {};
  for (const flag of MEMORY_FEATURE_FLAGS) {
    requested[flag] = resolveMemoryFeatureFlagValue(flag, layers);
  }
  return requested;
}

function getEffectiveMemoryFeatureFlags(): Record<MemoryFeatureFlag, boolean> {
  return computeEffectiveMemoryFeatureFlags(readRequestedMemoryFeatureFlags());
}

function featureFlagValueSource(flag: MemoryFeatureFlag, layers: MemoryFeatureFlagResolutionLayers): FeatureFlagValueSource {
  if (layers.runtimeConfigOverride?.[flag] !== undefined) return 'runtime_config_override';
  if (layers.persistedConfig?.[flag] !== undefined) return 'persisted_config';
  if (layers.environmentStartupDefault?.[flag] !== undefined) return 'environment_startup_default';
  return 'registry_default';
}

function isPreferenceFeatureEnabled(): boolean {
  return isMemoryFeatureEnabled(PREFERENCE_FEATURE_FLAG);
}

function preferenceUserIdForSend(cmd: Record<string, unknown>, record: SessionRecord | null | undefined): string {
  const fromCommand = typeof cmd.userId === 'string' ? cmd.userId.trim() : '';
  if (fromCommand) return fromCommand;
  const fromNamespace = record?.contextNamespace?.userId?.trim();
  return fromNamespace || DAEMON_LOCAL_PREFERENCE_USER_ID;
}

const processPreferenceContextSignatures = new Map<string, string>();

function normalizePreferenceProviderContextSignature(context: string): string {
  return context.replace(/\s+/g, ' ').trim();
}

function prepareProcessPreferenceProviderText(input: {
  sessionName: string;
  providerText: string;
  preferenceContext: string;
}): string {
  const context = input.preferenceContext.trim();
  if (!context) return input.providerText;
  const trimmedText = input.providerText.trim();
  if (trimmedText.startsWith('/')) {
    if (shouldResetProcessPreferenceContextForSessionControl(trimmedText)) {
      processPreferenceContextSignatures.delete(input.sessionName);
    }
    return input.providerText;
  }
  const signature = normalizePreferenceProviderContextSignature(context);
  if (!signature) return input.providerText;
  if (processPreferenceContextSignatures.get(input.sessionName) === signature) {
    return input.providerText;
  }
  processPreferenceContextSignatures.set(input.sessionName, signature);
  return prependPreferenceProviderContext(input.providerText, context);
}

function loadPreferenceProviderContext(input: {
  enabled: boolean;
  userId: string;
  currentRecords: readonly PreferenceIngestRecord[];
}): string {
  if (!input.enabled) return '';
  const records: PreferenceProviderContextRecord[] = input.currentRecords.map((record) => ({
    text: record.text,
    fingerprint: record.fingerprint,
  }));
  const scopeKey = `${PREFERENCE_INGEST_SCOPE}:${input.userId}`;
  const idempotencyPrefix = [
    PREFERENCE_IDEMPOTENCY_PREFIX,
    input.userId,
    scopeKey,
    '',
  ].join('\u0000');
  try {
    for (const observation of listContextObservations({
      scope: PREFERENCE_INGEST_SCOPE,
      class: PREFERENCE_INGEST_OBSERVATION_CLASS,
    })) {
      if (observation.state !== PREFERENCE_INGEST_OBSERVATION_STATE) continue;
      const preferenceText = typeof observation.content.text === 'string'
        ? observation.content.text
        : '';
      if (!preferenceText.trim()) continue;
      const idempotencyKey = typeof observation.content.idempotencyKey === 'string'
        ? observation.content.idempotencyKey
        : '';
      if (!idempotencyKey.startsWith(idempotencyPrefix)) continue;
      records.push({
        text: preferenceText,
        fingerprint: observation.fingerprint,
        updatedAt: observation.updatedAt,
      });
    }
  } catch (err) {
    logger.warn({ err, userId: input.userId }, 'failed to load preference context for provider dispatch');
  }
  return renderPreferenceProviderContext(records);
}

function schedulePreferencePersistence(input: {
  userId: string;
  commandId: string;
  records: readonly PreferenceIngestRecord[];
  sendOrigin: SendOrigin;
}): void {
  if (input.records.length === 0) return;
  setTimeout(() => {
    try {
      const namespace = ensureContextNamespace({
        scope: PREFERENCE_INGEST_SCOPE,
        userId: input.userId,
        name: 'preferences',
      });
      for (const record of input.records) {
        const alreadyPersisted = listContextObservations({
          namespaceId: namespace.id,
          class: PREFERENCE_INGEST_OBSERVATION_CLASS,
        }).some((observation) => (
          observation.fingerprint === record.fingerprint
          && observation.content.idempotencyKey === record.idempotencyKey
        ));
        writeContextObservation({
          namespaceId: namespace.id,
          scope: PREFERENCE_INGEST_SCOPE,
          class: PREFERENCE_INGEST_OBSERVATION_CLASS,
          origin: PREFERENCE_INGEST_ORIGIN,
          fingerprint: record.fingerprint,
          content: {
            text: record.text,
            ownerUserId: input.userId,
            createdByUserId: input.userId,
            updatedByUserId: input.userId,
            idempotencyKey: record.idempotencyKey,
          },
          text: record.text,
          sourceEventIds: [input.commandId],
          state: PREFERENCE_INGEST_OBSERVATION_STATE,
        });
        incrementCounter(alreadyPersisted ? 'mem.preferences.duplicate_ignored' : 'mem.preferences.persisted', {
          sendOrigin: input.sendOrigin,
        });
      }
    } catch (err) {
      incrementCounter('mem.preferences.persistence_failed', { source: 'schedulePreferencePersistence' });
      logger.warn({ err }, 'preference ingest persistence failed after send receipt');
    }
  }, 0);
}

/**
 * Reliable `command.ack` emission — enqueue into the on-disk outbox BEFORE the
 * network send so that a transient serverLink outage doesn't silently drop the
 * ack. The outbox flushes on the next successful reconnect + auth; the server's
 * seenCommandAcks LRU dedups replays so the browser sees the ack exactly once.
 *
 * Replaces the original `try { serverLink.send({ type: 'command.ack', ... }) }
 * catch {}` pattern that existed in ~15 sites across handleSessionSend's
 * transport/P2P/queue paths. Keeping it all funnelled through one helper makes
 * it impossible to forget the outbox hook on a new code path.
 *
 * Does NOT emit the corresponding `timelineEmitter.emit(..., 'command.ack', ...)`
 * — call sites still do that explicitly so they can choose whether the ack is
 * timeline-visible (process path) or not (some P2P internal paths).
 */
function emitCommandAckReliable(
  serverLink: (Pick<ServerLink, 'send'> & Partial<Pick<ServerLink, 'trySend'>>) | undefined,
  params: {
    commandId: string;
    sessionName: string;
    status: string;
    error?: string;
  },
): void {
  const outbox = getDefaultAckOutbox();
  outbox
    .enqueue({
      commandId: params.commandId,
      sessionName: params.sessionName,
      status: params.status,
      ...(params.error ? { error: params.error } : {}),
      ts: Date.now(),
    })
    .catch((err) =>
      logger.error({ commandId: params.commandId, err }, 'ackOutbox.enqueue failed'),
    );
  const sent = trySendCommandAck(serverLink, {
    commandId: params.commandId,
    sessionName: params.sessionName,
    status: params.status,
    error: params.error,
  });
  if (sent) {
    outbox
      .markAcked(params.commandId)
      .catch((err) =>
        logger.warn({ commandId: params.commandId, err }, 'ackOutbox.markAcked failed'),
      );
  } else {
    logger.warn(
      { commandId: params.commandId },
      'command.ack not sent, queued for retry via outbox',
    );
  }
}

function trySendCommandAck(
  serverLink: (Pick<ServerLink, 'send'> & Partial<Pick<ServerLink, 'trySend'>>) | undefined,
  params: {
    commandId: string;
    sessionName: string;
    status: string;
    error?: string;
  },
): boolean {
  if (!serverLink) return false;
  const wireMsg: Record<string, unknown> = {
    type: MSG_COMMAND_ACK,
    commandId: params.commandId,
    status: params.status,
    session: params.sessionName,
  };
  if (params.error) wireMsg.error = params.error;
  if (typeof serverLink.trySend === 'function') {
    return serverLink.trySend(wireMsg);
  }
  try {
    serverLink.send(wireMsg);
    return true;
  } catch (err) {
    logger.warn({ commandId: params.commandId, err }, 'command.ack send failed');
    return false;
  }
}

function normalizeTransportConfigUpdate(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function handleSessionTransportConfigUpdate(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  if (!sessionName) {
    logger.warn('session.update_transport_config: missing sessionName');
    return;
  }
  const record = getSession(sessionName);
  if (!record) {
    logger.warn({ sessionName }, 'session.update_transport_config: session not found in store');
    return;
  }
  // Distinguish "cmd did not include transportConfig" from "cmd set transportConfig=null".
  // If the key is missing entirely, we must not wipe the existing config — earlier
  // versions were silently dropping supervision whenever this handler ran with a
  // malformed payload.
  if (!('transportConfig' in cmd)) {
    logger.warn({ sessionName }, 'session.update_transport_config: missing transportConfig field — ignoring');
    return;
  }
  const nextTransportConfig = normalizeTransportConfigUpdate(cmd.transportConfig);
  const nextRecord: SessionRecord = {
    ...record,
    transportConfig: nextTransportConfig,
    updatedAt: Date.now(),
  };
  upsertSession(nextRecord);
  // Push the updated record to the server so daemon-side edits survive a restart+sync.
  // The server persist callback is a no-op when not yet wired; the next `persistSessionToWorker`
  // loop in lifecycle will retry from the local store.
  persistSessionRecord(nextRecord, sessionName);
  supervisionAutomation.applySnapshotUpdate(sessionName, extractSessionSupervisionSnapshot(nextTransportConfig ?? null));
  invalidateTransportListModelsCache('session_transport_config_update');
  await handleGetSessions(serverLink);
}

async function handleSubSessionTransportConfigUpdate(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  if (!sessionName) {
    logger.warn('subsession.update_transport_config: missing sessionName');
    return;
  }
  const record = getSession(sessionName);
  if (!record) {
    logger.warn({ sessionName }, 'subsession.update_transport_config: session not found in store');
    return;
  }
  if (!('transportConfig' in cmd)) {
    logger.warn({ sessionName }, 'subsession.update_transport_config: missing transportConfig field — ignoring');
    return;
  }
  const nextTransportConfig = normalizeTransportConfigUpdate(cmd.transportConfig);
  const nextRecord: SessionRecord = {
    ...record,
    transportConfig: nextTransportConfig,
    updatedAt: Date.now(),
  };
  upsertSession(nextRecord);
  persistSessionRecord(nextRecord, sessionName);
  supervisionAutomation.applySnapshotUpdate(sessionName, extractSessionSupervisionSnapshot(nextTransportConfig ?? null));
  invalidateTransportListModelsCache('subsession_transport_config_update');
  const id = sessionName.replace(/^deck_sub_/, '');
  try {
    await sendSubSessionSync(serverLink, id, { transportConfig: nextTransportConfig });
  } catch {
    // not connected
  }
}

function supportsEffort(agentType: string | undefined): agentType is 'claude-code-sdk' | 'codex-sdk' | 'copilot-sdk' | 'openclaw' | 'qwen' {
  return agentType === 'claude-code-sdk'
    || agentType === 'codex-sdk'
    || agentType === 'copilot-sdk'
    || agentType === 'openclaw'
    || agentType === 'qwen';
}

function supportsTransportClear(agentType: string | undefined): agentType is 'claude-code-sdk' | 'codex-sdk' | 'copilot-sdk' | 'cursor-headless' | 'openclaw' | 'qwen' | 'kimi-sdk' {
  return agentType === 'claude-code-sdk'
    || agentType === 'codex-sdk'
    || agentType === 'copilot-sdk'
    || agentType === 'cursor-headless'
    || agentType === 'openclaw'
    || agentType === 'qwen'
    || agentType === 'kimi-sdk';
}

// `/compact` is provider-dispatched, not daemon-synthesized. Provider adapters
// that expose a compact RPC translate the raw command at the SDK boundary;
// verified slash-command providers receive the literal command; unsupported
// providers fail visibly. The daemon's automatic materialization pipeline still
// records raw events into `context_event_archive`, so provenance is preserved
// independently of provider-side compaction.

function supportsProcessClear(agentType: string | undefined): agentType is 'claude-code' | 'codex' | 'opencode' {
  return agentType === 'claude-code' || agentType === 'codex' || agentType === 'opencode';
}

async function relaunchFreshTransportConversation(record: SessionRecord): Promise<void> {
  await stopTransportRuntimeSession(record.name);
  await launchTransportSession({
    name: record.name,
    projectName: record.projectName,
    role: record.role,
    agentType: record.agentType as 'claude-code-sdk' | 'codex-sdk' | 'copilot-sdk' | 'cursor-headless' | 'openclaw' | 'qwen' | 'kimi-sdk',
    projectDir: record.projectDir,
    label: record.label,
    description: record.description,
    requestedModel: record.requestedModel,
    effort: record.effort,
    transportConfig: record.transportConfig,
    ccPreset: (record.agentType === 'claude-code-sdk' || record.agentType === 'qwen') ? record.ccPreset : undefined,
    ...(record.agentType === 'claude-code-sdk' ? { ccSessionId: randomUUID() } : {}),
    ...(record.agentType === 'openclaw' && record.providerSessionId ? { bindExistingKey: record.providerSessionId } : {}),
    ...(record.parentSession ? { parentSession: record.parentSession } : {}),
    ...(record.userCreated ? { userCreated: true } : {}),
    fresh: true,
  });
}

/**
 * Resume an existing transport session after the runtime lost its provider
 * session id (observed when a cancel or mid-init error left the runtime stuck
 * with `providerSessionId === null`). Unlike `relaunchFreshTransportConversation`
 * this does NOT pass `fresh: true` — conversation continuity is preserved via
 * the persisted resume id (`ccSessionId` / `codexSessionId` / `providerResumeId`
 * / `providerSessionId`), which `launchTransportSession` threads back through
 * to the provider's resume path.
 *
 * On success, `launchTransportSession` will drain the transport resend queue
 * for the same session name (see `session-manager.ts`), so any message that
 * the caller enqueued right before invoking this helper is auto-delivered.
 */
async function resumeTransportRuntimeAfterLoss(record: SessionRecord): Promise<void> {
  await stopTransportRuntimeSession(record.name).catch(() => {});
  await launchTransportSession({
    name: record.name,
    projectName: record.projectName,
    role: record.role,
    agentType: record.agentType as 'claude-code-sdk' | 'codex-sdk' | 'copilot-sdk' | 'cursor-headless' | 'openclaw' | 'qwen' | 'kimi-sdk',
    projectDir: record.projectDir,
    label: record.label,
    description: record.description,
    requestedModel: record.requestedModel,
    effort: record.effort,
    transportConfig: record.transportConfig,
    ccPreset: (record.agentType === 'claude-code-sdk' || record.agentType === 'qwen') ? record.ccPreset : undefined,
    // Thread resume ids back so the provider reuses the same conversation.
    ...(record.agentType === 'claude-code-sdk' && record.ccSessionId ? { ccSessionId: record.ccSessionId } : {}),
    ...(record.agentType === 'codex-sdk' && record.codexSessionId ? { codexSessionId: record.codexSessionId } : {}),
    ...((record.agentType === 'cursor-headless' || record.agentType === 'copilot-sdk' || record.agentType === 'kimi-sdk') && record.providerResumeId
      ? { providerResumeId: record.providerResumeId } : {}),
    ...(record.agentType === 'openclaw' && record.providerSessionId ? { bindExistingKey: record.providerSessionId } : {}),
    ...(record.agentType === 'qwen' && record.providerSessionId ? { bindExistingKey: record.providerSessionId } : {}),
    ...(record.parentSession ? { parentSession: record.parentSession } : {}),
    ...(record.userCreated ? { userCreated: true } : {}),
  });
}

function getSupportedEffortLevels(agentType: string | undefined): readonly TransportEffortLevel[] {
  return agentType === 'claude-code-sdk'
    ? CLAUDE_SDK_EFFORT_LEVELS
    : agentType === 'codex-sdk'
      ? CODEX_SDK_EFFORT_LEVELS
      : agentType === 'copilot-sdk'
        ? COPILOT_SDK_EFFORT_LEVELS
        : agentType === 'qwen'
          ? QWEN_EFFORT_LEVELS
          : agentType === 'openclaw'
            ? OPENCLAW_THINKING_LEVELS
            : [];
}

function getDefaultThinkingLevel(agentType: string | undefined): TransportEffortLevel | undefined {
  return supportsEffort(agentType) ? DEFAULT_TRANSPORT_EFFORT : undefined;
}

async function syncSubSessionIfNeeded(sessionName: string, serverLink: ServerLink): Promise<void> {
  if (!sessionName.startsWith('deck_sub_')) return;
  const subId = sessionName.slice('deck_sub_'.length);
  try { await sendSubSessionSync(serverLink, subId); } catch { /* ignore */ }
}

/**
 * For sandboxed agents (Gemini, Codex): copy files from ~/.imcodes/ to
 * the session's project .imc/refs/ so the agent can access them.
 * Rewrites @paths and `#N:(path)` attachment references in the message text.
 * Auto-deletes copies after 30 min and persists cleanup metadata in
 * ~/.imcodes/temp-files.json.
 */
async function rewritePathsForSandbox(sessionName: string, text: string): Promise<string> {
  const record = getSession(sessionName);
  const projectDir = record?.projectDir;
  if (!projectDir) return text;

  const imcodesDir = nodePath.join(homedir(), '.imcodes');
  const escapedImcodesDir = imcodesDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const legacyAtPathRegex = new RegExp(`@(${escapedImcodesDir}[/\\\\][^\\s)]+)`, 'g');
  const taggedPathRegex = new RegExp(`#\\d+:\\((${escapedImcodesDir}[/\\\\][^)]+)\\)`, 'g');

  let result = text;
  const paths = new Set<string>();
  for (const match of text.matchAll(legacyAtPathRegex)) {
    if (match[1]) paths.add(match[1]);
  }
  for (const match of text.matchAll(taggedPathRegex)) {
    if (match[1]) paths.add(match[1]);
  }
  if (paths.size === 0) return text;

  const refsDir = await ensureImcDir(projectDir, 'refs');

  for (const srcPath of paths) {
    const filename = nodePath.basename(srcPath);
    // Unique prefix prevents collision when multiple sessions copy the same file concurrently
    const uniqueName = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${filename}`;
    const destPath = nodePath.join(refsDir, uniqueName);
    try {
      await copyFile(srcPath, destPath);
      const now = Date.now();
      await registerTempFile({
        path: destPath,
        createdAt: now,
        expiresAt: now + (30 * 60_000),
        reason: 'sandbox-ref-copy',
      });
      result = result.replaceAll(`@${srcPath}`, `@${destPath}`);
      result = result.replaceAll(`(${srcPath})`, `(${destPath})`);
      // Auto-delete after 30 minutes
      const cleanupTimer = setTimeout(async () => {
        try { const { unlink } = await import('node:fs/promises'); await unlink(destPath); } catch { /* already deleted */ }
        try { await removeTrackedTempFile(destPath); } catch { /* ignore */ }
      }, 30 * 60_000);
      cleanupTimer.unref?.();
    } catch (err) {
      logger.warn({ src: srcPath, dest: destPath, err }, 'Failed to copy file for sandboxed agent');
    }
  }

  return result;
}
import { handleRepoCommand } from './repo-handler.js';
import {
  handleFileUpload,
  handleFileUploadFetch,
  handleFileDownload,
  tryCreateProjectFileHandle,
  lookupAttachment,
} from './file-transfer-handler.js';
import { getDefaultPreviewReadCoordinator, __resetPreviewReadCoordinatorForTests } from './file-preview-read-coordinator.js';
import { isFilePreviewPathAllowed, resolveCanonical } from './file-preview-path-policy.js';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';
import { FS_READ_ERROR_CODES } from '../../shared/fs-read-error-codes.js';
import { REPO_MSG } from '../shared/repo-types.js';
import { handlePreviewCommand } from './preview-relay.js';
import { PREVIEW_MSG } from '../../shared/preview-types.js';
import type { TransportAttachment } from '../../shared/transport-attachments.js';

import { resolveContextWindow } from '../util/model-context.js';
import { QWEN_MODEL_IDS } from '../../shared/qwen-models.js';
import { getQwenRuntimeConfig } from '../agent/qwen-runtime-config.js';
import { getQwenDisplayMetadata } from '../agent/provider-display.js';
import { buildRelatedPastWorkText } from '../../shared/memory-recall-format.js';
import { getQwenOAuthQuotaUsageLabel, recordQwenOAuthRequest } from '../agent/provider-quota.js';
import { listProviderSessions as listProviderSessionsImpl } from './provider-sessions.js';
import { buildMemoryContextTimelinePayload, buildMemoryContextStatusPayload } from './memory-context-timeline.js';

function describeTransportSendError(err: unknown): string {
  if (err && typeof err === 'object') {
    const record = err as { message?: unknown };
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
  }
  return err instanceof Error ? err.message : String(err);
}

const pendingSessionRelaunches = new Map<string, Promise<void>>();

function trackPendingSessionRelaunch(sessionName: string, pending: Promise<void>): Promise<void> {
  pendingSessionRelaunches.set(sessionName, pending);
  void pending.then(() => {
    if (pendingSessionRelaunches.get(sessionName) === pending) pendingSessionRelaunches.delete(sessionName);
  }, () => {
    if (pendingSessionRelaunches.get(sessionName) === pending) pendingSessionRelaunches.delete(sessionName);
  });
  return pending;
}

function runExclusiveSessionRelaunch(sessionName: string, factory: () => Promise<void>): Promise<void> {
  const pending = pendingSessionRelaunches.get(sessionName);
  if (pending) return pending;
  return trackPendingSessionRelaunch(sessionName, factory());
}

async function waitForPendingSessionRelaunch(sessionName: string): Promise<void> {
  const pending = pendingSessionRelaunches.get(sessionName);
  if (!pending) return;
  try {
    await pending;
  } catch {
    // Restart path already emitted its own error and corrective session sync.
  }
}

function refreshQwenQuotaUsageLabels(serverLink?: ServerLink): void {
  const usageLabel = getQwenOAuthQuotaUsageLabel();
  for (const session of listSessions()) {
    if (session.agentType !== 'qwen' || session.qwenAuthType !== 'qwen-oauth') continue;
    upsertSession({
      ...session,
      quotaUsageLabel: usageLabel,
      updatedAt: Date.now(),
    });
    // Re-sync sub-sessions so their quota usage labels update in the browser
    if (session.name.startsWith('deck_sub_')) {
      const subId = session.name.replace(/^deck_sub_/, '');
      if (serverLink) void sendSubSessionSync(serverLink, subId).catch(() => { /* not connected */ });
    }
  }
  if (serverLink) void handleGetSessions(serverLink);
}

export async function refreshCodexQuotaMetadata(serverLink?: ServerLink): Promise<void> {
  const sessions = listSessions();
  const codexSessions = sessions.filter((session) => session.agentType === 'codex' || session.agentType === 'codex-sdk');
  if (codexSessions.length === 0) return;

  if (serverLink) {
    await handleGetSessions(serverLink);
  } else {
    await buildSessionList();
  }

  if (!serverLink) return;
  for (const session of codexSessions) {
    if (!session.name.startsWith('deck_sub_')) continue;
    const subId = session.name.replace(/^deck_sub_/, '');
    try {
      await sendSubSessionSync(serverLink, subId);
    } catch {
      // not connected
    }
  }
}

// ── @@ token parsing ─────────────────────────────────────────────────────────

/**
 * Expand @@all — find all active sessions in the same domain as the initiator.
 *
 * Rules:
 * - If initiator is a main session (deck_{project}_{role}):
 *   select its direct sub-sessions + same-project main sessions
 * - If initiator is a sub-session (deck_sub_*):
 *   select its siblings (same parentSession) + parent
 * - Always skip: initiator itself, stopped sessions
 */
function expandAllTargets(initiatorName: string, mode: string, excludeSameType = false, sessionConfig?: P2pSessionConfig): P2pTarget[] {
  const initiator = getSession(initiatorName);
  const all = listSessions();
  const targets: P2pTarget[] = [];

  const NON_DISCUSSABLE = new Set(['shell', 'script']);

  for (const s of all) {
    if (s.name === initiatorName) continue;
    if (s.state === 'stopped') continue;
    if (NON_DISCUSSABLE.has(s.agentType ?? '')) continue;
    if (excludeSameType && initiator?.agentType && s.agentType === initiator.agentType) continue;

    let inDomain = false;
    if (initiatorName.startsWith('deck_sub_')) {
      const isSibling = s.parentSession && s.parentSession === initiator?.parentSession;
      const isParent = s.name === initiator?.parentSession;
      inDomain = !!(isSibling || isParent);
    } else {
      const isChild = s.parentSession === initiatorName;
      const isSameProject = !s.name.startsWith('deck_sub_') && initiator?.projectName && s.projectName === initiator.projectName;
      inDomain = !!(isChild || isSameProject);
    }

    if (!inDomain) continue;

    if (sessionConfig) {
      // Strict allowlist semantics: a saved P2P config is an INCLUSION list.
      // ONLY sessions with `enabled: true` and a non-`skip` mode are eligible.
      // Missing entries are EXCLUDED.
      //
      // Earlier "missing = include" semantics caused every new sub-session
      // (created after the user's last save) to silently join the run, so
      // selecting 3 members produced "all members" once any new sub-session
      // was spawned. The Gate 1 / Gate 2 / cap=5 checks at command-handler
      // entry now reject the empty-config case explicitly with a clear error
      // (`NO_SAVED_CONFIG` / `NO_ENABLED_PARTICIPANTS`), so the strict
      // allowlist never silently fails — it always either runs the picked
      // set or surfaces a visible error.
      const entry = sessionConfig[s.name];
      if (!entry || entry.enabled !== true || entry.mode === 'skip') continue;
      const effectiveMode = (mode === P2P_CONFIG_MODE) ? entry.mode : mode;
      targets.push({ session: s.name, mode: effectiveMode });
    } else {
      targets.push({ session: s.name, mode });
    }
  }
  // Sort deterministically by session name for predictable ordering
  targets.sort((a, b) => a.session.localeCompare(b.session));
  return targets;
}

function resolveP2pConfigScopeSession(sessionName: string): string {
  if (!sessionName.startsWith('deck_sub_')) return sessionName;
  const record = getSession(sessionName);
  return record?.parentSession ?? sessionName;
}

async function resolveStructuredP2pSessionConfig(
  sessionName: string,
  serverLink: ServerLink,
  clientConfig?: P2pSessionConfig,
): Promise<P2pSessionConfig | undefined> {
  const scopeSession = resolveP2pConfigScopeSession(sessionName);
  const storeScope = getP2pConfigStoreScope(serverLink, scopeSession);
  const saved = await getSavedP2pConfig(storeScope);
  if (saved?.sessions && typeof saved.sessions === 'object') return saved.sessions;
  if (storeScope !== scopeSession) {
    const legacySaved = await getSavedP2pConfig(scopeSession);
    if (legacySaved?.sessions && typeof legacySaved.sessions === 'object') return legacySaved.sessions;
  }
  return clientConfig;
}

function sendP2pTargetError(
  serverLink: ServerLink,
  sessionName: string,
  commandId: string,
  error: string,
  timelineMessage: string,
): void {
  timelineEmitter.emit(sessionName, 'command.ack', { commandId, status: 'error', error: timelineMessage });
  emitCommandAckReliable(serverLink, { commandId, sessionName, status: 'error', error });
}

// Session names: alphanumeric + underscore only (matches deck_{project}_{role} and deck_sub_{id} patterns)
const SESSION_NAME_RE = /[a-zA-Z0-9_]+/;
const SINGLE_MODES = new Set(['audit', 'review', 'plan', 'brainstorm', 'discuss', 'config']);
const VALID_MODES = SINGLE_MODES; // alias for parseAtTokens (individual session tokens always use single modes)

/** Validate a mode string — single mode or combo pipeline (e.g. "brainstorm>discuss>plan"). */
function isValidP2pMode(mode: string): boolean {
  if (SINGLE_MODES.has(mode)) return true;
  // Combo pipeline: every segment must be a known mode (not config)
  const pipeline = parseModePipeline(mode);
  return pipeline.length > 1 && pipeline.every((m) => SINGLE_MODES.has(m) && m !== 'config');
}
const DISCUSS_TOKEN_RE = /@@discuss\(([^,]+),\s*([^)]+)\)/g;
// @@all(mode) or @@all(mode, exclude-same-type)
const ALL_TOKEN_RE = /@@all\(([^)]+)\)/g;
const P2P_CONFIG_TOKEN_RE = /@@p2p-config\([^)]*\)/g;
const FILE_TOKEN_RE = /@((?:[a-zA-Z0-9_.\-/]+\/)*[a-zA-Z0-9_.\-]+\.[a-zA-Z0-9]+)/g;

export interface ParsedTokens {
  agents: P2pTarget[];
  files: string[];
  cleanText: string;
  /** True if @@all was used — caller must expand with active sessions. */
  expandAll?: { mode: string; excludeSameType?: boolean; rounds?: number };
  /** True if @@discuss tokens were present but ALL failed validation. */
  hadDiscussTokens?: boolean;
}

function parseAllModeSpec(raw: string): { mode: string; rounds?: number; excludeSameType?: boolean } | null {
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const excludeSameType = parts.includes('exclude-same-type');
  const first = parts[0] ?? '';
  const roundsMatch = /^(.*?)\s*[×x]\s*(\d+)\s*$/.exec(first);
  const mode = (roundsMatch?.[1] ?? first).trim();
  const rounds = roundsMatch ? Math.max(1, Math.min(parseInt(roundsMatch[2] ?? '1', 10) || 1, 6)) : undefined;
  if (!isValidP2pMode(mode)) return null;
  return { mode, rounds, excludeSameType };
}

export function parseAtTokens(text: string): ParsedTokens {
  const agents: P2pTarget[] = [];
  const files: string[] = [];
  let expandAll: { mode: string; excludeSameType?: boolean; rounds?: number } | undefined;

  // Check for @@all(mode[, flags]) first
  const allMatch = ALL_TOKEN_RE.exec(text);
  if (allMatch) {
    const parsed = parseAllModeSpec(allMatch[1]);
    if (parsed) expandAll = parsed;
  }
  ALL_TOKEN_RE.lastIndex = 0; // reset regex state

  // Validate session names and modes in @@discuss tokens
  const validSessions = new Set(listSessions().map((s) => s.name));
  let discussTokenCount = 0;
  for (const m of text.matchAll(DISCUSS_TOKEN_RE)) {
    discussTokenCount++;
    const session = m[1].trim();
    const mode = m[2].trim();
    if (SESSION_NAME_RE.test(session) && validSessions.has(session) && VALID_MODES.has(mode)) {
      agents.push({ session, mode });
    } else {
      logger.warn({ session, mode, valid: validSessions.has(session), modeValid: VALID_MODES.has(mode) }, 'parseAtTokens: @@discuss token skipped — session not in store or invalid mode');
    }
  }

  // Remove @@all, @@discuss, and @@p2p-config tokens first so @file regex doesn't partially match them
  let withoutCx = text.replace(ALL_TOKEN_RE, '').replace(DISCUSS_TOKEN_RE, '').replace(P2P_CONFIG_TOKEN_RE, '');
  for (const m of withoutCx.matchAll(FILE_TOKEN_RE)) {
    files.push(m[1]);
  }

  const cleanText = withoutCx.replace(FILE_TOKEN_RE, '').replace(/\s+/g, ' ').trim();
  const hadDiscussTokens = discussTokenCount > 0 && agents.length === 0;
  return { agents, files, cleanText, expandAll, hadDiscussTokens };
}

// ── Binary frame packing ─────────────────────────────────────────────────────

/**
 * Pack a raw PTY buffer into the v1 binary frame format:
 *   byte 0: version (0x01)
 *   bytes 1-2: sessionName length (uint16 BE)
 *   bytes 3..3+N-1: sessionName (UTF-8)
 *   bytes 3+N..: raw PTY payload
 */
function packRawFrame(sessionName: string, data: Buffer): Buffer {
  const nameBytes = Buffer.from(sessionName, 'utf8');
  const header = Buffer.allocUnsafe(3 + nameBytes.length);
  header[0] = 0x01;
  header.writeUInt16BE(nameBytes.length, 1);
  nameBytes.copy(header, 3);
  return Buffer.concat([header, data]);
}

// ── AsyncMutex (per-session serialized stdin writes) ─────────────────────────

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const tryLock = () => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => this.release());
        } else {
          this.queue.push(tryLock);
        }
      };
      tryLock();
    });
  }

  private release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) next();
  }
}

const sessionMutexes = new Map<string, AsyncMutex>();
function getMutex(sessionName: string): AsyncMutex {
  let mutex = sessionMutexes.get(sessionName);
  if (!mutex) {
    mutex = new AsyncMutex();
    sessionMutexes.set(sessionName, mutex);
  }
  return mutex;
}

const PROCESS_MEMORY_RECALL_DEADLINE_MS = 2_500;

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface ProcessDeliveryTurn {
  waitForTurn(): Promise<void>;
  releaseTurn(): void;
}

const processDeliveryChains = new Map<string, Promise<void>>();

function reserveProcessDeliveryTurn(sessionName: string): ProcessDeliveryTurn {
  const previous = processDeliveryChains.get(sessionName) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const chain = previous.catch(() => { /* keep the delivery chain alive */ }).then(() => current);
  processDeliveryChains.set(sessionName, chain);
  let released = false;
  return {
    waitForTurn: () => previous.catch(() => { /* earlier delivery failure is surfaced elsewhere */ }),
    releaseTurn: () => {
      if (released) return;
      released = true;
      releaseCurrent();
      void chain.finally(() => {
        if (processDeliveryChains.get(sessionName) === chain) {
          processDeliveryChains.delete(sessionName);
        }
      });
    },
  };
}

// ── CommandId dedup cache (100 entries / 5 min TTL per session) ──────────────

class CommandDedup {
  private entries = new Map<string, number>(); // commandId → timestamp
  private readonly MAX_SIZE = 100;
  private readonly TTL_MS = 5 * 60 * 1000;

  has(commandId: string): boolean {
    const ts = this.entries.get(commandId);
    if (ts === undefined) return false;
    if (Date.now() - ts > this.TTL_MS) {
      this.entries.delete(commandId);
      return false;
    }
    return true;
  }

  add(commandId: string): void {
    if (this.entries.size >= this.MAX_SIZE) {
      // Evict expired entries first
      const now = Date.now();
      for (const [id, ts] of this.entries) {
        if (now - ts > this.TTL_MS) this.entries.delete(id);
      }
      // If still at max, evict the oldest
      if (this.entries.size >= this.MAX_SIZE) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    this.entries.set(commandId, Date.now());
  }
}

const sessionDedups = new Map<string, CommandDedup>();
function getDedup(sessionName: string): CommandDedup {
  let dedup = sessionDedups.get(sessionName);
  if (!dedup) {
    dedup = new CommandDedup();
    sessionDedups.set(sessionName, dedup);
  }
  return dedup;
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return homedir() + p.slice(1);
  return p;
}

// Track active terminal subscriptions for proper cleanup
const activeSubscriptions = new Map<string, { subscriber: StreamSubscriber; unsubscribe: () => void }>();

let routerCtx: RouterContext | null = null;

/** Set the router context for handling inbound chat messages. Must be called before messages arrive. */
export function setRouterContext(ctx: RouterContext): void {
  routerCtx = ctx;
}

export function handleWebCommand(msg: unknown, serverLink: ServerLink): void {
  // Input validation: anything that isn't a non-null object goes
  // straight to the floor.  We log a debug ping for arrays / primitives
  // so a confused client gets diagnostic feedback without flooding.
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    if (msg !== null && msg !== undefined) {
      logger.debug({ kind: typeof msg, isArray: Array.isArray(msg) }, 'Ignoring non-object web command');
    }
    return;
  }
  const cmd = msg as Record<string, unknown>;
  traceWebCommandReceived(cmd);

  // Top-level isolation: any synchronous throw inside a handler — e.g.
  // a TypeError from `cmd.foo.bar` when `foo` is undefined, or a
  // validation throw before the first await of an async function —
  // would otherwise propagate out of the WebSocket onMessage callback
  // and trip the global uncaughtException handler.  That handler keeps
  // the daemon alive but emits a noisy "UNCAUGHT EXCEPTION" line and
  // broadcasts a daemon.error event to every connected browser, so to
  // operators the daemon LOOKED crashed.  Wrap the dispatch so a bad
  // single command can't destabilize the whole connection.
  //
  // Note on async rejections: handlers in the switch use the
  // `void handleX(...)` pattern so promise rejections propagate to
  // process.on('unhandledRejection') in src/index.ts, which logs and
  // forwards a daemon.error event but keeps the process alive.  The
  // rare-but-real "throw before first await" case STILL surfaces to
  // browsers, but the daemon does not crash.  Individual handlers
  // already do their own try/catch where input validation matters.
  try {
    traceSync('web_command.dispatch_sync', {
      type: typeof cmd.type === 'string' ? cmd.type : '<non-string>',
      commandId: typeof cmd.commandId === 'string' ? cmd.commandId : undefined,
      sessionName: typeof cmd.sessionName === 'string' ? cmd.sessionName : undefined,
    }, () => dispatchWebCommand(cmd, serverLink));
  } catch (err) {
    logger.warn(
      { err, type: typeof cmd.type === 'string' ? cmd.type : '<non-string>' },
      'Web command handler threw synchronously — daemon stays alive',
    );
  }
}

function dispatchWebCommand(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  switch (cmd.type) {
    case 'inbound':
      void handleInbound(cmd);
      break;
    case 'session.start':
      void handleStart(cmd, serverLink);
      break;
    case 'session.stop':
      void handleStop(cmd, serverLink);
      break;
    case 'session.restart':
      void handleRestart(cmd, serverLink);
      break;
    case DAEMON_COMMAND_TYPES.SESSION_CANCEL:
      void handleSessionCancel(cmd, serverLink);
      break;
    case SESSION_GROUP_CLONE_MSG.START:
      void handleSessionGroupCloneCommand(cmd, serverLink);
      break;
    case SESSION_GROUP_CLONE_MSG.CANCEL:
      handleSessionGroupCloneCancel(cmd, serverLink);
      break;
    case DAEMON_COMMAND_TYPES.SESSION_UPDATE_TRANSPORT_CONFIG:
      void handleSessionTransportConfigUpdate(cmd, serverLink);
      break;
    case 'session.send':
      void handleSend(cmd, serverLink);
      break;
    case 'session.edit_queued_message':
      void handleEditQueuedTransportMessage(cmd, serverLink);
      break;
    case 'session.undo_queued_message':
      void handleUndoQueuedTransportMessage(cmd, serverLink);
      break;
    case 'session.input':
      void handleInput(cmd);
      break;
    case 'session.resize':
      void handleResize(cmd);
      break;
    case 'get_sessions':
      handleGetSessions(serverLink);
      break;
    case 'terminal.subscribe':
      traceSync('web_command.terminal_subscribe', {
        sessionName: typeof cmd.sessionName === 'string' ? cmd.sessionName : undefined,
      }, () => handleSubscribe(cmd, serverLink));
      break;
    case 'terminal.unsubscribe':
      traceSync('web_command.terminal_unsubscribe', {
        sessionName: typeof cmd.sessionName === 'string' ? cmd.sessionName : undefined,
      }, () => handleUnsubscribe(cmd));
      break;
    case 'terminal.snapshot_request':
      handleSnapshotRequest(cmd);
      break;
    case TIMELINE_MESSAGES.REPLAY_REQUEST:
      void traceCommandAsync(cmd, 'web_command.timeline_replay', () => handleTimelineReplay(cmd, serverLink));
      break;
    case TIMELINE_MESSAGES.HISTORY_REQUEST:
      void traceCommandAsync(cmd, 'web_command.timeline_history', () => handleTimelineHistory(cmd, serverLink));
      break;
    case TIMELINE_MESSAGES.PAGE_REQUEST:
      void traceCommandAsync(cmd, 'web_command.timeline_page', () => handleTimelineHistory(cmd, serverLink));
      break;
    case TIMELINE_MESSAGES.DETAIL_REQUEST:
      traceSync('web_command.timeline_detail', {
        sessionName: typeof cmd.sessionName === 'string' ? cmd.sessionName : undefined,
        requestId: typeof cmd.requestId === 'string' ? cmd.requestId : undefined,
      }, () => handleTimelineDetailRequest(cmd, serverLink));
      break;
    case 'chat.subscribe':
      void traceCommandAsync(cmd, 'web_command.chat_subscribe', () => handleChatSubscribeReplay(cmd, serverLink));
      break;
    case TRANSPORT_MSG.APPROVAL_RESPONSE:
      void handleTransportApprovalResponse(cmd, serverLink);
      break;
    case 'subsession.start':
      void handleSubSessionStart(cmd, serverLink);
      break;
    case 'subsession.stop':
      void handleSubSessionStop(cmd, serverLink);
      break;
    case 'subsession.restart':
      void handleSubSessionRestart(cmd, serverLink);
      break;
    case DAEMON_COMMAND_TYPES.SUBSESSION_UPDATE_TRANSPORT_CONFIG:
      void handleSubSessionTransportConfigUpdate(cmd, serverLink);
      break;
    case 'subsession.rebuild_all':
      void traceCommandAsync(cmd, 'web_command.subsession_rebuild_all', () => handleSubSessionRebuildAll(cmd, serverLink));
      break;
    case CLAUDE_QUOTA_MSG.SET_OPT_IN:
      // User authorized (or revoked) reading the local Claude token for the
      // weekly (7d) quota. Off by default; gates the /api/oauth/usage pull.
      setClaudeUsageQuotaOptIn(cmd.enabled === true);
      break;
    case 'subsession.detect_shells':
      void handleSubSessionDetectShells(serverLink);
      break;
    case 'subsession.read_response':
      void handleSubSessionReadResponse(cmd, serverLink);
      break;
    case 'subsession.set_model':
      void handleSubSessionSetModel(cmd, serverLink);
      break;
    case 'subsession.rename': {
      const sName = cmd.sessionName as string | undefined;
      const label = cmd.label === null
        ? null
        : (typeof cmd.label === 'string' ? cmd.label : undefined);
      if (sName && label !== undefined) {
        const record = getSession(sName);
        if (record) {
          const nextLabel = label ?? undefined;
          upsertSession({ ...record, label: nextLabel, updatedAt: Date.now() });
          logger.info({ sessionName: sName, label }, 'subsession.rename: label updated');
          const id = sName.replace(/^deck_sub_/, '');
          void sendSubSessionSync(serverLink, id, { label: nextLabel }).catch(() => {
            // not connected
          });
        }
      }
      break;
    }
    case 'session.rename': {
      const sessionName = cmd.sessionName as string | undefined;
      const projectName = typeof cmd.projectName === 'string' ? cmd.projectName.trim() : '';
      if (sessionName && projectName) {
        const record = getSession(sessionName);
        if (record) {
          upsertSession({ ...record, projectName, updatedAt: Date.now() });
          logger.info({ sessionName, projectName }, 'session.rename: project name updated');
          void buildSessionList().then((sessions) => {
            try {
              serverLink.send({ type: 'session_list', daemonVersion: serverLink.daemonVersion, sessions });
            } catch {
              // not connected
            }
          });
        }
      }
      break;
    }
    case 'session.relabel': {
      const sessionName = cmd.sessionName as string | undefined;
      const label = cmd.label === null
        ? null
        : (typeof cmd.label === 'string' ? cmd.label : undefined);
      if (sessionName && label !== undefined) {
        const record = getSession(sessionName);
        if (record) {
          upsertSession({ ...record, label: label ?? undefined, updatedAt: Date.now() });
          logger.info({ sessionName, label }, 'session.relabel: label updated');
          void buildSessionList().then((sessions) => {
            try {
              serverLink.send({ type: 'session_list', daemonVersion: serverLink.daemonVersion, sessions });
            } catch {
              // not connected
            }
          });
        }
      }
      break;
    }
    case 'ask.answer':
      void handleAskAnswer(cmd, serverLink);
      break;
    case 'discussion.start':
      void handleDiscussionStart(cmd, serverLink);
      break;
    case 'discussion.status':
      handleDiscussionStatus(cmd, serverLink);
      break;
    case P2P_WORKFLOW_MSG.LIST_DISCUSSIONS:
      void traceCommandAsync(cmd, 'web_command.p2p_list_discussions', () => handleP2pListDiscussions(cmd, serverLink));
      break;
    case P2P_WORKFLOW_MSG.READ_DISCUSSION:
      void traceCommandAsync(cmd, 'web_command.p2p_read_discussion', () => handleP2pReadDiscussion(cmd, serverLink));
      break;
    case 'discussion.stop':
      void handleDiscussionStop(cmd);
      break;
    case P2P_CONFIG_MSG.SAVE:
      void handleP2pConfigSave(cmd, serverLink);
      break;
    case 'discussion.list':
      handleDiscussionList(serverLink);
      break;
    case DAEMON_COMMAND_TYPES.SERVER_DELETE:
      void handleServerDelete();
      break;
    case DAEMON_COMMAND_TYPES.DAEMON_UPGRADE:
      try {
        const normalizedTarget = normalizeDaemonUpgradeTargetVersion(cmd.targetVersion);
        void handleDaemonUpgrade(
          normalizedTarget === DAEMON_UPGRADE_TARGET_LATEST ? undefined : normalizedTarget,
          serverLink,
        );
      } catch {
        logger.warn({ targetVersion: cmd.targetVersion }, 'daemon.upgrade rejected invalid targetVersion');
      }
      break;
    case 'file.search':
      void traceCommandAsync(cmd, 'web_command.file_search', () => handleFileSearch(cmd, serverLink));
      break;
    case MEMORY_WS.SEARCH:
      void traceCommandAsync(cmd, 'web_command.memory_search', () => handleMemorySearch(cmd, serverLink));
      break;
    case MEMORY_WS.ARCHIVE:
      void handleMemoryArchive(cmd, serverLink);
      break;
    case MEMORY_WS.RESTORE:
      void handleMemoryRestore(cmd, serverLink);
      break;
    case MEMORY_WS.CREATE:
      void handleMemoryCreate(cmd, serverLink);
      break;
    case MEMORY_WS.UPDATE:
      void handleMemoryUpdate(cmd, serverLink);
      break;
    case MEMORY_WS.PIN:
      void handleMemoryPin(cmd, serverLink);
      break;
    case MEMORY_WS.DELETE:
      void handleMemoryDelete(cmd, serverLink);
      break;
    case MEMORY_WS.GET_SOURCES_REQUEST:
      void handleMemoryGetSourcesRequest(cmd, serverLink);
      break;
    case 'fs.ls':
      void traceCommandAsync(cmd, 'web_command.fs_ls', () => handleFsList(cmd, serverLink));
      break;
    case 'fs.read':
      void handleFsRead(cmd, serverLink);
      break;
    case 'fs.git_status':
      void traceCommandAsync(cmd, 'web_command.fs_git_status', () => handleFsGitStatus(cmd, serverLink));
      break;
    case 'fs.git_diff':
      void traceCommandAsync(cmd, 'web_command.fs_git_diff', () => handleFsGitDiff(cmd, serverLink));
      break;
    case 'fs.mkdir':
      void handleFsMkdir(cmd, serverLink);
      break;
    case 'fs.write':
      void handleFsWrite(cmd, serverLink);
      break;
    case P2P_WORKFLOW_MSG.CANCEL:
      void handleP2pCancel(cmd, serverLink);
      break;
    case P2P_WORKFLOW_MSG.STATUS:
      void traceCommandAsync(cmd, 'web_command.p2p_status', () => handleP2pStatus(cmd, serverLink));
      break;
    case CC_PRESET_MSG.LIST:
      void handleCcPresetsList(serverLink);
      break;
    case CC_PRESET_MSG.SAVE:
      void handleCcPresetsSave(cmd, serverLink).catch((err) => {
        logger.error({ err }, 'Unhandled CC preset save failure');
      });
      break;
    case CC_PRESET_MSG.DISCOVER_MODELS:
      void handleCcPresetsDiscoverModels(cmd, serverLink);
      break;
    case SHARED_CONTEXT_RUNTIME_CONFIG_MSG.APPLY:
      void handleSharedContextRuntimeConfigApply(cmd);
      break;
    case MEMORY_FEATURE_CONFIG_MSG.APPLY:
      handleMemoryFeatureConfigApply(cmd);
      break;
    case MEMORY_WS.PERSONAL_QUERY:
      void handlePersonalMemoryQuery(cmd, serverLink);
      break;
    case MEMORY_WS.PROJECT_RESOLVE:
      void handleMemoryProjectResolve(cmd, serverLink);
      break;
    case MEMORY_WS.FEATURES_QUERY:
      handleMemoryFeaturesQuery(cmd, serverLink);
      break;
    case MEMORY_WS.FEATURES_SET:
      handleMemoryFeaturesSet(cmd, serverLink);
      break;
    case MEMORY_WS.MCP_STATUS_QUERY:
      handleMemoryMcpStatusQuery(cmd, serverLink);
      break;
    case MEMORY_WS.PREF_QUERY:
      void traceCommandAsync(cmd, 'web_command.memory_pref_query', () => handleMemoryPreferencesQuery(cmd, serverLink));
      break;
    case MEMORY_WS.PREF_CREATE:
      void handleMemoryPreferenceCreate(cmd, serverLink);
      break;
    case MEMORY_WS.PREF_UPDATE:
      void handleMemoryPreferenceUpdate(cmd, serverLink);
      break;
    case MEMORY_WS.PREF_DELETE:
      void handleMemoryPreferenceDelete(cmd, serverLink);
      break;
    case MEMORY_WS.SKILL_QUERY:
      void traceCommandAsync(cmd, 'web_command.memory_skill_query', () => handleMemorySkillsQuery(cmd, serverLink));
      break;
    case MEMORY_WS.SKILL_REBUILD:
      void handleMemorySkillsRebuild(cmd, serverLink);
      break;
    case MEMORY_WS.SKILL_READ:
      void handleMemorySkillRead(cmd, serverLink);
      break;
    case MEMORY_WS.SKILL_DELETE:
      void handleMemorySkillDelete(cmd, serverLink);
      break;
    case MEMORY_WS.MD_INGEST_RUN:
      void handleMemoryMarkdownIngestRun(cmd, serverLink);
      break;
    case MEMORY_WS.OBSERVATION_QUERY:
      void traceCommandAsync(cmd, 'web_command.memory_observation_query', () => handleMemoryObservationsQuery(cmd, serverLink));
      break;
    case MEMORY_WS.OBSERVATION_UPDATE:
      void handleMemoryObservationUpdate(cmd, serverLink);
      break;
    case MEMORY_WS.OBSERVATION_DELETE:
      void handleMemoryObservationDelete(cmd, serverLink);
      break;
    case MEMORY_WS.OBSERVATION_PROMOTE:
      void handleMemoryObservationPromote(cmd, serverLink);
      break;
    case 'file.upload':
      void handleFileUpload(cmd, serverLink);
      break;
    case 'file.upload_fetch':
      void handleFileUploadFetch(cmd, serverLink);
      break;
    case 'file.download':
      void handleFileDownload(cmd, serverLink);
      break;
    case TRANSPORT_MSG.LIST_SESSIONS:
      void handleListProviderSessions(cmd, serverLink);
      break;
    case CRON_MSG.DISPATCH:
      void executeCronJob(cmd as unknown as import('../../shared/cron-types.js').CronDispatchMessage, serverLink);
      break;
    case PREVIEW_MSG.REQUEST:
    case PREVIEW_MSG.REQUEST_END:
    case PREVIEW_MSG.CLOSE:
    case PREVIEW_MSG.ABORT:
    case PREVIEW_MSG.WS_OPEN:
    case PREVIEW_MSG.WS_CLOSE:
      if (handlePreviewCommand(cmd, serverLink)) break;
      break;
    case 'auth_ok':
    case 'heartbeat':
    case 'heartbeat_ack':
    case 'ping':
    case 'pong':
      // Expected internal messages, ignore silently
      break;
    case 'openclaw.list_sessions':
      void (async () => {
        try {
          const sessions = await listProviderSessions('openclaw');
          serverLink.send({ type: 'openclaw.sessions_response', sessions });
        } catch (err) {
          logger.warn({ err }, 'openclaw.list_sessions failed');
          serverLink.send({ type: 'openclaw.sessions_response', sessions: [] });
        }
      })();
      break;
    case 'transport.list_models':
      void traceCommandAsync(cmd, 'web_command.transport_list_models', () => handleTransportListModels(cmd, serverLink));
      break;
    case REPO_MSG.DETECT:
      void traceCommandAsync(cmd, 'web_command.repo_detect', async () => { handleRepoCommand(cmd, serverLink); });
      break;
    case REPO_MSG.LIST_ISSUES:
    case REPO_MSG.LIST_PRS:
    case REPO_MSG.LIST_BRANCHES:
    case REPO_MSG.LIST_COMMITS:
    case REPO_MSG.LIST_ACTIONS:
    case REPO_MSG.CHECKOUT_BRANCH:
    case REPO_MSG.ACTION_DETAIL:
    case REPO_MSG.COMMIT_DETAIL:
    case REPO_MSG.PR_DETAIL:
    case REPO_MSG.ISSUE_DETAIL:
      void handleRepoCommand(cmd, serverLink);
      break;
    default:
      if (typeof cmd.type === 'string') {
        logger.warn({ type: cmd.type }, 'Unknown web command type');
      }
  }
}

async function handleP2pConfigSave(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  const scopeSession = typeof cmd.scopeSession === 'string' ? cmd.scopeSession.trim() : '';
  const config = cmd.config;
  if (!scopeSession || !isP2pSavedConfig(config)) {
    if (requestId) {
      serverLink?.send({
        type: P2P_CONFIG_MSG.SAVE_RESPONSE,
        requestId,
        scopeSession,
        ok: false,
        error: P2P_CONFIG_ERROR.INVALID_CONFIG,
      });
    }
    return;
  }
  try {
    await upsertSavedP2pConfig(getP2pConfigStoreScope(serverLink, scopeSession), config);
    if (requestId) {
      serverLink?.send({
        type: P2P_CONFIG_MSG.SAVE_RESPONSE,
        requestId,
        scopeSession,
        ok: true,
      });
    }
  } catch (err) {
    logger.warn({ err, scopeSession }, 'Failed to persist daemon-local P2P config');
    if (requestId) {
      serverLink?.send({
        type: P2P_CONFIG_MSG.SAVE_RESPONSE,
        requestId,
        scopeSession,
        ok: false,
        error: P2P_CONFIG_ERROR.PERSIST_FAILED,
      });
    }
  }
}

async function handleInbound(cmd: Record<string, unknown>): Promise<void> {
  const msg = cmd.msg as InboundMessage | undefined;
  if (!msg) {
    logger.warn('inbound: missing msg payload');
    return;
  }
  if (!routerCtx) {
    logger.warn('inbound: router context not set, dropping message');
    return;
  }
  try {
    await routeMessage(msg, routerCtx);
  } catch (err) {
    logger.error({ err, platform: msg.platform, channelId: msg.channelId }, 'inbound: routeMessage failed');
  }
}

// sanitizeProjectName moved to shared/sanitize-project-name.ts

async function handleStart(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawProject = cmd.project as string | undefined;
  const agentType = (cmd.agentType as string) || 'claude-code';
  const dir = expandTilde((cmd.dir as string) || '~');
  const ccPresetName = cmd.ccPreset as string | undefined;
  const ccInitPrompt = cmd.ccInitPrompt as string | undefined;
  const requestedModel = (cmd.requestedModel as string | undefined) ?? (cmd.model as string | undefined);
  const requestedEffort: unknown = cmd.thinking ?? cmd.effort;
  const effort = isTransportEffortLevel(requestedEffort)
    ? requestedEffort
    : getDefaultThinkingLevel(agentType);

  if (!rawProject) {
    logger.warn('session.start: missing project name');
    return;
  }
  const project = sanitizeProjectName(rawProject);
  const sessionName = `deck_${project}_brain`;
  // Preserve original name as label when sanitization changes it (e.g. Chinese characters)
  const label = project !== rawProject.trim().toLowerCase() ? rawProject.trim() : undefined;
  if (isKnownTestSessionName(sessionName) || isKnownTestProjectName(rawProject)) {
    const message = `Refusing to start known test session pattern: ${sessionName}`;
    logger.warn({ rawProject, project, dir, agentType }, 'session.start rejected by test-session guard');
    try { serverLink.send({ type: 'session.error', project, message }); } catch { /* ignore */ }
    return;
  }

  try {
    // Resolve CC env preset if specified
    let extraEnv: Record<string, string> | undefined;
    if (ccPresetName && (agentType === 'claude-code' || agentType === 'claude-code-sdk')) {
      const { resolvePresetEnv } = await import('./cc-presets.js');
      extraEnv = await resolvePresetEnv(ccPresetName);
    }

    // Reject duplicate main-session starts for an existing project/session namespace.
    const existingByProject = listSessions(project).filter((s) => s.role === 'brain' && s.state !== 'stopped');
    if (existingByProject.length > 0) {
      const message = `Session already exists for project ${project}. Stop or restart it instead of starting a duplicate.`;
      logger.warn({ project, dir, agentType, existing: existingByProject.map((s) => s.name) }, 'session.start rejected because project already has an active main session');
      try { serverLink.send({ type: 'session.error', project, message }); } catch { /* ignore */ }
      return;
    }
    if (agentType === 'claude-code-sdk' || agentType === 'codex-sdk' || agentType === 'copilot-sdk' || agentType === 'cursor-headless' || agentType === 'gemini-sdk' || agentType === 'kimi-sdk') {
      logger.info({ project, agentType }, 'SDK fresh session.start removing stale main-session store record');
      removeSession(`deck_${project}_brain`);
    }
    const config: ProjectConfig = {
      name: project,
      dir,
      brainType: agentType as ProjectConfig['brainType'],
      workerTypes: [],
      label,
      fresh: agentType === 'claude-code-sdk' || agentType === 'codex-sdk' || agentType === 'gemini-sdk' || agentType === 'kimi-sdk',
      extraEnv,
      ccPreset: ccPresetName,
      effort,
    };
    if (agentType === 'claude-code-sdk') {
      logger.info({ project }, 'SDK fresh session.start launching new Claude SDK main session');
      await launchTransportSession({
        name: `deck_${project}_brain`,
        projectName: project,
        role: 'brain',
        agentType: 'claude-code-sdk',
        projectDir: dir,
        fresh: true,
        ccSessionId: randomUUID(),
        extraEnv,
        ccPreset: ccPresetName,
        ...(requestedModel ? { requestedModel } : {}),
        label,
        effort,
      });
    } else if (agentType === 'codex-sdk') {
      logger.info({ project }, 'SDK fresh session.start launching new Codex SDK main session');
      await launchTransportSession({
        name: `deck_${project}_brain`,
        projectName: project,
        role: 'brain',
        agentType: 'codex-sdk',
        projectDir: dir,
        fresh: true,
        ...(requestedModel ? { requestedModel } : {}),
        label,
        effort,
      });
    } else if (agentType === 'copilot-sdk' || agentType === 'cursor-headless') {
      logger.info({ project, agentType }, 'SDK fresh session.start launching new transport main session');
      await launchTransportSession({
        name: `deck_${project}_brain`,
        projectName: project,
        role: 'brain',
        agentType: agentType as 'copilot-sdk' | 'cursor-headless',
        projectDir: dir,
        fresh: true,
        ...(requestedModel ? { requestedModel } : {}),
        label,
        effort,
      });
    } else if (agentType === 'gemini-sdk' || agentType === 'kimi-sdk') {
      // ACP SDK providers share the codex-sdk shape: fresh launch, optional
      // requested model, no ccPreset. The provider emits a durable resume id
      // after the first real ACP session is created.
      logger.info({ project, agentType }, 'SDK fresh session.start launching ACP SDK main session');
      await launchTransportSession({
        name: `deck_${project}_brain`,
        projectName: project,
        role: 'brain',
        agentType: agentType as 'gemini-sdk' | 'kimi-sdk',
        projectDir: dir,
        fresh: true,
        ...(requestedModel ? { requestedModel } : {}),
        label,
        effort,
      });
    } else if (agentType === 'qwen') {
      logger.info({ project }, 'SDK fresh session.start launching new Qwen main session');
      await launchTransportSession({
        name: `deck_${project}_brain`,
        projectName: project,
        role: 'brain',
        agentType: 'qwen',
        projectDir: dir,
        fresh: true,
        ...(ccPresetName ? { ccPreset: ccPresetName } : {}),
        ...(requestedModel ? { requestedModel } : {}),
        label,
        effort,
      });
    } else {
      await startProject(config);
    }
    logger.info({ project }, 'Session started via web');

    // Inject preset init message after session starts
    if (agentType === 'claude-code' && (ccPresetName || ccInitPrompt)) {
      const brainSession = `deck_${project}_brain`;
      const parts: string[] = [];
      if (ccPresetName) {
        const { getPreset, getPresetInitMessage } = await import('./cc-presets.js');
        const preset = await getPreset(ccPresetName);
        if (preset) parts.push(getPresetInitMessage(preset));
      }
      if (ccInitPrompt) parts.push(ccInitPrompt);
      if (parts.length > 0) {
        const msg = `[Context — absorb silently, do not respond to this message]\n${parts.join('\n\n')}`;
        setTimeout(async () => {
          try { await sendKeysDelayedEnter(brainSession, msg); } catch { /* session may not be ready */ }
        }, 5000);
      }
    }
  } catch (err) {
    logger.error({ project, err }, 'session.start failed');
    const message = err instanceof Error ? err.message : String(err);
    try { serverLink.send({ type: 'session.error', project, message }); } catch { /* ignore */ }
  }
}

async function handleRestart(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  if (sessionName) {
    const record = getSession(sessionName);
    if (!record) {
      logger.warn({ sessionName }, 'session.restart: session not found in store');
      return;
    }
    try {
      await runExclusiveSessionRelaunch(sessionName, async () => {
        try {
          await relaunchSessionWithSettings(record, {
            agentType: (cmd.agentType as any) ?? undefined,
            projectDir: ('cwd' in cmd ? (cmd.cwd as string | undefined) : undefined),
            label: ('label' in cmd ? (cmd.label as string | null) : undefined),
            description: ('description' in cmd ? (cmd.description as string | null) : undefined),
            requestedModel: ('requestedModel' in cmd ? (cmd.requestedModel as string | null) : undefined),
            effort: ('effort' in cmd ? (cmd.effort as any) : undefined),
            transportConfig: ('transportConfig' in cmd ? (cmd.transportConfig as Record<string, unknown> | null) : undefined),
          });
          await handleGetSessions(serverLink);
          logger.info({ sessionName, agentType: cmd.agentType ?? record.agentType }, 'Session relaunched via settings');
        } catch (err) {
          logger.error({ sessionName, err }, 'session.restart(sessionName) failed');
          const message = err instanceof Error ? err.message : String(err);
          emitSessionInlineError(sessionName, message);
          try { serverLink.send({ type: 'session.error', project: record.projectName, message }); } catch { /* ignore */ }
          await handleGetSessions(serverLink);
          throw err;
        }
      });
    } catch {
      // Failure already surfaced via session.error + corrective session_list.
    }
    return;
  }

  const project = cmd.project as string | undefined;
  const fresh = cmd.fresh === true;
  if (!project) {
    logger.warn('session.restart: missing project name');
    return;
  }

  const sessions = listSessions(project);
  if (!sessions.length) {
    logger.warn({ project }, 'session.restart: no sessions found for project');
    return;
  }

  const brain = sessions.find((s) => s.role === 'brain');
  if (!brain) {
    logger.warn({ project }, 'session.restart: no brain session found');
    return;
  }

  try {
    // Teardown: kill tmux + watchers but keep store records so they survive failures
    await teardownProject(project);
    const config: ProjectConfig = {
      name: project,
      dir: brain.projectDir,
      brainType: brain.agentType as ProjectConfig['brainType'],
      workerTypes: sessions
        .filter((s) => s.role !== 'brain')
        .map((s) => s.agentType as ProjectConfig['brainType']),
      fresh,
    };
    await startProject(config);
    logger.info({ project, fresh }, 'Session restarted via web');
  } catch (err) {
    logger.error({ project, err }, 'session.restart failed');
    const message = err instanceof Error ? err.message : String(err);
    emitSessionInlineError(brain.name, message);
    try { serverLink.send({ type: 'session.error', project, message }); } catch { /* ignore */ }
  }
}

async function handleStop(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const project = cmd.project as string | undefined;
  if (!project) {
    logger.warn('session.stop: missing project name');
    return;
  }

  let result;
  try {
    result = await stopProject(project, serverLink);
  } catch (err) {
    logger.error({ project, err }, 'session.stop failed');
    const message = err instanceof Error ? err.message : String(err);
    try { serverLink.send({ type: 'session.error', project, message: `Shutdown failed: ${message}` }); } catch { /* ignore */ }
    return;
  }

  if (result.ok) {
    logger.info({ project }, 'Session stopped via web');
    return;
  }

  const message = result.failed
    .map((failure) => `${failure.sessionName}:${failure.stage}`)
    .join(', ');
  logger.warn({ project, failed: result.failed }, 'session.stop completed with shutdown failures');
  try { serverLink.send({ type: 'session.error', project, message: `Shutdown failed: ${message}` }); } catch { /* ignore */ }
}

function resolveSessionCommandName(cmd: Record<string, unknown>): string | undefined {
  return (typeof cmd.sessionName === 'string' && cmd.sessionName)
    ? cmd.sessionName
    : (typeof cmd.session === 'string' && cmd.session ? cmd.session : undefined);
}

function markTransportCancelIdle(sessionName: string, error?: string): void {
  const runtime = getTransportRuntime(sessionName);
  timelineEmitter.emit(sessionName, 'session.state', {
    state: 'idle',
    pendingCount: runtime?.pendingCount ?? 0,
    pendingMessages: runtime?.pendingMessages ?? [],
    pendingMessageEntries: runtime?.pendingEntries ?? [],
    pendingMessageVersion: runtime?.pendingVersion ?? 0,
    ...(error ? { error } : {}),
  }, { source: 'daemon', confidence: 'high' });
}

function emitSessionControlTimelineFeedback(sessionName: string, controlId: 'stop'): void {
  const feedback = getSessionControlTimelineFeedbackById(controlId);
  if (!feedback) return;
  timelineEmitter.emit(sessionName, 'session.state', {
    state: feedback.state,
    reason: feedback.reason,
  }, { source: 'daemon', confidence: 'high' });
}

function cancelTransportTurnNow(
  sessionName: string,
  commandId: string | undefined,
  serverLink: Pick<ServerLink, 'send'> | undefined,
): boolean {
  const stopRuntime = getTransportRuntime(sessionName);
  const stopRecord = getSession(sessionName);
  const isTransportStop = !!stopRuntime
    || stopRecord?.runtimeType === 'transport'
    || (typeof stopRecord?.agentType === 'string' && isTransportAgent(stopRecord.agentType));
  if (!isTransportStop) return false;

  clearResend(sessionName);
  if (commandId) emitCommandAck(sessionName, commandId, 'accepted', undefined, serverLink);
  emitSessionControlTimelineFeedback(sessionName, 'stop');
  markTransportCancelIdle(sessionName);

  if (!stopRuntime) return true;

  // STOP IS THE PRIORITY LANE.
  // Do not acquire getMutex(sessionName), do not call transportRuntime.send('/stop'),
  // and do not wait for provider/model/context work here. This path must cut
  // in front of queued sends and long pre-send work (startup memory, semantic
  // recall, authored context, provider send-start). Regressions are locked by:
  // - test/daemon/command-handler-transport-queue.test.ts
  // - test/daemon/transport-session-runtime.test.ts
  // - web/test/components/SessionControls.test.tsx
  void (async () => {
    try {
      supervisionAutomation.cancelSession(sessionName);
      await stopRuntime.cancel();
      // Mark session for fresh start so daemon restart doesn't resume the
      // stuck conversation.
      if (stopRecord?.agentType === 'qwen') {
        upsertSession({ ...stopRecord, qwenFreshOnResume: true, updatedAt: Date.now() });
      }
    } catch (err) {
      const errMsg = describeTransportSendError(err);
      logger.error({ sessionName, err }, 'session.cancel (transport) failed');
      timelineEmitter.emit(sessionName, 'assistant.text', { text: `⚠️ Stop failed: ${errMsg}`, streaming: false, memoryExcluded: true }, { source: 'daemon', confidence: 'high' });
      markTransportCancelIdle(sessionName, errMsg);
    }
  })();

  return true;
}

async function handleSessionCancel(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = resolveSessionCommandName(cmd);
  const commandId = typeof cmd.commandId === 'string' && cmd.commandId.trim()
    ? cmd.commandId.trim()
    : undefined;
  if (!sessionName) {
    logger.warn('session.cancel: missing sessionName');
    return;
  }

  if (cancelTransportTurnNow(sessionName, commandId, serverLink)) return;

  const errMsg = 'Transport session unavailable';
  logger.warn({ sessionName }, 'session.cancel: session is not a transport session');
  if (commandId) emitCommandAck(sessionName, commandId, 'error', errMsg, serverLink);
}

/**
 * Send a command to a session, handling `!`-prefixed shell commands:
 * - claude-code: send `!` first (with delayed-Enter), then send the rest of the command
 * - codex: strip `!` and send the shell command directly (Codex has no `!` prefix)
 * - others: send as-is
 */
/** Agents with sandboxed file access — temp files must be in project dir. */
const SANDBOXED_AGENTS = new Set(['gemini']);

async function sendShellAwareCommand(sessionName: string, text: string, agentType: string): Promise<void> {
  const record = getSession(sessionName);
  const cwd = SANDBOXED_AGENTS.has(agentType) ? record?.projectDir : undefined;
  const opts = cwd ? { cwd } : undefined;
  if (text.startsWith('!')) {
    const shellCmd = text.slice(1).trimStart();
    if (agentType === 'codex') {
      // Codex: just send the shell command without `!`
      await sendKeysDelayedEnter(sessionName, shellCmd, opts);
    } else {
      // claude-code (and others): send `!` first to enter shell mode, then the command
      await sendKeysDelayedEnter(sessionName, '!', opts);
      await new Promise((r) => setTimeout(r, 300));
      await sendKeysDelayedEnter(sessionName, shellCmd, opts);
    }
  } else {
    await sendKeysDelayedEnter(sessionName, text, opts);
  }
}

function resolveSingleTargetMode(
  targetSession: string,
  requestedMode: string,
  sessionConfig?: P2pSessionConfig,
): string {
  if (requestedMode !== P2P_CONFIG_MODE) return requestedMode;
  const configuredMode = sessionConfig?.[targetSession]?.mode;
  return configuredMode && configuredMode !== 'skip' ? configuredMode : 'discuss';
}

type PreparedAdvancedWorkflowLaunch =
  | {
      ok: true;
      advancedRounds: P2pAdvancedRound[];
      advancedRunTimeoutMs?: number;
      contextReducer?: P2pContextReducerConfig;
      diagnostics: P2pWorkflowDiagnostic[];
      /**
       * Audit:V-1 / N-H1 — when present, the bound workflow flowed through
       * compile + bind. Caller MUST pass `advanced: { kind: 'envelope_compiled', bound, ... }`
       * to `startP2pRun` so the orchestrator surfaces capabilitySnapshot/policy
       * on the run state. Absent on legacy passthrough (no envelope).
       */
      bound?: P2pBoundWorkflow;
    }
  | { ok: false; diagnostics: P2pWorkflowDiagnostic[] };

function hasOldAdvancedLaunchFields(cmd: Record<string, unknown>): boolean {
  return cmd.p2pAdvancedPresetKey != null
    || cmd.p2pAdvancedRounds != null
    || cmd.p2pAdvancedRunTimeoutMinutes != null
    || cmd.p2pContextReducer != null;
}

function roundPresetFromWorkflowPreset(node: Pick<P2pWorkflowNodeDraft, 'preset'>): P2pRoundPreset {
  if (
    node.preset === 'openspec_propose'
    || node.preset === 'proposal_audit'
    || node.preset === 'implementation'
    || node.preset === 'implementation_audit'
    || node.preset === 'custom'
  ) {
    return node.preset;
  }
  return 'discussion';
}

/**
 * R3 PR-α (A2 / Cu1-N3) — order compiled nodes for legacy executor traversal.
 *
 * The previous implementation sorted by `node.id.localeCompare`, which made
 * round execution order depend on lexical id spelling rather than the
 * compiled `rootNodeId` + edges topology. That violated spec
 * "Workflow rootNodeId SHALL define execution start" and produced
 * non-deterministic order across renames. We now traverse from
 * `workflow.rootNodeId` along DEFAULT edges, then append any unreachable
 * nodes in declaration order so the legacy projection still surfaces them.
 */
export function orderCompiledNodesForExecution(workflow: P2pCompiledWorkflow): P2pCompiledNode[] {
  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const ordered: P2pCompiledNode[] = [];
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    const node = nodesById.get(nodeId);
    if (!node) return;
    visited.add(nodeId);
    ordered.push(node);
    const outgoing = workflow.edges
      .filter((edge) => edge.fromNodeId === nodeId && edge.edgeKind === 'default')
      .map((edge) => edge.toNodeId);
    for (const next of outgoing) visit(next);
  };
  if (workflow.rootNodeId) visit(workflow.rootNodeId);
  // Defensive: append any unreachable nodes in declaration order so the
  // legacy projection still surfaces them. Compiler MUST reject unreachable
  // graphs; this is just a safety net for adapter consumers.
  for (const node of workflow.nodes) {
    if (!visited.has(node.id)) ordered.push(node);
  }
  return ordered;
}

/**
 * R3 PR-α (Cu1-N3) — Map a single compiled outgoing conditional edge to the
 * legacy `jumpRule` shape. Returns undefined when the node has no conditional
 * outgoing edge or when no loop budget is registered. Marker preserves the
 * raw `condition.equals` string instead of compressing every non-`PASS`
 * marker to `'REWORK'`; non-`PASS|REWORK` markers fall back to `'REWORK'`
 * because the legacy `P2pVerdictMarker` union accepts only those two values.
 * The new envelope_compiled executor (PR-β) bypasses this adapter entirely
 * and reads `condition` directly, so the legacy compression is bounded to
 * oldAdvanced surfaces.
 */
export function mapConditionalEdgeToJumpRule(
  conditionalEdge: P2pCompiledEdge | undefined,
  loopBudgets: Record<string, number>,
): { jumpRule: P2pAdvancedRound['jumpRule']; verdictPolicy: P2pAdvancedRound['verdictPolicy'] } {
  if (!conditionalEdge) return { jumpRule: undefined, verdictPolicy: 'none' };
  const loopBudget = loopBudgets[conditionalEdge.id];
  const rawMarker = conditionalEdge.condition?.equals;
  const marker: 'PASS' | 'REWORK' = rawMarker === 'PASS' ? 'PASS' : 'REWORK';
  if (loopBudget === undefined) {
    // No registered loop budget → emit `forced_rework` policy without a
    // jumpRule so the legacy projection records routing intent without
    // letting orchestrator loop indefinitely.
    return { jumpRule: undefined, verdictPolicy: 'forced_rework' };
  }
  return {
    jumpRule: {
      targetRoundId: conditionalEdge.toNodeId,
      marker,
      minTriggers: 0,
      maxTriggers: loopBudget,
    },
    verdictPolicy: 'forced_rework',
  };
}

/**
 * R3 PR-α (A1 / W3 / Cu1-N3) — Map a compiled node to a legacy
 * `P2pAdvancedRound`, preserving `nodeKind`, `script`, `routingAuthority`,
 * and `artifactConvention` so the orchestrator can dispatch / recheck without
 * a sidecar `bound.compiled.nodes.find(...)` lookup.
 */
export function mapCompiledNodeToLegacyRound(
  node: P2pCompiledNode,
  workflow: P2pCompiledWorkflow,
): P2pAdvancedRound {
  const conditionalEdge = workflow.edges.find((edge) => edge.fromNodeId === node.id && edge.edgeKind === 'conditional');
  const { jumpRule, verdictPolicy } = mapConditionalEdgeToJumpRule(conditionalEdge, workflow.loopBudgets);
  // R3 PR-α (W3) — preserve the FIRST artifact contract's convention so the
  // orchestrator can decide between `openspec_convention` (per-file sha256
  // baseline + frozen identity) and `explicit_paths` (legacy sha256 listing).
  // Multi-contract nodes are not allowed in v1a; compiler enforces.
  const artifactConvention: 'none' | 'explicit' | 'openspec_convention' | undefined =
    node.artifacts.length > 0
      ? (node.artifacts[0].convention as 'explicit' | 'openspec_convention')
      : undefined;
  /*
   * R3 v2 PR-μ — Resolve the per-round summary prompt:
   *   1. Use the user's `summaryPromptOverride` (canvas inspector) when set.
   *   2. Fall back to `P2P_PRESET_DEFAULT_SUMMARY_PROMPT[node.preset]`.
   * The legacy round carries the resolved string in
   * `effectiveSummaryPrompt` so `normalizeAdvancedRound` can force the
   * summary phase on EVERY workflow round, including single_main nodes
   * that previously had `synthesisStyle='none'`.
   */
  const effectiveSummaryPrompt = (node.summaryPromptOverride ?? '').trim().length > 0
    ? (node.summaryPromptOverride ?? '').trim()
    : P2P_PRESET_DEFAULT_SUMMARY_PROMPT[node.preset];
  return {
    id: node.id,
    title: node.title ?? node.id,
    preset: roundPresetFromWorkflowPreset(node),
    executionMode: node.dispatchStyle === 'multi_dispatch' ? 'multi_dispatch' : 'single_main',
    permissionScope: node.permissionScope,
    ...(node.promptAppend ? { promptAppend: node.promptAppend } : {}),
    ...(node.artifacts.length > 0 ? { artifactOutputs: node.artifacts.flatMap((artifact) => artifact.paths).sort() } : {}),
    verdictPolicy,
    ...(jumpRule ? { jumpRule } : {}),
    // R3 PR-α (A1 / W3) — compiled-node carriers preserved on the legacy
    // round model so downstream consumers can read authoritative semantics.
    nodeKind: node.nodeKind,
    ...(node.script ? { script: node.script } : {}),
    ...(node.routingAuthority ? { routingAuthority: node.routingAuthority } : {}),
    ...(artifactConvention ? { artifactConvention } : {}),
    ...(effectiveSummaryPrompt ? { effectiveSummaryPrompt } : {}),
  } satisfies P2pAdvancedRound;
}

function compiledWorkflowToLegacyAdvancedRounds(workflow: P2pCompiledWorkflow): P2pAdvancedRound[] {
  // R3 PR-α — replaced lexical sort with topological traversal so the
  // execution order honours `rootNodeId` + DEFAULT edges (A2). Field
  // preservation lives in `mapCompiledNodeToLegacyRound` (A1 / W3); jump rule
  // mapping lives in `mapConditionalEdgeToJumpRule` (Cu1-N3 split). Each
  // helper is independently unit-tested.
  return orderCompiledNodesForExecution(workflow).map((node) => mapCompiledNodeToLegacyRound(node, workflow));
}

function buildAdvancedLaunchEnvelopeFromCommand(
  cmd: Record<string, unknown>,
  launchContext: P2pWorkflowLaunchEnvelope['launchContext'],
): P2pWorkflowLaunchEnvelope | null {
  const explicitEnvelope = cmd.p2pWorkflowLaunchEnvelope ?? cmd.workflowLaunchEnvelope;
  if (isPlainRecord(explicitEnvelope)) {
    return explicitEnvelope as unknown as P2pWorkflowLaunchEnvelope;
  }
  if (!hasOldAdvancedLaunchFields(cmd)) return null;
  return {
    workflowSchemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
    workflowKind: 'advanced',
    oldAdvanced: {
      ...(typeof cmd.p2pAdvancedPresetKey === 'string' ? { advancedPresetKey: cmd.p2pAdvancedPresetKey } : {}),
      ...(Array.isArray(cmd.p2pAdvancedRounds) ? { advancedRounds: cmd.p2pAdvancedRounds as Array<Record<string, unknown>> } : {}),
      ...(typeof cmd.p2pAdvancedRunTimeoutMinutes === 'number' ? { advancedRunTimeoutMinutes: cmd.p2pAdvancedRunTimeoutMinutes } : {}),
      ...(isPlainRecord(cmd.p2pContextReducer) ? { contextReducer: cmd.p2pContextReducer } : {}),
    },
    migrationPolicy: { kind: 'materialize_old_advanced' },
    launchContext,
  };
}

// `getCurrentDaemonWorkflowCapabilities` is the single entry point for
// "what capabilities does this daemon currently advertise?". v1a fix
// (audit:N-H2): the fallback when `serverLink.getP2pWorkflowCapabilities` is
// missing now returns `[]` (fail-closed) — previously it returned all three
// dangerous caps as a hardcoded permissive default, which was a fail-OPEN
// authorisation bug. The function itself lives in the daemon static-policy
// module so compile/bind/recheck all share one source.
import {
  loadDaemonP2pStaticPolicy,
  readCachedHelloSnapshot,
} from './p2p-workflow-static-policy.js';

function makeBindRuntimeContext(
  options: {
    runId: string;
    requestId?: string;
    repoRoot: string;
    serverLink: ServerLink;
    policySnapshot: P2pStaticPolicy;
    initiatorSession: string;
    targets: P2pTarget[];
    accepted: boolean;
  },
): P2pBindRuntimeContext {
  const helloSnapshot = readCachedHelloSnapshot(options.serverLink);
  return {
    runId: options.runId,
    requestId: options.requestId,
    repoRoot: options.repoRoot,
    participants: [
      { sessionName: options.initiatorSession },
      ...options.targets.map((target) => ({ sessionName: target.session, roleLabel: target.mode })),
    ],
    launchScope: {
      serverId: typeof options.serverLink.getServerId === 'function' ? options.serverLink.getServerId() : undefined,
      sessionName: options.initiatorSession,
    },
    // Real hello snapshot, not synthesised placeholder (audit:N2). When the
    // daemon hasn't sent a hello yet (`helloEpoch === 0` AND `sentAt === 0`),
    // we still record the actual values so projection consumers can detect
    // "pre-hello bind" instead of being fed a fake `Date.now()` timestamp.
    capabilitySnapshot: helloSnapshot,
    // Audit:R3 PR-α — full P2pStaticPolicy snapshot replaces the previous
    // ad-hoc { allowScript / allowImplementation / ... } subset. The clone
    // ensures runtime mutations to the loaded policy never bleed into a run
    // that was already bound under a different policy version.
    policySnapshot: structuredClone(options.policySnapshot),
    concurrencyAdmission: options.accepted ? { accepted: true } : { accepted: false, reason: 'daemon_busy' },
  };
}

// Audit:R3 hardening / task 10.2 — exported so the cron dispatcher (and any
// future automation entry point) can drive the same envelope→compile→bind
// pipeline as `handleSend`. Keeping a single launch authority is the only way
// to ensure cron and manual launches share `daemon_busy` admission, capability
// gating, and `static_policy_mismatch_recompiled` emission.
export async function prepareAdvancedWorkflowLaunch(options: {
  cmd: Record<string, unknown>;
  sessionName: string;
  targets: P2pTarget[];
  userText: string;
  locale?: string;
  projectDir: string;
  commandId: string;
  serverLink: ServerLink;
}): Promise<PreparedAdvancedWorkflowLaunch> {
  const envelope = buildAdvancedLaunchEnvelopeFromCommand(options.cmd, {
    requestId: options.commandId,
    sessionName: options.sessionName,
    projectRoot: options.projectDir,
    userText: options.userText,
    locale: options.locale,
  });
  if (!envelope) return { ok: true, advancedRounds: [], diagnostics: [] };
  if ((options.cmd.p2pWorkflowLaunchEnvelope || options.cmd.workflowLaunchEnvelope) && hasOldAdvancedLaunchFields(options.cmd)) {
    return { ok: false, diagnostics: [makeP2pWorkflowDiagnostic('mixed_advanced_schema_fields', 'parse')] };
  }
  const envelopeValidation = validateP2pWorkflowLaunchEnvelope(envelope);
  if (!envelopeValidation.ok) return { ok: false, diagnostics: envelopeValidation.diagnostics };

  let draft: P2pWorkflowDraft | undefined = envelope.advancedDraft;
  let contextReducer: P2pContextReducerConfig | undefined;
  if (!draft && envelope.oldAdvanced) {
    if (envelope.migrationPolicy?.kind !== 'materialize_old_advanced') {
      return { ok: false, diagnostics: [makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: 'migrationPolicy' })] };
    }
    try {
      draft = materializeOldAdvancedConfigToWorkflowDraft({
        advancedPresetKey: envelope.oldAdvanced.advancedPresetKey,
        advancedRounds: envelope.oldAdvanced.advancedRounds as P2pAdvancedRound[] | undefined,
        advancedRunTimeoutMinutes: envelope.oldAdvanced.advancedRunTimeoutMinutes,
      });
      contextReducer = envelope.oldAdvanced.contextReducer as P2pContextReducerConfig | undefined;
    } catch (err) {
      return {
        ok: false,
        diagnostics: [makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', {
          summary: err instanceof Error ? err.message : String(err),
        })],
      };
    }
  }
  if (!draft) {
    return { ok: false, diagnostics: [makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: 'advancedDraft' })] };
  }
  const draftValidation = validateP2pWorkflowDraft(draft);
  if (!draftValidation.ok) return { ok: false, diagnostics: draftValidation.diagnostics };

  // Audit:N4 — staticPolicy must derive from the daemon's actual capability
  // advertisement, not from hardcoded permissive overrides. `loadDaemonP2pStaticPolicy`
  // is the single source of truth: allow-flags reflect daemon hello capabilities,
  // and `concurrency.maxAdvancedRuns` / `concurrency.maxScripts` come from the
  // policy default (P2P_WORKFLOW_MAX_ACTIVE_RUNS / P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS).
  const baseStaticPolicy = loadDaemonP2pStaticPolicy(options.serverLink);
  // R3 PR-α follow-up — UI-driven allowlist. When the envelope carries an
  // `allowedExecutables` list (configured in `P2pConfigPanel`), rebuild
  // the policy with that list and recompute the hash so bind validation
  // sees the user-supplied executables. Daemon-side default is `[]`; the
  // envelope is the SOLE source for non-empty allowlists in this product.
  // Removes the previous `~/.imcodes/p2p-policy.json` JSON-file workflow
  // (off-product for a UI-driven IM client).
  const envelopeAllowedExecutables = Array.isArray(envelope.allowedExecutables)
    ? [...new Set(envelope.allowedExecutables.filter((entry) => typeof entry === 'string'))].sort()
    : [];
  const staticPolicy = envelopeAllowedExecutables.length > 0
    ? buildDefaultP2pStaticPolicy({ ...baseStaticPolicy, allowedExecutables: envelopeAllowedExecutables })
    : baseStaticPolicy;
  // Audit:R3 PR-γ / N-M5 / V-4 — when the envelope carries a saved
  // `expectedStaticPolicyHash` (compiled against an earlier policy version)
  // and the daemon's CURRENT policy hash differs, emit
  // `static_policy_mismatch_recompiled` (warning severity) so callers know
  // the preview's compilation result is no longer authoritative. The daemon
  // proceeds with the current policy regardless; this diagnostic only
  // documents that a recompile occurred.
  const policyMismatchDiagnostics: P2pWorkflowDiagnostic[] = [];
  if (
    typeof envelope.expectedStaticPolicyHash === 'string'
    && envelope.expectedStaticPolicyHash.length > 0
    && envelope.expectedStaticPolicyHash !== staticPolicy.policyHash
  ) {
    policyMismatchDiagnostics.push(makeP2pWorkflowDiagnostic('static_policy_mismatch_recompiled', 'bind', {
      fieldPath: 'expectedStaticPolicyHash',
      summary: `Launch envelope referenced static policy ${envelope.expectedStaticPolicyHash} but daemon recompiled with current policy ${staticPolicy.policyHash ?? '<unhashed>'}.`,
    }));
  }
  const compileResult = compileP2pWorkflowDraft(draft, staticPolicy);
  if (!compileResult.ok) {
    return { ok: false, diagnostics: [...policyMismatchDiagnostics, ...compileResult.diagnostics] };
  }

  // Audit:N-H3 — admission cap reads `staticPolicy.concurrency.maxAdvancedRuns`
  // rather than the bare `P2P_WORKFLOW_MAX_ACTIVE_RUNS` constant, so future
  // policy customisation (cron multi-run, supervision, env override) only has
  // to update one place.
  const activeAdvancedRuns = listP2pRuns().filter((run) => run.advancedP2pEnabled && !P2P_TERMINAL_RUN_STATUSES.has(run.status));
  const bindContext = makeBindRuntimeContext({
    runId: randomUUID(),
    requestId: options.commandId,
    repoRoot: options.projectDir,
    serverLink: options.serverLink,
    policySnapshot: staticPolicy,
    initiatorSession: options.sessionName,
    targets: options.targets,
    accepted: activeAdvancedRuns.length < staticPolicy.concurrency.maxAdvancedRuns,
  });
  // Audit:N5 / Q5 (binder API single shape). `bindP2pCompiledWorkflow` always
  // returns the `P2pBindResult` discriminated union — there is no legacy "no
  // ok field" branch. Use the discriminant directly; the dead `else` branch
  // that previously inspected `diagnostics.some(severity==='error')` has been
  // removed. The reverse-regression suite blocks its reintroduction.
  const bindResult = bindP2pCompiledWorkflow(compileResult.workflow, bindContext);
  const bindDiagnostics = bindResult.diagnostics;
  if (!bindResult.ok) {
    // R3 PR-δ (A5 / Cu1-M1) — bind-fail must include any
    // `policyMismatchDiagnostics` so callers learn that the daemon
    // recompiled with the current policy before bind rejected it. Earlier
    // versions returned only `bindDiagnostics`, hiding the
    // `static_policy_mismatch_recompiled` warning from observers.
    return { ok: false, diagnostics: [...policyMismatchDiagnostics, ...bindDiagnostics] };
  }

  return {
    ok: true,
    advancedRounds: compiledWorkflowToLegacyAdvancedRounds(compileResult.workflow),
    advancedRunTimeoutMs: envelope.oldAdvanced?.advancedRunTimeoutMinutes != null
      ? envelope.oldAdvanced.advancedRunTimeoutMinutes * 60_000
      : undefined,
    contextReducer,
    bound: bindResult.bound,
    diagnostics: [
      ...envelopeValidation.diagnostics,
      ...policyMismatchDiagnostics,
      ...compileResult.diagnostics,
      ...bindDiagnostics,
    ],
  };
}

function summarizeP2pWorkflowDiagnostics(diagnostics: P2pWorkflowDiagnostic[]): string {
  return diagnostics.map((diagnostic) => diagnostic.code).join(', ') || 'invalid_launch_envelope';
}

async function handleSend(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = (cmd.sessionName ?? cmd.session) as string | undefined;
  const text = cmd.text as string | undefined;
  const commandId = cmd.commandId as string | undefined;
  const directTargetSession = (cmd as any).directTargetSession as string | undefined;
  const directTargetMode = ((cmd as any).directTargetMode as string | undefined) ?? 'discuss';

  if (!sessionName || !text) {
    logger.warn('session.send: missing sessionName or text');
    return;
  }

  // Only a message to a claude-code-sdk session counts as activity that keeps the
  // Claude usage-quota poll alive (the quota tracks the Claude subscription).
  // Cheap sync Map lookup — does not touch the send hot-path ack latency.
  if (getSession(sessionName)?.agentType === 'claude-code-sdk') recordClaudeQuotaActivity();

  // Fallback: legacy clients that don't send commandId get a server-generated one
  const isLegacy = !commandId;
  const effectiveId = commandId ?? crypto.randomUUID();
  if (isLegacy) {
    logger.warn({ sessionName, effectiveId }, 'session.send: missing commandId — using server-generated fallback');
  }

  // Dedup: reject duplicate commandIds explicitly so the browser/server does
  // not wait for an ack timeout after the daemon has already seen this send.
  const dedup = getDedup(sessionName);
  if (dedup.has(effectiveId)) {
    if ((cmd as any).__bridgeRetry === true) {
      logger.debug({ sessionName, effectiveId }, 'session.send: bridge retry for commandId already owned by daemon, ignored');
      return;
    }
    logger.debug({ sessionName, effectiveId }, 'session.send: duplicate commandId, rejected');
    timelineEmitter.emit(sessionName, 'command.ack', {
      commandId: effectiveId,
      status: 'error',
      error: COMMAND_ACK_ERROR_DUPLICATE_COMMAND_ID,
    });
    emitCommandAckReliable(serverLink, {
      commandId: effectiveId,
      sessionName,
      status: 'error',
      error: COMMAND_ACK_ERROR_DUPLICATE_COMMAND_ID,
    });
    return;
  }
  dedup.add(effectiveId);

// ── P2P routing: structured WS fields (new) or inline @@tokens (legacy) ──
  const clientP2pSessionConfig = (cmd as any).p2pSessionConfig as P2pSessionConfig | undefined;
  let receiptAcked = false;
  const emitAcceptedReceiptAck = (): void => {
    if (receiptAcked) return;
    const status = isLegacy ? 'accepted_legacy' : 'accepted';
    emitCommandAck(sessionName, effectiveId, status, undefined, serverLink);
    receiptAcked = true;
  };
  const emitTransportUserMessage = (payloadText: string, extra?: Record<string, unknown>, eventId?: string) => {
    // Always thread the client commandId through so the web UI can reconcile
    // its optimistic "sending" bubble deterministically. Callers that set
    // `clientMessageId` in `extra` keep their override (legacy path).
    const base: Record<string, unknown> = {
      text: payloadText,
      allowDuplicate: true,
      commandId: effectiveId,
    };
    timelineEmitter.emit(
      sessionName,
      'user.message',
      { ...base, ...(extra ?? {}) },
      eventId ? { source: 'daemon', confidence: 'high', eventId } : undefined,
    );
  };
  const trimmedText = text.trim();
  const wantsStructuredP2pRouting = Boolean(
    clientP2pSessionConfig ||
    (cmd as any).p2pMode ||
    directTargetSession ||
    (Array.isArray((cmd as any).p2pAtTargets) && (cmd as any).p2pAtTargets.length > 0),
  );
  const wantsLegacyP2pRouting = text.includes('@@discuss(')
    || text.includes('@@all(')
    || text.includes('@@p2p-config(');
  const isDaemonHandledControlSend = trimmedText === '/stop'
    || isDaemonHandledSessionControlSend(trimmedText)
    || /^\/model\s+\S+/.test(trimmedText)
    || /^\/(?:thinking|effort)\s+\S+/.test(trimmedText);
  // For ordinary user turns, command.ack is a daemon-receipt acknowledgement:
  // once the daemon owns the commandId, the browser should stop waiting on the
  // websocket round trip. This intentionally happens before the first async
  // boundary in handleSend: no P2P preference reads, no pending relaunch wait,
  // no per-session send lock, no live context bootstrap, no semantic recall, no
  // embedding, and no provider send-start may delay it. Follow-up delivery,
  // reconnect/restart, memory, and SDK failures surface through later timeline
  // or session-state events. `/compact` is intentionally NOT a daemon-handled
  // control and is acked here before being forwarded unchanged to the SDK.
  if (!wantsStructuredP2pRouting && !wantsLegacyP2pRouting && !isDaemonHandledControlSend) {
    emitAcceptedReceiptAck();
  }

  if (trimmedText === '/stop') {
    if (cancelTransportTurnNow(sessionName, effectiveId, serverLink)) {
      receiptAcked = true;
      return;
    }
  }

  const p2pSessionConfig = wantsStructuredP2pRouting
    ? await resolveStructuredP2pSessionConfig(sessionName, serverLink, clientP2pSessionConfig)
    : undefined;

  // ── P2P start gates (mandatory) ──
  // GATE 1: every structured P2P start must have a saved config (either sent
  //         from client or persisted on disk).
  // GATE 2: that config must contain at least one participant explicitly
  //         enabled with a non-skip mode — "no specific selected members → reject".
  // CAP:    no more than MAX_P2P_PARTICIPANTS (=5) enabled members.
  // Targeted, structured routing via the @ picker (`p2pAtTargets` with named
  // sessions, no '__all__' token) is exempt from gates 1+2 because the user
  // has explicitly named the targets in the message itself; the cap still
  // applies. The gates' purpose is to prevent the dropdown / `__all__` paths
  // from defaulting to "every active session" when saved config is missing.
  if (wantsStructuredP2pRouting) {
    const inlineAtTargets = (cmd as any).p2pAtTargets as Array<{ session: string; mode: string }> | undefined;
    const hasNamedAtTargets =
      Array.isArray(inlineAtTargets) &&
      inlineAtTargets.length > 0 &&
      inlineAtTargets.every((t) => t && typeof t.session === 'string' && t.session !== '__all__');
    const hasDirectNamedTarget = typeof directTargetSession === 'string'
      && directTargetSession.length > 0
      && directTargetSession !== '__all__';

    if (hasNamedAtTargets || hasDirectNamedTarget) {
      // @ picker / legacy directTargetSession — explicit per-message targets.
      // Only apply the cap; these do not need a saved dropdown config.
      const explicitTargetCount = hasNamedAtTargets ? inlineAtTargets!.length : 1;
      if (explicitTargetCount > MAX_P2P_PARTICIPANTS) {
        logger.warn({ sessionName, count: explicitTargetCount }, 'P2P start blocked: too many explicit targets');
        sendP2pTargetError(
          serverLink,
          sessionName,
          effectiveId,
          P2P_CONFIG_ERROR.TOO_MANY_PARTICIPANTS,
          `P2P participants exceed the limit of ${MAX_P2P_PARTICIPANTS}`,
        );
        return;
      }
    } else {
      // Dropdown / __all__ / config-mode path — must have saved config selecting members.
      if (!p2pSessionConfig || typeof p2pSessionConfig !== 'object') {
        logger.warn({ sessionName }, 'P2P start blocked: no saved P2P config');
        sendP2pTargetError(
          serverLink,
          sessionName,
          effectiveId,
          P2P_CONFIG_ERROR.NO_SAVED_CONFIG,
          'P2P requires a saved configuration before starting. Open the P2P settings panel and select members.',
        );
        return;
      }
      const enabledNames = Object.entries(p2pSessionConfig)
        .filter(([, entry]) => entry && entry.enabled === true && entry.mode !== 'skip')
        .map(([name]) => name);
      if (enabledNames.length === 0) {
        logger.warn({ sessionName }, 'P2P start blocked: saved config has no enabled members');
        sendP2pTargetError(
          serverLink,
          sessionName,
          effectiveId,
          P2P_CONFIG_ERROR.NO_ENABLED_PARTICIPANTS,
          'No P2P participants selected. Open settings and enable at least one member.',
        );
        return;
      }
      if (enabledNames.length > MAX_P2P_PARTICIPANTS) {
        logger.warn({ sessionName, count: enabledNames.length }, 'P2P start blocked: too many enabled members');
        sendP2pTargetError(
          serverLink,
          sessionName,
          effectiveId,
          P2P_CONFIG_ERROR.TOO_MANY_PARTICIPANTS,
          `P2P participants exceed the limit of ${MAX_P2P_PARTICIPANTS}. Reduce selection in the settings panel.`,
        );
        return;
      }
    }
  }
  let p2pRounds = (cmd as any).p2pRounds as number | undefined;
  let p2pExtraPrompt = (cmd as any).p2pExtraPrompt as string | undefined;
  const p2pLocale = (cmd as any).p2pLocale as string | undefined;
  const p2pHopTimeoutMs = (cmd as any).p2pHopTimeoutMs as number | undefined;
  const p2pAdvancedPresetKey = (cmd as any).p2pAdvancedPresetKey as string | undefined;
  const p2pAdvancedRounds = (cmd as any).p2pAdvancedRounds as P2pAdvancedRound[] | undefined;
  const p2pAdvancedRunTimeoutMinutes = (cmd as any).p2pAdvancedRunTimeoutMinutes as number | undefined;
  const p2pContextReducer = (cmd as any).p2pContextReducer as P2pContextReducerConfig | undefined;
  const p2pModeField = (cmd as any).p2pMode as string | undefined;
  const p2pAtTargets = (cmd as any).p2pAtTargets as Array<{ session: string; mode: string }> | undefined;
  const explicitTargets = directTargetSession
    ? [{ session: directTargetSession, mode: resolveSingleTargetMode(directTargetSession, directTargetMode, p2pSessionConfig) }]
    : p2pAtTargets;

  // Build P2P tokens from structured fields (frontend no longer injects @@tokens into text)
  let tokens: ParsedTokens;
  if (explicitTargets && explicitTargets.length > 0) {
    // @ picker targets — expand __all__ or use specific sessions
    const agents: P2pTarget[] = [];
    const files: string[] = [];
    for (const t of explicitTargets) {
      if (t.session === '__all__') {
        agents.push(...expandAllTargets(sessionName, t.mode, false, p2pSessionConfig));
      } else if (getSession(t.session)) {
        agents.push({ session: t.session, mode: t.mode });
      }
    }
    // Extract @file references from text
    for (const m of text.matchAll(FILE_TOKEN_RE)) files.push(m[1]);
    const cleanText = text.replace(FILE_TOKEN_RE, '').replace(/\s+/g, ' ').trim();
    tokens = { agents, files, cleanText };
  } else if (p2pModeField) {
    // Dropdown P2P mode — expand to all targets
    const agents = expandAllTargets(sessionName, p2pModeField, !!(cmd as any).p2pExcludeSameType, p2pSessionConfig);
    const files: string[] = [];
    for (const m of text.matchAll(FILE_TOKEN_RE)) files.push(m[1]);
    const cleanText = text.replace(FILE_TOKEN_RE, '').replace(/\s+/g, ' ').trim();
    tokens = { agents, files, cleanText };
  } else {
    // Legacy: parse @@tokens from text (backward compat with older frontends)
    tokens = parseAtTokens(text);
  }

  // Extract rounds from @@p2p-config(rounds=N) text token if not in WS field
  if (!p2pRounds) {
    const roundsMatch = /@@p2p-config\(rounds=(\d+)\)/.exec(text);
    if (roundsMatch) p2pRounds = Math.min(parseInt(roundsMatch[1], 10), 6);
  }

  // For combo pipelines, `p2pRounds` is the user-selected number of complete
  // flow cycles. The orchestrator expands each cycle into the full pipeline.
  const resolvedMode = p2pModeField ?? tokens.agents[0]?.mode ?? '';

  // All @@discuss tokens were rejected — sessions not found in store
  if (tokens.hadDiscussTokens) {
    logger.warn({ sessionName }, 'P2P: all @@discuss tokens had invalid session names — none matched session store');
    timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: 'No valid P2P targets — session names not found' });
    emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: 'error', error: 'no_valid_targets' });
    return;
  }

  // @@all(mode) from legacy text tokens — expand to all active sessions
  if (tokens.expandAll && tokens.agents.length === 0) {
    const mode = tokens.expandAll.mode;
    if (!p2pRounds && tokens.expandAll.rounds) {
      p2pRounds = tokens.expandAll.rounds;
    }
    tokens.agents.push(...expandAllTargets(sessionName, mode, tokens.expandAll.excludeSameType, p2pSessionConfig));
    if (tokens.agents.length === 0) {
      const unfilteredTargets = p2pSessionConfig
        ? expandAllTargets(sessionName, mode, tokens.expandAll.excludeSameType)
        : [];
      if (unfilteredTargets.length > 0) {
        logger.warn({ sessionName, mode }, '@@all: config filtered all eligible sessions');
        sendP2pTargetError(serverLink, sessionName, effectiveId, P2P_CONFIG_ERROR.NO_CONFIGURED_TARGETS, 'No configured P2P targets found');
        return;
      }
      logger.warn({ sessionName }, '@@all: no active sessions found in same domain');
      sendP2pTargetError(serverLink, sessionName, effectiveId, 'no_sessions', 'No active sessions found for @@all');
      return;
    }
    logger.info({ sessionName, targets: tokens.agents.map(a => a.session) }, '@@all expanded');
  }

  // No targets found from any source
  if ((explicitTargets || p2pModeField) && tokens.agents.length === 0) {
    const structuredMode = p2pModeField ?? explicitTargets?.find((t) => t.session === '__all__')?.mode;
    const unfilteredTargets = p2pSessionConfig && structuredMode
      ? expandAllTargets(sessionName, structuredMode, !!(cmd as any).p2pExcludeSameType)
      : [];
    if (unfilteredTargets.length > 0) {
      logger.warn({ sessionName, p2pModeField }, 'P2P: config filtered all eligible structured-routing targets');
      sendP2pTargetError(serverLink, sessionName, effectiveId, P2P_CONFIG_ERROR.NO_CONFIGURED_TARGETS, 'No configured P2P targets found');
      return;
    }
    logger.warn({ sessionName, p2pModeField }, 'P2P: no active sessions found for structured routing');
    sendP2pTargetError(serverLink, sessionName, effectiveId, 'no_sessions', 'No active sessions found');
    return;
  }

  if (tokens.agents.length > 0) {
    // P2P Quick Discussion — delegate to orchestrator
    try {
      // ── Concurrency guard: check for active P2P runs on same initiator ──
      const forceNew = !!(cmd as Record<string, unknown>).force;
      const existingRun = listP2pRuns().find(
        (r) => r.initiatorSession === sessionName && !P2P_TERMINAL_RUN_STATUSES.has(r.status),
      );

      if (existingRun && !forceNew) {
        // Conflict: active run exists, user didn't force → notify browser
        logger.info({ sessionName, existingRunId: existingRun.id }, 'P2P conflict: active run already exists');
        try {
          serverLink.send({
            type: 'p2p.conflict',
            existingRunId: existingRun.id,
            initiatorSession: sessionName,
            commandId: effectiveId,
          });
          // Send command.ack so pending message state clears
          emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: 'conflict' });
        } catch { /* not connected */ }
        return;
      }

      if (existingRun && forceNew) {
        // Force: cancel existing run first, then start new
        logger.info({ sessionName, existingRunId: existingRun.id }, 'P2P force: cancelling existing run');
        cancelP2pRun(existingRun.id, serverLink);
      }

      const record = getSession(sessionName);
      const projectDir = record?.projectDir ?? '';
      // The selected UI locale is a structured field. Prompt builders append
      // the final language line at the very end, leaving user extraPrompt
      // untouched and avoiding mid-prompt "reply in ..." hints that get missed.
      const advancedLaunchRequested = hasOldAdvancedLaunchFields(cmd)
        || isPlainRecord((cmd as Record<string, unknown>).p2pWorkflowLaunchEnvelope)
        || isPlainRecord((cmd as Record<string, unknown>).workflowLaunchEnvelope);
      if (advancedLaunchRequested && tokens.files.length > 0) {
        const diagnostic = makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', {
          fieldPath: 'tokens.files',
          summary: 'Advanced workflow launch requires explicit startContext file references.',
        });
        const errMsg = summarizeP2pWorkflowDiagnostics([diagnostic]);
        timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: errMsg });
        emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: 'error', error: errMsg });
        return;
      }
      const preparedAdvanced = await prepareAdvancedWorkflowLaunch({
        cmd,
        sessionName,
        targets: tokens.agents,
        userText: tokens.cleanText,
        locale: p2pLocale,
        projectDir,
        commandId: effectiveId,
        serverLink,
      });
      if (!preparedAdvanced.ok) {
        const errMsg = summarizeP2pWorkflowDiagnostics(preparedAdvanced.diagnostics);
        logger.warn({ sessionName, diagnostics: preparedAdvanced.diagnostics }, 'P2P advanced workflow launch rejected');
        timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: errMsg });
        emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: 'error', error: errMsg });
        return;
      }
      const fileContents: Array<{ path: string; content: string }> = [];
      if (!advancedLaunchRequested) {
        for (const fp of tokens.files.slice(0, MAX_P2P_FILE_PULL_COUNT)) {
          try {
            const absPath = nodePath.isAbsolute(fp) ? fp : nodePath.join(projectDir, fp);
            // Check for binary content (null bytes anywhere in the capped content)
            const content = await fsReadFileRaw(absPath, 'utf8');
            const capped = content.slice(0, 50_000);
            if (capped.includes('\0')) {
              // Binary file (image, etc.) — include path reference so agents can read it
              fileContents.push({ path: absPath, content: '' });
              continue;
            }
            fileContents.push({ path: fp, content: capped }); // cap at 50KB
          } catch { /* ignore unreadable files */ }
        }
      }
      // Audit:V-1 / N-H1 — when the prepared advanced launch carries a `bound`
      // workflow (envelope path), funnel it through the typed
      // `advanced: { kind: 'envelope_compiled', bound, advancedRounds }`
      // discriminated union so the orchestrator stores capabilitySnapshot &
      // currentDaemonPolicy on the run state. Pure-legacy launches (no
      // envelope, no compiled rounds) fall back to the deprecated top-level
      // `advancedPresetKey`/`advancedRounds` passthrough until v1b.
      const compiledFromEnvelope = preparedAdvanced.bound !== undefined
        && preparedAdvanced.advancedRounds.length > 0;
      const run = await startP2pRun({
        initiatorSession: sessionName,
        targets: tokens.agents,
        userText: tokens.cleanText,
        locale: p2pLocale,
        fileContents,
        serverLink,
        rounds: p2pRounds,
        extraPrompt: p2pExtraPrompt,
        modeOverride: resolvedMode || undefined,
        hopTimeoutMs: p2pHopTimeoutMs,
        ...(compiledFromEnvelope
          ? {
              advanced: {
                kind: 'envelope_compiled' as const,
                bound: preparedAdvanced.bound!,
                advancedRounds: preparedAdvanced.advancedRounds,
                ...(preparedAdvanced.advancedRunTimeoutMs !== undefined
                  ? { advancedRunTimeoutMs: preparedAdvanced.advancedRunTimeoutMs }
                  : {}),
                ...(preparedAdvanced.contextReducer
                  ? { contextReducer: preparedAdvanced.contextReducer }
                  : {}),
              },
              advancedPresetKey: 'openspec',
            }
          : {
              advancedPresetKey: p2pAdvancedPresetKey,
              advancedRounds: p2pAdvancedRounds,
              advancedRunTimeoutMs: p2pAdvancedRunTimeoutMinutes != null ? p2pAdvancedRunTimeoutMinutes * 60_000 : undefined,
              contextReducer: p2pContextReducer,
            }),
      });
      // NOTE: do NOT emit a `user.message` on the initiator timeline here.
      // A P2P send is a COMMAND to start a discussion, not a chat message to
      // the main session's agent — it belongs in .imc/discussions/<run>.md,
      // not in the main session's chat stream. The web side is expected to
      // skip the optimistic pending bubble entirely when the send payload
      // carries p2pAtTargets/p2pMode (see SessionPane.onSend guard); with
      // no pending bubble to reconcile, no echo is needed.
      //
      // A previous commit (96218b5) mistakenly added a user.message echo
      // here "to clear the stuck spinner" — that fixed the spinner but
      // made every P2P send leave a stray committed user bubble in the
      // main session's chat, which the user correctly flagged as wrong
      // ("应该拦截掉发起 p2p 讨论"). The correct fix is at the web
      // composer: never inject the optimistic bubble for P2P sends.
      const status = isLegacy ? 'accepted_legacy' : 'accepted';
      timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status });
      emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status });
      try {
        serverLink.send({ type: 'p2p.run_started', runId: run.id, session: sessionName });
      } catch { /* not connected */ }
    } catch (err) {
      logger.error({ sessionName, err }, 'P2P run start failed');
      const errMsg = err instanceof Error ? err.message : String(err);
      // Emit error ack so the message exits pending state in the UI
      timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: errMsg });
      emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: 'error', error: errMsg });
    }
    return;
  }

  await waitForPendingSessionRelaunch(sessionName);

  // Transport sessions — route directly to the provider runtime, bypassing tmux.
  const transportRuntime = getTransportRuntime(sessionName);
  const record = (await import('../store/session-store.js')).getSession(sessionName);

  // F4 fix (audit f395d49c-78c) — fail closed when the session record is missing.
  //
  // Without this guard, the code below evaluates `isTransportSession` via
  // `record?.runtimeType === 'transport' || (typeof record?.agentType ===
  // 'string' && isTransportAgent(record.agentType))`. When `record` is
  // undefined the expression resolves to false, so the message silently
  // falls through to the process-agent / tmux path further down
  // (around `sendProcessSessionMessage` ~line 3380+). That path uses
  // `agentType='unknown'` and tries to `sendKeys` to a tmux session
  // that does not exist; the failure is only logged, never surfaced to
  // the client. The user sees an "accepted" command.ack while the
  // message goes nowhere — bug 1 ("message bypasses queue, never
  // reaches SDK").
  //
  // Additionally, the providerSessionId-null branch (~line 3022 area)
  // would still emit `accepted` ack + queued state, but its
  // `if (record)` guard skips the relaunch dispatch entirely — so the
  // user receives an accepted ack with no actual recovery in flight.
  //
  // The safe behaviour for any record-missing send is the same
  // regardless of the runtime state: emit an explicit error ack so the
  // client surface can mark the message as failed and offer retry. We
  // do not attempt to enqueue or relaunch because the launch metadata
  // (agentType / projectDir / resume ids / transportConfig) only lives
  // on the record itself.
  if (!record) {
    logger.warn(
      { sessionName, commandId: effectiveId },
      'handleSend: session record missing — emitting error ack instead of silent fallthrough',
    );
    timelineEmitter.emit(
      sessionName,
      'session.state',
      { state: 'error', error: 'session_missing' },
      { source: 'daemon', confidence: 'high' },
    );
    emitCommandAckReliable(serverLink, {
      commandId: effectiveId,
      sessionName,
      status: 'error',
      error: 'session_missing',
    });
    return;
  }

  const preferenceUserId = preferenceUserIdForSend(cmd, record);
  const preferenceFeatureEnabled = isPreferenceFeatureEnabled();
  const preferenceIngest = processPreferenceLines({
    text,
    featureEnabled: preferenceFeatureEnabled,
    sendOrigin: cmd.origin,
    userId: preferenceUserId,
    scopeKey: `${PREFERENCE_INGEST_SCOPE}:${preferenceUserId}`,
    messageId: effectiveId,
  });
  for (const event of preferenceIngest.telemetry) {
    incrementCounter(event.counter, { sendOrigin: event.sendOrigin });
  }
  const displayText = preferenceIngest.providerText;
  const preferenceMessagePreamble = loadPreferenceProviderContext({
    enabled: preferenceFeatureEnabled,
    userId: preferenceUserId,
    currentRecords: preferenceIngest.records,
  });
  schedulePreferencePersistence({
    userId: preferenceUserId,
    commandId: effectiveId,
    records: preferenceIngest.records,
    sendOrigin: normalizeSendOrigin(cmd.origin),
  });
  const supervisionSnapshot = isSupportedSupervisionTargetSessionType(record?.agentType)
    ? extractSessionSupervisionSnapshot(record?.transportConfig ?? null)
    : null;
  const shouldTrackSupervisionTaskRun = supervisionSnapshot != null
    && supervisionSnapshot.mode !== SUPERVISION_MODE.OFF
    && isEligibleSupervisionTaskText(displayText);
  const attachments: TransportAttachment[] = [];
  const transportUserEventId = (clientMessageId: string) => `transport-user:${clientMessageId}`;
  const isTransportSession = record?.runtimeType === 'transport'
    || (typeof record?.agentType === 'string' && isTransportAgent(record.agentType));
  if (!transportRuntime && isTransportSession) {
    // No runtime — provider is still (re)connecting. Queue the message for
    // automatic redelivery once `restoreTransportSessions()` rebuilds the
    // runtime instead of dropping it on the floor.
    //
    // Deliberately NOT emitting a user.message timeline event here — the
    // agent has not seen this message yet, only the daemon has. Surfacing
    // it as a committed timeline entry mid-outage would be a lie. The web
    // client's optimistic pending bubble stays in its "sending" state, and
    // the session.state 'queued' event below carries pendingMessageEntries
    // so the UI can surface the queue count. The real user.message event
    // is emitted by restoreTransportSessions when the drain actually
    // dispatches the entry via runtime.send().
    const providerLabel = record.providerId ?? 'unknown';
    logger.info(
      { sessionName, providerId: record.providerId, commandId: effectiveId },
      'session.send: transport session has no runtime — queuing for resend after reconnect',
    );
    const enqueueResult = enqueueResend(sessionName, {
      text: displayText,
      ...(preferenceMessagePreamble ? { messagePreamble: preferenceMessagePreamble } : {}),
      commandId: effectiveId,
      queuedAt: Date.now(),
    });
    // N-R3 fix (audit 0419d1ac-1f4) — surface a user-visible warning when
    // the resend queue overflow drops the oldest entry. Previously the
    // drop only logged at warn-level on the daemon, and the dropped
    // entry's clientMessageId was already inside `settledCommandIdsRef`
    // on the web (via `reconcileQueuedOptimisticMessages`), so a per-entry
    // `command.ack error` would have been swallowed. An `assistant.text`
    // summary is the only path the user actually sees.
    if (enqueueResult.droppedOldest) {
      timelineEmitter.emit(
        sessionName,
        'assistant.text',
        {
          text: '⚠️ 排队消息已满（上限 10 条），最旧消息已被丢弃。请稍后重新发送。',
          streaming: false,
          memoryExcluded: true,
        },
        { source: 'daemon', confidence: 'high' },
      );
    }
    if (shouldTrackSupervisionTaskRun) {
      supervisionAutomation.queueTaskIntent(sessionName, effectiveId, displayText, supervisionSnapshot);
    }
    const queued = getResendEntries(sessionName);
    const infoMsg = `⏳ Provider ${providerLabel} not connected yet — will resend ${queued.length} queued message${queued.length === 1 ? '' : 's'} once reconnected.`;
    timelineEmitter.emit(
      sessionName,
      'assistant.text',
      { text: infoMsg, streaming: false, memoryExcluded: true },
      { source: 'daemon', confidence: 'high' },
    );
    timelineEmitter.emit(
      sessionName,
      'session.state',
      {
        state: 'queued',
        pendingCount: queued.length,
        pendingMessages: queued.map((e) => e.text),
        pendingMessageEntries: queued.map((e) => ({ clientMessageId: e.commandId, text: e.text })),
      },
      { source: 'daemon', confidence: 'high' },
    );
    emitAcceptedReceiptAck();
    // Best-effort resume for sessions that failed to launch or whose runtime
    // vanished outside the provider reconnect path. The resend queue drains on
    // successful relaunch, so the queued user message still delivers.
    void runExclusiveSessionRelaunch(sessionName, async () => {
      try {
        await resumeTransportRuntimeAfterLoss(record);
      } catch (err) {
        logger.error({ err, sessionName }, 'auto-resume after missing transport runtime failed');
        const resumeErr = err instanceof Error ? err.message : String(err);
        timelineEmitter.emit(
          sessionName,
          'assistant.text',
          { text: `⚠️ Auto-resume failed: ${resumeErr}. Restart the session manually to recover.`, streaming: false, memoryExcluded: true },
          { source: 'daemon', confidence: 'high' },
        );
      }
    });
    return;
  }
  if (transportRuntime && !transportRuntime.providerSessionId) {
    // Runtime object is registered but its provider session id is null —
    // typically after a cancel or mid-init error left it stuck. Tear it down,
    // queue the user's message for resend, and kick off a resume (NOT fresh
    // — we want the same conversation). `launchTransportSession` drains the
    // resend queue on success, so the message auto-delivers without user
    // intervention.
    // Same "don't lie to the timeline" rule as the no-runtime branch above:
    // the agent hasn't seen this message yet. Skip the user.message emit
    // here and let the drain path emit it when the runtime actually
    // dispatches the entry.
    const providerLabel = record?.providerId ?? 'unknown';
    logger.info(
      { sessionName, providerId: record?.providerId, commandId: effectiveId },
      'session.send: transport runtime missing provider session id — queuing and auto-resuming',
    );
    const enqueueResultMissingSid = enqueueResend(sessionName, {
      text: displayText,
      ...(preferenceMessagePreamble ? { messagePreamble: preferenceMessagePreamble } : {}),
      commandId: effectiveId,
      queuedAt: Date.now(),
    });
    // N-R3 fix (audit 0419d1ac-1f4) — surface droppedOldest the same way as
    // the no-runtime branch above.
    if (enqueueResultMissingSid.droppedOldest) {
      timelineEmitter.emit(
        sessionName,
        'assistant.text',
        {
          text: '⚠️ 排队消息已满（上限 10 条），最旧消息已被丢弃。请稍后重新发送。',
          streaming: false,
          memoryExcluded: true,
        },
        { source: 'daemon', confidence: 'high' },
      );
    }
    if (shouldTrackSupervisionTaskRun) {
      supervisionAutomation.queueTaskIntent(sessionName, effectiveId, displayText, supervisionSnapshot);
    }
    const queued = getResendEntries(sessionName);
    const infoMsg = `⏳ Provider ${providerLabel} is restarting — will auto-resend ${queued.length} queued message${queued.length === 1 ? '' : 's'} once the runtime is back.`;
    timelineEmitter.emit(
      sessionName,
      'assistant.text',
      { text: infoMsg, streaming: false, memoryExcluded: true },
      { source: 'daemon', confidence: 'high' },
    );
    timelineEmitter.emit(
      sessionName,
      'session.state',
      {
        state: 'queued',
        pendingCount: queued.length,
        pendingMessages: queued.map((e) => e.text),
        pendingMessageEntries: queued.map((e) => ({ clientMessageId: e.commandId, text: e.text })),
      },
      { source: 'daemon', confidence: 'high' },
    );
    emitAcceptedReceiptAck();
    // Best-effort resume. Failure is logged but doesn't change the ack —
    // the next user send will re-enter this branch and try again, or a
    // manual /restart path can recover.
    if (record) {
      void runExclusiveSessionRelaunch(sessionName, async () => {
        try {
          await resumeTransportRuntimeAfterLoss(record);
        } catch (err) {
          logger.error({ err, sessionName }, 'auto-resume after provider-session-id loss failed');
          const resumeErr = err instanceof Error ? err.message : String(err);
          timelineEmitter.emit(
            sessionName,
            'assistant.text',
            { text: `⚠️ Auto-resume failed: ${resumeErr}. Restart the session manually to recover.`, streaming: false, memoryExcluded: true },
            { source: 'daemon', confidence: 'high' },
          );
        }
      });
    }
    return;
  }
  if (transportRuntime) {
    if (isSessionControlCommandText(trimmedText, 'clear') && supportsTransportClear(record?.agentType)) {
      emitTransportUserMessage(text);
      // Fresh conversation must not replay stale queued messages from the prior
      // offline window — drop anything we had buffered for resend.
      clearResend(sessionName);
      try {
        await runExclusiveSessionRelaunch(sessionName, async () => {
          await relaunchFreshTransportConversation(record);
        });
        // Reset per-session memory injection history — fresh conversation
        // should be allowed to re-inject previously-shown memories again.
        clearRecentInjectionHistory(sessionName);
        await handleGetSessions(serverLink);
        await syncSubSessionIfNeeded(sessionName, serverLink);
        timelineEmitter.emit(sessionName, 'assistant.text', {
          text: 'Started a fresh conversation',
          streaming: false,
          memoryExcluded: true,
        }, { source: 'daemon', confidence: 'high' });
        const clearStatus = isLegacy ? 'accepted_legacy' : 'accepted';
        timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: clearStatus });
        emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: clearStatus });
      } catch (err) {
        const errMsg = describeTransportSendError(err);
        logger.error({ sessionName, err }, 'session.clear (transport) failed');
        timelineEmitter.emit(sessionName, 'assistant.text', { text: `⚠️ Clear failed: ${errMsg}`, streaming: false, memoryExcluded: true }, { source: 'daemon', confidence: 'high' });
        timelineEmitter.emit(sessionName, 'session.state', { state: 'idle', error: errMsg }, { source: 'daemon', confidence: 'high' });
        emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: 'error', error: errMsg });
      }
      return;
    }
    // `/compact` is intentionally NOT handled as daemon-side compaction here.
    // The transport runtime/provider capability decides whether it is translated
    // to an SDK RPC, forwarded as a verified slash command, or rejected visibly.
    // Falling through preserves the ordinary receipt-ack contract while keeping
    // provider-specific compact semantics at the SDK boundary.
    const release = await getMutex(sessionName).acquire();
    try {
      const modelMatch = trimmedText.match(/^\/model\s+(\S+)(?:\s+.*)?$/);
      const effortMatch = trimmedText.match(/^\/(?:thinking|effort)\s+(\S+)\s*$/);
      if (record?.agentType === 'qwen' && modelMatch) {
        const nextModel = modelMatch[1];
          const runtimeConfig = await getQwenRuntimeConfig(true).catch(() => null);
          // Priority: session qwenAvailableModels (may include preset models) >
          // runtimeConfig.availableModels (from Qwen CLI, may not know about preset
          // models) > hardcoded QWEN_MODEL_IDS fallback. Session record is
          // authoritative because it was populated with preset models at launch.
          const sessionModels = record.qwenAvailableModels ?? [];
          const runtimeModels = runtimeConfig?.availableModels ?? [];
          const allowedModels = sessionModels.length
            ? sessionModels
            : (runtimeModels.length ? runtimeModels : QWEN_MODEL_IDS);
          if (!allowedModels.includes(nextModel)) {
            const qwenAuthType = runtimeConfig?.authType ?? record.qwenAuthType;
            const authHint = qwenAuthType === 'qwen-oauth'
              ? ' (current tier only allows coder-model)'
              : '';
            emitTransportUserMessage(text);
            timelineEmitter.emit(sessionName, 'assistant.text', {
              text: `⚠️ Unknown Qwen model: ${nextModel}${authHint}`,
              streaming: false,
              memoryExcluded: true,
            }, { source: 'daemon', confidence: 'high' });
            timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: `Unknown Qwen model: ${nextModel}${authHint}` });
            emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: 'error', error: `Unknown Qwen model: ${nextModel}${authHint}` });
            return;
          }
          transportRuntime.setAgentId(nextModel);
          const qwenAuthType = runtimeConfig?.authType ?? record.qwenAuthType;
          // Merge runtime models INTO session's existing list (union) so preset
          // models survive future switches. Never overwrite with only runtime models.
          const mergedAvailableModels = [...new Set([...sessionModels, ...runtimeModels])];
          const nextRecord = {
            ...record,
            requestedModel: nextModel,
            activeModel: nextModel,
            modelDisplay: nextModel,
            qwenModel: nextModel,
            ...(qwenAuthType ? { qwenAuthType } : {}),
            ...(runtimeConfig?.authLimit ? { qwenAuthLimit: runtimeConfig.authLimit } : {}),
            ...(mergedAvailableModels.length ? { qwenAvailableModels: mergedAvailableModels } : {}),
            ...getQwenDisplayMetadata({
              model: nextModel,
              authType: qwenAuthType,
              authLimit: runtimeConfig?.authLimit ?? record.qwenAuthLimit,
              quotaUsageLabel: qwenAuthType === 'qwen-oauth' ? getQwenOAuthQuotaUsageLabel() : undefined,
            }),
            updatedAt: Date.now(),
          };
          upsertSession(nextRecord);
          persistSessionRecord(nextRecord, sessionName);
          await handleGetSessions(serverLink);
          syncSubSessionIfNeeded(sessionName, serverLink);
          emitTransportUserMessage(text);
          timelineEmitter.emit(sessionName, 'usage.update', {
            model: nextModel,
            contextWindow: resolveContextWindow(undefined, nextModel),
          }, { source: 'daemon', confidence: 'high' });
          timelineEmitter.emit(sessionName, 'assistant.text', {
            text: `Switched model to ${nextModel}`,
            streaming: false,
            automation: true,
            memoryExcluded: true,
          }, { source: 'daemon', confidence: 'high' });
          timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: isLegacy ? 'accepted_legacy' : 'accepted' });
          emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: isLegacy ? 'accepted_legacy' : 'accepted' });
          return;
      }
      if (record?.agentType === 'claude-code-sdk' && modelMatch) {
        const requestedModel = modelMatch[1];
        const selectedModel = normalizeClaudeCodeModelId(requestedModel);
        if (!selectedModel) {
          emitTransportUserMessage(text);
          timelineEmitter.emit(sessionName, 'assistant.text', { text: `⚠️ Unknown Claude model: ${requestedModel}`, streaming: false, memoryExcluded: true }, { source: 'daemon', confidence: 'high' });
          timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: `Unknown Claude model: ${requestedModel}` });
          emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: 'error', error: `Unknown Claude model: ${requestedModel}` });
          return;
        }
        transportRuntime.setAgentId(normalizeClaudeSdkModelForProvider(selectedModel));
        const sdkDisplay = await getClaudeSdkRuntimeConfig(true).catch(() => ({}) as import('../agent/sdk-runtime-config.js').SdkRuntimeConfig);
        const nextRecord = {
          ...record,
          requestedModel: selectedModel,
          activeModel: selectedModel,
          modelDisplay: selectedModel,
          ...(sdkDisplay.planLabel ? { planLabel: sdkDisplay.planLabel } : {}),
          updatedAt: Date.now(),
        };
        upsertSession(nextRecord);
        persistSessionRecord(nextRecord, sessionName);
        await handleGetSessions(serverLink);
        syncSubSessionIfNeeded(sessionName, serverLink);
        emitTransportUserMessage(text);
        timelineEmitter.emit(sessionName, 'usage.update', { model: selectedModel, contextWindow: resolveContextWindow(undefined, selectedModel) }, { source: 'daemon', confidence: 'high' });
        timelineEmitter.emit(sessionName, 'assistant.text', {
          text: `Switched model to ${selectedModel}`,
          streaming: false,
          automation: true,
          memoryExcluded: true,
        }, { source: 'daemon', confidence: 'high' });
        timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: isLegacy ? 'accepted_legacy' : 'accepted' });
        emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: isLegacy ? 'accepted_legacy' : 'accepted' });
        return;
      }
      if (record?.agentType === 'codex-sdk' && modelMatch) {
        const nextModel = modelMatch[1];
        const sdkRuntime = await getCodexRuntimeConfig(true).catch(() => ({}) as import('../agent/codex-runtime-config.js').CodexRuntimeConfig);
        const sdkDisplay = mergeCodexDisplayMetadata(sdkRuntime, record);
        const availableModels = sdkRuntime.availableModels?.length
          ? sdkRuntime.availableModels
          : record.codexAvailableModels?.length
            ? record.codexAvailableModels
            : [...CODEX_MODEL_IDS];
        if (!availableModels.includes(nextModel)) {
          emitTransportUserMessage(text);
          timelineEmitter.emit(sessionName, 'assistant.text', { text: `⚠️ Unknown Codex model: ${nextModel}`, streaming: false, memoryExcluded: true }, { source: 'daemon', confidence: 'high' });
          timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: `Unknown Codex model: ${nextModel}` });
          emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: 'error', error: `Unknown Codex model: ${nextModel}` });
          return;
        }
        transportRuntime.setAgentId(nextModel);
        const nextRecord = {
          ...record,
          requestedModel: nextModel,
          activeModel: nextModel,
          modelDisplay: nextModel,
          ...(availableModels.length ? { codexAvailableModels: availableModels } : {}),
          ...sdkDisplay,
          updatedAt: Date.now(),
        };
        upsertSession(nextRecord);
        persistSessionRecord(nextRecord, sessionName);
        await handleGetSessions(serverLink);
        syncSubSessionIfNeeded(sessionName, serverLink);
        emitTransportUserMessage(text);
        timelineEmitter.emit(sessionName, 'usage.update', { model: nextModel, contextWindow: resolveContextWindow(undefined, nextModel) }, { source: 'daemon', confidence: 'high' });
        timelineEmitter.emit(sessionName, 'assistant.text', {
          text: `Switched model to ${nextModel}`,
          streaming: false,
          automation: true,
          memoryExcluded: true,
        }, { source: 'daemon', confidence: 'high' });
        timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: isLegacy ? 'accepted_legacy' : 'accepted' });
        emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: isLegacy ? 'accepted_legacy' : 'accepted' });
        return;
      }
      if ((record?.agentType === 'copilot-sdk' || record?.agentType === 'cursor-headless' || record?.agentType === 'gemini-sdk' || record?.agentType === 'kimi-sdk') && modelMatch) {
        const nextModel = modelMatch[1];
        transportRuntime.setAgentId(nextModel);
        const nextRecord = {
          ...record,
          requestedModel: nextModel,
          activeModel: nextModel,
          modelDisplay: nextModel,
          updatedAt: Date.now(),
        };
        upsertSession(nextRecord);
        persistSessionRecord(nextRecord, sessionName);
        await handleGetSessions(serverLink);
        syncSubSessionIfNeeded(sessionName, serverLink);
        emitTransportUserMessage(text);
        timelineEmitter.emit(sessionName, 'usage.update', { model: nextModel, contextWindow: resolveContextWindow(undefined, nextModel) }, { source: 'daemon', confidence: 'high' });
        timelineEmitter.emit(sessionName, 'assistant.text', {
          text: `Switched model to ${nextModel}`,
          streaming: false,
          automation: true,
          memoryExcluded: true,
        }, { source: 'daemon', confidence: 'high' });
        timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: isLegacy ? 'accepted_legacy' : 'accepted' });
        emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: isLegacy ? 'accepted_legacy' : 'accepted' });
        return;
      }
      if (supportsEffort(record?.agentType) && effortMatch) {
        const nextEffort = effortMatch[1];
        const allowed = getSupportedEffortLevels(record?.agentType);
        if (!isTransportEffortLevel(nextEffort) || !allowed.includes(nextEffort)) {
          const supported = allowed.join(', ');
          emitTransportUserMessage(text);
          timelineEmitter.emit(sessionName, 'assistant.text', {
            text: `⚠️ Unsupported thinking level: ${nextEffort}. Supported: ${supported}`,
            streaming: false,
            memoryExcluded: true,
          }, { source: 'daemon', confidence: 'high' });
          timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: `Unsupported thinking level: ${nextEffort}` });
          emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: 'error', error: `Unsupported thinking level: ${nextEffort}` });
          return;
        }
        transportRuntime.setEffort(nextEffort);
        const nextRecord = {
          ...record,
          effort: nextEffort,
          updatedAt: Date.now(),
        };
        upsertSession(nextRecord);
        persistSessionRecord(nextRecord, sessionName);
        await handleGetSessions(serverLink);
        syncSubSessionIfNeeded(sessionName, serverLink);
        emitTransportUserMessage(text);
        timelineEmitter.emit(sessionName, 'assistant.text', {
          text: `Switched thinking level to ${nextEffort}`,
          streaming: false,
          automation: true,
          memoryExcluded: true,
        }, { source: 'daemon', confidence: 'high' });
        timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: isLegacy ? 'accepted_legacy' : 'accepted' });
        emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: isLegacy ? 'accepted_legacy' : 'accepted' });
        return;
      }
      if (record?.agentType === 'qwen' && record.qwenAuthType === 'qwen-oauth') {
        recordQwenOAuthRequest();
        refreshQwenQuotaUsageLabels(serverLink);
      }

      // send() is synchronous: dispatches immediately if idle, queues if busy.
      // Status changes come from transport runtime's onStatusChange callback.
      const result = preferenceMessagePreamble
        ? transportRuntime.send(
          displayText,
          effectiveId,
          attachments.length > 0 ? attachments : undefined,
          preferenceMessagePreamble,
        )
        : (attachments.length > 0
            ? transportRuntime.send(displayText, effectiveId, attachments)
            : transportRuntime.send(displayText, effectiveId));
      if (shouldTrackSupervisionTaskRun) {
        if (result === 'queued') {
          supervisionAutomation.queueTaskIntent(sessionName, effectiveId, displayText, supervisionSnapshot);
        } else if (result === 'sent') {
          supervisionAutomation.registerTaskIntent(sessionName, effectiveId, displayText, supervisionSnapshot);
        }
      }
      if (result === 'sent') {
        if (!shouldHideTimelineUserMessageForSessionControl(displayText)) {
          emitTransportUserMessage(
            displayText,
            {
              clientMessageId: effectiveId,
              ...(attachments.length > 0 ? { attachments } : {}),
            },
            transportUserEventId(effectiveId),
          );
        }
      }
      if (result === 'queued') {
        timelineEmitter.emit(sessionName, 'session.state', {
          state: 'queued',
          pendingCount: transportRuntime.pendingCount,
          pendingMessages: transportRuntime.pendingMessages,
          pendingMessageEntries: transportRuntime.pendingEntries,
          pendingMessageVersion: transportRuntime.pendingVersion,
        }, { source: 'daemon', confidence: 'high' });
      }
      // Clear fresh-start flag — the new conversation is now active
      if (record?.qwenFreshOnResume) {
        upsertSession({ ...record, qwenFreshOnResume: undefined, updatedAt: Date.now() });
      }
      emitAcceptedReceiptAck();
    } catch (err) {
      const errMsg = describeTransportSendError(err);
      logger.error({ sessionName, err }, 'session.send (transport) failed');
      const failureLabel = isSessionControlCommandText(displayText, 'compact') ? 'Compact failed' : 'Send failed';
      timelineEmitter.emit(sessionName, 'assistant.text', { text: `⚠️ ${failureLabel}: ${errMsg}`, streaming: false, memoryExcluded: true }, { source: 'daemon', confidence: 'high' });
      timelineEmitter.emit(sessionName, 'session.state', { state: 'idle', error: errMsg }, { source: 'daemon', confidence: 'high' });
      if (!receiptAcked) {
        emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: 'error', error: errMsg });
      }
    } finally {
      release();
    }
    return;
  }

  // Preserve raw @file references for normal sends. Stable preferences are
  // session context, not per-turn recall: for tmux/process agents inject them
  // once per provider conversation, and reset the gate on clear/compact.
  const finalText = prepareProcessPreferenceProviderText({
    sessionName,
    providerText: displayText,
    preferenceContext: preferenceMessagePreamble,
  });

  if (isSessionControlCommandText(text, 'clear') && record?.runtimeType !== 'transport' && supportsProcessClear(record?.agentType)) {
    emitTransportUserMessage(text);
    try {
      await runExclusiveSessionRelaunch(sessionName, async () => {
        await relaunchSessionWithSettings(record, { fresh: true });
      });
      // Reset per-session memory injection history — fresh conversation
      // should be allowed to re-inject previously-shown memories again.
      clearRecentInjectionHistory(sessionName);
      await handleGetSessions(serverLink);
      await syncSubSessionIfNeeded(sessionName, serverLink);
      timelineEmitter.emit(sessionName, 'assistant.text', {
        text: 'Started a fresh conversation',
        streaming: false,
        memoryExcluded: true,
      }, { source: 'daemon', confidence: 'high' });
      const clearStatus = isLegacy ? 'accepted_legacy' : 'accepted';
      timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: clearStatus });
      emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: clearStatus });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ sessionName, err }, 'session.clear failed');
      timelineEmitter.emit(sessionName, 'assistant.text', { text: `⚠️ Clear failed: ${errMsg}`, streaming: false, memoryExcluded: true }, { source: 'daemon', confidence: 'high' });
      timelineEmitter.emit(sessionName, 'session.state', { state: 'idle', error: errMsg }, { source: 'daemon', confidence: 'high' });
      emitCommandAckReliable(serverLink, { commandId: effectiveId, sessionName, status: 'error', error: errMsg });
    }
    return;
  }

  // Build attachment refs for any uploaded files referenced in the message
  if (tokens.files.length > 0) {
    const record = getSession(sessionName);
    const projectDir = record?.projectDir ?? '';
    for (const fp of tokens.files) {
      const absPath = nodePath.isAbsolute(fp) ? fp : nodePath.join(projectDir, fp);
      const entry = lookupAttachment(absPath);
      if (entry) {
        attachments.push({
          id: entry.id,
          originalName: entry.originalName,
          mime: entry.mime,
          size: entry.size,
          daemonPath: entry.daemonPath,
        });
      }
    }
  }

  try {
    await sendProcessSessionMessage(sessionName, finalText, attachments, {
      originalText: displayText,
      commandId: effectiveId,
      isLegacy,
      ackAlreadySent: receiptAcked,
      serverLink,
    });
  } catch (err) {
    logger.error({ sessionName, err }, 'session.send failed');
  }
}

/** Emit command.ack to local timeline + outbox + server. Idempotent per commandId. */
function emitCommandAck(
  sessionName: string,
  commandId: string,
  status: 'accepted' | 'accepted_legacy' | 'error',
  error: string | undefined,
  serverLink: (Pick<ServerLink, 'send'> & Partial<Pick<ServerLink, 'trySend'>>) | undefined,
): void {
  const ackPayload: Record<string, unknown> = { commandId, status };
  if (error) ackPayload.error = error;
  timelineEmitter.emit(sessionName, 'command.ack', ackPayload);
  const outbox = getDefaultAckOutbox();
  outbox.enqueue({
    commandId,
    sessionName,
    status,
    error,
    ts: Date.now(),
  }).catch((err) => {
    logger.error({ commandId, err }, 'ackOutbox.enqueue failed');
  });
  const sent = trySendCommandAck(serverLink, { commandId, sessionName, status, error });
  if (sent) {
    outbox.markAcked(commandId).catch((err) => {
      logger.warn({ commandId, err }, 'ackOutbox.markAcked failed');
    });
  } else {
    logger.warn({ commandId }, 'command.ack not sent, queued for retry');
  }
}

async function sendProcessSessionMessage(
  sessionName: string,
  finalText: string,
  attachments: TransportAttachment[],
  options?: {
    originalText?: string;
    commandId?: string;
    isLegacy?: boolean;
    ackAlreadySent?: boolean;
    serverLink?: Pick<ServerLink, 'send'>;
  },
): Promise<void> {
  // ── Step 1: Confirm receipt to the user IMMEDIATELY ─────────────────────────
  // This is the daemon-receipt confirmation. It happens BEFORE the mutex,
  // BEFORE memory recall, BEFORE any tmux work — so the spinner clears in one
  // WS RTT regardless of how busy the agent or daemon is. The actual delivery
  // to the agent happens in the background.
  const payload: Record<string, unknown> = { text: options?.originalText ?? finalText };
  if (attachments.length > 0) payload.attachments = attachments;
  if (options?.commandId) payload.commandId = options.commandId;
  const userEvent = timelineEmitter.emit(sessionName, 'user.message', payload);
  if (options?.commandId && !options.ackAlreadySent) {
    const status = options.isLegacy ? 'accepted_legacy' : 'accepted';
    emitCommandAck(sessionName, options.commandId, status, undefined, options.serverLink);
  }

  const deliveryTurn = reserveProcessDeliveryTurn(sessionName);
  const agentType = getSession(sessionName)?.agentType ?? 'unknown';

  // ── Step 2: Prepare advisory context outside the per-session delivery lock ──
  // Path sandboxing and memory recall can touch disk/SQLite/embedding state.
  // They must not block earlier queued tmux writes any longer than necessary.
  let sendText = finalText;
  try {
    if (agentType === 'gemini' || agentType === 'codex') {
      sendText = await rewritePathsForSandbox(sessionName, finalText);
    }
  } catch (rewriteErr) {
    logger.warn({ sessionName, err: rewriteErr }, 'sandbox path rewrite failed — sending original message');
    sendText = finalText;
  }

  let memoryContext: Awaited<ReturnType<typeof prependLocalMemory>> = { text: sendText };
  try {
    const deadlineAt = Date.now() + PROCESS_MEMORY_RECALL_DEADLINE_MS;
    memoryContext = await withDeadline(
      prependLocalMemory(sendText, sessionName, { deadlineAt }),
      PROCESS_MEMORY_RECALL_DEADLINE_MS,
      'memory_recall_timeout',
    );
    sendText = memoryContext.text;
  } catch (recallErr) {
    logger.warn({ sessionName, timeoutMs: PROCESS_MEMORY_RECALL_DEADLINE_MS, err: recallErr }, 'memory recall skipped — sending without memory injection');
  }

  // ── Step 3: Serialize only the actual stdin write ──────────────────────────
  // The delivery turn is reserved before async preparation, so parallel recall
  // cannot reorder two user messages for the same process session.
  await deliveryTurn.waitForTurn();
  const release = await getMutex(sessionName).acquire();
  try {
    await sendShellAwareCommand(sessionName, sendText, agentType);
  } catch (sendErr) {
    const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
    logger.error({ sessionName, err: sendErr }, 'sendShellAwareCommand failed after ack');
    try {
      emitSessionInlineError(sessionName, `Failed to deliver message to agent: ${errMsg}`);
    } catch { /* best-effort */ }
    throw sendErr;
  } finally {
    release();
    deliveryTurn.releaseTurn();
  }

  // ── Step 4: Post-delivery — emit memory.context + record hits ──────────────
  if (memoryContext.timelinePayload && userEvent) {
    timelineEmitter.emit(sessionName, 'memory.context', {
      ...memoryContext.timelinePayload,
      relatedToEventId: userEvent.eventId,
    });
    if (memoryContext.hitIds && memoryContext.hitIds.length > 0) {
      try { recordMemoryHits(memoryContext.hitIds); } catch { /* non-fatal */ }
    }
  }

  if (agentType === 'opencode') {
    const { scheduleCatchup } = await import('./opencode-watcher.js');
    scheduleCatchup(sessionName);
  }
}

export async function sendProcessSessionMessageForAutomation(sessionName: string, text: string): Promise<void> {
  await sendProcessSessionMessage(sessionName, text, [], { originalText: text });
}

async function resolveProcessRecallQueryContext(
  sessionName: string,
): Promise<{
  namespace?: SessionRecord['contextNamespace'];
  repo?: string;
  currentEnterpriseId?: string;
}> {
  const record = getSession(sessionName);
  if (record?.contextNamespace?.projectId) {
    return {
      namespace: record.contextNamespace,
      repo: record.contextNamespace.projectId,
      currentEnterpriseId: record.contextNamespace.enterpriseId,
    };
  }

  const projectDir = record?.projectDir?.trim();
  let originUrl: string | null | undefined;
  if (projectDir) {
    try {
      const repo = await detectRepo(projectDir);
      originUrl = repo.info?.remoteUrl ?? null;
    } catch {
      originUrl = null;
    }
  }

  const canonical = processRecallRepositoryIdentityService.resolve({
    cwd: projectDir,
    originUrl,
  });
  const projectId = canonical.key || record?.projectName;
  if (!projectId) return {};
  return {
    namespace: { scope: 'personal', projectId },
    repo: projectId,
  };
}

async function handleEditQueuedTransportMessage(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = typeof cmd.sessionName === 'string' ? cmd.sessionName : '';
  const clientMessageId = typeof cmd.clientMessageId === 'string' ? cmd.clientMessageId.trim() : '';
  const text = typeof cmd.text === 'string' ? cmd.text.trim() : '';
  const commandId = typeof cmd.commandId === 'string' && cmd.commandId.trim()
    ? cmd.commandId.trim()
    : `edit-queued-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (!sessionName || !clientMessageId || !text) return;
  const runtime = getTransportRuntime(sessionName);
  const record = getSession(sessionName);
  if (!runtime || record?.runtimeType !== 'transport') {
    timelineEmitter.emit(sessionName, 'command.ack', { commandId, status: 'error', error: 'Transport session unavailable' });
    emitCommandAckReliable(serverLink, { commandId, sessionName, status: 'error', error: 'Transport session unavailable' });
    return;
  }
  const release = await getMutex(sessionName).acquire();
  try {
    const edited = runtime.editPendingMessage(clientMessageId, text);
    if (!edited) {
      timelineEmitter.emit(sessionName, 'command.ack', { commandId, status: 'error', error: 'Queued message not found' });
      emitCommandAckReliable(serverLink, { commandId, sessionName, status: 'error', error: 'Queued message not found' });
      return;
    }
    supervisionAutomation.updateQueuedTaskIntent(sessionName, clientMessageId, text);
    timelineEmitter.emit(sessionName, 'session.state', {
      state: runtime.sending ? 'queued' : 'idle',
      pendingCount: runtime.pendingCount,
      pendingMessages: runtime.pendingMessages,
      pendingMessageEntries: runtime.pendingEntries,
      pendingMessageVersion: runtime.pendingVersion,
    }, { source: 'daemon', confidence: 'high' });
    timelineEmitter.emit(sessionName, 'command.ack', { commandId, status: 'accepted' });
    emitCommandAckReliable(serverLink, { commandId, sessionName, status: 'accepted' });
  } finally {
    release();
  }
}

async function handleUndoQueuedTransportMessage(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = typeof cmd.sessionName === 'string' ? cmd.sessionName : '';
  const clientMessageId = typeof cmd.clientMessageId === 'string' ? cmd.clientMessageId.trim() : '';
  const commandId = typeof cmd.commandId === 'string' && cmd.commandId.trim()
    ? cmd.commandId.trim()
    : `undo-queued-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (!sessionName || !clientMessageId) return;
  const runtime = getTransportRuntime(sessionName);
  const record = getSession(sessionName);
  if (!runtime || record?.runtimeType !== 'transport') {
    timelineEmitter.emit(sessionName, 'command.ack', { commandId, status: 'error', error: 'Transport session unavailable' });
    emitCommandAckReliable(serverLink, { commandId, sessionName, status: 'error', error: 'Transport session unavailable' });
    return;
  }
  const release = await getMutex(sessionName).acquire();
  try {
    const removed = runtime.removePendingMessage(clientMessageId);
    if (!removed) {
      timelineEmitter.emit(sessionName, 'command.ack', { commandId, status: 'error', error: 'Queued message not found' });
      emitCommandAckReliable(serverLink, { commandId, sessionName, status: 'error', error: 'Queued message not found' });
      return;
    }
    supervisionAutomation.removeQueuedTaskIntent(sessionName, clientMessageId);
    timelineEmitter.emit(sessionName, 'session.state', {
      state: runtime.sending ? 'queued' : 'idle',
      pendingCount: runtime.pendingCount,
      pendingMessages: runtime.pendingMessages,
      pendingMessageEntries: runtime.pendingEntries,
      pendingMessageVersion: runtime.pendingVersion,
    }, { source: 'daemon', confidence: 'high' });
    timelineEmitter.emit(sessionName, 'command.ack', { commandId, status: 'accepted' });
    emitCommandAckReliable(serverLink, { commandId, sessionName, status: 'accepted' });
  } finally {
    release();
  }
}

async function handleInput(cmd: Record<string, unknown>): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  const data = cmd.data as string | undefined;

  // session.input SHALL NOT require or process commandId
  if (!sessionName || data === undefined) return;

  // Transport sessions have no terminal, but ESC should cancel the active turn.
  const transportRuntime = getTransportRuntime(sessionName);
  if (transportRuntime) {
    if (data === '\x1b') {
      cancelTransportTurnNow(sessionName, undefined, undefined);
    }
    return;
  }

  // Serialized via same per-session mutex (no commandId, no retry)
  const release = await getMutex(sessionName).acquire();
  try {
    // For Codex and Gemini, ESC doesn't interrupt an ongoing task — they need Ctrl+C.
    // Remap ESC → Ctrl+C for these agents so interrupt behavior is consistent with CC.
    const agentType = getSession(sessionName)?.agentType;
    const isEsc = data === '\x1b';
    if (isEsc && (agentType === 'codex' || agentType === 'gemini')) {
      await sendRawInput(sessionName, '\x03'); // Ctrl+C
    } else {
      await sendRawInput(sessionName, data);
    }
  } catch (err) {
    logger.error({ sessionName, err }, 'session.input failed');
  } finally {
    release();
  }
}

async function handleResize(cmd: Record<string, unknown>): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  const cols = cmd.cols as number | undefined;
  const rows = cmd.rows as number | undefined;
  if (!sessionName || !cols || !rows) return;
  const record = getSession(sessionName);
  if (record?.runtimeType === 'transport') return;
  try {
    // Subtract 1 col so tmux is always slightly narrower than the browser terminal.
    // xterm fitAddon rounds down but container width may have sub-character remainder,
    // causing tmux output to wrap at a wider width and misalign with xterm's display.
    await resizeSession(sessionName, Math.max(cols - 1, 40), Math.max(rows, 10));
    terminalStreamer.invalidateSize(sessionName);
  } catch (err) {
    logger.error({ sessionName, cols, rows, err }, 'session.resize failed');
  }
}

async function handleGetSessions(serverLink: ServerLink): Promise<void> {
  const sessions = await buildSessionList();
  try {
    serverLink.send({ type: 'session_list', daemonVersion: serverLink.daemonVersion, sessions });
  } catch {
    // not connected
  }
}

const RAW_BATCH_FLUSH_MS = 42;           // ~24fps flush interval
const RAW_BATCH_MAX_BYTES = 32 * 1024;   // flush immediately at 32KB

function handleSubscribe(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const session = cmd.session as string | undefined;
  if (!session) return;
  const record = getSession(session);
  // Check BOTH runtimeType and agentType to dodge a race where a freshly-
  // created transport session (copilot-sdk / cursor-headless / qwen / etc.)
  // is persisted with agentType but `runtimeType` hasn't propagated yet.
  // Without the agentType fallback, the subscribe falls through to
  // terminalStreamer → startPipe → "Terminal stream unavailable: pane id
  // not available" error in the web UI within seconds of session creation.
  const isTransport = record?.runtimeType === 'transport'
    || (typeof record?.agentType === 'string' && isTransportAgent(record.agentType));
  if (isTransport) {
    const existing = activeSubscriptions.get(session);
    if (existing) {
      existing.unsubscribe();
      activeSubscriptions.delete(session);
    }
    logger.debug({ session, agentType: record?.agentType }, 'Terminal subscribe skipped for transport session');
    return;
  }

  // The bridge may include a `raw` flag on terminal.subscribe for its own forwarding-mode
  // bookkeeping, but daemon-side terminal streaming remains transport-stable in this phase:
  // once subscribed for a session, we continue emitting both text diffs and raw PTY bytes.
  // Per-session raw PTY batching: accumulate small chunks and flush on timer or size threshold.
  let rawBatch: Buffer[] = [];
  let rawBatchBytes = 0;
  let rawBatchTimer: ReturnType<typeof setTimeout> | null = null;

  const flushRawBatch = (): void => {
    if (rawBatchTimer) { clearTimeout(rawBatchTimer); rawBatchTimer = null; }
    if (rawBatch.length === 0) return;
    const combined = rawBatch.length === 1 ? rawBatch[0] : Buffer.concat(rawBatch);
    serverLink.sendBinary(packRawFrame(session, combined));
    rawBatch = [];
    rawBatchBytes = 0;
  };

  const subscriber: StreamSubscriber = {
    sessionName: session,
    send: (diff) => {
      try { serverLink.send({ type: 'terminal_update', diff }); } catch { /* ignore */ }
    },
    sendRaw: (data: Buffer) => {
      rawBatch.push(data);
      rawBatchBytes += data.length;
      if (rawBatchBytes >= RAW_BATCH_MAX_BYTES) {
        flushRawBatch();
      } else if (!rawBatchTimer) {
        rawBatchTimer = setTimeout(flushRawBatch, RAW_BATCH_FLUSH_MS);
      }
    },
    sendControl: (msg) => {
      try { serverLink.send(msg); } catch { /* ignore */ }
    },
    onError: () => {
      if (rawBatchTimer) clearTimeout(rawBatchTimer);
      activeSubscriptions.delete(session);
    },
  };

  // Subscribe new subscriber BEFORE removing old one so the pipe never drops to 0
  // subscribers and unnecessarily stops+restarts (which causes idle→running oscillation
  // and empty-line snapshot spam).
  const unsubscribe = terminalStreamer.subscribe(subscriber);
  const existing = activeSubscriptions.get(session);
  activeSubscriptions.set(session, { subscriber, unsubscribe });
  if (existing) {
    existing.unsubscribe();
  }
  logger.debug({ session }, 'Terminal subscribed via web');
}

function handleUnsubscribe(cmd: Record<string, unknown>): void {
  const session = cmd.session as string | undefined;
  if (!session) return;

  const entry = activeSubscriptions.get(session);
  if (entry) {
    entry.unsubscribe();
    activeSubscriptions.delete(session);
    logger.debug({ session }, 'Terminal unsubscribed via web');
  }
}

function handleSnapshotRequest(cmd: Record<string, unknown>): void {
  const sessionName = cmd.sessionName as string | undefined;
  if (!sessionName) return;
  const record = getSession(sessionName);
  if (record?.runtimeType === 'transport') return;
  terminalStreamer.requestSnapshot(sessionName);
  logger.debug({ sessionName }, 'Snapshot requested via web');
}

function timelineStatusFromPayload(droppedEvents: number, truncatedEvents: number): TimelineResponseStatus {
  return droppedEvents > 0 || truncatedEvents > 0
    ? TIMELINE_RESPONSE_STATUS.PARTIAL
    : TIMELINE_RESPONSE_STATUS.OK;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timelineHistoryResponseTypeForRequest(cmd: Record<string, unknown>): typeof TIMELINE_MESSAGES.HISTORY | typeof TIMELINE_MESSAGES.PAGE {
  return cmd.type === TIMELINE_MESSAGES.PAGE_REQUEST ? TIMELINE_MESSAGES.PAGE : TIMELINE_MESSAGES.HISTORY;
}

function resolveTimelineHistoryBudgetBytes(cmd: Record<string, unknown>): number {
  const requested = optionalFiniteNumber(cmd.budgetBytes);
  const cap = TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL;
  if (requested === undefined || requested <= 0) return cap;
  return Math.max(64 * 1024, Math.min(Math.trunc(requested), cap));
}

function buildTimelineNextCursor(
  events: readonly TimelineEvent[],
  epoch: number,
  direction: 'newer' | 'older' = TIMELINE_CURSOR_DIRECTIONS.OLDER,
): TimelinePayloadMetadata['nextCursor'] | undefined {
  if (events.length === 0) return undefined;
  if (direction === TIMELINE_CURSOR_DIRECTIONS.NEWER) {
    const last = events[events.length - 1]!;
    return { epoch, afterSeq: last.seq, afterTs: last.ts, direction };
  }
  const first = events[0]!;
  return { epoch, beforeTs: first.ts, direction };
}

function measureTimelineActualPayloadBytes<T extends Record<string, unknown>>(message: T): T & { actualPayloadBytes: number } {
  let actualPayloadBytes = 0;
  let next = { ...message, actualPayloadBytes };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const encodedBytes = Buffer.byteLength(JSON.stringify(next), 'utf8');
    if (encodedBytes === actualPayloadBytes) break;
    actualPayloadBytes = encodedBytes;
    next = { ...message, actualPayloadBytes };
  }
  return next as T & { actualPayloadBytes: number };
}

function timelineWireBudgetForMessage(message: Record<string, unknown>): number | undefined {
  switch (message.type) {
    case TIMELINE_MESSAGES.PAGE:
    case TIMELINE_MESSAGES.DETAIL:
    case TIMELINE_MESSAGES.HISTORY:
    case TIMELINE_MESSAGES.REPLAY:
      return TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL;
    default:
      return undefined;
  }
}

function compactTimelineMessageToBudget<T extends Record<string, unknown>>(
  message: T,
  budgetBytes: number,
  initialActualPayloadBytes?: number,
): T {
  if (!Array.isArray(message.events)) return message;
  const startedAt = Date.now();
  const originalEvents = [...message.events];
  const originalDropped = typeof message.droppedEvents === 'number' ? message.droppedEvents : 0;
  const originalTruncated = typeof message.truncatedEvents === 'number' ? message.truncatedEvents : 0;
  const buildCandidate = (startIndex: number): Record<string, unknown> => {
    const events = originalEvents.slice(startIndex);
    const selectedEventIds = new Set(events
      .map((event) => (event && typeof event === 'object' ? (event as { eventId?: unknown }).eventId : undefined))
      .filter((eventId): eventId is string => typeof eventId === 'string'));
    const detailRefs = Array.isArray(message.detailRefs)
      ? message.detailRefs.filter((ref) => {
        if (!ref || typeof ref !== 'object') return false;
        const eventId = (ref as { eventId?: unknown }).eventId;
        return typeof eventId === 'string' && selectedEventIds.has(eventId);
      })
      : undefined;
    const droppedByEnvelope = startIndex;
    return {
      ...message,
      events,
      ...(detailRefs && detailRefs.length > 0 ? { detailRefs } : { detailRefs: undefined }),
      ...(droppedByEnvelope > 0
        ? {
          status: TIMELINE_RESPONSE_STATUS.PARTIAL,
          payloadTruncated: true,
          hasMore: true,
          droppedEvents: originalDropped + droppedByEnvelope,
          truncatedEvents: originalTruncated + droppedByEnvelope,
        }
        : {}),
    };
  };

  let low = 0;
  let high = originalEvents.length;
  let best: Record<string, unknown> | undefined;
  let compactIterations = 0;
  let bestActualPayloadBytes = 0;
  while (low <= high) {
    compactIterations += 1;
    const mid = Math.floor((low + high) / 2);
    const candidate = buildCandidate(mid);
    const bytes = measureTimelineActualPayloadBytes(candidate).actualPayloadBytes;
    if (bytes <= budgetBytes) {
      best = candidate;
      bestActualPayloadBytes = bytes;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  if (best) {
    recordTimelineBudgetShape({
      type: typeof message.type === 'string' ? message.type : undefined,
      budgetBytes,
      initialActualPayloadBytes,
      finalActualPayloadBytes: bestActualPayloadBytes,
      initialEventCount: originalEvents.length,
      finalEventCount: Array.isArray(best.events) ? best.events.length : 0,
      compactIterations,
      durationMs: Date.now() - startedAt,
      result: 'partial',
    });
    return best as T;
  }
  const errorMessage = {
    ...message,
    events: [],
    detailRefs: undefined,
    status: TIMELINE_RESPONSE_STATUS.ERROR,
    source: TIMELINE_RESPONSE_SOURCES.ERROR,
    errorReason: TIMELINE_REQUEST_ERROR_REASONS.PAYLOAD_TOO_LARGE,
    payloadBytes: 2,
    payloadTruncated: true,
    hasMore: true,
    droppedEvents: (typeof message.droppedEvents === 'number' ? message.droppedEvents : 0) + (Array.isArray(message.events) ? message.events.length : 0),
    truncatedEvents: (typeof message.truncatedEvents === 'number' ? message.truncatedEvents : 0) + (Array.isArray(message.events) ? message.events.length : 0),
  } as T;
  const finalActualPayloadBytes = measureTimelineActualPayloadBytes(errorMessage).actualPayloadBytes;
  recordTimelineBudgetShape({
    type: typeof message.type === 'string' ? message.type : undefined,
    budgetBytes,
    initialActualPayloadBytes,
    finalActualPayloadBytes,
    initialEventCount: originalEvents.length,
    finalEventCount: 0,
    compactIterations,
    durationMs: Date.now() - startedAt,
    result: 'payload_too_large',
  });
  return errorMessage;
}

function withTimelineActualPayloadBytes<T extends Record<string, unknown>>(message: T): T & { actualPayloadBytes: number } {
  const budgetBytes = timelineWireBudgetForMessage(message);
  const measured = measureTimelineActualPayloadBytes(message);
  if (budgetBytes === undefined || measured.actualPayloadBytes <= budgetBytes) return measured;
  return measureTimelineActualPayloadBytes(compactTimelineMessageToBudget(message, budgetBytes, measured.actualPayloadBytes));
}

function sendTimelineMessage<T extends Record<string, unknown>>(serverLink: ServerLink, message: T): T & { actualPayloadBytes: number } {
  const wireMessage = withTimelineActualPayloadBytes(message);
  serverLink.send(wireMessage);
  return wireMessage;
}

function sendTimelineReplayError(
  serverLink: ServerLink,
  sessionName: string | undefined,
  requestId: string | undefined,
  errorReason: TimelineRequestErrorReason,
): void {
  try {
    sendTimelineMessage(serverLink, {
      type: TIMELINE_MESSAGES.REPLAY,
      sessionName,
      requestId,
      events: [],
      truncated: false,
      epoch: timelineEmitter.epoch,
      status: TIMELINE_RESPONSE_STATUS.ERROR,
      errorReason,
      source: TIMELINE_RESPONSE_SOURCES.ERROR,
      payloadBytes: 2,
      payloadTruncated: false,
      hasMore: false,
      droppedEvents: 0,
      truncatedEvents: 0,
    });
  } catch { /* not connected */ }
}

interface TimelineReplayRequestParams {
  sessionName: string;
  afterSeq: number;
  requestEpoch: number;
}

interface TimelineReplayBuildResult {
  events: TimelineEvent[];
  truncated: boolean;
  epoch: number;
  status: TimelineResponseStatus;
  source: TimelineResponseSource | string;
  payloadBytes: number;
  payloadTruncated: boolean;
  hasMore: boolean;
  nextCursor?: TimelinePayloadMetadata['nextCursor'];
  cursorReset?: boolean;
  droppedEvents: number;
  truncatedEvents: number;
  detailRefs?: TimelinePayloadMetadata['detailRefs'];
}

const timelineReplayInflight = new Map<string, Promise<TimelineReplayBuildResult>>();

function timelineReplayInflightKey(params: TimelineReplayRequestParams): string {
  return JSON.stringify({
    sessionName: params.sessionName,
    afterSeq: params.afterSeq,
    requestEpoch: params.requestEpoch,
    epoch: timelineEmitter.epoch,
  });
}

async function buildTimelineReplay(params: TimelineReplayRequestParams): Promise<TimelineReplayBuildResult> {
  if (params.requestEpoch !== timelineEmitter.epoch) {
    // Epoch reset (client reconnected across a daemon restart) — serve the
    // latest events from the SQLite projection, the sole chat-history read
    // source. readPreferred returns the most recent N events (across epochs)
    // ascending, which is exactly what a cursor-reset replay needs to re-sync.
    // No JSONL `read()` fallback: on projection unavailability this throws
    // TimelinePreferredReadError and handleTimelineReplay turns it into a
    // replay error response rather than degrading to a synchronous JSONL scan
    // (JSONL is now write/backup-only).
    const replayEpochResetLimit = 200;
    const events = await timelineStore.readPreferred(params.sessionName, { limit: replayEpochResetLimit });
    const shaped = shapeTimelineEventsForTransport(events, {
      detailSink: getDefaultTimelineDetailStore(),
    });
    const payloadTruncated = shaped.droppedEvents > 0 || shaped.truncatedEvents > 0;
    return {
      events: shaped.events,
      truncated: false,
      epoch: timelineEmitter.epoch,
      status: timelineStatusFromPayload(shaped.droppedEvents, shaped.truncatedEvents),
      source: TIMELINE_RESPONSE_SOURCES.MAIN_SQLITE,
      payloadBytes: shaped.payloadBytes,
      payloadTruncated,
      hasMore: shaped.droppedEvents > 0,
      nextCursor: buildTimelineNextCursor(shaped.events, timelineEmitter.epoch),
      cursorReset: true,
      droppedEvents: shaped.droppedEvents,
      truncatedEvents: shaped.truncatedEvents,
      detailRefs: shaped.detailRefs.length > 0 ? shaped.detailRefs : undefined,
    };
  }

  const { events, truncated, source = TIMELINE_RESPONSE_SOURCES.RING_BUFFER } = timelineEmitter.replay(params.sessionName, params.afterSeq);
  const shaped = shapeTimelineEventsForTransport(events, {
    detailSink: getDefaultTimelineDetailStore(),
  });
  const payloadTruncated = shaped.droppedEvents > 0 || shaped.truncatedEvents > 0;
  return {
    events: shaped.events,
    truncated,
    epoch: timelineEmitter.epoch,
    status: timelineStatusFromPayload(shaped.droppedEvents, shaped.truncatedEvents),
    source,
    payloadBytes: shaped.payloadBytes,
    payloadTruncated,
    hasMore: shaped.droppedEvents > 0,
    nextCursor: buildTimelineNextCursor(shaped.events, timelineEmitter.epoch, TIMELINE_CURSOR_DIRECTIONS.NEWER),
    droppedEvents: shaped.droppedEvents,
    truncatedEvents: shaped.truncatedEvents,
    detailRefs: shaped.detailRefs.length > 0 ? shaped.detailRefs : undefined,
  };
}

function getTimelineReplayResult(params: TimelineReplayRequestParams): Promise<TimelineReplayBuildResult> {
  const key = timelineReplayInflightKey(params);
  const existing = timelineReplayInflight.get(key);
  if (existing) return existing;
  const promise = new Promise<TimelineReplayBuildResult>((resolve, reject) => {
    setImmediate(() => {
      buildTimelineReplay(params).then(resolve, reject);
    });
  }).finally(() => {
    timelineReplayInflight.delete(key);
  });
  timelineReplayInflight.set(key, promise);
  return promise;
}

async function handleTimelineReplay(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  const afterSeq = cmd.afterSeq as number | undefined;
  const requestEpoch = cmd.epoch as number | undefined;
  const requestId = cmd.requestId as string | undefined;

  if (!sessionName || afterSeq === undefined || requestEpoch === undefined) {
    logger.warn({ sessionName, requestId }, 'timeline.replay_request: missing fields');
    sendTimelineReplayError(serverLink, sessionName, requestId, TIMELINE_REQUEST_ERROR_REASONS.MALFORMED_REQUEST);
    return;
  }

  try {
    const result = await getTimelineReplayResult({ sessionName, afterSeq, requestEpoch });
    sendTimelineMessage(serverLink, {
      type: TIMELINE_MESSAGES.REPLAY,
      sessionName,
      requestId,
      ...result,
    });
  } catch (err) {
    logger.warn({ err, sessionName, requestId }, 'timeline.replay_request failed');
    sendTimelineReplayError(serverLink, sessionName, requestId, TIMELINE_REQUEST_ERROR_REASONS.INTERNAL_ERROR);
  }
}

function handleTimelineDetailRequest(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const sessionName = cmd.sessionName as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  const detailId = cmd.detailId as string | undefined;
  const eventId = cmd.eventId as string | undefined;
  const fieldPath = cmd.fieldPath as string | undefined;
  const epoch = optionalFiniteNumber(cmd.epoch);
  const detailStoreGeneration = typeof cmd.detailStoreGeneration === 'string'
    ? cmd.detailStoreGeneration
    : undefined;
  const sendError = (errorReason: string): void => {
    try {
      sendTimelineMessage(serverLink, {
        type: TIMELINE_MESSAGES.DETAIL,
        sessionName,
        requestId,
        detailId,
        eventId,
        fieldPath,
        status: TIMELINE_RESPONSE_STATUS.ERROR,
        errorReason,
        source: TIMELINE_RESPONSE_SOURCES.ERROR,
        payloadBytes: 2,
        payloadTruncated: false,
        hasMore: false,
      });
    } catch { /* not connected */ }
  };
  if (!sessionName || !detailId || epoch === undefined) {
    sendError(TIMELINE_DETAIL_ERROR_REASONS.MALFORMED);
    return;
  }
  if (!getSession(sessionName)) {
    sendError(TIMELINE_DETAIL_ERROR_REASONS.MISSING);
    return;
  }
  let result;
  try {
    result = getDefaultTimelineDetailStore().get({
      sessionName,
      epoch,
      detailId,
      detailStoreGeneration,
      eventId,
      fieldPath,
    });
  } catch (err) {
    logger.warn({ err, sessionName, requestId }, 'timeline.detail_request failed');
    sendError(TIMELINE_DETAIL_ERROR_REASONS.INTERNAL_ERROR);
    return;
  }
  if (!result.ok) {
    sendError(result.reason);
    return;
  }
  const detailValue = result.entry.value;
  if (typeof detailValue !== 'string') {
    sendError(TIMELINE_DETAIL_ERROR_REASONS.OVERSIZED);
    return;
  }
  const responseEnvelope = {
    type: TIMELINE_MESSAGES.DETAIL,
    sessionName,
    requestId,
    detailId: result.entry.detailId,
    eventId: result.entry.eventId,
    fieldPath: result.entry.fieldPath,
    status: TIMELINE_RESPONSE_STATUS.OK,
    source: TIMELINE_RESPONSE_SOURCES.CACHE,
    mediaType: result.entry.mediaType,
    epoch: result.entry.epoch,
    detailStoreGeneration: result.entry.generation,
  };
  const shaped = shapeTimelineDetailValueForTransport(detailValue, responseEnvelope);
  if (!shaped.ok) {
    sendError(shaped.errorReason);
    return;
  }
  try {
    sendTimelineMessage(serverLink, {
      ...responseEnvelope,
      payloadBytes: shaped.payloadBytes,
      actualPayloadBytes: shaped.payloadBytes,
      payloadTruncated: shaped.payloadTruncated,
      hasMore: false,
      value: shaped.value,
    });
  } catch { /* not connected */ }
}

const OPENCODE_SYNTH_HISTORY_OVERLAP_MS = 60_000;

export function getOpenCodeSynthesizedAfterTs(afterTs: number | undefined): number | undefined {
  return afterTs === undefined ? undefined : Math.max(0, afterTs - OPENCODE_SYNTH_HISTORY_OVERLAP_MS);
}

/** Handle timeline.history_request — browser requesting full session history on open. */
export function hasSubstantiveTimelineHistory(events: Array<{ type: string }>): boolean {
  return events.some((event) => (
    event.type === 'user.message'
    || event.type === 'assistant.text'
    || event.type === 'assistant.thinking'
    || event.type === 'tool.call'
    || event.type === 'tool.result'
    || event.type === 'ask.question'
  ));
}

export function countSubstantiveTimelineEvents(events: Array<{ type: string }>): number {
  return events.filter((event) => (
    event.type === 'user.message'
    || event.type === 'assistant.text'
    || event.type === 'assistant.thinking'
    || event.type === 'tool.call'
    || event.type === 'tool.result'
    || event.type === 'ask.question'
  )).length;
}

function compareTimelineEventsForReplay(a: TimelineEvent, b: TimelineEvent): number {
  return a.ts - b.ts || a.seq - b.seq || a.eventId.localeCompare(b.eventId);
}

async function recoverOpenCodeSessionRecord(record: SessionRecord | undefined): Promise<SessionRecord | undefined> {
  if (!record || record.agentType !== 'opencode' || !record.projectDir) return record;
  try {
    let paneCmd = '';
    try {
      paneCmd = await getPaneStartCommand(record.name);
    } catch { /* ignore */ }
    const explicitPaneId = paneCmd.match(/\bopencode\b[\s\S]*?(?:--session|-s)\s+(?:"([^"]+)"|'([^']+)'|([^\s"'`;|&]+))/)?.slice(1).find(Boolean);
    if (explicitPaneId) {
      if (record.opencodeSessionId === explicitPaneId) return record;
      const next = { ...record, opencodeSessionId: explicitPaneId };
      upsertSession(next);
      return next;
    }

    const { discoverLatestOpenCodeSessionId } = await import('./opencode-history.js');
    const opencodeSessionId = await discoverLatestOpenCodeSessionId(record.projectDir, {
      exactDirectory: record.projectDir,
      maxCount: 50,
    });
    if (!opencodeSessionId || opencodeSessionId === record.opencodeSessionId) return record;
    const next = { ...record, opencodeSessionId };
    upsertSession(next);
    return next;
  } catch (err) {
    logger.debug({ err, sessionName: record.name, projectDir: record.projectDir }, 'Failed to recover OpenCode session ID from local history');
    return record;
  }
}

interface TimelineHistoryRequestParams {
  sessionName: string;
  requestId?: string;
  limit: number;
  afterTs?: number;
  beforeTs?: number;
  maxResponseBytes: number;
}

interface TimelineHistoryBuildResult {
  events: TimelineEvent[];
  eventsRead: number;
  payloadBytes: number;
  droppedEvents: number;
  truncatedEvents: number;
  readMs: number;
  synthesizeMs: number;
  sanitizeMs: number;
  source: TimelineResponseSource | string;
  status: TimelineResponseStatus;
  errorReason?: TimelineRequestErrorReason | string;
  cursorReset?: boolean;
  detailRefs: TimelinePayloadMetadata['detailRefs'];
}

const timelineHistoryInflight = new Map<string, Promise<TimelineHistoryBuildResult>>();

function timelineHistoryErrorResult(source: string, errorReason: TimelineRequestErrorReason | string): TimelineHistoryBuildResult {
  return {
    events: [],
    eventsRead: 0,
    payloadBytes: 2,
    droppedEvents: 0,
    truncatedEvents: 0,
    readMs: 0,
    synthesizeMs: 0,
    sanitizeMs: 0,
    source,
    status: TIMELINE_RESPONSE_STATUS.ERROR,
    errorReason,
    detailRefs: [],
  };
}

function timelineHistoryInflightKey(params: TimelineHistoryRequestParams): string {
  return JSON.stringify({
    sessionName: params.sessionName,
    limit: params.limit,
    afterTs: params.afterTs ?? null,
    beforeTs: params.beforeTs ?? null,
    maxResponseBytes: params.maxResponseBytes,
  });
}

function buildTimelineHistory(params: TimelineHistoryRequestParams): Promise<TimelineHistoryBuildResult> {
  const initialRecord = getSession(params.sessionName);
  if (shouldUseTimelineHistoryWorkerPool() && initialRecord?.agentType !== 'opencode') {
    return buildTimelineHistoryWithWorker(params).catch(async (err) => {
      const reason = err instanceof TimelineHistoryPoolError ? err.reason : 'unknown';
      if (reason === TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_UNAVAILABLE) {
        logger.debug({ sessionName: params.sessionName, requestId: params.requestId, reason }, 'timeline.history worker unavailable; falling back to projection client');
        return await buildTimelineHistoryOnMain(params);
      }
      logger.warn({ sessionName: params.sessionName, requestId: params.requestId, reason }, 'timeline.history worker failed; returning terminal error response');
      return timelineHistoryErrorResult(`worker_${reason}`, reason);
    });
  }
  return buildTimelineHistoryOnMain(params);
}

function getTimelineHistoryResult(params: TimelineHistoryRequestParams): Promise<TimelineHistoryBuildResult> {
  const key = timelineHistoryInflightKey(params);
  const existing = timelineHistoryInflight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(() => buildTimelineHistory(params)).finally(() => {
    timelineHistoryInflight.delete(key);
  });
  timelineHistoryInflight.set(key, promise);
  return promise;
}

async function buildTimelineHistoryOnMain(params: TimelineHistoryRequestParams): Promise<TimelineHistoryBuildResult> {
  let readMs = 0;
  let synthesizeMs = 0;

  // Query content by type instead of over-reading and filtering in JS. SQLite
  // has (session_id, type, ts) indexes; using them keeps the common path near
  // O(requested rows) instead of decoding thousands of unrelated state events.
  // Do NOT filter by epoch — history should include events across daemon restarts.
  const tRead0 = Date.now();
  let substantive: TimelineEvent[];
  let stateEvents: TimelineEvent[] = [];
  try {
    substantive = await timelineStore.readByTypesPreferred(
      params.sessionName,
      [...TIMELINE_HISTORY_CONTENT_TYPES],
      { limit: params.limit, afterTs: params.afterTs, beforeTs: params.beforeTs },
    );
  } catch (err) {
    if (err instanceof TimelinePreferredReadError) {
      return timelineHistoryErrorResult(err.source, err.reason);
    }
    throw err;
  }
  if (substantive.length > 0) {
    const cutoffTs = substantive[0]!.ts;
    const stateAfterTs = params.afterTs === undefined ? cutoffTs - 1 : Math.max(params.afterTs, cutoffTs - 1);
    try {
      stateEvents = await timelineStore.readByTypesPreferred(
        params.sessionName,
        [...TIMELINE_HISTORY_STATE_TYPES],
        { limit: Math.max(params.limit * 2, 100), afterTs: stateAfterTs, beforeTs: params.beforeTs },
      );
    } catch (err) {
      if (err instanceof TimelinePreferredReadError) {
        return timelineHistoryErrorResult(err.source, err.reason);
      }
      throw err;
    }
  }
  const events = [...substantive, ...stateEvents].sort(compareTimelineEventsForReplay);
  readMs = Date.now() - tRead0;

  // Content-aware limit: session.state events don't count toward the budget.
  // This prevents idle↔running oscillation storms from crowding out user.message events.
  const trimmedSubstantive = substantive.length > params.limit ? substantive.slice(substantive.length - params.limit) : substantive;
  let trimmed: TimelineEvent[];
  if (trimmedSubstantive.length > 0 && stateEvents.length > 0) {
    const cutoffTs = trimmedSubstantive[0]!.ts;
    const relevantState = stateEvents.filter((event) => event.ts >= cutoffTs);
    trimmed = [...trimmedSubstantive, ...relevantState].sort(compareTimelineEventsForReplay);
  } else {
    trimmed = trimmedSubstantive;
  }

  const record = await recoverOpenCodeSessionRecord(getSession(params.sessionName));
  let opencodeInitialDeferred = false;
  let opencodeSynthesized = false;
  if (record?.agentType === 'opencode' && record.projectDir && record.opencodeSessionId) {
    const initialHistoryRequest = params.afterTs === undefined && params.beforeTs === undefined;
    if (initialHistoryRequest) {
      opencodeInitialDeferred = !hasSubstantiveTimelineHistory(trimmed);
    } else {
      const tSyn0 = Date.now();
      try {
        const { exportOpenCodeSession, buildTimelineEventsFromOpenCodeExport } = await import('./opencode-history.js');
        const exportData = await exportOpenCodeSession(record.projectDir, record.opencodeSessionId);
        opencodeSynthesized = true;
        const synthesizedAfterTs = getOpenCodeSynthesizedAfterTs(params.afterTs);
        const synthesized = buildTimelineEventsFromOpenCodeExport(params.sessionName, exportData, timelineEmitter.epoch)
          .filter((event) => synthesizedAfterTs === undefined || event.ts > synthesizedAfterTs)
          .filter((event) => params.beforeTs === undefined || event.ts < params.beforeTs);
        const synthesizedTrimmed = synthesized.length > params.limit ? synthesized.slice(synthesized.length - params.limit) : synthesized;
        if (
          !hasSubstantiveTimelineHistory(trimmed)
          || countSubstantiveTimelineEvents(synthesizedTrimmed) > countSubstantiveTimelineEvents(trimmed)
        ) {
          trimmed = synthesizedTrimmed;
        }
      } catch (err) {
        logger.debug({ err, sessionHash: hashSessionName(params.sessionName), opencodeSessionId: record.opencodeSessionId }, 'Failed to synthesize OpenCode timeline history');
      }
      synthesizeMs = Date.now() - tSyn0;
    }
  }

  const tSanitize = Date.now();
  const sanitized = shapeTimelineEventsForTransport(trimmed, {
    maxResponseBytes: params.maxResponseBytes,
    detailSink: getDefaultTimelineDetailStore(),
  });
  const status = opencodeInitialDeferred
    ? TIMELINE_RESPONSE_STATUS.DEFERRED
    : timelineStatusFromPayload(sanitized.droppedEvents, sanitized.truncatedEvents);
  return {
    events: sanitized.events,
    eventsRead: events.length,
    payloadBytes: sanitized.payloadBytes,
    droppedEvents: sanitized.droppedEvents,
    truncatedEvents: sanitized.truncatedEvents,
    readMs,
    synthesizeMs,
    sanitizeMs: Date.now() - tSanitize,
    source: opencodeInitialDeferred
      ? TIMELINE_RESPONSE_SOURCES.DEFERRED
      : opencodeSynthesized
      ? TIMELINE_RESPONSE_SOURCES.OPENCODE_EXPORT
      : TIMELINE_RESPONSE_SOURCES.MAIN_SQLITE,
    status,
    errorReason: opencodeInitialDeferred ? TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_UNAVAILABLE : undefined,
    detailRefs: sanitized.detailRefs,
  };
}

async function buildTimelineHistoryWithWorker(params: TimelineHistoryRequestParams): Promise<TimelineHistoryBuildResult> {
  const result = await getDefaultTimelineHistoryWorkerPool().dispatch({
    sessionName: params.sessionName,
    limit: params.limit,
    afterTs: params.afterTs,
    beforeTs: params.beforeTs,
    maxResponseBytes: params.maxResponseBytes,
    contentTypes: [...TIMELINE_HISTORY_CONTENT_TYPES],
    stateTypes: [...TIMELINE_HISTORY_STATE_TYPES],
  }, { deadlineAt: Date.now() + 4_500 });
  const detailRefs = (result.detailCandidates ?? [])
    .map((candidate) => getDefaultTimelineDetailStore().put(candidate))
    .filter((ref): ref is NonNullable<typeof ref> => ref !== undefined);
  return {
    events: result.events,
    eventsRead: result.eventsRead,
    payloadBytes: result.payloadBytes,
    droppedEvents: result.droppedEvents,
    truncatedEvents: result.truncatedEvents,
    readMs: result.readMs,
    synthesizeMs: 0,
    sanitizeMs: result.sanitizeMs,
    source: result.source ?? TIMELINE_RESPONSE_SOURCES.WORKER_SQLITE,
    status: timelineStatusFromPayload(result.droppedEvents, result.truncatedEvents),
    detailRefs,
  };
}

async function handleTimelineHistory(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  const rawLimit = cmd.limit;
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 2000) : 500;
  const cursor = cmd.cursor && typeof cmd.cursor === 'object' && !Array.isArray(cmd.cursor)
    ? cmd.cursor as Record<string, unknown>
    : undefined;
  const afterTs = optionalFiniteNumber(cmd.afterTs) ?? optionalFiniteNumber(cursor?.afterTs);
  const beforeTs = optionalFiniteNumber(cmd.beforeTs) ?? optionalFiniteNumber(cursor?.beforeTs);
  const maxResponseBytes = resolveTimelineHistoryBudgetBytes(cmd);

  if (!sessionName) {
    logger.warn({ requestId }, 'timeline.history_request: missing sessionName');
    try {
      sendTimelineMessage(serverLink, {
        type: timelineHistoryResponseTypeForRequest(cmd),
        sessionName,
        requestId,
        events: [],
        epoch: timelineEmitter.epoch,
        status: TIMELINE_RESPONSE_STATUS.ERROR,
        errorReason: TIMELINE_REQUEST_ERROR_REASONS.MALFORMED_REQUEST,
        source: TIMELINE_RESPONSE_SOURCES.ERROR,
        payloadBytes: 2,
        payloadTruncated: false,
        hasMore: false,
        droppedEvents: 0,
        truncatedEvents: 0,
      });
    } catch { /* not connected */ }
    return;
  }

  const params: TimelineHistoryRequestParams = { sessionName, requestId, limit, afterTs, beforeTs, maxResponseBytes };
  const tStart = Date.now();
  try {
    const result = await getTimelineHistoryResult(params);
    const sent = sendTimelineMessage(serverLink, {
      type: timelineHistoryResponseTypeForRequest(cmd),
      sessionName,
      requestId,
      events: result.events,
      epoch: timelineEmitter.epoch,
      status: result.status,
      errorReason: result.errorReason,
      source: result.source,
      payloadBytes: result.payloadBytes,
      payloadTruncated: result.droppedEvents > 0 || result.truncatedEvents > 0,
      hasMore: result.droppedEvents > 0,
      nextCursor: buildTimelineNextCursor(result.events, timelineEmitter.epoch),
      cursorReset: result.cursorReset,
      droppedEvents: result.droppedEvents,
      truncatedEvents: result.truncatedEvents,
      detailRefs: result.detailRefs && result.detailRefs.length > 0 ? result.detailRefs : undefined,
    });
    const totalMs = Date.now() - tStart;
    const requestedBudgetBytes = optionalFiniteNumber(cmd.budgetBytes);
    logger.info({
      sessionHash: hashSessionName(sessionName),
      requestId,
      requestType: typeof cmd.type === 'string' ? cmd.type : undefined,
      responseType: sent.type,
      limit,
      afterTs,
      beforeTs,
      includeDetails: cmd.includeDetails === true,
      ...(requestedBudgetBytes !== undefined ? { requestedBudgetBytes } : {}),
      maxResponseBytes,
      actualPayloadBytes: sent.actualPayloadBytes,
      source: result.source,
      eventsReturned: result.events.length,
      eventsRead: result.eventsRead,
      eventsDropped: result.droppedEvents,
      truncatedEvents: result.truncatedEvents,
      payloadBytes: result.payloadBytes,
      readMs: result.readMs,
      synthesizeMs: result.synthesizeMs,
      sanitizeMs: result.sanitizeMs,
      totalMs,
    }, 'timeline.history served');
    return;
  } catch (err) {
    logger.error({ err, sessionHash: hashSessionName(sessionName), requestId }, 'timeline.history_request unexpectedly failed');
    try {
      sendTimelineMessage(serverLink, {
        type: timelineHistoryResponseTypeForRequest(cmd),
        sessionName,
        requestId,
        events: [],
        epoch: timelineEmitter.epoch,
        status: TIMELINE_RESPONSE_STATUS.ERROR,
        errorReason: TIMELINE_REQUEST_ERROR_REASONS.INTERNAL_ERROR,
        source: TIMELINE_RESPONSE_SOURCES.ERROR,
        payloadBytes: 2,
        payloadTruncated: false,
        hasMore: false,
        droppedEvents: 0,
        truncatedEvents: 0,
      });
    } catch { /* not connected */ }
    return;
  }
}

// ── Sub-session handlers ──────────────────────────────────────────────────

async function handleSubSessionStart(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const id = cmd.id as string | undefined;
  const type = cmd.sessionType as string | undefined;
  if (!id || !type) {
    logger.warn('subsession.start: missing id or type');
    return;
  }
  // Resolve a unique Gemini session ID so each sub-session gets its own conversation
  let geminiSessionId: string | null = null;
  let fileSnapshot: Set<string> | undefined;
  if (type === 'gemini') {
    // Snapshot existing files BEFORE resolving — used as fallback if resolve fails
    const { snapshotSessionFiles } = await import('./gemini-watcher.js');
    fileSnapshot = await snapshotSessionFiles();
    try {
      const { GeminiDriver } = await import('../agent/drivers/gemini.js');
      geminiSessionId = await new GeminiDriver().resolveSessionId(
        (cmd.cwd as string | undefined) ?? undefined,
      );
      logger.info({ id, geminiSessionId }, 'Resolved Gemini session ID for sub-session');
      // Persist to DB so rebuild can use the exact UUID
      serverLink.send({ type: 'subsession.update_gemini_id', id, geminiSessionId });
      fileSnapshot = undefined; // no longer needed
    } catch (e) {
      logger.warn({ err: e, id }, 'Failed to resolve Gemini session ID — using snapshot-diff fallback');
    }
  }
  const cwd = cmd.cwd as string | null | undefined;
  const shellBin = cmd.shellBin as string | null | undefined;
  const ccSessionId = cmd.ccSessionId as string | null | undefined;
  const parentSession = cmd.parentSession as string | null | undefined;
  const ccPreset = cmd.ccPreset as string | null | undefined;
  const requestedEffort: unknown = cmd.thinking ?? cmd.effort;
  const effort = isTransportEffortLevel(requestedEffort)
    ? requestedEffort
    : getDefaultThinkingLevel(type);
  const sessionName = subSessionName(id);
  if (isKnownTestSessionName(parentSession)) {
    logger.warn({ id, type, cwd, parentSession }, 'subsession.start rejected by test-session guard');
    return;
  }

  // Transport-backed providers: launch without tmux.
  if (isTransportAgent(type)) {
    const ocMode = cmd.ocMode as string | undefined;
    const bindExistingKey = type === 'openclaw'
      ? (ocMode === 'bind' ? (cmd.ocSessionId as string) || undefined : undefined)
      : ((cmd.providerSessionId as string | undefined) || undefined);
    const description = ((cmd.ocDescription as string) || (cmd.description as string) || '').trim() || undefined;
    if (bindExistingKey && isProviderSessionBound(bindExistingKey)) {
      logger.warn({ id, bindExistingKey }, 'subsession.start: providerSessionId already bound — skipped');
      return;
    }
    try {
      await launchTransportSession({
        name: sessionName,
        projectName: sessionName,
        role: 'w1',
        agentType: type as any,
        projectDir: (cwd as string) || process.cwd(),
        description,
        requestedModel: (cmd.requestedModel as string | undefined) ?? (cmd.model as string | undefined),
        transportConfig: (cmd.transportConfig as Record<string, unknown> | undefined) ?? undefined,
        bindExistingKey,
        ...(ccPreset ? { ccPreset } : {}),
        ...(type === 'claude-code-sdk' ? { ccSessionId: randomUUID(), fresh: true } : {}),
        ...(type === 'codex-sdk' || type === 'kimi-sdk' ? { fresh: true } : {}),
        ...(effort ? { effort } : {}),
        userCreated: true,
        parentSession: parentSession || undefined,
      });
      // Sync to server DB
      try {
        await sendSubSessionSync(serverLink, id);
      } catch { /* not connected */ }
    } catch (e: unknown) {
      logger.error({ err: e, id, type }, 'subsession.start failed (transport)');
      const now = Date.now();
      const errMsg = e instanceof Error ? e.message : String(e);
      const existing = getSession(sessionName);
      const errorRecord: SessionRecord = {
        name: sessionName,
        projectName: existing?.projectName ?? sessionName,
        role: existing?.role ?? 'w1',
        agentType: type,
        projectDir: existing?.projectDir ?? ((cwd as string) || process.cwd()),
        state: 'error',
        restarts: existing?.restarts ?? 0,
        restartTimestamps: existing?.restartTimestamps ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        runtimeType: 'transport',
        providerId: type,
        ...(description ? { description } : {}),
        ...(ccPreset ? { ccPreset } : {}),
        ...(effort ? { effort } : {}),
        ...(parentSession ? { parentSession } : {}),
        ...(cmd.requestedModel || cmd.model
          ? { requestedModel: ((cmd.requestedModel as string | undefined) ?? (cmd.model as string | undefined)) }
          : {}),
        userCreated: true,
      };
      upsertSession(errorRecord);
      timelineEmitter.emit(
        sessionName,
        'session.state',
        { state: 'error', error: errMsg },
        { source: 'daemon', confidence: 'high' },
      );
    }
    return;
  }
  const subCcInitPrompt = cmd.ccInitPrompt as string | null | undefined;
  const description = cmd.description as string | null | undefined;

  try {
    await startSubSession({
      id,
      type,
      shellBin,
      cwd,
      ccSessionId,
      parentSession,
      geminiSessionId,
      ccPreset,
      ccInitPrompt: subCcInitPrompt,
      description,
      effort,
      fresh: type === 'gemini' && !geminiSessionId,
      _fileSnapshot: fileSnapshot,
      _onGeminiDiscovered: fileSnapshot ? (sessionId: string) => {
        logger.info({ id, sessionId }, 'Discovered Gemini session ID via snapshot-diff');
        try { serverLink.send({ type: 'subsession.update_gemini_id', id, geminiSessionId: sessionId }); } catch { /* ignore */ }
      } : undefined,
    });
    // Sync to server DB so frontend can see the sub-session
    try {
      await sendSubSessionSync(serverLink, id);
    } catch { /* not connected */ }
  } catch (e: unknown) {
    logger.error({ err: e, id }, 'subsession.start failed');
  }
}

async function handleSubSessionStop(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sName = cmd.sessionName as string | undefined;
  if (!sName) {
    logger.warn('subsession.stop: missing sessionName');
    return;
  }
  const result = await stopSubSession(sName, serverLink).catch((e: unknown) => {
    logger.error({ err: e, sName }, 'subsession.stop failed');
    return null;
  });
  if (!result || result.ok) return;
  logger.warn({ sessionName: sName, failed: result.failed }, 'subsession.stop completed with shutdown failures');
}

async function handleSubSessionRestart(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sName = cmd.sessionName as string | undefined;
  if (!sName) {
    logger.warn('subsession.restart: missing sessionName');
    return;
  }
  const record = getSession(sName);
  if (!record) {
    logger.warn({ sessionName: sName }, 'subsession.restart: session not found in store');
    return;
  }
  const id = sName.replace(/^deck_sub_/, '');
  try {
    await runExclusiveSessionRelaunch(sName, async () => {
      try {
        const effectiveRecord = (await recoverOpenCodeSessionRecord(record)) ?? record;
        await relaunchSessionWithSettings(effectiveRecord, {
          agentType: (cmd.agentType as any) ?? undefined,
          projectDir: ('cwd' in cmd ? (cmd.cwd as string | undefined) : undefined),
          label: ('label' in cmd ? (cmd.label as string | null) : undefined),
          description: ('description' in cmd ? (cmd.description as string | null) : undefined),
          requestedModel: ('requestedModel' in cmd ? (cmd.requestedModel as string | null) : undefined),
          effort: ('effort' in cmd ? (cmd.effort as any) : undefined),
          transportConfig: ('transportConfig' in cmd ? (cmd.transportConfig as Record<string, unknown> | null) : undefined),
        });
        try {
          await sendSubSessionSync(serverLink, id);
        } catch { /* not connected */ }
      } catch (e: unknown) {
        logger.error({ err: e, sessionName: sName }, 'subsession.restart failed');
        throw e;
      }
    });
  } catch {
    // Failure already logged; keep command handler alive for future sends.
  }
}

async function handleSubSessionRebuildAll(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const subSessions = cmd.subSessions as SubSessionRecord[] | undefined;
  if (!Array.isArray(subSessions)) return;
  await rebuildSubSessions(subSessions).catch((e: unknown) => logger.error({ err: e }, 'subsession.rebuild_all failed'));
  for (const sub of subSessions) {
    try {
      await sendSubSessionSync(serverLink, sub.id);
    } catch (e) {
      logger.warn({ err: e, id: sub.id }, 'Failed to sync rebuilt sub-session');
    }
  }
}

async function handleSubSessionDetectShells(serverLink: ServerLink): Promise<void> {
  const shells = await detectShells().catch(() => [] as string[]);
  try {
    serverLink.send({ type: 'subsession.shells', shells });
  } catch { /* not connected */ }
}

async function handleSubSessionSetModel(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  const model = cmd.model as string | undefined;
  const cwd = cmd.cwd as string | undefined;

  if (!sessionName || !model) {
    logger.warn('subsession.set_model: missing sessionName or model');
    return;
  }

  // Extract sub-session id from name (deck_sub_{id})
  const prefix = 'deck_sub_';
  const id = sessionName.startsWith(prefix) ? sessionName.slice(prefix.length) : null;
  if (!id) {
    logger.warn({ sessionName }, 'subsession.set_model: invalid session name');
    return;
  }

  logger.info({ sessionName, model }, 'Restarting Codex sub-session with new model');
  await stopSubSession(sessionName, serverLink).catch(() => {});
  try {
    await startSubSession({ id, type: 'codex', cwd: cwd ?? null, codexModel: model });
    // Sync restarted sub-session to server DB
    try {
      await sendSubSessionSync(serverLink, id);
    } catch { /* not connected */ }
  } catch (e: unknown) {
    logger.error({ err: e, sessionName, model }, 'subsession.set_model restart failed');
  }
}

async function handleSubSessionReadResponse(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sName = cmd.sessionName as string | undefined;
  if (!sName) return;
  const result = await readSubSessionResponse(sName).catch(() => ({ status: 'working' as const }));
  try {
    serverLink.send({ type: 'subsession.response', sessionName: sName, ...result });
  } catch { /* not connected */ }
}

async function handleAskAnswer(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  const answer = cmd.answer as string | undefined;
  if (!sessionName || answer === undefined) {
    logger.warn('ask.answer: missing sessionName or answer');
    return;
  }
  // Transport (SDK) sessions have no TUI to type into. Deliver the chosen answer
  // as an ordinary message via handleSend (which is transport-aware): the
  // provider restarts the turn with it, resolving the AskUserQuestion by having
  // the user's choice arrive as the next user turn. Process/tmux sessions keep
  // the TUI behavior below.
  const record = getSession(sessionName);
  const isTransportSession = record?.runtimeType === 'transport'
    || (typeof record?.agentType === 'string' && isTransportAgent(record.agentType));
  if (isTransportSession) {
    if (answer.trim()) await handleSend({ sessionName, text: answer }, serverLink);
    return;
  }
  // Process/TUI path: ESC to dismiss the dialog, then send the answer text + Enter.
  await sendKey(sessionName, 'Escape');
  await new Promise<void>((r) => setTimeout(r, 150));
  await sendKeys(sessionName, answer);
}

// ── P2P discussion file listing ────────────────────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

async function canonicalProjectDir(projectDir: string): Promise<string> {
  try {
    return await fsRealpath(projectDir);
  } catch {
    return nodePath.resolve(projectDir);
  }
}

async function collectKnownProjectDirs(): Promise<Map<string, string>> {
  const dirs = new Map<string, string>();
  for (const session of listSessions()) {
    if (!session.projectDir) continue;
    const canonical = await canonicalProjectDir(session.projectDir);
    dirs.set(canonical, session.projectDir);
  }
  return dirs;
}

async function resolveP2pDiscussionProjectScope(cmd: Record<string, unknown>): Promise<{ projectDir: string; canonicalProjectDir: string } | null> {
  const scope = isPlainRecord(cmd.scope) ? cmd.scope : {};
  const requestedSession = stringField(scope, 'sessionName') ?? stringField(cmd, 'sessionName');
  if (requestedSession) {
    const session = getSession(requestedSession);
    if (!session?.projectDir) return null;
    return {
      projectDir: session.projectDir,
      canonicalProjectDir: await canonicalProjectDir(session.projectDir),
    };
  }

  const requestedProjectDir = stringField(scope, 'projectDir')
    ?? stringField(scope, 'cwd')
    ?? stringField(cmd, 'projectDir')
    ?? stringField(cmd, 'cwd');
  const knownProjectDirs = await collectKnownProjectDirs();
  if (requestedProjectDir) {
    const requestedCanonical = await canonicalProjectDir(requestedProjectDir);
    const known = knownProjectDirs.get(requestedCanonical);
    return known
      ? { projectDir: known, canonicalProjectDir: requestedCanonical }
      : null;
  }

  if (knownProjectDirs.size === 1) {
    const [canonical, projectDir] = [...knownProjectDirs.entries()][0]!;
    return { projectDir, canonicalProjectDir: canonical };
  }

  return null;
}

function isPathUnderDir(filePath: string, dir: string): boolean {
  const relative = nodePath.relative(dir, nodePath.resolve(filePath));
  return relative === '' || (!!relative && !relative.startsWith('..') && !nodePath.isAbsolute(relative));
}

const P2P_DISCUSSION_HISTORY_LIMIT = 50;
const P2P_DISCUSSION_PREVIEW_BYTES = 64 * 1024;
const P2P_DISCUSSION_FILE_STAT_CONCURRENCY = 24;
const P2P_DISCUSSION_PREVIEW_CONCURRENCY = 8;

interface P2pDiscussionHistoryCandidate {
  id: string;
  fileName: string;
  fullPath: string;
  mtime: number;
  projectDir?: string;
}

interface P2pDiscussionHistoryEntry {
  id: string;
  fileName: string;
  path: string;
  preview: string;
  mtime: number;
  projectDir?: string;
}

function isCanonicalDiscussionFileName(entry: string): boolean {
  if (!entry.endsWith('.md')) return false;
  // Keep only canonical discussion documents in the history list.
  // Intermediate hop artifacts and reducer snapshots are implementation
  // details and should not crowd out the main discussion file.
  if (/\.round\d+\.hop\d+\.md$/i.test(entry)) return false;
  if (/\.reducer\.\d+\.md$/i.test(entry)) return false;
  return true;
}

async function readP2pDiscussionPreview(filePath: string, fallback: string): Promise<string> {
  let fh: Awaited<ReturnType<typeof fsOpen>> | null = null;
  try {
    fh = await fsOpen(filePath, 'r');
    const buffer = Buffer.allocUnsafe(P2P_DISCUSSION_PREVIEW_BYTES);
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0);
    const snippet = buffer.subarray(0, bytesRead).toString('utf8');
    const reqMatch = snippet.match(/## User Request\s*\n+(.+)/);
    return reqMatch?.[1]?.trim().slice(0, 120) || fallback;
  } catch {
    return fallback;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function listP2pDiscussionCandidatesForProject(
  projectDir: string,
  includeProjectDir: boolean,
): Promise<P2pDiscussionHistoryCandidate[]> {
  const dir = imcSubDir(projectDir, 'discussions');
  let entries: string[];
  try {
    entries = await fsReaddir(dir);
  } catch {
    return [];
  }

  const files = entries.filter(isCanonicalDiscussionFileName);
  const candidates = await mapWithConcurrency(files, P2P_DISCUSSION_FILE_STAT_CONCURRENCY, async (f) => {
    const fullPath = nodePath.join(dir, f);
    try {
      const s = await fsStat(fullPath);
      if (!s.isFile()) return null;
      return {
        id: f.replace(/\.md$/i, ''),
        fileName: f,
        fullPath,
        mtime: s.mtimeMs,
        ...(includeProjectDir ? { projectDir } : {}),
      } satisfies P2pDiscussionHistoryCandidate;
    } catch {
      return null;
    }
  });
  return candidates.filter((entry): entry is P2pDiscussionHistoryCandidate => entry !== null);
}

async function materializeP2pDiscussionHistoryEntry(
  candidate: P2pDiscussionHistoryCandidate,
): Promise<P2pDiscussionHistoryEntry> {
  const preview = await readP2pDiscussionPreview(candidate.fullPath, candidate.fileName);
  return {
    id: candidate.id,
    fileName: candidate.fileName,
    path: candidate.fullPath,
    preview,
    mtime: candidate.mtime,
    ...(candidate.projectDir ? { projectDir: candidate.projectDir } : {}),
  };
}

// Short-TTL result cache + in-flight coalescing for p2p.list_discussions.
// Before this, EVERY poll re-scanned every project's discussions dir and
// re-parsed every candidate file's preview (heavy fs + JSON allocation → a
// top GC-pressure source under load). Web + mobile clients poll this list
// frequently and in reconnect bursts; a 2s cache collapses sequential polls
// and the in-flight map collapses simultaneous ones into a single scan.
const P2P_DISCUSSION_LIST_CACHE_TTL_MS = 2_000;
const P2P_DISCUSSION_LIST_GLOBAL_KEY = '__global__';
interface P2pDiscussionListResult {
  discussions: P2pDiscussionHistoryEntry[];
  aggregated: boolean;
}
const p2pDiscussionListCache = new Map<string, { expiresAt: number; value: P2pDiscussionListResult }>();
const p2pDiscussionListInflight = new Map<string, Promise<P2pDiscussionListResult>>();

async function computeP2pDiscussionList(
  scope: { projectDir: string; canonicalProjectDir: string } | null,
): Promise<P2pDiscussionListResult> {
  // Audit fix (e940d73f-a8e / M7-B) — when the caller cannot supply scope
  // (mobile global view, multi-project daemon's "view discussions" entry
  // without an active session), aggregate discussions across **all** known
  // projects instead of failing closed. Each entry carries `projectDir` so
  // subsequent reads can route back. Single-project daemons still return the
  // same one-project list.
  const projectsToScan: Array<{ projectDir: string }> = [];
  if (scope) {
    projectsToScan.push({ projectDir: scope.projectDir });
  } else {
    const known = await collectKnownProjectDirs();
    for (const projectDir of known.values()) projectsToScan.push({ projectDir });
  }
  const candidateLists = await mapWithConcurrency(projectsToScan, 4, ({ projectDir }) =>
    listP2pDiscussionCandidatesForProject(projectDir, !scope),
  );
  const recentCandidates = candidateLists
    .flat()
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, P2P_DISCUSSION_HISTORY_LIMIT);
  const discussions = await mapWithConcurrency(
    recentCandidates,
    P2P_DISCUSSION_PREVIEW_CONCURRENCY,
    materializeP2pDiscussionHistoryEntry,
  );
  return { discussions, aggregated: !scope };
}

async function getP2pDiscussionList(
  scope: { projectDir: string; canonicalProjectDir: string } | null,
): Promise<P2pDiscussionListResult> {
  const key = scope ? scope.canonicalProjectDir : P2P_DISCUSSION_LIST_GLOBAL_KEY;
  const cached = p2pDiscussionListCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const inflight = p2pDiscussionListInflight.get(key);
  if (inflight) return await inflight;
  const promise = computeP2pDiscussionList(scope)
    .then((value) => {
      p2pDiscussionListCache.set(key, { value, expiresAt: Date.now() + P2P_DISCUSSION_LIST_CACHE_TTL_MS });
      return value;
    })
    .finally(() => {
      p2pDiscussionListInflight.delete(key);
    });
  p2pDiscussionListInflight.set(key, promise);
  return await promise;
}

async function handleP2pListDiscussions(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = cmd.requestId as string | undefined;
  const scope = await resolveP2pDiscussionProjectScope(cmd);
  const { discussions, aggregated } = await getP2pDiscussionList(scope);
  serverLink.send({
    type: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS_RESPONSE,
    requestId,
    discussions,
    // Surface to the caller that the list was aggregated across projects.
    // Old clients ignore unknown fields.
    ...(aggregated ? { aggregated: true } : {}),
  });
}

async function handleP2pReadDiscussion(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const id = cmd.id as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  if (!id) { serverLink.send({ type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE, requestId, error: 'missing_id' }); return; }
  if (id.includes('/') || id.includes('\\') || id.includes('\0') || id === '.' || id === '..') {
    serverLink.send({ type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE, id, requestId, error: 'invalid_id' });
    return;
  }
  let scope = await resolveP2pDiscussionProjectScope(cmd);
  if (!scope) {
    // Audit fix (e940d73f-a8e / M7-B) — defense-in-depth scope fallback.
    // Multi-project daemons require explicit scope from the UI, but several
    // call sites (mobile push-into discussions, global "view discussions"
    // entry without an active session) did not pass one. Returning
    // `missing_or_invalid_scope` straight to the UI surfaced as
    // "(加载失败)". Before erroring out, try to derive scope from:
    //   1. an active P2P run whose `id`/`discussionId` matches — the run's
    //      `contextFilePath` carries the authoritative project root.
    //   2. otherwise, sweep `collectKnownProjectDirs()` for an
    //      `<id>.md` hit under each project's `imcSubDir(.../discussions)`.
    // The id is a 12-char UUID slice (low collision risk) so a cross-
    // project search is acceptable. Lexical traversal is still guarded by
    // `isPathUnderDir` below so this does NOT widen the safety boundary.
    for (const run of listP2pRuns()) {
      if (run.id !== id && run.discussionId !== id) continue;
      const ctx = run.contextFilePath;
      if (typeof ctx !== 'string' || ctx.length === 0) continue;
      const runDiscussionsDir = nodePath.dirname(ctx);
      // contextFilePath is `<projectDir>/.imc/discussions/<id>.md` so
      // walking up two parents recovers the project root.
      const inferredProjectDir = nodePath.resolve(runDiscussionsDir, '..', '..');
      try {
        const canonical = await canonicalProjectDir(inferredProjectDir);
        scope = { projectDir: inferredProjectDir, canonicalProjectDir: canonical };
        break;
      } catch { /* ignore — fall through to cross-project sweep */ }
    }
    if (!scope) {
      const known = await collectKnownProjectDirs();
      for (const [canonical, projectDir] of known.entries()) {
        const probeDir = nodePath.resolve(imcSubDir(projectDir, 'discussions'));
        const probe = nodePath.join(probeDir, `${id}.md`);
        if (!isPathUnderDir(probe, probeDir)) continue;
        try {
          // `fsStat` throws on ENOENT — successful resolve == file exists.
          await fsStat(probe);
          scope = { projectDir, canonicalProjectDir: canonical };
          break;
        } catch { /* file not in this project, keep sweeping */ }
      }
    }
    if (!scope) {
      serverLink.send({ type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE, id, requestId, error: 'missing_or_invalid_scope' });
      return;
    }
  }
  const discussionsDir = nodePath.resolve(imcSubDir(scope.projectDir, 'discussions'));

  // Tasks 5.4 / 12.4 — when the responder is reading on behalf of an active
  // run (`runId` supplied), use the per-(run, source) offset tracker so
  // repeated reads only return new bytes appended after the prior offset.
  // Callers that don't supply a runId keep the historical full-file read
  // semantics for backward compatibility (e.g. discussions list UI).
  const runId = typeof cmd.runId === 'string' && cmd.runId ? cmd.runId : undefined;
  const rawPolicy = typeof cmd.offsetMismatchPolicy === 'string' ? cmd.offsetMismatchPolicy : undefined;
  const policy: 'fail' | 'reset' = rawPolicy === 'fail' ? 'fail' : 'reset';

  async function respondWithOffset(filePath: string): Promise<boolean> {
    if (!runId) return false;
    try {
      const result = await readP2pDiscussionWithOffset({ runId, sourceKey: id!, filePath, policy });
      serverLink.send({
        type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE,
        id,
        requestId,
        content: result.content,
        offset: { ...result.newOffset },
        offsetReset: result.reset,
        ...(result.diagnostics.length ? { diagnostics: result.diagnostics } : {}),
      });
      return true;
    } catch (err) {
      const wrapped = err as Error & {
        code?: string;
        diagnostic?: P2pWorkflowDiagnostic;
        result?: { newOffset?: unknown; diagnostics?: P2pWorkflowDiagnostic[] };
      };
      if (wrapped?.code === 'discussion_read_offset_mismatch') {
        serverLink.send({
          type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE,
          id,
          requestId,
          error: 'offset_mismatch',
          offsetReset: 'mismatch_fail_closed',
          ...(wrapped.result?.newOffset ? { offset: wrapped.result.newOffset } : {}),
          ...(wrapped.result?.diagnostics?.length ? { diagnostics: wrapped.result.diagnostics } : {}),
        });
        return true;
      }
      // Any other read error (ENOENT etc.) → caller falls back to legacy paths.
      return false;
    }
  }

  // 1. Check active P2P runs first (in-memory, always fresh)
  for (const run of listP2pRuns()) {
    if (run.id === id || run.discussionId === id) {
      if (!isPathUnderDir(run.contextFilePath, discussionsDir)) continue;
      if (await respondWithOffset(run.contextFilePath)) return;
      try {
        const content = await fsReadFileRaw(run.contextFilePath, 'utf8');
        serverLink.send({ type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE, id, requestId, content });
        return;
      } catch { /* file may not exist yet */ }
    }
  }

  const filePath = nodePath.join(discussionsDir, `${id}.md`);
  if (!isPathUnderDir(filePath, discussionsDir)) {
    serverLink.send({ type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE, id, requestId, error: 'invalid_id' });
    return;
  }
  if (await respondWithOffset(filePath)) return;
  try {
    const content = await fsReadFileRaw(filePath, 'utf8');
    serverLink.send({ type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE, id, requestId, content });
    return;
  } catch { /* not found */ }
  serverLink.send({ type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE, id, requestId, error: 'not_found' });
}

// ── Discussion handlers ────────────────────────────────────────────────────

async function handleDiscussionStart(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const topic = cmd.topic as string | undefined;
  const cwd = cmd.cwd as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  const rawParticipants = cmd.participants as Array<Record<string, unknown>> | undefined;

  if (!topic || !rawParticipants || rawParticipants.length < 2) {
    logger.warn('discussion.start: missing required fields');
    try { serverLink.send({ type: 'discussion.error', requestId, error: 'missing_fields' }); } catch { /* ignore */ }
    return;
  }

  const { startDiscussion } = await import('./discussion-orchestrator.js');

  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const participants = rawParticipants.map((p) => ({
    agentType: (p.agentType as string) ?? 'claude-code',
    model: p.model as string | undefined,
    roleId: (p.roleId as string) ?? 'custom',
    roleLabel: p.roleLabel as string | undefined,
    rolePrompt: p.rolePrompt as string | undefined,
    sessionName: p.sessionName as string | undefined,
  }));

  try {
    const d = await startDiscussion(
      {
        id,
        serverId: '',
        requestId,
        topic,
        cwd: cwd ?? '',
        participants,
        maxRounds: (cmd.maxRounds as number | undefined) ?? 3,
        verdictIdx: cmd.verdictIdx as number | undefined,
      },
      (msg) => {
        try { serverLink.send(msg as Record<string, unknown>); } catch { /* not connected */ }
      },
    );

    try {
      serverLink.send({
        type: 'discussion.started',
        requestId,
        discussionId: d.id,
        topic: d.topic,
        maxRounds: d.maxRounds,
        filePath: d.filePath,
        participants: d.participants.map((p) => ({
          sessionName: p.sessionName,
          roleLabel: p.roleLabel,
          agentType: p.agentType,
          model: p.model,
        })),
      });
    } catch { /* not connected */ }
  } catch (err) {
    logger.error({ err }, 'discussion.start failed');
    const error = err instanceof Error ? err.message : String(err);
    try { serverLink.send({ type: 'discussion.error', requestId, error }); } catch { /* ignore */ }
  }
}

function handleDiscussionStatus(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const discussionId = cmd.discussionId as string | undefined;
  if (!discussionId) return;

  import('./discussion-orchestrator.js').then(({ getDiscussion }) => {
    const d = getDiscussion(discussionId);
    if (!d) {
      try { serverLink.send({ type: 'discussion.error', discussionId, error: 'not_found' }); } catch { /* ignore */ }
      return;
    }
    try {
      serverLink.send({
        type: 'discussion.update',
        discussionId: d.id,
        state: d.state,
        currentRound: d.currentRound,
        maxRounds: d.maxRounds,
        currentSpeaker: d.participants[d.currentSpeakerIdx]?.roleLabel,
      });
    } catch { /* not connected */ }
  }).catch(() => {});
}

function handleDiscussionList(serverLink: ServerLink): void {
  import('./discussion-orchestrator.js').then(({ listDiscussions }) => {
    try {
      serverLink.send({ type: 'discussion.list', discussions: listDiscussions() });
    } catch { /* not connected */ }
  }).catch(() => {});
}

async function handleDiscussionStop(cmd: Record<string, unknown>): Promise<void> {
  const discussionId = cmd.discussionId as string | undefined;
  if (!discussionId) return;
  const { stopDiscussion } = await import('./discussion-orchestrator.js');
  await stopDiscussion(discussionId).catch((e: unknown) =>
    logger.error({ err: e, discussionId }, 'discussion.stop failed'),
  );
}

/** Compare two imcodes daemon version strings.
 *
 * Returns -1 / 0 / 1 like Array.sort comparators (a<b / equal / a>b).
 *
 * Format we accept: `<num>.<num>.<num>[-<pre>...]` — calver-style with optional
 * dot-separated pre-release suffix. e.g.
 *   `2026.4.1873`              (release)
 *   `2026.4.1924-dev.1906`     (pre-release)
 *
 * Rules:
 *  - Compare the dot-separated release segments numerically, left-to-right.
 *  - If release segments tie, a version WITHOUT a pre-release suffix is
 *    *greater* than one WITH (standard semver convention; pre is a step
 *    *toward* the next release).
 *  - If both have pre-release suffixes, compare those segment-wise; numeric
 *    when both numeric, lexicographic otherwise.
 *
 * This is permissive about junk (non-numeric segments parse as 0) — we only
 * use it to gate downgrade-prevention, never for anything strict.
 */
function compareDaemonVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): { rel: number[]; pre: string[] | null } => {
    const dash = v.indexOf('-');
    const relStr = dash === -1 ? v : v.slice(0, dash);
    const preStr = dash === -1 ? null : v.slice(dash + 1);
    return {
      rel: relStr.split('.').map((n) => Number.parseInt(n, 10) || 0),
      pre: preStr ? preStr.split('.') : null,
    };
  };
  const A = parse(a);
  const B = parse(b);
  const len = Math.max(A.rel.length, B.rel.length);
  for (let i = 0; i < len; i++) {
    const da = A.rel[i] ?? 0;
    const db = B.rel[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  if (A.pre === null && B.pre === null) return 0;
  if (A.pre === null) return 1; // a stable > b pre
  if (B.pre === null) return -1;
  const plen = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < plen; i++) {
    const pa = A.pre[i] ?? '';
    const pb = B.pre[i] ?? '';
    const na = /^\d+$/.test(pa) ? Number.parseInt(pa, 10) : null;
    const nb = /^\d+$/.test(pb) ? Number.parseInt(pb, 10) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (pa !== pb) {
      return pa < pb ? -1 : 1;
    }
  }
  return 0;
}

/** daemon.upgrade — install latest via npm then restart service via a detached script.
 *
 * Safety rules:
 *  1. Never restart the service from within the daemon process itself (would kill us
 *     before the restart completes). Instead we write a shell script and spawn it
 *     fully detached so it outlives us.
 *  2. The script always restarts the service at the end — even if npm install failed —
 *     so the daemon always comes back up (possibly on the old version).
 *  3. A short sleep before the restart gives the current daemon time to finish
 *     sending any in-flight messages.
 *  4. Never DOWNGRADE: refuse to restart into an older version. The TS-side
 *     check at top blocks pinned-target downgrades; the bash-side check after
 *     `npm install` catches the `targetVersion === 'latest'` case where npm
 *     may resolve to an older release than what's currently installed.
 */
/** Auto-upgrade cooldown: rate-limit server-driven (no-targetVersion)
 *  upgrade commands so a CI-publish flurry doesn't translate to a flurry
 *  of daemon restarts. See handleDaemonUpgrade comment for context.
 *
 *  Pure function (testable). Returns:
 *    onCooldown: true → caller should decline the upgrade
 *    remainingMs: ms until the cooldown elapses (0 when not on cooldown)
 *    lastAt: epoch ms of the last successful upgrade (null if sentinel
 *            missing/unreadable — treated as "never upgraded")
 */
export interface AutoUpgradeCooldownInput {
  /** Caller-specified targetVersion. Empty / 'latest' = auto upgrade. */
  targetVersion: string | undefined;
  /** Now (epoch ms). Defaults to Date.now(); param exists for tests. */
  now?: number;
  /** Cooldown window in ms. */
  cooldownMs: number;
  /** Reads the sentinel file; returns its trimmed text or null on miss. */
  readSentinel: () => string | null;
}
export interface AutoUpgradeCooldownVerdict {
  onCooldown: boolean;
  remainingMs: number;
  lastAt: number | null;
}
export function evaluateAutoUpgradeCooldown(
  input: AutoUpgradeCooldownInput,
): AutoUpgradeCooldownVerdict {
  const { targetVersion, cooldownMs } = input;
  const now = input.now ?? Date.now();
  const isAutoUpgrade = !targetVersion || targetVersion === 'latest' || targetVersion === '';
  if (!isAutoUpgrade) return { onCooldown: false, remainingMs: 0, lastAt: null };
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return { onCooldown: false, remainingMs: 0, lastAt: null };
  let raw: string | null = null;
  try { raw = input.readSentinel(); } catch { /* sentinel unreadable */ }
  if (!raw) return { onCooldown: false, remainingMs: 0, lastAt: null };
  const lastAt = parseInt(raw.trim(), 10);
  if (!Number.isFinite(lastAt)) return { onCooldown: false, remainingMs: 0, lastAt: null };
  const ageMs = now - lastAt;
  // Negative age (clock skew, sentinel from the future) → ignore the
  // sentinel rather than blocking forever. Operator can also delete
  // the file to force-bypass the cooldown.
  if (ageMs < 0) return { onCooldown: false, remainingMs: 0, lastAt };
  if (ageMs >= cooldownMs) return { onCooldown: false, remainingMs: 0, lastAt };
  return { onCooldown: true, remainingMs: cooldownMs - ageMs, lastAt };
}

/** How long the *session-busy* gate may keep deferring an upgrade before the
 *  daemon forces it through. The per-turn staleness guard
 *  (`TRANSPORT_STALE_TURN_MS`) catches wedged transport turns; this is the
 *  final backstop for everything else (a process-agent CLI stuck in
 *  'running'/'queued', a transport turn the staleness guard hasn't yet aged
 *  out, an unforeseen state) so ONE stuck session can never pin the daemon on
 *  an old version forever. Override for tests via IMCODES_MAX_UPGRADE_DEFER_MS. */
const MAX_UPGRADE_DEFER_MS = (() => {
  const raw = parseInt(process.env.IMCODES_MAX_UPGRADE_DEFER_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
})();

/** Epoch ms when the session-busy gate FIRST blocked the current run of
 *  upgrade attempts, or null when the last attempt was not session-blocked.
 *  Persists across `handleDaemonUpgrade` calls (each server upgrade broadcast)
 *  so the backstop measures *continuous* deferral, not a single attempt. */
let upgradeSessionBusyDeferredSince: number | null = null;

/** Pure decision for the session-busy deferral backstop. Given whether the
 *  session gate is currently blocking and how long it has been blocking,
 *  decide whether to proceed anyway (forced) and what the next "blocked since"
 *  marker should be. Extracted for deterministic unit testing. */
export function evaluateUpgradeDeferralBackstop(args: {
  blocked: boolean;
  deferredSince: number | null;
  now: number;
  maxDeferMs: number;
}): { proceed: boolean; forced: boolean; nextDeferredSince: number | null; deferredMs: number } {
  const { blocked, deferredSince, now, maxDeferMs } = args;
  if (!blocked) {
    return { proceed: true, forced: false, nextDeferredSince: null, deferredMs: 0 };
  }
  const since = deferredSince ?? now;
  const deferredMs = Math.max(0, now - since);
  if (Number.isFinite(maxDeferMs) && maxDeferMs > 0 && deferredMs >= maxDeferMs) {
    // Deferred long enough — force the upgrade through and reset the tracker.
    return { proceed: true, forced: true, nextDeferredSince: null, deferredMs };
  }
  return { proceed: false, forced: false, nextDeferredSince: since, deferredMs };
}

/** Test-only: reset the module-level session-busy deferral tracker. */
export function __resetUpgradeDeferralStateForTests(): void {
  upgradeSessionBusyDeferredSince = null;
}

export interface UpgradeToolchainStatus {
  /** The node binary the upgrade script will use (process.execPath). */
  nodeBin: string;
  /** False when nodeBin no longer exists on disk — e.g. `apt autoremove`
   *  deleted the system Node while the daemon kept running on the now-deleted
   *  inode. Restarting in this state would `exec` a missing binary and kill the
   *  daemon for good, and every `npm install` fails because npm went with it. */
  nodeBinPresent: boolean;
  /** Resolved npm-cli.js path, or null if not found at the standard locations
   *  next to nodeBin. Advisory only (the upgrade script has more strategies,
   *  e.g. `npm prefix -g`), so a null here downgrades to a warning, not abort. */
  npmCli: string | null;
}

/**
 * Pre-flight check for the Node/npm toolchain the auto-upgrade depends on.
 * Pure (all IO injected) so it is unit-testable. Mirrors the npm-cli.js
 * discovery the generated upgrade.sh performs, plus the critical "is the node
 * binary still on disk" check the script cannot meaningfully recover from.
 *
 * The point: an upgrade spawned when the toolchain is broken fails silently in
 * a detached script — the daemon only notices 15 min later via the memory-
 * freeze watchdog, so a box can sit stuck on an old version for hours with no
 * clear signal. Surfacing this up front turns it into an immediate, actionable
 * alert ("reinstall Node").
 */
export function checkUpgradeToolchain(opts: {
  nodeBin: string;
  nodeDir: string;
  join: (...parts: string[]) => string;
  exists: (p: string) => boolean;
  realpath: (p: string) => string | null;
}): UpgradeToolchainStatus {
  const { nodeBin, nodeDir, join, exists, realpath } = opts;
  const nodeBinPresent = exists(nodeBin);

  let npmCli: string | null = null;
  // Strategy A: <nodeDir>/npm symlink → npm-cli.js (covers system / tarball /
  // most managed installs, where npm sits right next to node).
  const npmLink = join(nodeDir, 'npm');
  if (exists(npmLink)) {
    const resolved = realpath(npmLink);
    if (resolved && resolved.endsWith('npm-cli.js') && exists(resolved)) npmCli = resolved;
  }
  // Strategy B: known relative-from-nodeDir layouts (nvm/fnm/volta/system/snap).
  if (!npmCli) {
    const candidates = [
      join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(nodeDir, '..', '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
    for (const c of candidates) {
      if (exists(c)) { npmCli = c; break; }
    }
  }

  return { nodeBin, nodeBinPresent, npmCli };
}

/**
 * Resolve which npm registry the daemon's own auto-upgrade should use, so the
 * pre-flight "is latest newer?" probe and the actual `npm install -g` agree on
 * a single source. Previously the probe hard-coded registry.npmjs.org while the
 * install obeyed whatever registry the user's ~/.npmrc named (a mirror, in
 * restricted-network regions) — so in those regions the probe always failed,
 * the anti-downgrade short-circuit never fired, and the probe/install could
 * even resolve different versions.
 *
 * Priority: imcodes' own ~/.imcodes/install.json (written by the installer),
 * then the ambient `npm config get registry` (covers users installed via the
 * legacy script that persisted a mirror to ~/.npmrc), then the official
 * registry. `explicit` is true when the result is NOT the official default —
 * callers then pass `--registry` to npm so resolution is pinned, not ambient.
 */
async function resolveUpgradeRegistry(): Promise<{ base: string; explicit: boolean }> {
  const { readFileSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');
  const { execFile } = await import('child_process');

  let configRegistry: unknown;
  try {
    const raw = readFileSync(join(homedir(), '.imcodes', INSTALLER_CONFIG_BASENAME), 'utf8');
    const parsed = JSON.parse(raw) as InstallerConfig;
    configRegistry = parsed?.npmRegistry;
  } catch { /* no install.json (or unreadable) — fall through to ambient */ }

  let ambientRegistry: unknown;
  if (!normalizeRegistryBase(configRegistry)) {
    ambientRegistry = await new Promise<string | undefined>((resolve) => {
      try {
        const child = execFile('npm', ['config', 'get', 'registry'], { timeout: 5000 }, (err, stdout) => {
          resolve(err ? undefined : String(stdout).trim());
        });
        child.on('error', () => resolve(undefined));
      } catch { resolve(undefined); }
    });
  }

  const base = pickUpgradeRegistry({ configRegistry, ambientRegistry });
  return { base, explicit: base !== INSTALLER_OFFICIAL_NPM_REGISTRY };
}

async function handleDaemonUpgrade(targetVersion?: string, serverLink?: ServerLink): Promise<void> {
  const UPGRADE_MEMORY_FREEZE_TTL_MS = 15 * 60 * 1000;

  // ── Opt-out: forcibly disable the daemon's self-upgrade ───────────────────
  // Set `daemon.autoUpgrade: false` in ~/.imcodes/config.yaml (or the env
  // IMCODES_DISABLE_AUTO_UPGRADE=1) to stop the daemon from replacing itself —
  // e.g. when running a local source build you don't want clobbered by the
  // published npm release. The manual `imcodes upgrade` CLI is unaffected.
  const envDisabled = process.env.IMCODES_DISABLE_AUTO_UPGRADE === '1'
    || process.env.IMCODES_DISABLE_AUTO_UPGRADE === 'true';
  let configDisabled = false;
  try {
    const { loadConfig } = await import('../config.js');
    const cfg = await loadConfig();
    configDisabled = cfg?.daemon?.autoUpgrade === false;
  } catch { /* config unreadable — fall back to env only */ }
  if (envDisabled || configDisabled) {
    logger.info(
      { targetVersion, reason: envDisabled ? 'env' : 'config' },
      'daemon.upgrade: auto-upgrade disabled — skipping',
    );
    return;
  }

  // ── Auto-upgrade cooldown ─────────────────────────────────────────────────
  // Server pushes `daemon.upgrade` whenever it sees a new dev tag on the
  // npm registry. With CI publishing every ~5 min during active dev work,
  // four daemons each restarting on every tag = ~7 s offline × 4 boxes
  // every few minutes, which a human operator perceives as "always
  // offline". Bypassed when the operator names a specific targetVersion.
  // Sentinel: ~/.imcodes/last-upgrade-at, updated by upgrade.sh.
  try {
    const { homedir: _homedir } = await import('os');
    const { join: _join } = await import('path');
    const { readFileSync: _readFile } = await import('fs');
    const sentinelPath = _join(_homedir(), '.imcodes', 'last-upgrade-at');
    const verdict = evaluateAutoUpgradeCooldown({
      targetVersion,
      cooldownMs: parseInt(
        process.env.IMCODES_UPGRADE_COOLDOWN_MS ?? String(10 * 60 * 1000),
        10,
      ),
      readSentinel: () => {
        try { return _readFile(sentinelPath, 'utf8'); } catch { return null; }
      },
    });
    if (verdict.onCooldown) {
      logger.info({
        targetVersion,
        lastUpgradeAt: verdict.lastAt,
        cooldownRemainingMs: verdict.remainingMs,
      }, 'daemon.upgrade: auto-upgrade declined (cooldown active)');
      try {
        serverLink?.send({
          type: DAEMON_MSG.UPGRADE_BLOCKED,
          reason: 'cooldown_active',
          cooldownRemainingMs: verdict.remainingMs,
          lastUpgradeAt: verdict.lastAt,
        });
      } catch { /* ignore */ }
      return;
    }
  } catch { /* defensive — never block the upgrade on a sentinel read error */ }

  const activeRuns = getActiveP2pRunsBlockingDaemonUpgrade();
  if (activeRuns.length > 0) {
    logger.warn({
      targetVersion,
      activeRunIds: activeRuns.map((run) => run.id),
      activeRunStatuses: activeRuns.map((run) => run.status),
    }, 'daemon.upgrade: blocked because P2P runs are active');
    try {
      serverLink?.send({
        type: DAEMON_MSG.UPGRADE_BLOCKED,
        reason: 'p2p_active',
        activeRunIds: activeRuns.map((run) => run.id),
      });
    } catch { /* ignore */ }
    return;
  }

  const activeMasterCompactions = getInflightMasterCompactionCount();
  if (activeMasterCompactions > 0) {
    logger.warn({ targetVersion, activeMasterCompactions }, 'daemon.upgrade: blocked because master compaction is active');
    try {
      serverLink?.send({
        type: DAEMON_MSG.UPGRADE_BLOCKED,
        reason: 'master_compaction_active',
        activeMasterCompactions,
      });
    } catch { /* ignore */ }
    return;
  }

  const compressionState = getCompressionQueueState();
  if (!compressionState.idle) {
    logger.warn({ targetVersion, compressionState }, 'daemon.upgrade: blocked because memory compression is active');
    try {
      serverLink?.send({
        type: DAEMON_MSG.UPGRADE_BLOCKED,
        reason: 'compression_active',
        compressionState,
      });
    } catch { /* ignore */ }
    return;
  }

  // Cover BOTH transport-runtime sessions (claude-code-sdk, codex-sdk,
  // copilot-sdk, cursor-headless, openclaw, qwen) and process-runtime
  // sessions (claude-code, codex, opencode, gemini, shell). Pre-fix this
  // gate only checked transport runtimes, so a `claude-code` CLI in tmux
  // mid-turn would silently get killed by self-upgrade restart, throwing
  // away the in-flight generation.
  const activeSessions = getActiveSessionsBlockingDaemonUpgrade();
  const deferralBackstop = evaluateUpgradeDeferralBackstop({
    blocked: activeSessions.length > 0,
    deferredSince: upgradeSessionBusyDeferredSince,
    now: Date.now(),
    maxDeferMs: MAX_UPGRADE_DEFER_MS,
  });
  upgradeSessionBusyDeferredSince = deferralBackstop.nextDeferredSince;
  if (activeSessions.length > 0 && !deferralBackstop.proceed) {
    logger.warn({
      targetVersion,
      blockedSessions: activeSessions,
      deferredMs: deferralBackstop.deferredMs,
      maxDeferMs: MAX_UPGRADE_DEFER_MS,
    }, 'daemon.upgrade: blocked because sessions have active turns');
    try {
      serverLink?.send({
        type: DAEMON_MSG.UPGRADE_BLOCKED,
        reason: activeSessions.every((reason) => reason.runtimeType === 'transport') ? 'transport_busy' : 'session_busy',
        activeSessionNames: activeSessions.map((reason) => reason.name),
        blockedSessions: activeSessions,
      });
    } catch { /* ignore */ }
    return;
  }
  if (activeSessions.length > 0 && deferralBackstop.forced) {
    // Deferred past MAX_UPGRADE_DEFER_MS — the blocking session(s) are almost
    // certainly wedged. Proceed anyway rather than stay pinned on an old
    // version forever; a transport SDK session resumes after restart and a
    // wedged process turn was already lost.
    logger.warn({
      targetVersion,
      blockedSessions: activeSessions,
      deferredMs: deferralBackstop.deferredMs,
      maxDeferMs: MAX_UPGRADE_DEFER_MS,
    }, 'daemon.upgrade: forcing upgrade despite active sessions after prolonged deferral (sessions likely wedged)');
  }

  const { spawn } = await import('child_process');
  const { writeFileSync, readFileSync, mkdtempSync, existsSync } = await import('fs');
  const { join, dirname } = await import('path');
  const { tmpdir, homedir } = await import('os');

  const { DAEMON_VERSION } = await import('../util/version.js');
  if (targetVersion && DAEMON_VERSION === targetVersion) {
    logger.info({ daemonVersion: DAEMON_VERSION, targetVersion }, 'daemon.upgrade: already at target version, skipping');
    return;
  }
  // Don't downgrade: if a specific targetVersion is named and our running
  // daemon is already at or newer than it, skip. Without this, a server that
  // pushes `latest` (or an older pinned version) can repeatedly clobber a
  // newer dev/local build the operator has installed.
  if (targetVersion && targetVersion !== 'latest' && compareDaemonVersions(DAEMON_VERSION, targetVersion) >= 0) {
    logger.info({ daemonVersion: DAEMON_VERSION, targetVersion },
      'daemon.upgrade: installed version is at or newer than target, refusing to downgrade');
    return;
  }
  // For untargeted / `latest` upgrades, pre-flight against the npm registry —
  // if our running version is already at or newer than what the registry
  // resolves `imcodes@latest` to, skip the whole upgrade. This stops servers
  // that blindly broadcast `latest` from clobbering a newer dev build's
  // global install (npm install -g would replace the symlink/dir with the
  // older registry release even if we then refused to restart, so we have to
  // catch this BEFORE spawning the install).
  // Resolve the registry ONCE here and reuse it for both the pre-flight probe
  // and the install command baked into the upgrade script, so they never
  // diverge (this is the fix for the prior hard-coded-official-registry probe).
  const upgradeRegistry = await resolveUpgradeRegistry();
  if (!targetVersion || targetVersion === 'latest') {
    try {
      const res = await fetch(`${upgradeRegistry.base}imcodes/latest`, {
        headers: { accept: 'application/json' },
        // 5 s — registry should be fast; if it's not we'd rather skip the
        // probe and fall through than block the daemon for long.
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const json = await res.json() as { version?: string };
        const registryLatest = typeof json.version === 'string' ? json.version : null;
        if (registryLatest && compareDaemonVersions(DAEMON_VERSION, registryLatest) >= 0) {
          logger.info({ daemonVersion: DAEMON_VERSION, registryLatest },
            'daemon.upgrade: registry "latest" is not newer than current, refusing to downgrade');
          return;
        }
      } else {
        logger.warn({ status: res.status }, 'daemon.upgrade: registry probe returned non-2xx, proceeding without pre-flight');
      }
    } catch (e) {
      logger.warn({ err: e }, 'daemon.upgrade: registry probe failed, proceeding without pre-flight');
    }
  }

  // ── Toolchain pre-flight (non-Windows; Windows has its own runner) ─────────
  // Before spawning a detached upgrade script that would otherwise fail
  // silently, verify the Node/npm toolchain is intact. The unambiguous, fatal
  // case is a deleted node binary (e.g. `apt autoremove` pulled nodejs while
  // the daemon ran on the now-deleted inode): restarting would `exec` a missing
  // binary and kill the daemon permanently, and every `npm install` fails.
  // Abort loudly and keep the current version running instead. A missing
  // npm-cli.js alone is only a warning — the script has more discovery
  // strategies (`npm prefix -g`, PATH) that this static check doesn't run.
  if (process.platform !== 'win32') {
    const { existsSync: _existsSync, realpathSync: _realpathSync } = await import('fs');
    const { dirname: _dirname, join: _join } = await import('path');
    const nodeBin = process.execPath;
    const toolchain = checkUpgradeToolchain({
      nodeBin,
      nodeDir: _dirname(nodeBin),
      join: _join,
      exists: (p) => { try { return _existsSync(p); } catch { return false; } },
      realpath: (p) => { try { return _realpathSync(p); } catch { return null; } },
    });
    if (!toolchain.nodeBinPresent) {
      logger.error({
        targetVersion,
        nodeBin: toolchain.nodeBin,
        npmCli: toolchain.npmCli,
      }, 'daemon.upgrade: ABORTING — the Node binary no longer exists on disk (toolchain deleted, e.g. apt autoremove). Restarting would kill the daemon and npm is gone, so auto-upgrade is impossible until Node is reinstalled. Keeping the current version running.');
      try {
        serverLink?.send({
          type: DAEMON_MSG.UPGRADE_BLOCKED,
          reason: 'toolchain_unavailable',
          nodeBinPresent: false,
          npmAvailable: toolchain.npmCli !== null,
        });
      } catch { /* ignore */ }
      return;
    }
    if (toolchain.npmCli === null) {
      logger.warn({
        targetVersion,
        nodeBin: toolchain.nodeBin,
      }, 'daemon.upgrade: npm-cli.js not found next to the node binary; the upgrade script will fall back to `npm prefix -g` / PATH but the install may fail');
    }
  }

  let upgradeScriptSpawned = false;
  const releaseUpgradeMemoryFreeze = (() => {
    closeLiveContextMaterializationAdmission('upgrade-pending');
    stopAcceptingCompression('upgrade-pending');
    stopAcceptingMasterCompactions('upgrade-pending');
    let released = false;
    return () => {
      if (released) return;
      released = true;
      resumeAcceptingMasterCompactions();
      resumeAcceptingCompression();
      reopenLiveContextMaterializationAdmission();
    };
  })();
  const scheduleUpgradeMemoryFreezeRelease = () => {
    const timer = setTimeout(() => {
      logger.warn({ targetVersion }, 'daemon.upgrade: releasing memory freeze after watchdog timeout');
      releaseUpgradeMemoryFreeze();
    }, UPGRADE_MEMORY_FREEZE_TTL_MS);
    timer.unref?.();
  };

  try {
    const postFreezeMasterCompactions = getInflightMasterCompactionCount();
    if (postFreezeMasterCompactions > 0) {
      logger.warn({ targetVersion, activeMasterCompactions: postFreezeMasterCompactions }, 'daemon.upgrade: blocked because master compaction became active after freeze');
      try {
        serverLink?.send({
          type: DAEMON_MSG.UPGRADE_BLOCKED,
          reason: 'master_compaction_active',
          activeMasterCompactions: postFreezeMasterCompactions,
        });
      } catch { /* ignore */ }
      return;
    }
    const postFreezeCompressionState = getCompressionQueueState();
    if (!postFreezeCompressionState.idle) {
      logger.warn({ targetVersion, compressionState: postFreezeCompressionState }, 'daemon.upgrade: blocked because memory compression became active after freeze');
      try {
        serverLink?.send({
          type: DAEMON_MSG.UPGRADE_BLOCKED,
          reason: 'compression_active',
          compressionState: postFreezeCompressionState,
        });
      } catch { /* ignore */ }
      return;
    }

  logger.info('daemon.upgrade: preparing upgrade script');

  const scriptDir = mkdtempSync(join(tmpdir(), 'imcodes-upgrade-'));
  const logFile = join(scriptDir, 'upgrade.log');
  const scriptPath = join(scriptDir, 'upgrade.sh');
  // Build the platform-specific restart command.
  // We always restart regardless of whether npm install succeeded, so the daemon
  // is never left permanently dead.
  let restartCmd: string;
  if (process.platform === 'linux') {
    const userSvc = join(homedir(), '.config/systemd/user/imcodes.service');
    if (existsSync(userSvc)) {
      restartCmd = 'systemctl --user restart imcodes';
    } else {
      restartCmd = 'echo "No user service found. Run: imcodes bind" && exit 1';
    }
  } else if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library/LaunchAgents/imcodes.daemon.plist');
    const pidFile = join(homedir(), '.imcodes', 'daemon.pid');
    restartCmd = `launchctl unload "${plist}" 2>/dev/null || true
# Kill any lingering daemon processes after unload
STALE_PID=$(cat "${pidFile}" 2>/dev/null)
if [ -n "$STALE_PID" ] && kill -0 "$STALE_PID" 2>/dev/null; then
  kill "$STALE_PID" 2>/dev/null; sleep 2
  kill -0 "$STALE_PID" 2>/dev/null && kill -9 "$STALE_PID" 2>/dev/null
fi
launchctl load -w "${plist}"`;
  } else if (process.platform === 'win32') {
    // Windows: drive the upgrade with a Node.js runner instead of a
    // cmd.exe batch.  The batch was the source of every Windows
    // auto-upgrade outage we shipped (paren-counting in if-blocks,
    // timeout-needs-stdin, del silent failures, codepage issues with
    // non-ASCII %TEMP% / %USERPROFILE% paths).  Node fs APIs use the
    // Windows wide-char API natively, so Chinese / Cyrillic / etc.
    // paths round-trip transparently.
    //
    // Layout: copy the bundled runner to %TEMP%/imcodes-upgrade-X/upgrade.mjs
    // BEFORE spawning, so the in-flight `npm install -g` doesn't
    // overwrite the runner's source under itself when the new
    // package's files land at the same global path.
    const npmBin = join(dirname(process.execPath), 'npm.cmd');
    const npmCmd = existsSync(npmBin) ? npmBin : 'npm';
    const pkgSpec = targetVersion ? `imcodes@${targetVersion}` : 'imcodes@latest';
    const targetVer = targetVersion ?? 'latest';

    const runnerSrc = resolveWindowsUpgradeRunnerPath();
    const runnerCopy = join(scriptDir, 'upgrade.mjs');
    try {
      // Read+write rather than cpSync so a broken runnerSrc fails loud.
      writeFileSync(runnerCopy, readFileSync(runnerSrc));
    } catch (err) {
      logger.error({ err, runnerSrc }, 'daemon.upgrade: failed to stage upgrade runner — cannot proceed');
      return;
    }

    // Cleanup .cmd is still cmd.exe — but it's a 4-line idempotent rmdir
    // with NO control flow.  No parens, no timeout, no del — just one
    // ping sleep and one rmdir.  Kept because the runner self-cleans via
    // its own deferred rmSync, but this is a belt-and-suspenders for
    // the case where the runner crashes before reaching the finally block.
    const cleanupPath = join(scriptDir, 'cleanup.cmd');
    const cleanupVbsPath = join(scriptDir, 'cleanup.vbs');
    writeFileSync(cleanupPath, encodeCmdAsUtf8Bom(buildWindowsCleanupScript(scriptDir)));
    writeFileSync(cleanupVbsPath, encodeVbsAsUtf16(buildWindowsCleanupVbs(cleanupPath)));

    // VBS launcher — runs the JS runner via `node upgrade.mjs <args>`
    // hidden + detached.  Bake all paths as args so the runner doesn't
    // depend on env-var expansion or working directory.
    const upgradeVbsPath = join(scriptDir, 'upgrade.vbs');
    // Pass the resolved registry (sentinel '-' when official/default so we
    // don't add a redundant --registry) and the current daemon version so the
    // runner can apply a post-install downgrade guard for `latest` (Linux/macOS
    // do this in-script; Windows had no such guard before).
    const winRegistryArg = upgradeRegistry.explicit ? upgradeRegistry.base : '-';
    const upgradeVbs = buildWindowsUpgradeRunnerVbs({
      nodeExe: process.execPath,
      runnerPath: runnerCopy,
      args: [logFile, npmCmd, pkgSpec, targetVer, scriptDir, winRegistryArg, DAEMON_VERSION],
    });
    writeFileSync(upgradeVbsPath, encodeVbsAsUtf16(upgradeVbs));

    // Launch via wscript: hidden + fully detached, survives our exit.
    const child = spawn('wscript', [upgradeVbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    // Also kick off cleanup deferred 120 s — the runner cleans up too,
    // but if it crashes before its finally block we still want %TEMP% tidy.
    spawn('wscript', [cleanupVbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();

    logger.info({ log: logFile, runnerCopy }, 'daemon.upgrade: Windows JS upgrade runner spawned');
    upgradeScriptSpawned = true;
    scheduleUpgradeMemoryFreezeRelease();
    return;
  } else {
    logger.warn('daemon.upgrade: unsupported platform, cannot restart service');
    return;
  }

  // Resolve absolute paths to `node` and `npm-cli.js` and bake them into the
  // upgrade script.
  //
  // Why this matters on Linux/macOS:
  //   - `npm` itself is `#!/usr/bin/env node`, which fails when the upgrade
  //     script runs in a non-interactive shell that doesn't have node on PATH
  //     (very common with nvm/fnm/volta — their PATH setup lives in
  //     ~/.bashrc which has the standard `case $- in *i*) ;; *) return;;`
  //     guard, so non-interactive shells exit before nvm.sh is sourced).
  //   - Calling `node` via absolute path AND invoking npm-cli.js directly
  //     bypasses the shebang lookup entirely.
  //   - We also export node's bin dir to PATH so anything *npm* spawns
  //     (post-install scripts, node-gyp, the freshly-installed `imcodes`
  //     binary itself for the version check) can also find node.
  //
  // Layout coverage (all of these put npm-cli.js at the same relative path):
  //   - nvm:    ~/.nvm/versions/node/<ver>/{bin/node, lib/node_modules/npm/bin/npm-cli.js}
  //   - fnm:    ~/.local/share/fnm/node-versions/<ver>/installation/{bin/node, lib/...}
  //   - volta:  ~/.volta/tools/image/node/<ver>/{bin/node, lib/...}
  //   - tarball/system: /usr/{bin/node, lib/node_modules/npm/bin/npm-cli.js}
  //   - homebrew (macOS): /opt/homebrew/Cellar/node/<ver>/{bin/node, lib/...}
  //   - snap:   /snap/node/current/{bin/node, lib/node_modules/...}
  // If none of the candidates exist (extremely unusual), fall back to bare
  // `npm` and rely on PATH — same behavior as before.
  const nodeBin = process.execPath;
  const nodeDir = dirname(nodeBin);
  // Discovery happens INSIDE the bash script at runtime (see the
  // `discover npm-cli.js` block in the script body). The bash script
  // tries multiple strategies in order, with the most reliable first:
  //   1. `npm prefix -g` → derive `<prefix>/lib/node_modules/npm/bin/npm-cli.js`
  //   2. realpath of `<nodeDir>/npm` (handles symlink-based installs)
  //   3. relative candidates for nvm/fnm/volta/system/homebrew/snap layouts
  //   4. Fallback to bare `npm` and let the shebang chain handle it
  // Doing it in the script (vs hardcoded TS-side resolution) means the
  // discovery runs in the actual environment of the upgrade — different
  // user, different npm install method, no problem. Path baked at TS
  // gen-time would lock in the daemon process's view of npm, which can
  // diverge from the user-side installation (e.g. user upgraded node
  // mid-session).

  const pkgSpec = targetVersion ? `imcodes@${targetVersion}` : 'imcodes@latest';
  const targetVer = targetVersion ?? 'latest';
  const currentVer = DAEMON_VERSION;
  const oldDaemonPid = process.pid;
  // 24 h cleanup so a failed upgrade leaves debuggable artifacts on disk
  // instead of evaporating in 60 s. Operators running into a stuck daemon
  // can grep `find /tmp -name 'imcodes-upgrade-*' -mmin -1440` after the
  // fact. Successful upgrades still clean up via the same timer; the only
  // observable change is debugability. On Linux the delayed cleanup must run
  // in its own transient user unit; a background `sleep 86400` spawned from
  // imcodes.service stays in the daemon's cgroup and pollutes systemctl status
  // until it exits.
  const CLEANUP_AFTER_SEC = 24 * 60 * 60;
  // Pin the registry for both the visibility precheck and the install so they
  // resolve from the same source as the pre-flight probe above. Empty when the
  // resolved registry is the official default (preserves prior behavior exactly
  // — no --registry flag, npm uses its ambient config).
  const registryArg = upgradeRegistry.explicit ? `--registry ${upgradeRegistry.base}` : '';
  const script = `#!/bin/bash
# imcodes daemon-upgrade script. Generated by daemon.upgrade.
# Runs detached, outlives the parent daemon process.
# Logs every step to "$LOG" — keep the file for 24 h after exit so a
# stuck or failed restart can be diagnosed post-hoc.

LOG="${logFile}"
SCRIPT_DIR="${scriptDir}"
CLEANUP_AFTER_SEC=${CLEANUP_AFTER_SEC}
REGISTRY_ARG="${registryArg}"
log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*" >> "$LOG"; }

schedule_self_cleanup() {
  if [ -z "$SCRIPT_DIR" ] || [ ! -d "$SCRIPT_DIR" ]; then
    return 0
  fi

  if [ "$(uname)" = "Linux" ]; then
    if command -v systemd-run >/dev/null 2>&1; then
      CLEANUP_LABEL=$(printf '%s' "$(basename "$SCRIPT_DIR")" | tr -c 'A-Za-z0-9_.-' '-')
      CLEANUP_UNIT="imcodes-upgrade-cleanup-$CLEANUP_LABEL"
      if systemd-run --user --unit="$CLEANUP_UNIT" --collect --quiet /bin/sh -c 'sleep "$1"; rm -rf "$2"' imcodes-upgrade-cleanup "$CLEANUP_AFTER_SEC" "$SCRIPT_DIR" >> "$LOG" 2>&1; then
        log "[cleanup] scheduled via systemd-run user unit: $CLEANUP_UNIT"
        return 0
      fi
      log "[cleanup] systemd-run scheduling failed (non-fatal); leaving $SCRIPT_DIR for manual cleanup"
    else
      log "[cleanup] systemd-run unavailable; leaving $SCRIPT_DIR for manual cleanup"
    fi
    log "[cleanup] skipped background sleeper on Linux to avoid leaking into imcodes.service cgroup"
    return 0
  fi

  (sleep "$CLEANUP_AFTER_SEC" && rm -rf "$SCRIPT_DIR") >/dev/null 2>&1 &
  log "[cleanup] scheduled via background sleeper"
}

log "=== imcodes upgrade started ==="
log "[step 0] daemon PID at gen time: ${oldDaemonPid}"
log "[step 0] node bin: ${nodeBin}"
log "[step 0] target: ${pkgSpec} (current daemon version: ${currentVer})"
log "[step 0] registry: \${REGISTRY_ARG:-<npm default>}"

# ── Single-flight guard ─────────────────────────────────────────────────
#
# npm global installs are NOT atomic: a failed or concurrent
# \`npm install -g imcodes@...\` can remove/replace the global package while a
# second upgrade has already installed a good copy.  Keep the old daemon
# serving while the install runs, but allow only ONE upgrade script to touch
# the global install / service restart path at a time.
UPGRADE_LOCK_DIR="$HOME/.imcodes/upgrade.lock.d"
UPGRADE_LOCK_PID="$UPGRADE_LOCK_DIR/pid"
UPGRADE_LOCK_STARTED="$UPGRADE_LOCK_DIR/started"
UPGRADE_LOCK_STALE_AFTER_SEC=1800
UPGRADE_LOCK_HELD=0

lock_age_seconds() {
  local started now
  started=$(cat "$UPGRADE_LOCK_STARTED" 2>/dev/null || true)
  now=$(date +%s)
  case "$started" in
    ''|*[!0-9]*)
      # If a prior process crashed between mkdir and writing the started
      # file, fall back to the lock directory's mtime so it can still expire.
      started=$(stat -c %Y "$UPGRADE_LOCK_DIR" 2>/dev/null || stat -f %m "$UPGRADE_LOCK_DIR" 2>/dev/null || echo "$now")
      case "$started" in
        ''|*[!0-9]*) echo 0 ;;
        *) echo $((now - started)) ;;
      esac
      ;;
    *) echo $((now - started)) ;;
  esac
}

acquire_upgrade_lock() {
  mkdir -p "$HOME/.imcodes" 2>/dev/null || true
  while true; do
    if mkdir "$UPGRADE_LOCK_DIR" 2>/dev/null; then
      echo "$$" > "$UPGRADE_LOCK_PID" 2>/dev/null || true
      date +%s > "$UPGRADE_LOCK_STARTED" 2>/dev/null || true
      UPGRADE_LOCK_HELD=1
      log "[step 0.5] acquired upgrade lock: $UPGRADE_LOCK_DIR"
      return 0
    fi

    LOCK_OWNER=$(cat "$UPGRADE_LOCK_PID" 2>/dev/null || true)
    LOCK_AGE=$(lock_age_seconds)
    if [ -n "$LOCK_OWNER" ] && kill -0 "$LOCK_OWNER" 2>/dev/null; then
      log "[step 0.5] another upgrade is already running (pid $LOCK_OWNER, age \${LOCK_AGE}s) — exiting without touching npm/service"
      return 1
    fi
    if [ -z "$LOCK_OWNER" ] && [ "$LOCK_AGE" -lt "$UPGRADE_LOCK_STALE_AFTER_SEC" ]; then
      log "[step 0.5] upgrade lock exists without owner (age \${LOCK_AGE}s) — treating as active, exiting"
      return 1
    fi

    STALE_LOCK="\${UPGRADE_LOCK_DIR}.stale.$$"
    log "[step 0.5] removing stale upgrade lock (owner: \${LOCK_OWNER:-unknown}, age \${LOCK_AGE}s)"
    if mv "$UPGRADE_LOCK_DIR" "$STALE_LOCK" 2>/dev/null; then
      rm -rf "$STALE_LOCK"
      # Loop back and acquire with mkdir; if another process won the race,
      # mkdir will fail and we'll re-check the new owner.
      continue
    fi

    log "[step 0.5] lost race while clearing stale upgrade lock — exiting"
    return 1
  done
}

release_upgrade_lock() {
  if [ "$UPGRADE_LOCK_HELD" = "1" ]; then
    OWNER=$(cat "$UPGRADE_LOCK_PID" 2>/dev/null || true)
    if [ "$OWNER" = "$$" ]; then
      rm -rf "$UPGRADE_LOCK_DIR"
      log "[step 0.5] released upgrade lock"
    else
      log "[step 0.5] not releasing upgrade lock; owner changed to \${OWNER:-unknown}"
    fi
  fi
}

if ! acquire_upgrade_lock; then
  log "=== upgrade skipped: another upgrade is in progress ==="
  schedule_self_cleanup
  exit 0
fi
trap release_upgrade_lock EXIT

# Make node visible to everything we spawn (npm post-install scripts,
# node-gyp, the freshly-installed imcodes --version probe, etc).
# Critical on nvm/fnm/volta where node lives outside system PATH.
export PATH="${nodeDir}:$PATH"
log "[step 0] PATH=$PATH"

# Discover npm-cli.js dynamically — works for any node install method
# (Homebrew, nvm, fnm, volta, system pkg, snap, plain tarball, custom).
# Strategy ordering: most reliable first, fall through on failure.
NODE="${nodeBin}"
NPM_CLI=""

# Strategy 1: ask npm itself where it's installed. The shebang in
# <nodeDir>/npm will find node (we just exported PATH), so this works
# regardless of how the user installed node.
if [ -z "$NPM_CLI" ]; then
  NPM_PREFIX=$(npm prefix -g 2>>"$LOG")
  if [ -n "$NPM_PREFIX" ] && [ -f "$NPM_PREFIX/lib/node_modules/npm/bin/npm-cli.js" ]; then
    NPM_CLI="$NPM_PREFIX/lib/node_modules/npm/bin/npm-cli.js"
    log "[step 0] npm-cli.js via npm prefix -g: $NPM_CLI"
  fi
fi

# Strategy 2: realpath the npm sibling next to node. Handles symlink-
# based installs (Homebrew, nvm, fnm — even when their layouts diverge).
if [ -z "$NPM_CLI" ] && [ -e "${nodeDir}/npm" ]; then
  RESOLVED=$(readlink -f "${nodeDir}/npm" 2>/dev/null || readlink "${nodeDir}/npm" 2>/dev/null)
  case "$RESOLVED" in
    *npm-cli.js)
      if [ -f "$RESOLVED" ]; then
        NPM_CLI="$RESOLVED"
        log "[step 0] npm-cli.js via realpath \\\${nodeDir}/npm: $NPM_CLI"
      fi
      ;;
  esac
fi

# Strategy 3: probe known relative-from-nodeDir layouts.
if [ -z "$NPM_CLI" ]; then
  for CANDIDATE in \
    "${nodeDir}/../lib/node_modules/npm/bin/npm-cli.js" \
    "${nodeDir}/../../../lib/node_modules/npm/bin/npm-cli.js" \
    "${nodeDir}/node_modules/npm/bin/npm-cli.js" \
  ; do
    if [ -f "$CANDIDATE" ]; then
      NPM_CLI="$CANDIDATE"
      log "[step 0] npm-cli.js via candidate probe: $NPM_CLI"
      break
    fi
  done
fi

# Strategy 4: fall back to bare \`npm\` on PATH (PATH already includes nodeDir).
# The shebang chain still works because node is on PATH from our export.
if [ -z "$NPM_CLI" ]; then
  log "[step 0] npm-cli.js NOT located via any strategy — using bare 'npm' from PATH"
  NPM_RUN='npm'
else
  NPM_RUN="\\"$NODE\\" \\"$NPM_CLI\\""
fi
log "[step 0] npm runner: $NPM_RUN"

# Give the running daemon a moment to finish in-flight responses.
sleep 3

log "[step 1] discover global package root"
GLOBAL_ROOT=$(eval "$NPM_RUN root -g" 2>>"$LOG")
log "[step 1] global root: $GLOBAL_ROOT"
GLOBAL_PKG="$GLOBAL_ROOT/imcodes"

# Remove existing npm link if any — it shadows install and prevents real upgrade.
if [ -L "$GLOBAL_PKG" ]; then
  log "[step 1] removing pre-existing npm link: $GLOBAL_PKG -> $(readlink "$GLOBAL_PKG")"
  eval "$NPM_RUN uninstall -g imcodes" >> "$LOG" 2>&1 || log "[step 1] uninstall returned non-zero (ignored)"
fi

log "[step 2] installing ${pkgSpec}"
# --ignore-scripts: \`scripts/strip-onnxruntime-gpu.mjs\` strips
# \`node_modules/sharp/\` from the published tarball so npm re-resolves it on
# the user's actual platform (otherwise the Linux-built bundle ships a
# Linux-only sharp wrapper that can't load on macOS/Windows). When npm
# re-resolves sharp during a global install, sharp's \`install\` hook
# (\`node install/check.js || npm run build\`) fails with MODULE_NOT_FOUND
# in a way we couldn't reproduce in nested project installs — npm seems
# to half-extract sharp under \`<global>/imcodes/node_modules/sharp/\` (the
# install/ directory ends up missing) and then runs the hook anyway. The
# fallback \`npm run build\` then walks UP into imcodes's package.json,
# tries to run imcodes's \`tsc\` build, and exits 127 because tsc isn't on
# the global PATH. Net effect: every auto-upgrade since the strip-sharp
# change has been failing with exit 127 and operators were getting
# \`Cannot find module .../sharp/install/check.js\` in upgrade.log.
#
# Skipping install scripts is safe here because (a) sharp 0.34's runtime
# binary is the prebuilt \`@img/sharp-<platform>-<arch>\` package (which
# npm STILL fetches and unpacks because it's a regular optionalDependency
# of sharp — no install script involvement), and (b) the only thing
# install/check.js does is dlopen-test that prebuilt; if it fails
# check.js falls back to compiling from source (npm run build), which
# we never want on a user machine anyway.
#
# After the install we probe \`sharp/package.json\`. If npm left an empty
# placeholder dir (the half-extract pathology above), do a one-shot
# \`npm install\` from inside the global package to repopulate it. Run with
# --ignore-scripts again for the same reason.
#
# ── Retry on publish propagation / transient network failures ──────────
# Real-world failure mode caught on a production daemon: server publishes a
# new dev release to npm and broadcasts \`daemon.upgrade { targetVersion }\`
# almost immediately. npm origin has the version but the regional CDN
# edge serving this daemon hasn't replicated yet — so the packument
# response is a 200 missing the new version → npm exits with ETARGET.
# Pre-fix this either killed the upgrade for that release or, worse, ran
# \`npm cache clean --force\`, deleting every cached dependency on the box.
# The eventual successful install then had to redownload 200+ packages and
# took minutes. We now use a cheap \`npm view\` precheck for pinned versions,
# avoid full-cache wipes, and retry transient network failures like
# ECONNRESET/ETIMEDOUT/EAI_AGAIN.
INSTALL_OUT="${scriptDir}/install-attempt.log"
INSTALL_RC=1
ATTEMPT=0
MAX_ATTEMPTS=5
# Indexed sequentially with $ATTEMPT (1-based), so element 0 is unused.
# 15s / 30s / 60s / 120s keeps the common npm publish-CDN window quick
# without stretching a bad target into a 10-minute local stall.
RETRY_DELAYS=(0 15 30 60 120)

is_etarget_output() {
  grep -qiE 'code ETARGET|No matching version found' "$1" 2>/dev/null
}

is_transient_npm_output() {
  grep -qiE 'code (ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH)|network aborted|socket timeout|fetch failed|network socket disconnected|5[0-9][0-9]' "$1" 2>/dev/null
}

while [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; do
  ATTEMPT=$((ATTEMPT + 1))
  log "[step 2] install attempt $ATTEMPT/$MAX_ATTEMPTS"
  : > "$INSTALL_OUT"

  if [ "${targetVer}" != "latest" ]; then
    log "[step 2] registry visibility precheck for ${pkgSpec}"
    eval "$NPM_RUN view --prefer-online \${REGISTRY_ARG} ${pkgSpec} version" >> "$INSTALL_OUT" 2>&1
    VIEW_RC=$?
    cat "$INSTALL_OUT" >> "$LOG"
    if [ "$VIEW_RC" -ne 0 ] && is_etarget_output "$INSTALL_OUT"; then
      log "[step 2] ${pkgSpec} not visible in registry yet"
      if [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]; then
        log "[step 2] target never became visible across $MAX_ATTEMPTS attempts — giving up before heavyweight install"
        INSTALL_RC=$VIEW_RC
        break
      fi
      DELAY=\${RETRY_DELAYS[$ATTEMPT]}
      log "[step 2] waiting \${DELAY}s for npm publish propagation"
      sleep "$DELAY"
      continue
    fi
    if [ "$VIEW_RC" -ne 0 ]; then
      log "[step 2] registry precheck failed (exit $VIEW_RC); trying install anyway"
    fi
    : > "$INSTALL_OUT"
  fi

  # --prefer-online: tell npm to revalidate cached packument metadata
  # rather than serve potentially-stale entries. Do NOT use \`npm cache
  # clean --force\` here: it wipes cached dependency tarballs too, which is
  # exactly what made upgrades on large SDK dependency sets feel glacial.
  eval "$NPM_RUN install -g --ignore-scripts --prefer-online \${REGISTRY_ARG} ${pkgSpec}" >> "$INSTALL_OUT" 2>&1
  INSTALL_RC=$?
  # Always tee the attempt's output into the main log for forensics.
  cat "$INSTALL_OUT" >> "$LOG"
  if [ "$INSTALL_RC" -eq 0 ]; then
    log "[step 2] install attempt $ATTEMPT succeeded"
    break
  fi
  log "[step 2] install attempt $ATTEMPT failed (exit $INSTALL_RC)"
  IS_RETRYABLE=0
  RETRY_REASON="non-retryable"
  if is_etarget_output "$INSTALL_OUT"; then
    IS_RETRYABLE=1
    RETRY_REASON="target-not-visible"
  elif is_transient_npm_output "$INSTALL_OUT"; then
    IS_RETRYABLE=1
    RETRY_REASON="transient-network"
  fi
  if [ "$IS_RETRYABLE" -ne 1 ]; then
    log "[step 2] non-retryable npm failure — not retrying. Tail of npm output:"
    tail -20 "$INSTALL_OUT" | while IFS= read -r line; do log "[step 2]   $line"; done
    break
  fi
  if [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]; then
    log "[step 2] retryable npm failure ($RETRY_REASON) persisted across $MAX_ATTEMPTS attempts"
    break
  fi
  DELAY=\${RETRY_DELAYS[$ATTEMPT]}
  log "[step 2] retryable npm failure ($RETRY_REASON) — retrying in \${DELAY}s"
  sleep "$DELAY"
done
if [ "$INSTALL_RC" -ne 0 ]; then
  log "[step 2] install FAILED after $ATTEMPT attempts (final exit $INSTALL_RC) — keeping current daemon running"
  log "=== upgrade aborted ==="
  schedule_self_cleanup
  exit 0
fi
log "[step 2] install succeeded after $ATTEMPT attempt(s)"

${buildBashSharpRepair()}

# Read installed version directly from package.json — bypasses the
# freshly-installed imcodes shebang (which can fail under the same
# PATH issues that motivated this whole bypass).
GLOBAL_ROOT=$(eval "$NPM_RUN root -g" 2>/dev/null)
INSTALLED_VER=$("$NODE" -e "try{process.stdout.write(require('$GLOBAL_ROOT/imcodes/package.json').version)}catch(e){process.exit(1)}" 2>/dev/null || echo "unknown")
log "[step 3] installed version: $INSTALLED_VER, target: ${targetVer}"
if [ "${targetVer}" != "latest" ] && [ "$INSTALLED_VER" != "${targetVer}" ]; then
  log "[step 3] version mismatch — keeping current daemon running"
  log "=== upgrade aborted ==="
  schedule_self_cleanup
  exit 0
fi

# Downgrade guard — refuse to restart if installed < current daemon.
# Catches: server broadcasts \`latest\` but npm's "latest" dist-tag
# resolves to an older release than the operator's local dev build.
CURRENT_VER="${currentVer}"
"$NODE" -e "
  const a = process.argv[1], b = process.argv[2];
  const parse = v => { const i = v.indexOf('-'); return { rel: (i<0?v:v.slice(0,i)).split('.').map(n => parseInt(n,10)||0), pre: i<0 ? null : v.slice(i+1).split('.') }; };
  const A = parse(a), B = parse(b);
  const len = Math.max(A.rel.length, B.rel.length);
  for (let i = 0; i < len; i++) { const da = A.rel[i]||0, db = B.rel[i]||0; if (da !== db) process.exit(da < db ? 1 : 2); }
  if (A.pre === null && B.pre === null) process.exit(0);
  if (A.pre === null) process.exit(2);
  if (B.pre === null) process.exit(1);
  const plen = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < plen; i++) {
    const pa = A.pre[i]||'', pb = B.pre[i]||'';
    const na = /^\\d+\$/.test(pa) ? parseInt(pa,10) : null;
    const nb = /^\\d+\$/.test(pb) ? parseInt(pb,10) : null;
    if (na !== null && nb !== null) { if (na !== nb) process.exit(na < nb ? 1 : 2); }
    else if (pa !== pb) process.exit(pa < pb ? 1 : 2);
  }
  process.exit(0);
" "$INSTALLED_VER" "$CURRENT_VER"
CMP=$?
# Exit codes: 0=equal, 1=installed<current (downgrade), 2=installed>current (upgrade)
if [ "$CMP" = "1" ]; then
  log "[step 3] installed $INSTALLED_VER is OLDER than current $CURRENT_VER — refusing to downgrade"
  log "=== upgrade aborted ==="
  schedule_self_cleanup
  exit 0
fi
if [ "$CMP" = "0" ]; then
  log "[step 3] installed $INSTALLED_VER matches current — no restart needed"
  log "=== upgrade complete (no-op) ==="
  schedule_self_cleanup
  exit 0
fi
log "[step 3] version comparator: installed > current → restart"

# ── Step 3.5: Regenerate launch chain with the new binary's paths ──────
#
# Why this exists: on Linux the systemd unit at
# ~/.config/systemd/user/imcodes.service hard-codes ExecStart with the
# absolute path to \`node\` and the imcodes entry script as they existed at
# \`imcodes bind\` time. Any of these scenarios leaves it pointing at a
# bin that no longer exists / no longer resolves correctly:
#
#   * user switches node via nvm/fnm/volta — \`/.../node/v22.x.x/bin/imcodes\`
#     still resolves but a fresh \`npm i -g\` populated the new version's
#     prefix instead, so the old absolute path is stale.
#   * \`npm uninstall -g imcodes\` followed by reinstall under a different
#     prefix (homebrew vs nvm vs system) leaves the symlink dangling.
#   * any reorg of node versions where the bin sits at a new absolute path.
#
# Real-world hit: a production daemon stuck on an older dev build because the
# unit's ExecStart pointed at /home/k/.nvm/versions/node/v22.22.2/bin/imcodes
# from a prior install — \`systemctl restart imcodes\` succeeds in the
# upgrade script's eyes but the spawned process crashes "Cannot find
# module '/home/k/.../bin/imcodes'" (988 recorded crashes in daemon.log
# before one of them finally caught a working state by lucky races).
#
# Windows already does the equivalent (Step 5 "Regenerate daemon launch
# chain" in windows-upgrade-script.ts).  This mirrors that behavior for
# Linux + macOS so a successful npm install is always followed by a
# launch-chain pointing at the freshly-installed binary.
#
# Safe-by-design: we only touch ExecStart on Linux and ProgramArguments
# on macOS. Other Environment= / Restart= / KillMode= settings the user
# may have customised are preserved verbatim. If the unit / plist file
# doesn't exist, we skip silently — the user may run via \`imcodes start\`
# directly or have a non-standard launcher, neither of which we should
# clobber.
log "[step 3.5] regenerating launch chain"
NEW_IMCODES_SCRIPT="$GLOBAL_ROOT/imcodes/dist/src/index.js"
NEW_LAUNCHER="$GLOBAL_ROOT/imcodes/bin/imcodes-launch.sh"

# Prefer the self-healing launcher (bin/imcodes-launch.sh) when the
# freshly-installed package ships it. Older installs (pre-launcher) fall
# back to the direct node ExecStart so we never break versions that
# don't ship the file. Either way the resulting unit/plist points at
# absolute paths from THIS install — consistent with the rest of step
# 3.5's contract.
if [ -f "$NEW_LAUNCHER" ]; then
  LINUX_EXEC="ExecStart=$NEW_LAUNCHER start --foreground"
  DARWIN_PROGRAM_ARGS="[\\"$NEW_LAUNCHER\\",\\"start\\",\\"--foreground\\"]"
  log "[step 3.5] using self-healing launcher: $NEW_LAUNCHER"
else
  LINUX_EXEC="ExecStart=$NODE $NEW_IMCODES_SCRIPT start --foreground"
  DARWIN_PROGRAM_ARGS="[\\"$NODE\\",\\"$NEW_IMCODES_SCRIPT\\",\\"start\\",\\"--foreground\\"]"
  log "[step 3.5] $NEW_LAUNCHER not present in this version — using direct node ExecStart"
fi

if [ ! -f "$NEW_IMCODES_SCRIPT" ]; then
  log "[step 3.5] $NEW_IMCODES_SCRIPT not found — skipping (will rely on existing launch chain)"
elif [ "$(uname)" = "Linux" ]; then
  SVC="$HOME/.config/systemd/user/imcodes.service"
  if [ -f "$SVC" ]; then
    NEW_EXEC="$LINUX_EXEC"
    OLD_EXEC=$(grep -m1 '^ExecStart=' "$SVC" || echo '(none)')
    if [ "$OLD_EXEC" = "$NEW_EXEC" ]; then
      log "[step 3.5] systemd ExecStart already current"
    else
      log "[step 3.5] rewriting ExecStart"
      log "[step 3.5]   from: $OLD_EXEC"
      log "[step 3.5]   to:   $NEW_EXEC"
      # Use awk for portability — sed -i's in-place behavior differs
      # between BSD (mac) and GNU (linux), and quoting the replacement
      # gets thorny with paths that may contain '/'. awk on a temp
      # file is unambiguous on every Unix.
      if awk -v new="$NEW_EXEC" '
        BEGIN { done = 0 }
        /^ExecStart=/ { if (!done) { print new; done = 1; next } }
        { print }
      ' "$SVC" > "$SVC.new" && mv "$SVC.new" "$SVC"; then
        systemctl --user daemon-reload >> "$LOG" 2>&1 && log "[step 3.5] systemd daemon-reload OK" || log "[step 3.5] systemd daemon-reload FAILED (non-fatal)"
      else
        log "[step 3.5] awk rewrite FAILED — keeping old unit (non-fatal)"
        rm -f "$SVC.new"
      fi
    fi
  else
    log "[step 3.5] $SVC absent — nothing to rewrite"
  fi
elif [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/imcodes.daemon.plist"
  if [ -f "$PLIST" ]; then
    if command -v plutil >/dev/null 2>&1; then
      log "[step 3.5] rewriting plist ProgramArguments"
      if plutil -replace ProgramArguments -json "$DARWIN_PROGRAM_ARGS" "$PLIST" >> "$LOG" 2>&1; then
        log "[step 3.5] plutil rewrite OK"
      else
        log "[step 3.5] plutil rewrite FAILED (non-fatal)"
      fi
    else
      log "[step 3.5] plutil not available — skipping plist regen"
    fi
  else
    log "[step 3.5] $PLIST absent — nothing to rewrite"
  fi
fi

log "[step 4] running restart command"
# Wrap restartCmd in a subshell so its multi-line content captures all
# stdout/stderr to LOG. The previous template-literal interpolation
# attached >>$LOG to only the LAST line of restartCmd, swallowing
# everything before launchctl load (silent unload failures, kill exit
# codes, etc).
{
${restartCmd}
} >> "$LOG" 2>&1
RC=$?
log "[step 4] restart command exit code: $RC"

# Verify the old daemon process is actually gone — surfacing platform-
# specific restart failures (launchctl unload silently no-op'd, systemd
# returned 0 without restarting, etc).
sleep 2
if kill -0 ${oldDaemonPid} 2>/dev/null; then
  log "[step 4] WARN: old daemon PID ${oldDaemonPid} still alive after restart command"
else
  log "[step 4] old daemon PID ${oldDaemonPid} terminated as expected"
fi

# ── Step 5: Health check — verify a NEW daemon is actually running ─────
#
# Why: a successful step 4 (e.g. "systemctl --user restart imcodes" returns 0
# when the unit transitions to "activating") doesn't guarantee the new
# daemon survives. systemd returns success once the spawned process forks,
# but if its ExecStart fails (e.g. node crashes immediately on a stale
# module path that survived step 3.5), Restart=always immediately re-spawns
# it, and the failure repeats invisibly. The new daemon's PID is recorded
# in ~/.imcodes/daemon.pid AFTER successful startup, so we can use the pid
# file as a positive-liveness signal: read it 5–15 s after restart and
# kill -0 it.
#
# If the daemon failed to come up after restart, we surface the symptom in
# upgrade.log loudly so operators see "daemon NOT running after restart"
# instead of a silent dead service.
log "[step 5] post-restart health check"
sleep 5
HEALTH_PID=""
for i in 1 2 3; do
  if [ -f "$HOME/.imcodes/daemon.pid" ]; then
    HEALTH_PID=$(cat "$HOME/.imcodes/daemon.pid" 2>/dev/null || true)
    if [ -n "$HEALTH_PID" ] && kill -0 "$HEALTH_PID" 2>/dev/null && [ "$HEALTH_PID" != "${oldDaemonPid}" ]; then
      log "[step 5] new daemon healthy: PID $HEALTH_PID (after \${i}x check)"
      break
    fi
  fi
  HEALTH_PID=""
  sleep 3
done
if [ -z "$HEALTH_PID" ]; then
  log "[step 5] WARN: no live new daemon after 14s — service unit may have a stale path or the new binary crashes on startup"
  log "[step 5] WARN: check 'systemctl --user status imcodes' (linux) or 'log show --predicate \"subsystem == \\\"imcodes\\\"\"' (macos)"
  log "[step 5] WARN: if path-stale, manually fix ExecStart in $HOME/.config/systemd/user/imcodes.service then 'systemctl --user daemon-reload && systemctl --user restart imcodes'"
else
  # Drop the auto-upgrade cooldown sentinel — handleDaemonUpgrade
  # consults this on the new daemon's next auto-upgrade attempt to
  # rate-limit dev-tag-poll-driven restarts. Survives restart by
  # design (the very transition we are throttling against).
  # date +%s%3N = epoch ms (matches Date.now in JS). Best-effort: a
  # missing sentinel means no cooldown applies.
  date +%s%3N > "$HOME/.imcodes/last-upgrade-at" 2>/dev/null || true
  log "[step 5] cooldown sentinel updated: $HOME/.imcodes/last-upgrade-at"
fi

log "=== upgrade script done ==="

# Self-cleanup after 24 h so failures stay debuggable.
schedule_self_cleanup
`;

  writeFileSync(scriptPath, script, { mode: 0o755 });

  // Spawn fully detached — this process must NOT wait for the child
  const child = spawn('/bin/bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  logger.info({ log: logFile }, 'daemon.upgrade: upgrade script spawned, will restart in ~3 s');
  upgradeScriptSpawned = true;
  scheduleUpgradeMemoryFreezeRelease();
  } finally {
    if (!upgradeScriptSpawned) {
      releaseUpgradeMemoryFreeze();
    }
  }
}

// ── File system browser ────────────────────────────────────────────────────

// On Windows, don't restrict paths — projects commonly live on any drive (D:\code, etc.)
// The daemon runs as the user, so OS-level permissions are the real security boundary.
// Deny-list: block access to sensitive directories regardless of platform.
// Everything else is allowed — the daemon runs as the user and inherits their permissions.
const FS_DENIED_DIRS = ['.ssh', '.gnupg', '.pki'];

/** Special sentinel path that browses Windows drive roots (C:\, D:\, ...).
 *  Distinct from `~` so the home directory remains accessible on Windows. */
const WINDOWS_DRIVES_PATH = ':drives:';
const WINDOWS_DRIVES_ROOT = '__imcodes_windows_drives__';

function isPathAllowed(realPath: string): boolean {
  return isFilePreviewPathAllowed(realPath);
}

// ── P2P cancel/status handlers ────────────────────────────────────────────

async function handleP2pCancel(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const runId = cmd.runId as string | undefined;
  if (!runId) return;
  const ok = await cancelP2pRun(runId, serverLink);
  try { serverLink.send({ type: P2P_WORKFLOW_MSG.CANCEL_RESPONSE, runId, ok }); } catch { /* ignore */ }
}

async function handleP2pStatus(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const runId = cmd.runId as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  // Resolve scope mirror of handleP2pListDiscussions/handleP2pReadDiscussion: every
  // p2p.status request must be tied to a project context. Without scope we fail
  // closed (empty list / null run) so a browser viewer of project A cannot
  // observe runs belonging to project B that happens to share this daemon.
  const scope = await resolveP2pDiscussionProjectScope(cmd);
  if (!scope) {
    if (runId) {
      try { serverLink.send({ type: P2P_WORKFLOW_MSG.STATUS_RESPONSE, requestId, runId, run: null, error: 'missing_or_invalid_scope' }); } catch { /* ignore */ }
    } else {
      try { serverLink.send({ type: P2P_WORKFLOW_MSG.STATUS_RESPONSE, requestId, runs: [], error: 'missing_or_invalid_scope' }); } catch { /* ignore */ }
    }
    return;
  }
  const resolvedScope = scope;
  const discussionsDir = nodePath.resolve(imcSubDir(resolvedScope.projectDir, 'discussions'));
  // A run belongs to scope when its discussion file lives inside that project's
  // .imc/discussions directory. We also require initiatorSession (when set) to
  // resolve to the same canonical project — this catches edge cases where a run
  // was started against an external file path but the session itself is in a
  // different project.
  async function runMatchesScope(run: ReturnType<typeof getP2pRun>): Promise<boolean> {
    if (!run) return false;
    if (run.contextFilePath && isPathUnderDir(run.contextFilePath, discussionsDir)) return true;
    if (run.initiatorSession) {
      const initRecord = getSession(run.initiatorSession);
      if (initRecord?.projectDir) {
        const canon = await canonicalProjectDir(initRecord.projectDir);
        if (canon === resolvedScope.canonicalProjectDir) return true;
      }
    }
    return false;
  }
  if (runId) {
    const run = getP2pRun(runId);
    const inScope = await runMatchesScope(run);
    try { serverLink.send({ type: P2P_WORKFLOW_MSG.STATUS_RESPONSE, requestId, runId, run: inScope && run ? serializeP2pRun(run) : null }); } catch { /* ignore */ }
  } else {
    const runs = listP2pRuns();
    const filtered: typeof runs = [];
    for (const run of runs) {
      if (await runMatchesScope(run)) filtered.push(run);
    }
    try { serverLink.send({ type: P2P_WORKFLOW_MSG.STATUS_RESPONSE, requestId, runs: filtered.map((run) => serializeP2pRun(run)) }); } catch { /* ignore */ }
  }
}

// ── File search for @ picker ──────────────────────────────────────────────

const FILE_SEARCH_EXCLUDES = new Set([
  'node_modules', '.git', 'venv', '__pycache__', '.venv',
  'dist', 'build', '.next', '.nuxt', 'vendor', 'target',
]);

const FILE_SEARCH_MAX = 20;
const FILE_SEARCH_MAX_INDEXED_PATHS = 20_000;
const FILE_SEARCH_CACHE_TTL_MS = 5_000;
const FILE_SEARCH_CACHE_MAX_ENTRIES = 32;

interface FileSearchSnapshot {
  root: string;
  dirSignature: string;
  paths: string[];
}

const fileSearchCache = new Map<string, { expiresAt: number; value: FileSearchSnapshot }>();
const fileSearchInflight = new Map<string, Promise<FileSearchSnapshot>>();
const fileSearchGenerations = new Map<string, number>();

export function getActiveP2pRunsBlockingDaemonUpgrade(runs = listP2pRuns()) {
  return runs.filter((run) => !P2P_TERMINAL_RUN_STATUSES.has(run.status));
}

/** Transport-runtime statuses that represent a genuine in-flight turn the
 *  user is waiting on. `'error'` is intentionally NOT in this set — an
 *  errored runtime is *stuck*, not active, and forever-blocking daemon
 *  upgrades on it leaves the user no way out short of `imcodes service
 *  restart` (which is exactly what the upgrade wants to do anyway). */
const TRANSPORT_IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set(['thinking', 'streaming']);

/** A transport turn that reports in-progress (thinking/streaming) or
 *  sending/pending but has produced NO provider activity (no delta /
 *  completion / error / tool call / session-info / dispatch) for this long is
 *  treated as a PHANTOM — the provider wedged mid-turn (classic symptom: a
 *  lost `onComplete` leaves `_status='streaming'` and `_sending=true`
 *  forever) — and must NOT block daemon upgrades. Observed in production: a
 *  codex-sdk sub-session stuck in 'streaming' for 8+ hours blocked every
 *  auto-upgrade, pinning the daemon on a stale version. A live turn refreshes
 *  its activity timestamp on every delta, so a real generation never trips
 *  this (the absolute deferral backstop in `handleDaemonUpgrade` is the final
 *  safety net for everything this doesn't catch, e.g. wedged process agents).
 *  Override for tests via IMCODES_TRANSPORT_STALE_TURN_MS. */
const TRANSPORT_STALE_TURN_MS = (() => {
  const raw = parseInt(process.env.IMCODES_TRANSPORT_STALE_TURN_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60 * 1000;
})();

/** Snapshot of why a transport session is currently blocking daemon upgrade.
 *  Embedded in the upgrade-blocked log so future "why didn't it upgrade"
 *  investigations can see the actual failing condition instead of guessing
 *  whether session.state ('idle') or runtime.getStatus() ('error') is to blame. */
export interface TransportUpgradeBlockReason {
  status: string;
  sending: boolean;
  pendingCount: number;
  blockReason: 'status_thinking' | 'status_streaming' | 'sending' | 'pending';
}

export function getTransportSessionUpgradeBlockReason(
  sessionName: string,
  opts?: { now?: number; staleTurnMs?: number },
): TransportUpgradeBlockReason | null {
  const runtime = getTransportRuntime(sessionName);
  if (!runtime) return null;
  const status = runtime.getStatus();
  const sending = !!runtime.sending;
  const pendingCount = runtime.pendingCount ?? 0;
  let blockReason: TransportUpgradeBlockReason['blockReason'] | null = null;
  if (TRANSPORT_IN_PROGRESS_STATUSES.has(status)) {
    blockReason = status === 'streaming' ? 'status_streaming' : 'status_thinking';
  } else if (sending) {
    blockReason = 'sending';
  } else if (pendingCount > 0) {
    blockReason = 'pending';
  }
  if (!blockReason) return null;

  // Phantom-turn staleness guard. A runtime that reports in-progress but has
  // gone silent past the threshold is wedged — do NOT let it block the
  // upgrade indefinitely. `lastActivityAt` is absent on legacy/mock runtimes;
  // when so, fall back to the original always-block behaviour (safe default).
  const lastActivityAt = (runtime as { lastActivityAt?: number }).lastActivityAt;
  if (typeof lastActivityAt === 'number' && Number.isFinite(lastActivityAt)) {
    const now = opts?.now ?? Date.now();
    const staleMs = opts?.staleTurnMs ?? TRANSPORT_STALE_TURN_MS;
    const ageMs = now - lastActivityAt;
    if (ageMs >= staleMs) {
      logger.warn(
        { sessionName, status, sending, pendingCount, blockReason, ageMs, staleMs },
        'daemon.upgrade: transport turn is stale (no provider activity past threshold) — treating as phantom, NOT blocking upgrade',
      );
      return null;
    }
  }
  return { status, sending, pendingCount, blockReason };
}

/** Process-agent session.state values that represent a genuine in-flight turn.
 *  `'running'` is set by tmux/ConPTY drivers when the underlying CLI agent
 *  (claude-code, codex, opencode, gemini) has emitted activity that the
 *  driver classifies as "agent generating" — a self-upgrade restart in that
 *  window kills the agent's child process mid-turn and discards its work.
 *
 *  `'queued'` represents a turn that the user has dispatched but the driver
 *  has not yet flipped to `'running'` (e.g. waiting in tmux for the prompt
 *  delivery to settle, or waiting for a session restart-on-relaunch handshake
 *  to complete). The web client's `isRunningSessionState` already counts
 *  `'queued'` as busy; the upgrade gate previously did not, so a turn
 *  dispatched a few hundred ms before an `daemon.upgrade` broadcast would be
 *  silently killed. Including `'queued'` here closes that race. */
const PROCESS_IN_PROGRESS_STATES: ReadonlySet<string> = new Set(['running', 'queued']);

/** Per-session reason a daemon upgrade is currently blocked. Covers both
 *  transport-runtime sessions (claude-code-sdk, codex-sdk, qwen, …) and
 *  process-runtime sessions (claude-code, codex, opencode, gemini, shell)
 *  so the upgrade does not restart the daemon mid-turn for either kind. */
export interface SessionUpgradeBlockReason {
  name: string;
  runtimeType: 'transport' | 'process';
  sessionState: string;
  /** Populated only for transport sessions; null for process sessions. */
  transport: TransportUpgradeBlockReason | null;
}

export function getActiveSessionsBlockingDaemonUpgrade(
  sessions = listSessions(),
  opts?: { now?: number; staleTurnMs?: number },
): SessionUpgradeBlockReason[] {
  const reasons: SessionUpgradeBlockReason[] = [];
  for (const session of sessions) {
    if (session.runtimeType === 'transport') {
      const transport = getTransportSessionUpgradeBlockReason(session.name, opts);
      if (transport) {
        reasons.push({
          name: session.name,
          runtimeType: 'transport',
          sessionState: session.state,
          transport,
        });
      }
      continue;
    }
    // Process agent (tmux / ConPTY CLI). The transport-runtime block reason
    // helper is irrelevant here because there is no transport runtime to
    // probe; the only signal we have is `session.state === 'running'`,
    // which the driver flips when the CLI is mid-generation.
    if (PROCESS_IN_PROGRESS_STATES.has(session.state)) {
      reasons.push({
        name: session.name,
        runtimeType: 'process',
        sessionState: session.state,
        transport: null,
      });
    }
  }
  return reasons;
}

/**
 * Backward-compat wrapper. Retained because external callers (tests,
 * possibly third-party scripts) import the older transport-only helper
 * by name. New code should use `getActiveSessionsBlockingDaemonUpgrade`,
 * which covers both transport and process agents.
 */
export function getActiveTransportSessionsBlockingDaemonUpgrade(sessions = listSessions()) {
  const blockedNames = new Set(
    getActiveSessionsBlockingDaemonUpgrade(sessions)
      .filter((reason) => reason.runtimeType === 'transport')
      .map((reason) => reason.name),
  );
  return sessions.filter((session) => blockedNames.has(session.name));
}

async function handleFileSearch(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const query = (cmd.query as string ?? '').trim();
  const projectDir = cmd.projectDir as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  if (!requestId || !projectDir) return;

  try {
    const canonical = await resolveCanonical(projectDir, 'strict');
    if (!canonical) {
      try { serverLink.send({ type: 'file.search_response', requestId, results: [], error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH }); } catch { /* ignore */ }
      return;
    }
    const allPaths = (await getFileSearchSnapshot(canonical.realPath)).paths;

    let top: string[];
    if (!query) {
      // No query — return first files alphabetically
      top = [...allPaths].sort().slice(0, FILE_SEARCH_MAX);
    } else {
      // 2. Fuzzy search via fzf
      const { Fzf } = await import('fzf');
      const fzf = new Fzf(allPaths, {
        fuzzy: allPaths.length >= FILE_SEARCH_MAX_INDEXED_PATHS ? 'v1' : 'v2',
        forward: false,
        casing: 'case-insensitive',
        tiebreakers: [fileSearchByBasenamePrefix, fileSearchByMatchPosFromEnd, fileSearchByLengthAsc],
      });
      const results = fzf.find(query);
      top = results.slice(0, FILE_SEARCH_MAX).map((r: { item: string }) => r.item);
    }

    try { serverLink.send({ type: 'file.search_response', requestId, results: top }); } catch { /* ignore */ }
  } catch (err) {
    try { serverLink.send({ type: 'file.search_response', requestId, results: [], error: String(err) }); } catch { /* ignore */ }
  }
}

async function loadFileSearchSnapshot(root: string): Promise<FileSearchSnapshot> {
  const paths: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    if (paths.length >= FILE_SEARCH_MAX_INDEXED_PATHS) return;
    let entries: import('fs').Dirent[];
    try { entries = await fsReaddir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (paths.length >= FILE_SEARCH_MAX_INDEXED_PATHS) return;
      if (FILE_SEARCH_EXCLUDES.has(entry.name)) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        paths.push(`${relPath}/`);
        await walk(nodePath.join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        paths.push(relPath);
      }
    }
  }
  await walk(root, '');
  return {
    root,
    dirSignature: await safeStatSignature(root),
    paths,
  };
}

async function getFileSearchSnapshot(root: string): Promise<FileSearchSnapshot> {
  sweepExpiredCache(fileSearchCache);
  const dirSignature = await safeStatSignature(root);
  const cached = fileSearchCache.get(root);
  if (cached && cached.expiresAt > Date.now() && cached.value.dirSignature === dirSignature) {
    fileSearchCache.delete(root);
    fileSearchCache.set(root, cached);
    return cached.value;
  }

  const generation = getResourceGeneration(fileSearchGenerations, root);
  const inflightKey = `${root}::${generation}`;
  const inflight = fileSearchInflight.get(inflightKey);
  if (inflight) return await inflight;

  const promise = loadFileSearchSnapshot(root)
    .then(async (value) => {
      const currentSignature = await safeStatSignature(root);
      if (getResourceGeneration(fileSearchGenerations, root) === generation && currentSignature === value.dirSignature) {
        setBoundedCache(fileSearchCache, root, { value, expiresAt: Date.now() + FILE_SEARCH_CACHE_TTL_MS }, FILE_SEARCH_CACHE_MAX_ENTRIES);
      }
      return value;
    })
    .finally(() => {
      fileSearchInflight.delete(inflightKey);
    });
  fileSearchInflight.set(inflightKey, promise);
  return await promise;
}

function invalidateFileSearchCachesForPath(targetPath: string): void {
  const normalized = normalizeFsPath(targetPath);
  const roots = new Set<string>([
    ...fileSearchCache.keys(),
    ...fileSearchGenerations.keys(),
    ...[...fileSearchInflight.keys()].map((key) => key.split('::')[0] ?? ''),
  ]);
  for (const root of roots) {
    if (!root) continue;
    if (!isPathInside(root, normalized) && !isPathInside(normalized, root)) continue;
    bumpResourceGeneration(fileSearchGenerations, root);
    fileSearchCache.delete(root);
    for (const key of fileSearchInflight.keys()) {
      if (key.startsWith(`${root}::`)) fileSearchInflight.delete(key);
    }
  }
}

const FS_LIST_DEADLINE_MS = 10_000;
const FS_LIST_CACHE_TTL_MS = 5_000;
const FS_LIST_STALE_CACHE_TTL_MS = 30_000;
const FS_LIST_CACHE_MAX_ENTRIES = 128;
const FS_LIST_INFLIGHT_FANOUT_CAP = 32;
const FS_LIST_METADATA_CONCURRENCY = 32;

interface FreshnessCacheEntry<T> {
  expiresAt: number;
  staleUntil?: number;
  value: T;
}

interface InflightWork<T> {
  promise: Promise<T>;
  attached: number;
}

interface FsLsSnapshot {
  resolvedPath: string;
  dirSignature: string;
  entries: Array<Record<string, unknown>>;
}

interface FsListRequestContext {
  readonly terminal: boolean;
  markTerminal(): void;
  send(message: Record<string, unknown>): boolean;
}

const fsListCache = new Map<string, FreshnessCacheEntry<FsLsSnapshot>>();
const fsListInflight = new Map<string, InflightWork<FsLsSnapshot>>();
const fsListGenerations = new Map<string, number>();

function sweepExpiredCache<T, E extends FreshnessCacheEntry<T>>(cache: Map<string, E>, now = Date.now()): void {
  for (const [key, entry] of cache) {
    if ((entry.staleUntil ?? entry.expiresAt) <= now) cache.delete(key);
  }
}

function setBoundedCache<T, E extends FreshnessCacheEntry<T>>(
  cache: Map<string, E>,
  key: string,
  entry: E,
  maxEntries: number,
): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    cache.delete(oldestKey);
  }
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) return [];
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function getFsListCacheKey(realPath: string, includeFiles: boolean, includeMetadata: boolean, allowDownloadHandles: boolean): string {
  const metadataMode = includeMetadata
    ? (allowDownloadHandles ? 'meta' : 'meta-no-downloads')
    : 'plain';
  return `${realPath}::${includeFiles ? 'files' : 'dirs'}::${metadataMode}`;
}

function createFsListRequestContext(serverLink: ServerLink): FsListRequestContext {
  let terminal = false;
  let sent = false;
  return {
    get terminal() {
      return terminal;
    },
    markTerminal() {
      terminal = true;
    },
    send(message: Record<string, unknown>): boolean {
      if (terminal || sent) return false;
      sent = true;
      terminal = true;
      try {
        serverLink.send(message);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function fsListErrorCode(error: unknown): string {
  if (error instanceof FsListPoolError) {
    if (error.reason === 'queue_full') return FS_GENERIC_ERROR_CODES.FS_LIST_WORKER_QUEUE_FULL;
    if (error.reason === 'timeout') return FS_GENERIC_ERROR_CODES.FS_LIST_WORKER_TIMEOUT;
    if (error.reason === 'unavailable' || error.reason === 'crashed' || error.reason === 'shutdown') {
      return FS_GENERIC_ERROR_CODES.FS_LIST_WORKER_UNAVAILABLE;
    }
    return FS_GENERIC_ERROR_CODES.INTERNAL_ERROR;
  }
  return error instanceof Error ? error.message : String(error);
}

function canUseFsListStaleCache(error: unknown): boolean {
  return error instanceof FsListPoolError
    && (
      error.reason === 'queue_full'
      || error.reason === 'timeout'
      || error.reason === 'unavailable'
      || error.reason === 'crashed'
      || error.reason === 'shutdown'
    );
}

function getCachedFsListSnapshot(cacheKey: string, dirSignature: string, allowStale: boolean): FsLsSnapshot | null {
  const cached = fsListCache.get(cacheKey);
  if (!cached || cached.value.dirSignature !== dirSignature) return null;
  const now = Date.now();
  const usableUntil = allowStale ? (cached.staleUntil ?? cached.expiresAt) : cached.expiresAt;
  if (usableUntil <= now) return null;
  fsListCache.delete(cacheKey);
  fsListCache.set(cacheKey, cached);
  return cached.value;
}

function fsListWorkerQueueDepth(): number {
  if (!shouldUseFsListWorkerPool()) return 0;
  const pool = getDefaultFsListWorkerPool() as { getQueueDepth?: () => number };
  try {
    return typeof pool.getQueueDepth === 'function' ? pool.getQueueDepth() : 0;
  } catch {
    return 0;
  }
}

function fsGitStatusWorkerQueueDepth(): number {
  if (!shouldUseFsGitStatusWorkerPool()) return 0;
  const pool = getDefaultFsGitStatusWorkerPool() as { getQueueDepth?: () => number };
  try {
    return typeof pool.getQueueDepth === 'function' ? pool.getQueueDepth() : 0;
  } catch {
    return 0;
  }
}

async function loadFsListSnapshot(real: string, includeFiles: boolean, includeMetadata: boolean, allowDownloadHandles: boolean): Promise<FsLsSnapshot> {
  const snapshot = shouldUseFsListWorkerPool()
    ? await getDefaultFsListWorkerPool().dispatch({
      realPath: real,
      includeFiles,
      includeMetadata,
    })
    : await scanFsListSnapshot({ realPath: real, includeFiles, includeMetadata });

  const entries: Array<Record<string, unknown>> = snapshot.entries.map((entry) => ({ ...entry }));
  if (includeMetadata && allowDownloadHandles) {
    await mapWithConcurrency(entries, FS_LIST_METADATA_CONCURRENCY, async (entry) => {
      if (entry.isDir === true || typeof entry.path !== 'string' || typeof entry.name !== 'string') return entry;
      const size = typeof entry.size === 'number' ? entry.size : undefined;
      const mime = typeof entry.mime === 'string' ? entry.mime : undefined;
      const handle = await tryCreateProjectFileHandle(entry.path, entry.name, mime, size);
      if (handle) entry.downloadId = handle.id;
      return entry;
    });
  }

  return {
    resolvedPath: snapshot.resolvedPath,
    dirSignature: snapshot.dirSignature,
    entries,
  };
}

async function getFsListSnapshot(real: string, includeFiles: boolean, includeMetadata: boolean, allowDownloadHandles: boolean): Promise<FsLsSnapshot> {
  sweepExpiredCache(fsListCache);
  const dirSignature = await safeStatSignature(real);
  const cacheKey = getFsListCacheKey(real, includeFiles, includeMetadata, allowDownloadHandles);
  const cached = getCachedFsListSnapshot(cacheKey, dirSignature, false);
  if (cached) {
    recordFsWorkerMetric({
      commandType: 'fs.ls',
      cacheStatus: 'hit',
      terminalReason: 'ok',
      queueDepth: fsListWorkerQueueDepth(),
      queueWaitMs: 0,
      workerExecutionMs: 0,
      entryCount: cached.entries.length,
      includeFiles,
      includeMetadata,
    });
    return cached;
  }
  const staleCached = getCachedFsListSnapshot(cacheKey, dirSignature, true);

  const generation = getResourceGeneration(fsListGenerations, real);
  const inflightKey = `${cacheKey}::${dirSignature}::${generation}`;
  const inflight = fsListInflight.get(inflightKey);
  if (inflight) {
    if (inflight.attached >= FS_LIST_INFLIGHT_FANOUT_CAP) throw new FsListPoolError('queue_full');
    inflight.attached += 1;
    recordFsWorkerMetric({
      commandType: 'fs.ls',
      cacheStatus: 'inflight',
      terminalReason: 'ok',
      queueDepth: fsListWorkerQueueDepth(),
      queueWaitMs: 0,
      workerExecutionMs: 0,
      attached: inflight.attached,
      includeFiles,
      includeMetadata,
    });
    return await inflight.promise;
  }

  const workerStartedAt = Date.now();
  const queueDepthAtDispatch = fsListWorkerQueueDepth();
  const promise = loadFsListSnapshot(real, includeFiles, includeMetadata, allowDownloadHandles)
    .then(async (value) => {
      const currentSignature = await safeStatSignature(real);
      if (
        getResourceGeneration(fsListGenerations, real) === generation
        && currentSignature === dirSignature
        && value.dirSignature === dirSignature
      ) {
        setBoundedCache(
          fsListCache,
          cacheKey,
          {
            value,
            expiresAt: Date.now() + FS_LIST_CACHE_TTL_MS,
            staleUntil: Date.now() + FS_LIST_STALE_CACHE_TTL_MS,
          },
          FS_LIST_CACHE_MAX_ENTRIES,
        );
      }
      recordFsWorkerMetric({
        commandType: 'fs.ls',
        cacheStatus: 'miss',
        terminalReason: 'ok',
        queueDepth: queueDepthAtDispatch,
        queueWaitMs: 0,
        workerExecutionMs: Date.now() - workerStartedAt,
        entryCount: value.entries.length,
        includeFiles,
        includeMetadata,
      });
      return value;
    })
    .catch((error) => {
      const terminalReason = fsListErrorCode(error);
      if (staleCached && canUseFsListStaleCache(error)) {
        recordFsWorkerMetric({
          commandType: 'fs.ls',
          cacheStatus: 'stale',
          terminalReason,
          queueDepth: queueDepthAtDispatch,
          queueWaitMs: 0,
          workerExecutionMs: Date.now() - workerStartedAt,
          lateResultSkip: true,
          entryCount: staleCached.entries.length,
          includeFiles,
          includeMetadata,
        });
        return staleCached;
      }
      recordFsWorkerMetric({
        commandType: 'fs.ls',
        cacheStatus: 'miss',
        terminalReason,
        queueDepth: queueDepthAtDispatch,
        queueWaitMs: 0,
        workerExecutionMs: Date.now() - workerStartedAt,
        includeFiles,
        includeMetadata,
      });
      throw error;
    })
    .finally(() => {
      fsListInflight.delete(inflightKey);
    });
  fsListInflight.set(inflightKey, { promise, attached: 1 });
  return await promise;
}

function invalidateFsListCachesForPath(targetPath: string): void {
  const realTarget = normalizeFsPath(targetPath);
  bumpResourceGeneration(fsListGenerations, realTarget);
  for (const includeFiles of [false, true]) {
    fsListCache.delete(getFsListCacheKey(realTarget, includeFiles, false, true));
    fsListCache.delete(getFsListCacheKey(realTarget, includeFiles, true, true));
    fsListCache.delete(getFsListCacheKey(realTarget, includeFiles, true, false));
  }

  const parent = nodePath.dirname(realTarget);
  if (parent !== realTarget) {
    bumpResourceGeneration(fsListGenerations, parent);
    for (const includeFiles of [false, true]) {
      fsListCache.delete(getFsListCacheKey(parent, includeFiles, false, true));
      fsListCache.delete(getFsListCacheKey(parent, includeFiles, true, true));
      fsListCache.delete(getFsListCacheKey(parent, includeFiles, true, false));
    }
  }
}

async function handleFsList(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawPath = cmd.path as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  const includeFiles = cmd.includeFiles === true;
  const includeMetadata = cmd.includeMetadata === true;
  if (!rawPath || !requestId) return;

  // Special sentinel paths bypass normal path resolution
  const isDrivesSentinel = rawPath === WINDOWS_DRIVES_PATH;
  const expanded = isDrivesSentinel
    ? rawPath
    : (rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath);
  const resolved = isDrivesSentinel ? rawPath : nodePath.resolve(expanded);
  const requestContext = createFsListRequestContext(serverLink);

  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error(FS_GENERIC_ERROR_CODES.FS_LIST_TIMEOUT)), FS_LIST_DEADLINE_MS);
    deadlineTimer.unref?.();
  });

  try {
    await Promise.race([handleFsListInner(resolved, rawPath, requestId, includeFiles, includeMetadata, requestContext), deadline]);
  } catch (err) {
    const msg = fsListErrorCode(err);
    if (msg === FS_GENERIC_ERROR_CODES.FS_LIST_TIMEOUT || msg === FS_GENERIC_ERROR_CODES.FS_LIST_WORKER_TIMEOUT) {
      invalidateFsListCachesForPath(resolved);
    }
    if (msg === FS_GENERIC_ERROR_CODES.FS_LIST_TIMEOUT) {
      requestContext.send({ type: 'fs.ls_response', requestId, path: rawPath, status: 'error', error: FS_GENERIC_ERROR_CODES.FS_LIST_TIMEOUT });
    } else {
      requestContext.send({ type: 'fs.ls_response', requestId, path: rawPath, status: 'error', error: msg });
    }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    requestContext.markTerminal();
  }
}

async function handleFsListInner(resolved: string, rawPath: string, requestId: string, includeFiles: boolean, includeMetadata: boolean, requestContext: FsListRequestContext): Promise<void> {
  // Windows drive picker — only triggered by the explicit `:drives:` path,
  // NOT by `~` (which always means the user's home directory on every OS).
  if (process.platform === 'win32' && rawPath === WINDOWS_DRIVES_PATH) {
    const entries = await Promise.all(
      Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))
        .map(async (letter) => {
          const drive = `${letter}:\\`;
          try {
            await fsReaddir(drive, { withFileTypes: true });
            return { name: drive, path: drive, isDir: true, hidden: false };
          } catch {
            return null;
          }
        }),
    );
    requestContext.send({
      type: 'fs.ls_response',
      requestId,
      path: rawPath,
      resolvedPath: WINDOWS_DRIVES_ROOT,
      status: 'ok',
      entries: entries.filter(Boolean),
    });
    return;
  }

  const canonical = await resolveCanonical(resolved, includeMetadata ? 'lenient' : 'strict');
  if (!canonical) {
    requestContext.send({ type: 'fs.ls_response', requestId, path: rawPath, status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH });
    return;
  }

  const snapshot = await getFsListSnapshot(canonical.realPath, includeFiles, includeMetadata, !canonical.usedFallback);

  requestContext.send({ type: 'fs.ls_response', requestId, path: rawPath, resolvedPath: snapshot.resolvedPath, status: 'ok', entries: snapshot.entries });
}

const REPO_CONTEXT_CACHE_TTL_MS = 5_000;

async function handleFsRead(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  getDefaultPreviewReadCoordinator().handle(cmd.path, cmd.requestId, (message) => serverLink.send(message));
}

const GIT_STATUS_CACHE_TTL_MS = 5_000;
const GIT_STATUS_STALE_CACHE_TTL_MS = 30_000;
const GIT_STATUS_CACHE_MAX_ENTRIES = 128;
const GIT_STATUS_DEADLINE_MS = 10_000;
const GIT_STATUS_INFLIGHT_FANOUT_CAP = 32;
const GIT_DIFF_CACHE_TTL_MS = 5_000;

type GitStatusFile = { path: string; code: string; additions?: number; deletions?: number };

interface RepoContext {
  repoRoot: string;
  gitDir: string;
  repoSignature: string;
}

interface RepoContextBase {
  repoRoot: string;
  gitDir: string;
}

interface RepoSignatureState {
  repoSignature: string;
  indexSig: string;
  headSig: string;
  refPath: string | null;
  refSig: string;
}

interface GitStatusSnapshot {
  repoRoot: string;
  repoSignature: string;
  files: GitStatusFile[];
}

interface GitNumstatSnapshot {
  repoRoot: string;
  repoSignature: string;
  stats: Map<string, { additions?: number; deletions?: number }>;
}

interface GitStatusResponseSnapshot {
  repoRoot: string;
  repoSignature: string;
  requestedPath: string;
  includeStats: boolean;
  files: GitStatusFile[];
}

interface GitDiffSnapshot {
  logicalPath: string;
  repoRoot: string;
  repoSignature: string;
  fileSignature: string;
  diff: string;
}

const repoContextCache = new Map<string, { expiresAt: number; value: RepoContextBase | null }>();
const repoSignatureCache = new Map<string, RepoSignatureState>();
const gitStatusCache = new Map<string, { expiresAt: number; value: GitStatusSnapshot }>();
const gitStatusInflight = new Map<string, Promise<GitStatusSnapshot>>();
const gitNumstatCache = new Map<string, { expiresAt: number; value: GitNumstatSnapshot }>();
const gitNumstatInflight = new Map<string, Promise<GitNumstatSnapshot>>();
const gitStatusResponseCache = new Map<string, FreshnessCacheEntry<GitStatusResponseSnapshot>>();
const gitStatusResponseInflight = new Map<string, InflightWork<GitStatusResponseSnapshot>>();
const gitDiffCache = new Map<string, { expiresAt: number; value: GitDiffSnapshot }>();
const gitDiffInflight = new Map<string, Promise<GitDiffSnapshot>>();
const gitRepoGenerations = new Map<string, number>();
const gitDiffGenerations = new Map<string, number>();

function normalizeFsPath(value: string): string {
  return nodePath.resolve(value);
}

function getResourceGeneration(map: Map<string, number>, key: string): number {
  return map.get(key) ?? 0;
}

function bumpResourceGeneration(map: Map<string, number>, key: string): void {
  map.set(key, getResourceGeneration(map, key) + 1);
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeFsPath(root);
  const normalizedCandidate = normalizeFsPath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + nodePath.sep);
}

async function safeStatSignature(targetPath: string): Promise<string> {
  try {
    const stats = await fsStat(targetPath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'missing';
  }
}

async function resolveGitDir(dotGitPath: string, repoRoot: string): Promise<string | null> {
  try {
    const stats = await fsStat(dotGitPath);
    if (stats.isDirectory()) return dotGitPath;
    if (!stats.isFile()) return null;
    const raw = await fsReadFileRaw(dotGitPath, 'utf8');
    const match = raw.match(/^gitdir:\s*(.+)\s*$/mi);
    if (!match?.[1]) return null;
    return nodePath.resolve(repoRoot, match[1].trim());
  } catch {
    return null;
  }
}

async function findRepoContextBase(startPath: string): Promise<RepoContextBase | null> {
  let current = normalizeFsPath(startPath);
  const traversed: string[] = [];
  const now = Date.now();
  while (true) {
    const cached = repoContextCache.get(current);
    if (cached && cached.expiresAt > now) {
      for (const traversedPath of traversed) {
        repoContextCache.set(traversedPath, { expiresAt: now + REPO_CONTEXT_CACHE_TTL_MS, value: cached.value });
      }
      return cached.value;
    }
    traversed.push(current);
    const dotGit = nodePath.join(current, '.git');
    const gitDir = await resolveGitDir(dotGit, current);
    if (gitDir) {
      const value = { repoRoot: current, gitDir };
      for (const traversedPath of traversed) {
        repoContextCache.set(traversedPath, { expiresAt: Date.now() + REPO_CONTEXT_CACHE_TTL_MS, value });
      }
      return value;
    }
    const parent = nodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const traversedPath of traversed) {
    repoContextCache.set(traversedPath, { expiresAt: Date.now() + REPO_CONTEXT_CACHE_TTL_MS, value: null });
  }
  return null;
}

async function buildRepoSignatureState(gitDir: string, indexSig?: string, headSig?: string): Promise<RepoSignatureState> {
  const resolvedIndexSig = indexSig ?? await safeStatSignature(nodePath.join(gitDir, 'index'));
  const headPath = nodePath.join(gitDir, 'HEAD');
  const resolvedHeadSig = headSig ?? await safeStatSignature(headPath);
  let refPath: string | null = null;
  let refSig = 'none';
  try {
    const headRaw = await fsReadFileRaw(headPath, 'utf8');
    const match = headRaw.match(/^ref:\s*(.+)\s*$/m);
    if (match?.[1]) {
      refPath = match[1].trim();
      refSig = await safeStatSignature(nodePath.join(gitDir, refPath));
    }
  } catch {
    refSig = 'missing';
  }
  return {
    repoSignature: `${resolvedIndexSig}|${resolvedHeadSig}|${refSig}`,
    indexSig: resolvedIndexSig,
    headSig: resolvedHeadSig,
    refPath,
    refSig,
  };
}

async function getRepoSignature(repoRoot: string, gitDir: string): Promise<string> {
  const indexSig = await safeStatSignature(nodePath.join(gitDir, 'index'));
  const headPath = nodePath.join(gitDir, 'HEAD');
  const headSig = await safeStatSignature(headPath);
  const cached = repoSignatureCache.get(repoRoot);
  if (cached && cached.indexSig === indexSig && cached.headSig === headSig) {
    if (!cached.refPath || await safeStatSignature(nodePath.join(gitDir, cached.refPath)) === cached.refSig) {
      return cached.repoSignature;
    }
  }
  const next = await buildRepoSignatureState(gitDir, indexSig, headSig);
  repoSignatureCache.set(repoRoot, next);
  return next.repoSignature;
}

async function resolveRepoContext(startPath: string): Promise<RepoContext | null> {
  const repo = await findRepoContextBase(startPath);
  if (!repo) return null;
  return {
    repoRoot: repo.repoRoot,
    gitDir: repo.gitDir,
    repoSignature: await getRepoSignature(repo.repoRoot, repo.gitDir),
  };
}

function decodeGitPath(rawPath: string): string {
  return rawPath.replace(/\\([\\\"abfnrtv])/g, (_match, escaped: string) => {
    switch (escaped) {
      case 'a': return '\u0007';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'v': return '\v';
      case '\\': return '\\';
      case '"': return '"';
      default: return escaped;
    }
  }).replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function parseZRecords(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry.length > 0);
}

function normalizeRepoRelativePath(repoRoot: string, relativePath: string): string {
  return nodePath.join(repoRoot, decodeGitPath(relativePath));
}

async function loadRepoGitStatusSnapshot(repoRoot: string, repoSignature: string): Promise<GitStatusSnapshot> {
  const { stdout } = await execAsync('git status --porcelain=v1 -z -u', { cwd: repoRoot, timeout: 5000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const files: GitStatusFile[] = [];
  const records = parseZRecords(stdout);
  for (let idx = 0; idx < records.length; idx++) {
    const record = records[idx];
    const code = record.slice(0, 2).trim();
    const firstPath = record.slice(3);
    let logicalPath = firstPath;
    if (code.startsWith('R') || code.startsWith('C')) {
      const renamedTo = records[idx + 1];
      if (renamedTo) {
        logicalPath = renamedTo;
        idx += 1;
      }
    }
    files.push({ path: normalizeRepoRelativePath(repoRoot, logicalPath), code });
  }
  return { repoRoot, repoSignature, files };
}

async function getRepoGitStatusSnapshot(startPath: string): Promise<GitStatusSnapshot | null> {
  const context = await resolveRepoContext(startPath);
  if (!context) return null;
  const cached = gitStatusCache.get(context.repoRoot);
  if (cached && cached.expiresAt > Date.now() && cached.value.repoSignature === context.repoSignature) {
    return cached.value;
  }
  const generation = getResourceGeneration(gitRepoGenerations, context.repoRoot);
  const inflightKey = `${context.repoRoot}::${context.repoSignature}::${generation}`;
  const inflight = gitStatusInflight.get(inflightKey);
  if (inflight) return await inflight;
  const promise = loadRepoGitStatusSnapshot(context.repoRoot, context.repoSignature)
    .then(async (value) => {
      const currentSignature = await getRepoSignature(context.repoRoot, context.gitDir);
      if (getResourceGeneration(gitRepoGenerations, context.repoRoot) === generation && currentSignature === value.repoSignature) {
        gitStatusCache.set(context.repoRoot, { value, expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS });
      }
      return value;
    })
    .finally(() => {
      gitStatusInflight.delete(inflightKey);
    });
  gitStatusInflight.set(inflightKey, promise);
  return await promise;
}

async function loadRepoGitNumstatSnapshot(repoRoot: string, repoSignature: string): Promise<GitNumstatSnapshot> {
  let stdout = '';
  try {
    ({ stdout } = await execAsync('git diff --numstat -z HEAD', { cwd: repoRoot, timeout: 5000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
  } catch {
    try {
      ({ stdout } = await execAsync('git diff --numstat -z', { cwd: repoRoot, timeout: 5000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
    } catch {
      stdout = '';
    }
  }
  const stats = new Map<string, { additions?: number; deletions?: number }>();
  const records = parseZRecords(stdout);
  for (let idx = 0; idx < records.length; idx++) {
    const header = records[idx];
    const firstTab = header.indexOf('\t');
    const secondTab = firstTab >= 0 ? header.indexOf('\t', firstTab + 1) : -1;
    if (firstTab < 0 || secondTab < 0) continue;
    const additionsRaw = header.slice(0, firstTab);
    const deletionsRaw = header.slice(firstTab + 1, secondTab);
    const pathRaw = header.slice(secondTab + 1);
    const additions = additionsRaw === '-' ? undefined : parseInt(additionsRaw, 10);
    const deletions = deletionsRaw === '-' ? undefined : parseInt(deletionsRaw, 10);
    let logicalPath = pathRaw;
    if (pathRaw === '') {
      const renamedTo = records[idx + 2];
      if (!renamedTo) continue;
      logicalPath = renamedTo;
      idx += 2;
    }
    stats.set(normalizeRepoRelativePath(repoRoot, logicalPath), { additions, deletions });
  }
  return { repoRoot, repoSignature, stats };
}

async function getRepoGitNumstatSnapshot(startPath: string): Promise<GitNumstatSnapshot | null> {
  const context = await resolveRepoContext(startPath);
  if (!context) return null;
  const cached = gitNumstatCache.get(context.repoRoot);
  if (cached && cached.expiresAt > Date.now() && cached.value.repoSignature === context.repoSignature) {
    return cached.value;
  }
  const generation = getResourceGeneration(gitRepoGenerations, context.repoRoot);
  const inflightKey = `${context.repoRoot}::${context.repoSignature}::${generation}`;
  const inflight = gitNumstatInflight.get(inflightKey);
  if (inflight) return await inflight;
  const promise = loadRepoGitNumstatSnapshot(context.repoRoot, context.repoSignature)
    .then(async (value) => {
      const currentSignature = await getRepoSignature(context.repoRoot, context.gitDir);
      if (getResourceGeneration(gitRepoGenerations, context.repoRoot) === generation && currentSignature === value.repoSignature) {
        gitNumstatCache.set(context.repoRoot, { value, expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS });
      }
      return value;
    })
    .finally(() => {
      gitNumstatInflight.delete(inflightKey);
    });
  gitNumstatInflight.set(inflightKey, promise);
  return await promise;
}

function getGitStatusResponseCacheKey(repoRoot: string, requestedPath: string, includeStats: boolean): string {
  return `${repoRoot}::${requestedPath}::${includeStats ? 'stats' : 'plain'}`;
}

function fsGitStatusErrorCode(error: unknown): string {
  if (error instanceof FsGitStatusPoolError) {
    if (error.reason === 'queue_full') return FS_GENERIC_ERROR_CODES.FS_LIST_WORKER_QUEUE_FULL;
    if (error.reason === 'timeout') return FS_GENERIC_ERROR_CODES.FS_LIST_WORKER_TIMEOUT;
    if (
      error.reason === 'unavailable'
      || error.reason === 'crashed'
      || error.reason === 'shutdown'
      || error.reason === 'git_unavailable'
    ) {
      return FS_GENERIC_ERROR_CODES.FS_LIST_WORKER_UNAVAILABLE;
    }
    return FS_GENERIC_ERROR_CODES.INTERNAL_ERROR;
  }
  return error instanceof Error ? error.message : String(error);
}

function canUseGitStatusStaleCache(error: unknown): boolean {
  return error instanceof FsGitStatusPoolError
    && (
      error.reason === 'queue_full'
      || error.reason === 'timeout'
      || error.reason === 'unavailable'
      || error.reason === 'crashed'
      || error.reason === 'shutdown'
      || error.reason === 'git_unavailable'
    );
}

function getCachedGitStatusResponseSnapshot(cacheKey: string, repoSignature: string, allowStale: boolean): GitStatusResponseSnapshot | null {
  const cached = gitStatusResponseCache.get(cacheKey);
  if (!cached || cached.value.repoSignature !== repoSignature) return null;
  const now = Date.now();
  const usableUntil = allowStale ? (cached.staleUntil ?? cached.expiresAt) : cached.expiresAt;
  if (usableUntil <= now) return null;
  gitStatusResponseCache.delete(cacheKey);
  gitStatusResponseCache.set(cacheKey, cached);
  return cached.value;
}

async function loadRepoGitStatusResponseSnapshot(
  context: RepoContext,
  requestedPath: string,
  includeStats: boolean,
): Promise<GitStatusResponseSnapshot> {
  if (shouldUseFsGitStatusWorkerPool()) {
    const snapshot = await getDefaultFsGitStatusWorkerPool().dispatch({
      repoRoot: context.repoRoot,
      repoSignature: context.repoSignature,
      requestedPath,
      includeStats,
    });
    return {
      repoRoot: snapshot.repoRoot,
      repoSignature: snapshot.repoSignature,
      requestedPath: snapshot.requestedPath,
      includeStats: snapshot.includeStats,
      files: snapshot.files,
    };
  }

  const [snapshot, numstat] = await Promise.all([
    loadRepoGitStatusSnapshot(context.repoRoot, context.repoSignature),
    includeStats ? loadRepoGitNumstatSnapshot(context.repoRoot, context.repoSignature) : Promise.resolve(null),
  ]);
  const files = filterRepoFilesForPath(snapshot.files, requestedPath).map((file) => {
    const stats = numstat?.stats.get(file.path);
    return stats ? { ...file, ...stats } : file;
  });
  return {
    repoRoot: context.repoRoot,
    repoSignature: context.repoSignature,
    requestedPath,
    includeStats,
    files,
  };
}

async function getRepoGitStatusResponseSnapshot(startPath: string, includeStats: boolean): Promise<GitStatusResponseSnapshot | null> {
  const context = await resolveRepoContext(startPath);
  if (!context) {
    recordFsWorkerMetric({
      commandType: 'fs.git_status',
      cacheStatus: 'not_repo',
      terminalReason: 'ok',
      queueDepth: fsGitStatusWorkerQueueDepth(),
      queueWaitMs: 0,
      workerExecutionMs: 0,
      includeStats,
    });
    return null;
  }
  const cacheKey = getGitStatusResponseCacheKey(context.repoRoot, startPath, includeStats);
  const cached = getCachedGitStatusResponseSnapshot(cacheKey, context.repoSignature, false);
  if (cached) {
    recordFsWorkerMetric({
      commandType: 'fs.git_status',
      cacheStatus: 'hit',
      terminalReason: 'ok',
      queueDepth: fsGitStatusWorkerQueueDepth(),
      queueWaitMs: 0,
      workerExecutionMs: 0,
      includeStats,
      fileCount: cached.files.length,
    });
    return cached;
  }
  const staleCached = getCachedGitStatusResponseSnapshot(cacheKey, context.repoSignature, true);
  const generation = getResourceGeneration(gitRepoGenerations, context.repoRoot);
  const inflightKey = `${cacheKey}::${context.repoSignature}::${generation}`;
  const inflight = gitStatusResponseInflight.get(inflightKey);
  if (inflight) {
    if (inflight.attached >= GIT_STATUS_INFLIGHT_FANOUT_CAP) throw new FsGitStatusPoolError('queue_full');
    inflight.attached += 1;
    recordFsWorkerMetric({
      commandType: 'fs.git_status',
      cacheStatus: 'inflight',
      terminalReason: 'ok',
      queueDepth: fsGitStatusWorkerQueueDepth(),
      queueWaitMs: 0,
      workerExecutionMs: 0,
      attached: inflight.attached,
      includeStats,
    });
    return await inflight.promise;
  }
  const workerStartedAt = Date.now();
  const queueDepthAtDispatch = fsGitStatusWorkerQueueDepth();
  const promise = loadRepoGitStatusResponseSnapshot(context, startPath, includeStats)
    .then(async (value) => {
      const currentSignature = await getRepoSignature(context.repoRoot, context.gitDir);
      if (
        getResourceGeneration(gitRepoGenerations, context.repoRoot) === generation
        && currentSignature === value.repoSignature
      ) {
        setBoundedCache(
          gitStatusResponseCache,
          cacheKey,
          {
            value,
            expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS,
            staleUntil: Date.now() + GIT_STATUS_STALE_CACHE_TTL_MS,
          },
          GIT_STATUS_CACHE_MAX_ENTRIES,
        );
      }
      recordFsWorkerMetric({
        commandType: 'fs.git_status',
        cacheStatus: 'miss',
        terminalReason: 'ok',
        queueDepth: queueDepthAtDispatch,
        queueWaitMs: 0,
        workerExecutionMs: Date.now() - workerStartedAt,
        includeStats,
        fileCount: value.files.length,
      });
      return value;
    })
    .catch((error) => {
      const terminalReason = fsGitStatusErrorCode(error);
      if (staleCached && canUseGitStatusStaleCache(error)) {
        recordFsWorkerMetric({
          commandType: 'fs.git_status',
          cacheStatus: 'stale',
          terminalReason,
          queueDepth: queueDepthAtDispatch,
          queueWaitMs: 0,
          workerExecutionMs: Date.now() - workerStartedAt,
          lateResultSkip: true,
          includeStats,
          fileCount: staleCached.files.length,
        });
        return staleCached;
      }
      recordFsWorkerMetric({
        commandType: 'fs.git_status',
        cacheStatus: 'miss',
        terminalReason,
        queueDepth: queueDepthAtDispatch,
        queueWaitMs: 0,
        workerExecutionMs: Date.now() - workerStartedAt,
        includeStats,
      });
      throw error;
    })
    .finally(() => {
      gitStatusResponseInflight.delete(inflightKey);
    });
  gitStatusResponseInflight.set(inflightKey, { promise, attached: 1 });
  return await promise;
}

async function loadFileGitDiffSnapshot(logicalPath: string, repoRoot: string, repoSignature: string, fileSignature: string): Promise<GitDiffSnapshot> {
  let diff = '';
  const repoRelativePath = nodePath.relative(repoRoot, logicalPath).split(nodePath.sep).join('/');
  try {
    const { stdout } = await execFileAsync('git', ['diff', 'HEAD', '--', repoRelativePath], { cwd: repoRoot, timeout: 5000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    diff = stdout;
  } catch { /* ignore */ }
  if (!diff) {
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--', repoRelativePath], { cwd: repoRoot, timeout: 5000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      diff = stdout;
    } catch { /* ignore */ }
  }
  return { logicalPath, repoRoot, repoSignature, fileSignature, diff };
}

async function getFileGitDiffSnapshot(logicalPath: string): Promise<GitDiffSnapshot | null> {
  const context = await resolveRepoContext(nodePath.dirname(logicalPath));
  if (!context) return null;
  const fileSignature = await safeStatSignature(logicalPath);
  const cached = gitDiffCache.get(logicalPath);
  if (
    cached
    && cached.expiresAt > Date.now()
    && cached.value.repoSignature === context.repoSignature
    && cached.value.fileSignature === fileSignature
  ) {
    return cached.value;
  }
  const generation = getResourceGeneration(gitDiffGenerations, logicalPath);
  const inflightKey = `${logicalPath}::${context.repoSignature}::${fileSignature}::${generation}`;
  const inflight = gitDiffInflight.get(inflightKey);
  if (inflight) return await inflight;
  const promise = loadFileGitDiffSnapshot(logicalPath, context.repoRoot, context.repoSignature, fileSignature)
    .then(async (value) => {
      const currentContext = await resolveRepoContext(nodePath.dirname(logicalPath));
      const currentFileSignature = await safeStatSignature(logicalPath);
      if (
        getResourceGeneration(gitDiffGenerations, logicalPath) === generation
        && currentContext
        && currentContext.repoSignature === value.repoSignature
        && currentFileSignature === value.fileSignature
      ) {
        gitDiffCache.set(logicalPath, { value, expiresAt: Date.now() + GIT_DIFF_CACHE_TTL_MS });
      }
      return value;
    })
    .finally(() => {
      gitDiffInflight.delete(inflightKey);
    });
  gitDiffInflight.set(inflightKey, promise);
  return await promise;
}

function collectAffectedRepoRoots(targetPath: string): Set<string> {
  const affected = new Set<string>();
  for (const key of gitStatusCache.keys()) {
    if (isPathInside(key, targetPath)) affected.add(key);
  }
  for (const key of gitNumstatCache.keys()) {
    if (isPathInside(key, targetPath)) affected.add(key);
  }
  for (const key of gitStatusInflight.keys()) {
    const repoRoot = key.split('::')[0] ?? '';
    if (repoRoot && isPathInside(repoRoot, targetPath)) affected.add(repoRoot);
  }
  for (const key of gitNumstatInflight.keys()) {
    const repoRoot = key.split('::')[0] ?? '';
    if (repoRoot && isPathInside(repoRoot, targetPath)) affected.add(repoRoot);
  }
  for (const entry of gitStatusResponseCache.values()) {
    if (isPathInside(entry.value.repoRoot, targetPath)) affected.add(entry.value.repoRoot);
  }
  for (const key of gitStatusResponseInflight.keys()) {
    const repoRoot = key.split('::')[0] ?? '';
    if (repoRoot && isPathInside(repoRoot, targetPath)) affected.add(repoRoot);
  }
  for (const entry of repoContextCache.values()) {
    const repoRoot = entry.value?.repoRoot;
    if (repoRoot && isPathInside(repoRoot, targetPath)) affected.add(repoRoot);
  }
  return affected;
}

function invalidateGitCachesForPath(targetPath: string): void {
  const normalized = normalizeFsPath(targetPath);
  getDefaultPreviewReadCoordinator().invalidate(normalized);
  bumpResourceGeneration(gitDiffGenerations, normalized);
  for (const repoRoot of collectAffectedRepoRoots(normalized)) {
    bumpResourceGeneration(gitRepoGenerations, repoRoot);
  }
  gitDiffCache.delete(normalized);
  for (const key of gitDiffInflight.keys()) {
    if (key.startsWith(`${normalized}::`)) gitDiffInflight.delete(key);
  }
  for (const key of gitStatusCache.keys()) {
    if (isPathInside(key, normalized)) gitStatusCache.delete(key);
    if (isPathInside(key, normalized)) repoSignatureCache.delete(key);
  }
  for (const key of repoContextCache.keys()) {
    if (isPathInside(key, normalized)) repoContextCache.delete(key);
  }
  for (const key of gitNumstatCache.keys()) {
    if (isPathInside(key, normalized)) gitNumstatCache.delete(key);
    if (isPathInside(key, normalized)) repoSignatureCache.delete(key);
  }
  for (const [key, entry] of gitStatusResponseCache) {
    if (isPathInside(entry.value.repoRoot, normalized)) gitStatusResponseCache.delete(key);
  }
  for (const key of gitStatusInflight.keys()) {
    if (isPathInside(key.split('::')[0] ?? '', normalized)) gitStatusInflight.delete(key);
  }
  for (const key of gitNumstatInflight.keys()) {
    if (isPathInside(key.split('::')[0] ?? '', normalized)) gitNumstatInflight.delete(key);
  }
  for (const key of gitStatusResponseInflight.keys()) {
    if (isPathInside(key.split('::')[0] ?? '', normalized)) gitStatusResponseInflight.delete(key);
  }
}

export function __resetFsGitCachesForTests(): void {
  void __resetPreviewReadCoordinatorForTests();
  fsListCache.clear();
  fsListInflight.clear();
  fsListGenerations.clear();
  fileSearchCache.clear();
  fileSearchInflight.clear();
  fileSearchGenerations.clear();
  repoContextCache.clear();
  repoSignatureCache.clear();
  gitStatusCache.clear();
  gitStatusInflight.clear();
  gitNumstatCache.clear();
  gitNumstatInflight.clear();
  gitStatusResponseCache.clear();
  gitStatusResponseInflight.clear();
  gitDiffCache.clear();
  gitDiffInflight.clear();
  gitRepoGenerations.clear();
  gitDiffGenerations.clear();
  __resetFsGitStatusWorkerPoolForTests();
}

function filterRepoFilesForPath(files: GitStatusFile[], requestedPath: string): GitStatusFile[] {
  return files.filter((file) => isPathInside(requestedPath, file.path));
}

/** fs.git_status — return git modified file list for a directory */
async function handleFsGitStatus(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawPath = cmd.path as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  const includeStats = cmd.includeStats === true;
  if (!rawPath || !requestId) return;

  const expanded = rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath;
  const resolved = nodePath.resolve(expanded);
  const requestContext = createFsListRequestContext(serverLink);

  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new FsGitStatusPoolError('timeout')), GIT_STATUS_DEADLINE_MS);
    deadlineTimer.unref?.();
  });
  try {
    await Promise.race([handleFsGitStatusInner(resolved, rawPath, requestId, includeStats, requestContext), deadline]);
  } catch (err) {
    const msg = fsGitStatusErrorCode(err);
    if (msg === FS_GENERIC_ERROR_CODES.FS_LIST_WORKER_TIMEOUT) {
      invalidateGitCachesForPath(resolved);
    }
    // git not available or not a repo — return empty ok (not an error for the UI)
    const isNotRepo = msg.includes('not a git repository') || msg.includes('128');
    requestContext.send({ type: 'fs.git_status_response', requestId, path: rawPath, status: isNotRepo ? 'ok' : 'error', files: [], error: isNotRepo ? undefined : msg });
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    requestContext.markTerminal();
  }
}

async function handleFsGitStatusInner(
  resolved: string,
  rawPath: string,
  requestId: string,
  includeStats: boolean,
  requestContext: FsListRequestContext,
): Promise<void> {
  const real = await fsRealpath(resolved);
  const allowed = isPathAllowed(real);
  if (!allowed) {
    requestContext.send({ type: 'fs.git_status_response', requestId, path: rawPath, status: 'error', error: FS_READ_ERROR_CODES.FORBIDDEN_PATH });
    return;
  }
  const snapshot = await getRepoGitStatusResponseSnapshot(real, includeStats);
  requestContext.send({
    type: 'fs.git_status_response',
    requestId,
    path: rawPath,
    resolvedPath: real,
    status: 'ok',
    files: snapshot?.files ?? [],
  });
}

/** fs.git_diff — return git diff for a specific file */
async function handleFsGitDiff(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawPath = cmd.path as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  if (!rawPath || !requestId) return;

  const expanded = rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath;
  const resolved = nodePath.resolve(expanded);

  try {
    let allowedProbe = resolved;
    while (true) {
      try {
        allowedProbe = await fsRealpath(allowedProbe);
        break;
      } catch {
        const parent = nodePath.dirname(allowedProbe);
        if (parent === allowedProbe) throw new Error(`ENOENT: no such file or directory, realpath '${resolved}'`);
        allowedProbe = parent;
      }
    }
    const allowed = isPathAllowed(allowedProbe);
    if (!allowed) {
      try { serverLink.send({ type: 'fs.git_diff_response', requestId, path: rawPath, status: 'error', error: FS_READ_ERROR_CODES.FORBIDDEN_PATH }); } catch { /* ignore */ }
      return;
    }
    const snapshot = await getFileGitDiffSnapshot(resolved);
    const diff = snapshot?.diff ?? '';
    // Untracked files: no diff (nothing meaningful to compare against)
    try { serverLink.send({ type: 'fs.git_diff_response', requestId, path: rawPath, resolvedPath: resolved, status: 'ok', diff }); } catch { /* ignore */ }
  } catch (err) {
    try { serverLink.send({ type: 'fs.git_diff_response', requestId, path: rawPath, status: 'error', error: err instanceof Error ? err.message : String(err) }); } catch { /* ignore */ }
  }
}

/** fs.mkdir — create a directory */
async function handleFsMkdir(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawPath = cmd.path as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  if (!rawPath || !requestId) return;

  const expanded = rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath;
  const resolved = nodePath.resolve(expanded);

  // Check parent directory is in allowed roots
  const parent = nodePath.dirname(resolved);
  try {
    const realParent = await fsRealpath(parent);
    const allowed = isPathAllowed(realParent);
    if (!allowed) {
      try { serverLink.send({ type: 'fs.mkdir_response', requestId, path: rawPath, status: 'error', error: FS_READ_ERROR_CODES.FORBIDDEN_PATH }); } catch { /* ignore */ }
      return;
    }
  } catch {
    try { serverLink.send({ type: 'fs.mkdir_response', requestId, path: rawPath, status: 'error', error: FS_GENERIC_ERROR_CODES.PARENT_NOT_FOUND }); } catch { /* ignore */ }
    return;
  }

  try {
    const { mkdir } = await import('fs/promises');
    await mkdir(resolved, { recursive: true });
    const real = await fsRealpath(resolved);
    invalidateFsListCachesForPath(real);
    invalidateFileSearchCachesForPath(real);
    try { serverLink.send({ type: 'fs.mkdir_response', requestId, path: rawPath, resolvedPath: real, status: 'ok' }); } catch { /* ignore */ }
  } catch (err) {
    try { serverLink.send({ type: 'fs.mkdir_response', requestId, path: rawPath, status: 'error', error: err instanceof Error ? err.message : String(err) }); } catch { /* ignore */ }
  }
}

/** fs.write — write a file (with optional mtime conflict detection) */
function getFsWriteErrorCode(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'EEXIST' || message.includes('EEXIST') || message.includes('file already exists')) return FS_WRITE_ERROR.FILE_EXISTS;
  if (code === 'ENOENT' || code === 'ENOTDIR' || message.includes('ENOENT') || message.includes('no such file')) return FS_GENERIC_ERROR_CODES.PARENT_NOT_FOUND;
  return FS_GENERIC_ERROR_CODES.INTERNAL_ERROR;
}

async function handleFsWrite(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawPath = cmd.path as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  const content = cmd.content as string | undefined;
  if (!rawPath || !requestId || content === undefined) {
    if (requestId) {
      try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath ?? '', status: 'error', error: FS_GENERIC_ERROR_CODES.INVALID_REQUEST }); } catch { /* ignore */ }
    }
    return;
  }

  const expectedMtime = typeof cmd.expectedMtime === 'number' ? cmd.expectedMtime : undefined;
  const createOnly = cmd.createOnly === true;

  const expanded = rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath;
  const resolved = nodePath.resolve(expanded);

  // Size check first (cheap, before any I/O)
  if (Buffer.byteLength(content, 'utf-8') > 1_048_576) {
    try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, status: 'error', error: FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE }); } catch { /* ignore */ }
    return;
  }

  // Determine if file exists to choose sandbox validation strategy
  let fileExists = false;
  try {
    await fsStat(resolved);
    fileExists = true;
  } catch {
    fileExists = false;
  }

  if (fileExists) {
    // Existing file: realpath of target must be within FS_ALLOWED_ROOTS
    try {
      const real = await fsRealpath(resolved);
      const allowed = isPathAllowed(real);
      if (!allowed) {
        try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, resolvedPath: real, status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH }); } catch { /* ignore */ }
        return;
      }

      if (createOnly) {
        try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, resolvedPath: real, status: 'error', error: FS_WRITE_ERROR.FILE_EXISTS }); } catch { /* ignore */ }
        return;
      }

      // mtime conflict check
      if (expectedMtime !== undefined) {
        const stats = await fsStat(real);
        if (stats.mtimeMs !== expectedMtime) {
          // Read disk content (capped at 1MB)
          let diskContent: string | undefined;
          try {
            const diskBuf = await fsReadFileRaw(real, 'utf-8');
            diskContent = Buffer.byteLength(diskBuf, 'utf-8') > 1_048_576
              ? diskBuf.slice(0, 1_048_576)
              : diskBuf;
          } catch { /* ignore read errors for conflict content */ }
          try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, resolvedPath: real, status: 'conflict', diskContent, diskMtime: stats.mtimeMs }); } catch { /* ignore */ }
          return;
        }
      }

      // Write the file
      await fsWriteFile(real, content, 'utf-8');
      const newStats = await fsStat(real);
      invalidateFsListCachesForPath(real);
      invalidateFileSearchCachesForPath(real);
      invalidateGitCachesForPath(real);
      try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, resolvedPath: real, status: 'ok', mtime: newStats.mtimeMs }); } catch { /* ignore */ }
    } catch (err) {
      logger.warn({ requestId, errorCode: getFsWriteErrorCode(err) }, 'fs.write failed');
      try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, status: 'error', error: getFsWriteErrorCode(err) }); } catch { /* ignore */ }
    }
  } else {
    // New file: realpath of parent must be within FS_ALLOWED_ROOTS
    const parent = nodePath.dirname(resolved);
    try {
      const realParent = await fsRealpath(parent);
      const allowed = isPathAllowed(realParent);
      if (!allowed) {
        try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH }); } catch { /* ignore */ }
        return;
      }
      try {
        const targetStats = await fsLstat(resolved);
        const error = targetStats.isSymbolicLink() ? FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH : FS_WRITE_ERROR.FILE_EXISTS;
        try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, status: 'error', error }); } catch { /* ignore */ }
        return;
      } catch (err) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
        if (code !== 'ENOENT') throw err;
      }
      // Write the file
      await fsWriteFile(resolved, content, { encoding: 'utf-8', flag: 'wx' });
      const newStats = await fsStat(resolved);
      const real = await fsRealpath(resolved);
      invalidateFsListCachesForPath(real);
      invalidateFileSearchCachesForPath(real);
      invalidateGitCachesForPath(real);
      try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, resolvedPath: real, status: 'ok', mtime: newStats.mtimeMs }); } catch { /* ignore */ }
    } catch (err) {
      const errorCode = getFsWriteErrorCode(err);
      logger.warn({ requestId, errorCode }, 'fs.write failed');
      try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, status: 'error', error: errorCode }); } catch { /* ignore */ }
    }
  }
}

/** server.delete — remove credentials + service, then exit */
async function handleServerDelete(): Promise<void> {
  const { homedir } = await import('os');
  const { join } = await import('path');
  const { unlink, access } = await import('fs/promises');
  const { execSync } = await import('child_process');

  logger.info('server.delete received — self-destructing daemon');

  const credsPath = join(homedir(), '.imcodes', 'server.json');
  try { await unlink(credsPath); } catch { /* already gone */ }

  // Uninstall system service so daemon doesn't restart
  if (process.platform === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'imcodes.daemon.plist');
    try {
      await access(plistPath);
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'ignore' });
      await unlink(plistPath);
    } catch { /* not installed or already removed */ }
  } else if (process.platform === 'linux') {
    try {
      execSync('systemctl --user disable --now imcodes 2>/dev/null', { stdio: 'ignore' });
    } catch { /* not installed */ }
  }

  logger.info('Daemon unbound — exiting');
  // Give the log a moment to flush before exiting
  setTimeout(() => process.exit(0), 500);
}

// ── Transport chat history replay ─────────────────────────────────────────────

async function handleTransportApprovalResponse(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionId = typeof cmd.sessionId === 'string' ? cmd.sessionId : undefined;
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  const approved = typeof cmd.approved === 'boolean' ? cmd.approved : undefined;
  if (!sessionId || !requestId || approved === undefined) return;
  const runtime = getTransportRuntime(sessionId);
  if (!runtime) return;
  try {
    await runtime.respondApproval(requestId, approved);
    try {
      serverLink.send({
        type: TRANSPORT_MSG.APPROVAL_RESPONSE,
        sessionId,
        requestId,
        approved,
      });
    } catch {
      // ignore — daemon link disconnected
    }
  } catch (err) {
    logger.warn({ err, sessionId, requestId }, 'transport approval response failed');
  }
}

async function handleChatSubscribeReplay(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionId = cmd.sessionId as string | undefined;
  if (!sessionId) return;
  try {
    const { replayTransportHistory, trimTransportHistoryEventsToReplayBudget } = await import('./transport-history.js');
    const events = trimTransportHistoryEventsToReplayBudget(sessionId, await replayTransportHistory(sessionId));
    if (events.length === 0) return;
    // Send history as a batch so the browser can render them before live events
    serverLink.send({ type: TRANSPORT_MSG.CHAT_HISTORY, sessionId, events });
    logger.debug({ sessionId, count: events.length }, 'Replayed transport chat history');
  } catch (err) {
    logger.debug({ sessionId, err }, 'Transport history replay failed');
  }
}

/** Handle provider.list_sessions — list remote sessions from a provider, materialize + respond. */
async function handleListProviderSessions(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const providerId = (cmd.providerId as string) || 'openclaw';
  try {
    // Materialize any new sessions (side-effectful — creates sessions/sub-sessions)
    if (providerId === 'openclaw') {
      const { syncOcSessions } = await import('./oc-session-sync.js');
      await syncOcSessions(serverLink).catch((e) => logger.warn({ err: e }, 'OC sync during refresh failed'));
    }
    const sessions = await listProviderSessions(providerId);
    // Send via sync_sessions — bridge handles this type: caches, persists to DB, and broadcasts to browsers
    serverLink.send({ type: 'provider.sync_sessions', providerId, sessions });
  } catch (err) {
    logger.warn({ err, providerId }, 'Failed to list provider sessions');
    serverLink.send({ type: 'provider.sync_sessions', providerId, sessions: [] });
  }
}

async function handleTransportListModels(
  cmd: Record<string, unknown>,
  serverLink: ServerLink,
): Promise<void> {
  const agentType = typeof cmd.agentType === 'string' ? cmd.agentType : '';
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  const force = cmd.force === true;
  const reply = (payload: {
    models: Array<{ id: string; name?: string; supportsReasoningEffort?: boolean }>;
    defaultModel?: string;
    isAuthenticated?: boolean;
    error?: string;
  }): void => {
    try {
      serverLink.send({
        type: 'transport.models_response',
        agentType,
        ...(requestId ? { requestId } : {}),
        ...payload,
      });
    } catch { /* not connected */ }
  };
  try {
    const result = await getTransportListModels(cmd, agentType, force);
    reply(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, agentType }, 'transport.list_models failed');
    reply({ models: [], error: message });
  }
}

const TRANSPORT_LIST_MODELS_DEFAULT_TTL_MS = 5_000;
const TRANSPORT_LIST_MODELS_MAX_TTL_MS = 60_000;
const TRANSPORT_LIST_MODELS_TTL_ENV = 'IMCODES_TRANSPORT_LIST_MODELS_CACHE_TTL_MS';

type TransportListModelsResult = {
  models: Array<{ id: string; name?: string; supportsReasoningEffort?: boolean }>;
  defaultModel?: string;
  isAuthenticated?: boolean;
  error?: string;
};

const transportListModelsCache = new Map<string, { expiresAt: number; generation: number; value: TransportListModelsResult }>();
const transportListModelsInflight = new Map<string, { generation: number; promise: Promise<TransportListModelsResult> }>();
let transportListModelsCacheGeneration = 0;

function resolveTransportListModelsCacheTtlMs(): number {
  const raw = process.env[TRANSPORT_LIST_MODELS_TTL_ENV];
  if (raw === undefined || raw.trim() === '') return TRANSPORT_LIST_MODELS_DEFAULT_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return TRANSPORT_LIST_MODELS_DEFAULT_TTL_MS;
  return Math.min(Math.trunc(parsed), TRANSPORT_LIST_MODELS_MAX_TTL_MS);
}

function transportListModelsCacheKey(cmd: Record<string, unknown>, agentType: string): string {
  const provider = typeof cmd.provider === 'string'
    ? cmd.provider
    : typeof cmd.providerId === 'string'
      ? cmd.providerId
      : '';
  return `${agentType}\0${provider}`;
}

async function loadTransportListModels(agentType: string, force: boolean): Promise<TransportListModelsResult> {
  const { getProvider, ensureProviderConnected } = await import('../agent/provider-registry.js');
  let provider = getProvider(agentType);

  // Auto-connect local providers if missing, so we can probe for models
  if (!provider && (agentType === 'gemini-sdk' || agentType === 'kimi-sdk' || agentType === 'claude-code-sdk' || agentType === 'codex-sdk' || agentType === 'copilot-sdk' || agentType === 'cursor-headless')) {
    try {
      provider = await ensureProviderConnected(agentType, {});
    } catch (err) {
      logger.debug({ provider: agentType, err }, 'Auto-connect for model listing failed');
    }
  }

  if (provider && typeof provider.listModels === 'function') {
    return await provider.listModels(force);
  }
  return { models: [], error: `Unsupported agentType: ${agentType || '(missing)'}` };
}

async function getTransportListModels(
  cmd: Record<string, unknown>,
  agentType: string,
  force: boolean,
): Promise<TransportListModelsResult> {
  const cacheKey = transportListModelsCacheKey(cmd, agentType);
  const now = Date.now();
  const ttlMs = resolveTransportListModelsCacheTtlMs();
  const generation = transportListModelsCacheGeneration;
  if (!force && ttlMs > 0) {
    const cached = transportListModelsCache.get(cacheKey);
    if (cached && cached.generation === generation && cached.expiresAt > now) return cached.value;
  }

  const inflightKey = `${cacheKey}\0${force ? 'force' : 'normal'}`;
  const inflight = transportListModelsInflight.get(inflightKey);
  if (inflight && inflight.generation === generation) return await inflight.promise;

  const promise = loadTransportListModels(agentType, force)
    .then((value) => {
      if (transportListModelsCacheGeneration !== generation) {
        recordTransportListModelsStaleCompletion({
          agentType,
          cacheKey,
          force,
          startedGeneration: generation,
          currentGeneration: transportListModelsCacheGeneration,
          result: value.error ? 'error' : 'ok',
        });
        return value;
      }
      if (ttlMs > 0 && !value.error) {
        transportListModelsCache.set(cacheKey, { value, expiresAt: Date.now() + ttlMs, generation });
      } else {
        transportListModelsCache.delete(cacheKey);
      }
      return value;
    })
    .finally(() => {
      const current = transportListModelsInflight.get(inflightKey);
      if (current?.promise === promise) transportListModelsInflight.delete(inflightKey);
    });
  transportListModelsInflight.set(inflightKey, { generation, promise });
  return await promise;
}

export function __resetTransportListModelsCacheForTests(): void {
  transportListModelsCache.clear();
  transportListModelsInflight.clear();
  transportListModelsCacheGeneration = 0;
}

function invalidateTransportListModelsCache(reason: string): void {
  transportListModelsCacheGeneration += 1;
  transportListModelsCache.clear();
  recordTransportListModelsStaleCompletion({
    reason,
    currentGeneration: transportListModelsCacheGeneration,
    result: 'invalidated',
  });
}

export function __invalidateTransportListModelsCacheForTests(reason = 'test'): void {
  invalidateTransportListModelsCache(reason);
}

export function __resolveTransportListModelsCacheTtlMsForTests(): number {
  return resolveTransportListModelsCacheTtlMs();
}

// ── File search tiebreakers for fzf (exported for unit testing) ──────────────

type FzfEntry = { item: string; positions: Set<number> };

/** Tiebreaker: prefer matches in the basename (filename) over directory path. */
export function fileSearchByBasenamePrefix(a: FzfEntry, b: FzfEntry): number {
  const getBasenameStart = (p: string) => {
    const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
    return Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1;
  };
  const aDiff = Math.min(...a.positions) - getBasenameStart(a.item);
  const bDiff = Math.min(...b.positions) - getBasenameStart(b.item);
  const aIsFilename = aDiff >= 0;
  const bIsFilename = bDiff >= 0;
  if (aIsFilename && !bIsFilename) return -1;
  if (!aIsFilename && bIsFilename) return 1;
  if (aIsFilename && bIsFilename) return aDiff - bDiff;
  return 0;
}

/** Tiebreaker: prefer matches closer to the end of the path. */
export function fileSearchByMatchPosFromEnd(a: FzfEntry, b: FzfEntry): number {
  const maxPosA = Math.max(-1, ...a.positions);
  const maxPosB = Math.max(-1, ...b.positions);
  return (a.item.length - maxPosA) - (b.item.length - maxPosB);
}

/** Tiebreaker: prefer shorter paths. */
export function fileSearchByLengthAsc(a: FzfEntry, b: FzfEntry): number {
  return a.item.length - b.item.length;
}

/** Reusable: fetch remote sessions from a provider. */
export async function listProviderSessions(providerId: string): Promise<Array<{ key: string; displayName?: string; agentId?: string; updatedAt?: number; percentUsed?: number }>> {
  return listProviderSessionsImpl(providerId);
}

// ── CC env presets ────────────────────────────────────────────────────────

async function handleCcPresetsList(serverLink: ServerLink): Promise<void> {
  const { loadPresets } = await import('./cc-presets.js');
  const presets = await loadPresets();
  serverLink.send({ type: CC_PRESET_MSG.LIST_RESPONSE, presets });
}

async function handleCcPresetsSave(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  const presets = Array.isArray(cmd.presets) ? cmd.presets as CcPreset[] : undefined;
  if (!presets) {
    serverLink.send({
      type: CC_PRESET_MSG.SAVE_RESPONSE,
      ...(requestId ? { requestId } : {}),
      ok: false,
      error: 'presets is required',
    });
    return;
  }
  const { savePresets } = await import('./cc-presets.js');
  try {
    await savePresets(presets);
    serverLink.send({ type: CC_PRESET_MSG.SAVE_RESPONSE, ...(requestId ? { requestId } : {}), ok: true });
  } catch (err) {
    logger.error({ err }, 'Failed to save CC presets');
    serverLink.send({
      type: CC_PRESET_MSG.SAVE_RESPONSE,
      ...(requestId ? { requestId } : {}),
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleCcPresetsDiscoverModels(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  const presetName = typeof cmd.presetName === 'string' ? cmd.presetName.trim() : '';
  if (!presetName) {
    serverLink.send({
      type: CC_PRESET_MSG.DISCOVER_MODELS_RESPONSE,
      ...(requestId ? { requestId } : {}),
      presetName,
      ok: false,
      error: 'presetName is required',
    });
    return;
  }

  const { discoverPresetModels, loadPresets, savePresets, getPreset } = await import('./cc-presets.js');
  const preset = await getPreset(presetName);
  if (!preset) {
    serverLink.send({
      type: CC_PRESET_MSG.DISCOVER_MODELS_RESPONSE,
      ...(requestId ? { requestId } : {}),
      presetName,
      ok: false,
      error: `Preset "${presetName}" not found`,
    });
    return;
  }

  const normalizedName = normalizeCcPresetName(preset.name);
  try {
    const discovered = await discoverPresetModels(preset);
    const latestPresets = await loadPresets();
    const latestPreset = latestPresets.find((item) => normalizeCcPresetName(item.name) === normalizedName) ?? preset;
    const updatedPreset: CcPreset = {
      ...latestPreset,
      transportMode: latestPreset.transportMode ?? 'qwen-compatible-api',
      authType: latestPreset.authType ?? 'anthropic',
      availableModels: discovered.availableModels,
      ...(discovered.defaultModel ? { defaultModel: discovered.defaultModel } : {}),
      lastDiscoveredAt: Date.now(),
      modelDiscoveryError: undefined,
    };
    await savePresets(latestPresets.map((item) => (
      normalizeCcPresetName(item.name) === normalizedName ? updatedPreset : item
    )));
    serverLink.send({
      type: CC_PRESET_MSG.DISCOVER_MODELS_RESPONSE,
      ...(requestId ? { requestId } : {}),
      presetName: updatedPreset.name,
      ok: true,
      preset: updatedPreset,
      models: discovered.availableModels,
      endpoint: discovered.endpoint,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const latestPresets = await loadPresets();
    const latestPreset = latestPresets.find((item) => normalizeCcPresetName(item.name) === normalizedName) ?? preset;
    const updatedPreset: CcPreset = {
      ...latestPreset,
      modelDiscoveryError: message,
    };
    await savePresets(latestPresets.map((item) => (
      normalizeCcPresetName(item.name) === normalizedName ? updatedPreset : item
    )));
    serverLink.send({
      type: CC_PRESET_MSG.DISCOVER_MODELS_RESPONSE,
      ...(requestId ? { requestId } : {}),
      presetName: updatedPreset.name,
      ok: false,
      error: message,
      preset: updatedPreset,
    });
  }
}

async function handleSharedContextRuntimeConfigApply(cmd: Record<string, unknown>): Promise<void> {
  const config = cmd.config as Record<string, unknown> | undefined;
  const normalized = normalizeSharedContextRuntimeConfig({
    primaryContextBackend: normalizeSharedContextRuntimeBackend(
      typeof config?.primaryContextBackend === 'string' ? config.primaryContextBackend : undefined,
    ),
    primaryContextModel: typeof config?.primaryContextModel === 'string' ? config.primaryContextModel : undefined,
    primaryContextPreset: typeof config?.primaryContextPreset === 'string' ? config.primaryContextPreset : undefined,
    backupContextBackend: normalizeSharedContextRuntimeBackend(
      typeof config?.backupContextBackend === 'string' ? config.backupContextBackend : undefined,
    ),
    backupContextModel: typeof config?.backupContextModel === 'string' ? config.backupContextModel : undefined,
    backupContextPreset: typeof config?.backupContextPreset === 'string' ? config.backupContextPreset : undefined,
    memoryRecallMinScore: typeof config?.memoryRecallMinScore === 'number' ? config.memoryRecallMinScore : undefined,
    memoryScoringWeights: config?.memoryScoringWeights && typeof config.memoryScoringWeights === 'object'
      ? {
          similarity: typeof (config.memoryScoringWeights as Record<string, unknown>).similarity === 'number' ? (config.memoryScoringWeights as Record<string, unknown>).similarity as number : undefined,
          recency: typeof (config.memoryScoringWeights as Record<string, unknown>).recency === 'number' ? (config.memoryScoringWeights as Record<string, unknown>).recency as number : undefined,
          frequency: typeof (config.memoryScoringWeights as Record<string, unknown>).frequency === 'number' ? (config.memoryScoringWeights as Record<string, unknown>).frequency as number : undefined,
          project: typeof (config.memoryScoringWeights as Record<string, unknown>).project === 'number' ? (config.memoryScoringWeights as Record<string, unknown>).project as number : undefined,
        }
      : undefined,
    enablePersonalMemorySync: config?.enablePersonalMemorySync === true,
  });
  if (!normalized.primaryContextBackend || !normalized.primaryContextModel) {
    logger.warn({ cmd }, 'invalid shared-context runtime config apply command');
    return;
  }
  const { getContextModelConfig, setContextModelRuntimeConfig } = await import('../context/context-model-config.js');
  const wasSyncEnabled = getContextModelConfig().enablePersonalMemorySync === true;
  setContextModelRuntimeConfig(normalized);
  // If personal sync was just turned ON, re-queue all projections to ensure
  // any that were previously "replicated" while sync was off get sent.
  if (normalized.enablePersonalMemorySync && !wasSyncEnabled) {
    const { requeueAllForReplication } = await import('../context/processed-context-replication.js');
    requeueAllForReplication();
  }
}

function handleMemoryFeatureConfigApply(cmd: Record<string, unknown>): void {
  const nextFlags = sanitizeMemoryFeatureFlagValues(cmd.flags);
  const previous = getRuntimeMemoryFeatureFlagValues() ?? {};
  setRuntimeMemoryFeatureFlagValues(nextFlags);
  if (
    previous[MEMORY_FEATURE_FLAGS_BY_NAME.skills] !== nextFlags[MEMORY_FEATURE_FLAGS_BY_NAME.skills]
    || previous[MEMORY_FEATURE_FLAGS_BY_NAME.skillAutoCreation] !== nextFlags[MEMORY_FEATURE_FLAGS_BY_NAME.skillAutoCreation]
  ) {
    publishRuntimeMemoryCacheInvalidation({ kind: 'skill_registry' });
  }
}

async function handlePersonalMemoryQuery(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  if (!requestId) return;
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({
      type: MEMORY_WS.PERSONAL_RESPONSE,
      requestId,
      stats: emptyMemoryStatsView(),
      records: [],
      pendingRecords: [],
      ...memoryManagementContextError(),
    });
    return;
  }
  const projectId = commandCanonicalRepoId(cmd) || commandString(cmd, 'projectId');
  const ownerUserId = ctx.userId;
  const projectionClass = cmd.projectionClass === 'recent_summary' || cmd.projectionClass === 'durable_memory_candidate' || cmd.projectionClass === 'master_summary'
    ? cmd.projectionClass
    : undefined;
  const query = typeof cmd.query === 'string' ? cmd.query.trim() : '';
  const limit = Math.max(1, Math.min(100, typeof cmd.limit === 'number' ? cmd.limit : 20));
  const includeArchived = cmd.includeArchived === true;
  const baseStats = getProcessedProjectionStats({
    scope: 'personal',
    userId: ownerUserId,
    includeLegacyPersonalOwner: true,
    projectId: projectId || undefined,
    projectionClass,
    includeArchived,
  });

  let records: Array<{
    id: string;
    scope: 'personal';
    projectId: string;
    ownerUserId?: string;
    createdByUserId?: string;
    updatedByUserId?: string;
    summary: string;
    projectionClass: 'recent_summary' | 'durable_memory_candidate' | 'master_summary';
    sourceEventCount: number;
    updatedAt: number;
    hitCount: number;
    lastUsedAt: number | undefined;
    status: 'active' | 'archived' | 'archived_dedup';
  }>;
  let matchedRecords: number;

  if (query) {
    const { searchLocalMemorySemantic } = await import('../context/memory-search.js');
    const semantic = await searchLocalMemorySemantic({
      query,
      scope: 'personal',
      userId: ownerUserId,
      includeLegacyPersonalOwner: true,
      repo: projectId || undefined,
      projectionClass,
      limit,
      includeArchived,
    });
    records = semantic.items
      .filter((item) => item.type === 'processed' && item.scope === 'personal' && personalOwnerMatchesManagementUser(item.userId, ownerUserId))
      .map((item) => ({
        id: item.id,
        scope: 'personal' as const,
        projectId: item.projectId ?? '',
        ownerUserId: item.userId ?? ownerUserId,
        summary: item.summary,
        projectionClass: item.projectionClass ?? 'recent_summary',
        sourceEventCount: item.sourceEventCount ?? 0,
        updatedAt: item.updatedAt ?? item.createdAt,
        hitCount: item.hitCount ?? 0,
        lastUsedAt: item.lastUsedAt,
        status: item.status ?? 'active',
      }));
    matchedRecords = records.length;
  } else {
    records = queryProcessedProjections({
      scope: 'personal',
      userId: ownerUserId,
      includeLegacyPersonalOwner: true,
      projectId: projectId || undefined,
      projectionClass,
      limit,
      includeArchived,
    }).map((projection) => ({
      id: projection.id,
      scope: projection.namespace.scope as 'personal',
      projectId: projection.namespace.projectId ?? '',
      ownerUserId: recordOwnerUserIdFromContent(projection.content, projection.namespace) ?? ownerUserId,
      createdByUserId: recordCreatedByUserIdFromContent(
        projection.content,
        recordOwnerUserIdFromContent(projection.content, projection.namespace) ?? ownerUserId,
      ),
      updatedByUserId: recordUpdatedByUserIdFromContent(projection.content),
      summary: projection.summary,
      projectionClass: projection.class,
      sourceEventCount: projection.sourceEventIds.length,
      updatedAt: projection.updatedAt,
      hitCount: projection.hitCount ?? 0,
      lastUsedAt: projection.lastUsedAt,
      status: projection.status ?? 'active' as const,
    }));
    matchedRecords = baseStats.matchedRecords;
  }

  const stats = {
    ...baseStats,
    matchedRecords,
  };
  const pendingRecords = queryPendingContextEvents({
    scope: 'personal',
    userId: ownerUserId,
    includeLegacyPersonalOwner: true,
    projectId: projectId || undefined,
    query: query || undefined,
    limit,
  });
  const projects = listMemoryProjectSummaries({
    scope: 'personal',
    userId: ownerUserId,
    includeLegacyPersonalOwner: true,
    projectId: projectId || undefined,
    projectionClass,
    includeArchived,
  });
  serverLink.send({
    type: MEMORY_WS.PERSONAL_RESPONSE,
    requestId,
    stats,
    records,
    pendingRecords,
    projects,
  });
}

function commandString(cmd: Record<string, unknown>, key: string): string {
  const value = cmd[key];
  return typeof value === 'string' ? value.trim() : '';
}

function commandManagementContext(cmd: Record<string, unknown>): AuthenticatedMemoryManagementContext | null {
  const raw = cmd[MEMORY_MANAGEMENT_CONTEXT_FIELD];
  if (isAuthenticatedMemoryManagementContext(raw)) {
    const requestId = commandString(cmd, 'requestId');
    if (raw.source === 'server_bridge' && raw.requestId && requestId && raw.requestId !== requestId) {
      return null;
    }
    return {
      ...raw,
      actorId: raw.actorId.trim(),
      userId: raw.userId.trim(),
      boundProjects: raw.boundProjects ?? [],
    };
  }
  return null;
}

function commandCanonicalRepoId(cmd: Record<string, unknown>): string | undefined {
  return commandString(cmd, 'canonicalRepoId') || undefined;
}

function contextProjectHint(ctx: AuthenticatedMemoryManagementContext, projectDir?: string, canonicalRepoId?: string): {
  projectDir?: string;
  canonicalRepoId?: string;
  workspaceId?: string;
  orgId?: string;
} {
  const trimmedProjectDir = projectDir?.trim();
  const trimmedCanonicalRepoId = canonicalRepoId?.trim();
  const matched = trimmedCanonicalRepoId
    ? ctx.boundProjects?.find((project) => project.canonicalRepoId === trimmedCanonicalRepoId)
    : (trimmedProjectDir
      ? ctx.boundProjects?.find((project) => project.projectDir === trimmedProjectDir)
      : ctx.boundProjects?.[0]);
  return {
    projectDir: matched?.projectDir,
    canonicalRepoId: matched?.canonicalRepoId,
    workspaceId: matched?.workspaceId,
    orgId: matched?.orgId,
  };
}

function commandMemoryScope(cmd: Record<string, unknown>, fallback: MemoryScope): MemoryScope {
  const value = cmd.scope;
  return isMemoryScope(value) ? value : fallback;
}

function commandNamespace(cmd: Record<string, unknown>, fallbackScope: MemoryScope, ctx?: AuthenticatedMemoryManagementContext): ContextNamespace {
  const scope = commandMemoryScope(cmd, fallbackScope);
  const projectHint = ctx ? contextProjectHint(ctx, commandString(cmd, 'projectDir') || undefined, commandCanonicalRepoId(cmd)) : undefined;
  return {
    scope,
    userId: ctx?.userId || commandString(cmd, 'userId') || (scope === 'personal' || scope === 'user_private' ? DAEMON_LOCAL_PREFERENCE_USER_ID : undefined),
    projectId: ctx ? projectHint?.canonicalRepoId : commandString(cmd, 'projectId') || commandString(cmd, 'canonicalRepoId') || undefined,
    workspaceId: ctx ? projectHint?.workspaceId : commandString(cmd, 'workspaceId') || undefined,
    enterpriseId: ctx ? projectHint?.orgId : commandString(cmd, 'enterpriseId') || commandString(cmd, 'orgId') || undefined,
  };
}

function metadataUserId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function recordOwnerUserIdFromContent(content: Record<string, unknown>, namespace?: ContextNamespace): string | undefined {
  return metadataUserId(content.ownerUserId)
    ?? metadataUserId(content.ownedByUserId)
    ?? metadataUserId(content.userId)
    ?? (namespace && isOwnerPrivateMemoryScope(namespace.scope) ? metadataUserId(namespace.userId) : undefined);
}

function trustedRecordOwnerUserIdFromContent(content: Record<string, unknown>, namespace?: ContextNamespace): string | undefined {
  return metadataUserId(content.ownerUserId)
    ?? metadataUserId(content.ownedByUserId)
    ?? (namespace && isOwnerPrivateMemoryScope(namespace.scope) ? metadataUserId(namespace.userId) : undefined);
}

function recordCreatedByUserIdFromContent(content: Record<string, unknown>, fallbackOwnerUserId?: string): string | undefined {
  return metadataUserId(content.createdByUserId)
    ?? metadataUserId(content.authorUserId)
    ?? metadataUserId(content.createdBy)
    ?? fallbackOwnerUserId;
}

function trustedRecordCreatedByUserIdFromContent(content: Record<string, unknown>, fallbackOwnerUserId?: string): string | undefined {
  return metadataUserId(content.createdByUserId)
    ?? fallbackOwnerUserId;
}

function recordUpdatedByUserIdFromContent(content: Record<string, unknown>): string | undefined {
  return metadataUserId(content.updatedByUserId)
    ?? metadataUserId(content.lastEditedByUserId)
    ?? metadataUserId(content.updatedBy);
}

function recordOwnedOrCreatedByUser(content: Record<string, unknown>, namespace: ContextNamespace | undefined, userId: string): boolean {
  const ownerUserId = trustedRecordOwnerUserIdFromContent(content, namespace);
  const createdByUserId = trustedRecordCreatedByUserIdFromContent(content, ownerUserId);
  return ownerUserId === userId || createdByUserId === userId;
}

function preferenceOwnerFromObservation(observation: { content: Record<string, unknown> }): string {
  const explicitOwner = trustedRecordOwnerUserIdFromContent(observation.content);
  if (explicitOwner) return explicitOwner;
  const idempotencyKey = typeof observation.content.idempotencyKey === 'string' ? observation.content.idempotencyKey : '';
  const parts = idempotencyKey.split('\u0000');
  return typeof parts[1] === 'string' && parts[1].trim() ? parts[1] : DAEMON_LOCAL_PREFERENCE_USER_ID;
}

function observationNamespace(namespaceId: string): ContextNamespace | undefined {
  return listContextNamespaces().find((namespace) => namespace.id === namespaceId);
}

function personalOwnerMatchesManagementUser(namespaceUserId: string | undefined, ownerUserId: string): boolean {
  return namespaceUserId === ownerUserId
    || !namespaceUserId?.trim()
    || namespaceUserId === DAEMON_LOCAL_PREFERENCE_USER_ID;
}

function managementContextCanAccessNamespace(namespace: ContextNamespace | undefined, ctx: AuthenticatedMemoryManagementContext): boolean {
  if (!namespace) return false;
  if (namespace.scope === 'user_private') {
    return namespace.userId === ctx.userId;
  }
  const boundProjects = ctx.boundProjects ?? [];
  if (namespace.scope === 'personal') {
    if (!personalOwnerMatchesManagementUser(namespace.userId, ctx.userId)) return false;
    if (namespace.projectId) {
      if (boundProjects.length === 0) return true;
      return boundProjects.some((project) => project.canonicalRepoId === namespace.projectId);
    }
    return true;
  }
  if (namespace.scope === 'project_shared') {
    return Boolean(namespace.projectId && boundProjects.some((project) => project.canonicalRepoId === namespace.projectId));
  }
  if (namespace.scope === 'workspace_shared') {
    return Boolean(namespace.workspaceId && boundProjects.some((project) => project.workspaceId === namespace.workspaceId));
  }
  if (namespace.scope === 'org_shared') {
    return Boolean(namespace.enterpriseId && boundProjects.some((project) => project.orgId === namespace.enterpriseId));
  }
  return false;
}

function commandProjectBinding(
  cmd: Record<string, unknown>,
  ctx: AuthenticatedMemoryManagementContext,
): MemoryManagementBoundProject | undefined {
  const projectDir = commandString(cmd, 'projectDir') || undefined;
  const projectId = commandCanonicalRepoId(cmd);
  if (!projectDir && !projectId) return undefined;
  return (ctx.boundProjects ?? []).find((project) => (
    (!projectDir || project.projectDir === projectDir)
    && (!projectId || project.canonicalRepoId === projectId)
  ));
}

async function validateProjectScopedManagementBinding(
  cmd: Record<string, unknown>,
  ctx: AuthenticatedMemoryManagementContext,
): Promise<{ projectDir: string; canonicalRepoId: string; binding: MemoryManagementBoundProject } | { errorCode: MemoryManagementErrorCode }> {
  const projectDir = commandString(cmd, 'projectDir');
  const canonicalRepoId = commandCanonicalRepoId(cmd);
  if (!projectDir) return { errorCode: MEMORY_MANAGEMENT_ERROR_CODES.MISSING_PROJECT_DIR };
  if (!canonicalRepoId) return { errorCode: MEMORY_MANAGEMENT_ERROR_CODES.MISSING_PROJECT_IDENTITY };
  const binding = commandProjectBinding(cmd, ctx);
  if (!binding || binding.canonicalRepoId !== canonicalRepoId || binding.projectDir !== projectDir) {
    return { errorCode: MEMORY_MANAGEMENT_ERROR_CODES.PROJECT_IDENTITY_MISMATCH };
  }
  const stat = await fsStat(projectDir).catch(() => null);
  if (!stat?.isDirectory()) return { errorCode: MEMORY_MANAGEMENT_ERROR_CODES.INVALID_PROJECT_DIR };
  if (!(await validateCanonicalProjectIdentity(projectDir, canonicalRepoId))) {
    return { errorCode: MEMORY_MANAGEMENT_ERROR_CODES.PROJECT_IDENTITY_MISMATCH };
  }
  return { projectDir, canonicalRepoId, binding };
}

function observationVisibleToManagementContext(
  observation: { scope: MemoryScope; namespaceId: string },
  ctx: AuthenticatedMemoryManagementContext,
): boolean {
  return managementContextCanAccessNamespace(observationNamespace(observation.namespaceId), ctx);
}

function observationMutableByManagementContext(
  observation: { scope: MemoryScope; namespaceId: string; content: Record<string, unknown> },
  ctx: AuthenticatedMemoryManagementContext,
): boolean {
  const namespace = observationNamespace(observation.namespaceId);
  if (!managementContextCanAccessNamespace(namespace, ctx)) return false;
  if (isOwnerPrivateMemoryScope(observation.scope)) return true;
  if (isSharedProjectionScope(observation.scope)) {
    return ctx.role === 'workspace_admin'
      || ctx.role === 'org_admin'
      || recordOwnedOrCreatedByUser(observation.content, namespace, ctx.userId);
  }
  return false;
}

function projectionMutableByManagementContext(
  projection: { namespace: ContextNamespace; content: Record<string, unknown> },
  ctx: AuthenticatedMemoryManagementContext,
): boolean {
  const namespace = projection.namespace;
  if (!managementContextCanAccessNamespace(namespace, ctx)) return false;
  if (isOwnerPrivateMemoryScope(namespace.scope)) return true;
  if (isSharedProjectionScope(namespace.scope)) {
    return ctx.role === 'workspace_admin'
      || ctx.role === 'org_admin'
      || recordOwnedOrCreatedByUser(projection.content, namespace, ctx.userId);
  }
  return false;
}

function fingerprintKindForObservationClass(observationClass: string): 'preference' | 'skill' | 'decision' | 'note' {
  if (observationClass === 'preference') return 'preference';
  if (observationClass === 'skill_candidate') return 'skill';
  if (observationClass === 'decision') return 'decision';
  return 'note';
}

async function validateCanonicalProjectIdentity(projectDir: string, projectIdentity: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', '-v'], { cwd: projectDir, timeout: 3000 });
    const remotes = parseRemotes(stdout);
    const selected = remotes.find((remote) => remote.name === 'origin') ?? remotes[0];
    if (!selected) return false;
    const canonical = processRecallRepositoryIdentityService.resolve({ originUrl: selected.url });
    return canonical.key === projectIdentity.trim();
  } catch {
    return false;
  }
}

function observationText(content: Record<string, unknown>): string {
  if (typeof content.text === 'string') return content.text;
  if (typeof content.summary === 'string') return content.summary;
  if (typeof content.title === 'string') return content.title;
  return JSON.stringify(content);
}

function emptyMemoryStatsView(): ContextMemoryStatsView {
  return {
    totalRecords: 0,
    matchedRecords: 0,
    recentSummaryCount: 0,
    durableCandidateCount: 0,
    projectCount: 0,
    stagedEventCount: 0,
    dirtyTargetCount: 0,
    pendingJobCount: 0,
  };
}

function memoryManagementError(code: MemoryManagementErrorCode): { errorCode: MemoryManagementErrorCode; error: string } {
  return { errorCode: code, error: code };
}

function memoryManagementContextError(): { errorCode: MemoryManagementErrorCode; error: string } {
  incrementCounter('mem.management.unauthorized', { reason: 'missing_context' });
  return memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MANAGEMENT_REQUEST_UNROUTED);
}

function skillsFeatureEnabled(): boolean {
  return isMemoryFeatureEnabled(MEMORY_FEATURE_FLAGS_BY_NAME.skills);
}

function mdIngestFeatureEnabled(): boolean {
  return isMemoryFeatureEnabled(MD_INGEST_FEATURE_FLAG);
}

function observationStoreFeatureEnabled(): boolean {
  return isMemoryFeatureEnabled(MEMORY_FEATURE_FLAGS_BY_NAME.observationStore);
}

function processedMemoryManagementFeatureEnabled(): boolean {
  return observationStoreFeatureEnabled();
}

function buildMemoryFeatureAdminRecords() {
  const layers = readMemoryFeatureResolutionLayers();
  const requested = readRequestedMemoryFeatureFlags(layers);
  const effective = computeEffectiveMemoryFeatureFlags(requested);
  return MEMORY_FEATURE_FLAGS.map((flag) => {
    const definition = getMemoryFeatureFlagDefinition(flag);
    return {
      flag,
      requested: requested[flag] === true,
      enabled: effective[flag],
      source: featureFlagValueSource(flag, layers),
      envKey: memoryFeatureFlagEnvKey(flag),
      dependencies: definition.dependencies,
      dependencyBlocked: requested[flag] === true && !effective[flag]
        ? definition.dependencies.filter((dependency) => !effective[dependency])
        : [],
      disabledBehavior: definition.disabledBehavior,
    };
  });
}

function collectMemoryFeatureWithDependencies(flag: MemoryFeatureFlag, seen = new Set<MemoryFeatureFlag>()): Set<MemoryFeatureFlag> {
  if (seen.has(flag)) return seen;
  seen.add(flag);
  for (const dependency of getMemoryFeatureFlagDefinition(flag).dependencies) {
    collectMemoryFeatureWithDependencies(dependency, seen);
  }
  return seen;
}

function handleMemoryFeaturesQuery(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const requestId = commandString(cmd, 'requestId') || undefined;
  serverLink.send({
    type: MEMORY_WS.FEATURES_RESPONSE,
    requestId,
    records: buildMemoryFeatureAdminRecords(),
  });
}

function buildMemoryMcpProviderStatuses(): MemoryMcpProviderStatusView[] {
  return MEMORY_MCP_PROVIDER_IDS.map((providerId) => {
    const provider = getProvider(providerId);
    if (!provider) {
      return {
        providerId,
        status: MEMORY_MCP_STATUS.UNKNOWN,
        connected: false,
        degradedReasons: [MEMORY_MCP_PROVIDER_STATUS_REASON.PROVIDER_NOT_CONNECTED],
      };
    }
    const reported = provider.getMemoryMcpStatus?.();
    if (reported) {
      return {
        ...reported,
        providerId,
        connected: reported.connected ?? true,
        degradedReasons: reported.degradedReasons ?? [],
      };
    }
    return {
      providerId,
      status: MEMORY_MCP_STATUS.DEGRADED,
      connected: true,
      degradedReasons: [MEMORY_MCP_DEGRADED_REASON.STATUS_NOT_REPORTED],
    };
  });
}

function memoryMcpToolFamilyGate(): MemoryMcpToolFamilyGateView {
  const tools = [
    MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY,
    MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES,
    MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
    MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION,
    MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE,
  ];
  if (!isMcpFeatureEnabled(undefined, MCP_FEATURE_FLAGS_BY_NAME.memorySurface)) {
    return {
      family: MEMORY_MCP_TOOL_FAMILY.MEMORY,
      status: MEMORY_MCP_STATUS.DISABLED,
      enabled: false,
      disabledFlag: MEMORY_MCP_DISABLED_FLAGS.MEMORY_SURFACE,
      tools,
    };
  }
  const disabledFlags = [
    [MEMORY_FEATURE_FLAGS_BY_NAME.quickSearch, MEMORY_MCP_DISABLED_FLAGS.QUICK_SEARCH],
    [MEMORY_FEATURE_FLAGS_BY_NAME.observationStore, MEMORY_MCP_DISABLED_FLAGS.OBSERVATION_STORE],
    [MEMORY_FEATURE_FLAGS_BY_NAME.preferences, MEMORY_MCP_DISABLED_FLAGS.PREFERENCES],
  ] as const;
  const disabledMemoryFlags = disabledFlags
    .filter(([flag]) => !isMemoryFeatureEnabled(flag))
    .map(([, disabledFlag]) => disabledFlag);
  if (disabledMemoryFlags.length > 0) {
    return {
      family: MEMORY_MCP_TOOL_FAMILY.MEMORY,
      status: MEMORY_MCP_STATUS.DEGRADED,
      enabled: true,
      disabledFlag: disabledMemoryFlags[0],
      degradedReasons: disabledMemoryFlags,
      tools,
    };
  }
  return {
    family: MEMORY_MCP_TOOL_FAMILY.MEMORY,
    status: MEMORY_MCP_STATUS.READY,
    enabled: true,
    tools,
  };
}

function sendMcpToolFamilyGate(): MemoryMcpToolFamilyGateView {
  const enabled = isMcpFeatureEnabled(undefined, MCP_FEATURE_FLAGS_BY_NAME.sendDispatch);
  return {
    family: MEMORY_MCP_TOOL_FAMILY.SEND,
    status: enabled ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.DISABLED,
    enabled,
    ...(enabled ? {} : { disabledFlag: MEMORY_MCP_DISABLED_FLAGS.SEND_DISPATCH }),
    tools: [
      MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS,
      MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
    ],
  };
}

function cronMcpToolFamilyGate(): MemoryMcpToolFamilyGateView {
  const readEnabled = isMcpFeatureEnabled(undefined, MCP_FEATURE_FLAGS_BY_NAME.cronRead);
  const writeEnabled = isMcpFeatureEnabled(undefined, MCP_FEATURE_FLAGS_BY_NAME.cronWrite);
  const disabledFlags = [
    ...(readEnabled ? [] : [MEMORY_MCP_DISABLED_FLAGS.CRON_READ]),
    ...(writeEnabled ? [] : [MEMORY_MCP_DISABLED_FLAGS.CRON_WRITE]),
  ];
  return {
    family: MEMORY_MCP_TOOL_FAMILY.CRON,
    status: readEnabled && writeEnabled
      ? MEMORY_MCP_STATUS.READY
      : readEnabled || writeEnabled
        ? MEMORY_MCP_STATUS.DEGRADED
        : MEMORY_MCP_STATUS.DISABLED,
    enabled: readEnabled || writeEnabled,
    ...(disabledFlags[0] ? { disabledFlag: disabledFlags[0], degradedReasons: disabledFlags } : {}),
    tools: [
      MEMORY_MCP_TOOL_NAMES.CRON_CREATE,
      MEMORY_MCP_TOOL_NAMES.CRON_LIST,
      MEMORY_MCP_TOOL_NAMES.CRON_UPDATE,
      MEMORY_MCP_TOOL_NAMES.CRON_DELETE,
    ],
  };
}

function handleMemoryMcpStatusQuery(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const requestId = commandString(cmd, 'requestId') || undefined;
  serverLink.send({
    type: MEMORY_WS.MCP_STATUS_RESPONSE,
    requestId,
    providers: buildMemoryMcpProviderStatuses(),
    toolFamilies: [
      memoryMcpToolFamilyGate(),
      sendMcpToolFamilyGate(),
      cronMcpToolFamilyGate(),
    ],
    recentCalls: [],
    updatedAt: Date.now(),
  });
}

function handleMemoryFeaturesSet(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  // In normal server-backed operation the bridge consumes FEATURES_SET,
  // persists the account-level user-global config, and pushes
  // MEMORY_FEATURE_CONFIG_MSG.APPLY to every online daemon owned by that user.
  // This direct daemon write path is retained only as a local fallback for
  // legacy/offline control planes; it is not the primary UI persistence plane.
  const requestId = commandString(cmd, 'requestId') || undefined;
  const flag = commandString(cmd, 'flag');
  const enabled = cmd.enabled;
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({
      type: MEMORY_WS.FEATURES_SET_RESPONSE,
      requestId,
      success: false,
      ...memoryManagementContextError(),
    });
    return;
  }
  if (!isMemoryFeatureFlag(flag) || typeof enabled !== 'boolean') {
    serverLink.send({
      type: MEMORY_WS.FEATURES_SET_RESPONSE,
      requestId,
      success: false,
      ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.INVALID_FEATURE_FLAG),
    });
    return;
  }

  try {
    const updates: MemoryFeatureFlagValues = enabled
      ? Object.fromEntries([...collectMemoryFeatureWithDependencies(flag)].map((dependency) => [dependency, true])) as MemoryFeatureFlagValues
      : { [flag]: false };
    setPersistedMemoryFeatureFlagValues(updates);
    if (flag === MEMORY_FEATURE_FLAGS_BY_NAME.skills || flag === MEMORY_FEATURE_FLAGS_BY_NAME.skillAutoCreation) {
      publishRuntimeMemoryCacheInvalidation({ kind: 'skill_registry' });
    }
    const records = buildMemoryFeatureAdminRecords();
    serverLink.send({
      type: MEMORY_WS.FEATURES_SET_RESPONSE,
      requestId,
      success: true,
      flag,
      requested: enabled,
      enabled: records.find((record) => record.flag === flag)?.enabled ?? false,
      records,
    });
  } catch (err) {
    logger.warn({ flag, enabled, err }, 'Failed to persist memory feature flag override');
    serverLink.send({
      type: MEMORY_WS.FEATURES_SET_RESPONSE,
      requestId,
      success: false,
      flag,
      requested: enabled,
      ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_CONFIG_WRITE_FAILED),
    });
  }
}

async function handleMemoryProjectResolve(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = commandString(cmd, 'requestId') || undefined;
  const projectDir = commandString(cmd, 'projectDir');
  const claimedCanonicalRepoId = commandCanonicalRepoId(cmd);
  const send = (payload: {
    success: boolean;
    status: MemoryProjectResolutionStatus;
    projectDir?: string;
    canonicalRepoId?: string;
    displayName?: string;
    error?: string;
    errorCode?: MemoryManagementErrorCode;
  }) => {
    serverLink.send({
      type: MEMORY_WS.PROJECT_RESOLVE_RESPONSE,
      requestId,
      ...payload,
    });
  };

  if (!projectDir) {
    send({
      success: false,
      status: 'invalid_dir',
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.MISSING_PROJECT_DIR,
    });
    return;
  }

  const requestedRealpath = await fsRealpath(projectDir).catch(() => undefined);
  const knownProjectDirs = listSessions()
    .map((session) => session.projectDir?.trim())
    .filter((value): value is string => Boolean(value));
  const knownProjectRealpaths = new Set<string>();
  for (const dir of knownProjectDirs) {
    const real = await fsRealpath(dir).catch(() => undefined);
    if (real) knownProjectRealpaths.add(real);
  }
  const isKnownProjectDir = knownProjectDirs.includes(projectDir)
    || Boolean(requestedRealpath && knownProjectRealpaths.has(requestedRealpath));
  if (!isKnownProjectDir) {
    send({
      success: false,
      status: 'unauthorized',
      projectDir,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.PROJECT_IDENTITY_MISMATCH,
    });
    return;
  }

  const stat = await fsStat(projectDir).catch(() => null);
  if (!stat?.isDirectory()) {
    send({
      success: false,
      status: 'invalid_dir',
      projectDir,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.INVALID_PROJECT_DIR,
    });
    return;
  }

  try {
    const repo = await detectRepo(projectDir);
    if (!repo.info?.remoteUrl) {
      const status: MemoryProjectResolutionStatus = repo.status === 'multiple_remotes'
        ? 'multiple_remotes'
        : repo.status === 'no_repo'
          ? 'no_repo'
          : repo.status === 'unauthorized'
            ? 'unauthorized'
            : 'error';
      send({
        success: false,
        status,
        projectDir,
        errorCode: status === 'unauthorized'
          ? MEMORY_MANAGEMENT_ERROR_CODES.PROJECT_IDENTITY_MISMATCH
          : MEMORY_MANAGEMENT_ERROR_CODES.MISSING_PROJECT_IDENTITY,
      });
      return;
    }

    const canonical = processRecallRepositoryIdentityService.resolve({
      cwd: projectDir,
      originUrl: repo.info.remoteUrl,
    });
    if (claimedCanonicalRepoId && claimedCanonicalRepoId !== canonical.key) {
      send({
        success: false,
        status: 'mismatch',
        projectDir,
        canonicalRepoId: canonical.key,
        displayName: `${repo.info.owner}/${repo.info.repo}`,
        errorCode: MEMORY_MANAGEMENT_ERROR_CODES.PROJECT_IDENTITY_MISMATCH,
      });
      return;
    }

    send({
      success: true,
      status: 'resolved',
      projectDir,
      canonicalRepoId: canonical.key,
      displayName: `${repo.info.owner}/${repo.info.repo}`,
    });
  } catch (error) {
    logger.warn({ error, projectDir }, 'memory project resolve failed');
    send({
      success: false,
      status: 'error',
      projectDir,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.ACTION_FAILED,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleMemoryPreferencesQuery(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = commandString(cmd, 'requestId') || undefined;
  const userIdFilter = commandString(cmd, 'userId');
  if (!isPreferenceFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.PREF_RESPONSE, requestId, records: [], featureEnabled: false });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.PREF_RESPONSE, requestId, records: [], featureEnabled: true, ...memoryManagementContextError() });
    return;
  }
  const records = listContextObservations({
    scope: PREFERENCE_INGEST_SCOPE,
    class: PREFERENCE_INGEST_OBSERVATION_CLASS,
  })
    .filter((observation) => observation.state === PREFERENCE_INGEST_OBSERVATION_STATE)
    .map((observation) => {
      const userId = preferenceOwnerFromObservation(observation);
      const createdByUserId = recordCreatedByUserIdFromContent(observation.content, userId);
      return {
        id: observation.id,
        userId,
        ownerUserId: userId,
        createdByUserId,
        updatedByUserId: recordUpdatedByUserIdFromContent(observation.content) ?? createdByUserId,
        text: observationText(observation.content),
        fingerprint: observation.fingerprint,
        origin: observation.origin,
        state: observation.state,
        createdAt: observation.createdAt,
        updatedAt: observation.updatedAt,
      };
    })
    .filter((record) => record.userId === ctx.userId)
    .filter((record) => !userIdFilter || userIdFilter === ctx.userId && record.userId === userIdFilter)
    .slice(0, 100);
  serverLink.send({ type: MEMORY_WS.PREF_RESPONSE, requestId, records, featureEnabled: isPreferenceFeatureEnabled() });
}

async function handleMemoryPreferenceCreate(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = commandString(cmd, 'requestId') || undefined;
  const text = commandString(cmd, 'text');
  if (!isPreferenceFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.PREF_CREATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.PREF_CREATE_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  const userId = ctx.userId;
  if (!text) {
    serverLink.send({ type: MEMORY_WS.PREF_CREATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_PREFERENCE_TEXT) });
    return;
  }
  try {
    const scopeKey = `${PREFERENCE_INGEST_SCOPE}:${userId}`;
    const fingerprint = computeMemoryFingerprint({ kind: 'preference', content: text, scopeKey });
    const namespace = ensureContextNamespace({ scope: PREFERENCE_INGEST_SCOPE, userId, name: 'preferences' });
    const row = writeContextObservation({
      namespaceId: namespace.id,
      scope: PREFERENCE_INGEST_SCOPE,
      class: PREFERENCE_INGEST_OBSERVATION_CLASS,
      origin: PREFERENCE_INGEST_ORIGIN,
      fingerprint,
      content: {
        text,
        ownerUserId: userId,
        createdByUserId: ctx.actorId,
        updatedByUserId: ctx.actorId,
        idempotencyKey: [PREFERENCE_IDEMPOTENCY_PREFIX, userId, scopeKey, `manual:${requestId || fingerprint}`, fingerprint].join('\u0000'),
      },
      text,
      sourceEventIds: [`manual-pref:${requestId || fingerprint}`],
      state: PREFERENCE_INGEST_OBSERVATION_STATE,
    });
    incrementCounter('mem.preferences.persisted', { sendOrigin: 'interactive_user' });
    publishRuntimeMemoryCacheInvalidation({ kind: 'preference', userId });
    serverLink.send({ type: MEMORY_WS.PREF_CREATE_RESPONSE, requestId, success: true, id: row.id });
  } catch (error) {
    logger.warn({ error }, 'memory preference management create failed');
    serverLink.send({ type: MEMORY_WS.PREF_CREATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.ACTION_FAILED) });
  }
}

async function handleMemoryPreferenceUpdate(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = commandString(cmd, 'requestId') || undefined;
  const id = commandString(cmd, 'id');
  const text = commandString(cmd, 'text');
  if (!isPreferenceFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.PREF_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.PREF_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  if (!id) {
    serverLink.send({ type: MEMORY_WS.PREF_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_ID) });
    return;
  }
  if (!text) {
    serverLink.send({ type: MEMORY_WS.PREF_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_PREFERENCE_TEXT) });
    return;
  }
  const existingPreference = listContextObservations({
    scope: PREFERENCE_INGEST_SCOPE,
    class: PREFERENCE_INGEST_OBSERVATION_CLASS,
  }).find((observation) => observation.id === id);
  if (!existingPreference) {
    serverLink.send({ type: MEMORY_WS.PREF_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.PREFERENCE_NOT_FOUND) });
    return;
  }
  if (preferenceOwnerFromObservation(existingPreference) !== ctx.userId) {
    incrementCounter('mem.preferences.unauthorized_delete', { source: 'memory_management' });
    serverLink.send({ type: MEMORY_WS.PREF_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.PREFERENCE_FORBIDDEN_OWNER) });
    return;
  }
  try {
    const scopeKey = `${PREFERENCE_INGEST_SCOPE}:${ctx.userId}`;
    const fingerprint = computeMemoryFingerprint({ kind: 'preference', content: text, scopeKey });
    const row = updateContextObservationText({
      observationId: id,
      text,
      observationClass: PREFERENCE_INGEST_OBSERVATION_CLASS,
      fingerprint,
      ownerUserId: ctx.userId,
      createdByUserId: trustedRecordCreatedByUserIdFromContent(existingPreference.content, ctx.userId),
      updatedByUserId: ctx.actorId,
    });
    if (!row) {
      serverLink.send({ type: MEMORY_WS.PREF_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.PREFERENCE_NOT_FOUND) });
      return;
    }
    publishRuntimeMemoryCacheInvalidation({ kind: 'preference', userId: ctx.userId });
    serverLink.send({ type: MEMORY_WS.PREF_UPDATE_RESPONSE, requestId, success: true, id: row.id });
  } catch (error) {
    logger.warn({ error }, 'memory preference management update failed');
    serverLink.send({ type: MEMORY_WS.PREF_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.ACTION_FAILED) });
  }
}

async function handleMemoryPreferenceDelete(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = commandString(cmd, 'requestId') || undefined;
  const id = commandString(cmd, 'id');
  if (!isPreferenceFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.PREF_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.PREF_DELETE_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  if (!id) {
    serverLink.send({ type: MEMORY_WS.PREF_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_ID) });
    return;
  }
  const existingPreference = listContextObservations({
    scope: PREFERENCE_INGEST_SCOPE,
    class: PREFERENCE_INGEST_OBSERVATION_CLASS,
  }).find((observation) => observation.id === id);
  if (!existingPreference) {
    serverLink.send({ type: MEMORY_WS.PREF_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.PREFERENCE_NOT_FOUND) });
    return;
  }
  if (preferenceOwnerFromObservation(existingPreference) !== ctx.userId) {
    incrementCounter('mem.preferences.unauthorized_delete', { source: 'memory_management' });
    serverLink.send({ type: MEMORY_WS.PREF_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.PREFERENCE_FORBIDDEN_OWNER) });
    return;
  }
  const success = deleteContextObservation(id);
  if (success) publishRuntimeMemoryCacheInvalidation({ kind: 'preference', userId: ctx.userId });
  serverLink.send({ type: MEMORY_WS.PREF_DELETE_RESPONSE, requestId, success });
}

function skillAdminRecord(entry: import('../../shared/skill-registry-types.js').SkillRegistryEntry) {
  return {
    key: entry.key,
    layer: entry.layer,
    name: entry.metadata.name,
    category: entry.metadata.category,
    description: entry.metadata.description,
    displayPath: entry.displayPath,
    uri: entry.uri,
    fingerprint: entry.fingerprint,
    updatedAt: entry.updatedAt,
    enforcement: entry.enforcement,
    project: entry.project,
  };
}

async function handleMemorySkillsQuery(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = commandString(cmd, 'requestId') || undefined;
  const projectDir = commandString(cmd, 'projectDir') || undefined;
  const canonicalRepoId = commandCanonicalRepoId(cmd);
  if (!skillsFeatureEnabled()) {
    serverLink.send({
      type: MEMORY_WS.SKILL_RESPONSE,
      requestId,
      entries: [],
      sourceCounts: {},
      featureEnabled: false,
    });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.SKILL_RESPONSE, requestId, entries: [], sourceCounts: {}, featureEnabled: true, ...memoryManagementContextError() });
    return;
  }
  if (projectDir || canonicalRepoId) {
    const validation = await validateProjectScopedManagementBinding(cmd, ctx);
    if ('errorCode' in validation) {
      serverLink.send({ type: MEMORY_WS.SKILL_RESPONSE, requestId, entries: [], sourceCounts: {}, featureEnabled: true, ...memoryManagementError(validation.errorCode) });
      return;
    }
  }
  const { getSkillRegistryManagementSnapshot } = await import('../context/skill-registry.js');
  const snapshot = getSkillRegistryManagementSnapshot({ projectDir });
  serverLink.send({
    type: MEMORY_WS.SKILL_RESPONSE,
    requestId,
    entries: snapshot.entries.map(skillAdminRecord),
    sourceCounts: snapshot.sourceCounts,
    featureEnabled: skillsFeatureEnabled(),
  });
}

async function handleMemorySkillsRebuild(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = commandString(cmd, 'requestId') || undefined;
  const projectDir = commandString(cmd, 'projectDir') || undefined;
  const canonicalRepoId = commandCanonicalRepoId(cmd);
  if (!skillsFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.SKILL_REBUILD_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.SKILL_REBUILD_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  if (projectDir || canonicalRepoId) {
    const validation = await validateProjectScopedManagementBinding(cmd, ctx);
    if ('errorCode' in validation) {
      serverLink.send({ type: MEMORY_WS.SKILL_REBUILD_RESPONSE, requestId, success: false, ...memoryManagementError(validation.errorCode) });
      return;
    }
  }
  try {
    const { buildProjectSkillRegistry, buildUserSkillRegistry } = await import('../context/skill-registry-builder.js');
    const user = buildUserSkillRegistry();
    const project = projectDir ? buildProjectSkillRegistry({ projectDir }) : undefined;
    publishRuntimeMemoryCacheInvalidation({ kind: 'skill_registry' });
    serverLink.send({
      type: MEMORY_WS.SKILL_REBUILD_RESPONSE,
      requestId,
      success: true,
      userCount: user.entries.length,
      projectCount: project?.entries.length ?? 0,
    });
  } catch (error) {
    logger.warn({ error }, 'memory skill registry rebuild failed');
    serverLink.send({ type: MEMORY_WS.SKILL_REBUILD_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.ACTION_FAILED) });
  }
}

async function handleMemorySkillRead(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = commandString(cmd, 'requestId') || undefined;
  const key = commandString(cmd, 'key');
  const layer = commandString(cmd, 'layer');
  const projectDir = commandString(cmd, 'projectDir') || undefined;
  const canonicalRepoId = commandCanonicalRepoId(cmd);
  if (!skillsFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.SKILL_READ_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.SKILL_READ_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  if (projectDir || canonicalRepoId) {
    const validation = await validateProjectScopedManagementBinding(cmd, ctx);
    if ('errorCode' in validation) {
      serverLink.send({ type: MEMORY_WS.SKILL_READ_RESPONSE, requestId, success: false, ...memoryManagementError(validation.errorCode) });
      return;
    }
  }
  try {
    const { getSkillRegistryManagementSnapshot } = await import('../context/skill-registry.js');
    const entry = getSkillRegistryManagementSnapshot({ projectDir }).entries.find((candidate) => (
      candidate.key === key && candidate.layer === layer
    ));
    if (!entry?.path) {
      serverLink.send({ type: MEMORY_WS.SKILL_READ_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.SKILL_PATH_NOT_READABLE) });
      return;
    }
    let managedPath;
    try {
      managedPath = assertManagedSkillPathSync({ path: entry.path, projectDir, maxBytes: SKILL_MAX_BYTES });
    } catch (error) {
      const code = error instanceof ManagedSkillPathError && error.reason === 'oversize'
        ? MEMORY_MANAGEMENT_ERROR_CODES.SKILL_FILE_TOO_LARGE
        : MEMORY_MANAGEMENT_ERROR_CODES.SKILL_PATH_NOT_READABLE;
      serverLink.send({ type: MEMORY_WS.SKILL_READ_RESPONSE, requestId, success: false, ...memoryManagementError(code) });
      return;
    }
    const content = await fsReadFileRaw(managedPath.realPath, 'utf8');
    serverLink.send({ type: MEMORY_WS.SKILL_READ_RESPONSE, requestId, success: true, key, layer, content });
  } catch (error) {
    logger.warn({ error }, 'memory skill preview failed');
    serverLink.send({ type: MEMORY_WS.SKILL_READ_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.ACTION_FAILED) });
  }
}

async function handleMemorySkillDelete(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = commandString(cmd, 'requestId') || undefined;
  const key = commandString(cmd, 'key');
  const layer = commandString(cmd, 'layer');
  const projectDir = commandString(cmd, 'projectDir') || undefined;
  const canonicalRepoId = commandCanonicalRepoId(cmd);
  if (!skillsFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.SKILL_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.SKILL_DELETE_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  if (projectDir || canonicalRepoId) {
    const validation = await validateProjectScopedManagementBinding(cmd, ctx);
    if ('errorCode' in validation) {
      serverLink.send({ type: MEMORY_WS.SKILL_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(validation.errorCode) });
      return;
    }
  }
  try {
    const { getSkillRegistryManagementSnapshot, getSkillRegistryPathsForManagement, writeSkillRegistryManagementSnapshot } = await import('../context/skill-registry.js');
    const snapshot = getSkillRegistryManagementSnapshot({ projectDir });
    const entry = snapshot.entries.find((candidate) => candidate.key === key && candidate.layer === layer);
    if (!entry?.path) {
      serverLink.send({ type: MEMORY_WS.SKILL_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.SKILL_NOT_FOUND) });
      return;
    }
    let managedPath;
    try {
      managedPath = assertManagedSkillPathSync({ path: entry.path, projectDir });
    } catch (error) {
      serverLink.send({ type: MEMORY_WS.SKILL_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.SKILL_OUTSIDE_MANAGED_ROOTS) });
      return;
    }
    const rootKind = managedPath.rootKind;
    await fsUnlink(managedPath.realPath).catch((error) => {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (code !== 'ENOENT') throw error;
    });
    const paths = getSkillRegistryPathsForManagement({ projectDir });
    if (rootKind === 'user') {
      writeSkillRegistryManagementSnapshot(paths.user, snapshot.entries.filter((candidate) => {
        try {
          if (candidate.path && assertManagedSkillPathSync({ path: candidate.path, projectDir }).rootKind !== 'user') return false;
        } catch {
          return false;
        }
        return !(candidate.key === key && candidate.layer === layer && candidate.path === entry.path);
      }));
    } else if (paths.project) {
      writeSkillRegistryManagementSnapshot(paths.project, snapshot.entries.filter((candidate) => {
        try {
          if (candidate.path && assertManagedSkillPathSync({ path: candidate.path, projectDir }).rootKind !== 'project') return false;
        } catch {
          return false;
        }
        return !(candidate.key === key && candidate.layer === layer && candidate.path === entry.path);
      }));
    }
    publishRuntimeMemoryCacheInvalidation({ kind: 'skill_registry' });
    serverLink.send({ type: MEMORY_WS.SKILL_DELETE_RESPONSE, requestId, success: true });
  } catch (error) {
    logger.warn({ error }, 'memory skill delete failed');
    serverLink.send({ type: MEMORY_WS.SKILL_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.ACTION_FAILED) });
  }
}

async function handleMemoryMarkdownIngestRun(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = commandString(cmd, 'requestId') || undefined;
  const projectDir = commandString(cmd, 'projectDir');
  const projectIdentity = commandCanonicalRepoId(cmd);
  if (!mdIngestFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.MD_INGEST_RUN_RESPONSE, requestId, success: false, featureEnabled: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.MD_INGEST_RUN_RESPONSE, requestId, success: false, featureEnabled: true, ...memoryManagementContextError() });
    return;
  }
  if (!projectDir) {
    serverLink.send({ type: MEMORY_WS.MD_INGEST_RUN_RESPONSE, requestId, success: false, featureEnabled: true, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_PROJECT_DIR) });
    return;
  }
  if (!projectIdentity) {
    serverLink.send({ type: MEMORY_WS.MD_INGEST_RUN_RESPONSE, requestId, success: false, featureEnabled: true, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_PROJECT_IDENTITY) });
    return;
  }
  const stat = await fsStat(projectDir).catch(() => null);
  if (!stat?.isDirectory()) {
    serverLink.send({ type: MEMORY_WS.MD_INGEST_RUN_RESPONSE, requestId, success: false, featureEnabled: true, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.INVALID_PROJECT_DIR) });
    return;
  }
  if (!(await validateCanonicalProjectIdentity(projectDir, projectIdentity))) {
    serverLink.send({ type: MEMORY_WS.MD_INGEST_RUN_RESPONSE, requestId, success: false, featureEnabled: true, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.PROJECT_IDENTITY_MISMATCH) });
    return;
  }
  if (!commandProjectBinding(cmd, ctx)) {
    serverLink.send({ type: MEMORY_WS.MD_INGEST_RUN_RESPONSE, requestId, success: false, featureEnabled: true, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.PROJECT_IDENTITY_MISMATCH) });
    return;
  }
  try {
    const namespace = commandNamespace(cmd, 'personal', ctx);
    const { runMarkdownMemoryIngest } = await import('../context/md-ingest-worker.js');
    const result = await runMarkdownMemoryIngest({ projectDir, namespace, actorUserId: ctx.actorId });
    if (result.droppedReason === 'unsupported_scope') {
      serverLink.send({ type: MEMORY_WS.MD_INGEST_RUN_RESPONSE, requestId, success: false, featureEnabled: true, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.UNSUPPORTED_MD_INGEST_SCOPE), ...result });
      return;
    }
    publishRuntimeMemoryCacheInvalidation({ kind: 'md_ingest', projectDir, namespace });
    serverLink.send({ type: MEMORY_WS.MD_INGEST_RUN_RESPONSE, requestId, success: true, featureEnabled: true, ...result });
  } catch (error) {
    logger.warn({ error }, 'manual markdown memory ingest failed');
    serverLink.send({ type: MEMORY_WS.MD_INGEST_RUN_RESPONSE, requestId, success: false, featureEnabled: true, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.ACTION_FAILED) });
  }
}

async function handleMemoryObservationsQuery(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = commandString(cmd, 'requestId') || undefined;
  const scope = isMemoryScope(cmd.scope) ? cmd.scope : undefined;
  const observationClass = commandString(cmd, 'class');
  if (!observationStoreFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_RESPONSE, requestId, records: [], featureEnabled: false });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_RESPONSE, requestId, records: [], featureEnabled: true, ...memoryManagementContextError() });
    return;
  }
  const limit = Math.max(1, Math.min(200, typeof cmd.limit === 'number' ? cmd.limit : 50));
  const records = listContextObservations({
    scope,
    class: isObservationClass(observationClass) ? observationClass : undefined,
  }).filter((observation) => observationVisibleToManagementContext(observation, ctx)).slice(0, limit).map((observation) => {
    const namespace = observationNamespace(observation.namespaceId);
    const ownerUserId = trustedRecordOwnerUserIdFromContent(observation.content, namespace);
    const createdByUserId = recordCreatedByUserIdFromContent(observation.content, ownerUserId);
    return {
      id: observation.id,
      scope: observation.scope,
      class: observation.class,
      origin: observation.origin,
      state: observation.state,
      ownerUserId,
      createdByUserId,
      updatedByUserId: recordUpdatedByUserIdFromContent(observation.content) ?? createdByUserId,
      text: observationText(observation.content),
      fingerprint: observation.fingerprint,
      namespaceId: observation.namespaceId,
      projectionId: observation.projectionId,
      createdAt: observation.createdAt,
      updatedAt: observation.updatedAt,
    };
  });
  serverLink.send({ type: MEMORY_WS.OBSERVATION_RESPONSE, requestId, records, featureEnabled: observationStoreFeatureEnabled() });
}

async function handleMemoryObservationUpdate(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = commandString(cmd, 'requestId') || undefined;
  const observationId = commandString(cmd, 'id');
  const text = commandString(cmd, 'text');
  const expectedFromScope = isMemoryScope(cmd.expectedFromScope) ? cmd.expectedFromScope : undefined;
  if (!observationStoreFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  if (!observationId) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_ID) });
    return;
  }
  if (!text) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_OBSERVATION_TEXT) });
    return;
  }
  if (!expectedFromScope) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_EXPECTED_FROM_SCOPE) });
    return;
  }
  try {
    const observation = listContextObservations().find((candidate) => candidate.id === observationId);
    if (!observation) {
      serverLink.send({ type: MEMORY_WS.OBSERVATION_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_NOT_FOUND) });
      return;
    }
    if (observation.scope !== expectedFromScope) {
      serverLink.send({ type: MEMORY_WS.OBSERVATION_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_FROM_SCOPE_MISMATCH) });
      return;
    }
    if (!observationMutableByManagementContext(observation, ctx)) {
      incrementCounter('mem.observation.unauthorized_promotion_attempt', { source: 'memory_management' });
      serverLink.send({ type: MEMORY_WS.OBSERVATION_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_MUTATION_FORBIDDEN) });
      return;
    }
    const fingerprint = computeMemoryFingerprint({
      kind: fingerprintKindForObservationClass(observation.class),
      content: text,
      scopeKey: `${observation.scope}:${observation.namespaceId}`,
    });
    const namespace = observationNamespace(observation.namespaceId);
    const ownerUserId = trustedRecordOwnerUserIdFromContent(observation.content, namespace);
    const row = updateContextObservationText({
      observationId,
      text,
      observationClass: observation.class,
      fingerprint,
      ownerUserId,
      createdByUserId: trustedRecordCreatedByUserIdFromContent(observation.content, ownerUserId),
      updatedByUserId: ctx.actorId,
    });
    if (!row) {
      serverLink.send({ type: MEMORY_WS.OBSERVATION_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_NOT_FOUND) });
      return;
    }
    publishRuntimeMemoryCacheInvalidation({ kind: 'observation', observationId, namespace });
    if (observation.projectionId) {
      publishRuntimeMemoryCacheInvalidation({ kind: 'projection', projectionId: observation.projectionId, namespace });
    }
    serverLink.send({ type: MEMORY_WS.OBSERVATION_UPDATE_RESPONSE, requestId, success: true, id: row.id });
  } catch (error) {
    logger.warn({ error }, 'memory observation update failed');
    serverLink.send({ type: MEMORY_WS.OBSERVATION_UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.ACTION_FAILED) });
  }
}

async function handleMemoryObservationDelete(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = commandString(cmd, 'requestId') || undefined;
  const observationId = commandString(cmd, 'id');
  const expectedFromScope = isMemoryScope(cmd.expectedFromScope) ? cmd.expectedFromScope : undefined;
  if (!observationStoreFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_DELETE_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  if (!observationId) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_ID) });
    return;
  }
  if (!expectedFromScope) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_EXPECTED_FROM_SCOPE) });
    return;
  }
  try {
    const observation = listContextObservations().find((candidate) => candidate.id === observationId);
    if (!observation) {
      serverLink.send({ type: MEMORY_WS.OBSERVATION_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_NOT_FOUND) });
      return;
    }
    if (observation.scope !== expectedFromScope) {
      serverLink.send({ type: MEMORY_WS.OBSERVATION_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_FROM_SCOPE_MISMATCH) });
      return;
    }
    if (!observationMutableByManagementContext(observation, ctx)) {
      incrementCounter('mem.observation.unauthorized_promotion_attempt', { source: 'memory_management' });
      serverLink.send({ type: MEMORY_WS.OBSERVATION_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_MUTATION_FORBIDDEN) });
      return;
    }
    const success = deleteContextObservation(observationId);
    if (success) {
      publishRuntimeMemoryCacheInvalidation({ kind: 'observation', observationId, namespace: observationNamespace(observation.namespaceId) });
      if (observation.projectionId) {
        publishRuntimeMemoryCacheInvalidation({ kind: 'projection', projectionId: observation.projectionId, namespace: observationNamespace(observation.namespaceId) });
      }
    }
    serverLink.send({ type: MEMORY_WS.OBSERVATION_DELETE_RESPONSE, requestId, success });
  } catch (error) {
    logger.warn({ error }, 'memory observation delete failed');
    serverLink.send({ type: MEMORY_WS.OBSERVATION_DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.ACTION_FAILED) });
  }
}

async function handleMemoryObservationPromote(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = commandString(cmd, 'requestId') || undefined;
  const observationId = commandString(cmd, 'id');
  const toScopeRaw = cmd.toScope;
  const ctx = commandManagementContext(cmd);
  const reason = commandString(cmd, 'reason') || undefined;
  const expectedFromScope = isMemoryScope(cmd.expectedFromScope) ? cmd.expectedFromScope : undefined;
  if (!observationStoreFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  const actorId = ctx.actorId;
  if (!observationId) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_ID) });
    return;
  }
  if (!isMemoryScope(toScopeRaw)) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.INVALID_TARGET_SCOPE) });
    return;
  }
  if (!expectedFromScope) {
    serverLink.send({ type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_EXPECTED_FROM_SCOPE) });
    return;
  }
  const toScope = toScopeRaw;
  try {
    const observation = listContextObservations().find((candidate) => candidate.id === observationId);
    if (!observation) {
      serverLink.send({ type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_NOT_FOUND) });
      return;
    }
    if (!observationVisibleToManagementContext(observation, ctx)) {
      incrementCounter('mem.observation.unauthorized_promotion_attempt', { source: 'memory_management' });
      serverLink.send({ type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.PROMOTION_REQUIRES_AUTHORIZATION) });
      return;
    }
    if (isOwnerPrivateMemoryScope(observation.scope) && isSharedProjectionScope(toScope) && ctx.role !== 'workspace_admin' && ctx.role !== 'org_admin') {
      incrementCounter('mem.observation.cross_scope_promotion_blocked', { source: 'memory_management' });
      serverLink.send({ type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.PROMOTION_REQUIRES_AUTHORIZATION) });
      return;
    }
    if (isSharedProjectionScope(toScope) && ctx.role !== 'workspace_admin' && ctx.role !== 'org_admin') {
      incrementCounter('mem.observation.cross_scope_promotion_blocked', { source: 'memory_management' });
      serverLink.send({ type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.PROMOTION_REQUIRES_AUTHORIZATION) });
      return;
    }
    if (observation.scope !== expectedFromScope) {
      serverLink.send({ type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_FROM_SCOPE_MISMATCH) });
      return;
    }
    const audit = promoteContextObservation({ observationId, actorId, toScope, reason, action: 'web_ui_promote', actorRole: ctx.role, expectedFromScope });
    publishRuntimeMemoryCacheInvalidation({ kind: 'observation', observationId });
    serverLink.send({ type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE, requestId, success: true, audit });
  } catch (error) {
    logger.warn({ error }, 'memory observation promotion failed');
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = message === 'observation not found'
      ? MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_NOT_FOUND
      : message.startsWith('observation scope changed from expected ')
        ? MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_FROM_SCOPE_MISMATCH
        : MEMORY_MANAGEMENT_ERROR_CODES.ACTION_FAILED;
    serverLink.send({ type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE, requestId, success: false, ...memoryManagementError(errorCode) });
  }
}

async function handleMemorySearch(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const { searchLocalMemoryAuthorized } = await import('../context/memory-search.js');
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  if (!isMemoryFeatureEnabled(MEMORY_FEATURE_FLAGS_BY_NAME.quickSearch)) {
    serverLink.send({
      type: MEMORY_WS.SEARCH_RESPONSE,
      requestId,
      items: [],
      stats: { total: 0, disabled: true },
    });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({
      type: MEMORY_WS.SEARCH_RESPONSE,
      requestId,
      items: [],
      stats: { total: 0, disabled: false },
      ...memoryManagementContextError(),
    });
    return;
  }
  const repo = typeof cmd.repo === 'string' ? cmd.repo.trim() : '';
  const effectiveRepo = repo;
  const searchBinding = (ctx.boundProjects ?? []).find((project) => project.canonicalRepoId === effectiveRepo);
  if (!effectiveRepo || !searchBinding) {
    incrementCounter('mem.search.unauthorized_lookup', { source: 'memory_management' });
    serverLink.send({
      type: MEMORY_WS.SEARCH_RESPONSE,
      requestId,
      items: [],
      stats: { total: 0, disabled: false },
      ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_QUERY_FORBIDDEN),
    });
    return;
  }
  const authorizedNamespaces: ContextNamespace[] = [
    { scope: 'personal', projectId: effectiveRepo, userId: ctx.userId },
    { scope: 'project_shared', projectId: effectiveRepo, workspaceId: searchBinding.workspaceId, enterpriseId: searchBinding.orgId },
  ];
  if (searchBinding.workspaceId) authorizedNamespaces.push({ scope: 'workspace_shared', workspaceId: searchBinding.workspaceId, enterpriseId: searchBinding.orgId });
  if (searchBinding.orgId) authorizedNamespaces.push({ scope: 'org_shared', enterpriseId: searchBinding.orgId });
  const result = searchLocalMemoryAuthorized({
    query: typeof cmd.query === 'string' ? cmd.query : undefined,
    authorizedNamespaces,
    projectionClass: typeof cmd.projectionClass === 'string'
      ? cmd.projectionClass as 'recent_summary' | 'durable_memory_candidate'
      : undefined,
    eventType: typeof cmd.eventType === 'string' ? cmd.eventType : undefined,
    limit: typeof cmd.limit === 'number' ? cmd.limit : 50,
    offset: typeof cmd.offset === 'number' ? cmd.offset : 0,
  });
  serverLink.send({
    type: MEMORY_WS.SEARCH_RESPONSE,
    requestId,
    items: result.items,
    stats: result.stats,
  });
}

async function handleMemoryArchive(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  if (!processedMemoryManagementFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.ARCHIVE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const id = typeof cmd.id === 'string' ? cmd.id : '';
  if (!id) {
    serverLink.send({ type: MEMORY_WS.ARCHIVE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_ID) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.ARCHIVE_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  const projection = getProcessedProjectionById(id);
  if (!projection || !projectionMutableByManagementContext(projection, ctx)) {
    serverLink.send({ type: MEMORY_WS.ARCHIVE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_QUERY_FORBIDDEN) });
    return;
  }
  const { archiveMemory } = await import('../store/context-store.js');
  const success = archiveMemory(id);
  if (success) publishRuntimeMemoryCacheInvalidation({ kind: 'projection', projectionId: id, namespace: projection.namespace });
  serverLink.send({ type: MEMORY_WS.ARCHIVE_RESPONSE, requestId, success });
}

async function handleMemoryRestore(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  if (!processedMemoryManagementFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.RESTORE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const id = typeof cmd.id === 'string' ? cmd.id : '';
  if (!id) {
    serverLink.send({ type: MEMORY_WS.RESTORE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_ID) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.RESTORE_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  const projection = getProcessedProjectionById(id);
  if (!projection || !projectionMutableByManagementContext(projection, ctx)) {
    serverLink.send({ type: MEMORY_WS.RESTORE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_QUERY_FORBIDDEN) });
    return;
  }
  const { restoreArchivedMemory } = await import('../store/context-store.js');
  const success = restoreArchivedMemory(id);
  if (success) publishRuntimeMemoryCacheInvalidation({ kind: 'projection', projectionId: id, namespace: projection.namespace });
  serverLink.send({ type: MEMORY_WS.RESTORE_RESPONSE, requestId, success });
}

async function handleMemoryCreate(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  if (!processedMemoryManagementFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.CREATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const text = commandString(cmd, 'text');
  if (!text) {
    serverLink.send({ type: MEMORY_WS.CREATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_MEMORY_TEXT) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.CREATE_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  const canonicalRepoId = commandCanonicalRepoId(cmd);
  if (!canonicalRepoId) {
    serverLink.send({ type: MEMORY_WS.CREATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_PROJECT_IDENTITY) });
    return;
  }
  const projectDir = commandString(cmd, 'projectDir');
  if (projectDir) {
    const projectBinding = await validateProjectScopedManagementBinding(cmd, ctx);
    if ('errorCode' in projectBinding) {
      serverLink.send({ type: MEMORY_WS.CREATE_RESPONSE, requestId, success: false, ...memoryManagementError(projectBinding.errorCode) });
      return;
    }
  } else if (!ctx.boundProjects?.some((project) => project.canonicalRepoId === canonicalRepoId)) {
    serverLink.send({ type: MEMORY_WS.CREATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_QUERY_FORBIDDEN) });
    return;
  }
  const requestedClass = commandString(cmd, 'projectionClass');
  const projectionClass = requestedClass === 'recent_summary' || requestedClass === 'durable_memory_candidate'
    ? requestedClass
    : 'durable_memory_candidate';
  const namespace: ContextNamespace = { scope: 'personal', projectId: canonicalRepoId, userId: ctx.userId };
  try {
    const fingerprint = computeMemoryFingerprint({ kind: 'note', content: text, scopeKey: `personal:${ctx.userId}:${canonicalRepoId}` });
    const projection = writeProcessedProjection({
      namespace,
      class: projectionClass,
      sourceEventIds: [`manual-memory:${requestId || fingerprint}`],
      summary: text,
      content: {
        text,
        summary: text,
        manual: true,
        origin: 'user_note',
        source: 'web_management',
        ownerUserId: ctx.userId,
        createdByUserId: ctx.actorId,
        updatedByUserId: ctx.actorId,
      },
      origin: 'user_note',
    });
    publishRuntimeMemoryCacheInvalidation({ kind: 'projection', projectionId: projection.id, namespace });
    serverLink.send({ type: MEMORY_WS.CREATE_RESPONSE, requestId, success: true, id: projection.id });
  } catch (error) {
    logger.warn({ error }, 'manual memory create failed');
    serverLink.send({ type: MEMORY_WS.CREATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.ACTION_FAILED) });
  }
}

async function handleMemoryUpdate(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  if (!processedMemoryManagementFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const id = typeof cmd.id === 'string' ? cmd.id : '';
  const text = commandString(cmd, 'text');
  if (!id) {
    serverLink.send({ type: MEMORY_WS.UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_ID) });
    return;
  }
  if (!text) {
    serverLink.send({ type: MEMORY_WS.UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_MEMORY_TEXT) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.UPDATE_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  const projection = getProcessedProjectionById(id);
  if (!projection) {
    serverLink.send({ type: MEMORY_WS.UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MEMORY_NOT_FOUND) });
    return;
  }
  if (!projectionMutableByManagementContext(projection, ctx)) {
    serverLink.send({ type: MEMORY_WS.UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_QUERY_FORBIDDEN) });
    return;
  }
  try {
    const ownerUserId = trustedRecordOwnerUserIdFromContent(projection.content, projection.namespace) ?? ctx.userId;
    const updated = updateProcessedProjectionSummary({
      projectionId: id,
      summary: text,
      ownerUserId,
      createdByUserId: trustedRecordCreatedByUserIdFromContent(projection.content, ownerUserId),
      updatedByUserId: ctx.actorId,
    });
    if (!updated) {
      serverLink.send({ type: MEMORY_WS.UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MEMORY_NOT_FOUND) });
      return;
    }
    publishRuntimeMemoryCacheInvalidation({ kind: 'projection', projectionId: id, namespace: updated.namespace });
    serverLink.send({ type: MEMORY_WS.UPDATE_RESPONSE, requestId, success: true, id });
  } catch (error) {
    logger.warn({ error }, 'manual memory update failed');
    serverLink.send({ type: MEMORY_WS.UPDATE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.ACTION_FAILED) });
  }
}

async function handleMemoryPin(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  if (!processedMemoryManagementFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.PIN_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const id = typeof cmd.id === 'string' ? cmd.id : '';
  if (!id) {
    serverLink.send({ type: MEMORY_WS.PIN_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_ID) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.PIN_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  const projection = getProcessedProjectionById(id);
  if (!projection) {
    serverLink.send({ type: MEMORY_WS.PIN_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MEMORY_NOT_FOUND) });
    return;
  }
  if (!projectionMutableByManagementContext(projection, ctx)) {
    serverLink.send({ type: MEMORY_WS.PIN_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_QUERY_FORBIDDEN) });
    return;
  }
  try {
    const pinned = upsertPinnedNote({
      id: `projection:${projection.id}`,
      namespaceKey: serializeContextNamespace(projection.namespace),
      content: projection.summary,
      origin: 'manual_pin',
    });
    publishRuntimeMemoryCacheInvalidation({ kind: 'projection', projectionId: projection.id, namespace: projection.namespace });
    serverLink.send({ type: MEMORY_WS.PIN_RESPONSE, requestId, success: true, id: pinned.id });
  } catch (error) {
    logger.warn({ error }, 'manual memory pin failed');
    serverLink.send({ type: MEMORY_WS.PIN_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.ACTION_FAILED) });
  }
}


/**
 * Cross-server projection source resolution.
 *
 * Triggered by the server's pod-sticky `GET /api/memory/sources?serverId=...
 * &projectionId=...` route. The server has already authenticated the caller
 * and verified they own *this* daemon's serverId before forwarding the
 * request — so by the time the handler runs, the WS payload is trustworthy
 * for THIS daemon's own data. We resolve sources directly from the daemon's
 * local SQLite (the same call `memoryGetSources` makes after its owner
 * check) and reply with the standard `MemoryGetSourcesResult` shape plus
 * `originServerId` equal to this daemon's own serverId.
 *
 * Cross-namespace access stays fail-closed because every event's
 * `target.namespace` is matched against the projection's namespace before
 * its content is returned — same isolation `memoryGetSources` provides.
 */
async function handleMemoryGetSourcesRequest(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  const projectionId = typeof cmd.projectionId === 'string' ? cmd.projectionId.trim() : '';
  const expectedProjectId = typeof cmd.expectedProjectId === 'string' && cmd.expectedProjectId.trim()
    ? cmd.expectedProjectId.trim()
    : undefined;
  // The daemon's own bound serverId. Tagged on every reply so the server
  // route can fill `originServerId` even before the orchestrator knows which
  // daemon answered — useful for cache repopulation on the caller side.
  const originServerId = typeof cmd.expectedServerId === 'string' && cmd.expectedServerId.trim()
    ? cmd.expectedServerId.trim()
    : undefined;

  if (!projectionId) {
    serverLink.send({
      type: MEMORY_WS.GET_SOURCES_RESPONSE,
      requestId,
      status: 'error',
      reason: 'validation_failed',
      message: 'projectionId is required',
      originServerId,
    });
    return;
  }

  try {
    const { getProcessedProjectionById, listProjectionSources } = await import('../store/context-store.js');
    const projection = getProcessedProjectionById(projectionId);
    if (!projection || !expectedProjectId || projection.namespace.projectId !== expectedProjectId) {
      // Isomorphic with missing/cross-project rows. The cloud route already
      // authenticates the caller, but the daemon still enforces project scope
      // before expanding local raw events.
      serverLink.send({
        type: MEMORY_WS.GET_SOURCES_RESPONSE,
        requestId,
        status: 'ok',
        projectionId,
        sourceEventCount: 0,
        sources: [],
        originServerId,
      });
      return;
    }

    const projectionNamespaceKey = serializeContextNamespace(projection.namespace);
    const sources = listProjectionSources(projectionId).map((source) => {
      // Same defense memoryGetSources applies: only surface event content
      // when the underlying event's namespace matches the projection's.
      // The daemon's SQLite is single-user, but a corrupt row from a past
      // bug could conceivably mis-link namespaces, and silence is safer.
      const event = source.event;
      const eventInScope = !!event && serializeContextNamespace(event.target.namespace) === projectionNamespaceKey;
      return {
        eventId: source.eventId,
        status: source.status,
        content: eventInScope ? (event!.content ?? null) : null,
        eventType: eventInScope ? event!.eventType : undefined,
        createdAt: eventInScope ? event!.createdAt : undefined,
      };
    });
    const projectionSource = buildMemoryProjectionFallbackSource(projection);
    const shouldFallback = sources.length === 0
      || sources.every((source) => source.content === null && source.status === 'missing');
    const resolvedSources = shouldFallback && projectionSource
      ? [projectionSource]
      : sources;

    const partial = !(resolvedSources.length === 1 && resolvedSources[0]?.status === 'projection') && (
      sources.length !== projection.sourceEventIds.length
      || sources.some((source) => source.content === null)
    );

    serverLink.send({
      type: MEMORY_WS.GET_SOURCES_RESPONSE,
      requestId,
      status: 'ok',
      projectionId,
      sourceEventCount: Math.max(projection.sourceEventIds.length, resolvedSources.length),
      sources: resolvedSources,
      ...(projectionSource ? { projectionSource } : {}),
      partial,
      originServerId,
    });
  } catch (error) {
    logger.warn({ error, projectionId }, 'memory.get_sources_request failed');
    serverLink.send({
      type: MEMORY_WS.GET_SOURCES_RESPONSE,
      requestId,
      status: 'error',
      reason: FS_GENERIC_ERROR_CODES.INTERNAL_ERROR,
      message: 'failed to resolve sources',
      originServerId,
    });
  }
}


async function handleMemoryDelete(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  if (!processedMemoryManagementFeatureEnabled()) {
    serverLink.send({ type: MEMORY_WS.DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED) });
    return;
  }
  const id = typeof cmd.id === 'string' ? cmd.id : '';
  if (!id) {
    serverLink.send({ type: MEMORY_WS.DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.MISSING_ID) });
    return;
  }
  const ctx = commandManagementContext(cmd);
  if (!ctx) {
    serverLink.send({ type: MEMORY_WS.DELETE_RESPONSE, requestId, success: false, ...memoryManagementContextError() });
    return;
  }
  const projection = getProcessedProjectionById(id);
  if (!projection || !projectionMutableByManagementContext(projection, ctx)) {
    serverLink.send({ type: MEMORY_WS.DELETE_RESPONSE, requestId, success: false, ...memoryManagementError(MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_QUERY_FORBIDDEN) });
    return;
  }
  const { deleteMemory } = await import('../store/context-store.js');
  const success = deleteMemory(id);
  if (success) publishRuntimeMemoryCacheInvalidation({ kind: 'projection', projectionId: id, namespace: projection.namespace });
  serverLink.send({ type: MEMORY_WS.DELETE_RESPONSE, requestId, success });
}

// ── Process agent memory injection (text prepend) ────────────────────────

async function prependLocalMemory(
  prompt: string,
  sessionName: string,
  options?: { deadlineAt?: number },
): Promise<{
  text: string;
  timelinePayload?: Omit<MemoryContextTimelinePayload, 'relatedToEventId'>;
  hitIds?: string[];
}> {
  const query = prompt.slice(0, 200);
  if (prompt.trim().startsWith('/')) {
    return {
      text: prompt,
      timelinePayload: buildMemoryContextStatusPayload(query, 'skipped_control_message'),
    };
  }
  if (prompt.length < 10) {
    return {
      text: prompt,
      timelinePayload: buildMemoryContextStatusPayload(query, 'skipped_short_prompt'),
    };
  }
  // Template-prompt skip: OpenSpec / slash-command / skill-template prompts
  // are not natural-language questions; a recall over them returns noise.
  // See shared/template-prompt-patterns.ts.
  if (isTemplatePrompt(prompt)) {
    return {
      text: prompt,
      timelinePayload: buildMemoryContextStatusPayload(query, 'skipped_template_prompt'),
    };
  }
  // Imperative-command skip: short terse task-control verbs ("commit&push",
  // "redeploy", "continue") are ops directives, not semantic queries.
  if (isImperativeCommand(prompt)) {
    return {
      text: prompt,
      timelinePayload: buildMemoryContextStatusPayload(query, 'skipped_control_message'),
    };
  }
  try {
    const { searchLocalMemorySemantic } = await import('../context/memory-search.js');
    const recallContext = await resolveProcessRecallQueryContext(sessionName);
    // Broaden the candidate pool — the cap rule trims to 3 (or up to 5 for
    // all-strong results). We need enough candidates to survive filtering.
    const searchResult = await searchLocalMemorySemantic({
      query,
      namespace: recallContext.namespace,
      currentEnterpriseId: recallContext.currentEnterpriseId,
      repo: recallContext.repo,
      limit: 10,
    });
    if (typeof options?.deadlineAt === 'number' && Date.now() > options.deadlineAt) {
      return {
        text: prompt,
        timelinePayload: buildMemoryContextStatusPayload(query, 'failed'),
      };
    }
    // 1) Template-origin legacy summaries never surface through recall.
    const notTemplate = searchResult.items.filter(
      (item) => !isTemplateOriginSummary(item.summary),
    );
    // 2) Per-session dedup: drop items already injected in the last 10 turns
    //    of THIS session. Cleared on `session.clear`.
    const ids = notTemplate.map((item) => item.id);
    const keepIds = new Set(filterRecentlyInjected(sessionName, ids));
    const deduped = notTemplate.filter((item) => keepIds.has(item.id));
    const dedupedCount = Math.max(0, notTemplate.length - deduped.length);
    // 3) Cap rule: floor 0.5, top 3, extend to 5 iff all >= 0.6.
    //    See shared/memory-scoring.ts.
    const scored = deduped.map((item) => ({ item, score: item.relevanceScore ?? 0 }));
    const finalScored = applyRecallCapRule(scored, {
      minFloor: getContextModelConfig().memoryRecallMinScore,
    });
    const finalItems = finalScored.map((s) => s.item);
    if (finalItems.length === 0) {
      return {
        text: prompt,
        timelinePayload: deduped.length === 0 && notTemplate.length > 0
          ? buildMemoryContextStatusPayload(query, 'deduped_recently', 'message', {
              matchedCount: notTemplate.length,
              dedupedCount,
            })
          : buildMemoryContextStatusPayload(query, 'no_matches', 'message', {
              matchedCount: notTemplate.length,
            }),
      };
    }
    const hitIds = finalItems.filter((item) => item.type === 'processed').map((item) => item.id);
    const injectedText = buildRelatedPastWorkText(finalItems);
    const timelinePayload = buildMemoryContextTimelinePayload(query, finalItems);
    // 4) Record the injection into the per-session ring buffer so these
    //    same items do not re-inject on the next 10 turns.
    recordRecentInjection(sessionName, hitIds);
    return {
      text: `${injectedText}\n\n${prompt}`,
      timelinePayload: timelinePayload
        ? {
            query: timelinePayload.query,
            injectedText: timelinePayload.injectedText,
            items: timelinePayload.items,
          }
        : undefined,
      hitIds: hitIds.length > 0 ? hitIds : undefined,
    };
  } catch {
    return {
      text: prompt,
      timelinePayload: buildMemoryContextStatusPayload(query, 'failed'),
    }; // non-fatal
  }
}
