/**
 * SessionSettingsDialog — edit label, description, cwd for main or sub sessions.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { fetchSupervisorDefaults, patchSession, patchSubSession, saveSupervisorDefaults } from '../api.js';
import { SESSION_AGENT_TYPES, TRANSPORT_SESSION_AGENT_TYPES, type SessionAgentType } from '@shared/agent-types.js';
import type { SharedContextRuntimeBackend } from '@shared/context-types.js';
import { isKnownSharedContextModelForBackend } from '@shared/shared-context-runtime-config.js';
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
  readSupervisionSnapshotFromTransportConfig,
  resolveSupervisionModelForBackend,
  SUPERVISION_PROMPT_VERSION,
  SUPERVISION_REPAIR_PROMPT_VERSION,
  SUPERVISION_MODES,
  TASK_RUN_PROMPT_VERSION,
  type SupervisionAuditMode,
  type SupervisionMode,
  type SessionSupervisionSnapshot,
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
  onClose: () => void;
  onSaved: (fields: { label?: string; description?: string; cwd?: string; type?: string; transportConfig?: Record<string, unknown> | null }) => void;
}

type SupervisionDraft = {
  mode: SupervisionMode;
  backend?: SharedContextRuntimeBackend;
  model?: string;
  timeoutMs?: number;
  promptVersion?: string;
  maxParseRetries?: number;
  auditMode?: SupervisionAuditMode;
  maxAuditLoops?: number;
  taskRunPromptVersion?: string;
};

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

function SupervisionIntroCard({ t }: { t: (key: string, params?: Record<string, unknown>) => string }) {
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
        gap: 10,
        padding: 12,
        borderRadius: 10,
        background: 'rgba(15, 23, 42, 0.45)',
        border: '1px solid rgba(96, 165, 250, 0.2)',
      }}
    >
      <div style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 600 }}>
        {t('session.supervision.intro.title')}
      </div>
      {sections.map((section) => (
        <div key={section.title} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 600 }}>{section.title}</div>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: '#94a3b8' }}>{section.body}</div>
        </div>
      ))}
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

  useEffect(() => {
    if (!isSupportedTransport || hasPersistedSupervision) return;
    let cancelled = false;
    void fetchSupervisorDefaults()
      .then((defaults) => {
        if (!defaults) return;
        if (cancelled) return;
        setSupervision((prev) => {
          if (prev.backend || prev.model) return prev;
          return {
            ...prev,
            backend: defaults.backend,
            model: defaults.model,
            timeoutMs: defaults.timeoutMs,
            promptVersion: defaults.promptVersion,
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
  const supervisionParseRetries = supervision.maxParseRetries ?? DEFAULT_SUPERVISION_MAX_PARSE_RETRIES;
  const supervisionAuditMode = supervision.auditMode;
  const supervisionAuditLoops = supervision.maxAuditLoops ?? DEFAULT_SUPERVISION_MAX_AUDIT_LOOPS;
  const taskRunPromptVersion = supervision.taskRunPromptVersion ?? TASK_RUN_PROMPT_VERSION;

  const modelOptions = supervisionBackend ? getSupervisionModelOptions(supervisionBackend) : [];

  const hasChanges = useMemo(() => {
    const nextTransportConfig = buildTransportConfigWithSupervision(transportConfig, {
      mode: supervision.mode,
      backend: supervisionBackend || undefined,
      model: supervisionModel.trim() || undefined,
      timeoutMs: supervisionTimeout,
      promptVersion: supervisionPromptVersion,
      maxParseRetries: supervisionParseRetries,
      ...(isAuditMode
        ? {
            auditMode: supervisionAuditMode,
            maxAuditLoops: supervisionAuditLoops,
            taskRunPromptVersion,
          }
        : {}),
    });
    return (
      label !== initLabel
      || description !== initDesc
      || cwd !== initCwd
      || agentType !== type
      || JSON.stringify(nextTransportConfig ?? null) !== JSON.stringify(transportConfig ?? null)
    );
  }, [
    agentType,
    cwd,
    description,
    initCwd,
    initDesc,
    initLabel,
    isAuditMode,
    label,
    supervision.mode,
    supervisionAuditLoops,
    supervisionAuditMode,
    supervisionBackend,
    supervisionModel,
    supervisionParseRetries,
    supervisionPromptVersion,
    supervisionTimeout,
    taskRunPromptVersion,
    transportConfig,
    type,
  ]);

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
        maxParseRetries: prev.maxParseRetries ?? DEFAULT_SUPERVISION_MAX_PARSE_RETRIES,
        taskRunPromptVersion: prev.taskRunPromptVersion ?? TASK_RUN_PROMPT_VERSION,
      };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (hasSupervision && supervisionBackend && supervisionModel.trim()) {
        await saveSupervisorDefaults({
          backend: supervisionBackend,
          model: supervisionModel.trim(),
          timeoutMs: supervisionTimeout,
          promptVersion: supervisionPromptVersion,
        });
      }

      const nextSupervision = {
        mode: supervision.mode,
        backend: supervisionBackend || undefined,
        model: supervisionModel.trim() || undefined,
        timeoutMs: supervisionTimeout,
        promptVersion: supervisionPromptVersion,
        maxParseRetries: supervisionParseRetries,
        ...(isAuditMode
          ? {
              auditMode: supervisionAuditMode,
              maxAuditLoops: supervisionAuditLoops,
              taskRunPromptVersion,
            }
          : {}),
      } satisfies Partial<SessionSupervisionSnapshot>;
      const nextTransportConfig = buildTransportConfigWithSupervision(transportConfig, nextSupervision);

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

  const supervisionPanel = isSupportedTransport ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SupervisionIntroCard t={t} />

      <div style={{ fontSize: 12, color: '#94a3b8' }}>
        {t('session.supervision.help')}
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.backend')}</div>
              <select
                class="input"
                value={supervisionBackend}
                onChange={(e) => {
                  const next = (e.target as HTMLSelectElement).value;
                  setSupervision((prev) => {
                    if (!isSupportedSupervisionBackend(next)) {
                      return { ...prev, backend: undefined as never, model: undefined as never };
                    }
                    return {
                      ...prev,
                      backend: next,
                      model: resolveSupervisionModelForBackend(next, prev.model ?? '', prev.backend),
                    };
                  });
                }}
                style={{ width: '100%' }}
                disabled={saving}
              >
                <option value="">{t('session.supervision.selectBackend')}</option>
                {getSupportedSupervisionBackendOptions().map((backend) => (
                  <option key={backend} value={backend}>{labelForBackend(t, backend)}</option>
                ))}
              </select>
            </div>

            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.supervision.model')}</div>
                {supervisionBackend === 'openclaw' ? (
                <input
                  class="input"
                  value={supervisionModel}
                  onInput={(e) => setSupervision((prev) => ({ ...prev, model: (e.target as HTMLInputElement).value }))}
                  style={{ width: '100%' }}
                  disabled={saving}
                  placeholder={t('session.supervision.selectModel')}
                />
              ) : (
                <select
                  class="input"
                  value={supervisionModel}
                  onChange={(e) => setSupervision((prev) => ({ ...prev, model: (e.target as HTMLSelectElement).value }))}
                  style={{ width: '100%' }}
                  disabled={saving || !supervisionBackend}
                >
                  <option value="">{t('session.supervision.selectModel')}</option>
                  {(supervisionBackend ? modelOptions : []).map((model) => (
                    <option key={model} value={model}>{model}</option>
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
                value={String(supervisionTimeoutSeconds)}
                onInput={(e) => {
                  const value = Number.parseInt((e.target as HTMLInputElement).value, 10);
                  setSupervision((prev) => ({
                    ...prev,
                    timeoutMs: Number.isFinite(value) && value > 0
                      ? timeoutUiSecondsToMs(value)
                      : DEFAULT_SUPERVISION_TIMEOUT_MS,
                  }));
                }}
                style={{ width: '100%' }}
                disabled={saving}
              />
            </div>
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
              {hasSupervision
                ? t('session.supervision.summaryBackendModel', {
                    backend: supervisionBackend ? labelForBackend(t, supervisionBackend) : t('session.supervision.summaryUnset'),
                    model: supervisionModel.trim() || t('session.supervision.summaryUnset'),
                  })
                : t('session.supervision.summaryDisabled')}
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              {t('session.supervision.summaryTimeout', { value: `${supervisionTimeoutSeconds} s` })}
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

      {hasSupervision && supervisionBackend && supervisionModel.trim() && supervisionBackend !== 'openclaw' && !isKnownSharedContextModelForBackend(supervisionBackend, supervisionModel.trim()) && (
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
    if (supervisionBackend !== 'openclaw' && !isKnownSharedContextModelForBackend(supervisionBackend, supervisionModel.trim())) return false;
    if (supervisionTimeout <= 0) return false;
    if (isAuditMode) {
      if (!supervisionAuditMode || !isSupportedSupervisionAuditMode(supervisionAuditMode)) return false;
      if (supervisionAuditLoops <= 0) return false;
    }
    return true;
  }, [hasSupervision, isAuditMode, isSupportedTransport, supervisionAuditLoops, supervisionAuditMode, supervisionBackend, supervisionModel, supervisionTimeout]);

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
          <button class="btn btn-primary" onClick={handleSave} disabled={saving || !hasChanges || !supervisionValid}>
            {saving ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
