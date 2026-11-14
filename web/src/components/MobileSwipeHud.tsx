/**
 * Interactive 4-direction tactical HUD shown while dragging 2 fingers on mobile
 * to preview exact target server/session switching and threshold arming.
 */
import { useTranslation } from 'react-i18next';
import { cycleOrderedId } from '../keyboard-shortcuts.js';
import type {
  MobileNavigationDirection,
  MobileNavigationGestureProgress,
} from '../mobile-navigation-gestures.js';

export interface MobileSwipeServerTargetInput {
  readonly id: string;
  readonly name?: string | null;
  readonly isSharedIn?: boolean;
}

export interface MobileSwipeSessionTargetInput {
  readonly name: string;
  readonly label?: string | null;
  readonly project?: string | null;
}

export interface MobileSwipeTargetResolutionInput {
  readonly servers: readonly MobileSwipeServerTargetInput[];
  readonly currentServerId: string | null | undefined;
  readonly hasActiveShareTarget?: boolean;
  readonly tabs: readonly MobileSwipeSessionTargetInput[];
  readonly activeSession: string | null | undefined;
  readonly selectedServerId: string | null | undefined;
  readonly manualDashboard: boolean;
}

export type MobileSwipeTargets = Record<MobileNavigationDirection, string | null>;

/**
 * Resolves preview labels for all 4 gesture directions using the exact ordering,
 * cycling, naming, and minCount=2 guards used by `navigateServerByStep` and
 * `navigateTabByStep` in `app.tsx`.
 */
export function resolveMobileSwipeTargets(input: MobileSwipeTargetResolutionInput): MobileSwipeTargets {
  const {
    servers,
    currentServerId,
    hasActiveShareTarget = false,
    tabs,
    activeSession,
    selectedServerId,
    manualDashboard,
  } = input;

  const resolveServerDirection = (step: -1 | 1): string | null => {
    if (servers.length < 2) return null;
    const normalizedCurrent = currentServerId ?? null;
    const nextId = cycleOrderedId(
      servers.map((srv) => srv.id),
      normalizedCurrent,
      step,
    );
    const nextServer = nextId ? servers.find((srv) => srv.id === nextId) : null;
    if (!nextServer) return null;
    if (nextServer.id !== normalizedCurrent || (hasActiveShareTarget && !nextServer.isSharedIn)) {
      return nextServer.name || nextServer.id;
    }
    return null;
  };

  const resolveSessionDirection = (step: -1 | 1): string | null => {
    if (!selectedServerId || manualDashboard || tabs.length < 2) return null;
    const normalizedActive = activeSession ?? null;
    const nextName = cycleOrderedId(
      tabs.map((session) => session.name),
      normalizedActive,
      step,
    );
    if (!nextName || nextName === normalizedActive) return null;
    const nextSession = tabs.find((session) => session.name === nextName);
    return nextSession
      ? (nextSession.label || nextSession.project || nextSession.name)
      : nextName;
  };

  return {
    up: resolveServerDirection(-1),
    down: resolveServerDirection(1),
    left: resolveSessionDirection(-1),
    right: resolveSessionDirection(1),
  };
}

export interface MobileSwipeHudProps {
  progress: MobileNavigationGestureProgress | null;
  targets?: Partial<MobileSwipeTargets> | null;
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

export function MobileSwipeHud({ progress, targets }: MobileSwipeHudProps) {
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
        <span class="mobile-swipe-hud-corner is-tl" aria-hidden="true" />
        <span class="mobile-swipe-hud-corner is-tr" aria-hidden="true" />
        <span class="mobile-swipe-hud-corner is-bl" aria-hidden="true" />
        <span class="mobile-swipe-hud-corner is-br" aria-hidden="true" />

        <div class="mobile-swipe-hud-header">
          <span class="mobile-swipe-hud-title-wrap">
            <span class="mobile-swipe-hud-status-dot" aria-hidden="true" />
            <span class="mobile-swipe-hud-title">
              {t('mobile_gesture.hud.title', { defaultValue: '2-Finger Navigation' })}
            </span>
          </span>
          <span class="mobile-swipe-hud-pct" data-testid="mobile-swipe-hud-progress">
            {pct}%
          </span>
        </div>

        <div class="mobile-swipe-hud-compass">
          <div class="mobile-swipe-hud-reticle" aria-hidden="true">
            <span class="mobile-swipe-hud-axis is-vertical" />
            <span class="mobile-swipe-hud-axis is-horizontal" />
          </div>

          <div class="mobile-swipe-hud-center">
            <span class="mobile-swipe-hud-orbit" aria-hidden="true" />
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
            const hasTargetSlot = Boolean(targets && Object.prototype.hasOwnProperty.call(targets, item.dir));
            const targetValue = hasTargetSlot ? (targets?.[item.dir] ?? null) : undefined;
            const isUnavailable = hasTargetSlot && targetValue === null;
            return (
              <div
                key={item.dir}
                class={`mobile-swipe-hud-dir is-${item.dir} is-${item.kind}${isActive ? ' is-active' : ''}${isArmed ? ' is-armed' : ''}${isUnavailable ? ' is-unavailable' : ''}`}
                data-testid={`mobile-swipe-hud-dir-${item.dir}`}
                data-active={isActive ? 'true' : 'false'}
                data-armed={isArmed ? 'true' : 'false'}
                data-available={hasTargetSlot ? (isUnavailable ? 'false' : 'true') : undefined}
              >
                <div class="mobile-swipe-hud-dir-head">
                  <span class="mobile-swipe-hud-dir-arrow">{item.arrow}</span>
                  <span class="mobile-swipe-hud-dir-label">
                    {t(item.i18nKey, { defaultValue: item.fallback })}
                  </span>
                </div>
                {hasTargetSlot && (
                  <span
                    class={`mobile-swipe-hud-dir-target${isUnavailable ? ' is-empty' : ''}`}
                    data-testid={`mobile-swipe-hud-dir-target-${item.dir}`}
                    data-available={isUnavailable ? 'false' : 'true'}
                  >
                    {targetValue ?? t('mobile_gesture.hud.no_target', { defaultValue: 'No other target' })}
                  </span>
                )}
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
