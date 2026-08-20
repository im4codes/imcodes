import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PINNED_DEPOT_TOOLS_REVISION,
  PINNED_LIBWEBRTC_REVISION,
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
  verifyRemoteDesktopWorkerArtifactSet,
} from '../../scripts/remote-desktop-worker-artifacts.mjs';
import {
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_FILES,
  validateRemoteDesktopVirtualDisplayPackageManifest,
} from '../../shared/remote-desktop-worker.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeArtifact(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-rd-release-artifact-'));
  dirs.push(root);
  const dir = join(root, 'remote-desktop-worker', 'win32-x64');
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.from('immutable worker bytes');
  const executable = join(dir, REMOTE_DESKTOP_WORKER_FILENAME);
  const archiveBytes = Buffer.from('signed virtual display archive');
  await writeFile(join(dir, REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME), archiveBytes);
  await writeFile(executable, bytes);
  const manifest = {
    manifestVersion: 2,
    workerVersion: '2026.8.1234',
    protocolVersion: 2,
    ipcVersion: 1,
    os: 'win32',
    arch: 'x64',
    fileName: REMOTE_DESKTOP_WORKER_FILENAME,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    authenticodeSignerSha256: 'c'.repeat(64),
    libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
    virtualDisplay: {
      archiveFileName: REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
      packageManifestFileName: 'imcodes-virtual-display.manifest.json',
      size: archiveBytes.length,
      sha256: createHash('sha256').update(archiveBytes).digest('hex'),
    },
    toolchain: {
      msvc: '14.44.35207',
      windowsSdk: '10.0.26100.0',
      cmake: 'not-used-gn',
      ninja: '1.13.1',
      depotTools: PINNED_DEPOT_TOOLS_REVISION,
    },
    ...overrides,
  };
  await writeFile(`${executable}.manifest.json`, `${JSON.stringify(manifest)}\n`);
  return root;
}

describe('remote desktop worker release artifact verifier', () => {
  it('requires both Microsoft and pinned WebRTC notices in the driver package', () => {
    const manifest = {
      manifestVersion: 1,
      hardwareId: 'ImcodesVirtualDisplay',
      dllSignerSha256: 'a'.repeat(64),
      catalogSignerSha256: 'b'.repeat(64),
      files: REMOTE_DESKTOP_VIRTUAL_DISPLAY_FILES.map((name) => ({
        name,
        size: 1,
        sha256: 'c'.repeat(64),
      })),
    };
    expect(validateRemoteDesktopVirtualDisplayPackageManifest(manifest)).not.toBeNull();
    expect(validateRemoteDesktopVirtualDisplayPackageManifest({
      ...manifest,
      files: manifest.files.filter(({ name }) => name !== 'THIRD_PARTY_NOTICES.webrtc.md'),
    })).toBeNull();
  });

  it('accepts only the exact pinned artifact, toolchain, and release version', async () => {
    const root = await writeArtifact();
    await expect(verifyRemoteDesktopWorkerArtifactSet(root, '2026.8.1234'))
      .resolves.toMatchObject({ manifest: { workerVersion: '2026.8.1234' } });
    await expect(verifyRemoteDesktopWorkerArtifactSet(root, '2026.8.1235'))
      .rejects.toThrow(/invalid remote desktop worker manifest/);
  });

  it('fails closed on a digest or pinned depot_tools revision mismatch', async () => {
    const badDigest = await writeArtifact({ sha256: '0'.repeat(64) });
    await expect(verifyRemoteDesktopWorkerArtifactSet(badDigest, '2026.8.1234'))
      .rejects.toThrow(/sha256 mismatch/);

    const badToolchain = await writeArtifact({
      toolchain: {
        msvc: '14.44.35207',
        windowsSdk: '10.0.26100.0',
        cmake: 'not-used-gn',
        ninja: '1.13.1',
        depotTools: 'b'.repeat(40),
      },
    });
    await expect(verifyRemoteDesktopWorkerArtifactSet(badToolchain, '2026.8.1234'))
      .rejects.toThrow(/invalid remote desktop worker manifest/);
  });

  it('rejects intermediate or unmanifested files from the release artifact', async () => {
    const root = await writeArtifact();
    await writeFile(join(root, 'remote-desktop-worker', 'win32-x64', 'unexpected.obj'), 'build output');
    await expect(verifyRemoteDesktopWorkerArtifactSet(root, '2026.8.1234'))
      .rejects.toThrow(/unexpected entries/);
  });
});
