import { R2_RELAY_PHASE } from '@shared/r2-relay.js';
import {
  reportR2Preparation,
  DOWNLOAD_TRANSFER_ROUTE,
  DOWNLOAD_TRANSFER_STATUS,
  completeDownloadTransfer,
  reportDownloadTransferProgress,
  setDownloadTransferSave,
  setDownloadTransferSavedFile,
  updateDownloadTransfer,
} from './download-transfer-store.js';
import {
  FILE_DOWNLOAD_TRANSPORT_MODE,
  type DirectPreviewDownloadDestination,
  type FileDownloadProgress,
  type FileDownloadTransportMode,
} from './direct-file-transfer.js';
import { savedDownloadFileHandle } from './download-file-actions.js';

/**
 * Connects one download attempt to its row in the download center: route and
 * status as the transport changes, progress, the mobile "ready to save" hand-
 * off, and — once it completes — the saved file that lets the row offer
 * "Show in folder".
 *
 * Shared by every surface that downloads into the center (file browser, chat),
 * so they cannot drift apart. Create one per attempt: a retry starts clean.
 */
export function createDownloadTransferWiring(transferId: string) {
  const state = { handedOffToBrowser: false, savePending: false };
  return {
    state,
    onSaveReady(save: () => Promise<void>): void {
      state.savePending = true;
      setDownloadTransferSave(transferId, save);
    },
    onProgress(progress: FileDownloadProgress): void {
      const { loadedBytes, totalBytes } = progress;
      if (progress.phase === R2_RELAY_PHASE.PREPARING && totalBytes !== null) {
        reportR2Preparation(transferId, { phase: R2_RELAY_PHASE.PREPARING, loadedBytes, totalBytes,
          speedBps: progress.speedBps ?? 0, etaSeconds: progress.etaSeconds ?? null });
        return;
      }
      reportDownloadTransferProgress(transferId, loadedBytes, totalBytes);
    },
    onMode(mode: FileDownloadTransportMode): void {
      if (mode === FILE_DOWNLOAD_TRANSPORT_MODE.R2) {
        updateDownloadTransfer(transferId, DOWNLOAD_TRANSFER_ROUTE.R2, DOWNLOAD_TRANSFER_STATUS.PREPARING);
      } else if (mode === FILE_DOWNLOAD_TRANSPORT_MODE.CONNECTING) {
        updateDownloadTransfer(transferId, DOWNLOAD_TRANSFER_ROUTE.PENDING, DOWNLOAD_TRANSFER_STATUS.CONNECTING);
      } else if (mode === FILE_DOWNLOAD_TRANSPORT_MODE.DIRECT) {
        updateDownloadTransfer(transferId, DOWNLOAD_TRANSFER_ROUTE.DIRECT, DOWNLOAD_TRANSFER_STATUS.TRANSFERRING);
      } else if (mode === FILE_DOWNLOAD_TRANSPORT_MODE.RECOVERING) {
        updateDownloadTransfer(transferId, DOWNLOAD_TRANSFER_ROUTE.DIRECT, DOWNLOAD_TRANSFER_STATUS.TRANSFERRING);
      } else if (mode === FILE_DOWNLOAD_TRANSPORT_MODE.FALLING_BACK) {
        updateDownloadTransfer(transferId, DOWNLOAD_TRANSFER_ROUTE.HTTP, DOWNLOAD_TRANSFER_STATUS.FALLING_BACK);
      } else if (mode === FILE_DOWNLOAD_TRANSPORT_MODE.HTTP) {
        updateDownloadTransfer(transferId, DOWNLOAD_TRANSFER_ROUTE.HTTP, DOWNLOAD_TRANSFER_STATUS.TRANSFERRING);
      } else {
        state.handedOffToBrowser = true;
        updateDownloadTransfer(transferId, DOWNLOAD_TRANSFER_ROUTE.BROWSER, DOWNLOAD_TRANSFER_STATUS.PREPARING);
      }
    },
    /**
     * Settle a finished attempt. A download that still waits for the mobile
     * save sheet stays "ready to save"; one written through the save picker
     * keeps its file so the row can show it in its folder; one handed to the browser's
     * download manager is invisible to the page and gets no such buttons.
     */
    complete(destination: DirectPreviewDownloadDestination | null | undefined): void {
      if (state.savePending) return;
      completeDownloadTransfer(transferId, state.handedOffToBrowser);
      if (!state.handedOffToBrowser) {
        setDownloadTransferSavedFile(transferId, savedDownloadFileHandle(destination?.handle));
      }
    },
  };
}
