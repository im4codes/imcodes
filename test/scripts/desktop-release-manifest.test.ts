import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DESKTOP_RELEASE_MANIFEST_FILENAME,
  DESKTOP_RELEASE_MANIFEST_SCHEMA_VERSION,
  desktopReleaseTargetManifestFilename,
  mergeDesktopReleaseManifests,
  safeValidateDesktopReleaseManifest,
  validateDesktopReleaseManifest,
  verifyDesktopReleaseComponentIdentity,
} from '../../shared/desktop-release-manifest.js';
import {
  buildDesktopReleaseManifest,
  verifyDesktopReleaseManifest,
} from '../../scripts/desktop-release-manifest.mjs';
import { DAEMON_RUNTIME_CRITICAL_ENTRIES } from '../../scripts/daemon-runtime-artifacts.mjs';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function writeFileWithHash(filePath: string, content: string): { sha256: string; size: number } {
  mkdirSync(join(filePath, '..'), { recursive: true });
  const buf = Buffer.from(content, 'utf8');
  writeFileSync(filePath, buf);
  return { sha256: sha256Hex(buf), size: buf.length };
}

function makeFakeDaemonRuntimeManifest({
  dir,
  target,
  version,
  signer,
}: {
  dir: string;
  target: 'linux-x64' | 'darwin-arm64' | 'win32-x64';
  version: string;
  signer?: string;
}) {
  const [os, arch] = target.split('-');
  const format = os === 'win32' ? 'zip' : 'tar.gz';
  const archiveName = `daemon-runtime-${target}.${format}`;
  const archivePath = join(dir, 'daemon-runtime', archiveName);
  const archiveInfo = writeFileWithHash(archivePath, `archive-${target}-${version}`);
  const nodeRel = os === 'win32' ? 'node.exe' : 'bin/node';
  const manifest = {
    schemaVersion: 1,
    artifact: {
      fileName: archiveName,
      format,
      os,
      arch,
      size: archiveInfo.size,
      sha256: archiveInfo.sha256,
      ...(signer ? { authenticodeSignerSha256: signer } : {}),
    },
    entrypoint: {
      node: nodeRel,
      script: 'package/dist/src/index.js',
    },
    toolchain: {
      nodeVersion: 'v24.16.0',
      nodeProvider: 'official-node',
      nodeArchive: `node-v24.16.0-${os}-${arch}.${format}`,
      nodeArchiveSha256: 'a'.repeat(64),
    },
    build: {
      commit: '1234567890abcdef',
      version,
    },
    totalUncompressedBytes: DAEMON_RUNTIME_CRITICAL_ENTRIES.length * 10,
    fileCount: DAEMON_RUNTIME_CRITICAL_ENTRIES.length + 1,
    files: [
      { path: nodeRel, size: 10, sha256: 'b'.repeat(64), executable: true },
      ...DAEMON_RUNTIME_CRITICAL_ENTRIES.map((rel) => ({
        path: rel,
        size: 10,
        sha256: 'c'.repeat(64),
        executable: false,
      })),
    ],
  };
  // adjust totalUncompressedBytes accurately
  manifest.totalUncompressedBytes = manifest.files.length * 10;
  writeFileWithHash(join(dir, 'daemon-runtime', `daemon-runtime-${target}.manifest.json`), JSON.stringify(manifest, null, 2));
}

