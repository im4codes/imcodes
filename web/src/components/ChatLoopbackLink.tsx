import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  buildLocalWebPreviewProxyUrl,
  createLocalWebPreview,
} from '../api.js';

export interface LoopbackHttpTarget {
  port: number;
  path: string;
}

/**
 * Only loopback HTTP links can be safely mapped to the daemon's local preview
 * relay. Private-LAN addresses are deliberately excluded: their target is
 * already unambiguous and rewriting them through the daemon could reach a
 * different machine than the browser would.
 */
export function parseLoopbackHttpTarget(value: string): LoopbackHttpTarget | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:') return null;
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === '127.0.0.1'
      || hostname === '[::1]';
    if (!loopback) return null;
    const port = url.port ? Number(url.port) : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { port, path: `${url.pathname || '/'}${url.search}${url.hash}` };
  } catch {
    return null;
  }
}

interface Props {
  href: string;
  serverId?: string;
  onUrlClick?: (url: string) => void;
  children: ComponentChildren;
}

function openNewTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function ChatLoopbackLink({ href, serverId, onUrlClick, children }: Props) {
  const { t } = useTranslation();
  const target = parseLoopbackHttpTarget(href);
  const [openingProxy, setOpeningProxy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openProxy = async () => {
    if (!target || !serverId || openingProxy) return;
    setOpeningProxy(true);
    setError(null);

    // Reserve the tab while this trusted click is still on the browser's user
    // activation stack. Opening only after the POST resolves is blocked by
    // Safari and by stricter Chromium popup settings.
    const pendingTab = window.open('about:blank', '_blank');
    if (pendingTab) pendingTab.opener = null;
    try {
      const preview = await createLocalWebPreview(serverId, target.port, target.path);
      const proxyUrl = buildLocalWebPreviewProxyUrl(
        serverId,
        preview.previewId,
        target.path,
        preview.previewAccessToken,
      );
      if (pendingTab && !pendingTab.closed) {
        pendingTab.location.replace(proxyUrl);
      } else {
        openNewTab(proxyUrl);
      }
    } catch (err) {
      pendingTab?.close();
      setError(err instanceof Error && err.message
        ? err.message
        : t('chat.local_link_proxy_failed'));
    } finally {
      setOpeningProxy(false);
    }
  };

  if (!target || !serverId) {
    return (
      <a
        class="chat-external-link"
        href={href}
        title={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event: Event) => {
          if (!onUrlClick) return;
          event.preventDefault();
          onUrlClick(href);
        }}
      >
        {children}
      </a>
    );
  }

  return (
    <span class="chat-loopback-link">
      <a
        class="chat-external-link"
        href={href}
        title={t('chat.local_link_proxy_default')}
        onClick={(event: Event) => {
          event.preventDefault();
          void openProxy();
        }}
      >
        {children}
      </a>
      <span class="chat-loopback-actions">
        <button
          type="button"
          class="chat-loopback-action is-proxy"
          disabled={openingProxy}
          onClick={() => void openProxy()}
        >
          {openingProxy ? t('chat.local_link_proxy_opening') : t('chat.local_link_proxy_open')}
        </button>
        <button
          type="button"
          class="chat-loopback-action"
          onClick={() => openNewTab(href)}
        >
          {t('chat.local_link_direct_open')}
        </button>
      </span>
      {error && <span class="chat-loopback-error" role="alert">{error}</span>}
    </span>
  );
}
