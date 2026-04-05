/**
 * File transfer routes: upload and download via HTTP, relayed to daemon over WS.
 */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import { WsBridge } from '../ws/bridge.js';
import { randomHex } from '../security/crypto.js';
import { FILE_TRANSFER_LIMITS } from '../../../shared/transport/file-transfer.js';
import type { AttachmentRef, FileUploadRequest, FileDownloadRequest } from '../../../shared/transport/file-transfer.js';
import logger from '../util/logger.js';
import * as path from 'node:path';

export const fileTransferRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

// ── One-time download tokens (in-memory, 300s expiry) ─────────────────────────
// Allows native apps (iOS WKWebView) to open download URLs in the system browser
// without needing auth cookies. Token is single-use and short-lived.
const downloadTokens = new Map<string, { serverId: string; attachmentId: string; userId: string; expiresAt: number }>();

const authMiddleware = requireAuth();
fileTransferRoutes.use('/*', async (c, next) => {
  // Allow token-based auth for download endpoint, otherwise require cookie/bearer auth
  const token = c.req.query('token');
  if (token && c.req.method === 'GET' && c.req.path.endsWith('/download')) {
    const entry = downloadTokens.get(token);
    if (!entry || Date.now() > entry.expiresAt) {
      downloadTokens.delete(token ?? '');
      return c.json({ error: 'invalid_or_expired_token' }, 401);
    }
    // Consume token (single-use)
    downloadTokens.delete(token);
    // Pass token binding so download handler can verify URL params match
    c.set('userId' as never, entry.userId as never);
    c.set('tokenServerId' as never, entry.serverId as never);
    c.set('tokenAttachmentId' as never, entry.attachmentId as never);
    return next();
  }
  return (authMiddleware as any)(c, next);
});

// ── POST /api/server/:id/upload ─────────────────────────────────────────────

fileTransferRoutes.post('/:id/upload', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;

  // Permission check
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  // Parse multipart
  const formData = await c.req.formData().catch(() => null);
  if (!formData) return c.json({ error: 'invalid_body' }, 400);

  const file = formData.get('file');
  if (!file || !(file instanceof File)) return c.json({ error: 'missing_file' }, 400);

  // Size check
  if (file.size > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
    return c.json({
      error: 'file_too_large',
      maxBytes: FILE_TRANSFER_LIMITS.MAX_FILE_SIZE,
    }, 413);
  }

  // Daemon connectivity check
  const bridge = WsBridge.get(serverId);
  if (!bridge.isDaemonConnected()) {
    return c.json({ error: 'daemon_offline' }, 503);
  }

  // Generate upload ID and sanitized filename
  const uploadId = randomHex(16);
  const ext = path.extname(file.name || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 20);
  const filename = `${randomHex(16)}${ext}`;

  // Read file as base64
  const arrayBuffer = await file.arrayBuffer();
  const content = Buffer.from(arrayBuffer).toString('base64');

  const uploadMsg: FileUploadRequest = {
    type: 'file.upload',
    uploadId,
    filename,
    originalName: file.name || undefined,
    mime: file.type || undefined,
    size: file.size,
    content,
  };

  try {
    const result = await bridge.sendFileTransferRequest(
      uploadId,
      uploadMsg as unknown as Record<string, unknown>,
      FILE_TRANSFER_LIMITS.UPLOAD_TIMEOUT_MS,
    );

    if (result.type === 'file.upload_error') {
      logger.warn({ serverId, uploadId, error: result.message }, 'Daemon upload error');
      return c.json({ error: 'upload_failed', message: result.message }, 500);
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
  }
});

// ── POST /api/server/:id/uploads/:attachmentId/download-token ────────────────
// Generate a one-time token for downloading without cookies (iOS native app).

fileTransferRoutes.post('/:id/uploads/:attachmentId/download-token', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const attachmentId = c.req.param('attachmentId')!;

  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  if (!/^[a-f0-9]+(\.[a-zA-Z0-9]+)?$/.test(attachmentId)) {
    return c.json({ error: 'invalid_attachment_id' }, 400);
  }

  const token = randomHex(32);
  downloadTokens.set(token, { serverId, attachmentId, userId, expiresAt: Date.now() + 300_000 });

  // Cleanup expired tokens periodically (max 1000 entries)
  if (downloadTokens.size > 1000) {
    const now = Date.now();
    for (const [k, v] of downloadTokens) {
      if (now > v.expiresAt) downloadTokens.delete(k);
    }
  }

  return c.json({ token, expiresIn: 300 });
});

// ── GET /api/server/:id/uploads/:attachmentId/download ──────────────────────

fileTransferRoutes.get('/:id/uploads/:attachmentId/download', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const attachmentId = c.req.param('attachmentId')!;

  // Token-auth binding: verify token was minted for this exact resource
  const tokenServerId = c.get('tokenServerId' as never) as string | undefined;
  const tokenAttachmentId = c.get('tokenAttachmentId' as never) as string | undefined;
  if (tokenServerId && (tokenServerId !== serverId || tokenAttachmentId !== attachmentId)) {
    return c.json({ error: 'token_resource_mismatch' }, 403);
  }

  // Permission check
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  // Validate attachment ID format (hex + optional extension)
  if (!/^[a-f0-9]+(\.[a-zA-Z0-9]+)?$/.test(attachmentId)) {
    return c.json({ error: 'invalid_attachment_id' }, 400);
  }

  // Daemon connectivity check
  const bridge = WsBridge.get(serverId);
  if (!bridge.isDaemonConnected()) {
    return c.json({ error: 'daemon_offline' }, 503);
  }

  const downloadId = randomHex(16);
  const downloadMsg: FileDownloadRequest = {
    type: 'file.download',
    downloadId,
    attachmentId,
  };

  try {
    const result = await bridge.sendFileTransferRequest(
      downloadId,
      downloadMsg as unknown as Record<string, unknown>,
      FILE_TRANSFER_LIMITS.DOWNLOAD_TIMEOUT_MS,
    );

    if (result.type === 'file.download_error') {
      const errMsg = result.message as string;
      if (errMsg === 'not_found') return c.json({ error: 'not_found' }, 404);
      if (errMsg === 'expired') return c.json({ error: 'handle_expired' }, 410);
      return c.json({ error: 'download_failed', message: errMsg }, 500);
    }

    // Decode base64 content and return as binary response
    const content = Buffer.from(result.content as string, 'base64');
    const mime = (result.mime as string) || 'application/octet-stream';
    const filename = (result.filename as string) || attachmentId;

    c.header('Content-Type', mime);
    c.header('Content-Length', String(content.length));
    // RFC 5987: non-ASCII filenames must use filename*=UTF-8'' encoding.
    // Always include both for maximum client compatibility.
    const safeFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '\\"');
    const encodedFilename = encodeURIComponent(filename).replace(/'/g, '%27');
    c.header('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);

    return c.body(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'daemon_offline' || msg === 'daemon_disconnected' || msg === 'daemon_error') return c.json({ error: 'daemon_offline' }, 503);
    if (msg === 'timeout') return c.json({ error: 'download_timeout' }, 504);
    logger.error({ serverId, downloadId, err }, 'Download relay failed');
    return c.json({ error: 'download_failed' }, 500);
  }
});
