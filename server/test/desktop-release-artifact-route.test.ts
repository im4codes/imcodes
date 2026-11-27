import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
  CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN,
  CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_FILENAME,
  CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_SCHEMA_VERSION,
  controlledNodeReleaseArtifactEntryKey,
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
import {
  invalidateR2ReleaseManifestCache,
  invalidateReleaseArtifactsManifestCache,
  setR2ManifestFetchForTests,
} from '../src/services/controlled-node-artifact-distribution.js';
import { USER_STATUS } from '../../shared/user-status.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from '../../shared/remote-desktop.js';
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

function makeFakeServerApp(serverRows: Map<string, Record<string, unknown>>, extraEnv: Record<string, unknown> = {}) {
  const catalog = createArtifactCatalog();
  const routes = createEnrollRoutes(catalog);
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
      ...extraEnv,
    };
    await next();
  });
  app.route('/api/enroll', routes);
  return app;
}

function writeReleaseArtifactsManifest(
  dir: string,
  target: 'linux-x64' | 'linux-arm64' | 'darwin-arm64' | 'darwin-x64' | 'win32-x64',
  version: string,
  archiveBytes: Buffer,
  entryOverrides: Record<string, unknown> = {},
  includeDaemonRuntimeEntry = true,
) {
  const [rawOs, arch] = target.split('-');
  const os = rawOs === 'darwin' ? 'mac' : rawOs === 'win32' ? 'win' : 'linux';
  const format = rawOs === 'win32' ? 'zip' : 'tar.gz';
  const archiveName = `daemon-runtime-${target}.${format}`;
  const key = controlledNodeReleaseArtifactEntryKey({
    asset: CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME,
    os,
    arch,
  });
  const artifacts: Record<string, unknown> = includeDaemonRuntimeEntry
    ? {
        [key]: {
          asset: CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME,
          assetFilename: archiveName,
          relativePath: `daemon-runtime/${archiveName}`,
          sha256: sha256(archiveBytes),
          sizeBytes: archiveBytes.length,
          version,
          os,
          arch,
          ...(os === 'win' ? { authenticodeSignerSha256: 'a'.repeat(64) } : {}),
          ...entryOverrides,
        },
      }
    : {};
  writeFileSync(
    join(dir, CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_FILENAME),
    JSON.stringify({
      schemaVersion: CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_SCHEMA_VERSION,
      version,
      generatedAt: new Date().toISOString(),
      artifacts,
    }, null, 2),
  );
  invalidateReleaseArtifactsManifestCache(dir);
}

