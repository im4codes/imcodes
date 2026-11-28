import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadResponseToFileWithIntegrity, validateDownloadUrl } from '../../src/node/cli-install-helpers.js';
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
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
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

  it('rolls back partial Codex siblings before publishing binary and preserves existing sibling files on retry', async () => {
    const root = makeTempDir();
    const home = join(root, 'home');
    const codexSuffix = resolveCodexPlatformSuffix()!;
    const codexSubVer = `0.172.0-${codexSuffix}`;
    const targetTriple = codexSuffix === 'darwin-arm64'
      ? 'aarch64-apple-darwin'
      : codexSuffix === 'darwin-x64'
        ? 'x86_64-apple-darwin'
        : 'x86_64-unknown-linux-musl';
    const codexTgz = buildTarGz([
      { name: `package/vendor/${targetTriple}/bin/codex`, content: '#!/bin/sh\necho "0.172.0"\n', mode: 0o755 },
      { name: `package/vendor/${targetTriple}/bin/codex-code-mode-host`, content: '#!/bin/sh\necho host\n', mode: 0o755 },
      { name: `package/vendor/${targetTriple}/codex-path/rg`, content: 'rg-bin', mode: 0o755 },
      { name: `package/vendor/${targetTriple}/codex-resources/custom.txt`, content: 'upstream-default', mode: 0o644 },
      { name: `package/vendor/${targetTriple}/codex-resources/new-asset.txt`, content: 'new-asset', mode: 0o644 },
    ]);
    const srv = await startMockServer((req, res) => {
      if (req.url === '/@openai%2Fcodex/latest') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '0.172.0', optionalDependencies: { [`@openai/codex-${codexSuffix}`]: `npm:@openai/codex@${codexSubVer}` } }));
        return;
      }
      if (req.url === `/@openai%2Fcodex/${encodeURIComponent(codexSubVer)}`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: codexSubVer, dist: { tarball: `${srv.url}/codex.tgz`, integrity: sriSha512(codexTgz) } }));
        return;
      }
      if (req.url === '/codex.tgz') { res.end(codexTgz); return; }
      res.statusCode = 404;
      res.end();
    });

    try {
      // Pre-create an existing sibling file that must never be overwritten or deleted during rollback
      mkdirSync(join(home, '.codex', 'codex-resources'), { recursive: true });
      writeFileSync(join(home, '.codex', 'codex-resources', 'custom.txt'), 'user-custom-data');

      // Counterexample: simulate failure when linking `new-asset.txt` after `codex-code-mode-host` & `rg` were written
      let linkCalls = 0;
      const failingLink = (src: string, dst: string) => {
        linkCalls += 1;
        if (dst.endsWith('new-asset.txt')) {
          throw new Error('simulated_sibling_disk_full');
        }
        const fsMod = require('node:fs') as typeof import('node:fs');
        fsMod.linkSync(src, dst);
      };
      const failRes = await installCodexCli({
        homeDir: home,
        env: { PATH: '' },
        registry: srv.url,
        noFallback: true,
        linkFile: failingLink,
        verifyVersion: () => 'codex-cli 0.172.0',
      });
      expect(failRes.status).toBe('failed');
      expect(linkCalls).toBeGreaterThan(0);
      // Main binary must NEVER be published, newly created siblings/dirs must be rolled back, pre-existing file preserved!
      expect(existsSync(join(home, '.codex', 'bin', 'codex'))).toBe(false);
      expect(existsSync(join(home, '.codex', 'bin', 'codex-code-mode-host'))).toBe(false);
      expect(existsSync(join(home, '.codex', 'codex-path', 'rg'))).toBe(false);
      expect(existsSync(join(home, '.codex', 'codex-path'))).toBe(false);
      expect(readFileSync(join(home, '.codex', 'codex-resources', 'custom.txt'), 'utf8')).toBe('user-custom-data');

      // Immediate retry succeeds cleanly and preserves pre-existing sibling without overwriting
      const retryRes = await installCodexCli({
        homeDir: home,
        env: { PATH: '' },
        registry: srv.url,
        noFallback: true,
        verifyVersion: () => 'codex-cli 0.172.0',
      });
      expect(retryRes.status).toBe('installed');
      expect(existsSync(join(home, '.codex', 'bin', 'codex'))).toBe(true);
      expect(existsSync(join(home, '.codex', 'bin', 'codex-code-mode-host'))).toBe(true);
      expect(existsSync(join(home, '.codex', 'codex-path', 'rg'))).toBe(true);
      expect(readFileSync(join(home, '.codex', 'codex-resources', 'new-asset.txt'), 'utf8')).toBe('new-asset');
      expect(readFileSync(join(home, '.codex', 'codex-resources', 'custom.txt'), 'utf8')).toBe('user-custom-data');
    } finally {
      await srv.close();
    }
  });

  it('routes HTTP/HTTPS via built-in Node proxy with zero undici dependency and fails closed when proxy breaks', async () => {
    // Static zero-dep guard: runtime installers never depend on undici
    const helperSrc = readFileSync(join(process.cwd(), 'src', 'node', 'cli-install-helpers.ts'), 'utf8');
    expect(helperSrc).not.toMatch(/['"]undici['"]/);

    const root = makeTempDir();
    const home = join(root, 'home');
    const claudePkg = resolveClaudePlatformPackage({ isMusl: false })!;
    const claudeTgz = buildTarGz([{ name: 'package/claude', content: '#!/bin/sh\necho "2.1.332"\n', mode: 0o755 }]);

    let directHits = 0;
    const originSrv = await startMockServer((req, res) => {
      directHits += 1;
      if (req.url === `/${claudePkg.startsWith('@') ? `@${encodeURIComponent(claudePkg.slice(1))}` : encodeURIComponent(claudePkg)}/latest`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '2.1.332', dist: { tarball: `${originSrv.url}/claude.tgz`, integrity: sriSha512(claudeTgz) } }));
        return;
      }
      if (req.url === '/claude.tgz') { res.end(claudeTgz); return; }
      res.statusCode = 404;
      res.end();
    });

    const proxyHits: string[] = [];
    const proxyAuthHeaders: string[] = [];
    const httpMod = await import('node:http');
    const proxySrv = await startMockServer((req, res) => {
      proxyHits.push(req.url ?? '');
      if (req.headers['proxy-authorization']) {
        proxyAuthHeaders.push(String(req.headers['proxy-authorization']));
      }
      const targetUrl = new URL(req.url!);
      const fwd = httpMod.request(targetUrl, { headers: req.headers }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      fwd.on('error', (err) => {
        res.statusCode = 502;
        res.end(String(err));
      });
      req.pipe(fwd);
    });

    try {
      const proxyRes = await installClaudeCli({
        homeDir: home,
        isMusl: false,
        env: { PATH: '', HTTP_PROXY: proxySrv.url.replace('http://', 'http://u:p@') },
        registry: originSrv.url,
        noFallback: true,
        verifyVersion: () => '2.1.332',
      });
      expect(proxyRes.status).toBe('installed');
      expect(proxyHits.length).toBeGreaterThanOrEqual(2);
      expect(proxyAuthHeaders.length).toBeGreaterThanOrEqual(2);
      expect(directHits).toBe(proxyHits.length);

      // Fail-closed: broken proxy must NEVER silently fall back to direct fetch
      const directBeforeBroken = directHits;
      const brokenHome = join(root, 'home-broken');
      const brokenRes = await installClaudeCli({
        homeDir: brokenHome,
        isMusl: false,
        env: { PATH: '', HTTP_PROXY: 'http://127.0.0.1:9' },
        registry: originSrv.url,
        noFallback: true,
        verifyVersion: () => '2.1.332',
      });
      expect(brokenRes.status).toBe('failed');
      expect(brokenRes.reason).toContain('proxy_');
      expect(directHits).toBe(directBeforeBroken);

      // Unsupported proxy scheme also fails closed without touching target
      const socksRes = await installClaudeCli({
        homeDir: join(root, 'home-socks'),
        isMusl: false,
        env: { PATH: '', HTTP_PROXY: 'socks5://127.0.0.1:1080' },
        registry: originSrv.url,
        noFallback: true,
        verifyVersion: () => '2.1.332',
      });
      expect(socksRes.status).toBe('failed');
      expect(socksRes.reason).toContain('proxy_unsupported_protocol');
      expect(directHits).toBe(directBeforeBroken);

      // Strict isolatedTest ignores HTTP_PROXY completely and rejects non-loopback URLs before fetch
      expect(() => validateDownloadUrl('https://registry.npmjs.org/a.tgz', 'https:', 'https://registry.npmjs.org', true))
        .toThrow('disallowed_non_loopback_isolated_origin');
      const nonLoopbackRes = await installClaudeCli({
        homeDir: join(root, 'home-iso-pub'),
        isMusl: false,
        env: { PATH: '', HTTP_PROXY: 'http://127.0.0.1:9' },
        registry: 'https://registry.npmjs.org',
        isolatedTest: true,
        noFallback: true,
      });
      expect(nonLoopbackRes.status).toBe('failed');
      expect(nonLoopbackRes.reason).toContain('disallowed_non_loopback_isolated_origin');

      const isoIgnoreProxyHitsBefore = proxyHits.length;
      const isoLoopbackRes = await installClaudeCli({
        homeDir: join(root, 'home-iso-ok'),
        isMusl: false,
        env: { PATH: '', HTTP_PROXY: 'http://127.0.0.1:9' },
        registry: originSrv.url,
        isolatedTest: true,
        noFallback: true,
        verifyVersion: () => '2.1.332',
      });
      expect(isoLoopbackRes.status).toBe('installed');
      expect(proxyHits.length).toBe(isoIgnoreProxyHitsBefore);
    } finally {
      await proxySrv.close();
      await originSrv.close();
    }
  });

  it('handles mid-stream WriteStream errors cleanly without unhandled crash and isolates failing CLIs from siblings', async () => {
    const root = makeTempDir();
    // 1. Delayed 2-chunk Web stream targeting nonexistent parent directory must reject cleanly without uncaughtException
    const payload = Buffer.from('hello-delayed-stream-payload');
    const sha512 = createHash('sha512').update(payload).digest('hex');
    const delayedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload.subarray(0, 10));
        setTimeout(() => {
          controller.enqueue(payload.subarray(10));
          controller.close();
        }, 30);
      },
    });
    const fakeRes = new Response(delayedStream, { status: 200 });
    const unwritableTarget = join(root, 'missing-parent-dir', 'payload.bin');
    await expect(
      downloadResponseToFileWithIntegrity(fakeRes, unwritableTarget, {
        maxBytes: 1024 * 1024,
        expectedSha512Hex: sha512,
      }),
    ).rejects.toThrow();

    // 2. Concurrent execution inside installDefaultAgentClis: symlinked .local/bin/claude fails claude ONLY
    //    while codex & agy still install concurrently without crashing or aborting
    const home = join(root, 'home');
    const decoyTarget = join(root, 'outside-decoy');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(decoyTarget, join(home, '.local', 'bin', 'claude'));

    const codexSuffix = resolveCodexPlatformSuffix()!;
    const codexSubVer = `0.172.0-${codexSuffix}`;
    const ocPkg = resolveOpenCodePlatformPackage({ isMusl: false })!;
    const agyPlatform = resolveAgyManifestPlatform({ isMusl: false })!;
    const ocTgz = buildTarGz([{ name: 'package/bin/opencode', content: '#!/bin/sh\necho "2.4.2"\n', mode: 0o755 }]);
    const codexTgz = buildTarGz([{ name: 'package/vendor/x86_64-unknown-linux-musl/bin/codex', content: '#!/bin/sh\necho "0.172.0"\n', mode: 0o755 }]);
    const agyBin = Buffer.from('#!/bin/sh\necho "0.9.0"\n');
    const agySha512 = createHash('sha512').update(agyBin).digest('hex');

    const slowOcResponses: ServerResponse[] = [];
    const srv = await startMockServer((req, res) => {
      if (req.url === `/${encodeURIComponent(ocPkg)}/latest`) {
        slowOcResponses.push(res);
        return;
      }
      if (req.url === '/@openai%2Fcodex/latest') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '0.172.0', optionalDependencies: { [`@openai/codex-${codexSuffix}`]: `npm:@openai/codex@${codexSubVer}` } }));
        return;
      }
      if (req.url === `/@openai%2Fcodex/${encodeURIComponent(codexSubVer)}`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: codexSubVer, dist: { tarball: `${srv.url}/codex.tgz`, integrity: sriSha512(codexTgz) } }));
        return;
      }
      if (req.url === '/codex.tgz') { res.end(codexTgz); return; }
      if (req.url === `/manifests/${agyPlatform}.json`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '0.9.0', url: `${srv.url}/agy-bin`, sha512: agySha512 }));
        return;
      }
      if (req.url === '/agy-bin') { res.end(agyBin); return; }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { results } = await installDefaultAgentClis({
        homeDir: home,
        isMusl: false,
        env: { PATH: '' },
        registry: srv.url,
        agyManifestBaseUrl: srv.url,
        noFallback: true,
        metadataTimeoutMs: 120,
        verifyVersion: () => '1.0.0',
      });
      expect(results.opencode?.status).toBe('failed');
      expect(results.claude?.status).toBe('failed');
      expect(results.claude?.reason).toContain('unsafe_symlink_target');
      expect(results.codex?.status).toBe('installed');
      expect(results.agy?.status).toBe('installed');
      expect(existsSync(decoyTarget)).toBe(false);
    } finally {
      for (const r of slowOcResponses) {
        try { r.destroy(); } catch { /* ignore */ }
      }
      await srv.close();
    }
  });

  it('aborts hung response body after headers arrive without stalling sibling CLIs', async () => {
    const root = makeTempDir();
    const home = join(root, 'home');
    const claudePkg = resolveClaudePlatformPackage({ isMusl: false })!;
    const claudeTgz = buildTarGz([{ name: 'package/claude', content: '#!/bin/sh\necho "2.1.332"\n', mode: 0o755 }]);

    const openSockets: ServerResponse[] = [];
    const headerHangOrigin = await startMockServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      res.write('{'); // send headers + 1 byte, then stall body forever!
      openSockets.push(res);
    });

    const headerHangProxy = await startMockServer((req, res) => {
      if (req.url?.includes('opencode') || req.url?.includes('manifests')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.flushHeaders();
        res.write('{"partial":'); // proxy sends headers immediately, hangs body forever
        openSockets.push(res);
        return;
      }
      const targetUrl = new URL(req.url!);
      const up = httpRequest(targetUrl, { headers: req.headers }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      });
      up.on('error', () => res.destroy());
      req.pipe(up);
    });

    const healthySrv = await startMockServer((req, res) => {
      if (req.url === `/${claudePkg.startsWith('@') ? `@${encodeURIComponent(claudePkg.slice(1))}` : encodeURIComponent(claudePkg)}/latest`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '2.1.332', dist: { tarball: `${healthySrv.url}/claude.tgz`, integrity: sriSha512(claudeTgz) } }));
        return;
      }
      if (req.url === '/claude.tgz') { res.end(claudeTgz); return; }
      res.statusCode = 404;
      res.end();
    });

    try {
      // Single hung-body proxied request must abort cleanly within bounded timeout
      const t0 = Date.now();
      const hungRes = await installAgyCli({
        homeDir: join(root, 'home-hung'),
        isMusl: false,
        env: { PATH: '', HTTP_PROXY: headerHangProxy.url },
        agyManifestBaseUrl: headerHangOrigin.url,
        noFallback: true,
        metadataTimeoutMs: 140,
      });
      const elapsed = Date.now() - t0;
      expect(hungRes.status).toBe('failed');
      expect(elapsed).toBeLessThan(1_500);

      // Healthy Claude sibling installs while OpenCode & Agy hang mid-body behind proxy
      const t1 = Date.now();
      const { results } = await installDefaultAgentClis({
        homeDir: home,
        isMusl: false,
        only: ['opencode', 'claude', 'agy'],
        env: { PATH: '', HTTP_PROXY: headerHangProxy.url },
        registry: healthySrv.url,
        agyManifestBaseUrl: headerHangOrigin.url,
        noFallback: true,
        metadataTimeoutMs: 140,
        verifyVersion: () => '2.1.332',
      });
      expect(Date.now() - t1).toBeLessThan(2_000);
      expect(results.claude?.status).toBe('installed');
      expect(results.opencode?.status).toBe('failed');
      expect(results.agy?.status).toBe('failed');
    } finally {
      for (const s of openSockets) {
        try { s.destroy(); } catch { /* ignore */ }
      }
      await headerHangProxy.close();
      await headerHangOrigin.close();
      await healthySrv.close();
    }
  });

  it('tunnels HTTPS via CONNECT for HTTPS_PROXY and HTTP_PROXY-only, isolates NODE_USE_ENV_PROXY, and coordinates two-process Codex publish lock', async () => {
    const execFileAsync = promisify(execFile);
    const root = makeTempDir();
    const { build } = await import('esbuild');

    // Transpile live src/ into an isolated directory with ZERO node_modules, preserving
    // separate module URLs identically to the compiled desktop daemon-runtime package.
    const strippedDir = join(root, 'stripped-runtime');
    mkdirSync(strippedDir, { recursive: true });
    writeFileSync(join(strippedDir, 'package.json'), JSON.stringify({ name: 'stripped-runtime', type: 'module' }));
    await build({
      entryPoints: [
        join(process.cwd(), 'src', 'node', 'install-default-agent-clis.ts'),
        join(process.cwd(), 'src', 'node', 'install-opencode-cli.ts'),
        join(process.cwd(), 'src', 'node', 'cli-install-helpers.ts'),
        join(process.cwd(), 'src', 'util', 'imcodes-state-dir.ts'),
        join(process.cwd(), 'src', 'util', 'windows-daemon-lock.ts'),
        join(process.cwd(), 'shared', 'imcodes-home-env.ts'),
      ],
      outdir: strippedDir,
      outbase: process.cwd(),
      bundle: false,
      platform: 'node',
      format: 'esm',
    });
    writeFileSync(
      join(strippedDir, 'src', 'util', 'windows-daemon-watchdog.mjs'),
      readFileSync(join(process.cwd(), 'src', 'util', 'windows-daemon-watchdog.mjs')),
    );
    const bundledDefaultPath = join(strippedDir, 'src', 'node', 'install-default-agent-clis.js');
    const bundledOcPath = join(strippedDir, 'src', 'node', 'install-opencode-cli.js');

    // Generate self-signed RSA cert for 127.0.0.1
    const keyPath = join(root, 'srv-key.pem');
    const certPath = join(root, 'srv-cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    ], { stdio: 'ignore' });

    const codexSuffix = resolveCodexPlatformSuffix()!;
    const codexSubVer = `0.172.0-${codexSuffix}`;
    const targetTriple = codexSuffix === 'darwin-arm64'
      ? 'aarch64-apple-darwin'
      : codexSuffix === 'darwin-x64'
        ? 'x86_64-apple-darwin'
        : 'x86_64-unknown-linux-musl';
    const ocPkg = resolveOpenCodePlatformPackage({ isMusl: false })!;
    const claudePkg = resolveClaudePlatformPackage({ isMusl: false })!;
    const agyPlatform = resolveAgyManifestPlatform({ isMusl: false })!;

    const ocTgz = buildTarGz([{ name: 'package/bin/opencode', content: '#!/bin/sh\necho "2.4.2"\n', mode: 0o755 }]);
    const codexTgz = buildTarGz([
      { name: `package/vendor/${targetTriple}/bin/codex`, content: '#!/bin/sh\necho "0.172.0"\n', mode: 0o755 },
      { name: `package/vendor/${targetTriple}/bin/codex-code-mode-host`, content: '#!/bin/sh\necho host\n', mode: 0o755 },
      { name: `package/vendor/${targetTriple}/codex-path/rg`, content: 'rg', mode: 0o755 },
      { name: `package/vendor/${targetTriple}/codex-resources/asset.txt`, content: 'asset', mode: 0o644 },
    ]);
    const claudeTgz = buildTarGz([{ name: 'package/claude', content: '#!/bin/sh\necho "2.1.332"\n', mode: 0o755 }]);
    const agyBin = Buffer.from('#!/bin/sh\necho "0.9.0"\n');

    let httpsHits = 0;
    const httpsSrv = https.createServer(
      { key: readFileSync(keyPath), cert: readFileSync(certPath) },
      (req, res) => {
        httpsHits += 1;
        const base = `https://127.0.0.1:${(httpsSrv.address() as net.AddressInfo).port}`;
        if (req.url === `/${claudePkg.startsWith('@') ? `@${encodeURIComponent(claudePkg.slice(1))}` : encodeURIComponent(claudePkg)}/latest`) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ version: '2.1.332', dist: { tarball: `${base}/claude.tgz`, integrity: sriSha512(claudeTgz) } }));
          return;
        }
        if (req.url === '/claude.tgz') { res.end(claudeTgz); return; }
        res.statusCode = 404;
        res.end();
      },
    );
    await new Promise<void>((resolve) => httpsSrv.listen(0, '127.0.0.1', () => resolve()));
    const httpsOrigin = `https://127.0.0.1:${(httpsSrv.address() as net.AddressInfo).port}`;

    let connectCount = 0;
    let proxyHttpCount = 0;
    const activeTunnels = new Set<net.Socket>();
    const connectProxy = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const s = createServer((req, res) => {
        proxyHttpCount += 1;
        const u = new URL(req.url!);
        const fwd = httpRequest(u, { headers: req.headers }, (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        });
        fwd.on('error', () => res.destroy());
        req.pipe(fwd);
      });
      s.on('connect', (req, clientSock, head) => {
        connectCount += 1;
        const [host, portStr] = String(req.url).split(':');
        const cs = clientSock as net.Socket;
        activeTunnels.add(cs);
        cs.once('close', () => activeTunnels.delete(cs));
        const upstream = net.connect({ host, port: Number(portStr) || 443 }, () => {
          cs.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length > 0) upstream.write(head);
          upstream.pipe(cs);
          cs.pipe(upstream);
        });
        activeTunnels.add(upstream);
        upstream.once('close', () => activeTunnels.delete(upstream));
        upstream.on('error', () => cs.destroy());
        cs.on('error', () => upstream.destroy());
      });
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address() as net.AddressInfo;
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise((r) => {
            for (const sock of activeTunnels) {
              try { sock.destroy(); } catch { /* ignore */ }
            }
            s.closeAllConnections?.();
            s.close(() => r());
          }),
        });
      });
    });

    const httpSrv = await startMockServer((req, res) => {
      if (req.url === `/${encodeURIComponent(ocPkg)}/latest`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '2.4.2', dist: { tarball: `${httpSrv.url}/oc.tgz`, integrity: sriSha512(ocTgz) } }));
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
        res.end(JSON.stringify({ version: codexSubVer, dist: { tarball: `${httpSrv.url}/codex.tgz`, integrity: sriSha512(codexTgz) } }));
        return;
      }
      if (req.url === '/codex.tgz') { res.end(codexTgz); return; }
      if (req.url === `/manifests/${agyPlatform}.json`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '0.9.0', url: `${httpSrv.url}/agy`, sha512: createHash('sha512').update(agyBin).digest('hex') }));
        return;
      }
      if (req.url === '/agy') { res.end(agyBin); return; }
      res.statusCode = 404;
      res.end();
    });

    try {
      // 1a. HTTPS_PROXY -> CONNECT tunnel over HTTPS origin inside stripped runtime (no node_modules!)
      const homeHttpsProxy = join(root, 'home-https-proxy');
      await execFileAsync(
        process.execPath,
        [bundledDefaultPath, '--home', homeHttpsProxy, '--only', 'claude', '--registry', httpsOrigin, '--no-fallback', '--strict'],
        { cwd: strippedDir, env: { PATH: '', HOME: homeHttpsProxy, HTTPS_PROXY: connectProxy.url, NODE_EXTRA_CA_CERTS: certPath } },
      );
      expect(existsSync(join(homeHttpsProxy, '.local', 'bin', 'claude'))).toBe(true);
      expect(connectCount).toBeGreaterThanOrEqual(2);
      const connectsAfterHttps = connectCount;

      // 1b. HTTP_PROXY only (NO HTTPS_PROXY) still tunnels HTTPS via CONNECT
      const homeHttpOnlyProxy = join(root, 'home-http-only-proxy');
      await execFileAsync(
        process.execPath,
        [bundledDefaultPath, '--home', homeHttpOnlyProxy, '--only', 'claude', '--registry', httpsOrigin, '--no-fallback', '--strict'],
        { cwd: strippedDir, env: { PATH: '', HOME: homeHttpOnlyProxy, HTTP_PROXY: connectProxy.url, NODE_EXTRA_CA_CERTS: certPath } },
      );
      expect(existsSync(join(homeHttpOnlyProxy, '.local', 'bin', 'claude'))).toBe(true);
      expect(connectCount).toBeGreaterThanOrEqual(connectsAfterHttps + 2);

      // 1c. Broken HTTPS_PROXY fails closed with 0 hits to HTTPS origin
      const hitsBeforeDead = httpsHits;
      const homeDeadProxy = join(root, 'home-dead-proxy');
      const deadProc = await execFileAsync(
        process.execPath,
        [bundledDefaultPath, '--home', homeDeadProxy, '--only', 'claude', '--registry', httpsOrigin, '--no-fallback', '--strict'],
        { cwd: strippedDir, env: { PATH: '', HOME: homeDeadProxy, HTTPS_PROXY: 'http://127.0.0.1:9', NODE_EXTRA_CA_CERTS: certPath } },
      ).then(() => ({ failed: false }), () => ({ failed: true }));
      expect(deadProc.failed).toBe(true);
      expect(httpsHits).toBe(hitsBeforeDead);

      // 2. NODE_USE_ENV_PROXY=1 must NOT leak isolatedTest loopback traffic into HTTP_PROXY/HTTPS_PROXY (both installDefaultAgentClis & installOpenCodeCli)
      const connectsBeforeIso = connectCount;
      const httpProxyBeforeIso = proxyHttpCount;
      const homeIsoNodeProxy = join(root, 'home-iso-node-env-proxy');
      await execFileAsync(
        process.execPath,
        [bundledDefaultPath, '--home', homeIsoNodeProxy, '--only', 'codex,opencode,agy', '--registry', httpSrv.url, '--agy-manifest-base-url', httpSrv.url, '--isolated-test', '--strict'],
        {
          cwd: strippedDir,
          timeout: 5_000,
          env: {
            PATH: '',
            HOME: homeIsoNodeProxy,
            NODE_USE_ENV_PROXY: '1',
            HTTP_PROXY: connectProxy.url,
            HTTPS_PROXY: connectProxy.url,
          },
        },
      );
      expect(existsSync(join(homeIsoNodeProxy, '.codex', 'bin', 'codex'))).toBe(true);
      expect(existsSync(join(homeIsoNodeProxy, '.opencode', 'bin', 'opencode'))).toBe(true);
      expect(existsSync(join(homeIsoNodeProxy, '.local', 'bin', 'agy'))).toBe(true);

      const homeIsoOc = join(root, 'home-iso-oc-env-proxy');
      await execFileAsync(
        process.execPath,
        [bundledOcPath, '--home', homeIsoOc, '--registry', httpSrv.url, '--isolated-test', '--strict'],
        {
          cwd: strippedDir,
          timeout: 5_000,
          env: {
            PATH: '',
            HOME: homeIsoOc,
            NODE_USE_ENV_PROXY: '1',
            HTTP_PROXY: connectProxy.url,
            HTTPS_PROXY: connectProxy.url,
          },
        },
      );
      expect(existsSync(join(homeIsoOc, '.opencode', 'bin', 'opencode'))).toBe(true);
      expect(connectCount).toBe(connectsBeforeIso);
      expect(proxyHttpCount).toBe(httpProxyBeforeIso);

      // 3. Two independent concurrent OS processes installing Codex into the same home:
      //    loser must wait on .codex-publish.lock, see existing binary, and NEVER delete winner's sibling files!
      const sharedHome = join(root, 'home-two-proc');
      const [r1, r2] = await Promise.all([
        execFileAsync(
          process.execPath,
          [bundledDefaultPath, '--home', sharedHome, '--only', 'codex', '--registry', httpSrv.url, '--no-fallback', '--strict'],
          { cwd: strippedDir, env: { PATH: '', HOME: sharedHome } },
        ),
        execFileAsync(
          process.execPath,
          [bundledDefaultPath, '--home', sharedHome, '--only', 'codex', '--registry', httpSrv.url, '--no-fallback', '--strict'],
          { cwd: strippedDir, env: { PATH: '', HOME: sharedHome } },
        ),
      ]);
      const combinedOut = `${r1.stdout}\n${r2.stdout}`;
      expect(combinedOut).toContain('codex:installed(');
      expect(combinedOut).toContain('codex:existing(');
      expect(existsSync(join(sharedHome, '.codex', 'bin', 'codex'))).toBe(true);
      expect(existsSync(join(sharedHome, '.codex', 'bin', 'codex-code-mode-host'))).toBe(true);
      expect(existsSync(join(sharedHome, '.codex', 'codex-path', 'rg'))).toBe(true);
      expect(existsSync(join(sharedHome, '.codex', 'codex-resources', 'asset.txt'))).toBe(true);
      expect(existsSync(join(sharedHome, '.codex', '.codex-publish.lock'))).toBe(false);

      // 3b. Interleaved failure/success race: A stalls & fails inside sibling link while B starts concurrently;
      //     lock ensures A rolls back cleanly before B publishes, leaving B's binary & siblings intact!
      const raceHome = join(root, 'home-two-proc-interleave');
      const fsMod = await import('node:fs');
      const resA = installCodexCli({
        homeDir: raceHome,
        env: { PATH: '' },
        registry: httpSrv.url,
        noFallback: true,
        verifyVersion: () => {
          // Burn ~80ms in synchronous probe, then fail during sibling link after B already started downloading
          const start = Date.now();
          while (Date.now() - start < 80) { /* spin */ }
          return '0.172.0';
        },
        linkFile: (src, dst) => {
          if (dst.endsWith('asset.txt')) throw new Error('simulated_race_a_fail');
          fsMod.linkSync(src, dst);
        },
      });
      const resB = new Promise<Awaited<ReturnType<typeof installCodexCli>>>((resolve) => {
        setTimeout(() => {
          resolve(installCodexCli({
            homeDir: raceHome,
            env: { PATH: '' },
            registry: httpSrv.url,
            noFallback: true,
            verifyVersion: () => '0.172.0',
          }));
        }, 20);
      });
      const [outA, outB] = await Promise.all([resA, resB]);
      expect([outA.status, outB.status].sort()).toEqual(['failed', 'installed']);
      expect(existsSync(join(raceHome, '.codex', 'bin', 'codex'))).toBe(true);
      expect(existsSync(join(raceHome, '.codex', 'bin', 'codex-code-mode-host'))).toBe(true);
      expect(existsSync(join(raceHome, '.codex', 'codex-path', 'rg'))).toBe(true);
      expect(existsSync(join(raceHome, '.codex', 'codex-resources', 'asset.txt'))).toBe(true);
    } finally {
      await connectProxy.close();
      httpsSrv.closeAllConnections?.();
      await new Promise<void>((resolve) => httpsSrv.close(() => resolve()));
      await httpSrv.close();
    }
  }, 30_000);
});
