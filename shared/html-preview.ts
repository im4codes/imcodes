export const HTML_RENDER_MAX_BYTES = 1024 * 1024;
export const HTML_PREVIEW_SANDBOX = '' as const;

export type HtmlPreviewViewMode = 'source' | 'diff' | 'html-render';

const HTML_PREVIEW_EXTENSIONS = ['.html', '.htm'] as const;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

export function isHtmlPreviewPath(path: string): boolean {
  const value = path.trim().replace(/^`+|`+$/g, '');
  if (!value) return false;
  if (value.startsWith('//')) return false;
  if (URI_SCHEME_PATTERN.test(value) && !WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)) return false;

  const normalized = value.replace(/\\/g, '/');
  const slashIndex = normalized.lastIndexOf('/');
  const basename = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
  if (!basename || basename === '.' || basename === '..') return false;

  const lowerBasename = basename.toLowerCase();
  return HTML_PREVIEW_EXTENSIONS.some(
    (extension) => lowerBasename.length > extension.length && lowerBasename.endsWith(extension),
  );
}
