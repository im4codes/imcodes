/**
 * File transfer routes: upload and download via HTTP, relayed to daemon over WS.
 */
import { Hono, type Context } from 'hono';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { resolveHttpShareAccessForCoveredSession, resolveServerMemberAccessOrShareDeny } from './share-http-auth.js';
import { shareTargetFromSessionName } from '../db/tab-sharing.js';
import { WsBridge } from '../ws/bridge.js';
import { randomHex } from '../security/crypto.js';
import {
  FILE_TRANSFER_LIMITS,
  FILE_TRANSFER_DIRECTORY_CAPABILITY,
  FILE_TRANSFER_UPLOAD_ERROR_CODE,
  FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
  FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
  FILE_TRANSFER_DELETE_ERROR,
  FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
  FILE_TRANSFER_PATH_MAX_BYTES,
  FILE_TRANSFER_MSG,
  validateFileDeleteRequest,
  validateFileDirectoryListRequest,
  validateFilePathHandleRequest,
} from '../../../shared/transport/file-transfer.js';
import {
  DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY,
  isDirectFileTransferClientUploadId,
} from '../../../shared/direct-file-transfer.js';
import {
  MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY,
  MACHINE_DIRECT_FILE_FETCH_CAPABILITY,
  MACHINE_DIRECT_FILE_TRANSFER_LIMITS,
  MACHINE_DIRECT_FILE_TRANSFER_MSG,
  refreshMachineDirectUploadAuthority,
  refreshMachineDirectFetchAuthority,
  validateMachineDirectFetchRequest,
  validateMachineDirectUploadRequest,
} from '../../../shared/machine-direct-file-transfer.js';
import {
  canOperateControlledMachine,
  resolveControlledMachineAccess,
} from '../share/machine-access.js';
import { FS_GENERIC_ERROR_CODES } from '../../../shared/fs-error-codes.js';
import type {
  AttachmentRef,
  FileDownloadRequest,
  FileDownloadStreamRequest,
  FilePathHandleRequest,
  FileDirectoryListRequest,
  FileDeleteRequest,
  FileUploadFetchRequest,
  FileUploadRequest,
} from '../../../shared/transport/file-transfer.js';
import logger from '../util/logger.js';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const fileTransferRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

// ── Native download tokens (in-memory, 15min expiry) ─────────────────────────
// Allows native apps to open download URLs in a system browser/download manager
// without needing auth cookies. Android download handoff may request the same
// URL more than once, so tokens are resource-bound and short-lived with a small
// use budget instead of being consumed on the first GET.
const DOWNLOAD_TOKEN_MAX_USES = 5;
const MULTIPART_UPLOAD_OVERHEAD_BYTES = 1024 * 1024;
const STAGED_UPLOAD_PREFIX = 'imcodes-staged-upload-';
const STAGED_UPLOAD_FETCH_CLEANUP_GRACE_MS = 30_000;
const UPLOAD_PROGRESS_STREAM_MIME = 'application/x-ndjson';
const STAGED_DOWNLOAD_TTL_MS = FILE_TRANSFER_LIMITS.DOWNLOAD_TIMEOUT_MS;
const MACHINE_FILE_HANDLE_BODY_MAX_BYTES = FILE_TRANSFER_PATH_MAX_BYTES + 1024;
const downloadTokens = new Map<string, {
  serverId: string;
  attachmentId: string;
  userId: string;
  expiresAt: number;
  remainingUses: number;
  sessionName?: string;
}>();
const stagedUploads = new Map<string, {
  serverId: string;
  controlledAccessUserId?: string;
  token: string;
  dir: string;
  filePath: string;
  size: number;
  mime?: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  deleteAfterFetchTimer?: ReturnType<typeof setTimeout>;
}>();
const stagedDownloads = new Map<string, {
  serverId: string;
  controlledAccessUserId?: string;
  token: string;
  stream: PassThrough;
  ready: Promise<Record<string, unknown>>;
  resolveReady: (msg: Record<string, unknown>) => void;
  rejectReady: (err: Error) => void;
  readySettled: boolean;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  started: boolean;
}>();

async function hasCurrentControlledStageAccess(
  db: Env['DB'],
  entry: { serverId: string; controlledAccessUserId?: string },
): Promise<boolean> {
  if (!entry.controlledAccessUserId) return true;
  const access = await resolveControlledMachineAccess(
    db,
    entry.controlledAccessUserId,
    entry.serverId,
    Date.now(),
  );
  return access != null
    && canOperateControlledMachine(access.access_role)
    && access.exec_enabled;
}

function settleStagedDownloadReady(downloadId: string, settle: (entry: NonNullable<ReturnType<typeof stagedDownloads.get>>) => void): void {
  const entry = stagedDownloads.get(downloadId);
  if (!entry || entry.readySettled) return;
  entry.readySettled = true;
  settle(entry);
}

function resolveStagedDownloadReady(downloadId: string, msg: Record<string, unknown>): void {
  settleStagedDownloadReady(downloadId, (entry) => entry.resolveReady(msg));
}

function rejectStagedDownloadReady(downloadId: string, err: Error): void {
  settleStagedDownloadReady(downloadId, (entry) => entry.rejectReady(err));
}

function waitForStagedDownloadReady(entry: { ready: Promise<Record<string, unknown>> }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('download_stream_not_ready')), FILE_TRANSFER_LIMITS.DOWNLOAD_STREAM_READY_TIMEOUT_MS);
    timer.unref?.();
    entry.ready.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function decodeRelayFilename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function deleteStagedDownload(downloadId: string, err?: Error): void {
  const entry = stagedDownloads.get(downloadId);
  if (!entry) return;
  stagedDownloads.delete(downloadId);
  clearTimeout(entry.timer);
  if (!entry.readySettled) {
    entry.readySettled = true;
    entry.rejectReady(err ?? new Error('download_stream_closed'));
  }
  if (err) {
    entry.stream.destroy(err);
  } else if (!entry.stream.destroyed) {
    entry.stream.end();
  }
}

function deleteStagedUpload(uploadId: string): void {
  const entry = stagedUploads.get(uploadId);
  if (!entry) return;
  stagedUploads.delete(uploadId);
  clearTimeout(entry.timer);
  if (entry.deleteAfterFetchTimer) clearTimeout(entry.deleteAfterFetchTimer);
  void rm(entry.dir, { recursive: true, force: true }).catch((err) => {
    logger.warn({ uploadId, err }, 'Failed to clean staged upload');
  });
}

