/**
 * StartSubSessionDialog — choose type (cc/cc-sdk/codex/codex-sdk/opencode/gemini/qwen/shell/openclaw) and launch a sub-session.
 */
import { useState, useEffect, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient } from '../ws-client.js';
import type { RemoteSession } from '../hooks/useProviderStatus.js';
import { parseString, usePref } from '../hooks/usePref.js';
import { PREF_KEY_DEFAULT_SHELL } from '../constants/prefs.js';
import { CLAUDE_SDK_EFFORT_LEVELS, CODEX_SDK_EFFORT_LEVELS, COPILOT_SDK_EFFORT_LEVELS, OPENCLAW_THINKING_LEVELS, QWEN_EFFORT_LEVELS, formatEffortLevel, type TransportEffortLevel } from '@shared/effort-levels.js';
import { getSessionAgentGroups, getSessionAgentLabel, SESSION_AGENT_GROUP_LABEL_KEYS } from './session-agent-options.js';
import { QwenCodingPlanHint } from './QwenCodingPlanHint.js';
import { useTransportModels, supportsDynamicTransportModels } from '../hooks/useTransportModels.js';
import {
  buildCcPresetFromDraft,
  createCcPresetDraftFromPreset,
  createDefaultCcPresetDraft,
  type CcPresetEntry,
  type CcPresetDraft,
} from './cc-preset-form.js';
import {
  CC_PRESET_MSG,
  getCcPresetAvailableModelIds,
  getCcPresetEffectiveModel,
  normalizeCcPresetName,
  type CcPreset,
} from '@shared/cc-presets.js';
import { CODEX_MODEL_IDS, GEMINI_MODEL_IDS, mergeModelSuggestions } from '../../../src/shared/models/options.js';
import { loadCodexModelPreference } from '../codex-model-preference.js';

const CURSOR_HEADLESS_MODEL_SUGGESTIONS = ['gpt-5.2'] as const;
const COPILOT_SDK_MODEL_SUGGESTIONS = ['gpt-5.4', 'gpt-5.4-mini'] as const;
const CODEX_SDK_MODEL_SUGGESTIONS = [...CODEX_MODEL_IDS] as const;
const GEMINI_SDK_MODEL_SUGGESTIONS = [...GEMINI_MODEL_IDS] as const;
const responsiveDialogStyle = {
  // Hard-cap against the visual viewport instead of relying on flex padding.
  // iOS can still render a 380px fixed-ish dialog inside a 390px viewport,
  // which clips the custom-provider help text into one-character columns.
  width: 'calc(100vw - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px) - 32px)',
  maxWidth: 380,
  minWidth: 0,
  boxSizing: 'border-box',
  // Long help/preset labels (e.g. Qwen provider URLs) must wrap inside the
  // narrow viewport instead of forcing the dialog to grow past max-width.
  overflowWrap: 'anywhere',
} as const;

interface Props {
  ws: WsClient | null;
  defaultCwd?: string;
  isProviderConnected: (id: string) => boolean;
  getRemoteSessions: (providerId: string) => RemoteSession[];
  refreshSessions: (providerId: string) => void;
  onStart: (type: string, shellBin?: string, cwd?: string, label?: string, extra?: Record<string, unknown>) => void;
  onClose: () => void;
  onToast?: (message: string) => void;
}

type OpenClawMode = 'new' | 'bind';

