import { h } from 'preact';
import { fireEvent, render, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createLocalWebPreview = vi.fn();
const buildLocalWebPreviewProxyUrl = vi.fn();

vi.mock('../../src/api.js', () => ({
  createLocalWebPreview: (...args: unknown[]) => createLocalWebPreview(...args),
  buildLocalWebPreviewProxyUrl: (...args: unknown[]) => buildLocalWebPreviewProxyUrl(...args),
}));

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
    createLocalWebPreview.mockReset();
    buildLocalWebPreviewProxyUrl.mockReset();
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

  it('uses the IM.codes preview relay for the link and primary action', async () => {
    const replace = vi.fn();
    const pendingTab = {
      closed: false,
      close: vi.fn(),
      location: { replace },
      opener: {} as Window | null,
    };
    const open = vi.spyOn(window, 'open').mockReturnValue(pendingTab as unknown as Window);
    createLocalWebPreview.mockResolvedValue({
      previewId: 'preview-1',
      previewAccessToken: 'access-1',
    });
    buildLocalWebPreviewProxyUrl.mockReturnValue('https://im.example/api/server/s1/local-web/preview-1/docs');

    const { container } = render(
      <ChatLoopbackLink href="http://127.0.0.1:8787/docs?q=1" serverId="s1">
        local app
      </ChatLoopbackLink>,
    );

    expect(container.querySelectorAll('.chat-loopback-action')).toHaveLength(2);
    fireEvent.click(container.querySelector('.chat-external-link') as HTMLAnchorElement);

    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => {
      expect(createLocalWebPreview).toHaveBeenCalledWith('s1', 8787, '/docs?q=1');
      expect(replace).toHaveBeenCalledWith('https://im.example/api/server/s1/local-web/preview-1/docs');
    });
    expect(buildLocalWebPreviewProxyUrl).toHaveBeenCalledWith(
      's1',
      'preview-1',
      '/docs?q=1',
      'access-1',
    );
  });

  it('keeps direct opening explicit and does not create a proxy', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const href = 'http://localhost:8787/';
    const { container } = render(
      <ChatLoopbackLink href={href} serverId="s1">local app</ChatLoopbackLink>,
    );

    const direct = container.querySelectorAll('.chat-loopback-action')[1] as HTMLButtonElement;
    fireEvent.click(direct);

    expect(open).toHaveBeenCalledWith(href, '_blank', 'noopener,noreferrer');
    expect(createLocalWebPreview).not.toHaveBeenCalled();
  });

  it('leaves ordinary external links on the existing confirmation path', () => {
    const onUrlClick = vi.fn();
    const { container } = render(
      <ChatLoopbackLink href="https://example.test/docs" serverId="s1" onUrlClick={onUrlClick}>
        docs
      </ChatLoopbackLink>,
    );

    expect(container.querySelector('.chat-loopback-actions')).toBeNull();
    fireEvent.click(container.querySelector('a') as HTMLAnchorElement);
    expect(onUrlClick).toHaveBeenCalledWith('https://example.test/docs');
    expect(createLocalWebPreview).not.toHaveBeenCalled();
  });
});
