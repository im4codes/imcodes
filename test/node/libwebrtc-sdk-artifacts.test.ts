import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LIBWEBRTC_SDK_ARCHIVE_FILENAME,
  LIBWEBRTC_SDK_MANIFEST_FILENAME,
  computeLibwebrtcSdkSourceSha256,
  createLibwebrtcSdkDirectory,
  createLibwebrtcSdkLock,
  materializeLibwebrtcSdk,
  validateLibwebrtcSdkLock,
  validateLibwebrtcSdkManifest,
  verifyLibwebrtcSdkDirectory,
  verifyLibwebrtcSdkLock,
} from '../../scripts/libwebrtc-sdk-artifacts.mjs';
import {
  PINNED_DEPOT_TOOLS_REVISION,
  PINNED_LIBWEBRTC_REVISION,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME,
  REMOTE_DESKTOP_WORKER_FILENAME,
} from '../../scripts/remote-desktop-worker-artifacts.mjs';

const roots: string[] = [];

async function sha256(value: string | Buffer): Promise<string> {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-libwebrtc-sdk-test-'));
  roots.push(root);
  const release = join(root, 'release');
  const platform = join(release, 'remote-desktop-worker', 'win32-x64');
  await mkdir(platform, { recursive: true });
  const worker = Buffer.from('signed-worker');
  const virtualDisplay = Buffer.from('signed-virtual-display');
  const workerSha256 = await sha256(worker);
  const virtualDisplaySha256 = await sha256(virtualDisplay);
  await Promise.all([
    writeFile(join(platform, REMOTE_DESKTOP_WORKER_FILENAME), worker),
    writeFile(join(platform, REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME), virtualDisplay),
    writeFile(join(platform, `${REMOTE_DESKTOP_WORKER_FILENAME}.manifest.json`), JSON.stringify({
      manifestVersion: 2,
      workerVersion: '2026.8.13',
      protocolVersion: 2,
      ipcVersion: 1,
      os: 'win32',
      arch: 'x64',
      fileName: REMOTE_DESKTOP_WORKER_FILENAME,
      size: worker.length,
      sha256: workerSha256,
      authenticodeSignerSha256: 'a'.repeat(64),
      libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
      virtualDisplay: {
        archiveFileName: REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
        packageManifestFileName: REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME,
        size: virtualDisplay.length,
        sha256: virtualDisplaySha256,
      },
      toolchain: {
        msvc: '14.44.35207',
        windowsSdk: '10.0.26100.0',
        cmake: 'not-used-gn',
        ninja: '1.13.1',
        depotTools: PINNED_DEPOT_TOOLS_REVISION,
      },
    })),
  ]);
  return { root, release, worker, virtualDisplay };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('fixed libwebrtc SDK artifacts', () => {
  it('binds a fixed signed native release to the current native source fingerprint', async () => {
    const { root, release } = await fixture();
    const sdk = join(root, 'sdk');
    const sourceSha256 = await computeLibwebrtcSdkSourceSha256();
    const result = await createLibwebrtcSdkDirectory(
      release,
      sdk,
      '1'.repeat(40),
    );

    expect(result.manifest).toMatchObject({
      manifestVersion: 1,
      sourceSha256,
      sourceCommit: '1'.repeat(40),
      libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
      depotToolsRevision: PINNED_DEPOT_TOOLS_REVISION,
    });
    await expect(verifyLibwebrtcSdkDirectory(sdk)).resolves.toMatchObject({
      manifest: { sourceSha256 },
    });
  });

  it('normalizes Git CRLF PowerShell checkouts into one cross-platform source fingerprint', async () => {
    const script = 'scripts/windows-sign-release-artifact.ps1';
    const original = await readFile(script);
    const lf = original.toString('utf8').replace(/\r\n/g, '\n');
    const expected = await computeLibwebrtcSdkSourceSha256();
    try {
      await writeFile(script, lf.replace(/\n/g, '\r\n'));
      await expect(computeLibwebrtcSdkSourceSha256()).resolves.toBe(expected);
    } finally {
      await writeFile(script, original);
    }
  });

  it('materializes a per-release manifest without rebuilding the fixed signed binaries', async () => {
    const { root, release, worker, virtualDisplay } = await fixture();
    const sdk = join(root, 'sdk');
    const output = join(root, 'output');
    await createLibwebrtcSdkDirectory(release, sdk, '2'.repeat(40));

    const materialized = await materializeLibwebrtcSdk(sdk, output, '2026.8.1401');
    expect(materialized.manifest.workerVersion).toBe('2026.8.1401');
    await expect(readFile(materialized.executablePath)).resolves.toEqual(worker);
    await expect(readFile(materialized.archivePath)).resolves.toEqual(virtualDisplay);
  });

  it('fails closed on changed bytes, extra entries, source mismatch, and lock tampering', async () => {
    const { root, release } = await fixture();
    const sdk = join(root, 'sdk');
    await createLibwebrtcSdkDirectory(release, sdk, '3'.repeat(40));

    await writeFile(join(sdk, REMOTE_DESKTOP_WORKER_FILENAME), 'tampered');
    await expect(verifyLibwebrtcSdkDirectory(sdk)).rejects.toThrow('worker hash or size mismatch');

    await createLibwebrtcSdkDirectory(release, sdk, '3'.repeat(40));
    await writeFile(join(sdk, 'unexpected.obj'), 'unexpected');
    await expect(verifyLibwebrtcSdkDirectory(sdk)).rejects.toThrow('unexpected entries');

    const manifest = JSON.parse(await readFile(join(sdk, LIBWEBRTC_SDK_MANIFEST_FILENAME), 'utf8'));
    expect(() => validateLibwebrtcSdkManifest({ ...manifest, sourceSha256: 'f'.repeat(64) }, manifest.sourceSha256))
      .toThrow('invalid libwebrtc SDK manifest');

    const archive = join(root, LIBWEBRTC_SDK_ARCHIVE_FILENAME);
    const lockPath = join(root, 'lock.json');
    await writeFile(archive, 'fixed-sdk-archive');
    await createLibwebrtcSdkDirectory(release, sdk, '3'.repeat(40));
    const lock = await createLibwebrtcSdkLock(archive, sdk, lockPath);
    await expect(verifyLibwebrtcSdkLock(lockPath, archive, sdk)).resolves.toEqual(lock);
    const sdkManifest = JSON.parse(await readFile(join(sdk, LIBWEBRTC_SDK_MANIFEST_FILENAME), 'utf8'));
    expect(lock).toMatchObject({
      sourceCommit: '3'.repeat(40),
      workerSha256: sdkManifest.worker.sha256,
      virtualDisplaySha256: sdkManifest.virtualDisplay.sha256,
      authenticodeSignerSha256: sdkManifest.worker.authenticodeSignerSha256,
      toolchain: sdkManifest.toolchain,
    });
    await writeFile(join(sdk, LIBWEBRTC_SDK_MANIFEST_FILENAME), JSON.stringify({
      ...sdkManifest,
      sourceCommit: '4'.repeat(40),
    }));
    await expect(verifyLibwebrtcSdkLock(lockPath, archive, sdk)).rejects.toThrow('contents do not match');
    await writeFile(archive, 'tampered-sdk-archive');
    await expect(verifyLibwebrtcSdkLock(lockPath, archive)).rejects.toThrow('does not match');
    expect(() => validateLibwebrtcSdkLock({ ...lock, releaseTag: 'latest' }, lock.sourceSha256))
      .toThrow('invalid libwebrtc SDK lock');
  });
});
