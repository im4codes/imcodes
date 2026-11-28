import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

function createSelfSignedLoopbackCert(): { keyPem: string; certPem: string } {
  const derLen = (n: number): Buffer => {
    if (n < 0x80) return Buffer.from([n]);
    const bytes: number[] = [];
    let v = n;
    while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  };
  const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
  };
  const derInt = (buf: Buffer): Buffer => tlv(0x02, (buf[0]! & 0x80) ? Buffer.concat([Buffer.from([0]), buf]) : buf);
  const derOid = (bytes: number[]): Buffer => tlv(0x06, Buffer.from(bytes));
  const oidSha256Rsa = derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]);
  const oidCn = derOid([0x55, 0x04, 0x03]);
  const oidSan = derOid([0x55, 0x1d, 0x11]);
  const oidBasic = derOid([0x55, 0x1d, 0x13]);

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const algId = tlv(0x30, oidSha256Rsa, Buffer.from([0x05, 0x00]));
  const name = tlv(0x30, tlv(0x31, tlv(0x30, oidCn, tlv(0x0c, Buffer.from('127.0.0.1')))));
  const validity = tlv(0x30, tlv(0x17, Buffer.from('250101000000Z')), tlv(0x17, Buffer.from('350101000000Z')));
  const sanExt = tlv(0x30, oidSan, tlv(0x04, tlv(0x30, Buffer.from([0x87, 4, 127, 0, 0, 1]))));
  const basicExt = tlv(0x30, oidBasic, Buffer.from([0x01, 0x01, 0xff]), tlv(0x04, tlv(0x30, Buffer.from([0x01, 0x01, 0xff]))));
  const tbs = tlv(0x30, tlv(0xa0, derInt(Buffer.from([2]))), derInt(Buffer.from([1])), algId, name, validity, name, spki, tlv(0xa3, tlv(0x30, sanExt, basicExt)));
  const sig = sign('sha256', tbs, privateKey);
  const certDer = tlv(0x30, tbs, algId, tlv(0x03, Buffer.from([0]), sig));
  const certPem = `-----BEGIN CERTIFICATE-----\n${certDer.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  return { keyPem, certPem };
}

async function transpileStrippedRuntime(targetDir: string): Promise<{
  defaultModUrl: string;
  openCodeModUrl: string;
  helpersModUrl: string;
  defaultCliPath: string;
  openCodeCliPath: string;
}> {
  const { build } = await import('esbuild');
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'package.json'), JSON.stringify({ name: 'stripped-runtime', type: 'module' }));
  await build({
    entryPoints: [
      join(process.cwd(), 'src', 'node', 'install-default-agent-clis.ts'),
      join(process.cwd(), 'src', 'node', 'install-opencode-cli.ts'),
      join(process.cwd(), 'src', 'node', 'cli-install-helpers.ts'),
      join(process.cwd(), 'src', 'util', 'imcodes-state-dir.ts'),
      join(process.cwd(), 'src', 'util', 'windows-daemon-lock.ts'),
      join(process.cwd(), 'src', 'util', 'suppress-sqlite-warning.ts'),
      join(process.cwd(), 'shared', 'imcodes-home-env.ts'),
    ],
    outdir: targetDir,
    outbase: process.cwd(),
    bundle: false,
    platform: 'node',
    format: 'esm',
  });
  writeFileSync(
    join(targetDir, 'src', 'util', 'windows-daemon-watchdog.mjs'),
    readFileSync(join(process.cwd(), 'src', 'util', 'windows-daemon-watchdog.mjs')),
  );
  const defaultCliPath = join(targetDir, 'src', 'node', 'install-default-agent-clis.js');
  const openCodeCliPath = join(targetDir, 'src', 'node', 'install-opencode-cli.js');
  const helpersPath = join(targetDir, 'src', 'node', 'cli-install-helpers.js');
  return {
    defaultCliPath,
    openCodeCliPath,
    defaultModUrl: pathToFileURL(defaultCliPath).href,
    openCodeModUrl: pathToFileURL(openCodeCliPath).href,
    helpersModUrl: pathToFileURL(helpersPath).href,
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

  it('tunnels HTTPS via CONNECT for HTTPS_PROXY and HTTP_PROXY-only, fails closed on proxy break, and isolates NODE_USE_ENV_PROXY in stripped runtime across all platforms', async () => {
    const execFileAsync = promisify(execFile);
    const root = makeTempDir();
    const strippedDir = join(root, 'stripped-runtime');
    const rt = await transpileStrippedRuntime(strippedDir);
    const { keyPem, certPem } = createSelfSignedLoopbackCert();
    const certPath = join(root, 'srv-cert.pem');
    writeFileSync(certPath, certPem);

    const ocTgz = buildTarGz([{ name: 'package/bin/opencode', content: 'oc-bin', mode: 0o755 }]);
    const codexTgz = buildTarGz([{ name: 'package/vendor/x86_64-unknown-linux-musl/bin/codex', content: 'codex-bin', mode: 0o755 }]);
    const claudeTgz = buildTarGz([{ name: 'package/claude', content: 'claude-bin', mode: 0o755 }]);
    const agyBin = Buffer.from('agy-bin');

    let httpsHits = 0;
    const httpsSrv = https.createServer(
      { key: keyPem, cert: certPem },
      (req, res) => {
        httpsHits += 1;
        res.setHeader('connection', 'close');
        const base = `https://127.0.0.1:${(httpsSrv.address() as net.AddressInfo).port}`;
        if (req.url === '/@anthropic-ai%2Fclaude-code-linux-x64/latest') {
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
      res.setHeader('connection', 'close');
      if (req.url === '/opencode-linux-x64/latest') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '2.4.2', dist: { tarball: `${httpSrv.url}/oc.tgz`, integrity: sriSha512(ocTgz) } }));
        return;
      }
      if (req.url === '/oc.tgz') { res.end(ocTgz); return; }
      if (req.url === '/@openai%2Fcodex/latest') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '0.172.0', optionalDependencies: { '@openai/codex-linux-x64': 'npm:@openai/codex@0.172.0-linux-x64' } }));
        return;
      }
      if (req.url === '/@openai%2Fcodex/0.172.0-linux-x64') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '0.172.0-linux-x64', dist: { tarball: `${httpSrv.url}/codex.tgz`, integrity: sriSha512(codexTgz) } }));
        return;
      }
      if (req.url === '/codex.tgz') { res.end(codexTgz); return; }
      if (req.url === '/manifests/linux_amd64.json') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '0.9.0', url: `${httpSrv.url}/agy`, sha512: hexSha512(agyBin) }));
        return;
      }
      if (req.url === '/agy') { res.end(agyBin); return; }
      res.statusCode = 404;
      res.end();
    });

    try {
      // 1a. HTTPS_PROXY -> CONNECT tunnel over HTTPS origin inside stripped runtime (platform-neutral fixture)
      const homeHttps = join(root, 'home-https');
      const r1 = await execFileAsync(
        process.execPath,
        [
          '--input-type=module', '-e',
          `const { installClaudeCli } = await import(${JSON.stringify(rt.defaultModUrl)});
           const res = await installClaudeCli({ homeDir: ${JSON.stringify(homeHttps)}, platform: 'linux', arch: 'x64', isMusl: false, env: { PATH: '', HTTPS_PROXY: ${JSON.stringify(connectProxy.url)} }, registry: ${JSON.stringify(httpsOrigin)}, noFallback: true, verifyVersion: () => '2.1.332' });
           console.log(JSON.stringify(res));`,
        ],
        { cwd: strippedDir, env: { PATH: '', NODE_EXTRA_CA_CERTS: certPath } },
      );
      expect(JSON.parse(r1.stdout.trim()).status).toBe('installed');
      expect(connectCount).toBeGreaterThanOrEqual(2);
      const connectsAfterHttps = connectCount;

      // 1b. HTTP_PROXY only (no HTTPS_PROXY) still tunnels HTTPS via CONNECT
      const homeHttpOnly = join(root, 'home-http-only');
      const r2 = await execFileAsync(
        process.execPath,
        [
          '--input-type=module', '-e',
          `const { installClaudeCli } = await import(${JSON.stringify(rt.defaultModUrl)});
           const res = await installClaudeCli({ homeDir: ${JSON.stringify(homeHttpOnly)}, platform: 'linux', arch: 'x64', isMusl: false, env: { PATH: '', HTTP_PROXY: ${JSON.stringify(connectProxy.url)} }, registry: ${JSON.stringify(httpsOrigin)}, noFallback: true, verifyVersion: () => '2.1.332' });
           console.log(JSON.stringify(res));`,
        ],
        { cwd: strippedDir, env: { PATH: '', NODE_EXTRA_CA_CERTS: certPath } },
      );
      expect(JSON.parse(r2.stdout.trim()).status).toBe('installed');
      expect(connectCount).toBeGreaterThanOrEqual(connectsAfterHttps + 2);

      // 1c. Dead HTTPS_PROXY fails closed with 0 hits to HTTPS origin
      const hitsBeforeDead = httpsHits;
      const homeDead = join(root, 'home-dead');
      const r3 = await execFileAsync(
        process.execPath,
        [
          '--input-type=module', '-e',
          `const { installClaudeCli } = await import(${JSON.stringify(rt.defaultModUrl)});
           const res = await installClaudeCli({ homeDir: ${JSON.stringify(homeDead)}, platform: 'linux', arch: 'x64', isMusl: false, env: { PATH: '', HTTPS_PROXY: 'http://127.0.0.1:9' }, registry: ${JSON.stringify(httpsOrigin)}, noFallback: true, verifyVersion: () => '2.1.332' });
           console.log(JSON.stringify(res));`,
        ],
        { cwd: strippedDir, env: { PATH: '', NODE_EXTRA_CA_CERTS: certPath } },
      );
      const parsedDead = JSON.parse(r3.stdout.trim()) as { status: string; reason?: string };
      expect(parsedDead.status).toBe('failed');
      expect(parsedDead.reason).toContain('proxy_');
      expect(httpsHits).toBe(hitsBeforeDead);

      // 2. NODE_USE_ENV_PROXY=1 must NOT leak isolatedTest loopback traffic across compiled helpers or OpenCode
      const connectsBeforeIso = connectCount;
      const httpProxyBeforeIso = proxyHttpCount;
      const homeIsoAll = join(root, 'home-iso-all');
      const r4 = await execFileAsync(
        process.execPath,
        [
          '--input-type=module', '-e',
          `const { installDefaultAgentClis } = await import(${JSON.stringify(rt.defaultModUrl)});
           const res = await installDefaultAgentClis({ homeDir: ${JSON.stringify(homeIsoAll)}, only: ['codex', 'opencode', 'agy'], platform: 'linux', arch: 'x64', isMusl: false, env: { PATH: '' }, registry: ${JSON.stringify(httpSrv.url)}, agyManifestBaseUrl: ${JSON.stringify(httpSrv.url)}, isolatedTest: true, noFallback: true, verifyVersion: () => '1.0.0' });
           console.log(JSON.stringify(res));`,
        ],
        {
          cwd: strippedDir,
          env: { PATH: '', NODE_USE_ENV_PROXY: '1', HTTP_PROXY: connectProxy.url, HTTPS_PROXY: connectProxy.url },
        },
      );
      const isoResults = (JSON.parse(r4.stdout.trim()) as { results: Record<string, { status: string }> }).results;
      expect(isoResults.codex?.status).toBe('installed');
      expect(isoResults.opencode?.status).toBe('installed');
      expect(isoResults.agy?.status).toBe('installed');

      const homeIsoOc = join(root, 'home-iso-oc');
      const r5 = await execFileAsync(
        process.execPath,
        [
          '--input-type=module', '-e',
          `const { installOpenCodeCli } = await import(${JSON.stringify(rt.openCodeModUrl)});
           const res = await installOpenCodeCli({ homeDir: ${JSON.stringify(homeIsoOc)}, platform: 'linux', arch: 'x64', isMusl: false, env: { PATH: '' }, registry: ${JSON.stringify(httpSrv.url)}, isolatedTest: true, noFallback: true, verifyVersion: () => '2.4.2' });
           console.log(JSON.stringify(res));`,
        ],
        {
          cwd: strippedDir,
          env: { PATH: '', NODE_USE_ENV_PROXY: '1', HTTP_PROXY: connectProxy.url, HTTPS_PROXY: connectProxy.url },
        },
      );
      expect(JSON.parse(r5.stdout.trim()).status).toBe('installed');
      expect(connectCount).toBe(connectsBeforeIso);
      expect(proxyHttpCount).toBe(httpProxyBeforeIso);
    } finally {
      await connectProxy.close();
      httpsSrv.closeAllConnections?.();
      await new Promise<void>((resolve) => httpsSrv.close(() => resolve()));
      await httpSrv.close();
    }
  });

  it.skipIf(process.platform === 'win32')('runs POSIX CLI entrypoints end-to-end across CONNECT proxy and NODE_USE_ENV_PROXY isolation', async () => {
    const execFileAsync = promisify(execFile);
    const root = makeTempDir();
    const rt = await transpileStrippedRuntime(join(root, 'stripped-posix'));
    const { keyPem, certPem } = createSelfSignedLoopbackCert();
    const certPath = join(root, 'srv-cert.pem');
    writeFileSync(certPath, certPem);

    const ocPkg = resolveOpenCodePlatformPackage({ isMusl: false })!;
    const claudePkg = resolveClaudePlatformPackage({ isMusl: false })!;
    const codexSuffix = resolveCodexPlatformSuffix()!;
    const codexSubVer = `0.172.0-${codexSuffix}`;
    const agyPlatform = resolveAgyManifestPlatform({ isMusl: false })!;

    const ocTgz = buildTarGz([{ name: 'package/bin/opencode', content: '#!/bin/sh\necho "2.4.2"\n', mode: 0o755 }]);
    const codexTgz = buildTarGz([{ name: 'package/vendor/x/bin/codex', content: '#!/bin/sh\necho "0.172.0"\n', mode: 0o755 }]);
    const claudeTgz = buildTarGz([{ name: 'package/claude', content: '#!/bin/sh\necho "2.1.332"\n', mode: 0o755 }]);
    const agyBin = Buffer.from('#!/bin/sh\necho "0.9.0"\n');

    const httpsSrv = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
      res.setHeader('connection', 'close');
      const base = `https://127.0.0.1:${(httpsSrv.address() as net.AddressInfo).port}`;
      if (req.url === `/${encodeURIComponent(claudePkg).replace('%40', '@')}/latest` || req.url === `/${claudePkg.startsWith('@') ? `@${encodeURIComponent(claudePkg.slice(1))}` : encodeURIComponent(claudePkg)}/latest`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '2.1.332', dist: { tarball: `${base}/claude.tgz`, integrity: sriSha512(claudeTgz) } }));
        return;
      }
      if (req.url === '/claude.tgz') { res.end(claudeTgz); return; }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => httpsSrv.listen(0, '127.0.0.1', () => resolve()));
    const httpsOrigin = `https://127.0.0.1:${(httpsSrv.address() as net.AddressInfo).port}`;

    let connectCount = 0;
    const activeTunnels = new Set<net.Socket>();
    const connectProxy = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const s = createServer((_req, res) => { res.statusCode = 405; res.end(); });
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
      res.setHeader('connection', 'close');
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
        res.end(JSON.stringify({ version: '0.9.0', url: `${httpSrv.url}/agy`, sha512: hexSha512(agyBin) }));
        return;
      }
      if (req.url === '/agy') { res.end(agyBin); return; }
      res.statusCode = 404;
      res.end();
    });

    try {
      const homeProxy = join(root, 'home-posix-proxy');
      await execFileAsync(
        process.execPath,
        [rt.defaultCliPath, '--home', homeProxy, '--only', 'claude', '--registry', httpsOrigin, '--no-fallback', '--strict'],
        { env: { PATH: '', HOME: homeProxy, HTTPS_PROXY: connectProxy.url, NODE_EXTRA_CA_CERTS: certPath } },
      );
      expect(existsSync(join(homeProxy, '.local', 'bin', 'claude'))).toBe(true);
      const connectsBeforeIso = connectCount;

      const homeIso = join(root, 'home-posix-iso');
      await execFileAsync(
        process.execPath,
        [rt.defaultCliPath, '--home', homeIso, '--only', 'codex,opencode,agy', '--registry', httpSrv.url, '--agy-manifest-base-url', httpSrv.url, '--isolated-test', '--strict'],
        { env: { PATH: '', HOME: homeIso, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: connectProxy.url, HTTP_PROXY: connectProxy.url } },
      );
      expect(existsSync(join(homeIso, '.codex', 'bin', 'codex'))).toBe(true);
      expect(existsSync(join(homeIso, '.opencode', 'bin', 'opencode'))).toBe(true);
      expect(existsSync(join(homeIso, '.local', 'bin', 'agy'))).toBe(true);

      const homeIsoOc = join(root, 'home-posix-iso-oc');
      await execFileAsync(
        process.execPath,
        [rt.openCodeCliPath, '--home', homeIsoOc, '--registry', httpSrv.url, '--isolated-test', '--strict'],
        { env: { PATH: '', HOME: homeIsoOc, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: connectProxy.url, HTTP_PROXY: connectProxy.url } },
      );
      expect(existsSync(join(homeIsoOc, '.opencode', 'bin', 'opencode'))).toBe(true);
      expect(connectCount).toBe(connectsBeforeIso);
    } finally {
      await connectProxy.close();
      httpsSrv.closeAllConnections?.();
      await new Promise<void>((resolve) => httpsSrv.close(() => resolve()));
      await httpSrv.close();
    }
  });

  it('serializes multi-process Codex publish via kernel lock, never double-rolls-back after lock release, and never steals held aged locks', async () => {
    const execFileAsync = promisify(execFile);
    const root = makeTempDir();
    const rt = await transpileStrippedRuntime(join(root, 'stripped-lock'));

    const codexTgz = buildTarGz([
      { name: 'package/vendor/x86_64-unknown-linux-musl/bin/codex', content: 'codex-bin', mode: 0o755 },
      { name: 'package/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host', content: 'host-bin', mode: 0o755 },
      { name: 'package/vendor/x86_64-unknown-linux-musl/codex-path/rg', content: 'rg', mode: 0o755 },
      { name: 'package/vendor/x86_64-unknown-linux-musl/codex-resources/asset.txt', content: 'asset', mode: 0o644 },
    ]);
    const srv = await startMockServer((req, res) => {
      res.setHeader('connection', 'close');
      if (req.url === '/@openai%2Fcodex/latest') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '0.172.0', optionalDependencies: { '@openai/codex-linux-x64': 'npm:@openai/codex@0.172.0-linux-x64' } }));
        return;
      }
      if (req.url === '/@openai%2Fcodex/0.172.0-linux-x64') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '0.172.0-linux-x64', dist: { tarball: `${srv.url}/codex.tgz`, integrity: sriSha512(codexTgz) } }));
        return;
      }
      if (req.url === '/codex.tgz') { res.end(codexTgz); return; }
      res.statusCode = 404;
      res.end();
    });

    try {
      // 1. Two independent OS processes succeeding concurrently: winner installs, loser sees existing
      const sharedHome = join(root, 'home-two-proc');
      const runInstallProc = (extraScript: string) => execFileAsync(
        process.execPath,
        [
          '--input-type=module', '-e',
          `const { installCodexCli } = await import(${JSON.stringify(rt.defaultModUrl)});
           ${extraScript}`,
        ],
        { cwd: root, env: { PATH: '' } },
      );

      const [okA, okB] = await Promise.all([
        runInstallProc(`const r = await installCodexCli({ homeDir: ${JSON.stringify(sharedHome)}, platform: 'linux', arch: 'x64', env: { PATH: '' }, registry: ${JSON.stringify(srv.url)}, noFallback: true, verifyVersion: () => '0.172.0' }); console.log(JSON.stringify(r));`),
        runInstallProc(`const r = await installCodexCli({ homeDir: ${JSON.stringify(sharedHome)}, platform: 'linux', arch: 'x64', env: { PATH: '' }, registry: ${JSON.stringify(srv.url)}, noFallback: true, verifyVersion: () => '0.172.0' }); console.log(JSON.stringify(r));`),
      ]);
      const statuses = [JSON.parse(okA.stdout.trim()).status, JSON.parse(okB.stdout.trim()).status].sort();
      expect(statuses).toEqual(['existing', 'installed']);
      expect(existsSync(join(sharedHome, '.codex', 'bin', 'codex'))).toBe(true);
      expect(existsSync(join(sharedHome, '.codex', 'bin', 'codex-code-mode-host'))).toBe(true);
      expect(existsSync(join(sharedHome, '.codex', 'codex-path', 'rg'))).toBe(true);
      expect(existsSync(join(sharedHome, '.codex', 'codex-resources', 'asset.txt'))).toBe(true);

      // 2. Interleaved failure/success across TWO OS PROCESSES:
      //    Process A fails in sibling publish, rolls back ONCE inside lock, releases lock, then PAUSES
      //    inside outer catch's logger.warn while Process B enters lock and installs everything cleanly!
      //    When A resumes/exits outer catch, it MUST NOT delete B's published siblings.
      const raceHome = join(root, 'home-two-proc-postlock-delay');
      const releasedMarker = join(root, 'a-released.flag');
      const procA = runInstallProc(`
        import fs from 'node:fs';
        const r = await installCodexCli({
          homeDir: ${JSON.stringify(raceHome)},
          platform: 'linux',
          arch: 'x64',
          env: { PATH: '' },
          registry: ${JSON.stringify(srv.url)},
          noFallback: true,
          verifyVersion: () => '0.172.0',
          linkFile: (src, dst) => {
            if (dst.endsWith('asset.txt')) throw new Error('sim_a_fail');
            fs.linkSync(src, dst);
          },
          logger: {
            warn: () => {
              // Runs AFTER lock is released in outer catch; signal B to acquire lock & install,
              // then stay alive past B's completion before A unwinds catch.
              fs.writeFileSync(${JSON.stringify(releasedMarker)}, '1');
              const until = Date.now() + 350;
              while (Date.now() < until) {}
            },
          },
        });
        console.log(JSON.stringify(r));
      `);
      // Wait for A to have rolled back and exited the lock, then immediately run independent Process B
      await new Promise<void>((resolve) => {
        const poll = () => (existsSync(releasedMarker) ? resolve() : setTimeout(poll, 10));
        poll();
      });
      const procB = runInstallProc(`const r = await installCodexCli({ homeDir: ${JSON.stringify(raceHome)}, platform: 'linux', arch: 'x64', env: { PATH: '' }, registry: ${JSON.stringify(srv.url)}, noFallback: true, verifyVersion: () => '0.172.0' }); console.log(JSON.stringify(r));`);
      const [outRaceA, outRaceB] = await Promise.all([procA, procB]);
      expect(JSON.parse(outRaceA.stdout.trim()).status).toBe('failed');
      expect(JSON.parse(outRaceB.stdout.trim()).status).toBe('installed');
      expect(existsSync(join(raceHome, '.codex', 'bin', 'codex'))).toBe(true);
      expect(existsSync(join(raceHome, '.codex', 'bin', 'codex-code-mode-host'))).toBe(true);
      expect(existsSync(join(raceHome, '.codex', 'codex-path', 'rg'))).toBe(true);
      expect(existsSync(join(raceHome, '.codex', 'codex-resources', 'asset.txt'))).toBe(true);

      // 3. Aged lock held by a LIVE process MUST NOT be preempted/stolen (both node:sqlite AND legacy PID fallback)
      for (const forceLegacyPidFile of [false, true]) {
        const lockDir = join(root, forceLegacyPidFile ? 'lock-legacy' : 'lock-sqlite');
        mkdirSync(lockDir, { recursive: true });
        const lockDb = join(lockDir, '.codex-publish.lock.db');
        const heldFlag = join(lockDir, 'held.flag');

        const holderProc = execFileAsync(
          process.execPath,
          [
            '--input-type=module', '-e',
            `import fs from 'node:fs';
             const { withProcessExclusiveLock } = await import(${JSON.stringify(rt.helpersModUrl)});
             await withProcessExclusiveLock(${JSON.stringify(lockDb)}, { timeoutMs: 2000, forceLegacyPidFile: ${forceLegacyPidFile} }, async () => {
               fs.writeFileSync(${JSON.stringify(heldFlag)}, 'held');
               await new Promise((r) => setTimeout(r, 450));
             });`,
          ],
          { cwd: root, env: { PATH: '' } },
        );
        await new Promise<void>((resolve) => {
          const poll = () => (existsSync(heldFlag) ? resolve() : setTimeout(poll, 10));
          poll();
        });
        // Backdate lock file mtime by 2 hours while holder process is still alive
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const targetLockFile = forceLegacyPidFile ? `${lockDb}.pid` : lockDb;
        if (existsSync(targetLockFile)) {
          utimesSync(targetLockFile, twoHoursAgo, twoHoursAgo);
        }
        const waiterRes = await execFileAsync(
          process.execPath,
          [
            '--input-type=module', '-e',
            `const { withProcessExclusiveLock } = await import(${JSON.stringify(rt.helpersModUrl)});
             try {
               await withProcessExclusiveLock(${JSON.stringify(lockDb)}, { timeoutMs: 120, forceLegacyPidFile: ${forceLegacyPidFile} }, async () => {});
               console.log('STOLE');
             } catch (err) {
               console.log(err instanceof Error ? err.message : String(err));
             }`,
          ],
          { cwd: root, env: { PATH: '' } },
        );
        expect(waiterRes.stdout.trim()).toBe('codex_publish_lock_timeout');
        await holderProc;
      }
    } finally {
      await srv.close();
    }
  });
});
