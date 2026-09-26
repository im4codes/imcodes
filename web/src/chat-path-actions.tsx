import { h, type ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { isHtmlPreviewPath } from '@shared/html-preview.js';
import {
  chatPathHasFileExtension,
  isLikelyDomainPath,
  isLocalChatPath,
} from '@shared/chat-local-path.js';
import {
  ChatLocalImagePreview,
  type ChatLocalImagePreviewLoader,
} from './components/ChatLocalImagePreview.js';

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
  labels?: ChatPathActionLabels;
  handlers?: ChatPathActionHandlers;
  onPathClick?: (path: string) => void;
  onDownload?: ChatPathDownloadHandler;
  onHtmlPreview?: (path: string) => void;
  onImagePreview?: ChatLocalImagePreviewLoader;
  downloadLabel?: string;
  htmlPreviewLabel?: string;
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
  const showImagePreview = !!resolvedHandlers.onImagePreview && isLocalChatPath(path) && isImagePreviewPath(path);
  const downloadTitle = downloadState === 'error' && downloadError
    ? downloadError
    : downloadResult || resolvedLabels.download;

  return (
    <>
      <span class="chat-path-actions">
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
