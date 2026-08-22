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
