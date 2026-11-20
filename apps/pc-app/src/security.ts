import path from 'node:path';

export const MAIN_WINDOW_WEB_PREFERENCES = Object.freeze({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webviewTag: false,
} as const);

export const DEFAULT_EXTERNAL_DOCS_HOSTS = [
  'docs.im.codes',
  'github.com',
  'docs.github.com',
] as const;

export const ALLOWED_WEB_PERMISSIONS = new Set<string>([
  'clipboard-read',
  'clipboard-sanitized-write',
  'media',
  'fullscreen',
  'keyboardLock',
  'notifications',
]);

function parseHttpOrigin(rawUrl: string): { protocol: 'http:' | 'https:'; origin: string } | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  if (!parsed.origin || parsed.origin === 'null') {
    return null;
  }
  return { protocol: parsed.protocol, origin: parsed.origin };
}

/**
 * Navigation / redirect target must stay strictly on the currently active
 * trusted origin. Switching servers happens only via main's `selectServer()`.
 */
export function isSameActiveOrigin(
  rawUrl: string,
  activeOrigin: string | null,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  if (!activeOrigin || !trustedOrigins.has(activeOrigin)) return false;
  const parsed = parseHttpOrigin(rawUrl);
  if (!parsed) return false;
  return parsed.origin === activeOrigin && trustedOrigins.has(parsed.origin);
}

/**
 * Separate external-link policy (§4.7): ONLY `https:` URLs targeting explicit
 * documentation / help domains are permitted. Never reuses `trustedOrigins` and
 * never allows arbitrary `https:` destinations.
 */
export function isAllowedExternalUrl(
  rawUrl: string,
  allowedHosts: readonly string[] = DEFAULT_EXTERNAL_DOCS_HOSTS,
): boolean {
  if (!rawUrl) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  return allowedHosts.some((entry) => entry.trim().toLowerCase() === host);
}

export function isAllowedPermissionRequest(params: {
  requestingUrl: string;
  permission: string;
  activeOrigin: string | null;
  trustedOrigins: ReadonlySet<string>;
  currentPageOrigin: string | null;
}): boolean {
  if (!ALLOWED_WEB_PERMISSIONS.has(params.permission)) return false;
  if (!params.activeOrigin || !params.currentPageOrigin) return false;
  if (params.currentPageOrigin !== params.activeOrigin) return false;
  if (!params.trustedOrigins.has(params.activeOrigin)) return false;
  const req = parseHttpOrigin(params.requestingUrl);
  if (!req) return false;
  return req.origin === params.activeOrigin;
}

export interface PreventableEventLike {
  preventDefault(): void;
}

export interface DownloadItemLike {
  getFilename(): string;
  pause?(): void;
  isPaused?(): boolean;
  resume?(): void;
  cancel(): void;
  setSavePath(savePath: string): void;
}

export interface PermissionRequestDetailsLike {
  requestingUrl?: string;
}

export interface SecurityWebContentsLike {
  getURL(): string;
  on(event: 'will-navigate', listener: (event: PreventableEventLike, url: string) => void): unknown;
  on(event: 'will-redirect', listener: (event: PreventableEventLike, url: string) => void): unknown;
  on(event: 'will-attach-webview', listener: (event: PreventableEventLike) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
}

export interface SecuritySessionLike {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details?: PermissionRequestDetailsLike,
    ) => void,
  ): void;
  setPermissionCheckHandler?(
    handler: (
      webContents: unknown,
      permission: string,
      requestingOrigin: string,
    ) => boolean,
  ): void;
  on(event: 'will-download', listener: (event: PreventableEventLike, item: DownloadItemLike, webContents: unknown) => void): unknown;
}

export interface WindowSecurityGuardOptions {
  webContents: SecurityWebContentsLike;
  session: SecuritySessionLike;
  getActiveOrigin: () => string | null;
  getTrustedOrigins: () => ReadonlySet<string>;
  getCurrentTrustedOrigin: () => string | null;
  openExternal: (url: string) => Promise<void> | void;
  /**
   * Synchronously prompt user for a save path (e.g. `dialog.showSaveDialogSync`).
   * Electron's `DownloadItem.setSavePath()` is only honored synchronously within `will-download`.
   */
  promptSavePathSync: (suggestedFilename: string) => string | undefined | null;
  externalDocsHosts?: readonly string[];
}

/**
 * Enforce §4.7 Electron security guards on the main BrowserWindow and session:
 * - Same-active-origin navigation & redirect allowlist
 * - Window-open denial + strict allowlisted external URL handoff
 * - Webview attachment prevention (defense-in-depth alongside webviewTag=false)
 * - Active-trusted-origin scoped permission gate (clipboard, media, fullscreen, keyboardLock & notifications only)
 * - User-confirmed download destination (never silent disk writes)
 */
export function attachWindowSecurityGuards(options: WindowSecurityGuardOptions): void {
  const {
    webContents,
    session,
    getActiveOrigin,
    getTrustedOrigins,
    getCurrentTrustedOrigin,
    openExternal,
    promptSavePathSync,
    externalDocsHosts = DEFAULT_EXTERNAL_DOCS_HOSTS,
  } = options;

  const enforceNavigation = (event: PreventableEventLike, targetUrl: string) => {
    if (!isSameActiveOrigin(targetUrl, getActiveOrigin(), getTrustedOrigins())) {
      event.preventDefault();
    }
  };

  webContents.on('will-navigate', enforceNavigation);
  webContents.on('will-redirect', enforceNavigation);
  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url, externalDocsHosts)) {
      void openExternal(url);
    }
    return { action: 'deny' };
  });

  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (wc !== webContents) {
      callback(false);
      return;
    }
    const requestingUrl = details?.requestingUrl || webContents.getURL();
    const granted = isAllowedPermissionRequest({
      requestingUrl,
      permission,
      activeOrigin: getActiveOrigin(),
      trustedOrigins: getTrustedOrigins(),
      currentPageOrigin: getCurrentTrustedOrigin(),
    });
    callback(granted);
  });

  session.setPermissionCheckHandler?.((wc, permission, requestingOrigin) => {
    if (wc !== webContents) return false;
    return isAllowedPermissionRequest({
      requestingUrl: requestingOrigin || webContents.getURL(),
      permission,
      activeOrigin: getActiveOrigin(),
      trustedOrigins: getTrustedOrigins(),
      currentPageOrigin: getCurrentTrustedOrigin(),
    });
  });

  session.on('will-download', (event, item, wc) => {
    if (wc && wc !== webContents) {
      event.preventDefault();
      item.cancel();
      return;
    }
    const rawName = item.getFilename() || 'download';
    const safeName = path.basename(rawName) || 'download';
    try {
      const chosenPath = promptSavePathSync(safeName);
      if (!chosenPath) {
        event.preventDefault();
        item.cancel();
        return;
      }
      item.setSavePath(chosenPath);
    } catch {
      event.preventDefault();
      item.cancel();
    }
  });
}
