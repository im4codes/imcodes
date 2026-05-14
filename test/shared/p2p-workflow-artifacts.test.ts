import { describe, expect, it } from 'vitest';
import {
  areP2pArtifactBaselinesEqual,
  hashP2pArtifactBaseline,
  validateP2pArtifactBaseline,
  validateP2pArtifactRelativePath,
} from '../../shared/p2p-workflow-artifacts.js';

describe('p2p workflow artifact helpers', () => {
  it('accepts lexical relative artifact paths', () => {
    expect(validateP2pArtifactRelativePath('artifacts/result.json').ok).toBe(true);
    expect(validateP2pArtifactRelativePath('openspec/changes/change-1/specs/demo/spec.md').ok).toBe(true);
  });

  it('rejects unsafe artifact paths lexically', () => {
    const unsafePaths = [
      '',
      '/tmp/file',
      '../secret',
      'dir/../secret',
      'dir//file',
      'dir/.',
      'dir\0file',
      '~/secret',
      'C:/Users/name/file',
      '//server/share/file',
      'dir\\file',
    ];

    for (const path of unsafePaths) {
      const result = validateP2pArtifactRelativePath(path);
      expect(result.ok, path).toBe(false);
      expect(result.diagnostics[0]?.code).toBe('unsafe_artifact_path');
    }
  });

  it('hashes and compares per-file sha256 metadata while ignoring capturedAt', () => {
    const left = {
      files: [
        { path: 'b.txt', sha256: 'b'.repeat(64), sizeBytes: 2, fileType: 'file' as const, metadata: { capturedAt: '2026-01-01T00:00:00.000Z', mode: '100644' } },
        { path: 'a.txt', sha256: 'a'.repeat(64), sizeBytes: 1, fileType: 'file' as const, metadata: { sizeBytes: 1 } },
      ],
    };
    const right = {
      files: [
        { path: 'a.txt', sha256: 'a'.repeat(64), sizeBytes: 1, fileType: 'file' as const, metadata: { sizeBytes: 1 } },
        { path: 'b.txt', sha256: 'b'.repeat(64), sizeBytes: 2, fileType: 'file' as const, metadata: { capturedAt: '2026-02-01T00:00:00.000Z', mode: '100644' } },
      ],
    };

    expect(areP2pArtifactBaselinesEqual(left, right)).toBe(true);
    expect(hashP2pArtifactBaseline(left)).toBe(hashP2pArtifactBaseline(right));
  });

  it('detects sha256 and stable metadata differences', () => {
    const baseline = {
      files: [{ path: 'a.txt', sha256: 'a'.repeat(64), sizeBytes: 1, fileType: 'file' as const, metadata: { capturedAt: 'now' } }],
    };

    expect(areP2pArtifactBaselinesEqual(baseline, {
      files: [{ path: 'a.txt', sha256: 'b'.repeat(64), sizeBytes: 1, fileType: 'file' as const, metadata: { capturedAt: 'now' } }],
    })).toBe(false);
    expect(areP2pArtifactBaselinesEqual(baseline, {
      files: [{ path: 'a.txt', sha256: 'a'.repeat(64), sizeBytes: 2, fileType: 'file' as const, metadata: { capturedAt: 'now' } }],
    })).toBe(false);
  });

  it('validates baseline path, size, type, hash, and resource caps', () => {
    const valid = validateP2pArtifactBaseline({
      files: [
        { path: 'artifacts/result.json', sha256: 'a'.repeat(64), sizeBytes: 10, fileType: 'file' },
      ],
    });
    expect(valid.ok).toBe(true);

    const invalid = validateP2pArtifactBaseline({
      files: [
        { path: '../secret', sha256: 'not-a-hash', sizeBytes: -1, fileType: 'socket' },
      ],
    });

    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      'unsafe_artifact_path',
      'artifact_baseline_mismatch',
    ]));
  });

  it('rejects baseline resource cap violations', () => {
    const result = validateP2pArtifactBaseline({
      files: [
        { path: 'artifacts/too-large.bin', sha256: 'a'.repeat(64), sizeBytes: 9 * 1024 * 1024, fileType: 'file' },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('artifact_baseline_too_large');
  });
});
