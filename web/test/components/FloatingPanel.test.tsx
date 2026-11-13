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
      expect(handle.className).toContain('resize-hover-surface');
      expect(handle.className).toContain(`resize-${dir}`);
    }
    const layer = screen.getByTestId('floating-panel-handle-classes').querySelector('.resize-handle-layer');
    expect(layer).not.toBeNull();
    expect(layer?.parentElement).toBe(screen.getByTestId('floating-panel-handle-classes'));
  });

  it('mirrors target-phase mouse hover into an explicit cross-engine class for every direction', () => {
    render(
      <FloatingPanel id="handle-hover" title="Preview" onClose={() => {}}>
        <div>content</div>
      </FloatingPanel>,
    );

    for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const handle = screen.getByTestId(`floating-resize-${dir}`);
      expect(handle.className).not.toContain('is-pointer-hovered');
      fireEvent.mouseEnter(handle);
      expect(handle.className).toContain('is-pointer-hovered');
      fireEvent.mouseLeave(handle);
      expect(handle.className).not.toContain('is-pointer-hovered');
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

  it('resizes from each corner while keeping the opposite corner anchored', () => {
    const cases = [
      { dir: 'nw', dx: -20, dy: -30, left: '80px', top: '70px', width: '720px', height: '530px' },
      { dir: 'ne', dx: 20, dy: -30, left: '100px', top: '70px', width: '720px', height: '530px' },
      { dir: 'sw', dx: -20, dy: 30, left: '80px', top: '100px', width: '720px', height: '530px' },
      { dir: 'se', dx: 20, dy: 30, left: '100px', top: '100px', width: '720px', height: '530px' },
    ] as const;

    for (const testCase of cases) {
      localStorage.setItem(`rcc_float_corner-${testCase.dir}`, JSON.stringify({ x: 100, y: 100, w: 700, h: 500 }));
      render(
        <FloatingPanel id={`corner-${testCase.dir}`} title="Preview" onClose={() => {}}>
          <div>content</div>
        </FloatingPanel>,
      );

      const handle = screen.getByTestId(`floating-resize-${testCase.dir}`);
      fireEvent.mouseDown(handle, { clientX: 100, clientY: 100 });
      fireEvent.mouseMove(document, { clientX: 100 + testCase.dx, clientY: 100 + testCase.dy });
      fireEvent.mouseUp(document);

      const panel = screen.getByTestId(`floating-panel-corner-${testCase.dir}`) as HTMLElement;
      expect(panel.style.left).toBe(testCase.left);
      expect(panel.style.top).toBe(testCase.top);
      expect(panel.style.width).toBe(testCase.width);
      expect(panel.style.height).toBe(testCase.height);
      cleanup();
    }
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

  it('does not place a hidden drag strip over content when a custom handle is declared', () => {
    render(
      <FloatingPanel
        id="custom-handle"
        title="Remote"
        onClose={() => {}}
        hideTitleBar
        dragHandleSelector=".remote-desktop-toolbar"
      >
        <div class="remote-desktop-toolbar">toolbar</div>
        <div data-testid="remote-content">content</div>
      </FloatingPanel>,
    );

    expect(screen.queryByTestId('floating-bottom-drag')).toBeNull();
  });

  it('uses getDefaultGeometry on initial open and falls back to defaultW/defaultH when it returns null', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1000);

    const view = render(
      <FloatingPanel
        id="cloud-docs-default"
        title="Cloud Docs"
        onClose={() => {}}
        defaultW={1080}
        defaultH={760}
        minW={640}
        minH={440}
        defaultVersion={2}
        getDefaultGeometry={() => ({ x: 260, y: 48, w: 1200, h: 820 })}
      >
        <div>content</div>
      </FloatingPanel>,
    );

    const panel = screen.getByTestId('floating-panel-cloud-docs-default') as HTMLElement;
    expect(panel.style.left).toBe('260px');
    expect(panel.style.top).toBe('48px');
    expect(panel.style.width).toBe('1200px');
    expect(panel.style.height).toBe('820px');
    view.unmount();

    localStorage.clear();
    render(
      <FloatingPanel
        id="cloud-docs-null-default"
        title="Cloud Docs"
        onClose={() => {}}
        defaultW={1080}
        defaultH={760}
        minW={640}
        minH={440}
        defaultVersion={2}
        getDefaultGeometry={() => null}
      >
        <div>content</div>
      </FloatingPanel>,
    );
    const fallbackPanel = screen.getByTestId('floating-panel-cloud-docs-null-default') as HTMLElement;
    expect(fallbackPanel.style.width).toBe('1080px');
    expect(fallbackPanel.style.height).toBe('760px');
  });

  it('migrates only versioned cloud-docs cache once while keeping unversioned panel caches intact', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1000);

    localStorage.setItem('rcc_float_cloud-docs', JSON.stringify({ x: 100, y: 100, w: 920, h: 660 }));
    localStorage.setItem('rcc_float_filebrowser', JSON.stringify({ x: 75, y: 85, w: 720, h: 540 }));

    const cloudView = render(
      <FloatingPanel
        id="cloud-docs"
        title="Cloud Docs"
        onClose={() => {}}
        defaultW={1080}
        defaultH={760}
        minW={640}
        minH={440}
        defaultVersion={2}
        getDefaultGeometry={() => ({ x: 280, y: 50, w: 1220, h: 800 })}
      >
        <div>docs</div>
      </FloatingPanel>,
    );

    const cloudPanel = screen.getByTestId('floating-panel-cloud-docs') as HTMLElement;
    expect(cloudPanel.style.width).toBe('1220px');
    expect(cloudPanel.style.height).toBe('800px');
    expect(JSON.parse(localStorage.getItem('rcc_float_cloud-docs') ?? '{}')).toEqual({
      x: 280,
      y: 50,
      w: 1220,
      h: 800,
      _dv: 2,
    });
    cloudView.unmount();

    const filesView = render(
      <FloatingPanel id="filebrowser" title="Files" onClose={() => {}}>
        <div>files</div>
      </FloatingPanel>,
    );
    const filesPanel = screen.getByTestId('floating-panel-filebrowser') as HTMLElement;
    expect(filesPanel.style.left).toBe('75px');
    expect(filesPanel.style.top).toBe('85px');
    expect(filesPanel.style.width).toBe('720px');
    expect(filesPanel.style.height).toBe('540px');
    expect(JSON.parse(localStorage.getItem('rcc_float_filebrowser') ?? '{}')._dv).toBeUndefined();
    filesView.unmount();
  });

  it('persists manual resize and drag across close/reopen and clamps on shrunk viewport', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1000);

    const view1 = render(
      <FloatingPanel
        id="cloud-docs"
        title="Cloud Docs"
        onClose={() => {}}
        defaultW={1080}
        defaultH={760}
        minW={640}
        minH={440}
        defaultVersion={2}
        getDefaultGeometry={() => ({ x: 240, y: 50, w: 1200, h: 800 })}
      >
        <div>docs</div>
      </FloatingPanel>,
    );

    // Manually resize SE inward (-200w, -150h) -> 1000x650
    fireEvent.mouseDown(screen.getByTestId('floating-resize-se'), { clientX: 1440, clientY: 850 });
    fireEvent.mouseMove(document, { clientX: 1240, clientY: 700 });
    fireEvent.mouseUp(document);

    // Manually drag from bottom strip (+40x, +30y) -> x: 280, y: 80
    fireEvent.mouseDown(screen.getByTestId('floating-bottom-drag'), { clientX: 500, clientY: 700 });
    fireEvent.mouseMove(document, { clientX: 540, clientY: 730 });
    fireEvent.mouseUp(document);
    view1.unmount();

    // Close and reopen -> remembers 1000x650 at (280, 80), ignoring getDefaultGeometry
    const view2 = render(
      <FloatingPanel
        id="cloud-docs"
        title="Cloud Docs"
        onClose={() => {}}
        defaultW={1080}
        defaultH={760}
        minW={640}
        minH={440}
        defaultVersion={2}
        getDefaultGeometry={() => ({ x: 240, y: 50, w: 1200, h: 800 })}
      >
        <div>docs</div>
      </FloatingPanel>,
    );
    const reopened = screen.getByTestId('floating-panel-cloud-docs') as HTMLElement;
    expect(reopened.style.left).toBe('280px');
    expect(reopened.style.top).toBe('80px');
    expect(reopened.style.width).toBe('1000px');
    expect(reopened.style.height).toBe('650px');

    // Shrink viewport -> clamps within new bounds
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(900);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
    fireEvent(window, new Event('resize'));
    expect(parseFloat(reopened.style.left) + parseFloat(reopened.style.width)).toBeLessThanOrEqual(900);
    expect(parseFloat(reopened.style.top) + parseFloat(reopened.style.height)).toBeLessThanOrEqual(500);
    view2.unmount();
  });

  it('renders open-in-new-window button on desktop titlebar and invokes callback without starting drag', () => {
    const onOpenNewWindow = vi.fn();
    render(
      <FloatingPanel
        id="cloud-docs-popout"
        title="Cloud Docs"
        onClose={() => {}}
        onOpenNewWindow={onOpenNewWindow}
        openNewWindowTooltip="Open in new window"
      >
        <div>docs</div>
      </FloatingPanel>,
    );

    const btn = screen.getByTestId('floating-open-new-window');
    expect(btn.getAttribute('title')).toBe('Open in new window');
    fireEvent.mouseDown(btn, { clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 250, clientY: 120 });
    fireEvent.mouseUp(document);
    fireEvent.click(btn);
    expect(onOpenNewWindow).toHaveBeenCalledTimes(1);
  });
});
