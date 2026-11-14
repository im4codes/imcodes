/**
 * Lightweight ONLYOFFICE component prewarming utilities.
 *
 * Kept completely separate from OfficePreview.tsx and local fallback parsers
 * (pdfjs-dist, docx-preview, xlsx) so CloudDocsPanel, FileBrowser, and post-auth
 * idle hooks can warm ONLYOFFICE DNS/TLS, api.js, and static editor bundles
 * without pulling preview UI or fallback parsers into initial chunks.
 */
import { fetchOnlyOfficeStatus, type OnlyOfficeStatusResponse } from './api.js';

declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: new (placeholderId: string, config: Record<string, unknown>) => {
        destroyEditor?: () => void;
      };
    };
  }
}

const scriptLoadPromises = new Map<string, Promise<void>>();
let prewarmPromise: Promise<void> | null = null;
let prewarmSeq = 0;
let cachedStatus: OnlyOfficeStatusResponse | null = null;

function resolveOrigin(url: string): string | null {
  try {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return new URL(url, window.location.origin).origin;
    }
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function findScriptElementBySrc(scriptUrl: string): HTMLScriptElement | null {
  if (typeof document === 'undefined') return null;
  const tags = document.querySelectorAll('script[data-onlyoffice-src]');
  for (const tag of tags) {
    if (tag instanceof HTMLScriptElement && tag.dataset.onlyofficeSrc === scriptUrl) {
      return tag;
    }
  }
  return null;
}

function ensurePreconnectLink(publicUrl: string): void {
  if (typeof document === 'undefined' || !document.head) return;
  const origin = resolveOrigin(publicUrl);
  if (!origin) return;
  const existingLinks = document.head.querySelectorAll('link[data-onlyoffice-preconnect]');
  for (const link of existingLinks) {
    if (link instanceof HTMLLinkElement && link.dataset.onlyofficePreconnect === origin) {
      return;
    }
  }
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = origin;
  link.dataset.onlyofficePreconnect = origin;
  document.head.appendChild(link);
}

function resolvePreloadDocumentUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/$/, '')}/web-apps/apps/api/documents/preload.html`;
}

function mountOnlyOfficePreloadIframe(publicUrl: string): void {
  if (typeof document === 'undefined') return;
  const container = document.body ?? document.documentElement;
  if (!container) return;
  const preloadUrl = resolvePreloadDocumentUrl(publicUrl);
  const existingFrames = document.querySelectorAll('iframe[data-onlyoffice-preload]');
  for (const frame of existingFrames) {
    if (frame instanceof HTMLIFrameElement) {
      if (frame.dataset.onlyofficePreload === preloadUrl) {
        return;
      }
      frame.remove();
    }
  }
  const iframe = document.createElement('iframe');
  iframe.src = preloadUrl;
  iframe.title = '';
  iframe.tabIndex = -1;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.dataset.onlyofficePreload = preloadUrl;
  iframe.style.display = 'none';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.onerror = () => {
    // Silent failure: preload frame errors must never bubble or interfere with document preview.
  };
  container.appendChild(iframe);
}

/**
 * Load ONLYOFFICE `api.js` once per URL and cache the settled promise across prewarm and editor opens.
 * On load error, clears the cached promise and removes the failed tag so later retries start clean.
 */
export function loadOnlyOfficeScript(scriptUrl: string): Promise<void> {
  if (typeof window !== 'undefined' && window.DocsAPI?.DocEditor) {
    return Promise.resolve();
  }
  const existing = scriptLoadPromises.get(scriptUrl);
  if (existing) return existing;

  const promise = new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') {
      scriptLoadPromises.delete(scriptUrl);
      reject(new Error('Document is unavailable'));
      return;
    }
    if (window.DocsAPI?.DocEditor) {
      resolve();
      return;
    }
    const existingTag = findScriptElementBySrc(scriptUrl);
    if (existingTag) {
      existingTag.remove();
    }
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.dataset.onlyofficeSrc = scriptUrl;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoadPromises.delete(scriptUrl);
      script.remove();
      reject(new Error('Failed to load ONLYOFFICE API script'));
    };
    document.head.appendChild(script);
  });

  scriptLoadPromises.set(scriptUrl, promise);
  return promise;
}

/**
 * Idempotently check ONLYOFFICE availability and prewarm origin connection, `api.js`,
 * and hidden static preload iframe. Completely silent on disabled or offline/error states.
 */
export async function prewarmOnlyOfficeComponents(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (prewarmPromise) {
    return prewarmPromise;
  }
  if (cachedStatus && !cachedStatus.enabled) {
    return;
  }

  const seq = ++prewarmSeq;
  const run = (async () => {
    try {
      const status = cachedStatus ?? await fetchOnlyOfficeStatus();
      if (seq !== prewarmSeq) return;
      cachedStatus = status;
      if (!status.enabled || !status.scriptUrl) {
        return;
      }
      const publicUrl =
        status.publicUrl || status.scriptUrl.replace(/\/web-apps\/apps\/api\/documents\/api\.js$/, '');
      ensurePreconnectLink(publicUrl);
      await loadOnlyOfficeScript(status.scriptUrl);
      if (seq !== prewarmSeq) return;
      mountOnlyOfficePreloadIframe(publicUrl);
    } catch {
      // Prewarm errors are intentionally suppressed; real document opens handle status & fallback cleanly.
    } finally {
      if (seq === prewarmSeq) {
        prewarmPromise = null;
      }
    }
  })();

  prewarmPromise = run;
  return run;
}

/**
 * Schedule ONLYOFFICE prewarming during browser idle time and return a cancellation handle.
 */
export function scheduleOnlyOfficePrewarm(): () => void {
  if (typeof window === 'undefined') return () => {};
  const win = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  let cancelled = false;
  const trigger = () => {
    if (!cancelled) {
      void prewarmOnlyOfficeComponents();
    }
  };
  if (typeof win.requestIdleCallback === 'function') {
    const idleId = win.requestIdleCallback(trigger, { timeout: 2500 });
    return () => {
      cancelled = true;
      win.cancelIdleCallback?.(idleId);
    };
  }
  const timerId = window.setTimeout(trigger, 800);
  return () => {
    cancelled = true;
    window.clearTimeout(timerId);
  };
}

/** Clear cached prewarm state on logout or inside unit tests. */
export function resetOnlyOfficePrewarm(opts?: { clearScriptCache?: boolean; removeDomNodes?: boolean }): void {
  prewarmSeq += 1;
  prewarmPromise = null;
  cachedStatus = null;
  if (opts?.clearScriptCache) {
    scriptLoadPromises.clear();
  }
  if (opts?.removeDomNodes && typeof document !== 'undefined') {
    for (const node of document.querySelectorAll('link[data-onlyoffice-preconnect], script[data-onlyoffice-src], iframe[data-onlyoffice-preload]')) {
      node.remove();
    }
  }
}
