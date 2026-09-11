import { useEffect, useRef, useState } from 'preact/hooks';

/** How long an armed button waits before giving up and disarming itself. */
export const CONFIRM_BUTTON_TIMEOUT_MS = 4000;

/**
 * A button that asks again, in place, before it does anything.
 *
 * The first click only arms it; the second commits. No modal, because a modal
 * that appears under the cursor is dismissed by the same reflex that caused the
 * misclick, and because these actions sit in a list where a dialog would hide
 * the row you are acting on.
 *
 * It disarms itself after a few seconds. An armed button left sitting there is
 * a trap: you come back to the screen, click what looks like a normal button,
 * and it fires immediately.
 *
 * Deliberately NOT disarmed on blur. That would be a nicety on top of the
 * timeout, and it could not be exercised in this test environment -- the click
 * path updates state there but the blur path never reaches the handler. An
 * untestable safeguard is worse than one less safeguard, because only the first
 * kind can rot without anyone noticing.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = '',
  confirmClassName = 'controlled-nodes-danger-btn',
  disabled = false,
  testId,
  timeoutMs = CONFIRM_BUTTON_TIMEOUT_MS,
  style,
  confirmStyle,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  confirmClassName?: string;
  disabled?: boolean;
  testId?: string;
  timeoutMs?: number;
  style?: preact.JSX.CSSProperties;
  confirmStyle?: preact.JSX.CSSProperties;
}): preact.JSX.Element {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setArmed(false);
  };

  // A pending timer on an unmounted button would disarm a component that is no
  // longer there, and on a re-used one would fire against the wrong action.
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  // Losing the ability to press it must also lose the armed state, or it comes
  // back armed when it is re-enabled.
  useEffect(() => { if (disabled) disarm(); }, [disabled]);

  return (
    <button
      type="button"
      class={`${armed ? confirmClassName : className} ${armed ? 'is-armed' : ''}`.trim()}
      data-testid={testId}
      data-armed={armed ? 'true' : undefined}
      style={armed ? (confirmStyle ?? style) : style}
      disabled={disabled}
      // Announced, not just recoloured: the change from "Remove" to "Sure?" is
      // the entire safeguard, and it must not be visual-only.
      aria-live="polite"
      onClick={() => {
        // jsdom, and any caller dispatching a synthetic click, will deliver one
        // to a disabled button. Guarding here rather than trusting the
        // attribute keeps "disabled" meaning the same thing everywhere.
        if (disabled) return;
        if (!armed) {
          setArmed(true);
          timer.current = setTimeout(() => {
            timer.current = null;
            setArmed(false);
          }, timeoutMs);
          return;
        }
        disarm();
        onConfirm();
      }}
    >{armed ? confirmLabel : label}</button>
  );
}
