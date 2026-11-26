import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  STREAMING_SPEECH_OFFLINE_MODEL_EVENT,
  type OfflineSpeechModelStatus,
} from '@shared/voice-recognition.js';
import {
  getNativeOfflineSpeechModelManager,
  isCapacitorUnimplementedError,
  isNativeOfflineModelShellOutdated,
} from '../voice-recognition-backend.js';

const DEFAULT_MODEL_SIZE_MB = 712;

export function formatOfflineModelSizeMb(totalBytes?: number | null): number {
  if (typeof totalBytes === 'number' && Number.isFinite(totalBytes) && totalBytes > 0) {
    return Math.max(1, Math.floor(totalBytes / 1_000_000));
  }
  return DEFAULT_MODEL_SIZE_MB;
}

export function OfflineVoiceModelSection() {
  const { t } = useTranslation();
  const manager = getNativeOfflineSpeechModelManager();
  const shellOutdated = isNativeOfflineModelShellOutdated();
  const [status, setStatus] = useState<OfflineSpeechModelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [cellularConfirmOpen, setCellularConfirmOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [appUpdateRequired, setAppUpdateRequired] = useState(false);
  const mountedRef = useRef(true);

  const showAppUpdateRequired = shellOutdated || appUpdateRequired;

  const handleActionError = useCallback((err: unknown, fallbackMessage: string) => {
    if (isCapacitorUnimplementedError(err)) {
      setAppUpdateRequired(true);
      setActionError(null);
      setCellularConfirmOpen(false);
      return;
    }
    setActionError(err instanceof Error ? err.message : fallbackMessage);
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!manager) return;
    try {
      const next = await manager.getOfflineModelStatus();
      if (!mountedRef.current) return;
      setStatus(next);
    } catch (err) {
      if (!mountedRef.current) return;
      if (isCapacitorUnimplementedError(err)) {
        setAppUpdateRequired(true);
        setActionError(null);
        setCellularConfirmOpen(false);
      }
    }
  }, [manager]);

  useEffect(() => {
    mountedRef.current = true;
    if (!manager || shellOutdated) return undefined;
    void refreshStatus();
    let removeListener: (() => Promise<void>) | undefined;
    let disposed = false;
    void manager.addListener?.(STREAMING_SPEECH_OFFLINE_MODEL_EVENT, (next) => {
      if (!mountedRef.current) return;
      setStatus(next);
      if (next.status === 'downloading' || next.status === 'ready') {
        setCellularConfirmOpen(false);
      }
      if (next.error) {
        setActionError(next.error);
      } else if (next.status !== 'failed') {
        setActionError(null);
      }
    }).then((handle) => {
      if (disposed) {
        void handle.remove();
      } else {
        removeListener = handle.remove;
      }
    }).catch(() => {});

    return () => {
      disposed = true;
      mountedRef.current = false;
      if (removeListener) {
        void removeListener();
      }
    };
  }, [manager, refreshStatus, shellOutdated]);

  if (!manager && !showAppUpdateRequired) return null;

  const sizeMb = formatOfflineModelSizeMb(status?.totalBytes);
  const downloadedMb = status && status.downloadedBytes > 0
    ? Math.floor(status.downloadedBytes / 1_000_000)
    : 0;
  const pct = status ? Math.min(100, Math.max(0, Math.round(status.progress * 100))) : 0;
  const lifecycle = status?.status ?? 'idle';
  const supported = status?.supported !== false;
  const displayError = actionError ?? (lifecycle === 'failed' ? (status?.error ?? null) : null);

  const handleDownload = async (allowCellular: boolean) => {
    if (!manager || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await manager.downloadOfflineModel({ allowCellular });
      if (!mountedRef.current) return;
      if (res?.status) setStatus(res.status);
      if (!allowCellular && res?.requiresCellularConfirmation) {
        setCellularConfirmOpen(true);
      } else {
        setCellularConfirmOpen(false);
        if (res?.status?.error) setActionError(res.status.error);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      handleActionError(err, t('settings.offline_voice_model_download_error'));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!manager || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await manager.cancelOfflineModelDownload();
      if (!mountedRef.current) return;
      setCellularConfirmOpen(false);
      if (res?.status) setStatus(res.status);
    } catch (err) {
      if (!mountedRef.current) return;
      handleActionError(err, t('settings.offline_voice_model_download_error'));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!manager || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await manager.deleteOfflineModel();
      if (!mountedRef.current) return;
      setCellularConfirmOpen(false);
      if (res?.status) setStatus(res.status);
    } catch (err) {
      if (!mountedRef.current) return;
      handleActionError(err, t('settings.offline_voice_model_delete_error'));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <div class="settings-card" data-testid="settings-offline-voice-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h2 class="settings-card-heading" style={{ marginBottom: 0 }}>
            {t('settings.offline_voice_model_title')}
          </h2>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 600,
              color: '#7dd3fc',
              background: 'rgba(56, 189, 248, 0.14)',
              borderRadius: 4,
              padding: '1px 6px',
            }}
          >
            Qwen3-ASR 0.6B INT4 · ~{sizeMb} MB
          </span>
        </div>
        {!showAppUpdateRequired && lifecycle === 'ready' && (
          <span
            data-testid="settings-offline-voice-ready-badge"
            style={{
              fontSize: '11px',
              fontWeight: 600,
              color: '#86efac',
              background: 'rgba(34, 197, 94, 0.14)',
              border: '1px solid rgba(34, 197, 94, 0.32)',
              borderRadius: 999,
              padding: '2px 8px',
            }}
          >
            {t('settings.offline_voice_model_ready')}
          </span>
        )}
      </div>

      <div style={{ color: '#94a3b8', fontSize: '12px', lineHeight: 1.5, marginBottom: 12 }}>
        {t('settings.offline_voice_model_desc', { sizeMb })}
      </div>

      {showAppUpdateRequired ? (
        <div
          data-testid="settings-offline-voice-update-required"
          style={{ fontSize: '12px', color: '#94a3b8' }}
        >
          {t('settings.offline_voice_model_app_update_required')}
        </div>
      ) : !supported ? (
        <div
          data-testid="settings-offline-voice-unsupported"
          style={{ fontSize: '12px', color: '#94a3b8' }}
        >
          {t('settings.offline_voice_model_unsupported')}
        </div>
      ) : lifecycle === 'downloading' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', color: '#cbd5e1', gap: 8 }}>
            <span data-testid="settings-offline-voice-progress-text">
              {t('settings.offline_voice_model_downloading', {
                percent: pct,
                downloadedMb,
                totalMb: sizeMb,
              })}
            </span>
            <span style={{ fontSize: '11px', color: '#94a3b8' }}>
              {status?.allowCellular
                ? t('settings.offline_voice_model_via_cellular')
                : t('settings.offline_voice_model_via_wifi')}
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{
              width: '100%',
              height: 6,
              borderRadius: 999,
              background: 'rgba(148, 163, 184, 0.2)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: '100%',
                background: '#38bdf8',
                transition: 'width 150ms ease',
              }}
            />
          </div>
          <div>
            <button
              type="button"
              class="settings-btn-secondary"
              data-testid="settings-offline-voice-cancel"
              style={{ padding: '6px 12px', fontSize: '12px' }}
              disabled={busy}
              onClick={() => void handleCancel()}
            >
              {t('settings.offline_voice_model_cancel')}
            </button>
          </div>
        </div>
      ) : lifecycle === 'ready' ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: '12px', color: '#cbd5e1' }}>
            {t('settings.offline_voice_model_installed_note', { sizeMb })}
          </div>
          {!status?.bundled && (
            <button
              type="button"
              class="settings-btn-secondary"
              data-testid="settings-offline-voice-delete"
              style={{ padding: '6px 12px', fontSize: '12px', color: '#fca5a5', borderColor: 'rgba(248, 113, 113, 0.35)' }}
              disabled={busy}
              onClick={() => void handleDelete()}
            >
              {t('settings.offline_voice_model_delete', { sizeMb })}
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {displayError && (
            <div
              data-testid="settings-offline-voice-error"
              style={{
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.32)',
                color: '#fca5a5',
                fontSize: '12px',
              }}
            >
              {displayError}
            </div>
          )}

          {cellularConfirmOpen ? (
            <div
              data-testid="settings-offline-voice-cellular-confirm"
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                background: 'rgba(245, 158, 11, 0.12)',
                border: '1px solid rgba(245, 158, 11, 0.35)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ fontSize: '12px', color: '#fde68a', lineHeight: 1.5 }}>
                {t('settings.offline_voice_model_cellular_prompt', { sizeMb })}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  class="settings-btn-secondary"
                  data-testid="settings-offline-voice-cellular-cancel"
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                  disabled={busy}
                  onClick={() => setCellularConfirmOpen(false)}
                >
                  {t('common.cancel', { defaultValue: 'Cancel' })}
                </button>
                <button
                  type="button"
                  class="settings-btn-primary"
                  data-testid="settings-offline-voice-cellular-proceed"
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                  disabled={busy}
                  onClick={() => void handleDownload(true)}
                >
                  {t('settings.offline_voice_model_cellular_confirm', { sizeMb })}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '12px', color: '#94a3b8' }}>
                {t('settings.offline_voice_model_wifi_only_note')}
              </span>
              <button
                type="button"
                class="settings-btn-primary"
                data-testid="settings-offline-voice-download"
                style={{ padding: '6px 14px', fontSize: '12px', flexShrink: 0 }}
                disabled={busy}
                onClick={() => void handleDownload(false)}
              >
                {t('settings.offline_voice_model_download', { sizeMb })}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
