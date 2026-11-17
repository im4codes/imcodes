export interface MobileKeyboardState {
  kbOpen: boolean;
  hideInputUi: boolean;
  hadKeyboardOpen: boolean;
}

export function getMobileKeyboardState(inputFocused: boolean, shrink: number, hadKeyboardOpen: boolean): MobileKeyboardState {
  const kbOpen = shrink > 40 || (inputFocused && shrink > 15);
  const nextHadKeyboardOpen = inputFocused ? (hadKeyboardOpen || kbOpen) : false;
  const hideInputUi = inputFocused && (!nextHadKeyboardOpen || kbOpen);
  return {
    kbOpen,
    hideInputUi,
    hadKeyboardOpen: nextHadKeyboardOpen,
  };
}

const MOBILE_KEYBOARD_INPUT_TAGS = new Set(['INPUT', 'TEXTAREA']);

/** Returns true when `el` is a text/IME or terminal keyboard input target. */
export function isMobileKeyboardInputTarget(el: Element | null): boolean {
  if (!el) return false;
  return MOBILE_KEYBOARD_INPUT_TAGS.has(el.tagName)
    || el.getAttribute('contenteditable') === 'true'
    || el.classList.contains('xterm-helper-textarea');
}

/** Returns true when `el` is a keyboard input hosted inside `.subcard-bar`. */
export function isSubSessionBarInputTarget(el: Element | null): boolean {
  return isMobileKeyboardInputTarget(el) && !!el?.closest('.subcard-bar');
}

/**
 * Returns true when `.subcard-bar` should yield mobile viewport height to a
 * focused external input (e.g. main-session or floating SubSessionWindow),
 * never when focus resides inside `.subcard-bar` itself.
 */
export function shouldSuppressSubSessionBarForKeyboard(doc: Document = document): boolean {
  const root = doc.documentElement;
  if (root.classList.contains('subcard-input-focused')) return false;
  if (doc.activeElement?.closest('.subcard-bar')) return false;
  try {
    if (doc.querySelector('.subcard-bar:focus-within')) return false;
  } catch { /* ignore selector engine quirks */ }
  return root.classList.contains('kb-open') || root.classList.contains('input-focused');
}
