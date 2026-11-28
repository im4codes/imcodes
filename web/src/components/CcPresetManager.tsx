import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  getCcPresetEffectiveModel,
  normalizeCcPresetName,
  type CcPreset,
  type CcPresetAuthType,
} from '@shared/cc-presets.js';
import {
  CC_PRESET_ERR_CONFLICT,
  CC_PRESET_ERR_DISCOVER_FAILED,
  CC_PRESET_ERR_NOT_LOADED,
  CC_PRESET_ERR_OFFLINE,
  CC_PRESET_ERR_RECONNECTED,
  CC_PRESET_ERR_SAVE_FAILED,
  CC_PRESET_ERR_SAVE_IN_PROGRESS,
  CC_PRESET_ERR_SYNCING,
  CC_PRESET_ERR_TIMEOUT,
  useCcPresets,
  type CcPresetDiscoverResult,
  type CcPresetSaveResult,
} from '../hooks/useCcPresets.js';
import type { WsClient } from '../ws-client.js';
import {
  buildCcPresetFromDraft,
  createCcPresetDraftFromPreset,
  createDefaultCcPresetDraft,
  DEFAULT_CC_PRESET_BASE_URL,
  DEFAULT_CC_PRESET_MODEL,
  DEFAULT_OPENAI_PRESET_BASE_URL,
  DEFAULT_OPENAI_PRESET_MODEL,
  type CcPresetDraft,
} from './cc-preset-form.js';

