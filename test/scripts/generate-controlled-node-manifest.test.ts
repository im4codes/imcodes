import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateControlledNodeReleaseManifest } from '../../scripts/generate-controlled-node-manifest.mjs';
import { CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_FILENAME } from '../../shared/controlled-node-artifacts.js';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('generate-controlled-node-manifest script', () => {
  it('generates deterministic flat release asset entries and stages unique filenames', () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes-release-manifest-'));
    tempDirs.push(root);
    const artifactsDir = join(root, 'artifacts');
    const stageDir = join(root, 'stage');
    mkdirSync(artifactsDir, { recursive: true });

    const linuxBytes = Buffer.from('linux-node-exe-bytes');
    writeFileSync(join(artifactsDir, 'imcodes-node-linux'), linuxBytes);
    writeFileSync(
      join(artifactsDir, 'imcodes-node-linux.manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        build: { version: '2026.11.1' },
        artifact: {
          fileName: 'imcodes-node-linux',
          os: 'linux',
          arch: 'x64',
          abiProfile: 'modern',
          size: linuxBytes.length,
          sha256: sha256(linuxBytes),
        },
      }),
    );

    const winWorkerDir = join(artifactsDir, 'remote-desktop-worker', 'win32-x64');
    const linuxWorkerDir = join(artifactsDir, 'remote-desktop-worker', 'linux-x64');
    mkdirSync(winWorkerDir, { recursive: true });
    mkdirSync(linuxWorkerDir, { recursive: true });
    const winWorkerBytes = Buffer.from('win-worker');
    const linuxWorkerBytes = Buffer.from('linux-worker');
    writeFileSync(join(winWorkerDir, 'imcodes-remote-desktop-worker.exe'), winWorkerBytes);
    writeFileSync(
      join(winWorkerDir, 'imcodes-remote-desktop-worker.exe.manifest.json'),
      JSON.stringify({ workerVersion: '2026.11.1' }),
    );
    writeFileSync(join(linuxWorkerDir, 'imcodes-remote-desktop-worker'), linuxWorkerBytes);
    writeFileSync(
      join(linuxWorkerDir, 'imcodes-remote-desktop-worker.manifest.json'),
      JSON.stringify({ workerVersion: '2026.11.1' }),
    );

    const helperDir = join(artifactsDir, 'computer-use-helper', 'darwin-universal');
    mkdirSync(helperDir, { recursive: true });
    const helperBytes = Buffer.from('mac-helper-zip');
    writeFileSync(join(helperDir, 'open-computer-use.app.zip'), helperBytes);

    const { manifest, outputPath } = generateControlledNodeReleaseManifest({
      artifactsDir,
      stageDir,
    });

    expect(outputPath).toBe(join(artifactsDir, CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_FILENAME));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.version).toBe('2026.11.1');
    expect(manifest.artifacts['node:linux:x64']).toMatchObject({
      asset: 'node',
      assetFilename: 'imcodes-node-linux',
      sha256: sha256(linuxBytes),
      sizeBytes: linuxBytes.length,
      version: '2026.11.1',
    });
    expect(manifest.artifacts['remote-desktop-worker:win:x64']?.assetFilename)
      .toBe('imcodes-remote-desktop-worker-win32-x64.exe');
    expect(manifest.artifacts['remote-desktop-worker:linux:x64']?.assetFilename)
      .toBe('imcodes-remote-desktop-worker-linux-x64');
    expect(manifest.artifacts['computer-use-helper:mac:universal']?.assetFilename)
      .toBe('open-computer-use-darwin-universal.app.zip');

    expect(existsSync(join(stageDir, CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_FILENAME))).toBe(true);
    expect(readFileSync(join(stageDir, 'imcodes-node-linux'))).toEqual(linuxBytes);
    expect(readFileSync(join(stageDir, 'open-computer-use-darwin-universal.app.zip'))).toEqual(helperBytes);
  });

  it('rejects a node binary whose digest disagrees with its node manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes-release-manifest-bad-'));
    tempDirs.push(root);
    const artifactsDir = join(root, 'artifacts');
    mkdirSync(artifactsDir, { recursive: true });

    writeFileSync(join(artifactsDir, 'imcodes-node-linux'), Buffer.from('actual'));
    writeFileSync(
      join(artifactsDir, 'imcodes-node-linux.manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        build: { version: '2026.11.1' },
        artifact: {
          fileName: 'imcodes-node-linux',
          os: 'linux',
          arch: 'x64',
          size: 6,
          sha256: '0'.repeat(64),
        },
      }),
    );

    expect(() => generateControlledNodeReleaseManifest({ artifactsDir }))
      .toThrow('node_manifest_sha256_mismatch:imcodes-node-linux');
  });

  it('records and stages win32-x64 daemon-runtime, unified installers, and merged desktop-release.manifest.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes-release-unified-'));
    tempDirs.push(root);
    const artifactsDir = join(root, 'artifacts');
    const stageDir = join(root, 'stage');
    const drDir = join(artifactsDir, 'daemon-runtime');
    const installersDir = join(artifactsDir, 'installers');
    mkdirSync(drDir, { recursive: true });
    mkdirSync(installersDir, { recursive: true });

    const releaseVersion = '2026.11.1';
    const gitSha = 'a'.repeat(40);
    const nodeCompatSha = 'b'.repeat(64);
    const rdSha = 'c'.repeat(64);
    const cuSha = 'd'.repeat(64);

    const makeDrBundle = (target: string, osName: 'win32' | 'darwin' | 'linux', arch: string, ext: 'zip' | 'tar.gz') => {
      const archiveFile = `daemon-runtime-${target}.${ext}`;
      const bytes = Buffer.from(`runtime-${target}`);
      writeFileSync(join(drDir, archiveFile), bytes);
      const sidecarFile = `daemon-runtime-${target}.manifest.json`;
      writeFileSync(
        join(drDir, sidecarFile),
        JSON.stringify({
          schemaVersion: 1,
          build: { version: releaseVersion, commit: gitSha },
          artifact: {
            fileName: archiveFile,
            format: ext,
            os: osName,
            arch,
            size: bytes.length,
            sha256: sha256(bytes),
          },
        }),
      );
      return { archiveFile, sidecarFile, bytes };
    };

    const winDr = makeDrBundle('win32-x64', 'win32', 'x64', 'zip');
    const linuxDr = makeDrBundle('linux-x64', 'linux', 'x64', 'tar.gz');
    const macDr = makeDrBundle('darwin-arm64', 'darwin', 'arm64', 'tar.gz');

    const debBytes = Buffer.from('deb-installer');
    const shBytes = Buffer.from('#!/bin/sh\necho ok\n');
    const pkgBytes = Buffer.from('pkg-installer');
    const exeBytes = Buffer.from('exe-installer');

    const debName = `imcodes-desktop-${releaseVersion}-linux-amd64.deb`;
    const shName = `imcodes-desktop-${releaseVersion}-linux-x64.sh`;
    const pkgName = `imcodes-desktop-${releaseVersion}-darwin-arm64.pkg`;
    const exeName = `imcodes-desktop-${releaseVersion}-win32-x64.exe`;

    writeFileSync(join(installersDir, debName), debBytes);
    writeFileSync(join(installersDir, shName), shBytes);
    writeFileSync(join(installersDir, pkgName), pkgBytes);
    writeFileSync(join(installersDir, exeName), exeBytes);
    writeFileSync(
      join(installersDir, `${exeName}.manifest.json`),
      JSON.stringify({
        schemaVersion: 1,
        artifact: { filename: exeName, size: exeBytes.length, sha256: sha256(exeBytes) },
      }),
    );

    const writeTargetRelease = (
      target: string,
      osName: 'win32' | 'darwin' | 'linux',
      arch: string,
      dr: { archiveFile: string; sidecarFile: string; bytes: Buffer },
      installers: Array<{ kind: string; fileName: string; bytes: Buffer; manifestFileName?: string }>,
    ) => {
      writeFileSync(
        join(artifactsDir, `desktop-release-${target}.manifest.json`),
        JSON.stringify({
          schemaVersion: 1,
          releaseVersion,
          gitSha,
          generatedAt: '2026-11-15T00:00:00.000Z',
          targets: {
            [target]: {
              target,
              os: osName,
              arch,
              components: {
                'imcodes-node': { fileName: 'node', sha256: nodeCompatSha, sizeBytes: 10, version: releaseVersion, compat: { os: osName, arch } },
                'remote-desktop': { fileName: 'rd', sha256: rdSha, sizeBytes: 10, version: releaseVersion, compat: { os: osName, arch } },
                'open-computer-use': { fileName: 'cu', sha256: cuSha, sizeBytes: 10, version: releaseVersion, compat: { os: osName, arch } },
                'daemon-runtime': {
                  fileName: dr.archiveFile,
                  relativePath: `daemon-runtime/${dr.archiveFile}`,
                  sha256: sha256(dr.bytes),
                  sizeBytes: dr.bytes.length,
                  manifestFileName: dr.sidecarFile,
                  version: releaseVersion,
                  compat: { os: osName, arch },
                },
              },
              installers: installers.map((inst) => ({
                kind: inst.kind,
                fileName: inst.fileName,
                relativePath: `installers/${inst.fileName}`,
                sha256: sha256(inst.bytes),
                sizeBytes: inst.bytes.length,
                version: releaseVersion,
                ...(inst.manifestFileName ? { manifestFileName: inst.manifestFileName } : {}),
              })),
            },
          },
        }),
      );
    };

    writeTargetRelease('win32-x64', 'win32', 'x64', winDr, [
      { kind: 'exe', fileName: exeName, bytes: exeBytes, manifestFileName: `${exeName}.manifest.json` },
    ]);
    writeTargetRelease('linux-x64', 'linux', 'x64', linuxDr, [
      { kind: 'deb', fileName: debName, bytes: debBytes },
      { kind: 'sh', fileName: shName, bytes: shBytes },
    ]);
    writeTargetRelease('darwin-arm64', 'darwin', 'arm64', macDr, [
      { kind: 'pkg', fileName: pkgName, bytes: pkgBytes },
    ]);

    const { manifest } = generateControlledNodeReleaseManifest({
      artifactsDir,
      version: releaseVersion,
      stageDir,
    });

    expect(manifest.artifacts['daemon-runtime:win:x64']?.assetFilename).toBe(winDr.archiveFile);
    expect(manifest.artifacts['daemon-runtime-manifest:win:x64']?.assetFilename).toBe(winDr.sidecarFile);
    expect(manifest.artifacts['desktop-release-manifest:win:x64']?.assetFilename).toBe('desktop-release-win32-x64.manifest.json');
    expect(manifest.artifacts['desktop-installer-exe:win:x64']?.assetFilename).toBe(exeName);
    expect(manifest.artifacts['desktop-installer-deb:linux:x64']?.assetFilename).toBe(debName);
    expect(manifest.artifacts['desktop-installer-sh:linux:x64']?.assetFilename).toBe(shName);
    expect(manifest.artifacts['desktop-installer-pkg:mac:arm64']?.assetFilename).toBe(pkgName);
    expect(manifest.artifacts['desktop-release-manifest']?.assetFilename).toBe('desktop-release.manifest.json');

    for (const flatFile of [
      winDr.archiveFile,
      winDr.sidecarFile,
      'desktop-release-win32-x64.manifest.json',
      'desktop-release-linux-x64.manifest.json',
      'desktop-release-darwin-arm64.manifest.json',
      'desktop-release.manifest.json',
      debName,
      shName,
      pkgName,
      exeName,
    ]) {
      expect(existsSync(join(stageDir, flatFile)), `staged ${flatFile}`).toBe(true);
    }

    const merged = JSON.parse(readFileSync(join(stageDir, 'desktop-release.manifest.json'), 'utf8'));
    expect(merged.releaseVersion).toBe(releaseVersion);
    expect(merged.gitSha).toBe(gitSha);
    expect(Object.keys(merged.targets).sort()).toEqual(['darwin-arm64', 'linux-x64', 'win32-x64']);
  });

  it('fails closed on desktop installer digest mismatch and gitSha mismatch across target manifests', () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes-release-unified-bad-'));
    tempDirs.push(root);
    const artifactsDir = join(root, 'artifacts');
    const installersDir = join(artifactsDir, 'installers');
    mkdirSync(installersDir, { recursive: true });

    const releaseVersion = '2026.11.1';
    const exeName = `imcodes-desktop-${releaseVersion}-win32-x64.exe`;
    writeFileSync(join(installersDir, exeName), Buffer.from('actual-exe-bytes'));
    writeFileSync(
      join(artifactsDir, 'desktop-release-win32-x64.manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        releaseVersion,
        gitSha: 'a'.repeat(40),
        targets: {
          'win32-x64': {
            target: 'win32-x64',
            os: 'win32',
            arch: 'x64',
            components: {},
            installers: [{
              kind: 'exe',
              fileName: exeName,
              relativePath: `installers/${exeName}`,
              sha256: '0'.repeat(64),
              sizeBytes: 16,
              version: releaseVersion,
            }],
          },
        },
      }),
    );

    expect(() => generateControlledNodeReleaseManifest({ artifactsDir, version: releaseVersion }))
      .toThrow(`desktop_installer_sha256_mismatch:installers/${exeName}`);

    // Fix digest and add a second target with a conflicting gitSha
    const actualBytes = readFileSync(join(installersDir, exeName));
    writeFileSync(
      join(artifactsDir, 'desktop-release-win32-x64.manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        releaseVersion,
        gitSha: 'a'.repeat(40),
        targets: {
          'win32-x64': {
            target: 'win32-x64',
            os: 'win32',
            arch: 'x64',
            components: {},
            installers: [{
              kind: 'exe',
              fileName: exeName,
              relativePath: `installers/${exeName}`,
              sha256: sha256(actualBytes),
              sizeBytes: actualBytes.length,
              version: releaseVersion,
            }],
          },
        },
      }),
    );
    writeFileSync(
      join(artifactsDir, 'desktop-release-linux-x64.manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        releaseVersion,
        gitSha: 'b'.repeat(40),
        targets: {
          'linux-x64': { target: 'linux-x64', os: 'linux', arch: 'x64', components: {} },
        },
      }),
    );

    expect(() => generateControlledNodeReleaseManifest({ artifactsDir, version: releaseVersion }))
      .toThrow('desktop_release_manifest_git_sha_mismatch:linux-x64');
  });
});
