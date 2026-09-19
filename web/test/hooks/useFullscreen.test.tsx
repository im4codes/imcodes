/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'preact/hooks';
import { useFullscreen, fullscreenSupported, type FullscreenControl } from '../../src/hooks/useFullscreen.js';
import { installFullscreenStub, removeFullscreenStub } from '../support/fullscreen-stub.js';

let control: FullscreenControl;
let target: HTMLElement | null = null;

function Probe(): preact.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  control = useFullscreen(ref);
  return <div ref={(element) => { ref.current = element; target = element; }} data-testid="target" />;
}

afterEach(() => {
  cleanup();
  removeFullscreenStub();
  target = null;
  vi.restoreAllMocks();
});

describe('useFullscreen', () => {
  beforeEach(() => { removeFullscreenStub(); });

  it('reports unsupported rather than offering a button that can only fail', () => {
    // No API at all.
    expect(fullscreenSupported()).toBe(false);

    // Present, but refused by policy -- an iframe without `allowfullscreen`
    // reports exactly this.
    installFullscreenStub({ enabled: false });
    expect(fullscreenSupported()).toBe(false);

    removeFullscreenStub();
    installFullscreenStub();
    expect(fullscreenSupported()).toBe(true);
  });

  it('enters and leaves, tracking the element it was actually given', async () => {
    const api = installFullscreenStub();
    render(<Probe />);
    expect(control.active).toBe(false);

    await act(async () => { await control.toggle(); });
    expect(api.requests).toEqual([target]);
    expect(control.active).toBe(true);

    await act(async () => { await control.toggle(); });
    expect(control.active).toBe(false);
  });

  it('is not fooled by some other element being fullscreen', async () => {
    // Truthiness of `document.fullscreenElement` is the tempting check and the
    // wrong one: it makes this button claim to be on because of something
    // else on the page, and pressing it then drops that other thing out of
    // fullscreen instead of putting this one in.
    const api = installFullscreenStub();
    render(<Probe />);
    const stranger = document.createElement('video');
    document.body.appendChild(stranger);

    await act(async () => { api.setElement(stranger); });
    expect(control.active, 'someone else is fullscreen, not us').toBe(false);

    await act(async () => { await control.toggle(); });
    expect(api.requests, 'a swap, not an exit').toEqual([target]);
    expect(control.active).toBe(true);
  });

  it('notices Esc, which leaves fullscreen with no click at all', async () => {
    const api = installFullscreenStub();
    render(<Probe />);
    await act(async () => { await control.toggle(); });
    expect(control.active).toBe(true);

    // The browser exits and only tells us through the event. A flag we set
    // ourselves would still say "on" over a window that plainly is not.
    await act(async () => { api.setElement(null); });
    expect(control.active).toBe(false);
  });

  it('survives a refusal instead of throwing out of the click handler', async () => {
    // Safari refuses a non-video element, and every browser refuses without a
    // user gesture. An unhandled rejection here takes the toolbar with it.
    installFullscreenStub({ reject: true });
    render(<Probe />);
    let result: boolean | undefined;
    await act(async () => { result = await control.toggle(); });
    expect(result).toBe(false);
    expect(control.active).toBe(false);
  });

  it('does nothing at all when the element is not mounted yet', async () => {
    const api = installFullscreenStub();
    function Unmounted(): preact.JSX.Element {
      const ref = useRef<HTMLDivElement | null>(null);
      control = useFullscreen(ref);
      return <span />;
    }
    render(<Unmounted />);
    let result: boolean | undefined;
    await act(async () => { result = await control.toggle(); });
    expect(result).toBe(false);
    expect(api.requests).toEqual([]);
  });
});
