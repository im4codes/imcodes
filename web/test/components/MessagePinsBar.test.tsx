/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useState } from 'preact/hooks';
import type { MessagePin } from '../../../shared/message-pins.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'messagePins.summary') return `current ${vars?.current} / all ${vars?.total}`;
      if (key === 'messagePins.currentTab') return `Current (${vars?.count})`;
      if (key === 'messagePins.allTab') return `All (${vars?.count})`;
      return key;
    },
  }),
}));

import { MessagePinsBar } from '../../src/components/MessagePinsBar.js';

function pin(id: string, sessionName: string): MessagePin {
  return {
    id,
    serverId: 'srv-1',
    sessionName,
    eventId: `event-${id}`,
    eventTs: 1_700_000_000_000,
    eventType: id.startsWith('u') ? 'user.message' : 'assistant.text',
    text: `pinned ${id}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('MessagePinsBar', () => {
  afterEach(cleanup);

  it('collapses to a compact current/total count and switches between current and all sessions', () => {
    const onLocate = vi.fn();
    const onQuote = vi.fn();
    const onUnpin = vi.fn();
    const pins = [pin('u1', 'deck_current'), pin('a2', 'deck_current'), pin('a3', 'deck_other')];
    render(<MessagePinsBar pins={pins} currentSessionName="deck_current" onLocate={onLocate} onQuote={onQuote} onUnpin={onUnpin} />);

    const trigger = screen.getByTestId('message-pins-trigger');
    expect(trigger.textContent).toBe('📌2/3');
    expect(trigger.getAttribute('aria-label')).toBe('current 2 / all 3');
    expect(screen.queryByText('pinned u1')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText('pinned u1')).toBeTruthy();
    expect(screen.getByText('pinned a2')).toBeTruthy();
    expect(screen.queryByText('pinned a3')).toBeNull();

    fireEvent.click(screen.getByText('All (3)'));
    expect(screen.getByText('pinned a3')).toBeTruthy();
    expect(screen.getByText('deck_other')).toBeTruthy();
    fireEvent.click(screen.getByText('pinned a3'));
    expect(onLocate).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.message-pins-panel')).toBeNull();
    expect(screen.getByText('messagePins.previewTitle')).toBeTruthy();
    expect(screen.getByText('common.quote')).toBeTruthy();
    expect(screen.getByText('messagePins.jump')).toBeTruthy();
    expect(screen.getByText('common.copy')).toBeTruthy();

    fireEvent.click(screen.getByText('common.quote'));
    expect(onQuote).toHaveBeenCalledWith('pinned a3');
    expect(onLocate).not.toHaveBeenCalled();
    expect(screen.queryByText('messagePins.previewTitle')).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByText('All (3)'));
    fireEvent.click(screen.getByText('pinned a3'));
    fireEvent.click(screen.getByText('messagePins.jump'));
    expect(onLocate).toHaveBeenCalledWith(pins[2]);
  });

  it('keeps removal separate from navigation', () => {
    const onLocate = vi.fn();
    const onUnpin = vi.fn();
    const pins = [pin('u1', 'deck_current')];
    render(<MessagePinsBar pins={pins} currentSessionName="deck_current" onLocate={onLocate} onUnpin={onUnpin} />);
    fireEvent.click(screen.getByTestId('message-pins-trigger'));
    fireEvent.click(screen.getByLabelText('messagePins.unpin'));
    expect(onUnpin).toHaveBeenCalledWith(pins[0]);
    expect(onLocate).not.toHaveBeenCalled();
  });

  it('keeps the compact entry visible with a zero count', () => {
    render(<MessagePinsBar pins={[]} currentSessionName="deck_current" onLocate={vi.fn()} onUnpin={vi.fn()} />);
    expect(screen.getByTestId('message-pins-trigger').textContent).toBe('📌0/0');
  });

  it('defaults to the chat renderer and can switch to plain text', () => {
    function Harness() {
      const [mode, setMode] = useState<'rendered' | 'text'>('rendered');
      return (
        <MessagePinsBar
          pins={[pin('a1', 'deck_current')]}
          currentSessionName="deck_current"
          onLocate={vi.fn()}
          onUnpin={vi.fn()}
          previewMode={mode}
          onPreviewModeChange={setMode}
          renderPreview={(text) => <strong data-testid="rendered-preview">rendered: {text}</strong>}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByTestId('message-pins-trigger'));
    fireEvent.click(screen.getByText('pinned a1'));

    expect(screen.getByTestId('rendered-preview').textContent).toBe('rendered: pinned a1');
    expect(screen.getByRole('button', { name: 'messagePins.renderedMode' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'messagePins.textMode' }));
    expect(screen.queryByTestId('rendered-preview')).toBeNull();
    expect(document.querySelector('pre.zoom-text-content')?.textContent).toBe('pinned a1');
    expect(screen.getByRole('button', { name: 'messagePins.textMode' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('closes the expanded list when clicking outside the pin control', async () => {
    render(<MessagePinsBar pins={[pin('u1', 'deck_current')]} currentSessionName="deck_current" onLocate={vi.fn()} onUnpin={vi.fn()} />);
    const trigger = screen.getByTestId('message-pins-trigger');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(document.body);
    await waitFor(() => {
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByText('pinned u1')).toBeNull();
    });
  });
});
