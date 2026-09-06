import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

function productionShape() {
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
  const inspected = inspectSupervisionAssignmentWorktree({
    sessionName: 'deck_alpha_worker', assignmentId: 'asg_exact', worktreePath: implementer,
  });
  if (!inspected.ok) throw new Error(inspected.reason);
  return { root, sourceRoot, implementer, integration, bundleRoot, base, snapshot: inspected.snapshot };
}

describe('immutable supervision integration bundle', () => {
  it('preserves the exact tsk_f1x after bytes after the implementer worktree returns to base', () => {
    const shape = productionShape();
    const frozen = freezeSupervisionIntegrationBundle({
      taskId: 'tsk_f1x', assignmentId: 'asg_f40', revision: 'daemon-preview-drain-order-r1',
      snapshot: shape.snapshot, bundleRoot: shape.bundleRoot, now: 100,
    });
    expect(frozen).toMatchObject({ ok: true, replay: false });
    if (!frozen.ok) throw new Error(frozen.reason);

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
    expect(inspectSupervisionAssignmentWorktree({
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

  it('is content addressed, replay-safe, and fails closed on bundle or target conflicts', () => {
    const shape = productionShape();
    const input = {
      taskId: 'tsk_exact', assignmentId: 'asg_exact', revision: 'exact-r1',
      snapshot: shape.snapshot, bundleRoot: shape.bundleRoot, now: 100,
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

  it('persists one exact bundle binding across store reopen and refuses a conflicting hash', () => {
    const shape = productionShape();
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
      snapshot: shape.snapshot, bundleRoot: shape.bundleRoot,
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
