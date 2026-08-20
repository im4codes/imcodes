import type { ComponentChildren } from 'preact';
import { useTranslation } from 'react-i18next';

export interface LoopbackHttpTarget {
  port: number;
  path: string;
}

export type ChatLocalWebPreviewOpenHandler = (target: LoopbackHttpTarget) => void;

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
  onOpenLocalWebPreview?: ChatLocalWebPreviewOpenHandler;
  onUrlClick?: (url: string) => void;
  children: ComponentChildren;
}

function openNewTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function ChatLoopbackLink({ href, onOpenLocalWebPreview, onUrlClick, children }: Props) {
  const { t } = useTranslation();
  const target = parseLoopbackHttpTarget(href);

  if (!target || !onOpenLocalWebPreview) {
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
          onOpenLocalWebPreview(target);
        }}
      >
        {children}
      </a>
      <span class="chat-loopback-actions">
        <button
          type="button"
          class="chat-loopback-action is-proxy"
          onClick={() => onOpenLocalWebPreview(target)}
        >
          {t('chat.local_link_proxy_open')}
        </button>
        <button
          type="button"
          class="chat-loopback-action"
          onClick={() => openNewTab(href)}
        >
          {t('chat.local_link_direct_open')}
        </button>
      </span>
    </span>
  );
}
