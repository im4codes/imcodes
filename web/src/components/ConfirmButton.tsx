import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

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
 * It disarms on an explicit outside click/tap or Escape rather than blur.
 * Blur also fires while keyboard users move focus for unrelated reasons and is
 * not a reliable expression of cancellation; pointer/Escape are deterministic
 * in both the browser and the component tests.
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
  resetKey,
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
  /** Any change invalidates a confirmation that was armed for older context. */
  resetKey?: string | number;
  style?: preact.JSX.CSSProperties;
  confirmStyle?: preact.JSX.CSSProperties;
}): preact.JSX.Element {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const armedRef = useRef(false);
  armedRef.current = armed;

  const disarm = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    armedRef.current = false;
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

  // A confirmation belongs to the exact action context in which it was
  // armed. Callers use this for target or content changes that would otherwise
  // turn the second click into approval of a different action.
  useLayoutEffect(() => { if (armed) disarm(); }, [resetKey]);

  useLayoutEffect(() => {
    const onOutsideClick = (event: MouseEvent): void => {
      if (!armedRef.current) return;
      if (!buttonRef.current?.contains(event.target as Node)) disarm();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!armedRef.current || event.key !== 'Escape') return;
      // While armed, this control owns Escape. Letting the event reach a parent
      // shortcut can cancel/append the very queue action the user is trying to
      // back out of.
      event.preventDefault();
      event.stopPropagation();
      disarm();
    };
    document.addEventListener('click', onOutsideClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('click', onOutsideClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  return (
    <button
      ref={buttonRef}
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
        if (!armedRef.current) {
          armedRef.current = true;
          setArmed(true);
          timer.current = setTimeout(() => {
            timer.current = null;
            armedRef.current = false;
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
