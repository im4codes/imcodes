/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RemoteDesktopMinimizedDock,
  rememberMinimizeOrigin,
  type RemoteDesktopMinimizeOrigin,
} from '../src/components/RemoteDesktopMinimizedDock.js';

const rect = (left: number, top: number, width: number, height: number) => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
}) as DOMRect;

function addAnchor(box: DOMRect): HTMLElement {
  const anchor = document.createElement('div');
  anchor.className = 'controlled-nodes-shortcut-group';
  anchor.getBoundingClientRect = () => box;
  document.body.appendChild(anchor);
  return anchor;
}

describe('RemoteDesktopMinimizedDock', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    delete (Element.prototype as { animate?: unknown }).animate;
  });

  it('sits directly under the AI Desk shortcut, and the next chip stacks below it', () => {
    addAnchor(rect(40, 100, 120, 30));
    const originRef = { current: null as RemoteDesktopMinimizeOrigin | null };
    const { container } = render(
      <>
        <RemoteDesktopMinimizedDock originRef={originRef} label="Workspace · 3" onRestore={vi.fn()} />
        <RemoteDesktopMinimizedDock originRef={originRef} label="Wall · 2" onRestore={vi.fn()} />
      </>,
    );
    const docks = container.querySelectorAll<HTMLButtonElement>('.remote-desktop-minimized-dock');
    expect(docks).toHaveLength(2);
    expect(docks[0]!.style.left).toBe('40px');
    expect(docks[0]!.style.top).toBe('135px');
    expect(docks[1]!.style.left).toBe('40px');
    expect(Number.parseInt(docks[1]!.style.top, 10)).toBeGreaterThan(135);
  });

  it('keeps the stylesheet corner placement when there is no AI Desk shortcut on screen', () => {
    const originRef = { current: null as RemoteDesktopMinimizeOrigin | null };
    const { container } = render(
      <RemoteDesktopMinimizedDock originRef={originRef} label="Workspace" onRestore={vi.fn()} />,
    );
    const dock = container.querySelector<HTMLButtonElement>('.remote-desktop-minimized-dock')!;
    expect(dock.style.left).toBe('');
    expect(dock.style.top).toBe('');
  });

  it('restores on click', () => {
    const onRestore = vi.fn();
    const originRef = { current: null as RemoteDesktopMinimizeOrigin | null };
    const { container } = render(
      <RemoteDesktopMinimizedDock originRef={originRef} label="Workspace" onRestore={onRestore} />,
    );
    container.querySelector<HTMLButtonElement>('.remote-desktop-minimized-dock')!.click();
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it('shrinks a ghost of the window from where it was into the chip, then removes it', () => {
    addAnchor(rect(40, 100, 120, 30));
    const frames: Keyframe[][] = [];
    let finish: (() => void) | null = null;
    (Element.prototype as { animate?: unknown }).animate = function animate(keyframes: Keyframe[]) {
      frames.push(keyframes);
      const animation = { onfinish: null as null | (() => void), oncancel: null, cancel: vi.fn() };
      finish = () => animation.onfinish?.();
      return animation;
    };

    const windowEl = document.createElement('div');
    windowEl.className = 'floating-panel';
    windowEl.getBoundingClientRect = () => rect(300, 60, 1000, 700);
    const minimizeButton = document.createElement('button');
    windowEl.appendChild(minimizeButton);
    document.body.appendChild(windowEl);

    const originRef = { current: null as RemoteDesktopMinimizeOrigin | null };
    rememberMinimizeOrigin(originRef, minimizeButton);
    expect(originRef.current).toEqual({ left: 300, top: 60, width: 1000, height: 700 });

    const { container } = render(
      <RemoteDesktopMinimizedDock originRef={originRef} label="Workspace" onRestore={vi.fn()} />,
    );
    expect(originRef.current).toBeNull();
    expect(container.querySelector('.remote-desktop-minimize-ghost')).not.toBeNull();
    expect(frames).toHaveLength(1);
    expect(frames[0]![0]).toMatchObject({ left: '300px', top: '60px', width: '1000px', height: '700px' });
    // Ends at the chip's own box (jsdom reports zeros for it), with the window faded out.
    expect(frames[0]![1]).toMatchObject({ opacity: 0.15 });

    finish!();
    return Promise.resolve().then(() => {
      expect(container.querySelector('.remote-desktop-minimize-ghost')).toBeNull();
    });
  });

  it('does not animate when the window position was not captured', () => {
    const originRef = { current: null as RemoteDesktopMinimizeOrigin | null };
    rememberMinimizeOrigin(originRef, document.createElement('button'));
    expect(originRef.current).toBeNull();
    const { container } = render(
      <RemoteDesktopMinimizedDock originRef={originRef} label="Workspace" onRestore={vi.fn()} />,
    );
    expect(container.querySelector('.remote-desktop-minimize-ghost')).toBeNull();
  });
});
