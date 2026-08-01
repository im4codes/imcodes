import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILE_TRANSFER_LIMITS } from '../../shared/transport/file-transfer.js';
import { MACHINE_DIRECT_FILE_TRANSFER_MSG } from '../../shared/machine-direct-file-transfer.js';
import { fetchFileFromMachine, sendFileToMachine } from '../../src/daemon/machine-file-client.js';

const { startMachineDirectSenderMock } = vi.hoisted(() => ({
  startMachineDirectSenderMock: vi.fn(),
}));

vi.mock('../../src/daemon/machine-direct-transfer.js', () => ({
  startMachineDirectSender: startMachineDirectSenderMock,
}));

const dirs: string[] = [];
afterEach(async () => {
  startMachineDirectSenderMock.mockReset();
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
      expect(init?.headers).toMatchObject({ 'X-Server-Id': 'full-1', authorization: 'Bearer token' });
      return new Response(JSON.stringify({ ok: true, attachment: attachment('a'.repeat(32), '/staging/a.txt') }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(sendFileToMachine({
      serverUrl: 'https://relay.example',
      sourceServerId: 'full-1',
      sourceToken: 'token',
      targetServerId: 'controlled-1',
      sourcePath,
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual({ size: 5, attachmentId: 'a'.repeat(32), remotePath: '/staging/a.txt' });
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
    })).resolves.toMatchObject({ attachmentId: 'd'.repeat(32), remotePath: '/staging/fallback.txt' });
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
    })).resolves.toMatchObject({ attachmentId: 'a'.repeat(32), remotePath: '/staging/mismatch.txt' });
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
    })).resolves.toEqual({ size, attachmentId: 'e'.repeat(32), remotePath: '/uploads/large.bin' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('downloads to a sibling temp file and commits the explicit destination', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fetch-'));
    dirs.push(dir);
    const destinationPath = join(dir, 'downloaded.txt');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, attachment: attachment('b'.repeat(32), 'C:\\Temp\\a.txt') }), { status: 200 }))
      .mockResolvedValueOnce(new Response('hello', { status: 200, headers: { 'content-length': '5' } }));

    await expect(fetchFileFromMachine({
      serverUrl: 'https://relay.example',
      sourceServerId: 'full-1',
      sourceToken: 'token',
      targetServerId: 'controlled-1',
      sourcePath: 'C:\\Temp\\a.txt',
      destinationPath,
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual({ size: 5, attachmentId: 'b'.repeat(32), destinationPath });
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('hello');
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('atomically replaces an existing regular destination only when overwrite is explicit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-overwrite-'));
    dirs.push(dir);
    const destinationPath = join(dir, 'downloaded.txt');
    await writeFile(destinationPath, 'old');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        attachment: attachment('c'.repeat(32), '/tmp/new.txt'),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('new-value', { status: 200, headers: { 'content-length': '9' } }));

    await expect(fetchFileFromMachine({
      serverUrl: 'https://relay.example', sourceServerId: 'full-1', sourceToken: 'token', targetServerId: 'controlled-1',
      sourcePath: '/tmp/new.txt', destinationPath, overwrite: true, fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({ size: 9, destinationPath });
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('new-value');
  });
});