function scheduleStagedUploadFetchCleanup(uploadId: string): void {
  const entry = stagedUploads.get(uploadId);
  if (!entry || entry.deleteAfterFetchTimer) return;
  entry.deleteAfterFetchTimer = setTimeout(
    () => deleteStagedUpload(uploadId),
    STAGED_UPLOAD_FETCH_CLEANUP_GRACE_MS,
  );
  entry.deleteAfterFetchTimer.unref?.();
}

async function persistStagedUpload(file: File, filePath: string): Promise<number> {
  await pipeline(
    Readable.fromWeb(file.stream() as never),
    createWriteStream(filePath),
  );
  const fileStat = await stat(filePath);
  return fileStat.size;
}

function buildRelayUrl(requestUrl: string, configuredServerUrl: string | undefined): URL {
  return configuredServerUrl?.trim() ? new URL(configuredServerUrl) : new URL(requestUrl);
}

function buildStagedUploadUrl(requestUrl: string, configuredServerUrl: string | undefined, serverId: string, uploadId: string, token: string): string {
  const url = buildRelayUrl(requestUrl, configuredServerUrl);
  url.pathname = `/api/server/${encodeURIComponent(serverId)}/upload-staged/${encodeURIComponent(uploadId)}`;
  url.search = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

function buildStagedDownloadUrl(requestUrl: string, configuredServerUrl: string | undefined, serverId: string, downloadId: string, token: string): string {
  const url = buildRelayUrl(requestUrl, configuredServerUrl);
  url.pathname = `/api/server/${encodeURIComponent(serverId)}/download-staged/${encodeURIComponent(downloadId)}`;
  url.search = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

/**
 * Send a `file.download_done` (base64 inline) daemon result to the browser as a
 * binary attachment response. Shared by the inline small-file fast path, the
 * legacy (no-stream-capability) path, and the relay-failure fallback — repo
 * rule: never copy code.
 */
function respondBase64Download(c: Context, result: Record<string, unknown>, attachmentId: string): Response {
  const content = Buffer.from(result.content as string, 'base64');
  const mime = (result.mime as string) || 'application/octet-stream';
  const filename = (result.filename as string) || attachmentId;
  c.header('Content-Type', mime);
  c.header('Content-Length', String(content.length));
  // RFC 5987: non-ASCII filenames must use filename*=UTF-8'' encoding. Include
  // both for maximum client compatibility.
  const safeFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '\\"');
  const encodedFilename = encodeURIComponent(filename).replace(/'/g, '%27');
  c.header('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);
  return c.body(content);
}

/**
 * One streaming-relay download attempt. Stages a sink, asks the daemon to stream
 * to it, and waits up to DOWNLOAD_STREAM_READY_TIMEOUT_MS for bytes to START
 * flowing. Returns a terminal `{ kind: 'done', response }` for a delivered
 * stream, an inline small-file reply, or a genuine missing/expired handle
 * (404/410). Returns `{ kind: 'retry' }` when the relay errored or did not begin
 * delivering in time — the caller retries (a fresh attempt can recover a wedged
 * PUT) and ultimately falls back to base64. A ready relay still returns as soon
 * as the first byte lands, so this never waits longer than necessary.
 */
async function attemptStreamedDownload(
  c: Context,
  bridge: ReturnType<typeof WsBridge.get>,
  serverId: string,
  attachmentId: string,
  controlledAccessUserId?: string,
): Promise<{ kind: 'done'; response: Response } | { kind: 'retry' }> {
  const downloadId = randomHex(16);
  const token = randomHex(32);
  const stream = new PassThrough();
  // Guard against an uncaught 'error' if the sink is destroyed while still
  // unconsumed (relay failure / timeout before we hand it to the Response).
  stream.on('error', () => {});
  const timer = setTimeout(() => {
    deleteStagedDownload(downloadId, new Error('download_timeout'));
  }, STAGED_DOWNLOAD_TTL_MS);
  timer.unref?.();
  let resolveReady!: (msg: Record<string, unknown>) => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  stagedDownloads.set(downloadId, {
    serverId,
    ...(controlledAccessUserId ? { controlledAccessUserId } : {}),
    token,
    stream,
    ready,
    resolveReady,
    rejectReady,
    readySettled: false,
    expiresAt: Date.now() + STAGED_DOWNLOAD_TTL_MS,
    timer,
    started: false,
  });

  const streamMsg: FileDownloadStreamRequest = {
    type: FILE_TRANSFER_MSG.DOWNLOAD_STREAM,
    downloadId,
    attachmentId,
    uploadUrl: buildStagedDownloadUrl(c.req.url, c.env.SERVER_URL, serverId, downloadId, token),
  };
  void bridge.sendFileTransferRequest(
    downloadId,
    streamMsg as unknown as Record<string, unknown>,
    FILE_TRANSFER_LIMITS.DOWNLOAD_TIMEOUT_MS,
  ).then((result) => {
    // Settle readiness from the WS ack only for an explicit error or an inline
    // reply. A success/READY ack is premature (bytes aren't flowing yet) — the
    // download-staged PUT handler settles the streaming success case.
    const resultType = result && (result as { type?: string }).type;
    if (resultType === 'file.download_error' || resultType === 'file.download_done') {
      resolveStagedDownloadReady(downloadId, result as Record<string, unknown>);
    }
  }).catch((err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    rejectStagedDownloadReady(downloadId, error);
    deleteStagedDownload(downloadId, error);
  });

  const entry = stagedDownloads.get(downloadId);
  if (!entry) return { kind: 'retry' };
  try {
    const result = await waitForStagedDownloadReady(entry);

    if (result.type === 'file.download_error') {
      const errMsg = result.message as string;
      deleteStagedDownload(downloadId, new Error(String(errMsg ?? 'download_failed')));
      // Genuine missing/expired handle is terminal (base64 would fail too).
      if (errMsg === 'not_found') return { kind: 'done', response: c.json({ error: 'not_found' }, 404) };
      if (errMsg === 'expired') return { kind: 'done', response: c.json({ error: 'handle_expired' }, 410) };
      return { kind: 'retry' }; // relay/transport error → retry, then base64
    }

    if (result.type === 'file.download_done') {
      // Small file returned inline — no relay/PassThrough involved.
      deleteStagedDownload(downloadId);
      return { kind: 'done', response: respondBase64Download(c, result, attachmentId) };
    }

    const mime = (result.mime as string) || 'application/octet-stream';
    const filename = (result.filename as string) || attachmentId;
    const size = typeof result.size === 'number' && Number.isFinite(result.size) && result.size >= 0
      ? Math.trunc(result.size)
      : undefined;
    c.header('Content-Type', mime);
    if (size !== undefined) c.header('Content-Length', String(size));
    const safeFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '\\"');
    const encodedFilename = encodeURIComponent(filename).replace(/'/g, '%27');
    c.header('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);
    c.header('Cache-Control', 'no-store');
    return {
      kind: 'done',
      response: new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers: c.res.headers }),
    };
  } catch {
    // Did not start delivering in time — retry / fall back.
    deleteStagedDownload(downloadId, new Error('download_stream_not_ready'));
    return { kind: 'retry' };
  }
}

function wantsUploadProgressStream(accept: string | undefined): boolean {
  return (accept ?? '').split(',').some((part) => part.trim().toLowerCase().startsWith(UPLOAD_PROGRESS_STREAM_MIME));
}

function jsonLine(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

// Token-auth middleware for download endpoint only — scoped to upload/download paths
// to avoid shadowing other sub-apps mounted at the same /api/server prefix.
const authMiddleware = requireAuth();

fileTransferRoutes.use('/:id/upload', authMiddleware);
fileTransferRoutes.use('/:id/machine-file-handle', authMiddleware);
fileTransferRoutes.use('/:id/machine-file-list', authMiddleware);
fileTransferRoutes.use('/:id/machine-direct-upload', authMiddleware);
fileTransferRoutes.use('/:id/machine-direct-fetch', authMiddleware);
fileTransferRoutes.use('/:id/uploads/:attachmentId/download-token', authMiddleware);
fileTransferRoutes.use('/:id/uploads/:attachmentId', authMiddleware);
fileTransferRoutes.use('/:id/uploads/:attachmentId/download', async (c, next) => {
  // Token-based auth bypass for native downloads (system browser has no app auth)
  const token = c.req.query('token');
  if (token && c.req.method === 'GET') {
    const entry = downloadTokens.get(token);
    if (!entry || Date.now() > entry.expiresAt) {
      downloadTokens.delete(token ?? '');
      return c.json({ error: 'invalid_or_expired_token' }, 401);
    }
    const serverId = c.req.param('id')!;
    const attachmentId = c.req.param('attachmentId')!;
    if (entry.serverId !== serverId || entry.attachmentId !== attachmentId) {
      return c.json({ error: 'token_resource_mismatch' }, 403);
    }
    entry.remainingUses -= 1;
    if (entry.remainingUses <= 0) downloadTokens.delete(token);
    c.set('userId' as never, entry.userId as never);
    c.set('tokenServerId' as never, entry.serverId as never);
    c.set('tokenAttachmentId' as never, entry.attachmentId as never);
    if (entry.sessionName) c.set('tokenSessionName' as never, entry.sessionName as never);
    return next();
  }
  // No token — fall back to cookie/bearer auth
  return (authMiddleware as any)(c, next);
});

type ControlledTargetGate =
  | { ok: true; bridge: ReturnType<typeof WsBridge.get>; controlled: boolean; daemonGeneration?: number }
  | { ok: false; reason: 'scoped_auth' | 'target_forbidden' | 'exec_disabled' | 'daemon_offline' | 'capability_unavailable' };

async function authorizeControlledFileTarget(
  c: Context,
  serverId: string,
  capability: string,
  requireControlled: boolean,
  allowInteractiveUser = false,
): Promise<ControlledTargetGate> {
  const target = await c.env.DB.queryOne(
    'SELECT user_id, node_role, exec_enabled, revoked_at FROM servers WHERE id = $1',
    [serverId],
  ) as {
    user_id: string;
    node_role: string | null;
    exec_enabled: boolean;
    revoked_at: number | null;
  } | null;
  const controlled = target?.node_role === 'controlled';
  if (!target || (requireControlled && !controlled)) return { ok: false, reason: 'target_forbidden' };

  const bridge = WsBridge.get(serverId);
  if (!controlled) return { ok: true, bridge, controlled: false };

  const userId = c.get('userId' as never) as string;
  const nodeRole = c.get('nodeRole' as never) as string | undefined;
  const sourceServerId = c.get('authServerId' as never) as string | undefined;
  const authenticatedFullDaemon = nodeRole === 'full'
    && typeof sourceServerId === 'string'
    && sourceServerId !== serverId;
  const authenticatedInteractiveUser = allowInteractiveUser
    && nodeRole === undefined
    && sourceServerId === undefined;
  if (!authenticatedFullDaemon && !authenticatedInteractiveUser) {
    return { ok: false, reason: 'scoped_auth' };
  }
  const access = await resolveControlledMachineAccess(c.env.DB, userId, serverId, Date.now());
  if (!access || !canOperateControlledMachine(access.access_role)) {
    return { ok: false, reason: 'target_forbidden' };
  }
  if (!access.exec_enabled) return { ok: false, reason: 'exec_disabled' };
  if (!bridge.isDaemonConnected()) return { ok: false, reason: 'daemon_offline' };
  // Capture the exact socket generation synchronously with the capability
  // observation. Callers can spend time reading/validating request bodies, but
  // must never dispatch the authorized command to a replacement generation.
  const daemonGeneration = bridge.daemonConnectionGeneration();
  if (!bridge.hasDaemonCapability(capability)) return { ok: false, reason: 'capability_unavailable' };
  return { ok: true, bridge, controlled: true, daemonGeneration };
}

function controlledTargetGateError(c: Context, reason: Exclude<ControlledTargetGate, { ok: true }>['reason']): Response {
  if (reason === 'daemon_offline') return c.json({ error: reason }, 503);
  if (reason === 'capability_unavailable') return c.json({ error: reason }, 409);
  return c.json({ error: reason }, 403);
}

type SharedFileAccessMode = 'read' | 'write';

async function authorizeSessionFileAccess(
  c: Context,
  serverId: string,
  userId: string,
  mode: SharedFileAccessMode,
): Promise<{ ok: true; sessionName?: string } | { ok: false; reason: string }> {
  const member = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (member.ok) return { ok: true };

  const sessionName = (
    (c.get('tokenSessionName' as never) as string | undefined)
    ?? c.req.query('sessionName')
    ?? ''
  ).trim();
  const target = shareTargetFromSessionName(serverId, sessionName);
  if (!target) return { ok: false, reason: member.reason };

  const access = await resolveHttpShareAccessForCoveredSession(c.env.DB, {
    serverId,
    userId,
    target,
  });
  if (access.actor.kind !== 'share') return { ok: false, reason: member.reason };
  if (mode === 'write' && access.actor.effectiveActorRole !== 'participant') {
    return { ok: false, reason: 'share-role-denied' };
  }
  return { ok: true, sessionName };
}

async function readBoundedJsonObject(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; tooLarge: boolean }> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, tooLarge: true };
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, tooLarge: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, tooLarge: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

// ── GET /api/server/:id/upload-staged/:uploadId ─────────────────────────────
// Token-authenticated, relay-local temporary object fetch for daemon uploads.
// Controlled-node stages also revalidate the issuing user's current grant
// before bytes leave the Server, so a queued token cannot outlive revocation.
// The token stays reusable for a short grace window after a successful read so
// daemon-side HTTP retries do not fail, then the staged object is removed.

fileTransferRoutes.get('/:id/upload-staged/:uploadId', async (c) => {
  const serverId = c.req.param('id')!;
  const uploadId = c.req.param('uploadId')!;
  const token = c.req.query('token') ?? '';
  const entry = stagedUploads.get(uploadId);
  if (!entry || entry.serverId !== serverId) return c.json({ error: 'not_found' }, 404);
  if (Date.now() > entry.expiresAt) {
    deleteStagedUpload(uploadId);
    return c.json({ error: 'expired' }, 410);
  }
  if (!token || token !== entry.token) return c.json({ error: 'forbidden' }, 403);
  const accessCurrent = await hasCurrentControlledStageAccess(c.env.DB, entry);
  if (stagedUploads.get(uploadId) !== entry) return c.json({ error: 'not_found' }, 404);
  if (!accessCurrent) {
    deleteStagedUpload(uploadId);
    return c.json({ error: 'forbidden' }, 403);
  }
  if (Date.now() > entry.expiresAt) {
    deleteStagedUpload(uploadId);
    return c.json({ error: 'expired' }, 410);
  }

  const fileStream = createReadStream(entry.filePath);
  fileStream.once('end', () => scheduleStagedUploadFetchCleanup(uploadId));
  fileStream.once('error', (err) => {
    logger.warn({ uploadId, err }, 'Staged upload stream failed');
  });

  return new Response(Readable.toWeb(fileStream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': entry.mime || 'application/octet-stream',
      'Content-Length': String(entry.size),
      'Cache-Control': 'no-store',
    },
  });
});

// ── PUT /api/server/:id/download-staged/:downloadId ─────────────────────────
// Token-authenticated, relay-local sink for daemon → browser streaming
// downloads. The daemon uploads raw bytes here; the browser GET response reads
// the paired PassThrough, so large files never cross the daemon WS as base64.
// Controlled-node stages revalidate access before accepting the first byte.

fileTransferRoutes.put('/:id/download-staged/:downloadId', async (c) => {
  const serverId = c.req.param('id')!;
  const downloadId = c.req.param('downloadId')!;
  const token = c.req.query('token') ?? '';
  const entry = stagedDownloads.get(downloadId);
  if (!entry || entry.serverId !== serverId) return c.json({ error: 'not_found' }, 404);
  if (Date.now() > entry.expiresAt) {
    deleteStagedDownload(downloadId, new Error('expired'));
    return c.json({ error: 'expired' }, 410);
  }
  if (!token || token !== entry.token) return c.json({ error: 'forbidden' }, 403);
  const accessCurrent = await hasCurrentControlledStageAccess(c.env.DB, entry);
  if (stagedDownloads.get(downloadId) !== entry) return c.json({ error: 'not_found' }, 404);
  if (!accessCurrent) {
    deleteStagedDownload(downloadId, new Error('authorization_revoked'));
    return c.json({ error: 'forbidden' }, 403);
  }
  if (Date.now() > entry.expiresAt) {
    deleteStagedDownload(downloadId, new Error('expired'));
    return c.json({ error: 'expired' }, 410);
  }
  if (entry.started) return c.json({ error: 'already_started' }, 409);

  const contentLengthHeader = c.req.header('content-length');
  const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : Number.NaN;
  if (Number.isFinite(contentLength) && contentLength > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
    deleteStagedDownload(downloadId, new Error('file_too_large'));
    return c.json({ error: 'file_too_large', maxBytes: FILE_TRANSFER_LIMITS.MAX_FILE_SIZE }, 413);
  }
  if (!c.req.raw.body) {
    deleteStagedDownload(downloadId, new Error('empty_body'));
    return c.json({ error: 'empty_body' }, 400);
  }

  entry.started = true;
  resolveStagedDownloadReady(downloadId, {
    type: FILE_TRANSFER_MSG.DOWNLOAD_STREAM_READY,
    downloadId,
    mime: c.req.header('content-type') || 'application/octet-stream',
    filename: decodeRelayFilename(c.req.header('x-imcodes-filename')),
    size: Number.isFinite(contentLength) && contentLength >= 0 ? Math.trunc(contentLength) : undefined,
  });
  try {
    await pipeline(
      Readable.fromWeb(c.req.raw.body as never),
      entry.stream,
    );
    deleteStagedDownload(downloadId);
    return c.json({ ok: true });
  } catch (err) {
    deleteStagedDownload(downloadId, err instanceof Error ? err : new Error(String(err)));
    logger.warn({ serverId, downloadId, err }, 'Staged download stream failed');
    return c.json({ error: 'download_stream_failed' }, 500);
  }
});

// ── POST /api/server/:id/upload ─────────────────────────────────────────────

// A FULL daemon asks a CONTROLLED node to turn one explicit regular-file path
// into the existing short-lived attachment handle. Directory browsing and
// arbitrary filesystem CRUD remain outside this route.
fileTransferRoutes.post('/:id/machine-file-handle', async (c) => {
  const serverId = c.req.param('id')!;
  const gate = await authorizeControlledFileTarget(
    c,
    serverId,
    FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
    true,
    true,
  );
  if (!gate.ok) return controlledTargetGateError(c, gate.reason);

  const boundedBody = await readBoundedJsonObject(c.req.raw, MACHINE_FILE_HANDLE_BODY_MAX_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.tooLarge
      ? c.json({ error: 'request_too_large' }, 413)
      : c.json({ error: 'invalid_body' }, 400);
  }
  const body = boundedBody.value;
  if (Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, 'path')) {
    return c.json({ error: FS_GENERIC_ERROR_CODES.INVALID_REQUEST }, 400);
  }
  const requestId = randomHex(16);
  const parsed = validateFilePathHandleRequest({
    ...body,
    type: FILE_TRANSFER_MSG.PATH_HANDLE,
    requestId,
  });
  if (!parsed.ok) return c.json({ error: FS_GENERIC_ERROR_CODES.INVALID_REQUEST }, 400);

  try {
    const result = await gate.bridge.sendFileTransferRequest(
      requestId,
      parsed.value as FilePathHandleRequest as unknown as Record<string, unknown>,
      FILE_TRANSFER_LIMITS.DOWNLOAD_TIMEOUT_MS,
      undefined,
      gate.daemonGeneration,
    );
    if (result.type === FILE_TRANSFER_MSG.PATH_HANDLE_ERROR) {
      const reason = typeof result.error === 'string' ? result.error : 'path_handle_failed';
      if (reason === 'not_found') return c.json({ error: reason }, 404);
      return c.json({ error: reason }, 400);
    }
    if (result.type !== FILE_TRANSFER_MSG.PATH_HANDLE_DONE || !result.attachment) {
      return c.json({ error: 'invalid_daemon_response' }, 502);
    }
    const attachment = result.attachment as AttachmentRef;
    attachment.serverId = serverId;
    return c.json({ ok: true, attachment });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'path_handle_failed';
    if (reason === 'daemon_offline' || reason === 'daemon_disconnected' || reason === 'daemon_generation_changed') {
      return c.json({ error: 'daemon_offline' }, 503);
    }
    if (reason === 'timeout') return c.json({ error: 'timeout' }, 504);
    logger.error({ serverId, err }, 'Controlled node path handle failed');
    return c.json({ error: 'path_handle_failed' }, 500);
  }
});

