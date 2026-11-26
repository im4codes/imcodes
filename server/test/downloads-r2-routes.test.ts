import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error ESM script module
import { generateControlledNodeReleaseManifest } from '../../scripts/generate-controlled-node-manifest.mjs';
import {
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
  CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN,
} from '../../shared/controlled-node-artifacts.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
  REMOTE_DESKTOP_MACOS_TEAM_ID,
} from '../../shared/remote-desktop-worker.js';
import { appleDesignatedRequirement } from '../../shared/macos-code-requirement.js';
import { WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN } from '../../shared/remote-desktop-qualification.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { USER_STATUS } from '../../shared/user-status.js';
import type { Env } from '../src/env.js';
import { buildApp } from '../src/index.js';
import { createDownloadsRoutes } from '../src/routes/downloads.js';
import { createEnrollRoutes } from '../src/routes/enroll.js';
import { sha256Hex } from '../src/security/crypto.js';
import { createArtifactCatalog } from '../src/services/controlled-node-artifact-catalog.js';
import {
  DEFAULT_CONTROLLED_NODE_ARTIFACT_R2_BASE_URL,
  invalidateReleaseArtifactsManifestCache,
  invalidateR2ReleaseManifestCache,
  resolveArtifactChannel,
  resolveControlledNodeExternalArtifact,
  resolveR2ObjectUrl,
  setR2ManifestFetchForTests,
} from '../src/services/controlled-node-artifact-distribution.js';

