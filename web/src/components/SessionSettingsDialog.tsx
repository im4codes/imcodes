/**
 * SessionSettingsDialog — edit metadata and view cwd for main or sub sessions.
 */
import { AUDIT_SEVERITY_LEVELS, normalizeAuditBlockingSeverities, type AuditSeverity } from '@shared/audit-convergence.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import { patchSession, patchSubSession } from '../api.js';
import { useSupervisorDefaults } from '../hooks/useSupervisorDefaults.js';
import { readCachedTransportModels, supportsDynamicTransportModels, useTransportModels } from '../hooks/useTransportModels.js';
import type { WsClient } from '../ws-client.js';
import { CLAUDE_CODE_CLI_SDK_AGENT_TYPE, SESSION_AGENT_TYPES, TRANSPORT_SESSION_AGENT_TYPES, getSessionRuntimeType, type SessionAgentType } from '@shared/agent-types.js';
import { CODEBUDDY_PROVIDER_IDS } from '@shared/codebuddy.js';
import { HERMES_AGENT_PROVIDER_ID } from '@shared/hermes-agent.js';
import { AGY_SDK_PROVIDER_ID } from '@shared/agy-agent.js';
import { isDelegationReplyCapableAgentType } from '@shared/agent-delegation.js';
import type { SharedContextRuntimeBackend } from '@shared/context-types.js';
import {
  doesSharedContextBackendSupportPresets,
  normalizeSharedContextRuntimeBackend,
} from '@shared/shared-context-runtime-config.js';
import {
  buildTransportConfigWithSupervision,
  hasInvalidSessionSupervisionSnapshot,
  isSupportedSupervisionBackend,
  normalizeSupervisorDefaultConfig,
  readSupervisionSnapshotFromTransportConfig,
  resolveSupervisionAuditBlockingSeverities,
  SUPERVISION_MODE,
  type SessionSupervisionSnapshot,
  type SupervisionMode,
} from '@shared/supervision-config.js';
import { TaskPairSettingsSection } from './TaskPairSettingsSection.js';
import {
  buildSupervisionExecutionCapabilityId,
  isExcludedDevelopmentModel,
  normalizeSupervisionExecutionModel,
  normalizeSupervisionExecutionPools,
  supervisionExecutionConfigRole,
  SUPERVISION_EXECUTION_POOL_ROLES,
  type SupervisionExecutionConfig,
  type SupervisionExecutionPoolKind,
  type SupervisionExecutionPoolRole,
  type SupervisionExecutionPoolsConfig,
} from '@shared/supervision-execution-pool.js';
import {
  PEER_AUDIT_UNKNOWN_IDENTITY,
  resolvePeerAuditNormalizedModelId,
  resolvePeerAuditProviderFamily,
} from '@shared/peer-audit.js';
import {
  type SessionSettingsOpenIntent,
} from '../session-settings-open-intent.js';
import { AGY_MODEL_IDS, CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS, mergeModelSuggestions } from '../../../src/shared/models/options.js';
import { getKnownQwenModelOptions } from '@shared/qwen-models.js';
import { SessionIdentityTabs } from './SessionIdentityTabs.js';
import { dispatchSessionModelSwitch } from '../session-model-switch.js';

interface Props {
  serverId: string;
  /** Main session name (e.g. deck_myapp_brain) */
  sessionName: string;
  /** Sub-session ID — if set, patches sub_sessions table instead of sessions */
  subSessionId?: string;
  /** Current values */
  label: string;
  description: string;
  cwd: string;
  type: string;
  parentSession?: string | null;
  /** UI hint only; Server/daemon remain the authority for automatic mode. */
  canControlAutomaticSupervision?: boolean;
  transportConfig?: Record<string, unknown> | null;
  /** Minimal owner-authoritative mode projected to shared read-only clients. */
  supervisionMode?: SupervisionMode | null;
  sessionInstanceId?: string;
  runtimeEpoch?: string;
  activeModel?: string | null;
  requestedModel?: string | null;
  modelDisplay?: string | null;
  providerId?: string | null;
  projectKey?: string;
  pairTaskId?: string;
  /**
   * Ordinary sub-sessions already loaded by the App's HTTP session APIs and
   * enriched by live session sync. Settings must render this list directly;
   * it must not start a second daemon candidate-list RPC just to populate UI.
   */
  peerAuditSessions?: readonly PeerAuditSettingsSession[];
  /** Opens the existing sub-session launcher for a new pool candidate. */
  onAddPoolSession?: (pool: SupervisionExecutionPoolKind) => void;
  /** Lowers this overlay only while the reused child launcher is open. */
  poolSessionDialogOpen?: boolean;
  openIntent?: SessionSettingsOpenIntent;
  /** Production callers must select one independent settings surface. */
  surface: 'session' | 'supervision';
  /**
   * Optional WebSocket client. When supplied, the supervision dialog subscribes
   * to `cc.presets.list_response` and adds compatible third-party presets to
   * the shared runtime selector. When absent, built-in model selection remains
   * available and only the preset row is omitted.
   */
  ws?: WsClient | null;
  onClose: () => void;
  onSaved: (fields: { label?: string; description?: string; cwd?: string; type?: string; transportConfig?: Record<string, unknown> | null; requestedModel?: string | null; activeModel?: string | null; modelDisplay?: string | null }) => void;
}

export const SESSION_MODEL_CONFIRMATION_TIMEOUT_MS = 15_000;

export interface PeerAuditSettingsSession {
  sessionName: string;
  parentSession?: string | null;
  type: string;
  runtimeType?: 'process' | 'transport' | null;
  label?: string | null;
  state?: string | null;
  sessionInstanceId?: string | null;
  runtimeEpoch?: string | null;
  activeModel?: string | null;
  requestedModel?: string | null;
  modelDisplay?: string | null;
  providerId?: string | null;
  closedAt?: number | null;
  ccPresetId?: string | null;
  executionCloneKind?: string | null;
  parentRunId?: string | null;
  /** Server-filtered owner-group candidate projection for shared participants. */
  ownerCatalog?: true;
}

type SupervisionDraft = Partial<SessionSupervisionSnapshot> & {
  mode: SupervisionMode;
};

type SupervisionRuntimeDraft = {
  backend?: SharedContextRuntimeBackend;
  model?: string;
  preset?: string;
  timeoutMs?: number;
  promptVersion?: string;
  customInstructions?: string;
  maxAutoContinueStreak?: number;
  maxAutoContinueTotal?: number;
  backupBackend?: SharedContextRuntimeBackend;
  backupModel?: string;
  backupPreset?: string;
  executionPools?: SupervisionExecutionPoolsConfig;
};