export function StartSubSessionDialog({ ws, defaultCwd, isProviderConnected: _isProviderConnected, getRemoteSessions, refreshSessions, onStart, onClose, onToast }: Props) {
  const { t } = useTranslation();
  const [type, setType] = useState('claude-code-sdk');
  const [lastUnlockedType, setLastUnlockedType] = useState('claude-code-sdk');
  const [customProviderSdk, setCustomProviderSdk] = useState(false);
  const [shells, setShells] = useState<string[]>([]);
  const [shellBin, setShellBin] = useState<string>('/bin/bash');
  const cwd = defaultCwd ?? '';
  const [label, setLabel] = useState('');
  const [scriptCmd, setScriptCmd] = useState('');
  const [scriptInterval, setScriptInterval] = useState('5');
  const [detectingShells, setDetectingShells] = useState(false);
  const [thinking, setThinking] = useState<TransportEffortLevel>('high');
  const [requestedModel, setRequestedModel] = useState('');

  // OpenClaw-specific state
  const [ocMode, setOcMode] = useState<OpenClawMode>('new');
  const [ocSessionKey, setOcSessionKey] = useState('');
  const [description, setDescription] = useState('');
  const [ocSelectedSession, setOcSelectedSession] = useState('');

  // CC env presets
  const [ccPresets, setCcPresets] = useState<CcPresetEntry[]>([]);
  const [ccPreset, setCcPreset] = useState<string>('');
  const [ccInitPrompt, setCcInitPrompt] = useState<string>('');
  const [showPresetEditor, setShowPresetEditor] = useState(false);
  const defaultPresetDraft = createDefaultCcPresetDraft();
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetBaseUrl, setNewPresetBaseUrl] = useState(defaultPresetDraft.baseUrl);
  const [newPresetToken, setNewPresetToken] = useState('');
  const [newPresetModel, setNewPresetModel] = useState(defaultPresetDraft.model);
  const [newPresetCtx, setNewPresetCtx] = useState(defaultPresetDraft.contextWindow);
  const [newPresetCustomEnv, setNewPresetCustomEnv] = useState<Array<{ key: string; value: string }>>(defaultPresetDraft.customEnv);
  const [newPresetInit, setNewPresetInit] = useState(defaultPresetDraft.initMessage);
  const [newPresetAvailableModels, setNewPresetAvailableModels] = useState(defaultPresetDraft.availableModels);
  const [presetError, setPresetError] = useState('');
  const [discoveringPreset, setDiscoveringPreset] = useState(false);
  const fmtCtx = (v: string) => { const n = parseInt(v, 10); if (!n) return ''; if (n >= 1000000) return `${(n/1000000).toFixed(n%1000000===0?0:1)}M`; if (n >= 1000) return `${(n/1000).toFixed(0)}K`; return String(n); };
  const applyPresetDraft = (draft: CcPresetDraft) => {
    setNewPresetName(draft.name);
    setNewPresetBaseUrl(draft.baseUrl);
    setNewPresetToken(draft.token);
    setNewPresetModel(draft.model);
    setNewPresetCtx(draft.contextWindow);
    setNewPresetCustomEnv(draft.customEnv);
    setNewPresetInit(draft.initMessage);
    setNewPresetAvailableModels(draft.availableModels);
  };
  const buildCurrentPresetDraft = (): CcPresetDraft => ({
    name: newPresetName,
    baseUrl: newPresetBaseUrl,
    token: newPresetToken,
    model: newPresetModel,
    contextWindow: newPresetCtx,
    customEnv: newPresetCustomEnv,
    initMessage: newPresetInit,
    availableModels: newPresetAvailableModels,
  });
  const persistPresetDraft = (): CcPresetEntry => {
    const preset = buildCcPresetFromDraft(buildCurrentPresetDraft());
    const presetKey = normalizeCcPresetName(preset.name);
    const updated = [...ccPresets.filter((p) => normalizeCcPresetName(p.name) !== presetKey), preset];
    setCcPresets(updated);
    try { ws?.send({ type: CC_PRESET_MSG.SAVE, requestId: `cc-preset-save-${Date.now()}`, presets: updated }); } catch {}
    return preset;
  };
  const selectType = (nextType: string) => {
    if (customProviderSdk && nextType !== 'claude-code-sdk') return;
    setType(nextType);
    if (!customProviderSdk) setLastUnlockedType(nextType);
    setPresetError('');
  };
  const toggleCustomProviderSdk = (enabled: boolean) => {
    setCustomProviderSdk(enabled);
    setPresetError('');
    if (enabled) {
      if (type !== 'claude-code-sdk') setLastUnlockedType(type);
      setType('claude-code-sdk');
      return;
    }
    setType(lastUnlockedType);
  };
  const selectedCcPreset = useMemo(
    () => ccPresets.find((preset) => preset.name === ccPreset),
    [ccPreset, ccPresets],
  );
  const qwenPresetModels = useMemo(
    () => selectedCcPreset ? getCcPresetAvailableModelIds(selectedCcPreset) : [],
    [selectedCcPreset],
  );
  const importPresetFromClipboard = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      const parsed = JSON.parse(await navigator.clipboard.readText()) as CcPresetEntry;
      if (!parsed || typeof parsed.name !== 'string' || !parsed.env || typeof parsed.env !== 'object') {
        throw new Error('Invalid preset JSON');
      }
      applyPresetDraft(createCcPresetDraftFromPreset(parsed));
      setCcPreset(parsed.name);
      setShowPresetEditor(true);
      setPresetError('');
    } catch {
      setPresetError(t('new_session.api_provider_import_error'));
    }
  };
  const exportPresetToClipboard = async (preset: CcPresetEntry) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(JSON.stringify(preset, null, 2));
      setPresetError('');
      onToast?.(t('new_session.api_provider_export_success'));
    } catch {
      setPresetError(t('new_session.api_provider_export_error'));
    }
  };

  // Remote sessions come from the provider status hook (pushed on connect, cached in DB)
  const ocRemoteSessions = getRemoteSessions('openclaw');

  const agentGroups = getSessionAgentGroups('sub-session');

  // Load saved shell preference from server
  const defaultShellPref = usePref<string>(PREF_KEY_DEFAULT_SHELL, { parse: parseString });
  useEffect(() => {
    if (defaultShellPref.value) setShellBin(defaultShellPref.value);
  }, [defaultShellPref.value]);

  // Request shell detection from daemon
  useEffect(() => {
    if (!ws) return;

    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'subsession.shells') {
        setShells(msg.shells);
        setDetectingShells(false);
        setShellBin((prev) => (msg.shells.includes(prev) ? prev : (msg.shells[0] ?? prev)));
      }
      if (msg.type === CC_PRESET_MSG.LIST_RESPONSE) {
        setCcPresets((msg as any).presets ?? []);
      }
      if (msg.type === CC_PRESET_MSG.DISCOVER_MODELS_RESPONSE) {
        setDiscoveringPreset(false);
        if (msg.preset) {
          const presetKey = normalizeCcPresetName(msg.preset.name);
          setCcPresets((current) => [
            ...current.filter((preset) => normalizeCcPresetName(preset.name) !== presetKey),
            msg.preset,
          ].filter((preset): preset is CcPreset => preset !== undefined));
          if (newPresetName.trim().toLowerCase() === msg.preset.name.trim().toLowerCase()) {
            applyPresetDraft(createCcPresetDraftFromPreset(msg.preset));
          }
          if (ccPreset === msg.preset.name || !ccPreset) setCcPreset(msg.preset.name);
          const nextModel = getCcPresetEffectiveModel(msg.preset)
            ?? getCcPresetAvailableModelIds(msg.preset)[0];
          if (nextModel) setRequestedModel(nextModel);
        }
        setPresetError(msg.ok ? '' : (msg.error ?? 'Failed to discover models'));
      }
    });

    setDetectingShells(true);
    ws.subSessionDetectShells();
    try { ws.send({ type: CC_PRESET_MSG.LIST }); } catch {}
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  // Auto-generate a session key when switching to openclaw new mode
  useEffect(() => {
    if (type === 'openclaw' && ocMode === 'new' && !ocSessionKey) {
      setOcSessionKey(`oc-${Math.random().toString(36).slice(2, 10)}`);
    }
  }, [type, ocMode, ocSessionKey]);

  useEffect(() => {
    setThinking('high');
  }, [type]);

  useEffect(() => {
    if (!customProviderSdk) return;
    if (type !== 'claude-code-sdk') setType('claude-code-sdk');
    if (!ccPreset && ccPresets.length > 0) setCcPreset(ccPresets[0].name);
  }, [ccPreset, ccPresets, customProviderSdk, type]);

  useEffect(() => {
    if (type !== 'qwen') return;
    const fallbackModel = selectedCcPreset ? (getCcPresetEffectiveModel(selectedCcPreset) ?? '') : '';
    setRequestedModel((current) => {
      if (qwenPresetModels.length === 0) {
        return current || fallbackModel;
      }
      if (
        fallbackModel
        && current === selectedCcPreset?.env.ANTHROPIC_MODEL
        && current !== fallbackModel
        && qwenPresetModels.includes(fallbackModel)
      ) {
        return fallbackModel;
      }
      if (!current || !qwenPresetModels.includes(current)) {
        return qwenPresetModels.includes(fallbackModel) ? fallbackModel : qwenPresetModels[0];
      }
      return current;
    });
  }, [type, qwenPresetModels, selectedCcPreset]);

  const handleStart = () => {
    const desc = description.trim() || undefined;
    if (customProviderSdk && !ccPreset) {
      setPresetError(t('new_session.custom_provider_preset_required'));
      setShowPresetEditor(true);
      return;
    }
    if (type === 'script') {
      if (!scriptCmd.trim()) return;
      const interval = Math.max(1, parseInt(scriptInterval, 10) || 5);
      const escaped = scriptCmd.trim().replace(/'/g, "'\\''");
      const wrapper = `bash -c 'while true; do clear; ${escaped}; sleep ${interval}; done'`;
      onStart('script', wrapper, cwd || undefined, label || scriptCmd.trim().slice(0, 30), desc ? { description: desc } : undefined);
      return;
    }
    if (type === 'openclaw') {
      const extra =
        ocMode === 'bind'
          ? { ocMode: 'bind', ocSessionId: ocSelectedSession, description: desc, thinking }
          : { ocMode: 'new', ocSessionKey: ocSessionKey.trim(), description: desc, thinking };
      onStart('openclaw', undefined, cwd || undefined, label || undefined, extra);
      return;
    }
    const selectedShell = type === 'shell' ? (shellBin || undefined) : undefined;
    if (type === 'shell' && selectedShell) {
      void defaultShellPref.save(selectedShell).catch(() => {});
    }
    const extra: Record<string, unknown> = {};
    if (desc) extra.description = desc;
    if (ccPreset && (type === 'claude-code' || type === 'claude-code-sdk' || type === 'qwen')) extra.ccPreset = ccPreset;
    if (ccInitPrompt.trim() && type === 'claude-code') extra.ccInitPrompt = ccInitPrompt.trim();
    if ((type === 'codex-sdk' || type === 'copilot-sdk' || type === 'cursor-headless' || type === 'opencode-sdk' || type === 'gemini-sdk' || type === 'grok-sdk' || type === 'kimi-sdk' || type === 'qwen') && requestedModel.trim()) extra.requestedModel = requestedModel.trim();
    if (type === 'claude-code-sdk' || type === 'codex-sdk' || type === 'copilot-sdk' || type === 'qwen') extra.thinking = thinking;
    onStart(type, selectedShell, cwd || undefined, label || undefined, Object.keys(extra).length > 0 ? extra : undefined);
  };

  const thinkingLevels = type === 'claude-code-sdk'
    ? CLAUDE_SDK_EFFORT_LEVELS
    : type === 'codex-sdk'
      ? CODEX_SDK_EFFORT_LEVELS
      : type === 'copilot-sdk'
        ? COPILOT_SDK_EFFORT_LEVELS
        : type === 'qwen'
          ? QWEN_EFFORT_LEVELS
          : type === 'openclaw'
            ? OPENCLAW_THINKING_LEVELS
            : [];
  const supportsCcPreset = type === 'claude-code' || type === 'claude-code-sdk' || type === 'qwen';
  const providerPresetLabel = customProviderSdk
    ? t('new_session.custom_provider_preset')
    : type === 'qwen'
      ? t('new_session.compatible_api_via_qwen')
      : t('new_session.api_provider');
  const dynamicModelsAgentType = supportsDynamicTransportModels(type) ? type : null;
  const transportModels = useTransportModels(ws, dynamicModelsAgentType);
  const supportsModelSelection = type === 'codex-sdk' || type === 'copilot-sdk' || type === 'cursor-headless' || type === 'opencode-sdk' || type === 'gemini-sdk' || type === 'grok-sdk' || type === 'kimi-sdk' || (type === 'qwen' && !!selectedCcPreset);
  const modelSuggestions = useMemo(() => (
    type === 'qwen' && selectedCcPreset
      ? qwenPresetModels
    : transportModels.models.length > 0
      ? (type === 'gemini-sdk'
        ? mergeModelSuggestions(GEMINI_SDK_MODEL_SUGGESTIONS, transportModels.models.map((model) => model.id))
        : type === 'codex-sdk'
          ? mergeModelSuggestions(CODEX_SDK_MODEL_SUGGESTIONS, transportModels.models.map((model) => model.id))
        : transportModels.models.map((model) => model.id))
      : type === 'codex-sdk'
        ? [...CODEX_SDK_MODEL_SUGGESTIONS]
      : type === 'copilot-sdk'
        ? [...COPILOT_SDK_MODEL_SUGGESTIONS]
        : type === 'cursor-headless'
          ? [...CURSOR_HEADLESS_MODEL_SUGGESTIONS]
        : type === 'qwen'
            ? qwenPresetModels
            : type === 'gemini-sdk'
              ? [...GEMINI_SDK_MODEL_SUGGESTIONS]
              : []
  ), [transportModels.models, type, qwenPresetModels, selectedCcPreset]);

  useEffect(() => {
    if (type !== 'codex-sdk') return;
    setRequestedModel((current) => {
      const trimmed = current.trim();
      if (trimmed && (modelSuggestions.length === 0 || modelSuggestions.includes(trimmed))) return trimmed;
      const stored = loadCodexModelPreference();
      if (stored && (modelSuggestions.length === 0 || modelSuggestions.includes(stored))) return stored;
      const fallback = CODEX_SDK_MODEL_SUGGESTIONS[0];
      if (modelSuggestions.length === 0 || modelSuggestions.includes(fallback)) return fallback;
      if (transportModels.defaultModel && (modelSuggestions.length === 0 || modelSuggestions.includes(transportModels.defaultModel))) {
        return transportModels.defaultModel;
      }
      return modelSuggestions[0] ?? fallback;
    });
  }, [type, modelSuggestions, transportModels.defaultModel]);

  return (
    <div class="dialog-overlay">
      <div class="dialog" style={responsiveDialogStyle}>
        <div class="dialog-header">
          <span>New Sub-Session</span>
          <button class="dialog-close" onClick={onClose}>×</button>
        </div>

        <div class="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Type selection */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Type</div>
            <div class="subsession-type-groups">
              {agentGroups.map((group) => (
                <div key={group.id} class="subsession-type-group">
                  <div class="subsession-type-group-title">{t(SESSION_AGENT_GROUP_LABEL_KEYS[group.id])}</div>
                  <div class="subsession-type-grid">
                    {group.items.map((choice) => (
                      <button
                        key={choice.id}
                        class={`subsession-type-btn${type === choice.id ? ' active' : ''}`}
                        disabled={customProviderSdk && choice.id !== 'claude-code-sdk'}
                        onClick={() => selectType(choice.id)}
                      >
                        <span>{choice.icon}</span> {getSessionAgentLabel(t, choice)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                }}
              >
                {/*
                 * Mirror NewSessionDialog: width:auto + margin:0 defend
                 * against any global `input { width: 100% }` rule (this
                 * dialog doesn't currently use .form-group but the
                 * regression must stay symmetric). flex:1 1 auto + minWidth:0
                 * on the span lets the label text wrap normally inside the
                 * dialog instead of overflowing.
                 */}
                <input
                  type="checkbox"
                  checked={customProviderSdk}
                  onChange={(e) => toggleCustomProviderSdk((e.target as HTMLInputElement).checked)}
                  style={{ flex: '0 0 auto', width: 'auto', margin: 0 }}
                />
                <span
                  style={{
                    color: '#e2e8f0',
                    fontSize: 13,
                    overflowWrap: 'break-word',
                    minWidth: 0,
                    flex: '1 1 auto',
                  }}
                >
                  {t('new_session.custom_provider_sdk')}
                </span>
              </label>
              <div
                style={{
                  marginLeft: 24,
                  marginTop: 4,
                  color: '#94a3b8',
                  fontSize: 12,
                  lineHeight: 1.35,
                }}
              >
                {t('new_session.custom_provider_sdk_help')}
              </div>
            </div>
            <QwenCodingPlanHint selected={customProviderSdk || type === 'qwen'} />
          </div>

          {/* Script command (only for script type) */}
          {type === 'script' && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Command</div>
              <input
                class="input"
                placeholder="e.g. df -h, kubectl get pods, htop -t"
                value={scriptCmd}
                onInput={(e) => setScriptCmd((e.target as HTMLInputElement).value)}
                style={{ width: '100%' }}
                autoFocus
              />
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 12, marginBottom: 8 }}>Interval (seconds)</div>
              <input
                class="input"
                type="number"
                min="1"
                value={scriptInterval}
                onInput={(e) => setScriptInterval((e.target as HTMLInputElement).value)}
                style={{ width: 80 }}
              />
            </div>
          )}

          {/* Shell binary picker (only for shell type) */}
          {type === 'shell' && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Shell</div>
              {detectingShells ? (
                <div style={{ fontSize: 12, color: '#64748b' }}>Detecting shells...</div>
              ) : shells.length > 0 ? (
                <select
                  class="input"
                  value={shellBin}
                  onInput={(e) => setShellBin((e.target as HTMLSelectElement).value)}
                  style={{ width: '100%' }}
                >
                  {shells.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : (
                <input
                  class="input"
                  placeholder="/bin/bash"
                  value={shellBin}
                  onInput={(e) => setShellBin((e.target as HTMLInputElement).value)}
                  style={{ width: '100%' }}
                />
              )}
            </div>
          )}

          {/* OpenClaw-specific options — always show, even if provider not yet connected */}
          {type === 'openclaw' && (
            <>
              <div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.sessionMode')}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <button
                    class={`subsession-type-btn${ocMode === 'new' ? ' active' : ''}`}
                    onClick={() => setOcMode('new')}
                  >
                    {t('session.newSession')}
                  </button>
                  <button
                    class={`subsession-type-btn${ocMode === 'bind' ? ' active' : ''}`}
                    onClick={() => setOcMode('bind')}
                  >
                    {t('session.bindExisting')}
                  </button>
                </div>
              </div>

              {ocMode === 'bind' ? (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: '#94a3b8' }}>{t('session.selectSession')}</div>
                    <button
                      type="button"
                      class="btn btn-secondary"
                      onClick={() => refreshSessions('openclaw')}
                      style={{ fontSize: 10, padding: '2px 8px', lineHeight: 1.4 }}
                      title={t('common.refresh')}
                    >
                      {t('common.refresh')}
                    </button>
                  </div>
                  {ocRemoteSessions.length === 0 ? (
                    <div style={{ fontSize: 12, color: '#64748b' }}>{t('session.noSessions')}</div>
                  ) : (
                    <select
                      class="input"
                      value={ocSelectedSession}
                      onInput={(e) => setOcSelectedSession((e.target as HTMLSelectElement).value)}
                      style={{ width: '100%' }}
                    >
                      <option value="">{t('session.selectSession')}</option>
                      {ocRemoteSessions.map((s) => (
                        <option key={s.key} value={s.key}>{s.displayName || s.key}</option>
                      ))}
                    </select>
                  )}
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.sessionKey')}</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      class="input"
                      type="text"
                      value={ocSessionKey}
                      onInput={(e) => setOcSessionKey((e.target as HTMLInputElement).value)}
                      autoComplete="off"
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      class="btn btn-secondary"
                      onClick={() => setOcSessionKey(`oc-${Math.random().toString(36).slice(2, 10)}`)}
                      style={{ whiteSpace: 'nowrap', fontSize: 12 }}
                    >
                      {t('session.autoGenerate')}
                    </button>
                  </div>
                </div>
              )}

            </>
          )}

          {/* CC env preset selector + editor */}
          {supportsCcPreset && (
            <>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>{providerPresetLabel}</span>
                  <button type="button" style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: 11, padding: 0 }} onClick={() => setShowPresetEditor(!showPresetEditor)}>
                    {showPresetEditor ? `▾ ${t('common.close')}` : t('new_session.api_provider_add_edit')}
                  </button>
                </div>
	                {ccPresets.length > 0 ? (
	                  <select class="input" value={ccPreset} onInput={(e) => setCcPreset((e.target as HTMLSelectElement).value)} style={{ width: '100%' }}>
	                    <option value="">{t('new_session.api_provider_default')}</option>
	                    {ccPresets.map((p) => <option key={p.name} value={p.name}>{p.name}{getCcPresetEffectiveModel(p) ? ` (${getCcPresetEffectiveModel(p)})` : ''}</option>)}
	                  </select>
                ) : !showPresetEditor && (
                  <div style={{ fontSize: 11, color: '#475569' }}>{t('new_session.api_provider_default')}</div>
                )}
              </div>

              {showPresetEditor && (
                <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: 10, fontSize: 11 }}>
                  <div style={{ color: '#64748b', marginBottom: 4, fontSize: 10 }}>Stored locally (~/.imcodes/cc-presets.json)</div>
                  {presetError && <div style={{ color: '#ef4444', fontSize: 11, marginBottom: 4 }}>{presetError}</div>}
                  {[
                    { label: 'Preset Name', envKey: '', ph: 'e.g. MiniMax', val: newPresetName, set: setNewPresetName },
                    { label: 'API Base URL', envKey: 'ANTHROPIC_BASE_URL', ph: 'https://api.minimax.io/anthropic', val: newPresetBaseUrl, set: setNewPresetBaseUrl },
                    { label: 'API Key', envKey: 'ANTHROPIC_AUTH_TOKEN', ph: 'your-api-key', val: newPresetToken, set: setNewPresetToken, type: 'password' as const },
                    { label: 'Model', envKey: 'ANTHROPIC_MODEL', ph: 'e.g. MiniMax-M2.7', val: newPresetModel, set: setNewPresetModel },
                  ].map(({ label, envKey, ph, val, set, type }) => (
                    <div key={label} style={{ marginBottom: 4 }}>
                      <div style={{ fontSize: 9, color: '#64748b', marginBottom: 1 }}>{label}{envKey && <span style={{ color: '#334155', marginLeft: 4 }}>{envKey}</span>}</div>
                      <input class="input" type={type ?? 'text'} placeholder={ph} value={val} onInput={(e) => set((e.target as HTMLInputElement).value)} style={{ width: '100%', fontSize: 11 }} />
                    </div>
                  ))}
                  {newPresetAvailableModels.length > 0 && (
                    <div style={{ marginBottom: 4 }}>
                      <div style={{ fontSize: 9, color: '#64748b', marginBottom: 1 }}>Discovered Models</div>
                      <select class="input" value={newPresetModel} onInput={(e) => setNewPresetModel((e.target as HTMLSelectElement).value)} style={{ width: '100%', fontSize: 11 }}>
                        {newPresetAvailableModels.map((item) => (
                          <option key={item.id} value={item.id}>{item.name ? `${item.name} (${item.id})` : item.id}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 9, color: '#64748b', marginBottom: 1 }}>Context Window{newPresetCtx && <span style={{ color: '#3b82f6', marginLeft: 4 }}>{fmtCtx(newPresetCtx)}</span>}</div>
                    <input class="input" type="text" placeholder="1000000" value={newPresetCtx} onInput={(e) => setNewPresetCtx((e.target as HTMLInputElement).value)} style={{ width: '100%', fontSize: 11 }} />
                  </div>
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 1 }}>
                      <span style={{ fontSize: 9, color: '#64748b' }}>Custom ENV Vars</span>
                      <button type="button" style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: 9, padding: 0 }} onClick={() => setNewPresetCustomEnv([...newPresetCustomEnv, { key: '', value: '' }])}>+ Add</button>
                    </div>
                    {newPresetCustomEnv.map((item, i) => (
                      <div key={i} style={{ display: 'flex', gap: 3, marginBottom: 2 }}>
                        <input class="input" placeholder="ENV_KEY" value={item.key} onInput={(e) => { const u = [...newPresetCustomEnv]; u[i] = { ...u[i], key: (e.target as HTMLInputElement).value }; setNewPresetCustomEnv(u); }} style={{ flex: 1, fontSize: 10, fontFamily: 'monospace' }} />
                        <input class="input" placeholder="value" value={item.value} onInput={(e) => { const u = [...newPresetCustomEnv]; u[i] = { ...u[i], value: (e.target as HTMLInputElement).value }; setNewPresetCustomEnv(u); }} style={{ flex: 2, fontSize: 10 }} />
                        <button type="button" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 11, padding: '0 3px' }} onClick={() => setNewPresetCustomEnv(newPresetCustomEnv.filter((_, j) => j !== i))}>×</button>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 9, color: '#64748b', marginBottom: 1 }}>Init Message</div>
                    <textarea class="input" value={newPresetInit} rows={2} onInput={(e) => setNewPresetInit((e.target as HTMLTextAreaElement).value)} style={{ width: '100%', fontSize: 10, resize: 'vertical' }} />
                  </div>
                  <button type="button" class="btn btn-primary" style={{ fontSize: 11, padding: '3px 10px' }} disabled={!newPresetName.trim() || !newPresetBaseUrl.trim()}
                    onClick={() => {
                      const preset = persistPresetDraft();
                      applyPresetDraft(createDefaultCcPresetDraft());
                      setCcPreset(preset.name); setPresetError('');
                    }}
                  >Save</button>
                  <button
                    type="button"
                    class="btn btn-secondary"
                    style={{ fontSize: 11, padding: '3px 10px', marginLeft: 8 }}
                    onClick={() => { void importPresetFromClipboard(); }}
                  >{t('new_session.api_provider_import_json')}</button>
	                  <button
                    type="button"
                    class="btn btn-secondary"
                    style={{ fontSize: 11, padding: '3px 10px', marginLeft: 8 }}
                    disabled={discoveringPreset || !newPresetName.trim() || !newPresetBaseUrl.trim() || !newPresetToken.trim()}
                    onClick={() => {
                      if (!ws?.connected) {
                        setPresetError('Daemon offline');
                        return;
                      }
                      const preset = persistPresetDraft();
                      setCcPreset(preset.name);
                      setDiscoveringPreset(true);
                      setPresetError('');
                      try {
                        ws.send({
                          type: CC_PRESET_MSG.DISCOVER_MODELS,
                          requestId: `cc-preset-discover-${Date.now()}`,
                          presetName: preset.name,
                        });
                      } catch {
                        setDiscoveringPreset(false);
                        setPresetError('Failed to send discover request');
                      }
                    }}
                  >{discoveringPreset ? 'Discovering...' : 'Discover Models'}</button>
                  {ccPresets.length > 0 && (
                    <div style={{ marginTop: 8, borderTop: '1px solid #334155', paddingTop: 6 }}>
                      {ccPresets.map((p) => (
                        <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 11 }}>
	                          <span style={{ color: '#e2e8f0' }}>{p.name} <span style={{ color: '#475569' }}>{getCcPresetEffectiveModel(p) ?? ''}</span></span>
	                          <div style={{ display: 'flex', gap: 4 }}>
                            <button type="button" style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: 10 }} onClick={() => {
                              applyPresetDraft(createCcPresetDraftFromPreset(p));
                              setPresetError(p.modelDiscoveryError ?? '');
                            }}>Edit</button>
	                            <button type="button" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 10 }} onClick={() => { const u = ccPresets.filter(x => normalizeCcPresetName(x.name) !== normalizeCcPresetName(p.name)); setCcPresets(u); try { ws?.send({ type: CC_PRESET_MSG.SAVE, requestId: `cc-preset-save-${Date.now()}`, presets: u }); } catch {} if (normalizeCcPresetName(ccPreset) === normalizeCcPresetName(p.name)) setCcPreset(''); }}>Del</button>
                            <button type="button" style={{ background: 'none', border: 'none', color: '#22c55e', cursor: 'pointer', fontSize: 10 }} onClick={() => { void exportPresetToClipboard(p); }}>{t('new_session.api_provider_export_json')}</button>
	                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {ccPreset && (
                <div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Extra init prompt</div>
                  <textarea class="input" placeholder="Additional instruction..." value={ccInitPrompt} rows={2} onInput={(e) => setCcInitPrompt((e.target as HTMLTextAreaElement).value)} style={{ width: '100%', resize: 'vertical' }} />
                </div>
              )}
            </>
          )}

          {/* Working directory */}
          {thinkingLevels.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.thinking')}</div>
              <select
                class="input"
                value={thinking}
                onInput={(e) => setThinking((e.target as HTMLSelectElement).value as TransportEffortLevel)}
                style={{ width: '100%' }}
              >
                {thinkingLevels.map((level) => (
                  <option key={level} value={level}>{formatEffortLevel(level)}</option>
                ))}
              </select>
            </div>
          )}

          {supportsModelSelection && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.supervision.model')}</div>
              {type === 'qwen' && modelSuggestions.length > 0 ? (
                <select
                  class="input"
                  value={requestedModel}
                  onInput={(e) => setRequestedModel((e.target as HTMLSelectElement).value)}
                  style={{ width: '100%' }}
                >
                  {modelSuggestions.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              ) : (
                <input
                  class="input"
                  type="text"
                  list={`sub-session-model-options-${type}`}
                  placeholder={t('session.supervision.selectModel')}
                  value={requestedModel}
                  onInput={(e) => setRequestedModel((e.target as HTMLInputElement).value)}
                  style={{ width: '100%' }}
                />
              )}
              {modelSuggestions.length > 0 && (
                <datalist id={`sub-session-model-options-${type}`}>
                  {modelSuggestions.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              )}
              {type === 'grok-sdk' && transportModels.error && (
                <div role="alert" style={{ marginTop: 6, color: '#fca5a5', fontSize: 12 }}>
                  {t('new_session.grok_prerequisite_error', { error: transportModels.error })}
                </div>
              )}
            </div>
          )}

          {/* Working directory */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.subsessionWorkingDirectory')}</div>
            <div class="input-with-browse">
              <input
                class="input"
                placeholder={t('session.subsessionWorkingDirectoryPlaceholder')}
                value={cwd}
                disabled
                readOnly
                aria-disabled="true"
              />
            </div>
            <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>
              {t('session.subsessionWorkingDirectoryLocked')}
            </div>
          </div>

          {/* Label */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Label (optional)</div>
            <input
              class="input"
              placeholder="e.g. backend"
              value={label}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              style={{ width: '100%' }}
            />
          </div>

          {/* Description / persona */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.description')}</div>
            <textarea
              class="input"
              placeholder={t('session.descriptionPlaceholder')}
              value={description}
              onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
              rows={2}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>
        </div>

        <div class="dialog-footer">
          <button class="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button class="btn btn-primary" onClick={handleStart}>Launch</button>
        </div>
      </div>
    </div>
  );
}