const tempDirs: string[] = [];
const prevExeDir = process.env.IMCODES_NODE_EXE_DIR;
const prevR2Base = process.env.CONTROLLED_NODE_ARTIFACT_R2_BASE_URL;
const prevR2Prefix = process.env.CONTROLLED_NODE_ARTIFACT_R2_PREFIX;
const prevUseR2 = process.env.USE_R2_ARTIFACT;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function writeDesktopAndRdFixtures(dir: string, version: string) {
  const installersDir = join(dir, 'installers');
  mkdirSync(installersDir, { recursive: true });

  const pkgBytes = Buffer.from(`pkg-${version}`);
  const pkgIntelBytes = Buffer.from(`pkg-intel-${version}`);
  const exeBytes = Buffer.from(`exe-${version}`);
  const debBytes = Buffer.from(`deb-${version}`);
  const shBytes = Buffer.from(`sh-${version}`);

  const pkgRel = `installers/imcodes-desktop-${version}-darwin-arm64.pkg`;
  const pkgIntelRel = `installers/imcodes-desktop-${version}-darwin-x64.pkg`;
  const exeRel = `installers/imcodes-desktop-${version}-win32-x64.exe`;
  const debRel = `installers/imcodes-desktop-${version}-linux-amd64.deb`;
  const shRel = `installers/imcodes-desktop-${version}-linux-x64.sh`;

  writeFileSync(join(dir, pkgRel), pkgBytes);
  writeFileSync(join(dir, pkgIntelRel), pkgIntelBytes);
  writeFileSync(join(dir, exeRel), exeBytes);
  writeFileSync(join(dir, debRel), debBytes);
  writeFileSync(join(dir, shRel), shBytes);

  const gitSha = 'a'.repeat(40);
  writeFileSync(join(dir, 'desktop-release-darwin-arm64.manifest.json'), JSON.stringify({
    schemaVersion: 1,
    releaseVersion: version,
    gitSha,
    targets: {
      'darwin-arm64': {
        components: {},
        installers: [{
          kind: 'pkg',
          fileName: `imcodes-desktop-${version}-darwin-arm64.pkg`,
          relativePath: pkgRel,
          sha256: sha256(pkgBytes),
          sizeBytes: pkgBytes.length,
        }],
      },
    },
  }));
  writeFileSync(join(dir, 'desktop-release-darwin-x64.manifest.json'), JSON.stringify({
    schemaVersion: 1,
    releaseVersion: version,
    gitSha,
    targets: {
      'darwin-x64': {
        components: {},
        installers: [{
          kind: 'pkg',
          fileName: `imcodes-desktop-${version}-darwin-x64.pkg`,
          relativePath: pkgIntelRel,
          sha256: sha256(pkgIntelBytes),
          sizeBytes: pkgIntelBytes.length,
        }],
      },
    },
  }));
  writeFileSync(join(dir, 'desktop-release-win32-x64.manifest.json'), JSON.stringify({
    schemaVersion: 1,
    releaseVersion: version,
    gitSha,
    targets: {
      'win32-x64': {
        components: {},
        installers: [{
          kind: 'exe',
          fileName: `imcodes-desktop-${version}-win32-x64.exe`,
          relativePath: exeRel,
          sha256: sha256(exeBytes),
          sizeBytes: exeBytes.length,
        }],
      },
    },
  }));
  writeFileSync(join(dir, 'desktop-release-linux-x64.manifest.json'), JSON.stringify({
    schemaVersion: 1,
    releaseVersion: version,
    gitSha,
    targets: {
      'linux-x64': {
        components: {},
        installers: [
          {
            kind: 'deb',
            fileName: `imcodes-desktop-${version}-linux-amd64.deb`,
            relativePath: debRel,
            sha256: sha256(debBytes),
            sizeBytes: debBytes.length,
          },
          {
            kind: 'sh',
            fileName: `imcodes-desktop-${version}-linux-x64.sh`,
            relativePath: shRel,
            sha256: sha256(shBytes),
            sizeBytes: shBytes.length,
          },
        ],
      },
    },
  }));

  // Linux remote-desktop worker
  const linuxRdDir = join(dir, 'remote-desktop-worker', 'linux-x64');
  mkdirSync(linuxRdDir, { recursive: true });
  const linuxRdBytes = Buffer.from(`linux-worker-${version}`);
  writeFileSync(join(linuxRdDir, 'imcodes-linux-remote-desktop-worker'), linuxRdBytes);
  writeFileSync(join(linuxRdDir, 'imcodes-linux-remote-desktop-worker.manifest.json'), JSON.stringify({
    schemaVersion: 1,
    build: { source: gitSha, version },
    artifact: {
      fileName: 'imcodes-linux-remote-desktop-worker',
      os: 'linux',
      arch: 'x64',
      size: linuxRdBytes.length,
      sha256: sha256(linuxRdBytes),
    },
  }));

  // macOS remote-desktop component sets (arm64 + x64)
  for (const arch of ['arm64', 'x64'] as const) {
    const macDir = join(dir, 'remote-desktop-worker', `darwin-${arch}`);
    mkdirSync(macDir, { recursive: true });
    const compSpecs = [
      ['worker', 'imcodes-remote-desktop-worker', 'codes.im.remote-desktop.worker'],
      ['launchAgent', 'imcodes-remote-desktop-launch-agent', 'codes.im.remote-desktop.launch-agent'],
      ['disclosure', 'imcodes-remote-desktop-disclosure', 'codes.im.remote-desktop.disclosure'],
      ['virtualDisplayHelper', 'imcodes-virtual-display-helper', 'codes.im.remote-desktop.virtual-display'],
    ] as const;
    const components: Record<string, unknown> = {};
    const bundles: Record<string, unknown> = {};
    for (const [kind, fileName, bundleIdentifier] of compSpecs) {
      const payload = Buffer.from(`mac-${arch}-${kind}-${version}`);
      writeFileSync(join(macDir, fileName), payload);
      components[kind] = {
        fileName,
        size: payload.length,
        sha256: sha256(payload),
        notarization: {
          status: 'accepted',
          submissionId: '11111111-1111-4111-8111-111111111111',
          ticketSha256: 'c'.repeat(64),
          stapled: false,
          stapleValidated: false,
          unstapledReason: 'artifact_format_cannot_carry_a_ticket',
        },
      };
      bundles[kind] = {
        bundleIdentifier,
        designatedRequirement: appleDesignatedRequirement(bundleIdentifier, REMOTE_DESKTOP_MACOS_TEAM_ID),
        hardenedRuntime: true,
      };
    }
    writeFileSync(join(macDir, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME), JSON.stringify({
      manifestVersion: 4,
      artifactKind: 'macos-component-set',
      workerVersion: version,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      ipcVersion: 1,
      os: 'darwin',
      arch,
      components,
      libwebrtcRevision: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.libwebrtcRevision,
      minimumOsVersion: '13.0',
      codeSignature: {
        teamId: REMOTE_DESKTOP_MACOS_TEAM_ID,
        bundles,
      },
      toolchain: { xcode: '16.0', macosSdk: '15.0', clang: '16.0' },
    }));
  }

  const stageDir = join(dir, '_staged');
  const generated = generateControlledNodeReleaseManifest({ artifactsDir: dir, version, stageDir });
  return { pkgBytes, exeBytes, debBytes, shBytes, linuxRdBytes, manifest: generated.manifest };
}

