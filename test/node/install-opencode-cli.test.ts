import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractBinaryFromTarGz,
  installOpenCodeCli,
  isOpenCodeAlreadyInstalled,
  isOpenCodeOptedOut,
  resolveCandidateRegistries,
  resolveOpenCodePlatformPackage,
  runInstallOpenCodeCli,
  verifyBufferIntegrity,
} from '../../src/node/install-opencode-cli.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'imcodes-opencode-inst-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const str = value.toString(8).padStart(length - 1, '0') + '\0';
  buf.write(str, offset, length, 'ascii');
}

function buildTarGz(entries: Array<{ name: string; content: Buffer | string; typeflag?: string; mode?: number }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const header = Buffer.alloc(512, 0);
    const nameBytes = Buffer.from(entry.name, 'utf8');
    if (nameBytes.length > 100) {
      // Write PAX extended header for long name support testing too
      const paxRecordContent = `${Buffer.byteLength(` path=${entry.name}\n`) + String(Buffer.byteLength(` path=${entry.name}\n`)).length} path=${entry.name}\n`;
      const paxPayload = Buffer.from(paxRecordContent, 'utf8');
      const paxHeader = Buffer.alloc(512, 0);
      paxHeader.write('PaxHeaders.0/entry', 0, 100, 'utf8');
      writeOctal(paxHeader, 100, 8, 0o644);
      writeOctal(paxHeader, 108, 8, 0);
      writeOctal(paxHeader, 116, 8, 0);
      writeOctal(paxHeader, 124, 12, paxPayload.length);
      writeOctal(paxHeader, 136, 12, 0);
      paxHeader.fill(0x20, 148, 156);
      paxHeader.write('x', 156, 1, 'ascii');
      paxHeader.write('ustar\0', 257, 6, 'ascii');
      paxHeader.write('00', 263, 2, 'ascii');
      let sum = 0;
      for (let i = 0; i < 512; i += 1) sum += paxHeader[i];
      writeOctal(paxHeader, 148, 7, sum);
      paxHeader[155] = 0x20;
      blocks.push(paxHeader);
      blocks.push(paxPayload);
      const paxPad = (512 - (paxPayload.length % 512)) % 512;
      if (paxPad > 0) blocks.push(Buffer.alloc(paxPad, 0));
      header.write('truncated-entry', 0, 100, 'utf8');
    } else {
      header.write(entry.name, 0, 100, 'utf8');
    }
    writeOctal(header, 100, 8, entry.mode ?? 0o755);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, content.length);
    writeOctal(header, 136, 12, 1700000000);
    header.fill(0x20, 148, 156);
    header.write(entry.typeflag ?? '0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let chksum = 0;
    for (let i = 0; i < 512; i += 1) chksum += header[i];
    writeOctal(header, 148, 7, chksum);
    header[155] = 0x20;
    blocks.push(header);
    if (content.length > 0) {
      blocks.push(content);
      const pad = (512 - (content.length % 512)) % 512;
      if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

async function startMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('install-opencode-cli', () => {
  it('maps supported darwin/linux(glibc+musl)/win32 platform packages and rejects unsupported targets', () => {
    expect(resolveOpenCodePlatformPackage({ platform: 'darwin', arch: 'arm64' })).toBe('opencode-darwin-arm64');
    expect(resolveOpenCodePlatformPackage({ platform: 'darwin', arch: 'x64' })).toBe('opencode-darwin-x64');
    expect(resolveOpenCodePlatformPackage({ platform: 'linux', arch: 'x64', isMusl: false })).toBe('opencode-linux-x64');
    expect(resolveOpenCodePlatformPackage({ platform: 'linux', arch: 'x64', isMusl: true })).toBe('opencode-linux-x64-musl');
    expect(resolveOpenCodePlatformPackage({ platform: 'linux', arch: 'arm64', isMusl: false })).toBe('opencode-linux-arm64');
    expect(resolveOpenCodePlatformPackage({ platform: 'linux', arch: 'arm64', isMusl: true })).toBe('opencode-linux-arm64-musl');
    expect(resolveOpenCodePlatformPackage({ platform: 'win32', arch: 'x64' })).toBe('opencode-windows-x64');
    expect(resolveOpenCodePlatformPackage({ platform: 'win32', arch: 'arm64' })).toBe('opencode-windows-arm64');
    expect(resolveOpenCodePlatformPackage({ platform: 'linux', arch: 'ia32', isMusl: false })).toBeNull();
    expect(resolveOpenCodePlatformPackage({ platform: 'freebsd', arch: 'x64' })).toBeNull();
  });

  it('respects opt-out flags and IMCODES_SKIP_OPENCODE without making network calls', async () => {
    expect(isOpenCodeOptedOut({ skip: true })).toBe(true);
    expect(isOpenCodeOptedOut({ env: { IMCODES_SKIP_OPENCODE: '1' } })).toBe(true);
    expect(isOpenCodeOptedOut({ env: { IMCODES_SKIP_OPENCODE: 'TRUE' } })).toBe(true);
    expect(isOpenCodeOptedOut({ env: { IMCODES_SKIP_OPENCODE: 'yes' } })).toBe(true);
    expect(isOpenCodeOptedOut({ env: { IMCODES_SKIP_OPENCODE: '0' } })).toBe(false);

    const fetchSpy = vi.fn();
    const res = await installOpenCodeCli({
      homeDir: makeTempDir(),
      env: { IMCODES_SKIP_OPENCODE: '1' },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res).toEqual({ status: 'skipped' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps existing opencode on PATH or ~/.opencode/bin with zero network calls', async () => {
    const homeWithPath = makeTempDir();
    const pathBinDir = join(homeWithPath, 'custom-bin');
    mkdirSync(pathBinDir, { recursive: true });
    const existingBin = join(pathBinDir, 'opencode');
    writeFileSync(existingBin, '#!/bin/sh\necho 0.9.1\n', 'utf8');
    chmodSync(existingBin, 0o755);

    const fetchSpy = vi.fn();
    const pathHit = await installOpenCodeCli({
      homeDir: homeWithPath,
      platform: 'linux',
      arch: 'x64',
      env: { PATH: pathBinDir },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(pathHit).toEqual({ status: 'existing', path: existingBin });
    expect(fetchSpy).not.toHaveBeenCalled();

    const homeWithOc = makeTempDir();
    const ocBin = join(homeWithOc, '.opencode', 'bin', 'opencode');
    mkdirSync(join(homeWithOc, '.opencode', 'bin'), { recursive: true });
    writeFileSync(ocBin, '#!/bin/sh\necho 1.0.0\n', 'utf8');
    chmodSync(ocBin, 0o755);

    const homeHit = await installOpenCodeCli({
      homeDir: homeWithOc,
      platform: 'linux',
      arch: 'x64',
      env: { PATH: '' },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(homeHit).toEqual({ status: 'existing', path: ocBin });
    expect(fetchSpy).not.toHaveBeenCalled();

    // Windows PATH/PATHEXT detection
    const winFound = await isOpenCodeAlreadyInstalled({
      homeDir: 'C:\\Users\\demo',
      platform: 'win32',
      env: { PATH: 'C:\\Tools;C:\\Apps', PATHEXT: '.EXE;.CMD' },
      checkFileExecutable: async (p) => p.toLowerCase() === 'c:\\apps\\opencode.exe',
    });
    expect(winFound).toBe('C:\\Apps\\opencode.exe');
  });

  it('verifies SHA-512 / SHA-1 integrity and rejects missing or tampered tarballs', () => {
    const payload = Buffer.from('hello-opencode');
    const sha512 = createHash('sha512').update(payload).digest('base64');
    const sha1 = createHash('sha1').update(payload).digest('hex');

    expect(() => verifyBufferIntegrity(payload, { integrity: `sha512-${sha512}` })).not.toThrow();
    expect(() => verifyBufferIntegrity(payload, { shasum: sha1 })).not.toThrow();
    expect(() => verifyBufferIntegrity(Buffer.from('tampered'), { integrity: `sha512-${sha512}` })).toThrow(/integrity_mismatch/);
    expect(() => verifyBufferIntegrity(Buffer.from('tampered'), { shasum: sha1 })).toThrow(/integrity_mismatch/);
    expect(() => verifyBufferIntegrity(payload, {})).toThrow(/missing_integrity_metadata/);
  });

  it('rejects traversal entries and non-regular binary entries in tarballs', () => {
    const symlinkTar = buildTarGz([
      { name: 'package/bin/opencode', content: '', typeflag: '2' },
    ]);
    expect(() => extractBinaryFromTarGz(symlinkTar, ['package/bin/opencode'])).toThrow(/binary_not_found_in_tarball/);

    const traversalTar = buildTarGz([
      { name: '../evil/opencode', content: 'bad' },
    ]);
    expect(() => extractBinaryFromTarGz(traversalTar, ['package/bin/opencode'])).toThrow(/unsafe_tar_entry_path/);
  });

  it('downloads, verifies SHA-512, extracts atomically, runs --version, and supports mirror fallback against local HTTP registries', async () => {
    const fakeScript = Buffer.from('#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode 2.4.2"; exit 0; fi\nexit 1\n', 'utf8');
    const tgz = buildTarGz([
      { name: 'package/package.json', content: '{"name":"opencode-linux-x64","version":"2.4.2"}', typeflag: '0', mode: 0o644 },
      { name: './package/bin/opencode', content: fakeScript, typeflag: '0', mode: 0o755 },
    ]);
    const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;

    const failingPrimary = await startMockServer((_req, res) => {
      res.statusCode = 500;
      res.end('registry error');
    });
    let mirrorUrl = '';
    const workingMirror = await startMockServer((req, res) => {
      if (req.url === '/opencode-linux-x64/latest') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          name: 'opencode-linux-x64',
          version: '2.4.2',
          dist: {
            tarball: `${mirrorUrl}/opencode-linux-x64-2.4.2.tgz`,
            integrity,
          },
        }));
        return;
      }
      if (req.url === '/opencode-linux-x64-2.4.2.tgz') {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(tgz);
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    mirrorUrl = workingMirror.url;

    try {
      const homeDir = makeTempDir();
      const result = await installOpenCodeCli({
        homeDir,
        platform: 'linux',
        arch: 'x64',
        isMusl: false,
        env: { PATH: '' },
        registries: [failingPrimary.url, workingMirror.url],
      });

      const expectedDest = join(homeDir, '.opencode', 'bin', 'opencode');
      expect(result).toEqual({
        status: 'installed',
        path: expectedDest,
        version: 'opencode 2.4.2',
        packageName: 'opencode-linux-x64',
        registry: workingMirror.url,
      });
      expect(existsSync(expectedDest)).toBe(true);
      expect(readFileSync(expectedDest)).toEqual(fakeScript);
      if (process.platform !== 'win32') {
        const verOut = execFileSync(expectedDest, ['--version'], { encoding: 'utf8' }).trim();
        expect(verOut).toBe('opencode 2.4.2');
      }
    } finally {
      await failingPrimary.close();
      await workingMirror.close();
    }
  });

  it('rejects tampered downloads with zero leftover temp/target files and exits 0 non-blockingly', async () => {
    const realTgz = buildTarGz([{ name: 'package/bin/opencode', content: 'real', typeflag: '0' }]);
    const wrongIntegrity = `sha512-${createHash('sha512').update('something-else').digest('base64')}`;

    let srvUrl = '';
    const badMirror = await startMockServer((req, res) => {
      if (req.url?.endsWith('/latest')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          version: '2.4.2',
          dist: { tarball: `${srvUrl}/pkg.tgz`, integrity: wrongIntegrity },
        }));
        return;
      }
      res.end(realTgz);
    });
    srvUrl = badMirror.url;

    try {
      const homeDir = makeTempDir();
      const warnSpy = vi.fn();
      const res = await installOpenCodeCli({
        homeDir,
        platform: 'linux',
        arch: 'x64',
        isMusl: false,
        env: { PATH: '' },
        registries: [badMirror.url],
        logger: { warn: warnSpy },
      });
      expect(res.status).toBe('failed');
      expect(res.reason).toContain('integrity_mismatch');
      expect(existsSync(join(homeDir, '.opencode', 'bin', 'opencode'))).toBe(false);

      // CLI wrapper returns 0 by default (non-blocking) when offline/failing
      const prevNoFallback = process.env.IMCODES_OPENCODE_NO_FALLBACK;
      const prevPath = process.env.PATH;
      process.env.IMCODES_OPENCODE_NO_FALLBACK = '1';
      process.env.PATH = '';
      try {
        const exitCode = await runInstallOpenCodeCli(['--home', homeDir, '--registry', badMirror.url, '--no-fallback', '--quiet']);
        expect(exitCode).toBe(0);
        const strictCode = await runInstallOpenCodeCli(['--home', homeDir, '--registry', badMirror.url, '--no-fallback', '--strict', '--quiet']);
        expect(strictCode).toBe(1);
      } finally {
        if (prevNoFallback === undefined) delete process.env.IMCODES_OPENCODE_NO_FALLBACK;
        else process.env.IMCODES_OPENCODE_NO_FALLBACK = prevNoFallback;
        if (prevPath === undefined) delete process.env.PATH;
        else process.env.PATH = prevPath;
      }
    } finally {
      await badMirror.close();
    }
  });

  it('orders registries from CLI/env/install.json before official and mirror', () => {
    const homeDir = makeTempDir();
    mkdirSync(join(homeDir, '.imcodes'), { recursive: true });
    writeFileSync(join(homeDir, '.imcodes', 'install.json'), JSON.stringify({ registry: 'https://custom-json.example/npm/' }));

    const list = resolveCandidateRegistries({
      registry: 'https://cli.example/npm/',
      env: { IMCODES_NPM_REGISTRY: 'https://env.example/npm/' },
      homeDir,
    });
    expect(list).toEqual([
      'https://cli.example/npm',
      'https://env.example/npm',
      'https://custom-json.example/npm',
      'https://registry.npmjs.org',
      'https://registry.npmmirror.com',
    ]);
  });
});
