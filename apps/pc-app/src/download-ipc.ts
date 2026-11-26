import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { isSameActiveOrigin } from './security.js';
import type { PcAppIpcInvokeEventLike, PcAppIpcMainLike } from './voice-ipc.js';

export const PC_APP_DOWNLOAD_CHANNELS = Object.freeze({
  pickSaveFile: 'imcodes:pc-download:pick-save-file',
  openWriter: 'imcodes:pc-download:open-writer',
  writeChunk: 'imcodes:pc-download:write-chunk',
  seekWriter: 'imcodes:pc-download:seek-writer',
  truncateWriter: 'imcodes:pc-download:truncate-writer',
  closeWriter: 'imcodes:pc-download:close-writer',
  abortWriter: 'imcodes:pc-download:abort-writer',
  getFileSize: 'imcodes:pc-download:get-file-size',
  revealFile: 'imcodes:pc-download:reveal-file',
} as const);

export const PC_APP_DOWNLOAD_MAX_CHUNK_BYTES = 16 * 1024 * 1024;

export interface PcAppDownloadSaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface PcAppDownloadControllerDeps {
  isAllowedWebContents: (sender: unknown) => boolean;
  getCurrentTrustedOrigin: () => string | null;
  getActiveOrigin: () => string | null;
  getTrustedOrigins: () => ReadonlySet<string>;
  getSenderUrl?: (sender: unknown) => string;
  getDefaultDownloadsDir?: () => string;
  showSaveDialog: (
    sender: unknown,
    options: { defaultPath: string },
  ) => Promise<PcAppDownloadSaveDialogResult>;
  showItemInFolder: (filePath: string) => Promise<void> | void;
  fsOps?: Pick<typeof fs, 'open' | 'rename' | 'stat' | 'unlink'>;
}

export interface PcAppDownloadController {
  registerIpc: (ipcMain: PcAppIpcMainLike) => void;
  unregisterIpc: (ipcMain: PcAppIpcMainLike) => void;
  cleanupWebContents: (webContents: unknown) => Promise<void>;
  cleanupOriginMismatch: (activeOrigin: string | null) => Promise<void>;
  dispose: () => Promise<void>;
  /** Exposed for diagnostic/unit-test verification only. */
  activeCounts: () => { handles: number; writers: number };
}

interface DownloadHandleRecord {
  handleId: string;
  filePath: string;
  name: string;
  ownerWebContents: unknown;
  origin: string;
}

interface DownloadWriterRecord {
  writerId: string;
  handleId: string;
  ownerWebContents: unknown;
  origin: string;
  targetPath: string;
  stagingPath: string | null;
  fd: fs.FileHandle;
  position: number;
  initialSize: number;
  createdNewTarget: boolean;
  closed: boolean;
}

export function sanitizeDownloadFilename(suggestedName?: unknown): string {
  if (typeof suggestedName !== 'string') return 'download';
  const trimmed = suggestedName.trim();
  if (!trimmed) return 'download';
  // Normalize Windows separators so traversal paths like ..\..\evil.mp4 are stripped on POSIX hosts too.
  const normalized = trimmed.replaceAll('\\', '/');
  const base = path.posix.basename(normalized).replace(/[\0\r\n]/g, '').trim();
  if (!base || base === '.' || base === '..') return 'download';
  return base;
}

function isErrnoWithCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === code);
}

function isOverwriteRenameError(error: unknown): boolean {
  return isErrnoWithCode(error, 'EPERM') || isErrnoWithCode(error, 'EEXIST');
}

async function replaceFileSafely(
  fsOps: Pick<typeof fs, 'open' | 'rename' | 'stat' | 'unlink'>,
  stagingPath: string,
  targetPath: string,
  writerId: string,
): Promise<void> {
  try {
    await fsOps.rename(stagingPath, targetPath);
    return;
  } catch (renameErr) {
    if (!isOverwriteRenameError(renameErr)) {
      throw renameErr;
    }
    // Windows fs.rename onto an existing target can fail with EPERM/EEXIST even
    // when creating a fresh name in the same directory succeeds. Move the old
    // target aside first so we can roll back intact if moving staging fails.
    const targetExists = await fsOps.stat(targetPath).then(() => true, () => false);
    if (!targetExists) {
      throw renameErr;
    }
    const backupPath = path.join(path.dirname(targetPath), `.imcodes-dl-${writerId}.bak`);
    await fsOps.rename(targetPath, backupPath);
    try {
      await fsOps.rename(stagingPath, targetPath);
    } catch (swapErr) {
      await fsOps.rename(backupPath, targetPath).catch(() => {});
      throw swapErr;
    }
    await fsOps.unlink(backupPath).catch(() => {});
  }
}

