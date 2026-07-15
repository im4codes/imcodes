import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchFileFromMachine, sendFileToMachine } from '../../src/daemon/machine-file-client.js';

const dirs: string[] = [];
afterEach(async () => {
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
