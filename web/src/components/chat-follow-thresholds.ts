/**
 * Follow-mode ("stick to bottom") hysteresis thresholds for the chat scroll
 * viewport, pulled out of ChatView's `handleScroll` so the boundary maths is
 * unit-testable.
 *
 * Two thresholds form a hysteresis band that prevents the follow state from
 * flapping around a single boundary during streaming layout shifts:
 *   - `disengageThreshold`: while following, scrolling MORE than this far from
 *      the bottom pauses follow (the user is reading older content).
 *   - `reengageThreshold`: while paused, scrolling back to WITHIN this of the
 *      bottom re-engages follow. Always strictly below `disengageThreshold`.
 *
 * The base thresholds scale with viewport height (adaptive: a flat pixel value
 * over-engages a short mobile pane and under-engages a tall desktop pane).
 *
 * Short-content guard — the bug this module exists to fix: when the content
 * only slightly exceeds the viewport (certain window heights), the fixed
 * disengage threshold can be LARGER than the entire scrollable range, so the
 * user can never scroll up far enough to pause follow-mode — every reflow /
 * load-older / stream tick then snaps them straight back to the bottom (the
 * chat "jitters to the bottom" on a gentle scroll-up). When the base disengage
 * threshold would need more than half the achievable range, both thresholds
 * are rescaled to that range (0.5× / 0.2×), keeping disengage > reengage.
 */
/**
 * How long after mount / session-change the chat keeps re-asserting the bottom
 * while follow is engaged, and how often it checks.
 *
 * A page refresh finishes painting long before the layout settles: blocks mount
 * ABOVE the messages (the "Load older" row once `hasOlderHistory` resolves, the
 * loading-older status row, the agent todo list, the tool-chooser banner behind an
 * async preference fetch), and growth above the viewport with `scrollTop` frozen
 * slides the whole log down — the user is left looking at older content. The
 * ResizeObserver cannot see it (it only watches `clientHeight`) and the chat sets
 * `overflow-anchor: none`, so nothing else corrects it.
 *
 * The window has to outlast the slowest of those settles — the `.subsession-bar`
 * max-height transition alone is 200ms and the preference fetch is a network
 * round-trip — while staying short enough that it is unambiguously "the refresh",
 * not an ongoing behaviour that could fight the user later.
 */
export const CHAT_MOUNT_SETTLE_MS = 1_500;
export const CHAT_MOUNT_SETTLE_TICK_MS = 80;

export interface FollowThresholds {
  disengageThreshold: number;
  reengageThreshold: number;
}

export function computeFollowThresholds(clientHeight: number, scrollHeight: number): FollowThresholds {
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  let disengageThreshold = Math.max(180, Math.round(0.25 * clientHeight));
  let reengageThreshold = Math.max(60, Math.round(0.10 * clientHeight));
  if (maxScroll > 0 && disengageThreshold > maxScroll * 0.5) {
    disengageThreshold = Math.max(8, Math.round(maxScroll * 0.5));
    reengageThreshold = Math.max(4, Math.round(maxScroll * 0.2));
  }
  return { disengageThreshold, reengageThreshold };
}
