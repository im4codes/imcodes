import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../env.js';
import { randomHex, sha256Hex, signJwt, verifyJwt } from '../security/crypto.js';
import { resolveAuthOutcome } from '../security/authorization.js';
import {
  getDocumentShareById,
  isPathWithinSharedFolder,
  normalizeDocumentSharePath,
  resolveEffectiveDocumentAccess,
  type DocumentShareRole,
  type EffectiveDocumentAccess,
} from '../db/document-sharing.js';
import { shareTargetFromSessionName } from '../db/tab-sharing.js';
import { resolveHttpShareAccess, resolveHttpShareAccessForCoveredSession } from './share-http-auth.js';
import type { Database } from '../db/client.js';
import { WsBridge } from '../ws/bridge.js';

export const onlyofficeRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

export const DOC_DEVICE_COOKIE = 'imcodes_doc_device';

export interface OnlyOfficeDocumentMeta {
  ext: string;
  fileType: string;
  documentType: 'word' | 'cell' | 'slide' | 'pdf';
  mimeType: string;
  isEditable: boolean;
  isBinary: boolean;
}

const EXTENSION_META: Record<string, Omit<OnlyOfficeDocumentMeta, 'ext'>> = {
  '.docx': {
    fileType: 'docx',
    documentType: 'word',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    isEditable: true,
    isBinary: true,
  },
  '.doc': {
    fileType: 'doc',
    documentType: 'word',
    mimeType: 'application/msword',
    isEditable: true,
    isBinary: true,
  },
  '.odt': {
    fileType: 'odt',
    documentType: 'word',
    mimeType: 'application/vnd.oasis.opendocument.text',
    isEditable: true,
    isBinary: true,
  },
  '.rtf': {
    fileType: 'rtf',
    documentType: 'word',
    mimeType: 'application/rtf',
    isEditable: true,
    isBinary: false,
  },
  '.txt': {
    fileType: 'txt',
    documentType: 'word',
    mimeType: 'text/plain; charset=utf-8',
    isEditable: true,
    isBinary: false,
  },
  '.md': {
    fileType: 'txt',
    documentType: 'word',
    mimeType: 'text/markdown; charset=utf-8',
    isEditable: true,
    isBinary: false,
  },
  '.xlsx': {
    fileType: 'xlsx',
    documentType: 'cell',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    isEditable: true,
    isBinary: true,
  },
  '.xls': {
    fileType: 'xls',
    documentType: 'cell',
    mimeType: 'application/vnd.ms-excel',
    isEditable: true,
    isBinary: true,
  },
  '.ods': {
    fileType: 'ods',
    documentType: 'cell',
    mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
    isEditable: true,
    isBinary: true,
  },
  '.csv': {
    fileType: 'csv',
    documentType: 'cell',
    mimeType: 'text/csv; charset=utf-8',
    isEditable: true,
    isBinary: false,
  },
  '.pptx': {
    fileType: 'pptx',
    documentType: 'slide',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    isEditable: true,
    isBinary: true,
  },
  '.ppt': {
    fileType: 'ppt',
    documentType: 'slide',
    mimeType: 'application/vnd.ms-powerpoint',
    isEditable: true,
    isBinary: true,
  },
  '.odp': {
    fileType: 'odp',
    documentType: 'slide',
    mimeType: 'application/vnd.oasis.opendocument.presentation',
    isEditable: true,
    isBinary: true,
  },
  '.pdf': {
    fileType: 'pdf',
    documentType: 'pdf',
    mimeType: 'application/pdf',
    isEditable: false,
    isBinary: true,
  },
};

export function getOnlyOfficeDocumentMeta(filePath: string): OnlyOfficeDocumentMeta | null {
  const ext = path.posix.extname(filePath).toLowerCase();
  const entry = EXTENSION_META[ext];
  if (!entry) return null;
  return { ext, ...entry };
}

export function resolveOnlyOfficeJwtSecret(env: Pick<Env, 'ONLYOFFICE_JWT_SECRET' | 'JWT_SIGNING_KEY'>): string {
  const explicit = env.ONLYOFFICE_JWT_SECRET?.trim();
  if (explicit) return explicit;
  return createHmac('sha256', env.JWT_SIGNING_KEY).update('imcodes-onlyoffice-jwt-secret').digest('hex');
}

interface DocumentVersionState {
  committedHash: string;
  lastForceSavedHash: string | null;
  sessionEpoch: number;
  commitSeq: number;
  activeKey: string;
  updatedAt: number;
}

const ROOMS_STORE_PATH = path.join(os.tmpdir(), '.imcodes-onlyoffice-rooms.json');

