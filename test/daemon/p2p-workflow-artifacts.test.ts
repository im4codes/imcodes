import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetP2pArtifactIdentitiesForTests,
  captureP2pArtifactBaseline,
  createP2pArtifactPath,
  freezeP2pArtifactIdentity,
  getFrozenP2pArtifactIdentity,
  p2pArtifactBaselinesEqual,
  validateP2pArtifactRuntimePath,
  verifyP2pArtifactBaselineDelta,
} from '../../src/daemon/p2p-workflow-artifact-runtime.js';
import type { P2pArtifactContract } from '../../shared/p2p-workflow-types.js';

function uniqueRepoRoot(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `imcodes-p2p-artifact-${label}-`));
}

beforeEach(() => {
  __resetP2pArtifactIdentitiesForTests();
});

afterEach(() => {
  __resetP2pArtifactIdentitiesForTests();
});

describe('p2p workflow artifact runtime', () => {
  it('validates lexical paths and resolves the nearest existing ancestor', async () => {
    const repoRoot = uniqueRepoRoot('nearest');
    await mkdir(path.join(repoRoot, 'artifacts'), { recursive: true });

    const result = await validateP2pArtifactRuntimePath({
      repoRoot,
      relativePath: 'artifacts/new/result.json',
      phase: 'create',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nearestExistingAncestor).toBe(path.join(repoRoot, 'artifacts'));
      expect(result.absolutePath).toBe(path.join(repoRoot, 'artifacts/new/result.json'));
    }
  });

  it('rejects symlink escapes during create/freeze phases', async () => {
    const repoRoot = uniqueRepoRoot('symlink');
    const outsideRoot = uniqueRepoRoot('outside');
    await symlink(outsideRoot, path.join(repoRoot, 'linked'));

    const result = await validateP2pArtifactRuntimePath({
      repoRoot,
      relativePath: 'linked/result.json',
      phase: 'create',
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toEqual(expect.objectContaining({
      code: 'unsafe_artifact_path',
      fieldPath: 'linked',
    }));
  });

  it('allows existing symlinks only when the realpath remains under the repo root', async () => {
    const repoRoot = uniqueRepoRoot('under-root');
    await mkdir(path.join(repoRoot, 'real'), { recursive: true });
    await writeFile(path.join(repoRoot, 'real/result.txt'), 'ok');
    await symlink(path.join(repoRoot, 'real'), path.join(repoRoot, 'linked'));

    const rejected = await validateP2pArtifactRuntimePath({
      repoRoot,
      relativePath: 'linked/result.txt',
      phase: 'baseline',
      symlinkPolicy: 'reject_all',
    });
    expect(rejected.ok).toBe(false);

    const accepted = await validateP2pArtifactRuntimePath({
      repoRoot,
      relativePath: 'linked/result.txt',
      phase: 'baseline',
      symlinkPolicy: 'allow_existing_under_root',
    });
    expect(accepted.ok).toBe(true);
  });

  it('validateP2pArtifactRuntimePath phase: \'freeze\' rejects symlinked ancestor', async () => {
    const repoRoot = uniqueRepoRoot('freeze-symlink');
    await mkdir(path.join(repoRoot, 'real'), { recursive: true });
    await symlink(path.join(repoRoot, 'real'), path.join(repoRoot, 'aliased'));

    const result = await validateP2pArtifactRuntimePath({
      repoRoot,
      relativePath: 'aliased/new.json',
      phase: 'freeze',
      symlinkPolicy: 'allow_existing_under_root',
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('unsafe_artifact_path');
    expect(result.diagnostics[0]?.fieldPath).toBe('aliased');
  });

  it('validateP2pArtifactRuntimePath phase: \'baseline\' follows symlink when realpath stays under repo root', async () => {
    const repoRoot = uniqueRepoRoot('baseline-symlink-ok');
    await mkdir(path.join(repoRoot, 'real/sub'), { recursive: true });
    await writeFile(path.join(repoRoot, 'real/sub/data.txt'), 'data');
    await symlink(path.join(repoRoot, 'real'), path.join(repoRoot, 'aliased'));

    const result = await validateP2pArtifactRuntimePath({
      repoRoot,
      relativePath: 'aliased/sub/data.txt',
      phase: 'baseline',
      symlinkPolicy: 'allow_existing_under_root',
    });
    expect(result.ok).toBe(true);
  });

  describe('freezeP2pArtifactIdentity', () => {
    it('reuses identity across retries with the same runId', async () => {
      const repoRoot = uniqueRepoRoot('reuse');
      const contract: P2pArtifactContract = {
        convention: 'openspec_convention',
        paths: ['proposal.md'],
      };
      const first = await freezeP2pArtifactIdentity({
        contract,
        repoRoot,
        runId: 'run-reuse-1',
        inferredSlug: 'shared-feature',
      });
      const second = await freezeP2pArtifactIdentity({
        contract,
        repoRoot,
        runId: 'run-reuse-1',
        inferredSlug: 'shared-feature',
      });
      expect(first).toBe(second);
      expect(first.openspecChangeSlug).toBe('shared-feature');
      expect(first.openspecChangePath).toBe('openspec/changes/shared-feature');
      expect(first.openspecArtifactPaths).toEqual(['openspec/changes/shared-feature/proposal.md']);
      expect(getFrozenP2pArtifactIdentity('run-reuse-1')).toBe(first);
    });

    it('emits artifact_identity_collision_resolved when slug exists', async () => {
      const repoRoot = uniqueRepoRoot('collision');
      // Pre-create the base slug so the freeze must collide once.
      await mkdir(path.join(repoRoot, 'openspec/changes/widget'), { recursive: true });

      const result = await freezeP2pArtifactIdentity({
        contract: { convention: 'openspec_convention', paths: ['proposal.md'] },
        repoRoot,
        runId: 'run-collision-1',
        inferredSlug: 'widget',
      });
      expect(result.collisionResolved).toBe(true);
      expect(result.openspecChangeSlug).toBe('widget-2');
      expect(result.openspecChangePath).toBe('openspec/changes/widget-2');
      const collisionDiagnostic = result.diagnostics.find((d) => d.code === 'artifact_identity_collision_resolved');
      expect(collisionDiagnostic).toBeDefined();
      expect(collisionDiagnostic?.severity).toBe('warning');
    });

    it('creates openspec/changes/<slug>/ atomically', async () => {
      const repoRoot = uniqueRepoRoot('atomic');
      const result = await freezeP2pArtifactIdentity({
        contract: { convention: 'openspec_convention', paths: [] },
        repoRoot,
        runId: 'run-atomic-1',
        inferredSlug: 'atomic-change',
      });
      expect(result.openspecChangePath).toBe('openspec/changes/atomic-change');

      // Re-running with a DIFFERENT runId but same slug must collision-resolve.
      const second = await freezeP2pArtifactIdentity({
        contract: { convention: 'openspec_convention', paths: [] },
        repoRoot,
        runId: 'run-atomic-2',
        inferredSlug: 'atomic-change',
      });
      expect(second.collisionResolved).toBe(true);
      expect(second.openspecChangePath).toBe('openspec/changes/atomic-change-2');
    });

    it('sanitizes inferred slugs to [a-z0-9-]+', async () => {
      const repoRoot = uniqueRepoRoot('sanitize');
      const result = await freezeP2pArtifactIdentity({
        contract: { convention: 'openspec_convention', paths: [] },
        repoRoot,
        runId: 'run-sanitize-1',
        inferredSlug: 'My Feature: v1.0!',
      });
      expect(result.openspecChangeSlug).toBe('my-feature-v1-0');
    });

    it('rejects openspec_convention without a derivable slug', async () => {
      const repoRoot = uniqueRepoRoot('no-slug');
      const result = await freezeP2pArtifactIdentity({
        contract: { convention: 'openspec_convention', paths: [] },
        repoRoot,
        runId: 'run-no-slug-1',
      });
      expect(result.openspecChangeSlug).toBeUndefined();
      expect(result.diagnostics[0]?.code).toBe('unsafe_artifact_path');
    });

    it('explicit_paths convention validates each declared path', async () => {
      const repoRoot = uniqueRepoRoot('explicit');
      const result = await freezeP2pArtifactIdentity({
        contract: { convention: 'explicit_paths', paths: ['artifacts/result.json'] },
        repoRoot,
        runId: 'run-explicit-1',
      });
      expect(result.openspecArtifactPaths).toEqual(['artifacts/result.json']);
      expect(result.openspecChangeSlug).toBeUndefined();

      const bad = await freezeP2pArtifactIdentity({
        contract: { convention: 'explicit_paths', paths: ['../escape'] },
        repoRoot,
        runId: 'run-explicit-2',
      });
      expect(bad.diagnostics[0]?.code).toBe('unsafe_artifact_path');
    });
  });

  describe('createP2pArtifactPath', () => {
    it('creates a placeholder file under the artifact sandbox', async () => {
      const repoRoot = uniqueRepoRoot('create-file');
      const result = await createP2pArtifactPath({
        repoRoot,
        relativePath: 'artifacts/new/result.json',
        phase: 'create',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.absolutePath).toBe(path.join(repoRoot, 'artifacts/new/result.json'));
      }
    });

    it('rejects symlink ancestor on create', async () => {
      const repoRoot = uniqueRepoRoot('create-symlink');
      const outsideRoot = uniqueRepoRoot('create-outside');
      await symlink(outsideRoot, path.join(repoRoot, 'aliased'));

      const result = await createP2pArtifactPath({
        repoRoot,
        relativePath: 'aliased/new.txt',
        phase: 'create',
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('captureP2pArtifactBaseline', () => {
    it('excludes capturedAt from equality', async () => {
      const repoRoot = uniqueRepoRoot('capturedAt');
      await mkdir(path.join(repoRoot, 'baseline-root'), { recursive: true });
      await writeFile(path.join(repoRoot, 'baseline-root/a.txt'), 'one');
      await writeFile(path.join(repoRoot, 'baseline-root/b.txt'), 'two');

      const first = await captureP2pArtifactBaseline({
        rootPath: 'baseline-root',
        repoRoot,
        phase: 'baseline',
      });
      // Wait long enough for ISO timestamps to differ (set to 5ms).
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await captureP2pArtifactBaseline({
        rootPath: 'baseline-root',
        repoRoot,
        phase: 'baseline',
      });
      expect(first.baseline.capturedAt).not.toBe(second.baseline.capturedAt);
      expect(p2pArtifactBaselinesEqual(first.baseline, second.baseline)).toBe(true);
    });

    it('enforces max 200 files', async () => {
      const repoRoot = uniqueRepoRoot('cap-files');
      await mkdir(path.join(repoRoot, 'baseline-root'), { recursive: true });
      // Write 201 files.
      for (let i = 0; i < 201; i += 1) {
        await writeFile(path.join(repoRoot, 'baseline-root', `file-${String(i).padStart(3, '0')}.txt`), `${i}`);
      }
      const result = await captureP2pArtifactBaseline({
        rootPath: 'baseline-root',
        repoRoot,
        phase: 'baseline',
      });
      expect(result.baseline.truncated).toBe(true);
      expect(result.baseline.files.length).toBeLessThanOrEqual(200);
      expect(result.diagnostics.find((d) => d.code === 'artifact_baseline_too_large')).toBeDefined();
    });

    it('skips files larger than 8 MiB with a per-file diagnostic', async () => {
      const repoRoot = uniqueRepoRoot('cap-file-bytes');
      await mkdir(path.join(repoRoot, 'baseline-root'), { recursive: true });
      const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x41);
      await writeFile(path.join(repoRoot, 'baseline-root/big.bin'), big);
      await writeFile(path.join(repoRoot, 'baseline-root/small.txt'), 'small');
      const result = await captureP2pArtifactBaseline({
        rootPath: 'baseline-root',
        repoRoot,
        phase: 'baseline',
      });
      const fileDiagnostic = result.diagnostics.find((d) => d.code === 'artifact_baseline_too_large' && d.fieldPath?.includes('big.bin'));
      expect(fileDiagnostic).toBeDefined();
      // The small file MUST still be captured (per-file overflow does not halt the walk).
      expect(result.baseline.files.find((f) => f.relativePath.endsWith('small.txt'))).toBeDefined();
    });

    it('enforces max depth 8', async () => {
      const repoRoot = uniqueRepoRoot('cap-depth');
      // depth 8 means 8 path segments under the rootPath; we add depth 9 to overflow.
      let dir = path.join(repoRoot, 'baseline-root');
      await mkdir(dir, { recursive: true });
      for (let i = 0; i < 9; i += 1) {
        dir = path.join(dir, `d${i}`);
        await mkdir(dir);
      }
      await writeFile(path.join(dir, 'leaf.txt'), 'leaf');

      const result = await captureP2pArtifactBaseline({
        rootPath: 'baseline-root',
        repoRoot,
        phase: 'baseline',
      });
      expect(result.baseline.truncated).toBe(true);
      expect(result.diagnostics.find((d) => d.code === 'artifact_baseline_too_large' && (d.summary ?? '').includes('depth'))).toBeDefined();
    });

    it('halts at the total bytes cap (64 MiB) and marks truncated', async () => {
      const repoRoot = uniqueRepoRoot('cap-total-bytes');
      await mkdir(path.join(repoRoot, 'baseline-root'), { recursive: true });
      // Predictive cap: write a file that is just under per-file limit (8 MiB)
      // 9 times = 72 MiB declared, but the 9th read predictively trips the
      // 64 MiB total cap and stops the walk.
      const chunk = Buffer.alloc(8 * 1024 * 1024, 0x42);
      for (let i = 0; i < 9; i += 1) {
        await writeFile(path.join(repoRoot, 'baseline-root', `f-${i}.bin`), chunk);
      }
      const result = await captureP2pArtifactBaseline({
        rootPath: 'baseline-root',
        repoRoot,
        phase: 'baseline',
      });
      expect(result.baseline.truncated).toBe(true);
      const totalDiag = result.diagnostics.find((d) => d.code === 'artifact_baseline_too_large' && (d.summary ?? '').includes('total bytes'));
      expect(totalDiag).toBeDefined();
    });
  });

  describe('verifyP2pArtifactBaselineDelta', () => {
    it('requires sha256 change for declared file', () => {
      const before = {
        rootPath: 'art',
        files: [{ relativePath: 'art/a.txt', size: 1, sha256: 'aaaa', type: 'file' as const }],
        capturedAt: 't1',
        truncated: false,
      };
      const after = {
        rootPath: 'art',
        files: [{ relativePath: 'art/a.txt', size: 2, sha256: 'bbbb', type: 'file' as const }],
        capturedAt: 't2',
        truncated: false,
      };
      const result = verifyP2pArtifactBaselineDelta(before, after, [{ relativePath: 'art/a.txt' }]);
      expect(result.ok).toBe(true);
      expect(result.diagnostics).toEqual([]);
    });

    it('rejects unchanged file even when other files in the dir changed', () => {
      const before = {
        rootPath: 'art',
        files: [
          { relativePath: 'art/a.txt', size: 1, sha256: 'aaaa', type: 'file' as const },
          { relativePath: 'art/b.txt', size: 1, sha256: 'cccc', type: 'file' as const },
        ],
        capturedAt: 't1',
        truncated: false,
      };
      const after = {
        rootPath: 'art',
        files: [
          { relativePath: 'art/a.txt', size: 1, sha256: 'aaaa', type: 'file' as const }, // unchanged
          { relativePath: 'art/b.txt', size: 2, sha256: 'dddd', type: 'file' as const }, // changed but not declared
        ],
        capturedAt: 't2',
        truncated: false,
      };
      const result = verifyP2pArtifactBaselineDelta(before, after, [{ relativePath: 'art/a.txt' }]);
      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]?.code).toBe('artifact_baseline_mismatch');
      expect(result.diagnostics[0]?.fieldPath).toBe('art/a.txt');
    });

    it('treats added declared file (absent before, present after) as success', () => {
      const before = {
        rootPath: 'art',
        files: [],
        capturedAt: 't1',
        truncated: false,
      };
      const after = {
        rootPath: 'art',
        files: [{ relativePath: 'art/new.json', size: 5, sha256: 'eeee', type: 'file' as const }],
        capturedAt: 't2',
        truncated: false,
      };
      const result = verifyP2pArtifactBaselineDelta(before, after, [{ relativePath: 'art/new.json' }]);
      expect(result.ok).toBe(true);
    });

    it('rejects declared file missing in after baseline', () => {
      const before = {
        rootPath: 'art',
        files: [],
        capturedAt: 't1',
        truncated: false,
      };
      const after = {
        rootPath: 'art',
        files: [],
        capturedAt: 't2',
        truncated: false,
      };
      const result = verifyP2pArtifactBaselineDelta(before, after, [{ relativePath: 'art/missing.json' }]);
      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]?.code).toBe('artifact_contract_not_satisfied');
    });
  });
});

// keep mkdtemp imported for potential future test helpers
void mkdtemp;
