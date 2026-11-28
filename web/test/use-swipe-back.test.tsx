/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const streamingApi = vi.hoisted(() => ({
  available: vi.fn(),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  addListener: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  performHaptic: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({ registerPlugin: vi.fn(() => streamingApi) }));

vi.mock('@capgo/capacitor-speech-recognition', () => ({
  SpeechRecognition: {},
}));

vi.mock('../src/screen-awake.js', () => ({
  holdScreenAwake: () => () => {},
}));

import { useSwipeBack } from '../src/hooks/useSwipeBack.js';

function TestSwipeBackSurface({ onBack }: { onBack?: (() => void) | null }) {
  const ref = useSwipeBack(onBack);
  return <div ref={ref} data-testid="swipe-back-surface" />;
}

interface TouchInitPoint {
  identifier?: number;
  clientX: number;
  clientY: number;
}

function dispatchTouch(
  target: EventTarget,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: TouchInitPoint[],
  changedTouches: TouchInitPoint[] = touches,
): void {
  const evt = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    touches: TouchInitPoint[];
    changedTouches: TouchInitPoint[];
  };
  Object.defineProperty(evt, 'touches', { configurable: true, value: touches });
  Object.defineProperty(evt, 'changedTouches', { configurable: true, value: changedTouches });
  target.dispatchEvent(evt);
}

describe('useSwipeBack haptics and edge lifecycle', () => {
  const origCap = (globalThis as { Capacitor?: unknown }).Capacitor;
  const origVibrateDesc = Object.getOwnPropertyDescriptor(navigator, 'vibrate');

  beforeEach(() => {
    vi.useFakeTimers();
    streamingApi.performHaptic.mockReset().mockResolvedValue(undefined);
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    (globalThis as { Capacitor?: unknown }).Capacitor = origCap;
    if (origVibrateDesc) Object.defineProperty(navigator, 'vibrate', origVibrateDesc);
    else delete (navigator as unknown as Record<string, unknown>).vibrate;
    document.body.innerHTML = '';
  });

  it('emits medium on threshold arm, light on pull-back disarm, and success on back commit without repeats', () => {
    const onBack = vi.fn();
    const { getByTestId } = render(<TestSwipeBackSurface onBack={onBack} />);
    const el = getByTestId('swipe-back-surface');

    dispatchTouch(el, 'touchstart', [{ identifier: 1, clientX: 10, clientY: 200 }]);
    dispatchTouch(el, 'touchmove', [{ identifier: 1, clientX: 60, clientY: 200 }]); // dx=50 (<80)
    expect(streamingApi.performHaptic).not.toHaveBeenCalled();

    // Cross 80px threshold -> medium once; staying >=80px does not repeat
    dispatchTouch(el, 'touchmove', [{ identifier: 1, clientX: 95, clientY: 200 }]); // dx=85
    dispatchTouch(el, 'touchmove', [{ identifier: 1, clientX: 120, clientY: 200 }]); // dx=110
    expect(streamingApi.performHaptic.mock.calls).toEqual([[{ style: 'medium' }]]);

    // Pull back below 80px -> light once; staying <80px does not repeat
    dispatchTouch(el, 'touchmove', [{ identifier: 1, clientX: 65, clientY: 200 }]); // dx=55
    dispatchTouch(el, 'touchmove', [{ identifier: 1, clientX: 45, clientY: 200 }]); // dx=35
    expect(streamingApi.performHaptic.mock.calls).toEqual([
      [{ style: 'medium' }],
      [{ style: 'light' }],
    ]);

    // Re-arm past 80px -> medium, then release -> success + onBack
    dispatchTouch(el, 'touchmove', [{ identifier: 1, clientX: 105, clientY: 200 }]); // dx=95
    dispatchTouch(el, 'touchend', [], [{ identifier: 1, clientX: 105, clientY: 200 }]);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(streamingApi.performHaptic.mock.calls).toEqual([
      [{ style: 'medium' }],
      [{ style: 'light' }],
      [{ style: 'medium' }],
      [{ style: 'success' }],
    ]);
  });

  it('suppresses haptics and commit on vertical scroll abort, second-finger multitouch, and touchcancel', () => {
    const onBack = vi.fn();
    const { getByTestId } = render(<TestSwipeBackSurface onBack={onBack} />);
    const el = getByTestId('swipe-back-surface');

    // 1) Vertical scroll from left edge aborts cleanly without haptics or back
    dispatchTouch(el, 'touchstart', [{ identifier: 1, clientX: 10, clientY: 200 }]);
    dispatchTouch(el, 'touchmove', [{ identifier: 1, clientX: 15, clientY: 250 }]); // dy=50 > dx*1.2 && dx<30
    dispatchTouch(el, 'touchmove', [{ identifier: 1, clientX: 120, clientY: 250 }]);
    dispatchTouch(el, 'touchend', [], [{ identifier: 1, clientX: 120, clientY: 250 }]);
    expect(streamingApi.performHaptic).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();

    // 2) Second finger arriving while armed cancels without extra haptics or commit
    dispatchTouch(el, 'touchstart', [{ identifier: 2, clientX: 10, clientY: 200 }]);
    dispatchTouch(el, 'touchmove', [{ identifier: 2, clientX: 100, clientY: 200 }]); // armed -> medium
    expect(streamingApi.performHaptic.mock.calls).toEqual([[{ style: 'medium' }]]);
    dispatchTouch(el, 'touchstart', [
      { identifier: 2, clientX: 100, clientY: 200 },
      { identifier: 3, clientX: 180, clientY: 200 },
    ]);
    dispatchTouch(el, 'touchmove', [{ identifier: 2, clientX: 130, clientY: 200 }]);
    dispatchTouch(el, 'touchend', [], [{ identifier: 2, clientX: 130, clientY: 200 }]);
    expect(streamingApi.performHaptic.mock.calls).toEqual([[{ style: 'medium' }]]);
    expect(onBack).not.toHaveBeenCalled();

    // 3) touchcancel while armed cleans up overlay SVG and skips success/onBack
    streamingApi.performHaptic.mockClear();
    dispatchTouch(el, 'touchstart', [{ identifier: 4, clientX: 10, clientY: 200 }]);
    expect(document.body.querySelector('svg')).toBeTruthy();
    dispatchTouch(el, 'touchmove', [{ identifier: 4, clientX: 100, clientY: 200 }]); // medium
    dispatchTouch(el, 'touchcancel', [], [{ identifier: 4, clientX: 100, clientY: 200 }]);
    vi.advanceTimersByTime(300);
    expect(document.body.querySelector('svg')).toBeNull();
    expect(streamingApi.performHaptic.mock.calls).toEqual([[{ style: 'medium' }]]);
    expect(onBack).not.toHaveBeenCalled();

    // 4) Sub-threshold or overly diagonal release does not emit success or call onBack
    streamingApi.performHaptic.mockClear();
    dispatchTouch(el, 'touchstart', [{ identifier: 5, clientX: 10, clientY: 200 }]);
    dispatchTouch(el, 'touchmove', [{ identifier: 5, clientX: 100, clientY: 280 }]); // dx=90 -> armed (medium), dy=80
    dispatchTouch(el, 'touchend', [], [{ identifier: 5, clientX: 100, clientY: 280 }]); // dx <= dy*1.5 -> not triggered
    expect(streamingApi.performHaptic.mock.calls).toEqual([[{ style: 'medium' }]]);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('degrades cleanly when performHaptic rejects and navigator.vibrate is missing or throws', async () => {
    const onBack = vi.fn();
    const vibrate = vi.fn(() => { throw new Error('vibrate blocked'); });
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    streamingApi.performHaptic.mockRejectedValue(new Error('UNIMPLEMENTED'));

    const { getByTestId } = render(<TestSwipeBackSurface onBack={onBack} />);
    const el = getByTestId('swipe-back-surface');

    dispatchTouch(el, 'touchstart', [{ identifier: 1, clientX: 10, clientY: 200 }]);
    dispatchTouch(el, 'touchmove', [{ identifier: 1, clientX: 100, clientY: 200 }]);
    await Promise.resolve();
    dispatchTouch(el, 'touchend', [], [{ identifier: 1, clientX: 100, clientY: 200 }]);
    await Promise.resolve();
    expect(onBack).toHaveBeenCalledTimes(1);

    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: undefined });
    dispatchTouch(el, 'touchstart', [{ identifier: 2, clientX: 10, clientY: 200 }]);
    dispatchTouch(el, 'touchmove', [{ identifier: 2, clientX: 100, clientY: 200 }]);
    dispatchTouch(el, 'touchend', [], [{ identifier: 2, clientX: 100, clientY: 200 }]);
    await Promise.resolve();
    expect(onBack).toHaveBeenCalledTimes(2);
  });
});
