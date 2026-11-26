export interface MobileKeyboardState {
  kbOpen: boolean;
  hideInputUi: boolean;
  hadKeyboardOpen: boolean;
}

const MIN_LAYOUT_ONLY_KEYBOARD_SHRINK_PX = 120;

export interface MobileKeyboardShrinkMeasurement {
  baselineHeight: number;
  shrink: number;
  layoutVsVisualShrink: number;
}

/**
 * Computes mobile keyboard shrink against the pre-focus viewport baseline so
 * Android `adjustResize` / IME bottom-margin resizing (`window.innerHeight`
 * shrinking to match `visualViewport.height`) does not collapse `shrink` back
 * to 0 while the keyboard is still open, while keeping `layoutVsVisualShrink`
 * separate for `position: fixed` `--kbh` offsets.
 */
export function measureMobileKeyboardShrink(params: {
  inputFocused: boolean;
  layoutHeight: number;
  visualHeight: number;
  baselineHeight: number;
  hadKeyboardOpen?: boolean;
}): MobileKeyboardShrinkMeasurement {
  const layout = Number.isFinite(params.layoutHeight) && params.layoutHeight > 0 ? params.layoutHeight : 0;
  const visual = Number.isFinite(params.visualHeight) && params.visualHeight > 0 ? params.visualHeight : layout;
  const maxObserved = Math.max(layout, visual);
  const effectiveHeight = Math.min(layout, visual);
  const layoutVsVisualShrink = Math.max(0, layout - visual);

  if (!params.inputFocused) {
    return {
      baselineHeight: maxObserved,
      shrink: layoutVsVisualShrink,
      layoutVsVisualShrink,
    };
  }

  // Freeze baselineHeight while focused so iOS Safari URL-bar collapse/restore
  // (e.g. 760/760 -> 810/460 -> 760/760) cannot ratchet baselineHeight up and
  // leave kbOpen stuck true after dismissal.
  const baselineHeight = params.baselineHeight > 0
    ? params.baselineHeight
    : maxObserved;
  const baselineShrink = Math.max(0, baselineHeight - effectiveHeight);
  // Ignore modest synchronous layout+visual shifts (e.g. mobile browser chrome
  // show/hide ~44-80px) before a keyboard has been observed open, while keeping
  // full sensitivity once layoutVsVisualShrink > 15, hadKeyboardOpen is true,
  // or Android adjustResize shrinks the layout viewport by >= 120px.
  const qualifiedBaselineShrink = layoutVsVisualShrink > 15
    || params.hadKeyboardOpen
    || baselineShrink >= MIN_LAYOUT_ONLY_KEYBOARD_SHRINK_PX
    ? baselineShrink
    : 0;
  const shrink = Math.max(layoutVsVisualShrink, qualifiedBaselineShrink);

  return {
    baselineHeight,
    shrink,
    layoutVsVisualShrink,
  };
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

/**
 * Returns true when a large viewport width jump (e.g. foldable fold/unfold or
 * orientation transition >= 80px) happens while no keyboard input holds focus,
 * so stale `.kb-open` / `.input-focused` classes are cleared cleanly.
 */
export function shouldResetMobileKeyboardOnWidthTransition(
  prevWidth: number,
  nextWidth: number,
  activeElement: Element | null,
): boolean {
  return Math.abs(nextWidth - prevWidth) >= 80 && !isMobileKeyboardInputTarget(activeElement);
}

const KEYBOARD_DISMISS_EXEMPT_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[contenteditable="plaintext-only"]',
  'button',
  'a',
  'label',
  'summary',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="listbox"]',
  '[role="link"]',
  '.controls',
  '.controls-slash-picker',
  '.controls-alias-picker',
  '.controls-machine-picker',
  '.controls-task-pair-picker',
  '.controls-cloud-doc-picker',
  '.at-picker',
  '.qp',
  '.ask-option',
  '.ask-question-timeline-card-interactive',
  '.chat-sel-menu',
  '.chat-ctx-menu',
  '.chat-path-link',
  '.voice-overlay',
  '.remote-desktop-stage',
  '.remote-desktop-mobile-keyboard',
  '.subcard-input-area',
  '.subcard-input-wrap',
  '.xterm',
].join(', ');

const TAP_DISMISS_MAX_MOVE_PX = 10;
const TAP_DISMISS_MAX_DURATION_MS = 350;

function asElementTarget(target: EventTarget | null): Element | null {
  if (!target) return null;
  if ('closest' in target && typeof (target as Element).closest === 'function') {
    return target as Element;
  }
  if ('parentElement' in target) {
    return (target as Node).parentElement;
  }
  return null;
}

