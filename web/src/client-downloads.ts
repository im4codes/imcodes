import { encode } from 'uqr';
import {
  CLIENT_DOWNLOAD_API_PREFIX,
  CLIENT_DOWNLOAD_RESOLVE_MODES,
  CLIENT_DOWNLOAD_RESOLVE_QUERY_PARAM,
  CLIENT_DOWNLOAD_RESOLVE_QUERY_VALUE,
  type ClientDownloadResolveResponse,
} from '@shared/client-downloads.js';
import { getApiBaseUrl } from './api.js';
import { DEFAULT_SERVER_URL, isNative } from './native.js';
import { isPcAppDesktop } from './native-platform.js';

export const IOS_APP_STORE_URL = 'https://apps.apple.com/us/app/im-codes/id6761014424';
export const GITHUB_RELEASES_URL = 'https://github.com/im4codes/imcodes/releases';

export const CLIENT_DOWNLOAD_PATHS = {
  macArm64: '/api/downloads/latest/desktop-mac',
  macIntel: '/api/downloads/latest/desktop-mac-intel',
  windows: '/api/downloads/latest/desktop-win',
  linuxDeb: '/api/downloads/latest/desktop-linux-deb',
  linuxSh: '/api/downloads/latest/desktop-linux-sh',
  androidFcm: '/api/downloads/latest/android-with-fcm',
  androidNoFcm: '/api/downloads/latest/android-without-fcm',
} as const;

export type AndroidVariant = 'fcm' | 'no-fcm';

export interface ClientDownloadUrls {
  origin: string;
  macArm64: string;
  macIntel: string;
  windows: string;
  linuxDeb: string;
  linuxSh: string;
  androidFcm: string;
  androidNoFcm: string;
  iosAppStore: string;
  githubReleases: string;
}

export function normalizeHttpOrigin(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.host) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export function resolveDownloadOrigin(explicitBaseUrl?: string | null): string {
  const candidates: Array<string | null | undefined> = [
    explicitBaseUrl,
    getApiBaseUrl(),
    typeof window !== 'undefined' ? window.location?.origin : null,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeHttpOrigin(candidate);
    if (normalized) return normalized;
  }
  return DEFAULT_SERVER_URL;
}

export function resolveClientDownloadUrls(explicitBaseUrl?: string | null): ClientDownloadUrls {
  const origin = resolveDownloadOrigin(explicitBaseUrl);
  return {
    origin,
    macArm64: `${origin}${CLIENT_DOWNLOAD_PATHS.macArm64}`,
    macIntel: `${origin}${CLIENT_DOWNLOAD_PATHS.macIntel}`,
    windows: `${origin}${CLIENT_DOWNLOAD_PATHS.windows}`,
    linuxDeb: `${origin}${CLIENT_DOWNLOAD_PATHS.linuxDeb}`,
    linuxSh: `${origin}${CLIENT_DOWNLOAD_PATHS.linuxSh}`,
    androidFcm: `${origin}${CLIENT_DOWNLOAD_PATHS.androidFcm}`,
    androidNoFcm: `${origin}${CLIENT_DOWNLOAD_PATHS.androidNoFcm}`,
    iosAppStore: IOS_APP_STORE_URL,
    githubReleases: GITHUB_RELEASES_URL,
  };
}

export interface QrMatrixSvgData {
  size: number;
  path: string;
}

/**
 * Generate a local SVG path representing a QR code with zero external requests.
 * Dark modules are combined into a single SVG path for sharp rendering at any zoom.
 */
export function buildQrMatrixPath(data: string, border = 3): QrMatrixSvgData {
  const qr = encode(data, { ecc: 'M', border });
  const commands: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    const row = qr.data[y];
    if (!row) continue;
    let x = 0;
    while (x < qr.size) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      let span = 1;
      while (x + span < qr.size && row[x + span]) {
        span += 1;
      }
      commands.push(`M${x},${y}h${span}v1h-${span}z`);
      x += span;
    }
  }
  return { size: qr.size, path: commands.join('') };
}

const PC_APP_DOWNLOAD_RESOLVE_TIMEOUT_MS = 5000;

export function isPcAppClient(): boolean {
  if (isNative()) return false;
  if (isPcAppDesktop()) return true;
  if (typeof navigator !== 'undefined' && /\bElectron\//i.test(navigator.userAgent ?? '')) {
    return true;
  }
  return false;
}

