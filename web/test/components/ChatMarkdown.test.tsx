import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/preact';

// ChatMarkdown's CodeBlock uses react-i18next for the per-block copy button's
// tooltip. The runtime build aliases react → preact/compat via @preact/preset-vite,
// but vitest doesn't, so loading react-i18next directly crashes on its bare
// `import 'react'`. Mock to a no-op translator — the tests below don't assert
// on tooltip text.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const parts = key.split('.');
      return parts[parts.length - 1];
    },
  }),
}));

import { ChatMarkdown } from '../../src/components/ChatMarkdown';
import { RICH_TEXT_ENHANCEMENT_CHAR_LIMIT } from '../../src/chat-render-limits';

describe('ChatMarkdown', () => {
  it('renders oversized text without markdown parsing', () => {
    const text = `# ${'large message '.repeat(Math.ceil(RICH_TEXT_ENHANCEMENT_CHAR_LIMIT / 14))}`;
    const { container } = render(<ChatMarkdown text={text} />);

    expect(container.querySelector('h1')).toBeNull();
    expect(container.textContent).toBe(text);
  });

  it('detects relative paths with dots', () => {
    const { container } = render(
      <ChatMarkdown 
        text="Check ../src/main.ts and ./README.md" 
        onPathClick={() => {}}
      />
    );
    const links = container.querySelectorAll('.chat-path-link');
    expect(links.length).toBe(2);
    expect(links[0].textContent).toBe('../src/main.ts');
    expect(links[1].textContent).toBe('./README.md');
  });

  it('detects paths inside backtick code spans', () => {
    const clicked: string[] = [];
    const { container } = render(
      <ChatMarkdown
        text="生成完毕：`~/.openclaw-ppt/projects/digital-town/output/digital-town.pdf`"
        onPathClick={(p) => clicked.push(p)}
      />
    );
    const links = container.querySelectorAll('.chat-path-link');
    expect(links.length).toBe(1);
    expect(links[0].textContent).toBe('~/.openclaw-ppt/projects/digital-town/output/digital-town.pdf');
    // Should also have inline-code styling
    expect(links[0].classList.contains('chat-inline-code')).toBe(true);
  });

  it('renders a download button for plain file paths and calls onDownload', () => {
    const onDownload = vi.fn();
    const { container } = render(
      <ChatMarkdown
        text="Open ./README.md"
        onPathClick={() => {}}
        onDownload={onDownload}
      />
    );

    const button = container.querySelector('.chat-dl-btn') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onDownload).toHaveBeenCalledWith('./README.md');
  });

  it('shows download progress and failure state for async path downloads', async () => {
    const onDownload = vi.fn().mockRejectedValue(new Error('missing download handle'));
    const { container } = render(
      <ChatMarkdown
        text="Open ./missing.pdf"
        onPathClick={() => {}}
        onDownload={onDownload}
      />
    );

    const button = container.querySelector('.chat-dl-btn') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    fireEvent.click(button!);

    expect(button!.disabled).toBe(true);
    expect(button!.textContent).toBe('…');
    await waitFor(() => expect(button!.disabled).toBe(false));
    expect(button!.classList.contains('is-error')).toBe(true);
    expect(button!.textContent).toBe('!');
    expect(button!.title).toBe('missing download handle');
  });

  it('renders a download button for backtick file paths and calls onDownload', () => {
    const onDownload = vi.fn();
    const { container } = render(
      <ChatMarkdown
        text="生成完毕：`./dist/report.pdf`"
        onPathClick={() => {}}
        onDownload={onDownload}
      />
    );

    const button = container.querySelector('.chat-dl-btn') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onDownload).toHaveBeenCalledWith('./dist/report.pdf');
  });

  it('detects file paths inside bash code blocks and preserves preview/download actions', () => {
    const clicked: string[] = [];
    const onDownload = vi.fn();
    const { container } = render(
      <ChatMarkdown
        text={'```bash\n/home/big/Desktop/拼团经济模型v1.0.docx\n```'}
        onPathClick={(path) => clicked.push(path)}
        onDownload={onDownload}
      />
    );

    const pathLink = container.querySelector('.chat-code-block .chat-path-link') as HTMLElement | null;
    expect(pathLink).not.toBeNull();
    expect(pathLink?.textContent).toBe('/home/big/Desktop/拼团经济模型v1.0.docx');
    fireEvent.click(pathLink!);
    expect(clicked).toEqual(['/home/big/Desktop/拼团经济模型v1.0.docx']);

    const button = container.querySelector('.chat-code-block .chat-dl-btn') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onDownload).toHaveBeenCalledWith('/home/big/Desktop/拼团经济模型v1.0.docx');
  });


  it('code block copy button copies only the original code text, not rendered links or download buttons', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const { container } = render(
      <ChatMarkdown
        text={'```bash\n/home/big/Desktop/拼团经济模型v1.0.docx\n```'}
        onPathClick={() => {}}
        onDownload={() => {}}
      />
    );

    expect(container.querySelector('.chat-code-block .chat-path-link')).not.toBeNull();
    expect(container.querySelector('.chat-code-block .chat-dl-btn')).not.toBeNull();

    const copyButton = container.querySelector('.chat-code-copy-btn') as HTMLButtonElement | null;
    expect(copyButton).not.toBeNull();
    fireEvent.click(copyButton!);

    expect(writeText).toHaveBeenCalledWith('/home/big/Desktop/拼团经济模型v1.0.docx');
  });

  it('places the code block copy button next to the language title', () => {
    const { container } = render(
      <ChatMarkdown text={'```bash\necho hi\n```'} />
    );

    const titlebar = container.querySelector('.chat-code-titlebar');
    const lang = titlebar?.querySelector('.chat-code-lang');
    const copyButton = titlebar?.querySelector('.chat-code-copy-btn');

    expect(titlebar).not.toBeNull();
    expect(lang?.textContent).toBe('bash');
    expect(copyButton).not.toBeNull();
  });

  it('renders a download button for local markdown links with file extensions', () => {
    const onDownload = vi.fn();
    const { container } = render(
      <ChatMarkdown
        text="[report](./dist/report.pdf)"
        onPathClick={() => {}}
        onDownload={onDownload}
      />
    );

    const button = container.querySelector('.chat-dl-btn') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onDownload).toHaveBeenCalledWith('./dist/report.pdf');
  });

  it.each([
    ['plain text path', 'Open ./dist/index.html', './dist/index.html'],
    ['markdown link', '[preview](./dist/INDEX.HTML)', './dist/INDEX.HTML'],
    ['code span', 'Open `./dist/index.htm`', './dist/index.htm'],
    ['fenced code block', '```bash\n./dist/index.html\n```', './dist/index.html'],
  ])('renders download then HTML preview actions for %s', (_name, text, expectedPath) => {
    const onDownload = vi.fn();
    const onHtmlPreview = vi.fn();
    const { container } = render(
      <ChatMarkdown
        text={text}
        onPathClick={() => {}}
        onDownload={onDownload}
        onHtmlPreview={onHtmlPreview}
      />,
    );

    const action = container.querySelector('.chat-path-actions') as HTMLElement | null;
    expect(action).not.toBeNull();
    const children = Array.from(action!.children);
    expect(children[0].classList.contains('chat-path-link')).toBe(true);
    expect(children[1].classList.contains('chat-dl-btn')).toBe(true);
    expect(children[2].classList.contains('chat-html-preview-btn')).toBe(true);

    fireEvent.click(children[1] as HTMLButtonElement);
    expect(onDownload).toHaveBeenCalledWith(expectedPath);
    fireEvent.click(children[2] as HTMLButtonElement);
    expect(onHtmlPreview).toHaveBeenCalledWith(expectedPath);
  });

  it('does not render HTML preview for non-HTML paths or without a preview callback', () => {
    const withNonHtml = render(
      <ChatMarkdown
        text="Open ./dist/readme.md"
        onPathClick={() => {}}
        onHtmlPreview={() => {}}
      />,
    );
    expect(withNonHtml.container.querySelector('.chat-html-preview-btn')).toBeNull();

    const withoutCallback = render(
      <ChatMarkdown
        text="Open ./dist/index.html"
        onPathClick={() => {}}
        onDownload={() => {}}
      />,
    );
    expect(withoutCallback.container.querySelector('.chat-html-preview-btn')).toBeNull();
  });

  it('does not detect paths inside URLs', () => {
    const { container } = render(
      <ChatMarkdown 
        text="Visit https://example.com/some/path" 
        onPathClick={() => {}}
      />
    );
    const pathLinks = container.querySelectorAll('.chat-path-link');
    expect(pathLinks.length).toBe(0);
    const externalLinks = container.querySelectorAll('.chat-external-link');
    expect(externalLinks.length).toBe(1);
  });

  it('keeps public mp4 URLs followed by the download glyph as external links', () => {
    const url = 'https://media.example.test/public-results/pixelle/demo-video.mp4';
    const text = `公网链接：${url}⬇为什么被标记为内部链接了, 这不是http url吗?`;
    const { container } = render(
      <ChatMarkdown
        text={text}
        onPathClick={() => {}}
        onUrlClick={() => {}}
        onDownload={() => {}}
      />
    );

    const externalLink = container.querySelector('.chat-external-link') as HTMLAnchorElement | null;
    expect(externalLink).not.toBeNull();
    expect(externalLink?.textContent).toBe(url);
    expect(externalLink?.href).toBe(url);
    expect(container.textContent).toContain('⬇为什么被标记为内部链接了');
    expect(container.querySelector('.chat-path-link')).toBeNull();
    expect(container.querySelector('.chat-dl-btn')).toBeNull();
  });

  it('keeps public rich mp4 URLs as external links before path detection', () => {
    const url = 'https://media.example.test/public-results/pixelle/demo-video-rich.mp4';
    const { container } = render(
      <ChatMarkdown
        text={url}
        onPathClick={() => {}}
        onUrlClick={() => {}}
        onDownload={() => {}}
      />
    );

    const externalLink = container.querySelector('.chat-external-link') as HTMLAnchorElement | null;
    expect(externalLink).not.toBeNull();
    expect(externalLink?.textContent).toBe(url);
    expect(externalLink?.href).toBe(url);
    expect(container.querySelector('.chat-path-link')).toBeNull();
    expect(container.querySelector('.chat-dl-btn')).toBeNull();
  });

  it('keeps backticked public URLs external instead of previewable local paths', () => {
    const url = 'https://media.example.test/public-results/pixelle/demo-video-rich.mp4';
    const { container } = render(
      <ChatMarkdown
        text={`\`${url}\``}
        onPathClick={() => {}}
        onUrlClick={() => {}}
        onDownload={() => {}}
      />
    );

    const externalLink = container.querySelector('.chat-external-link') as HTMLAnchorElement | null;
    expect(externalLink).not.toBeNull();
    expect(externalLink?.textContent).toBe(url);
    expect(container.querySelector('.chat-path-link')).toBeNull();
    expect(container.querySelector('.chat-dl-btn')).toBeNull();
  });
});
