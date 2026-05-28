import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Props {
  open: boolean;
  selector?: string;
  onDismiss: () => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function TeamDiscussionGuide({
  open,
  selector = '[data-onboarding="p2p-mode"]',
  onDismiss,
}: Props) {
  const { t } = useTranslation();
  const [targetRect, setTargetRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!open) {
      setTargetRect(null);
      return;
    }

    let raf = 0;
    const update = () => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) {
        setTargetRect(null);
        return;
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
  }, [open, selector]);

  const position = useMemo(() => {
    if (!targetRect) return null;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const width = Math.min(380, vw - 24);
    const estimatedHeight = 198;
    const gap = 16;
    const targetCenter = targetRect.left + targetRect.width / 2;
    const placement: 'above' | 'below' = targetRect.top > estimatedHeight + gap + 12 ? 'above' : 'below';
    const top = placement === 'above'
      ? clamp(targetRect.top - estimatedHeight - gap, 12, Math.max(12, vh - estimatedHeight - 12))
      : clamp(targetRect.top + targetRect.height + gap, 12, Math.max(12, vh - estimatedHeight - 12));
    const left = clamp(targetCenter - width / 2, 12, Math.max(12, vw - width - 12));
    const arrowLeft = clamp(targetCenter - left - 8, 18, width - 34);
    return {
      card: { top: `${top}px`, left: `${left}px`, width: `${width}px` },
      arrow: { left: `${arrowLeft}px` },
      placement,
    };
  }, [targetRect]);

  if (!open || !position) return null;

  return (
    <div
      class={`team-discussion-guide team-discussion-guide-${position.placement}`}
      style={position.card}
      role="dialog"
      aria-live="polite"
      aria-label={t('onboarding.team_discussion_guide.title')}
      data-testid="team-discussion-guide"
    >
      <div
        class={`team-discussion-guide-arrow team-discussion-guide-arrow-${position.placement}`}
        style={position.arrow}
        aria-hidden="true"
      />
      <button
        type="button"
        class="team-discussion-guide-close"
        onClick={onDismiss}
        aria-label={t('onboarding.team_discussion_guide.dismiss')}
      >
        ×
      </button>
      <div class="team-discussion-guide-kicker">Team</div>
      <div class="team-discussion-guide-title">{t('onboarding.team_discussion_guide.title')}</div>
      <div class="team-discussion-guide-body">
        <div>{t('onboarding.team_discussion_guide.body_1')}</div>
        <div>{t('onboarding.team_discussion_guide.body_2')}</div>
        <div>{t('onboarding.team_discussion_guide.body_3')}</div>
      </div>
      <button type="button" class="team-discussion-guide-action" onClick={onDismiss}>
        {t('onboarding.team_discussion_guide.dismiss')}
      </button>
    </div>
  );
}