fileTransferRoutes.post('/:id/machine-file-list', async (c) => {
  const serverId = c.req.param('id')!;
  const gate = await authorizeControlledFileTarget(
    c,
    serverId,
    FILE_TRANSFER_DIRECTORY_CAPABILITY,
    true,
    true,
  );
  if (!gate.ok) return controlledTargetGateError(c, gate.reason);

  const boundedBody = await readBoundedJsonObject(c.req.raw, MACHINE_FILE_HANDLE_BODY_MAX_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.tooLarge
      ? c.json({ error: 'request_too_large' }, 413)
      : c.json({ error: 'invalid_body' }, 400);
  }
  const body = boundedBody.value;
  if (Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, 'path')) {
    return c.json({ error: FS_GENERIC_ERROR_CODES.INVALID_REQUEST }, 400);
  }
  const requestId = randomHex(16);
  const parsed = validateFileDirectoryListRequest({
    ...body,
    type: FILE_TRANSFER_MSG.DIRECTORY_LIST,
    requestId,
  });
  if (!parsed.ok) return c.json({ error: FS_GENERIC_ERROR_CODES.INVALID_REQUEST }, 400);

  try {
    const result = await gate.bridge.sendFileTransferRequest(
      requestId,
      parsed.value as FileDirectoryListRequest as unknown as Record<string, unknown>,
      FILE_TRANSFER_LIMITS.DOWNLOAD_TIMEOUT_MS,
      undefined,
      gate.daemonGeneration,
    );
    if (result.type === FILE_TRANSFER_MSG.DIRECTORY_LIST_ERROR) {
      return c.json({ error: typeof result.error === 'string' ? result.error : 'directory_list_failed' }, 400);
    }
    if (result.type !== FILE_TRANSFER_MSG.DIRECTORY_LIST_DONE
      || !Array.isArray(result.entries)
      || typeof result.resolvedPath !== 'string') {
      return c.json({ error: 'invalid_daemon_response' }, 502);
    }
    return c.json({ ok: true, resolvedPath: result.resolvedPath, entries: result.entries });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'directory_list_failed';
    if (reason === 'daemon_offline' || reason === 'daemon_disconnected' || reason === 'daemon_generation_changed') {
      return c.json({ error: 'daemon_offline' }, 503);
    }
    if (reason === 'timeout') return c.json({ error: 'timeout' }, 504);
    return c.json({ error: 'directory_list_failed' }, 500);
  }
});

