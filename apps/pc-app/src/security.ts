import path from 'node:path';

export const MAIN_WINDOW_WEB_PREFERENCES = Object.freeze({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webviewTag: false,
} as const);

export type WindowOpenWebPreferences = typeof MAIN_WINDOW_WEB_PREFERENCES & { preload?: string };

export interface ChildBrowserWindowOptions {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  autoHideMenuBar: boolean;
  webPreferences: WindowOpenWebPreferences;
}

export type WindowOpenHandlerResult =
  | { action: 'deny' }
  | {
      action: 'allow';
      overrideBrowserWindowOptions?: ChildBrowserWindowOptions;
    };

export function buildChildWindowWebPreferences(preloadPath?: string): WindowOpenWebPreferences {
  return preloadPath
    ? { ...MAIN_WINDOW_WEB_PREFERENCES, preload: preloadPath }
    : { ...MAIN_WINDOW_WEB_PREFERENCES };
}

export function buildChildWindowOptions(preloadPath?: string): ChildBrowserWindowOptions {
  return {
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    autoHideMenuBar: true,
    webPreferences: buildChildWindowWebPreferences(preloadPath),
  };
}

export const DEFAULT_EXTERNAL_DOCS_HOSTS = [
  'docs.im.codes',
  'github.com',
  'docs.github.com',
] as const;

const INTERNAL_VIRTUAL_HOSTS = new Set([
  'imcodes-welcome.local',
  'imcodes-prompt.local',
]);

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
 * Same-origin `/api/downloads/` links must open externally in the system browser
 * rather than opening a blank child BrowserWindow inside Electron.
 */
export function isSameOriginDownloadUrl(
  rawUrl: string,
  activeOrigin: string | null,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  if (!isSameActiveOrigin(rawUrl, activeOrigin, trustedOrigins)) return false;
  try {
    return new URL(rawUrl).pathname.startsWith('/api/downloads/');
  } catch {
    return false;
  }
}

/**
 * External-link policy for opening URLs in the system default browser (§4.7):
 * - Permits valid `https:` and `http:` URLs with a non-empty host and no embedded credentials.
 * - Rejects dangerous/unsupported schemes (`file:`, `javascript:`, `vbscript:`, `data:`, `smb:`, `ftp:`, etc.),
 *   malformed URLs, and internal virtual Electron hosts.
 * - When `allowedHosts` is explicitly supplied, restricts the hostname to that list.
 */
export function isAllowedExternalUrl(
  rawUrl: string,
  allowedHosts?: readonly string[],
): boolean {
  if (!rawUrl) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (!host || INTERNAL_VIRTUAL_HOSTS.has(host)) return false;
  if (allowedHosts !== undefined) {
    return allowedHosts.some((entry) => entry.trim().toLowerCase() === host);
  }
  return true;
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

export interface ChildWindowLike {
  webContents: SecurityWebContentsLike;
}

export interface SecurityWebContentsLike {
  getURL(): string;
  on(event: 'will-navigate', listener: (event: PreventableEventLike, url: string) => void): unknown;
  on(event: 'will-redirect', listener: (event: PreventableEventLike, url: string) => void): unknown;
  on(event: 'will-attach-webview', listener: (event: PreventableEventLike) => void): unknown;
  on(event: 'did-create-window', listener: (window: ChildWindowLike, details?: unknown) => void): unknown;
  once?(event: 'destroyed', listener: () => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenHandlerResult): void;
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

export interface ChildWindowSecurityGuardOptions {
  webContents: SecurityWebContentsLike;
  getActiveOrigin: () => string | null;
  getTrustedOrigins: () => ReadonlySet<string>;
  openExternal: (url: string) => Promise<void> | void;
  preloadPath?: string;
  externalDocsHosts?: readonly string[];
  onChildWindowCreated?: (childWindow: ChildWindowLike) => void;
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
  onTrustedMediaPermissionRequest?: (details?: PermissionRequestDetailsLike) => Promise<boolean> | boolean;
  onWebContentsAdded?: (webContents: unknown) => void;
  onWebContentsRemoved?: (webContents: unknown) => void;
  onWebContentsNavigatedAway?: (webContents: unknown) => void;
  preloadPath?: string;
  externalDocsHosts?: readonly string[];
}

/**
 * Attach §4.7 navigation, redirect, webview, and window-open guards onto a window's webContents
 * (and recursively onto any same-origin child BrowserWindows created via `did-create-window`).
 */
export function attachChildWindowSecurityGuards(options: ChildWindowSecurityGuardOptions): void {
  const {
    webContents,
    getActiveOrigin,
    getTrustedOrigins,
    openExternal,
    preloadPath,
    externalDocsHosts,
    onChildWindowCreated,
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
    const activeOrigin = getActiveOrigin();
    const trustedOrigins = getTrustedOrigins();
    if (isSameOriginDownloadUrl(url, activeOrigin, trustedOrigins)) {
      if (isAllowedExternalUrl(url, externalDocsHosts)) {
        void Promise.resolve(openExternal(url)).catch(() => {});
      }
      return { action: 'deny' };
    }
    if (isSameActiveOrigin(url, activeOrigin, trustedOrigins)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: buildChildWindowOptions(preloadPath),
      };
    }
    if (isAllowedExternalUrl(url, externalDocsHosts)) {
      void Promise.resolve(openExternal(url)).catch(() => {});
    }
    return { action: 'deny' };
  });

  webContents.on?.('did-create-window', (childWindow) => {
    onChildWindowCreated?.(childWindow);
    attachChildWindowSecurityGuards({
      webContents: childWindow.webContents,
      getActiveOrigin,
      getTrustedOrigins,
      openExternal,
      preloadPath,
      externalDocsHosts,
      onChildWindowCreated,
    });
  });
}

