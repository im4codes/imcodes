/**
 * "Show in folder" for a download the user saved through the browser's own
 * save dialog.
 *
 * What a web page can do here is narrow, so this file only offers what is
 * actually possible:
 * - Only a download written through the File System Access save picker has a
 *   handle to the saved file. A download handed to the browser's download
 *   manager (Safari, Firefox, the mobile app) is invisible to the page, so
 *   those rows simply get no button rather than a button that does nothing.
 * - It cannot open Finder/Explorer — no web API does — so it opens the system
 *   file dialog already inside the folder the file was saved to
 *   (`startIn: handle`), which is as close as a browser gets.
 *
 * There is deliberately no "Open file". A page cannot launch a local file in
 * its local app, and the only thing it could do instead — read the file back
 * into a `blob:` URL in a new tab — shows a web address rather than opening the
 * file, which is not what anyone clicking "Open file" asked for.
 *
 * Must be called synchronously from the click that asked for it: the file
 * dialog needs the user's gesture, and an await in front of it makes the
 * browser refuse.
 */

/** A saved file the page can read back. */
export interface SavedDownloadFileHandle {
  getFile(): Promise<File>;
}

type OpenFilePicker = (options?: { startIn?: unknown; multiple?: boolean }) => Promise<unknown>;

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

/** Open the system file dialog inside the folder the file was saved to. */
export function revealSavedDownload(handle: SavedDownloadFileHandle): boolean {
  const picker = openFilePicker();
  if (!picker) return false;
  // Dismissing the dialog rejects with AbortError; nothing is being chosen, so
  // every outcome is fine.
  void picker({ startIn: handle }).catch(() => undefined);
  return true;
}
