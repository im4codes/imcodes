import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
} from '../../shared/controlled-node-artifacts.js';
import {
  DESKTOP_RELEASE_MANIFEST_FILENAME,
  desktopReleaseTargetManifestFilename,
} from '../../shared/desktop-release-manifest.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { DAEMON_RUNTIME_CRITICAL_ENTRIES } from '../../scripts/daemon-runtime-artifacts.mjs';
import { createEnrollRoutes } from '../src/routes/enroll.js';
import { sha256Hex } from '../src/security/crypto.js';
import { createArtifactCatalog } from '../src/services/controlled-node-artifact-catalog.js';
import { USER_STATUS } from '../../shared/user-status.js';
import type { Env } from '../src/env.js';

const tempDirs: string[] = [];
const prevEnvDir = process.env.IMCODES_NODE_EXE_DIR;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function makeFakeServerApp(serverRows: Map<string, Record<string, unknown>>) {
  const catalog = createArtifactCatalog();
  const routes = createEnrollRoutes({ artifactCatalog: catalog });
  const app = new Hono<{ Bindings: Env }>();
  const mockDb = {
    queryOne: async (_sql: string, params: unknown[]) => {
      const id = String(params[0] ?? '');
      return serverRows.get(id) ?? null;
    },
    execute: async () => ({ changes: 1 }),
  };
  app.use('*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = {
      DB: mockDb,
      JWT_SIGNING_KEY: 'test-key-32-chars-padding-123456',
      BOT_ENCRYPTION_KEY: '0'.repeat(32),
      SERVER_URL: 'https://app.im.codes',
      ALLOWED_ORIGINS: '',
      TRUSTED_PROXIES: '',
      BIND_HOST: '127.0.0.1',
      PORT: '3000',
      NODE_ENV: 'test',
    };
    await next();
  });
  app.route('/api/enroll', routes);
  return app;
}

