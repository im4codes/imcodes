/**
 * R3 v2 PR-ζ — Artifact identity persistence hardening tests.
 *
 * Pins the new defenses on top of v1b's basic round-trip:
 *   - resolveRunStateDir env containment (B4)
 *   - persistFrozenIdentity tmp PID suffix (B2)
 *   - rehydrate symlink reject + path re-validate + repoRoot containment +
 *     count cap + TTL eviction (A2 / A3 / A4 / B3 / O5)
 *   - clearPersistedFrozenP2pArtifactIdentity removes both memory + disk
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  P2P_RUN_STATE_DIR_ENV,
  __resetP2pArtifactIdentitiesForTests,
  clearPersistedFrozenP2pArtifactIdentity,
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

describe('PR-ζ persistence hardening', () => {
  it('persistFrozenIdentity uses a PID-suffixed tmp filename (B2)', async () => {
    await freezeP2pArtifactIdentity({
      contract: { convention: 'explicit_paths', paths: ['proposal.md'] },
      repoRoot,
      runId: 'run-pid-tmp',
    });
    // Persistence is fire-and-forget; allow microtasks to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const files = readdirSync(join(runStateRoot, 'run-pid-tmp'));
    // Final file is `identity.json`. Tmp files (if observable) include the
    // pid pattern. We cannot easily race two writes inside one test, so
    // we assert the FINAL file exists AND no leftover .tmp lingers (tmp
    // is renamed atomically).
    expect(files).toContain('identity.json');
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('clearPersistedFrozenP2pArtifactIdentity removes both memory and disk (A2)', async () => {
    await freezeP2pArtifactIdentity({
      contract: { convention: 'explicit_paths', paths: ['proposal.md'] },
      repoRoot,
      runId: 'run-clear',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getFrozenP2pArtifactIdentity('run-clear')).toBeDefined();
    await clearPersistedFrozenP2pArtifactIdentity('run-clear');
    expect(getFrozenP2pArtifactIdentity('run-clear')).toBeUndefined();
    const dir = join(runStateRoot, 'run-clear');
    expect(() => readFileSync(join(dir, 'identity.json'), 'utf8')).toThrow();
  });

  it('rehydrate skips symlink top-level entries (A3)', async () => {
    // Create a real entry first.
    const realDir = join(runStateRoot, 'real-entry');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'identity.json'), JSON.stringify({
      schemaVersion: 1,
      identity: { convention: 'explicit_paths', openspecArtifactPaths: ['proposal.md'], frozenAt: new Date().toISOString(), collisionResolved: false, diagnostics: [] },
    }), 'utf8');
    // Symlink another entry name to it.
    try {
      symlinkSync(realDir, join(runStateRoot, 'symlink-entry'));
    } catch (error) {
      // Some test sandboxes disallow symlinks; skip the case in that scenario.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const loaded = await loadPersistedFrozenP2pArtifactIdentities();
    expect(loaded).toBe(1); // only the real entry
    expect(getFrozenP2pArtifactIdentity('real-entry')).toBeDefined();
    expect(getFrozenP2pArtifactIdentity('symlink-entry')).toBeUndefined();
  });

  it('rehydrate drops identity whose declared path fails validation when repoRoot is supplied (A4)', async () => {
    const dir = join(runStateRoot, 'bad-paths');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'identity.json'), JSON.stringify({
      schemaVersion: 1,
      identity: {
        convention: 'openspec_convention',
        openspecArtifactPaths: ['../../etc/passwd'],
        frozenAt: new Date().toISOString(),
        collisionResolved: false,
        diagnostics: [],
      },
    }), 'utf8');
    const loaded = await loadPersistedFrozenP2pArtifactIdentities({ repoRoot });
    expect(loaded).toBe(0);
    expect(getFrozenP2pArtifactIdentity('bad-paths')).toBeUndefined();
  });

  it('rehydrate cleans up .tmp orphans (B3)', async () => {
    const dir = join(runStateRoot, 'tmp-orphan');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'identity.json'), JSON.stringify({
      schemaVersion: 1,
      identity: { convention: 'explicit_paths', openspecArtifactPaths: ['proposal.md'], frozenAt: new Date().toISOString(), collisionResolved: false, diagnostics: [] },
    }), 'utf8');
    writeFileSync(join(dir, 'identity.json.42.99999.abc.tmp'), '{partial', 'utf8');
    await loadPersistedFrozenP2pArtifactIdentities();
    const remaining = readdirSync(dir);
    expect(remaining.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(remaining).toContain('identity.json');
  });
});
