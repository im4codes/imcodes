/**
 * SessionSettingsDialog — edit metadata and view cwd for main or sub sessions.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import { patchSession, patchSubSession } from '../api.js';
import { useSupervisorDefaults } from '../hooks/useSupervisorDefaults.js';
import type { WsClient } from '../ws-client.js';
import { SESSION_AGENT_TYPES, TRANSPORT_SESSION_AGENT_TYPES, getSessionRuntimeType, type SessionAgentType } from '@shared/agent-types.js';
import { isDelegationReplyCapableAgentType } from '@shared/agent-delegation.js';
import type { SharedContextRuntimeBackend } from '@shared/context-types.js';
import { doesSharedContextBackendSupportPresets, isKnownSharedContextModelForBackend } from '@shared/shared-context-runtime-config.js';
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
  SUPERVISION_MODES,
  SUPERVISION_MIN_TIMEOUT_MS,
  TASK_RUN_PROMPT_VERSION,
  type SupervisionMode,
} from '@shared/supervision-config.js';
import {
  PEER_AUDIT_CANDIDATE_REASONS,
  PEER_AUDIT_PROMPT_VERSION,
  PEER_AUDIT_UNKNOWN_IDENTITY,
  resolvePeerAuditNormalizedModelId,
  resolvePeerAuditProviderFamily,
  type PeerAuditCandidate,
} from '@shared/peer-audit.js';
import { PeerAuditCandidatePicker } from '../peerAudit/PeerAuditAuditorChooser.js';
import { peerAuditCandidateDisplayLabel, peerAuditProviderTypeLabel } from '../peerAudit/types.js';
import {
  SESSION_SETTINGS_FOCUS,
  type SessionSettingsOpenIntent,
} from '../session-settings-open-intent.js';

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
  openIntent?: SessionSettingsOpenIntent;
  /**
   * Optional WebSocket client. When supplied, the supervision dialog subscribes
   * to `cc.presets.list_response` and renders a preset picker for qwen
   * supervisor backends. When absent (tests, legacy callers), the dialog
   * silently omits the picker — the rest of the UI keeps working unchanged.
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
   * `doesSharedContextBackendSupportPresets(backend)` returns true
   * (currently only `qwen`). The daemon broker routes the supervisor session
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

// Runtime draft used for both the global-defaults region and the session's
// own backend/model/timeout overrides. `customInstructions` and `preset` are
// included here so the global-defaults region can edit them; the session
// region edits its own textarea value separately and uses the override flag
// to decide merging.
type SupervisionRuntimeDraft = Pick<
  SupervisionDraft,
  'backend' | 'model' | 'preset' | 'timeoutMs' | 'promptVersion' | 'customInstructions' | 'maxAutoContinueStreak' | 'maxAutoContinueTotal'
>;

type CcPresetSummary = {
  name: string;
  env?: Record<string, string>;
  availableModels?: Array<{ id: string; name?: string }>;
  defaultModel?: string;
};

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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: collapsed ? 0 : 10,
        padding: 12,
        borderRadius: 10,
        background: 'rgba(15, 23, 42, 0.45)',
        border: '1px solid rgba(96, 165, 250, 0.2)',
      }}
    >
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        aria-controls="supervision-intro-body"
        data-testid="supervision-intro-toggle"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'transparent',
          border: 'none',
          padding: 0,
          margin: 0,
          cursor: 'pointer',
          color: '#e2e8f0',
          fontSize: 12,
          fontWeight: 600,
          textAlign: 'left',
          width: '100%',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            transition: 'transform 150ms ease',
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            width: 10,
            textAlign: 'center',
            color: '#94a3b8',
          }}
        >
          ▾
        </span>
        <span style={{ flex: 1 }}>{t('session.supervision.intro.title')}</span>
        <span style={{ fontSize: 11, color: '#64748b', fontWeight: 400 }}>
          {t(collapsed ? 'session.supervision.intro.expandHint' : 'session.supervision.intro.collapseHint')}
        </span>
      </button>
      {!collapsed && (
        <div
          id="supervision-intro-body"
          style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 2 }}
        >
          {sections.map((section) => (
            <div key={section.title} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 600 }}>{section.title}</div>
              <div style={{ fontSize: 12, lineHeight: 1.5, color: '#94a3b8' }}>{section.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Pull the preset's pinned model out of its env bundle. CcPreset stores
 * provider credentials + model under ANTHROPIC_MODEL (mirrored into
 * OPENAI_MODEL for OpenAI-compatible endpoints, e.g. qwen --auth-type anthropic
 * against a MiniMax/GLM/Kimi gateway). The daemon's getQwenPresetTransportConfig
 * reads the same field and treats it as authoritative at launch — we use it
 * here so the supervision UI reflects the effective model the moment the user
 * picks a preset, instead of showing a stale Qwen default alongside.
 */
