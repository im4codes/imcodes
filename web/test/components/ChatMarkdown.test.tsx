import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/preact';
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
