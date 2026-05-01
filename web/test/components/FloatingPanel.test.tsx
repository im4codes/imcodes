/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { FloatingPanel } from '../../src/components/FloatingPanel.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

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
