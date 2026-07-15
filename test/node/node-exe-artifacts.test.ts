import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// The production build script is plain ESM so it can run before TypeScript is built.
// @ts-expect-error No declaration file is emitted for this build-time helper.
import { verifyOfficialNodeArtifact } from '../../scripts/node-exe-artifacts.mjs';

const verifier = join(process.cwd(), 'scripts', 'node-exe-artifacts.mjs');
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'imcodes-node-artifact-'));
  dirs.push(dir);
  return dir;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeFixture(dir: string, overrides: Record<string, unknown> = {}) {
  const fileName = 'imcodes-node-linux';
  const artifact = Buffer.from('controlled-node-artifact');
  writeFileSync(join(dir, fileName), artifact);
  const manifest = {
    schemaVersion: 1,
    artifact: {
      fileName,
      os: 'linux',
      arch: 'x64',
      size: artifact.length,
      sha256: sha256(artifact),
    },
    toolchain: {
      nodeVersion: 'v22.11.0',
      nodeArchive: 'node-v22.11.0-linux-x64.tar.gz',
      nodeArchiveSha256: 'b'.repeat(64),
      postjectVersion: '1.0.0-alpha.6',
    },
    build: {
      commit: 'a'.repeat(40),
      version: '2026.7.1234-dev.5',
    },
    ...overrides,
  };
  const manifestPath = join(dir, `${fileName}.manifest.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { artifactPath: join(dir, fileName), manifestPath };
}

function writeLinuxHelperFixture(dir: string): void {
  const helperDir = join(dir, 'computer-use-helper', 'linux-x64');
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, 'open-computer-use'), 'helper');
}

function verify(manifestPath: string, dir: string): void {
  execFileSync(process.execPath, [verifier, 'verify', manifestPath, dir], { stdio: 'pipe' });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('controlled-node executable artifact verification', () => {
  it('accepts mirror bytes only when they match the official Node SHASUMS256 entry', async () => {
    const dir = tempDir();
    const archivePath = join(dir, 'node-v22.11.0-linux-x64.tar.gz');
    const archive = Buffer.from('official-node-archive-fixture');
    writeFileSync(archivePath, archive);
    const shasums = `${sha256(archive)}  node-v22.11.0-linux-x64.tar.gz\n`;

    await expect(verifyOfficialNodeArtifact(archivePath, 'node-v22.11.0-linux-x64.tar.gz', shasums))
      .resolves.toBe(sha256(archive));
  });

  it('rejects mirror bytes that differ from the official Node checksum', async () => {
    const dir = tempDir();
    const archivePath = join(dir, 'node-v22.11.0-linux-x64.tar.gz');
    writeFileSync(archivePath, 'tampered-node-archive');
    const shasums = `${sha256('official-node-archive')}  node-v22.11.0-linux-x64.tar.gz\n`;

    await expect(verifyOfficialNodeArtifact(archivePath, 'node-v22.11.0-linux-x64.tar.gz', shasums))
      .rejects.toThrow(/checksum mismatch/);
  });

  it('accepts an artifact whose size and sha256 match its manifest', () => {
    const dir = tempDir();
    const { manifestPath } = writeFixture(dir);
    expect(() => verify(manifestPath, dir)).not.toThrow();
  });

  it('rejects an artifact altered after the manifest was produced', () => {
    const dir = tempDir();
    const { artifactPath, manifestPath } = writeFixture(dir);
    writeFileSync(artifactPath, 'tampered-controlled-node-artifact');
    expect(() => verify(manifestPath, dir)).toThrow();
  });

  it('rejects a manifest altered to carry the wrong checksum', () => {
    const dir = tempDir();
    const { manifestPath } = writeFixture(dir);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { artifact: { sha256: string } };
    manifest.artifact.sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verify(manifestPath, dir)).toThrow();
  });

  it('rejects traversal in artifact.fileName', () => {
    const dir = tempDir();
    const { manifestPath } = writeFixture(dir);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { artifact: { fileName: string } };
    manifest.artifact.fileName = '../imcodes-node-linux';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verify(manifestPath, dir)).toThrow();
  });

  it('rejects a release set whose manifest commit differs from GITHUB_SHA', () => {
    const dir = tempDir();
    writeFixture(dir);
    writeLinuxHelperFixture(dir);
    expect(() => execFileSync(
      process.execPath,
      [verifier, 'verify-set', dir, 'imcodes-node-linux'],
      { stdio: 'pipe', env: { ...process.env, GITHUB_SHA: 'c'.repeat(40) } },
    )).toThrow();
  });

  it('requires the Computer Use helper sidecar in a release set', () => {
    const dir = tempDir();
    writeFixture(dir);
    expect(() => execFileSync(
      process.execPath,
      [verifier, 'verify-set', dir, 'imcodes-node-linux'],
      { stdio: 'pipe', env: { ...process.env, GITHUB_SHA: 'a'.repeat(40) } },
    )).toThrow(/Computer Use helper/);
    writeLinuxHelperFixture(dir);
    expect(() => execFileSync(
      process.execPath,
      [verifier, 'verify-set', dir, 'imcodes-node-linux'],
      { stdio: 'pipe', env: { ...process.env, GITHUB_SHA: 'a'.repeat(40) } },
    )).not.toThrow();
  });

  it('rejects a release set whose runtime version differs from the server version', () => {
    const dir = tempDir();
    writeFixture(dir);
    writeLinuxHelperFixture(dir);
    expect(() => execFileSync(
      process.execPath,
      [verifier, 'verify-set', dir, 'imcodes-node-linux'],
      {
        stdio: 'pipe',
        env: {
          ...process.env,
          GITHUB_SHA: 'a'.repeat(40),
          IMCODES_BUILD_VERSION: '2026.7.9999-dev.5',
        },
      },
    )).toThrow(/version mismatch/);
  });
});
