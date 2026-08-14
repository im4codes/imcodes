/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePreviewPane } from '../../src/components/FilePreviewPane.js';
import { resolveMarkdownLocalPath } from '../../src/util/path-utils.js';
import { isLocalChatPath } from '../../src/chat-path-actions.js';

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
    ['/repo/docs/README.md', './assets/My%20Image%23final.png?preview=1', '/repo/docs/assets/My Image#final.png'],
    ['/repo/docs/README.md', '/repo/docs/images/flow.png', '/repo/docs/images/flow.png'],
    ['README.md', 'images/flow.png', 'images/flow.png'],
    ['C:\\repo\\docs\\README.md', '.\\assets\\flow.png?raw=1', 'C:\\repo\\docs\\assets\\flow.png'],
    ['C:\\repo\\docs\\README.md', 'C:\\repo\\docs\\flow.png', 'C:\\repo\\docs\\flow.png'],
  ])('resolves %s + %s to %s', (markdownPath, href, expected) => {
    expect(resolveMarkdownLocalPath(markdownPath, href)).toBe(expected);
  });

  it('allows parent references inside an explicit project root but not outside it', () => {
    expect(resolveMarkdownLocalPath('/repo/docs/README.md', '../assets/logo.png', '/repo'))
      .toBe('/repo/assets/logo.png');
    expect(resolveMarkdownLocalPath('/repo/docs/README.md', '../../etc/shadow', '/repo'))
      .toBeNull();
    expect(resolveMarkdownLocalPath('C:\\Repo\\docs\\README.md', '..\\assets\\logo.png', 'c:\\repo'))
      .toBe('C:\\Repo\\assets\\logo.png');
    expect(resolveMarkdownLocalPath('/repo-other/docs/README.md', './logo.png', '/repo'))
      .toBeNull();
  });

  it.each([
    ['#usage'],
    ['./bad\nname.png'],
    ['//attacker.example/share/logo.png'],
    ['\\\\attacker.example\\share\\logo.png'],
    ['../outside.png'],
    ['..%2f..%2fetc%2fshadow'],
    ['%2e%2e%5cWindows%5cwin.ini'],
    ['~/.ssh/id_rsa'],
    ['%7e%2f.ssh%2fid_rsa'],
    [':session-root:/secret.png'],
    ['\\\\?\\C:\\Windows\\win.ini'],
  ])('rejects unsafe local reference %s', (href) => {
    expect(resolveMarkdownLocalPath('/repo/docs/README.md', href)).toBeNull();
  });

  it('never classifies protocol-relative web URLs or UNC paths as local chat paths', () => {
    expect(isLocalChatPath('//cdn.example.com/logo.png')).toBe(false);
    expect(isLocalChatPath('\\\\server\\share\\logo.png')).toBe(false);
  });
});

describe('FilePreviewPane Markdown references', () => {
  it('opens relative file links through the resolved local file path', () => {
    const onPathClick = vi.fn();
    const { container } = render(
      <FilePreviewPane
        content="[Guide](../GUIDE.md#install)"
        path="/repo/docs/README.md"
        allowedRootPath="/repo"
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

  it('keeps protocol-relative images on the browser path without invoking local file reads', () => {
    const onImagePreview = vi.fn();
    const { container } = render(
      <FilePreviewPane
        content="![CDN](//cdn.example.com/logo.png)"
        path="C:\\repo\\docs\\README.md"
        onImagePreview={onImagePreview}
      />,
    );

    expect(container.querySelector('img')?.getAttribute('src')).toBe('//cdn.example.com/logo.png');
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
