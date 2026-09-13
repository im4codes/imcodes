/**
 * "Open file" and "Show in folder" for a download the user saved through the
 * browser's own save dialog.
 *
 * What a web page can do here is narrow, so this file only offers what is
 * actually possible:
 * - Only a download written through the File System Access save picker has a
 *   handle to the saved file. A download handed to the browser's download
 *   manager (Safari, Firefox, the mobile app) is invisible to the page, so
 *   those rows simply get no buttons rather than buttons that do nothing.
 * - "Open file" reads the saved file back and opens it in a new tab, where the
 *   browser renders what it can (images, PDF, text, audio, video).
 * - "Show in folder" cannot open Finder/Explorer — no web API does — so it
 *   opens the system file dialog already inside the folder the file was saved
 *   to (`startIn: handle`), which is as close as a browser gets.
 *
 * Both must be called synchronously from the click that asked for them: the
 * new tab and the file dialog each need the user's gesture, and an await in
 * front of them makes the browser block the request.
 */

/** A saved file the page can read back. */
export interface SavedDownloadFileHandle {
  getFile(): Promise<File>;
}

type OpenFilePicker = (options?: { startIn?: unknown; multiple?: boolean }) => Promise<unknown>;

/** Revoke the object URL well after the new tab has had time to load it. */
const OPENED_FILE_URL_TTL_MS = 60_000;

/** The readable saved-file handle behind a save-picker destination, if any. */
export function savedDownloadFileHandle(handle: unknown): SavedDownloadFileHandle | null {
  if (!handle || typeof handle !== 'object') return null;
  const getFile = (handle as { getFile?: unknown }).getFile;
  return typeof getFile === 'function' ? handle as SavedDownloadFileHandle : null;
}

function openFilePicker(): OpenFilePicker | null {
  const picker = (globalThis as typeof globalThis & { showOpenFilePicker?: OpenFilePicker }).showOpenFilePicker;
  return typeof picker === 'function' ? picker : null;
}

/** Whether "Show in folder" can do anything in this browser. */
export function canRevealSavedDownload(): boolean {
  return openFilePicker() !== null;
}

/**
 * Open the saved file in a new tab. Returns false when the browser blocked the
 * tab, so the caller can say so instead of failing silently.
 */
export function openSavedDownload(handle: SavedDownloadFileHandle): boolean {
  // Opened before any await so the click's user activation is still valid.
  const tab = window.open('', '_blank');
  if (!tab) return false;
  try {
    tab.opener = null;
  } catch {
    // Some browsers make opener read-only; the tab is still usable.
  }
  void handle.getFile().then((file) => {
    const url = URL.createObjectURL(file);
    tab.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), OPENED_FILE_URL_TTL_MS);
  }).catch(() => {
    // The file was moved or deleted since it was saved: close the blank tab
    // rather than leave the user staring at it.
    tab.close();
  });
  return true;
}

/** Open the system file dialog inside the folder the file was saved to. */
export function revealSavedDownload(handle: SavedDownloadFileHandle): boolean {
  const picker = openFilePicker();
  if (!picker) return false;
  // Dismissing the dialog rejects with AbortError; nothing is being chosen, so
  // every outcome is fine.
  void picker({ startIn: handle }).catch(() => undefined);
  return true;
}
