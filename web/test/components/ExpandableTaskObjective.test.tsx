/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'delegation.objective_expand': '展开',
      'delegation.objective_collapse': '收起',
    }[key] ?? key),
  }),
}));

import { ExpandableTaskObjective } from '../../src/components/ExpandableTaskObjective.js';

const originalResizeObserver = globalThis.ResizeObserver;
const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
  else Reflect.deleteProperty(document, 'fonts');
});

describe('ExpandableTaskObjective', () => {
  it('shows a 1000-character objective once, clamps it, and exposes an accessible toggle', () => {
    const objective = 'Delegation objective '.repeat(55).trim();
    render(<ExpandableTaskObjective text={objective} measureOverflow={() => true} />);

    const text = screen.getByTestId('expandable-task-objective-text');
    const toggle = screen.getByRole('button', { name: '展开' });
    expect(text.textContent).toBe(objective);
    expect(document.body.textContent?.split(objective)).toHaveLength(2);
    expect(text.classList.contains('is-clamped')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(text.id);
    expect(toggle.getAttribute('title')).toBe('展开');

    fireEvent.click(toggle);
    expect(text.classList.contains('is-expanded')).toBe(true);
    expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('leaves a two-line objective untouched and offers no toggle', () => {
    render(<ExpandableTaskObjective text={'Short first line\nShort second line'} measureOverflow={() => false} />);
    const text = screen.getByTestId('expandable-task-objective-text');
    expect(text.textContent).toBe('Short first line\nShort second line');
    expect(text.classList.contains('is-multiline')).toBe(true);
    expect(text.classList.contains('is-clamped')).toBe(true);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('preserves CJK code points and supports the legacy 4 KiB projection bound', () => {
    const objective = '修复委派回复标题，保留全部任务上下文。'.repeat(180);
    render(<ExpandableTaskObjective text={objective} measureOverflow={() => true} />);
    expect(screen.getByTestId('expandable-task-objective-text').textContent).toBe(objective);
    expect(screen.getByTestId('expandable-task-objective-text').textContent).not.toContain('\ufffd');
  });

  it('remeasures real overflow after container resize and font loading', async () => {
    let resize: (() => void) | undefined;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) { resize = () => callback([], this as never); }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const fontListeners = new Set<EventListenerOrEventListenerObject>();
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        ready: new Promise<void>(() => {}),
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => fontListeners.add(listener),
        removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => fontListeners.delete(listener),
      },
    });
    let overflows = false;
    render(<ExpandableTaskObjective text="Remeasure this objective" measureOverflow={() => overflows} />);
    expect(screen.queryByRole('button')).toBeNull();

    overflows = true;
    resize?.();
    await waitFor(() => expect(screen.getByRole('button', { name: '展开' })).toBeTruthy());
    overflows = false;
    for (const listener of fontListeners) {
      if (typeof listener === 'function') listener(new Event('loadingdone'));
      else listener.handleEvent(new Event('loadingdone'));
    }
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });
});
