import { HTML_PREVIEW_SANDBOX } from '@shared/html-preview.js';
import { useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { createSafeHtmlPreviewDocument } from '../util/html-safe-preview.js';

interface HtmlSafePreviewProps {
  path: string;
  content?: string | null;
}

function contentIdentity(path: string, content: string): string {
  let hash = 2166136261;
  const value = `${path}\0${content}`;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${path.length}:${content.length}:${(hash >>> 0).toString(36)}`;
}

export function HtmlSafePreview({ path, content }: HtmlSafePreviewProps) {
  const { t } = useTranslation();
  const result = useMemo(() => createSafeHtmlPreviewDocument(content), [content]);

  if (result.status === 'too-large') {
    return (
      <div class="fb-preview-msg fb-preview-error" role="status">
        {t('chat.html_preview_too_large', { maxBytes: result.maxBytes })}
      </div>
    );
  }
  if (result.status === 'unavailable' || typeof content !== 'string') {
    return (
      <div class="fb-preview-msg fb-preview-error" role="status">
        {t('chat.html_preview_unavailable')}
      </div>
    );
  }

  const identity = contentIdentity(path, content);
  return (
    <iframe
      key={identity}
      class="html-safe-preview-frame"
      title={t('chat.html_preview_frame', { path })}
      sandbox={HTML_PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={result.srcDoc}
      data-preview-identity={identity}
    />
  );
}