function getPresetPinnedModel(
  presets: readonly CcPresetSummary[],
  presetName: string | undefined,
): string | undefined {
  if (!presetName) return undefined;
  const target = presetName.trim().toLowerCase();
  if (!target) return undefined;
  const match = presets.find((p) => p.name.trim().toLowerCase() === target);
  if (!match) return undefined;
  // Prefer the discovered defaultModel (set by cc.presets.discover_models);
  // fall back to the env-pinned model used by the daemon at launch.
  const discovered = typeof match.defaultModel === 'string' ? match.defaultModel.trim() : '';
  if (discovered) return discovered;
  const envModel = match.env?.ANTHROPIC_MODEL ?? match.env?.OPENAI_MODEL;
  const trimmed = typeof envModel === 'string' ? envModel.trim() : '';
  return trimmed || undefined;
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
  const options: string[] = [];
  const add = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !options.includes(trimmed)) options.push(trimmed);
  };
  add(match.defaultModel);
  add(match.env?.ANTHROPIC_MODEL);
  add(match.env?.OPENAI_MODEL);
  for (const model of match.availableModels ?? []) add(model.id);
  return options;
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

/**
 * Qwen preset picker — renders a chip row (including a "none" clear chip) for
 * backends that support presets. Kept lightweight and decoupled from the
 * broader shared-context panel's unified selector. The preset's pinned model
 * (from env.ANTHROPIC_MODEL) is auto-applied by the parent's onChange handler
 * so the model dropdown never shows a value that contradicts the preset.
 */
