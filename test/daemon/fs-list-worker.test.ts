import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanFsListSnapshot } from '../../src/daemon/fs-list-worker.js';

describe('fs list worker', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('scans, sorts, and enriches directory entries off the daemon hot path', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'imcodes-fs-list-worker-'));
    mkdirSync(join(tempDir, 'src'));
    mkdirSync(join(tempDir, '.git'));
    writeFileSync(join(tempDir, 'README.md'), 'hello');
    writeFileSync(join(tempDir, '.env'), 'secret');

    const result = await scanFsListSnapshot({
      realPath: tempDir,
      includeFiles: true,
      includeMetadata: true,
    });

    expect(result.resolvedPath).toBe(tempDir);
    expect(result.dirSignature).toMatch(/:/);
    expect(result.entries.map((entry) => entry.name)).toEqual(['src', '.git', 'README.md', '.env']);
    expect(result.entries.find((entry) => entry.name === 'README.md')).toMatchObject({
      isDir: false,
      hidden: false,
      mime: 'text/markdown',
      size: 5,
    });
  });

  it('filters files when includeFiles is false', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'imcodes-fs-list-worker-'));
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'README.md'), 'hello');

    const result = await scanFsListSnapshot({
      realPath: tempDir,
      includeFiles: false,
      includeMetadata: false,
    });

    expect(result.entries.map((entry) => entry.name)).toEqual(['src']);
  });
});
