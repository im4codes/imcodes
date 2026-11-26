import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_BLOB_ACTION,
  CAPABILITY_BLOB_TOKEN_HEADER,
  CAPABILITY_ERROR,
  type CapabilityBlobAccess,
} from '../../shared/capability-management.js';
import {
  CapabilityBlobHttpClient,
  CapabilityBlobHttpError,
} from '../../src/capability/capability-blob-http-client.js';

function accessFor(bytes: Buffer, action: CapabilityBlobAccess['action']): CapabilityBlobAccess {
  return {
    action,
    capabilityId: 'capability-1',
    versionId: 'version-1',
    blobDigest: createHash('sha256').update(bytes).digest('hex'),
    maxBytes: bytes.byteLength,
    expiresAt: Date.now() + 60_000,
    singleUseToken: 'single-use-secret',
  };
}

function credentials() {
  return { serverId: 'server-1', token: 'daemon-bearer', workerUrl: 'https://worker.example' };
}

describe('CapabilityBlobHttpClient', () => {
  it('requests a download grant through the authenticated server access route', async () => {
    const bytes = Buffer.from('grant archive');
    const access = accessFor(bytes, CAPABILITY_BLOB_ACTION.DOWNLOAD);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new CapabilityBlobHttpClient({
      serverId: 'server-1', loadCredentials: async () => credentials(), fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(client.requestAccess('capability-1', 'version-1')).resolves.toEqual(access);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://worker.example/api/capabilities/blobs/version-1/access?serverId=server-1');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ capabilityId: 'capability-1', action: CAPABILITY_BLOB_ACTION.DOWNLOAD }) });
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer daemon-bearer');
    expect(headers.get('x-server-id')).toBe('server-1');
    expect(headers.has(CAPABILITY_BLOB_TOKEN_HEADER)).toBe(false);
  });

  it('uploads exact bytes with daemon identity, server query, and the one-use blob grant', async () => {
    const bytes = Buffer.from('deterministic archive');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ready' }), { status: 200 }));
    const client = new CapabilityBlobHttpClient({
      serverId: 'server-1',
      loadCredentials: async () => credentials(),
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.upload(accessFor(bytes, CAPABILITY_BLOB_ACTION.UPLOAD), bytes);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://worker.example/api/capabilities/blobs/version-1?serverId=server-1');
    expect(init).toMatchObject({ method: 'PUT' });
    expect(Buffer.from(init?.body as Uint8Array)).toEqual(bytes);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer daemon-bearer');
    expect(headers.get('x-server-id')).toBe('server-1');
    expect(headers.get(CAPABILITY_BLOB_TOKEN_HEADER)).toBe('single-use-secret');
    expect(headers.get('content-length')).toBe(String(bytes.byteLength));
  });

  it('downloads only an exact-length, exact-digest response', async () => {
    const bytes = Buffer.from('downloaded archive');
    const client = new CapabilityBlobHttpClient({
      serverId: 'server-1',
      loadCredentials: async () => credentials(),
      fetchImpl: vi.fn(async () => new Response(bytes, {
        status: 200,
        headers: { 'Content-Length': String(bytes.byteLength), 'Content-Type': 'application/octet-stream' },
      })) as typeof fetch,
    });
    await expect(client.download(accessFor(bytes, CAPABILITY_BLOB_ACTION.DOWNLOAD))).resolves.toEqual(bytes);
  });

  it('rejects an oversized declared download before buffering it', async () => {
    const expected = Buffer.from('small');
    const client = new CapabilityBlobHttpClient({
      serverId: 'server-1',
      loadCredentials: async () => credentials(),
      fetchImpl: vi.fn(async () => new Response(Buffer.alloc(128), {
        status: 200,
        headers: { 'Content-Length': '128' },
      })) as typeof fetch,
    });
    await expect(client.download(accessFor(expected, CAPABILITY_BLOB_ACTION.DOWNLOAD))).rejects.toMatchObject({
      code: CAPABILITY_ERROR.INTEGRITY_FAILED,
    });
  });

  it('aborts a stalled request within the configured timeout', async () => {
    const bytes = Buffer.from('archive');
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const client = new CapabilityBlobHttpClient({
      serverId: 'server-1',
      loadCredentials: async () => credentials(),
      fetchImpl: fetchImpl as typeof fetch,
      requestTimeoutMs: 5,
    });
    await expect(client.upload(accessFor(bytes, CAPABILITY_BLOB_ACTION.UPLOAD), bytes)).rejects.toEqual(
      expect.objectContaining<Partial<CapabilityBlobHttpError>>({ code: CAPABILITY_ERROR.RUNTIME_PENDING, retryable: true }),
    );
  });

  it('fails closed when daemon credentials belong to another server', async () => {
    const bytes = Buffer.from('archive');
    const fetchImpl = vi.fn();
    const client = new CapabilityBlobHttpClient({
      serverId: 'server-1',
      loadCredentials: async () => ({ ...credentials(), serverId: 'server-2' }),
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(client.upload(accessFor(bytes, CAPABILITY_BLOB_ACTION.UPLOAD), bytes)).rejects.toMatchObject({
      code: CAPABILITY_ERROR.FORBIDDEN,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