function loadPersistentRooms(): Record<string, DocumentVersionState> {
  try {
    if (fs.existsSync(ROOMS_STORE_PATH)) {
      const raw = fs.readFileSync(ROOMS_STORE_PATH, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') return data;
    }
  } catch { /* ignore */ }
  return {};
}

function savePersistentRoom(mapKey: string, state: DocumentVersionState | null): void {
  try {
    const data = loadPersistentRooms();
    if (state === null) {
      delete data[mapKey];
    } else {
      data[mapKey] = state;
    }
    const tmp = `${ROOMS_STORE_PATH}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, ROOMS_STORE_PATH);
  } catch { /* ignore */ }
}

const docCommitMutex = new Map<string, Promise<void>>();
async function lockDocumentCommit<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = docCommitMutex.get(key) ?? Promise.resolve();
  let resolveNext!: () => void;
  const next = new Promise<void>((r) => { resolveNext = r; });
  docCommitMutex.set(key, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    resolveNext();
    if (docCommitMutex.get(key) === next) {
      docCommitMutex.delete(key);
    }
  }
}

// Track per-document collaborative state backed by the recoverable daemon file digest
// so concurrent opens of the same document version share the exact same key, while
// completed saves, external edits, or process restarts never reuse a stale version room.
const documentRevisionMap = new Map<string, number>();
const documentVersionStateMap = new Map<string, DocumentVersionState>();

function getDocumentCommitSeq(mapKey: string): number {
  const state = documentVersionStateMap.get(mapKey) ?? loadPersistentRooms()[mapKey];
  return state?.commitSeq ?? 0;
}

function computeDocumentKeyFromDigest(
  serverId: string,
  normalizedPath: string,
  contentHash: string,
  extraRev = 0,
): string {
  const revSuffix = extraRev > 0 ? `:r${extraRev}` : '';
  return sha256Hex(`onlyoffice-collab:${serverId}:${normalizedPath}:${contentHash}${revSuffix}`).slice(0, 32);
}

export function getOnlyOfficeDocumentKey(
  serverId: string,
  normalizedPath: string,
  contentHash?: string,
): string {
  const mapKey = `${serverId}:${normalizedPath}`;
  const state = documentVersionStateMap.get(mapKey) ?? loadPersistentRooms()[mapKey];
  if (state) {
    if (contentHash && contentHash !== state.committedHash && contentHash !== state.lastForceSavedHash) {
      return computeDocumentKeyFromDigest(serverId, normalizedPath, contentHash, state.sessionEpoch);
    }
    return state.activeKey;
  }
  const hash = contentHash ?? 'initial';
  return computeDocumentKeyFromDigest(serverId, normalizedPath, hash, 0);
}

export function bumpOnlyOfficeDocumentRevision(
  serverId: string,
  normalizedPath: string,
  newContentHash?: string,
): number {
  const mapKey = `${serverId}:${normalizedPath}`;
  let state = documentVersionStateMap.get(mapKey);
  if (!state) {
    state = loadPersistentRooms()[mapKey];
  }
  const sessionEpoch = (state?.sessionEpoch ?? 0) + 1;
  const commitSeq = (state?.commitSeq ?? 0) + 1;
  const resolvedHash = newContentHash ?? state?.committedHash ?? 'initial';
  const activeKey = computeDocumentKeyFromDigest(serverId, normalizedPath, resolvedHash, sessionEpoch);
  const newState: DocumentVersionState = {
    committedHash: resolvedHash,
    lastForceSavedHash: null,
    sessionEpoch,
    commitSeq,
    activeKey,
    updatedAt: Date.now(),
  };
  documentVersionStateMap.set(mapKey, newState);
  savePersistentRoom(mapKey, newState);
  return sessionEpoch;
}

export function resetOnlyOfficeDocumentKeyCacheForTests(): void {
  documentRevisionMap.clear();
  documentVersionStateMap.clear();
}

export async function resolveOnlyOfficeDocumentKey(
  serverId: string,
  normalizedPath: string,
  options?: { allowedRoot?: string },
): Promise<string> {
  const mapKey = `${serverId}:${normalizedPath}`;
  try {
    const { bytes } = await readFileFromDaemon(serverId, normalizedPath, options);
    const currentHash = createHash('sha256').update(bytes).digest('hex');
    let existing = documentVersionStateMap.get(mapKey);
    if (!existing) {
      const persisted = loadPersistentRooms()[mapKey];
      if (persisted) {
        existing = persisted;
        documentVersionStateMap.set(mapKey, existing);
      }
    }
    if (existing) {
      if (currentHash === existing.committedHash || currentHash === existing.lastForceSavedHash) {
        return existing.activeKey;
      }
      // File content changed externally on the daemon -> advance to new version key
      const nextEpoch = existing.sessionEpoch + 1;
      const nextSeq = existing.commitSeq + 1;
      const activeKey = computeDocumentKeyFromDigest(serverId, normalizedPath, currentHash, nextEpoch);
      const newState: DocumentVersionState = {
        committedHash: currentHash,
        lastForceSavedHash: null,
        sessionEpoch: nextEpoch,
        commitSeq: nextSeq,
        activeKey,
        updatedAt: Date.now(),
      };
      documentVersionStateMap.set(mapKey, newState);
      savePersistentRoom(mapKey, newState);
      return activeKey;
    }

    const activeKey = computeDocumentKeyFromDigest(serverId, normalizedPath, currentHash, 0);
    const newState: DocumentVersionState = {
      committedHash: currentHash,
      lastForceSavedHash: null,
      sessionEpoch: 0,
      commitSeq: 0,
      activeKey,
      updatedAt: Date.now(),
    };
    documentVersionStateMap.set(mapKey, newState);
    savePersistentRoom(mapKey, newState);
    return activeKey;
  } catch {
    return getOnlyOfficeDocumentKey(serverId, normalizedPath);
  }
}

export interface OnlyOfficeDocTokenClaims {
  type: 'onlyoffice-doc';
  serverId: string;
  path: string;
  actorId: string;
  actorName: string;
  role: DocumentShareRole;
  allowDownload: boolean;
  shareId: string | null;
  userId?: string | null;
  externalShareToken?: string | null;
  deviceToken?: string | null;
  sessionName?: string | null;
  allowedRoot?: string | null;
  documentKey?: string | null;
  iat?: number;
  exp?: number;
}

export function signOnlyOfficeDocToken(
  claims: Omit<OnlyOfficeDocTokenClaims, 'type' | 'iat' | 'exp'>,
  signingKey: string,
  ttlSeconds = 4 * 3600,
): string {
  return signJwt(
    {
      ...claims,
      type: 'onlyoffice-doc',
    },
    signingKey,
    ttlSeconds,
  );
}

export function verifyOnlyOfficeDocToken(
  token: string,
  signingKey: string,
): OnlyOfficeDocTokenClaims | null {
  const payload = verifyJwt(token, signingKey);
  if (!payload || payload.type !== 'onlyoffice-doc') return null;
  if (
    typeof payload.serverId !== 'string' ||
    typeof payload.path !== 'string' ||
    typeof payload.actorId !== 'string' ||
    typeof payload.actorName !== 'string' ||
    (payload.role !== 'viewer' && payload.role !== 'editor')
  ) {
    return null;
  }
  const norm = normalizeDocumentSharePath(payload.path);
  if (!norm) return null;
  return {
    type: 'onlyoffice-doc',
    serverId: payload.serverId,
    path: norm,
    actorId: payload.actorId,
    actorName: payload.actorName,
    role: payload.role,
    allowDownload: Boolean(payload.allowDownload),
    shareId: typeof payload.shareId === 'string' ? payload.shareId : null,
    userId: typeof payload.userId === 'string' ? payload.userId : null,
    externalShareToken: typeof payload.externalShareToken === 'string' ? payload.externalShareToken : null,
    deviceToken: typeof payload.deviceToken === 'string' ? payload.deviceToken : null,
    sessionName: typeof payload.sessionName === 'string' ? payload.sessionName : null,
    allowedRoot: typeof payload.allowedRoot === 'string' ? payload.allowedRoot : null,
    documentKey: typeof payload.documentKey === 'string' ? payload.documentKey : null,
    iat: typeof payload.iat === 'number' ? payload.iat : undefined,
    exp: typeof payload.exp === 'number' ? payload.exp : undefined,
  };
}

// ── Daemon FS & File Transfer RPC Bridge Helpers ──────────────────────────────

type FsRouteKind = 'ls' | 'read' | 'write' | 'rename' | 'delete' | 'mkdir';

export async function sendDaemonFsCommand<T extends Record<string, unknown> = Record<string, unknown>>(
  serverId: string,
  kind: FsRouteKind,
  msg: Record<string, unknown> & { type: string; requestId: string },
  timeoutMs = 15_000,
): Promise<T> {
  const bridge = WsBridge.get(serverId) as unknown as {
    isDaemonConnected?: () => boolean;
    daemonWs?: {
      readyState?: number;
      on?: (event: string, cb: (raw: Buffer | string) => void) => void;
      off?: (event: string, cb: (raw: Buffer | string) => void) => void;
      removeListener?: (event: string, cb: (raw: Buffer | string) => void) => void;
    } | null;
    registerPendingFsRoute?: (
      k: string,
      ws: unknown,
      m: Record<string, unknown>,
    ) => boolean;
    sendToDaemon: (raw: string) => void;
    sendFileTransferRequest?: <R>(id: string, m: Record<string, unknown>, t?: number) => Promise<R>;
  };

  if (typeof bridge.isDaemonConnected === 'function' && !bridge.isDaemonConnected()) {
    throw new Error('daemon_offline');
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const daemonWs = bridge.daemonWs;

    const cleanup = () => {
      if (daemonWs && onMessage) {
        if (typeof daemonWs.off === 'function') daemonWs.off('message', onMessage);
        else if (typeof daemonWs.removeListener === 'function') daemonWs.removeListener('message', onMessage);
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('daemon_timeout'));
    }, timeoutMs);
    timer.unref?.();

    const settleOk = (payload: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(payload);
    };

    const onMessage = (raw: Buffer | string) => {
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (
          parsed &&
          typeof parsed === 'object' &&
          parsed.requestId === msg.requestId &&
          typeof parsed.type === 'string' &&
          parsed.type !== msg.type
        ) {
          settleOk(parsed as T);
        }
      } catch {
        // Ignore non-JSON frames
      }
    };

    if (daemonWs && typeof daemonWs.on === 'function') {
      daemonWs.on('message', onMessage);
    }

    if (kind !== 'mkdir' && typeof bridge.registerPendingFsRoute === 'function') {
      const virtualSocket = {
        readyState: 1,
        send(data: string, _opts?: unknown, cb?: () => void) {
          cb?.();
          try {
            settleOk(JSON.parse(String(data)) as T);
          } catch (err) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              cleanup();
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          }
        },
      };
      const pendingKind = msg.type.startsWith('fs.') ? msg.type : `fs.${kind}`;
      bridge.registerPendingFsRoute(pendingKind, virtualSocket, msg);
    }

    try {
      bridge.sendToDaemon(JSON.stringify(msg));
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });
}

export async function readFileFromDaemon(
  serverId: string,
  filePath: string,
  options?: { allowedRoot?: string },
): Promise<{ bytes: Buffer; mtime?: number }> {
  const norm = normalizeDocumentSharePath(filePath);
  if (!norm) throw new Error('invalid_path');

  const requestId = `oo-read-${randomHex(10)}`;
  const res = await sendDaemonFsCommand<{
    type: string;
    requestId: string;
    status?: 'ok' | 'error';
    content?: string;
    encoding?: 'utf8' | 'base64';
    downloadId?: string;
    mtime?: number;
    error?: string;
  }>(serverId, 'read', {
    type: 'fs.read',
    requestId,
    path: norm,
    ...(options?.allowedRoot ? { allowedRoot: options.allowedRoot } : {}),
  });

  if (res.status === 'error') {
    throw new Error(res.error || 'daemon_file_read_failed');
  }

  if (typeof res.content === 'string') {
    const bytes = res.encoding === 'base64'
      ? Buffer.from(res.content, 'base64')
      : Buffer.from(res.content, 'utf8');
    return { bytes, mtime: res.mtime };
  }

  if (typeof res.downloadId === 'string' && res.downloadId) {
    const bridge = WsBridge.get(serverId);
    const dlReqId = `oo-dl-${randomHex(10)}`;
    const dlRes = (await bridge.sendFileTransferRequest(
      dlReqId,
      {
        type: 'file.download',
        downloadId: dlReqId,
        attachmentId: res.downloadId,
      },
      30_000,
    )) as {
      type?: string;
      status?: string;
      error?: string;
      downloadId?: string;
      content?: string;
      mime?: string;
      size?: number;
    };
    if (
      !dlRes ||
      dlRes.type === 'file.download_error' ||
      dlRes.status === 'error' ||
      typeof dlRes.error === 'string' ||
      typeof dlRes.content !== 'string'
    ) {
      throw new Error(dlRes?.error || 'daemon_file_download_failed');
    }
    return {
      bytes: Buffer.from(dlRes.content, 'base64'),
      mtime: res.mtime,
    };
  }

  throw new Error(res.error || 'daemon_file_read_failed');
}

function assertFileUploadSuccess(
  upRes: unknown,
  options?: { createOnly?: boolean },
): void {
  const rec = (upRes && typeof upRes === 'object' ? upRes : null) as {
    type?: string;
    status?: string;
    error?: string;
  } | null;
  if (!rec) {
    throw new Error('file_upload_empty_response');
  }
  if (rec.type === 'file.upload_error' || rec.status === 'error' || typeof rec.error === 'string') {
    const rawErr = String(rec.error || 'file_upload_failed');
    if (options?.createOnly && rawErr.includes('destination_exists')) {
      throw new Error('EEXIST');
    }
    throw new Error(rawErr);
  }
}

export async function writeFileToDaemon(
  serverId: string,
  filePath: string,
  bytes: Buffer,
  options?: { createOnly?: boolean; isBinary?: boolean; mimeType?: string; allowedRoot?: string },
): Promise<{ mtime?: number }> {
  const norm = normalizeDocumentSharePath(filePath);
  if (!norm) throw new Error('invalid_path');

  const allowedRoot = options?.allowedRoot;
  if (allowedRoot && !isPathWithinSharedFolder(norm, allowedRoot)) {
    throw new Error('forbidden_path');
  }

  const meta = getOnlyOfficeDocumentMeta(norm);
  const isBinary = options?.isBinary ?? meta?.isBinary ?? false;
  const createOnly = Boolean(options?.createOnly);

  if (!isBinary) {
    const requestId = `oo-write-${randomHex(10)}`;
    const res = await sendDaemonFsCommand<{
      type: string;
      requestId: string;
      status?: 'ok' | 'error';
      mtime?: number;
      error?: string;
    }>(serverId, 'write', {
      type: 'fs.write',
      requestId,
      path: norm,
      content: bytes.toString('utf8'),
      encoding: 'utf8',
      ...(createOnly ? { createOnly: true } : {}),
      ...(allowedRoot ? { allowedRoot } : {}),
    });
    if (res.status === 'error') {
      throw new Error(res.error || 'daemon_write_failed');
    }
    return { mtime: res.mtime };
  }

  // Binary file (.docx, .xlsx, .pptx, .pdf):
  // Never fall back to UTF-8 fs.write on error.
  // For createOnly: upload directly with wx semantics and inspect the daemon response.
  // For overwrite (!createOnly): write the complete binary payload to a same-directory temporary staging file first
  // without touching the original file, verify upload success, and then atomically commit via fs.rename(overwrite: true).
  const parentDir = path.posix.dirname(norm);
  const baseName = path.posix.basename(norm);
  const bridge = WsBridge.get(serverId);
  const mime = options?.mimeType || meta?.mimeType || 'application/octet-stream';

  if (createOnly) {
    const uploadId = `oo-up-${randomHex(10)}`;
    const upRes = await bridge.sendFileTransferRequest(
      uploadId,
      {
        type: 'file.upload',
        uploadId,
        filename: `${uploadId}-${baseName}`,
        originalName: baseName,
        sanitizedName: baseName,
        mime,
        size: bytes.length,
        content: bytes.toString('base64'),
        destinationDirectory: parentDir,
        ...(allowedRoot ? { allowedRoot } : {}),
      },
      15_000,
    );
    assertFileUploadSuccess(upRes, { createOnly: true });
    return {};
  }

  const stageName = `.oo-stage-${randomHex(8)}-${baseName}`;
  const stagePath = path.posix.join(parentDir, stageName);
  const uploadId = `oo-up-${randomHex(10)}`;

  const upRes = await bridge.sendFileTransferRequest(
    uploadId,
    {
      type: 'file.upload',
      uploadId,
      filename: `${uploadId}-${stageName}`,
      originalName: stageName,
      sanitizedName: stageName,
      mime,
      size: bytes.length,
      content: bytes.toString('base64'),
      destinationDirectory: parentDir,
      ...(allowedRoot ? { allowedRoot } : {}),
    },
    15_000,
  );
  assertFileUploadSuccess(upRes, { createOnly: false });

  try {
    const renRes = await sendDaemonFsCommand<{ status?: 'ok' | 'error'; error?: string }>(
      serverId,
      'rename',
      {
        type: 'fs.rename',
        requestId: `oo-commit-${randomHex(8)}`,
        path: stagePath,
        newPath: norm,
        overwrite: true,
        ...(allowedRoot ? { allowedRoot } : {}),
      },
      10_000,
    );
    if (renRes.status !== 'ok') {
      throw new Error(renRes.error || 'atomic_rename_failed');
    }
    return {};
  } catch (commitErr) {
    await sendDaemonFsCommand(
      serverId,
      'delete',
      {
        type: 'fs.delete',
        requestId: `oo-cleanup-${randomHex(8)}`,
        path: stagePath,
        ...(allowedRoot ? { allowedRoot } : {}),
      },
      5_000,
    ).catch(() => {});
    throw commitErr;
  }
}

// ── Minimal Valid OOXML (.docx / .xlsx / .pptx) & .md Generator ───────────────

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipArchive(files: Array<{ name: string; content: string | Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const rawBuf = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content;
    const compressed = deflateRawSync(rawBuf);
    const crc = crc32(rawBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4);         // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0, 6);          // General purpose bit flag
    localHeader.writeUInt16LE(8, 8);          // Compression method: deflate (8)
    localHeader.writeUInt16LE(0, 10);         // File last modification time
    localHeader.writeUInt16LE(0x21, 12);      // File last modification date
    localHeader.writeUInt32LE(crc, 14);       // CRC-32
    localHeader.writeUInt32LE(compressed.length, 18); // Compressed size
    localHeader.writeUInt32LE(rawBuf.length, 22);     // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);    // File name length
    localHeader.writeUInt16LE(0, 28);                 // Extra field length

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory file header signature
    centralHeader.writeUInt16LE(20, 4);         // Version made by
    centralHeader.writeUInt16LE(20, 6);         // Version needed to extract
    centralHeader.writeUInt16LE(0, 8);          // General purpose bit flag
    centralHeader.writeUInt16LE(8, 10);         // Compression method: deflate
    centralHeader.writeUInt16LE(0, 12);         // Last mod time
    centralHeader.writeUInt16LE(0x21, 14);      // Last mod date
    centralHeader.writeUInt32LE(crc, 16);       // CRC-32
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra field length
    centralHeader.writeUInt16LE(0, 32); // File comment length
    centralHeader.writeUInt16LE(0, 34); // Disk number start
    centralHeader.writeUInt16LE(0, 36); // Internal file attributes
    centralHeader.writeUInt32LE(0, 38); // External file attributes
    centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDirSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // End of central directory signature
  eocd.writeUInt16LE(0, 4);          // Number of this disk
  eocd.writeUInt16LE(0, 6);          // Disk where central directory starts
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

export function buildBlankDocumentBytes(ext: string): Buffer {
  const normalizedExt = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;

  if (normalizedExt === '.md') {
    return Buffer.from('# Untitled Document\n\n', 'utf8');
  }

  if (normalizedExt === '.docx') {
    return buildZipArchive([
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
      },
      {
        name: '_rels/.rels',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
      },
      {
        name: 'word/document.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:body><w:p><w:r><w:t></w:t></w:r></w:p><w:sectPr/></w:body>' +
          '</w:document>',
      },
    ]);
  }

  if (normalizedExt === '.xlsx') {
    return buildZipArchive([
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>',
      },
      {
        name: '_rels/.rels',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      },
      {
        name: 'xl/workbook.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>' +
          '</workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>',
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<sheetData/>' +
          '</worksheet>',
      },
    ]);
  }

  if (normalizedExt === '.pptx') {
    return buildZipArchive([
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
          '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
          '</Types>',
      },
      {
        name: '_rels/.rels',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
          '</Relationships>',
      },
      {
        name: 'ppt/presentation.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
          '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>' +
          '<p:sldSz cx="9144000" cy="6858000"/>' +
          '<p:notesSz cx="6858000" cy="9144000"/>' +
          '</p:presentation>',
      },
      {
        name: 'ppt/_rels/presentation.xml.rels',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
          '</Relationships>',
      },
      {
        name: 'ppt/slides/slide1.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
          '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>' +
          '</p:sld>',
      },
    ]);
  }

  throw new Error(`unsupported_blank_document_extension:${normalizedExt}`);
}

// ── Route Handlers ────────────────────────────────────────────────────────────

type RouteContext = Context<{ Bindings: Env; Variables: { userId: string; role: string } }>;

function extractDeviceToken(c: RouteContext): string | null {
  return (
    c.req.query('deviceToken')?.trim() ||
    c.req.header('x-doc-device-token')?.trim() ||
    getCookie(c, DOC_DEVICE_COOKIE)?.trim() ||
    null
  );
}

function extractShareToken(c: RouteContext): string | null {
  return (
    c.req.query('shareToken')?.trim() ||
    c.req.header('x-doc-share-token')?.trim() ||
    null
  );
}

async function resolveLiveOnlyOfficeAccess(
  db: Database,
  params: {
    serverId: string;
    userId?: string | null;
    userScope?: string | null;
    externalShareToken?: string | null;
    deviceToken?: string | null;
    sessionName?: string | null;
    filePath: string;
  },
): Promise<EffectiveDocumentAccess> {
  const access = await resolveEffectiveDocumentAccess(db, {
    serverId: params.serverId,
    userId: params.userId ?? null,
    externalShareToken: params.externalShareToken ?? null,
    deviceToken: params.deviceToken ?? null,
    filePath: params.filePath,
  });

  if (access.allowed) {
    return access;
  }

  // Compatibility with existing server / main-session / sub-session tab shares for internal users
  if (
    access.reason === 'no_active_share' &&
    params.userId &&
    params.userScope !== 'doc_collaborator' &&
    !params.externalShareToken
  ) {
    const serverAccess = await resolveHttpShareAccess(db, {
      serverId: params.serverId,
      userId: params.userId,
      target: { kind: 'server', serverId: params.serverId },
    });
    if (serverAccess.actor.kind === 'share') {
      return {
        allowed: true,
        role: serverAccess.actor.effectiveActorRole === 'participant' ? 'editor' : 'viewer',
        allowDownload: true,
        canManageShare: false,
        isOwner: false,
        shareId: null,
        targetPath: null,
      };
    }

    const sessionName = params.sessionName?.trim() || '';
    if (sessionName) {
      const target = shareTargetFromSessionName(params.serverId, sessionName);
      if (target) {
        const covered = await resolveHttpShareAccessForCoveredSession(db, {
          serverId: params.serverId,
          userId: params.userId,
          target,
        });
        if (covered.actor.kind === 'share') {
          return {
            allowed: true,
            role: covered.actor.effectiveActorRole === 'participant' ? 'editor' : 'viewer',
            allowDownload: true,
            canManageShare: false,
            isOwner: false,
            shareId: null,
            targetPath: null,
          };
        }
      }
    }
  }

  return access;
}

function isUrlUnderTrustedBase(candidate: URL, base: URL): boolean {
  if (candidate.origin !== base.origin) return false;
  const basePath = base.pathname.replace(/\/$/, '');
  if (!basePath || basePath === '') {
    return candidate.pathname.startsWith('/');
  }
  return candidate.pathname === basePath || candidate.pathname.startsWith(`${basePath}/`);
}

export function resolveTrustedOnlyOfficeDownloadUrl(
  rawUrl: string,
  env: Pick<Env, 'SERVER_URL' | 'ONLYOFFICE_PUBLIC_URL' | 'ONLYOFFICE_INTERNAL_URL'>,
): { internalFetchUrl: string; fallbackPublicUrl: string | null } | null {
  let candidate: URL;
  try {
    candidate = new URL(rawUrl);
  } catch {
    return null;
  }
  if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') {
    return null;
  }
  if (candidate.username || candidate.password) {
    return null;
  }
  const decodedPath = (() => {
    try {
      return decodeURIComponent(candidate.pathname);
    } catch {
      return candidate.pathname;
    }
  })();
  if (decodedPath.split('/').some((seg) => seg === '..')) {
    return null;
  }

  const serverBase = (env.SERVER_URL || 'http://localhost:19138').replace(/\/$/, '');
  const publicRaw = (env.ONLYOFFICE_PUBLIC_URL || `${serverBase}/onlyoffice`).replace(/\/$/, '');
  const internalRaw = (env.ONLYOFFICE_INTERNAL_URL || 'http://onlyoffice:80').replace(/\/$/, '');

  let publicBase: URL;
  let internalBase: URL;
  try {
    publicBase = new URL(publicRaw);
    internalBase = new URL(internalRaw);
  } catch {
    return null;
  }

  if (isUrlUnderTrustedBase(candidate, publicBase)) {
    const publicBasePath = publicBase.pathname.replace(/\/$/, '');
    const relativeSuffix = candidate.pathname.slice(publicBasePath.length) + candidate.search;
    const rewritten = `${internalRaw}${relativeSuffix}`;
    return {
      internalFetchUrl: rewritten,
      fallbackPublicUrl: candidate.toString(),
    };
  }

  if (isUrlUnderTrustedBase(candidate, internalBase)) {
    return {
      internalFetchUrl: candidate.toString(),
      fallbackPublicUrl: null,
    };
  }

  return null;
}

// GET /api/server/:id/onlyoffice/config?path=<encodedPath>&mode=<view|edit>&shareToken=<optionalToken>&sessionName=<optionalSession>
onlyofficeRoutes.get('/server/:id/onlyoffice/config', async (c): Promise<Response> => {
  const serverId = c.req.param('id') ?? '';
  const rawPath = c.req.query('path') ?? '';
  const normPath = normalizeDocumentSharePath(rawPath);
  if (!normPath) {
    return c.json({ error: 'invalid_path' }, 400);
  }

  const meta = getOnlyOfficeDocumentMeta(normPath);
  if (!meta) {
    return c.json({ error: 'unsupported_document_type' }, 400);
  }

  const { auth } = await resolveAuthOutcome(c);
  const shareToken = extractShareToken(c);
  const deviceToken = extractDeviceToken(c);
  const sessionName = c.req.query('sessionName')?.trim() || null;

  const access = await resolveLiveOnlyOfficeAccess(c.env.DB, {
    serverId,
    userId: auth?.userId ?? null,
    userScope: auth?.scope ?? null,
    externalShareToken: shareToken,
    deviceToken,
    sessionName,
    filePath: normPath,
  });

  if (!access.allowed || !access.role) {
    const status =
      access.reason === 'unauthenticated'
        ? 401
        : access.reason === 'server_not_found' || access.reason === 'share_not_found'
          ? 404
          : access.reason === 'invalid_path'
            ? 400
            : 403;
    return c.json({ error: 'forbidden', reason: access.reason ?? 'access_denied' }, status);
  }

  const requestedMode = c.req.query('mode');
  const effectiveMode: 'view' | 'edit' =
    access.role === 'editor' && meta.isEditable && requestedMode !== 'view'
      ? 'edit'
      : 'view';

  // Resolve actor display name for collaborative cursor & header
  let actorId = auth?.userId ?? (access.shareId ? `ext:${access.shareId}` : 'ext:guest');
  let actorName = access.participantLabel?.trim() || '';

  if (auth?.userId) {
    const userRow = await c.env.DB.queryOne<{ username: string | null; display_name: string | null }>(
      'SELECT username, display_name FROM users WHERE id = $1',
      [auth.userId],
    );
    if (!actorName) {
      actorName = userRow?.display_name || userRow?.username || auth.userId;
    }
  }
  if (!actorName) {
    actorName = 'External Collaborator';
  }

  const documentKey = await resolveOnlyOfficeDocumentKey(serverId, normPath, {
    allowedRoot: access.targetPath ?? undefined,
  });

  const docToken = signOnlyOfficeDocToken(
    {
      serverId,
      path: normPath,
      actorId,
      actorName,
      role: access.role,
      allowDownload: access.allowDownload,
      shareId: access.shareId ?? null,
      userId: auth?.userId ?? null,
      externalShareToken: shareToken,
      deviceToken,
      sessionName,
      allowedRoot: access.targetPath ?? null,
      documentKey,
    },
    c.env.JWT_SIGNING_KEY,
    4 * 3600,
  );

  const serverBaseUrl = (c.env.SERVER_URL || 'http://localhost:19138').replace(/\/$/, '');
  const publicUrl = (c.env.ONLYOFFICE_PUBLIC_URL || `${serverBaseUrl}/onlyoffice`).replace(/\/$/, '');
  const scriptUrl = `${publicUrl}/web-apps/apps/api/documents/api.js`;

  // Include explicit ?serverId= on both file and callback URLs to satisfy pod-sticky routing
  const fileUrl = `${serverBaseUrl}/api/onlyoffice/file/${docToken}?serverId=${encodeURIComponent(serverId)}`;

  if (c.env.ONLYOFFICE_ENABLED !== 'true') {
    return c.json({
      enabled: false,
      fallbackReason: 'onlyoffice_disabled',
      role: access.role,
      allowDownload: access.allowDownload,
      canManageShare: access.canManageShare,
      isOwner: access.isOwner,
      mode: effectiveMode,
      docToken,
      fileUrl,
    });
  }

  const callbackUrl = `${serverBaseUrl}/api/onlyoffice/callback/${docToken}?serverId=${encodeURIComponent(serverId)}`;

  const canEditDocument = effectiveMode === 'edit' && access.role === 'editor';
  const editorConfigPayload = {
    documentType: meta.documentType,
    document: {
      fileType: meta.fileType,
      key: documentKey,
      title: path.posix.basename(normPath),
      url: fileUrl,
      permissions: {
        edit: canEditDocument,
        download: access.allowDownload,
        print: access.allowDownload,
        copy: access.allowDownload,
        review: canEditDocument,
        comment: canEditDocument,
      },
    },
    editorConfig: {
      mode: effectiveMode,
      callbackUrl,
      lang: c.req.query('lang') || 'en',
      user: {
        id: actorId,
        name: actorName,
      },
      customization: {
        forcesave: true,
        compactHeader: true,
      },
    },
  };

  const ooSecret = resolveOnlyOfficeJwtSecret(c.env);
  const ooJwt = signJwt(
    {
      ...editorConfigPayload,
      tokenKind: 'editor_config',
    } as unknown as Record<string, unknown>,
    ooSecret,
    4 * 3600,
  );

  return c.json({
    enabled: true,
    role: access.role,
    allowDownload: access.allowDownload,
    canManageShare: access.canManageShare,
    isOwner: access.isOwner,
    mode: effectiveMode,
    publicUrl,
    scriptUrl,
    docToken,
    fileUrl,
    token: ooJwt,
    config: {
      ...editorConfigPayload,
      token: ooJwt,
    },
  });
});

async function verifyLiveClaimsAccess(
  db: Database,
  claims: OnlyOfficeDocTokenClaims,
): Promise<{ allowed: boolean; role: DocumentShareRole | null; allowedRoot: string | null }> {
  if (claims.userId || claims.externalShareToken || claims.sessionName) {
    const live = await resolveLiveOnlyOfficeAccess(db, {
      serverId: claims.serverId,
      userId: claims.userId ?? null,
      externalShareToken: claims.externalShareToken ?? null,
      deviceToken: claims.deviceToken ?? null,
      sessionName: claims.sessionName ?? null,
      filePath: claims.path,
    });
    if (!live.allowed || !live.role) {
      return { allowed: false, role: null, allowedRoot: null };
    }
    return {
      allowed: true,
      role: live.role,
      allowedRoot: live.targetPath ?? claims.allowedRoot ?? null,
    };
  }

  if (claims.shareId) {
    const share = await getDocumentShareById(db, claims.shareId, claims.serverId);
    if (!share || share.revokedAt !== null || (share.expiresAt !== null && share.expiresAt <= Date.now())) {
      return { allowed: false, role: null, allowedRoot: null };
    }
    return {
      allowed: true,
      role: share.role,
      allowedRoot: share.targetPath ?? claims.allowedRoot ?? null,
    };
  }

  return {
    allowed: true,
    role: claims.role,
    allowedRoot: claims.allowedRoot ?? null,
  };
}

async function handleOnlyOfficeFileDownload(c: RouteContext): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const claims = verifyOnlyOfficeDocToken(token, c.env.JWT_SIGNING_KEY);
  if (!claims) {
    return c.json({ error: 'invalid_doc_token' }, 401);
  }

  const explicitServerId = c.req.param('id') || c.req.query('serverId');
  if (explicitServerId && explicitServerId !== claims.serverId) {
    return c.json({ error: 'server_id_mismatch' }, 403);
  }

  const liveAccess = await verifyLiveClaimsAccess(c.env.DB, claims);
  if (!liveAccess.allowed) {
    return c.json({ error: 'share_revoked_or_expired' }, 403);
  }

  // If ONLYOFFICE_ENABLED is true and ONLYOFFICE sends Authorization JWT header, verify it if present
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const ooSecret = resolveOnlyOfficeJwtSecret(c.env);
    const verified = verifyJwt(authHeader.slice(7), ooSecret);
    if (!verified) {
      return c.json({ error: 'invalid_onlyoffice_jwt' }, 401);
    }
  }

  const meta = getOnlyOfficeDocumentMeta(claims.path);
  try {
    const { bytes } = await readFileFromDaemon(claims.serverId, claims.path, {
      allowedRoot: liveAccess.allowedRoot ?? undefined,
    });
    const filename = path.posix.basename(claims.path);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': meta?.mimeType || 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      msg === 'daemon_offline'
        ? 503
        : msg === 'ENOENT' || msg === 'enoent'
          ? 404
          : msg === 'forbidden_path'
            ? 403
            : 502;
    return c.json({ error: msg }, status);
  }
}

onlyofficeRoutes.get('/onlyoffice/file/:token', handleOnlyOfficeFileDownload);
onlyofficeRoutes.get('/server/:id/onlyoffice/file/:token', handleOnlyOfficeFileDownload);

async function handleOnlyOfficeCallback(c: RouteContext): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const claims = verifyOnlyOfficeDocToken(token, c.env.JWT_SIGNING_KEY);
  if (!claims) {
    return c.json({ error: 1, message: 'invalid_doc_token' }, 401);
  }

  const explicitServerId = c.req.param('id') || c.req.query('serverId');
  if (explicitServerId && explicitServerId !== claims.serverId) {
    return c.json({ error: 1, message: 'server_id_mismatch' }, 403);
  }

  if (claims.role !== 'editor') {
    return c.json({ error: 1, message: 'editor_role_required' }, 403);
  }

  const liveAccess = await verifyLiveClaimsAccess(c.env.DB, claims);
  if (!liveAccess.allowed || liveAccess.role !== 'editor') {
    return c.json({ error: 1, message: 'share_revoked_or_downgraded' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 1, message: 'invalid_json' }, 400);
  }

  // Verify ONLYOFFICE callback JWT (either in body.token or Authorization: Bearer <jwt>)
  const ooSecret = resolveOnlyOfficeJwtSecret(c.env);
  const bearerToken = c.req.header('Authorization')?.startsWith('Bearer ')
    ? c.req.header('Authorization')!.slice(7).trim()
    : null;
  const bodyToken = typeof body.token === 'string' ? body.token.trim() : null;
  const rawOoJwt = bodyToken || bearerToken;

  if (!rawOoJwt) {
    return c.json({ error: 1, message: 'missing_onlyoffice_jwt' }, 401);
  }

  const verifiedJwt = verifyJwt(rawOoJwt, ooSecret);
  if (!verifiedJwt) {
    return c.json({ error: 1, message: 'invalid_onlyoffice_jwt' }, 401);
  }

  const nestedPayload =
    verifiedJwt.payload && typeof verifiedJwt.payload === 'object' && !Array.isArray(verifiedJwt.payload)
      ? (verifiedJwt.payload as Record<string, unknown>)
      : verifiedJwt;

  // Reject browser editor-config tokens reused as callback credentials
  if (
    nestedPayload.tokenKind === 'editor_config' ||
    nestedPayload.editorConfig !== undefined ||
    nestedPayload.document !== undefined ||
    typeof nestedPayload.status !== 'number'
  ) {
    return c.json({ error: 1, message: 'invalid_onlyoffice_callback_jwt' }, 401);
  }

  // Reject any unsigned body field that attempts to override signed JWT callback fields
  if (body.status !== undefined && body.status !== nestedPayload.status) {
    return c.json({ error: 1, message: 'callback_payload_mismatch' }, 401);
  }
  const signedUrl = typeof nestedPayload.url === 'string' ? nestedPayload.url.trim() : '';
  if (typeof body.url === 'string' && body.url.trim() && body.url.trim() !== signedUrl) {
    return c.json({ error: 1, message: 'callback_payload_mismatch' }, 401);
  }
  const signedKey = typeof nestedPayload.key === 'string' ? nestedPayload.key.trim() : '';
  if (typeof body.key === 'string' && body.key.trim() && signedKey && body.key.trim() !== signedKey) {
    return c.json({ error: 1, message: 'callback_payload_mismatch' }, 401);
  }

  if (claims.documentKey && signedKey && signedKey !== claims.documentKey) {
    return c.json({ error: 1, message: 'callback_key_mismatch' }, 401);
  }

  const status = nestedPayload.status;

  // Status 2 = ready for saving, Status 6 = force save while editing
  if (status === 2 || status === 6) {
    const downloadUrl = signedUrl;
    if (!downloadUrl) {
      return c.json({ error: 1, message: 'missing_download_url' }, 400);
    }

    const trustedUrl = resolveTrustedOnlyOfficeDownloadUrl(downloadUrl, c.env);
    if (!trustedUrl) {
      return c.json({ error: 1, message: 'untrusted_download_url' }, 400);
    }

    const mapKey = `${claims.serverId}:${claims.path}`;
    const startCommitSeq = getDocumentCommitSeq(mapKey);
    const preCheckKey = await resolveOnlyOfficeDocumentKey(claims.serverId, claims.path, {
      allowedRoot: liveAccess.allowedRoot ?? undefined,
    });
    if (claims.documentKey && preCheckKey !== claims.documentKey) {
      return c.json({ error: 1, message: 'stale_document_key' }, 409);
    }
    if (signedKey && preCheckKey !== signedKey) {
      return c.json({ error: 1, message: 'stale_document_key' }, 409);
    }

    let docRes: Response;
    try {
      docRes = await fetch(trustedUrl.internalFetchUrl, { redirect: 'error' });
    } catch (fetchErr) {
      if (trustedUrl.fallbackPublicUrl && trustedUrl.fallbackPublicUrl !== trustedUrl.internalFetchUrl) {
        docRes = await fetch(trustedUrl.fallbackPublicUrl, { redirect: 'error' });
      } else {
        throw fetchErr;
      }
    }

    if (!docRes.ok) {
      return c.json({ error: 1, message: 'failed_to_download_edited_file' }, 502);
    }

    const arrayBuf = await docRes.arrayBuffer();
    const bytes = Buffer.from(arrayBuf);
    const meta = getOnlyOfficeDocumentMeta(claims.path);

    return await lockDocumentCommit(mapKey, async () => {
      // Re-check live access and key CAS under commit lock
      const liveCommitAccess = await verifyLiveClaimsAccess(c.env.DB, claims);
      if (!liveCommitAccess.allowed || liveCommitAccess.role !== 'editor') {
        return c.json({ error: 1, message: 'share_revoked_or_downgraded' }, 403);
      }

      // Check commit sequence: if a newer commit succeeded while downloading, this older callback loses write authority
      if (getDocumentCommitSeq(mapKey) !== startCommitSeq) {
        return c.json({ error: 1, message: 'stale_document_commit_sequence' }, 409);
      }

      const keyAtCommit = await resolveOnlyOfficeDocumentKey(claims.serverId, claims.path, {
        allowedRoot: liveCommitAccess.allowedRoot ?? undefined,
      });
      if (claims.documentKey && keyAtCommit !== claims.documentKey) {
        return c.json({ error: 1, message: 'stale_document_key' }, 409);
      }
      if (signedKey && keyAtCommit !== signedKey) {
        return c.json({ error: 1, message: 'stale_document_key' }, 409);
      }

      try {
        await writeFileToDaemon(claims.serverId, claims.path, bytes, {
          createOnly: false,
          isBinary: meta?.isBinary ?? true,
          mimeType: meta?.mimeType,
          allowedRoot: liveCommitAccess.allowedRoot ?? undefined,
        });
      } catch (writeErr) {
        const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        const errStatus = msg === 'forbidden_path' ? 403 : 502;
        return c.json({ error: 1, message: msg }, errStatus);
      }

      const newDigest = createHash('sha256').update(bytes).digest('hex');
      let state = documentVersionStateMap.get(mapKey) ?? loadPersistentRooms()[mapKey];
      if (status === 2) {
        const nextEpoch = (state?.sessionEpoch ?? 0) + 1;
        const nextSeq = (state?.commitSeq ?? 0) + 1;
        const nextKey = computeDocumentKeyFromDigest(claims.serverId, claims.path, newDigest, nextEpoch);
        const newState: DocumentVersionState = {
          committedHash: newDigest,
          lastForceSavedHash: null,
          sessionEpoch: nextEpoch,
          commitSeq: nextSeq,
          activeKey: nextKey,
          updatedAt: Date.now(),
        };
        documentVersionStateMap.set(mapKey, newState);
        savePersistentRoom(mapKey, newState);
      } else if (status === 6) {
        const nextSeq = (state?.commitSeq ?? 0) + 1;
        const currentEpoch = state?.sessionEpoch ?? 0;
        const currentKey = state?.activeKey ?? signedKey;
        const newState: DocumentVersionState = {
          committedHash: state?.committedHash ?? newDigest,
          lastForceSavedHash: newDigest,
          sessionEpoch: currentEpoch,
          commitSeq: nextSeq,
          activeKey: currentKey,
          updatedAt: Date.now(),
        };
        documentVersionStateMap.set(mapKey, newState);
        savePersistentRoom(mapKey, newState);
      }

      return c.json({ error: 0 });
    });
  }

  return c.json({ error: 0 });
}

onlyofficeRoutes.post('/onlyoffice/callback/:token', handleOnlyOfficeCallback);
onlyofficeRoutes.post('/server/:id/onlyoffice/callback/:token', handleOnlyOfficeCallback);