function SupervisionPresetPicker({
  t,
  saving,
  presets,
  value,
  onChange,
  noneLabel,
  labelKey,
  helpKey,
}: {
  t: (key: string, params?: Record<string, unknown>) => string;
  saving: boolean;
  presets: readonly CcPresetSummary[];
  value: string;
  onChange: (next: string | undefined) => void;
  noneLabel: string;
  labelKey: string;
  helpKey: string;
}) {
  const baseChipStyle = {
    padding: '4px 10px',
    fontSize: 11,
    borderRadius: 999,
    border: '1px solid rgba(148, 163, 184, 0.35)',
    background: 'rgba(15, 23, 42, 0.6)',
    color: '#cbd5e1',
    cursor: saving ? 'not-allowed' : 'pointer',
    opacity: saving ? 0.6 : 1,
  } as const;
  const activeChipStyle = {
    ...baseChipStyle,
    background: 'rgba(124, 58, 237, 0.35)',
    border: '1px solid rgba(167, 139, 250, 0.55)',
    color: '#f3e8ff',
    fontWeight: 600,
  } as const;
  const noneActiveStyle = {
    ...baseChipStyle,
    background: '#374151',
    border: '1px solid rgba(148, 163, 184, 0.55)',
    color: '#f3f4f6',
    fontWeight: 600,
  } as const;
  const trimmed = value.trim();
  return (
    <div>
      <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t(labelKey)}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} data-testid="supervision-preset-picker">
        <button
          type="button"
          disabled={saving}
          style={trimmed === '' ? noneActiveStyle : baseChipStyle}
          onClick={() => onChange(undefined)}
        >
          {noneLabel}
        </button>
        {presets.map((p) => (
          <button
            key={p.name}
            type="button"
            disabled={saving}
            style={trimmed === p.name ? activeChipStyle : baseChipStyle}
            onClick={() => onChange(p.name)}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>{t(helpKey)}</div>
    </div>
  );
}

function SupervisionRuntimeFields({
  t,
  saving,
  backend,
  model,
  timeoutSeconds,
  modelOptions,
  onBackendChange,
  onModelChange,
  onTimeoutChange,
}: {
  t: (key: string, params?: Record<string, unknown>) => string;
  saving: boolean;
  backend: SharedContextRuntimeBackend | '';
  model: string;
  timeoutSeconds: number;
  modelOptions: readonly string[];
  onBackendChange: (backend: string) => void;
  onModelChange: (model: string) => void;
  onTimeoutChange: (seconds: number) => void;
}) {
  const handleBackendSelect = (e: Event): void => {
    onBackendChange((e.target as HTMLSelectElement).value);
  };
  const handleModelSelect = (e: Event): void => {
    onModelChange((e.target as HTMLSelectElement).value);
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
      <div>
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.backend')}</div>
        <select
          class="input"
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

      <div>
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.model')}</div>
        {backend === 'openclaw' ? (
          <input
            class="input"
            value={model}
            onInput={(e) => onModelChange((e.target as HTMLInputElement).value)}
            style={{ width: '100%' }}
            disabled={saving}
            placeholder={t('session.supervision.selectModel')}
          />
        ) : (
          <select
            class="input"
            value={model}
            onInput={handleModelSelect}
            onChange={handleModelSelect}
            style={{ width: '100%' }}
            disabled={saving || !backend}
          >
            <option value="">{t('session.supervision.selectModel')}</option>
            {(backend ? modelOptions : []).map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        )}
      </div>

      <div>
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.timeout')}</div>
        <input
          class="input"
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
      </div>
    </div>
  );
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
  parentSession,
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
  }, [hasPersistedSupervision, openIntent?.supervisionMode, transportConfig, type]);

  const [label, setLabel] = useState(initLabel);
  const [description, setDescription] = useState(initDesc);
  const [agentType, setAgentType] = useState(type);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [supervision, setSupervision] = useState<SupervisionDraft>(initialSupervision);
  const [peerAuditTargetName, setPeerAuditTargetName] = useState<string | null>(
    initialSupervision.auditTargetSessionName ?? null,
  );
  const peerAuditTargetRef = useRef<HTMLDivElement>(null);
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
  const supervisorDefaultsPref = useSupervisorDefaults(isSupportedTransport);

  useEffect(() => {
    if (openIntent?.focus !== SESSION_SETTINGS_FOCUS.PEER_AUDIT_TARGET || !isAuditMode) return;
    const target = peerAuditTargetRef.current;
    if (!target) return;
    target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    target.focus({ preventScroll: true });
  }, [isAuditMode, openIntent?.focus]);

  // Subscribe to `cc.presets.list_response` for as long as the dialog is
  // mounted with a valid `ws`. We fire the list request once on mount and
  // again whenever `ws` changes — the daemon response is idempotent.
  useEffect(() => {
    if (!ws) return;
    const unsub = ws.onMessage((msg) => {
      const m = msg as { type?: string; presets?: CcPresetSummary[] };
      if (m.type === 'cc.presets.list_response') {
        setCcPresets(m.presets ?? []);
      }
    });
    try { ws.send({ type: 'cc.presets.list' }); } catch { /* ws may not support send in tests */ }
    return unsub;
  }, [ws]);

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
    setSupervision((prev) => {
      const backend = normalizeBackendValue(String(prev.backend ?? ''));
      if (!backend || !doesSharedContextBackendSupportPresets(backend) || !prev.preset) return prev;
      const resolvedModel = resolvePresetModel(ccPresets, prev.preset, prev.model);
      if (!resolvedModel || prev.model === resolvedModel) return prev;
      return { ...prev, model: resolvedModel };
    });
  }, [
    ccPresets,
    supervisorDefaults.backend,
    supervisorDefaults.model,
    supervisorDefaults.preset,
    supervision.backend,
    supervision.model,
    supervision.preset,
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

  const supervisionBackend = normalizeBackendValue(String(supervision.backend ?? ''));
  const supervisionModel = typeof supervision.model === 'string' ? supervision.model : '';
  const supervisionTimeout = supervision.timeoutMs ?? DEFAULT_SUPERVISION_TIMEOUT_MS;
  const supervisionTimeoutSeconds = timeoutMsToUiSeconds(supervisionTimeout);
  const supervisionPromptVersion = supervision.promptVersion ?? SUPERVISION_PROMPT_VERSION;
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
  const auditedPeerModel = resolvePeerAuditNormalizedModelId({ activeModel, requestedModel });
  const selectedPeerIsSameModel = Boolean(selectedPeerAuditCandidate
    && auditedPeerModel !== 'unknown'
    && selectedPeerAuditCandidate.normalizedModelId === auditedPeerModel);
  const taskRunPromptVersion = supervision.taskRunPromptVersion ?? TASK_RUN_PROMPT_VERSION;
  const supervisionPresetEntry = ccPresets.find((p) => p.name === (typeof supervision.preset === 'string' ? supervision.preset.trim() : ''));
  const supervisionPresetModelOptions = getPresetModelOptions(ccPresets, supervision.preset);
  const modelOptions = supervisionBackend
    ? (supervisionPresetEntry && supervisionPresetModelOptions.length > 0
        ? supervisionPresetModelOptions
        : getSupervisionModelOptions(supervisionBackend))
    : [];
  const supervisorDefaultsBackend = normalizeBackendValue(String(supervisorDefaults.backend ?? ''));
  const supervisorDefaultsModel = typeof supervisorDefaults.model === 'string' ? supervisorDefaults.model : '';
  const supervisorDefaultsTimeout = supervisorDefaults.timeoutMs ?? DEFAULT_SUPERVISION_TIMEOUT_MS;
  const supervisorDefaultsTimeoutSeconds = timeoutMsToUiSeconds(supervisorDefaultsTimeout);
  const supervisorDefaultsPromptVersion = supervisorDefaults.promptVersion ?? SUPERVISION_PROMPT_VERSION;
  const supervisorDefaultsPresetEntry = ccPresets.find((p) => p.name === (typeof supervisorDefaults.preset === 'string' ? supervisorDefaults.preset.trim() : ''));
  const supervisorDefaultsPresetModelOptions = getPresetModelOptions(ccPresets, supervisorDefaults.preset);
  const supervisorDefaultsModelOptions = supervisorDefaultsBackend
    ? (supervisorDefaultsPresetEntry && supervisorDefaultsPresetModelOptions.length > 0
        ? supervisorDefaultsPresetModelOptions
        : getSupervisionModelOptions(supervisorDefaultsBackend))
    : [];
  const supervisorDefaultsCustomInstructions = typeof supervisorDefaults.customInstructions === 'string' ? supervisorDefaults.customInstructions : '';
  const supervisorDefaultsAutoContinueStreak = supervisorDefaults.maxAutoContinueStreak ?? DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK;
  const supervisorDefaultsAutoContinueTotal = supervisorDefaults.maxAutoContinueTotal ?? DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL;
  const supervisionPreset = typeof supervision.preset === 'string' ? supervision.preset : '';
  const supervisorDefaultsPreset = typeof supervisorDefaults.preset === 'string' ? supervisorDefaults.preset : '';
  // Gate preset picker visibility: needs a ws channel to fetch presets, a
  // backend that actually uses them (qwen today), and at least one preset.
  const sessionSupportsPreset = !!supervisionBackend && doesSharedContextBackendSupportPresets(supervisionBackend);
  const defaultsSupportsPreset = !!supervisorDefaultsBackend && doesSharedContextBackendSupportPresets(supervisorDefaultsBackend);
  const showSessionPresetPicker = !!ws && sessionSupportsPreset && ccPresets.length > 0;
  const showDefaultsPresetPicker = !!ws && defaultsSupportsPreset && ccPresets.length > 0;
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
    backend: supervisionBackend || undefined,
    model: supervisionModel.trim() || undefined,
    // Preset only survives when the current backend supports it; the shared
    // normalizer will also strip it server-side, but stripping here keeps the
    // diff clean when the user flips between qwen and non-preset backends.
    ...(sessionSupportsPreset && supervisionPreset.trim() ? { preset: supervisionPreset.trim() } : {}),
    timeoutMs: supervisionTimeout,
    promptVersion: supervisionPromptVersion,
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
    ...((selectedPeerAuditCandidate?.name ?? peerAuditTargetName)
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
    sessionSupportsPreset,
    supervision.mode,
    supervisionAuditLoops,
    selectedPeerAuditCandidate,
    peerAuditTargetName,
    supervisionAutoContinueStreak,
    supervisionAutoContinueTotal,
    supervisionBackend,
    supervisionCustomInstructions,
    supervisionCustomInstructionsOverride,
    supervisionModel,
    supervisionParseRetries,
    supervisionPreset,
    supervisionPromptVersion,
    supervisionTimeout,
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

  const hasGlobalDefaultsChanges = useMemo(() => JSON.stringify(supervisorDefaults) !== JSON.stringify(initialSupervisorDefaults), [
    initialSupervisorDefaults,
    supervisorDefaults,
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
    if (supervisorDefaultsTimeout < SUPERVISION_MIN_TIMEOUT_MS) return false;
    return true;
  }, [isSupportedTransport, supervisorDefaultsBackend, supervisorDefaultsModel, supervisorDefaultsPreset, supervisorDefaultsTimeout]);

  const supervisionPanel = isSupportedTransport ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SupervisionIntroCard t={t} />

      <div style={{ fontSize: 12, color: '#94a3b8' }}>
        {t('session.supervision.help')}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 10, background: 'rgba(15, 23, 42, 0.45)', border: '1px solid rgba(148, 163, 184, 0.16)' }}>
        <div style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 600 }}>
          {t('session.supervision.globalDefaultsTitle')}
        </div>
        <div style={{ fontSize: 12, color: '#94a3b8' }}>
          {t('session.supervision.globalDefaultsHelp')}
        </div>
        <SupervisionRuntimeFields
          t={t}
          saving={saving}
          backend={supervisorDefaultsBackend}
          model={supervisorDefaultsModel}
          timeoutSeconds={supervisorDefaultsTimeoutSeconds}
          modelOptions={supervisorDefaultsModelOptions}
          onBackendChange={(nextBackend) => {
            updateSupervisorDefaultsFromUser((prev) => ({ ...prev, ...updateRuntimeDraft(prev, nextBackend) }));
          }}
          onModelChange={(model) => updateSupervisorDefaultsFromUser((prev) => ({ ...prev, model }))}
          onTimeoutChange={(seconds) => updateSupervisorDefaultsFromUser((prev) => ({ ...prev, timeoutMs: timeoutUiSecondsToMs(seconds) }))}
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.maxAutoContinueStreak')}</div>
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
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>{t('session.supervision.maxAutoContinueStreakHelp')}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.maxAutoContinueTotal')}</div>
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
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>{t('session.supervision.maxAutoContinueTotalHelp')}</div>
          </div>
        </div>

        {showDefaultsPresetPicker && (
          <SupervisionPresetPicker
            t={t}
            saving={saving}
            presets={ccPresets}
            value={supervisorDefaultsPreset}
            onChange={(next) => updateSupervisorDefaultsFromUser((prev) => {
              // When a preset is chosen, pin the model to the preset's own
              // ANTHROPIC_MODEL so the picker doesn't keep a stale Qwen default
              // visible while the daemon is actually routing through MiniMax /
              // GLM / Kimi. Clearing the preset leaves the model untouched —
              // the user may have had a vanilla Qwen model they want to keep.
              const pinned = getPresetPinnedModel(ccPresets, next);
              return { ...prev, preset: next, ...(pinned ? { model: pinned } : {}) };
            })}
            noneLabel={t('session.supervision.presetNone')}
            labelKey="session.supervision.presetLabel"
            helpKey="session.supervision.presetHelp"
          />
        )}

        <div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>
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
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 10, background: 'rgba(15, 23, 42, 0.45)', border: '1px solid rgba(148, 163, 184, 0.16)' }}>
        <div style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 600 }}>
          {t('session.supervision.sessionConfigTitle')}
        </div>
        <div style={{ fontSize: 12, color: '#94a3b8' }}>
          {t('session.supervision.sessionConfigHelp')}
        </div>

        <div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.modeLabel')}</div>
          <select
            class="input"
            value={supervision.mode}
            onInput={handleSessionModeSelect}
            onChange={handleSessionModeSelect}
            style={{ width: '100%' }}
            disabled={saving}
          >
            {SUPERVISION_MODES.map((mode) => (
              <option key={mode} value={mode}>{t(`session.supervision.mode.${mode}`)}</option>
            ))}
          </select>
        </div>

        {hasSupervision && (
          <>
            <SupervisionRuntimeFields
              t={t}
              saving={saving}
              backend={supervisionBackend}
              model={supervisionModel}
              timeoutSeconds={supervisionTimeoutSeconds}
              modelOptions={modelOptions}
              onBackendChange={(nextBackend) => {
                setSupervision((prev) => ({ ...prev, ...updateRuntimeDraft(prev, nextBackend) }));
              }}
              onModelChange={(model) => setSupervision((prev) => ({ ...prev, model }))}
              onTimeoutChange={(seconds) => setSupervision((prev) => ({ ...prev, timeoutMs: timeoutUiSecondsToMs(seconds) }))}
            />

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.maxAutoContinueStreak')}</div>
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
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>{t('session.supervision.maxAutoContinueStreakHelp')}</div>
              </div>

              <div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.maxAutoContinueTotal')}</div>
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
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>{t('session.supervision.maxAutoContinueTotalHelp')}</div>
              </div>
            </div>

            {showSessionPresetPicker && (
              <SupervisionPresetPicker
                t={t}
                saving={saving}
                presets={ccPresets}
                value={supervisionPreset}
                onChange={(next) => setSupervision((prev) => {
                  // Pin the preset's ANTHROPIC_MODEL into the draft so the
                  // model dropdown immediately reflects the model the daemon
                  // will actually spawn (preset wins at launch anyway — see
                  // getQwenPresetTransportConfig). Clearing the preset keeps
                  // the current model so we don't silently lose the user's
                  // last selection.
                  const pinned = getPresetPinnedModel(ccPresets, next);
                  return { ...prev, preset: next, ...(pinned ? { model: pinned } : {}) };
                })}
                noneLabel={t('session.supervision.presetNone')}
                labelKey="session.supervision.presetLabel"
                helpKey="session.supervision.presetHelp"
              />
            )}

            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.customInstructionsLabel')}</div>
              <textarea
                class="input"
                value={supervisionCustomInstructions}
                onInput={(e) => setSupervision((prev) => ({ ...prev, customInstructions: (e.target as HTMLTextAreaElement).value }))}
                rows={4}
                style={{ width: '100%', resize: 'vertical' }}
                disabled={saving}
                placeholder={t('session.supervision.customInstructionsPlaceholder')}
              />
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
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

                <div
                  ref={peerAuditTargetRef}
                  tabIndex={-1}
                  data-testid="session-supervision-peer-target-section"
                >
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>
                    {t('peerAuditQuick.chooserTitle')}
                  </div>
                  <div data-testid="session-supervision-peer-picker">
                    <PeerAuditCandidatePicker
                      candidates={peerAuditCandidates}
                      selectedSessionInstanceId={selectedPeerAuditCandidate?.sessionInstanceId}
                      onSelect={(candidate) => {
                        setPeerAuditTargetName(candidate.name);
                      }}
                    />
                  </div>
                  {selectedPeerIsSameModel && (
                    <div style={{ color: '#fbbf24', fontSize: 11, marginTop: 6 }} data-testid="peer-audit-same-model-warning">
                      {t('peerAuditQuick.chooserReason.same_model_remembered')}
                    </div>
                  )}
                  {selectedPeerAuditCandidate?.dispositionCapability === 'sent_unrevocable' && (
                    <div style={{ color: '#fbbf24', fontSize: 11, marginTop: 6 }} data-testid="peer-audit-process-warning">
                      {t('peerAuditQuick.disposition.sent_unrevocable')}
                    </div>
                  )}
                  {selectedPeerAuditCandidate && (
                    <div style={{ color: '#34d399', fontSize: 11, marginTop: 6 }} data-testid="peer-audit-settings-selected">
                      {selectedPeerAuditVisibleIdentity}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div style={{ padding: 12, borderRadius: 8, background: 'rgba(15, 23, 42, 0.6)', border: '1px solid rgba(148, 163, 184, 0.18)', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 600 }}>{t('session.supervision.summaryTitle')}</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>{t('session.supervision.summaryMode', { value: supervisionModeLabel })}</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                {t('session.supervision.summaryBackendModel', {
                  backend: supervisionBackend ? labelForBackend(t, supervisionBackend) : t('session.supervision.summaryUnset'),
                  model: supervisionModel.trim() || t('session.supervision.summaryUnset'),
                })}
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                {t('session.supervision.summaryTimeout', { value: `${supervisionTimeoutSeconds} s` })}
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
                  promptVersion: supervisionPromptVersion,
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

      {hasSupervision && !supervisionBackend && (
        <div style={{ color: '#fbbf24', fontSize: 12 }}>
          {t('session.supervision.validation.backendRequired')}
        </div>
      )}

      {hasSupervision && supervisionBackend && !supervisionModel.trim() && (
        <div style={{ color: '#fbbf24', fontSize: 12 }}>
          {t('session.supervision.validation.modelRequired')}
        </div>
      )}

      {hasSupervision && supervisionBackend && supervisionModel.trim() && supervisionBackend !== 'openclaw' && !isKnownSharedContextModelForBackend(supervisionBackend, supervisionModel.trim(), supervisionPreset.trim() || undefined) && (
        <div style={{ color: '#f87171', fontSize: 12 }}>
          {t('session.supervision.validation.modelInvalid', { backend: labelForBackend(t, supervisionBackend) })}
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
    if (!supervisionBackend) return false;
    if (!supervisionModel.trim()) return false;
    if (supervisionBackend !== 'openclaw' && !isKnownSharedContextModelForBackend(supervisionBackend, supervisionModel.trim(), supervisionPreset.trim() || undefined)) return false;
    if (supervisionTimeout <= 0) return false;
    if (isAuditMode) {
      if (!peerAuditTargetName || !selectedPeerAuditCandidate?.eligible) return false;
      if (supervisionAuditLoops < 0) return false;
    }
    return true;
  }, [hasSupervision, isAuditMode, isSupportedTransport, peerAuditTargetName, selectedPeerAuditCandidate, supervisionAuditLoops, supervisionBackend, supervisionModel, supervisionPreset, supervisionTimeout]);

  const dialog = (
    <div class="dialog-overlay session-settings-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog" style={{ width: 440 }}>
        <div class="dialog-header">
          <span>{t('session.settings')}</span>
          <button type="button" class="dialog-close" onClick={onClose}>{t('common.close')}</button>
        </div>

        <div class="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Type */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.type')}</div>
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
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.parentSession')}</div>
              <div style={{ fontSize: 13, color: '#64748b' }}>{parentSession}</div>
            </div>
          )}

          {/* Label */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.label')}</div>
            <input
              class="input"
              value={label}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              style={{ width: '100%' }}
              disabled={saving}
            />
          </div>

          {/* Description */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.description')}</div>
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
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.workingDir')}</div>
            <input
              class="input"
              value={initCwd}
              style={{ width: '100%', opacity: 0.7, cursor: 'not-allowed' }}
              disabled
              readOnly
              placeholder={t('session.workingDirPlaceholder')}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4, borderTop: '1px solid rgba(148, 163, 184, 0.18)' }}>
            <div style={{ fontSize: 12, color: '#94a3b8', fontWeight: 600 }}>{t('session.supervision.title')}</div>
            {supervisionPanel}
          </div>

          {error && <div style={{ color: '#f87171', fontSize: 12 }}>{error}</div>}
        </div>

        <div class="dialog-footer">
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
