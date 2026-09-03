/**
 * SessionSettingsDialog — edit metadata and view cwd for main or sub sessions.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import { patchSession, patchSubSession } from '../api.js';
import { useSupervisorDefaults } from '../hooks/useSupervisorDefaults.js';
import { supportsDynamicTransportModels, useTransportModels } from '../hooks/useTransportModels.js';
import type { WsClient } from '../ws-client.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { SESSION_AGENT_TYPES, TRANSPORT_SESSION_AGENT_TYPES, getSessionRuntimeType, type SessionAgentType } from '@shared/agent-types.js';
import { CODEBUDDY_PROVIDER_IDS } from '@shared/codebuddy.js';
import { HERMES_AGENT_PROVIDER_ID } from '@shared/hermes-agent.js';
import { isDelegationReplyCapableAgentType } from '@shared/agent-delegation.js';
import type { SharedContextRuntimeBackend } from '@shared/context-types.js';
import {
  doesSharedContextBackendSupportPresets,
  isKnownSharedContextModelForBackend,
  normalizeSharedContextRuntimeBackend,
} from '@shared/shared-context-runtime-config.js';
import {
  CC_PRESET_MSG,
  getCcPresetAvailableModelIds,
} from '@shared/cc-presets.js';
import {
  DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK,
  DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL,
  buildTransportConfigWithSupervision,
  DEFAULT_SUPERVISION_MAX_AUDIT_LOOPS,
  DEFAULT_SUPERVISION_MAX_PARSE_RETRIES,
  DEFAULT_SUPERVISION_TIMEOUT_MS,
  getSupportedSupervisionBackendOptions,
  getSupervisionModelOptions,
  hasInvalidSessionSupervisionSnapshot,
  isSupportedSupervisionBackend,
  mergeSupervisionCustomInstructions,
  normalizeSupervisorDefaultConfig,
  readSupervisionSnapshotFromTransportConfig,
  resolveSupervisionModelForBackend,
  SUPERVISION_PROMPT_VERSION,
  SUPERVISION_REPAIR_PROMPT_VERSION,
  SUPERVISION_MODE,
  SUPERVISION_MODES,
  SUPERVISION_MIN_TIMEOUT_MS,
  TASK_RUN_PROMPT_VERSION,
  type SupervisionMode,
} from '@shared/supervision-config.js';
import {
  buildSupervisionExecutionCapabilityId,
  isExcludedDevelopmentModel,
  normalizeSupervisionExecutionModel,
  normalizeSupervisionExecutionPools,
  type SupervisionExecutionConfig,
  type SupervisionExecutionPoolKind,
  type SupervisionExecutionPoolsConfig,
} from '@shared/supervision-execution-pool.js';
import {
  PEER_AUDIT_CANDIDATE_REASONS,
  PEER_AUDIT_PROMPT_VERSION,
  PEER_AUDIT_UNKNOWN_IDENTITY,
  resolvePeerAuditNormalizedModelId,
  resolvePeerAuditProviderFamily,
  type PeerAuditCandidate,
} from '@shared/peer-audit.js';
import { peerAuditCandidateDisplayLabel, peerAuditProviderTypeLabel } from '../peerAudit/types.js';
import {
  type SessionSettingsOpenIntent,
} from '../session-settings-open-intent.js';
import {
  RuntimeModelPresetSelector,
  type RuntimeModelPresetEntry,
} from './RuntimeModelPresetSelector.js';
import { mergeModelSuggestions } from '../../../src/shared/models/options.js';

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
  sessionInstanceId?: string;
  runtimeEpoch?: string;
  activeModel?: string | null;
  requestedModel?: string | null;
  providerId?: string | null;
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
  /**
   * Optional WebSocket client. When supplied, the supervision dialog subscribes
   * to `cc.presets.list_response` and adds compatible third-party presets to
   * the shared runtime selector. When absent, built-in model selection remains
   * available and only the preset row is omitted.
   */
  ws?: WsClient | null;
  onClose: () => void;
  onSaved: (fields: { label?: string; description?: string; cwd?: string; type?: string; transportConfig?: Record<string, unknown> | null }) => void;
}

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

export type PeerAuditSettingsCandidate = PeerAuditCandidate;

export function buildPeerAuditSettingsCandidates(input: {
  auditedSessionName: string;
  parentSession?: string | null;
  sessions: readonly PeerAuditSettingsSession[];
}): PeerAuditSettingsCandidate[] {
  const owningMainSession = input.parentSession?.trim() || input.auditedSessionName;
  const seen = new Set<string>();
  const candidates: PeerAuditSettingsCandidate[] = [];

  for (const session of input.sessions) {
    if (session.sessionName === input.auditedSessionName
      || session.parentSession !== owningMainSession
      || seen.has(session.sessionName)
      || !isDelegationReplyCapableAgentType(session.type)) {
      continue;
    }
    seen.add(session.sessionName);

    const sessionInstanceId = session.sessionInstanceId?.trim();
    const runtimeEpoch = session.runtimeEpoch?.trim();
    const knownModelIds = [session.activeModel, session.requestedModel, session.modelDisplay]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    const normalizedModelId = resolvePeerAuditNormalizedModelId({
      activeModel: session.activeModel,
      requestedModel: session.requestedModel,
      configuredModel: session.modelDisplay,
    }, { knownModelIds });
    const providerFamily = resolvePeerAuditProviderFamily({
      providerId: session.providerId,
      agentType: session.type,
    });
    const runtimeType = session.runtimeType ?? getSessionRuntimeType(session.type);
    candidates.push({
      name: session.sessionName,
      label: session.label?.trim()
        || (providerFamily === PEER_AUDIT_UNKNOWN_IDENTITY
          ? session.type
          : peerAuditProviderTypeLabel(providerFamily)),
      // Candidate identity is presentation-only in settings. Automatic audit
      // persists the selected session name and resolves the live target when
      // the audit starts, exactly like ordinary reply-enabled delegation.
      sessionInstanceId: sessionInstanceId || session.sessionName,
      runtimeEpoch: runtimeEpoch || session.sessionName,
      normalizedModelId,
      providerFamily,
      liveState: session.state ?? PEER_AUDIT_UNKNOWN_IDENTITY,
      dispositionCapability: runtimeType === 'process'
        ? 'sent_unrevocable'
        : session.state === 'idle' ? 'sent' : 'queued',
      eligible: true,
      reason: PEER_AUDIT_CANDIDATE_REASONS.ELIGIBLE,
    });
  }

  return candidates.sort((left, right) => left.label.localeCompare(right.label)
    || left.normalizedModelId.localeCompare(right.normalizedModelId)
    || left.name.localeCompare(right.name));
}

type SupervisionDraft = {
  mode: SupervisionMode;
  backend?: SharedContextRuntimeBackend;
  model?: string;
  /**
   * Optional preset name — only meaningful when
   * `doesSharedContextBackendSupportPresets(backend)` returns true. The daemon broker routes the supervisor session
   * through the preset's env bundle when set.
   */
  preset?: string;
  timeoutMs?: number;
  promptVersion?: string;
  customInstructions?: string;
  /**
   * Session-level switch. When `true`, only the session `customInstructions`
   * is sent to the supervisor; the global value is ignored for this session.
   * When `false` (or missing), the daemon merges global + session.
   */
  customInstructionsOverride?: boolean;
  maxParseRetries?: number;
  maxAutoContinueStreak?: number;
  maxAutoContinueTotal?: number;
  auditTargetSessionName?: string;
  auditTargetFingerprint?: {
    sessionInstanceId: string;
    normalizedModelId: string;
    providerFamily: string;
  };
  peerAuditPromptVersion?: string;
  maxAuditLoops?: number;
  taskRunPromptVersion?: string;
};