function labelForBackend(t: (key: string, params?: Record<string, unknown>) => string, backend: SharedContextRuntimeBackend): string {
  return t({
    'claude-code-sdk': 'session.agentType.claude_code_sdk',
    'codex-sdk': 'session.agentType.codex_sdk',
    'qoder-sdk': 'session.agentType.qoder_sdk',
    qwen: 'session.agentType.qwen',
    openclaw: 'session.agentType.openclaw',
    'copilot-sdk': 'session.agentType.copilot_sdk',
    'cursor-headless': 'session.agentType.cursor_headless',
  }[backend]);
}

function labelForPoolAgentType(
  t: (key: string, params?: Record<string, unknown>) => string,
  agentType: string,
): string {
  return isSupportedSupervisionBackend(agentType)
    ? labelForBackend(t, agentType)
    : agentType;
}

function buildPoolConfig(backend: SharedContextRuntimeBackend, model: string): SupervisionExecutionConfig {
  const canonicalModel = normalizeSupervisionExecutionModel(backend, model);
  const runtimeType = getSessionRuntimeType(backend);
  const providerFamily = resolvePeerAuditProviderFamily({ agentType: backend });
  return {
    agentType: backend,
    providerFamily,
    runtimeType,
    model: canonicalModel,
    capabilityId: buildSupervisionExecutionCapabilityId({
      agentType: backend,
      providerFamily,
      runtimeType,
      model: canonicalModel,
    }),
  };
}

/**
 * Bootstrap only from the Brain itself, never from whatever sibling sessions
 * happen to be alive when Settings opens.  This keeps the pool a durable model
 * selection while making the common case immediately usable: the Brain's own
 * model is checked in the primary development/audit pool, and the user can add
 * more models (or explicitly move it to the economy pool) afterwards.
 */
function withBrainPrimaryPoolDefault(input: {
  pools: SupervisionExecutionPoolsConfig;
  brainAgentType: string;
  brainModel: string;
}): SupervisionExecutionPoolsConfig {
  if (input.pools.state === 'configured'
    || !isSupportedSupervisionBackend(input.brainAgentType)
    || !input.brainModel
    || input.brainModel === PEER_AUDIT_UNKNOWN_IDENTITY
    || isExcludedDevelopmentModel(input.brainModel)) {
    return input.pools;
  }
  const config = buildPoolConfig(input.brainAgentType, input.brainModel);
  return {
    ...input.pools,
    state: 'configured',
    primaryDevelopmentPool: {
      ...input.pools.primaryDevelopmentPool,
      configs: [config],
    },
  };
}

const SUPERVISION_POOL_OPEN_SESSION_STATES = new Set([
  'starting',
  'queued',
  'running',
  'idle',
]);

export interface SupervisionExecutionPoolCandidate {
  sessionNames: string[];
  labels: string[];
  matchingSessionCount: number;
  label: string;
  config: SupervisionExecutionConfig;
}

/**
 * Build pool choices only from live ordinary sub-sessions in the current
 * Brain group. Closed/history rows, execution-incompatible runtimes and
 * sessions without a concrete model all fail closed instead of becoming a
 * durable account authorization merely because their metadata exists.
 *
 * Provider quota/availability is deliberately rechecked by the daemon when a
 * task is dispatched. The settings projection owns only the narrower, stable
 * question: is this an open reply-capable session with an observed model that
 * can represent a supervision execution capability?
 */
export function buildSupervisionExecutionPoolCandidates(input: {
  sessionName: string;
  parentSession?: string | null;
  sessions: readonly PeerAuditSettingsSession[];
}): SupervisionExecutionPoolCandidate[] {
  const owningMainSession = input.parentSession?.trim() || input.sessionName;
  const seenSessionNames = new Set<string>();
  const candidatesByCapability = new Map<string, SupervisionExecutionPoolCandidate>();

  for (const session of input.sessions) {
    if (!session.sessionName.trim()
      || session.parentSession !== owningMainSession
      || session.closedAt != null
      || (session.ownerCatalog !== true && !SUPERVISION_POOL_OPEN_SESSION_STATES.has(session.state ?? ''))
      || !isDelegationReplyCapableAgentType(session.type)
      || session.executionCloneKind != null
      || session.parentRunId != null
      || seenSessionNames.has(session.sessionName)) {
      continue;
    }
    const model = resolvePeerAuditNormalizedModelId({
      activeModel: session.activeModel,
      requestedModel: session.requestedModel,
      configuredModel: session.modelDisplay,
    });
    if (!model || model === PEER_AUDIT_UNKNOWN_IDENTITY) continue;
    const providerFamily = resolvePeerAuditProviderFamily({
      providerId: session.providerId,
      agentType: session.type,
    });
    if (!providerFamily || providerFamily === PEER_AUDIT_UNKNOWN_IDENTITY) continue;
    const runtimeType = session.runtimeType ?? getSessionRuntimeType(session.type);
    const canonicalModel = normalizeSupervisionExecutionModel(session.type, model);
    const ccPresetId = session.ccPresetId == null ? undefined : session.ccPresetId.trim();
    const backend = normalizeSharedContextRuntimeBackend(session.type);
    if (session.ccPresetId != null
      && (!ccPresetId || ccPresetId !== session.ccPresetId
        || !backend || !doesSharedContextBackendSupportPresets(backend))) continue;
    const config: SupervisionExecutionConfig = {
      agentType: session.type,
      providerFamily,
      runtimeType,
      model: canonicalModel,
      ...(ccPresetId ? { ccPresetId } : {}),
      capabilityId: buildSupervisionExecutionCapabilityId({
        agentType: session.type,
        providerFamily,
        runtimeType,
        model: canonicalModel,
        ...(ccPresetId ? { ccPresetId } : {}),
      }),
    };
    seenSessionNames.add(session.sessionName);
    const label = session.label?.trim() || session.sessionName;
    const existing = candidatesByCapability.get(config.capabilityId);
    if (existing) {
      existing.sessionNames.push(session.sessionName);
      existing.matchingSessionCount = existing.sessionNames.length;
      if (!existing.labels.includes(label)) existing.labels.push(label);
      continue;
    }
    candidatesByCapability.set(config.capabilityId, {
      sessionNames: [session.sessionName],
      labels: [label],
      matchingSessionCount: 1,
      label,
      config,
    });
  }

  const candidates = [...candidatesByCapability.values()];
  for (const candidate of candidates) {
    candidate.sessionNames.sort((left, right) => left.localeCompare(right));
    candidate.labels.sort((left, right) => left.localeCompare(right));
    candidate.label = candidate.labels.join(', ');
  }
  return candidates.sort((left, right) => left.label.localeCompare(right.label)
    || left.config.capabilityId.localeCompare(right.config.capabilityId));
}

