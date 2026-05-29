import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

/**
 * Standard xterm arrow-key escape sequences. These are intentionally the
 * "normal cursor keys" form (CSI). The daemon's `sendRawInput`
 * (`src/agent/tmux.ts`) maps each one to a tmux key NAME via `XTERM_KEY_MAP`
 * (`\x1b[A` → `Up`, `\x1b[D` → `Left`, …), then runs `tmux send-keys Up`.
 * tmux re-emits the app-correct sequence per the focused app's
 * application-cursor-keys mode (DECCKM) — e.g. `\x1bOA` for ncdu / vim /
 * less / fzf / htop, `\x1b[A` for a plain shell. So the D-pad inherits the
 * exact same TUI-aware handling as the desktop ↑/↓ buttons simply by
 * sending these standard sequences down the same `ws.sendInput` path. Left
 * and Right are already in `XTERM_KEY_MAP`, so no daemon change is needed.
 */
export const DPAD_ARROW_SEQUENCES = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
} as const;

type DpadDirection = keyof typeof DPAD_ARROW_SEQUENCES;

/** Drag distance (px) before a direction registers — avoids accidental taps firing a key. */
const DEADZONE_PX = 8;
/** Delay before auto-repeat starts while a direction is held (matches keyboard repeat feel). */
const REPEAT_DELAY_MS = 400;
/** Interval between auto-repeat fires while a direction is held. */
const REPEAT_INTERVAL_MS = 110;

export interface MobileDpadProps {
  /** Called with the standard arrow escape sequence for the dragged direction. */
  onDirection: (sequence: string) => void;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
}

/**
 * Mobile-only directional pad. Replaces the separate ↑/↓ shortcut buttons on
 * small screens with a single control: press and drag toward a direction to
 * send that arrow key (up/down/left/right). Holding a direction auto-repeats
 * (useful for scrolling lists in ncdu/less/etc.); dragging back through the
 * center re-arms so a wiggle fires again. Desktop keeps the discrete buttons.
 */
export function MobileDpad({ onDirection, disabled, title, ariaLabel }: MobileDpadProps) {
  const [activeDir, setActiveDir] = useState<DpadDirection | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const pointerRef = useRef<number | null>(null);
  const dirRef = useRef<DpadDirection | null>(null);
  const repeatRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRepeat = useCallback(() => {
    if (repeatRef.current) {
      clearTimeout(repeatRef.current);
      repeatRef.current = null;
    }
  }, []);

  const scheduleRepeat = useCallback((delay: number) => {
    clearRepeat();
    repeatRef.current = setTimeout(() => {
      const dir = dirRef.current;
      if (!dir) return;
      onDirection(DPAD_ARROW_SEQUENCES[dir]);
      scheduleRepeat(REPEAT_INTERVAL_MS);
    }, delay);
  }, [clearRepeat, onDirection]);

  const fireDirection = useCallback((dir: DpadDirection) => {
    dirRef.current = dir;
    setActiveDir(dir);
    onDirection(DPAD_ARROW_SEQUENCES[dir]);
    scheduleRepeat(REPEAT_DELAY_MS);
  }, [onDirection, scheduleRepeat]);

  const recenter = useCallback(() => {
    clearRepeat();
    dirRef.current = null;
    setActiveDir(null);
  }, [clearRepeat]);

  const handlePointerDown = useCallback((e: PointerEvent) => {
    if (disabled) return;
    if (pointerRef.current !== null) return;
    pointerRef.current = e.pointerId;
    originRef.current = { x: e.clientX, y: e.clientY };
    dirRef.current = null;
    setActiveDir(null);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* setPointerCapture unsupported (or jsdom) — drag still tracked via move events */
    }
    e.preventDefault();
  }, [disabled]);

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (pointerRef.current !== e.pointerId) return;
    const origin = originRef.current;
    if (!origin) return;
    const dx = e.clientX - origin.x;
    const dy = e.clientY - origin.y;
    if (Math.hypot(dx, dy) < DEADZONE_PX) {
      // Returned to center — re-arm so dragging out again fires the next key.
      if (dirRef.current !== null) recenter();
      return;
    }
    const dir: DpadDirection = Math.abs(dx) >= Math.abs(dy)
      ? (dx > 0 ? 'right' : 'left')
      : (dy > 0 ? 'down' : 'up');
    if (dir !== dirRef.current) fireDirection(dir);
    e.preventDefault();
  }, [fireDirection, recenter]);

  const handlePointerEnd = useCallback((e: PointerEvent) => {
    if (pointerRef.current !== e.pointerId) return;
    pointerRef.current = null;
    originRef.current = null;
    recenter();
  }, [recenter]);

  // Stop the auto-repeat timer if the pad unmounts mid-drag (e.g. layout
  // switch to desktop, or session change) so it can't fire after teardown.
  useEffect(() => clearRepeat, [clearRepeat]);

  return (
    <div
      class={`shortcut-btn shortcut-dpad${activeDir ? ` shortcut-dpad-active dpad-dir-${activeDir}` : ''}`}
      role="button"
      aria-label={ariaLabel ?? title}
      title={title}
      aria-disabled={disabled ? 'true' : undefined}
      data-disabled={disabled ? 'true' : undefined}
      data-active-dir={activeDir ?? undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={handlePointerEnd}
    >
      <span class="dpad-arrow dpad-arrow-up" aria-hidden="true">▲</span>
      <span class="dpad-arrow dpad-arrow-left" aria-hidden="true">◀</span>
      <span class="dpad-arrow dpad-arrow-right" aria-hidden="true">▶</span>
      <span class="dpad-arrow dpad-arrow-down" aria-hidden="true">▼</span>
    </div>
  );
}
