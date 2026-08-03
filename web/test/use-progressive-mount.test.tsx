/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProgressiveMount } from '../src/hooks/useProgressiveMount.js';

/**
 * The point of this hook is that N heavy windows do NOT all mount in one task.
 * If it ever returned the full count on the first render the app would look
 * correct and silently go back to producing one multi-second block, so these
 * tests pin the frame-by-frame growth rather than just the end state.
 */
let frames: Array<() => void> = [];

function flushFrame(): void {
  const pending = frames;
  frames = [];
  act(() => { for (const fn of pending) fn(); });
}

function Probe({ count, seen }: { count: number; seen: number[] }) {
  const budget = useProgressiveMount(count);
  seen.push(budget);
  return <div data-testid="budget">{budget}</div>;
}

describe('useProgressiveMount', () => {
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
      frames.push(fn);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('reveals one item per frame instead of all at once', () => {
    const seen: number[] = [];
    const { getByTestId } = render(<Probe count={4} seen={seen} />);

    // The whole point: the first render must not mount all four.
    expect(getByTestId('budget').textContent).toBe('1');

    flushFrame();
    expect(getByTestId('budget').textContent).toBe('2');
    flushFrame();
    expect(getByTestId('budget').textContent).toBe('3');
    flushFrame();
    expect(getByTestId('budget').textContent).toBe('4');
  });

  it('stops scheduling frames once every item is revealed', () => {
    render(<Probe count={2} seen={[]} />);
    flushFrame();
    expect(frames.length).toBe(0);
  });

  it('never reports more than the current count', () => {
    const seen: number[] = [];
    const { rerender, getByTestId } = render(<Probe count={3} seen={seen} />);
    flushFrame();
    flushFrame();
    expect(getByTestId('budget').textContent).toBe('3');

    // Closing windows must not leave a budget that over-reports the list length,
    // or the caller would slice past the end of its array.
    rerender(<Probe count={1} seen={seen} />);
    expect(getByTestId('budget').textContent).toBe('1');
    expect(Math.max(...seen)).toBeLessThanOrEqual(3);
  });

  it('catches up within one frame when a single item is added later', () => {
    const { rerender, getByTestId } = render(<Probe count={1} seen={[]} />);
    expect(getByTestId('budget').textContent).toBe('1');

    rerender(<Probe count={2} seen={[]} />);
    flushFrame();
    expect(getByTestId('budget').textContent).toBe('2');
  });
});
