import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applySupervisionIntegrationBundle,
  freezeSupervisionIntegrationBundle,
  verifySupervisionIntegrationCommit,
  verifySupervisionIntegrationBundle,
} from '../../src/daemon/supervision-integration-bundle.js';
import { inspectSupervisionAssignmentWorktree } from '../../src/daemon/supervision-worktree-inspector.js';
import { SupervisionTaskRegistry } from '../../src/daemon/supervision-state-store.js';
import { suppressSqliteExperimentalWarning } from '../../src/util/suppress-sqlite-warning.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function productionShape() {
  const root = mkdtempSync(join(tmpdir(), 'imcodes-frozen-bundle-'));
  roots.push(root);
  const sourceRoot = join(root, 'source');
  const implementer = join(root, 'implementer-root', 'repo');
  const integration = join(root, 'integration-root', 'repo');
  const bundleRoot = join(root, 'bundles');
  execFileSync('mkdir', ['-p', sourceRoot]);
  git(sourceRoot, 'init');
  git(sourceRoot, 'config', 'user.email', 'tests@example.com');
  git(sourceRoot, 'config', 'user.name', 'Tests');
  execFileSync('mkdir', ['-p', join(sourceRoot, 'test')]);
  writeFileSync(join(sourceRoot, 'test/a.test.ts'), 'before-a\n');
  writeFileSync(join(sourceRoot, 'test/b.test.ts'), 'before-b\n');
  writeFileSync(join(sourceRoot, 'test/deleted.test.ts'), 'before-delete\n');
  writeFileSync(join(sourceRoot, 'test/unchanged.test.ts'), 'already-desired\n');
  git(sourceRoot, 'add', '.');
  git(sourceRoot, 'commit', '-m', 'base');
  const base = git(sourceRoot, 'rev-parse', 'HEAD');
  execFileSync('mkdir', ['-p', join(root, 'implementer-root'), join(root, 'integration-root')]);
  git(sourceRoot, 'worktree', 'add', '--detach', implementer, base);
  git(sourceRoot, 'worktree', 'add', '--detach', integration, base);

  writeFileSync(join(implementer, 'test/a.test.ts'), 'after-a\n');
  writeFileSync(join(implementer, 'test/b.test.ts'), 'after-b\n');
  chmodSync(join(implementer, 'test/b.test.ts'), 0o755);
  writeFileSync(join(implementer, 'test/added.test.ts'), 'after-add\n');
  rmSync(join(implementer, 'test/deleted.test.ts'));
  const inspected = await inspectSupervisionAssignmentWorktree({
    sessionName: 'deck_alpha_worker', assignmentId: 'asg_exact', worktreePath: implementer,
  });
  if (!inspected.ok) throw new Error(inspected.reason);
  return { root, sourceRoot, implementer, integration, bundleRoot, base, snapshot: inspected.snapshot };
}

