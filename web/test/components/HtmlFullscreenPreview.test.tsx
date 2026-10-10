/** @vitest-environment jsdom */
import { useState } from 'preact/hooks';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HtmlFullscreenPreview,
  type HtmlFullscreenPreviewState,
} from '../../src/components/HtmlFullscreenPreview.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const htmlPreview: HtmlFullscreenPreviewState = {
  status: 'ok',
  path: '/tmp/preview.html',
  content: '<!doctype html><h1>kept content</h1>',
};

let createObjectUrlDescriptor: PropertyDescriptor | undefined;
let revokeObjectUrlDescriptor: PropertyDescriptor | undefined;
const createObjectURL = vi.fn(() => 'blob:html-preview-token');
const revokeObjectURL = vi.fn();

beforeEach(() => {
  createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  if (createObjectUrlDescriptor) Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor);
  else delete (URL as typeof URL & { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
  if (revokeObjectUrlDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor);
  else delete (URL as typeof URL & { revokeObjectURL?: typeof URL.revokeObjectURL }).revokeObjectURL;
});

function previewOwner() {
  function Owner() {
    const [preview, setPreview] = useState<HtmlFullscreenPreviewState | null>(htmlPreview);
    return <>
      {preview && <span data-testid="preview-owner">origin</span>}
      <HtmlFullscreenPreview preview={preview} onClose={() => setPreview(null)} />
    </>;
  }
  return render(<Owner />);
}

function openedWindow() {
  let load: EventListener | undefined;
  const opened = {
    opener: window,
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === 'load') load = listener;
    }),
  } as unknown as Window;
  return {
    opened,
    load: () => load?.(new Event('load')),
  };
}

describe('HtmlFullscreenPreview new-window lifecycle', () => {
  it('closes the owner only after confirmed creation and retains the blob token until the child loads', () => {
    vi.useFakeTimers();
    const child = openedWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(child.opened);
    const view = previewOwner();

    fireEvent.click(view.getByRole('button', { name: 'chat.html_preview_open_new_window' }));

    expect(open).toHaveBeenCalledWith('blob:html-preview-token', '_blank');
    expect(child.opened.opener).toBeNull();
    expect(view.queryByTestId('preview-owner')).toBeNull();
    expect(document.querySelector('.html-fullscreen-preview')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    view.unmount();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    act(() => child.load());
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:html-preview-token');
    act(() => vi.runAllTimers());
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['popup block', () => null],
    ['window.open failure', () => { throw new Error('open failed'); }],
  ])('preserves the originating preview on %s and releases the unused token', (_label, result) => {
    vi.spyOn(window, 'open').mockImplementation(result as () => Window | null);
    const view = previewOwner();

    fireEvent.click(view.getByRole('button', { name: 'chat.html_preview_open_new_window' }));

    expect(view.getByTestId('preview-owner')).toBeDefined();
    expect(document.querySelector('.html-fullscreen-preview')).not.toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:html-preview-token');
  });

  it.each(['returns null', 'throws'] as const)(
    're-arms after window.open %s so a later success closes exactly once',
    (failure) => {
      const child = openedWindow();
      const open = vi.spyOn(window, 'open').mockReturnValue(child.opened);
      if (failure === 'returns null') open.mockReturnValueOnce(null);
      else open.mockImplementationOnce(() => { throw new Error('open failed'); });
      const onClose = vi.fn();
      const view = render(<HtmlFullscreenPreview preview={htmlPreview} onClose={onClose} />);
      const button = view.getByRole('button', { name: 'chat.html_preview_open_new_window' });

      fireEvent.click(button);
      expect(open).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
      expect(document.querySelector('.html-fullscreen-preview')).not.toBeNull();

      fireEvent.click(button);
      expect(open).toHaveBeenCalledTimes(2);
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it('coalesces duplicate activation while the confirmed owner close is pending', () => {
    const child = openedWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(child.opened);
    const onClose = vi.fn();
    const view = render(<HtmlFullscreenPreview preview={htmlPreview} onClose={onClose} />);
    const button = view.getByRole('button', { name: 'chat.html_preview_open_new_window' });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(open).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('re-arms when the same mounted host receives a new preview after a successful close', () => {
    const firstChild = openedWindow();
    const secondChild = openedWindow();
    const open = vi.spyOn(window, 'open')
      .mockReturnValueOnce(firstChild.opened)
      .mockReturnValueOnce(secondChild.opened);
    const onClose = vi.fn();

    function PersistentHost() {
      const [preview, setPreview] = useState<HtmlFullscreenPreviewState | null>(htmlPreview);
      return <>
        <button
          type="button"
          onClick={() => setPreview({
            status: 'ok',
            path: '/tmp/second.html',
            content: '<h1>second preview</h1>',
          })}
        >next-preview</button>
        <HtmlFullscreenPreview
          preview={preview}
          onClose={() => {
            onClose();
            setPreview(null);
          }}
        />
      </>;
    }

    const view = render(<PersistentHost />);
    fireEvent.click(view.getByRole('button', { name: 'chat.html_preview_open_new_window' }));
    expect(document.querySelector('.html-fullscreen-preview')).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(view.getByRole('button', { name: 'next-preview' }));
    const secondOpen = view.getByRole('button', { name: 'chat.html_preview_open_new_window' });
    expect(document.querySelector('.html-fullscreen-preview')).not.toBeNull();
    fireEvent.click(secondOpen);

    expect(document.querySelector('.html-fullscreen-preview')).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('supports keyboard activation in a mobile touch viewport', () => {
    const widthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    try {
      const child = openedWindow();
      const open = vi.spyOn(window, 'open').mockReturnValue(child.opened);
      const view = previewOwner();
      const button = view.getByRole('button', { name: 'chat.html_preview_open_new_window' }) as HTMLButtonElement;
      button.focus();

      fireEvent.keyDown(button, { key: 'Enter' });

      expect(open).toHaveBeenCalledTimes(1);
      expect(view.queryByTestId('preview-owner')).toBeNull();
      expect(document.activeElement).not.toBe(button);
    } finally {
      if (widthDescriptor) Object.defineProperty(window, 'innerWidth', widthDescriptor);
      if (matchMediaDescriptor) Object.defineProperty(window, 'matchMedia', matchMediaDescriptor);
      else delete (window as Window & { matchMedia?: typeof window.matchMedia }).matchMedia;
    }
  });

  it('leaves non-HTML previews on their existing path without creating a window or token', () => {
    const open = vi.spyOn(window, 'open');
    const preview: HtmlFullscreenPreviewState = {
      status: 'ok',
      path: '/tmp/readme.txt',
      content: 'plain text',
    };
    const onClose = vi.fn();
    const view = render(<HtmlFullscreenPreview preview={preview} onClose={onClose} />);
    const button = view.getByRole('button', { name: 'chat.html_preview_open_new_window' }) as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    fireEvent.click(button);

    expect(open).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('.html-fullscreen-preview')).not.toBeNull();
  });
});