function hasExpandedNativeTextSelection(activeElement: Element | null): boolean {
  if (!activeElement) return false;
  const tag = activeElement.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
  try {
    const inputEl = activeElement as HTMLInputElement | HTMLTextAreaElement;
    if (typeof inputEl.selectionStart === 'number' && typeof inputEl.selectionEnd === 'number') {
      return inputEl.selectionStart !== inputEl.selectionEnd;
    }
  } catch {
    // Input types without text selection ranges (e.g. email/number/date/checkbox) fall back cleanly.
  }
  return false;
}

/**
 * Returns true when neither the focused input/textarea nor the document Selection
 * holds an expanded (non-collapsed) text selection.
 */
export function isMobileKeyboardSelectionCollapsed(
  activeElement: Element | null,
  doc?: Pick<Document, 'getSelection'> | null,
): boolean {
  if (hasExpandedNativeTextSelection(activeElement)) return false;
  const sel = doc?.getSelection?.();
  return sel ? sel.isCollapsed : true;
}

/**
 * Returns true when a mobile tap landed on blank / non-interactive space while a
 * keyboard input holds focus and no text selection is active, so tapping outside
 * the composer/pickers/buttons dismisses the soft keyboard immediately.
 */
export function shouldDismissMobileKeyboardOnTap(
  target: Element | null,
  activeElement: Element | null,
  selectionCollapsed = isMobileKeyboardSelectionCollapsed(activeElement, target?.ownerDocument),
): boolean {
  if (!isMobileKeyboardInputTarget(activeElement)) return false;
  if (selectionCollapsed === false || hasExpandedNativeTextSelection(activeElement)) return false;
  if (!target || activeElement?.contains(target)) return false;
  if (target.closest(KEYBOARD_DISMISS_EXEMPT_SELECTOR)) return false;
  return true;
}

/**
 * Installs passive document touch listeners that blur the focused mobile
 * keyboard target after a short single-finger tap on blank/reading space,
 * canceling on consumed events, scroll drags (>10px), multi-touch,
 * long-press (>350ms), or non-collapsed text selections.
 */
export function installMobileKeyboardTapDismiss(doc: Document = document): () => void {
  let armed: { x: number; y: number; time: number; target: Element } | null = null;

  const onTouchStart = (e: TouchEvent) => {
    if (e.defaultPrevented || e.touches.length !== 1) {
      armed = null;
      return;
    }
    const target = asElementTarget(e.target);
    const active = doc.activeElement;
    if (!shouldDismissMobileKeyboardOnTap(target, active, isMobileKeyboardSelectionCollapsed(active, doc))) {
      armed = null;
      return;
    }
    const touch = e.touches[0]!;
    armed = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
      target: target!,
    };
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!armed) return;
    if (e.touches.length !== 1) {
      armed = null;
      return;
    }
    const touch = e.touches[0]!;
    if (Math.hypot(touch.clientX - armed.x, touch.clientY - armed.y) > TAP_DISMISS_MAX_MOVE_PX) {
      armed = null;
    }
  };

  const onTouchCancel = () => {
    armed = null;
  };

  const onTouchEnd = (e: TouchEvent) => {
    const start = armed;
    armed = null;
    if (!start || e.defaultPrevented) return;
    if (Date.now() - start.time > TAP_DISMISS_MAX_DURATION_MS) return;
    const endTouch = e.changedTouches[0];
    if (endTouch && Math.hypot(endTouch.clientX - start.x, endTouch.clientY - start.y) > TAP_DISMISS_MAX_MOVE_PX) {
      return;
    }
    const active = doc.activeElement;
    if (!shouldDismissMobileKeyboardOnTap(start.target, active, isMobileKeyboardSelectionCollapsed(active, doc))) return;
    if (typeof (active as HTMLElement).blur === 'function') {
      (active as HTMLElement).blur();
    }
  };

  doc.addEventListener('touchstart', onTouchStart, { passive: true });
  doc.addEventListener('touchmove', onTouchMove, { passive: true });
  doc.addEventListener('touchend', onTouchEnd, { passive: true });
  doc.addEventListener('touchcancel', onTouchCancel, { passive: true });

  return () => {
    armed = null;
    doc.removeEventListener('touchstart', onTouchStart);
    doc.removeEventListener('touchmove', onTouchMove);
    doc.removeEventListener('touchend', onTouchEnd);
    doc.removeEventListener('touchcancel', onTouchCancel);
  };
}
