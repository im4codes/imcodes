/**
 * Zoom compensation helper for ONLYOFFICE embedded preview/editor hosts.
 * Neutralizes ancestor CSS `zoom` (`--imcodes-ui-zoom`) back to effective `zoom: 1`
 * and syncs explicit visual dimensions from the editor wrapper so ONLYOFFICE iframes
 * fill 100% edge-to-edge without WebKit viewport mismatch or clipping.
 */
import { getActiveCssZoom, UI_SCALE_EVENT } from './ui-scale.js';

export function syncOnlyOfficeEditorHostGeometry(
  wrap: HTMLElement | null,
  host: HTMLElement | null,
  activeZoom: number = getActiveCssZoom(),
): void {
  if (!wrap || !host) return;
  const zoomStyle = host.style as unknown as { zoom?: string };
  if (!Number.isFinite(activeZoom) || activeZoom <= 0 || Math.abs(activeZoom - 1) < 0.0005) {
    zoomStyle.zoom = '';
    host.style.removeProperty('zoom');
    host.style.removeProperty('width');
    host.style.removeProperty('height');
    return;
  }
  const rect = wrap.getBoundingClientRect();
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
    return;
  }
  const inverseZoom = String(Number((1 / activeZoom).toFixed(6)));
  zoomStyle.zoom = inverseZoom;
  host.style.setProperty('zoom', inverseZoom);
  host.style.setProperty('width', `${rect.width}px`, 'important');
  host.style.setProperty('height', `${rect.height}px`, 'important');
}

export function observeOnlyOfficeEditorHostGeometry(
  wrap: HTMLElement | null,
  host: HTMLElement | null,
): () => void {
  if (typeof window === 'undefined' || !wrap || !host) return () => {};
  const sync = () => syncOnlyOfficeEditorHostGeometry(wrap, host);
  sync();
  let rafId = 0;
  const scheduleSync = () => {
    sync();
    if (typeof requestAnimationFrame === 'function') {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        sync();
      });
    }
  };
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(sync)
    : null;
  ro?.observe(wrap);
  window.addEventListener(UI_SCALE_EVENT, scheduleSync);
  window.addEventListener('resize', scheduleSync);
  window.visualViewport?.addEventListener('resize', scheduleSync);
  return () => {
    if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    ro?.disconnect();
    window.removeEventListener(UI_SCALE_EVENT, scheduleSync);
    window.removeEventListener('resize', scheduleSync);
    window.visualViewport?.removeEventListener('resize', scheduleSync);
  };
}
