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
  localStorage.removeItem('message_pin_preview_height');
  localStorage.removeItem('message_pin_preview_width');
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

function firePointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: MouseEventInit & { pointerId: number },
) {
  // jsdom does not provide PointerEvent. A MouseEvent with the same event name
  // plus pointerId exercises Preact's real pointer-handler wiring.
  const eventName = type === 'pointerdown'
    && target instanceof Element
    && !('onpointerdown' in target)
    ? 'PointerDown'
    : type;
  const event = new MouseEvent(eventName, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId });
  fireEvent(target, event);
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

  it('persists pinned-preview width and height without closing after resize', async () => {
    const onClose = vi.fn();
    render(
      <ZoomedTextDialog
        text="resizable preview"
        onClose={onClose}
        messagePreviewLayout
      />,
    );

    const dialog = document.querySelector<HTMLElement>('.zoom-text-dialog-message-preview')!;
    const initialWidth = Number.parseInt(dialog.style.width, 10);
    const initialHeight = Number.parseInt(dialog.style.height, 10);
    expect(initialWidth).toBeGreaterThanOrEqual(320);
    expect(initialHeight).toBeGreaterThanOrEqual(280);
    dialog.getBoundingClientRect = () => ({
      width: initialWidth,
      height: initialHeight,
      top: 0,
      left: 0,
      right: initialWidth,
      bottom: initialHeight,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const handle = document.querySelector('.zoom-text-resize-handle.is-corner')!;
    firePointer(handle, 'pointerdown', { button: 0, pointerId: 7, clientX: 500, clientY: 300 });
    firePointer(document, 'pointermove', { pointerId: 7, clientX: 540, clientY: 330 });
    firePointer(document, 'pointerup', { pointerId: 7, clientX: 540, clientY: 330 });

    await waitFor(() => {
      expect(localStorage.getItem('message_pin_preview_width')).toBe(String(initialWidth + 80));
      expect(localStorage.getItem('message_pin_preview_height')).toBe(String(initialHeight + 60));
      expect(dialog.style.width).toBe(`${initialWidth + 80}px`);
      expect(dialog.style.height).toBe(`${initialHeight + 60}px`);
    });

    fireEvent.click(document.querySelector('.zoom-text-overlay')!);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('.zoom-text-dialog')).toBeTruthy();
  });

  it('still closes on an ordinary outside click', () => {
    const onClose = vi.fn();
    render(<ZoomedTextDialog text="outside close" onClose={onClose} messagePreviewLayout />);

    fireEvent.click(document.querySelector('.zoom-text-overlay')!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('supports independent width-only and height-only resize handles', async () => {
    render(<ZoomedTextDialog text="axis resize" onClose={vi.fn()} messagePreviewLayout />);
    const dialog = document.querySelector<HTMLElement>('.zoom-text-dialog-message-preview')!;
    const rect = () => {
      const width = Number.parseInt(dialog.style.width, 10);
      const height = Number.parseInt(dialog.style.height, 10);
      return {
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    };
    dialog.getBoundingClientRect = rect;
    const initial = rect();

    const rightHandle = document.querySelector('.zoom-text-resize-handle.is-right')!;
    firePointer(rightHandle, 'pointerdown', { button: 0, pointerId: 8, clientX: 500, clientY: 300 });
    firePointer(document, 'pointerup', { pointerId: 8, clientX: 530, clientY: 390 });
    await waitFor(() => {
      expect(dialog.style.width).toBe(`${initial.width + 60}px`);
      expect(dialog.style.height).toBe(`${initial.height}px`);
    });

    const afterWidth = rect();
    const bottomHandle = document.querySelector('.zoom-text-resize-handle.is-bottom')!;
    firePointer(bottomHandle, 'pointerdown', { button: 0, pointerId: 9, clientX: 500, clientY: 300 });
    firePointer(document, 'pointerup', { pointerId: 9, clientX: 380, clientY: 325 });
    await waitFor(() => {
      expect(dialog.style.width).toBe(`${afterWidth.width}px`);
      expect(dialog.style.height).toBe(`${afterWidth.height + 50}px`);
    });
  });
});
