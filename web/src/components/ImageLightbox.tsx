import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { shareBlobOrDownload } from '../browser-download.js';
// RemoteDesktopPanel already solved pinch/wheel zoom-anchored-at-a-point and
// bounded pan for its own zoomed stage; that math is generic viewport
// geometry, not remote-desktop-specific, so it is reused here verbatim
// instead of a second, drifting copy (CLAUDE.md: never copy code that
// already exists). The 1x-4x range these export is also exactly the range
// this feature was asked for.
import { lightboxActualSizeScale, LIGHTBOX_ZOOM_CAP } from '../attachment-preview-size.js';
import {
  clampRemoteDesktopViewport,
  INITIAL_REMOTE_DESKTOP_VIEWPORT,
  REMOTE_DESKTOP_MAX_ZOOM,
  viewportFromRemoteDesktopPinch,
  type RemoteDesktopViewport,
  type RemoteDesktopViewportGeometry,
} from '../remote-desktop-viewport.js';

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
  /** The picture could not be loaded (blocked, undecodable): the owner may offer another source. */
  onImageError?: () => void;
  /** Extra class on the overlay (a caller that has to sit above the app chrome adds its layer class). */
  overlayClass?: string;
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

/** How much one wheel "notch" (deltaY of ~100 on most mice) changes scale. */
const WHEEL_ZOOM_SENSITIVITY = 0.0016;

/** Max gap between taps, and max finger travel, to count as a double-tap. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP_PX = 32;
/** Below this much total finger travel, a touch is still a tap candidate. */
const TAP_MOVEMENT_SLOP_PX = 10;

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

/**
 * `offsetWidth`/`offsetHeight` are the image's laid-out box BEFORE the CSS
 * `transform: scale()` this component applies -- exactly the "content size
 * at 1x" `clampRemoteDesktopViewport`/`viewportFromRemoteDesktopPinch`
 * expect, since `.fb-lightbox img`'s own `max-width`/`max-height`/
 * `object-fit: contain` already fit it to the stage at rest.
 */
