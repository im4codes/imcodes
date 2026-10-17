import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { ImageLightbox } from './ImageLightbox.js';
import {
  CHAT_IMAGE_PATH_ATTR,
  collectChatImagePaths,
  resolveGalleryPosition,
  stepGallery,
} from '../chat-image-gallery.js';

export interface ChatLocalImagePreviewResult {
  dataUrl: string;
  alt?: string;
  /**
   * tsk_5rf R2: streamed previews resolve a download-handle URL with a bounded
   * server-side TTL. The promise resolves long before the browser discovers the
   * handle is dead, so the loader supplies this hook and the component calls it
   * from the <img> error path. Without it a cached URL would be reused forever
   * and a retry could never mint a fresh handle.
   */
  onLoadFailed?: () => void;
}

export type ChatLocalImagePreviewLoader = (path: string) => Promise<ChatLocalImagePreviewResult | string>;
export type ChatLocalImagePreviewDownloadHandler = (path: string) => void | Promise<void>;

interface Props {
  path: string;
  loadImagePreview: ChatLocalImagePreviewLoader;
  onDownload?: ChatLocalImagePreviewDownloadHandler;
}

// tsk_5rf R2: a streamed preview resolves a URL, not bytes, so a resolved URL
// is NOT success. 'pending' means the URL is known and the browser is still
// fetching it; only the real <img> load event promotes it to 'ok', and an
// error demotes it to 'error' instead of leaving a broken image on screen.
type PreviewState =
  | { status: 'loading' }
  | { status: 'pending'; dataUrl: string; alt: string }
  | { status: 'ok'; dataUrl: string; alt: string }
  | { status: 'error' };

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export function ChatLocalImagePreview({ path, loadImagePreview, onDownload }: Props) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const thumbRef = useRef<HTMLImageElement>(null);
  // Gallery snapshot taken when the lightbox opens. Sampling once keeps paging
  // stable: streaming replies can append images while the viewer is open, and a
  // list that grew underneath would shift what "next" means mid-gesture.
  const [gallery, setGallery] = useState<string[]>([]);
  // Which image the viewer is showing. Starts at this thumbnail's own path and
  // moves independently of it as the user pages.
  const [shownPath, setShownPath] = useState(path);
  const [shown, setShown] = useState<PreviewState>({ status: 'loading' });
  const onLoadFailedRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setPreview({ status: 'loading' });
    setLightboxOpen(false);

    loadImagePreview(path)
      .then((result) => {
        if (cancelled) return;
        const dataUrl = typeof result === 'string' ? result : result.dataUrl;
        if (!dataUrl) {
          setPreview({ status: 'error' });
          return;
        }
        onLoadFailedRef.current = typeof result === 'string' ? undefined : result.onLoadFailed;
        setPreview({
          status: 'pending',
          dataUrl,
          alt: typeof result === 'string' ? basename(path) : (result.alt || basename(path)),
        });
      })
      .catch(() => {
        if (!cancelled) setPreview({ status: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [loadImagePreview, path]);

  // Loads whatever the viewer is currently paged to. When that is this
  // thumbnail's own path the already-resolved preview is reused, so opening
  // never re-fetches; other paths go through the same loader, which the chat
  // view memoises, so paging back and forth is cheap.
  useEffect(() => {
    if (!lightboxOpen) return;
    if (shownPath === path) {
      setShown(preview);
      return;
    }
    let cancelled = false;
    setShown({ status: 'loading' });
    loadImagePreview(shownPath)
      .then((result) => {
        if (cancelled) return;
        const dataUrl = typeof result === 'string' ? result : result.dataUrl;
        if (!dataUrl) {
          setShown({ status: 'error' });
          return;
        }
        setShown({
          status: 'ok',
          dataUrl,
          alt: typeof result === 'string' ? basename(shownPath) : (result.alt || basename(shownPath)),
        });
      })
      .catch(() => {
        if (!cancelled) setShown({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [lightboxOpen, shownPath, path, preview, loadImagePreview]);

  const openLightbox = useCallback(() => {
    setGallery(collectChatImagePaths(thumbRef.current));
    setShownPath(path);
    setShown(preview);
    setLightboxOpen(true);
  }, [path, preview]);

  const closeLightbox = useCallback(() => {
    setLightboxOpen(false);
    setShownPath(path);
  }, [path]);

  const navigate = useCallback((direction: -1 | 1) => {
    setShownPath((current) => stepGallery(gallery, current, direction) ?? current);
  }, [gallery]);

  if (preview.status === 'error') {
    // tsk_5rf R3: rendering null made a failed preview indistinguishable from a
    // message that never had an image, so a dead handle looked like nothing was
    // ever there. Surface a visible, labelled failure instead.
    return (
      <span
        class="chat-local-image-preview chat-local-image-preview-error"
        title={path}
      >
        {t('file_browser.preview_error')}
      </span>
    );
  }

  if (preview.status === 'loading') {
    return <span class="chat-local-image-preview chat-local-image-preview-loading" aria-hidden="true" />;
  }

  const settling = preview.status === 'pending';

  return (
    <>
      {settling && (
        <span class="chat-local-image-preview chat-local-image-preview-loading" aria-hidden="true" />
      )}
      {/* Deliberately NOT display:none while settling. The <img> uses
          loading="lazy", and a hidden image may never enter the viewport, so
          hiding it here would stop it ever loading and freeze the placeholder
          forever. The element stays in flow; an unloaded image paints nothing. */}
      <span class="chat-local-image-preview">
        <img
          ref={thumbRef}
          class="chat-local-image-preview-img"
          src={preview.dataUrl}
          alt={preview.alt}
          title={path}
          loading="lazy"
          {...{ [CHAT_IMAGE_PATH_ATTR]: path }}
          onLoad={() => {
            setPreview((current) => (current.status === 'pending'
              ? { status: 'ok', dataUrl: current.dataUrl, alt: current.alt }
              : current));
          }}
          onError={() => {
            // A dead or expired handle must fail loudly, drop the element, and
            // evict the cached URL so the next attempt mints a fresh handle.
            onLoadFailedRef.current?.();
            setPreview({ status: 'error' });
            setLightboxOpen(false);
          }}
          onClick={(e) => {
            e.stopPropagation();
            openLightbox();
          }}
        />
      </span>
      {lightboxOpen && shown.status === 'ok' && (
        <ImageLightbox
          src={shown.dataUrl}
          alt={shown.alt}
          fileName={basename(shown.alt)}
          onDownload={onDownload ? () => onDownload(shownPath) : undefined}
          onClose={closeLightbox}
          onNavigate={gallery.length > 1 ? navigate : undefined}
          canPrev={resolveGalleryPosition(gallery, shownPath).canPrev}
          canNext={resolveGalleryPosition(gallery, shownPath).canNext}
        />
      )}
    </>
  );
}
