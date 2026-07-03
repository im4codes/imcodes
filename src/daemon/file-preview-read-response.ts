import { FS_READ_ERROR_CODES } from '../../shared/fs-read-error-codes.js';
import { asValidatedRealPath } from './file-preview-path-policy.js';
import { createProjectFileHandleFromValidatedPath } from './file-transfer-handler.js';
import type {
  PreviewReadPreflightSuccess,
  PreviewReadSnapshotSuccess,
} from './file-preview-read-types.js';

export interface PreviewReadPublicTerminal {
  requestId: string;
  rawPath: string;
  status: 'ok' | 'error';
  resolvedPath?: string;
  content?: string;
  encoding?: 'base64';
  mimeType?: string;
  previewMode?: 'stream';
  size?: number;
  downloadId?: string;
  mtime?: number;
  error?: string;
  previewReason?: string;
}

function createHandle(realPath: string, fileName: string, mimeType: string | undefined, size: number): string | null {
  const validated = asValidatedRealPath(realPath);
  if (!validated) return null;
  return createProjectFileHandleFromValidatedPath(validated, fileName, mimeType, size).id;
}

export function assemblePreflightTerminal(args: {
  requestId: string;
  rawPath: string;
  preflight: PreviewReadPreflightSuccess;
}): PreviewReadPublicTerminal | null {
  const { preflight, requestId, rawPath } = args;
  if (
    preflight.classification.previewKind !== 'too_large'
    && preflight.classification.previewKind !== 'video'
    && preflight.classification.previewKind !== 'audio'
  ) {
    return null;
  }
  const downloadId = createHandle(
    preflight.realPath,
    preflight.fileName,
    preflight.classification.mimeType,
    preflight.size,
  );
  if (!downloadId) {
    return {
      requestId,
      rawPath,
      resolvedPath: preflight.realPath,
      status: 'error',
      error: FS_READ_ERROR_CODES.FORBIDDEN_PATH,
    };
  }
  if (preflight.classification.previewKind === 'too_large') {
    return {
      requestId,
      rawPath,
      resolvedPath: preflight.realPath,
      status: 'error',
      error: FS_READ_ERROR_CODES.FILE_TOO_LARGE,
      previewReason: preflight.classification.previewReason,
      downloadId,
      mtime: preflight.mtimeMs,
    };
  }
  return {
    requestId,
    rawPath,
    resolvedPath: preflight.realPath,
    status: 'ok',
    mimeType: preflight.classification.mimeType,
    previewMode: 'stream',
    size: preflight.size,
    downloadId,
    mtime: preflight.mtimeMs,
  };
}

export function assembleSnapshotTerminal(args: {
  requestId: string;
  rawPath: string;
  snapshot: PreviewReadSnapshotSuccess;
}): PreviewReadPublicTerminal {
  const { requestId, rawPath, snapshot } = args;
  const payload = snapshot.payload;
  const payloadMime = payload.mode === 'base64' || payload.mode === 'stream' ? payload.mimeType : snapshot.classification.mimeType;
  const downloadId = createHandle(snapshot.realPath, snapshot.fileName, payloadMime, snapshot.size);
  if (!downloadId) {
    return {
      requestId,
      rawPath,
      resolvedPath: snapshot.realPath,
      status: 'error',
      error: FS_READ_ERROR_CODES.FORBIDDEN_PATH,
    };
  }
  if (payload.mode === 'unavailable') {
    return {
      requestId,
      rawPath,
      resolvedPath: snapshot.realPath,
      status: 'error',
      error: payload.error,
      previewReason: payload.previewReason,
      downloadId,
      mtime: snapshot.mtimeMs,
    };
  }
  if (payload.mode === 'stream') {
    return {
      requestId,
      rawPath,
      resolvedPath: snapshot.realPath,
      status: 'ok',
      mimeType: payload.mimeType,
      previewMode: 'stream',
      size: payload.size,
      downloadId,
      mtime: snapshot.mtimeMs,
    };
  }
  if (payload.mode === 'base64') {
    return {
      requestId,
      rawPath,
      resolvedPath: snapshot.realPath,
      status: 'ok',
      content: payload.content,
      encoding: 'base64',
      mimeType: payload.mimeType,
      downloadId,
      mtime: snapshot.mtimeMs,
    };
  }
  return {
    requestId,
    rawPath,
    resolvedPath: snapshot.realPath,
    status: 'ok',
    content: payload.content,
    downloadId,
    mtime: snapshot.mtimeMs,
  };
}
