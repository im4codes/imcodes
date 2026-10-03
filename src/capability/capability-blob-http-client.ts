import { createHash } from 'node:crypto';
import {
  CAPABILITY_BLOB_ACTION,
  CAPABILITY_BLOB_TOKEN_HEADER,
  CAPABILITY_ERROR,
  CAPABILITY_LIMITS,
  capabilityBlobAccessPath,
  capabilityBlobTransferPath,
  type CapabilityBlobAccess,
  type CapabilityErrorCode,
} from '../../shared/capability-management.js';
import type { ServerCapabilityCredentials } from './server-capability-service.js';

const DEFAULT_BLOB_REQUEST_TIMEOUT_MS = 20_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface CapabilityBlobHttpClientOptions {
  serverId: string;
  fetchImpl?: typeof fetch;
  loadCredentials?: () => Promise<ServerCapabilityCredentials | null>;
  requestTimeoutMs?: number;
}

export class CapabilityBlobHttpError extends Error {
  constructor(
    public readonly code: CapabilityErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'CapabilityBlobHttpError';
  }
}

async function defaultLoadCredentials(): Promise<ServerCapabilityCredentials | null> {
  const module = await import('../bind/bind-flow.js');
  return module.loadCredentials();
}

function validateAccess(access: CapabilityBlobAccess, expectedAction: CapabilityBlobAccess['action']): void {
  if (access.action !== expectedAction
    || !access.capabilityId || access.capabilityId.length > 256
    || !access.versionId || access.versionId.length > 256
    || !SHA256_PATTERN.test(access.blobDigest)
    || !Number.isSafeInteger(access.maxBytes)
    || access.maxBytes < 0
    || access.maxBytes > CAPABILITY_LIMITS.PACKAGE_BYTES
    || !Number.isSafeInteger(access.expiresAt)
    || access.expiresAt <= Date.now()
    || !access.singleUseToken
    || access.singleUseToken.length > CAPABILITY_LIMITS.SOURCE_CHARS) {
    throw new CapabilityBlobHttpError(CAPABILITY_ERROR.INVALID_INPUT, 'Capability blob grant is invalid or expired');
  }
}

