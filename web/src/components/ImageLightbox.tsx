import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { shareBlobOrDownload } from '../browser-download.js';

interface Props {
  src: string;
  alt?: string;
  fileName?: string;
  onDownload?: () => void | Promise<void>;
  onClose: () => void;
  /** Page to the previous/next image. Omit to render a lightbox with no paging. */
  onNavigate?: (direction: -1 | 1) => void;
  canPrev?: boolean;
  canNext?: boolean;
}

type ClipboardItemConstructor = new (items: Record<string, Blob>) => unknown;

const IMAGE_LONG_PRESS_MS = 520;

/**
 * Vertical travel, in px, that commits a drag-to-dismiss.
 *
 * The gesture is deliberately vertical-only. Horizontal swiping is the most
 * ingrained "next photo" gesture there is, and dismissing on it would make
 * every attempt to page through the gallery close the viewer instead.
 */
const DISMISS_DRAG_THRESHOLD_PX = 96;

/**
 * How much more vertical than horizontal a drag must be before it counts as a
 * dismiss. Without this a slightly-off horizontal swipe reads as a dismiss.
 */
const DISMISS_DRAG_AXIS_RATIO = 1.4;

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
  await shareBlobOrDownload(blob, ensureImageFileName(fileName, blob.type || inferredMimeType));
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

export function ImageLightbox({ src, alt = '', fileName, onDownload, onClose, onNavigate, canPrev = false, canNext = false }: Props) {
  const { t } = useTranslation();
  const lightboxRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  // Mirrors dragOffset for the imperative listeners, which close over the
  // effect's first render and would otherwise always read 0 at touchend.
  const dragOffsetRef = useRef(0);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextImageClickRef = useRef(false);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  dragOffsetRef.current = dragOffset;
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragAxisRef = useRef<'undecided' | 'vertical' | 'horizontal'>('undecided');
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

  // Keys are bound on the window rather than the lightbox element. The element
  // is `tabIndex={-1}` with no focus trap, so clicking the download or copy
  // button moves focus off it and an element-scoped handler would go dead --
  // exactly when a user is most likely to reach for the arrow keys next.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (!onNavigate) return;
      if (e.key === 'ArrowLeft' && canPrev) {
        e.preventDefault();
        e.stopPropagation();
        onNavigate(-1);
        return;
      }
      if (e.key === 'ArrowRight' && canNext) {
        e.preventDefault();
        e.stopPropagation();
        onNavigate(1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, onNavigate, canPrev, canNext]);

  // Reset any in-flight drag when the shown image changes, so paging mid-drag
  // cannot leave the next image rendered at an offset.
  useEffect(() => {
    dragStartRef.current = null;
    dragAxisRef.current = 'undecided';
    setDragOffset(0);
  }, [src]);

  // Drag-to-dismiss is bound imperatively with `{ passive: false }` so
  // `touchmove` can call preventDefault. Without that the browser keeps
  // scrolling the chat underneath and may trigger native swipe navigation
  // while the user is dragging the photo.
  useEffect(() => {
    const node = imageRef.current;
    if (!node) return;

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch || e.touches.length > 1) {
        dragStartRef.current = null;
        return;
      }
      dragStartRef.current = { x: touch.clientX, y: touch.clientY };
      dragAxisRef.current = 'undecided';
    };

    const onTouchMove = (e: TouchEvent) => {
      const start = dragStartRef.current;
      const touch = e.touches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;

      if (dragAxisRef.current === 'undecided') {
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        // Wait for enough travel to tell the axes apart, then commit. Locking
        // the axis once keeps a wobbly finger from flipping mid-gesture.
        if (absX < 8 && absY < 8) return;
        dragAxisRef.current = absY > absX * DISMISS_DRAG_AXIS_RATIO ? 'vertical' : 'horizontal';
      }
      if (dragAxisRef.current !== 'vertical') return;

      e.preventDefault();
      setDragOffset(dy);
    };

    const endDrag = () => {
      const committed = dragAxisRef.current === 'vertical'
        && Math.abs(dragOffsetRef.current) >= DISMISS_DRAG_THRESHOLD_PX;
      dragStartRef.current = null;
      dragAxisRef.current = 'undecided';
      setDragOffset(0);
      if (committed) onClose();
    };

    node.addEventListener('touchstart', onTouchStart, { passive: true });
    node.addEventListener('touchmove', onTouchMove, { passive: false });
    node.addEventListener('touchend', endDrag);
    node.addEventListener('touchcancel', endDrag);
    return () => {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', endDrag);
      node.removeEventListener('touchcancel', endDrag);
    };
  }, [onClose]);

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
    >
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        style={dragOffset === 0 ? undefined : {
          transform: `translateY(${dragOffset}px)`,
          // Fade toward the dismiss threshold so the gesture shows its own
          // commit point instead of closing without warning.
          opacity: Math.max(0.35, 1 - Math.abs(dragOffset) / (DISMISS_DRAG_THRESHOLD_PX * 2)),
          transition: 'none',
        }}
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
      {onNavigate && (canPrev || canNext) && (
        <>
          <button
            type="button"
            class="fb-lightbox-nav fb-lightbox-nav-prev"
            aria-label={t('chat.image_previous')}
            title={t('chat.image_previous')}
            disabled={!canPrev}
            onClick={(e) => {
              e.stopPropagation();
              onNavigate(-1);
            }}
          >‹</button>
          <button
            type="button"
            class="fb-lightbox-nav fb-lightbox-nav-next"
            aria-label={t('chat.image_next')}
            title={t('chat.image_next')}
            disabled={!canNext}
            onClick={(e) => {
              e.stopPropagation();
              onNavigate(1);
            }}
          >›</button>
        </>
      )}
      <button type="button" class="fb-lightbox-close" onClick={onClose}>✕</button>
    </div>
  );
}