fileTransferRoutes.post('/:id/machine-direct-upload', async (c) => {
  const serverId = c.req.param('id')!;
  const gate = await authorizeControlledFileTarget(c, serverId, MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY, true);
  if (!gate.ok) return controlledTargetGateError(c, gate.reason);
  const body = await readBoundedJsonObject(c.req.raw, MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_CONTROL_BYTES);
  if (!body.ok) return c.json({ error: body.tooLarge ? 'body_too_large' : 'invalid_body' }, body.tooLarge ? 413 : 400);
  const parsed = validateMachineDirectUploadRequest(body.value);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  // The request reached this authenticated, pod-sticky endpoint now. Re-mint
  // its short authority window from the Server clock so source clock skew can
  // neither reject a fresh request nor create a long-lived target authority.
  const forwarded = refreshMachineDirectUploadAuthority(parsed.value);
  try {
    const result = await gate.bridge.sendFileTransferRequest(
      forwarded.requestId,
      forwarded as unknown as Record<string, unknown>,
      MACHINE_DIRECT_FILE_TRANSFER_LIMITS.TRANSFER_TIMEOUT_MS,
      undefined,
      gate.daemonGeneration,
    );
    if (result.type !== MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE) {
      return c.json({ error: typeof result.error === 'string' ? result.error : 'direct_failed' }, 409);
    }
    const attachment = result.attachment as AttachmentRef;
    attachment.serverId = serverId;
    return c.json({ type: MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE, requestId: forwarded.requestId, attachment });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'timeout') return c.json({ error: 'direct_timeout' }, 504);
    if (message === 'request_id_conflict') return c.json({ error: message }, 409);
    return c.json({ error: 'daemon_offline' }, 503);
  }
});

