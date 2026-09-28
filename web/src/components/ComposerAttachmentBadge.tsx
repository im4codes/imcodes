import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { buildAttachmentDownloadUrl } from '../api.js';
import { getAttachmentPreview, isPreviewableImageName } from '../attachment-preview-cache.js';
import { ImageLightbox } from './ImageLightbox.js';

/** Pause before the hover preview opens, so sweeping across chips does not flash them. */
const HOVER_PREVIEW_DELAY_MS = 140;
const POPOVER_GAP_PX = 8;

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
  const isImage = isPreviewableImageName(name) || isPreviewableImageName(path);
  const badgeRef = useRef<HTMLSpanElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [src, setSrc] = useState<string | null>(() => (isImage ? getAttachmentPreview(path) ?? null : null));
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<{ left: number; bottom: number } | null>(null);
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
    if (!attachmentId || !serverId) { setFailed(true); return; }
    void buildAttachmentDownloadUrl(serverId, attachmentId, sessionName)
      .then(setSrc)
      .catch(() => setFailed(true));
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
      setHover({ left: rect.left, bottom: window.innerHeight - rect.top + POPOVER_GAP_PX });
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
      {hover && isImage && (
        <div
          class="attachment-hover-preview"
          role="img"
          aria-label={name}
          style={{ left: `${Math.max(8, hover.left)}px`, bottom: `${hover.bottom}px` }}
        >
          {src
            ? <img src={src} alt={name} onError={() => setFailed(true)} />
            : <span class="attachment-hover-preview-state">
              {failed ? t('upload.preview_unavailable') : t('upload.preview_loading')}
            </span>}
          <span class="attachment-hover-preview-caption">#{seq} {name}</span>
        </div>
      )}
      {lightbox && src && (
        <ImageLightbox src={src} alt={name} fileName={name} onClose={() => setLightbox(false)} />
      )}
      {lightbox && !src && (
        <div class="attachment-lightbox-pending" onClick={() => setLightbox(false)} role="presentation">
          <span>{failed ? t('upload.preview_unavailable') : t('upload.preview_loading')}</span>
        </div>
      )}
    </>
  );
}
