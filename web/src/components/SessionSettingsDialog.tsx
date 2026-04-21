/**
 * SessionSettingsDialog — edit label, description, cwd for main or sub sessions.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { fetchSupervisorDefaults, patchSession, patchSubSession, saveSupervisorDefaults } from '../api.js';
import type { WsClient } from '../ws-client.js';
import { SESSION_AGENT_TYPES, TRANSPORT_SESSION_AGENT_TYPES, type SessionAgentType } from '@shared/agent-types.js';
import type { SharedContextRuntimeBackend } from '@shared/context-types.js';
import { doesSharedContextBackendSupportPresets, isKnownSharedContextModelForBackend } from '@shared/shared-context-runtime-config.js';
import {
  buildTransportConfigWithSupervision,
  DEFAULT_SUPERVISION_MAX_AUDIT_LOOPS,
  DEFAULT_SUPERVISION_MAX_PARSE_RETRIES,
  DEFAULT_SUPERVISION_TIMEOUT_MS,
  getAutomationAuditModeOptions,
  getSupportedSupervisionBackendOptions,
  getSupervisionModelOptions,
  hasInvalidSessionSupervisionSnapshot,
  isSupportedSupervisionAuditMode,
  isSupportedSupervisionBackend,
  mergeSupervisionCustomInstructions,
  normalizeSupervisorDefaultConfig,
  readSupervisionSnapshotFromTransportConfig,
  resolveSupervisionModelForBackend,
  SUPERVISION_PROMPT_VERSION,
  SUPERVISION_REPAIR_PROMPT_VERSION,
  SUPERVISION_MODES,
  TASK_RUN_PROMPT_VERSION,
  type SupervisionAuditMode,
  type SupervisionMode,
} from '@shared/supervision-config.js';

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
  auditMode?: SupervisionAuditMode;
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
  'backend' | 'model' | 'preset' | 'timeoutMs' | 'promptVersion' | 'customInstructions'
>;

function timeoutMsToUiSeconds(timeoutMs: number | undefined): number {
  const safeMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_SUPERVISION_TIMEOUT_MS;
  return Math.max(1, Math.round(safeMs / 1000));
}

function timeoutUiSecondsToMs(seconds: number): number {
  return Math.max(1, Math.round(seconds)) * 1000;
}

function labelForBackend(t: (key: string, params?: Record<string, unknown>) => string, backend: SharedContextRuntimeBackend): string {
  return t({
    'claude-code-sdk': 'session.agentType.claude_code_sdk',
    'codex-sdk': 'session.agentType.codex_sdk',
    qwen: 'session.agentType.qwen',
    openclaw: 'session.agentType.openclaw',
    'copilot-sdk': 'session.agentType.copilot_sdk',
    'cursor-headless': 'session.agentType.cursor_headless',
  }[backend]);
}

function labelForMode(t: (key: string, params?: Record<string, unknown>) => string, mode: SupervisionMode): string {
  return t(`session.supervision.mode.${mode}`);
}

function labelForAuditMode(t: (key: string, params?: Record<string, unknown>) => string, mode: SupervisionAuditMode): string {
  const key = mode.replace(/>/g, '_');
  return t(`session.supervision.auditMode.${key}`);
}

function normalizeBackendValue(value: string): SharedContextRuntimeBackend | '' {
  return isSupportedSupervisionBackend(value) ? value : '';
}

function getAuditModeOptions(): SupervisionAuditMode[] {
  const allowed = new Set(['audit', 'audit>plan', 'review', 'review>plan', 'audit>review>plan']);
  return getAutomationAuditModeOptions().filter((mode): mode is SupervisionAuditMode => allowed.has(mode));
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
  presets: Array<{ name: string; env?: Record<string, string> }>,
  presetName: string | undefined,
): string | undefined {
  if (!presetName) return undefined;
  const target = presetName.trim().toLowerCase();
  if (!target) return undefined;
  const match = presets.find((p) => p.name.trim().toLowerCase() === target);
  const model = match?.env?.ANTHROPIC_MODEL ?? match?.env?.OPENAI_MODEL;
  const trimmed = typeof model === 'string' ? model.trim() : '';
  return trimmed || undefined;
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
  presets: Array<{ name: string; env?: Record<string, string> }>;
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
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
      <div>
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.backend')}</div>
        <select
          class="input"
          value={backend}
          onChange={(e) => onBackendChange((e.target as HTMLSelectElement).value)}
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
            onChange={(e) => onModelChange((e.target as HTMLSelectElement).value)}
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
          min={1}
          step={1}
          value={String(timeoutSeconds)}
          onInput={(e) => {
            const value = Number.parseInt((e.target as HTMLInputElement).value, 10);
            onTimeoutChange(Number.isFinite(value) && value > 0 ? value : timeoutSeconds);
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
  parentSession,
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
    if (!hasPersistedSupervision) return { mode: 'off' };
    return readSupervisionSnapshotFromTransportConfig(transportConfig);
  }, [hasPersistedSupervision, transportConfig]);

  const [label, setLabel] = useState(initLabel);
  const [description, setDescription] = useState(initDesc);
  const [cwd, setCwd] = useState(initCwd);
  const [agentType, setAgentType] = useState(type);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [supervision, setSupervision] = useState<SupervisionDraft>(initialSupervision);
  const [supervisorDefaults, setSupervisorDefaults] = useState<SupervisionRuntimeDraft>(() => normalizeSupervisorDefaultConfig(null));
  const [initialSupervisorDefaults, setInitialSupervisorDefaults] = useState<SupervisionRuntimeDraft>(() => normalizeSupervisorDefaultConfig(null));
  // Qwen presets (env bundles) fetched from the daemon via the same
  // `cc.presets.list` WS channel the Shared Context panel uses. Stays empty
  // when `ws` is not provided — the picker hides itself in that case.
  const [ccPresets, setCcPresets] = useState<Array<{ name: string; env?: Record<string, string> }>>([]);

  useEffect(() => {
    setLabel(initLabel);
    setDescription(initDesc);
    setCwd(initCwd);
    setAgentType(type);
    setSupervision(initialSupervision);
  }, [initLabel, initDesc, initCwd, type, initialSupervision, sessionName, subSessionId]);

  const hasSupervision = supervision.mode !== 'off';
  const isSupportedTransport = TRANSPORT_SESSION_AGENT_TYPES.includes(agentType as typeof TRANSPORT_SESSION_AGENT_TYPES[number]);
  const isAuditMode = supervision.mode === 'supervised_audit';

  // Subscribe to `cc.presets.list_response` for as long as the dialog is
  // mounted with a valid `ws`. We fire the list request once on mount and
  // again whenever `ws` changes — the daemon response is idempotent.
  useEffect(() => {
    if (!ws) return;
    const unsub = ws.onMessage((msg) => {
      const m = msg as { type?: string; presets?: Array<{ name: string; env?: Record<string, string> }> };
      if (m.type === 'cc.presets.list_response') {
        setCcPresets(m.presets ?? []);
      }
    });
    try { ws.send({ type: 'cc.presets.list' }); } catch { /* ws may not support send in tests */ }
    return unsub;
  }, [ws]);

  useEffect(() => {
    if (!isSupportedTransport) return;
    let cancelled = false;
    void fetchSupervisorDefaults()
      .then((defaults) => {
        if (cancelled) return;
        const resolvedDefaults = normalizeSupervisorDefaultConfig(defaults);
        setSupervisorDefaults(resolvedDefaults);
        setInitialSupervisorDefaults(resolvedDefaults);
        if (hasPersistedSupervision) return;
        setSupervision((prev) => {
          if (prev.backend || prev.model) return prev;
          return {
            ...prev,
            backend: resolvedDefaults.backend,
            model: resolvedDefaults.model,
            // Seed preset from defaults when the backend supports it. If the
            // backend doesn't support presets the normalizer already stripped
            // it, so copying is safe either way.
            preset: resolvedDefaults.preset,
            timeoutMs: resolvedDefaults.timeoutMs,
            promptVersion: resolvedDefaults.promptVersion,
            maxParseRetries: prev.maxParseRetries ?? DEFAULT_SUPERVISION_MAX_PARSE_RETRIES,
            maxAuditLoops: prev.maxAuditLoops ?? DEFAULT_SUPERVISION_MAX_AUDIT_LOOPS,
            taskRunPromptVersion: prev.taskRunPromptVersion ?? TASK_RUN_PROMPT_VERSION,
          };
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hasPersistedSupervision, isSupportedTransport, sessionName, subSessionId]);

  const supervisionBackend = normalizeBackendValue(String(supervision.backend ?? ''));
  const supervisionModel = typeof supervision.model === 'string' ? supervision.model : '';
  const supervisionTimeout = supervision.timeoutMs ?? DEFAULT_SUPERVISION_TIMEOUT_MS;
  const supervisionTimeoutSeconds = timeoutMsToUiSeconds(supervisionTimeout);
  const supervisionPromptVersion = supervision.promptVersion ?? SUPERVISION_PROMPT_VERSION;
  const supervisionCustomInstructions = typeof supervision.customInstructions === 'string' ? supervision.customInstructions : '';
  const supervisionCustomInstructionsOverride = supervision.customInstructionsOverride === true;
  const supervisionParseRetries = supervision.maxParseRetries ?? DEFAULT_SUPERVISION_MAX_PARSE_RETRIES;
  const supervisionAuditMode = supervision.auditMode;
  const supervisionAuditLoops = supervision.maxAuditLoops ?? DEFAULT_SUPERVISION_MAX_AUDIT_LOOPS;
  const taskRunPromptVersion = supervision.taskRunPromptVersion ?? TASK_RUN_PROMPT_VERSION;
  const modelOptions = supervisionBackend ? getSupervisionModelOptions(supervisionBackend) : [];
  const supervisorDefaultsBackend = normalizeBackendValue(String(supervisorDefaults.backend ?? ''));
  const supervisorDefaultsModel = typeof supervisorDefaults.model === 'string' ? supervisorDefaults.model : '';
  const supervisorDefaultsTimeout = supervisorDefaults.timeoutMs ?? DEFAULT_SUPERVISION_TIMEOUT_MS;
  const supervisorDefaultsTimeoutSeconds = timeoutMsToUiSeconds(supervisorDefaultsTimeout);
  const supervisorDefaultsPromptVersion = supervisorDefaults.promptVersion ?? SUPERVISION_PROMPT_VERSION;
  const supervisorDefaultsModelOptions = supervisorDefaultsBackend ? getSupervisionModelOptions(supervisorDefaultsBackend) : [];
  const supervisorDefaultsCustomInstructions = typeof supervisorDefaults.customInstructions === 'string' ? supervisorDefaults.customInstructions : '';
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
    ...(isAuditMode
      ? {
          auditMode: supervisionAuditMode,
          maxAuditLoops: supervisionAuditLoops,
          taskRunPromptVersion,
        }
      : {}),
  }), [
    isAuditMode,
    sessionSupportsPreset,
    supervision.mode,
    supervisionAuditLoops,
    supervisionAuditMode,
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
    || cwd !== initCwd
    || agentType !== type
    || JSON.stringify(nextTransportConfig ?? null) !== JSON.stringify(transportConfig ?? null)
  ), [
    agentType,
    cwd,
    description,
    initCwd,
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
      case 'codex': return t('session.agentType.codex_cli');
      case 'qwen': return t('session.agentType.qwen');
      case 'openclaw': return t('session.agentType.openclaw');
      case 'copilot-sdk': return t('session.agentType.copilot_sdk');
      case 'cursor-headless': return t('session.agentType.cursor_headless');
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
          maxParseRetries: prev.maxParseRetries ?? DEFAULT_SUPERVISION_MAX_PARSE_RETRIES,
          auditMode: prev.auditMode,
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
          maxParseRetries: prev.maxParseRetries ?? DEFAULT_SUPERVISION_MAX_PARSE_RETRIES,
          auditMode: prev.auditMode,
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
        await saveSupervisorDefaults({
          backend: supervisorDefaultsBackend || undefined,
          model: supervisorDefaultsModel.trim(),
          timeoutMs: supervisorDefaultsTimeout,
          promptVersion: supervisorDefaultsPromptVersion,
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
      if (cwd !== initCwd) fields.cwd = cwd || null;
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
        cwd: cwd || undefined,
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
  const globalDefaultsValid = useMemo(() => {
    if (!isSupportedTransport) return true;
    if (!supervisorDefaultsBackend) return false;
    if (!supervisorDefaultsModel.trim()) return false;
    if (supervisorDefaultsBackend !== 'openclaw' && !isKnownSharedContextModelForBackend(supervisorDefaultsBackend, supervisorDefaultsModel.trim(), supervisorDefaultsPreset.trim() || undefined)) return false;
    if (supervisorDefaultsTimeout <= 0) return false;
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
            setSupervisorDefaults((prev) => ({ ...prev, ...updateRuntimeDraft(prev, nextBackend) }));
          }}
          onModelChange={(model) => setSupervisorDefaults((prev) => ({ ...prev, model }))}
          onTimeoutChange={(seconds) => setSupervisorDefaults((prev) => ({ ...prev, timeoutMs: timeoutUiSecondsToMs(seconds) }))}
        />

        {showDefaultsPresetPicker && (
          <SupervisionPresetPicker
            t={t}
            saving={saving}
            presets={ccPresets}
            value={supervisorDefaultsPreset}
            onChange={(next) => setSupervisorDefaults((prev) => {
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
            onInput={(e) => setSupervisorDefaults((prev) => ({ ...prev, customInstructions: (e.target as HTMLTextAreaElement).value }))}
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
            onChange={(e) => handleModeChange((e.target as HTMLSelectElement).value as SupervisionMode)}
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.auditModeLabel')}</div>
                  <select
                    class="input"
                    value={supervisionAuditMode ?? ''}
                    onChange={(e) => setSupervision((prev) => ({ ...prev, auditMode: (e.target as HTMLSelectElement).value as SupervisionAuditMode }))}
                    style={{ width: '100%' }}
                    disabled={saving}
                  >
                    <option value="">{t('session.supervision.selectAuditMode')}</option>
                    {getAuditModeOptions().map((mode) => (
                      <option key={mode} value={mode}>{labelForAuditMode(t, mode)}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.maxAuditLoops')}</div>
                  <input
                    class="input"
                    type="number"
                    min={1}
                    value={String(supervisionAuditLoops)}
                    onInput={(e) => {
                      const value = Number.parseInt((e.target as HTMLInputElement).value, 10);
                      setSupervision((prev) => ({ ...prev, maxAuditLoops: Number.isFinite(value) && value > 0 ? value : DEFAULT_SUPERVISION_MAX_AUDIT_LOOPS }));
                    }}
                    style={{ width: '100%' }}
                    disabled={saving}
                  />
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
                {t('session.supervision.summaryCustomInstructions', {
                  value: supervisionCustomInstructions.trim()
                    ? t('session.supervision.summaryCustomInstructionsSet')
                    : t('session.supervision.summaryUnset'),
                })}
              </div>
              {isAuditMode && (
                <div style={{ fontSize: 12, color: '#94a3b8' }}>
                  {t('session.supervision.summaryAudit', {
                    auditMode: supervisionAuditMode ? labelForAuditMode(t, supervisionAuditMode) : t('session.supervision.summaryUnset'),
                    loops: supervisionAuditLoops,
                  })}
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

      {isAuditMode && !supervisionAuditMode && (
        <div style={{ color: '#fbbf24', fontSize: 12 }}>
          {t('session.supervision.validation.auditModeRequired')}
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
      if (!supervisionAuditMode || !isSupportedSupervisionAuditMode(supervisionAuditMode)) return false;
      if (supervisionAuditLoops <= 0) return false;
    }
    return true;
  }, [hasSupervision, isAuditMode, isSupportedTransport, supervisionAuditLoops, supervisionAuditMode, supervisionBackend, supervisionModel, supervisionPreset, supervisionTimeout]);

  return (
    <div class="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog" style={{ width: 440 }}>
        <div class="dialog-header">
          <span>{t('session.settings')}</span>
          <button class="dialog-close" onClick={onClose}>{t('common.close')}</button>
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
              value={cwd}
              onInput={(e) => setCwd((e.target as HTMLInputElement).value)}
              style={{ width: '100%' }}
              disabled={saving}
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
          <button class="btn btn-secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          <button class="btn btn-primary" onClick={handleSave} disabled={saving || !hasChanges || !supervisionValid || !globalDefaultsValid}>
            {saving ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