fileTransferRoutes.post('/:id/machine-direct-fetch', async (c) => {
  const serverId = c.req.param('id')!;
  const gate = await authorizeControlledFileTarget(c, serverId, MACHINE_DIRECT_FILE_FETCH_CAPABILITY, true);
  if (!gate.ok) return controlledTargetGateError(c, gate.reason);
  const body = await readBoundedJsonObject(c.req.raw, MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_CONTROL_BYTES);
  if (!body.ok) return c.json({ error: body.tooLarge ? 'body_too_large' : 'invalid_body' }, body.tooLarge ? 413 : 400);
  const parsed = validateMachineDirectFetchRequest(body.value);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const forwarded = refreshMachineDirectFetchAuthority(parsed.value);
  try {
    const result = await gate.bridge.sendFileTransferRequest(
      forwarded.requestId,
      forwarded as unknown as Record<string, unknown>,
      MACHINE_DIRECT_FILE_TRANSFER_LIMITS.TRANSFER_TIMEOUT_MS,
      undefined,
      gate.daemonGeneration,
    );
    if (result.type !== MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE
      || result.requestId !== forwarded.requestId
      || typeof result.size !== 'number') {
      return c.json({ error: typeof result.error === 'string' ? result.error : 'direct_failed' }, 409);
    }
    return c.json({ type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE, requestId: forwarded.requestId, size: result.size });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'timeout') return c.json({ error: 'direct_timeout' }, 504);
    if (message === 'request_id_conflict') return c.json({ error: message }, 409);
    return c.json({ error: 'daemon_offline' }, 503);
  }
});

