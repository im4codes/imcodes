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

fileTransferRoutes.use('/*', requireAuth());

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

// ── GET /api/server/:id/uploads/:attachmentId/download ──────────────────────

fileTransferRoutes.get('/:id/uploads/:attachmentId/download', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const attachmentId = c.req.param('attachmentId')!;

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
    c.header('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '\\"')}"`);

    return c.body(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'daemon_offline' || msg === 'daemon_disconnected' || msg === 'daemon_error') return c.json({ error: 'daemon_offline' }, 503);
    if (msg === 'timeout') return c.json({ error: 'download_timeout' }, 504);
    logger.error({ serverId, downloadId, err }, 'Download relay failed');
    return c.json({ error: 'download_failed' }, 500);
  }
});
