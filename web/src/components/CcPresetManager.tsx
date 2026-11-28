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
  const normalizedDraftName = draft.name.trim() ? normalizeCcPresetName(draft.name) : '';

  const textFields = [
    {
      key: 'name' as const,
      label: t('ccPreset.nameLabel'),
      envKey: '',
      ph: t('ccPreset.namePlaceholder'),
      val: draft.name,
      type: 'text' as const,
    },
    {
      key: 'baseUrl' as const,
      label: t('ccPreset.baseUrlLabel'),
      envKey: isOpenAi ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL',
      ph: isOpenAi ? DEFAULT_OPENAI_PRESET_BASE_URL : DEFAULT_CC_PRESET_BASE_URL,
      val: draft.baseUrl,
      type: 'text' as const,
    },
    {
      key: 'token' as const,
      label: t('ccPreset.apiKeyLabel'),
      envKey: isOpenAi ? 'OPENAI_API_KEY' : (compact ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'),
      ph: t('ccPreset.apiKeyPlaceholder'),
      val: draft.token,
      type: 'password' as const,
    },
  ];

  const editorClasses = [
    'cc-preset-editor',
    standalone ? 'cc-preset-editor-standalone' : '',
    compact ? 'is-compact' : '',
  ].filter(Boolean).join(' ');

  return (
    <div class={editorClasses}>
      {!compact && !standalone && (
        <div class="cc-preset-editor-title">
          {t('ccPreset.editorTitle')}
        </div>
      )}
      <div class="cc-preset-storage-hint">
        {t('ccPreset.storageHint')}
      </div>
      {(!loaded || refreshing) && (
        <div data-testid="cc-preset-loading" class="cc-preset-status-banner">
          {loading || refreshing ? t('ccPreset.loadingList') : t('ccPreset.notLoadedError')}
        </div>
      )}
      {compact && displayError && (
        <div role="alert" class="cc-preset-alert">{displayError}</div>
      )}

      <div class="cc-preset-field">
        <div class="cc-preset-field-label">
          {t('ccPreset.protocolLabel')}
        </div>
        <div class="cc-preset-protocol-group">
          <label class={`cc-preset-protocol-pill${draft.authType === 'anthropic' ? ' is-active' : ''}`}>
            <input
              type="radio"
              name={radioName}
              value="anthropic"
              checked={draft.authType === 'anthropic'}
              onChange={() => handleProtocolChange('anthropic')}
            />
            {t('ccPreset.protocolAnthropic')}
          </label>
          <label class={`cc-preset-protocol-pill${draft.authType === 'openai' ? ' is-active' : ''}`}>
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

      {textFields.map(({ key, label, envKey, ph, val, type }) => (
        <div key={key} class="cc-preset-field">
          <div class="cc-preset-field-label">
            <span>{label}</span>
            {envKey && <span class="cc-preset-env-key">{envKey}</span>}
          </div>
          <input
            class="cc-preset-input"
            type={type}
            placeholder={ph}
            value={val}
            onInput={(e) => setField(key, (e.target as HTMLInputElement).value)}
          />
        </div>
      ))}

      {draft.availableModels.length > 0 && (
        <div class="cc-preset-field">
          <div class="cc-preset-field-label">{t('ccPreset.discoveredModelsLabel')}</div>
          <select
            class="cc-preset-select"
            value={draft.model}
            onInput={(e) => setField('model', (e.target as HTMLSelectElement).value)}
          >
            {draft.availableModels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name ? `${item.name} (${item.id})` : item.id}
              </option>
            ))}
          </select>
        </div>
      )}

      <div class="cc-preset-field-row-2col">
        <div class="cc-preset-field">
          <div class="cc-preset-field-label">
            <span>{t('ccPreset.modelLabel')}</span>
            <span class="cc-preset-env-key">{isOpenAi ? 'OPENAI_MODEL' : 'ANTHROPIC_MODEL'}</span>
          </div>
          <input
            class="cc-preset-input"
            type="text"
            placeholder={isOpenAi ? DEFAULT_OPENAI_PRESET_MODEL : DEFAULT_CC_PRESET_MODEL}
            value={draft.model}
            onInput={(e) => setField('model', (e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="cc-preset-field">
          <div class="cc-preset-field-label">
            <span>{t('ccPreset.contextWindowLabel')}</span>
            {draft.contextWindow && (
              <span class="cc-preset-context-badge">
                {formatContextWindowBadge(draft.contextWindow)}
              </span>
            )}
          </div>
          <input
            class="cc-preset-input"
            type="text"
            placeholder="1000000"
            value={draft.contextWindow}
            onInput={(e) => setField('contextWindow', (e.target as HTMLInputElement).value)}
          />
        </div>
      </div>

      <div class="cc-preset-env-section">
        <div class="cc-preset-env-header">
          <span class="cc-preset-field-label">
            {t('ccPreset.customEnvLabel')}
          </span>
          <button
            type="button"
            class="cc-preset-add-env-btn"
            onClick={() => setField('customEnv', [...draft.customEnv, { key: '', value: '' }])}
          >
            {t('ccPreset.addEnvVar')}
          </button>
        </div>
        {draft.customEnv.length > 0 && (
          <div class="cc-preset-env-list">
            {draft.customEnv.map((item, idx) => (
              <div key={idx} class="cc-preset-env-row">
                <input
                  class="cc-preset-input cc-preset-env-key-input"
                  type="text"
                  placeholder="ENV_KEY"
                  value={item.key}
                  onInput={(e) => {
                    const updated = [...draft.customEnv];
                    updated[idx] = { ...updated[idx], key: (e.target as HTMLInputElement).value };
                    setField('customEnv', updated);
                  }}
                />
                <input
                  class="cc-preset-input cc-preset-env-val-input"
                  type="text"
                  placeholder={t('ccPreset.envValuePlaceholder')}
                  value={item.value}
                  onInput={(e) => {
                    const updated = [...draft.customEnv];
                    updated[idx] = { ...updated[idx], value: (e.target as HTMLInputElement).value };
                    setField('customEnv', updated);
                  }}
                />
                <button
                  type="button"
                  class="cc-preset-env-remove-btn"
                  aria-label="Remove env var"
                  onClick={() => setField('customEnv', draft.customEnv.filter((_, j) => j !== idx))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div class="cc-preset-field">
        <div class="cc-preset-field-label">
          {compact ? t('ccPreset.initMessageCompactLabel') : t('ccPreset.initMessageLabel')}
        </div>
        <textarea
          class="cc-preset-textarea"
          value={draft.initMessage}
          rows={2}
          onInput={(e) => setField('initMessage', (e.target as HTMLTextAreaElement).value)}
        />
      </div>

      {!compact && displayError && (
        <div role="alert" class="cc-preset-alert">{displayError}</div>
      )}

      <div class="cc-preset-editor-actions">
        <button
          type="button"
          class="cc-preset-btn cc-preset-btn-primary"
          disabled={saving || !draft.name.trim() || !draft.baseUrl.trim()}
          onClick={() => { void handleSave(); }}
        >
          {saving
            ? t('ccPreset.savingButton')
            : (compact ? t('ccPreset.saveButton') : t('ccPreset.savePresetButton'))}
        </button>
        <button
          type="button"
          class="cc-preset-btn cc-preset-btn-secondary"
          onClick={() => { void handleImport(); }}
        >
          {t('new_session.api_provider_import_json')}
        </button>
        <button
          type="button"
          class="cc-preset-btn cc-preset-btn-discover"
          disabled={saving || discovering || !draft.name.trim() || !draft.baseUrl.trim() || !draft.token.trim()}
          onClick={() => { void handleDiscover(); }}
        >
          {discovering ? t('ccPreset.discoveringModels') : t('ccPreset.discoverModels')}
        </button>
        {standalone && draft.name && (
          <button
            type="button"
            class="cc-preset-btn cc-preset-btn-ghost"
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
        <div class="cc-preset-saved-section">
          {!compact && (
            <div class="cc-preset-saved-header">
              <span>{t('ccPreset.savedListLabel')}</span>
              <span class="cc-preset-saved-count">{presets.length}</span>
            </div>
          )}
          <div class="cc-preset-saved-list">
            {presets.map((preset) => {
              const effectiveModel = getCcPresetEffectiveModel(preset);
              const isEditingRow = normalizedDraftName !== '' && normalizedDraftName === normalizeCcPresetName(preset.name);
              return (
                <div
                  key={preset.name}
                  data-cc-preset-row={preset.name}
                  class={`cc-preset-row${isEditingRow ? ' is-editing' : ''}`}
                >
                  <div class="cc-preset-row-main">
                    <span class="cc-preset-row-name">{preset.name}</span>
                    <span class="cc-preset-row-proto">
                      {preset.authType === 'openai' ? 'OpenAI' : 'Anthropic'}
                    </span>
                    {effectiveModel && (
                      <span class="cc-preset-row-model">{effectiveModel}</span>
                    )}
                  </div>
                  <div class="cc-preset-row-actions">
                    <button
                      type="button"
                      class="cc-preset-row-btn cc-preset-row-btn-edit"
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
                      class="cc-preset-row-btn cc-preset-row-btn-delete"
                      onClick={() => { void handleDelete(preset.name); }}
                    >
                      {compact ? t('ccPreset.deleteCompactButton') : t('ccPreset.deleteButton')}
                    </button>
                    <button
                      type="button"
                      class="cc-preset-row-btn cc-preset-row-btn-export"
                      onClick={() => { void handleExport(preset); }}
                    >
                      {t('new_session.api_provider_export_json')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : standalone ? (
        <div data-testid="cc-preset-empty" class="cc-preset-empty">
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
      class="dialog-overlay cc-preset-manager-overlay"
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
        onClick={(e) => e.stopPropagation()}
      >
        <div class="dialog-header cc-preset-manager-header">
          <span class="cc-preset-manager-title">{t('ccPreset.managerTitle')}</span>
          <button
            type="button"
            class="dialog-close cc-preset-manager-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>

        <div class="dialog-body cc-preset-manager-body">
          <div class="cc-preset-manager-subtitle">
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

        <div class="dialog-footer cc-preset-manager-footer">
          <button type="button" class="btn cc-preset-btn cc-preset-btn-ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
