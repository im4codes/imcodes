import { useState, useEffect, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  REMOTE_VOICE_MAX_NICKNAME_CHARS,
  type RemoteVoiceProviderInfo,
  type RemoteVoiceServerAsrServicePublic,
} from '@shared/remote-voice.js';
import {
  createServerAsrService,
  deleteServerAsrService,
  fetchServerAsrServices,
  updateServerAsrService,
} from '../api.js';
import {
  getRemoteVoiceState,
  refreshRemoteVoiceProviders,
  selectPrimaryRemoteVoiceProvider,
  subscribeRemoteVoiceState,
  toggleRemoteVoiceServerSharing,
  updateRemoteVoiceNickname,
  type RemoteVoiceClientState,
} from '../remote-voice-client.js';
import { isPcAppDesktop } from '../native-platform.js';
import { getLocalPcAppRemoteDeviceId } from '../remote-voice-provider.js';

const inlineLabelStyle = { fontSize: '13px', fontWeight: 600, color: '#e2e8f0' } as const;

interface AsrDraftState {
  mode: 'create' | 'edit';
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  clearApiKey: boolean;
  hasExistingApiKey: boolean;
  model: string;
  enabled: boolean;
}

function emptyCreateAsrDraft(): AsrDraftState {
  return {
    mode: 'create',
    name: '',
    baseUrl: '',
    apiKey: '',
    clearApiKey: false,
    hasExistingApiKey: false,
    model: 'whisper-1',
    enabled: true,
  };
}

export function formatSharedProviderHeadline(provider: RemoteVoiceProviderInfo): string {
  return provider.displayName;
}

