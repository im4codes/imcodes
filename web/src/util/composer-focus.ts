export interface FocusComposerOptions {
  /** Place the caret at the end of the composer's text after focusing. */
  moveCursorToEnd?: boolean;
}

type ComposerFocusHandler = (options?: FocusComposerOptions) => boolean;

const composerFocusHandlers = new WeakMap<HTMLElement, ComposerFocusHandler>();

/**
 * Register a component-owned focus/enter-typing handler for a composer element
 * so external `inputRef` callers can transition out of non-editable touch-lock
 * states before focusing.
 */
export function registerComposerFocusHandler(
  el: HTMLElement | null,
  handler: ComposerFocusHandler,
): () => void {
  if (!el) return () => {};
  composerFocusHandlers.set(el, handler);
  return () => {
    if (composerFocusHandlers.get(el) === handler) {
      composerFocusHandlers.delete(el);
    }
  };
}

/** Collapse selection to the end of `el` when the Selection API is available. */
export function moveCaretToEnd(el: HTMLElement): void {
  try {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch { /* ignore jsdom or detached node selection failures */ }
}

/**
 * Intentionally enter typing mode and focus a composer element, delegating to
 * any registered SessionControls lock-release handler first.
 */
export function focusComposerElement(
  el: HTMLElement | null | undefined,
  options?: FocusComposerOptions,
): boolean {
  if (!el) return false;
  const registered = composerFocusHandlers.get(el);
  if (registered) {
    return registered(options);
  }
  if (el.classList.contains('controls-input-disabled')) {
    return false;
  }
  if (el.getAttribute('contenteditable') !== 'true') {
    el.setAttribute('contenteditable', 'true');
  }
  el.focus();
  if (options?.moveCursorToEnd) {
    moveCaretToEnd(el);
  }
  return document.activeElement === el;
}
