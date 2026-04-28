/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { FloatingPanel } from '../../src/components/FloatingPanel.js';

const defaultUserAgent = navigator.userAgent;

afterEach(() => {
  cleanup();
  localStorage.clear();
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: defaultUserAgent });
});

describe('FloatingPanel', () => {
  it('clamps north resize so the panel cannot move above the viewport top', () => {
    localStorage.setItem('rcc_float_clamp-north', JSON.stringify({ x: 100, y: 40, w: 700, h: 500 }));
    const onFocus = vi.fn();
    render(
      <FloatingPanel id="clamp-north" title="Preview" onClose={() => {}} onFocus={onFocus}>
        <div>content</div>
      </FloatingPanel>,
    );

    fireEvent.mouseDown(screen.getByTestId('floating-resize-n'), { clientX: 120, clientY: 40 });
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalled();
    fireEvent.mouseMove(document, { clientX: 120, clientY: -300 });
    fireEvent.mouseUp(document);

    const panel = screen.getByTestId('floating-panel-clamp-north') as HTMLElement;
    expect(panel.style.top).toBe('0px');
  });

  it('focuses on resize drag start for desktop panels', () => {
    const onFocus = vi.fn();
    render(
      <FloatingPanel id="resize-start" title="Preview" onClose={() => {}} onFocus={onFocus}>
        <div>content</div>
      </FloatingPanel>,
    );

    fireEvent.mouseDown(screen.getByTestId('floating-resize-se'), { clientX: 120, clientY: 120 });
    expect(onFocus).toHaveBeenCalledTimes(1);

    fireEvent.mouseMove(document, { clientX: 160, clientY: 180 });
    fireEvent.mouseUp(document);
    expect(screen.getByTestId('floating-panel-resize-start').style.width).not.toBe('');
  });

  it('allows dragging the floating panel from the bottom frame strip', () => {
    localStorage.setItem('rcc_float_bottom-drag', JSON.stringify({ x: 100, y: 100, w: 700, h: 500 }));
    const onFocus = vi.fn();
    render(
      <FloatingPanel id="bottom-drag" title="Preview" onClose={() => {}} onFocus={onFocus}>
        <div>content</div>
      </FloatingPanel>,
    );

    fireEvent.mouseDown(screen.getByTestId('floating-bottom-drag'), { clientX: 200, clientY: 590 });
    expect(onFocus).toHaveBeenCalled();
    fireEvent.mouseMove(document, { clientX: 240, clientY: 640 });
    fireEvent.mouseUp(document);

    const panel = screen.getByTestId('floating-panel-bottom-drag') as HTMLElement;
    expect(panel.style.left).toBe('140px');
    expect(panel.style.top).toBe('150px');
  });

  it('focuses on desktop root mouse down and title drag start', () => {
    const onFocus = vi.fn();
    render(
      <FloatingPanel id="focus-events" title="Preview" onClose={() => {}} onFocus={onFocus}>
        <div>content</div>
      </FloatingPanel>,
    );

    fireEvent.mouseDown(screen.getByTestId('floating-panel-focus-events'), { clientX: 160, clientY: 140 });
    expect(onFocus).toHaveBeenCalledTimes(1);

    const callsBeforeTitleDrag = onFocus.mock.calls.length;
    fireEvent.mouseDown(screen.getByText('Preview').parentElement as HTMLElement, { clientX: 180, clientY: 140 });
    expect(onFocus.mock.calls.length).toBeGreaterThan(callsBeforeTitleDrag);
  });

  it('keeps mobile fullscreen layering independent from desktop z-index props', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });

    const { container } = render(
      <FloatingPanel id="mobile-layer" title="Preview" onClose={() => {}} zIndex={7777}>
        <div>content</div>
      </FloatingPanel>,
    );

    expect(screen.queryByTestId('floating-panel-mobile-layer')).toBeNull();
    expect((container.firstElementChild as HTMLElement | null)?.style.zIndex).toBe('2000');
  });
});
