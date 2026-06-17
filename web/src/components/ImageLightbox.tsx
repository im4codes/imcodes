import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';

interface Props {
  src: string;
  alt?: string;
  fileName?: string;
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

function downloadImage(src: string, fileName: string) {
  const link = document.createElement('a');
  link.href = src;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
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

export function ImageLightbox({ src, alt = '', fileName, onClose }: Props) {
  const { t } = useTranslation();
  const lightboxRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextImageClickRef = useRef(false);
  const [actionsVisible, setActionsVisible] = useState(false);
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
    clearLongPressTimer();
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      suppressNextImageClickRef.current = true;
      setActionsVisible(true);
    }, IMAGE_LONG_PRESS_MS);
  };

  const handleDownload = (e: Event) => {
    e.stopPropagation();
    downloadImage(src, resolvedFileName);
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
          e.preventDefault();
          e.stopPropagation();
          clearLongPressTimer();
          setActionsVisible(true);
        }}
      />
      {actionsVisible && (
        <div class="fb-lightbox-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" class="fb-lightbox-action" onClick={handleDownload}>
            {t('chat.image_download')}
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