function updateExecutionPoolSelection(
  pools: SupervisionExecutionPoolsConfig,
  pool: SupervisionExecutionPoolKind,
  config: SupervisionExecutionConfig,
): SupervisionExecutionPoolsConfig {
  const primary = pools.primaryDevelopmentPool.configs.filter((item) => item.capabilityId !== config.capabilityId);
  const economy = pools.economyTaskPool.configs.filter((item) => item.capabilityId !== config.capabilityId);
  const selectedPool = pool === 'primary' ? pools.primaryDevelopmentPool : pools.economyTaskPool;
  // Reusing an already configured capability must retain its role when it is
  // moved between pools.  The capability id intentionally excludes role.
  const existingConfig = [...pools.primaryDevelopmentPool.configs, ...pools.economyTaskPool.configs]
    .find((item) => item.capabilityId === config.capabilityId);
  const configToAdd = existingConfig ?? config;
  if (!selectedPool.configs.some((item) => item.capabilityId === config.capabilityId)) {
    (pool === 'primary' ? primary : economy).push(configToAdd);
  }
  return {
    ...pools,
    state: 'configured',
    primaryDevelopmentPool: { ...pools.primaryDevelopmentPool, configs: primary },
    economyTaskPool: { ...pools.economyTaskPool, configs: economy },
  };
}

/** Which pair role a pool entry may serve. Auditors currently pick from the primary pool. */
function updateExecutionPoolRole(
  pools: SupervisionExecutionPoolsConfig,
  capabilityId: string,
  role: SupervisionExecutionPoolRole,
): SupervisionExecutionPoolsConfig {
  const applyRole = (config: SupervisionExecutionConfig): SupervisionExecutionConfig => (
    config.capabilityId === capabilityId ? { ...config, role } : config
  );
  return {
    ...pools,
    primaryDevelopmentPool: { ...pools.primaryDevelopmentPool, configs: pools.primaryDevelopmentPool.configs.map(applyRole) },
    economyTaskPool: { ...pools.economyTaskPool, configs: pools.economyTaskPool.configs.map(applyRole) },
  };
}

function SupervisionExecutionPoolsEditor({
  t,
  saving,
  pools,
  candidates,
  onAddPoolSession,
  onChange,
}: {
  t: (key: string, params?: Record<string, unknown>) => string;
  saving: boolean;
  pools: SupervisionExecutionPoolsConfig;
  candidates: readonly SupervisionExecutionPoolCandidate[];
  onAddPoolSession?: (pool: SupervisionExecutionPoolKind) => void;
  onChange: (pools: SupervisionExecutionPoolsConfig) => void;
}) {
  const selected = (pool: SupervisionExecutionPoolKind, capabilityId: string): boolean => (
    (pool === 'primary' ? pools.primaryDevelopmentPool : pools.economyTaskPool)
      .configs.some((config) => config.capabilityId === capabilityId)
  );
  const toggle = (pool: SupervisionExecutionPoolKind, config: SupervisionExecutionConfig): void => {
    onChange(updateExecutionPoolSelection(pools, pool, config));
  };
  const setRole = (capabilityId: string, role: SupervisionExecutionPoolRole): void => {
    onChange(updateExecutionPoolRole(pools, capabilityId, role));
  };
  const configuredByCapability = new Map([
    ...pools.economyTaskPool.configs,
    ...pools.primaryDevelopmentPool.configs,
  ].map((config) => [config.capabilityId, config]));
  const renderRoleSelect = (candidate: SupervisionExecutionConfig) => {
    // Live candidates describe capability identity, not the user's saved role.
    // Resolve the draft entry across both pools so moving it cannot reset role.
    // Primary wins if an imported config contains the capability in both pools.
    const config = configuredByCapability.get(candidate.capabilityId) ?? candidate;
    return (
      <select
        aria-label={t('session.supervision.poolEntryRole', { model: config.model })}
        data-testid={`supervision-execution-pool-role-${config.capabilityId}`}
        value={supervisionExecutionConfigRole(config)}
        disabled={saving || !configuredByCapability.has(config.capabilityId)}
        onChange={(e) => setRole(config.capabilityId, (e.target as HTMLSelectElement).value as SupervisionExecutionPoolRole)}
      >
        {SUPERVISION_EXECUTION_POOL_ROLES.map((role) => (
          <option key={role} value={role}>{t(`session.supervision.poolEntryRole_${role}`)}</option>
        ))}
      </select>
    );
  };
  const renderPool = (pool: SupervisionExecutionPoolKind) => {
    const primary = pool === 'primary';
    const eligibleCandidates = primary
      ? candidates.filter((candidate) => !isExcludedDevelopmentModel(candidate.config.model))
      : candidates;
    const candidateCapabilityIds = new Set(candidates.map((candidate) => candidate.config.capabilityId));
    const configuredOnly = (primary ? pools.primaryDevelopmentPool : pools.economyTaskPool).configs
      .filter((config) => !candidateCapabilityIds.has(config.capabilityId));
    const titleKey = primary ? 'session.supervision.primaryDevelopmentPool' : 'session.supervision.economyTaskPool';
    return (
      <div class="session-settings-subsection" data-testid={`supervision-execution-pool-${pool}`}>
        <div class="session-settings-pool-heading">
          <div class="session-settings-subtitle">{t(titleKey)}</div>
          {onAddPoolSession && (
            <button
              type="button"
              class="session-settings-pool-add"
              aria-label={t('session.supervision.addPoolSession', { pool: t(titleKey) })}
              title={t('session.supervision.addPoolSession', { pool: t(titleKey) })}
              onClick={() => onAddPoolSession(pool)}
              disabled={saving}
            >+</button>
          )}
        </div>
        <div class="session-settings-muted">
          {t(primary ? 'session.supervision.primaryDevelopmentPoolHelp' : 'session.supervision.economyTaskPoolHelp')}
        </div>
        {eligibleCandidates.length === 0 && (
          <div class="session-settings-pool-empty" data-testid={`supervision-execution-pool-${pool}-empty`}>
            {t('session.supervision.noPoolSessions')}
          </div>
        )}
        <div class="session-settings-pool-options" style={{ marginTop: 8 }}>
          {eligibleCandidates.map((candidate) => (
            <label key={`${pool}:${candidate.config.capabilityId}`} class="session-settings-pool-option">
              <input
                type="checkbox"
                aria-label={`${pool}:${candidate.sessionNames.join(',')}`}
                checked={selected(pool, candidate.config.capabilityId)}
                onChange={() => toggle(pool, candidate.config)}
                disabled={saving}
              />
              <span class="session-settings-pool-option-copy">
                <strong>{candidate.label}</strong>
                <span>{candidate.sessionNames.join(', ')} · ×{candidate.matchingSessionCount}</span>
                <span>{labelForPoolAgentType(t, candidate.config.agentType)} · {candidate.config.model}</span>
              </span>
              {primary && renderRoleSelect(candidate.config)}
            </label>
          ))}
          {configuredOnly.map((config) => (
            <label key={`${pool}:configured:${config.capabilityId}`} class="session-settings-pool-option is-configured-only">
              <input
                type="checkbox"
                aria-label={`${pool}:configured:${config.agentType}:${config.model}`}
                checked
                onChange={() => toggle(pool, config)}
                disabled={saving}
              />
              <span class="session-settings-pool-option-copy">
                <strong>{t('session.supervision.configuredPoolModel')}</strong>
                <span>{labelForPoolAgentType(t, config.agentType)} · {config.model}</span>
                <span>{t('session.supervision.configuredPoolModelUnavailable')}</span>
              </span>
              {primary && renderRoleSelect(config)}
            </label>
          ))}
        </div>
      </div>
    );
  };
  return <>{renderPool('primary')}{renderPool('economy')}</>;
}

