/**
 * Lightweight ONLYOFFICE component prewarming utilities.
 *
 * Kept completely separate from preview UI and local fallback parsers
 * so CloudDocsPanel, FileBrowser, and post-auth idle hooks can warm
 * ONLYOFFICE DNS/TLS, api.js, and static editor bundles without eagerly
 * bundling document preview UI or fallback parsers.
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

type VerifiedDocsApiBinding = {
  scriptUrl: string;
  epoch: number;
  docsApi: NonNullable<Window['DocsAPI']>;
  docEditor: NonNullable<Window['DocsAPI']>['DocEditor'];
};

type ActiveScriptLoad = {
  scriptUrl: string;
  epoch: number;
  promise: Promise<void>;
  tag: HTMLScriptElement;
};

let prewarmPromise: Promise<void> | null = null;
let prewarmSeq = 0;
let loaderEpoch = 0;
let verifiedBinding: VerifiedDocsApiBinding | null = null;
let activeLoad: ActiveScriptLoad | null = null;
let cachedStatus: OnlyOfficeStatusResponse | null = null;
const staleDocsApis = new WeakSet<object>();
const staleDocEditors = new WeakSet<object>();

function markDocsApiStale(docsApi: Window['DocsAPI'] | undefined): void {
  if (!docsApi || typeof docsApi !== 'object') return;
  staleDocsApis.add(docsApi);
  if (typeof docsApi.DocEditor === 'function') {
    staleDocEditors.add(docsApi.DocEditor);
  }
}

function clearGlobalDocsApi(): void {
  if (typeof window === 'undefined') return;
  markDocsApiStale(window.DocsAPI);
  try {
    delete window.DocsAPI;
  } catch {
    window.DocsAPI = undefined;
  }
}

function restoreVerifiedDocsApi(binding: VerifiedDocsApiBinding): void {
  if (typeof window === 'undefined') return;
  if (binding.docsApi.DocEditor !== binding.docEditor) {
    binding.docsApi = { ...binding.docsApi, DocEditor: binding.docEditor };
  }
  window.DocsAPI = binding.docsApi;
}

function invalidateLoaderState(): void {
  loaderEpoch += 1;
  if (verifiedBinding) {
    markDocsApiStale(verifiedBinding.docsApi);
    staleDocEditors.add(verifiedBinding.docEditor);
    verifiedBinding = null;
  }
  activeLoad = null;
  clearGlobalDocsApi();
}

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

function removeManagedScriptTags(): void {
  if (typeof document === 'undefined') return;
  for (const tag of document.querySelectorAll('script[data-onlyoffice-src]')) {
    tag.remove();
  }
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

function removeManagedDomNodes(): void {
  if (typeof document === 'undefined') return;
  for (const node of document.querySelectorAll(
    'link[data-onlyoffice-preconnect], script[data-onlyoffice-src], iframe[data-onlyoffice-preload]',
  )) {
    node.remove();
  }
}

/**
 * Load ONLYOFFICE `api.js` for `scriptUrl`, verifying that `window.DocsAPI.DocEditor`
 * actually initialized and belongs to the requested URL/generation.
 * On load failure or missing initialization, evicts failed cache/tag state so retries start fresh.
 */
export function loadOnlyOfficeScript(scriptUrl: string): Promise<void> {
  if (
    verifiedBinding &&
    verifiedBinding.scriptUrl === scriptUrl &&
    verifiedBinding.epoch === loaderEpoch
  ) {
    if (
      typeof window !== 'undefined' &&
      (window.DocsAPI !== verifiedBinding.docsApi || window.DocsAPI?.DocEditor !== verifiedBinding.docEditor)
    ) {
      restoreVerifiedDocsApi(verifiedBinding);
    }
    return Promise.resolve();
  }

  if (activeLoad && activeLoad.scriptUrl === scriptUrl && activeLoad.epoch === loaderEpoch) {
    return activeLoad.promise;
  }

  if (typeof document === 'undefined') {
    invalidateLoaderState();
    return Promise.reject(new Error('Document is unavailable'));
  }

  invalidateLoaderState();
  removeManagedScriptTags();

  const epoch = loaderEpoch;
  const script = document.createElement('script');
  script.src = scriptUrl;
  script.async = true;
  script.dataset.onlyofficeSrc = scriptUrl;

  let resolveLoad!: () => void;
  let rejectLoad!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveLoad = resolve;
    rejectLoad = reject;
  });

  const record: ActiveScriptLoad = {
    scriptUrl,
    epoch,
    promise,
    tag: script,
  };
  activeLoad = record;

  script.onload = () => {
    if (record.epoch !== loaderEpoch || activeLoad !== record) {
      // Stale script finished late after reset/switch: repair current verified binding or wipe untrusted global state.
      const currentDocsApi = typeof window !== 'undefined' ? window.DocsAPI : undefined;
      if (verifiedBinding && verifiedBinding.epoch === loaderEpoch) {
        if (currentDocsApi && currentDocsApi !== verifiedBinding.docsApi) {
          markDocsApiStale(currentDocsApi);
        } else if (
          currentDocsApi?.DocEditor &&
          currentDocsApi.DocEditor !== verifiedBinding.docEditor
        ) {
          staleDocEditors.add(currentDocsApi.DocEditor);
        }
        if (currentDocsApi !== verifiedBinding.docsApi || currentDocsApi?.DocEditor !== verifiedBinding.docEditor) {
          restoreVerifiedDocsApi(verifiedBinding);
        }
      } else {
        clearGlobalDocsApi();
      }
      script.remove();
      rejectLoad(new Error('Stale ONLYOFFICE API script load superseded'));
      return;
    }

    const docsApi = typeof window !== 'undefined' ? window.DocsAPI : undefined;
    const docEditor = docsApi?.DocEditor;
    if (
      !docsApi ||
      typeof docsApi !== 'object' ||
      typeof docEditor !== 'function' ||
      staleDocsApis.has(docsApi) ||
      staleDocEditors.has(docEditor)
    ) {
      activeLoad = null;
      clearGlobalDocsApi();
      script.remove();
      rejectLoad(new Error('ONLYOFFICE API script loaded without DocsAPI.DocEditor'));
      return;
    }

    activeLoad = null;
    verifiedBinding = {
      scriptUrl,
      epoch,
      docsApi,
      docEditor,
    };
    resolveLoad();
  };

  script.onerror = () => {
    if (activeLoad === record) {
      activeLoad = null;
    }
    script.remove();
    rejectLoad(new Error('Failed to load ONLYOFFICE API script'));
  };

  document.head.appendChild(script);
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

/** Clear cached prewarm state and invalidate prior script bindings on auth switch/logout or inside tests. */
export function resetOnlyOfficePrewarm(opts?: { clearScriptCache?: boolean; removeDomNodes?: boolean }): void {
  prewarmSeq += 1;
  prewarmPromise = null;
  cachedStatus = null;
  if (opts?.clearScriptCache !== false) {
    invalidateLoaderState();
  } else {
    loaderEpoch += 1;
    activeLoad = null;
  }
  if (opts?.removeDomNodes !== false) {
    removeManagedDomNodes();
  }
}
