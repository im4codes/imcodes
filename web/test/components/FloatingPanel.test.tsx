/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { FloatingPanel } from '../../src/components/FloatingPanel.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.querySelectorAll('.tab-bar').forEach((node) => node.remove());
  vi.restoreAllMocks();
});

function rectWithBottom(bottom: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: bottom,
    top: 0,
    right: 0,
    bottom,
    left: 0,
    toJSON: () => ({}),
  };
}

describe('FloatingPanel', () => {
  it('renders with the supplied zIndex on desktop', () => {
    render(
      <FloatingPanel id="zindex-prop" title="Preview" onClose={() => {}} zIndex={5050}>
        <div>content</div>
      </FloatingPanel>,
    );
    const panel = screen.getByTestId('floating-panel-zindex-prop') as HTMLElement;
    expect(panel.style.zIndex).toBe('5050');
  });

  it('keeps mobile panels above the server switcher layer', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('iPhone');
    const view = render(
      <FloatingPanel id="mobile-zindex" title="Cron manager" onClose={() => {}} zIndex={5070}>
        <div>content</div>
      </FloatingPanel>,
    );
    const panel = view.container.querySelector('.floating-panel') as HTMLElement;
    expect(panel.style.zIndex).toBe('7070');
  });

  it('fires onFocus on root pointer-down', () => {
    const onFocus = vi.fn();
    render(
      <FloatingPanel id="focus-pointer" title="Preview" onClose={() => {}} onFocus={onFocus}>
        <div>content</div>
      </FloatingPanel>,
    );
    fireEvent.mouseDown(screen.getByTestId('floating-panel-focus-pointer'));
    expect(onFocus).toHaveBeenCalled();
  });

  it('fires onFocus on drag start (title bar)', () => {
    const onFocus = vi.fn();
    render(
      <FloatingPanel id="focus-drag" title="Preview" onClose={() => {}} onFocus={onFocus}>
        <div>content</div>
      </FloatingPanel>,
    );
    onFocus.mockClear(); // ignore the root pointer-down that bubbles before this
    fireEvent.mouseDown(screen.getByTestId('floating-bottom-drag'), { clientX: 0, clientY: 0 });
    fireEvent.mouseUp(document);
    expect(onFocus).toHaveBeenCalled();
  });

  it('fires onFocus on resize start', () => {
    const onFocus = vi.fn();
    render(
      <FloatingPanel id="focus-resize" title="Preview" onClose={() => {}} onFocus={onFocus}>
        <div>content</div>
      </FloatingPanel>,
    );
    onFocus.mockClear();
    fireEvent.mouseDown(screen.getByTestId('floating-resize-se'), { clientX: 0, clientY: 0 });
    fireEvent.mouseUp(document);
    expect(onFocus).toHaveBeenCalled();
  });

  // The resize affordance is purely visual, so its whole contract is the class
  // names `styles.css` hooks onto. Asserting them here is what keeps a future
  // refactor from silently returning the window to "no hint it can be resized".
  it('gives every resize handle the shared stylesheet classes', () => {
    render(
      <FloatingPanel id="handle-classes" title="Preview" onClose={() => {}}>
        <div>content</div>
      </FloatingPanel>,
    );

    for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const handle = screen.getByTestId(`floating-resize-${dir}`);
      expect(handle.className).toContain('resize-handle');
      expect(handle.className).toContain(`resize-${dir}`);
    }
  });

  it('keeps the dragged handle and the frame lit for the whole resize', () => {
    render(
      <FloatingPanel id="resize-lit" title="Preview" onClose={() => {}}>
        <div>content</div>
      </FloatingPanel>,
    );

    const handle = screen.getByTestId('floating-resize-se');
    const panel = screen.getByTestId('floating-panel-resize-lit');
    expect(handle.className).not.toContain('is-resizing');
    expect(panel.className).not.toContain('is-resizing');

    fireEvent.mouseDown(handle, { clientX: 0, clientY: 0 });
    // Pointer has left the 6px strip — the affordance must not blink out.
    fireEvent.mouseMove(document, { clientX: 400, clientY: 400 });
    expect(handle.className).toContain('is-resizing');
    expect(panel.className).toContain('is-resizing');
    expect(screen.getByTestId('floating-resize-n').className).not.toContain('is-resizing');

    fireEvent.mouseUp(document);
    expect(handle.className).not.toContain('is-resizing');
    expect(panel.className).not.toContain('is-resizing');
  });

  it('clamps north resize so the panel cannot move above the viewport top', () => {
    localStorage.setItem('rcc_float_clamp-north', JSON.stringify({ x: 100, y: 40, w: 700, h: 500 }));
    render(
      <FloatingPanel id="clamp-north" title="Preview" onClose={() => {}}>
        <div>content</div>
      </FloatingPanel>,
    );

    fireEvent.mouseDown(screen.getByTestId('floating-resize-n'), { clientX: 120, clientY: 40 });
    fireEvent.mouseMove(document, { clientX: 120, clientY: -300 });
    fireEvent.mouseUp(document);

    const panel = screen.getByTestId('floating-panel-clamp-north') as HTMLElement;
    expect(panel.style.top).toBe('0px');
  });

  it('clamps upward drag to the session tab button bottom', () => {
    const tabBar = document.createElement('div');
    tabBar.className = 'tab-bar';
    const tabButton = document.createElement('button');
    tabButton.setAttribute('role', 'tab');
    tabButton.getBoundingClientRect = () => rectWithBottom(44);
    tabBar.appendChild(tabButton);
    document.body.appendChild(tabBar);
    localStorage.setItem('rcc_float_clamp-tab-bottom', JSON.stringify({ x: 100, y: 100, w: 700, h: 500 }));

    render(
      <FloatingPanel id="clamp-tab-bottom" title="Preview" onClose={() => {}}>
        <div>content</div>
      </FloatingPanel>,
    );

    fireEvent.mouseDown(screen.getByTestId('floating-bottom-drag'), { clientX: 200, clientY: 590 });
    fireEvent.mouseMove(document, { clientX: 200, clientY: 100 });
    fireEvent.mouseUp(document);

    const panel = screen.getByTestId('floating-panel-clamp-tab-bottom') as HTMLElement;
    expect(panel.style.top).toBe('44px');

    tabBar.remove();
  });

  it('allows dragging the floating panel from the bottom frame strip', () => {
    localStorage.setItem('rcc_float_bottom-drag', JSON.stringify({ x: 100, y: 100, w: 700, h: 500 }));
    render(
      <FloatingPanel id="bottom-drag" title="Preview" onClose={() => {}}>
        <div>content</div>
      </FloatingPanel>,
    );

    fireEvent.mouseDown(screen.getByTestId('floating-bottom-drag'), { clientX: 200, clientY: 590 });
    fireEvent.mouseMove(document, { clientX: 240, clientY: 640 });
    fireEvent.mouseUp(document);

    const panel = screen.getByTestId('floating-panel-bottom-drag') as HTMLElement;
    expect(panel.style.left).toBe('140px');
    expect(panel.style.top).toBe('150px');
  });
});