afterEach(() => {
  setR2ManifestFetchForTests(null);
  invalidateR2ReleaseManifestCache();
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    invalidateReleaseArtifactsManifestCache(d);
    rmSync(d, { recursive: true, force: true });
  }
  if (prevExeDir === undefined) delete process.env.IMCODES_NODE_EXE_DIR;
  else process.env.IMCODES_NODE_EXE_DIR = prevExeDir;
  if (prevR2Base === undefined) delete process.env.CONTROLLED_NODE_ARTIFACT_R2_BASE_URL;
  else process.env.CONTROLLED_NODE_ARTIFACT_R2_BASE_URL = prevR2Base;
  if (prevR2Prefix === undefined) delete process.env.CONTROLLED_NODE_ARTIFACT_R2_PREFIX;
  else process.env.CONTROLLED_NODE_ARTIFACT_R2_PREFIX = prevR2Prefix;
  if (prevUseR2 === undefined) delete process.env.USE_R2_ARTIFACT;
  else process.env.USE_R2_ARTIFACT = prevUseR2;
});

describe('two-channel R2 distribution, /api/downloads/latest, and Linux/macOS RD redirects', () => {
  it('resolves master vs dev R2 channels cleanly from artifact version', () => {
    expect(resolveArtifactChannel('2026.11.7088')).toBe('master');
    expect(resolveArtifactChannel('2026.11.7088-dev.6988')).toBe('dev');
    expect(resolveArtifactChannel(undefined)).toBe('master');
  });

  it('routes /api/downloads/latest/:target across all 6 targets with channel inference, R2 presigning, GitHub/local fallbacks, and LANDING_HOST pass-through', async () => {
    const dir = makeTempDir('imcodes-downloads-');
    const landingDir = makeTempDir('imcodes-landing-dist-');
    writeFileSync(join(landingDir, 'index.html'), '<html><body>landing</body></html>');

    const devVersion = '2026.11.7088-dev.6988';
    const { pkgBytes, manifest } = writeDesktopAndRdFixtures(dir, devVersion);
    setR2ManifestFetchForTests(async () => new Response(JSON.stringify(manifest), { status: 200 }));

    const makeAppWithEnv = (extraEnv: Partial<Env>) => {
      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        (c as unknown as { env: Record<string, unknown> }).env = {
          CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: 'https://cdn.imcodes.example',
          CONTROLLED_NODE_ARTIFACT_R2_PREFIX: 'releases',
          ...extraEnv,
        };
        await next();
      });
      app.route('/api/downloads', createDownloadsRoutes(() => dir));
      return app;
    };

    const devApp = makeAppWithEnv({});
    const expectedMap: Array<[string, string]> = [
      ['android-with-fcm', 'https://cdn.imcodes.example/releases/dev/android/imcodes-with-fcm-latest.apk'],
      ['android-without-fcm', 'https://cdn.imcodes.example/releases/dev/android/imcodes-without-fcm-latest.apk'],
      ['desktop-mac', `https://cdn.imcodes.example/releases/dev/imcodes-desktop-${devVersion}-darwin-arm64.pkg?v=${manifest.artifacts['desktop-installer-pkg:mac:arm64'].sha256.slice(0, 16)}`],
      ['desktop-mac-intel', `https://cdn.imcodes.example/releases/dev/imcodes-desktop-${devVersion}-darwin-x64.pkg?v=${manifest.artifacts['desktop-installer-pkg:mac:x64'].sha256.slice(0, 16)}`],
      ['desktop-win', `https://cdn.imcodes.example/releases/dev/imcodes-desktop-${devVersion}-win32-x64.exe?v=${manifest.artifacts['desktop-installer-exe:win:x64'].sha256.slice(0, 16)}`],
      ['desktop-linux-deb', `https://cdn.imcodes.example/releases/dev/imcodes-desktop-${devVersion}-linux-amd64.deb?v=${manifest.artifacts['desktop-installer-deb:linux:x64'].sha256.slice(0, 16)}`],
      ['desktop-linux-sh', `https://cdn.imcodes.example/releases/dev/imcodes-desktop-${devVersion}-linux-x64.sh?v=${manifest.artifacts['desktop-installer-sh:linux:x64'].sha256.slice(0, 16)}`],
    ];
    for (const [target, expectedUrl] of expectedMap) {
      const res = await devApp.request(`/api/downloads/latest/${target}`);
      expect(res.status, target).toBe(302);
      expect(res.headers.get('location'), target).toBe(expectedUrl);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }

    // Explicit ?channel=master switches Android APK URL to master/, and redirects cross-channel desktop to GitHub Releases.
    const androidMasterRes = await devApp.request('/api/downloads/latest/android-with-fcm?channel=master');
    expect(androidMasterRes.status).toBe(302);
    expect(androidMasterRes.headers.get('location')).toBe(
      'https://cdn.imcodes.example/releases/master/android/imcodes-with-fcm-latest.apk',
    );
    const desktopCrossRes = await devApp.request('/api/downloads/latest/desktop-mac?channel=master');
    expect(desktopCrossRes.status).toBe(302);
    expect(desktopCrossRes.headers.get('location')).toBe('https://github.com/im4codes/imcodes/releases/latest');

    // Invalid channel & unknown target fail closed.
    const badChannel = await devApp.request('/api/downloads/latest/android-with-fcm?channel=nightly');
    expect(badChannel.status).toBe(400);
    const badTarget = await devApp.request('/api/downloads/latest/../../etc/passwd');
    expect(badTarget.status).toBe(404);
    const unknownTarget = await devApp.request('/api/downloads/latest/unknown-target');
    expect(unknownTarget.status).toBe(404);

    // Presigned R2 mode when public base URL is absent.
    const accountId = 'a'.repeat(32);
    const presignApp = makeAppWithEnv({
      CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: undefined,
      CONTROLLED_NODE_ARTIFACT_R2_PREFIX: 'cdn',
      USE_R2_ARTIFACT: 'true',
      R2_ACCOUNT_ID: accountId,
      R2_BUCKET: 'imcodes-artifacts',
      R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    const presignedAndroid = await presignApp.request('/api/downloads/latest/android-without-fcm');
    expect(presignedAndroid.status).toBe(302);
    const presignedUrl = presignedAndroid.headers.get('location')!;
    expect(presignedUrl).toContain(`https://${accountId}.r2.cloudflarestorage.com/imcodes-artifacts/cdn/dev/android/imcodes-without-fcm-latest.apk`);
    expect(presignedUrl).toContain('X-Amz-Signature=');

    // Without R2 or GitHub: Android redirects to GitHub Releases; desktop falls back to verified local file stream.
    const fallbackApp = makeAppWithEnv({
      CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: undefined,
      USE_R2_ARTIFACT: 'false',
    });
    const androidFallback = await fallbackApp.request('/api/downloads/latest/android-with-fcm');
    expect(androidFallback.status).toBe(302);
    expect(androidFallback.headers.get('location')).toBe('https://github.com/im4codes/imcodes/releases');

    const desktopLocal = await fallbackApp.request('/api/downloads/latest/desktop-mac');
    expect(desktopLocal.status).toBe(200);
    expect(Buffer.from(await desktopLocal.arrayBuffer())).toEqual(pkgBytes);

    // LANDING_HOST through real buildApp lets /api/downloads/latest/* bypass landing HTML fallback without auth/CSRF.
    process.env.IMCODES_NODE_EXE_DIR = dir;
    process.env.CONTROLLED_NODE_ARTIFACT_R2_BASE_URL = 'https://cdn.imcodes.example';
    process.env.CONTROLLED_NODE_ARTIFACT_R2_PREFIX = 'releases';
    const fullApp = buildApp({
      DB: { queryOne: async () => null, execute: async () => ({ changes: 1 }) } as never,
      JWT_SIGNING_KEY: 'test-signing-key-32-bytes-minimum',
      BOT_ENCRYPTION_KEY: '0'.repeat(32),
      SERVER_URL: 'https://app.im.codes',
      ALLOWED_ORIGINS: '',
      TRUSTED_PROXIES: '',
      BIND_HOST: '127.0.0.1',
      PORT: '3000',
      NODE_ENV: 'test',
      LANDING_HOST: 'im.codes',
      CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: 'https://cdn.imcodes.example',
      CONTROLLED_NODE_ARTIFACT_R2_PREFIX: 'releases',
    } as never);
    const landingDownloadRes = await fullApp.request('http://im.codes/api/downloads/latest/android-with-fcm', {
      headers: { Host: 'im.codes' },
    });
    expect(landingDownloadRes.status).toBe(302);
    expect(landingDownloadRes.headers.get('location')).toBe(
      'https://cdn.imcodes.example/releases/dev/android/imcodes-with-fcm-latest.apk',
    );
  });

  it('redirects Linux remote-desktop worker and macOS component-set self-upgrades via R2 with exact sha256 parity', async () => {
    const dir = makeTempDir('imcodes-rd-r2-');
    process.env.IMCODES_NODE_EXE_DIR = dir;
    const version = '2026.11.7088';
    const { linuxRdBytes, manifest } = writeDesktopAndRdFixtures(dir, version);
    setR2ManifestFetchForTests(async () => new Response(JSON.stringify(manifest), { status: 200 }));

    const linuxToken = 'linux-token';
    const macToken = 'mac-token';
    const servers = new Map<string, Record<string, unknown>>([
      ['srv-linux', { id: 'srv-linux', token_hash: sha256Hex(linuxToken), node_role: NODE_ROLE.CONTROLLED, revoked_at: null, os: 'linux', arch: 'x64', abi_profile: 'modern', owner_status: USER_STATUS.ACTIVE }],
      ['srv-mac', { id: 'srv-mac', token_hash: sha256Hex(macToken), node_role: NODE_ROLE.CONTROLLED, revoked_at: null, os: 'mac', arch: 'x64', abi_profile: 'modern', owner_status: USER_STATUS.ACTIVE }],
    ]);

    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as unknown as { env: Record<string, unknown> }).env = {
        DB: {
          queryOne: async (_sql: string, params: unknown[]) => servers.get(String(params[0] ?? '')) ?? null,
          execute: async () => ({ changes: 1 }),
        },
        JWT_SIGNING_KEY: 'test-signing-key-32-bytes-minimum',
        BOT_ENCRYPTION_KEY: '0'.repeat(32),
        SERVER_URL: 'https://app.im.codes',
        ALLOWED_ORIGINS: '',
        TRUSTED_PROXIES: '',
        BIND_HOST: '127.0.0.1',
        PORT: '3000',
        NODE_ENV: 'test',
        CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: 'https://cdn.imcodes.example',
        CONTROLLED_NODE_ARTIFACT_R2_PREFIX: 'artifacts',
      };
      await next();
    });
    app.route('/api/enroll', createEnrollRoutes({ artifactCatalog: createArtifactCatalog() }));

    // Linux remote-desktop worker + manifest -> R2 master/ channel
    const linuxWorkerRes = await app.request(
      `/api/enroll/v2/node-artifact?serverId=srv-linux&os=linux&arch=x64&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER}`,
      {
        headers: {
          Authorization: `Bearer ${linuxToken}`,
          [CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION]: String(REMOTE_DESKTOP_PROTOCOL_VERSION),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.EXTERNAL_REDIRECT]: CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN,
        },
      },
    );
    expect(linuxWorkerRes.status).toBe(302);
    const linuxRdSha = sha256(linuxRdBytes);
    expect(linuxWorkerRes.headers.get('location')).toBe(
      `https://cdn.imcodes.example/artifacts/master/imcodes-linux-remote-desktop-worker-linux-x64?v=${linuxRdSha.slice(0, 16)}`,
    );
    expect(linuxWorkerRes.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256)).toBe(linuxRdSha);

    // macOS component set (arm64 + x64) -> R2 master/ channel + byte/sha256 parity with streamed set
    for (const arch of ['arm64', 'x64'] as const) {
      const macR2Res = await app.request(
        `/api/enroll/v2/node-artifact?serverId=srv-mac&os=mac&arch=${arch}&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_MACOS_COMPONENT_SET}`,
        {
          headers: {
            Authorization: `Bearer ${macToken}`,
            [CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION]: String(REMOTE_DESKTOP_PROTOCOL_VERSION),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.EXTERNAL_REDIRECT]: CONTROLLED_NODE_EXTERNAL_REDIRECT_OPT_IN,
          },
        },
      );
      expect(macR2Res.status, arch).toBe(302);
      const macSetSha = manifest.artifacts[`remote-desktop-macos-component-set:mac:${arch}`].sha256;
      expect(macR2Res.headers.get('location')).toBe(
        `https://cdn.imcodes.example/artifacts/master/imcodes-remote-desktop-darwin-${arch}.set?v=${macSetSha.slice(0, 16)}`,
      );
      expect(macR2Res.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256)).toBe(macSetSha);

      // Without opt-in header: streamed bytes match staged archive bytes byte-for-byte
      const macStreamRes = await app.request(
        `/api/enroll/v2/node-artifact?serverId=srv-mac&os=mac&arch=${arch}&asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_MACOS_COMPONENT_SET}`,
        {
          headers: {
            Authorization: `Bearer ${macToken}`,
            [CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION]: String(REMOTE_DESKTOP_PROTOCOL_VERSION),
          },
        },
      );
      expect(macStreamRes.status, arch).toBe(200);
      const streamed = Buffer.from(await macStreamRes.arrayBuffer());
      const staged = readFileSync(join(dir, '_staged', `imcodes-remote-desktop-darwin-${arch}.set`));
      expect(streamed.equals(staged)).toBe(true);
    }
  });

  it('defaults R2 distribution to https://dl.im.codes with empty env while respecting opt-out, custom overrides, fail-closed invalid URLs, and presign mode', async () => {
    expect(DEFAULT_CONTROLLED_NODE_ARTIFACT_R2_BASE_URL).toBe('https://dl.im.codes');

    // Empty env enables https://dl.im.codes out of the box for both channels.
    expect(resolveR2ObjectUrl({}, 'master/imcodes-node-linux')).toBe(
      'https://dl.im.codes/master/imcodes-node-linux',
    );
    expect(resolveR2ObjectUrl({ CONTROLLED_NODE_ARTIFACT_R2_PREFIX: 'pkg' }, 'dev/android/app.apk')).toBe(
      'https://dl.im.codes/pkg/dev/android/app.apk',
    );

    // USE_R2_ARTIFACT=false disables R2 completely even if a custom URL is present.
    expect(resolveR2ObjectUrl({ USE_R2_ARTIFACT: 'false' }, 'master/imcodes-node-linux')).toBeNull();
    expect(resolveR2ObjectUrl({
      USE_R2_ARTIFACT: 'false',
      CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: 'https://cdn.imcodes.example',
    }, 'master/imcodes-node-linux')).toBeNull();

    // Invalid explicit base URLs and empty string (without presign opt-in) fail closed instead of falling back to dl.im.codes.
    for (const bad of ['http://dl.im.codes', 'https://user:pass@dl.im.codes', 'not-a-url', '']) {
      expect(resolveR2ObjectUrl({ CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: bad }, 'master/imcodes-node-linux'), bad).toBeNull();
    }

    // Explicit valid URL overrides default.
    expect(resolveR2ObjectUrl({
      CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: 'https://custom.cdn.example/',
    }, 'master/imcodes-node-linux')).toBe('https://custom.cdn.example/master/imcodes-node-linux');

    // Private presigned bucket remains supported when USE_R2_ARTIFACT=true with credentials and empty/undefined base URL.
    const accountId = 'b'.repeat(32);
    for (const base of [undefined, '']) {
      const presigned = resolveR2ObjectUrl({
        CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: base,
        USE_R2_ARTIFACT: 'true',
        R2_ACCOUNT_ID: accountId,
        R2_BUCKET: 'private-artifacts',
        R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      }, 'dev/imcodes-node-linux');
      expect(presigned).toContain(`https://${accountId}.r2.cloudflarestorage.com/private-artifacts/dev/imcodes-node-linux`);
      expect(presigned).toContain('X-Amz-Signature=');
    }

    // Real routes & resolveControlledNodeExternalArtifact use https://dl.im.codes with empty env.
    for (const version of ['2026.11.7088', '2026.11.7088-dev.6988']) {
      const dir = makeTempDir('imcodes-dl-default-');
      const channel = resolveArtifactChannel(version);
      const { linuxRdBytes, manifest } = writeDesktopAndRdFixtures(dir, version);
      setR2ManifestFetchForTests(async () => new Response(JSON.stringify(manifest), { status: 200 }));

      const entry = manifest.artifacts['remote-desktop-worker:linux:x64'];
      const external = await resolveControlledNodeExternalArtifact(dir, {}, {
        asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER,
        os: 'linux',
        arch: 'x64',
        sha256: sha256(linuxRdBytes),
        sizeBytes: linuxRdBytes.length,
        version,
      });
      expect(external).toEqual({
        tier: 'r2',
        url: `https://dl.im.codes/${channel}/imcodes-linux-remote-desktop-worker-linux-x64?v=${entry.sha256.slice(0, 16)}`,
        entry,
      });
      // Presigned R2 URLs with SigV4 query signatures must NEVER be mutated with &v= / ?v=.
      const presignedExternal = await resolveControlledNodeExternalArtifact(dir, {
        CONTROLLED_NODE_ARTIFACT_R2_BASE_URL: undefined,
        USE_R2_ARTIFACT: 'true',
        R2_ACCOUNT_ID: accountId,
        R2_BUCKET: 'private-artifacts',
        R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      }, {
        asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER,
        os: 'linux',
        arch: 'x64',
        sha256: sha256(linuxRdBytes),
        sizeBytes: linuxRdBytes.length,
        version,
      });
      expect(presignedExternal?.tier).toBe('r2');
      expect(presignedExternal?.url).toContain('X-Amz-Signature=');
      expect(presignedExternal?.url).not.toContain('&v=');
      expect(presignedExternal?.url).not.toContain('?v=');

      expect(await resolveControlledNodeExternalArtifact(dir, { USE_R2_ARTIFACT: 'false' }, {
        asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER,
        os: 'linux',
        arch: 'x64',
        sha256: sha256(linuxRdBytes),
        sizeBytes: linuxRdBytes.length,
        version,
      })).toBeNull();

      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        (c as unknown as { env: Record<string, unknown> }).env = {};
        await next();
      });
      app.route('/api/downloads', createDownloadsRoutes(() => dir));

      const androidRes = await app.request('/api/downloads/latest/android-with-fcm');
      expect(androidRes.status).toBe(302);
      expect(androidRes.headers.get('location')).toBe(
        `https://dl.im.codes/${channel}/android/imcodes-with-fcm-latest.apk`,
      );

      const desktopRes = await app.request('/api/downloads/latest/desktop-mac');
      expect(desktopRes.status).toBe(302);
      expect(desktopRes.headers.get('location')).toBe(
        `https://dl.im.codes/${channel}/imcodes-desktop-${version}-darwin-arm64.pkg?v=${manifest.artifacts['desktop-installer-pkg:mac:arm64'].sha256.slice(0, 16)}`,
      );
    }
  });

  it('skips drifted, missing, or timed-out R2 live manifests (falling back to Tier 2 GitHub or Tier 3 origin), coalesces concurrent checks, and caches TTLs cleanly', async () => {
    const dir = makeTempDir('imcodes-r2-drift-');
    const serverVersion = '2026.11.7114-dev.7008';
    const { pkgBytes, linuxRdBytes, manifest: serverManifest } = writeDesktopAndRdFixtures(dir, serverVersion);
    const rdEntry = serverManifest.artifacts['remote-desktop-worker:linux:x64'];

    // 1. Live R2 manifest drifted to newer CI build dev.7012 -> skips R2 and falls back to Tier 2 GitHub when configured, or Tier 3 null/stream otherwise.
    const driftedManifest = {
      ...serverManifest,
      version: '2026.11.7119-dev.7012',
      artifacts: {
        ...serverManifest.artifacts,
        'remote-desktop-worker:linux:x64': {
          ...rdEntry,
          sha256: 'e'.repeat(64),
          sizeBytes: rdEntry.sizeBytes + 512,
          version: '2026.11.7119-dev.7012',
        },
        'desktop-installer-pkg:mac:arm64': {
          ...serverManifest.artifacts['desktop-installer-pkg:mac:arm64'],
          assetFilename: 'imcodes-desktop-2026.11.7119-dev.7012-darwin-arm64.pkg',
          sha256: 'd'.repeat(64),
          sizeBytes: pkgBytes.length + 128,
          version: '2026.11.7119-dev.7012',
        },
      },
    };
    const r2FetchSpy = vi.fn(async () => new Response(JSON.stringify(driftedManifest), { status: 200 }));
    setR2ManifestFetchForTests(r2FetchSpy as unknown as typeof fetch);

    const tier2Fallback = await resolveControlledNodeExternalArtifact(dir, {
      CONTROLLED_NODE_ARTIFACT_GITHUB_REPO: 'im4codes/imcodes',
      CONTROLLED_NODE_ARTIFACT_GITHUB_TAG: `controlled-node-v${serverVersion}`,
    }, {
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER,
      os: 'linux',
      arch: 'x64',
      sha256: sha256(linuxRdBytes),
      sizeBytes: linuxRdBytes.length,
      version: serverVersion,
    });
    expect(tier2Fallback).toEqual({
      tier: 'github',
      url: `https://github.com/im4codes/imcodes/releases/download/controlled-node-v${serverVersion}/${rdEntry.assetFilename}`,
      entry: rdEntry,
    });

    // Without GitHub configured, Tier 3 (null) is used and /api/downloads/latest streams verified local installer instead of redirecting to deleted R2 installer!
    const tier3Fallback = await resolveControlledNodeExternalArtifact(dir, {}, {
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER,
      os: 'linux',
      arch: 'x64',
      sha256: sha256(linuxRdBytes),
      sizeBytes: linuxRdBytes.length,
      version: serverVersion,
    });
    expect(tier3Fallback).toBeNull();

    const dlApp = new Hono<{ Bindings: Env }>();
    dlApp.use('*', async (c, next) => {
      (c as unknown as { env: Record<string, unknown> }).env = {};
      await next();
    });
    dlApp.route('/api/downloads', createDownloadsRoutes(() => dir));
    const desktopLocalFallback = await dlApp.request('/api/downloads/latest/desktop-mac');
    expect(desktopLocalFallback.status).toBe(200);
    expect(Buffer.from(await desktopLocalFallback.arrayBuffer())).toEqual(pkgBytes);

    // Cached across repeated lookups -> only 1 live R2 manifest fetch so far!
    expect(r2FetchSpy).toHaveBeenCalledTimes(1);

    // 2. Concurrent upgrades coalesce into a single R2 manifest request and TTL hit cache stops after 1 fetch.
    invalidateR2ReleaseManifestCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
    let concurrentFetchCount = 0;
    let releaseManifestFetch!: (res: Response) => void;
    setR2ManifestFetchForTests(vi.fn(async () => {
      concurrentFetchCount += 1;
      return await new Promise<Response>((resolve) => {
        releaseManifestFetch = resolve;
      });
    }) as unknown as typeof fetch);

    const pending30 = Promise.all(
      Array.from({ length: 30 }, () => resolveControlledNodeExternalArtifact(dir, {}, {
        asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER,
        os: 'linux',
        arch: 'x64',
        sha256: sha256(linuxRdBytes),
        sizeBytes: linuxRdBytes.length,
        version: serverVersion,
      })),
    );
    await vi.waitFor(() => {
      expect(concurrentFetchCount).toBe(1);
    });
    releaseManifestFetch(new Response(JSON.stringify(serverManifest), { status: 200 }));
    const results30 = await pending30;
    expect(concurrentFetchCount).toBe(1);
    for (const r of results30) {
      expect(r?.tier).toBe('r2');
    }

    // Within 60s hit TTL: still 1 fetch; after 60s expiry: re-fetches!
    vi.setSystemTime(new Date('2026-11-24T10:00:59Z'));
    expect((await resolveControlledNodeExternalArtifact(dir, {}, {
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER,
      os: 'linux',
      arch: 'x64',
      sha256: sha256(linuxRdBytes),
      sizeBytes: linuxRdBytes.length,
      version: serverVersion,
    }))?.tier).toBe('r2');
    expect(concurrentFetchCount).toBe(1);

    // 3. Unreachable/404 R2 fails open to Tier 3 without hanging, caches negative for 15s, and USE_R2_ARTIFACT=false skips R2 fetch entirely.
    setR2ManifestFetchForTests(vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch);
    const notFoundResult = await resolveControlledNodeExternalArtifact(dir, {}, {
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER,
      os: 'linux',
      arch: 'x64',
      sha256: sha256(linuxRdBytes),
      sizeBytes: linuxRdBytes.length,
      version: serverVersion,
    });
    expect(notFoundResult).toBeNull();

    const optOutFetch = vi.fn(async () => {
      throw new Error('should_not_fetch_when_r2_disabled');
    });
    setR2ManifestFetchForTests(optOutFetch as unknown as typeof fetch);
    expect(await resolveControlledNodeExternalArtifact(dir, { USE_R2_ARTIFACT: 'false' }, {
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER,
      os: 'linux',
      arch: 'x64',
      sha256: sha256(linuxRdBytes),
      sizeBytes: linuxRdBytes.length,
      version: serverVersion,
    })).toBeNull();
    expect(optOutFetch).not.toHaveBeenCalled();

    // Network/timeout failure also falls back cleanly to Tier 3.
    invalidateR2ReleaseManifestCache();
    setR2ManifestFetchForTests(vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch);
    expect(await resolveControlledNodeExternalArtifact(dir, {}, {
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER,
      os: 'linux',
      arch: 'x64',
      sha256: sha256(linuxRdBytes),
      sizeBytes: linuxRdBytes.length,
      version: serverVersion,
    })).toBeNull();
  });
});
