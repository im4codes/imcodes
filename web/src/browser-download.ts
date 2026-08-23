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

/**
 * Prefer the mobile system share sheet so the user can choose Save to Files,
 * AirDrop, Messages, or another destination. This is Web Share rather than a
 * Capacitor plugin, so a Web deployment is sufficient. Unsupported browsers
 * retain the ordinary named-download fallback.
 */
export async function shareBlobOrDownload(blob: Blob, fileName: string): Promise<'shared' | 'downloaded'> {
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
