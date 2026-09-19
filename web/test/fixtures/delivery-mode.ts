import { act } from '@testing-library/preact';
import {
  SESSION_SEND_DELIVERY_MODES,
  SESSION_SEND_DELIVERY_USER_PREF_KEY,
} from '../../../shared/session-send-delivery.js';

/**
 * Append is the default composer mode, and a busy-session Append send goes
 * straight into the timeline as an optimistic bubble. Tests that exercise the
 * FIFO queue strip (queue cards, edit/undo/retry of a queued row) must select
 * Queue explicitly -- via the same account-pref change broadcast a real toggle
 * emits -- after rendering and before sending.
 */
export function selectQueueDeliveryMode(): void {
  act(() => {
    window.dispatchEvent(new CustomEvent('imcodes:user-pref-changed', {
      detail: { key: SESSION_SEND_DELIVERY_USER_PREF_KEY, value: SESSION_SEND_DELIVERY_MODES.QUEUE },
    }));
  });
}
