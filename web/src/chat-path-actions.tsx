import { h, type ComponentChildren } from 'preact';
import { isHtmlPreviewPath } from '@shared/html-preview.js';

export interface ChatPathActionLabels {
  download: string;
  htmlPreview: string;
}

export interface ChatPathActionHandlers {
  onPathClick?: (path: string) => void;
  onDownload?: (path: string) => void;
  onHtmlPreview?: (path: string) => void;
}

export interface ChatPathActionOptions {
  key?: string | number;
  path: string;
  children?: ComponentChildren;
  content?: ComponentChildren;
  asCode?: boolean;
  code?: boolean;
  pathClass?: string;
  labels?: ChatPathActionLabels;
  handlers?: ChatPathActionHandlers;
  onPathClick?: (path: string) => void;
  onDownload?: (path: string) => void;
  onHtmlPreview?: (path: string) => void;
  downloadLabel?: string;
  htmlPreviewLabel?: string;
}

export function chatPathHasFileExtension(path: string): boolean {
  const basename = path.split(/[/\\]/).pop() ?? '';
  return /\.\w{1,10}$/.test(basename);
}

export function isLikelyDomainPath(value: string): boolean {
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/|$)/i.test(value);
}

export function isLocalChatPath(path: string): boolean {
  const value = path.trim().replace(/^`+|`+$/g, '');
  if (!value) return false;
  if (isLikelyDomainPath(value)) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (/^mailto:/i.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[/\\]/i.test(value)) return false;
  return true;
}

export function canRenderHtmlPreviewAction(
  path: string,
  handlers: ChatPathActionHandlers,
): boolean {
  return !!handlers.onPathClick && !!handlers.onHtmlPreview && isLocalChatPath(path) && isHtmlPreviewPath(path);
}

export function renderChatPathActions({
  key,
  path,
  children,
  content,
  asCode = false,
  code,
  pathClass,
  labels,
  handlers,
  onPathClick,
  onDownload,
  onHtmlPreview,
  downloadLabel,
  htmlPreviewLabel,
}: ChatPathActionOptions): h.JSX.Element {
  const resolvedHandlers = handlers ?? { onPathClick, onDownload, onHtmlPreview };
  const resolvedLabels = labels ?? {
    download: downloadLabel ?? '',
    htmlPreview: htmlPreviewLabel ?? '',
  };
  const nodeContent = children ?? content ?? path;
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

  return (
    <span key={key} class="chat-path-actions">
      {pathLabel}
      {showDownload && (
        <button
          type="button"
          class="chat-dl-btn"
          title={resolvedLabels.download}
          aria-label={resolvedLabels.download}
          onClick={(e: Event) => {
            e.stopPropagation();
            resolvedHandlers.onDownload?.(path);
          }}
        >
          ⬇
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
  );
}
