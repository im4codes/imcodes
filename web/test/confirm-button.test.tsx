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

  it('fires exactly once for a burst of clicks inside one tick', () => {
    // `armed` state is not readable again until the component re-renders, and
    // preact defers that past the current task. A real double-click (or any two
    // clicks in one batch) therefore reaches the handler twice while `armed` is
    // still false, so a state-only guard re-arms on the second click instead of
    // confirming: the user's second press is silently swallowed. Dispatched raw
    // and without an intervening act() so no flush hides the batch.
    const { button, onConfirm } = renderButton();
    const target = button();
    act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onConfirm, 'the second press in a burst must confirm, exactly once').toHaveBeenCalledTimes(1);
  });

  it('does not fire again for a third click in the same burst', () => {
    // The other edge of exactly-once: a burst longer than two must not confirm
    // twice. The third click re-arms, it does not re-confirm.
    const { button, onConfirm } = renderButton();
    const target = button();
    act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
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

  it('disarms on an outside click or Escape', () => {
    const { button, onConfirm } = renderButton();
    fireEvent.click(button());
    fireEvent.click(document.body);
    expect(button().textContent).toBe('Remove');

    fireEvent.click(button());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(button().textContent).toBe('Remove');

    fireEvent.click(button());
    expect(onConfirm, 'both cancellation paths must make the next click arm again').not.toHaveBeenCalled();
  });

  it('disarms when its caller changes the action context', () => {
    const onConfirm = vi.fn();
    const { container, rerender } = render(
      <ConfirmButton label="Remove" confirmLabel="Sure?" onConfirm={onConfirm} testId="confirm" resetKey="row-a" />,
    );
    const button = () => container.querySelector('[data-testid="confirm"]') as HTMLButtonElement;
    fireEvent.click(button());
    expect(button().textContent).toBe('Sure?');

    rerender(
      <ConfirmButton label="Remove" confirmLabel="Sure?" onConfirm={onConfirm} testId="confirm" resetKey="row-b" />,
    );
    expect(button().textContent).toBe('Remove');
    fireEvent.click(button());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('owns Escape only while armed, and hands it back afterwards', () => {
    // The listeners are document-level and capture-phase, so this changes Escape
    // for the whole app, not just this button -- and ConfirmButton already has
    // six other live instances (five in TeamManagementPanel, one in
    // P2pChainStatus) whose Escape previously always passed through. Pin both
    // halves: armed consumes the key so a parent shortcut cannot cancel or
    // append the very action being backed out of, and once disarmed the key is
    // immediately a parent concern again.
    const parentEscape = vi.fn();
    document.addEventListener('keydown', parentEscape);
    try {
      const { button, onConfirm } = renderButton();

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(parentEscape, 'an idle button must not intercept Escape').toHaveBeenCalledTimes(1);

      fireEvent.click(button());
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(button().textContent, 'Escape disarms').toBe('Remove');
      expect(parentEscape, 'while armed the key stops here').toHaveBeenCalledTimes(1);

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(parentEscape, 'once disarmed Escape belongs to the parent again').toHaveBeenCalledTimes(2);
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', parentEscape);
    }
  });

  it('leaves other keys alone while armed', () => {
    const parentKeys = vi.fn();
    document.addEventListener('keydown', parentKeys);
    try {
      const { button } = renderButton();
      fireEvent.click(button());
      fireEvent.keyDown(document, { key: 'Enter' });
      fireEvent.keyDown(document, { key: 'a' });
      expect(parentKeys, 'only Escape is claimed').toHaveBeenCalledTimes(2);
      expect(button().textContent, 'unrelated keys must not disarm').toBe('Sure?');
    } finally {
      document.removeEventListener('keydown', parentKeys);
    }
  });

  it('cannot be armed at all while disabled', () => {
    const { button, onConfirm } = renderButton({ disabled: true });
    fireEvent.click(button());
    fireEvent.click(button());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