function isSecurityWebContents(value: unknown): value is SecurityWebContentsLike {
  return Boolean(value && typeof value === 'object' && typeof (value as SecurityWebContentsLike).getURL === 'function');
}

/**
 * Enforce §4.7 Electron security guards on the main BrowserWindow and session:
 * - Same-active-origin navigation & redirect allowlist
 * - Same-origin popout BrowserWindow allowlist with enforced webPreferences + external URL handoff
 * - Child BrowserWindow security inheritance via `did-create-window`
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
    onTrustedMediaPermissionRequest,
    onWebContentsAdded,
    onWebContentsRemoved,
    onWebContentsNavigatedAway,
    preloadPath,
    externalDocsHosts,
  } = options;

  const allowedWebContents = new Set<unknown>([webContents]);
  const attachLifecycleListeners = (wc: SecurityWebContentsLike) => {
    const dynamicWc = wc as SecurityWebContentsLike & {
      on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
    };
    dynamicWc.on?.('did-navigate', () => {
      if (!isSameActiveOrigin(wc.getURL(), getActiveOrigin(), getTrustedOrigins())) {
        onWebContentsNavigatedAway?.(wc);
      }
    });
    wc.once?.('destroyed', () => {
      allowedWebContents.delete(wc);
      onWebContentsRemoved?.(wc);
    });
  };
  onWebContentsAdded?.(webContents);
  attachLifecycleListeners(webContents);

  attachChildWindowSecurityGuards({
    webContents,
    getActiveOrigin,
    getTrustedOrigins,
    openExternal,
    preloadPath,
    externalDocsHosts,
    onChildWindowCreated: (childWindow) => {
      allowedWebContents.add(childWindow.webContents);
      onWebContentsAdded?.(childWindow.webContents);
      attachLifecycleListeners(childWindow.webContents);
    },
  });

  const resolveWindowPageOrigin = (wc: unknown): string | null => {
    const mainTrusted = getCurrentTrustedOrigin();
    if (!mainTrusted) return null;
    if (wc === webContents) return mainTrusted;
    if (!isSecurityWebContents(wc)) return null;
    return isSameActiveOrigin(wc.getURL(), getActiveOrigin(), getTrustedOrigins()) ? getActiveOrigin() : null;
  };

  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (!allowedWebContents.has(wc)) {
      callback(false);
      return;
    }
    const requestingUrl = details?.requestingUrl || (isSecurityWebContents(wc) ? wc.getURL() : webContents.getURL());
    const granted = isAllowedPermissionRequest({
      requestingUrl,
      permission,
      activeOrigin: getActiveOrigin(),
      trustedOrigins: getTrustedOrigins(),
      currentPageOrigin: resolveWindowPageOrigin(wc),
    });
    if (!granted) {
      callback(false);
      return;
    }
    if (permission === 'media' && onTrustedMediaPermissionRequest) {
      Promise.resolve(onTrustedMediaPermissionRequest(details)).then(
        (allowed) => callback(Boolean(allowed)),
        () => callback(false),
      );
      return;
    }
    callback(true);
  });

  session.setPermissionCheckHandler?.((wc, permission, requestingOrigin) => {
    if (!allowedWebContents.has(wc)) return false;
    return isAllowedPermissionRequest({
      requestingUrl: requestingOrigin || (isSecurityWebContents(wc) ? wc.getURL() : webContents.getURL()),
      permission,
      activeOrigin: getActiveOrigin(),
      trustedOrigins: getTrustedOrigins(),
      currentPageOrigin: resolveWindowPageOrigin(wc),
    });
  });

  session.on('will-download', (event, item, wc) => {
    if (wc && !allowedWebContents.has(wc)) {
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