export function SharedVoiceSection() {
  const { t } = useTranslation();
  const [remoteState, setRemoteState] = useState<RemoteVoiceClientState>(() => (
    typeof getRemoteVoiceState === 'function'
        ? getRemoteVoiceState()
      : {
          primaryDeviceId: null,
          canManageServerSharing: false,
          canShareOwnProviderToServer: false,
          providers: [],
          fetchedAt: 0,
          loading: false,
          fallbackNotice: null,
        }
  ));
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [asrServices, setAsrServices] = useState<RemoteVoiceServerAsrServicePublic[]>([]);
  const [asrEnvDefault, setAsrEnvDefault] = useState<RemoteVoiceServerAsrServicePublic | null>(null);
  const [asrEncryptionAvailable, setAsrEncryptionAvailable] = useState(true);
  const [asrLoading, setAsrLoading] = useState(false);
  const [asrDraft, setAsrDraft] = useState<AsrDraftState | null>(null);

  const loadAdminAsrServices = useCallback(async () => {
    if (!remoteState.canManageServerSharing || typeof fetchServerAsrServices !== 'function') {
      return;
    }
    setAsrLoading(true);
    try {
      const res = await fetchServerAsrServices();
      if (res && Array.isArray(res.services)) {
        setAsrServices(res.services);
        setAsrEnvDefault(res.envDefault ?? null);
        setAsrEncryptionAvailable(res.encryptionAvailable !== false);
      }
    } catch {
      // Non-fatal: admin list stays empty if request fails
    } finally {
      setAsrLoading(false);
    }
  }, [remoteState.canManageServerSharing]);

  useEffect(() => {
    if (typeof subscribeRemoteVoiceState !== 'function') return;
    const unsub = subscribeRemoteVoiceState(setRemoteState);
    if (typeof refreshRemoteVoiceProviders === 'function') {
      void refreshRemoteVoiceProviders();
    }
    return unsub;
  }, []);

  useEffect(() => {
    if (!remoteState.canManageServerSharing) {
      setAsrServices([]);
      setAsrEnvDefault(null);
      setAsrDraft(null);
      return;
    }
    void loadAdminAsrServices();
  }, [remoteState.canManageServerSharing, loadAdminAsrServices]);

  const localPcDeviceId = typeof getLocalPcAppRemoteDeviceId === 'function'
    ? getLocalPcAppRemoteDeviceId()
    : null;
  const canShowServerShareToggle = isPcAppDesktop() && remoteState.canShareOwnProviderToServer;
  const primaryId = remoteState.primaryDeviceId;
  const primaryOnline = primaryId
    ? remoteState.providers.find((p) => p.deviceId === primaryId && p.ready)
    : null;
  const primaryOffline = Boolean(
    primaryId
    && (!localPcDeviceId || primaryId !== localPcDeviceId)
    && !primaryOnline,
  );

  const handleSelectPrimary = async (nextId: string | null) => {
    setBusyKey(nextId ? `primary:${nextId}` : 'primary:local');
    setFeedback(null);
    try {
      await selectPrimaryRemoteVoiceProvider(nextId);
      setFeedback({ type: 'ok', text: t('settings.shared_voice_saved') });
    } catch {
      setFeedback({ type: 'err', text: t('settings.shared_voice_save_error') });
    } finally {
      setBusyKey(null);
    }
  };

  const handleSaveNickname = async (deviceId: string, nickname: string | null) => {
    setBusyKey(`nick:${deviceId}`);
    setFeedback(null);
    try {
      await updateRemoteVoiceNickname(deviceId, nickname);
      setEditingDeviceId(null);
      setNicknameDraft('');
      setFeedback({ type: 'ok', text: t('settings.shared_voice_saved') });
    } catch {
      setFeedback({ type: 'err', text: t('settings.shared_voice_save_error') });
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleServerSharing = async (provider: RemoteVoiceProviderInfo) => {
    setBusyKey(`share:${provider.deviceId}`);
    setFeedback(null);
    try {
      await toggleRemoteVoiceServerSharing(provider.deviceId, provider.shareScope !== 'server');
      setFeedback({ type: 'ok', text: t('settings.shared_voice_saved') });
    } catch {
      setFeedback({ type: 'err', text: t('settings.shared_voice_save_error') });
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div class="settings-card" data-testid="settings-shared-voice-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        <div>
          <h2 class="settings-card-heading" style={{ marginBottom: 4 }}>
            {t('settings.shared_voice_title')}
          </h2>
          <div style={{ color: '#94a3b8', fontSize: '12px', lineHeight: 1.45 }}>
            {t('settings.shared_voice_desc')}
          </div>
        </div>
        <button
          type="button"
          class="settings-btn-secondary"
          data-testid="settings-shared-voice-refresh"
          style={{ padding: '5px 10px', fontSize: '12px', flexShrink: 0 }}
          disabled={remoteState.loading}
          onClick={() => {
            setFeedback(null);
            if (typeof refreshRemoteVoiceProviders === 'function') {
              void refreshRemoteVoiceProviders();
            }
            if (remoteState.canManageServerSharing) {
              void loadAdminAsrServices();
            }
          }}
        >
          {t('settings.shared_voice_refresh')}
        </button>
      </div>

      {primaryOffline && (
        <div
          data-testid="settings-shared-voice-offline-banner"
          style={{
            marginBottom: 10,
            padding: '8px 10px',
            borderRadius: 8,
            background: 'rgba(245, 158, 11, 0.12)',
            border: '1px solid rgba(245, 158, 11, 0.28)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '12px', color: '#fcd34d' }}>
            {t('settings.shared_voice_primary_offline')}
          </span>
          <button
            type="button"
            class="settings-btn-secondary"
            data-testid="settings-shared-voice-reset-local"
            style={{ padding: '4px 10px', fontSize: '11px' }}
            disabled={busyKey !== null}
            onClick={() => void handleSelectPrimary(null)}
          >
            {t('settings.shared_voice_use_local')}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          data-testid="settings-shared-voice-local-row"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            padding: '10px 12px',
            borderRadius: 8,
            background: 'rgba(15, 23, 42, 0.45)',
            border: primaryId === null
              ? '1px solid rgba(56, 189, 248, 0.45)'
              : '1px solid rgba(148, 163, 184, 0.14)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={inlineLabelStyle}>{t('settings.shared_voice_local_default')}</div>
            <div style={{ fontSize: '12px', color: '#94a3b8' }}>
              {t('settings.shared_voice_local_desc')}
            </div>
          </div>
          <button
            type="button"
            data-testid="settings-shared-voice-select-local"
            class={primaryId === null ? 'settings-btn-primary' : 'settings-btn-secondary'}
            style={{ padding: '5px 12px', fontSize: '12px', flexShrink: 0 }}
            disabled={busyKey !== null || primaryId === null}
            onClick={() => void handleSelectPrimary(null)}
          >
            {primaryId === null
              ? t('settings.shared_voice_active')
              : t('settings.shared_voice_use_this')}
          </button>
        </div>

        {remoteState.providers.length === 0 ? (
          <div
            data-testid="settings-shared-voice-empty"
            style={{ fontSize: '12px', color: '#94a3b8', padding: '6px 2px' }}
          >
            {t('settings.shared_voice_empty')}
          </div>
        ) : (
          remoteState.providers.map((provider) => {
            const isPrimary = primaryId === provider.deviceId;
            const isThisPc = Boolean(localPcDeviceId && provider.deviceId === localPcDeviceId);
            const isEditing = editingDeviceId === provider.deviceId;
            const statusText = !provider.ready
              ? t('settings.shared_voice_status_not_ready')
              : provider.busy
                ? t('settings.shared_voice_status_busy')
                : t('settings.shared_voice_status_ready');
            const scopeLabel = provider.shareScope === 'server'
              ? t('settings.shared_voice_scope_server')
              : t('settings.shared_voice_scope_account');

            return (
              <div
                key={provider.deviceId}
                data-testid={`settings-shared-voice-provider-${provider.deviceId}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: 'rgba(15, 23, 42, 0.45)',
                  border: isPrimary
                    ? '1px solid rgba(56, 189, 248, 0.45)'
                    : '1px solid rgba(148, 163, 184, 0.14)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: '1 1 200px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span
                        style={{
                          ...inlineLabelStyle,
                          overflowWrap: 'anywhere',
                          wordBreak: 'break-word',
                        }}
                      >
                        {formatSharedProviderHeadline(provider)}
                      </span>
                      <span
                        data-testid={`settings-shared-voice-model-${provider.deviceId}`}
                        style={{
                          fontSize: '11px',
                          fontWeight: 600,
                          color: '#7dd3fc',
                          background: 'rgba(56, 189, 248, 0.14)',
                          borderRadius: 4,
                          padding: '1px 6px',
                        }}
                      >
                        {provider.modelLabel}
                      </span>
                      <span
                        data-testid={`settings-shared-voice-scope-${provider.deviceId}`}
                        style={{
                          fontSize: '11px',
                          color: '#cbd5e1',
                          background: 'rgba(148, 163, 184, 0.14)',
                          borderRadius: 4,
                          padding: '1px 6px',
                        }}
                      >
                        {scopeLabel}
                      </span>
                      {provider.isOwnDevice && provider.customNickname && provider.deviceName && provider.customNickname !== provider.deviceName && (
                        <span
                          data-testid={`settings-shared-voice-device-${provider.deviceId}`}
                          style={{
                            fontSize: '11px',
                            color: '#94a3b8',
                            overflowWrap: 'anywhere',
                            wordBreak: 'break-word',
                          }}
                        >
                          {provider.deviceName}
                        </span>
                      )}
                      {isThisPc && (
                        <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                          ({t('settings.shared_voice_this_device')})
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '11px', color: provider.ready ? '#86efac' : '#fbbf24', marginTop: 2 }}>
                      {statusText}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid={`settings-shared-voice-select-${provider.deviceId}`}
                    class={isPrimary ? 'settings-btn-primary' : 'settings-btn-secondary'}
                    style={{ padding: '5px 12px', fontSize: '12px', flexShrink: 0 }}
                    disabled={busyKey !== null || isPrimary || !provider.ready}
                    onClick={() => void handleSelectPrimary(provider.deviceId)}
                  >
                    {isPrimary
                      ? t('settings.shared_voice_active')
                      : t('settings.shared_voice_use_this')}
                  </button>
                </div>

                {provider.isOwnDevice && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid rgba(148, 163, 184, 0.1)', paddingTop: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      {!isEditing ? (
                        <>
                          <span style={{ fontSize: '12px', color: '#94a3b8' }}>
                            {t('settings.shared_voice_nickname_label')}:{' '}
                            <strong style={{ color: '#e2e8f0', fontWeight: 500 }}>
                              {provider.customNickname || t('settings.shared_voice_nickname_default')}
                            </strong>
                          </span>
                          <button
                            type="button"
                            class="settings-btn-secondary"
                            data-testid={`settings-shared-voice-edit-nick-${provider.deviceId}`}
                            style={{ padding: '3px 9px', fontSize: '11px' }}
                            disabled={busyKey !== null}
                            onClick={() => {
                              setEditingDeviceId(provider.deviceId);
                              setNicknameDraft(provider.customNickname ?? '');
                            }}
                          >
                            {t('settings.edit')}
                          </button>
                        </>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', flexWrap: 'wrap' }}>
                          <input
                            type="text"
                            class="settings-input"
                            data-testid={`settings-shared-voice-nick-input-${provider.deviceId}`}
                            maxLength={REMOTE_VOICE_MAX_NICKNAME_CHARS}
                            style={{ flex: '1 1 160px', padding: '5px 8px', fontSize: '12px' }}
                            value={nicknameDraft}
                            placeholder={t('settings.shared_voice_nickname_placeholder', { model: provider.modelLabel })}
                            onInput={(e) => setNicknameDraft((e.target as HTMLInputElement).value)}
                          />
                          <button
                            type="button"
                            class="settings-btn-primary"
                            data-testid={`settings-shared-voice-save-nick-${provider.deviceId}`}
                            style={{ padding: '4px 10px', fontSize: '11px' }}
                            disabled={busyKey !== null}
                            onClick={() => void handleSaveNickname(provider.deviceId, nicknameDraft.trim() || null)}
                          >
                            {t('common.save')}
                          </button>
                          {provider.customNickname && (
                            <button
                              type="button"
                              class="settings-btn-secondary"
                              data-testid={`settings-shared-voice-reset-nick-${provider.deviceId}`}
                              style={{ padding: '4px 10px', fontSize: '11px' }}
                              disabled={busyKey !== null}
                              onClick={() => void handleSaveNickname(provider.deviceId, null)}
                            >
                              {t('settings.shared_voice_nickname_reset')}
                            </button>
                          )}
                          <button
                            type="button"
                            class="settings-btn-secondary"
                            style={{ padding: '4px 10px', fontSize: '11px' }}
                            onClick={() => {
                              setEditingDeviceId(null);
                              setNicknameDraft('');
                            }}
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      )}
                    </div>

                    {canShowServerShareToggle && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                        <div>
                          <div style={{ fontSize: '12px', fontWeight: 500, color: '#e2e8f0' }}>
                            {t('settings.shared_voice_server_share_toggle')}
                          </div>
                          <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                            {t('settings.shared_voice_server_share_desc')}
                          </div>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={provider.shareScope === 'server'}
                          data-testid={`settings-shared-voice-server-toggle-${provider.deviceId}`}
                          class={provider.shareScope === 'server' ? 'settings-btn-primary' : 'settings-btn-secondary'}
                          style={{ minWidth: 56, padding: '4px 10px', fontSize: '11px', flexShrink: 0 }}
                          disabled={busyKey !== null}
                          onClick={() => void handleToggleServerSharing(provider)}
                        >
                          {provider.shareScope === 'server'
                            ? t('common.on', { defaultValue: 'On' })
                            : t('common.off', { defaultValue: 'Off' })}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {remoteState.canManageServerSharing && (
        <div
          data-testid="settings-shared-voice-asr-section"
          style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: '1px solid rgba(148, 163, 184, 0.16)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                {t('settings.shared_voice_asr_title')}
              </div>
              <div style={{ fontSize: '11px', color: '#94a3b8', lineHeight: 1.45 }}>
                {t('settings.shared_voice_asr_desc')}
              </div>
            </div>
            <button
              type="button"
              class="settings-btn-secondary"
              data-testid="settings-shared-voice-asr-add-btn"
              style={{ padding: '4px 10px', fontSize: '11px', flexShrink: 0 }}
              disabled={busyKey !== null || asrLoading}
              onClick={() => {
                setFeedback(null);
                setAsrDraft(emptyCreateAsrDraft());
              }}
            >
              {t('settings.shared_voice_asr_add')}
            </button>
          </div>

          {!asrEncryptionAvailable && (
            <div
              data-testid="settings-shared-voice-asr-encryption-warn"
              style={{
                marginBottom: 8,
                padding: '6px 10px',
                borderRadius: 6,
                background: 'rgba(245, 158, 11, 0.12)',
                border: '1px solid rgba(245, 158, 11, 0.28)',
                fontSize: '11px',
                color: '#fcd34d',
              }}
            >
              {t('settings.shared_voice_asr_encryption_warn')}
            </div>
          )}

          {asrDraft && (
            <div
              data-testid="settings-shared-voice-asr-form"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: '10px 12px',
                marginBottom: 10,
                borderRadius: 8,
                background: 'rgba(15, 23, 42, 0.55)',
                border: '1px solid rgba(56, 189, 248, 0.28)',
              }}
            >
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: '11px', color: '#cbd5e1' }}>{t('settings.shared_voice_asr_name_label')}</span>
                <input
                  type="text"
                  class="settings-input"
                  data-testid="settings-shared-voice-asr-input-name"
                  maxLength={64}
                  value={asrDraft.name}
                  placeholder={t('settings.shared_voice_asr_name_placeholder')}
                  onInput={(e) => setAsrDraft((prev) => (prev ? { ...prev, name: (e.target as HTMLInputElement).value } : prev))}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: '11px', color: '#cbd5e1' }}>{t('settings.shared_voice_asr_base_url_label')}</span>
                <input
                  type="text"
                  class="settings-input"
                  data-testid="settings-shared-voice-asr-input-base-url"
                  maxLength={2048}
                  value={asrDraft.baseUrl}
                  placeholder={t('settings.shared_voice_asr_base_url_placeholder')}
                  onInput={(e) => setAsrDraft((prev) => (prev ? { ...prev, baseUrl: (e.target as HTMLInputElement).value } : prev))}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: '11px', color: '#cbd5e1' }}>{t('settings.shared_voice_asr_model_label')}</span>
                <input
                  type="text"
                  class="settings-input"
                  data-testid="settings-shared-voice-asr-input-model"
                  maxLength={128}
                  value={asrDraft.model}
                  placeholder={t('settings.shared_voice_asr_model_placeholder')}
                  onInput={(e) => setAsrDraft((prev) => (prev ? { ...prev, model: (e.target as HTMLInputElement).value } : prev))}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: '11px', color: '#cbd5e1' }}>{t('settings.shared_voice_asr_api_key_label')}</span>
                <input
                  type="password"
                  class="settings-input"
                  data-testid="settings-shared-voice-asr-input-api-key"
                  maxLength={4096}
                  value={asrDraft.apiKey}
                  disabled={asrDraft.clearApiKey}
                  placeholder={
                    asrDraft.mode === 'edit' && asrDraft.hasExistingApiKey
                      ? t('settings.shared_voice_asr_api_key_keep')
                      : t('settings.shared_voice_asr_api_key_placeholder')
                  }
                  onInput={(e) => setAsrDraft((prev) => (prev ? { ...prev, apiKey: (e.target as HTMLInputElement).value } : prev))}
                />
              </label>

              {asrDraft.mode === 'edit' && asrDraft.hasExistingApiKey && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '11px', color: '#cbd5e1' }}>
                  <input
                    type="checkbox"
                    data-testid="settings-shared-voice-asr-clear-key"
                    checked={asrDraft.clearApiKey}
                    onChange={(e) => {
                      const checked = (e.target as HTMLInputElement).checked;
                      setAsrDraft((prev) => (prev ? { ...prev, clearApiKey: checked, ...(checked ? { apiKey: '' } : {}) } : prev));
                    }}
                  />
                  <span>{t('settings.shared_voice_asr_api_key_clear')}</span>
                </label>
              )}

              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '11px', color: '#cbd5e1' }}>
                <input
                  type="checkbox"
                  data-testid="settings-shared-voice-asr-input-enabled"
                  checked={asrDraft.enabled}
                  onChange={(e) => {
                    const checked = (e.target as HTMLInputElement).checked;
                    setAsrDraft((prev) => (prev ? { ...prev, enabled: checked } : prev));
                  }}
                />
                <span>{t('settings.shared_voice_asr_enabled_label')}</span>
              </label>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  class="settings-btn-secondary"
                  data-testid="settings-shared-voice-asr-cancel"
                  style={{ padding: '4px 10px', fontSize: '11px' }}
                  onClick={() => setAsrDraft(null)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  class="settings-btn-primary"
                  data-testid="settings-shared-voice-asr-save"
                  style={{ padding: '4px 10px', fontSize: '11px' }}
                  disabled={busyKey !== null}
                  onClick={async () => {
                    if (!asrDraft) return;
                    setBusyKey('asr:save');
                    setFeedback(null);
                    try {
                      const trimmedKey = asrDraft.apiKey.trim();
                      if (asrDraft.mode === 'create') {
                        const res = await createServerAsrService({
                          name: asrDraft.name.trim(),
                          baseUrl: asrDraft.baseUrl.trim(),
                          model: asrDraft.model.trim(),
                          enabled: asrDraft.enabled,
                          ...(trimmedKey ? { apiKey: trimmedKey } : {}),
                        });
                        if (Array.isArray(res.services)) setAsrServices(res.services);
                        setAsrEnvDefault(res.envDefault ?? null);
                        setAsrEncryptionAvailable(res.encryptionAvailable !== false);
                      } else if (asrDraft.id) {
                        const payload = {
                          name: asrDraft.name.trim(),
                          baseUrl: asrDraft.baseUrl.trim(),
                          model: asrDraft.model.trim(),
                          enabled: asrDraft.enabled,
                          ...(asrDraft.clearApiKey
                            ? { apiKey: '' }
                            : trimmedKey
                              ? { apiKey: trimmedKey }
                              : {}),
                        };
                        const res = await updateServerAsrService(asrDraft.id, payload);
                        if (Array.isArray(res.services)) setAsrServices(res.services);
                        setAsrEnvDefault(res.envDefault ?? null);
                        setAsrEncryptionAvailable(res.encryptionAvailable !== false);
                      }
                      setAsrDraft(null);
                      setFeedback({ type: 'ok', text: t('settings.shared_voice_asr_saved') });
                      if (typeof refreshRemoteVoiceProviders === 'function') {
                        await refreshRemoteVoiceProviders();
                      }
                    } catch {
                      setFeedback({ type: 'err', text: t('settings.shared_voice_asr_error') });
                    } finally {
                      setBusyKey(null);
                    }
                  }}
                >
                  {t('common.save')}
                </button>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {asrEnvDefault && (
              <div
                data-testid={`settings-shared-voice-asr-item-${asrEnvDefault.id}`}
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: 'rgba(15, 23, 42, 0.35)',
                  border: '1px solid rgba(148, 163, 184, 0.14)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: '#e2e8f0' }}>{asrEnvDefault.name}</span>
                  <span style={{ fontSize: '11px', color: '#7dd3fc', background: 'rgba(56, 189, 248, 0.14)', borderRadius: 4, padding: '1px 6px' }}>
                    {asrEnvDefault.model}
                  </span>
                  <span style={{ fontSize: '11px', color: '#cbd5e1', background: 'rgba(148, 163, 184, 0.14)', borderRadius: 4, padding: '1px 6px' }}>
                    {t('settings.shared_voice_asr_env_badge')}
                  </span>
                </div>
                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: 3 }}>
                  {asrEnvDefault.baseUrl}{asrEnvDefault.apiKeyMasked ? ` · ${asrEnvDefault.apiKeyMasked}` : ''}
                </div>
                <div style={{ fontSize: '11px', color: '#64748b', marginTop: 2 }}>
                  {t('settings.shared_voice_asr_env_readonly')}
                </div>
              </div>
            )}

            {!asrEnvDefault && asrServices.length === 0 ? (
              <div
                data-testid="settings-shared-voice-asr-empty"
                style={{ fontSize: '12px', color: '#94a3b8', padding: '4px 2px' }}
              >
                {t('settings.shared_voice_asr_empty')}
              </div>
            ) : (
              asrServices.map((svc) => (
                <div
                  key={svc.id}
                  data-testid={`settings-shared-voice-asr-item-${svc.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: 'rgba(15, 23, 42, 0.4)',
                    border: '1px solid rgba(148, 163, 184, 0.14)',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ minWidth: 0, flex: '1 1 200px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: '#e2e8f0' }}>{svc.name}</span>
                      <span style={{ fontSize: '11px', color: '#7dd3fc', background: 'rgba(56, 189, 248, 0.14)', borderRadius: 4, padding: '1px 6px' }}>
                        {svc.model}
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: 3, wordBreak: 'break-all' }}>
                      {svc.baseUrl}{svc.apiKeyMasked ? ` · ${svc.apiKeyMasked}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={svc.enabled}
                      data-testid={`settings-shared-voice-asr-toggle-${svc.id}`}
                      class={svc.enabled ? 'settings-btn-primary' : 'settings-btn-secondary'}
                      style={{ minWidth: 48, padding: '4px 8px', fontSize: '11px' }}
                      disabled={busyKey !== null}
                      onClick={async () => {
                        setBusyKey(`asr:toggle:${svc.id}`);
                        setFeedback(null);
                        try {
                          const res = await updateServerAsrService(svc.id, { enabled: !svc.enabled });
                          if (Array.isArray(res.services)) setAsrServices(res.services);
                          setAsrEnvDefault(res.envDefault ?? null);
                          setAsrEncryptionAvailable(res.encryptionAvailable !== false);
                          setFeedback({ type: 'ok', text: t('settings.shared_voice_asr_saved') });
                          if (typeof refreshRemoteVoiceProviders === 'function') {
                            await refreshRemoteVoiceProviders();
                          }
                        } catch {
                          setFeedback({ type: 'err', text: t('settings.shared_voice_asr_error') });
                        } finally {
                          setBusyKey(null);
                        }
                      }}
                    >
                      {svc.enabled
                        ? t('common.on', { defaultValue: 'On' })
                        : t('common.off', { defaultValue: 'Off' })}
                    </button>
                    <button
                      type="button"
                      class="settings-btn-secondary"
                      data-testid={`settings-shared-voice-asr-edit-${svc.id}`}
                      style={{ padding: '4px 8px', fontSize: '11px' }}
                      disabled={busyKey !== null}
                      onClick={() => {
                        setFeedback(null);
                        setAsrDraft({
                          mode: 'edit',
                          id: svc.id,
                          name: svc.name,
                          baseUrl: svc.baseUrl,
                          apiKey: '',
                          clearApiKey: false,
                          hasExistingApiKey: svc.hasApiKey,
                          model: svc.model,
                          enabled: svc.enabled,
                        });
                      }}
                    >
                      {t('settings.shared_voice_asr_edit')}
                    </button>
                    <button
                      type="button"
                      class="settings-btn-secondary"
                      data-testid={`settings-shared-voice-asr-delete-${svc.id}`}
                      style={{ padding: '4px 8px', fontSize: '11px', color: '#f87171' }}
                      disabled={busyKey !== null}
                      onClick={async () => {
                        setBusyKey(`asr:delete:${svc.id}`);
                        setFeedback(null);
                        try {
                          const res = await deleteServerAsrService(svc.id);
                          if (Array.isArray(res.services)) setAsrServices(res.services);
                          setAsrEnvDefault(res.envDefault ?? null);
                          setAsrEncryptionAvailable(res.encryptionAvailable !== false);
                          if (asrDraft?.id === svc.id) setAsrDraft(null);
                          setFeedback({ type: 'ok', text: t('settings.shared_voice_asr_deleted') });
                          if (typeof refreshRemoteVoiceProviders === 'function') {
                            await refreshRemoteVoiceProviders();
                          }
                        } catch {
                          setFeedback({ type: 'err', text: t('settings.shared_voice_asr_error') });
                        } finally {
                          setBusyKey(null);
                        }
                      }}
                    >
                      {t('settings.shared_voice_asr_delete')}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {feedback && (
        <div
          data-testid="settings-shared-voice-feedback"
          style={{
            marginTop: 8,
            fontSize: '12px',
            color: feedback.type === 'ok' ? '#86efac' : '#f87171',
          }}
        >
          {feedback.text}
        </div>
      )}
    </div>
  );
}
