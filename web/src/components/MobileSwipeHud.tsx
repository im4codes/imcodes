/**
 * Interactive 4-direction tactical HUD shown while long-press dragging on mobile
 * to preview multi-level target server/session switching, hysteresis lock, and threshold arming.
 */
import { useTranslation } from 'react-i18next';
import { cycleOrderedId } from '../keyboard-shortcuts.js';
import {
  MOBILE_SWIPE_HORIZONTAL_MAX_STEPS,
  MOBILE_SWIPE_VERTICAL_MAX_STEPS_TALL,
  resolveMobileSwipeVerticalMaxSteps,
  type MobileNavigationDirection,
  type MobileNavigationGestureProgress,
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
  readonly verticalMaxSteps?: number;
  readonly horizontalMaxSteps?: number;
}

export interface MobileSwipeTargetEntry {
  readonly step: number;
  readonly id: string;
  readonly label: string;
}

export type MobileSwipeTargetInputValue = readonly MobileSwipeTargetEntry[] | string | null;
export type MobileSwipeTargets = Record<MobileNavigationDirection, readonly MobileSwipeTargetEntry[]>;

/**
 * Resolves ordered multi-level preview targets (1..K) for all 4 gesture directions
 * using the exact ordering, cycling, naming, distinct capping, and minCount=2 guards
 * used by `navigateServerByStep` and `navigateTabByStep` in `app.tsx`.
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
    verticalMaxSteps,
    horizontalMaxSteps,
  } = input;

  const verticalLimit = Math.max(
    1,
    Math.min(
      MOBILE_SWIPE_VERTICAL_MAX_STEPS_TALL,
      Math.trunc(verticalMaxSteps ?? resolveMobileSwipeVerticalMaxSteps()),
    ),
  );
  const horizontalLimit = Math.max(
    1,
    Math.min(
      MOBILE_SWIPE_HORIZONTAL_MAX_STEPS,
      Math.trunc(horizontalMaxSteps ?? MOBILE_SWIPE_HORIZONTAL_MAX_STEPS),
    ),
  );

  const serverIds = servers.map((srv) => srv.id);
  const resolveServerDirection = (sign: -1 | 1): readonly MobileSwipeTargetEntry[] => {
    if (servers.length < 2) return [];
    const normalizedCurrent = currentServerId ?? null;
    const entries: MobileSwipeTargetEntry[] = [];
    const seen = new Set<string>();
    for (let step = 1; step <= verticalLimit; step++) {
      const nextId = cycleOrderedId(serverIds, normalizedCurrent, sign * step);
      if (!nextId) break;
      const nextServer = servers.find((srv) => srv.id === nextId);
      if (!nextServer) break;
      const canUseSameServerExit = step === 1 && hasActiveShareTarget && !nextServer.isSharedIn;
      if (nextServer.id === normalizedCurrent && !canUseSameServerExit) {
        break;
      }
      if (seen.has(nextServer.id)) break;
      seen.add(nextServer.id);
      entries.push({
        step,
        id: nextServer.id,
        label: nextServer.name || nextServer.id,
      });
    }
    return entries;
  };

  const tabNames = tabs.map((session) => session.name);
  const resolveSessionDirection = (sign: -1 | 1): readonly MobileSwipeTargetEntry[] => {
    if (!selectedServerId || manualDashboard || tabs.length < 2) return [];
    const normalizedActive = activeSession ?? null;
    const entries: MobileSwipeTargetEntry[] = [];
    const seen = new Set<string>();
    for (let step = 1; step <= horizontalLimit; step++) {
      const nextName = cycleOrderedId(tabNames, normalizedActive, sign * step);
      if (!nextName || nextName === normalizedActive || seen.has(nextName)) break;
      seen.add(nextName);
      const nextSession = tabs.find((session) => session.name === nextName);
      entries.push({
        step,
        id: nextName,
        label: nextSession
          ? (nextSession.label || nextSession.project || nextSession.name)
          : nextName,
      });
    }
    return entries;
  };

  return {
    up: resolveServerDirection(-1),
    down: resolveServerDirection(1),
    left: resolveSessionDirection(-1),
    right: resolveSessionDirection(1),
  };
}

function normalizeDirectionTargets(raw: MobileSwipeTargetInputValue | undefined): readonly MobileSwipeTargetEntry[] {
  if (!raw) return [];
  if (typeof raw === 'string') {
    return [{ step: 1, id: raw, label: raw }];
  }
  return raw;
}

export interface MobileSwipeHudProps {
  progress: MobileNavigationGestureProgress | null;
  targets?: Partial<Record<MobileNavigationDirection, MobileSwipeTargetInputValue>> | null;
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
  const activeStep = Math.max(0, Math.trunc(progress.step ?? (progress.armed ? 1 : 0)));
  const maxSteps = Math.max(0, Math.trunc(progress.maxSteps ?? 3));
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
      data-step={String(activeStep)}
      data-max-steps={String(maxSteps)}
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
              {t('mobile_gesture.hud.title', { defaultValue: 'Gesture' })}
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
            <span class="mobile-swipe-hud-center-badge" data-testid="mobile-swipe-hud-center-badge">
              {activeStep > 0 ? (
                `L${activeStep}`
              ) : (
                <svg class="mobile-swipe-hud-gesture-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M8 1.5l2.2 2.2-.9.9L8.65 3.95v3.4h3.4l-.65-.65.9-.9L14.5 8l-2.2 2.2-.9-.9.65-.65h-3.4v3.4l.65-.65.9.9L8 14.5l-2.2-2.2.9-.9.65.65v-3.4h-3.4l.65.65-.9.9L1.5 8l2.2-2.2.9.9-.65.65h3.4v-3.4l-.65.65-.9-.9L8 1.5z"
                  />
                </svg>
              )}
            </span>
          </div>

          {DIRECTION_ITEMS.map((item) => {
            const isActive = progress.direction === item.dir;
            const isArmed = isActive && progress.armed && activeStep > 0;
            const dirStep = isArmed ? activeStep : 0;
            const hasTargetSlot = Boolean(targets && Object.prototype.hasOwnProperty.call(targets, item.dir));
            const targetEntries = hasTargetSlot ? normalizeDirectionTargets(targets?.[item.dir]) : [];
            const isUnavailable = hasTargetSlot && targetEntries.length === 0;
            return (
              <div
                key={item.dir}
                class={`mobile-swipe-hud-dir is-${item.dir} is-${item.kind}${isActive ? ' is-active' : ''}${isArmed ? ' is-armed' : ''}${isUnavailable ? ' is-unavailable' : ''}`}
                data-testid={`mobile-swipe-hud-dir-${item.dir}`}
                data-active={isActive ? 'true' : 'false'}
                data-armed={isArmed ? 'true' : 'false'}
                data-step={String(dirStep)}
                data-available={hasTargetSlot ? (isUnavailable ? 'false' : 'true') : undefined}
              >
                <div class="mobile-swipe-hud-dir-head">
                  <span class="mobile-swipe-hud-dir-arrow">{item.arrow}</span>
                  <span class="mobile-swipe-hud-dir-label">
                    {t(item.i18nKey, { defaultValue: item.fallback })}
                  </span>
                </div>
                {hasTargetSlot && (
                  isUnavailable ? (
                    <span
                      class="mobile-swipe-hud-dir-target is-empty"
                      data-testid={`mobile-swipe-hud-dir-target-${item.dir}`}
                      data-available="false"
                    >
                      {t('mobile_gesture.hud.no_target', { defaultValue: 'No other target' })}
                    </span>
                  ) : (
                    <div class={`mobile-swipe-hud-dir-targets is-${item.dir}`}>
                      {targetEntries.map((entry) => {
                        const isSelected = isArmed && dirStep === entry.step;
                        return (
                          <div
                            key={entry.step}
                            class={`mobile-swipe-hud-dir-target-row${isSelected ? ' is-selected' : ''}`}
                            data-step={String(entry.step)}
                            data-selected={isSelected ? 'true' : 'false'}
                          >
                            <span class="mobile-swipe-hud-step-badge">{entry.step}</span>
                            <span
                              class={`mobile-swipe-hud-dir-target${isSelected ? ' is-selected' : ''}`}
                              data-testid={
                                entry.step === 1
                                  ? `mobile-swipe-hud-dir-target-${item.dir}`
                                  : `mobile-swipe-hud-dir-target-${item.dir}-${entry.step}`
                              }
                              data-step={String(entry.step)}
                              data-selected={isSelected ? 'true' : 'false'}
                              data-available="true"
                            >
                              {entry.label}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )
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
              ? (activeStep > 1
                ? t('mobile_gesture.hud.release_to_switch_step', {
                  step: activeStep,
                  defaultValue: `Release to switch (L${activeStep})`,
                })
                : t('mobile_gesture.hud.release_to_switch', { defaultValue: 'Release to switch' }))
              : t('mobile_gesture.hud.drag_to_threshold', { defaultValue: 'Drag past threshold to switch' })}
          </div>
        </div>
      </div>
    </div>
  );
}
