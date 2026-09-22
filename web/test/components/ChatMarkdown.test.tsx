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
  it('adds preview and direct actions to detected loopback links when the preview host is available', () => {
    const { container } = render(
      <ChatMarkdown
        text="本机访问：http://127.0.0.1:8787/"
        onOpenLocalWebPreview={() => {}}
        onUrlClick={() => {}}
      />,
    );

    expect(container.querySelector('.chat-loopback-link')).not.toBeNull();
    expect(container.querySelectorAll('.chat-loopback-action')).toHaveLength(2);
  });

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

  it('keeps an ambiguous daemon resolution visible after a successful download', async () => {
    const onDownload = vi.fn().mockResolvedValue('resolved newest of 2: /repo/new/report.pdf');
    const { container } = render(
      <ChatMarkdown text="report.pdf" onPathClick={() => {}} onDownload={onDownload} />,
    );
    const button = container.querySelector('.chat-dl-btn') as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(button.title).toBe('resolved newest of 2: /repo/new/report.pdf');
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
    ['absolute POSIX', '[release notes](/Users/k/output/release.pdf)', '/Users/k/output/release.pdf'],
    ['spaces and parentheses', '[final report](</Users/k/My Files/report (final).pdf>)', '/Users/k/My Files/report (final).pdf'],
    ['percent encoding', '[季度报告](/Users/k/My%20Files/%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A.pdf)', '/Users/k/My Files/季度报告.pdf'],
    ['non-ASCII', '[设计稿](</Users/k/交付/最终设计稿.pdf>)', '/Users/k/交付/最终设计稿.pdf'],
    ['Windows drive', String.raw`[Windows report](<C:\Users\K\My Files\report (final).pdf>)`, String.raw`C:\Users\K\My Files\report (final).pdf`],
  ])('keeps only the display name visible and passes the decoded full path for %s links', (_name, text, expectedPath) => {
    const onPathClick = vi.fn();
    const onDownload = vi.fn();
    const { container } = render(
      <ChatMarkdown
        text={text}
        onPathClick={onPathClick}
        onDownload={onDownload}
      />,
    );

    const link = container.querySelector('.chat-path-link') as HTMLElement | null;
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe(text.slice(1, text.indexOf(']')));
    expect(container.textContent).not.toContain(expectedPath);
    fireEvent.click(link!);
    expect(onPathClick).toHaveBeenCalledWith(expectedPath);

    const download = container.querySelector('.chat-dl-btn') as HTMLButtonElement | null;
    expect(download).not.toBeNull();
    fireEvent.click(download!);
    expect(onDownload).toHaveBeenCalledWith(expectedPath);
  });

  it.each([
    [
      'a Windows hidden-directory destination',
      String.raw`[artifact](C:\Users\k\.imcodes\uploads\a.png)`,
      String.raw`C:\Users\k\.imcodes\uploads\a.png`,
      'artifact',
    ],
    [
      'an angle-wrapped Windows destination containing spaces',
      String.raw`[artifact](<C:\Users\k\.imcodes\My Files\a.png>)`,
      String.raw`C:\Users\k\.imcodes\My Files\a.png`,
      'artifact',
    ],
    [
      'a POSIX destination containing spaces without angle brackets',
      '[报告](/Users/k/My Docs/报告.pdf)',
      '/Users/k/My Docs/报告.pdf',
      '报告',
    ],
    [
      'a Linux hidden directory and CJK underscore filename',
      '[企享云外贸财税申报管理系统_代码.pdf](/home/ai/.imcodes/交付包/企享云外贸财税申报管理系统_代码.pdf)',
      '/home/ai/.imcodes/交付包/企享云外贸财税申报管理系统_代码.pdf',
      '企享云外贸财税申报管理系统_代码.pdf',
    ],
    [
      'an NFD Linux filename',
      `[NFD](</home/ai/.work/${'留住彼此'.normalize('NFD')}_代码.pdf>)`,
      `/home/ai/.work/${'留住彼此'.normalize('NFD')}_代码.pdf`,
      'NFD',
    ],
    [
      'a literal percent decoded exactly once',
      '[percent](/home/ai/交付包/完成率100%25_代码.pdf)',
      '/home/ai/交付包/完成率100%_代码.pdf',
      'percent',
    ],
  ])('preserves the exact local path from %s', (_name, text, expectedPath, expectedLabel) => {
    const onPathClick = vi.fn();
    const onDownload = vi.fn();
    const { container } = render(
      <ChatMarkdown
        text={text}
        onPathClick={onPathClick}
        onDownload={onDownload}
      />,
    );

    const link = container.querySelector('.chat-path-link') as HTMLElement | null;
    expect(link?.textContent).toBe(expectedLabel);
    fireEvent.click(link!);
    expect(onPathClick).toHaveBeenCalledWith(expectedPath);
    fireEvent.click(container.querySelector('.chat-dl-btn') as HTMLButtonElement);
    expect(onDownload).toHaveBeenCalledWith(expectedPath);
  });

  it.each([
    ['relative Markdown', '[报告](dist/报告.pdf)', 'dist/报告.pdf'],
    ['relative Markdown image', '![预览](images/结果.png)', 'images/结果.png'],
    ['local file URL', '[报告](file:///home/ai/%E4%BA%A4%E4%BB%98/report.pdf)', '/home/ai/交付/report.pdf'],
    ['bare filename', '请下载 report.pdf', 'report.pdf'],
    ['source line suffix', '源码在 ./src/report.ts:42:7。', './src/report.ts'],
    ['trailing Chinese punctuation', '文件：../交付/报告.pdf，', '../交付/报告.pdf'],
    ['full-width parentheses', '文件：./交付/报告（最终）.pdf。', './交付/报告（最终）.pdf'],
  ])('supports non-contract %s file references', (_label, text, expectedPath) => {
    const onDownload = vi.fn();
    const { container } = render(
      <ChatMarkdown text={text} onPathClick={() => {}} onDownload={onDownload} />,
    );
    const button = container.querySelector('.chat-dl-btn') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onDownload).toHaveBeenCalledWith(expectedPath);
  });

  it('keeps remote file URLs outside local file actions', () => {
    const { container } = render(
      <ChatMarkdown
        text="[remote](file://server/share/a.pdf) and example.com"
        onPathClick={() => {}}
        onDownload={() => {}}
      />,
    );
    expect(container.querySelector('.chat-dl-btn')).toBeNull();
  });

  it('keeps UNC link and image destinations out of local file actions', () => {
    const { container } = render(
      <ChatMarkdown
        text={String.raw`[share](\\server\share\report.pdf) ![image](\\server\share\image.png)`}
        onPathClick={() => {}}
        onDownload={() => {}}
        onImagePreview={() => Promise.resolve('data:image/png;base64,aW1n')}
      />,
    );

    expect(container.querySelector('.chat-path-link')).toBeNull();
    expect(container.querySelector('.chat-dl-btn')).toBeNull();
    expect(container.querySelector('.chat-local-image-preview')).toBeNull();
  });

  it.each([
    ['plain standalone path', '/home/ai/.work/我的 报告_代码.pdf'],
    ['backticked path', '`/home/ai/.work/我的 报告_代码.pdf`'],
  ])('keeps the complete Linux CJK path for %s', (_name, text) => {
    const expectedPath = '/home/ai/.work/我的 报告_代码.pdf';
    const onDownload = vi.fn();
    const { container } = render(
      <ChatMarkdown text={text} onPathClick={() => {}} onDownload={onDownload} />,
    );

    expect(container.querySelector('.chat-path-link')?.textContent).toBe(expectedPath);
    fireEvent.click(container.querySelector('.chat-dl-btn') as HTMLButtonElement);
    expect(onDownload).toHaveBeenCalledWith(expectedPath);
  });

  it.each([
    [
      'Windows hidden directory',
      String.raw`![preview](C:\Users\k\.hidden\renders\a.png)`,
      String.raw`C:\Users\k\.hidden\renders\a.png`,
    ],
    [
      'unwrapped POSIX spaces',
      '![预览](/Users/k/My Renders/成品.png)',
      '/Users/k/My Renders/成品.png',
    ],
  ])('preserves the exact local image path for %s', (_name, text, expectedPath) => {
    const onDownload = vi.fn();
    const onImagePreview = vi.fn().mockResolvedValue('data:image/png;base64,aW1n');
    const { container } = render(
      <ChatMarkdown
        text={text}
        onPathClick={() => {}}
        onDownload={onDownload}
        onImagePreview={onImagePreview}
      />,
    );

    expect(onImagePreview).toHaveBeenCalledWith(expectedPath);
    fireEvent.click(container.querySelector('.chat-dl-btn') as HTMLButtonElement);
    expect(onDownload).toHaveBeenCalledWith(expectedPath);
  });

  it('does not normalize markdown-looking local links inside inline or fenced code', () => {
    const markdownLookingPath = '[报告](/Users/k/My Docs/报告.pdf)';
    const { container } = render(
      <ChatMarkdown
        text={`\`${markdownLookingPath}\`\n\n\`\`\`text\n${markdownLookingPath}\n\`\`\``}
        onPathClick={() => {}}
        onDownload={() => {}}
      />,
    );

    expect(container.querySelector('.chat-inline-code')?.textContent).toContain(markdownLookingPath);
    const codeBlockText = container.querySelector('.chat-code-block code')?.textContent ?? '';
    expect(codeBlockText).toContain('[报告](/Users/k/My Docs/报告.pdf');
    expect(Array.from(container.querySelectorAll('.chat-path-link')).some((node) => node.textContent === '报告')).toBe(false);
  });

  it('preserves decoded full-path actions inside list, table, blockquote, and bold markdown', () => {
    const onDownload = vi.fn();
    const paths = [
      '/Users/k/My Files/list.pdf',
      '/Users/k/My Files/table.pdf',
      '/Users/k/My Files/quote.pdf',
      '/Users/k/My Files/bold.pdf',
    ];
    const text = [
      '- [list](</Users/k/My Files/list.pdf>)',
      '',
      '| artifact |',
      '| --- |',
      '| [table](/Users/k/My%20Files/table.pdf) |',
      '',
      '> [quote](</Users/k/My Files/quote.pdf>)',
      '',
      '**[bold](/Users/k/My%20Files/bold.pdf)**',
    ].join('\n');
    const { container } = render(
      <ChatMarkdown text={text} onPathClick={() => {}} onDownload={onDownload} />,
    );

    expect(Array.from(container.querySelectorAll('.chat-path-link')).map((node) => node.textContent))
      .toEqual(['list', 'table', 'quote', 'bold']);
    const buttons = container.querySelectorAll('.chat-dl-btn');
    expect(buttons).toHaveLength(paths.length);
    buttons.forEach((button) => fireEvent.click(button));
    expect(onDownload.mock.calls.map(([path]) => path)).toEqual(paths);
  });

  it('keeps HTTP markdown links external and bare or backticked paths on their existing path flow', () => {
    const onUrlClick = vi.fn();
    const onDownload = vi.fn();
    const { container } = render(
      <ChatMarkdown
        text={'[site](https://example.test/file.pdf)\n\nBare /Users/k/out/bare.pdf and `/Users/k/out/code.pdf`'}
        onPathClick={() => {}}
        onUrlClick={onUrlClick}
        onDownload={onDownload}
      />,
    );

    expect(container.querySelector('.chat-external-link')?.textContent).toBe('site');
    expect(Array.from(container.querySelectorAll('.chat-path-link')).map((node) => node.textContent))
      .toEqual(['/Users/k/out/bare.pdf', '/Users/k/out/code.pdf']);
    expect(container.querySelectorAll('.chat-dl-btn')).toHaveLength(2);
  });

  it('does not turn a percent-encoded HTTP destination into a local file action', () => {
    const { container } = render(
      <ChatMarkdown
        text="[encoded site](%68%74%74%70%73%3A%2F%2Fexample.test%2Ffile.pdf)"
        onPathClick={() => {}}
        onUrlClick={() => {}}
        onDownload={() => {}}
      />,
    );

    expect(container.querySelector('.chat-path-link')).toBeNull();
    expect(container.querySelector('.chat-dl-btn')).toBeNull();
    expect(container.querySelector('.chat-external-link')?.textContent).toBe('encoded site');
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

  it('renders local image paths inline and reuses the shared lightbox zoom', async () => {
    const onImagePreview = vi.fn().mockResolvedValue({
      dataUrl: 'data:image/png;base64,aW1n',
      alt: 'result.png',
    });
    const { container } = render(
      <ChatMarkdown
        text="Open ./screenshots/result.png"
        onPathClick={() => {}}
        onImagePreview={onImagePreview}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('.chat-local-image-preview-img')).not.toBeNull();
    });
    expect(onImagePreview).toHaveBeenCalledWith('./screenshots/result.png');

    const image = container.querySelector('.chat-local-image-preview-img') as HTMLImageElement;
    expect(image.src).toBe('data:image/png;base64,aW1n');

    // tsk_5rf R2: a resolved URL is no longer treated as a loaded image, so the
    // preview stays in its loading phase until the real load event. jsdom never
    // loads images on its own, so fire it here exactly as a browser would
    // before the thumbnail becomes interactive.
    fireEvent.load(image);
    await waitFor(() => expect(container.querySelector('.chat-local-image-preview-loading')).toBeNull());

    fireEvent.click(image);
    expect(container.querySelector('.fb-lightbox')).not.toBeNull();
    fireEvent.keyDown(container.querySelector('.fb-lightbox') as HTMLDivElement, { key: 'Escape' });
    expect(container.querySelector('.fb-lightbox')).toBeNull();

    fireEvent.click(image);
    expect(container.querySelector('.fb-lightbox')).not.toBeNull();
    fireEvent.click(container.querySelector('.fb-lightbox-close') as HTMLButtonElement);
    expect(container.querySelector('.fb-lightbox')).toBeNull();
  });

  it('renders local markdown image links through the same inline preview path', async () => {
    const onImagePreview = vi.fn().mockResolvedValue('data:image/webp;base64,d2VicA==');
    const { container } = render(
      <ChatMarkdown
        text="![rendered preview](./out/page.webp)"
        onPathClick={() => {}}
        onImagePreview={onImagePreview}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('.chat-local-image-preview-img')).not.toBeNull();
    });
    expect(container.querySelector('.chat-path-link')?.textContent).toBe('rendered preview');
    expect(onImagePreview).toHaveBeenCalledWith('./out/page.webp');
  });

  it('decodes the full path for a local markdown image preview while keeping its alt text visible', async () => {
    const onImagePreview = vi.fn().mockResolvedValue('data:image/png;base64,aW1n');
    const onDownload = vi.fn();
    const { container } = render(
      <ChatMarkdown
        text="![rendered image](</Users/k/My Files/%E6%88%90%E5%93%81 (1).png>)"
        onPathClick={() => {}}
        onDownload={onDownload}
        onImagePreview={onImagePreview}
      />,
    );

    await waitFor(() => expect(onImagePreview).toHaveBeenCalled());
    expect(container.querySelector('.chat-path-link')?.textContent).toBe('rendered image');
    expect(container.textContent).not.toContain('/Users/k/My Files/成品 (1).png');
    expect(onImagePreview).toHaveBeenCalledWith('/Users/k/My Files/成品 (1).png');
    fireEvent.click(container.querySelector('.chat-dl-btn') as HTMLButtonElement);
    expect(onDownload).toHaveBeenCalledWith('/Users/k/My Files/成品 (1).png');
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
