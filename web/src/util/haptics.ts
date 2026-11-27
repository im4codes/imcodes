import * as VoiceInput from '../components/VoiceInput.js';
import type { HapticFeedbackStyle } from '../voice-recognition-backend.js';

const touchHapticsByDoc = new WeakMap<Document, Set<number>>();
const touchHapticsFallback = new Set<number>();

function getTouchHapticSet(doc?: Document): Set<number> {
  const resolved = doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!resolved) return touchHapticsFallback;
  let set = touchHapticsByDoc.get(resolved);
  if (!set) {
    set = new Set<number>();
    touchHapticsByDoc.set(resolved, set);
  }
  return set;
}

/** Record that a touch identifier already emitted long-press haptic feedback in this document. */
export function markTouchHapticTriggered(doc: Document | undefined, touchId: number | null | undefined): void {
  if (typeof touchId !== 'number') return;
  getTouchHapticSet(doc).add(touchId);
}

/** Check whether a touch identifier already emitted long-press haptic feedback in this document. */
export function hasTouchHapticTriggered(doc: Document | undefined, touchId: number | null | undefined): boolean {
  if (typeof touchId !== 'number') return false;
  return getTouchHapticSet(doc).has(touchId);
}

/** Clear recorded haptic feedback state when a touch sequence ends or cancels. */
export function clearTouchHapticTriggered(doc: Document | undefined, touchId: number | null | undefined): void {
  if (typeof touchId !== 'number') return;
  getTouchHapticSet(doc).delete(touchId);
}

/** Trigger cross-platform tactile feedback with safe fallback for partial mocks and environments without vibrate. */
export function triggerHaptic(
  style: HapticFeedbackStyle = 'medium',
  durationMs = style === 'light' ? 10 : 20,
): void {
  if (Object.prototype.hasOwnProperty.call(VoiceInput, 'triggerHapticFeedback')) {
    const fn = (VoiceInput as {
      triggerHapticFeedback?: (ms?: number, style?: HapticFeedbackStyle) => Promise<void>;
    }).triggerHapticFeedback;
    if (typeof fn === 'function') {
      void fn(durationMs, style);
      return;
    }
  }
  try {
    globalThis.navigator?.vibrate?.(durationMs);
  } catch {
    /* ignore */
  }
}
