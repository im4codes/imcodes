/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIRM_BUTTON_TIMEOUT_MS, ConfirmButton } from '../src/components/ConfirmButton.js';

afterEach(cleanup);

function renderButton(over: Partial<Parameters<typeof ConfirmButton>[0]> = {}) {
  const onConfirm = vi.fn();
  const result = render(
    <ConfirmButton
      label="Remove"
      confirmLabel="Sure?"
      onConfirm={onConfirm}
      testId="confirm"
      {...over}
    />,
  );
  // Re-queried on every use: holding one reference across a re-render is how a
  // test ends up asserting against a node the component has already replaced.
  const button = () => result.container.querySelector('[data-testid="confirm"]') as HTMLButtonElement;
  return { ...result, button, onConfirm };
}

describe('ConfirmButton', () => {
  it('does nothing on the first click, and acts on the second', () => {
    const { button, onConfirm } = renderButton();
    expect(button().textContent).toBe('Remove');

    fireEvent.click(button());
    expect(onConfirm, 'the first click is the safeguard, not the action').not.toHaveBeenCalled();
    expect(button().textContent).toBe('Sure?');
    expect(button().getAttribute('data-armed')).toBe('true');

    fireEvent.click(button());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // Back to its resting state, so a third click cannot fire it again.
    expect(button().textContent).toBe('Remove');
    expect(button().getAttribute('data-armed')).toBeNull();
  });

  it('disarms itself after a few seconds', () => {
    // An armed button left sitting there is a trap: you come back, click what
    // looks like a normal button, and it fires immediately.
    vi.useFakeTimers();
    try {
      const { button, onConfirm } = renderButton();
      fireEvent.click(button());
      expect(button().textContent).toBe('Sure?');

      act(() => { vi.advanceTimersByTime(CONFIRM_BUTTON_TIMEOUT_MS + 1); });
      expect(button().textContent).toBe('Remove');

      fireEvent.click(button());
      expect(onConfirm, 'a disarmed button starts over').not.toHaveBeenCalled();
    } finally {
      // Drain before restoring. Preact schedules its re-render flush on a timer;
      // swapping back to real ones with that still pending discards it, and the
      // NEXT test in this file then never re-renders on setState -- which looks
      // exactly like the component being broken.
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('disarms when it becomes disabled, so it does not come back armed', () => {
    const onConfirm = vi.fn();
    const { container, rerender } = render(
      <ConfirmButton label="Remove" confirmLabel="Sure?" onConfirm={onConfirm} testId="confirm" />,
    );
    const button = () => container.querySelector('[data-testid="confirm"]') as HTMLButtonElement;
    fireEvent.click(button());
    expect(button().textContent).toBe('Sure?');

    rerender(
      <ConfirmButton label="Remove" confirmLabel="Sure?" onConfirm={onConfirm} testId="confirm" disabled />,
    );
    rerender(
      <ConfirmButton label="Remove" confirmLabel="Sure?" onConfirm={onConfirm} testId="confirm" />,
    );
    expect(button().textContent, 'being re-enabled must not restore the armed state').toBe('Remove');
  });

  it('cannot be armed at all while disabled', () => {
    const { button, onConfirm } = renderButton({ disabled: true });
    fireEvent.click(button());
    fireEvent.click(button());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