export function isSafeHttpDownloadUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function resolveBrowserBaseUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.location?.href || normalizeHttpOrigin(window.location?.origin) || undefined;
}

function isSameOriginUrl(resolved: URL, sourceOrigin: string): boolean {
  const windowOrigin = typeof window !== 'undefined' ? normalizeHttpOrigin(window.location?.origin) : null;
  return (windowOrigin !== null && resolved.origin === windowOrigin) || resolved.origin === sourceOrigin;
}

export function isDownloadApiUrl(rawUrl: string): boolean {
  if (!isSafeHttpDownloadUrl(rawUrl)) {
    if (typeof window === 'undefined' || !rawUrl.startsWith(CLIENT_DOWNLOAD_API_PREFIX)) return false;
  }
  try {
    const parsed = new URL(rawUrl, resolveBrowserBaseUrl());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (parsed.username || parsed.password) return false;
    if (!parsed.pathname.startsWith(CLIENT_DOWNLOAD_API_PREFIX)) return false;
    const windowOrigin = typeof window !== 'undefined' ? normalizeHttpOrigin(window.location?.origin) : null;
    return parsed.origin === resolveDownloadOrigin() || (windowOrigin !== null && parsed.origin === windowOrigin);
  } catch {
    return false;
  }
}

function triggerSamePageDownload(url: string): void {
  if (typeof document === 'undefined' || !document.body) {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    return;
  }
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

export async function openPcAppDownloadUrl(url: string): Promise<void> {
  if (!isDownloadApiUrl(url)) return;
  const base = resolveBrowserBaseUrl() ?? 'http://localhost';
  let resolveUrl: URL;
  let fallbackUrl: URL;
  try {
    resolveUrl = new URL(url, base);
    fallbackUrl = new URL(url, base);
  } catch {
    return;
  }
  const sourceOrigin = resolveUrl.origin;
  resolveUrl.searchParams.set(CLIENT_DOWNLOAD_RESOLVE_QUERY_PARAM, CLIENT_DOWNLOAD_RESOLVE_QUERY_VALUE);
  fallbackUrl.searchParams.delete(CLIENT_DOWNLOAD_RESOLVE_QUERY_PARAM);
  const safeFallbackUrl = fallbackUrl.toString();

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => {
        controller.abort();
      }, PC_APP_DOWNLOAD_RESOLVE_TIMEOUT_MS)
    : null;

  try {
    const res = await fetch(resolveUrl.toString(), {
      signal: controller?.signal,
      credentials: 'same-origin',
    });
    const contentType = typeof res.headers?.get === 'function' ? (res.headers.get('content-type') ?? '') : '';
    if (!res.ok || (contentType && !contentType.toLowerCase().includes('json'))) {
      await res.body?.cancel?.().catch(() => {});
      triggerSamePageDownload(safeFallbackUrl);
      return;
    }
    const payload = (await res.json()) as Partial<ClientDownloadResolveResponse> | null;
    if (
      payload?.ok === true &&
      payload.mode === CLIENT_DOWNLOAD_RESOLVE_MODES.REDIRECT &&
      typeof payload.url === 'string'
    ) {
      if (!isSafeHttpDownloadUrl(payload.url)) {
        return;
      }
      const resolvedUrl = new URL(payload.url);
      if (isSameOriginUrl(resolvedUrl, sourceOrigin)) {
        // Same-origin artifacts (e.g. reverse-proxied /artifacts/...) must download in-page
        // via <a download> so old PC App shells never open a blank child BrowserWindow.
        resolvedUrl.searchParams.delete(CLIENT_DOWNLOAD_RESOLVE_QUERY_PARAM);
        const safeTarget = resolvedUrl.pathname.startsWith(CLIENT_DOWNLOAD_API_PREFIX)
          ? safeFallbackUrl
          : resolvedUrl.toString();
        triggerSamePageDownload(safeTarget);
        return;
      }
      if (typeof window !== 'undefined') {
        window.open(resolvedUrl.toString(), '_blank', 'noopener,noreferrer');
      }
      return;
    }
    triggerSamePageDownload(safeFallbackUrl);
  } catch {
    triggerSamePageDownload(safeFallbackUrl);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function openExternalDownloadUrl(url: string): Promise<void> {
  if (!isNative()) return;
  try {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
  } catch {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }
}