// Account-level automatic-supervision runtime. Sessions can still customize
// mode, audit target, limits and instructions, but never own a separate model.
type SupervisionRuntimeDraft = Pick<
  SupervisionDraft,
  'backend' | 'model' | 'preset' | 'timeoutMs' | 'promptVersion' | 'customInstructions' | 'maxAutoContinueStreak' | 'maxAutoContinueTotal'
> & {
  backupBackend?: SharedContextRuntimeBackend;
  backupModel?: string;
  backupPreset?: string;
  executionPools?: SupervisionExecutionPoolsConfig;
};

type CcPresetSummary = RuntimeModelPresetEntry;

function timeoutMsToUiSeconds(timeoutMs: number | undefined): number {
  const safeMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
    ? Math.max(timeoutMs, SUPERVISION_MIN_TIMEOUT_MS)
    : DEFAULT_SUPERVISION_TIMEOUT_MS;
  return Math.round(safeMs / 1000);
}

function timeoutUiSecondsToMs(seconds: number): number {
  return Math.max(SUPERVISION_MIN_TIMEOUT_MS, Math.round(seconds) * 1000);
}

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

function labelForMode(t: (key: string, params?: Record<string, unknown>) => string, mode: SupervisionMode): string {
  return t(`session.supervision.mode.${mode}`);
}

function normalizeBackendValue(value: string): SharedContextRuntimeBackend | '' {
  return isSupportedSupervisionBackend(value) ? value : '';
}

// localStorage key tracking whether the per-user has hidden the intro block.
// The intro card summarizes how Auto supervision works across three short
// paragraphs; users who already understand it asked to hide it by default,
// and we persist the choice across sessions so the dialog reopens small.
const SUPERVISION_INTRO_COLLAPSED_KEY = 'imcodes:supervision-intro-collapsed';

function readIntroCollapsedPref(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(SUPERVISION_INTRO_COLLAPSED_KEY);
    // Default to collapsed on first open — the intro block is long and most
    // users will only need it once. They can expand it any time.
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

function writeIntroCollapsedPref(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SUPERVISION_INTRO_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // storage unavailable (private mode / quota) — fall through; UI still works,
    // state just won't persist across reloads.
  }
}