function writeDaemonRuntimeFixture(
  dir: string,
  target: 'linux-x64' | 'linux-arm64' | 'darwin-arm64' | 'win32-x64',
  version: string,
) {
  const [os, arch] = target.split('-');
  const format = os === 'win32' ? 'zip' : 'tar.gz';
  const archiveName = `daemon-runtime-${target}.${format}`;
  const archiveBytes = Buffer.from(`fake-runtime-${target}-${version}`, 'utf8');
  mkdirSync(join(dir, 'daemon-runtime'), { recursive: true });
  writeFileSync(join(dir, 'daemon-runtime', archiveName), archiveBytes);

  const nodeRel = os === 'win32' ? 'node.exe' : 'bin/node';
  const manifest = {
    schemaVersion: 1,
    artifact: {
      fileName: archiveName,
      format,
      os,
      arch,
      size: archiveBytes.length,
      sha256: sha256(archiveBytes),
      ...(os === 'win32' ? { authenticodeSignerSha256: 'a'.repeat(64) } : {}),
    },
    entrypoint: { node: nodeRel, script: 'package/dist/src/index.js' },
    toolchain: {
      nodeVersion: 'v24.16.0',
      nodeProvider: 'official-node',
      nodeArchive: `node-v24.16.0-${os}-${arch}.${format}`,
      nodeArchiveSha256: 'b'.repeat(64),
    },
    build: { commit: '1234567abcdef', version },
    totalUncompressedBytes: 100,
    fileCount: DAEMON_RUNTIME_CRITICAL_ENTRIES.length + 1,
    files: [
      { path: nodeRel, size: 10, sha256: 'c'.repeat(64), executable: true },
      ...DAEMON_RUNTIME_CRITICAL_ENTRIES.map((p) => ({
        path: p,
        size: 10,
        sha256: 'd'.repeat(64),
        executable: false,
      })),
    ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(join(dir, 'daemon-runtime', `daemon-runtime-${target}.manifest.json`), manifestBytes);

  const nodeFile = os === 'win32' ? 'imcodes-node.exe' : os === 'darwin' ? 'imcodes-node-macos' : 'imcodes-node-linux';
  const rdFile = os === 'win32' ? 'imcodes-remote-desktop-worker.exe' : os === 'darwin' ? 'imcodes-remote-desktop-worker' : 'imcodes-linux-remote-desktop-worker';
  const cuFile = os === 'win32' ? 'open-computer-use.exe' : os === 'darwin' ? 'open-computer-use.app.zip' : 'open-computer-use';
  const releaseManifest = {
    schemaVersion: 1,
    releaseVersion: version,
    gitSha: '1234567abcdef',
    generatedAt: new Date().toISOString(),
    targets: {
      [target]: {
        target,
        os,
        arch,
        components: {
          'imcodes-node': {
            component: 'imcodes-node',
            version,
            fileName: nodeFile,
            sha256: '1'.repeat(64),
            sizeBytes: 123,
            compat: {
              os,
              arch: os === 'darwin' ? 'universal' : arch,
              ...(os === 'win32' ? { authenticodeSignerSha256: 'a'.repeat(64) } : {}),
            },
          },
          'remote-desktop': {
            component: 'remote-desktop',
            version,
            fileName: rdFile,
            sha256: '2'.repeat(64),
            sizeBytes: 456,
            compat: {
              os,
              arch,
              protocolVersion: 2,
              ...(os === 'win32' ? { authenticodeSignerSha256: 'a'.repeat(64) } : {}),
            },
          },
          'open-computer-use': {
            component: 'open-computer-use',
            version,
            fileName: cuFile,
            sha256: '3'.repeat(64),
            sizeBytes: 789,
            compat: {
              os,
              arch: os === 'darwin' ? 'universal' : arch,
              ...(os === 'win32' ? { authenticodeSignerSha256: 'a'.repeat(64) } : {}),
            },
          },
          'daemon-runtime': {
            component: 'daemon-runtime',
            version,
            fileName: archiveName,
            sha256: sha256(archiveBytes),
            sizeBytes: archiveBytes.length,
            compat: {
              os,
              arch,
              nodeVersion: 'v24.16.0',
              ...(os === 'win32' ? { authenticodeSignerSha256: 'a'.repeat(64) } : {}),
            },
          },
        },
      },
    },
  };
  const rmBytes = Buffer.from(JSON.stringify(releaseManifest, null, 2), 'utf8');
  writeFileSync(join(dir, desktopReleaseTargetManifestFilename(target)), rmBytes);
  return { archiveBytes, manifestBytes, releaseManifestBytes: rmBytes };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  if (prevEnvDir === undefined) delete process.env.IMCODES_NODE_EXE_DIR;
  else process.env.IMCODES_NODE_EXE_DIR = prevEnvDir;
});

describe('/api/enroll/v2/node-artifact release manifest & daemon-runtime routes', () => {
  it('serves daemon-runtime, daemon-runtime-manifest, and desktop-release-manifest to FULL daemons with hashes and enforces role boundaries', async () => {
    const dir = makeTempDir('enroll-dr-');
    process.env.IMCODES_NODE_EXE_DIR = dir;
    const version = '2026.5.3100-dev.1';
    const linux = writeDaemonRuntimeFixture(dir, 'linux-arm64', version);
    const mac = writeDaemonRuntimeFixture(dir, 'darwin-arm64', version);

    const fullToken = 'full-token';
    const ctrlToken = 'ctrl-token';
    const servers = new Map<string, Record<string, unknown>>([
      ['srv-full-linux', { id: 'srv-full-linux', token_hash: sha256Hex(fullToken), node_role: NODE_ROLE.FULL, revoked_at: null, os: 'linux', arch: 'arm64', abi_profile: 'modern', owner_status: USER_STATUS.ACTIVE }],
      ['srv-full-mac', { id: 'srv-full-mac', token_hash: sha256Hex(fullToken), node_role: NODE_ROLE.FULL, revoked_at: null, os: 'mac', arch: 'x64', abi_profile: 'modern', owner_status: USER_STATUS.ACTIVE }],
      ['srv-ctrl', { id: 'srv-ctrl', token_hash: sha256Hex(ctrlToken), node_role: NODE_ROLE.CONTROLLED, revoked_at: null, os: 'mac', arch: 'arm64', abi_profile: 'modern', owner_status: USER_STATUS.ACTIVE }],
    ]);
    const app = makeFakeServerApp(servers);

    // FULL daemon gets daemon-runtime (even linux-arm64!) + pinned headers + release manifest hash
    const rtRes = await app.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-linux&os=linux&arch=arm64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    );
    expect(rtRes.status).toBe(200);
    expect(rtRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256)).toBe(sha256(linux.archiveBytes));
    expect(rtRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION)).toBe(version);
    expect(rtRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256)).toBe(sha256(linux.releaseManifestBytes));
    expect(Buffer.from(await rtRes.arrayBuffer())).toEqual(linux.archiveBytes);

    // FULL daemon gets macOS daemon-runtime-manifest (even if enrolled under Rosetta x64 arch)
    const manRes = await app.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-mac&os=mac&arch=arm64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME_MANIFEST}`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    );
    expect(manRes.status).toBe(200);
    expect(manRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256)).toBe(sha256(mac.manifestBytes));
    expect(Buffer.from(await manRes.arrayBuffer())).toEqual(mac.manifestBytes);

    // Both FULL and CONTROLLED can read desktop-release-manifest
    const rmFull = await app.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-mac&os=mac&arch=arm64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DESKTOP_RELEASE_MANIFEST}`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    );
    expect(rmFull.status).toBe(200);
    expect(rmFull.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256)).toBe(sha256(mac.releaseManifestBytes));

    const rmCtrl = await app.request(
      `/api/enroll/v2/node-artifact?serverId=srv-ctrl&os=mac&arch=arm64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DESKTOP_RELEASE_MANIFEST}`,
      { headers: { authorization: `Bearer ${ctrlToken}` } },
    );
    expect(rmCtrl.status).toBe(200);

    // Role boundaries preserved: FULL cannot fetch computer-use-helper; CONTROLLED cannot fetch daemon-runtime
    const forbiddenCu = await app.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-mac&os=mac&arch=universal&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.COMPUTER_USE_HELPER}`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    );
    expect(forbiddenCu.status).toBe(403);

    const forbiddenDr = await app.request(
      `/api/enroll/v2/node-artifact?serverId=srv-ctrl&os=mac&arch=arm64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { headers: { authorization: `Bearer ${ctrlToken}` } },
    );
    expect(forbiddenDr.status).toBe(403);

    // Range requests rejected (416)
    const rangeRes = await app.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-linux&os=linux&arch=arm64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { headers: { authorization: `Bearer ${fullToken}`, range: 'bytes=0-10' } },
    );
    expect(rangeRes.status).toBe(416);

    // Unbuilt win32-x64 returns 404 daemon_runtime_not_published
    const fullWinId = 'srv-full-win';
    servers.set(fullWinId, { id: fullWinId, token_hash: sha256Hex(fullToken), node_role: NODE_ROLE.FULL, revoked_at: null, os: 'win', arch: 'x64', abi_profile: 'modern', owner_status: USER_STATUS.ACTIVE });
    const missingRes = await app.request(
      `/api/enroll/v2/node-artifact?serverId=${fullWinId}&os=win&arch=x64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    );
    expect(missingRes.status).toBe(404);
  });

  it('fails closed (503) when daemon-runtime is tampered or symlinked, or mismatches unified release manifest', async () => {
    const dir = makeTempDir('enroll-tamper-');
    process.env.IMCODES_NODE_EXE_DIR = dir;
    const version = '2026.5.3100-dev.1';
    writeDaemonRuntimeFixture(dir, 'linux-x64', version);

    const fullToken = 'full-token';
    const servers = new Map<string, Record<string, unknown>>([
      ['srv-full', { id: 'srv-full', token_hash: sha256Hex(fullToken), node_role: NODE_ROLE.FULL, revoked_at: null, os: 'linux', arch: 'x64', abi_profile: 'modern', owner_status: USER_STATUS.ACTIVE }],
    ]);
    const app = makeFakeServerApp(servers);

    // Tamper release manifest version -> mismatch triggers 503
    const brokenManifestPath = join(dir, DESKTOP_RELEASE_MANIFEST_FILENAME);
    rmSync(join(dir, desktopReleaseTargetManifestFilename('linux-x64')));
    writeFileSync(brokenManifestPath, JSON.stringify({
      schemaVersion: 1,
      releaseVersion: '2026.5.3199-dev.1',
      gitSha: '1234567abcdef',
      generatedAt: new Date().toISOString(),
      targets: {
        'linux-x64': {
          target: 'linux-x64', os: 'linux', arch: 'x64',
          components: {
            'imcodes-node': { component: 'imcodes-node', version: '2026.5.3199-dev.1', fileName: 'imcodes-node-linux', sha256: '1'.repeat(64), sizeBytes: 10, compat: { os: 'linux', arch: 'x64' } },
            'remote-desktop': { component: 'remote-desktop', version: '2026.5.3199-dev.1', fileName: 'imcodes-linux-remote-desktop-worker', sha256: '2'.repeat(64), sizeBytes: 10, compat: { os: 'linux', arch: 'x64', protocolVersion: 2 } },
            'open-computer-use': { component: 'open-computer-use', version: '2026.5.3199-dev.1', fileName: 'open-computer-use', sha256: '3'.repeat(64), sizeBytes: 10, compat: { os: 'linux', arch: 'x64' } },
            'daemon-runtime': { component: 'daemon-runtime', version: '2026.5.3199-dev.1', fileName: 'daemon-runtime-linux-x64.tar.gz', sha256: '4'.repeat(64), sizeBytes: 10, compat: { os: 'linux', arch: 'x64', nodeVersion: 'v24.16.0' } },
          },
        },
      },
    }));

    const mismatchRes = await app.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full&os=linux&arch=x64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    );
    expect(mismatchRes.status).toBe(503);

    // Replace daemon-runtime archive with symlink -> refused
    rmSync(brokenManifestPath);
    const archivePath = join(dir, 'daemon-runtime', 'daemon-runtime-linux-x64.tar.gz');
    rmSync(archivePath);
    writeFileSync(join(dir, 'outside.txt'), 'secret');
    symlinkSync(join(dir, 'outside.txt'), archivePath);
    const symlinkRes = await app.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full&os=linux&arch=x64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    );
    expect(symlinkRes.status).toBe(503);
  });
});
