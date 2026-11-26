import { h } from 'preact';
import { fireEvent, render } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import {
  ChatLoopbackLink,
  parseLoopbackHttpTarget,
} from '../../src/components/ChatLoopbackLink.js';

describe('ChatLoopbackLink', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('recognizes only daemon-loopback HTTP targets and preserves path state', () => {
    expect(parseLoopbackHttpTarget('http://127.0.0.1:8787/docs?q=1#intro')).toEqual({
      port: 8787,
      path: '/docs?q=1#intro',
    });
    expect(parseLoopbackHttpTarget('http://localhost/')).toEqual({ port: 80, path: '/' });
    expect(parseLoopbackHttpTarget('http://app.localhost:3000/x')).toEqual({ port: 3000, path: '/x' });
    expect(parseLoopbackHttpTarget('https://localhost:8787/')).toBeNull();
    expect(parseLoopbackHttpTarget('http://192.168.2.10:8787/')).toBeNull();
    expect(parseLoopbackHttpTarget('http://example.test/')).toBeNull();
  });

  it('opens the existing local-web-preview host for the link and primary action', () => {
    const onOpenLocalWebPreview = vi.fn();

    const { container } = render(
      <ChatLoopbackLink href="http://127.0.0.1:8787/docs?q=1" onOpenLocalWebPreview={onOpenLocalWebPreview}>
        local app
      </ChatLoopbackLink>,
    );

    expect(container.querySelectorAll('.chat-loopback-action')).toHaveLength(2);
    fireEvent.click(container.querySelector('.chat-external-link') as HTMLAnchorElement);
    expect(onOpenLocalWebPreview).toHaveBeenLastCalledWith({ port: 8787, path: '/docs?q=1' });

    fireEvent.click(container.querySelector('.chat-loopback-action.is-proxy') as HTMLButtonElement);
    expect(onOpenLocalWebPreview).toHaveBeenCalledTimes(2);
    expect(onOpenLocalWebPreview).toHaveBeenLastCalledWith({ port: 8787, path: '/docs?q=1' });
  });

  it('keeps direct opening explicit and does not create a proxy', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onOpenLocalWebPreview = vi.fn();
    const href = 'http://localhost:8787/';
    const { container } = render(
      <ChatLoopbackLink href={href} onOpenLocalWebPreview={onOpenLocalWebPreview}>local app</ChatLoopbackLink>,
    );

    const direct = container.querySelectorAll('.chat-loopback-action')[1] as HTMLButtonElement;
    fireEvent.click(direct);

    expect(open).toHaveBeenCalledWith(href, '_blank', 'noopener,noreferrer');
    expect(onOpenLocalWebPreview).not.toHaveBeenCalled();
  });

  it('leaves ordinary external links on the existing confirmation path', () => {
    const onUrlClick = vi.fn();
    const { container } = render(
      <ChatLoopbackLink href="https://example.test/docs" onOpenLocalWebPreview={() => {}} onUrlClick={onUrlClick}>
        docs
      </ChatLoopbackLink>,
    );

    expect(container.querySelector('.chat-loopback-actions')).toBeNull();
    fireEvent.click(container.querySelector('a') as HTMLAnchorElement);
    expect(onUrlClick).toHaveBeenCalledWith('https://example.test/docs');
  });
});
