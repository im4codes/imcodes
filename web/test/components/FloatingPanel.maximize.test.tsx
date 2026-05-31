/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { FloatingPanel } from '../../src/components/FloatingPanel.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'window.maximize': 'Maximize',
      'window.restore': 'Restore',
      'window.minimize': 'Minimize',
      'window.close': 'Close',
      'sidebar.pin_to_sidebar': 'Pin to sidebar',
    })[key] ?? key,
  }),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('FloatingPanel maximize integration', () => {
  it('shows a maximize control for an opted-in file browser panel', () => {
    render(
      <FloatingPanel
        id="filebrowser"
        title="Files"
        onClose={() => {}}
        enableMaximize
        isMaximized={false}
        onToggleMaximized={() => {}}
      >
        <div>content</div>
      </FloatingPanel>,
    );

    expect(screen.getByRole('button', { name: 'Maximize' })).toBeTruthy();
  });

  it('does not show a maximize control for other panels by default', () => {
    render(
      <FloatingPanel id="repo" title="Repo" onClose={() => {}}>
        <div>content</div>
      </FloatingPanel>,
    );

    expect(screen.queryByTestId('floating-maximize-toggle')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Maximize' })).toBeNull();
  });

  it('does not show a maximize control when desktop layout capability is disabled', () => {
    render(
      <FloatingPanel
        id="filebrowser"
        title="Files"
        onClose={() => {}}
        enableMaximize
        isMaximized={false}
        desktopLayoutCapable={false}
        onToggleMaximized={() => {}}
      >
        <div>content</div>
      </FloatingPanel>,
    );

    expect(screen.queryByTestId('floating-maximize-toggle')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Maximize' })).toBeNull();
  });

  it('renders maximized geometry exactly from workspace bounds', () => {
    render(
      <FloatingPanel
        id="filebrowser"
        title="Files"
        onClose={() => {}}
        enableMaximize
        isMaximized
        onToggleMaximized={() => {}}
        getMaximizeBounds={() => ({ x: 240, y: 72, w: 1180, h: 720 })}
      >
        <div>content</div>
      </FloatingPanel>,
    );

    const panel = screen.getByTestId('floating-panel-filebrowser') as HTMLElement;
    expect(panel.style.left).toBe('240px');
    expect(panel.style.top).toBe('72px');
    expect(panel.style.width).toBe('1180px');
    expect(panel.style.height).toBe('720px');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(screen.getByTitle('Files')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('normalizes malformed stored normal geometry instead of rendering NaN styles', () => {
    localStorage.setItem('rcc_float_filebrowser', JSON.stringify({ x: Number.NaN, y: 'bad', w: null, h: Infinity }));

    render(
      <FloatingPanel id="filebrowser" title="Files" onClose={() => {}}>
        <div>content</div>
      </FloatingPanel>,
    );

    const panel = screen.getByTestId('floating-panel-filebrowser') as HTMLElement;
    expect(panel.style.left).not.toContain('NaN');
    expect(panel.style.top).not.toContain('NaN');
    expect(panel.style.width).not.toContain('NaN');
    expect(panel.style.height).not.toContain('NaN');
  });

  it('keeps normal floating geometry above the reserved sub-session strip', () => {
    localStorage.setItem('rcc_float_filebrowser', JSON.stringify({ x: 80, y: 999, w: 700, h: 520 }));

    render(
      <FloatingPanel id="filebrowser" title="Files" onClose={() => {}}>
        <div>content</div>
      </FloatingPanel>,
    );

    const panel = screen.getByTestId('floating-panel-filebrowser') as HTMLElement;
    expect(parseFloat(panel.style.top) + parseFloat(panel.style.height)).toBeLessThanOrEqual(window.innerHeight - 100);
  });

  it('restores offscreen normal floating geometry fully inside the viewport', () => {
    localStorage.setItem('rcc_float_filebrowser', JSON.stringify({ x: 99999, y: 80, w: 700, h: 520 }));

    render(
      <FloatingPanel id="filebrowser" title="Files" onClose={() => {}}>
        <div>content</div>
      </FloatingPanel>,
    );

    const panel = screen.getByTestId('floating-panel-filebrowser') as HTMLElement;
    expect(parseFloat(panel.style.left) + parseFloat(panel.style.width)).toBeLessThanOrEqual(window.innerWidth);
  });

  it('does not persist maximized workspace geometry as normal panel geometry', () => {
    const saved = { x: 80, y: 90, w: 700, h: 520 };
    localStorage.setItem('rcc_float_filebrowser', JSON.stringify(saved));

    render(
      <FloatingPanel
        id="filebrowser"
        title="Files"
        onClose={() => {}}
        enableMaximize
        isMaximized
        onToggleMaximized={() => {}}
        getMaximizeBounds={() => ({ x: 240, y: 72, w: 1180, h: 720 })}
      >
        <div>content</div>
      </FloatingPanel>,
    );

    expect(JSON.parse(localStorage.getItem('rcc_float_filebrowser') ?? '{}')).toEqual(saved);
  });

  it('hides drag and resize affordances while maximized', () => {
    localStorage.setItem('rcc_float_filebrowser', JSON.stringify({ x: 80, y: 90, w: 700, h: 520 }));

    render(
      <FloatingPanel
        id="filebrowser"
        title="Files"
        onClose={() => {}}
        enableMaximize
        isMaximized
        onToggleMaximized={() => {}}
        getMaximizeBounds={() => ({ x: 240, y: 72, w: 1180, h: 720 })}
      >
        <div>content</div>
      </FloatingPanel>,
    );

    expect(screen.queryByTestId('floating-bottom-drag')).toBeNull();
    expect(screen.queryByTestId('floating-resize-se')).toBeNull();
  });

  it('keeps close and minimize behavior unchanged', () => {
    const onClose = vi.fn();
    render(
      <FloatingPanel
        id="filebrowser"
        title="Files"
        onClose={onClose}
        enableMaximize
        isMaximized
        onToggleMaximized={() => {}}
        getMaximizeBounds={() => ({ x: 240, y: 72, w: 1180, h: 720 })}
      >
        <div>content</div>
      </FloatingPanel>,
    );

    fireEvent.click(screen.getByTitle('Minimize'));
    fireEvent.click(screen.getByTitle('Close'));

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('toggles maximize without starting titlebar drag', () => {
    const onFocus = vi.fn();
    const onToggleMaximized = vi.fn();
    render(
      <FloatingPanel
        id="filebrowser"
        title="Files"
        onClose={() => {}}
        onFocus={onFocus}
        enableMaximize
        isMaximized={false}
        onToggleMaximized={onToggleMaximized}
      >
        <div>content</div>
      </FloatingPanel>,
    );

    const panel = screen.getByTestId('floating-panel-filebrowser') as HTMLElement;
    const before = { left: panel.style.left, top: panel.style.top };
    const button = screen.getByRole('button', { name: 'Maximize' });

    fireEvent.mouseDown(button, { clientX: 120, clientY: 80 });
    fireEvent.mouseMove(document, { clientX: 320, clientY: 260 });
    fireEvent.mouseUp(document);
    fireEvent.click(button);

    expect(onToggleMaximized).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(panel.style.left).toBe(before.left);
    expect(panel.style.top).toBe(before.top);
  });
});