function SupervisionIntroCard({ t }: { t: (key: string, params?: Record<string, unknown>) => string }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => readIntroCollapsedPref());

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      writeIntroCollapsedPref(next);
      return next;
    });
  };

  const sections = [
    {
      title: t('session.supervision.intro.howToUseTitle'),
      body: t('session.supervision.intro.howToUseBody'),
    },
    {
      title: t('session.supervision.intro.purposeTitle'),
      body: t('session.supervision.intro.purposeBody'),
    },
    {
      title: t('session.supervision.intro.howItWorksTitle'),
      body: t('session.supervision.intro.howItWorksBody'),
    },
  ];

  return (
    <div class={`session-settings-intro${collapsed ? ' is-collapsed' : ''}`}>
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        aria-controls="supervision-intro-body"
        data-testid="supervision-intro-toggle"
        class="session-settings-intro-toggle"
      >
        <span
          aria-hidden="true"
          class="session-settings-intro-arrow"
        >
          ▾
        </span>
        <span class="session-settings-intro-title">{t('session.supervision.intro.title')}</span>
        <span class="session-settings-intro-hint">
          {t(collapsed ? 'session.supervision.intro.expandHint' : 'session.supervision.intro.collapseHint')}
        </span>
      </button>
      {!collapsed && (
        <div id="supervision-intro-body" class="session-settings-intro-body">
          {sections.map((section) => (
            <div key={section.title} class="session-settings-intro-item">
              <div class="session-settings-intro-item-title">{section.title}</div>
              <div class="session-settings-intro-item-body">{section.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function getPresetModelOptions(
  presets: readonly CcPresetSummary[],
  presetName: string | undefined,
): string[] {
  if (!presetName) return [];
  const target = presetName.trim().toLowerCase();
  if (!target) return [];
  const match = presets.find((p) => p.name.trim().toLowerCase() === target);
  if (!match) return [];
  return getCcPresetAvailableModelIds(match);
}

function resolvePresetModel(
  presets: readonly CcPresetSummary[],
  presetName: string | undefined,
  currentModel: string | undefined,
): string | undefined {
  const options = getPresetModelOptions(presets, presetName);
  if (options.length === 0) return undefined;
  const current = currentModel?.trim();
  return current && options.includes(current) ? current : options[0];
}

function SupervisionRuntimeFields({
  t,
  saving,
  backend,
  model,
  preset,
  presets,
  timeoutSeconds,
  modelOptions,
  idPrefix,
  onBackendChange,
  onModelChange,
  onRuntimeChange,
  onTimeoutChange,
}: {
  t: (key: string, params?: Record<string, unknown>) => string;
  saving: boolean;
  backend: SharedContextRuntimeBackend | '';
  model: string;
  preset: string;
  presets: readonly CcPresetSummary[];
  timeoutSeconds?: number;
  modelOptions: readonly string[];
  idPrefix: string;
  onBackendChange: (backend: string) => void;
  onModelChange: (model: string) => void;
  onRuntimeChange: (next: { model: string; preset: string }) => void;
  onTimeoutChange?: (seconds: number) => void;
}) {
  const handleBackendSelect = (e: Event): void => {
    onBackendChange((e.target as HTMLSelectElement).value);
  };
  return (
    <div class="supervision-runtime-fields">
      <div class="supervision-runtime-grid" style={{ gridTemplateColumns: backend === 'openclaw' ? `repeat(${onTimeoutChange ? 3 : 2}, minmax(0, 1fr))` : `repeat(${onTimeoutChange ? 2 : 1}, minmax(0, 1fr))` }}>
        <div class="session-settings-field">
          <div class="session-settings-label">{t('session.supervision.backend')}</div>
          <select
            class="input"
            aria-label={`${idPrefix}:backend`}
            value={backend}
            onInput={handleBackendSelect}
            onChange={handleBackendSelect}
            style={{ width: '100%' }}
            disabled={saving}
          >
            <option value="">{t('session.supervision.selectBackend')}</option>
            {getSupportedSupervisionBackendOptions().map((option) => (
              <option key={option} value={option}>{labelForBackend(t, option)}</option>
            ))}
          </select>
        </div>

        {backend === 'openclaw' && (
          <div class="session-settings-field">
            <div class="session-settings-label">{t('session.supervision.model')}</div>
          <input
            class="input"
            aria-label={`${idPrefix}:model`}
            value={model}
            onInput={(e) => onModelChange((e.target as HTMLInputElement).value)}
            style={{ width: '100%' }}
            disabled={saving}
            placeholder={t('session.supervision.selectModel')}
          />
          </div>
        )}

        {onTimeoutChange && timeoutSeconds != null && <div class="session-settings-field">
          <div class="session-settings-label">{t('session.supervision.timeout')}</div>
          <input
            class="input"
            aria-label={`${idPrefix}:timeout`}
            type="number"
            min={SUPERVISION_MIN_TIMEOUT_MS / 1000}
            step={1}
            value={String(timeoutSeconds)}
            onInput={(e) => {
              const value = Number.parseInt((e.target as HTMLInputElement).value, 10);
              onTimeoutChange(
                Number.isFinite(value)
                  ? Math.max(value, SUPERVISION_MIN_TIMEOUT_MS / 1000)
                  : timeoutSeconds,
              );
            }}
            style={{ width: '100%' }}
            disabled={saving}
          />
        </div>}
      </div>

      {backend && backend !== 'openclaw' && (
        <RuntimeModelPresetSelector
          backend={backend}
          model={model}
          preset={preset}
          presets={presets}
          modelOptions={modelOptions}
          onChange={onRuntimeChange}
          idPrefix={idPrefix}
          disabled={saving}
        />
      )}
    </div>
  );
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
  if (!selectedPool.configs.some((item) => item.capabilityId === config.capabilityId)) {
    (pool === 'primary' ? primary : economy).push(config);
  }
  return {
    ...pools,
    state: 'configured',
    primaryDevelopmentPool: { ...pools.primaryDevelopmentPool, configs: primary },
    economyTaskPool: { ...pools.economyTaskPool, configs: economy },
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
            </label>
          ))}
        </div>
      </div>
    );
  };
  return <>{renderPool('primary')}{renderPool('economy')}</>;
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
  activeModel,
  requestedModel,
  peerAuditSessions = [],
  onAddPoolSession,
  poolSessionDialogOpen = false,
  parentSession,
  canControlAutomaticSupervision = false,
  openIntent,
  ws,
  onClose,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const hasPersistedSupervision = useMemo(() => !!(transportConfig && typeof transportConfig === 'object' && transportConfig.supervision), [transportConfig]);
  const hasInvalidPersistedSupervision = useMemo(
    () => hasInvalidSessionSupervisionSnapshot(transportConfig),
    [transportConfig],
  );
  const initialSupervision = useMemo<SupervisionDraft>(() => {
    const persisted: SupervisionDraft = hasPersistedSupervision
      ? readSupervisionSnapshotFromTransportConfig(transportConfig)
      : { mode: 'off' as const };
    if (!canControlAutomaticSupervision) return { ...persisted, mode: SUPERVISION_MODE.OFF };
    if (!openIntent?.supervisionMode) return persisted;
    if (openIntent.supervisionMode === 'off' || (persisted.backend && persisted.model)) {
      return { ...persisted, mode: openIntent.supervisionMode };
    }
    // Quick-open must be usable before the async user-pref request resolves.
    // Seed the same canonical fallback used by the daemon so Save is never
    // held hostage by a slow/offline preference request.
    const immediateDefaults = normalizeSupervisorDefaultConfig(
      isSupportedSupervisionBackend(type) ? { backend: type } : null,
    );
    return {
      ...immediateDefaults,
      ...persisted,
      mode: openIntent.supervisionMode,
    };
  }, [canControlAutomaticSupervision, hasPersistedSupervision, openIntent?.supervisionMode, transportConfig, type]);

  const [label, setLabel] = useState(initLabel);
  const [description, setDescription] = useState(initDesc);
  const [agentType, setAgentType] = useState(type);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [supervision, setSupervision] = useState<SupervisionDraft>(initialSupervision);
  const [peerAuditTargetName, setPeerAuditTargetName] = useState<string | null>(
    initialSupervision.auditTargetSessionName ?? null,
  );
  const ccPresetListRequestIdRef = useRef<string | null>(null);
  const [supervisorDefaults, setSupervisorDefaults] = useState<SupervisionRuntimeDraft>(() => normalizeSupervisorDefaultConfig(null));
  const [initialSupervisorDefaults, setInitialSupervisorDefaults] = useState<SupervisionRuntimeDraft>(() => normalizeSupervisorDefaultConfig(null));
  const supervisorDefaultsDirtyRef = useRef(false);
  // Qwen presets (env bundles) fetched from the daemon via the same
  // `cc.presets.list` WS channel the Shared Context panel uses. Stays empty
  // when `ws` is not provided — the picker hides itself in that case.
  const [ccPresets, setCcPresets] = useState<CcPresetSummary[]>([]);

  useEffect(() => {
    setLabel(initLabel);
    setDescription(initDesc);
    setAgentType(type);
    setSupervision(initialSupervision);
    setPeerAuditTargetName(initialSupervision.auditTargetSessionName ?? null);
  }, [initLabel, initDesc, initCwd, type, initialSupervision, sessionName, subSessionId]);

  const hasSupervision = supervision.mode !== 'off';
  const isSupportedTransport = TRANSPORT_SESSION_AGENT_TYPES.includes(agentType as typeof TRANSPORT_SESSION_AGENT_TYPES[number]);
  const isAuditMode = supervision.mode === 'supervised_audit';
  const supervisorDefaultsPref = useSupervisorDefaults(isSupportedTransport, {
    serverId,
    sessionName,
  });


  // Subscribe to `cc.presets.list_response` for as long as the dialog is
  // mounted with a valid `ws`. We fire the list request once on mount and
  // again whenever `ws` changes — the daemon response is idempotent.
  useEffect(() => {
    if (!ws) return;
    // A dialog can move between covered sessions without remounting. Presets
    // are owner-machine data, so never retain the previous owner's catalogue
    // while the new scoped request is in flight (or if it is denied).
    setCcPresets([]);
    const requestPresets = (): void => {
      const requestId = globalThis.crypto?.randomUUID?.()
        ?? `cc-presets-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      ccPresetListRequestIdRef.current = requestId;
      // A reconnect can race this effect. Keep the settings dialog usable and
      // let the next RECONNECTED notification retry instead of turning a
      // transient transport failure into a render-time exception.
      try {
        ws.send({
          type: CC_PRESET_MSG.LIST,
          requestId,
          sessionName,
        });
      } catch {
        // Retry is driven by the reconnect notification above.
      }
    };
    const unsub = ws.onMessage((msg) => {
      const m = msg as { type?: string; requestId?: string; presets?: CcPresetSummary[] };
      if (m.type === DAEMON_MSG.RECONNECTED) {
        requestPresets();
        return;
      }
      if (
        m.type === CC_PRESET_MSG.LIST_RESPONSE
        && (!m.requestId || m.requestId === ccPresetListRequestIdRef.current)
      ) {
        setCcPresets(m.presets ?? []);
      }
    });
    requestPresets();
    return unsub;
  }, [sessionName, ws]);

  useEffect(() => {
    if (ccPresets.length === 0) return;
    if (supervisorDefaultsDirtyRef.current) return;
    setSupervisorDefaults((prev) => {
      const backend = normalizeBackendValue(String(prev.backend ?? ''));
      if (!backend || !doesSharedContextBackendSupportPresets(backend) || !prev.preset) return prev;
      const resolvedModel = resolvePresetModel(ccPresets, prev.preset, prev.model);
      if (!resolvedModel || prev.model === resolvedModel) return prev;
      return { ...prev, model: resolvedModel };
    });
    setSupervisorDefaults((prev) => {
      const backend = normalizeBackendValue(String(prev.backupBackend ?? ''));
      if (!backend || !doesSharedContextBackendSupportPresets(backend) || !prev.backupPreset) return prev;
      const resolvedModel = resolvePresetModel(ccPresets, prev.backupPreset, prev.backupModel);
      if (!resolvedModel || prev.backupModel === resolvedModel) return prev;
      return { ...prev, backupModel: resolvedModel };
    });
  }, [
    ccPresets,
    supervisorDefaults.backend,
    supervisorDefaults.model,
    supervisorDefaults.preset,
    supervisorDefaults.backupBackend,
    supervisorDefaults.backupModel,
    supervisorDefaults.backupPreset,
  ]);

  useEffect(() => {
    if (!isSupportedTransport) return;
    if (!supervisorDefaultsPref.loaded) return;
    const resolvedDefaults = normalizeSupervisorDefaultConfig(supervisorDefaultsPref.value);
    setInitialSupervisorDefaults(resolvedDefaults);
    if (!supervisorDefaultsDirtyRef.current) {
      setSupervisorDefaults(resolvedDefaults);
    }
    setSupervision((prev) => {
      const missingBackend = !prev.backend;
      const missingModel = !prev.model?.trim();
      if (!missingBackend && !missingModel) return prev;
      const nextBackend = prev.backend ?? resolvedDefaults.backend;
      const nextModel = missingModel
        ? (nextBackend === resolvedDefaults.backend
            ? resolvedDefaults.model
            : resolveSupervisionModelForBackend(nextBackend, '', prev.backend))
        : prev.model;
      const shouldSeedAutoContinueStreak = prev.maxAutoContinueStreak == null
        || prev.maxAutoContinueStreak === DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK;
      const shouldSeedAutoContinueTotal = prev.maxAutoContinueTotal == null
        || prev.maxAutoContinueTotal === DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL;
      return {
        ...prev,
        backend: nextBackend,
        model: nextModel,
        // Seed preset from defaults when the backend supports it. If the
        // backend doesn't support presets the normalizer already stripped
        // it, so copying is safe either way.
        preset: prev.preset ?? (nextBackend === resolvedDefaults.backend ? resolvedDefaults.preset : undefined),
        timeoutMs: resolvedDefaults.timeoutMs,
        promptVersion: resolvedDefaults.promptVersion,
        maxAutoContinueStreak: shouldSeedAutoContinueStreak
          ? resolvedDefaults.maxAutoContinueStreak
          : prev.maxAutoContinueStreak,
        maxAutoContinueTotal: shouldSeedAutoContinueTotal
          ? resolvedDefaults.maxAutoContinueTotal
          : prev.maxAutoContinueTotal,
        maxParseRetries: prev.maxParseRetries ?? DEFAULT_SUPERVISION_MAX_PARSE_RETRIES,
        maxAuditLoops: prev.maxAuditLoops ?? DEFAULT_SUPERVISION_MAX_AUDIT_LOOPS,
        taskRunPromptVersion: prev.taskRunPromptVersion ?? TASK_RUN_PROMPT_VERSION,
      };
    });
  }, [isSupportedTransport, supervisorDefaultsPref.loaded, supervisorDefaultsPref.value]);

  const updateSupervisorDefaultsFromUser = (updater: (prev: SupervisionRuntimeDraft) => SupervisionRuntimeDraft): void => {
    supervisorDefaultsDirtyRef.current = true;
    setSupervisorDefaults(updater);
  };

  const supervisionCustomInstructions = typeof supervision.customInstructions === 'string' ? supervision.customInstructions : '';
  const supervisionCustomInstructionsOverride = supervision.customInstructionsOverride === true;
  const supervisionParseRetries = supervision.maxParseRetries ?? DEFAULT_SUPERVISION_MAX_PARSE_RETRIES;
  const supervisionAutoContinueStreak = supervision.maxAutoContinueStreak ?? DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK;
  const supervisionAutoContinueTotal = supervision.maxAutoContinueTotal ?? DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL;
  const supervisionAuditLoops = supervision.maxAuditLoops ?? DEFAULT_SUPERVISION_MAX_AUDIT_LOOPS;
  const loadedPeerAuditCandidates = useMemo(() => buildPeerAuditSettingsCandidates({
    auditedSessionName: sessionName,
    parentSession,
    sessions: peerAuditSessions,
  }), [parentSession, peerAuditSessions, sessionName]);
  const peerAuditCandidates = loadedPeerAuditCandidates;
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
  const selectedPeerAuditCandidate = peerAuditCandidates.find((candidate) => candidate.name === peerAuditTargetName);
  const selectedPeerAuditDisplayLabel = selectedPeerAuditCandidate
    ? peerAuditCandidateDisplayLabel(selectedPeerAuditCandidate)
    : null;
  const selectedPeerAuditTypeLabel = selectedPeerAuditCandidate
    ? peerAuditProviderTypeLabel(selectedPeerAuditCandidate.providerFamily)
    : null;
  const selectedPeerAuditVisibleIdentity = selectedPeerAuditCandidate
    ? [
      selectedPeerAuditTypeLabel,
      selectedPeerAuditDisplayLabel !== selectedPeerAuditTypeLabel ? selectedPeerAuditDisplayLabel : null,
      selectedPeerAuditCandidate.normalizedModelId,
    ].filter(Boolean).join(' · ')
    : null;
  const taskRunPromptVersion = supervision.taskRunPromptVersion ?? TASK_RUN_PROMPT_VERSION;
  const supervisorDefaultsBackend = normalizeBackendValue(String(supervisorDefaults.backend ?? ''));
  const supervisorDefaultsModel = typeof supervisorDefaults.model === 'string' ? supervisorDefaults.model : '';
  const supervisorDefaultsPreset = typeof supervisorDefaults.preset === 'string' ? supervisorDefaults.preset : '';
  const supervisorDefaultsTimeout = supervisorDefaults.timeoutMs ?? DEFAULT_SUPERVISION_TIMEOUT_MS;
  const supervisorDefaultsTimeoutSeconds = timeoutMsToUiSeconds(supervisorDefaultsTimeout);
  const supervisorDefaultsPromptVersion = supervisorDefaults.promptVersion ?? SUPERVISION_PROMPT_VERSION;
  const supervisorDefaultsPresetEntry = ccPresets.find((p) => p.name === (typeof supervisorDefaults.preset === 'string' ? supervisorDefaults.preset.trim() : ''));
  const supervisorDefaultsPresetModelOptions = getPresetModelOptions(ccPresets, supervisorDefaults.preset);
  const supervisorDefaultsDynamicModels = useTransportModels(
    ws ?? null,
    supportsDynamicTransportModels(supervisorDefaultsBackend)
      ? supervisorDefaultsBackend
      : null,
    supervisorDefaultsPreset || undefined,
    sessionName,
  );
  const supervisorDefaultsModelOptions = supervisorDefaultsBackend
    ? (supervisorDefaultsPresetEntry
        ? mergeModelSuggestions(
            supervisorDefaultsPresetModelOptions,
            supervisorDefaultsDynamicModels.models.map((entry) => entry.id),
          )
        : mergeModelSuggestions(
            supervisorDefaultsDynamicModels.models.map((entry) => entry.id),
            getSupervisionModelOptions(supervisorDefaultsBackend),
          ))
    : [];
  const supervisorDefaultsCustomInstructions = typeof supervisorDefaults.customInstructions === 'string' ? supervisorDefaults.customInstructions : '';
  const supervisorDefaultsAutoContinueStreak = supervisorDefaults.maxAutoContinueStreak ?? DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK;
  const supervisorDefaultsAutoContinueTotal = supervisorDefaults.maxAutoContinueTotal ?? DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL;
  const supervisorDefaultsBackupBackend = normalizeBackendValue(String(supervisorDefaults.backupBackend ?? ''));
  const supervisorDefaultsBackupModel = typeof supervisorDefaults.backupModel === 'string' ? supervisorDefaults.backupModel : '';
  const supervisorDefaultsBackupPreset = typeof supervisorDefaults.backupPreset === 'string' ? supervisorDefaults.backupPreset : '';
  const brainExecutionModel = resolvePeerAuditNormalizedModelId({ activeModel, requestedModel });
  const supervisorDefaultsExecutionPools = useMemo(() => withBrainPrimaryPoolDefault({
    pools: supervisorDefaults.executionPools ?? normalizeSupervisionExecutionPools(undefined),
    // A sub-session's model is not the Brain model and must never silently
    // become an account-wide primary-pool authorization.
    brainAgentType: parentSession ? '' : type,
    brainModel: brainExecutionModel,
  }), [brainExecutionModel, parentSession, supervisorDefaults.executionPools, type]);
  const supervisorDefaultsBackupPresetEntry = ccPresets.find((p) => p.name === supervisorDefaultsBackupPreset.trim());
  const supervisorDefaultsBackupPresetModelOptions = getPresetModelOptions(ccPresets, supervisorDefaultsBackupPreset);
  const supervisorDefaultsBackupDynamicModels = useTransportModels(
    ws ?? null,
    supportsDynamicTransportModels(supervisorDefaultsBackupBackend)
      ? supervisorDefaultsBackupBackend
      : null,
    supervisorDefaultsBackupPreset || undefined,
    sessionName,
  );
  const supervisorDefaultsBackupModelOptions = supervisorDefaultsBackupBackend
    ? (supervisorDefaultsBackupPresetEntry
        ? mergeModelSuggestions(
            supervisorDefaultsBackupPresetModelOptions,
            supervisorDefaultsBackupDynamicModels.models.map((entry) => entry.id),
          )
        : mergeModelSuggestions(
            supervisorDefaultsBackupDynamicModels.models.map((entry) => entry.id),
            getSupervisionModelOptions(supervisorDefaultsBackupBackend),
          ))
    : [];
  // Preset persistence is valid only for runtime backends that can resolve the
  // same third-party endpoint bundles used by memory processing.
  const defaultsSupportsPreset = !!supervisorDefaultsBackend && doesSharedContextBackendSupportPresets(supervisorDefaultsBackend);
  const defaultsBackupSupportsPreset = !!supervisorDefaultsBackupBackend
    && doesSharedContextBackendSupportPresets(supervisorDefaultsBackupBackend);
  // Merged preview shown only when override is unchecked AND both sides have
  // non-empty trimmed content. Any other case is redundant (the effective
  // value equals one or the other side, visible in the textarea already).
  const supervisionMergedPreview = useMemo(
    () => mergeSupervisionCustomInstructions(
      supervisorDefaultsCustomInstructions,
      supervisionCustomInstructions,
      supervisionCustomInstructionsOverride,
    ),
    [supervisionCustomInstructions, supervisionCustomInstructionsOverride, supervisorDefaultsCustomInstructions],
  );
  const shouldShowMergedPreview = !supervisionCustomInstructionsOverride
    && supervisorDefaultsCustomInstructions.trim().length > 0
    && supervisionCustomInstructions.trim().length > 0;

  const nextTransportConfig = useMemo(() => buildTransportConfigWithSupervision(transportConfig, {
    mode: supervision.mode,
    // Session snapshots retain a runtime mirror for cold-start compatibility,
    // but the UI has one global source of truth and the daemon refreshes it
    // continuously and applies it to every decision.
    backend: supervisorDefaultsBackend || undefined,
    model: supervisorDefaultsModel.trim() || undefined,
    ...(defaultsSupportsPreset && supervisorDefaultsPreset.trim() ? { preset: supervisorDefaultsPreset.trim() } : {}),
    ...(supervisorDefaultsBackupBackend && supervisorDefaultsBackupModel.trim() ? {
      backupBackend: supervisorDefaultsBackupBackend,
      backupModel: supervisorDefaultsBackupModel.trim(),
      ...(defaultsBackupSupportsPreset && supervisorDefaultsBackupPreset.trim()
        ? { backupPreset: supervisorDefaultsBackupPreset.trim() }
        : {}),
    } : {}),
    timeoutMs: supervisorDefaultsTimeout,
    promptVersion: supervisorDefaultsPromptVersion,
    executionPools: supervisorDefaultsExecutionPools,
    customInstructions: supervisionCustomInstructions.trim() || undefined,
    // Only write the flag when true to keep default payloads minimal.
    ...(supervisionCustomInstructionsOverride ? { customInstructionsOverride: true } : {}),
    // Snapshot cache mirror of the global custom instructions. The daemon
    // merges this with the session value at dispatch time; the field is
    // intentionally re-populated on every save so it stays in sync when the
    // user edits the global textarea in the same dialog.
    ...(supervisorDefaultsCustomInstructions.trim()
      ? { globalCustomInstructions: supervisorDefaultsCustomInstructions.trim() }
      : {}),
    maxParseRetries: supervisionParseRetries,
    maxAutoContinueStreak: supervisionAutoContinueStreak,
    maxAutoContinueTotal: supervisionAutoContinueTotal,
    // Remember the auditor on this session even while audit mode is not
    // selected, so switching back to audit can reuse it without prompting.
    // Legacy manual-auditor fields are never persisted from supervision mode:
    // the auditor comes from auditPolicy + the live pool. Any inherited value is
    // stripped so a stale target cannot survive a save.
    ...(!hasSupervision && (selectedPeerAuditCandidate?.name ?? peerAuditTargetName)
      ? {
          auditTargetSessionName: selectedPeerAuditCandidate?.name ?? peerAuditTargetName ?? undefined,
          peerAuditPromptVersion: PEER_AUDIT_PROMPT_VERSION,
        }
      : {}),
    ...(isAuditMode
      ? {
          maxAuditLoops: supervisionAuditLoops,
          taskRunPromptVersion,
        }
      : {}),
  }), [
    isAuditMode,
    defaultsBackupSupportsPreset,
    defaultsSupportsPreset,
    supervision.mode,
    supervisionAuditLoops,
    selectedPeerAuditCandidate,
    peerAuditTargetName,
    supervisionAutoContinueStreak,
    supervisionAutoContinueTotal,
    supervisionCustomInstructions,
    supervisionCustomInstructionsOverride,
    supervisionParseRetries,
    supervisorDefaultsBackend,
    supervisorDefaultsBackupBackend,
    supervisorDefaultsBackupModel,
    supervisorDefaultsBackupPreset,
    supervisorDefaultsModel,
    supervisorDefaultsPreset,
    supervisorDefaultsPromptVersion,
    supervisorDefaultsTimeout,
    supervisorDefaultsExecutionPools,
    supervisorDefaultsCustomInstructions,
    taskRunPromptVersion,
    transportConfig,
  ]);

  const hasSessionChanges = useMemo(() => (
    label !== initLabel
    || description !== initDesc
    || agentType !== type
    || JSON.stringify(nextTransportConfig ?? null) !== JSON.stringify(transportConfig ?? null)
  ), [
    agentType,
    description,
    initDesc,
    initLabel,
    label,
    nextTransportConfig,
    transportConfig,
    type,
  ]);

  const hasGlobalDefaultsChanges = useMemo(() => JSON.stringify({
    ...supervisorDefaults,
    executionPools: supervisorDefaultsExecutionPools,
  }) !== JSON.stringify(initialSupervisorDefaults), [
    initialSupervisorDefaults,
    supervisorDefaults,
    supervisorDefaultsExecutionPools,
  ]);

  const hasChanges = hasSessionChanges || hasGlobalDefaultsChanges;

  const renderTypeLabel = (value: string): string => {
    switch (value) {
      case 'claude-code-sdk': return t('session.agentType.claude_code_sdk');
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
      case HERMES_AGENT_PROVIDER_ID: return t('session.agentType.hermes_agent');
      case 'deepseek-harness': return t('session.agentType.deepseek_harness');
      case 'pi': return t('session.agentType.pi');
      case CODEBUDDY_PROVIDER_IDS.CHINA: return t('session.agentType.codebuddy_china');
      case CODEBUDDY_PROVIDER_IDS.INTERNATIONAL: return t('session.agentType.codebuddy_international');
      default: return value;
    }
  };

  const handleModeChange = (nextMode: SupervisionMode) => {
    setSupervision((prev) => {
      if (nextMode === 'off') {
        return {
          mode: 'off',
          backend: prev.backend,
          model: prev.model,
          timeoutMs: prev.timeoutMs ?? DEFAULT_SUPERVISION_TIMEOUT_MS,
          promptVersion: prev.promptVersion ?? SUPERVISION_PROMPT_VERSION,
          customInstructions: prev.customInstructions,
          maxAutoContinueStreak: prev.maxAutoContinueStreak ?? supervisorDefaultsAutoContinueStreak,
          maxAutoContinueTotal: prev.maxAutoContinueTotal ?? supervisorDefaultsAutoContinueTotal,
          maxParseRetries: prev.maxParseRetries ?? DEFAULT_SUPERVISION_MAX_PARSE_RETRIES,
          auditTargetSessionName: prev.auditTargetSessionName,
          auditTargetFingerprint: prev.auditTargetFingerprint,
          peerAuditPromptVersion: prev.peerAuditPromptVersion,
          maxAuditLoops: prev.maxAuditLoops ?? DEFAULT_SUPERVISION_MAX_AUDIT_LOOPS,
          taskRunPromptVersion: prev.taskRunPromptVersion ?? TASK_RUN_PROMPT_VERSION,
        };
      }
      if (nextMode === 'supervised_audit') {
        return {
          mode: nextMode,
          backend: prev.backend,
          model: prev.model,
          timeoutMs: prev.timeoutMs ?? DEFAULT_SUPERVISION_TIMEOUT_MS,
          promptVersion: prev.promptVersion ?? SUPERVISION_PROMPT_VERSION,
          customInstructions: prev.customInstructions,
          maxAutoContinueStreak: prev.maxAutoContinueStreak == null || prev.maxAutoContinueStreak === DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK
            ? supervisorDefaultsAutoContinueStreak
            : prev.maxAutoContinueStreak,
          maxAutoContinueTotal: prev.maxAutoContinueTotal == null || prev.maxAutoContinueTotal === DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL
            ? supervisorDefaultsAutoContinueTotal
            : prev.maxAutoContinueTotal,
          maxParseRetries: prev.maxParseRetries ?? DEFAULT_SUPERVISION_MAX_PARSE_RETRIES,
          auditTargetSessionName: prev.auditTargetSessionName,
          auditTargetFingerprint: prev.auditTargetFingerprint,
          peerAuditPromptVersion: prev.peerAuditPromptVersion,
          maxAuditLoops: prev.maxAuditLoops ?? DEFAULT_SUPERVISION_MAX_AUDIT_LOOPS,
          taskRunPromptVersion: prev.taskRunPromptVersion ?? TASK_RUN_PROMPT_VERSION,
        };
      }
      return {
        mode: nextMode,
        backend: prev.backend,
        model: prev.model,
        timeoutMs: prev.timeoutMs ?? DEFAULT_SUPERVISION_TIMEOUT_MS,
        promptVersion: prev.promptVersion ?? SUPERVISION_PROMPT_VERSION,
        customInstructions: prev.customInstructions,
        maxAutoContinueStreak: prev.maxAutoContinueStreak == null || prev.maxAutoContinueStreak === DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK
          ? supervisorDefaultsAutoContinueStreak
          : prev.maxAutoContinueStreak,
        maxAutoContinueTotal: prev.maxAutoContinueTotal == null || prev.maxAutoContinueTotal === DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL
          ? supervisorDefaultsAutoContinueTotal
          : prev.maxAutoContinueTotal,
        maxParseRetries: prev.maxParseRetries ?? DEFAULT_SUPERVISION_MAX_PARSE_RETRIES,
        taskRunPromptVersion: prev.taskRunPromptVersion ?? TASK_RUN_PROMPT_VERSION,
      };
    });
  };

  const updateRuntimeDraft = (
    previous: SupervisionRuntimeDraft,
    nextBackendValue: string,
  ): SupervisionRuntimeDraft => {
    if (!isSupportedSupervisionBackend(nextBackendValue)) {
      // Clearing the backend also clears preset — otherwise a stale preset
      // would round-trip to the server and the normalizer would strip it
      // anyway, leaving the dialog's diff out of sync with storage.
      return { ...previous, backend: undefined, model: undefined, preset: undefined };
    }
    const nextSupportsPreset = doesSharedContextBackendSupportPresets(nextBackendValue);
    return {
      ...previous,
      backend: nextBackendValue,
      model: resolveSupervisionModelForBackend(nextBackendValue, previous.model ?? '', previous.backend),
      // Switch to a non-preset backend → drop preset. Switch between preset
      // backends (future case) → keep the previous preset for continuity.
      preset: nextSupportsPreset ? previous.preset : undefined,
    };
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (hasGlobalDefaultsChanges) {
        await supervisorDefaultsPref.save({
          backend: supervisorDefaultsBackend || undefined,
          model: supervisorDefaultsModel.trim(),
          timeoutMs: supervisorDefaultsTimeout,
          promptVersion: supervisorDefaultsPromptVersion,
          maxAutoContinueStreak: supervisorDefaultsAutoContinueStreak,
          maxAutoContinueTotal: supervisorDefaultsAutoContinueTotal,
          // Optional free-text global supervision instructions. Empty string
          // is normalized to undefined by the shared helper.
          customInstructions: supervisorDefaultsCustomInstructions.trim() || undefined,
          // Only forward preset when the current defaults backend supports it.
          // The shared normalizer would strip it anyway for non-preset backends,
          // but scrubbing here keeps the wire payload tidy.
          ...(defaultsSupportsPreset && supervisorDefaultsPreset.trim()
            ? { preset: supervisorDefaultsPreset.trim() }
            : {}),
          ...(supervisorDefaultsBackupBackend && supervisorDefaultsBackupModel.trim() ? {
            backupBackend: supervisorDefaultsBackupBackend,
            backupModel: supervisorDefaultsBackupModel.trim(),
            ...(defaultsBackupSupportsPreset && supervisorDefaultsBackupPreset.trim()
              ? { backupPreset: supervisorDefaultsBackupPreset.trim() }
              : {}),
          } : {}),
          executionPools: supervisorDefaultsExecutionPools,
        });
      }

      const fields: {
        label?: string | null;
        description?: string | null;
        cwd?: string | null;
        agentType?: string | null;
        type?: string | null;
        transportConfig?: Record<string, unknown> | null;
      } = {};
      if (label !== initLabel) fields.label = label || null;
      if (description !== initDesc) fields.description = description || null;
      if (agentType !== type) {
        if (subSessionId) fields.type = agentType;
        else fields.agentType = agentType;
      }
      if (JSON.stringify(nextTransportConfig ?? null) !== JSON.stringify(transportConfig ?? null)) {
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
        label: label || undefined,
        description: description || undefined,
        type: agentType || undefined,
        transportConfig: nextTransportConfig,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const supervisionModeLabel = labelForMode(t, supervision.mode);
  const handleSessionModeSelect = (e: Event): void => {
    handleModeChange((e.target as HTMLSelectElement).value as SupervisionMode);
  };
  const globalDefaultsValid = useMemo(() => {
    if (!isSupportedTransport) return true;
    if (!supervisorDefaultsBackend) return false;
    if (!supervisorDefaultsModel.trim()) return false;
    if (supervisorDefaultsBackend !== 'openclaw' && !isKnownSharedContextModelForBackend(supervisorDefaultsBackend, supervisorDefaultsModel.trim(), supervisorDefaultsPreset.trim() || undefined)) return false;
    if (supervisorDefaultsBackupBackend) {
      if (!supervisorDefaultsBackupModel.trim()) return false;
      if (
        supervisorDefaultsBackupBackend !== 'openclaw'
        && !isKnownSharedContextModelForBackend(
          supervisorDefaultsBackupBackend,
          supervisorDefaultsBackupModel.trim(),
          supervisorDefaultsBackupPreset.trim() || undefined,
        )
      ) return false;
    }
    if (supervisorDefaultsTimeout < SUPERVISION_MIN_TIMEOUT_MS) return false;
    if (supervisorDefaultsExecutionPools.state !== 'configured'
      || supervisorDefaultsExecutionPools.primaryDevelopmentPool.configs.length === 0) return false;
    return true;
  }, [
    isSupportedTransport,
    supervisorDefaultsBackend,
    supervisorDefaultsBackupBackend,
    supervisorDefaultsBackupModel,
    supervisorDefaultsBackupPreset,
    supervisorDefaultsModel,
    supervisorDefaultsPreset,
    supervisorDefaultsTimeout,
    supervisorDefaultsExecutionPools,
  ]);

  const supervisionPanel = isSupportedTransport ? (
    <div class="session-settings-supervision-panel">
      <SupervisionIntroCard t={t} />

      <div class="session-settings-help">
        {t('session.supervision.help')}
      </div>

      <div class="session-settings-card session-settings-card-primary">
        <div class="session-settings-card-title">
          {t('session.supervision.globalDefaultsTitle')}
        </div>
        <div class="session-settings-help">
          {t('session.supervision.globalDefaultsHelp')}
        </div>
        <div class="session-settings-subtitle">
          {t('session.supervision.globalPrimaryRuntime')}
        </div>
        <SupervisionRuntimeFields
          t={t}
          saving={saving}
          backend={supervisorDefaultsBackend}
          model={supervisorDefaultsModel}
          preset={supervisorDefaultsPreset}
          presets={ccPresets}
          timeoutSeconds={supervisorDefaultsTimeoutSeconds}
          modelOptions={supervisorDefaultsModelOptions}
          idPrefix="supervision-defaults"
          onBackendChange={(nextBackend) => {
            updateSupervisorDefaultsFromUser((prev) => ({ ...prev, ...updateRuntimeDraft(prev, nextBackend) }));
          }}
          onModelChange={(model) => updateSupervisorDefaultsFromUser((prev) => ({ ...prev, model }))}
          onRuntimeChange={({ model, preset }) => updateSupervisorDefaultsFromUser((prev) => ({ ...prev, model, preset: preset || undefined }))}
          onTimeoutChange={(seconds) => updateSupervisorDefaultsFromUser((prev) => ({ ...prev, timeoutMs: timeoutUiSecondsToMs(seconds) }))}
        />

        <div class="session-settings-subsection">
          <div class="session-settings-subtitle">
            {t('session.supervision.globalBackupRuntime')}
          </div>
          <div class="session-settings-muted">
            {t('session.supervision.globalBackupHelp')}
          </div>
          <SupervisionRuntimeFields
            t={t}
            saving={saving}
            backend={supervisorDefaultsBackupBackend}
            model={supervisorDefaultsBackupModel}
            preset={supervisorDefaultsBackupPreset}
            presets={ccPresets}
            modelOptions={supervisorDefaultsBackupModelOptions}
            idPrefix="supervision-defaults-backup"
            onBackendChange={(nextBackend) => {
              updateSupervisorDefaultsFromUser((prev) => {
                if (!isSupportedSupervisionBackend(nextBackend)) {
                  return { ...prev, backupBackend: undefined, backupModel: undefined, backupPreset: undefined };
                }
                return {
                  ...prev,
                  backupBackend: nextBackend,
                  backupModel: resolveSupervisionModelForBackend(nextBackend, prev.backupModel ?? '', prev.backupBackend),
                  backupPreset: doesSharedContextBackendSupportPresets(nextBackend) ? prev.backupPreset : undefined,
                };
              });
            }}
            onModelChange={(backupModel) => updateSupervisorDefaultsFromUser((prev) => ({ ...prev, backupModel }))}
            onRuntimeChange={({ model, preset }) => updateSupervisorDefaultsFromUser((prev) => ({
              ...prev,
              backupModel: model,
              backupPreset: preset || undefined,
            }))}
          />
        </div>

        <SupervisionExecutionPoolsEditor
          t={t}
          saving={saving}
          pools={supervisorDefaultsExecutionPools}
          candidates={executionPoolCandidates}
          onAddPoolSession={onAddPoolSession}
          onChange={(executionPools) => updateSupervisorDefaultsFromUser((prev) => ({ ...prev, executionPools }))}
        />

        {supervisorDefaultsExecutionPools.primaryDevelopmentPool.configs.length === 0 && (
          <div style={{ color: '#fbbf24', fontSize: 12 }}>
            {t('session.supervision.validation.modelRequired')}
          </div>
        )}

        <div class="session-settings-grid">
          <div class="session-settings-field">
            <div class="session-settings-label">{t('session.supervision.maxAutoContinueStreak')}</div>
            <input
              class="input"
              type="number"
              min={0}
              value={String(supervisorDefaultsAutoContinueStreak)}
              onInput={(e) => {
                const value = Number.parseInt((e.target as HTMLInputElement).value, 10);
                updateSupervisorDefaultsFromUser((prev) => ({ ...prev, maxAutoContinueStreak: Number.isFinite(value) && value >= 0 ? value : DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK }));
              }}
              style={{ width: '100%' }}
              disabled={saving}
            />
            <div class="session-settings-field-help">{t('session.supervision.maxAutoContinueStreakHelp')}</div>
          </div>
          <div class="session-settings-field">
            <div class="session-settings-label">{t('session.supervision.maxAutoContinueTotal')}</div>
            <input
              class="input"
              type="number"
              min={0}
              value={String(supervisorDefaultsAutoContinueTotal)}
              onInput={(e) => {
                const value = Number.parseInt((e.target as HTMLInputElement).value, 10);
                updateSupervisorDefaultsFromUser((prev) => ({ ...prev, maxAutoContinueTotal: Number.isFinite(value) && value >= 0 ? value : DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL }));
              }}
              style={{ width: '100%' }}
              disabled={saving}
            />
            <div class="session-settings-field-help">{t('session.supervision.maxAutoContinueTotalHelp')}</div>
          </div>
        </div>

        <div class="session-settings-field">
          <div class="session-settings-label">
            {t('session.supervision.globalCustomInstructionsLabel')}
          </div>
          <textarea
            class="input"
            value={supervisorDefaultsCustomInstructions}
            onInput={(e) => updateSupervisorDefaultsFromUser((prev) => ({ ...prev, customInstructions: (e.target as HTMLTextAreaElement).value }))}
            rows={3}
            style={{ width: '100%', resize: 'vertical' }}
            disabled={saving}
            placeholder={t('session.supervision.globalCustomInstructionsPlaceholder')}
          />
          <div class="session-settings-field-help">
            {t('session.supervision.globalCustomInstructionsHelp')}
          </div>
        </div>

        {!supervisorDefaultsBackend && (
          <div style={{ color: '#fbbf24', fontSize: 12 }}>
            {t('session.supervision.validation.backendRequired')}
          </div>
        )}

        {supervisorDefaultsBackend && !supervisorDefaultsModel.trim() && (
          <div style={{ color: '#fbbf24', fontSize: 12 }}>
            {t('session.supervision.validation.modelRequired')}
          </div>
        )}

        {supervisorDefaultsBackend && supervisorDefaultsModel.trim() && supervisorDefaultsBackend !== 'openclaw' && !isKnownSharedContextModelForBackend(supervisorDefaultsBackend, supervisorDefaultsModel.trim(), supervisorDefaultsPreset.trim() || undefined) && (
          <div style={{ color: '#f87171', fontSize: 12 }}>
            {t('session.supervision.validation.modelInvalid', { backend: labelForBackend(t, supervisorDefaultsBackend) })}
          </div>
        )}
      </div>

      <div class="session-settings-card session-settings-card-session">
        <div class="session-settings-card-title">
          {t('session.supervision.sessionConfigTitle')}
        </div>
        <div class="session-settings-help">
          {t('session.supervision.sessionConfigHelp')}
        </div>

        <div class="session-settings-field">
          <div class="session-settings-label">{t('session.supervision.modeLabel')}</div>
          <select
            class="input"
            aria-label="supervision-session:mode"
            value={supervision.mode}
            onInput={handleSessionModeSelect}
            onChange={handleSessionModeSelect}
            style={{ width: '100%' }}
            disabled={saving || !canControlAutomaticSupervision}
          >
            {SUPERVISION_MODES.map((mode) => (
              <option key={mode} value={mode}>{t(`session.supervision.mode.${mode}`)}</option>
            ))}
          </select>
          {!canControlAutomaticSupervision && (
            <div class="session-settings-field-help">{t('session.supervision.brainOnly')}</div>
          )}
        </div>

        {hasSupervision && (
          <>
            <div class="session-settings-notice">
              {t('session.supervision.usesGlobalRuntime')}
            </div>

            <div class="session-settings-grid">
              <div class="session-settings-field">
                <div class="session-settings-label">{t('session.supervision.maxAutoContinueStreak')}</div>
                <input
                  class="input"
                  type="number"
                  min={0}
                  value={String(supervisionAutoContinueStreak)}
                  onInput={(e) => {
                    const value = Number.parseInt((e.target as HTMLInputElement).value, 10);
                    setSupervision((prev) => ({ ...prev, maxAutoContinueStreak: Number.isFinite(value) && value >= 0 ? value : DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK }));
                  }}
                  style={{ width: '100%' }}
                  disabled={saving}
                />
                <div class="session-settings-field-help">{t('session.supervision.maxAutoContinueStreakHelp')}</div>
              </div>

              <div class="session-settings-field">
                <div class="session-settings-label">{t('session.supervision.maxAutoContinueTotal')}</div>
                <input
                  class="input"
                  type="number"
                  min={0}
                  value={String(supervisionAutoContinueTotal)}
                  onInput={(e) => {
                    const value = Number.parseInt((e.target as HTMLInputElement).value, 10);
                    setSupervision((prev) => ({ ...prev, maxAutoContinueTotal: Number.isFinite(value) && value >= 0 ? value : DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL }));
                  }}
                  style={{ width: '100%' }}
                  disabled={saving}
                />
                <div class="session-settings-field-help">{t('session.supervision.maxAutoContinueTotalHelp')}</div>
              </div>
            </div>

            <div class="session-settings-field">
              <div class="session-settings-label">{t('session.supervision.customInstructionsLabel')}</div>
              <textarea
                class="input"
                value={supervisionCustomInstructions}
                onInput={(e) => setSupervision((prev) => ({ ...prev, customInstructions: (e.target as HTMLTextAreaElement).value }))}
                rows={4}
                style={{ width: '100%', resize: 'vertical' }}
                disabled={saving}
                placeholder={t('session.supervision.customInstructionsPlaceholder')}
              />
              <div class="session-settings-field-help">
                {t('session.supervision.customInstructionsHelp')}
              </div>

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8, cursor: saving ? 'not-allowed' : 'pointer' }}>
                <input
                  type="checkbox"
                  checked={supervisionCustomInstructionsOverride}
                  disabled={saving}
                  onChange={(e) => {
                    const checked = (e.target as HTMLInputElement).checked;
                    setSupervision((prev) => ({ ...prev, customInstructionsOverride: checked }));
                  }}
                  style={{ marginTop: 2 }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 12, color: '#e2e8f0' }}>
                    {t('session.supervision.customInstructionsOverrideLabel')}
                  </span>
                  <span style={{ fontSize: 11, color: '#64748b' }}>
                    {t('session.supervision.customInstructionsOverrideHelp')}
                  </span>
                </div>
              </label>

              {shouldShowMergedPreview && (
                <div
                  data-testid="supervision-merged-preview"
                  style={{ marginTop: 8, padding: 10, borderRadius: 8, background: 'rgba(15, 23, 42, 0.6)', border: '1px dashed rgba(148, 163, 184, 0.24)' }}
                >
                  <div style={{ fontSize: 11, color: '#cbd5e1', fontWeight: 600, marginBottom: 4 }}>
                    {t('session.supervision.customInstructionsMergedPreviewHeading')}
                  </div>
                  <pre style={{ margin: 0, fontSize: 11, color: '#94a3b8', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {supervisionMergedPreview}
                  </pre>
                </div>
              )}
            </div>

            {isAuditMode && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ maxWidth: 200 }}>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.maxAuditLoops')}</div>
                  <input
                    class="input"
                    type="number"
                    min={0}
                    value={String(supervisionAuditLoops)}
                    onInput={(e) => {
                      const value = Number.parseInt((e.target as HTMLInputElement).value, 10);
                      setSupervision((prev) => ({ ...prev, maxAuditLoops: Number.isFinite(value) && value >= 0 ? value : DEFAULT_SUPERVISION_MAX_AUDIT_LOOPS }));
                    }}
                    style={{ width: '100%' }}
                    disabled={saving}
                  />
                </div>

              </div>
            )}

            <div class="session-settings-summary">
              <div style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 600 }}>{t('session.supervision.summaryTitle')}</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>{t('session.supervision.summaryMode', { value: supervisionModeLabel })}</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                {t('session.supervision.summaryBackendModel', {
                  backend: supervisorDefaultsBackend ? labelForBackend(t, supervisorDefaultsBackend) : t('session.supervision.summaryUnset'),
                  model: supervisorDefaultsModel.trim() || t('session.supervision.summaryUnset'),
                })}
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                {t('session.supervision.summaryTimeout', { value: `${supervisorDefaultsTimeoutSeconds} s` })}
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                {t('session.supervision.summaryContinueLimits', {
                  streak: supervisionAutoContinueStreak,
                  total: supervisionAutoContinueTotal,
                })}
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                {t('session.supervision.summaryCustomInstructions', {
                  value: supervisionCustomInstructions.trim()
                    ? t('session.supervision.summaryCustomInstructionsSet')
                    : t('session.supervision.summaryUnset'),
                })}
              </div>
              {isAuditMode && (
                <div style={{ fontSize: 12, color: '#94a3b8' }}>
                  {t('session.supervision.summaryAudit', {
                    auditor: selectedPeerAuditVisibleIdentity ?? t('session.supervision.summaryUnset'),
                    loops: supervisionAuditLoops,
                  })}
                  {selectedPeerAuditCandidate && (
                    <span>
                      {' · '}{selectedPeerAuditCandidate.normalizedModelId}
                      {' · '}{selectedPeerAuditCandidate.providerFamily}
                      {' · '}{t(`peerAuditQuick.disposition.${selectedPeerAuditCandidate.dispositionCapability}`)}
                    </span>
                  )}
                </div>
              )}
              <div style={{ fontSize: 11, color: '#64748b' }}>
                {t('session.supervision.summaryMeta', {
                  promptVersion: supervisorDefaultsPromptVersion,
                  repairVersion: SUPERVISION_REPAIR_PROMPT_VERSION,
                  parseRetries: supervisionParseRetries,
                  taskRunVersion: taskRunPromptVersion,
                })}
              </div>
            </div>
          </>
        )}

        {!hasSupervision && (
          <div style={{ fontSize: 12, color: '#64748b' }}>
            {t('session.supervision.disabledHint')}
          </div>
        )}
      </div>

      {hasInvalidPersistedSupervision && (
        <div style={{ color: '#fbbf24', fontSize: 12 }}>
          {t('session.supervision.invalidStoredConfig')}
        </div>
      )}

      {isAuditMode && !peerAuditTargetName && (
        <div style={{ color: '#fbbf24', fontSize: 12 }}>
          {t('session.supervision.validation.auditTargetRequired')}
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
    if (!hasSupervision) return true;
    if (!globalDefaultsValid) return false;
    if (isAuditMode) {
      // The auditor is routed from auditPolicy + the live pool, so the legacy
      // manual picker is not a precondition for a valid supervision config.
      // Requiring an eligible candidate here made Save unreachable whenever no
      // peer session happened to be open.
      if (supervisionAuditLoops < 0) return false;
    }
    return true;
  }, [globalDefaultsValid, hasSupervision, isAuditMode, isSupportedTransport, peerAuditTargetName, selectedPeerAuditCandidate, supervisionAuditLoops]);

  const dialog = (
    <div class={`dialog-overlay session-settings-overlay${poolSessionDialogOpen ? ' has-child-dialog' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog session-settings-dialog">
        <div class="dialog-header session-settings-header">
          <span class="session-settings-title">{t('session.settings')}</span>
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
          {/* Type */}
          <div class="session-settings-field">
            <div class="session-settings-label">{t('session.type')}</div>
            <select
              class="input"
              value={agentType}
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

          <div class="session-settings-section">
            <div class="session-settings-section-title">{t('session.supervision.title')}</div>
            {supervisionPanel}
          </div>

          {error && <div class="session-settings-error">{error}</div>}
        </div>

        <div class="dialog-footer session-settings-footer">
          <button type="button" class="btn btn-secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          <button type="button" class="btn btn-primary" onClick={handleSave} disabled={saving || !hasChanges || !supervisionValid || !globalDefaultsValid}>
            {saving ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
