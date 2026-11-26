import { DIRECT_FILE_TRANSFER_ERROR } from '@shared/direct-file-transfer.js';
import { isNative } from './native.js';
import { getPcAppBridge, type PcAppDownloadsBridge } from './native-platform.js';

export class DirectFileTransferFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable = true,
    message = code,
  ) {
    super(message);
    this.name = 'DirectFileTransferFailure';
  }
}

export interface FileSystemWritableFileStreamLike {
  write(data: BufferSource): Promise<void>;
  seek?(position: number): Promise<void>;
  truncate?(size: number): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface FileSystemFileHandleLike {
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStreamLike>;
  getFile?(): Promise<File>;
  reveal?(): Promise<boolean> | boolean;
}

export interface DirectPreviewDownloadDestination {
  readonly handle: FileSystemFileHandleLike;
}

const pcAppDownloadDestinations = new WeakSet<DirectPreviewDownloadDestination>();

/** Returns true when running inside an Electron PC App shell (even older builds without `.downloads`). */
export function isElectronPcAppRuntime(): boolean {
  if (getPcAppBridge() !== null) return true;
  const ua = typeof navigator !== 'undefined' ? (navigator.userAgent ?? '') : '';
  return /\bElectron\//i.test(ua);
}

/** Returns true when `destination` was created via the PC App `.downloads` IPC bridge. */
export function isPcAppDownloadDestination(
  destination: DirectPreviewDownloadDestination | null | undefined,
): boolean {
  return destination != null && pcAppDownloadDestinations.has(destination);
}

type SavePicker = (options?: {
  suggestedName?: string;
  excludeAcceptAllOption?: boolean;
}) => Promise<FileSystemFileHandleLike>;

const FILE_SYSTEM_ACCESS_REFUSAL_ERROR_NAMES = new Set([
  'SecurityError',
  'NotAllowedError',
  'InvalidModificationError',
  'NoModificationAllowedError',
]);

export function errorNameOf(error: unknown): string | null {
  if (error instanceof DOMException || error instanceof Error) return error.name;
  return typeof error === 'object' && error !== null && 'name' in error && typeof (error as { name?: unknown }).name === 'string'
    ? (error as { name: string }).name
    : null;
}

export function isFileSystemAbortError(error: unknown): boolean {
  return errorNameOf(error) === 'AbortError';
}

export function isQuotaOrCapacityError(error: unknown): boolean {
  if (errorNameOf(error) === 'QuotaExceededError') return true;
  if (error instanceof DirectFileTransferFailure && error.code === DIRECT_FILE_TRANSFER_ERROR.INSUFFICIENT_CAPACITY) {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /\benospc\b|quota|no space|insufficient_capacity|disk full/i.test(msg);
}

export function isFileSystemAccessRefusalError(
  error: unknown,
  options?: { allowTypeError?: boolean },
): boolean {
  if (isQuotaOrCapacityError(error) || isFileSystemAbortError(error)) return false;
  const name = errorNameOf(error);
  if (name === null) return false;
  if (options?.allowTypeError && name === 'TypeError') return true;
  return FILE_SYSTEM_ACCESS_REFUSAL_ERROR_NAMES.has(name);
}

export function isFileUploadCanceled(error: unknown): boolean {
  return (error instanceof DirectFileTransferFailure && error.code === DIRECT_FILE_TRANSFER_ERROR.CANCELED)
    || isFileSystemAbortError(error);
}

const PC_APP_DOWNLOAD_CHUNK_BYTES = 16 * 1024 * 1024;

function mapPcAppDownloadError(error: unknown): Error {
  if (isQuotaOrCapacityError(error)) {
    const msg = error instanceof Error ? error.message : String(error ?? 'QuotaExceededError');
    const err = new Error(msg);
    err.name = 'QuotaExceededError';
    return err;
  }
  return error instanceof Error ? error : new Error(String(error ?? DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED));
}

function createPcAppDestinationHandle(
  downloads: Required<Pick<PcAppDownloadsBridge, 'openWriter' | 'writeChunk' | 'closeWriter' | 'abortWriter' | 'getFileSize'>> &
    Pick<PcAppDownloadsBridge, 'seekWriter' | 'truncateWriter' | 'revealFile'>,
  handleId: string,
  initialName: string,
): FileSystemFileHandleLike {
  let fileName = initialName || 'download';
  return {
    async getFile(): Promise<File> {
      const info = await downloads.getFileSize({ handleId });
      fileName = info.name || fileName;
      const size = Number.isSafeInteger(info.size) && info.size >= 0 ? info.size : 0;
      const file = new File([], fileName);
      Object.defineProperty(file, 'size', { value: size, configurable: true });
      return file;
    },
    async createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStreamLike> {
      let writerId: string;
      try {
        ({ writerId } = await downloads.openWriter({
          handleId,
          keepExistingData: Boolean(options?.keepExistingData),
        }));
      } catch (err) {
        throw mapPcAppDownloadError(err);
      }

      let settled = false;
      return {
        async write(data: BufferSource): Promise<void> {
          if (settled) throw new Error('download_writer_closed');
          const bytes = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          for (let offset = 0; offset < bytes.byteLength; offset += PC_APP_DOWNLOAD_CHUNK_BYTES) {
            const slice = bytes.subarray(offset, Math.min(offset + PC_APP_DOWNLOAD_CHUNK_BYTES, bytes.byteLength));
            try {
              await downloads.writeChunk({ writerId, chunk: slice });
            } catch (err) {
              throw mapPcAppDownloadError(err);
            }
          }
        },
        ...(downloads.seekWriter
          ? {
              async seek(position: number): Promise<void> {
                if (settled) throw new Error('download_writer_closed');
                try {
                  await downloads.seekWriter!({ writerId, position });
                } catch (err) {
                  throw mapPcAppDownloadError(err);
                }
              },
            }
          : {}),
        ...(downloads.truncateWriter
          ? {
              async truncate(size: number): Promise<void> {
                if (settled) throw new Error('download_writer_closed');
                try {
                  await downloads.truncateWriter!({ writerId, size });
                } catch (err) {
                  throw mapPcAppDownloadError(err);
                }
              },
            }
          : {}),
        async close(): Promise<void> {
          if (settled) throw new Error('download_writer_closed');
          settled = true;
          try {
            await downloads.closeWriter({ writerId });
          } catch (err) {
            throw mapPcAppDownloadError(err);
          }
        },
        async abort(): Promise<void> {
          if (settled) return;
          settled = true;
          await downloads.abortWriter({ writerId }).catch(() => undefined);
        },
      };
    },
    ...(downloads.revealFile
      ? {
          reveal(): Promise<boolean> {
            return downloads.revealFile!({ handleId });
          },
        }
      : {}),
  };
}

export async function selectPreviewDownloadDestination(suggestedName?: string): Promise<DirectPreviewDownloadDestination | null> {
  // Native WebViews must not use a coincidental/partial File System Access
  // surface. If embedded Filesystem+Share plugins are unavailable, the caller
  // falls back to the authenticated Browser.open download path instead of an
  // invisible hidden-anchor handoff.
  if (isNative()) return null;

  const pcDownloads = getPcAppBridge()?.downloads;
  if (
    pcDownloads?.pickSaveFile &&
    pcDownloads.openWriter &&
    pcDownloads.writeChunk &&
    pcDownloads.closeWriter &&
    pcDownloads.abortWriter &&
    pcDownloads.getFileSize
  ) {
    let picked: Awaited<ReturnType<NonNullable<PcAppDownloadsBridge['pickSaveFile']>>>;
    try {
      picked = await pcDownloads.pickSaveFile(suggestedName ? { suggestedName } : undefined);
    } catch (error) {
      if (isFileSystemAbortError(error)) {
        throw new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false, 'save_picker_canceled');
      }
      throw new DirectFileTransferFailure(
        DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED,
        false,
        error instanceof Error ? error.message : DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED,
      );
    }
    if (picked.canceled) {
      throw new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false, 'save_picker_canceled');
    }
    const destination: DirectPreviewDownloadDestination = {
      handle: createPcAppDestinationHandle(
        {
          openWriter: pcDownloads.openWriter,
          writeChunk: pcDownloads.writeChunk,
          seekWriter: pcDownloads.seekWriter,
          truncateWriter: pcDownloads.truncateWriter,
          closeWriter: pcDownloads.closeWriter,
          abortWriter: pcDownloads.abortWriter,
          getFileSize: pcDownloads.getFileSize,
          revealFile: pcDownloads.revealFile,
        },
        picked.handleId,
        picked.name || suggestedName || 'download',
      ),
    };
    pcAppDownloadDestinations.add(destination);
    return destination;
  }

  // Older Electron PC App shells without the `.downloads` IPC bridge still
  // expose Chromium's `window.showSaveFilePicker()`, whose writable stream
  // rejects on permission and would fall back to `will-download` — showing
  // two save dialogs in a row. Return `null` so Electron handles saving once.
  if (isElectronPcAppRuntime()) return null;

  const picker = (globalThis as typeof globalThis & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) return null;
  try {
    return { handle: await picker({ ...(suggestedName ? { suggestedName } : {}) }) };
  } catch (error) {
    // Picker cancellation is a user cancellation, never a retry or HTTP
    // fallback trigger.  The browser exposes AbortError for it.
    if (isFileSystemAbortError(error)) {
      throw new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false, 'save_picker_canceled');
    }
    const name = errorNameOf(error);
    if (name === 'SecurityError' || name === 'NotAllowedError' || name === 'TypeError') {
      return null;
    }
    throw new DirectFileTransferFailure(
      DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED,
      false,
      error instanceof Error ? error.message : DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED,
    );
  }
}
