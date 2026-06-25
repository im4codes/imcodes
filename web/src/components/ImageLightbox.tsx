import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';

interface Props {
  src: string;
  alt?: string;
  fileName?: string;
  onDownload?: () => void | Promise<void>;
  onClose: () => void;
}

type ClipboardItemConstructor = new (items: Record<string, Blob>) => unknown;

const IMAGE_LONG_PRESS_MS = 520;

function defaultImageFileName(alt: string): string {
  const trimmed = alt.trim().split(/[/\\]/).pop()?.trim();
  return trimmed || 'image';
}

function getMimeTypeFromDataUrl(src: string): string | null {
  const match = /^data:([^;,]+)[;,]/.exec(src);
  return match?.[1] ?? null;
}

function extensionForMimeType(mimeType: string | null): string {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/svg+xml':
      return '.svg';
    case 'image/png':
    default:
      return '.png';
  }
}

function ensureImageFileName(fileName: string, mimeType: string | null): string {
  return /\.[A-Za-z0-9]{2,5}$/.test(fileName) ? fileName : `${fileName}${extensionForMimeType(mimeType)}`;
}

function saveBlobViaAnchor(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob);
  const revokeObjectURL = URL.revokeObjectURL;
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  if (typeof revokeObjectURL === 'function') {
    setTimeout(() => revokeObjectURL.call(URL, objectUrl), 0);
  }
}

async function readImageBlob(src: string): Promise<Blob> {
  const response = await fetch(src);
  return response.blob();
}

function shouldUseMobileImageActions(): boolean {
  const runtime = globalThis as typeof globalThis & { Capacitor?: { isNativePlatform?: () => boolean } };
  if (runtime.Capacitor?.isNativePlatform?.() === true) return true;
  const touchPoints = navigator.maxTouchPoints ?? 0;
  if (touchPoints <= 0) return false;
  const coarsePointer = typeof matchMedia === 'function'
    && matchMedia('(pointer: coarse)').matches;
  return coarsePointer || innerWidth < 900;
}

async function downloadImage(src: string, fileName: string) {
  const inferredMimeType = getMimeTypeFromDataUrl(src);
  const blob = await readImageBlob(src);
  saveBlobViaAnchor(blob, ensureImageFileName(fileName, blob.type || inferredMimeType));
}

async function copyImageToClipboard(src: string) {
  const clipboard = navigator.clipboard as (Clipboard & { write?: (items: unknown[]) => Promise<void> }) | undefined;
  const clipboardItemCtor = (globalThis as typeof globalThis & { ClipboardItem?: ClipboardItemConstructor }).ClipboardItem;
  if (clipboard?.write && clipboardItemCtor) {
    const response = await fetch(src);
    const blob = await response.blob();
    const mimeType = blob.type || getMimeTypeFromDataUrl(src) || 'image/png';
    await clipboard.write([new clipboardItemCtor({ [mimeType]: blob })]);
    return;
  }
  if (clipboard?.writeText) {
    await clipboard.writeText(src);
    return;
  }
  throw new Error('clipboard_unavailable');
}

export function ImageLightbox({ src, alt = '', fileName, onDownload, onClose }: Props) {
  const { t } = useTranslation();
  const lightboxRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextImageClickRef = useRef(false);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [downloadState, setDownloadState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [copyState, setCopyState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const resolvedFileName = fileName || defaultImageFileName(alt);

  useEffect(() => {
    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    lightboxRef.current?.focus();
    return () => {
      previousActiveElement?.focus?.();
    };
  }, []);

  useEffect(() => () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
  }, []);

  const clearLongPressTimer = () => {
    if (!longPressTimerRef.current) return;
    clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  const startLongPress = () => {
    if (!shouldUseMobileImageActions()) return;
    clearLongPressTimer();
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      suppressNextImageClickRef.current = true;
      setActionsVisible(true);
    }, IMAGE_LONG_PRESS_MS);
  };

  const handleDownload = (e: Event) => {
    e.stopPropagation();
    setDownloadState('busy');
    Promise.resolve(onDownload ? onDownload() : downloadImage(src, resolvedFileName))
      .then(() => {
        setDownloadState('done');
      })
      .catch(() => {
        setDownloadState('error');
      });
  };

  const handleCopy = (e: Event) => {
    e.stopPropagation();
    setCopyState('busy');
    copyImageToClipboard(src)
      .then(() => {
        setCopyState('done');
      })
      .catch(() => {
        setCopyState('error');
      });
  };

  const copyLabel = copyState === 'done'
    ? t('chat.image_copied')
    : copyState === 'error'
      ? t('chat.image_copy_failed')
      : t('chat.image_copy');
  const downloadLabel = downloadState === 'busy'
    ? t('chat.image_downloading')
    : downloadState === 'done'
      ? t('chat.image_downloaded')
      : downloadState === 'error'
        ? t('chat.image_download_failed')
        : t('chat.image_download');

  return (
    <div
      ref={lightboxRef}
      class="fb-lightbox"
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <img
        src={src}
        alt={alt}
        onClick={(e) => {
          e.stopPropagation();
          if (suppressNextImageClickRef.current) {
            suppressNextImageClickRef.current = false;
          }
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          startLongPress();
        }}
        onMouseUp={clearLongPressTimer}
        onMouseLeave={clearLongPressTimer}
        onTouchStart={(e) => {
          e.stopPropagation();
          startLongPress();
        }}
        onTouchEnd={clearLongPressTimer}
        onTouchMove={clearLongPressTimer}
        onContextMenu={(e) => {
          if (!shouldUseMobileImageActions()) return;
          e.preventDefault();
          e.stopPropagation();
          clearLongPressTimer();
          setActionsVisible(true);
        }}
      />
      {actionsVisible && (
        <div class="fb-lightbox-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            class={`fb-lightbox-action${downloadState === 'error' ? ' is-error' : ''}`}
            onClick={handleDownload}
            disabled={downloadState === 'busy'}
          >
            {downloadLabel}
          </button>
          <button
            type="button"
            class={`fb-lightbox-action${copyState === 'error' ? ' is-error' : ''}`}
            onClick={handleCopy}
            disabled={copyState === 'busy'}
          >
            {copyLabel}
          </button>
        </div>
      )}
      <button type="button" class="fb-lightbox-close" onClick={onClose}>✕</button>
    </div>
  );
}
