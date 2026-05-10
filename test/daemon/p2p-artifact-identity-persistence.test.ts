/**
 * R3 v1b follow-up — Artifact identity persistence across daemon restart.
 *
 * Verifies:
 *   - `freezeP2pArtifactIdentity` writes `~/.imcodes/runs/<runId>/identity.json`
 *     (atomic via .tmp → rename) for both `openspec_convention` and
 *     `explicit_paths` contracts
 *   - `loadPersistedFrozenP2pArtifactIdentities` rehydrates the in-memory
 *     map and skips malformed / mismatched-schema entries silently
 *   - the rehydrated identity is returned by `getFrozenP2pArtifactIdentity`
 *     so the next freeze call short-circuits (i.e., slug-N is preserved
 *     across restart)
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  P2P_RUN_STATE_DIR_ENV,
  __resetP2pArtifactIdentitiesForTests,
  freezeP2pArtifactIdentity,
  getFrozenP2pArtifactIdentity,
  loadPersistedFrozenP2pArtifactIdentities,
} from '../../src/daemon/p2p-workflow-artifact-runtime.js';

const SAVED_ENV = process.env[P2P_RUN_STATE_DIR_ENV];
let runStateRoot: string;
let repoRoot: string;

beforeEach(() => {
  __resetP2pArtifactIdentitiesForTests();
  runStateRoot = mkdtempSync(join(tmpdir(), 'imcodes-test-p2p-workflow-runs-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'imcodes-test-p2p-workflow-repo-'));
  process.env[P2P_RUN_STATE_DIR_ENV] = runStateRoot;
});

afterEach(() => {
  __resetP2pArtifactIdentitiesForTests();
  if (SAVED_ENV === undefined) delete process.env[P2P_RUN_STATE_DIR_ENV];
  else process.env[P2P_RUN_STATE_DIR_ENV] = SAVED_ENV;
  rmSync(runStateRoot, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('artifact identity persistence', () => {
  it('writes identity.json after freezing an explicit_paths contract', async () => {
    const identity = await freezeP2pArtifactIdentity({
      contract: { convention: 'explicit_paths', paths: ['proposal.md'] },
      repoRoot,
      runId: 'run-explicit-1',
    });
    expect(identity.convention).toBe('explicit_paths');
    const filePath = join(runStateRoot, 'run-explicit-1', 'identity.json');
    // Persistence is fire-and-forget; allow a microtask tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as { schemaVersion: number; identity: unknown };
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.identity).toMatchObject({ convention: 'explicit_paths', openspecArtifactPaths: ['proposal.md'] });
  });

  it('loadPersistedFrozenP2pArtifactIdentities rehydrates after reset (simulated daemon restart)', async () => {
    await freezeP2pArtifactIdentity({
      contract: { convention: 'explicit_paths', paths: ['proposal.md'] },
      repoRoot,
      runId: 'run-rehydrate-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Simulate restart: drop in-memory state without touching the disk file.
    __resetP2pArtifactIdentitiesForTests();
    expect(getFrozenP2pArtifactIdentity('run-rehydrate-1')).toBeUndefined();
    const loaded = await loadPersistedFrozenP2pArtifactIdentities();
    expect(loaded).toBe(1);
    const rehydrated = getFrozenP2pArtifactIdentity('run-rehydrate-1');
    expect(rehydrated?.convention).toBe('explicit_paths');
    expect(rehydrated?.openspecArtifactPaths).toEqual(['proposal.md']);
  });

  it('subsequent freeze for the same runId short-circuits to the rehydrated identity', async () => {
    const first = await freezeP2pArtifactIdentity({
      contract: { convention: 'explicit_paths', paths: ['proposal.md'] },
      repoRoot,
      runId: 'run-stable-id',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    __resetP2pArtifactIdentitiesForTests();
    await loadPersistedFrozenP2pArtifactIdentities();
    const second = await freezeP2pArtifactIdentity({
      contract: { convention: 'explicit_paths', paths: ['proposal.md', 'never-merged.md'] },
      repoRoot,
      runId: 'run-stable-id',
    });
    // Second call MUST short-circuit to the persisted identity even though
    // the contract paths differ — that's the spec invariant.
    expect(second.frozenAt).toBe(first.frozenAt);
    expect(second.openspecArtifactPaths).toEqual(['proposal.md']);
  });

  it('skips malformed persisted entries silently', async () => {
    const dir = join(runStateRoot, 'run-bad-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'identity.json'), 'not valid json{', 'utf8');
    // Also drop a wrong-schema entry.
    const dir2 = join(runStateRoot, 'run-bad-2');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 'identity.json'), JSON.stringify({ schemaVersion: 99, identity: {} }), 'utf8');
    const loaded = await loadPersistedFrozenP2pArtifactIdentities();
    expect(loaded).toBe(0);
    expect(getFrozenP2pArtifactIdentity('run-bad-1')).toBeUndefined();
    expect(getFrozenP2pArtifactIdentity('run-bad-2')).toBeUndefined();
  });

  it('skips entries whose runId directory name fails the [A-Za-z0-9_-] sanity check', async () => {
    // Subdirectory with a path-traversal name should never match the regex,
    // so the loader ignores it.
    const dir = join(runStateRoot, '..bad..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'identity.json'), JSON.stringify({
      schemaVersion: 1,
      identity: { convention: 'explicit_paths', openspecArtifactPaths: [], frozenAt: '', collisionResolved: false, diagnostics: [] },
    }), 'utf8');
    expect(await loadPersistedFrozenP2pArtifactIdentities()).toBe(0);
  });

  it('returns 0 when the run state directory does not exist', async () => {
    rmSync(runStateRoot, { recursive: true, force: true });
    expect(await loadPersistedFrozenP2pArtifactIdentities()).toBe(0);
  });
});
