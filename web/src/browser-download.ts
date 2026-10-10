import { Capacitor, registerPlugin } from '@capacitor/core';

/** Save an in-memory payload using the browser/WebView download surface. */
export function saveBlobViaDownloadAnchor(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const revokeObjectURL = URL.revokeObjectURL;
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  if (typeof revokeObjectURL === 'function') {
    setTimeout(() => revokeObjectURL.call(URL, objectUrl), 0);
  }
}

type NativeFilesystemPlugin = {
  writeFile(options: { path: string; data: string; directory: 'CACHE' }): Promise<{ uri: string }>;
  deleteFile(options: { path: string; directory: 'CACHE' }): Promise<void>;
};

type NativeSharePlugin = {
  share(options: { url: string; title: string }): Promise<unknown>;
};

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('blob_read_failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Restore the native path that shipped before browser-only downloads: write
 * the authenticated HTTP payload to Cache, then ask Capacitor Share to open
 * the system Save/Forward sheet. Registering proxies from @capacitor/core does
 * not add a native dependency; it reuses the plugins already embedded in an
 * installed app and therefore remains safe for a web-only rollout.
 */
export function canUseNativeFileShare(): boolean {
  return Capacitor.isNativePlatform()
    && Capacitor.getPlatform() === 'android'
    && Capacitor.isPluginAvailable('Filesystem')
    && Capacitor.isPluginAvailable('Share');
}

async function tryNativeFileShare(blob: Blob, fileName: string): Promise<boolean> {
  const filesystem = registerPlugin<NativeFilesystemPlugin>('Filesystem');
  const share = registerPlugin<NativeSharePlugin>('Share');
  const safeName = fileName.replace(/[\\/\0]/g, '_') || 'download';
  const cachePath = `imcodes-download-${crypto.randomUUID()}-${safeName}`;
  const data = await blobToBase64(blob);
  const saved = await filesystem.writeFile({ path: cachePath, data, directory: 'CACHE' });
  try {
    await share.share({ url: saved.uri, title: safeName });
  } finally {
    await filesystem.deleteFile({ path: cachePath, directory: 'CACHE' }).catch(() => undefined);
  }
  return true;
}

/**
 * Prefer the mobile system share sheet so the user can choose Save to Files,
 * AirDrop, Messages, or another destination. This is Web Share rather than a
 * Capacitor plugin, so a Web deployment is sufficient. Unsupported browsers
 * retain the ordinary named-download fallback.
 */
export async function shareBlobOrDownload(blob: Blob, fileName: string): Promise<'shared' | 'downloaded'> {
  // Check plugin availability synchronously. In the Web Share fallback there
  // must be no await before navigator.share(), otherwise WKWebView consumes the
  // fresh button gesture before the share sheet is requested.
  if (canUseNativeFileShare()) {
    await tryNativeFileShare(blob, fileName);
    return 'shared';
  }
  const share = navigator.share?.bind(navigator);
  if (share) {
    const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
    const shareData: ShareData = { files: [file], title: fileName };
    if (typeof navigator.canShare !== 'function' || navigator.canShare(shareData)) {
      await share(shareData);
      return 'shared';
    }
  }
  saveBlobViaDownloadAnchor(blob, fileName);
  return 'downloaded';
}