fileTransferRoutes.post('/:id/upload', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;

  const controlledGate = await authorizeControlledFileTarget(
    c,
    serverId,
    FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
    false,
    true,
  );
  if (!controlledGate.ok) return controlledTargetGateError(c, controlledGate.reason);
  // Controlled-node shares have their own DB-authoritative Owner/Participant
  // grants. Standard daemons retain the existing member/session-share check.
  if (!controlledGate.controlled) {
    const access = await authorizeSessionFileAccess(c, serverId, userId, 'write');
    if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);
  }

  const contentLengthHeader = c.req.header('content-length');
  const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : Number.NaN;
  if (
    Number.isFinite(contentLength)
    && contentLength > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE + MULTIPART_UPLOAD_OVERHEAD_BYTES
  ) {
    return c.json({
      error: 'file_too_large',
      maxBytes: FILE_TRANSFER_LIMITS.MAX_FILE_SIZE,
    }, 413);
  }

  // Parse multipart
  const formData = await c.req.formData().catch(() => null);
  if (!formData) return c.json({ error: 'invalid_body' }, 400);

  const file = formData.get('file');
  if (!file || !(file instanceof File)) return c.json({ error: 'missing_file' }, 400);
  const rawClientUploadId = formData.get('clientUploadId');
  const clientUploadId = typeof rawClientUploadId === 'string' && isDirectFileTransferClientUploadId(rawClientUploadId)
    ? rawClientUploadId
    : undefined;
  const rawDestinationDirectory = formData.get('destinationDirectory');
  const destinationDirectory = typeof rawDestinationDirectory === 'string' && rawDestinationDirectory.trim()
    ? rawDestinationDirectory.trim()
    : undefined;
  if (destinationDirectory) {
    if (Buffer.byteLength(destinationDirectory, 'utf8') > FILE_TRANSFER_PATH_MAX_BYTES) {
      return c.json({ error: 'invalid_destination_directory' }, 400);
    }
    if (!controlledGate.controlled || !controlledGate.bridge.hasDaemonCapability(FILE_TRANSFER_DIRECTORY_CAPABILITY)) {
      return c.json({ error: 'capability_unavailable' }, 409);
    }
  }

  // Size check
  if (file.size > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
    return c.json({
      error: 'file_too_large',
      maxBytes: FILE_TRANSFER_LIMITS.MAX_FILE_SIZE,
    }, 413);
  }

  // Daemon connectivity check
  const bridge = controlledGate.bridge;
  if (!bridge.isDaemonConnected()) {
    return c.json({ error: 'daemon_offline' }, 503);
  }
  // The request has an exact-key daemon validator. Include the dedupe field
  // only when the current clean v2 upload-recovery capability is advertised.
  const negotiatedClientUploadId = (
    bridge.hasDaemonCapability(DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY)
    || bridge.hasDaemonCapability(MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY)
  )
    ? clientUploadId
    : undefined;

  // Generate upload ID and sanitized filename
  const uploadId = randomHex(16);
  const ext = path.extname(file.name || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 20);
  const filename = `${randomHex(16)}${ext}`;
  const stagedDir = await mkdtemp(path.join(tmpdir(), STAGED_UPLOAD_PREFIX));
  const stagedPath = path.join(stagedDir, filename);
  const stagedSize = await persistStagedUpload(file, stagedPath).catch(async (err) => {
    await rm(stagedDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  });
  if (stagedSize !== file.size) {
    await rm(stagedDir, { recursive: true, force: true }).catch(() => {});
    return c.json({ error: 'upload_failed', message: 'size_mismatch' }, 400);
  }
  const supportsRelayFetch = bridge.hasDaemonCapability(FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY);
  let relayStaged = false;
  let legacyStageDeleted = false;
  const cleanupUploadStage = () => {
    if (relayStaged) {
      deleteStagedUpload(uploadId);
      return;
    }
    if (legacyStageDeleted) return;
    legacyStageDeleted = true;
    void rm(stagedDir, { recursive: true, force: true }).catch((err) => {
      logger.warn({ uploadId, err }, 'Failed to clean legacy staged upload');
    });
  };

  let uploadMsg: FileUploadFetchRequest | FileUploadRequest;
  if (supportsRelayFetch) {
    const token = randomHex(32);
    const expiresAt = Date.now() + FILE_TRANSFER_LIMITS.STAGED_UPLOAD_TTL_MS;
    const timer = setTimeout(() => deleteStagedUpload(uploadId), FILE_TRANSFER_LIMITS.STAGED_UPLOAD_TTL_MS);
    timer.unref?.();
    stagedUploads.set(uploadId, {
      serverId,
      ...(controlledGate.controlled ? { controlledAccessUserId: userId } : {}),
      token,
      dir: stagedDir,
      filePath: stagedPath,
      size: stagedSize,
      mime: file.type || undefined,
      expiresAt,
      timer,
    });
    relayStaged = true;

    uploadMsg = {
      type: 'file.upload_fetch',
      uploadId,
      filename,
      originalName: file.name || undefined,
      mime: file.type || undefined,
      size: file.size,
      downloadUrl: buildStagedUploadUrl(c.req.url, c.env.SERVER_URL, serverId, uploadId, token),
      ...(negotiatedClientUploadId ? { clientUploadId: negotiatedClientUploadId } : {}),
      ...(destinationDirectory ? { destinationDirectory } : {}),
    };
  } else {
    uploadMsg = {
      type: 'file.upload',
      uploadId,
      filename,
      originalName: file.name || undefined,
      mime: file.type || undefined,
      size: file.size,
      content: (await readFile(stagedPath)).toString('base64'),
      ...(negotiatedClientUploadId ? { clientUploadId: negotiatedClientUploadId } : {}),
      ...(destinationDirectory ? { destinationDirectory } : {}),
    };
  }

  const runDaemonFetch = async (onProgress?: (msg: Record<string, unknown>) => void): Promise<Response> => {
    try {
      const result = await bridge.sendFileTransferRequest(
        uploadId,
        uploadMsg as unknown as Record<string, unknown>,
        FILE_TRANSFER_LIMITS.UPLOAD_TIMEOUT_MS,
        onProgress,
        controlledGate.daemonGeneration,
      );

      if (result.type === 'file.upload_error') {
        const code = typeof (result as { code?: unknown }).code === 'string'
          ? (result as { code: string }).code
          : 'upload_failed';
        logger.warn({ serverId, uploadId, error: result.message, code }, 'Daemon upload error');
        // 507 Insufficient Storage when the daemon's disk is full; 500 otherwise.
        const status = code === FILE_TRANSFER_UPLOAD_ERROR_CODE.INSUFFICIENT_CAPACITY ? 507 : 500;
        return c.json({ error: code, message: result.message }, status);
      }

      const attachment = result.attachment as AttachmentRef;
      // Server fills serverId (daemon doesn't know it)
      attachment.serverId = serverId;
      return c.json({ ok: true, attachment });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'daemon_offline' || msg === 'daemon_disconnected' || msg === 'daemon_error') {
        return c.json({ error: 'daemon_offline' }, 503);
      }
      if (msg === 'timeout') {
        logger.warn({ serverId, uploadId }, 'Upload timeout');
        return c.json({ error: 'upload_timeout' }, 504);
      }
      logger.error({ serverId, uploadId, err }, 'Upload relay failed');
      return c.json({ error: 'upload_failed' }, 500);
    } finally {
      cleanupUploadStage();
    }
  };

  if (!wantsUploadProgressStream(c.req.header('accept'))) {
    return runDaemonFetch();
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (payload: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(jsonLine(payload)));
      };
      try {
        write({
          type: 'file.upload_progress',
          uploadId,
          loaded: 0,
          total: file.size,
        });
        const result = await bridge.sendFileTransferRequest(
          uploadId,
          uploadMsg as unknown as Record<string, unknown>,
          FILE_TRANSFER_LIMITS.UPLOAD_TIMEOUT_MS,
          (msg) => write(msg),
          controlledGate.daemonGeneration,
        );

        if (result.type === 'file.upload_error') {
          logger.warn({ serverId, uploadId, error: result.message }, 'Daemon upload error');
          write({ type: 'file.upload_error', uploadId, error: 'upload_failed', message: result.message });
          return;
        }

        const attachment = result.attachment as AttachmentRef;
        attachment.serverId = serverId;
        write({ type: 'file.upload_done', uploadId, ok: true, attachment });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'timeout') {
          logger.warn({ serverId, uploadId }, 'Upload timeout');
          write({ type: 'file.upload_error', uploadId, error: 'upload_timeout' });
        } else if (msg === 'daemon_offline' || msg === 'daemon_disconnected' || msg === 'daemon_error') {
          write({ type: 'file.upload_error', uploadId, error: 'daemon_offline' });
        } else {
          logger.error({ serverId, uploadId, err }, 'Upload relay failed');
          write({ type: 'file.upload_error', uploadId, error: 'upload_failed' });
        }
      } finally {
        cleanupUploadStage();
        closed = true;
        controller.close();
      }
    },
    cancel() {
      cleanupUploadStage();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': `${UPLOAD_PROGRESS_STREAM_MIME}; charset=utf-8`,
      'Cache-Control': 'no-store',
    },
  });
});

