import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { RefObject } from 'preact';
import { useTranslation } from 'react-i18next';
import { TTS_DEFAULT_VOICE } from '@shared/tts-config.js';
import {
  canOpenNativeTtsSettings,
  fetchServerTtsVoices,
  getCachedServerTtsConfig,
  getCachedServerTtsVoices,
  getDefaultPresetTtsVoices,
  getNativeTtsVoiceQuality,
  getTtsAutoReadEnabled,
  getTtsMode,
  getTtsSpeechRate,
  getTtsState,
  isServerTtsConfigured,
  openNativeTtsSettings,
  previewServerTtsVoice,
  saveServerTtsConfig,
  setTtsAutoReadEnabled,
  setTtsMode,
  setTtsSpeechRate,
  stopSpeaking,
  subscribeTtsPreferences,
  subscribeTtsState,
  TTS_RATE_OPTIONS,
  type TtsEngineMode,
  type TtsPlaybackState,
  type TtsPublicConfig,
  type TtsVoiceOption,
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

interface PopoverPosition {
  top: number;
  left: number;
  width?: number;
  maxHeight: number;
  alignLeft: boolean;
}

const VIEWPORT_MARGIN = 8;
const MOBILE_BREAKPOINT = 640;
const DESKTOP_POPOVER_WIDTH = 272;
const ESTIMATED_POPOVER_HEIGHT = 280;

function computePopoverPosition(
  anchorRect: DOMRect,
  popoverRect: DOMRect | null,
  vw: number,
  vh: number,
): PopoverPosition | null {
  if ((anchorRect.width <= 0 && anchorRect.height <= 0) || vw <= 0 || vh <= 0) {
    return null;
  }

  const isMobile = vw <= MOBILE_BREAKPOINT;
  const gap = isMobile ? 4 : 6;
  const maxAvailableWidth = Math.max(0, vw - VIEWPORT_MARGIN * 2);
  const popWidth = isMobile
    ? maxAvailableWidth
    : Math.min(popoverRect && popoverRect.width > 0 ? popoverRect.width : DESKTOP_POPOVER_WIDTH, maxAvailableWidth);
  const popHeight = popoverRect && popoverRect.height > 0 ? popoverRect.height : ESTIMATED_POPOVER_HEIGHT;

  let left: number;
  let alignLeft = false;
  if (isMobile) {
    left = vw > VIEWPORT_MARGIN * 2 ? VIEWPORT_MARGIN : 0;
  } else {
    const canAlignRight = anchorRect.right - popWidth >= VIEWPORT_MARGIN;
    alignLeft = !canAlignRight;
    const preferredLeft = canAlignRight ? anchorRect.right - popWidth : anchorRect.left;
    const maxLeft = Math.max(VIEWPORT_MARGIN, vw - popWidth - VIEWPORT_MARGIN);
    left = Math.min(Math.max(preferredLeft, VIEWPORT_MARGIN), maxLeft);
  }

  const belowTop = anchorRect.bottom + gap;
  const spaceBelow = vh - belowTop - VIEWPORT_MARGIN;
  const spaceAbove = anchorRect.top - gap - VIEWPORT_MARGIN;
  const placeBelow = spaceBelow >= popHeight || spaceBelow >= spaceAbove;
  const rawMaxHeight = placeBelow ? spaceBelow : spaceAbove;
  const maxAllowedHeight = Math.max(1, vh - VIEWPORT_MARGIN * 2);
  const maxHeight = rawMaxHeight > 0 ? Math.min(maxAllowedHeight, Math.floor(rawMaxHeight)) : maxAllowedHeight;
  const effectiveHeight = Math.min(popHeight, maxHeight);
  const rawTop = placeBelow ? belowTop : anchorRect.top - gap - effectiveHeight;
  const maxTop = Math.max(VIEWPORT_MARGIN, vh - effectiveHeight - VIEWPORT_MARGIN);
  const top = Math.min(Math.max(rawTop, VIEWPORT_MARGIN), maxTop);

  return {
    top,
    left,
    ...(isMobile && maxAvailableWidth > 0 ? { width: maxAvailableWidth } : {}),
    maxHeight,
    alignLeft,
  };
}

export function TtsQuickSettingsPopover({ anchorRef, locale, onClose }: Props) {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [ttsAutoRead, setTtsAutoRead] = useState<boolean>(() => getTtsAutoReadEnabled());
  const [ttsRate, setTtsRate] = useState<number>(() => getTtsSpeechRate());
  const [ttsMode, setLocalTtsMode] = useState<TtsEngineMode>(() => getTtsMode());
  const [serverConfig, setServerConfig] = useState<TtsPublicConfig | null>(() => getCachedServerTtsConfig());
  const serverConfigured = isServerTtsConfigured(serverConfig);
  const currentServerVoice = serverConfig?.voice?.trim() || TTS_DEFAULT_VOICE;
  const [serverVoices, setServerVoices] = useState<TtsVoiceOption[]>(() => (
    getCachedServerTtsVoices()?.voices ?? getDefaultPresetTtsVoices(getCachedServerTtsConfig()?.voice)
  ));
  const [savingVoice, setSavingVoice] = useState(false);
  const [ttsPlayback, setTtsPlayback] = useState<TtsPlaybackState>(() => (
    typeof getTtsState === 'function' ? getTtsState() : { status: 'idle', activeMessageId: null, error: null }
  ));
  const [previewError, setPreviewError] = useState<string | null>(null);
  const lastVoiceChangeRef = useRef(currentServerVoice);
  if (!savingVoice) {
    lastVoiceChangeRef.current = currentServerVoice;
  }
  const [nativeVoiceQuality, setNativeVoiceQuality] = useState<NativeTtsVoiceQualityInfo | null>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  const isIosNative = isIosNativePlatform();
  const canOpenSettings = canOpenNativeTtsSettings();

  useEffect(() => subscribeTtsPreferences(() => {
    setTtsAutoRead(getTtsAutoReadEnabled());
    setTtsRate(getTtsSpeechRate());
    setLocalTtsMode(getTtsMode());
    setServerConfig(getCachedServerTtsConfig());
  }), []);

  useEffect(() => {
    if (typeof subscribeTtsState !== 'function') return undefined;
    return subscribeTtsState((next) => {
      setTtsPlayback(next);
    });
  }, []);

  useEffect(() => {
    if (ttsMode !== 'server' || !serverConfigured || typeof fetchServerTtsVoices !== 'function') return;
    let cancelled = false;
    void fetchServerTtsVoices().then((res) => {
      if (cancelled || !res?.voices?.length) return;
      setServerVoices(res.voices);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    ttsMode,
    serverConfigured,
    serverConfig?.baseUrl,
    serverConfig?.hasApiKey,
    serverConfig?.apiKeyMasked,
    serverConfig?.apiKeyFingerprint,
    serverConfig?.serverDefaultConfigured,
  ]);

  const voiceSelectOptions = useMemo(() => {
    const base = serverVoices.length > 0 ? serverVoices : getDefaultPresetTtsVoices(currentServerVoice);
    if (currentServerVoice && !base.some((v) => v.id === currentServerVoice)) {
      return [{ id: currentServerVoice, name: currentServerVoice }, ...base];
    }
    return base;
  }, [serverVoices, currentServerVoice]);

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

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === 'undefined') return;
    const vw = window.innerWidth || document.documentElement?.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement?.clientHeight || 0;
    const next = computePopoverPosition(
      anchor.getBoundingClientRect(),
      popoverRef.current?.getBoundingClientRect() ?? null,
      vw,
      vh,
    );
    setPosition(next);
  }, [anchorRef]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition, serverConfigured, ttsMode, nativeVoiceQuality, canOpenSettings]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleReposition = () => updatePosition();
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);
    return () => {
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [updatePosition]);

  useEffect(() => {
    const handleOutsidePress = (e: Event) => {
      const target = e.target as Node | null;
      if (target && (anchorRef.current?.contains(target) || popoverRef.current?.contains(target))) return;
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

  const popoverStyle = position
    ? {
        top: `${position.top}px`,
        left: `${position.left}px`,
        right: 'auto',
        ...(position.width !== undefined ? { width: `${position.width}px` } : {}),
        maxHeight: `${position.maxHeight}px`,
      }
    : undefined;

  const handleVoiceSelect = async (e: Event) => {
    const nextVoice = (e.currentTarget as HTMLSelectElement).value;
    if (!nextVoice || nextVoice === currentServerVoice || nextVoice === lastVoiceChangeRef.current) return;
    lastVoiceChangeRef.current = nextVoice;
    void stopSpeaking();
    if (typeof saveServerTtsConfig !== 'function') return;
    setSavingVoice(true);
    try {
      const res = await saveServerTtsConfig({ voice: nextVoice });
      if (res?.config) {
        setServerConfig(res.config);
        lastVoiceChangeRef.current = res.config.voice?.trim() || nextVoice;
      }
    } catch {
      lastVoiceChangeRef.current = currentServerVoice;
    } finally {
      setSavingVoice(false);
    }
  };

  const popoverEl = (
    <div
      ref={popoverRef}
      class={`chat-tts-settings-popover${position?.alignLeft ? ' is-align-left' : ''}`}
      data-testid="chat-tts-settings-popover"
      role="dialog"
      aria-label={t('chat.tts_settings')}
      style={popoverStyle}
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
        <>
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
          {ttsMode === 'server' && serverConfigured && (() => {
            const quickPreviewId = 'chat-quick-voice-preview';
            const isPreviewing = ttsPlayback.status === 'speaking' && ttsPlayback.activeMessageId === quickPreviewId;
            return (
              <div class="chat-tts-settings-section" data-testid="chat-tts-settings-voice-section">
                <label class="chat-tts-settings-label" for="chat-tts-settings-voice-select">
                  {t('settings.tts_server_voice')}
                </label>
                <div class="chat-tts-settings-voice-row">
                  <select
                    id="chat-tts-settings-voice-select"
                    data-testid="chat-tts-settings-voice-select"
                    class="chat-tts-settings-select"
                    value={currentServerVoice}
                    disabled={savingVoice}
                    onInput={(e) => void handleVoiceSelect(e)}
                    onChange={(e) => void handleVoiceSelect(e)}
                  >
                    {voiceSelectOptions.map((voice) => {
                      const label = voice.name && voice.name !== voice.id
                        ? `${voice.name} (${voice.id})`
                        : voice.id;
                      return <option key={voice.id} value={voice.id}>{voice.locale ? `${label} · ${voice.locale}` : label}</option>;
                    })}
                  </select>
                  <button
                    type="button"
                    data-testid="chat-tts-settings-voice-preview"
                    class={`chat-tts-settings-voice-preview-btn${isPreviewing ? ' is-playing' : ''}`}
                    title={isPreviewing ? t('settings.tts_preview_stop') : t('settings.tts_preview_voice')}
                    aria-label={isPreviewing ? t('settings.tts_preview_stop') : t('settings.tts_preview_voice')}
                    onClick={async () => {
                      setPreviewError(null);
                      if (isPreviewing) {
                        await stopSpeaking();
                        return;
                      }
                      if (typeof previewServerTtsVoice !== 'function') return;
                      const res = await previewServerTtsVoice({
                        voice: currentServerVoice,
                        rate: ttsRate,
                        availableVoices: voiceSelectOptions,
                        fallbackLocale: locale,
                        previewId: quickPreviewId,
                      });
                      if (!res.started && res.reason === 'error' && res.error) {
                        setPreviewError(t('settings.tts_preview_failed', { error: res.error }));
                      }
                    }}
                  >
                    {isPreviewing ? `■ ${t('settings.tts_preview_stop')}` : `▶ ${t('settings.tts_preview_voice')}`}
                  </button>
                </div>
                {previewError && (
                  <div class="chat-tts-settings-hint" data-testid="chat-tts-settings-voice-preview-error">
                    {previewError}
                  </div>
                )}
              </div>
            );
          })()}
        </>
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

  return typeof document !== 'undefined' && document.body ? createPortal(popoverEl, document.body) : popoverEl;
}
