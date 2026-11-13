import { isStandaloneDisplayMode } from './pwa-install.js';
import { publishCloudDocsWindowBlocked } from './cloud-docs-window-notice.js';
import { remoteDesktopWindowBounds, remoteDesktopWindowFeatures } from './remote-desktop-window.js';

export const CLOUD_DOCS_WINDOW_QUERY = 'cloudDocs';
export const CLOUD_DOCS_TAB_QUERY = 'cloudDocsTab';
export const CLOUD_DOCS_FOLDER_QUERY = 'cloudDocsFolder';
export const CLOUD_DOCS_DOC_QUERY = 'cloudDocsDoc';

export type CloudDocsWindowTab = 'recent' | 'my_docs' | 'shared';

export interface CloudDocsWindowParams {
  tab?: CloudDocsWindowTab;
  folderId?: string;
  docId?: string;
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
