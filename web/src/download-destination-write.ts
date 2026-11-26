import {
  DOWNLOAD_TRANSFER_ROUTE,
  DOWNLOAD_TRANSFER_STATUS,
  abortDownloadCommit,
  beginDownloadCommit,
  completeDownloadTransfer,
  failDownloadTransfer,
  isDownloadTransferPaused,
  setDownloadTransferSavedFile,
  updateDownloadTransfer,
} from './download-transfer-store.js';
import {
  isFileSystemAccessRefusalError,
  isFileUploadCanceled,
  isPcAppDownloadDestination,
  isQuotaOrCapacityError,
  type DirectPreviewDownloadDestination,
  type FileSystemWritableFileStreamLike,
} from './download-destination.js';
import { savedDownloadFileHandle } from './download-file-actions.js';

class DestinationSinkError extends Error {
  constructor(readonly sinkCause: unknown) {
    super(sinkCause instanceof Error ? sinkCause.message : String(sinkCause ?? 'destination_write_failed'));
    this.name = 'DestinationSinkError';
  }
}

function wrapDestinationWriter(rawWriter: FileSystemWritableFileStreamLike): FileSystemWritableFileStreamLike {
  const wrapOp = async <T>(op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (sinkErr) {
      throw new DestinationSinkError(sinkErr);
    }
  };
  return {
    write: (data) => wrapOp(() => rawWriter.write(data)),
    ...(rawWriter.seek ? { seek: (pos: number) => wrapOp(() => rawWriter.seek!(pos)) } : {}),
    ...(rawWriter.truncate ? { truncate: (size: number) => wrapOp(() => rawWriter.truncate!(size)) } : {}),
    close: () => rawWriter.close(),
    abort: (reason) => rawWriter.abort(reason),
  };
}

/**
 * Stream into a chosen save-picker or PC App handle with unified abort,
 * pause-safety, non-cancelable commit window (`beginDownloadCommit`),
 * disk-full (`QuotaExceededError`), and destination-only File System Access refusal fallback.
 * Kept separate from `direct-file-transfer.ts` / `download-transfer-wiring.ts`
 * so `api.ts` never pulls `@capacitor/core` at module load.
 */
export async function writeDownloadDestinationWithFallback(options: {
  transferId: string;
  destination: DirectPreviewDownloadDestination;
  signal: AbortSignal;
  writeTo: (writer: FileSystemWritableFileStreamLike) => Promise<boolean>;
  fallbackToBrowser: () => Promise<void>;
}): Promise<'completed' | 'canceled' | 'fallback'> {
  const { transferId, destination, signal, writeTo, fallbackToBrowser } = options;
  let writer: FileSystemWritableFileStreamLike | null = null;
  const triggerRefusalFallback = async (): Promise<'fallback' | 'canceled'> => {
    if (writer) {
      await writer.abort().catch(() => undefined);
      writer = null;
    }
    if (signal.aborted || isDownloadTransferPaused(transferId)) {
      if (!isDownloadTransferPaused(transferId)) {
        failDownloadTransfer(transferId, true, Date.now(), signal);
      }
      return 'canceled';
    }
    updateDownloadTransfer(transferId, DOWNLOAD_TRANSFER_ROUTE.BROWSER, DOWNLOAD_TRANSFER_STATUS.FALLING_BACK, Date.now(), signal);
    await fallbackToBrowser();
    completeDownloadTransfer(transferId, true, Date.now(), signal);
    return 'fallback';
  };

  try {
    try {
      writer = await destination.handle.createWritable();
    } catch (openErr) {
      if (isDownloadTransferPaused(transferId)) return 'canceled';
      if (signal.aborted || isFileUploadCanceled(openErr)) {
        failDownloadTransfer(transferId, true, Date.now(), signal);
        return 'canceled';
      }
      if (!isPcAppDownloadDestination(destination) && !isQuotaOrCapacityError(openErr) && isFileSystemAccessRefusalError(openErr, { allowTypeError: true })) {
        return await triggerRefusalFallback();
      }
      throw openErr;
    }

    const completed = await writeTo(wrapDestinationWriter(writer));
    if (!completed || signal.aborted || isDownloadTransferPaused(transferId)) {
      await writer.abort().catch(() => undefined);
      writer = null;
      if (!isDownloadTransferPaused(transferId)) {
        failDownloadTransfer(transferId, true, Date.now(), signal);
      }
      return 'canceled';
    }

    if (!beginDownloadCommit(transferId, signal)) {
      await writer.abort().catch(() => undefined);
      writer = null;
      if (!isDownloadTransferPaused(transferId)) {
        failDownloadTransfer(transferId, true, Date.now(), signal);
      }
      return 'canceled';
    }

    try {
      await writer.close();
      writer = null;
    } catch (closeErr) {
      abortDownloadCommit(transferId, signal);
      if (isDownloadTransferPaused(transferId)) return 'canceled';
      if (signal.aborted || isFileUploadCanceled(closeErr)) {
        failDownloadTransfer(transferId, true, Date.now(), signal);
        return 'canceled';
      }
      if (!isPcAppDownloadDestination(destination) && !isQuotaOrCapacityError(closeErr) && isFileSystemAccessRefusalError(closeErr, { allowTypeError: true })) {
        return await triggerRefusalFallback();
      }
      throw closeErr;
    }

    completeDownloadTransfer(transferId, false, Date.now(), signal);
    setDownloadTransferSavedFile(transferId, savedDownloadFileHandle(destination.handle));
    return 'completed';
  } catch (err) {
    if (writer) {
      await writer.abort().catch(() => undefined);
      writer = null;
    }
    if (err instanceof DestinationSinkError) {
      const sinkErr = err.sinkCause;
      if (isDownloadTransferPaused(transferId)) return 'canceled';
      if (signal.aborted || isFileUploadCanceled(sinkErr)) {
        failDownloadTransfer(transferId, true, Date.now(), signal);
        return 'canceled';
      }
      if (!isPcAppDownloadDestination(destination)
        && !isQuotaOrCapacityError(sinkErr) && isFileSystemAccessRefusalError(sinkErr, { allowTypeError: true })) {
        return await triggerRefusalFallback();
      }
      throw sinkErr;
    }
    throw err;
  }
}
