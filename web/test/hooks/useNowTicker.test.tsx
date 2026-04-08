/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { h } from 'preact';
import { render, screen, cleanup, act } from '@testing-library/preact';
import { useNowTicker } from '../../src/hooks/useNowTicker.js';

function TickerProbe({ label, active }: { label: string; active: boolean }) {
  const now = useNowTicker(active);
  return <div data-testid={label}>{String(now)}</div>;
}

describe('useNowTicker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-08T00:00:00.000Z'));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shares one interval across multiple active subscribers and clears it after unmount', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const { unmount } = render(
      <>
        <TickerProbe label="first" active={true} />
        <TickerProbe label="second" active={true} />
      </>,
    );

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    const firstBefore = screen.getByTestId('first').textContent;
    const secondBefore = screen.getByTestId('second').textContent;

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByTestId('first').textContent).not.toBe(firstBefore);
    expect(screen.getByTestId('second').textContent).not.toBe(secondBefore);

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('does not start the shared interval for inactive subscribers', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    render(<TickerProbe label="idle" active={false} />);

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