function seedTargetArtifacts(
  distDir: string,
  target: 'linux-x64' | 'darwin-arm64' | 'win32-x64',
  version: string,
  overrides: { rdVersion?: string; signer?: string; cuVersion?: string } = {},
) {
  const rdVer = overrides.rdVersion ?? version;
  const signer = overrides.signer ?? (target === 'win32-x64' ? 'd'.repeat(64) : undefined);

  if (target === 'linux-x64') {
    const nodeInfo = writeFileWithHash(join(distDir, 'imcodes-node-linux'), `node-${version}`);
    writeFileWithHash(
      join(distDir, 'imcodes-node-linux.manifest.json'),
      JSON.stringify({ schemaVersion: 1, artifact: { fileName: 'imcodes-node-linux', os: 'linux', arch: 'x64', size: nodeInfo.size, sha256: nodeInfo.sha256 }, build: { version } }),
    );
    const rdInfo = writeFileWithHash(join(distDir, 'remote-desktop-worker/linux-x64/imcodes-linux-remote-desktop-worker'), `rd-${rdVer}`);
    writeFileWithHash(
      join(distDir, 'remote-desktop-worker/linux-x64/imcodes-linux-remote-desktop-worker.manifest.json'),
      JSON.stringify({ artifact: { fileName: 'imcodes-linux-remote-desktop-worker', size: rdInfo.size, sha256: rdInfo.sha256 }, build: { version: rdVer } }),
    );
    writeFileWithHash(join(distDir, 'computer-use-helper/linux-x64/open-computer-use'), `cu-${version}`);
    if (overrides.cuVersion) {
      const cuInfo = writeFileWithHash(join(distDir, 'computer-use-helper/linux-x64/open-computer-use'), `cu-${overrides.cuVersion}`);
      writeFileWithHash(
        join(distDir, 'computer-use-helper/linux-x64/open-computer-use.manifest.json'),
        JSON.stringify({ schemaVersion: 1, artifact: { fileName: 'open-computer-use', size: cuInfo.size, sha256: cuInfo.sha256 }, build: { version: overrides.cuVersion } }),
      );
    }
    writeFileWithHash(join(distDir, `installers/imcodes-desktop-${version}-linux-x64.sh`), '#!/bin/sh\n');
    writeFileWithHash(join(distDir, `installers/imcodes-desktop-${version}-linux-amd64.deb`), 'deb-bytes');
    makeFakeDaemonRuntimeManifest({ dir: distDir, target, version });
    return;
  }

  if (target === 'darwin-arm64') {
    const nodeInfo = writeFileWithHash(join(distDir, 'imcodes-node-macos'), `node-${version}`);
    writeFileWithHash(
      join(distDir, 'imcodes-node-macos.manifest.json'),
      JSON.stringify({ schemaVersion: 1, artifact: { fileName: 'imcodes-node-macos', os: 'darwin', arch: 'universal', size: nodeInfo.size, sha256: nodeInfo.sha256 }, build: { version } }),
    );
    const rdInfo = writeFileWithHash(join(distDir, 'remote-desktop-worker/darwin-arm64/imcodes-remote-desktop-worker'), `rd-${rdVer}`);
    writeFileWithHash(
      join(distDir, 'remote-desktop-worker/darwin-arm64/imcodes-remote-desktop.manifest.json'),
      JSON.stringify({ manifestVersion: 4, workerVersion: rdVer, protocolVersion: 2, os: 'darwin', arch: 'arm64', components: { worker: { fileName: 'imcodes-remote-desktop-worker', size: rdInfo.size, sha256: rdInfo.sha256 } } }),
    );
    writeFileWithHash(join(distDir, 'computer-use-helper/darwin-universal/open-computer-use.app.zip'), `cu-${version}`);
    writeFileWithHash(join(distDir, `installers/imcodes-desktop-${version}-darwin-arm64.pkg`), 'pkg-bytes');
    makeFakeDaemonRuntimeManifest({ dir: distDir, target, version });
    return;
  }

  // win32-x64
  const nodeInfo = writeFileWithHash(join(distDir, 'imcodes-node.exe'), `node-${version}`);
  writeFileWithHash(
    join(distDir, 'imcodes-node.exe.manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      artifact: { fileName: 'imcodes-node.exe', os: 'win32', arch: 'x64', size: nodeInfo.size, sha256: nodeInfo.sha256, authenticodeSignerSha256: signer },
      build: { version },
    }),
  );
  const rdInfo = writeFileWithHash(join(distDir, 'remote-desktop-worker/win32-x64/imcodes-remote-desktop-worker.exe'), `rd-${rdVer}`);
  writeFileWithHash(
    join(distDir, 'remote-desktop-worker/win32-x64/imcodes-remote-desktop-worker.exe.manifest.json'),
    JSON.stringify({
      manifestVersion: 2,
      fileName: 'imcodes-remote-desktop-worker.exe',
      size: rdInfo.size,
      sha256: rdInfo.sha256,
      workerVersion: rdVer,
      protocolVersion: 2,
      authenticodeSignerSha256: signer,
    }),
  );
  writeFileWithHash(join(distDir, 'computer-use-helper/win32-x64/open-computer-use.exe'), `cu-${version}`);
  writeFileWithHash(join(distDir, `installers/imcodes-desktop-${version}-win32-x64.exe`), 'exe-bytes');
  makeFakeDaemonRuntimeManifest({ dir: distDir, target, version, signer });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('desktop release manifest', () => {
  it('builds, verifies, and merges 4-component manifests for linux, darwin, and win32 targets', async () => {
    const version = '2026.5.3000-dev.1';
    const gitSha = 'abcdef1234567890';
    const linuxDir = makeTempDir('drm-linux-');
    const macDir = makeTempDir('drm-mac-');
    const winDir = makeTempDir('drm-win-');
    seedTargetArtifacts(linuxDir, 'linux-x64', version);
    seedTargetArtifacts(macDir, 'darwin-arm64', version);
    seedTargetArtifacts(winDir, 'win32-x64', version);

    const linuxOut = join(linuxDir, desktopReleaseTargetManifestFilename('linux-x64'));
    const macOut = join(macDir, desktopReleaseTargetManifestFilename('darwin-arm64'));
    const winOut = join(winDir, desktopReleaseTargetManifestFilename('win32-x64'));

    await buildDesktopReleaseManifest({ distDir: linuxDir, target: 'linux-x64', releaseVersion: version, gitSha, outPath: linuxOut });
    await buildDesktopReleaseManifest({ distDir: macDir, target: 'darwin-arm64', releaseVersion: version, gitSha, outPath: macOut });
    await buildDesktopReleaseManifest({ distDir: winDir, target: 'win32-x64', releaseVersion: version, gitSha, outPath: winOut });

    const verifiedLinux = await verifyDesktopReleaseManifest(linuxOut, { distDir: linuxDir, expectedVersion: version, expectedGitSha: gitSha, target: 'linux-x64' });
    const verifiedMac = await verifyDesktopReleaseManifest(macOut, { distDir: macDir, expectedVersion: version, expectedGitSha: gitSha, target: 'darwin-arm64' });
    const verifiedWin = await verifyDesktopReleaseManifest(winOut, { distDir: winDir, expectedVersion: version, expectedGitSha: gitSha, target: 'win32-x64' });

    expect(verifiedLinux.schemaVersion).toBe(DESKTOP_RELEASE_MANIFEST_SCHEMA_VERSION);
    expect(verifiedLinux.targets['linux-x64']?.installers?.map((i) => i.kind).sort()).toEqual(['deb', 'sh']);
    expect(verifiedMac.targets['darwin-arm64']?.components['imcodes-node'].compat.arch).toBe('universal');
    expect(verifiedWin.targets['win32-x64']?.components['daemon-runtime'].compat.nodeVersion).toBe('v24.16.0');

    const merged = mergeDesktopReleaseManifests([verifiedLinux, verifiedMac, verifiedWin]);
    expect(Object.keys(merged.targets).sort()).toEqual(['darwin-arm64', 'linux-x64', 'win32-x64']);
    expect(verifyDesktopReleaseComponentIdentity(merged, 'win32-x64', 'remote-desktop', {
      version,
      sha256: verifiedWin.targets['win32-x64']!.components['remote-desktop'].sha256,
      protocolVersion: 2,
    }).ok).toBe(true);

    // Aggregate merge CLI helper
    const mergedOut = join(linuxDir, DESKTOP_RELEASE_MANIFEST_FILENAME);
    await buildDesktopReleaseManifest({ mergeManifestPaths: [linuxOut, macOut, winOut], releaseVersion: version, gitSha, outPath: mergedOut });
    const loadedMerged = validateDesktopReleaseManifest(JSON.parse(readFileSync(mergedOut, 'utf8')));
    expect(Object.keys(loadedMerged.targets).sort()).toEqual(['darwin-arm64', 'linux-x64', 'win32-x64']);
  });

  it('rejects unaligned component versions unless explicitly covered by compatRules', async () => {
    const version = '2026.5.3000';
    const gitSha = '1234567890abcdef';
    const linuxDir = makeTempDir('drm-mismatch-');
    seedTargetArtifacts(linuxDir, 'linux-x64', version, { rdVersion: '2026.5.2999' });

    await expect(
      buildDesktopReleaseManifest({ distDir: linuxDir, target: 'linux-x64', releaseVersion: version, gitSha }),
    ).rejects.toThrow(/is not aligned with releaseVersion/);

    const allowed = await buildDesktopReleaseManifest({
      distDir: linuxDir,
      target: 'linux-x64',
      releaseVersion: version,
      gitSha,
      compatRules: [
        {
          component: 'remote-desktop',
          target: 'linux-x64',
          allowedVersion: '2026.5.2999',
          reason: 'protocol v2 binary compatible with release',
        },
      ],
    });
    expect(allowed.targets['linux-x64']?.components['remote-desktop'].version).toBe('2026.5.2999');
  });

  it('fails verification when an artifact file or manifest field is tampered', async () => {
    const version = '2026.5.3000';
    const gitSha = '1234567890abcdef';
    const winDir = makeTempDir('drm-tamper-');
    seedTargetArtifacts(winDir, 'win32-x64', version);
    const outPath = join(winDir, desktopReleaseTargetManifestFilename('win32-x64'));
    const manifest = await buildDesktopReleaseManifest({ distDir: winDir, target: 'win32-x64', releaseVersion: version, gitSha, outPath });

    // Tamper component binary bytes
    writeFileSync(join(winDir, 'computer-use-helper/win32-x64/open-computer-use.exe'), 'tampered!');
    await expect(verifyDesktopReleaseManifest(outPath, { distDir: winDir })).rejects.toThrow(/size mismatch|sha256 mismatch/);

    // Reject path traversal & signer mismatch in schema validation
    const cloned = JSON.parse(JSON.stringify(manifest));
    cloned.targets['win32-x64'].components['imcodes-node'].relativePath = '../../etc/passwd';
    expect(safeValidateDesktopReleaseManifest(cloned).ok).toBe(false);

    const signerBroken = JSON.parse(JSON.stringify(manifest));
    signerBroken.targets['win32-x64'].components['remote-desktop'].compat.authenticodeSignerSha256 = 'e'.repeat(64);
    expect(safeValidateDesktopReleaseManifest(signerBroken).ok).toBe(false);
  });
});
