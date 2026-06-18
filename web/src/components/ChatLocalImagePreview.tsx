import { useEffect, useState } from 'preact/hooks';
import { ImageLightbox } from './ImageLightbox.js';

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

  if (preview.status === 'error') return null;

  if (preview.status === 'loading') {
    return <span class="chat-local-image-preview chat-local-image-preview-loading" aria-hidden="true" />;
  }

  return (
    <>
      <span class="chat-local-image-preview">
        <img
          class="chat-local-image-preview-img"
          src={preview.dataUrl}
          alt={preview.alt}
          title={path}
          loading="lazy"
          onClick={(e) => {
            e.stopPropagation();
            setLightboxOpen(true);
          }}
        />
      </span>
      {lightboxOpen && (
        <ImageLightbox
          src={preview.dataUrl}
          alt={preview.alt}
          fileName={basename(preview.alt)}
          onDownload={onDownload ? () => onDownload(path) : undefined}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </>
  );
}