function formatContextWindowBadge(value: string): string {
  const n = parseInt(value, 10);
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatPresetError(t: (key: string) => string, raw: string): string {
  if (!raw) return '';
  if (raw === CC_PRESET_ERR_OFFLINE) return t('new_session.daemon_offline');
  if (raw === CC_PRESET_ERR_NOT_LOADED) return t('ccPreset.notLoadedError');
  if (raw === CC_PRESET_ERR_SYNCING) return t('ccPreset.syncingError');
  if (raw === CC_PRESET_ERR_SAVE_IN_PROGRESS) return t('ccPreset.saveInProgressError');
  if (raw === CC_PRESET_ERR_CONFLICT) return t('ccPreset.conflictError');
  if (raw === CC_PRESET_ERR_RECONNECTED) return t('ccPreset.reconnectedError');
  if (raw === CC_PRESET_ERR_TIMEOUT) return t('ccPreset.timeoutError');
  if (raw === CC_PRESET_ERR_SAVE_FAILED) return t('ccPreset.saveFailed');
  if (raw === CC_PRESET_ERR_DISCOVER_FAILED) return t('ccPreset.discoverFailed');
  return raw;
}

export interface CcPresetEditorPanelProps {
  ws: WsClient | null;
  presets: CcPreset[];
  loaded?: boolean;
  loading?: boolean;
  refreshing?: boolean;
  saving?: boolean;
  discovering: boolean;
  error: string;
  onClearError: () => void;
  onError: (message: string) => void;
  onSavePreset: (preset: CcPreset) => Promise<CcPresetSaveResult> | CcPresetSaveResult;
  onDeletePreset: (name: string) => Promise<CcPresetSaveResult> | CcPresetSaveResult;
  onDiscoverModels: (preset: CcPreset) => Promise<CcPresetDiscoverResult> | CcPresetDiscoverResult;
  selectedPresetName?: string;
  onSelectPresetName?: (name: string) => void;
  onToast?: (message: string) => void;
  radioName?: string;
  compact?: boolean;
  standalone?: boolean;
}

export function CcPresetEditorPanel({
  ws,
  presets,
  loaded = true,
  loading = false,
  refreshing = false,
  saving = false,
  discovering,
  error,
  onClearError,
  onError,
  onSavePreset,
  onDeletePreset,
  onDiscoverModels,
  selectedPresetName,
  onSelectPresetName,
  onToast,
  radioName = 'cc-preset-auth-type',
  compact = false,
  standalone = false,
}: CcPresetEditorPanelProps) {
  const { t } = useTranslation();
  const [draft, setDraftState] = useState<CcPresetDraft>(() => createDefaultCcPresetDraft());
  const draftNameRef = useRef(draft.name);
  draftNameRef.current = draft.name;
  const draftVersionRef = useRef(0);
  const selectedPresetRef = useRef(selectedPresetName);
  const prevSelectedPresetRef = useRef(selectedPresetName);
  const selectionEpochRef = useRef(0);
  if (prevSelectedPresetRef.current !== selectedPresetName) {
    prevSelectedPresetRef.current = selectedPresetName;
    selectionEpochRef.current += 1;
  }
  selectedPresetRef.current = selectedPresetName;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const updateDraft = (updater: CcPresetDraft | ((prev: CcPresetDraft) => CcPresetDraft)) => {
    draftVersionRef.current += 1;
    setDraftState(updater);
  };

  const setField = <K extends keyof CcPresetDraft>(key: K, value: CcPresetDraft[K]) => {
    updateDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleProtocolChange = (authType: CcPresetAuthType) => {
    updateDraft((prev) => {
      if (authType === 'openai') {
        return {
          ...prev,
          authType: 'openai',
          baseUrl: !prev.baseUrl || prev.baseUrl === DEFAULT_CC_PRESET_BASE_URL
            ? DEFAULT_OPENAI_PRESET_BASE_URL
            : prev.baseUrl,
          model: !prev.model || prev.model === DEFAULT_CC_PRESET_MODEL
            ? DEFAULT_OPENAI_PRESET_MODEL
            : prev.model,
        };
      }
      return {
        ...prev,
        authType: 'anthropic',
        baseUrl: !prev.baseUrl || prev.baseUrl === DEFAULT_OPENAI_PRESET_BASE_URL
          ? DEFAULT_CC_PRESET_BASE_URL
          : prev.baseUrl,
        model: !prev.model || prev.model === DEFAULT_OPENAI_PRESET_MODEL
          ? DEFAULT_CC_PRESET_MODEL
          : prev.model,
      };
    });
  };

  const handleSave = async () => {
    const saveDraftVersion = draftVersionRef.current;
    const saveSelectionEpoch = selectionEpochRef.current;
    const preset = buildCcPresetFromDraft(draft);
    const result = await onSavePreset(preset);
    if (!mountedRef.current || !result.ok) return;
    if (draftVersionRef.current === saveDraftVersion) {
      updateDraft(createDefaultCcPresetDraft());
      if (selectionEpochRef.current === saveSelectionEpoch) {
        onSelectPresetName?.(preset.name);
      }
      onClearError();
    }
  };

  const handleImport = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      const parsed = JSON.parse(await navigator.clipboard.readText()) as CcPreset;
      if (!parsed || typeof parsed.name !== 'string' || !parsed.env || typeof parsed.env !== 'object') {
        throw new Error('Invalid preset JSON');
      }
      updateDraft(createCcPresetDraftFromPreset(parsed));
      onSelectPresetName?.(parsed.name);
      onClearError();
    } catch {
      onError(t('new_session.api_provider_import_error'));
    }
  };

  const handleExport = async (preset: CcPreset) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(JSON.stringify(preset, null, 2));
      onClearError();
      onToast?.(t('new_session.api_provider_export_success'));
    } catch {
      onError(t('new_session.api_provider_export_error'));
    }
  };

  const handleDiscover = async () => {
    const sentPresetKey = normalizeCcPresetName(draft.name);
    const sentModel = draft.model;
    const preset = buildCcPresetFromDraft(draft);
    if (!ws?.connected) {
      onError(CC_PRESET_ERR_OFFLINE);
      return;
    }
    const result = await onDiscoverModels(preset);
    if (!mountedRef.current || !result.ok || !result.preset) return;
    // Update only the current draft's discovered model fields; parent dialog owns session ccPreset selection.
    if (normalizeCcPresetName(draftNameRef.current) === normalizeCcPresetName(result.preset.name)
        && sentPresetKey === normalizeCcPresetName(result.preset.name)) {
      const nextModel = getCcPresetEffectiveModel(result.preset);
      setDraftState((prev) => ({
        ...prev,
        availableModels: result.preset?.availableModels ?? [],
        model: prev.model === sentModel && nextModel ? nextModel : prev.model,
      }));
    }
  };

  const handleDelete = async (presetName: string) => {
    const result = await onDeletePreset(presetName);
    if (!mountedRef.current || !result.ok) return;
    const currentSelected = selectedPresetRef.current;
    if (currentSelected && normalizeCcPresetName(currentSelected) === normalizeCcPresetName(presetName)) {
      onSelectPresetName?.('');
    }
  };

  const displayError = formatPresetError(t, error);
  const isOpenAi = draft.authType === 'openai';
  const inputStyle = compact
    ? { width: '100%', fontSize: 11 }
    : {
        width: '100%',
        background: '#1e293b',
        border: '1px solid #334155',
        color: '#e2e8f0',
        padding: '5px 8px',
        borderRadius: 4,
        fontSize: 12,
        boxSizing: 'border-box' as const,
      };
  const labelStyle = compact
    ? { fontSize: 9, color: '#64748b', marginBottom: 1 }
    : { fontSize: 10, color: '#64748b', marginBottom: 2 };

  return (
    <div
      class={standalone ? 'cc-preset-editor cc-preset-editor-standalone' : 'cc-preset-editor'}
      style={{
        background: '#0f172a',
        border: '1px solid #334155',
        borderRadius: 6,
        padding: compact ? 10 : 12,
        marginBottom: standalone || compact ? 0 : 12,
        fontSize: compact ? 11 : 12,
      }}
    >
      {!compact && !standalone && (
        <div style={{ marginBottom: 4, fontWeight: 600, color: '#94a3b8' }}>
          {t('ccPreset.editorTitle')}
        </div>
      )}
      <div style={{ fontSize: 10, color: compact ? '#64748b' : '#475569', marginBottom: compact ? 4 : 8 }}>
        {t('ccPreset.storageHint')}
      </div>
      {(!loaded || refreshing) && (
        <div data-testid="cc-preset-loading" style={{ color: '#94a3b8', fontSize: 11, marginBottom: 6 }}>
          {loading || refreshing ? t('ccPreset.loadingList') : t('ccPreset.notLoadedError')}
        </div>
      )}
      {compact && displayError && (
        <div role="alert" style={{ color: '#ef4444', fontSize: 11, marginBottom: 4 }}>{displayError}</div>
      )}

      <div style={{ marginBottom: compact ? 6 : 8 }}>
        <div style={{ fontSize: compact ? 9 : 10, color: '#64748b', marginBottom: 2 }}>
          {t('ccPreset.protocolLabel')}
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: compact ? 10 : 11, color: '#e2e8f0' }}>
            <input
              type="radio"
              name={radioName}
              value="anthropic"
              checked={draft.authType === 'anthropic'}
              onChange={() => handleProtocolChange('anthropic')}
            />
            {t('ccPreset.protocolAnthropic')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: compact ? 10 : 11, color: '#e2e8f0' }}>
            <input
              type="radio"
              name={radioName}
              value="openai"
              checked={draft.authType === 'openai'}
              onChange={() => handleProtocolChange('openai')}
            />
            {t('ccPreset.protocolOpenAi')}
          </label>
        </div>
      </div>

      {[
        {
          label: t('ccPreset.nameLabel'),
          envKey: '',
          ph: t('ccPreset.namePlaceholder'),
          val: draft.name,
          onChange: (val: string) => setField('name', val),
          type: 'text' as const,
        },
        {
          label: t('ccPreset.baseUrlLabel'),
          envKey: isOpenAi ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL',
          ph: isOpenAi ? DEFAULT_OPENAI_PRESET_BASE_URL : DEFAULT_CC_PRESET_BASE_URL,
          val: draft.baseUrl,
          onChange: (val: string) => setField('baseUrl', val),
          type: 'text' as const,
        },
        {
          label: t('ccPreset.apiKeyLabel'),
          envKey: isOpenAi ? 'OPENAI_API_KEY' : (compact ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'),
          ph: t('ccPreset.apiKeyPlaceholder'),
          val: draft.token,
          onChange: (val: string) => setField('token', val),
          type: 'password' as const,
        },
        {
          label: t('ccPreset.modelLabel'),
          envKey: isOpenAi ? 'OPENAI_MODEL' : 'ANTHROPIC_MODEL',
          ph: isOpenAi ? DEFAULT_OPENAI_PRESET_MODEL : DEFAULT_CC_PRESET_MODEL,
          val: draft.model,
          onChange: (val: string) => setField('model', val),
          type: 'text' as const,
        },
      ].map(({ label, envKey, ph, val, onChange, type }) => (
        <div key={label} style={{ marginBottom: compact ? 4 : 5 }}>
          <div style={labelStyle}>
            {label}
            {envKey && <span style={{ color: '#334155', marginLeft: 4 }}>{envKey}</span>}
          </div>
          <input
            class={compact ? 'input' : undefined}
            type={type}
            placeholder={ph}
            value={val}
            onInput={(e) => onChange((e.target as HTMLInputElement).value)}
            style={inputStyle}
          />
        </div>
      ))}

      {draft.availableModels.length > 0 && (
        <div style={{ marginBottom: compact ? 4 : 5 }}>
          <div style={labelStyle}>{t('ccPreset.discoveredModelsLabel')}</div>
          <select
            class={compact ? 'input' : undefined}
            value={draft.model}
            onInput={(e) => setField('model', (e.target as HTMLSelectElement).value)}
            style={inputStyle}
          >
            {draft.availableModels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name ? `${item.name} (${item.id})` : item.id}
              </option>
            ))}
          </select>
        </div>
      )}

      <div style={{ marginBottom: compact ? 4 : 5 }}>
        <div style={labelStyle}>
          {t('ccPreset.contextWindowLabel')}
          {draft.contextWindow && (
            <span style={{ color: '#3b82f6', marginLeft: compact ? 4 : 6 }}>
              {formatContextWindowBadge(draft.contextWindow)}
            </span>
          )}
        </div>
        <input
          class={compact ? 'input' : undefined}
          type="text"
          placeholder="1000000"
          value={draft.contextWindow}
          onInput={(e) => setField('contextWindow', (e.target as HTMLInputElement).value)}
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: compact ? 4 : 5 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: compact ? 1 : 2 }}>
          <span style={{ fontSize: compact ? 9 : 10, color: '#64748b' }}>
            {t('ccPreset.customEnvLabel')}
          </span>
          <button
            type="button"
            style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: compact ? 9 : 10, padding: 0 }}
            onClick={() => setField('customEnv', [...draft.customEnv, { key: '', value: '' }])}
          >
            {t('ccPreset.addEnvVar')}
          </button>
        </div>
        {draft.customEnv.map((item, idx) => (
          <div key={idx} style={{ display: 'flex', gap: compact ? 3 : 4, marginBottom: compact ? 2 : 3 }}>
            <input
              class={compact ? 'input' : undefined}
              type="text"
              placeholder="ENV_KEY"
              value={item.key}
              onInput={(e) => {
                const updated = [...draft.customEnv];
                updated[idx] = { ...updated[idx], key: (e.target as HTMLInputElement).value };
                setField('customEnv', updated);
              }}
              style={compact
                ? { flex: 1, fontSize: 10, fontFamily: 'monospace' }
                : { flex: 1, background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 6px', borderRadius: 4, fontSize: 11, fontFamily: 'monospace', boxSizing: 'border-box' as const }}
            />
            <input
              class={compact ? 'input' : undefined}
              type="text"
              placeholder={t('ccPreset.envValuePlaceholder')}
              value={item.value}
              onInput={(e) => {
                const updated = [...draft.customEnv];
                updated[idx] = { ...updated[idx], value: (e.target as HTMLInputElement).value };
                setField('customEnv', updated);
              }}
              style={compact
                ? { flex: 2, fontSize: 10 }
                : { flex: 2, background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 6px', borderRadius: 4, fontSize: 11, boxSizing: 'border-box' as const }}
            />
            <button
              type="button"
              style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: compact ? 11 : 12, padding: compact ? '0 3px' : '0 4px' }}
              onClick={() => setField('customEnv', draft.customEnv.filter((_, j) => j !== idx))}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: compact ? 4 : 6 }}>
        <div style={labelStyle}>
          {compact ? t('ccPreset.initMessageCompactLabel') : t('ccPreset.initMessageLabel')}
        </div>
        <textarea
          class={compact ? 'input' : undefined}
          value={draft.initMessage}
          rows={2}
          onInput={(e) => setField('initMessage', (e.target as HTMLTextAreaElement).value)}
          style={compact
            ? { width: '100%', fontSize: 10, resize: 'vertical' }
            : { width: '100%', background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', padding: '5px 8px', borderRadius: 4, fontSize: 11, resize: 'vertical', boxSizing: 'border-box' as const }}
        />
      </div>

      {!compact && displayError && (
        <div role="alert" style={{ color: '#ef4444', fontSize: 11, marginBottom: 6 }}>{displayError}</div>
      )}

      <div class="cc-preset-editor-actions">
        <button
          type="button"
          class={compact ? 'btn btn-primary' : undefined}
          disabled={saving || !draft.name.trim() || !draft.baseUrl.trim()}
          style={compact
            ? { fontSize: 11, padding: '3px 10px' }
            : {
                background: '#1d4ed8',
                border: 'none',
                color: '#fff',
                padding: '4px 12px',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
                opacity: saving || !draft.name.trim() || !draft.baseUrl.trim() ? 0.5 : 1,
              }}
          onClick={() => { void handleSave(); }}
        >
          {saving
            ? t('ccPreset.savingButton')
            : (compact ? t('ccPreset.saveButton') : t('ccPreset.savePresetButton'))}
        </button>
        <button
          type="button"
          class={compact ? 'btn btn-secondary' : undefined}
          style={compact
            ? { fontSize: 11, padding: '3px 10px', marginLeft: 8 }
            : {
                background: '#334155',
                border: 'none',
                color: '#fff',
                padding: '4px 12px',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
                marginLeft: 8,
              }}
          onClick={() => { void handleImport(); }}
        >
          {t('new_session.api_provider_import_json')}
        </button>
        <button
          type="button"
          class={compact ? 'btn btn-secondary' : undefined}
          disabled={saving || discovering || !draft.name.trim() || !draft.baseUrl.trim() || !draft.token.trim()}
          style={compact
            ? { fontSize: 11, padding: '3px 10px', marginLeft: 8 }
            : {
                background: '#0f766e',
                border: 'none',
                color: '#fff',
                padding: '4px 12px',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
                marginLeft: 8,
                opacity: saving || discovering || !draft.name.trim() || !draft.baseUrl.trim() || !draft.token.trim() ? 0.5 : 1,
              }}
          onClick={() => { void handleDiscover(); }}
        >
          {discovering ? t('ccPreset.discoveringModels') : t('ccPreset.discoverModels')}
        </button>
        {standalone && draft.name && (
          <button
            type="button"
            class="btn btn-secondary"
            style={{ fontSize: 12, padding: '4px 10px', marginLeft: 8 }}
            onClick={() => {
              updateDraft(createDefaultCcPresetDraft());
              onClearError();
            }}
          >
            {t('ccPreset.newPresetButton')}
          </button>
        )}
      </div>

      {presets.length > 0 ? (
        <div
          style={{
            marginTop: compact ? 8 : 10,
            borderTop: '1px solid #334155',
            paddingTop: compact ? 6 : 8,
          }}
        >
          {!compact && (
            <div style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>
              {t('ccPreset.savedListLabel')}
            </div>
          )}
          {presets.map((preset) => {
            const effectiveModel = getCcPresetEffectiveModel(preset);
            return (
              <div
                key={preset.name}
                data-cc-preset-row={preset.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: compact ? '2px 0' : '3px 0',
                  fontSize: compact ? 11 : 12,
                  gap: 8,
                }}
              >
                <span style={{ color: '#e2e8f0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {preset.name}{' '}
                  {effectiveModel && (
                    <span style={{ color: '#475569' }}>{effectiveModel}</span>
                  )}
                </span>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: compact ? 10 : 11 }}
                    onClick={() => {
                      updateDraft(createCcPresetDraftFromPreset(preset));
                      if (preset.modelDiscoveryError) {
                        onError(preset.modelDiscoveryError);
                      } else {
                        onClearError();
                      }
                    }}
                  >
                    {t('ccPreset.editButton')}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: compact ? 10 : 11 }}
                    onClick={() => { void handleDelete(preset.name); }}
                  >
                    {compact ? t('ccPreset.deleteCompactButton') : t('ccPreset.deleteButton')}
                  </button>
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: '#22c55e', cursor: 'pointer', fontSize: compact ? 10 : 11 }}
                    onClick={() => { void handleExport(preset); }}
                  >
                    {t('new_session.api_provider_export_json')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : standalone ? (
        <div
          data-testid="cc-preset-empty"
          style={{
            marginTop: 10,
            borderTop: '1px solid #334155',
            paddingTop: 8,
            color: '#64748b',
            fontSize: 12,
          }}
        >
          {t('ccPreset.emptyList')}
        </div>
      ) : null}
    </div>
  );
}

export interface CcPresetManagerDialogProps {
  ws: WsClient | null;
  onClose: () => void;
  onToast?: (message: string) => void;
}

export function CcPresetManagerDialog({
  ws,
  onClose,
  onToast,
}: CcPresetManagerDialogProps) {
  const { t } = useTranslation();
  const {
    presets,
    loaded,
    loading,
    refreshing,
    saving,
    discovering,
    error,
    setError,
    savePreset,
    deletePreset,
    discoverModels,
  } = useCcPresets(ws, { enabled: true });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      class="dialog-overlay"
      data-testid="cc-preset-manager-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        class="dialog cc-preset-manager-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('ccPreset.managerTitle')}
        style={{ width: 'min(520px, calc(100vw - 24px))', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="dialog-header">
          <span>{t('ccPreset.managerTitle')}</span>
          <button
            type="button"
            class="dialog-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>

        <div class="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
          <div style={{ fontSize: 12, color: '#94a3b8' }}>
            {t('ccPreset.managerSubtitle')}
          </div>
          <CcPresetEditorPanel
            ws={ws}
            presets={presets}
            loaded={loaded}
            loading={loading}
            refreshing={refreshing}
            saving={saving}
            discovering={discovering}
            error={error}
            onClearError={() => setError('')}
            onError={setError}
            onSavePreset={savePreset}
            onDeletePreset={deletePreset}
            onDiscoverModels={discoverModels}
            onToast={onToast}
            radioName="standalone-cc-preset-auth-type"
            standalone
          />
        </div>

        <div class="dialog-footer" style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 16px', borderTop: '1px solid #1e293b' }}>
          <button type="button" class="btn btn-secondary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
