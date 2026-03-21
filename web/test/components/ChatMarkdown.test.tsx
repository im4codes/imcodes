import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
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
