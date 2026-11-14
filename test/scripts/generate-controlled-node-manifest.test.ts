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
});
