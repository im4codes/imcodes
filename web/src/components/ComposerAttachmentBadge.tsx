import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { buildAttachmentDownloadUrl } from '../api.js';
import { forgetAttachmentPreview, getAttachmentPreview, isPreviewableImageName } from '../attachment-preview-cache.js';
import { ATTACHMENT_PREVIEW_CHROME, ATTACHMENT_PREVIEW_MARGIN_PX, attachmentPreviewLeft, attachmentPreviewSize } from '../attachment-preview-size.js';
import { ImageLightbox } from './ImageLightbox.js';
import { sanitizeUploadFilename } from '@shared/upload-filename.js';

/** Pause before the hover preview opens, so sweeping across chips does not flash them. */
const HOVER_PREVIEW_DELAY_MS = 140;
const POPOVER_GAP_PX = 8;
/**
 * Class of every overlay the chip opens (hover popover, lightbox, "loading" cover). They are rendered into <body> and take their
 * z-index from `--layer-attachment-preview` (styles.css): the chip sits in the composer, whose `.attachment-badges` is
 * `position: relative; z-index: 1`, so an overlay left inside it would rank as z-index 1 against the app bars and the
 * composer itself, however large its own number, and the phone's bars would cover the picture.
 */
export const ATTACHMENT_PREVIEW_LAYER_CLASS = 'attachment-preview-layer';
const toBody = (node: preact.ComponentChild) => createPortal(node, document.body);

export interface ComposerAttachmentBadgeProps {
  seq: number;
  name: string;
  path: string;
  /** Present for uploaded attachments; needed to load a preview after a reload. */
  attachmentId?: string;
  serverId?: string;
  sessionName?: string;
  removing: boolean;
  onRemove(): void;
}

/**
 * One attachment chip in the composer. Image attachments preview on hover
 * (mouse) and on tap (touch, and click on desktop) so a pile of `#1 image.png`
 * chips can be told apart.
 */