function wrapDownloadFsError(error: unknown): Error {
  if (isErrnoWithCode(error, 'ENOSPC')) {
    const err = new Error('QuotaExceededError (ENOSPC): no space left on device');
    err.name = 'QuotaExceededError';
    return err;
  }
  if (error instanceof Error) return error;
  return new Error(String(error ?? 'download_fs_error'));
}

function readSenderUrl(sender: unknown, fallback?: (sender: unknown) => string): string {
  if (sender && typeof sender === 'object' && typeof (sender as { getURL?: unknown }).getURL === 'function') {
    return String((sender as { getURL: () => string }).getURL() || '');
  }
  return fallback?.(sender) || '';
}

function isSenderDestroyed(sender: unknown): boolean {
  if (!sender || typeof sender !== 'object') return true;
  if (typeof (sender as { isDestroyed?: unknown }).isDestroyed === 'function') {
    return Boolean((sender as { isDestroyed: () => boolean }).isDestroyed());
  }
  return false;
}

function toUint8Array(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new Error('invalid_download_chunk');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function requireNonEmptyString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(code);
  }
  return value;
}

function requireNonNegativeSafeInt(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(code);
  }
  return value;
}

export function createPcAppDownloadController(deps: PcAppDownloadControllerDeps): PcAppDownloadController {
  const fsOps = deps.fsOps ?? fs;
  const handles = new Map<string, DownloadHandleRecord>();
  const writers = new Map<string, DownloadWriterRecord>();
  let registeredIpc: PcAppIpcMainLike | null = null;

  const isTrustedSender = (event: PcAppIpcInvokeEventLike): { sender: unknown; origin: string } | null => {
    const sender = event?.sender;
    if (!sender || isSenderDestroyed(sender)) return null;
    if (!deps.isAllowedWebContents(sender)) return null;
    if (!deps.getCurrentTrustedOrigin()) return null;

    const activeOrigin = deps.getActiveOrigin();
    const trustedOrigins = deps.getTrustedOrigins();
    if (!activeOrigin || !trustedOrigins.has(activeOrigin)) return null;

    const frameUrl = typeof event.senderFrame?.url === 'string' ? event.senderFrame.url : '';
    const wcUrl = readSenderUrl(sender, deps.getSenderUrl);

    if (!frameUrl && !wcUrl) return null;
    if (frameUrl && !isSameActiveOrigin(frameUrl, activeOrigin, trustedOrigins)) return null;
    if (wcUrl && !isSameActiveOrigin(wcUrl, activeOrigin, trustedOrigins)) return null;

    return { sender, origin: activeOrigin };
  };

  const assertTrustedSender = (event: PcAppIpcInvokeEventLike): { sender: unknown; origin: string } => {
    const auth = isTrustedSender(event);
    if (!auth) {
      throw new Error('Untrusted origin');
    }
    return auth;
  };

  const requireOwnedHandle = (event: PcAppIpcInvokeEventLike, handleId: string): DownloadHandleRecord => {
    const { sender, origin } = assertTrustedSender(event);
    const entry = handles.get(handleId);
    if (!entry || entry.ownerWebContents !== sender || entry.origin !== origin) {
      throw new Error('Invalid download handle');
    }
    return entry;
  };

  const requireOwnedWriter = (event: PcAppIpcInvokeEventLike, writerId: string): DownloadWriterRecord => {
    const { sender, origin } = assertTrustedSender(event);
    const writer = writers.get(writerId);
    if (!writer || writer.closed || writer.ownerWebContents !== sender || writer.origin !== origin) {
      throw new Error('Invalid download writer');
    }
    return writer;
  };

  const rollbackAndCloseWriter = async (writer: DownloadWriterRecord): Promise<void> => {
    if (writer.closed) return;
    writer.closed = true;
    writers.delete(writer.writerId);
    try {
      if (!writer.stagingPath && !writer.createdNewTarget) {
        await writer.fd.truncate(writer.initialSize).catch(() => {});
      }
      await writer.fd.close().catch(() => {});
    } finally {
      if (writer.stagingPath) {
        await fsOps.unlink(writer.stagingPath).catch(() => {});
      } else if (writer.createdNewTarget) {
        await fsOps.unlink(writer.targetPath).catch(() => {});
      }
    }
  };

  const cleanupMatching = async (predicate: (owner: unknown, origin: string) => boolean): Promise<void> => {
    const writersToAbort: DownloadWriterRecord[] = [];
    for (const writer of writers.values()) {
      if (predicate(writer.ownerWebContents, writer.origin)) {
        writersToAbort.push(writer);
      }
    }
    await Promise.allSettled(writersToAbort.map((writer) => rollbackAndCloseWriter(writer)));

    for (const [handleId, handle] of handles.entries()) {
      if (predicate(handle.ownerWebContents, handle.origin)) {
        handles.delete(handleId);
      }
    }
  };

  const handlePickSaveFile = async (
    event: PcAppIpcInvokeEventLike,
    rawOptions: unknown,
  ): Promise<{ canceled: true } | { canceled: false; handleId: string; name: string }> => {
    const { sender, origin } = assertTrustedSender(event);
    const opts = asRecord(rawOptions);
    const safeName = sanitizeDownloadFilename(opts.suggestedName);
    let defaultDir = '';
    try {
      defaultDir = deps.getDefaultDownloadsDir?.() || '';
    } catch {
      defaultDir = '';
    }
    const defaultPath = defaultDir ? path.join(defaultDir, safeName) : safeName;
    const result = await deps.showSaveDialog(sender, { defaultPath });

    // Re-verify sender is still alive and authorized after awaiting native modal dialog.
    const postAuth = isTrustedSender(event);
    if (!postAuth || postAuth.sender !== sender || postAuth.origin !== origin) {
      throw new Error('Untrusted origin');
    }

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    const filePath = path.resolve(result.filePath);
    const handleId = randomUUID();
    const name = path.basename(filePath) || safeName;
    handles.set(handleId, {
      handleId,
      filePath,
      name,
      ownerWebContents: sender,
      origin,
    });
    return { canceled: false, handleId, name };
  };

  const handleOpenWriter = async (
    event: PcAppIpcInvokeEventLike,
    rawOptions: unknown,
  ): Promise<{ writerId: string }> => {
    const opts = asRecord(rawOptions);
    const handleId = requireNonEmptyString(opts.handleId, 'invalid_handle_id');
    const keepExistingData = Boolean(opts.keepExistingData);
    const handle = requireOwnedHandle(event, handleId);

    const writerId = randomUUID();
    let stagingPath: string | null = null;
    let fd: fs.FileHandle;
    let initialSize = 0;
    let createdNewTarget = false;

    try {
      if (keepExistingData) {
        try {
          fd = await fsOps.open(handle.filePath, 'r+');
          const stat = await fd.stat();
          initialSize = Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : 0;
        } catch (err) {
          if (!isErrnoWithCode(err, 'ENOENT')) {
            throw err;
          }
          fd = await fsOps.open(handle.filePath, 'wx+', 0o600);
          createdNewTarget = true;
          initialSize = 0;
        }
      } else {
        stagingPath = path.join(path.dirname(handle.filePath), `.imcodes-dl-${writerId}.part`);
        fd = await fsOps.open(stagingPath, 'wx+', 0o600);
      }
    } catch (error) {
      throw wrapDownloadFsError(error);
    }

    writers.set(writerId, {
      writerId,
      handleId: handle.handleId,
      ownerWebContents: handle.ownerWebContents,
      origin: handle.origin,
      targetPath: handle.filePath,
      stagingPath,
      fd,
      position: 0,
      initialSize,
      createdNewTarget,
      closed: false,
    });

    return { writerId };
  };

  const handleWriteChunk = async (
    event: PcAppIpcInvokeEventLike,
    rawOptions: unknown,
  ): Promise<{ bytesWritten: number; position: number }> => {
    const opts = asRecord(rawOptions);
    const writerId = requireNonEmptyString(opts.writerId, 'invalid_writer_id');
    const writer = requireOwnedWriter(event, writerId);
    const bytes = toUint8Array(opts.chunk);
    if (bytes.byteLength > PC_APP_DOWNLOAD_MAX_CHUNK_BYTES) {
      throw new Error('chunk_too_large');
    }

    let offset = 0;
    try {
      while (offset < bytes.byteLength) {
        const res = await writer.fd.write(bytes, offset, bytes.byteLength - offset, writer.position);
        if (res.bytesWritten <= 0) {
          throw new Error('short_write');
        }
        offset += res.bytesWritten;
        writer.position += res.bytesWritten;
      }
    } catch (error) {
      throw wrapDownloadFsError(error);
    }
    return { bytesWritten: bytes.byteLength, position: writer.position };
  };

  const handleSeekWriter = async (
    event: PcAppIpcInvokeEventLike,
    rawOptions: unknown,
  ): Promise<void> => {
    const opts = asRecord(rawOptions);
    const writerId = requireNonEmptyString(opts.writerId, 'invalid_writer_id');
    const position = requireNonNegativeSafeInt(opts.position, 'invalid_seek_position');
    const writer = requireOwnedWriter(event, writerId);
    writer.position = position;
  };

  const handleTruncateWriter = async (
    event: PcAppIpcInvokeEventLike,
    rawOptions: unknown,
  ): Promise<void> => {
    const opts = asRecord(rawOptions);
    const writerId = requireNonEmptyString(opts.writerId, 'invalid_writer_id');
    const size = requireNonNegativeSafeInt(opts.size, 'invalid_truncate_size');
    const writer = requireOwnedWriter(event, writerId);
    try {
      await writer.fd.truncate(size);
    } catch (error) {
      throw wrapDownloadFsError(error);
    }
    if (writer.position > size) {
      writer.position = size;
    }
  };

  const handleCloseWriter = async (
    event: PcAppIpcInvokeEventLike,
    rawOptions: unknown,
  ): Promise<void> => {
    const opts = asRecord(rawOptions);
    const writerId = requireNonEmptyString(opts.writerId, 'invalid_writer_id');
    const writer = requireOwnedWriter(event, writerId);
    writer.closed = true;
    writers.delete(writerId);

    try {
      await writer.fd.sync().catch(() => {});
      await writer.fd.close();
      if (writer.stagingPath) {
        await replaceFileSafely(fsOps, writer.stagingPath, writer.targetPath, writer.writerId);
      }
    } catch (error) {
      if (writer.stagingPath) {
        await fsOps.unlink(writer.stagingPath).catch(() => {});
      }
      throw wrapDownloadFsError(error);
    }
  };

  const handleAbortWriter = async (
    event: PcAppIpcInvokeEventLike,
    rawOptions: unknown,
  ): Promise<void> => {
    const opts = asRecord(rawOptions);
    const writerId = requireNonEmptyString(opts.writerId, 'invalid_writer_id');
    const writer = requireOwnedWriter(event, writerId);
    await rollbackAndCloseWriter(writer);
  };

  const handleGetFileSize = async (
    event: PcAppIpcInvokeEventLike,
    rawOptions: unknown,
  ): Promise<{ size: number; name: string }> => {
    const opts = asRecord(rawOptions);
    const handleId = requireNonEmptyString(opts.handleId, 'invalid_handle_id');
    const handle = requireOwnedHandle(event, handleId);
    try {
      const stat = await fsOps.stat(handle.filePath);
      const size = Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : 0;
      return { size, name: handle.name };
    } catch (error) {
      if (isErrnoWithCode(error, 'ENOENT')) {
        return { size: 0, name: handle.name };
      }
      throw wrapDownloadFsError(error);
    }
  };

  const handleRevealFile = async (
    event: PcAppIpcInvokeEventLike,
    rawOptions: unknown,
  ): Promise<boolean> => {
    const opts = asRecord(rawOptions);
    const handleId = requireNonEmptyString(opts.handleId, 'invalid_handle_id');
    const handle = requireOwnedHandle(event, handleId);
    await deps.showItemInFolder(handle.filePath);
    return true;
  };

  const unregisterIpc = (ipcMain: PcAppIpcMainLike): void => {
    for (const channel of Object.values(PC_APP_DOWNLOAD_CHANNELS)) {
      ipcMain.removeHandler?.(channel);
    }
    if (registeredIpc === ipcMain) {
      registeredIpc = null;
    }
  };

  const registerIpc = (ipcMain: PcAppIpcMainLike): void => {
    if (registeredIpc && registeredIpc !== ipcMain) {
      unregisterIpc(registeredIpc);
    }
    unregisterIpc(ipcMain);
    registeredIpc = ipcMain;

    ipcMain.handle(PC_APP_DOWNLOAD_CHANNELS.pickSaveFile, handlePickSaveFile);
    ipcMain.handle(PC_APP_DOWNLOAD_CHANNELS.openWriter, handleOpenWriter);
    ipcMain.handle(PC_APP_DOWNLOAD_CHANNELS.writeChunk, handleWriteChunk);
    ipcMain.handle(PC_APP_DOWNLOAD_CHANNELS.seekWriter, handleSeekWriter);
    ipcMain.handle(PC_APP_DOWNLOAD_CHANNELS.truncateWriter, handleTruncateWriter);
    ipcMain.handle(PC_APP_DOWNLOAD_CHANNELS.closeWriter, handleCloseWriter);
    ipcMain.handle(PC_APP_DOWNLOAD_CHANNELS.abortWriter, handleAbortWriter);
    ipcMain.handle(PC_APP_DOWNLOAD_CHANNELS.getFileSize, handleGetFileSize);
    ipcMain.handle(PC_APP_DOWNLOAD_CHANNELS.revealFile, handleRevealFile);
  };

  return {
    registerIpc,
    unregisterIpc,
    cleanupWebContents: (webContents) => cleanupMatching((owner) => owner === webContents),
    cleanupOriginMismatch: (activeOrigin) =>
      cleanupMatching((_owner, origin) => !activeOrigin || origin !== activeOrigin),
    dispose: async () => {
      await cleanupMatching(() => true);
      if (registeredIpc) {
        unregisterIpc(registeredIpc);
      }
    },
    activeCounts: () => ({ handles: handles.size, writers: writers.size }),
  };
}