// ── DELETE /api/server/:id/uploads/:attachmentId ───────────────────────────

fileTransferRoutes.delete('/:id/uploads/:attachmentId', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const attachmentId = c.req.param('attachmentId')!;

  const gate = await authorizeControlledFileTarget(
    c,
    serverId,
    FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
    false,
    true,
  );
  if (!gate.ok) return controlledTargetGateError(c, gate.reason);
  if (!gate.controlled) {
    const access = await authorizeSessionFileAccess(c, serverId, userId, 'write');
    if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);
  }
  if (!gate.bridge.isDaemonConnected()) return c.json({ error: 'daemon_offline' }, 503);

  const requestId = randomHex(16);
  const parsed = validateFileDeleteRequest({ type: FILE_TRANSFER_MSG.DELETE, requestId, attachmentId });
  if (!parsed.ok) return c.json({ error: 'invalid_attachment_id' }, 400);

  try {
    const result = await gate.bridge.sendFileTransferRequest(
      requestId,
      parsed.value as FileDeleteRequest as unknown as Record<string, unknown>,
      30_000,
      undefined,
      gate.daemonGeneration,
    );
    if (result.type === FILE_TRANSFER_MSG.DELETE_DONE) return c.json({ ok: true });
    const reason = typeof result.error === 'string' ? result.error : FILE_TRANSFER_DELETE_ERROR.DELETE_FAILED;
    return c.json({ error: reason }, reason === FILE_TRANSFER_DELETE_ERROR.FORBIDDEN ? 403 : 500);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (reason === 'daemon_offline' || reason === 'daemon_disconnected' || reason === 'daemon_generation_changed') {
      return c.json({ error: 'daemon_offline' }, 503);
    }
    if (reason === 'timeout') return c.json({ error: 'timeout' }, 504);
    logger.error({ serverId, attachmentId, error }, 'Attachment deletion failed');
    return c.json({ error: FILE_TRANSFER_DELETE_ERROR.DELETE_FAILED }, 500);
  }
});

