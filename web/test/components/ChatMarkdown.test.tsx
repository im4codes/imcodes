import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/preact';

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

describe('ChatMarkdown', () => {
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
});
