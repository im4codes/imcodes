export const SDK_AGENTS_AUTO_OPEN_DELAY_MS = 450;
export const SDK_AGENTS_AUTO_CLOSE_GRACE_MS = 2500;

export interface SdkAgentsAutoOpenState {
  sessionId: string | null | undefined;
  open: boolean;
}

export interface SdkAgentsVisibilityInput {
  sessionId: string | null | undefined;
  canShowAgentsControl: boolean;
  hasAgentsStatusRows: boolean;
  desiredAgentsOpen: boolean;
  runningAgentsCount: number;
}

export type SdkAgentsTimerAction = 'none' | 'schedule-open' | 'schedule-close' | 'cancel';

/**
 * Compute initial/session-switch synchronous auto-open state so switching into
 * an idle session never flashes 1 frame and switching into an already-active
 * session opens immediately.
 */
export function initialSdkAgentsAutoOpen(input: SdkAgentsVisibilityInput): boolean {
  return input.canShowAgentsControl
    && input.hasAgentsStatusRows
    && input.desiredAgentsOpen
    && input.runningAgentsCount > 0;
}

/**
 * Resolve effective auto-open state synchronously during render, handling
 * session switches and immediate disablement without waiting for effects.
 */
export function resolveEffectiveSdkAgentsAutoOpen(
  state: SdkAgentsAutoOpenState,
  input: SdkAgentsVisibilityInput,
): boolean {
  if (!input.canShowAgentsControl || !input.hasAgentsStatusRows || !input.desiredAgentsOpen) {
    return false;
  }
  if (state.sessionId !== input.sessionId) {
    return input.runningAgentsCount > 0;
  }
  return state.open;
}

/**
 * Decide which hysteresis timer action applies to the current render state.
 */
export function resolveSdkAgentsTimerAction(
  effectiveAutoOpen: boolean,
  input: Omit<SdkAgentsVisibilityInput, 'sessionId'>,
): SdkAgentsTimerAction {
  if (!input.canShowAgentsControl || !input.hasAgentsStatusRows || !input.desiredAgentsOpen) {
    return 'cancel';
  }
  if (input.runningAgentsCount > 0) {
    return effectiveAutoOpen ? 'cancel' : 'schedule-open';
  }
  return effectiveAutoOpen ? 'schedule-close' : 'cancel';
}
