/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { FloatingPanel } from '../../src/components/FloatingPanel.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('FloatingPanel', () => {
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
