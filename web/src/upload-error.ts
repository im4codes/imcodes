import { FILE_TRANSFER_UPLOAD_ERROR_CODE } from '@shared/transport/file-transfer.js';

/**
 * True when a file-transfer error indicates the daemon ran out of disk space
 * (ENOSPC). The daemon tags such errors with a shared code, the server responds
 * HTTP 507, and the daemon's raw ENOSPC text rides along in the message — so an
 * ApiError surfaces as e.g. "API 507: insufficient_capacity". Match any of them.
 * Shared by the upload composer and the attachment download/preview button.
 */
export function isInsufficientCapacityError(body: string): boolean {
  return body.includes(FILE_TRANSFER_UPLOAD_ERROR_CODE.INSUFFICIENT_CAPACITY)
    || body.includes('507')
    || body.includes('ENOSPC')
    || body.includes('no space left');
}
