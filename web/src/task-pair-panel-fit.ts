/**
 * Fit the expanded mobile task-status panel into the VISIBLE chat area.
 *
 * The panel is absolutely positioned under the chat titlebar and clipped by
 * `.chat-main` (overflow: hidden). A fixed `65vh` / `100dvh - 160px` height
 * ignores everything stacked below the chat on a phone (context progress bar,
 * agent row, composer, sub-session bar) and the software keyboard, so the
 * panel's lower part was clipped away together with the rows the user could
 * not scroll to. Instead the space really available -- from the panel's top to
 * the bottom of `.chat-main`, capped by the visual viewport -- is measured and
 * published as a CSS variable the stylesheet uses as `max-height`; the rows
 * list (the only scroll container) then scrolls inside it.
 */

/** CSS custom property read by `.task-pair-status-panel.is-mobile` in styles.css. */
export const TASK_PAIR_PANEL_MAX_HEIGHT_VAR = '--task-pair-panel-max-h';

/** Gap kept between the panel's bottom edge and the visible bottom. */
export const TASK_PAIR_PANEL_BOTTOM_GAP_PX = 8;

/**
 * Below this height the header plus a sliver of a card is all that would show
 * (landscape phone, keyboard open): present the collapsed strip instead, which
 * always fits, rather than a panel whose rows cannot be read.
 */
export const TASK_PAIR_PANEL_MIN_USABLE_PX = 96;

export interface TaskPairPanelSpace {
  /** Top of the panel: the titlebar's bottom plus its offset. */
  panelTop: number;
  /** Bottom of the clipping `.chat-main`. */
  hostBottom: number;
  /** Bottom of the visual viewport (keyboard excluded). */
  viewportBottom: number;
}

export interface TaskPairPanelFit {
  maxHeight: number;
  /** True when too little room is left to show the panel usefully. */
  cramped: boolean;
}

export function computeTaskPairPanelFit(space: TaskPairPanelSpace): TaskPairPanelFit {
  const limit = Math.min(space.hostBottom, space.viewportBottom);
  const available = Math.floor(limit - space.panelTop - TASK_PAIR_PANEL_BOTTOM_GAP_PX);
  return {
    maxHeight: Math.max(0, available),
    cramped: !Number.isFinite(available) || available < TASK_PAIR_PANEL_MIN_USABLE_PX,
  };
}

/**
 * Where the expanded panel starts. Mirrors the stylesheet: under the chat
 * titlebar `top: max(calc(100% + 4px), 40px)`; directly in `.chat-main` (no
 * titlebar anchor) `top: 40px`.
 */
function measurePanelTop(parent: Element, host: Element): number {
  const rect = parent.getBoundingClientRect();
  if (!parent.classList.contains('chat-titlebar')) return host.getBoundingClientRect().top + 40;
  return Math.max(rect.bottom + 4, rect.top + 40);
}

/**
 * Keep `panel`'s bound current for as long as it is mounted. `panel`'s parent
 * (the titlebar) and its `.chat-main` are observed; window and visual-viewport
 * changes (rotation, keyboard) re-measure too. Returns the cleanup.
 */
export function bindTaskPairPanelFit(panel: HTMLElement, onCramped: (cramped: boolean) => void): () => void {
  const titlebar = panel.parentElement;
  const host = panel.closest('.chat-main');
  if (!titlebar || !host) {
    onCramped(false);
    return () => undefined;
  }
  let frame = 0;
  const apply = () => {
    frame = 0;
    const viewport = window.visualViewport;
    const hostRect = host.getBoundingClientRect();
    if (hostRect.width === 0 && hostRect.height === 0) {
      // Not laid out (hidden tab, detached subtree): nothing to measure, so keep
      // the stylesheet fallback rather than collapsing on a bogus zero.
      panel.style.removeProperty(TASK_PAIR_PANEL_MAX_HEIGHT_VAR);
      onCramped(false);
      return;
    }
    const fit = computeTaskPairPanelFit({
      panelTop: measurePanelTop(titlebar, host),
      hostBottom: hostRect.bottom,
      viewportBottom: viewport ? viewport.offsetTop + viewport.height : window.innerHeight,
    });
    panel.style.setProperty(TASK_PAIR_PANEL_MAX_HEIGHT_VAR, `${fit.maxHeight}px`);
    onCramped(fit.cramped);
  };
  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(apply);
  };
  apply();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  observer?.observe(host);
  observer?.observe(titlebar);
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  return () => {
    if (frame) window.cancelAnimationFrame(frame);
    observer?.disconnect();
    window.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
    panel.style.removeProperty(TASK_PAIR_PANEL_MAX_HEIGHT_VAR);
  };
}
