import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
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
}

export type ChatLocalImagePreviewLoader = (path: string) => Promise<ChatLocalImagePreviewResult | string>;
export type ChatLocalImagePreviewDownloadHandler = (path: string) => void | Promise<void>;

interface Props {
  path: string;
  loadImagePreview: ChatLocalImagePreviewLoader;
  onDownload?: ChatLocalImagePreviewDownloadHandler;
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ok'; dataUrl: string; alt: string }
  | { status: 'error' };

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export function ChatLocalImagePreview({ path, loadImagePreview, onDownload }: Props) {
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
        setPreview({
          status: 'ok',
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

  if (preview.status === 'error') return null;

  if (preview.status === 'loading') {
    return <span class="chat-local-image-preview chat-local-image-preview-loading" aria-hidden="true" />;
  }

  return (
    <>
      <span class="chat-local-image-preview">
        <img
          ref={thumbRef}
          class="chat-local-image-preview-img"
          src={preview.dataUrl}
          alt={preview.alt}
          title={path}
          loading="lazy"
          {...{ [CHAT_IMAGE_PATH_ATTR]: path }}
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
