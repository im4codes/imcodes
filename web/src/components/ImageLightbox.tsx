import { useEffect, useRef } from 'preact/hooks';

interface Props {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt = '', onClose }: Props) {
  const lightboxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    lightboxRef.current?.focus();
    return () => {
      previousActiveElement?.focus?.();
    };
  }, []);

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
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      <button type="button" class="fb-lightbox-close" onClick={onClose}>✕</button>
    </div>
  );
}