export function ComposerAttachmentBadge({
  seq, name, path, attachmentId, serverId, sessionName, removing, onRemove,
}: ComposerAttachmentBadgeProps) {
  const { t } = useTranslation();
  // Keep the user-facing name untouched, but use the shared cross-platform
  // basename when deciding whether a restored upload is previewable.
  const storageName = sanitizeUploadFilename(name);
  const isImage = isPreviewableImageName(name) || isPreviewableImageName(storageName) || isPreviewableImageName(path);
  const badgeRef = useRef<HTMLSpanElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [src, setSrc] = useState<string | null>(() => (isImage ? getAttachmentPreview(path) ?? null : null));
  const [failed, setFailed] = useState(false);
  // The local copy is tried first; when the page cannot show it (a policy that blocks blob: images, a codec the webview lacks)
  // the uploaded file's authenticated download URL is tried once before giving up.
  const remoteTriedRef = useRef(false);
  // `viewport` is the window size when the bubble opened: the bubble is sized from it and from the picture's own pixels (see attachment-preview-size.ts).
  const [hover, setHover] = useState<{ left: number; bottom: number; viewport: { width: number; height: number } } | null>(null);
  // The picture's pixel size, known once the browser has decoded it (tied to the source it was read from).
  const [natural, setNatural] = useState<{ src: string; width: number; height: number } | null>(null);
  const [lightbox, setLightbox] = useState(false);

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  // Resolve a source lazily: the local object URL if we still have one, else
  // the authenticated download URL of the uploaded file.
  const ensureSource = () => {
    if (!isImage || src || failed) return;
    const local = getAttachmentPreview(path);
    if (local) { setSrc(local); return; }
    loadRemoteSource();
  };

  function loadRemoteSource() {
    if (!attachmentId || !serverId || remoteTriedRef.current) { setSrc(null); setFailed(true); return; }
    remoteTriedRef.current = true;
    void buildAttachmentDownloadUrl(serverId, attachmentId, sessionName)
      .then(setSrc)
      .catch(() => { setSrc(null); setFailed(true); });
  }

  // The <img> reported an error for the current source.
  const onImageError = () => {
    if (src && src.startsWith('blob:')) {
      forgetAttachmentPreview(path);
      setSrc(null);
      loadRemoteSource();
      return;
    }
    setSrc(null);
    setFailed(true);
  };

  const cancelHover = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    setHover(null);
  };

  const onPointerEnter = (event: PointerEvent) => {
    // Touch has no hover; a tap opens the full preview instead.
    if (!isImage || event.pointerType !== 'mouse') return;
    ensureSource();
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      const rect = badgeRef.current?.getBoundingClientRect();
      if (!rect) return;
      setHover({ left: rect.left, bottom: window.innerHeight - rect.top + POPOVER_GAP_PX, viewport: { width: window.innerWidth, height: window.innerHeight } });
    }, HOVER_PREVIEW_DELAY_MS);
  };

  const openFull = () => {
    if (!isImage) return;
    cancelHover();
    ensureSource();
    setLightbox(true);
  };

  return (
    <>
      <span
        ref={badgeRef}
        class={`attachment-badge${isImage ? ' is-previewable' : ''}`}
        title={`#${seq} ${path}`}
        data-attachment-seq={seq}
        onPointerEnter={onPointerEnter}
        onPointerLeave={cancelHover}
      >
        {/*
          * R3 v2 PR-ρ — Surface the per-composer sequence number
          * as a `#N` prefix so the user can reference the file in
          * chat text via the same short tag (`#1`, `#2`, ...). The
          * counter resets on send (the attachments array is wiped
          * by `clearComposer`).
          */}
        {isImage ? (
          <button
            type="button"
            class="attachment-badge-main"
            onClick={openFull}
            aria-label={t('upload.preview_attachment', { seq, name })}
          >
            <span class="attachment-badge-icon" data-testid={`attachment-tag-${seq}`}>#{seq}</span>
            <span class="attachment-badge-name">{name}</span>
          </button>
        ) : (
          <>
            <span class="attachment-badge-icon" data-testid={`attachment-tag-${seq}`}>#{seq}</span>
            <span class="attachment-badge-name">{name}</span>
          </>
        )}
        <button
          class="attachment-badge-remove"
          disabled={removing}
          onClick={onRemove}
          title={removing ? t('upload.deleting') : t('common.delete')}
        >×</button>
      </span>
      {hover && isImage && toBody((() => {
        const known = src && natural && natural.src === src ? natural : null;
        const box = known
          ? attachmentPreviewSize({
            viewport: hover.viewport,
            natural: known,
            availableHeight: hover.viewport.height - hover.bottom - ATTACHMENT_PREVIEW_MARGIN_PX,
          })
          : null;
        const left = box
          ? attachmentPreviewLeft({ anchorLeft: hover.left, outerWidth: box.width + ATTACHMENT_PREVIEW_CHROME.width, viewportWidth: hover.viewport.width })
          : Math.max(ATTACHMENT_PREVIEW_MARGIN_PX, hover.left);
        return (
          <div
            class={`attachment-hover-preview ${ATTACHMENT_PREVIEW_LAYER_CLASS}`}
            role="img"
            aria-label={name}
            style={{ left: `${left}px`, bottom: `${hover.bottom}px` }}
          >
            {src && (
              // The original picture (never a pre-shrunk copy), decoded off the main thread, shown at the size computed from its own pixels.
              <img
                src={src}
                alt={name}
                decoding="async"
                class={box ? undefined : 'is-measuring'}
                style={box ? { width: `${box.width}px`, height: `${box.height}px` } : undefined}
                onLoad={(event) => {
                  const img = event.currentTarget as HTMLImageElement;
                  if (img.naturalWidth > 0 && img.naturalHeight > 0) setNatural({ src, width: img.naturalWidth, height: img.naturalHeight });
                }}
                onError={onImageError}
              />
            )}
            {!box && (
              <span class="attachment-hover-preview-state">
                {failed ? t('upload.preview_unavailable') : t('upload.preview_loading')}
              </span>
            )}
            <span class="attachment-hover-preview-caption">#{seq} {name}</span>
          </div>
        );
      })())}
      {lightbox && src && toBody(
        <ImageLightbox
          src={src}
          alt={name}
          fileName={name}
          onClose={() => setLightbox(false)}
          onImageError={onImageError}
          overlayClass={ATTACHMENT_PREVIEW_LAYER_CLASS}
        />,
      )}
      {lightbox && !src && toBody(
        <div class={`attachment-lightbox-pending ${ATTACHMENT_PREVIEW_LAYER_CLASS}`} onClick={() => setLightbox(false)} role="presentation">
          <span>{failed ? t('upload.preview_unavailable') : t('upload.preview_loading')}</span>
        </div>,
      )}
    </>
  );
}
