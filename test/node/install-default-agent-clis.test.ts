import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installAgyCli,
  installClaudeCli,
  installCodexCli,
  installDefaultAgentClis,
  isAgyAlreadyInstalled,
  isAgentCliOptedOut,
  isClaudeAlreadyInstalled,
  isCodexAlreadyInstalled,
  resolveAgyManifestPlatform,
  resolveCandidateAgyManifestBases,
  resolveClaudePlatformPackage,
  resolveCodexPlatformSuffix,
  runInstallDefaultAgentClis,
} from '../../src/node/install-default-agent-clis.js';
import { resolveOpenCodePlatformPackage } from '../../src/node/install-opencode-cli.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'imcodes-default-cli-inst-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const str = value.toString(8).padStart(length - 1, '0') + '\0';
  buf.write(str, offset, length, 'ascii');
}

function buildTarGz(entries: Array<{ name: string; content?: Buffer | string; typeflag?: string; mode?: number }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content === undefined
      ? Buffer.alloc(0)
      : typeof entry.content === 'string'
        ? Buffer.from(entry.content, 'utf8')
        : entry.content;
    const header = Buffer.alloc(512, 0);
    const nameBytes = Buffer.from(entry.name, 'utf8');
    if (nameBytes.length > 100) {
      const baseRecord = ` path=${entry.name}\n`;
      let totalLen = Buffer.byteLength(baseRecord) + 2;
      totalLen = Buffer.byteLength(`${totalLen}${baseRecord}`);
      const paxPayload = Buffer.from(`${totalLen}${baseRecord}`, 'utf8');
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
      blocks.push(paxHeader, paxPayload);
      const paxPad = (512 - (paxPayload.length % 512)) % 512;
      if (paxPad > 0) blocks.push(Buffer.alloc(paxPad, 0));
      header.write('long-entry', 0, 100, 'utf8');
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

function sriSha512(buf: Buffer): string {
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`;
}

function hexSha512(buf: Buffer): string {
  return createHash('sha512').update(buf).digest('hex');
}

async function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
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

describe('install-default-agent-clis', () => {
  it('maps codex, claude, and agy platforms across darwin/linux(glibc+musl)/win32', () => {
    expect(resolveCodexPlatformSuffix({ platform: 'darwin', arch: 'arm64' })).toBe('darwin-arm64');
    expect(resolveCodexPlatformSuffix({ platform: 'darwin', arch: 'x64' })).toBe('darwin-x64');
    expect(resolveCodexPlatformSuffix({ platform: 'linux', arch: 'x64' })).toBe('linux-x64');
    expect(resolveCodexPlatformSuffix({ platform: 'linux', arch: 'arm64' })).toBe('linux-arm64');
    expect(resolveCodexPlatformSuffix({ platform: 'win32', arch: 'x64' })).toBe('win32-x64');
    expect(resolveCodexPlatformSuffix({ platform: 'win32', arch: 'arm64' })).toBe('win32-arm64');
    expect(resolveCodexPlatformSuffix({ platform: 'freebsd', arch: 'x64' })).toBeNull();

    expect(resolveClaudePlatformPackage({ platform: 'darwin', arch: 'arm64' })).toBe('@anthropic-ai/claude-code-darwin-arm64');
    expect(resolveClaudePlatformPackage({ platform: 'darwin', arch: 'x64' })).toBe('@anthropic-ai/claude-code-darwin-x64');
    expect(resolveClaudePlatformPackage({ platform: 'linux', arch: 'x64', isMusl: false })).toBe('@anthropic-ai/claude-code-linux-x64');
    expect(resolveClaudePlatformPackage({ platform: 'linux', arch: 'x64', isMusl: true })).toBe('@anthropic-ai/claude-code-linux-x64-musl');
    expect(resolveClaudePlatformPackage({ platform: 'linux', arch: 'arm64', isMusl: false })).toBe('@anthropic-ai/claude-code-linux-arm64');
    expect(resolveClaudePlatformPackage({ platform: 'linux', arch: 'arm64', isMusl: true })).toBe('@anthropic-ai/claude-code-linux-arm64-musl');
    expect(resolveClaudePlatformPackage({ platform: 'win32', arch: 'x64' })).toBe('@anthropic-ai/claude-code-win32-x64');
    expect(resolveClaudePlatformPackage({ platform: 'win32', arch: 'arm64' })).toBe('@anthropic-ai/claude-code-win32-arm64');
    expect(resolveClaudePlatformPackage({ platform: 'linux', arch: 'ia32', isMusl: false })).toBeNull();

    expect(resolveAgyManifestPlatform({ platform: 'darwin', arch: 'arm64' })).toBe('darwin_arm64');
    expect(resolveAgyManifestPlatform({ platform: 'darwin', arch: 'x64' })).toBe('darwin_amd64');
    expect(resolveAgyManifestPlatform({ platform: 'linux', arch: 'x64', isMusl: false })).toBe('linux_amd64');
    expect(resolveAgyManifestPlatform({ platform: 'linux', arch: 'x64', isMusl: true })).toBe('linux_amd64_musl');
    expect(resolveAgyManifestPlatform({ platform: 'linux', arch: 'arm64', isMusl: false })).toBe('linux_arm64');
    expect(resolveAgyManifestPlatform({ platform: 'linux', arch: 'arm64', isMusl: true })).toBe('linux_arm64_musl');
    expect(resolveAgyManifestPlatform({ platform: 'win32', arch: 'x64' })).toBe('windows_amd64');
    expect(resolveAgyManifestPlatform({ platform: 'win32', arch: 'arm64' })).toBe('windows_arm64');
    expect(resolveAgyManifestPlatform({ platform: 'win32', arch: 'ia32' })).toBeNull();
  });

  it('respects per-CLI and global opt-out env vars without making network requests', async () => {
    const fetchSpy = async (): Promise<Response> => {
      throw new Error('network must not be called');
    };
    const root = makeTempDir();
    expect(isAgentCliOptedOut('IMCODES_SKIP_CODEX', { env: { IMCODES_SKIP_AGENT_CLIS: '1' } })).toBe(true);
    expect(isAgentCliOptedOut('IMCODES_SKIP_CLAUDE', { env: { IMCODES_SKIP_CLAUDE: 'true' } })).toBe(true);
    expect(isAgentCliOptedOut('IMCODES_SKIP_AGY', { env: { IMCODES_SKIP_AGY: 'YES' } })).toBe(true);

    const codexRes = await installCodexCli({ homeDir: root, env: { IMCODES_SKIP_CODEX: '1', PATH: '' }, fetchImpl: fetchSpy });
    const claudeRes = await installClaudeCli({ homeDir: root, env: { IMCODES_SKIP_CLAUDE: '1', PATH: '' }, fetchImpl: fetchSpy });
    const agyRes = await installAgyCli({ homeDir: root, env: { IMCODES_SKIP_AGY: '1', PATH: '' }, fetchImpl: fetchSpy });
    expect(codexRes).toEqual({ status: 'skipped' });
    expect(claudeRes).toEqual({ status: 'skipped' });
    expect(agyRes).toEqual({ status: 'skipped' });
  });

  it('detects existing installs in PATH or home dirs and keeps them untouched', async () => {
    const root = makeTempDir();
    const home = join(root, 'home');
    mkdirSync(join(home, '.codex', 'bin'), { recursive: true });
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const existingCodex = join(home, '.codex', 'bin', 'codex');
    const existingClaude = join(home, '.local', 'bin', 'claude');
    const existingAgy = join(home, '.local', 'bin', 'agy');
    writeFileSync(existingCodex, '#!/bin/sh\necho codex 0.172.0\n', { mode: 0o755 });
    writeFileSync(existingClaude, '#!/bin/sh\necho 2.1.332\n', { mode: 0o755 });
    writeFileSync(existingAgy, '#!/bin/sh\necho agy 1.5.19\n', { mode: 0o755 });

    const noNet = async (): Promise<Response> => {
      throw new Error('must not hit network when existing');
    };
    expect(await isCodexAlreadyInstalled({ homeDir: home, env: { PATH: '' } })).toBe(existingCodex);
    expect(await isClaudeAlreadyInstalled({ homeDir: home, env: { PATH: '' } })).toBe(existingClaude);
    expect(await isAgyAlreadyInstalled({ homeDir: home, env: { PATH: '' } })).toBe(existingAgy);

    const { results } = await installDefaultAgentClis({
      homeDir: home,
      env: { PATH: '' },
      skipOpenCode: true,
      fetchImpl: noNet,
    });
    expect(results.codex).toEqual({ status: 'existing', path: existingCodex });
    expect(results.claude).toEqual({ status: 'existing', path: existingClaude });
    expect(results.agy).toEqual({ status: 'existing', path: existingAgy });
  });

  it('rejects symlinked target directories or binaries without downloading payloads', async () => {
    const root = makeTempDir();
    const home = join(root, 'home');
    const decoy = join(root, 'decoy');
    mkdirSync(home, { recursive: true });
    mkdirSync(decoy, { recursive: true });

    symlinkSync(decoy, join(home, '.codex'));
    symlinkSync(decoy, join(home, '.local'));

    let fetchCalls = 0;
    const countingFetch: typeof fetch = async () => {
      fetchCalls += 1;
      throw new Error('must not fetch');
    };

    const codexRes = await installCodexCli({ homeDir: home, env: { PATH: '' }, registries: ['http://127.0.0.1:9'], fetchImpl: countingFetch });
    const claudeRes = await installClaudeCli({ homeDir: home, env: { PATH: '' }, registries: ['http://127.0.0.1:9'], fetchImpl: countingFetch });
    const agyRes = await installAgyCli({ homeDir: home, env: { PATH: '' }, agyManifestBaseUrls: ['http://127.0.0.1:9'], fetchImpl: countingFetch });

    expect(codexRes.status).toBe('failed');
    expect(codexRes.reason).toContain('unsafe_symlink_target');
    expect(claudeRes.status).toBe('failed');
    expect(claudeRes.reason).toContain('unsafe_symlink_target');
    expect(agyRes.status).toBe('failed');
    expect(agyRes.reason).toContain('unsafe_symlink_target');
    expect(fetchCalls).toBe(0);
  });

  it('installs codex from mirror fallback, preserves ~/.codex user data, installs sibling helpers, and rejects tampered digests', async () => {
    const root = makeTempDir();
    const home = join(root, 'home');
    mkdirSync(join(home, '.codex', 'sessions'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), '{"token":"keep-me"}', 'utf8');

    const codexScript = '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.172.0"; exit 0; fi\n';
    const rgScript = '#!/bin/sh\necho rg\n';
    const codexTgz = buildTarGz([
      { name: 'package/vendor/x86_64-unknown-linux-musl/bin/codex', content: codexScript, mode: 0o755 },
      { name: 'package/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host', content: 'host-bin', mode: 0o755 },
      { name: 'package/vendor/x86_64-unknown-linux-musl/codex-path/rg', content: rgScript, mode: 0o755 },
      { name: 'package/vendor/x86_64-unknown-linux-musl/codex-resources/voice/manifest.json', content: '{"ok":true}', mode: 0o644 },
    ]);

    let failCount = 0;
    const failingSrv = await startMockServer((_req, res) => {
      failCount += 1;
      res.statusCode = 500;
      res.end('registry down');
    });
    const suffix = resolveCodexPlatformSuffix()!;
    const subVer = `0.172.0-${suffix}`;
    const mirrorSrv = await startMockServer((req, res) => {
      if (req.url === '/@openai%2Fcodex/latest') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          version: '0.172.0',
          optionalDependencies: { [`@openai/codex-${suffix}`]: `npm:@openai/codex@${subVer}` },
        }));
        return;
      }
      if (req.url === `/@openai%2Fcodex/${encodeURIComponent(subVer)}`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          version: subVer,
          dist: { tarball: `${mirrorSrv.url}/codex.tgz`, integrity: sriSha512(codexTgz) },
        }));
        return;
      }
      if (req.url === '/codex.tgz') {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(codexTgz);
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const res = await installCodexCli({
        homeDir: home,
        env: { PATH: '' },
        registries: [failingSrv.url, mirrorSrv.url],
      });
      expect(failCount).toBeGreaterThanOrEqual(1);
      expect(res.status).toBe('installed');
      expect(res.path).toBe(join(home, '.codex', 'bin', 'codex'));
      expect(res.version).toContain('0.172.0');
      expect(existsSync(join(home, '.codex', 'bin', 'codex'))).toBe(true);
      expect(existsSync(join(home, '.codex', 'bin', 'codex-code-mode-host'))).toBe(true);
      expect(existsSync(join(home, '.codex', 'codex-path', 'rg'))).toBe(true);
      expect(readFileSync(join(home, '.codex', 'codex-resources', 'voice', 'manifest.json'), 'utf8')).toBe('{"ok":true}');
      expect(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')).toBe('{"token":"keep-me"}');

      // Tampered digest check
      const badHome = join(root, 'bad-home');
      const badSrv = await startMockServer((req, res) => {
        if (req.url === '/@openai%2Fcodex/latest') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            version: '0.172.0',
            optionalDependencies: { [`@openai/codex-${suffix}`]: `npm:@openai/codex@${subVer}` },
          }));
          return;
        }
        if (req.url === `/@openai%2Fcodex/${encodeURIComponent(subVer)}`) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            version: subVer,
            dist: { tarball: `${badSrv.url}/codex.tgz`, integrity: sriSha512(Buffer.from('wrong')) },
          }));
          return;
        }
        res.end(codexTgz);
      });
      try {
        const badRes = await installCodexCli({
          homeDir: badHome,
          env: { PATH: '' },
          registries: [badSrv.url],
        });
        expect(badRes.status).toBe('failed');
        expect(badRes.reason).toContain('integrity_mismatch');
        expect(existsSync(join(badHome, '.codex', 'bin', 'codex'))).toBe(false);
      } finally {
        await badSrv.close();
      }
    } finally {
      await failingSrv.close();
      await mirrorSrv.close();
    }
  });

  it('installs claude via npmmirror streaming extraction without touching claude.ai and supports large binaries', async () => {
    const root = makeTempDir();
    const home = join(root, 'home');
    // Build a multi-MB zero-padded binary payload with valid shell wrapper prefix to prove streaming across chunk boundaries
    const header = Buffer.from('#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.332 (Claude Code)"; exit 0; fi\nexit 0\n# ');
    const largePayload = Buffer.concat([header, Buffer.alloc(4 * 1024 * 1024, 0x41)]);
    const claudePkg = resolveClaudePlatformPackage({
      platform: process.platform,
      arch: process.arch,
      isMusl: false,
    })!;
    const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const claudeTgz = buildTarGz([
      { name: 'package/package.json', content: '{"name":"claude-code"}', mode: 0o644 },
      { name: `package/${binName}`, content: largePayload, mode: 0o755 },
    ]);

    const seenUrls: string[] = [];
    const primarySrv = await startMockServer((_req, res) => {
      res.statusCode = 503;
      res.end('blocked');
    });
    const encodePkg = (pkg: string): string => (pkg.startsWith('@') ? `@${encodeURIComponent(pkg.slice(1))}` : encodeURIComponent(pkg));
    const mirrorSrv = await startMockServer((req, res) => {
      seenUrls.push(req.url ?? '');
      if (req.url === `/${encodePkg(claudePkg)}/latest`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          version: '2.1.332',
          dist: { tarball: `${mirrorSrv.url}/claude.tgz`, integrity: sriSha512(claudeTgz) },
        }));
        return;
      }
      if (req.url === '/claude.tgz') {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(claudeTgz);
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const res = await installClaudeCli({
        homeDir: home,
        isMusl: false,
        env: { PATH: '' },
        registries: [primarySrv.url, mirrorSrv.url],
      });
      expect(res.status).toBe('installed');
      expect(res.path).toBe(join(home, '.local', 'bin', binName));
      expect(res.version).toContain('2.1.332');
      expect(readFileSync(join(home, '.local', 'bin', binName)).length).toBe(largePayload.length);
      expect(seenUrls.some((u) => u.includes('claude.ai'))).toBe(false);
    } finally {
      await primarySrv.close();
      await mirrorSrv.close();
    }
  });

  it('installs agy via manifest + sha512 mirror, supports raw binary mode, and fails fast on unreachable endpoints', async () => {
    const root = makeTempDir();
    const home = join(root, 'home');
    const agyScript = '#!/bin/sh\necho "1.5.19"\n';
    const agyTgz = buildTarGz([{ name: 'antigravity', content: agyScript, mode: 0o755 }]);
    const agyPlatform = resolveAgyManifestPlatform({ isMusl: false })!;

    const agyMirror = await startMockServer((req, res) => {
      if (req.url === `/manifests/${agyPlatform}.json`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          version: '1.5.19',
          url: `${agyMirror.url}/cli.tar.gz`,
          sha512: hexSha512(agyTgz),
        }));
        return;
      }
      if (req.url === '/cli.tar.gz') {
        res.end(agyTgz);
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const slowHoldSockets: ServerResponse[] = [];
    const hangingSrv = await startMockServer((_req, res) => {
      slowHoldSockets.push(res);
    });

    try {
      expect(resolveCandidateAgyManifestBases({ env: { IMCODES_AGY_MANIFEST_BASE_URL: 'https://mirror.example.cn/agy/' } })).toEqual([
        'https://mirror.example.cn/agy',
        'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app',
      ]);

      const okRes = await installAgyCli({
        homeDir: home,
        isMusl: false,
        env: { PATH: '', IMCODES_AGY_MANIFEST_BASE_URL: agyMirror.url },
        noFallback: true,
      });
      expect(okRes.status).toBe('installed');
      expect(okRes.path).toBe(join(home, '.local', 'bin', 'agy'));
      expect(okRes.version).toBe('1.5.19');

      // Bad SHA-512 rejection
      const badShaSrv = await startMockServer((req, res) => {
        if (req.url === `/manifests/${agyPlatform}.json`) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            version: '1.5.19',
            url: `${badShaSrv.url}/cli.tar.gz`,
            sha512: '0'.repeat(128),
          }));
          return;
        }
        res.end(agyTgz);
      });
      try {
        const badRes = await installAgyCli({
          homeDir: join(root, 'bad-agy'),
          isMusl: false,
          env: { PATH: '' },
          agyManifestBaseUrls: [badShaSrv.url],
        });
        expect(badRes.status).toBe('failed');
        expect(badRes.reason).toContain('checksum_mismatch:sha512');
      } finally {
        await badShaSrv.close();
      }

      // Raw binary Windows payload simulation (non-tar.gz)
      const fakeExeBytes = Buffer.from('MZ-fake-agy-exe');
      const winRawSrv = await startMockServer((req, res) => {
        if (req.url === '/manifests/windows_amd64.json') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            version: '1.5.19',
            url: `${winRawSrv.url}/cli_windows_x64.exe`,
            sha512: hexSha512(fakeExeBytes),
          }));
          return;
        }
        res.end(fakeExeBytes);
      });
      try {
        const winHome = join(root, 'win-home');
        const winRes = await installAgyCli({
          homeDir: winHome,
          platform: 'win32',
          arch: 'x64',
          env: { PATH: '' },
          agyManifestBaseUrls: [winRawSrv.url],
          verifyVersion: () => '1.5.19',
        });
        expect(winRes.status).toBe('installed');
        expect(winRes.path).toBe(join(winHome, '.local', 'bin', 'agy.exe'));
      } finally {
        await winRawSrv.close();
      }

      // Fast-fail timeout test on hanging server
      const t0 = Date.now();
      const timeoutRes = await installAgyCli({
        homeDir: join(root, 'timeout-agy'),
        isMusl: false,
        env: { PATH: '' },
        agyManifestBaseUrls: [hangingSrv.url],
        metadataTimeoutMs: 150,
      });
      const elapsed = Date.now() - t0;
      expect(timeoutRes.status).toBe('failed');
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      for (const r of slowHoldSockets) {
        try { r.destroy(); } catch { /* ignore */ }
      }
      await agyMirror.close();
      await hangingSrv.close();
    }
  });

  it('installs opencode/codex/claude via mirror concurrently even when official registry and agy hang or fail', async () => {
    const root = makeTempDir();
    const home = join(root, 'home');
    const codexSuffix = resolveCodexPlatformSuffix()!;
    const codexSubVer = `0.172.0-${codexSuffix}`;
    const ocPkg = resolveOpenCodePlatformPackage({ isMusl: false })!;
    const claudePkg = resolveClaudePlatformPackage({ isMusl: false })!;
    const agyPlatform = resolveAgyManifestPlatform({ isMusl: false })!;

    const ocTgz = buildTarGz([{ name: 'package/bin/opencode', content: '#!/bin/sh\necho "2.4.2"\n', mode: 0o755 }]);
    const codexTgz = buildTarGz([{ name: 'package/vendor/x86_64-unknown-linux-musl/bin/codex', content: '#!/bin/sh\necho "0.172.0"\n', mode: 0o755 }]);
    const claudeTgz = buildTarGz([{ name: 'package/claude', content: '#!/bin/sh\necho "2.1.332"\n', mode: 0o755 }]);

    const mirrorSrv = await startMockServer((req, res) => {
      if (req.url === `/${encodeURIComponent(ocPkg)}/latest`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '2.4.2', dist: { tarball: `${mirrorSrv.url}/oc.tgz`, integrity: sriSha512(ocTgz) } }));
        return;
      }
      if (req.url === '/oc.tgz') { res.end(ocTgz); return; }
      if (req.url === '/@openai%2Fcodex/latest') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '0.172.0', optionalDependencies: { [`@openai/codex-${codexSuffix}`]: `npm:@openai/codex@${codexSubVer}` } }));
        return;
      }
      if (req.url === `/@openai%2Fcodex/${encodeURIComponent(codexSubVer)}`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: codexSubVer, dist: { tarball: `${mirrorSrv.url}/codex.tgz`, integrity: sriSha512(codexTgz) } }));
        return;
      }
      if (req.url === '/codex.tgz') { res.end(codexTgz); return; }
      if (req.url === `/${claudePkg.startsWith('@') ? `@${encodeURIComponent(claudePkg.slice(1))}` : encodeURIComponent(claudePkg)}/latest`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '2.1.332', dist: { tarball: `${mirrorSrv.url}/claude.tgz`, integrity: sriSha512(claudeTgz) } }));
        return;
      }
      if (req.url === '/claude.tgz') { res.end(claudeTgz); return; }
      res.statusCode = 404;
      res.end();
    });

    const downOfficial = await startMockServer((_req, res) => {
      res.statusCode = 502;
      res.end('blocked');
    });
    const deadAgySockets: ServerResponse[] = [];
    const blockedAgy = await startMockServer((req, res) => {
      if (req.url === `/manifests/${agyPlatform}.json`) {
        deadAgySockets.push(res);
        return;
      }
      res.statusCode = 504;
      res.end();
    });

    try {
      const { results } = await installDefaultAgentClis({
        homeDir: home,
        isMusl: false,
        env: { PATH: '' },
        registries: [downOfficial.url, mirrorSrv.url],
        agyManifestBaseUrls: [blockedAgy.url],
        metadataTimeoutMs: 120,
      });

      expect(results.opencode?.status).toBe('installed');
      expect(results.codex?.status).toBe('installed');
      expect(results.claude?.status).toBe('installed');
      expect(results.agy?.status).toBe('failed');
      expect(existsSync(join(home, '.opencode', 'bin', 'opencode'))).toBe(true);
      expect(existsSync(join(home, '.codex', 'bin', 'codex'))).toBe(true);
      expect(existsSync(join(home, '.local', 'bin', 'claude'))).toBe(true);
      expect(existsSync(join(home, '.local', 'bin', 'agy'))).toBe(false);

      // Non-blocking CLI wrapper returns exit 0 even when isolated target fails; --strict returns 1
      const origPath = process.env.PATH;
      process.env.PATH = '';
      try {
        const nonStrictCode = await runInstallDefaultAgentClis([
          '--home', join(root, 'cli-fail'),
          '--only', 'agy',
          '--agy-manifest-base-url', downOfficial.url,
          '--isolated-test',
          '--quiet',
        ]);
        const strictCode = await runInstallDefaultAgentClis([
          '--home', join(root, 'cli-fail-2'),
          '--only', 'agy',
          '--agy-manifest-base-url', downOfficial.url,
          '--isolated-test',
          '--strict',
          '--quiet',
        ]);
        expect(nonStrictCode).toBe(0);
        expect(strictCode).toBe(1);
      } finally {
        if (origPath === undefined) delete process.env.PATH; else process.env.PATH = origPath;
      }
    } finally {
      for (const r of deadAgySockets) {
        try { r.destroy(); } catch { /* ignore */ }
      }
      await mirrorSrv.close();
      await downOfficial.close();
      await blockedAgy.close();
    }
  });
});
