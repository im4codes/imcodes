import { h, type ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { isHtmlPreviewPath } from '@shared/html-preview.js';
import {
  chatPathHasFileExtension,
  isLikelyDomainPath,
  isLocalChatPath,
} from '@shared/chat-local-path.js';
import {
  splitPlainTextByCloudDocIds,
  splitTextByCloudDocQuoteTags,
  type CloudDocTextSegment,
} from './cloud-docs-reference.js';
import {
  formatRemoteDesktopCitation,
  splitTextByRemoteDesktopCitations,
} from '@shared/remote-desktop-reference.js';
import { splitTextByHttpUrls } from './link-detection.js';
import {
  ChatLocalImagePreview,
  type ChatLocalImagePreviewLoader,
} from './components/ChatLocalImagePreview.js';
import {
  ChatLoopbackLink,
  type ChatLocalWebPreviewOpenHandler,
} from './components/ChatLoopbackLink.js';

export type ChatPathDownloadHandler = (path: string) => void | string | Promise<void | string>;

export interface ChatPathActionLabels {
  download: string;
  htmlPreview: string;
}

export interface ChatPathActionHandlers {
  onPathClick?: (path: string) => void;
  onDownload?: ChatPathDownloadHandler;
  onHtmlPreview?: (path: string) => void;
  onImagePreview?: ChatLocalImagePreviewLoader;
}

export interface ChatPathActionOptions {
  key?: string | number;
  path: string;
  children?: ComponentChildren;
  content?: ComponentChildren;
  asCode?: boolean;
  code?: boolean;
  pathClass?: string;
  compactPathBadge?: boolean;
  badgePrefix?: string;
  hideInlineImagePreview?: boolean;
  labels?: ChatPathActionLabels;
  handlers?: ChatPathActionHandlers;
  onPathClick?: (path: string) => void;
  onDownload?: ChatPathDownloadHandler;
  onHtmlPreview?: (path: string) => void;
  onImagePreview?: ChatLocalImagePreviewLoader;
  downloadLabel?: string;
  htmlPreviewLabel?: string;
}

export function chatPathBasename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

const IMAGE_PREVIEW_EXTENSIONS = new Set([
  'apng',
  'avif',
  'bmp',
  'gif',
  'ico',
  'jpg',
  'jpeg',
  'png',
  'svg',
  'webp',
]);

export { chatPathHasFileExtension, isLikelyDomainPath, isLocalChatPath };

export function isImagePreviewPath(path: string): boolean {
  const basename = path.split(/[/\\]/).pop() ?? '';
  const match = /\.([a-z0-9]{1,10})(?:[?#].*)?$/i.exec(basename);
  return !!match && IMAGE_PREVIEW_EXTENSIONS.has(match[1].toLowerCase());
}

export function canRenderHtmlPreviewAction(
  path: string,
  handlers: ChatPathActionHandlers,
): boolean {
  return !!handlers.onPathClick && !!handlers.onHtmlPreview && isLocalChatPath(path) && isHtmlPreviewPath(path);
}

function ChatPathActions({
  path,
  children,
  content,
  asCode = false,
  code,
  pathClass,
  compactPathBadge = false,
  badgePrefix,
  hideInlineImagePreview = false,
  labels,
  handlers,
  onPathClick,
  onDownload,
  onHtmlPreview,
  onImagePreview,
  downloadLabel,
  htmlPreviewLabel,
}: ChatPathActionOptions): h.JSX.Element {
  const [downloadState, setDownloadState] = useState<'idle' | 'busy' | 'error'>('idle');
  const [downloadError, setDownloadError] = useState('');
  const [downloadResult, setDownloadResult] = useState('');
  const resolvedHandlers = handlers ?? { onPathClick, onDownload, onHtmlPreview, onImagePreview };
  const resolvedLabels = labels ?? {
    download: downloadLabel ?? '',
    htmlPreview: htmlPreviewLabel ?? '',
  };
  const nodeContent = children ?? content ?? (compactPathBadge ? chatPathBasename(path) : path);
  const shouldRenderCode = asCode || code;
  const resolvedPathClass = pathClass ?? (shouldRenderCode ? 'chat-inline-code chat-path-link' : 'chat-path-link');
  const pathLabel = resolvedHandlers.onPathClick
    ? shouldRenderCode
      ? <code class={resolvedPathClass} onClick={() => resolvedHandlers.onPathClick?.(path)} title={path}>{nodeContent}</code>
      : <span class={resolvedPathClass} onClick={() => resolvedHandlers.onPathClick?.(path)} title={path}>{nodeContent}</span>
    : shouldRenderCode
      ? <code class={resolvedPathClass} title={path}>{nodeContent}</code>
      : <span class={resolvedPathClass} title={path}>{nodeContent}</span>;
  const showDownload = !!resolvedHandlers.onDownload && chatPathHasFileExtension(path);
  const showHtmlPreview = canRenderHtmlPreviewAction(path, resolvedHandlers);
  const showImagePreview = !hideInlineImagePreview && !!resolvedHandlers.onImagePreview && isLocalChatPath(path) && isImagePreviewPath(path);
  const downloadTitle = downloadState === 'error' && downloadError
    ? downloadError
    : downloadResult || resolvedLabels.download;
  const actionsClass = compactPathBadge ? 'chat-path-actions chat-path-actions-badge' : 'chat-path-actions';

  return (
    <>
      <span class={actionsClass}>
        {compactPathBadge && badgePrefix && (
          <span class="chat-path-badge-index">{badgePrefix}</span>
        )}
        {pathLabel}
        {showDownload && (
          <button
            type="button"
            class={`chat-dl-btn${downloadState === 'busy' ? ' is-busy' : ''}${downloadState === 'error' ? ' is-error' : ''}`}
            title={downloadTitle}
            aria-label={downloadTitle}
            aria-busy={downloadState === 'busy'}
            disabled={downloadState === 'busy'}
            onClick={async (e: Event) => {
              e.stopPropagation();
              if (!resolvedHandlers.onDownload) return;
              setDownloadState('busy');
              setDownloadError('');
              setDownloadResult('');
              try {
                const result = await resolvedHandlers.onDownload(path);
                if (typeof result === 'string') setDownloadResult(result);
                setDownloadState('idle');
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                setDownloadError(message || resolvedLabels.download);
                setDownloadState('error');
              }
            }}
          >
            {downloadState === 'busy' ? '…' : downloadState === 'error' ? '!' : '⬇'}
          </button>
        )}
        {showHtmlPreview && (
          <button
            type="button"
            class="chat-dl-btn chat-html-preview-btn"
            title={resolvedLabels.htmlPreview}
            aria-label={resolvedLabels.htmlPreview}
            onClick={(e: Event) => {
              e.stopPropagation();
              resolvedHandlers.onHtmlPreview?.(path);
            }}
          >
            👁
          </button>
        )}
      </span>
      {showImagePreview && resolvedHandlers.onImagePreview && (
        <ChatLocalImagePreview
          path={path}
          loadImagePreview={resolvedHandlers.onImagePreview}
          onDownload={resolvedHandlers.onDownload
            ? async (downloadPath) => { await resolvedHandlers.onDownload?.(downloadPath); }
            : undefined}
        />
      )}
    </>
  );
}

export function renderChatPathActions(options: ChatPathActionOptions): h.JSX.Element {
  const { key, ...rest } = options;
  return <ChatPathActions key={key} {...rest} />;
}

export interface ChatCloudDocActionOptions {
  key?: string | number;
  docId: string;
  content: ComponentChildren;
  kind?: CloudDocTextSegment['kind'];
  code?: boolean;
  onCloudDocClick?: (docId: string) => void;
}

/** Render a clickable Cloud Doc chip or inline reference without local-file download/preview chrome. */
export function renderCloudDocAction({
  key,
  docId,
  content,
  kind = 'id',
  code = false,
  onCloudDocClick,
}: ChatCloudDocActionOptions): h.JSX.Element {
  const labelText = typeof content === 'string' ? content : docId;
  const title = kind === 'quote'
    ? `[CloudDoc: ${labelText} | id=${docId}]`
    : docId;
  const handleActivate = (e: Event) => {
    if (!onCloudDocClick) return;
    e.stopPropagation();
    onCloudDocClick(docId);
  };
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!onCloudDocClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      onCloudDocClick(docId);
    }
  };

  if (kind === 'quote') {
    return (
      <button
        key={key}
        type="button"
        class="chat-cloud-doc-chip"
        data-testid="chat-cloud-doc-link"
        data-cloud-doc-id={docId}
        data-cloud-doc-kind={kind}
        title={title}
        aria-label={title}
        disabled={!onCloudDocClick}
        onClick={handleActivate}
      >
        <svg class="chat-cloud-doc-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M5.5 3.5h7.25L16.5 7.25V19a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19V5a1.5 1.5 0 0 1 1.5-1.5Z"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linejoin="round"
          />
          <path d="M12.5 3.75v3.5h3.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          <path
            d="M15.7 9.8h4.2a2.1 2.1 0 0 0 .25-4.18 2.85 2.85 0 0 0-5.4-.52A2.35 2.35 0 0 0 15.7 9.8Z"
            fill="#38bdf8"
            stroke="#0f172a"
            stroke-width="1.2"
            stroke-linejoin="round"
          />
        </svg>
        <span class="chat-cloud-doc-label">{content}</span>
      </button>
    );
  }

  const className = code
    ? `chat-inline-code chat-cloud-doc-link${onCloudDocClick ? ' is-clickable' : ''}`
    : `chat-cloud-doc-link${onCloudDocClick ? ' is-clickable' : ''}`;

  if (code) {
    return (
      <code
        key={key}
        role={onCloudDocClick ? 'button' : undefined}
        tabIndex={onCloudDocClick ? 0 : undefined}
        class={className}
        data-testid="chat-cloud-doc-link"
        data-cloud-doc-id={docId}
        data-cloud-doc-kind={kind}
        title={title}
        onClick={handleActivate}
        onKeyDown={handleKeyDown}
      >
        {content}
      </code>
    );
  }

  return (
    <span
      key={key}
      role={onCloudDocClick ? 'button' : undefined}
      tabIndex={onCloudDocClick ? 0 : undefined}
      class={className}
      data-testid="chat-cloud-doc-link"
      data-cloud-doc-id={docId}
      data-cloud-doc-kind={kind}
      title={title}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
    >
      {content}
    </span>
  );
}

export interface ChatRemoteDesktopActionOptions {
  key?: string | number;
  targetId: string;
  content: ComponentChildren;
  onRemoteDesktopClick?: (targetId: string) => void;
}

/** Render a clickable Remote Desktop chip for `[RemoteDesktop: <name> | id=<id>]` references. */
export function renderRemoteDesktopAction({
  key,
  targetId,
  content,
  onRemoteDesktopClick,
}: ChatRemoteDesktopActionOptions): h.JSX.Element {
  const labelText = typeof content === 'string' ? content : targetId;
  const title = formatRemoteDesktopCitation(labelText, targetId);
  const handleActivate = (e: Event) => {
    if (!onRemoteDesktopClick) return;
    e.stopPropagation();
    onRemoteDesktopClick(targetId);
  };

  return (
    <button
      key={key}
      type="button"
      class="chat-remote-desktop-chip"
      data-testid="chat-remote-desktop-link"
      data-remote-desktop-id={targetId}
      title={title}
      aria-label={title}
      disabled={!onRemoteDesktopClick}
      onClick={handleActivate}
    >
      <svg class="chat-remote-desktop-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.8" />
        <path d="M8 20h8M12 16v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
      <span class="chat-remote-desktop-label">{content}</span>
    </button>
  );
}

/**
 * Split plain text by Cloud Doc quote tags, Remote Desktop citation tags,
 * HTTP(S) URLs, `cdoc_...` IDs, and filenames paired with `cdoc_...`,
 * delegating only remaining non-URL text chunks to `renderPlainText` for local path detection.
 */
export function splitTextWithCloudDocsAndUrls(
  text: string,
  options: {
    onCloudDocClick?: (docId: string) => void;
    onRemoteDesktopClick?: (targetId: string) => void;
    onUrlClick?: (url: string) => void;
    onOpenLocalWebPreview?: ChatLocalWebPreviewOpenHandler;
    omitEmptyFallback?: boolean;
    renderPlainText: (chunkText: string, baseOffset: number) => h.JSX.Element[];
  },
): h.JSX.Element[] {
  const parts: h.JSX.Element[] = [];
  for (const quoteSeg of splitTextByCloudDocQuoteTags(text)) {
    if (quoteSeg.type === 'cloud_doc' && quoteSeg.docId) {
      parts.push(renderCloudDocAction({
        key: `cdq${quoteSeg.start}`,
        docId: quoteSeg.docId,
        content: quoteSeg.label ?? quoteSeg.value,
        kind: 'quote',
        onCloudDocClick: options.onCloudDocClick,
      }));
      continue;
    }

    for (const rdSeg of splitTextByRemoteDesktopCitations(quoteSeg.value)) {
      const rdBase = quoteSeg.start + rdSeg.start;
      if (rdSeg.type === 'remote_desktop' && rdSeg.targetId) {
        parts.push(renderRemoteDesktopAction({
          key: `rd${rdBase}`,
          targetId: rdSeg.targetId,
          content: rdSeg.label ?? rdSeg.value,
          onRemoteDesktopClick: options.onRemoteDesktopClick,
        }));
        continue;
      }

      for (const urlChunk of splitTextByHttpUrls(rdSeg.value)) {
        const urlBase = rdBase + urlChunk.start;
        if (urlChunk.type === 'url') {
          parts.push(
            <ChatLoopbackLink
              key={`u${urlBase}`}
              href={urlChunk.value}
              onOpenLocalWebPreview={options.onOpenLocalWebPreview}
              onUrlClick={options.onUrlClick}
            >
              {urlChunk.value}
            </ChatLoopbackLink>,
          );
          continue;
        }

        for (const idSeg of splitPlainTextByCloudDocIds(urlChunk.value)) {
          const segBase = urlBase + idSeg.start;
          if (idSeg.type === 'cloud_doc' && idSeg.docId) {
            parts.push(renderCloudDocAction({
              key: `cd${segBase}`,
              docId: idSeg.docId,
              content: idSeg.label ?? idSeg.value,
              kind: idSeg.kind ?? 'id',
              onCloudDocClick: options.onCloudDocClick,
            }));
          } else {
            parts.push(...options.renderPlainText(idSeg.value, segBase));
          }
        }
      }
    }
  }
  return parts.length || options.omitEmptyFallback ? parts : [<span>{text}</span>];
}
