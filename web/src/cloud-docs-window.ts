import { isStandaloneDisplayMode } from './pwa-install.js';
import { publishCloudDocsWindowBlocked } from './cloud-docs-window-notice.js';
import { remoteDesktopWindowBounds, remoteDesktopWindowFeatures } from './remote-desktop-window.js';
import type { CloudDocQuoteTarget } from './cloud-docs-reference.js';

export const CLOUD_DOCS_WINDOW_QUERY = 'cloudDocs';
export const CLOUD_DOCS_TAB_QUERY = 'cloudDocsTab';
export const CLOUD_DOCS_FOLDER_QUERY = 'cloudDocsFolder';
export const CLOUD_DOCS_DOC_QUERY = 'cloudDocsDoc';
export const CLOUD_DOCS_QUOTE_CHANNEL = 'imcodes:cloud-docs-quote';

export type CloudDocsWindowTab = 'recent' | 'my_docs' | 'shared';

export interface CloudDocsWindowParams {
  tab?: CloudDocsWindowTab;
  folderId?: string;
  docId?: string;
}

export interface CloudDocQuoteMessage {
  type: 'cloud_doc_quote';
  target: CloudDocQuoteTarget;
  ts: number;
}

const VALID_CLOUD_DOCS_TABS = new Set<CloudDocsWindowTab>(['recent', 'my_docs', 'shared']);

/** Whether the current document URL asks to mount the standalone Cloud Docs workspace. */
export function isCloudDocsStandaloneWindow(search = window.location.search): boolean {
  const value = new URLSearchParams(search).get(CLOUD_DOCS_WINDOW_QUERY);
  return value === '1' || value === 'true';
}

/** Parse optional deep-link tab / folder / document parameters for standalone Cloud Docs. */
export function readCloudDocsWindowParams(search = window.location.search): CloudDocsWindowParams {
  const sp = new URLSearchParams(search);
  const rawTab = sp.get(CLOUD_DOCS_TAB_QUERY);
  const rawFolder = sp.get(CLOUD_DOCS_FOLDER_QUERY)?.trim() || undefined;
  const rawDoc = sp.get(CLOUD_DOCS_DOC_QUERY)?.trim() || undefined;
  const tab = rawTab && VALID_CLOUD_DOCS_TABS.has(rawTab as CloudDocsWindowTab)
    ? (rawTab as CloudDocsWindowTab)
    : undefined;
  return {
    ...(tab ? { tab } : {}),
    ...(rawFolder ? { folderId: rawFolder } : {}),
    ...(rawDoc ? { docId: rawDoc } : {}),
  };
}

/** Build the standalone Cloud Docs URL from the current origin/path, stripping unrelated query/hash state. */
export function buildCloudDocsWindowUrl(
  params?: CloudDocsWindowParams,
  currentUrl = window.location.href,
): string {
  const url = new URL(currentUrl);
  url.search = '';
  url.hash = '';
  url.searchParams.set(CLOUD_DOCS_WINDOW_QUERY, '1');
  if (params?.tab) url.searchParams.set(CLOUD_DOCS_TAB_QUERY, params.tab);
  if (params?.folderId) url.searchParams.set(CLOUD_DOCS_FOLDER_QUERY, params.folderId);
  if (params?.docId) url.searchParams.set(CLOUD_DOCS_DOC_QUERY, params.docId);
  return url.toString();
}

/**
 * Open Cloud Docs in a detached browser window (or sibling app window inside an installed PWA),
 * severing opener references and notifying if pop-ups are blocked.
 */
export function openCloudDocsWindow(params?: CloudDocsWindowParams): Window | null {
  const url = buildCloudDocsWindowUrl(params);
  const opened = isStandaloneDisplayMode()
    ? window.open(url, '_blank')
    : window.open(url, '_blank', remoteDesktopWindowFeatures(remoteDesktopWindowBounds(1280, 840)));
  if (opened) {
    try { opened.opener = null; } catch { /* Browser policy may already isolate the window. */ }
  } else {
    publishCloudDocsWindowBlocked();
  }
  return opened;
}

function isValidCloudDocQuoteTarget(value: unknown): value is CloudDocQuoteTarget {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CloudDocQuoteTarget> & Record<string, unknown>;
  if (candidate.kind === 'cloud_doc') {
    return typeof candidate.docId === 'string' && candidate.docId.length > 0 && typeof candidate.name === 'string';
  }
  if (candidate.kind === 'server_file') {
    return typeof candidate.path === 'string' && candidate.path.length > 0 && typeof candidate.name === 'string';
  }
  return false;
}

/**
 * Broadcast a document quote from a detached/standalone Cloud Docs window
 * to any same-origin main app window listening on `CLOUD_DOCS_QUOTE_CHANNEL`.
 */
export function publishCloudDocQuote(target: CloudDocQuoteTarget): boolean {
  if (typeof BroadcastChannel === 'undefined') return false;
  try {
    const channel = new BroadcastChannel(CLOUD_DOCS_QUOTE_CHANNEL);
    try {
      const payload: CloudDocQuoteMessage = {
        type: 'cloud_doc_quote',
        target,
        ts: Date.now(),
      };
      channel.postMessage(payload);
      return true;
    } finally {
      channel.close();
    }
  } catch {
    return false;
  }
}

/**
 * Subscribe to document quotes posted by standalone Cloud Docs windows.
 * Returns a cleanup callback. Safe no-op when BroadcastChannel is unavailable.
 */
export function subscribeCloudDocQuotes(
  onQuote: (target: CloudDocQuoteTarget) => void,
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  try {
    const channel = new BroadcastChannel(CLOUD_DOCS_QUOTE_CHANNEL);
    const handleMessage = (event: MessageEvent<unknown>) => {
      const data = event.data as Partial<CloudDocQuoteMessage> | null | undefined;
      if (!data || data.type !== 'cloud_doc_quote') return;
      if (!isValidCloudDocQuoteTarget(data.target)) return;
      onQuote(data.target);
    };
    channel.addEventListener('message', handleMessage);
    return () => {
      try {
        channel.removeEventListener('message', handleMessage);
        channel.close();
      } catch {
        // Ignore channel close errors on teardown.
      }
    };
  } catch {
    return () => {};
  }
}
