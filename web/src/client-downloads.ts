import { encode } from 'uqr';
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

export function isDownloadApiUrl(rawUrl: string): boolean {
  if (!isSafeHttpDownloadUrl(rawUrl)) {
    if (typeof window === 'undefined' || !rawUrl.startsWith('/api/downloads/')) return false;
  }
  try {
    const base = typeof window !== 'undefined' ? window.location?.href : undefined;
    const parsed = new URL(rawUrl, base);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (parsed.username || parsed.password) return false;
    if (!parsed.pathname.startsWith('/api/downloads/')) return false;
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
  const base = typeof window !== 'undefined' ? window.location?.href : 'http://localhost';
  let resolveUrl: URL;
  try {
    resolveUrl = new URL(url, base);
  } catch {
    return;
  }
  resolveUrl.searchParams.set('resolve', 'json');

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
      triggerSamePageDownload(url);
      return;
    }
    const payload = (await res.json()) as { ok?: unknown; mode?: unknown; url?: unknown } | null;
    if (payload?.ok === true && payload.mode === 'redirect' && typeof payload.url === 'string') {
      if (isSafeHttpDownloadUrl(payload.url)) {
        if (typeof window !== 'undefined') {
          window.open(payload.url, '_blank', 'noopener,noreferrer');
        }
        return;
      }
      return;
    }
    triggerSamePageDownload(url);
  } catch {
    triggerSamePageDownload(url);
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
