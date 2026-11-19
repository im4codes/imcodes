/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isHoverPreviewSuppressed,
  onHoverPreviewSuppressed,
  resetHoverPreviewGateForTests,
  suppressHoverPreviewsUntilPointerMove,
} from '../src/hover-preview-gate.js';

function dispatchMove(type: 'pointermove' | 'mousemove', clientX: number, clientY: number, pointerType?: string) {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY }) as MouseEvent & { pointerType?: string };
  if (pointerType !== undefined) {
    Object.defineProperty(event, 'pointerType', { value: pointerType, configurable: true });
  }
  window.dispatchEvent(event);
}

describe('hover-preview-gate', () => {
  afterEach(() => {
    resetHoverPreviewGateForTests();
  });

  it('suppresses hover previews on shortcut navigation, ignores same-coordinate synthetic moves, and unsuppresses only when pointer coordinates change', () => {
    const onSuppressed = vi.fn();
    const unsub = onHoverPreviewSuppressed(onSuppressed);

    expect(isHoverPreviewSuppressed()).toBe(false);
    dispatchMove('mousemove', 120, 240);

    suppressHoverPreviewsUntilPointerMove();
    expect(isHoverPreviewSuppressed()).toBe(true);
    expect(onSuppressed).toHaveBeenCalledTimes(1);

    // Same-coordinate synthetic moves emitted on DOM swap must keep suppression active.
    dispatchMove('pointermove', 120, 240, 'mouse');
    dispatchMove('mousemove', 120, 240);
    expect(isHoverPreviewSuppressed()).toBe(true);

    // Touch events must never clear or update the desktop hover suppression state.
    dispatchMove('pointermove', 160, 280, 'touch');
    expect(isHoverPreviewSuppressed()).toBe(true);

    // Real pointer movement to a different coordinate restores hover previews.
    dispatchMove('mousemove', 121, 240);
    expect(isHoverPreviewSuppressed()).toBe(false);

    unsub();
    suppressHoverPreviewsUntilPointerMove();
    expect(onSuppressed).toHaveBeenCalledTimes(1);
    expect(isHoverPreviewSuppressed()).toBe(true);
  });

  it('keeps suppression active across repeated shortcuts until a real coordinate change occurs', () => {
    expect(isHoverPreviewSuppressed()).toBe(false);
    suppressHoverPreviewsUntilPointerMove();
    expect(isHoverPreviewSuppressed()).toBe(true);

    // Touch move with no prior mouse position must still keep suppression active.
    dispatchMove('pointermove', 50, 60, 'touch');
    expect(isHoverPreviewSuppressed()).toBe(true);

    // First real pointer move unlocks when no prior mouse position was recorded.
    dispatchMove('pointermove', 50, 60, 'mouse');
    expect(isHoverPreviewSuppressed()).toBe(false);

    // Repeated suppression keeps blocking same-position moves.
    suppressHoverPreviewsUntilPointerMove();
    suppressHoverPreviewsUntilPointerMove();
    dispatchMove('mousemove', 50, 60);
    expect(isHoverPreviewSuppressed()).toBe(true);

    dispatchMove('pointermove', 50, 61, 'mouse');
    expect(isHoverPreviewSuppressed()).toBe(false);
  });
});
