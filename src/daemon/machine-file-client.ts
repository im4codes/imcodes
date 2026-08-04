import { randomBytes } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  FILE_TRANSFER_LIMITS,
  FILE_PATH_HANDLE_ERROR,
  validateAttachmentRef,
  type AttachmentRef,
} from '../../shared/transport/file-transfer.js';
import { isFilePreviewPathAllowed } from './file-preview-path-policy.js';
import { MachineControlPlaneError } from './machine-exec-client.js';
import {
  MACHINE_FILE_TRANSFER_TRANSPORT,
  MACHINE_DIRECT_FILE_TRANSFER_LIMITS,
  MACHINE_DIRECT_FILE_TRANSFER_MSG,
  validateMachineDirectFetchResponse,
  validateMachineDirectUploadResponse,
  type MachineFileTransferTransport,
  type MachineDirectUploadRequest,
} from '../../shared/machine-direct-file-transfer.js';
import { startMachineDirectFetchReceiver, startMachineDirectSender } from './machine-direct-transfer.js';

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
  transport: MachineFileTransferTransport;
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
  const clientUploadId = randomBytes(24).toString('base64url');
  // The MCP process does not own the daemon's long-lived ServerLink, so the
  // direct attempt uses a short authenticated HTTP control request while file
  // bytes stay on the routed-LAN TCP socket.
  {
    const requestId = randomBytes(24).toString('base64url');
    const capability = randomBytes(32).toString('base64url');
    const requestBase: Omit<MachineDirectUploadRequest, 'candidates'> = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST,
      requestId,
      clientUploadId,
      capability,
      originalName: basename(source.path),
      size: source.size,
      expiresAt: Date.now() + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
    };
    const sender = await startMachineDirectSender({ sourcePath: source.path, request: requestBase }).catch(() => null);
    if (sender) {
      try {
        const response = await doFetch(
          `${options.serverUrl.replace(/\/+$/, '')}/api/server/${encodeURIComponent(options.targetServerId)}/machine-direct-upload`,
          {
            method: 'POST',
            headers: { ...authHeaders(options.sourceServerId, options.sourceToken), 'content-type': 'application/json' },
            body: JSON.stringify({ ...requestBase, candidates: sender.candidates }),
            signal: boundedTransferSignal(options.signal, FILE_TRANSFER_LIMITS.UPLOAD_TIMEOUT_MS),
          },
        );
        const body = await readBoundedJson(response);
        const parsed = validateMachineDirectUploadResponse(body, validateAttachmentRef);
        if (response.ok
          && parsed.ok
          && parsed.value.type === MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE
          && parsed.value.requestId === requestId) {
          await sender.completion;
          const attachment = parsed.value.attachment;
          return {
            size: attachment.size ?? source.size,
            attachmentId: attachment.id,
            transport: MACHINE_FILE_TRANSFER_TRANSPORT.DIRECT,
            remotePath: attachment.daemonPath,
          };
        }
      } catch {
        // Any direct-control, connect, authentication, or transfer failure falls
        // through to the existing staged Server upload below.
      } finally {
        sender.close();
      }
    }
  }
  if (source.size > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
    throw new MachineControlPlaneError('malformed', 'source file is too large for Server relay fallback');
  }
  const form = new FormData();
  form.append('file', await openAsBlob(source.path), basename(source.path));
  form.append('clientUploadId', clientUploadId);
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
    transport: MACHINE_FILE_TRANSFER_TRANSPORT.RELAY,
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
  const prepared = await prepareDestination(options.destinationPath, options.overwrite === true);

  {
    const requestId = randomBytes(24).toString('base64url');
    const requestBase = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST,
      requestId,
      capability: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
    } as const;
    const receiver = await startMachineDirectFetchReceiver({ tempPath: prepared.temp, request: requestBase }).catch(() => null);
    if (receiver) {
      try {
        const response = await doFetch(`${base}/api/server/${encodeURIComponent(options.targetServerId)}/machine-direct-fetch`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ ...requestBase, sourcePath: options.sourcePath, candidates: receiver.candidates }),
          signal: boundedTransferSignal(options.signal, MACHINE_DIRECT_FILE_TRANSFER_LIMITS.TRANSFER_TIMEOUT_MS),
        });
        const body = await readBoundedJson(response);
        const terminal = validateMachineDirectFetchResponse(body);
        if (response.ok
          && terminal.ok
          && terminal.value.type === MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE
          && terminal.value.requestId === requestId) {
          const start = await receiver.completion;
          if (start.size !== terminal.value.size) throw new MachineControlPlaneError('malformed', 'direct fetch size mismatch');
          await commitDownloadedFile(prepared.temp, prepared.destination, options.overwrite === true);
          return {
            size: start.size,
            attachmentId: requestId,
            transport: MACHINE_FILE_TRANSFER_TRANSPORT.DIRECT,
            destinationPath: prepared.destination,
          };
        }
      } catch {
        // Capability, control, connection, authentication, and pre-commit
        // failures all enter the existing bounded Server download below.
      } finally {
        receiver.close();
      }
      await unlink(prepared.temp).catch(() => {});
    }
  }

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
  if (!handleResponse.ok) {
    const reason = typeof handleBody.error === 'string' ? handleBody.error : `http_${handleResponse.status}`;
    if (reason === FILE_PATH_HANDLE_ERROR.FILE_TOO_LARGE) {
      throw new MachineControlPlaneError('malformed', 'source file is too large for Server relay fallback');
    }
    throw new MachineControlPlaneError('http_status', reason);
  }
  const attachment = parseAttachmentResponse(handleBody);

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
    return {
      size,
      attachmentId: attachment.id,
      transport: MACHINE_FILE_TRANSFER_TRANSPORT.RELAY,
      destinationPath: prepared.destination,
    };
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(prepared.temp).catch(() => {});
    if (error instanceof MachineControlPlaneError) throw error;
    throw new MachineControlPlaneError('transport', 'file download failed');
  }
}
