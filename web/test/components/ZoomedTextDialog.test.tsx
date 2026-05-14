/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZoomedTextDialog } from '../../src/components/ZoomedTextDialog.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});

function selectText(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

describe('ZoomedTextDialog', () => {
  it('shows Copy and Quote actions for selected text', async () => {
    const onQuote = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <ZoomedTextDialog text="Alpha beta gamma" onClose={onClose} onQuote={onQuote} />,
    );

    const content = container.querySelector('.zoom-text-content')!;
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      selectText(content.firstChild!, 6, 10);
    });

    await waitFor(() => {
      expect(screen.getByText('common.copy')).toBeTruthy();
      expect(screen.getByText('common.quote')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('common.quote'));

    expect(onQuote).toHaveBeenCalledWith('beta');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
