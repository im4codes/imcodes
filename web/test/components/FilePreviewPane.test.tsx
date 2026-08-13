/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePreviewPane } from '../../src/components/FilePreviewPane.js';
import { resolveMarkdownLocalPath } from '../../src/util/path-utils.js';

vi.mock('react-i18next', () => {
  const t = (key: string, fallback?: string) => fallback ?? key;
  return { useTranslation: () => ({ t }) };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('resolveMarkdownLocalPath', () => {
  it.each([
    ['/repo/docs/README.md', './images/flow.png', '/repo/docs/images/flow.png'],
    ['/repo/docs/README.md', '../assets/My%20Image.png#preview', '/repo/assets/My Image.png'],
    ['README.md', 'images/flow.png', 'images/flow.png'],
    ['C:\\repo\\docs\\README.md', '..\\assets\\flow.png?raw=1', 'C:\\repo\\assets\\flow.png'],
    ['C:\\repo\\docs\\README.md', '/assets/flow.png', 'C:\\assets\\flow.png'],
    ['\\\\host\\share\\docs\\README.md', '..\\flow.png', '\\\\host\\share\\flow.png'],
  ])('resolves %s + %s to %s', (markdownPath, href, expected) => {
    expect(resolveMarkdownLocalPath(markdownPath, href)).toBe(expected);
  });

  it('does not turn document-only fragments or malformed control paths into file reads', () => {
    expect(resolveMarkdownLocalPath('/repo/README.md', '#usage')).toBeNull();
    expect(resolveMarkdownLocalPath('/repo/README.md', './bad\nname.png')).toBeNull();
  });
});

describe('FilePreviewPane Markdown references', () => {
  it('opens relative file links through the resolved local file path', () => {
    const onPathClick = vi.fn();
    const { container } = render(
      <FilePreviewPane
        content="[Guide](../GUIDE.md#install)"
        path="/repo/docs/README.md"
        onPathClick={onPathClick}
      />,
    );

    fireEvent.click(container.querySelector('.chat-path-link')!);
    expect(onPathClick).toHaveBeenCalledWith('/repo/GUIDE.md');
  });

  it('loads relative images through the local preview channel and renders the result', async () => {
    const onImagePreview = vi.fn(async () => ({
      dataUrl: 'data:image/png;base64,cG5n',
      alt: 'Architecture',
    }));
    const { container } = render(
      <FilePreviewPane
        content="![Architecture](./assets/architecture.png)"
        path="/repo/docs/README.md"
        onImagePreview={onImagePreview}
      />,
    );

    await waitFor(() => {
      expect(onImagePreview).toHaveBeenCalledWith('/repo/docs/assets/architecture.png');
      expect(container.querySelector('.chat-local-image-preview-img')?.getAttribute('src'))
        .toBe('data:image/png;base64,cG5n');
    });
  });

  it('keeps external images as browser URLs without invoking local file reads', () => {
    const onImagePreview = vi.fn();
    const { container } = render(
      <FilePreviewPane
        content="![Remote](https://example.com/remote.png)"
        path="/repo/README.md"
        onImagePreview={onImagePreview}
      />,
    );

    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/remote.png');
    expect(onImagePreview).not.toHaveBeenCalled();
  });

  it('renders raw HTML as text instead of injecting it into the preview DOM', () => {
    const { container } = render(
      <FilePreviewPane content={'<img src=x onerror="alert(1)">'} path="/repo/README.md" />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});
