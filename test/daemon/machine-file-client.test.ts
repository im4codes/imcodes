import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_TRANSFER_LIMITS, FILE_TRANSFER_RESUMABLE_UPLOAD } from '../../shared/transport/file-transfer.js';
import { MACHINE_DIRECT_FILE_TRANSFER_MSG } from '../../shared/machine-direct-file-transfer.js';
import { fetchFileFromMachine, sendFileToMachine } from '../../src/daemon/machine-file-client.js';

const { startMachineDirectSenderMock, startMachineDirectFetchReceiverMock } = vi.hoisted(() => ({
  startMachineDirectSenderMock: vi.fn(),
  startMachineDirectFetchReceiverMock: vi.fn(),
}));

vi.mock('../../src/daemon/machine-direct-transfer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/daemon/machine-direct-transfer.js')>()),
  startMachineDirectSender: startMachineDirectSenderMock,
  startMachineDirectFetchReceiver: startMachineDirectFetchReceiverMock,
}));

const dirs: string[] = [];
beforeEach(() => {
  startMachineDirectFetchReceiverMock.mockResolvedValue(null);
});
afterEach(async () => {
  startMachineDirectSenderMock.mockReset();
  startMachineDirectFetchReceiverMock.mockReset();
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function attachment(id: string, daemonPath: string) {
  return {
    id,
    source: 'local',
    serverId: 'controlled-1',
    daemonPath,
    size: 5,
    createdAt: new Date().toISOString(),
    downloadable: true,
  };
}

function sourceIdentity(version = 1, size = 5) {
  return { size, mtimeMs: version, device: 7, inode: version };
}

describe('machine file client', () => {
  it('uploads a regular file through the existing multipart route', async () => {
    startMachineDirectSenderMock.mockResolvedValueOnce(null);
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-send-'));
    dirs.push(dir);
    const sourcePath = join(dir, 'a.txt');
    await writeFile(sourcePath, 'hello');
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(FormData);
      expect(init?.headers).toMatchObject({
        'X-Server-Id': 'full-1',
        authorization: 'Bearer token',
        'x-imcodes-shared-machine-authority': 'signed-turn',
      });
      return new Response(JSON.stringify({ ok: true, attachment: attachment('a'.repeat(32), '/staging/a.txt') }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(sendFileToMachine({
      serverUrl: 'https://relay.example',
      sourceServerId: 'full-1',
      sourceToken: 'token',
      sharedMachineAuthority: 'signed-turn',
      targetServerId: 'controlled-1',
      sourcePath,
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual({ size: 5, attachmentId: 'a'.repeat(32), transport: 'relay', remotePath: '/staging/a.txt' });
  });

  it('uploads machine relay bytes in receiver-acknowledged chunks', async () => {
    startMachineDirectSenderMock.mockResolvedValueOnce(null);
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-send-resume-'));
    dirs.push(dir);
    const sourcePath = join(dir, 'large.bin');
    const size = FILE_TRANSFER_RESUMABLE_UPLOAD.CHUNK_BYTES + 2;
    await writeFile(sourcePath, '');
    await truncate(sourcePath, size);
    const offsets: number[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      offsets.push(Number(form.get('uploadOffset')));
      if (offsets.length === 1) {
        return new Response(JSON.stringify({
          ok: true,
          complete: false,
          committedBytes: FILE_TRANSFER_RESUMABLE_UPLOAD.CHUNK_BYTES,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true,
        attachment: { ...attachment('a'.repeat(32), '/staging/large.bin'), size },
      }), { status: 200 });
    });

    await expect(sendFileToMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token',
      targetServerId: 'controlled-1', sourcePath, fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({ size, transport: 'relay' });
    expect(offsets).toEqual([0, FILE_TRANSFER_RESUMABLE_UPLOAD.CHUNK_BYTES]);
  });

  it('rejects a source symlink before network dispatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-symlink-'));
    dirs.push(dir);
    const target = join(dir, 'target.txt');
    const sourcePath = join(dir, 'link.txt');
    await writeFile(target, 'hello');
    await symlink(target, sourcePath);
    const fetchImpl = vi.fn();
    await expect(sendFileToMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1', sourcePath,
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toMatchObject({ kind: 'malformed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('automatically falls back to staged multipart upload when direct control rejects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fallback-'));
    dirs.push(dir);
    const sourcePath = join(dir, 'fallback.txt');
    await writeFile(sourcePath, 'hello');
    const close = vi.fn();
    startMachineDirectSenderMock.mockResolvedValueOnce({
      candidates: [{ host: '192.168.2.145', port: 45123 }],
      completion: Promise.resolve(),
      close,
    });
    let directClientUploadId = '';
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/machine-direct-upload')) {
        expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).not.toHaveProperty('content');
        expect(body.candidates).toEqual(expect.any(Array));
        directClientUploadId = String(body.clientUploadId);
        return new Response(JSON.stringify({ error: 'capability_unavailable' }), { status: 409 });
      }
      expect(pathname).toBe('/api/server/controlled-1/upload');
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get('clientUploadId')).toBe(directClientUploadId);
      return new Response(JSON.stringify({ ok: true, attachment: attachment('d'.repeat(32), '/staging/fallback.txt') }), { status: 200 });
    });

    await expect(sendFileToMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1', sourcePath,
      fetchImpl: fetchMock as typeof fetch,
    })).resolves.toMatchObject({ attachmentId: 'd'.repeat(32), transport: 'relay', remotePath: '/staging/fallback.txt' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it('falls back when a direct success response is correlated to another request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-mismatched-direct-'));
    dirs.push(dir);
    const sourcePath = join(dir, 'mismatch.txt');
    await writeFile(sourcePath, 'hello');
    const close = vi.fn();
    startMachineDirectSenderMock.mockResolvedValueOnce({
      candidates: [{ host: '192.168.2.145', port: 45123 }],
      completion: Promise.resolve(),
      close,
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/machine-direct-upload')) {
        return new Response(JSON.stringify({
          type: MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE,
          requestId: 'x'.repeat(32),
          attachment: attachment('f'.repeat(32), '/uploads/wrong.txt'),
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true,
        attachment: attachment('a'.repeat(32), '/staging/mismatch.txt'),
      }), { status: 200 });
    });

    await expect(sendFileToMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1', sourcePath,
      fetchImpl: fetchMock as typeof fetch,
    })).resolves.toMatchObject({ attachmentId: 'a'.repeat(32), transport: 'relay', remotePath: '/staging/mismatch.txt' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns direct success without multipart, including above the relay ceiling', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-direct-client-'));
    dirs.push(dir);
    const sourcePath = join(dir, 'large.bin');
    const size = FILE_TRANSFER_LIMITS.MAX_FILE_SIZE + 1;
    await writeFile(sourcePath, '');
    await truncate(sourcePath, size);
    const close = vi.fn();
    startMachineDirectSenderMock.mockResolvedValueOnce({
      candidates: [{ host: '172.16.253.211', port: 45124 }],
      completion: Promise.resolve(),
      close,
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(url)).pathname).toBe('/api/server/controlled-1/machine-direct-upload');
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request.size).toBe(size);
      return new Response(JSON.stringify({
        type: MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE,
        requestId: request.requestId,
        attachment: {
          id: 'e'.repeat(32), source: 'upload', serverId: 'controlled-1', daemonPath: '/uploads/large.bin',
          originalName: 'large.bin', size, createdAt: new Date().toISOString(), downloadable: true,
        },
      }), { status: 200 });
    });

    await expect(sendFileToMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1', sourcePath,
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual({ size, attachmentId: 'e'.repeat(32), transport: 'direct', remotePath: '/uploads/large.bin' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('downloads to a sibling temp file and commits the explicit destination', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fetch-'));
    dirs.push(dir);
    const destinationPath = join(dir, 'downloaded.txt');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        attachment: attachment('b'.repeat(32), 'C:\\Temp\\a.txt'),
        sourceIdentity: sourceIdentity(),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('hello', { status: 200, headers: { 'content-length': '5' } }));

    await expect(fetchFileFromMachine({
      serverUrl: 'https://relay.example',
      sourceServerId: 'full-1',
      sourceToken: 'token',
      targetServerId: 'controlled-1',
      sourcePath: 'C:\\Temp\\a.txt',
      destinationPath,
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual({ size: 5, attachmentId: 'b'.repeat(32), transport: 'relay', destinationPath });
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('hello');
  });

  it('falls back to the existing Server download when reverse-direct control rejects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fetch-fallback-'));
    dirs.push(dir);
    const destinationPath = join(dir, 'fallback.txt');
    const close = vi.fn();
    startMachineDirectFetchReceiverMock.mockResolvedValueOnce({
      candidates: [{ host: '172.16.253.211', port: 45125 }],
      completion: new Promise(() => {}),
      close,
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/machine-direct-fetch')) {
        return new Response(JSON.stringify({ error: 'connect_failed' }), { status: 409 });
      }
      if (pathname.endsWith('/machine-file-handle')) {
        return new Response(JSON.stringify({
          ok: true,
          attachment: attachment('b'.repeat(32), '/tmp/source.txt'),
          sourceIdentity: sourceIdentity(),
        }), { status: 200 });
      }
      expect(pathname).toContain('/uploads/');
      return new Response('hello', { status: 200, headers: { 'content-length': '5' } });
    });
    await expect(fetchFileFromMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1',
      sourcePath: '/tmp/source.txt', destinationPath, fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual({ size: 5, attachmentId: 'b'.repeat(32), transport: 'relay', destinationPath });
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('hello');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledOnce();
  });

  it('continues HTTP fallback from the prefix committed by reverse direct', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fetch-resume-fallback-'));
    dirs.push(dir);
    const destinationPath = join(dir, 'fallback.txt');
    startMachineDirectFetchReceiverMock.mockImplementationOnce(async (options: { tempPath: string }) => {
      await writeFile(options.tempPath, 'he');
      const { bindMachineFetchResumeIdentity } = await import('../../src/daemon/machine-direct-transfer.js');
      await bindMachineFetchResumeIdentity(options.tempPath, sourceIdentity());
      return {
        candidates: [{ host: '172.16.253.211', port: 45125 }],
        completion: new Promise(() => {}),
        close: vi.fn(),
      };
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/machine-direct-fetch')) {
        return new Response(JSON.stringify({ error: 'connect_failed' }), { status: 409 });
      }
      if (pathname.endsWith('/machine-file-handle')) {
        return new Response(JSON.stringify({
          ok: true,
          attachment: attachment('b'.repeat(32), '/tmp/source.txt'),
          sourceIdentity: sourceIdentity(),
        }), { status: 200 });
      }
      expect(new Headers(init?.headers).get('range')).toBe('bytes=2-');
      return new Response('llo', {
        status: 206,
        headers: { 'content-length': '3', 'content-range': 'bytes 2-4/5' },
      });
    });
    await expect(fetchFileFromMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1',
      sourcePath: '/tmp/source.txt', destinationPath, fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({ size: 5, transport: 'relay', destinationPath });
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('hello');
  });

  it('discards a relay partial when the remote source identity changes between attempts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fetch-source-replaced-'));
    dirs.push(dir);
    const destinationPath = join(dir, 'downloaded.txt');
    let sourceVersion = 1;
    let downloadAttempt = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/machine-file-handle')) {
        return new Response(JSON.stringify({
          ok: true,
          attachment: attachment((sourceVersion === 1 ? 'b' : 'c').repeat(32), '/tmp/source.txt'),
          sourceIdentity: sourceIdentity(sourceVersion),
        }), { status: 200 });
      }
      downloadAttempt += 1;
      if (downloadAttempt === 1) {
        let sentPrefix = false;
        const interrupted = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!sentPrefix) {
              sentPrefix = true;
              controller.enqueue(new TextEncoder().encode('AA'));
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
            controller.error(new Error('connection_lost'));
          },
        });
        return new Response(interrupted, { status: 200, headers: { 'content-length': '5' } });
      }
      const range = new Headers(init?.headers).get('range');
      if (range === 'bytes=2-') {
        return new Response('llo', {
          status: 206,
          headers: { 'content-length': '3', 'content-range': 'bytes 2-4/5' },
        });
      }
      expect(range, 'a replacement source must never reuse the old prefix').toBeNull();
      return new Response('hello', { status: 200, headers: { 'content-length': '5' } });
    });

    await expect(fetchFileFromMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1',
      sourcePath: '/tmp/source.txt', destinationPath, fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toMatchObject({ kind: 'transport' });
    await expect(readFile(join(dir, '.downloaded.txt.imcodes-resume.part'), 'utf8')).resolves.toBe('AA');
    sourceVersion = 2;

    await expect(fetchFileFromMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1',
      sourcePath: '/tmp/source.txt', destinationPath, fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({ size: 5, transport: 'relay', destinationPath });
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('hello');
  });

  it('restarts an unauthenticated full-size temp instead of committing stale equal-length bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fetch-stale-full-'));
    dirs.push(dir);
    const destinationPath = join(dir, 'downloaded.txt');
    await writeFile(join(dir, '.downloaded.txt.imcodes-resume.part'), 'stale');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        attachment: attachment('b'.repeat(32), '/tmp/source.txt'),
        sourceIdentity: sourceIdentity(),
      }), { status: 200 }))
      .mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).has('range')).toBe(false);
        return new Response('fresh', { status: 200, headers: { 'content-length': '5' } });
      });

    await expect(fetchFileFromMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1',
      sourcePath: '/tmp/source.txt', destinationPath, fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({ size: 5, transport: 'relay', destinationPath });
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('fresh');
  });

  it('reports a direct-required error when reverse direct fails above the relay ceiling', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fetch-too-large-'));
    dirs.push(dir);
    const destinationPath = join(dir, 'too-large.bin');
    startMachineDirectFetchReceiverMock.mockResolvedValueOnce({
      candidates: [{ host: '172.16.253.211', port: 45125 }],
      completion: new Promise(() => {}),
      close: vi.fn(),
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname;
      return pathname.endsWith('/machine-direct-fetch')
        ? new Response(JSON.stringify({ error: 'connect_failed' }), { status: 409 })
        : new Response(JSON.stringify({ error: 'file_too_large' }), { status: 400 });
    });
    await expect(fetchFileFromMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1',
      sourcePath: '/tmp/too-large.bin', destinationPath, fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toMatchObject({ kind: 'malformed', message: 'source file is too large for Server relay fallback' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(readFile(destinationPath)).rejects.toThrow();
  });

  it('fetches directly through the shared encrypted path without invoking relay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fetch-direct-client-'));
    dirs.push(dir);
    const destinationPath = join(dir, 'direct.bin');
    const close = vi.fn();
    startMachineDirectFetchReceiverMock.mockImplementationOnce(async (options: { tempPath: string }) => {
      await writeFile(options.tempPath, 'hello');
      return {
        candidates: [{ host: '172.16.253.211', port: 45125 }],
        completion: Promise.resolve({ size: 5, originalName: 'source.bin' }),
        close,
      };
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(url)).pathname).toBe('/api/server/controlled-1/machine-direct-fetch');
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toMatchObject({ sourcePath: '/tmp/source.bin', candidates: expect.any(Array) });
      return new Response(JSON.stringify({
        type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE,
        requestId: request.requestId,
        size: 5,
      }), { status: 200 });
    });

    await expect(fetchFileFromMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1',
      sourcePath: '/tmp/source.bin', destinationPath, fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({ size: 5, transport: 'direct', destinationPath, attachmentId: expect.any(String) });
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('hello');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('accepts a reverse-direct file above the relay ceiling', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fetch-direct-large-'));
    dirs.push(dir);
    const destinationPath = join(dir, 'large.bin');
    const size = FILE_TRANSFER_LIMITS.MAX_FILE_SIZE + 1;
    startMachineDirectFetchReceiverMock.mockImplementationOnce(async (options: { tempPath: string }) => {
      await writeFile(options.tempPath, '');
      await truncate(options.tempPath, size);
      return {
        candidates: [{ host: '172.16.253.211', port: 45125 }],
        completion: Promise.resolve({ size, originalName: 'large.bin' }),
        close: vi.fn(),
      };
    });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE, requestId: request.requestId, size }), { status: 200 });
    });
    await expect(fetchFileFromMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1',
      sourcePath: '/tmp/large.bin', destinationPath, fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({ size, transport: 'direct', destinationPath });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not overwrite an existing destination by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-no-overwrite-'));
    dirs.push(dir);
    const destinationPath = join(dir, 'downloaded.txt');
    await writeFile(destinationPath, 'keep');
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      attachment: attachment('b'.repeat(32), '/tmp/a.txt'),
    }), { status: 200 }));

    await expect(fetchFileFromMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1',
      sourcePath: '/tmp/a.txt', destinationPath, fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toMatchObject({ kind: 'malformed', message: 'destination already exists' });
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('keep');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('atomically replaces an existing regular destination only when overwrite is explicit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-overwrite-'));
    dirs.push(dir);
    const destinationPath = join(dir, 'downloaded.txt');
    await writeFile(destinationPath, 'old');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      attachment: { ...attachment('c'.repeat(32), '/tmp/new.txt'), size: 9 },
      sourceIdentity: sourceIdentity(1, 9),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('new-value', { status: 200, headers: { 'content-length': '9' } }));

    await expect(fetchFileFromMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1',
      sourcePath: '/tmp/new.txt', destinationPath, overwrite: true, fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({ size: 9, destinationPath });
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('new-value');
  });
});
