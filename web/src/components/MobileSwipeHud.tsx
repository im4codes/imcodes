/**
 * Interactive 4-direction threshold guide HUD shown while dragging 2 fingers
 * on mobile to preview server/session switching and threshold arming.
 */
import { useTranslation } from 'react-i18next';
import type {
  MobileNavigationDirection,
  MobileNavigationGestureProgress,
} from '../mobile-navigation-gestures.js';

export interface MobileSwipeHudProps {
  progress: MobileNavigationGestureProgress | null;
}

interface DirectionDescriptor {
  readonly dir: MobileNavigationDirection;
  readonly arrow: string;
  readonly kind: 'server' | 'session';
  readonly i18nKey: string;
  readonly fallback: string;
}

const DIRECTION_ITEMS: readonly DirectionDescriptor[] = [
  { dir: 'up', arrow: '↑', kind: 'server', i18nKey: 'mobile_gesture.hud.up', fallback: 'Previous Server' },
  { dir: 'left', arrow: '←', kind: 'session', i18nKey: 'mobile_gesture.hud.left', fallback: 'Previous Session' },
  { dir: 'right', arrow: '→', kind: 'session', i18nKey: 'mobile_gesture.hud.right', fallback: 'Next Session' },
  { dir: 'down', arrow: '↓', kind: 'server', i18nKey: 'mobile_gesture.hud.down', fallback: 'Next Server' },
];

const RING_RADIUS = 20;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function MobileSwipeHud({ progress }: MobileSwipeHudProps) {
  const { t } = useTranslation();

  if (!progress) return null;

  const pct = Math.max(0, Math.min(100, Math.round(progress.progress * 100)));
  const dashOffset = RING_CIRCUMFERENCE * (1 - pct / 100);
  const activeKind = progress.direction === 'up' || progress.direction === 'down'
    ? 'server'
    : (progress.direction === 'left' || progress.direction === 'right' ? 'session' : 'neutral');

  return (
    <div
      class={`mobile-swipe-hud is-${activeKind}${progress.armed ? ' is-armed' : ''}`}
      data-testid="mobile-swipe-hud"
      data-direction={progress.direction ?? 'none'}
      data-armed={progress.armed ? 'true' : 'false'}
      data-progress={String(pct)}
      aria-hidden="true"
    >
      <div class={`mobile-swipe-hud-card is-${activeKind}${progress.armed ? ' is-armed' : ''}`}>
        <div class="mobile-swipe-hud-header">
          <span class="mobile-swipe-hud-title">
            {t('mobile_gesture.hud.title', { defaultValue: '2-Finger Navigation' })}
          </span>
          <span class="mobile-swipe-hud-pct" data-testid="mobile-swipe-hud-progress">
            {pct}%
          </span>
        </div>

        <div class="mobile-swipe-hud-compass">
          <div class="mobile-swipe-hud-center">
            <svg class="mobile-swipe-hud-ring" viewBox="0 0 48 48" width="48" height="48">
              <circle
                class="mobile-swipe-hud-ring-track"
                cx="24"
                cy="24"
                r={RING_RADIUS}
              />
              <circle
                class="mobile-swipe-hud-ring-fill"
                cx="24"
                cy="24"
                r={RING_RADIUS}
                stroke-dasharray={RING_CIRCUMFERENCE.toFixed(2)}
                stroke-dashoffset={dashOffset.toFixed(2)}
              />
            </svg>
            <span class="mobile-swipe-hud-center-badge">2F</span>
          </div>

          {DIRECTION_ITEMS.map((item) => {
            const isActive = progress.direction === item.dir;
            const isArmed = isActive && progress.armed;
            return (
              <div
                key={item.dir}
                class={`mobile-swipe-hud-dir is-${item.dir} is-${item.kind}${isActive ? ' is-active' : ''}${isArmed ? ' is-armed' : ''}`}
                data-testid={`mobile-swipe-hud-dir-${item.dir}`}
                data-active={isActive ? 'true' : 'false'}
                data-armed={isArmed ? 'true' : 'false'}
              >
                <span class="mobile-swipe-hud-dir-arrow">{item.arrow}</span>
                <span class="mobile-swipe-hud-dir-label">
                  {t(item.i18nKey, { defaultValue: item.fallback })}
                </span>
              </div>
            );
          })}
        </div>

        <div class="mobile-swipe-hud-footer">
          <div class="mobile-swipe-hud-bar-track">
            <div
              class="mobile-swipe-hud-bar-fill"
              data-testid="mobile-swipe-hud-progress-bar"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div class="mobile-swipe-hud-hint" data-testid="mobile-swipe-hud-hint">
            {progress.armed
              ? t('mobile_gesture.hud.release_to_switch', { defaultValue: 'Release to switch' })
              : t('mobile_gesture.hud.drag_to_threshold', { defaultValue: 'Drag past threshold to switch' })}
          </div>
        </div>
      </div>
    </div>
  );
}