function writeDaemonRuntimeFixture(
  dir: string,
  target: 'linux-x64' | 'linux-arm64' | 'darwin-arm64' | 'darwin-x64' | 'win32-x64',
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
    totalUncompressedBytes: (DAEMON_RUNTIME_CRITICAL_ENTRIES.length + 1) * 10,
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
  setR2ManifestFetchForTests(null);
  invalidateR2ReleaseManifestCache();
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

  it('serves external-only daemon-runtime manifests, HEAD metadata, and R2/GitHub 302 redirects when local archives are absent, and fails closed on missing/mismatched release manifest or non-redirect GET', async () => {
    const dir = makeTempDir('enroll-external-dr-');
    process.env.IMCODES_NODE_EXE_DIR = dir;
    const version = '2026.5.3200-dev.1';
    const linux = writeDaemonRuntimeFixture(dir, 'linux-x64', version);
    const win = writeDaemonRuntimeFixture(dir, 'win32-x64', version);
    // Simulate Docker Option B image: remove local *.tar.gz and *.zip archives while retaining manifests.
    rmSync(join(dir, 'daemon-runtime', 'daemon-runtime-linux-x64.tar.gz'));
    rmSync(join(dir, 'daemon-runtime', 'daemon-runtime-win32-x64.zip'));

    const fullToken = 'full-token';
    const servers = new Map<string, Record<string, unknown>>([
      ['srv-full-linux', { id: 'srv-full-linux', token_hash: sha256Hex(fullToken), node_role: NODE_ROLE.FULL, revoked_at: null, os: 'linux', arch: 'x64', abi_profile: 'modern', owner_status: USER_STATUS.ACTIVE }],
      ['srv-full-win', { id: 'srv-full-win', token_hash: sha256Hex(fullToken), node_role: NODE_ROLE.FULL, revoked_at: null, os: 'win', arch: 'x64', abi_profile: 'modern', owner_status: USER_STATUS.ACTIVE }],
    ]);

    // 1. Missing release-artifacts-manifest.json fails closed (404 not_published).
    const appR2 = makeFakeServerApp(servers, {
      USE_R2_ARTIFACT: '',
      CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: 'https://cdn.imcodes.example',
    });
    const missingManifestRes = await appR2.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-linux&os=linux&arch=x64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { headers: { authorization: `Bearer ${fullToken}`, [CONTROLLED_NODE_ARTIFACT_HEADERS.EXTERNAL_REDIRECT]: CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN } },
    );
    expect(missingManifestRes.status).toBe(404);

    // 2. Write valid release-artifacts-manifest.json for linux-x64 -> manifest GET, HEAD, R2 302, GitHub 302, and non-redirect 503.
    writeReleaseArtifactsManifest(dir, 'linux-x64', version, linux.archiveBytes);
    const liveR2Manifest = JSON.parse(
      readFileSync(join(dir, CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_FILENAME), 'utf8'),
    ) as Record<string, unknown>;
    const linuxDaemonRuntimeKey = controlledNodeReleaseArtifactEntryKey({
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME,
      os: 'linux',
      arch: 'x64',
    });
    setR2ManifestFetchForTests(async () => new Response(JSON.stringify(liveR2Manifest), { status: 200 }));

    const manRes = await appR2.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-linux&os=linux&arch=x64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME_MANIFEST}`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    );
    expect(manRes.status).toBe(200);
    expect(manRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256)).toBe(sha256(linux.manifestBytes));
    expect(Buffer.from(await manRes.arrayBuffer())).toEqual(linux.manifestBytes);

    const headRes = await appR2.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-linux&os=linux&arch=x64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { method: 'HEAD', headers: { authorization: `Bearer ${fullToken}` } },
    );
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256)).toBe(sha256(linux.archiveBytes));
    expect(headRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES)).toBe(String(linux.archiveBytes.length));
    expect(headRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION)).toBe(version);
    expect(headRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256)).toBe(sha256(linux.releaseManifestBytes));

    // Tier-1 R2 302 redirect.
    const r2RedirectRes = await appR2.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-linux&os=linux&arch=x64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { headers: { authorization: `Bearer ${fullToken}`, [CONTROLLED_NODE_ARTIFACT_HEADERS.EXTERNAL_REDIRECT]: CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN } },
    );
    expect(r2RedirectRes.status).toBe(302);
    expect(r2RedirectRes.headers.get('location')).toBe(`https://cdn.imcodes.example/dev/daemon-runtime-linux-x64.tar.gz?v=${sha256(linux.archiveBytes).slice(0, 16)}`);
    expect(r2RedirectRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256)).toBe(sha256(linux.archiveBytes));
    expect(r2RedirectRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256)).toBe(sha256(linux.releaseManifestBytes));

    // A drifted live R2 manifest is rejected and falls back to version-pinned GitHub Releases.
    setR2ManifestFetchForTests(async () => new Response(JSON.stringify({
      ...liveR2Manifest,
      version: '2099.1.9999-dev.999',
      artifacts: {
        ...(liveR2Manifest.artifacts as Record<string, unknown>),
        [linuxDaemonRuntimeKey]: {
          ...((liveR2Manifest.artifacts as Record<string, unknown>)[linuxDaemonRuntimeKey] as Record<string, unknown>),
          sha256: 'f'.repeat(64),
          version: '2099.1.9999-dev.999',
        },
      },
    }), { status: 200 }));
    const driftedR2RedirectRes = await appR2.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-linux&os=linux&arch=x64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { headers: { authorization: `Bearer ${fullToken}`, [CONTROLLED_NODE_ARTIFACT_HEADERS.EXTERNAL_REDIRECT]: CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN } },
    );
    expect(driftedR2RedirectRes.status).toBe(302);
    expect(driftedR2RedirectRes.headers.get('location')).toBe(
      `https://github.com/im4codes/imcodes/releases/download/controlled-node-v${version}/daemon-runtime-linux-x64.tar.gz`,
    );

    // Tier-2 GitHub 302 redirect even when USE_R2_ARTIFACT=false and CONTROLLED_NODE_ARTIFACT_GITHUB_REPO is unset.
    const appGithubFallback = makeFakeServerApp(servers, {
      USE_R2_ARTIFACT: 'false',
      CONTROLLED_NODE_ARTIFACT_GITHUB_REPO: '',
    });
    const ghRedirectRes = await appGithubFallback.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-linux&os=linux&arch=x64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { headers: { authorization: `Bearer ${fullToken}`, [CONTROLLED_NODE_ARTIFACT_HEADERS.EXTERNAL_REDIRECT]: CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN } },
    );
    expect(ghRedirectRes.status).toBe(302);
    expect(ghRedirectRes.headers.get('location')).toBe(
      `https://github.com/im4codes/imcodes/releases/download/controlled-node-v${version}/daemon-runtime-linux-x64.tar.gz`,
    );

    // Client without external redirect opt-in receives clean 503 instead of crashing on undefined local handle.
    const noRedirectRes = await appR2.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-linux&os=linux&arch=x64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    );
    expect(noRedirectRes.status).toBe(503);
    expect(await noRedirectRes.json()).toMatchObject({ error: 'daemon_runtime_external_artifact_required', target: 'linux-x64' });

    // 3. Mismatched release-artifacts-manifest.json entry fails closed (503).
    writeReleaseArtifactsManifest(dir, 'win32-x64', version, win.archiveBytes, { sha256: 'f'.repeat(64) });
    const mismatchEntryRes = await appR2.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-win&os=win&arch=x64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { headers: { authorization: `Bearer ${fullToken}`, [CONTROLLED_NODE_ARTIFACT_HEADERS.EXTERNAL_REDIRECT]: CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN } },
    );
    expect(mismatchEntryRes.status).toBe(503);

    // 4. Missing entry in an existing release-artifacts-manifest.json fails closed (404).
    writeReleaseArtifactsManifest(dir, 'win32-x64', version, win.archiveBytes, {}, false);
    const missingEntryRes = await appR2.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-win&os=win&arch=x64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { headers: { authorization: `Bearer ${fullToken}`, [CONTROLLED_NODE_ARTIFACT_HEADERS.EXTERNAL_REDIRECT]: CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN } },
    );
    expect(missingEntryRes.status).toBe(404);

    // 5. Present-but-tampered local archive still fails closed (503) even when release-artifacts-manifest.json is valid.
    writeReleaseArtifactsManifest(dir, 'linux-x64', version, linux.archiveBytes);
    writeFileSync(join(dir, 'daemon-runtime', 'daemon-runtime-linux-x64.tar.gz'), Buffer.from('tampered-bytes'));
    const tamperedLocalRes = await appR2.request(
      `/api/enroll/v2/node-artifact?serverId=srv-full-linux&os=linux&arch=x64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME}`,
      { headers: { authorization: `Bearer ${fullToken}`, [CONTROLLED_NODE_ARTIFACT_HEADERS.EXTERNAL_REDIRECT]: CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN } },
    );
    expect(tamperedLocalRes.status).toBe(503);
  });

  it('resolves mac:universal node release manifest sha256 by x-imcodes-node-runtime-arch -> server.arch, omits it when unknown, and fails closed on mismatch', async () => {
    const dir = makeTempDir('enroll-mac-universal-arch-');
    process.env.IMCODES_NODE_EXE_DIR = dir;
    const version = '2026.11.6577-dev.6641';
    const nodeBytes = Buffer.from('universal-macos-node-binary-' + version, 'utf8');
    const nodeSha = sha256(nodeBytes);
    writeFileSync(join(dir, 'imcodes-node-macos'), nodeBytes);
    writeFileSync(join(dir, 'imcodes-node-macos.manifest.json'), JSON.stringify({
      schemaVersion: 1,
      artifact: {
        os: 'mac',
        arch: 'universal',
        fileName: 'imcodes-node-macos',
        size: nodeBytes.length,
        sha256: nodeSha,
      },
      build: { version },
    }, null, 2));

    const writeMacReleaseManifest = (arch: 'arm64' | 'x64', nodeShaOverride?: string): string => {
      const target = `darwin-${arch}` as const;
      const bytes = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        releaseVersion: version,
        gitSha: '1234567abcdef',
        generatedAt: new Date().toISOString(),
        targets: {
          [target]: {
            target,
            os: 'darwin',
            arch,
            components: {
              'imcodes-node': {
                component: 'imcodes-node',
                version,
                fileName: 'imcodes-node-macos',
                sha256: nodeShaOverride ?? nodeSha,
                sizeBytes: nodeBytes.length,
                compat: { os: 'darwin', arch: 'universal' },
              },
              'remote-desktop': {
                component: 'remote-desktop',
                version,
                fileName: `imcodes-macos-remote-desktop-${arch}.tar.gz`,
                sha256: (arch === 'x64' ? '2' : '3').repeat(64),
                sizeBytes: 456,
                compat: { os: 'darwin', arch, protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION },
              },
              'open-computer-use': {
                component: 'open-computer-use',
                version,
                fileName: 'open-computer-use.app.zip',
                sha256: '4'.repeat(64),
                sizeBytes: 789,
                compat: { os: 'darwin', arch: 'universal' },
              },
              'daemon-runtime': {
                component: 'daemon-runtime',
                version,
                fileName: `daemon-runtime-${target}.tar.gz`,
                sha256: (arch === 'x64' ? '5' : '6').repeat(64),
                sizeBytes: 999,
                compat: { os: 'darwin', arch, nodeVersion: 'v24.16.0' },
              },
            },
          },
        },
      }, null, 2), 'utf8');
      writeFileSync(join(dir, desktopReleaseTargetManifestFilename(target)), bytes);
      return sha256(bytes);
    };

    const arm64RmSha = writeMacReleaseManifest('arm64');
    const x64RmSha = writeMacReleaseManifest('x64');
    expect(arm64RmSha).not.toBe(x64RmSha);

    const macNodeKey = controlledNodeReleaseArtifactEntryKey({
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.NODE,
      os: 'mac',
      arch: 'universal',
    });
    const r2Manifest = {
      schemaVersion: CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_SCHEMA_VERSION,
      version,
      generatedAt: new Date().toISOString(),
      artifacts: {
        [macNodeKey]: {
          asset: CONTROLLED_NODE_ARTIFACT_ASSETS.NODE,
          assetFilename: 'imcodes-node-macos',
          relativePath: 'imcodes-node-macos',
          sha256: nodeSha,
          sizeBytes: nodeBytes.length,
          version,
          os: 'mac',
          arch: 'universal',
        },
      },
    };
    writeFileSync(join(dir, CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_FILENAME), JSON.stringify(r2Manifest));
    invalidateReleaseArtifactsManifestCache(dir);
    setR2ManifestFetchForTests(async () => new Response(JSON.stringify(r2Manifest), { status: 200 }));

    const token = 'mac-ctrl-token';
    const tokenHash = sha256Hex(token);
    const servers = new Map<string, Record<string, unknown>>([
      ['srv-mac-x64', { id: 'srv-mac-x64', token_hash: tokenHash, node_role: NODE_ROLE.CONTROLLED, revoked_at: null, os: 'mac', arch: 'x64', abi_profile: 'modern', owner_status: USER_STATUS.ACTIVE }],
      ['srv-mac-arm64', { id: 'srv-mac-arm64', token_hash: tokenHash, node_role: NODE_ROLE.CONTROLLED, revoked_at: null, os: 'mac', arch: 'arm64', abi_profile: 'modern', owner_status: USER_STATUS.ACTIVE }],
      ['srv-mac-univ', { id: 'srv-mac-univ', token_hash: tokenHash, node_role: NODE_ROLE.CONTROLLED, revoked_at: null, os: 'mac', arch: 'universal', abi_profile: 'modern', owner_status: USER_STATUS.ACTIVE }],
      ['srv-mac-null', { id: 'srv-mac-null', token_hash: tokenHash, node_role: NODE_ROLE.CONTROLLED, revoked_at: null, os: 'mac', arch: null, abi_profile: 'modern', owner_status: USER_STATUS.ACTIVE }],
    ]);
    const app = makeFakeServerApp(servers, {
      CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: 'https://cdn.imcodes.example',
    });

    // 1. Intel Mac (server.arch = 'x64', legacy client without header): HEAD, direct GET, and 302 ALL pin darwin-x64.
    const x64Head = await app.request(`/api/enroll/v2/node-artifact?serverId=srv-mac-x64&os=mac&arch=universal`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(x64Head.status).toBe(200);
    expect(x64Head.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256)).toBe(x64RmSha);

    const x64Direct = await app.request(`/api/enroll/v2/node-artifact?serverId=srv-mac-x64&os=mac&arch=universal`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(x64Direct.status).toBe(200);
    expect(x64Direct.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256)).toBe(x64RmSha);
    expect(Buffer.from(await x64Direct.arrayBuffer())).toEqual(nodeBytes);

    const x64Redirect = await app.request(`/api/enroll/v2/node-artifact?serverId=srv-mac-x64&os=mac&arch=universal`, {
      headers: {
        authorization: `Bearer ${token}`,
        [CONTROLLED_NODE_ARTIFACT_HEADERS.EXTERNAL_REDIRECT]: CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN,
      },
    });
    expect(x64Redirect.status).toBe(302);
    expect(x64Redirect.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256)).toBe(x64RmSha);

    // 2. Apple Silicon (server.arch = 'arm64', no header) pins darwin-arm64.
    const armHead = await app.request(`/api/enroll/v2/node-artifact?serverId=srv-mac-arm64&os=mac&arch=universal`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(armHead.status).toBe(200);
    expect(armHead.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256)).toBe(arm64RmSha);

    // 3. Explicit header x-imcodes-node-runtime-arch: x64 overrides stale arm64/universal DB arch.
    for (const sid of ['srv-mac-arm64', 'srv-mac-univ']) {
      const overrideRes = await app.request(`/api/enroll/v2/node-artifact?serverId=${sid}&os=mac&arch=universal`, {
        method: 'HEAD',
        headers: {
          authorization: `Bearer ${token}`,
          [CONTROLLED_NODE_ARTIFACT_HEADERS.RUNTIME_ARCH]: 'x64',
        },
      });
      expect(overrideRes.status).toBe(200);
      expect(overrideRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256)).toBe(x64RmSha);
    }

    // 4. Invalid x-imcodes-node-runtime-arch is ignored safely (falls back to DB or unknown without breaking node).
    const badHeaderWithDb = await app.request(`/api/enroll/v2/node-artifact?serverId=srv-mac-x64&os=mac&arch=universal`, {
      method: 'HEAD',
      headers: {
        authorization: `Bearer ${token}`,
        [CONTROLLED_NODE_ARTIFACT_HEADERS.RUNTIME_ARCH]: 'mips64',
      },
    });
    expect(badHeaderWithDb.status).toBe(200);
    expect(badHeaderWithDb.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256)).toBe(x64RmSha);

    // 5. Unknown arch (server.arch = 'universal' / null, no valid header) validates published manifests and OMITS pinned hash.
    for (const sid of ['srv-mac-univ', 'srv-mac-null']) {
      for (const init of [
        { method: 'HEAD', headers: { authorization: `Bearer ${token}` } },
        { method: 'GET', headers: { authorization: `Bearer ${token}`, [CONTROLLED_NODE_ARTIFACT_HEADERS.RUNTIME_ARCH]: 'invalid' } },
        { method: 'GET', headers: { authorization: `Bearer ${token}`, [CONTROLLED_NODE_ARTIFACT_HEADERS.EXTERNAL_REDIRECT]: CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN } },
      ] as RequestInit[]) {
        const res = await app.request(`/api/enroll/v2/node-artifact?serverId=${sid}&os=mac&arch=universal`, init);
        expect([200, 302]).toContain(res.status);
        expect(res.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256)).toBeNull();
        await res.body?.cancel().catch(() => {});
      }
    }

    // 6. Fail-closed 503 when either macOS release manifest imcodes-node entry mismatches (even for unknown arch).
    writeMacReleaseManifest('x64', 'f'.repeat(64));
    expect((await app.request(`/api/enroll/v2/node-artifact?serverId=srv-mac-x64&os=mac&arch=universal`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${token}` },
    })).status).toBe(503);
    expect((await app.request(`/api/enroll/v2/node-artifact?serverId=srv-mac-univ&os=mac&arch=universal`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${token}` },
    })).status).toBe(503);

    writeMacReleaseManifest('x64');
    writeMacReleaseManifest('arm64', 'e'.repeat(64));
    expect((await app.request(`/api/enroll/v2/node-artifact?serverId=srv-mac-univ&os=mac&arch=universal`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${token}` },
    })).status).toBe(503);
  });
});