function verifyExactBytes(access: CapabilityBlobAccess, bytes: Buffer): void {
  if (bytes.byteLength !== access.maxBytes) {
    throw new CapabilityBlobHttpError(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Capability blob byte length does not match its grant');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== access.blobDigest) {
    throw new CapabilityBlobHttpError(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Capability blob digest does not match its grant');
  }
}

function errorForStatus(status: number): CapabilityBlobHttpError {
  if (status === 401 || status === 403) {
    return new CapabilityBlobHttpError(CAPABILITY_ERROR.FORBIDDEN, 'Capability blob grant was rejected');
  }
  if (status === 404) {
    return new CapabilityBlobHttpError(CAPABILITY_ERROR.NOT_FOUND, 'Capability blob is unavailable');
  }
  if (status === 409 || status === 422) {
    return new CapabilityBlobHttpError(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Capability blob transfer failed integrity validation');
  }
  return new CapabilityBlobHttpError(
    CAPABILITY_ERROR.RUNTIME_PENDING,
    'Capability blob server is unavailable',
    status === 429 || status >= 500,
  );
}

async function readExactBody(response: Response, access: CapabilityBlobAccess): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared === null || !/^\d+$/.test(declared) || Number(declared) !== access.maxBytes) {
    throw new CapabilityBlobHttpError(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Capability blob response length is missing or incorrect');
  }
  if (!response.body) {
    if (access.maxBytes === 0) return Buffer.alloc(0);
    throw new CapabilityBlobHttpError(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Capability blob response body is missing');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > access.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CapabilityBlobHttpError(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Capability blob response exceeded its grant');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const content = Buffer.concat(chunks, total);
  verifyExactBytes(access, content);
  return content;
}

export class CapabilityBlobHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly loadCredentials: () => Promise<ServerCapabilityCredentials | null>;

  constructor(private readonly options: CapabilityBlobHttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.loadCredentials = options.loadCredentials ?? defaultLoadCredentials;
  }

  async upload(access: CapabilityBlobAccess, bytes: Buffer): Promise<void> {
    validateAccess(access, CAPABILITY_BLOB_ACTION.UPLOAD);
    verifyExactBytes(access, bytes);
    await this.request(access, {
      method: 'PUT',
      body: Uint8Array.from(bytes),
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
      },
    }, async (response) => {
      if (!response.ok) throw errorForStatus(response.status);
    });
  }

  async requestAccess(
    capabilityId: string,
    versionId: string,
    action: typeof CAPABILITY_BLOB_ACTION.DOWNLOAD = CAPABILITY_BLOB_ACTION.DOWNLOAD,
  ): Promise<CapabilityBlobAccess> {
    if (!capabilityId || capabilityId.length > 256 || !versionId || versionId.length > 256) {
      throw new CapabilityBlobHttpError(CAPABILITY_ERROR.INVALID_INPUT, 'Capability blob identity is invalid');
    }
    let credentials: ServerCapabilityCredentials | null;
    try {
      credentials = await this.loadCredentials();
    } catch {
      throw new CapabilityBlobHttpError(CAPABILITY_ERROR.RUNTIME_PENDING, 'Daemon credentials are unavailable', true);
    }
    if (!credentials || credentials.serverId !== this.options.serverId) {
      throw new CapabilityBlobHttpError(CAPABILITY_ERROR.FORBIDDEN, 'Capability blob caller identity does not match daemon credentials');
    }
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.min(this.options.requestTimeoutMs ?? DEFAULT_BLOB_REQUEST_TIMEOUT_MS, 60_000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const query = new URLSearchParams({ serverId: credentials.serverId });
    const url = `${credentials.workerUrl.replace(/\/$/, '')}${capabilityBlobAccessPath(versionId)}?${query}`;
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'X-Server-Id': credentials.serverId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ capabilityId, action }),
      });
      if (!response.ok) throw errorForStatus(response.status);
      const body = await response.json().catch(() => null) as { access?: CapabilityBlobAccess } | null;
      if (!body?.access) throw new CapabilityBlobHttpError(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Capability blob grant response is invalid');
      validateAccess(body.access, action);
      if (body.access.capabilityId !== capabilityId || body.access.versionId !== versionId) {
        throw new CapabilityBlobHttpError(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Capability blob grant identity does not match the request');
      }
      return body.access;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new CapabilityBlobHttpError(CAPABILITY_ERROR.RUNTIME_PENDING, 'Capability blob access request timed out', true);
      }
      if (error instanceof CapabilityBlobHttpError) throw error;
      throw new CapabilityBlobHttpError(CAPABILITY_ERROR.RUNTIME_PENDING, 'Capability blob server is unavailable', true);
    } finally {
      clearTimeout(timer);
    }
  }

  async download(access: CapabilityBlobAccess): Promise<Buffer> {
    validateAccess(access, CAPABILITY_BLOB_ACTION.DOWNLOAD);
    return this.request(access, { method: 'GET' }, async (response) => {
      if (!response.ok) throw errorForStatus(response.status);
      return readExactBody(response, access);
    });
  }

  private async request<T>(
    access: CapabilityBlobAccess,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    let credentials: ServerCapabilityCredentials | null;
    try {
      credentials = await this.loadCredentials();
    } catch {
      throw new CapabilityBlobHttpError(CAPABILITY_ERROR.RUNTIME_PENDING, 'Daemon credentials are unavailable', true);
    }
    if (!credentials || credentials.serverId !== this.options.serverId) {
      throw new CapabilityBlobHttpError(CAPABILITY_ERROR.FORBIDDEN, 'Capability blob caller identity does not match daemon credentials');
    }
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.min(this.options.requestTimeoutMs ?? DEFAULT_BLOB_REQUEST_TIMEOUT_MS, 60_000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const query = new URLSearchParams({ serverId: credentials.serverId });
    const url = `${credentials.workerUrl.replace(/\/$/, '')}${capabilityBlobTransferPath(access.versionId)}?${query}`;
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'X-Server-Id': credentials.serverId,
          [CAPABILITY_BLOB_TOKEN_HEADER]: access.singleUseToken,
          ...init.headers,
        },
      });
      return await consume(response);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new CapabilityBlobHttpError(CAPABILITY_ERROR.RUNTIME_PENDING, 'Capability blob request timed out', true);
      }
      if (error instanceof CapabilityBlobHttpError) throw error;
      throw new CapabilityBlobHttpError(CAPABILITY_ERROR.RUNTIME_PENDING, 'Capability blob server is unavailable', true);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createCapabilityBlobHttpClient(options: CapabilityBlobHttpClientOptions): CapabilityBlobHttpClient {
  return new CapabilityBlobHttpClient(options);
}

export const CAPABILITY_BLOB_HTTP_CLIENT_TESTING = {
  readExactBody,
  validateAccess,
  verifyExactBytes,
};
