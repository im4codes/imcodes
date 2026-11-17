/**
 * Non-blocking first-install floating card for native apps (`Capacitor.isNativePlatform() === true`)
 * prompting the user to pick/adjust a comfortable whole-page UI scale (%) once.
 */
import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { NATIVE_HOST_EVENT } from '../native-platform.js';
import {
  formatUiScale,
  markUiScalePrompted,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  shouldShowUiScaleOnboardingPrompt,
  UI_SCALE_PROMPT_EVENT,
  UI_SCALE_PROMPTED_STORAGE_KEY,
  UI_SCALE_STEP,
  UI_SCALE_STORAGE_KEY,
  useUiScale,
} from '../ui-scale.js';

const QUICK_SCALE_PRESETS = [75, 90, 100, 125] as const;

export function UiScaleOnboardingCard() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState<boolean>(() => shouldShowUiScaleOnboardingPrompt());
  const [uiScale, setUiScale] = useUiScale();

  useEffect(() => {
    const syncVisibility = () => {
      setVisible(shouldShowUiScaleOnboardingPrompt());
    };
    const onPromptChange = () => {
      setVisible(false);
    };
    const onStorage = (e: StorageEvent) => {
      if (
        e.key === null
        || e.key === UI_SCALE_PROMPTED_STORAGE_KEY
        || e.key === UI_SCALE_STORAGE_KEY
      ) {
        syncVisibility();
      }
    };
    globalThis.addEventListener(UI_SCALE_PROMPT_EVENT, onPromptChange);
    globalThis.addEventListener(NATIVE_HOST_EVENT, syncVisibility);
    globalThis.addEventListener('storage', onStorage);
    return () => {
      globalThis.removeEventListener(UI_SCALE_PROMPT_EVENT, onPromptChange);
      globalThis.removeEventListener(NATIVE_HOST_EVENT, syncVisibility);
      globalThis.removeEventListener('storage', onStorage);
    };
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    markUiScalePrompted();
    setVisible(false);
  };

  const btnStyle = (active: boolean, disabled = false) => ({
    padding: '4px 8px',
    borderRadius: 6,
    border: active ? '1px solid rgba(56, 189, 248, 0.72)' : '1px solid #334155',
    background: active ? 'rgba(14, 116, 144, 0.38)' : '#0f172a',
    color: active ? '#e0f2fe' : '#cbd5e1',
    opacity: disabled ? 0.45 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 'calc(12px + var(--imcodes-global-font-delta, 0px))',
    fontWeight: 600,
    fontFamily: 'system-ui',
    lineHeight: 1.2,
  }) as const;

  return (
    <aside
      data-testid="ui-scale-onboarding-card"
      aria-label={t('chat.font.uiScalePromptTitle', { defaultValue: 'Adjust UI scale' })}
      style={{
        position: 'fixed',
        top: 'calc(max(12px, var(--sat, 0px)) + 44px)',
        right: 12,
        zIndex: 660,
        width: 'min(320px, calc(var(--imcodes-ui-vw, 100vw) - 24px))',
        background: 'linear-gradient(180deg, rgba(17, 27, 45, 0.98), rgba(8, 13, 22, 0.98))',
        border: '1px solid rgba(56, 189, 248, 0.42)',
        borderRadius: 10,
        padding: '12px 14px',
        color: '#e2e8f0',
        boxShadow: '0 12px 30px rgba(0, 0, 0, 0.55), 0 0 18px rgba(34, 211, 238, 0.14)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 'calc(13px + var(--imcodes-global-font-delta, 0px))', fontWeight: 700, color: '#f8fafc' }}>
            {t('chat.font.uiScalePromptTitle', { defaultValue: 'Adjust UI scale' })}
          </div>
          <div style={{ fontSize: 'calc(12px + var(--imcodes-global-font-delta, 0px))', color: '#94a3b8', lineHeight: 1.4, marginTop: 2 }}>
            {t('chat.font.uiScalePromptHint', { defaultValue: 'Pick a comfortable size for this screen. You can change it anytime in Aa or Settings.' })}
          </div>
        </div>
        <button
          type="button"
          data-testid="ui-scale-onboarding-close"
          onClick={dismiss}
          aria-label={t('chat.font.uiScalePromptClose', { defaultValue: 'Close' })}
          style={{
            border: '1px solid transparent',
            background: 'transparent',
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: 'calc(16px + var(--imcodes-global-font-delta, 0px))',
            lineHeight: 1,
            padding: '2px 6px',
            borderRadius: 6,
            flexShrink: 0,
          }}
        >
          ×
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            data-testid="ui-scale-onboarding-decrease"
            onClick={() => setUiScale((prev) => prev - UI_SCALE_STEP)}
            disabled={uiScale <= MIN_UI_SCALE}
            aria-label={t('chat.font.uiScaleDecrease', { defaultValue: 'Decrease UI scale' })}
            style={btnStyle(false, uiScale <= MIN_UI_SCALE)}
          >
            −
          </button>
          <span
            data-testid="ui-scale-onboarding-readout"
            style={{
              minWidth: 44,
              textAlign: 'center',
              fontVariantNumeric: 'tabular-nums',
              fontWeight: 700,
              fontSize: 'calc(13px + var(--imcodes-global-font-delta, 0px))',
              color: '#f8fafc',
            }}
          >
            {formatUiScale(uiScale)}
          </span>
          <button
            type="button"
            data-testid="ui-scale-onboarding-increase"
            onClick={() => setUiScale((prev) => prev + UI_SCALE_STEP)}
            disabled={uiScale >= MAX_UI_SCALE}
            aria-label={t('chat.font.uiScaleIncrease', { defaultValue: 'Increase UI scale' })}
            style={btnStyle(false, uiScale >= MAX_UI_SCALE)}
          >
            +
          </button>
        </div>

        <button
          type="button"
          data-testid="ui-scale-onboarding-done"
          onClick={dismiss}
          style={{
            padding: '5px 12px',
            borderRadius: 6,
            border: '1px solid rgba(56, 189, 248, 0.55)',
            background: '#0284c7',
            color: '#f8fafc',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 'calc(12px + var(--imcodes-global-font-delta, 0px))',
          }}
        >
          {t('chat.font.uiScalePromptDone', { defaultValue: 'Done' })}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {QUICK_SCALE_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            data-testid={`ui-scale-onboarding-preset-${preset}`}
            onClick={() => setUiScale(preset)}
            style={btnStyle(uiScale === preset)}
          >
            {formatUiScale(preset)}
          </button>
        ))}
      </div>
    </aside>
  );
}
