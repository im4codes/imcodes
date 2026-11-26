import { encode } from 'uqr';
import { getApiBaseUrl } from './api.js';
import { DEFAULT_SERVER_URL, isNative } from './native.js';

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