describe('immutable supervision integration bundle', () => {
  it('applies a bundle that includes an unchanged scope file without stranding its integration owner', async () => {
    const shape = await productionShape();
    const unchanged = { path: 'test/unchanged.test.ts', sha256: sha('already-desired\n') };
    const snapshot = { ...shape.snapshot, files: [...shape.snapshot.files, unchanged] };
    const frozen = freezeSupervisionIntegrationBundle({
      taskId: 'tsk_partial_diff', assignmentId: 'asg_partial_diff', revision: 'partial-diff-r1',
      snapshot, scopeFiles: snapshot.files.map((file) => file.path),
      bundleRoot: shape.bundleRoot,
    });
    expect(frozen).toMatchObject({ ok: true });
    if (!frozen.ok) throw new Error(frozen.reason);

    // Production incident shape: every bundle byte is authoritative, but one
    // manifest path already equals HEAD and therefore is absent from git diff.
    expect(applySupervisionIntegrationBundle({
      bundle: frozen.bundle, worktreePath: shape.integration,
    })).toEqual({ ok: true, replay: false });
    expect(git(shape.integration, 'diff', '--name-only', 'HEAD', '--').split('\n'))
      .not.toContain(unchanged.path);
    expect(readFileSync(join(shape.integration, unchanged.path), 'utf8')).toBe('already-desired\n');
  });

  it('preserves the exact tsk_f1x after bytes after the implementer worktree returns to base', async () => {
    const shape = await productionShape();
    const frozen = freezeSupervisionIntegrationBundle({
      taskId: 'tsk_f1x', assignmentId: 'asg_f40', revision: 'daemon-preview-drain-order-r1',
      snapshot: shape.snapshot, scopeFiles: shape.snapshot.files.map((file) => file.path),
      bundleRoot: shape.bundleRoot, now: 100,
    });
    expect(frozen).toMatchObject({ ok: true, replay: false });
    if (!frozen.ok) throw new Error(frozen.reason);
    expect(frozen.bundle.scopeFiles).toEqual(
      shape.snapshot.files.map((file) => file.path).sort(),
    );

    git(shape.implementer, 'reset', '--hard', 'HEAD');
    git(shape.implementer, 'clean', '-fd');
    expect(readFileSync(join(shape.implementer, 'test/a.test.ts'), 'utf8')).toBe('before-a\n');
    expect(verifySupervisionIntegrationBundle(frozen.bundle)).toEqual({ ok: true });

    const applied = applySupervisionIntegrationBundle({ bundle: frozen.bundle, worktreePath: shape.integration });
    expect(applied).toEqual({ ok: true, replay: false });
    expect(readFileSync(join(shape.integration, 'test/a.test.ts'), 'utf8')).toBe('after-a\n');
    expect(readFileSync(join(shape.integration, 'test/b.test.ts'), 'utf8')).toBe('after-b\n');
    expect(statSync(join(shape.integration, 'test/b.test.ts')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(shape.integration, 'test/added.test.ts'), 'utf8')).toBe('after-add\n');
    expect(existsSync(join(shape.integration, 'test/deleted.test.ts'))).toBe(false);
    expect(await inspectSupervisionAssignmentWorktree({
      sessionName: 'deck_alpha_brain', assignmentId: 'asg_integration', worktreePath: shape.integration,
    })).toMatchObject({ ok: true, snapshot: { files: shape.snapshot.files } });
    git(shape.integration, 'add', '-A');
    git(shape.integration, 'commit', '-m', 'integrate exact bundle');
    const exactCommit = git(shape.integration, 'rev-parse', 'HEAD');
    expect(verifySupervisionIntegrationCommit({
      bundle: frozen.bundle, worktreePath: shape.integration, commitSha: exactCommit,
    })).toEqual({ ok: true });
    writeFileSync(join(shape.integration, 'test/a.test.ts'), 'wrong-committed-byte\n');
    git(shape.integration, 'add', 'test/a.test.ts');
    git(shape.integration, 'commit', '-m', 'wrong byte');
    expect(verifySupervisionIntegrationCommit({
      bundle: frozen.bundle, worktreePath: shape.integration,
      commitSha: git(shape.integration, 'rev-parse', 'HEAD'),
    })).toEqual({ ok: false, reason: 'hash_mismatch', path: 'test/a.test.ts' });
  });

  it('accepts only the deterministic merge of bundle bytes with a newer first parent', async () => {
    const shape = await productionShape();
    const paths = Array.from({ length: 20 }, (_, index) => `test/merge-${index}.ts`);
    for (const [index, path] of paths.entries()) {
      const base = index < 2
        ? `bundle-${index}: base\nshared: base\nupstream-${index}: base\n`
        : `file-${index}: base\n`;
      writeFileSync(join(shape.sourceRoot, path), base);
    }
    git(shape.sourceRoot, 'add', '.');
    git(shape.sourceRoot, 'commit', '-m', 'merge fixture base');
    const base = git(shape.sourceRoot, 'rev-parse', 'HEAD');
    git(shape.sourceRoot, 'worktree', 'remove', '--force', shape.implementer);
    git(shape.sourceRoot, 'worktree', 'remove', '--force', shape.integration);
    git(shape.sourceRoot, 'worktree', 'add', '--detach', shape.implementer, base);
    git(shape.sourceRoot, 'worktree', 'add', '--detach', shape.integration, base);

    for (const [index, path] of paths.entries()) {
      writeFileSync(join(shape.implementer, path), index < 2
        ? `bundle-${index}: changed\nshared: base\nupstream-${index}: base\n`
        : `file-${index}: bundle\n`);
    }
    const inspected = await inspectSupervisionAssignmentWorktree({
      sessionName: 'deck_alpha_worker', assignmentId: 'asg_merge', worktreePath: shape.implementer,
    });
    if (!inspected.ok) throw new Error(inspected.reason);
    const frozen = freezeSupervisionIntegrationBundle({
      taskId: 'tsk_merge', assignmentId: 'asg_merge', revision: 'merge-r1',
      snapshot: inspected.snapshot, scopeFiles: paths, bundleRoot: shape.bundleRoot,
    });
    expect(frozen).toMatchObject({ ok: true });
    if (!frozen.ok) throw new Error(frozen.reason);

    for (let index = 0; index < 2; index += 1) {
      writeFileSync(join(shape.integration, paths[index]!),
        `bundle-${index}: base\nshared: base\nupstream-${index}: changed\n`);
    }
    git(shape.integration, 'add', '.');
    git(shape.integration, 'commit', '-m', 'newer destination changes');
    const parentSha = git(shape.integration, 'rev-parse', 'HEAD');

    for (const [index, path] of paths.entries()) {
      writeFileSync(join(shape.integration, path), index < 2
        ? `bundle-${index}: changed\nshared: base\nupstream-${index}: changed\n`
        : `file-${index}: bundle\n`);
    }
    git(shape.integration, 'add', '.');
    git(shape.integration, 'commit', '-m', 'deterministic integration merge');
    const mergedCommit = git(shape.integration, 'rev-parse', 'HEAD');
    expect(verifySupervisionIntegrationCommit({
      bundle: frozen.bundle, worktreePath: shape.integration, commitSha: mergedCommit,
    })).toEqual({
      ok: true,
      mergedWithNewerBase: [
        { path: paths[0], parentSha },
        { path: paths[1], parentSha },
      ],
    });

    git(shape.integration, 'checkout', '--detach', parentSha);
    for (const path of paths) {
      const source = join(frozen.bundle.bundlePath, 'files', path);
      writeFileSync(join(shape.integration, path), readFileSync(source));
    }
    git(shape.integration, 'add', '.');
    git(shape.integration, 'commit', '-m', 'incorrectly revert newer destination bytes');
    expect(verifySupervisionIntegrationCommit({
      bundle: frozen.bundle, worktreePath: shape.integration,
      commitSha: git(shape.integration, 'rev-parse', 'HEAD'),
    })).toEqual({ ok: false, reason: 'hash_mismatch', path: paths[0] });

    git(shape.integration, 'checkout', '--detach', parentSha);
    for (const [index, path] of paths.entries()) {
      writeFileSync(join(shape.integration, path), index < 2
        ? `bundle-${index}: changed\nshared: tampered\nupstream-${index}: changed\n`
        : `file-${index}: bundle\n`);
    }
    git(shape.integration, 'add', '.');
    git(shape.integration, 'commit', '-m', 'tampered integration merge');
    expect(verifySupervisionIntegrationCommit({
      bundle: frozen.bundle, worktreePath: shape.integration,
      commitSha: git(shape.integration, 'rev-parse', 'HEAD'),
    })).toEqual({ ok: false, reason: 'hash_mismatch', path: paths[0] });

    git(shape.integration, 'checkout', '--orphan', 'unrelated-parent');
    git(shape.integration, 'rm', '-qrf', '.');
    execFileSync('mkdir', ['-p', join(shape.integration, 'test')]);
    for (const [index, path] of paths.entries()) {
      writeFileSync(join(shape.integration, path), index < 2
        ? `bundle-${index}: base\nshared: base\nupstream-${index}: changed\n`
        : `file-${index}: base\n`);
    }
    git(shape.integration, 'add', '.');
    git(shape.integration, 'commit', '-m', 'unrelated lookalike destination parent');
    for (const [index, path] of paths.entries()) {
      writeFileSync(join(shape.integration, path), index < 2
        ? `bundle-${index}: changed\nshared: base\nupstream-${index}: changed\n`
        : `file-${index}: bundle\n`);
    }
    git(shape.integration, 'add', '.');
    git(shape.integration, 'commit', '-m', 'merge on unrelated history');
    expect(verifySupervisionIntegrationCommit({
      bundle: frozen.bundle, worktreePath: shape.integration,
      commitSha: git(shape.integration, 'rev-parse', 'HEAD'),
    })).toEqual({ ok: false, reason: 'target_conflict' });
  });

  it('is content addressed, replay-safe, and fails closed on bundle or target conflicts', async () => {
    const shape = await productionShape();
    const input = {
      taskId: 'tsk_exact', assignmentId: 'asg_exact', revision: 'exact-r1',
      snapshot: shape.snapshot, scopeFiles: shape.snapshot.files.map((file) => file.path),
      bundleRoot: shape.bundleRoot, now: 100,
    } as const;
    const first = freezeSupervisionIntegrationBundle(input);
    const replay = freezeSupervisionIntegrationBundle({ ...input, now: 200 });
    expect(first).toMatchObject({ ok: true, replay: false });
    expect(replay).toMatchObject({ ok: true, replay: true });
    if (!first.ok || !replay.ok) throw new Error('freeze failed');
    expect(replay.bundle).toEqual(first.bundle);
    expect(first.bundle.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verifySupervisionIntegrationBundle({
      ...first.bundle,
      bundleRoot: join(shape.root, 'attacker-controlled-root'),
    })).toEqual({ ok: false, reason: 'invalid' });
    expect(verifySupervisionIntegrationBundle({
      ...first.bundle,
      scopeFiles: [...first.bundle.scopeFiles!, 'src/attacker.ts'],
    })).toEqual({ ok: false, reason: 'invalid' });

    writeFileSync(join(shape.integration, 'test/a.test.ts'), 'unrelated-owner-change\n');
    expect(applySupervisionIntegrationBundle({
      bundle: first.bundle, worktreePath: shape.integration,
    })).toEqual({ ok: false, reason: 'target_conflict', path: 'test/a.test.ts' });

    chmodSync(join(first.bundle.bundlePath, 'files/test/a.test.ts'), 0o600);
    writeFileSync(join(first.bundle.bundlePath, 'files/test/a.test.ts'), 'tampered\n');
    expect(verifySupervisionIntegrationBundle(first.bundle)).toEqual({
      ok: false, reason: 'hash_mismatch', path: 'test/a.test.ts',
    });
    expect(first.bundle.files.find((file) => file.path === 'test/a.test.ts')?.sha256)
      .toBe(sha('after-a\n'));
  });

  it('refuses to freeze a manifest row outside the explicitly bound assignment scope', async () => {
    const shape = await productionShape();
    expect(freezeSupervisionIntegrationBundle({
      taskId: 'tsk_scoped', assignmentId: 'asg_scoped', revision: 'scope-r1',
      snapshot: shape.snapshot,
      scopeFiles: ['test/a.test.ts'],
      bundleRoot: shape.bundleRoot,
    })).toEqual({ ok: false, reason: 'invalid' });
    expect(freezeSupervisionIntegrationBundle({
      taskId: 'tsk_scoped', assignmentId: 'asg_scoped', revision: 'scope-r1',
      snapshot: { ...shape.snapshot, files: [shape.snapshot.files[0]!] },
      scopeFiles: [],
      bundleRoot: shape.bundleRoot,
    })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('fails closed when source bytes change after inspection or an owned path becomes a symlink', async () => {
    const shape = await productionShape();
    writeFileSync(join(shape.implementer, 'test/a.test.ts'), 'changed-after-inspection\n');
    expect(freezeSupervisionIntegrationBundle({
      taskId: 'tsk_race', assignmentId: 'asg_race', revision: 'race-r1',
      snapshot: shape.snapshot,
      scopeFiles: shape.snapshot.files.map((file) => file.path),
      bundleRoot: shape.bundleRoot,
    })).toMatchObject({ ok: false, reason: 'source_mismatch' });

    const symlinkPath = join(shape.implementer, 'test/owned-link.ts');
    symlinkSync('../test/b.test.ts', symlinkPath);
    expect(freezeSupervisionIntegrationBundle({
      taskId: 'tsk_link', assignmentId: 'asg_link', revision: 'link-r1',
      snapshot: {
        ...shape.snapshot,
        files: [{ path: 'test/owned-link.ts', sha256: sha('after-b\n') }],
      },
      scopeFiles: ['test/owned-link.ts'],
      bundleRoot: shape.bundleRoot,
    })).toEqual({ ok: false, reason: 'source_mismatch' });
  });

  it('persists one exact bundle binding across store reopen and refuses a conflicting hash', async () => {
    const shape = await productionShape();
    const dbPath = join(shape.root, 'supervision.sqlite');
    const identity = {
      sessionName: 'deck_alpha_worker', sessionInstanceId: 'instance-worker',
      runtimeEpoch: 'epoch-worker', agentType: 'codex-sdk', providerFamily: 'openai',
    };
    const registry = new SupervisionTaskRegistry({ dbPath });
    expect(registry.createOrGet({
      taskId: 'tsk_restart', projectName: 'alpha', classification: 'independent_top_level',
      objective: 'persist exact after bytes', acceptance: ['same bundle after reopen'],
      baseRevision: shape.base, currentRevision: 'bundle-r1',
    })).toMatchObject({ ok: true });
    const assignment = registry.createAssignment({
      taskId: 'tsk_restart', assignmentId: 'asg_restart', role: 'implementer', identity,
      scopeFiles: shape.snapshot.files.map((file) => file.path), auditRevision: 'bundle-r1',
    });
    expect(assignment).toMatchObject({ ok: true });
    expect(registry.applyTaskIntent({
      taskId: 'tsk_restart', assignmentId: 'asg_restart', intent: 'start', toStatus: 'implementing',
    })).toMatchObject({ ok: true });
    const frozen = freezeSupervisionIntegrationBundle({
      taskId: 'tsk_restart', assignmentId: 'asg_restart', revision: 'bundle-r1',
      snapshot: shape.snapshot, scopeFiles: shape.snapshot.files.map((file) => file.path),
      bundleRoot: shape.bundleRoot,
    });
    if (!frozen.ok) throw new Error(frozen.reason);
    expect(registry.bindIntegrationBundle({
      taskId: 'tsk_restart', assignmentId: 'asg_restart', identity,
      revision: 'bundle-r1', bundle: frozen.bundle,
    })).toMatchObject({ ok: true });
    registry.close();

    const reopened = new SupervisionTaskRegistry({ dbPath });
    expect(reopened.getTaskRecord('tsk_restart')?.integrationBundle).toEqual(frozen.bundle);
    expect(verifySupervisionIntegrationBundle(reopened.getTaskRecord('tsk_restart')!.integrationBundle!))
      .toEqual({ ok: true });
    expect(reopened.bindIntegrationBundle({
      taskId: 'tsk_restart', assignmentId: 'asg_restart', identity,
      revision: 'bundle-r1', bundle: { ...frozen.bundle, manifestSha256: 'f'.repeat(64) },
    })).toEqual({ ok: false, reason: 'manifest_mismatch' });
    reopened.close();
  });
});
