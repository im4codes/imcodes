/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZoomedTextDialog } from '../../src/components/ZoomedTextDialog.js';

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  if (originalClipboardDescriptor) Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  else delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
  if (originalExecCommandDescriptor) Object.defineProperty(document, 'execCommand', originalExecCommandDescriptor);
  else delete (document as unknown as { execCommand?: (commandId: string) => boolean }).execCommand;
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
  it('copies only the zoomed message when Safari falls back from the Clipboard API', async () => {
    const setData = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        const event = new Event('copy', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: { setData } });
        document.dispatchEvent(event);
        return true;
      }),
    });

    render(
      <>
        <div>attachment and sidebar chrome</div>
        <ZoomedTextDialog text={'Only this message\nwith two lines'} onClose={vi.fn()} />
      </>,
    );
    const ambientRange = document.createRange();
    ambientRange.selectNodeContents(document.body);
    window.getSelection()?.addRange(ambientRange);

    fireEvent.click(screen.getByText('chat.zoom_copy_all'));

    await waitFor(() => {
      expect(setData).toHaveBeenCalledWith('text/plain', 'Only this message\nwith two lines');
      expect(screen.getByText('common.copied')).toBeTruthy();
    });
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    // Portalled to <body>, so the fallback textarea (if any) would live there.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('shows Copy and Quote actions for selected text', async () => {
    const onQuote = vi.fn();
    const onClose = vi.fn();
    render(
      <ZoomedTextDialog text="Alpha beta gamma" onClose={onClose} onQuote={onQuote} />,
    );

    const content = document.querySelector('.zoom-text-content')!;
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
  it('renders into <body> so the app bar cannot cover it', () => {
    // The overlay is `position: fixed; z-index: 9999`, but rendered inside the
    // chat subtree that number only ranks it among its own siblings.
    // `.mobile-server-bar` sits at z-index 6500 much higher up the tree, so the
    // dialog — its header and close button included — ended up underneath the
    // app bar. Only a body-level portal puts the 9999 where it can win.
    const { container } = render(
      <ZoomedTextDialog text="hello" onClose={vi.fn()} />,
    );

    expect(container.querySelector('.zoom-text-dialog')).toBeNull();
    const overlay = document.querySelector('.zoom-text-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay?.parentElement).toBe(document.body);
    expect(document.querySelector('.zoom-text-close')).toBeTruthy();
  });
});
