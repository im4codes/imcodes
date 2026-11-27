import * as VoiceInput from '../components/VoiceInput.js';
import type { HapticFeedbackStyle } from '../voice-recognition-backend.js';

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
