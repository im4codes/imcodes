/**
 * @vitest-environment jsdom
 *
 * Every FloatingPanel-based window (controlled nodes, remote desktop, file
 * browser, discussions, cron...) must raise from a click anywhere inside it.
 * Bubbling alone was not enough: an inner widget that stops propagation made
 * the window unraisable, so a large panel like the controlled-node list
 * appeared to permanently cover everything behind it.
 */
import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { render, fireEvent, cleanup } from '@testing-library/preact';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const { FloatingPanel } = await import('../../src/components/FloatingPanel.js');

describe('FloatingPanel raise-on-click', () => {
  it('raises from a click on a child that stops propagation', () => {
    const onFocus = vi.fn();
    const { container } = render(
      <FloatingPanel id="controlled-nodes" title="t" onClose={vi.fn()} zIndex={7010} onFocus={onFocus}>
        <div
          data-testid="swallowing-child"
          onPointerDown={(e: any) => e.stopPropagation()}
          onMouseDown={(e: any) => e.stopPropagation()}
        />
      </FloatingPanel>,
    );
    const child = container.querySelector('[data-testid="swallowing-child"]');
    expect(child).toBeTruthy();

    fireEvent.pointerDown(child!);
    expect(onFocus).toHaveBeenCalled();
    cleanup();
  });
});