function lightboxViewportGeometry(
  image: HTMLElement,
  stage: HTMLElement,
): RemoteDesktopViewportGeometry {
  return {
    stageWidth: stage.clientWidth,
    stageHeight: stage.clientHeight,
    contentWidth: image.offsetWidth,
    contentHeight: image.offsetHeight,
  };
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

export function ImageLightbox({ src, alt = '', fileName, onDownload, onClose, onNavigate, canPrev = false, canNext = false, onImageError, overlayClass }: Props) {
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
  // Zoom/pan state, reusing RemoteDesktopPanel's viewport shape/math -- see
  // the import comment above. Mirrored into a ref for the same reason
  // dragOffset is: the imperative touch listeners below close over the
  // effect's first render.
  const [viewport, setViewport] = useState<RemoteDesktopViewport>(INITIAL_REMOTE_DESKTOP_VIEWPORT);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const pinchStartRef = useRef<{
    distance: number;
    center: { x: number; y: number };
    viewport: RemoteDesktopViewport;
  } | null>(null);
  const panStartViewportRef = useRef<RemoteDesktopViewport | null>(null);
  // Whether the in-progress single-finger touch is still a tap candidate
  // (i.e. has not yet moved enough to commit to dismiss/pan), for double-tap
  // detection at touchend.
  const tapCandidateRef = useRef(false);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  // The picture's own pixel size (known once it has loaded): what "100%" means, and how far a picture shown much smaller than its pixels may be zoomed.
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const naturalRef = useRef(natural);
  naturalRef.current = natural;
  const mouseDragRef = useRef<{ x: number; y: number; viewport: RemoteDesktopViewport; moved: boolean } | null>(null);
  const suppressOverlayClickRef = useRef(false);
  const [downloadState, setDownloadState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [copyState, setCopyState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const resolvedFileName = fileName || defaultImageFileName(alt);

  /** Scale at which one picture pixel is one screen pixel, relative to the fitted size (0: already at/above its natural size). */
  const actualScaleNow = (): number => {
    const node = imageRef.current;
    const size = naturalRef.current;
    return node && size ? lightboxActualSizeScale(size, { width: node.offsetWidth, height: node.offsetHeight }) : 0;
  };
  const maxScaleNow = (): number => Math.min(LIGHTBOX_ZOOM_CAP, Math.max(REMOTE_DESKTOP_MAX_ZOOM, actualScaleNow()));
  /**
   * Fit <-> 100%: from the fitted view to the picture's own pixels (or 2x when it is already shown at full size), anchored at `point`
   * (image-relative px, default the centre); from any zoomed view back to fit. A wide screenshot or a long page is read at 100% and panned.
   */
  const toggleActualSize = (point?: { x: number; y: number }) => {
    const node = imageRef.current;
    const stage = lightboxRef.current;
    if (!node || !stage) { setViewport(INITIAL_REMOTE_DESKTOP_VIEWPORT); return; }
    const current = viewportRef.current;
    if (current.scale > 1.01) { setViewport(INITIAL_REMOTE_DESKTOP_VIEWPORT); return; }
    const target = actualScaleNow() || 2;
    const geometry = lightboxViewportGeometry(node, stage);
    if (!point) {
      // From the button or the keyboard: start at the picture's top-left corner (where a screenshot's text starts), not its middle.
      // The bounds keep it covering the stage, and a dimension that already fits stays centred.
      setViewport(clampRemoteDesktopViewport({ scale: target, x: Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER }, geometry, maxScaleNow()));
      return;
    }
    setViewport(viewportFromRemoteDesktopPinch(current, point, point, target, geometry, maxScaleNow()));
  };

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

  // Reset any in-flight drag/zoom/pan when the shown image changes, so
  // paging mid-gesture cannot leave the next image rendered at an offset or
  // still zoomed in from the previous one.
  useEffect(() => {
    dragStartRef.current = null;
    dragAxisRef.current = 'undecided';
    setDragOffset(0);
    pinchStartRef.current = null;
    panStartViewportRef.current = null;
    tapCandidateRef.current = false;
    lastTapRef.current = null;
    mouseDragRef.current = null;
    setViewport(INITIAL_REMOTE_DESKTOP_VIEWPORT);
    setNatural(null);
  }, [src]);

  // A mouse drag pans a zoomed picture (a touch drag does already). Bound on the window so the drag survives leaving the picture.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = mouseDragRef.current;
      const node = imageRef.current;
      const stage = lightboxRef.current;
      if (!drag || !node || !stage) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      e.preventDefault();
      setViewport(clampRemoteDesktopViewport({ ...drag.viewport, x: drag.viewport.x + dx, y: drag.viewport.y + dy }, lightboxViewportGeometry(node, stage), maxScaleNow()));
    };
    const onUp = () => {
      const drag = mouseDragRef.current;
      mouseDragRef.current = null;
      // The click that ends a drag must not close the lightbox.
      if (drag?.moved) { suppressOverlayClickRef.current = true; setTimeout(() => { suppressOverlayClickRef.current = false; }, 0); }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Drag-to-dismiss/pinch-zoom/pan are bound imperatively with
  // `{ passive: false }` on the moves so they can call preventDefault.
  // Without that the browser keeps scrolling the chat underneath, may
  // trigger native swipe navigation while dragging, and -- for pinch --
  // would zoom the whole page instead of just this image (see the
  // `touch-action: none` this relies on in styles.css).
  useEffect(() => {
    const node = imageRef.current;
    if (!node) return;

    const geometry = (): RemoteDesktopViewportGeometry | null => {
      const stage = lightboxRef.current;
      return stage ? lightboxViewportGeometry(node, stage) : null;
    };

    const beginSingleTouch = (touch: Touch) => {
      dragStartRef.current = { x: touch.clientX, y: touch.clientY };
      dragAxisRef.current = 'undecided';
      panStartViewportRef.current = viewportRef.current;
      tapCandidateRef.current = true;
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        // A real second finger landing always wins over whatever the first
        // finger was starting to do (a tap-and-hold about to become a long
        // press, or an undecided drag) -- and must cancel that long press
        // exactly like a real pinch start would.
        clearLongPressTimer();
        dragStartRef.current = null;
        dragAxisRef.current = 'undecided';
        panStartViewportRef.current = null;
        tapCandidateRef.current = false;
        setDragOffset(0);
        const [a, b] = e.touches;
        const rect = node.getBoundingClientRect();
        pinchStartRef.current = {
          distance: Math.max(1, Math.hypot(b!.clientX - a!.clientX, b!.clientY - a!.clientY)),
          center: {
            x: (a!.clientX + b!.clientX) / 2 - rect.left,
            y: (a!.clientY + b!.clientY) / 2 - rect.top,
          },
          viewport: viewportRef.current,
        };
        return;
      }
      pinchStartRef.current = null;
      const touch = e.touches[0];
      if (!touch) {
        dragStartRef.current = null;
        tapCandidateRef.current = false;
        return;
      }
      beginSingleTouch(touch);
    };

    const onTouchMove = (e: TouchEvent) => {
      const pinch = pinchStartRef.current;
      if (pinch && e.touches.length >= 2) {
        const box = geometry();
        if (!box) return;
        const [a, b] = e.touches;
        const rect = node.getBoundingClientRect();
        const distance = Math.max(1, Math.hypot(b!.clientX - a!.clientX, b!.clientY - a!.clientY));
        const center = {
          x: (a!.clientX + b!.clientX) / 2 - rect.left,
          y: (a!.clientY + b!.clientY) / 2 - rect.top,
        };
        e.preventDefault();
        setViewport(viewportFromRemoteDesktopPinch(
          pinch.viewport,
          pinch.center,
          center,
          pinch.viewport.scale * distance / pinch.distance,
          box,
          maxScaleNow(),
        ));
        return;
      }

      const start = dragStartRef.current;
      const touch = e.touches[0];
      if (!start || !touch || e.touches.length > 1) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;

      if (tapCandidateRef.current
        && Math.hypot(dx, dy) >= TAP_MOVEMENT_SLOP_PX) {
        tapCandidateRef.current = false;
      }

      // Once zoomed in, a single-finger drag pans the zoomed image instead
      // of dismissing -- the standard iOS Photos / most-lightbox convention
      // this task calls for.
      if (viewportRef.current.scale > 1) {
        const panStart = panStartViewportRef.current;
        const box = geometry();
        if (!panStart || !box) return;
        e.preventDefault();
        setViewport(clampRemoteDesktopViewport({
          ...panStart,
          x: panStart.x + dx,
          y: panStart.y + dy,
        }, box, maxScaleNow()));
        return;
      }

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

    // `wasTapCandidate` is the caller's own snapshot, taken BEFORE it resets
    // `tapCandidateRef` for the next gesture -- re-reading the ref in here
    // would always see that already-cleared value and never register a tap.
    const maybeHandleDoubleTap = (touch: Touch, wasTapCandidate: boolean) => {
      if (!wasTapCandidate) {
        lastTapRef.current = null;
        return false;
      }
      const now = Date.now();
      const last = lastTapRef.current;
      const isDoubleTap = last !== null
        && now - last.time <= DOUBLE_TAP_MS
        && Math.hypot(touch.clientX - last.x, touch.clientY - last.y) <= DOUBLE_TAP_SLOP_PX;
      if (isDoubleTap) {
        lastTapRef.current = null;
        const rect = node.getBoundingClientRect();
        toggleActualSize({ x: touch.clientX - rect.left, y: touch.clientY - rect.top });
        return true;
      }
      lastTapRef.current = { time: now, x: touch.clientX, y: touch.clientY };
      return false;
    };

    const endGesture = (e: TouchEvent) => {
      // Lifting one of two fingers hands the gesture off to whichever finger
      // remains, as a fresh single-finger start, rather than freezing it
      // until the whole hand comes off.
      if (pinchStartRef.current) {
        pinchStartRef.current = null;
        const touch = e.touches[0];
        if (touch) {
          beginSingleTouch(touch);
          tapCandidateRef.current = false;
          return;
        }
      }
      if (e.touches.length > 0) return;

      const wasTapCandidate = tapCandidateRef.current;
      const changedTouch = e.changedTouches[0];
      const committed = viewportRef.current.scale === 1
        && dragAxisRef.current === 'vertical'
        && Math.abs(dragOffsetRef.current) >= DISMISS_DRAG_THRESHOLD_PX;
      dragStartRef.current = null;
      dragAxisRef.current = 'undecided';
      panStartViewportRef.current = null;
      tapCandidateRef.current = false;
      setDragOffset(0);
      if (committed) {
        onClose();
        return;
      }
      if (changedTouch) maybeHandleDoubleTap(changedTouch, wasTapCandidate);
    };

    node.addEventListener('touchstart', onTouchStart, { passive: true });
    node.addEventListener('touchmove', onTouchMove, { passive: false });
    node.addEventListener('touchend', endGesture);
    node.addEventListener('touchcancel', endGesture);
    return () => {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', endGesture);
      node.removeEventListener('touchcancel', endGesture);
    };
  }, [onClose]);

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

  // Desktop mouse-wheel zoom, anchored at the cursor -- the wheel's own
  // client point is passed as both the "before" and "after" pinch center,
  // which keeps that exact point fixed under the cursor as the scale
  // changes (see viewportFromRemoteDesktopPinch's own contract). Always
  // preventDefault: there is nothing behind this fullscreen modal to
  // scroll, and a trackpad's synthetic pinch also delivers as `wheel` with
  // `ctrlKey: true`, which browsers otherwise read as a request to zoom the
  // whole page.
  const handleWheel = (e: WheelEvent) => {
    const node = imageRef.current;
    const stage = lightboxRef.current;
    if (!node || !stage) return;
    e.preventDefault();
    const rect = node.getBoundingClientRect();
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const current = viewportRef.current;
    const nextScale = current.scale * Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
    setViewport(viewportFromRemoteDesktopPinch(
      current, point, point, nextScale, lightboxViewportGeometry(node, stage), maxScaleNow(),
    ));
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
      class={overlayClass ? `fb-lightbox ${overlayClass}` : 'fb-lightbox'}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation();
        if (suppressOverlayClickRef.current) return;
        onClose();
      }}
    >
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        decoding="async"
        class={viewport.scale > 1 ? 'is-zoomed' : undefined}
        onLoad={(e) => {
          const img = e.currentTarget as HTMLImageElement;
          if (img.naturalWidth > 0 && img.naturalHeight > 0) setNatural({ width: img.naturalWidth, height: img.naturalHeight });
        }}
        onError={onImageError}
        style={dragOffset !== 0 ? {
          transform: `translateY(${dragOffset}px)`,
          // Fade toward the dismiss threshold so the gesture shows its own
          // commit point instead of closing without warning.
          opacity: Math.max(0.35, 1 - Math.abs(dragOffset) / (DISMISS_DRAG_THRESHOLD_PX * 2)),
          transition: 'none',
        } : (viewport.scale !== 1 || viewport.x !== 0 || viewport.y !== 0) ? {
          transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`,
          transition: 'none',
        } : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (suppressNextImageClickRef.current) {
            suppressNextImageClickRef.current = false;
          }
        }}
        onDblClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          toggleActualSize({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        }}
        onWheel={handleWheel}
        onMouseDown={(e) => {
          e.stopPropagation();
          startLongPress();
          if (e.button === 0 && viewportRef.current.scale > 1) {
            e.preventDefault();
            mouseDragRef.current = { x: e.clientX, y: e.clientY, viewport: viewportRef.current, moved: false };
          }
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
      {(actualScaleNow() > 0 || viewport.scale > 1.01) && (
        <button
          type="button"
          class="fb-lightbox-zoom"
          aria-pressed={viewport.scale > 1.01}
          onClick={(e) => { e.stopPropagation(); toggleActualSize(); }}
        >
          {viewport.scale > 1.01 ? t('chat.image_zoom_fit') : t('chat.image_zoom_actual')}
        </button>
      )}
      <button type="button" class="fb-lightbox-close" aria-label={t('common.close')} title={t('common.close')} onClick={(e) => { e.stopPropagation(); onClose(); }}>✕</button>
    </div>
  );
}
