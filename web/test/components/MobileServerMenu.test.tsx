import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { MobileServerMenu } from '../../src/components/MobileServerMenu.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('MobileServerMenu', () => {
  it('fills space below its actual anchor and tracks rotation/keyboard without changing the content', () => {
    const viewport = Object.assign(new EventTarget(), { offsetTop: 0, height: 700 });
    vi.stubGlobal('visualViewport', viewport);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 60 } as DOMRect);
    const removed = vi.spyOn(viewport, 'removeEventListener');
    const { container, unmount } = render(<MobileServerMenu><button>Server</button></MobileServerMenu>);
    const menu = container.firstElementChild as HTMLElement;
    const available = () => menu.style.getPropertyValue('--mobile-server-menu-available-height');
    expect(available()).toBe('640px');
    viewport.height = 360;
    viewport.dispatchEvent(new Event('resize'));
    expect(available()).toBe('300px');
    viewport.offsetTop = 20;
    viewport.dispatchEvent(new Event('scroll'));
    expect(available()).toBe('320px');
    viewport.height = 20;
    viewport.offsetTop = 0;
    window.dispatchEvent(new Event('resize'));
    expect(available()).toBe('0px');
    expect(menu.textContent).toBe('Server');
    unmount();
    expect(removed.mock.calls.map(([event]) => event)).toEqual(['resize', 'scroll']);
  });
  it('falls back to the layout viewport when visualViewport is absent', () => {
    vi.stubGlobal('visualViewport', undefined);
    vi.stubGlobal('innerHeight', 600);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 72 } as DOMRect);
    const { container } = render(<MobileServerMenu>Servers</MobileServerMenu>);
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--mobile-server-menu-available-height')).toBe('528px');
  });
});
