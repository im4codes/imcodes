import { randomBytes } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  FILE_TRANSFER_LIMITS,
  validateAttachmentRef,
  type AttachmentRef,
} from '../../shared/transport/file-transfer.js';
import { isFilePreviewPathAllowed } from './file-preview-path-policy.js';
import { MachineControlPlaneError } from './machine-exec-client.js';

const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;

interface MachineFileBaseOptions {
  serverUrl: string;
  sourceServerId: string;
  sourceToken: string;
  targetServerId: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface SendFileToMachineOptions extends MachineFileBaseOptions {
  sourcePath: string;
}

export interface FetchFileFromMachineOptions extends MachineFileBaseOptions {
  sourcePath: string;
  destinationPath: string;
  overwrite?: boolean;
}

export interface MachineFileTransferResult {
  size: number;
  attachmentId: string;
  remotePath?: string;
  destinationPath?: string;
}

function authHeaders(sourceServerId: string, sourceToken: string): Record<string, string> {
  return { 'X-Server-Id': sourceServerId, authorization: `Bearer ${sourceToken}` };
}

function boundedTransferSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new MachineControlPlaneError('malformed', 'empty control-plane response');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_CONTROL_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new MachineControlPlaneError('malformed', 'oversized control-plane response');
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof MachineControlPlaneError) throw error;
    throw new MachineControlPlaneError('malformed', 'malformed control-plane response');
  }
}

async function resolveReadableRegularFile(sourcePath: string): Promise<{ path: string; size: number }> {
  const requested = resolve(sourcePath);
  let rawStat;
  try {
    rawStat = await lstat(requested);
  } catch {
    throw new MachineControlPlaneError('malformed', 'source file is unavailable');
  }
  if (rawStat.isSymbolicLink() || !rawStat.isFile()) {
    throw new MachineControlPlaneError('malformed', 'source must be a regular file');
  }
  const canonical = await realpath(requested).catch(() => null);
  if (!canonical || !isFilePreviewPathAllowed(canonical)) {
    throw new MachineControlPlaneError('malformed', 'source path is forbidden');
  }
  if (rawStat.size > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
    throw new MachineControlPlaneError('malformed', 'source file is too large');
  }
  return { path: canonical, size: rawStat.size };
}

function parseAttachmentResponse(value: Record<string, unknown>): AttachmentRef {
  if (value.ok !== true || !Object.prototype.hasOwnProperty.call(value, 'attachment')) {
    throw new MachineControlPlaneError('http_status', typeof value.error === 'string' ? value.error : 'file transfer rejected');
  }
  const attachment = validateAttachmentRef(value.attachment);
  if (!attachment) throw new MachineControlPlaneError('malformed', 'malformed attachment response');
  return attachment;
}

export async function sendFileToMachine(options: SendFileToMachineOptions): Promise<MachineFileTransferResult> {
  const source = await resolveReadableRegularFile(options.sourcePath);
  const doFetch = options.fetchImpl ?? fetch;
  const form = new FormData();
  form.append('file', await openAsBlob(source.path), basename(source.path));
  let response: Response;
  try {
    response = await doFetch(
      `${options.serverUrl.replace(/\/+$/, '')}/api/server/${encodeURIComponent(options.targetServerId)}/upload`,
      {
        method: 'POST',
        headers: authHeaders(options.sourceServerId, options.sourceToken),
        body: form,
        signal: boundedTransferSignal(options.signal, FILE_TRANSFER_LIMITS.UPLOAD_TIMEOUT_MS),
      },
    );
  } catch {
    throw new MachineControlPlaneError('transport', 'file upload transport failed');
  }
  const body = await readBoundedJson(response);
  if (!response.ok) throw new MachineControlPlaneError('http_status', typeof body.error === 'string' ? body.error : `http_${response.status}`);
  const attachment = parseAttachmentResponse(body);
  return {
    size: attachment.size ?? source.size,
    attachmentId: attachment.id,
    remotePath: attachment.daemonPath,
  };
}

async function prepareDestination(destinationPath: string, overwrite: boolean): Promise<{ destination: string; temp: string }> {
  const destination = resolve(destinationPath);
  const parent = await realpath(dirname(destination)).catch(() => null);
  if (!parent || !isFilePreviewPathAllowed(parent)) {
    throw new MachineControlPlaneError('malformed', 'destination directory is unavailable or forbidden');
  }
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && (!overwrite || existing.isDirectory() || existing.isSymbolicLink())) {
    throw new MachineControlPlaneError('malformed', existing.isDirectory() || existing.isSymbolicLink()
      ? 'destination must be a regular file path'
      : 'destination already exists');
  }
  return {
    destination,
    temp: join(parent, `.${basename(destination)}.imcodes-${randomBytes(12).toString('hex')}.part`),
  };
}

async function commitDownloadedFile(temp: string, destination: string, overwrite: boolean): Promise<void> {
  if (overwrite) {
    // Never unlink first: if the platform cannot atomically replace the target,
    // fail and preserve the original destination rather than exposing a gap.
    await rename(temp, destination);
    return;
  }
  // Hard-linking a sibling temp file gives no-overwrite semantics even if a
  // destination appears after validation. The temp and destination share a FS.
  await link(temp, destination);
  await unlink(temp);
}

export async function fetchFileFromMachine(options: FetchFileFromMachineOptions): Promise<MachineFileTransferResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.serverUrl.replace(/\/+$/, '');
  const headers = authHeaders(options.sourceServerId, options.sourceToken);
  let handleResponse: Response;
  try {
    handleResponse = await doFetch(`${base}/api/server/${encodeURIComponent(options.targetServerId)}/machine-file-handle`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: options.sourcePath }),
      signal: boundedTransferSignal(options.signal, FILE_TRANSFER_LIMITS.DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new MachineControlPlaneError('transport', 'file handle transport failed');
  }
  const handleBody = await readBoundedJson(handleResponse);
  if (!handleResponse.ok) throw new MachineControlPlaneError('http_status', typeof handleBody.error === 'string' ? handleBody.error : `http_${handleResponse.status}`);
  const attachment = parseAttachmentResponse(handleBody);
  const prepared = await prepareDestination(options.destinationPath, options.overwrite === true);

  let file;
  try {
    file = await open(prepared.temp, 'wx', 0o600);
    const response = await doFetch(
      `${base}/api/server/${encodeURIComponent(options.targetServerId)}/uploads/${encodeURIComponent(attachment.id)}/download`,
      { headers, signal: boundedTransferSignal(options.signal, FILE_TRANSFER_LIMITS.DOWNLOAD_TIMEOUT_MS) },
    );
    if (!response.ok || !response.body) {
      throw new MachineControlPlaneError('http_status', `file download rejected: http_${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
      throw new MachineControlPlaneError('malformed', 'download is too large');
    }
    const reader = response.body.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
        await reader.cancel().catch(() => {});
        throw new MachineControlPlaneError('malformed', 'download is too large');
      }
      await file.write(value);
    }
    await file.sync();
    await file.close();
    file = undefined;
    await commitDownloadedFile(prepared.temp, prepared.destination, options.overwrite === true);
    return { size, attachmentId: attachment.id, destinationPath: prepared.destination };
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(prepared.temp).catch(() => {});
    if (error instanceof MachineControlPlaneError) throw error;
    throw new MachineControlPlaneError('transport', 'file download failed');
  }
}
