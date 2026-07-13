import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, open, readdir, rm, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEnrollRedeemV2Request,
  allowedEnrollmentServerOrigin,
  copyCleanExecutable,
  createEnrollmentStagingFs,
  encodeEnrollmentBlob,
  generateInstallIdentity,
  hashNodeToken,
  loadInstallIdentity,
  openVerifiedEnrollmentSource,
  parseEnrollmentBlob,
  persistInstallIdentity,
  readExactly,
  redeemEnrollmentV2,
  writeExactly,
} from '../../src/node/enrollment.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

function redeemResponse(
  value: unknown,
  options: { url?: string; redirected?: boolean; ok?: boolean; status?: number } = {},
): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    url: options.url ?? 'https://im.example/api/enroll/v2/redeem',
    redirected: options.redirected ?? false,
    json: async () => value,
  } as Response;
}

afterEach(() => vi.unstubAllEnvs());

describe('controlled node enrollment v2', () => {
  it('round-trips an enrollment blob appended to arbitrary executable bytes', () => {
    const encoded = encodeEnrollmentBlob({ serverUrl: 'https://im.example/', enrollToken: 'once-123' });
    expect(parseEnrollmentBlob(Buffer.concat([Buffer.from('binary-prefix'), encoded]))).toEqual({
      serverUrl: 'https://im.example',
      enrollToken: 'once-123',
    });
  });

  it('buildEnrollRedeemV2Request includes required D-A fields', () => {
    const blob = { serverUrl: 'https://im.example', enrollToken: 'tok' };
    const identity = generateInstallIdentity();
    const req = buildEnrollRedeemV2Request(blob, identity, { platform: 'darwin', arch: 'arm64', hostname: 'box' });
    expect(req.version).toBe(2);
    expect(req.installId).toBe(identity.installId);
    expect(req.nodeTokenHash).toBe(hashNodeToken(identity.nodeToken));
    expect(req.os).toBe('mac');
    expect(req.arch).toBe('arm64');
  });

  it.each([
    ['win32', 'win'],
    ['darwin', 'mac'],
    ['linux', 'linux'],
  ] as const)('uses canonical v2 OS value for Node platform %s', (platform, expected) => {
    const req = buildEnrollRedeemV2Request(
      { serverUrl: 'https://im.example', enrollToken: 'tok' },
      generateInstallIdentity(),
      { platform, arch: 'x64', hostname: 'box' },
    );
    expect(req.os).toBe(expected);
  });

  it('redeemEnrollmentV2 rejects a response that returns a raw token', async () => {
    const blob = { serverUrl: 'https://im.example', enrollToken: 'tok' };
    const identity = generateInstallIdentity();
    const fetchFn = vi.fn(async () => redeemResponse({ serverId: 's1', nodeRole: NODE_ROLE.CONTROLLED, token: 'server-minted' })) as unknown as typeof fetch;
    await expect(redeemEnrollmentV2(blob, identity, fetchFn)).rejects.toThrow(/raw_token/);
  });

  it('redeemEnrollmentV2 builds credential from local nodeToken when response has no token', async () => {
    const blob = { serverUrl: 'https://im.example', enrollToken: 'tok' };
    const identity = generateInstallIdentity();
    const fetchFn = vi.fn(async () => redeemResponse({ serverId: 's1', nodeRole: NODE_ROLE.CONTROLLED, refName: 'box-1234' })) as unknown as typeof fetch;
    const cred = await redeemEnrollmentV2(blob, identity, fetchFn);
    expect(cred.token).toBe(identity.nodeToken);
    expect(cred.serverId).toBe('s1');
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://im.example/api/enroll/v2/redeem');
    const body = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1]?.body));
    expect(body.installId).toBe(identity.installId);
    expect(body.nodeTokenHash).toBe(identity.nodeTokenHash);
    expect(body.version).toBe(2);
    expect((fetchFn.mock.calls[0] as [string, RequestInit])[1].redirect).toBe('error');
  });

  it('permits HTTP only for explicitly enabled local development origins', () => {
    expect(() => allowedEnrollmentServerOrigin('http://localhost:8787')).toThrow(/must_be_https/);
    vi.stubEnv('IMCODES_NODE_ALLOW_HTTP_ENROLL', '1');
    expect(allowedEnrollmentServerOrigin('http://localhost:8787')).toBe('http://localhost:8787');
    expect(allowedEnrollmentServerOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(() => allowedEnrollmentServerOrigin('http://relay.example')).toThrow(/must_be_https/);
    expect(() => allowedEnrollmentServerOrigin('https://relay.example/path')).toThrow(/must_be_origin/);
  });

  it('rejects a cross-origin or silently redirected redeem response', async () => {
    const blob = { serverUrl: 'https://im.example', enrollToken: 'tok' };
    const identity = generateInstallIdentity();
    const crossOrigin = vi.fn(async () => redeemResponse(
      { serverId: 's1', nodeRole: NODE_ROLE.CONTROLLED },
      { url: 'https://evil.example/api/enroll/v2/redeem' },
    )) as unknown as typeof fetch;
    await expect(redeemEnrollmentV2(blob, identity, crossOrigin)).rejects.toThrow(/origin_mismatch/);

    const redirected = vi.fn(async () => redeemResponse(
      { serverId: 's1', nodeRole: NODE_ROLE.CONTROLLED },
      { redirected: true },
    )) as unknown as typeof fetch;
    await expect(redeemEnrollmentV2(blob, identity, redirected)).rejects.toThrow(/redirect_rejected/);
  });

  it('rejects an unverifiable response URL instead of accepting a custom fetch silently', async () => {
    const fetchFn = vi.fn(async () => redeemResponse(
      { serverId: 's1', nodeRole: NODE_ROLE.CONTROLLED },
      { url: '' },
    )) as unknown as typeof fetch;
    await expect(redeemEnrollmentV2(
      { serverUrl: 'https://im.example', enrollToken: 'tok' },
      generateInstallIdentity(),
      fetchFn,
    )).rejects.toThrow(/response_url_invalid/);
  });

  it('durably persists and reloads the same install identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-identity-'));
    try {
      const path = join(dir, 'protected', 'install-identity.json');
      const identity = { ...generateInstallIdentity(), sourceExePath: '/tmp/imcodes-node' };
      await persistInstallIdentity(identity, path);
      await expect(loadInstallIdentity(path)).resolves.toEqual(identity);
      if (process.platform !== 'win32') {
        expect((await stat(path)).mode & 0o077).toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when an existing install identity is corrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-identity-corrupt-'));
    try {
      const path = join(dir, 'install-identity.json');
      await writeFile(path, '{bad json', { mode: 0o600 });
      await expect(loadInstallIdentity(path)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('copyCleanExecutable', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'imcodes-stage-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('copies only the trailer-free prefix bytes', async () => {
    const blob = encodeEnrollmentBlob({ serverUrl: 'https://im.example', enrollToken: 'once' });
    const source = join(dir, 'source.bin');
    const dest = join(dir, 'dest.bin');
    const prefix = Buffer.alloc(128, 0x42);
    await writeFile(source, Buffer.concat([prefix, blob]));
    const receipt = await copyCleanExecutable(source, prefix.length, dest);
    const staged = await readFile(dest);
    expect(staged.equals(prefix)).toBe(true);
    expect(staged.length).toBe(128);
    expect(receipt).toMatchObject({
      path: dest,
      size: 128,
    });
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    if (process.platform !== 'win32') {
      expect(((await stat(dest)).mode & 0o777) & 0o002).toBe(0);
    }
  });

  it('rejects symlink and non-regular enrollment sources before opening them', async () => {
    const directorySource = join(dir, 'directory-source');
    await (await import('node:fs/promises')).mkdir(directorySource);
    await expect(openVerifiedEnrollmentSource(directorySource)).rejects.toThrow(/not_regular/);

    if (process.platform !== 'win32') {
      const realSource = join(dir, 'real-source.bin');
      const linkedSource = join(dir, 'linked-source.bin');
      await writeFile(realSource, Buffer.from('source'));
      await symlink(realSource, linkedSource);
      await expect(openVerifiedEnrollmentSource(linkedSource)).rejects.toThrow(/is_symlink/);
    }
  });

  it('removes private staging temps after write, sync, chmod, or rename failure', async () => {
    const blob = encodeEnrollmentBlob({ serverUrl: 'https://im.example', enrollToken: 'once' });
    const prefix = Buffer.alloc(64, 0x52);
    const sourcePath = join(dir, 'failure-source.bin');
    await writeFile(sourcePath, Buffer.concat([prefix, blob]));
    const base = createEnrollmentStagingFs();
    const cases: Array<{ name: string; stagingFs: ReturnType<typeof createEnrollmentStagingFs> }> = [
      {
        name: 'write',
        stagingFs: createEnrollmentStagingFs({
          openDestination: async (path, flags, mode) => {
            const handle = await open(path, flags, mode);
            return {
              write: vi.fn(async () => { throw new Error('injected staging write failure'); }),
              sync: handle.sync.bind(handle),
              close: handle.close.bind(handle),
            };
          },
        }),
      },
      {
        name: 'sync',
        stagingFs: createEnrollmentStagingFs({
          openDestination: async (path, flags, mode) => {
            const handle = await open(path, flags, mode);
            return {
              write: handle.write.bind(handle),
              sync: vi.fn(async () => { throw new Error('injected staging sync failure'); }),
              close: handle.close.bind(handle),
            };
          },
        }),
      },
      ...(process.platform === 'win32' ? [] : [{
        name: 'chmod',
        stagingFs: createEnrollmentStagingFs({
          chmod: async (path, mode) => {
            if (path.endsWith('.tmp')) throw new Error('injected staging chmod failure');
            await base.chmod(path, mode);
          },
        }),
      }]),
      {
        name: 'rename',
        stagingFs: createEnrollmentStagingFs({
          rename: async () => { throw new Error('injected staging rename failure'); },
        }),
      },
    ];

    for (const failure of cases) {
      const destPath = join(dir, `dest-${failure.name}.bin`);
      const source = await openVerifiedEnrollmentSource(sourcePath, failure.stagingFs);
      try {
        await expect(source.stageTrailerFreeExecutable(destPath, prefix.length)).rejects.toThrow(/injected staging/);
      } finally {
        await source.close();
      }
      await expect(stat(destPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(dir)).filter((entry) => entry.startsWith(`dest-${failure.name}.bin.`))).toEqual([]);
    }
  });

  it('leaves only complete bytes on parent-fsync failure and succeeds on retry', async () => {
    const blob = encodeEnrollmentBlob({ serverUrl: 'https://im.example', enrollToken: 'once' });
    const prefix = Buffer.alloc(64, 0x61);
    const sourcePath = join(dir, 'parent-fsync-source.bin');
    const destPath = join(dir, 'parent-fsync-dest.bin');
    await writeFile(sourcePath, Buffer.concat([prefix, blob]));
    const base = createEnrollmentStagingFs();
    let failOnce = true;
    const source = await openVerifiedEnrollmentSource(sourcePath, createEnrollmentStagingFs({
      fsyncParentDirectory: async (path) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('injected parent fsync failure');
        }
        await base.fsyncParentDirectory(path);
      },
    }));
    try {
      await expect(source.stageTrailerFreeExecutable(destPath, prefix.length)).rejects.toThrow(/parent fsync/);
      await expect(readFile(destPath)).resolves.toEqual(prefix);
      expect((await readdir(dir)).filter((entry) => entry.startsWith('parent-fsync-dest.bin.'))).toEqual([]);
      const receipt = await source.stageTrailerFreeExecutable(destPath, prefix.length);
      expect(receipt).toMatchObject({ path: destPath, size: prefix.length });
      await expect(readFile(destPath)).resolves.toEqual(prefix);
    } finally {
      await source.close();
    }
  });

  it('readExactly loops across partial reads and fails on early EOF', async () => {
    const chunks = [Buffer.from('ab'), Buffer.from('cd'), Buffer.from('e')];
    const handle = {
      read: vi.fn(async (buffer: Buffer, offset: number) => {
        const chunk = chunks.shift();
        if (!chunk) return { bytesRead: 0, buffer };
        chunk.copy(buffer, offset);
        return { bytesRead: chunk.length, buffer };
      }),
    };
    await expect(readExactly(handle as never, 0, 5)).resolves.toEqual(Buffer.from('abcde'));
    expect(handle.read).toHaveBeenCalledTimes(3);

    await expect(readExactly({
      read: vi.fn(async () => ({ bytesRead: 0, buffer: Buffer.alloc(1) })),
    } as never, 0, 1)).rejects.toThrow(/read_exactly_eof/);
  });

  it('writeExactly loops across partial writes and fails on no-progress writes', async () => {
    const writes = [2, 1, 2];
    const seen: Array<{ offset: number; length: number; position: number }> = [];
    const handle = {
      write: vi.fn(async (_buffer: Buffer, offset: number, length: number, position: number) => {
        seen.push({ offset, length, position });
        return { bytesWritten: writes.shift() ?? 0, buffer: _buffer };
      }),
    };
    await expect(writeExactly(handle as never, Buffer.from('abcde'), 10)).resolves.toBeUndefined();
    expect(seen).toEqual([
      { offset: 0, length: 5, position: 10 },
      { offset: 2, length: 3, position: 12 },
      { offset: 3, length: 2, position: 13 },
    ]);

    await expect(writeExactly({
      write: vi.fn(async () => ({ bytesWritten: 0, buffer: Buffer.alloc(1) })),
    } as never, Buffer.from('x'), 0)).rejects.toThrow(/write_exactly_no_progress/);
  });

  it('cleanup skips a pathname replacement instead of mutating the wrong file', async () => {
    const blob = encodeEnrollmentBlob({ serverUrl: 'https://im.example', enrollToken: 'once' });
    const sourcePath = join(dir, 'source.bin');
    const prefix = Buffer.alloc(16, 0x42);
    await writeFile(sourcePath, Buffer.concat([prefix, blob]));
    const source = await openVerifiedEnrollmentSource(sourcePath);
    await writeFile(sourcePath, Buffer.from('replacement'));
    try {
      await expect(source.cleanupEnrollmentSource(prefix.length, blob.length)).resolves.toBe('skipped');
      await expect(readFile(sourcePath)).resolves.toEqual(Buffer.from('replacement'));
    } finally {
      await source.close();
    }
  });

  it.runIf(process.platform === 'linux')('atomically strips the trailer when Linux reports the running image as busy', async () => {
    const blob = encodeEnrollmentBlob({ serverUrl: 'https://im.example', enrollToken: 'once' });
    const sourcePath = join(dir, 'busy-source.bin');
    const prefix = Buffer.alloc(32, 0x62);
    await writeFile(sourcePath, Buffer.concat([prefix, blob]), { mode: 0o751 });
    const original = await stat(sourcePath);
    const source = await openVerifiedEnrollmentSource(sourcePath, createEnrollmentStagingFs({
      openSourceWritable: async () => {
        const error = new Error('text file busy') as NodeJS.ErrnoException;
        error.code = 'ETXTBSY';
        throw error;
      },
    }));
    try {
      await expect(source.cleanupEnrollmentSource(prefix.length, blob.length)).resolves.toBe('cleaned');
      await expect(readFile(sourcePath)).resolves.toEqual(prefix);
      const cleaned = await stat(sourcePath);
      expect(cleaned.mode & 0o777).toBe(original.mode & 0o777);
      expect(cleaned.uid).toBe(original.uid);
      expect(cleaned.gid).toBe(original.gid);
      expect((await readdir(dir)).filter((entry) => entry.endsWith('.cleanup'))).toEqual([]);
    } finally {
      await source.close();
    }
  });
});