// ── POST /api/server/:id/uploads/:attachmentId/download-token ────────────────
// Generate a one-time token for downloading without cookies (iOS native app).

fileTransferRoutes.post('/:id/uploads/:attachmentId/download-token', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const attachmentId = c.req.param('attachmentId')!;

  const controlledGate = await authorizeControlledFileTarget(
    c,
    serverId,
    FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
    false,
    true,
  );
  if (!controlledGate.ok) return controlledTargetGateError(c, controlledGate.reason);
  const access = controlledGate.controlled
    ? { ok: true as const, sessionName: undefined as string | undefined }
    : await authorizeSessionFileAccess(c, serverId, userId, 'read');
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

  if (!/^[a-f0-9]+(\.[a-zA-Z0-9]+)?$/.test(attachmentId)) {
    return c.json({ error: 'invalid_attachment_id' }, 400);
  }

  const token = randomHex(32);
  downloadTokens.set(token, {
    serverId,
    attachmentId,
    userId,
    expiresAt: Date.now() + 900_000,
    remainingUses: DOWNLOAD_TOKEN_MAX_USES,
    ...(access.sessionName ? { sessionName: access.sessionName } : {}),
  });

  // Cleanup expired tokens periodically (max 1000 entries)
  if (downloadTokens.size > 1000) {
    const now = Date.now();
    for (const [k, v] of downloadTokens) {
      if (now > v.expiresAt) downloadTokens.delete(k);
    }
  }

  return c.json({ token, expiresIn: 900 });
});

// ── GET /api/server/:id/uploads/:attachmentId/download ──────────────────────

fileTransferRoutes.get('/:id/uploads/:attachmentId/download', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const attachmentId = c.req.param('attachmentId')!;

  // Token-auth binding: defense-in-depth. The middleware already checks this
  // before decrementing remainingUses.
  const tokenServerId = c.get('tokenServerId' as never) as string | undefined;
  const tokenAttachmentId = c.get('tokenAttachmentId' as never) as string | undefined;
  if (tokenServerId && (tokenServerId !== serverId || tokenAttachmentId !== attachmentId)) {
    return c.json({ error: 'token_resource_mismatch' }, 403);
  }

  const controlledGate = await authorizeControlledFileTarget(
    c,
    serverId,
    FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
    false,
    true,
  );
  if (!controlledGate.ok) return controlledTargetGateError(c, controlledGate.reason);
  if (!controlledGate.controlled) {
    const access = await authorizeSessionFileAccess(c, serverId, userId, 'read');
    if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);
  }

  // Validate attachment ID format (hex + optional extension)
  if (!/^[a-f0-9]+(\.[a-zA-Z0-9]+)?$/.test(attachmentId)) {
    return c.json({ error: 'invalid_attachment_id' }, 400);
  }

  // Daemon connectivity check
  const bridge = controlledGate.bridge;
  if (!bridge.isDaemonConnected()) {
    return c.json({ error: 'daemon_offline' }, 503);
  }

  const downloadId = randomHex(16);
  const supportsStreamDownload = bridge.hasDaemonCapability?.(FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY) === true;

  try {
    if (supportsStreamDownload) {
      // Give the streaming relay several chances to START delivering before
      // falling back to base64. Each attempt waits DOWNLOAD_STREAM_READY_TIMEOUT_MS
      // (long enough to catch a relay that's ready a few seconds in), and a fresh
      // attempt can recover a wedged PUT — while a ready relay returns as soon as
      // the first byte lands. Only a delivered stream / inline reply / genuine
      // missing-or-expired handle is terminal; everything else retries, then
      // falls through to base64.
      for (let attempt = 0; attempt < FILE_TRANSFER_LIMITS.DOWNLOAD_STREAM_MAX_ATTEMPTS; attempt++) {
        const outcome = await attemptStreamedDownload(
          c,
          bridge,
          serverId,
          attachmentId,
          controlledGate.controlled ? userId : undefined,
        );
        if (outcome.kind === 'done') return outcome.response;
      }
      logger.warn(
        { serverId, attachmentId, attempts: FILE_TRANSFER_LIMITS.DOWNLOAD_STREAM_MAX_ATTEMPTS },
        'Streamed download relay did not deliver after retries — falling back to base64 download',
      );
      // fall through to the legacy base64 path below (relay-failure fallback)
    }

    // Legacy base64 download: the path for daemons without stream capability AND
    // the fallback when the stream relay above failed to deliver. Use a fresh id
    // because the stream attempt (if any) already consumed `downloadId` for its
    // WS request, whose RPC may still be pending.
    const legacyDownloadId = supportsStreamDownload ? randomHex(16) : downloadId;
    const downloadMsg: FileDownloadRequest = {
      type: 'file.download',
      downloadId: legacyDownloadId,
      attachmentId,
    };
    const result = await bridge.sendFileTransferRequest(
      legacyDownloadId,
      downloadMsg as unknown as Record<string, unknown>,
      FILE_TRANSFER_LIMITS.DOWNLOAD_TIMEOUT_MS,
    );

    if (result.type === 'file.download_error') {
      const errMsg = result.message as string;
      if (errMsg === 'not_found') return c.json({ error: 'not_found' }, 404);
      if (errMsg === 'expired') return c.json({ error: 'handle_expired' }, 410);
      return c.json({ error: 'download_failed', message: errMsg }, 500);
    }

    return respondBase64Download(c, result, attachmentId);
  } catch (err) {
    deleteStagedDownload(downloadId, err instanceof Error ? err : new Error(String(err)));
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'daemon_offline' || msg === 'daemon_disconnected' || msg === 'daemon_error') return c.json({ error: 'daemon_offline' }, 503);
    if (msg === 'timeout') return c.json({ error: 'download_timeout' }, 504);
    if (msg === 'download_stream_not_ready') return c.json({ error: 'download_stream_not_ready' }, 504);
    logger.error({ serverId, downloadId, err }, 'Download relay failed');
    return c.json({ error: 'download_failed' }, 500);
  }
});
