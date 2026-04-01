import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';

export interface NewUserGuideStep {
  selector?: string;
  titleKey: string;
  bodyKeys: string[];
}

interface Props {
  open: boolean;
  steps: NewUserGuideStep[];
  onClose: () => void;
  onComplete: () => void;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function NewUserGuide({ open, steps, onClose, onComplete }: Props) {
  const { t } = useTranslation();
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (open) setStepIndex(0);
  }, [open]);

  const step = steps[stepIndex];

  useEffect(() => {
    if (!open || !step) return;

    let raf = 0;
    const update = () => {
      if (!step.selector) {
        setTargetRect(null);
        return;
      }
      const el = document.querySelector(step.selector) as HTMLElement | null;
      if (!el) {
        setTargetRect(null);
        return;
      }
      try {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      } catch {
        el.scrollIntoView({ block: 'center', inline: 'center' });
      }
      const rect = el.getBoundingClientRect();
      setTargetRect({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      });
    };

    raf = requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, step]);

  const cardStyle = useMemo(() => {
    if (!targetRect) return undefined;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardWidth = Math.min(420, vw - 32);
    const gap = 16;
    const prefersBelow = targetRect.top < vh * 0.45;
    const top = prefersBelow
      ? clamp(targetRect.top + targetRect.height + gap, 16, vh - 260)
      : clamp(targetRect.top - 220 - gap, 16, vh - 260);
    const left = clamp(targetRect.left + (targetRect.width / 2) - (cardWidth / 2), 16, vw - cardWidth - 16);
    return { top: `${top}px`, left: `${left}px`, width: `${cardWidth}px` };
  }, [targetRect]);

  if (!open || !step) return null;

  const isLast = stepIndex === steps.length - 1;

  return (
    <div class="onboarding-overlay" onClick={onClose}>
      {targetRect && (
        <div
          class="onboarding-highlight"
          style={{
            top: `${targetRect.top - 6}px`,
            left: `${targetRect.left - 6}px`,
            width: `${targetRect.width + 12}px`,
            height: `${targetRect.height + 12}px`,
          }}
        />
      )}
      <div
        class={`onboarding-card${targetRect ? ' onboarding-card-floating' : ''}`}
        style={cardStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="onboarding-step">
          {t('onboarding.step_counter', { current: stepIndex + 1, total: steps.length })}
        </div>
        <div class="onboarding-title">{t(step.titleKey)}</div>
        <div class="onboarding-body">
          {step.bodyKeys.map((key) => (
            <div key={key}>{t(key)}</div>
          ))}
        </div>
        <div class="ask-actions">
          <button class="ask-btn-cancel" onClick={onClose}>{t('common.close')}</button>
          {stepIndex > 0 && (
            <button class="ask-btn-cancel" onClick={() => setStepIndex((idx) => Math.max(0, idx - 1))}>
              {t('onboarding.prev')}
            </button>
          )}
          <button
            class="ask-btn-submit"
            onClick={() => {
              if (isLast) onComplete();
              else setStepIndex((idx) => idx + 1);
            }}
          >
            {isLast ? t('onboarding.finish') : t('onboarding.next')}
          </button>
        </div>
      </div>
    </div>
  );
}
