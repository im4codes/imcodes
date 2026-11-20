import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { useTranslation } from 'react-i18next';
import {
  canOpenNativeTtsSettings,
  getCachedServerTtsConfig,
  getNativeTtsVoiceQuality,
  getTtsAutoReadEnabled,
  getTtsMode,
  getTtsSpeechRate,
  isServerTtsConfigured,
  openNativeTtsSettings,
  saveServerTtsConfig,
  setTtsAutoReadEnabled,
  setTtsMode,
  setTtsSpeechRate,
  stopSpeaking,
  subscribeTtsPreferences,
  TTS_RATE_OPTIONS,
  type TtsEngineMode,
} from '../tts.js';
import {
  getNativeTtsVoiceQualityLabelKey,
  isHighQualityNativeTtsVoice,
  isIosNativePlatform,
  type NativeTtsVoiceQualityInfo,
} from '../voice-recognition-backend.js';

interface Props {
  anchorRef: RefObject<HTMLDivElement>;
  locale?: string;
  onClose: () => void;
}

export function TtsQuickSettingsPopover({ anchorRef, locale, onClose }: Props) {
  const { t } = useTranslation();
  const [ttsAutoRead, setTtsAutoRead] = useState<boolean>(() => getTtsAutoReadEnabled());
  const [ttsRate, setTtsRate] = useState<number>(() => getTtsSpeechRate());
  const [ttsMode, setLocalTtsMode] = useState<TtsEngineMode>(() => getTtsMode());
  const [serverConfigured, setServerConfigured] = useState<boolean>(() => isServerTtsConfigured(getCachedServerTtsConfig()));
  const [nativeVoiceQuality, setNativeVoiceQuality] = useState<NativeTtsVoiceQualityInfo | null>(null);
  const [alignLeft, setAlignLeft] = useState(false);

  const isIosNative = isIosNativePlatform();
  const canOpenSettings = canOpenNativeTtsSettings();

  useEffect(() => subscribeTtsPreferences(() => {
    setTtsAutoRead(getTtsAutoReadEnabled());
    setTtsRate(getTtsSpeechRate());
    setLocalTtsMode(getTtsMode());
    setServerConfigured(isServerTtsConfigured(getCachedServerTtsConfig()));
  }), []);

  useEffect(() => {
    if (!isIosNative) {
      setNativeVoiceQuality(null);
      return;
    }
    let cancelled = false;
    void getNativeTtsVoiceQuality(locale).then((info) => {
      if (!cancelled) setNativeVoiceQuality(info);
    });
    return () => {
      cancelled = true;
    };
  }, [isIosNative, locale]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === 'undefined') return;
    const rect = anchor.getBoundingClientRect();
    if (rect.width <= 0) return;
    // Desktop popover is right-aligned to the trigger; flip to left-aligned if right-alignment would clip the left edge.
    setAlignLeft(rect.right < 280);
  }, [anchorRef]);

  useEffect(() => {
    const handleOutsidePress = (e: Event) => {
      const target = e.target as Node | null;
      if (target && anchorRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('pointerdown', handleOutsidePress, true);
    document.addEventListener('mousedown', handleOutsidePress, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePress, true);
      document.removeEventListener('mousedown', handleOutsidePress, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorRef, onClose]);

  const currentVoiceName = isIosNative ? nativeVoiceQuality?.voiceName?.trim() : '';
  const currentVoiceQualityKey = currentVoiceName ? getNativeTtsVoiceQualityLabelKey(nativeVoiceQuality) : '';
  const currentVoiceQualityLabel = currentVoiceQualityKey ? t(currentVoiceQualityKey) : '';
  const showIosHint = isIosNative && !!nativeVoiceQuality && !isHighQualityNativeTtsVoice(nativeVoiceQuality);
  const showNativeSection = Boolean(currentVoiceName || showIosHint || canOpenSettings);

  return (
    <div
      class={`chat-tts-settings-popover${alignLeft ? ' is-align-left' : ''}`}
      data-testid="chat-tts-settings-popover"
      role="dialog"
      aria-label={t('chat.tts_settings')}
    >
      <div class="chat-tts-settings-row">
        <span class="chat-tts-settings-label">{t('settings.tts_auto_read')}</span>
        <button
          type="button"
          role="switch"
          aria-checked={ttsAutoRead}
          aria-label={t('settings.tts_auto_read')}
          data-testid="chat-tts-settings-autoread-toggle"
          class={`chat-tts-settings-switch${ttsAutoRead ? ' is-active' : ''}`}
          onClick={() => {
            const next = !ttsAutoRead;
            setTtsAutoReadEnabled(next);
            setTtsAutoRead(next);
            if (!next) {
              void stopSpeaking();
            }
          }}
        >
          {ttsAutoRead ? t('common.on', { defaultValue: 'On' }) : t('common.off', { defaultValue: 'Off' })}
        </button>
      </div>

      <div class="chat-tts-settings-section">
        <div class="chat-tts-settings-label">{t('settings.tts_rate')}</div>
        <div class="chat-tts-settings-rate-group">
          {TTS_RATE_OPTIONS.map((opt) => (
            <button
              key={opt}
              type="button"
              data-testid={`chat-tts-settings-rate-${opt}`}
              aria-pressed={ttsRate === opt}
              class={`chat-tts-settings-rate-btn${ttsRate === opt ? ' is-active' : ''}`}
              onClick={() => {
                setTtsSpeechRate(opt);
                setTtsRate(opt);
              }}
            >
              {opt}x
            </button>
          ))}
        </div>
      </div>

      {serverConfigured || ttsMode === 'server' ? (
        <div class="chat-tts-settings-section" data-testid="chat-tts-settings-engine-section">
          <div class="chat-tts-settings-label">{t('settings.tts_engine')}</div>
          <div class="chat-tts-settings-rate-group">
            {(['system', 'server'] as const).map((engine) => (
              <button
                key={engine}
                type="button"
                data-testid={`chat-tts-settings-engine-${engine}`}
                aria-pressed={ttsMode === engine}
                class={`chat-tts-settings-rate-btn${ttsMode === engine ? ' is-active' : ''}`}
                onClick={() => {
                  if (ttsMode === engine) return;
                  setTtsMode(engine);
                  setLocalTtsMode(engine);
                  void stopSpeaking();
                  if (typeof saveServerTtsConfig === 'function') {
                    void saveServerTtsConfig({ mode: engine }).catch(() => {});
                  }
                }}
              >
                {t(`settings.tts_engine_${engine}`)}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div class="chat-tts-settings-hint" data-testid="chat-tts-settings-server-hint">
          {t('settings.tts_server_unconfigured_hint')}
        </div>
      )}

      {showNativeSection && (
        <div class="chat-tts-settings-native" data-testid="chat-tts-settings-native-section">
          {currentVoiceName && (
            <div class="chat-tts-settings-voice" data-testid="chat-tts-settings-current-voice">
              {currentVoiceQualityLabel
                ? t('settings.tts_current_voice', { name: currentVoiceName, quality: currentVoiceQualityLabel })
                : currentVoiceName}
            </div>
          )}
          {showIosHint && (
            <div class="chat-tts-settings-hint" data-testid="chat-tts-settings-ios-hint">
              {t('settings.tts_ios_enhanced_hint')}
            </div>
          )}
          {canOpenSettings && (
            <button
              type="button"
              data-testid="chat-tts-settings-open-native-btn"
              class="chat-tts-settings-open-btn"
              onClick={() => {
                void openNativeTtsSettings();
              }}
            >
              {isIosNative
                ? t('settings.tts_open_ios_settings')
                : t('settings.tts_open_android_settings')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
