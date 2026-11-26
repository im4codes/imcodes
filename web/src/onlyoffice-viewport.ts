/**
 * Viewport detection helper for ONLYOFFICE embedded preview/editor.
 * Kept separate from OfficePreview.tsx so callers like CloudDocsPanel can detect
 * mobile viewports without eagerly importing OfficePreview or local fallback parsers.
 */
export function isMobileOnlyOfficeViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches) {
    return true;
  }
  return typeof window.innerWidth === 'number' && window.innerWidth <= 768;
}
