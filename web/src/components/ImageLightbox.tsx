import { h } from 'preact';

interface Props {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt = '', onClose }: Props) {
  return (
    <div class="fb-lightbox" onClick={onClose}>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      <button type="button" class="fb-lightbox-close" onClick={onClose}>✕</button>
    </div>
  );
}