/** Pair settings carried unchanged through every supervision draft rebuild. */
function pairSettingsOf(draft: Pick<SupervisionDraft, 'pairEngine' | 'pairMaxConcurrency'>): Pick<SupervisionDraft, 'pairEngine' | 'pairMaxConcurrency'> {
  return {
    ...(draft.pairEngine ? { pairEngine: draft.pairEngine } : {}),
    ...(draft.pairMaxConcurrency ? { pairMaxConcurrency: draft.pairMaxConcurrency } : {}),
  };
}

export function SessionSettingsDialog({
  serverId,
  sessionName,
  subSessionId,
  label: initLabel,
  description: initDesc,
  cwd: initCwd,
  type,
  transportConfig,
  supervisionMode,
  activeModel,
  requestedModel,
  modelDisplay,
  projectKey,
  pairTaskId,
  peerAuditSessions = [],
  onAddPoolSession,
  poolSessionDialogOpen = false,
  parentSession,
  canControlAutomaticSupervision = false,
  openIntent,
  surface,
  ws,
  onClose,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const isMainSession = !subSessionId && !parentSession;
  const hasPersistedSupervision = useMemo(() => !!(transportConfig && typeof transportConfig === 'object' && transportConfig.supervision), [transportConfig]);
  const hasInvalidPersistedSupervision = useMemo(
    () => hasInvalidSessionSupervisionSnapshot(transportConfig),
    [transportConfig],
  );
  const initialSupervision = useMemo<SupervisionDraft>(() => {
    const persisted: SupervisionDraft = hasPersistedSupervision
      ? readSupervisionSnapshotFromTransportConfig(transportConfig)
      : { mode: supervisionMode ?? SUPERVISION_MODE.OFF };
    if (!canControlAutomaticSupervision || !openIntent?.supervisionMode) return persisted;
    return { ...persisted, mode: openIntent.supervisionMode };
  }, [canControlAutomaticSupervision, hasPersistedSupervision, openIntent?.supervisionMode, supervisionMode, transportConfig]);

  const [label, setLabel] = useState(initLabel);
  const [description, setDescription] = useState(initDesc);
  const [agentType, setAgentType] = useState(type);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const initialSessionModel = activeModel?.trim() || modelDisplay?.trim() || requestedModel?.trim() || '';
  const [sessionModel, setSessionModel] = useState(initialSessionModel);
  const [appliedSessionModel, setAppliedSessionModel] = useState(initialSessionModel);
  const [modelApplyState, setModelApplyState] = useState<'idle' | 'applying' | 'applied' | 'error'>('idle');
  const [modelApplyError, setModelApplyError] = useState('');
  const [pendingSessionModel, setPendingSessionModel] = useState<string | null>(null);
  const [supervision, setSupervision] = useState<SupervisionDraft>(initialSupervision);
  const agentTypeMountedRef = useRef(false);
  const providerModelManuallySelectedRef = useRef(false);
  useEffect(() => {
    if (canControlAutomaticSupervision || supervisionMode == null) return;
    setSupervision((current) => current.mode === supervisionMode
      ? current
      : { ...current, mode: supervisionMode });
  }, [canControlAutomaticSupervision, supervisionMode]);

  useEffect(() => {
    setLabel(initLabel);
    setDescription(initDesc);
    setAgentType(type);
    setSupervision(initialSupervision);
  }, [initLabel, initDesc, initCwd, type, initialSupervision, serverId, sessionName, subSessionId]);

  useEffect(() => {
    const observedModel = activeModel?.trim() || modelDisplay?.trim() || requestedModel?.trim() || '';
    setSessionModel(observedModel);
    setAppliedSessionModel(observedModel);
    setModelApplyState('idle');
    setModelApplyError('');
    setPendingSessionModel(null);
  }, [sessionName, subSessionId, type]);

  const providerDefaultModel = (nextType: string): string | null => {
    if (nextType === 'claude-code') return CLAUDE_CODE_MODEL_IDS[0] ?? null;
    if (nextType === 'codex') return CODEX_MODEL_IDS[0] ?? null;
    if (nextType === 'qwen') return getKnownQwenModelOptions()[0]?.id ?? null;
    const catalog = readCachedTransportModels(`${sessionName.trim()}\0${nextType}\0`, nextType);
    return catalog?.models.some((model) => model.id === catalog.defaultModel)
      ? catalog.defaultModel ?? null
      : catalog?.models[0]?.id ?? null;
  };

  // A provider change selects that provider's default, never the previous
  // provider's active model. The catalog hook may still hold the old provider
  // during this render, so read the target-scoped cache/fallback directly.
  useEffect(() => {
    if (!agentTypeMountedRef.current) {
      agentTypeMountedRef.current = true;
      return;
    }
    if (agentType === type) {
      providerModelManuallySelectedRef.current = false;
      setSessionModel(initialSessionModel);
      return;
    }
    providerModelManuallySelectedRef.current = false;
    setSessionModel(providerDefaultModel(agentType) ?? '');
  }, [agentType, type]);

  useEffect(() => {
    const activeEffectiveModel = activeModel?.trim() || modelDisplay?.trim() || '';
    const observedModel = activeEffectiveModel || requestedModel?.trim() || '';
    if (pendingSessionModel) {
      // requestedModel is only intent. The daemon's active/effective projection
      // is the confirmation that the provider actually accepted the switch.
      if (activeEffectiveModel !== pendingSessionModel) return;
      setAppliedSessionModel(activeEffectiveModel);
      setSessionModel(activeEffectiveModel);
      setModelApplyState('applied');
      setModelApplyError('');
      setPendingSessionModel(null);
      onSaved({
        requestedModel: pendingSessionModel,
        activeModel: activeEffectiveModel,
        modelDisplay: activeEffectiveModel,
      });
      return;
    }
    setAppliedSessionModel((previous) => {
      setSessionModel((selected) => selected === previous ? observedModel : selected);
      return observedModel;
    });
  }, [activeModel, modelDisplay, onSaved, pendingSessionModel, requestedModel]);

  useEffect(() => {
    if (!pendingSessionModel) return;
    const timer = window.setTimeout(() => {
      setPendingSessionModel((current) => {
        if (current !== pendingSessionModel) return current;
        setModelApplyError(t('session.modelSettings.confirmationTimeout'));
        setModelApplyState('error');
        return null;
      });
    }, SESSION_MODEL_CONFIRMATION_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [pendingSessionModel, t]);

  const sessionDynamicModels = useTransportModels(
    ws ?? null,
    surface !== 'supervision' && supportsDynamicTransportModels(agentType) ? agentType : null,
    undefined,
    sessionName,
  );
  useEffect(() => {
    if (agentType === type || providerModelManuallySelectedRef.current) return;
    // A late live catalog may replace the fallback default, but never a
    // subsequent explicit model selection made by the user.
    setSessionModel(providerDefaultModel(agentType) ?? '');
  }, [agentType, type, sessionDynamicModels.defaultModel, sessionDynamicModels.models]);
  const sessionModelOptions = useMemo(() => {
    if (agentType === AGY_SDK_PROVIDER_ID && sessionDynamicModels.models.length > 0) {
      // The hook already supplies fallback options until a real catalog arrives.
      // Keep an explicit current selection visible, but do not append stale
      // hardcoded catalog entries to the provider's newer model list.
      return mergeModelSuggestions(
        [sessionModel, agentType === type ? initialSessionModel : null].filter((value): value is string => !!value),
        sessionDynamicModels.models.map((entry) => entry.id),
      );
    }
    const staticOptions = agentType === 'claude-code' || agentType === 'claude-code-sdk' || agentType === CLAUDE_CODE_CLI_SDK_AGENT_TYPE
      ? [...CLAUDE_CODE_MODEL_IDS]
      : agentType === 'codex' || agentType === 'codex-sdk'
        ? [...CODEX_MODEL_IDS]
        : agentType === 'qwen'
          ? getKnownQwenModelOptions().map((entry) => entry.id)
          : agentType === 'muse-code-sdk'
            ? ['muse-spark-1.3', 'muse-spark', 'muse-wonder', 'muse-fast', 'wander']
            : agentType === AGY_SDK_PROVIDER_ID
              ? [...AGY_MODEL_IDS]
              : [];
    return mergeModelSuggestions(
      [sessionModel, agentType === type ? initialSessionModel : null, sessionDynamicModels.defaultModel, ...staticOptions].filter((value): value is string => !!value),
      sessionDynamicModels.models.map((entry) => entry.id),
    );
  }, [agentType, type, initialSessionModel, sessionDynamicModels.defaultModel, sessionDynamicModels.models, sessionModel]);
  const sessionModelSwitchSupported = agentType === 'claude-code'
    || agentType === 'codex'
    || supportsDynamicTransportModels(agentType);
  const sessionModelDirty = sessionModel.trim() !== appliedSessionModel;

  const handleApplySessionModel = async (): Promise<void> => {
    if (!ws || !sessionModelSwitchSupported || !sessionModel.trim()) return;
    const nextModel = sessionModel.trim();
    setModelApplyState('applying');
    setModelApplyError('');
    setPendingSessionModel(nextModel);
    try {
      // Commit the applying state before the existing fire-and-forget runtime
      // command is dispatched, so slow mobile taps get deterministic feedback.
      await Promise.resolve();
      if (ws.connected === false) {
        throw new Error(t('session.modelSettings.disconnected'));
      }
      dispatchSessionModelSwitch({
        sendMessage: (text) => ws.sendSessionMessage(sessionName, text),
        setSubSessionModel: (targetSessionName, modelId, cwd) => ws.subSessionSetModel(targetSessionName, modelId, cwd),
      }, {
        sessionName,
        agentType: agentType,
        model: nextModel,
        cwd: initCwd,
        subSession: !!subSessionId,
      });
    } catch (err) {
      setPendingSessionModel(null);
      setModelApplyError(err instanceof Error ? err.message : String(err));
      setModelApplyState('error');
    }
  };

  const isSupportedTransport = TRANSPORT_SESSION_AGENT_TYPES.includes(agentType as typeof TRANSPORT_SESSION_AGENT_TYPES[number]);
  const supervisorDefaultsPref = useSupervisorDefaults(isSupportedTransport, {
    serverId,
    sessionName,
  });

  const defaultsScopeKey = isSupportedTransport ? `${serverId.trim()}\0${sessionName.trim()}` : '';
  const supervisorDefaultsLoadedOk = isSupportedTransport
    && supervisorDefaultsPref.loaded
    && !supervisorDefaultsPref.loading
    && supervisorDefaultsPref.error == null;
  const supervisorDefaultsPending = isSupportedTransport
    && (!supervisorDefaultsPref.loaded || supervisorDefaultsPref.loading);
  const supervisorDefaultsLoadFailed = isSupportedTransport
    && supervisorDefaultsPref.loaded
    && !supervisorDefaultsPref.loading
    && supervisorDefaultsPref.error != null;

  const authoritativeSupervisorDefaults = useMemo<SupervisionRuntimeDraft | null>(() => {
    if (!supervisorDefaultsLoadedOk) return null;
    return normalizeSupervisorDefaultConfig(supervisorDefaultsPref.value);
  }, [supervisorDefaultsLoadedOk, supervisorDefaultsPref.value]);

  const [editedExecutionPools, setEditedExecutionPools] = useState<{
    scopeKey: string;
    pools: SupervisionExecutionPoolsConfig;
  } | null>(null);

  useEffect(() => {
    setEditedExecutionPools((current) => (current?.scopeKey === defaultsScopeKey ? current : null));
    setError('');
  }, [defaultsScopeKey]);

  const activeEditedExecutionPools = editedExecutionPools?.scopeKey === defaultsScopeKey
    ? editedExecutionPools.pools
    : null;

  const updateExecutionPoolsFromUser = (executionPools: SupervisionExecutionPoolsConfig): void => {
    if (!canControlAutomaticSupervision) return;
    setEditedExecutionPools({ scopeKey: defaultsScopeKey, pools: executionPools });
  };

  const supervisionAuditBlockingSeverities = resolveSupervisionAuditBlockingSeverities(supervision);
  const toggleAuditBlockingSeverity = (level: AuditSeverity, checked: boolean): void => {
    if (!canControlAutomaticSupervision) return;
    setSupervision((prev) => {
      const current = resolveSupervisionAuditBlockingSeverities(prev);
      const next = checked
        ? [...current, level]
        : current.filter((item) => item !== level);
      // At least one blocking level must stay selected; the last one cannot be cleared.
      if (next.length === 0) return prev;
      return { ...prev, auditBlockingSeverities: normalizeAuditBlockingSeverities(next) };
    });
  };
  const executionPoolSessions = useMemo(() => {
    const merged = new Map(peerAuditSessions.map((session) => [session.sessionName, session]));
    for (const session of supervisorDefaultsPref.executionPoolSessions) {
      // The owner-authoritative catalog deliberately replaces a participant's
      // incomplete local projection of the same session.
      merged.set(session.sessionName, session);
    }
    return [...merged.values()];
  }, [peerAuditSessions, supervisorDefaultsPref.executionPoolSessions]);
  const executionPoolParentSession = parentSession?.trim()
    || supervisorDefaultsPref.executionPoolSessions[0]?.parentSession
    || null;
  const executionPoolCandidates = useMemo(() => buildSupervisionExecutionPoolCandidates({
    sessionName,
    parentSession: executionPoolParentSession,
    sessions: executionPoolSessions,
  }), [executionPoolParentSession, executionPoolSessions, sessionName]);
  const brainExecutionModel = resolvePeerAuditNormalizedModelId({ activeModel, requestedModel });
  const rawExecutionPools = activeEditedExecutionPools
    ?? authoritativeSupervisorDefaults?.executionPools
    ?? normalizeSupervisionExecutionPools(undefined);
  const supervisorDefaultsExecutionPools = useMemo(() => withBrainPrimaryPoolDefault({
    pools: rawExecutionPools,
    // A sub-session's model is not the Brain model and must never silently
    // become an account-wide primary-pool authorization.
    brainAgentType: parentSession ? '' : type,
    brainModel: brainExecutionModel,
  }), [brainExecutionModel, parentSession, rawExecutionPools, type]);

  const draftSupervisorDefaults = useMemo<SupervisionRuntimeDraft | null>(() => {
    if (!authoritativeSupervisorDefaults) return null;
    return {
      ...authoritativeSupervisorDefaults,
      executionPools: supervisorDefaultsExecutionPools,
    };
  }, [authoritativeSupervisorDefaults, supervisorDefaultsExecutionPools]);

  const nextTransportConfig = useMemo(() => {
    if (!canControlAutomaticSupervision) return transportConfig ?? null;
    // Strip legacy manual-auditor target fields while transparently preserving
    // hidden legacy snapshot fields (mode, pairEngine, runtime, limits, etc.).
    const {
      auditTargetSessionName: _legacyTarget,
      auditTargetFingerprint: _legacyFingerprint,
      peerAuditPromptVersion: _legacyPeerPrompt,
      auditMode: _legacyAuditMode,
      ...preservedSupervision
    } = supervision;
    // Never replace persisted session pools with an unhydrated fallback while
    // account defaults are still pending or failed and the user hasn't edited pools.
    const resolvedSessionExecutionPools = (activeEditedExecutionPools !== null || authoritativeSupervisorDefaults !== null)
      ? supervisorDefaultsExecutionPools
      : preservedSupervision.executionPools;
    return buildTransportConfigWithSupervision(transportConfig, {
      ...preservedSupervision,
      ...(resolvedSessionExecutionPools ? { executionPools: resolvedSessionExecutionPools } : {}),
      ...(supervision.auditBlockingSeverities !== undefined
        ? { auditBlockingSeverities: supervision.auditBlockingSeverities }
        : {}),
      // Marker-driven task-pair settings live on the project Brain only.
      ...(isMainSession
        ? pairSettingsOf(supervision)
        : { pairEngine: undefined, pairMaxConcurrency: undefined }),
    });
  }, [
    activeEditedExecutionPools,
    authoritativeSupervisorDefaults,
    canControlAutomaticSupervision,
    isMainSession,
    supervision,
    supervisorDefaultsExecutionPools,
    transportConfig,
  ]);

  const hasSessionChanges = useMemo(() => (
    (surface !== 'supervision' && (
      label !== initLabel
      || description !== initDesc
      || agentType !== type
    ))
    || (surface !== 'session'
      && JSON.stringify(nextTransportConfig ?? null) !== JSON.stringify(transportConfig ?? null))
  ), [
    agentType,
    description,
    initDesc,
    initLabel,
    label,
    nextTransportConfig,
    surface,
    transportConfig,
    type,
  ]);

  const hasGlobalDefaultsChanges = useMemo(() => {
    if (!authoritativeSupervisorDefaults || !draftSupervisorDefaults) return false;
    return JSON.stringify(draftSupervisorDefaults) !== JSON.stringify(authoritativeSupervisorDefaults);
  }, [authoritativeSupervisorDefaults, draftSupervisorDefaults]);

  const globalDefaultsSaveBlocked = isSupportedTransport
    && canControlAutomaticSupervision
    && surface !== 'session'
    && activeEditedExecutionPools !== null
    && !supervisorDefaultsLoadedOk;

  const hasChanges = hasSessionChanges
    || (surface !== 'session' && canControlAutomaticSupervision && hasGlobalDefaultsChanges);

  const renderTypeLabel = (value: string): string => {
    switch (value) {
      case 'claude-code-sdk': return t('session.agentType.claude_code_sdk');
      case CLAUDE_CODE_CLI_SDK_AGENT_TYPE: return t('session.agentType.cc_cli_sdk');
      case 'claude-code': return t('session.agentType.claude_code_cli');
      case 'codex-sdk': return t('session.agentType.codex_sdk');
      case 'qoder-sdk': return t('session.agentType.qoder_sdk');
      case 'codex': return t('session.agentType.codex_cli');
      case 'qwen': return t('session.agentType.qwen');
      case 'openclaw': return t('session.agentType.openclaw');
      case 'copilot-sdk': return t('session.agentType.copilot_sdk');
      case 'cursor-headless': return t('session.agentType.cursor_headless');
      case 'grok-sdk': return t('session.agentType.grok_sdk');
      case 'kimi-sdk': return t('session.agentType.kimi_sdk');
      case 'muse-code-sdk': return t('session.agentType.muse_code_sdk');
      case HERMES_AGENT_PROVIDER_ID: return t('session.agentType.hermes_agent');
      case AGY_SDK_PROVIDER_ID: return t('session.agentType.agy_sdk');
      case 'deepseek-harness': return t('session.agentType.deepseek_harness');
      case 'pi': return t('session.agentType.pi');
      case CODEBUDDY_PROVIDER_IDS.CHINA: return t('session.agentType.codebuddy_china');
      case CODEBUDDY_PROVIDER_IDS.INTERNATIONAL: return t('session.agentType.codebuddy_international');
      default: return value;
    }
  };

  const handleSave = async () => {
    if (globalDefaultsSaveBlocked) {
      setError(t('session.supervision.defaultsLoadFailed'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (canControlAutomaticSupervision && surface !== 'session' && hasGlobalDefaultsChanges) {
        if (!draftSupervisorDefaults) {
          throw new Error(t('session.supervision.defaultsLoadFailed'));
        }
        await supervisorDefaultsPref.save(draftSupervisorDefaults);
      }

      const providerChanged = surface === 'session' && agentType !== type;
      const nextProviderModel = providerChanged
        ? (providerModelManuallySelectedRef.current ? sessionModel.trim() || null : providerDefaultModel(agentType))
        : null;
      const fields: {
        label?: string | null;
        description?: string | null;
        cwd?: string | null;
        agentType?: string | null;
        type?: string | null;
        requestedModel?: string | null;
        activeModel?: string | null;
        transportConfig?: Record<string, unknown> | null;
      } = {};
      if (surface !== 'supervision') {
        if (label !== initLabel) fields.label = label || null;
        if (description !== initDesc) fields.description = description || null;
        if (providerChanged) {
          if (subSessionId) fields.type = agentType;
          else fields.agentType = agentType;
          fields.requestedModel = nextProviderModel;
          fields.activeModel = null;
        }
      }
      if (surface !== 'session' && JSON.stringify(nextTransportConfig ?? null) !== JSON.stringify(transportConfig ?? null)) {
        fields.transportConfig = nextTransportConfig;
      }

      if (Object.keys(fields).length === 0) {
        onClose();
        return;
      }

      if (subSessionId) {
        await patchSubSession(serverId, subSessionId, fields);
      } else {
        await patchSession(serverId, sessionName, fields);
      }
      onSaved({
        ...(surface !== 'supervision' ? {
          label: label || undefined,
          description: description || undefined,
          type: agentType || undefined,
          ...(providerChanged ? {
            requestedModel: nextProviderModel,
            activeModel: null,
            modelDisplay: null,
          } : {}),
        } : {}),
        ...(surface !== 'session' ? { transportConfig: nextTransportConfig } : {}),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const globalDefaultsValid = useMemo(() => {
    if (!isSupportedTransport) return true;
    return supervisorDefaultsExecutionPools.state === 'configured'
      && supervisorDefaultsExecutionPools.primaryDevelopmentPool.configs.length > 0;
  }, [isSupportedTransport, supervisorDefaultsExecutionPools]);

  const supervisionPanel = isSupportedTransport ? (
    <div class="session-settings-supervision-panel">
      <div class="session-settings-card session-settings-card-primary">
        <div class="session-settings-card-title">
          {t('session.supervision.globalDefaultsTitle')}
        </div>

        <SupervisionExecutionPoolsEditor
          t={t}
          saving={saving || !canControlAutomaticSupervision}
          pools={supervisorDefaultsExecutionPools}
          candidates={executionPoolCandidates}
          onAddPoolSession={onAddPoolSession}
          onChange={updateExecutionPoolsFromUser}
        />

        {canControlAutomaticSupervision && supervisorDefaultsLoadFailed && (
          <div style={{ color: '#fbbf24', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }} role="alert">
            <span>{t('session.supervision.defaultsLoadFailed')}</span>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={saving}
              onClick={() => { void supervisorDefaultsPref.reload().catch(() => undefined); }}
            >
              {t('common.refresh')}
            </button>
          </div>
        )}

        {canControlAutomaticSupervision && supervisorDefaultsPending && activeEditedExecutionPools !== null && (
          <div class="session-settings-field-help">{t('common.loading')}</div>
        )}

        {supervisorDefaultsExecutionPools.primaryDevelopmentPool.configs.length === 0 && (
          <div style={{ color: '#fbbf24', fontSize: 12 }}>
            {t('session.supervision.validation.modelRequired')}
          </div>
        )}
      </div>

      <div class="session-settings-card session-settings-card-session">
        <div class="session-settings-card-title">
          {t('session.supervision.sessionConfigTitle')}
        </div>

        {!canControlAutomaticSupervision ? (
          <div class="session-settings-field-help">{t('session.supervision.brainOnly')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div class="session-settings-audit-severities" data-testid="audit-blocking-severities">
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.auditBlockingSeverities')}</div>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>{t('session.supervision.auditBlockingSeveritiesHelp')}</div>
              {AUDIT_SEVERITY_LEVELS.map((level) => {
                const checked = supervisionAuditBlockingSeverities.includes(level);
                const lastSelected = checked && supervisionAuditBlockingSeverities.length === 1;
                return (
                  <label key={level} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>
                    <input
                      type="checkbox"
                      data-testid={`audit-blocking-severity-${level}`}
                      checked={checked}
                      disabled={saving || lastSelected}
                      title={lastSelected ? t('session.supervision.auditBlockingSeveritiesAtLeastOne') : undefined}
                      onChange={(e) => toggleAuditBlockingSeverity(level, (e.target as HTMLInputElement).checked)}
                    />
                    <span>
                      <strong>{level}</strong>{' '}
                      <span style={{ color: '#94a3b8' }} data-testid={`audit-blocking-severity-description-${level}`}>{t(`session.supervision.auditSeverity.${level}`)}</span>
                    </span>
                  </label>
                );
              })}
              <div
                data-testid="audit-non-finding-policy"
                style={{ marginTop: 8, padding: '8px 10px', borderRadius: 6, background: '#0f172a', color: '#94a3b8', fontSize: 11, lineHeight: 1.5 }}
              >
                <strong style={{ color: '#cbd5e1' }}>{t('session.supervision.auditNonFindingTitle')}</strong>
                <div>{t('session.supervision.auditNonFindingHelp')}</div>
              </div>
            </div>

            {isMainSession && (
              <TaskPairSettingsSection
                value={pairSettingsOf(supervision)}
                disabled={saving}
                onChange={(next) => setSupervision((prev) => ({
                  ...prev,
                  pairEngine: next.pairEngine,
                  pairMaxConcurrency: next.pairMaxConcurrency,
                }))}
              />
            )}
          </div>
        )}
      </div>

      {hasInvalidPersistedSupervision && (
        <div style={{ color: '#fbbf24', fontSize: 12 }}>
          {t('session.supervision.invalidStoredConfig')}
        </div>
      )}
    </div>
  ) : (
    <div style={{ color: '#fca5a5', fontSize: 12 }}>
      {t('session.supervision.unsupported')}
    </div>
  );

  const supervisionValid = useMemo(() => {
    if (!isSupportedTransport) return true;
    return globalDefaultsValid;
  }, [globalDefaultsValid, isSupportedTransport]);

  const dialog = (
    <div class={`dialog-overlay session-settings-overlay${poolSessionDialogOpen ? ' has-child-dialog' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog session-settings-dialog">
        <div class="dialog-header session-settings-header">
          <span class="session-settings-title">
            {surface === 'supervision' ? t('session.supervision.settingsTitle') : t('session.settings')}
          </span>
          <button
            type="button"
            class="dialog-close session-settings-close"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div class="dialog-body session-settings-body">
          {surface !== 'supervision' && <>
          {/* Type */}
          <div class="session-settings-field">
            <div class="session-settings-label">{t('session.type')}</div>
            <select
              class="input"
              data-testid="session-agent-type"
              value={agentType}
              onInput={(e) => setAgentType((e.target as HTMLSelectElement).value as SessionAgentType)}
              onChange={(e) => setAgentType((e.target as HTMLSelectElement).value as SessionAgentType)}
              style={{ width: '100%' }}
              disabled={saving}
            >
              {SESSION_AGENT_TYPES.map((value) => (
                <option key={value} value={value}>{renderTypeLabel(value)}</option>
              ))}
            </select>
          </div>

          {/* Parent session (read-only, sub-session only) */}
          {parentSession && (
            <div class="session-settings-field">
              <div class="session-settings-label">{t('session.parentSession')}</div>
              <div class="session-settings-readonly">{parentSession}</div>
            </div>
          )}

          {/* Label */}
          <div class="session-settings-field">
            <div class="session-settings-label">{t('session.label')}</div>
            <input
              class="input"
              value={label}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              style={{ width: '100%' }}
              disabled={saving}
            />
          </div>

          {/* Description */}
          <div class="session-settings-field">
            <div class="session-settings-label">{t('session.description')}</div>
            <textarea
              class="input"
              value={description}
              onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
              rows={3}
              style={{ width: '100%', resize: 'vertical' }}
              disabled={saving}
              placeholder={t('session.descriptionPlaceholder')}
            />
          </div>

          <SessionIdentityTabs
            serverId={serverId}
            sessionName={sessionName}
            projectKey={projectKey}
            pairTaskId={pairTaskId}
            ws={ws}
            disabled={saving}
          />

          <div class="session-settings-field" data-testid="session-model-settings">
            <div class="session-settings-label">{t('session.modelSettings.label')}</div>
            <div class="session-settings-help">{t('session.modelSettings.help')}</div>
            {sessionModelSwitchSupported ? (
              <>
                <select
                  class="input"
                  aria-label={t('session.modelSettings.label')}
                  value={sessionModel}
                  disabled={saving || modelApplyState === 'applying'}
                  onInput={(event) => {
                    providerModelManuallySelectedRef.current = true;
                    setSessionModel((event.target as HTMLSelectElement).value);
                    setModelApplyState('idle');
                    setModelApplyError('');
                  }}
                  style={{ width: '100%' }}
                >
                  {!sessionModel && <option value="">{t('session.modelSettings.default')}</option>}
                  {sessionModelOptions.map((modelId) => (
                    <option key={modelId} value={modelId}>{modelId}</option>
                  ))}
                </select>
                <div class="session-settings-model-actions">
                  <span class="session-settings-field-help">
                    {t('session.modelSettings.current', {
                      model: appliedSessionModel || t('session.modelSettings.default'),
                    })}
                  </span>
                  <button
                    type="button"
                    class="btn btn-secondary"
                    onClick={() => { void handleApplySessionModel(); }}
                    disabled={!ws || agentType !== type || !sessionModelDirty || !sessionModel.trim() || modelApplyState === 'applying'}
                  >
                    {modelApplyState === 'applying'
                      ? t('session.modelSettings.applying')
                      : t('session.modelSettings.apply')}
                  </button>
                </div>
                {sessionDynamicModels.loading && (
                  <div class="session-settings-field-help">{t('session.modelSettings.loading')}</div>
                )}
                {modelApplyState === 'applied' && (
                  <div class="session-settings-success" role="status">{t('session.modelSettings.applied')}</div>
                )}
                {modelApplyState === 'error' && (
                  <div class="session-settings-error" role="alert">
                    {t('session.modelSettings.failed', { error: modelApplyError })}
                  </div>
                )}
              </>
            ) : (
              <div class="session-settings-notice">{t('session.modelSettings.unsupported')}</div>
            )}
          </div>

          {/* Working directory */}
          <div class="session-settings-field">
            <div class="session-settings-label">{t('session.workingDir')}</div>
            <input
              class="input"
              value={initCwd}
              style={{ width: '100%', opacity: 0.7, cursor: 'not-allowed' }}
              disabled
              readOnly
              placeholder={t('session.workingDirPlaceholder')}
            />
          </div>
          </>}

          {surface !== 'session' && <div class="session-settings-section">
            <div class="session-settings-section-title">{t('session.supervision.title')}</div>
            {supervisionPanel}
          </div>}

          {error && <div class="session-settings-error">{error}</div>}
        </div>

        <div class="dialog-footer session-settings-footer">
          <button type="button" class="btn btn-secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          <button type="button" class="btn btn-primary" onClick={handleSave} disabled={saving || !hasChanges || (surface !== 'session' && (!supervisionValid || !globalDefaultsValid || globalDefaultsSaveBlocked))}>
            {saving ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

type SupervisionSettingsDialogProps = Omit<Props, 'surface'> & { surface?: 'supervision' };

export function SupervisionSettingsDialog({ surface: _surface, ...props }: SupervisionSettingsDialogProps) {
  return <SessionSettingsDialog {...props} surface="supervision" />;
}
