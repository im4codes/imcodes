/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyboardLockSupported, useKeyboardLock } from '../src/hooks/useKeyboardLock.js';

afterEach(() => {
  cleanup();
  delete (navigator as { keyboard?: unknown }).keyboard;
});

function installKeyboard(lock: () => Promise<void> = () => Promise.resolve()) {
  const api = { lock: vi.fn(lock), unlock: vi.fn() };
  (navigator as { keyboard?: unknown }).keyboard = api;
  return api;
}

function Probe({ active }: { active: boolean }) {
  useKeyboardLock(active);
  return <div />;
}

describe('remote desktop keyboard lock', () => {
  it('is unsupported without the browser API, and asks for nothing', () => {
    expect(keyboardLockSupported()).toBe(false);
    const view = render(<Probe active />);
    expect(view.container.querySelector('div')).not.toBeNull();
  });

  it('holds the lock only while control is active in fullscreen', () => {
    const keyboard = installKeyboard();
    expect(keyboardLockSupported()).toBe(true);

    const view = render(<Probe active={false} />);
    expect(keyboard.lock).not.toHaveBeenCalled();

    view.rerender(<Probe active />);
    expect(keyboard.lock).toHaveBeenCalledTimes(1);
    // Every key, not a list: the point is the chords the browser keeps
    // (Command+T, Command+N, ...), and naming them would miss the next one.
    expect(keyboard.lock).toHaveBeenCalledWith();
    expect(keyboard.unlock).not.toHaveBeenCalled();

    // Leaving fullscreen or losing control gives the browser its shortcuts
    // back; a page that kept them would swallow Command+T for good.
    view.rerender(<Probe active={false} />);
    expect(keyboard.unlock).toHaveBeenCalledTimes(1);
  });

  it('releases the lock when the panel goes away', () => {
    const keyboard = installKeyboard();
    const view = render(<Probe active />);
    view.unmount();
    expect(keyboard.unlock).toHaveBeenCalledTimes(1);
  });

  it('survives a browser that refuses the lock', async () => {
    const keyboard = installKeyboard(() => Promise.reject(new Error('not allowed')));
    const view = render(<Probe active />);
    await Promise.resolve();
    expect(keyboard.lock).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(keyboard.unlock).toHaveBeenCalledTimes(1);
  });
});
