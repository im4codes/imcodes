import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureSupervisionAssignmentWorktree,
  resolveSupervisionWorktreeBase,
} from '../../src/daemon/supervision-worktree-provision.js';

const roots: string[] = [];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function canonicalWorktreePath(path: string): string {
  return join(realpathSync(dirname(path)), basename(path));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'imcodes-supervision-provision-'));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-q');
  git(source, 'config', 'user.email', 'test@example.invalid');
  git(source, 'config', 'user.name', 'Test');
  writeFileSync(join(source, 'base.txt'), 'base\n');
  git(source, 'add', 'base.txt');
  git(source, 'commit', '-qm', 'base');
  return { root, source, baseRevision: git(source, 'rev-parse', 'HEAD') };
}

function provisionInChild(input: Parameters<typeof ensureSupervisionAssignmentWorktree>[0]) {
  const moduleUrl = pathToFileURL(join(repositoryRoot, 'src/daemon/supervision-worktree-provision.ts')).href;
  const encodedInput = Buffer.from(JSON.stringify(input), 'utf8').toString('base64url');
  const script = [
    `const { ensureSupervisionAssignmentWorktree } = await import(${JSON.stringify(moduleUrl)});`,
    "const input = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));",
    'process.stdout.write(JSON.stringify(await ensureSupervisionAssignmentWorktree(input)));',
  ].join('\n');
  return new Promise<ReturnType<typeof ensureSupervisionAssignmentWorktree> extends Promise<infer T> ? T : never>(
    (resolveChild, rejectChild) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, encodedInput], {
        cwd: repositoryRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', rejectChild);
      child.once('close', (code) => {
        if (code !== 0) {
          rejectChild(new Error(`provision child exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
          return;
        }
        try {
          resolveChild(JSON.parse(Buffer.concat(stdout).toString('utf8')));
        } catch (error) {
          rejectChild(error);
        }
      });
    },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('supervision assignment worktree provisioning', () => {
  it.each([
    'asg_2',
    'supervision_assignment_22222222-2222-4222-8222-222222222222',
  ])('provisions a safe worktree path for assignment id %s', async (assignmentId) => {
    const shape = fixture();
    const worktreePath = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', assignmentId, 'repo');
    await expect(ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId,
      baseRevision: shape.baseRevision, worktreePath,
    })).resolves.toEqual({
      ok: true, worktreePath, baseRevision: shape.baseRevision, created: true,
    });
    expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(shape.baseRevision);
  });

  it('creates the exact detached base and replays without rebuilding it', async () => {
    const shape = fixture();
    const worktreePath = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', 'supervision_assignment_one', 'repo');
    const first = await ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_one',
      baseRevision: shape.baseRevision, worktreePath,
    });
    expect(first).toEqual({ ok: true, worktreePath, baseRevision: shape.baseRevision, created: true });
    expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(shape.baseRevision);
    const gitFile = readFileSync(join(worktreePath, '.git'), 'utf8');

    const replay = await ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_one',
      baseRevision: shape.baseRevision, worktreePath,
    });
    expect(replay).toEqual({ ok: true, worktreePath, baseRevision: shape.baseRevision, created: false });
    expect(readFileSync(join(worktreePath, '.git'), 'utf8')).toBe(gitFile);
  });

  it('coalesces concurrent adds into one created worktree and idempotent replays', async () => {
    const shape = fixture();
    const assignmentRoot = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', 'supervision_assignment_concurrent');
    const worktreePath = join(assignmentRoot, 'repo');
    const input = {
      projectRoot: shape.source,
      sessionName: 'deck_sub_worker',
      assignmentId: 'supervision_assignment_concurrent',
      baseRevision: shape.baseRevision,
      worktreePath,
    };

    const results = await Promise.all(Array.from(
      { length: 8 },
      () => ensureSupervisionAssignmentWorktree(input),
    ));

    expect(results.every((result) => result.ok), JSON.stringify(results)).toBe(true);
    expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
    expect(results.filter((result) => result.ok && !result.created)).toHaveLength(7);
    expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(shape.baseRevision);
    expect(git(shape.source, 'worktree', 'list', '--porcelain').split('\n')
      .filter((line) => line.startsWith('worktree '))).toHaveLength(2);
    expect(() => readFileSync(join(assignmentRoot, '.worktree-provision.json'), 'utf8')).toThrow();
  });

  it('converges 50 independent-process races onto one exact registered worktree', async () => {
    const shape = fixture();
    // Serialize distinct paths so this tests only the same-tuple arbitration,
    // not Git's repository-wide worktree administration lock.
    for (let round = 0; round < 50; round += 1) {
      const assignmentId = `supervision_assignment_process_race_${round}`;
      const assignmentRoot = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', assignmentId);
      const worktreePath = join(assignmentRoot, 'repo');
      const input = {
        projectRoot: shape.source,
        sessionName: 'deck_sub_worker',
        assignmentId,
        baseRevision: shape.baseRevision,
        worktreePath,
      };
      const pair = await Promise.all([provisionInChild(input), provisionInChild(input)]);
      expect(pair.every((result) => result.ok), JSON.stringify({ round, pair })).toBe(true);
      expect(pair.filter((result) => result.ok && result.created), JSON.stringify({ round, pair }))
        .toHaveLength(1);
      expect(pair.every((result) => result.ok && result.worktreePath === worktreePath)).toBe(true);
      expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(shape.baseRevision);
      expect(git(worktreePath, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
      expect(git(shape.source, 'worktree', 'list', '--porcelain').split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => canonicalWorktreePath(line.slice('worktree '.length)))
        .filter((path) => path === canonicalWorktreePath(worktreePath))).toHaveLength(1);
      expect(() => readFileSync(join(assignmentRoot, '.worktree-provision.json'), 'utf8')).toThrow();
      expect(() => readFileSync(join(assignmentRoot, '.worktree-provision.lock'), 'utf8')).toThrow();
    }
  }, 90_000);

  it('converges independent-process recovery contenders on one dead same-tuple lease', async () => {
    const shape = fixture();
    for (let round = 0; round < 10; round += 1) {
      const assignmentId = `supervision_assignment_dead_lease_race_${round}`;
      const assignmentRoot = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', assignmentId);
      const worktreePath = join(assignmentRoot, 'repo');
      const input = {
        projectRoot: shape.source,
        sessionName: 'deck_sub_worker',
        assignmentId,
        baseRevision: shape.baseRevision,
        worktreePath,
      };
      const deadToken = `dead-race-token-${round}`;
      mkdirSync(assignmentRoot, { recursive: true });
      writeFileSync(join(assignmentRoot, '.worktree-provision.lock'), `${JSON.stringify({
        version: 1,
        token: deadToken,
        fingerprint: JSON.stringify({
          projectRoot: resolve(shape.source),
          sessionName: input.sessionName,
          assignmentId,
          baseRevision: shape.baseRevision,
          worktreePath: resolve(worktreePath),
        }),
        pid: 2_147_483_647,
        processStartedAt: 1,
        acquiredAt: 1,
      })}\n`);

      const results = await Promise.all(Array.from({ length: 4 }, () => provisionInChild(input)));
      expect(results.every((result) => result.ok), JSON.stringify({ round, results })).toBe(true);
      expect(results.filter((result) => result.ok && result.created), JSON.stringify({ round, results }))
        .toHaveLength(1);
      expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(shape.baseRevision);
      expect(git(worktreePath, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
      expect(() => readFileSync(join(assignmentRoot, '.worktree-provision.lock'), 'utf8')).toThrow();
      expect(() => readFileSync(
        join(assignmentRoot, `.worktree-provision.lock.recover-${deadToken}`), 'utf8',
      )).toThrow();
    }
  }, 60_000);

  it('fails closed when a conflicting tuple targets an in-flight worktree', async () => {
    const shape = fixture();
    writeFileSync(join(shape.source, 'next.txt'), 'next\n');
    git(shape.source, 'add', 'next.txt');
    git(shape.source, 'commit', '-qm', 'next');
    const nextRevision = git(shape.source, 'rev-parse', 'HEAD');
    const worktreePath = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', 'supervision_assignment_conflict', 'repo');
    const first = ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_conflict',
      baseRevision: shape.baseRevision, worktreePath,
    });
    const conflicting = ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_conflict',
      baseRevision: nextRevision, worktreePath,
    });

    await expect(conflicting).resolves.toMatchObject({ ok: false, reason: 'existing_unsafe' });
    await expect(first).resolves.toMatchObject({ ok: true, created: true, baseRevision: shape.baseRevision });
    expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(shape.baseRevision);
  });

  it('waits for a live same-tuple provision lease without deleting it or creating behind its owner', async () => {
    const shape = fixture();
    const assignmentId = 'supervision_assignment_live_lease';
    const assignmentRoot = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', assignmentId);
    const worktreePath = join(assignmentRoot, 'repo');
    const input = {
      projectRoot: shape.source,
      sessionName: 'deck_sub_worker',
      assignmentId,
      baseRevision: shape.baseRevision,
      worktreePath,
    };
    const leasePath = join(assignmentRoot, '.worktree-provision.lock');
    mkdirSync(assignmentRoot, { recursive: true });
    writeFileSync(leasePath, `${JSON.stringify({
      version: 1,
      token: 'live-owner-token',
      fingerprint: JSON.stringify({
        projectRoot: resolve(shape.source),
        sessionName: input.sessionName,
        assignmentId,
        baseRevision: shape.baseRevision,
        worktreePath: resolve(worktreePath),
      }),
      pid: process.pid,
      processStartedAt: Math.floor(Date.now() - process.uptime() * 1_000),
      acquiredAt: Date.now(),
    })}\n`);

    let observedBeforeOwnerRelease = false;
    const ownerRelease = new Promise<void>((resolveRelease) => {
      setTimeout(() => {
        observedBeforeOwnerRelease = readFileSync(leasePath, 'utf8').includes('live-owner-token')
          && !existsSync(worktreePath);
        rmSync(leasePath);
        resolveRelease();
      }, 75);
    });
    const provision = ensureSupervisionAssignmentWorktree(input);
    await ownerRelease;
    await expect(provision).resolves.toEqual({
      ok: true, worktreePath, baseRevision: shape.baseRevision, created: true,
    });
    expect(observedBeforeOwnerRelease).toBe(true);
  });

  it('waits at entry for an existing index lock and never removes its live owner sentinel', async () => {
    const shape = fixture();
    const worktreePath = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', 'supervision_assignment_index_lock', 'repo');
    const input = {
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_index_lock',
      baseRevision: shape.baseRevision, worktreePath,
    };
    await expect(ensureSupervisionAssignmentWorktree(input)).resolves.toMatchObject({ ok: true });
    const gitDir = resolve(worktreePath, git(worktreePath, 'rev-parse', '--git-dir'));
    const indexLock = join(gitDir, 'index.lock');
    writeFileSync(indexLock, 'live-owner-sentinel\n');

    let observedBeforeOwnerRelease = false;
    const ownerRelease = new Promise<void>((resolveRelease) => {
      setTimeout(() => {
        observedBeforeOwnerRelease = readFileSync(indexLock, 'utf8') === 'live-owner-sentinel\n';
        rmSync(indexLock);
        resolveRelease();
      }, 75);
    });
    const replay = ensureSupervisionAssignmentWorktree(input);
    await ownerRelease;
    await expect(replay).resolves.toEqual({
      ok: true, worktreePath, baseRevision: shape.baseRevision, created: false,
    });
    expect(observedBeforeOwnerRelease).toBe(true);
  });

  it('reclaims only a dead same-tuple provision lease', async () => {
    const shape = fixture();
    const assignmentId = 'supervision_assignment_dead_lease';
    const assignmentRoot = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', assignmentId);
    const worktreePath = join(assignmentRoot, 'repo');
    const input = {
      projectRoot: shape.source,
      sessionName: 'deck_sub_worker',
      assignmentId,
      baseRevision: shape.baseRevision,
      worktreePath,
    };
    mkdirSync(assignmentRoot, { recursive: true });
    writeFileSync(join(assignmentRoot, '.worktree-provision.lock'), `${JSON.stringify({
      version: 1,
      token: 'dead-owner-token',
      fingerprint: JSON.stringify({
        projectRoot: resolve(shape.source),
        sessionName: input.sessionName,
        assignmentId,
        baseRevision: shape.baseRevision,
        worktreePath: resolve(worktreePath),
      }),
      pid: 2_147_483_647,
      processStartedAt: 1,
      acquiredAt: 1,
    })}\n`);

    await expect(ensureSupervisionAssignmentWorktree(input)).resolves.toEqual({
      ok: true, worktreePath, baseRevision: shape.baseRevision, created: true,
    });
    expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(shape.baseRevision);
    expect(() => readFileSync(join(assignmentRoot, '.worktree-provision.lock'), 'utf8')).toThrow();
    expect(() => readFileSync(
      join(assignmentRoot, '.worktree-provision.lock.recover-dead-owner-token'), 'utf8',
    )).toThrow();
  });

  it('provisions the tracked Gradle batch file with CRLF bytes and a clean Git status', async () => {
    const shape = fixture();
    const attributes = readFileSync(join(repositoryRoot, '.gitattributes'));
    const trackedBatch = execFileSync(
      'git', ['show', 'HEAD:web/android/gradlew.bat'], { cwd: repositoryRoot },
    );
    expect(trackedBatch.includes(Buffer.from('\r\n'))).toBe(false);
    expect(trackedBatch.includes(Buffer.from('\n'))).toBe(true);

    writeFileSync(join(shape.source, '.gitattributes'), attributes);
    const batchPath = join(shape.source, 'web', 'android', 'gradlew.bat');
    mkdirSync(dirname(batchPath), { recursive: true });
    writeFileSync(batchPath, trackedBatch);
    git(shape.source, 'add', '.gitattributes', 'web/android/gradlew.bat');
    git(shape.source, 'commit', '-qm', 'add production EOL fixture');
    const baseRevision = git(shape.source, 'rev-parse', 'HEAD');
    const worktreePath = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', 'asg_gradlew_eol', 'repo');

    await expect(ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'asg_gradlew_eol',
      baseRevision, worktreePath,
    })).resolves.toEqual({ ok: true, worktreePath, baseRevision, created: true });

    expect(git(worktreePath, 'check-attr', 'text', '--', 'web/android/gradlew.bat'))
      .toBe('web/android/gradlew.bat: text: set');
    expect(git(worktreePath, 'check-attr', 'eol', '--', 'web/android/gradlew.bat'))
      .toBe('web/android/gradlew.bat: eol: crlf');
    const checkedOutBatch = readFileSync(join(worktreePath, 'web', 'android', 'gradlew.bat'));
    expect(checkedOutBatch.includes(Buffer.from('\r\n'))).toBe(true);
    expect(checkedOutBatch.toString('binary').replaceAll('\r\n', '')).not.toContain('\n');
    expect(git(worktreePath, 'status', '--short', '--', 'web/android/gradlew.bat')).toBe('');
  });

  it('recovers the same missing path after an interrupted journal-only attempt', async () => {
    const shape = fixture();
    const assignmentRoot = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', 'supervision_assignment_restart');
    const worktreePath = join(assignmentRoot, 'repo');
    mkdirSync(assignmentRoot, { recursive: true });
    writeFileSync(join(assignmentRoot, '.worktree-provision.json'), JSON.stringify({
      version: 1,
      assignmentId: 'supervision_assignment_restart',
      baseRevision: shape.baseRevision,
      worktreePath,
    }));

    await expect(ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_restart',
      baseRevision: shape.baseRevision, worktreePath,
    })).resolves.toMatchObject({ ok: true, created: true, worktreePath, baseRevision: shape.baseRevision });
  });

  it('recovers one exact prunable registered-but-missing worktree without global prune', async () => {
    const shape = fixture();
    const assignmentId = 'supervision_assignment_registered_missing';
    const assignmentRoot = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', assignmentId);
    const worktreePath = join(assignmentRoot, 'repo');
    const input = {
      projectRoot: shape.source,
      sessionName: 'deck_sub_worker',
      assignmentId,
      baseRevision: shape.baseRevision,
      worktreePath,
    };
    await expect(ensureSupervisionAssignmentWorktree(input)).resolves.toMatchObject({
      ok: true, created: true,
    });
    const unrelatedPath = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', 'unrelated_stale', 'repo');
    git(shape.source, 'worktree', 'add', '--detach', unrelatedPath, shape.baseRevision);
    rmSync(unrelatedPath, { recursive: true });
    rmSync(worktreePath, { recursive: true });
    writeFileSync(join(assignmentRoot, '.worktree-provision.json'), JSON.stringify({
      version: 1, assignmentId, baseRevision: shape.baseRevision, worktreePath,
    }));
    const before = git(shape.source, 'worktree', 'list', '--porcelain');
    expect(before).toContain(`worktree ${canonicalWorktreePath(worktreePath)}`);
    expect(before).toContain('prunable gitdir file points to non-existent location');

    await expect(ensureSupervisionAssignmentWorktree(input)).resolves.toEqual({
      ok: true, worktreePath, baseRevision: shape.baseRevision, created: true,
    });
    expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(shape.baseRevision);
    expect(git(worktreePath, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect(git(shape.source, 'worktree', 'list', '--porcelain').split('\n')
      .filter((line) => line === `worktree ${canonicalWorktreePath(worktreePath)}`)).toHaveLength(1);
    expect(git(shape.source, 'worktree', 'list', '--porcelain'))
      .toContain(`worktree ${canonicalWorktreePath(unrelatedPath)}`);
    expect(() => readFileSync(join(assignmentRoot, '.worktree-provision.json'), 'utf8')).toThrow();
    expect(() => readFileSync(join(assignmentRoot, '.worktree-provision.lock'), 'utf8')).toThrow();
  });

  it('does not recover a registered-missing path after user bytes appear', async () => {
    const shape = fixture();
    const assignmentId = 'supervision_assignment_registered_user_bytes';
    const assignmentRoot = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', assignmentId);
    const worktreePath = join(assignmentRoot, 'repo');
    const input = {
      projectRoot: shape.source,
      sessionName: 'deck_sub_worker',
      assignmentId,
      baseRevision: shape.baseRevision,
      worktreePath,
    };
    await expect(ensureSupervisionAssignmentWorktree(input)).resolves.toMatchObject({ ok: true });
    rmSync(worktreePath, { recursive: true });
    mkdirSync(worktreePath);
    writeFileSync(join(worktreePath, 'user.txt'), 'must survive\n');
    writeFileSync(join(assignmentRoot, '.worktree-provision.json'), JSON.stringify({
      version: 1, assignmentId, baseRevision: shape.baseRevision, worktreePath,
    }));

    await expect(ensureSupervisionAssignmentWorktree(input)).resolves.toMatchObject({
      ok: false, reason: 'existing_unsafe',
    });
    expect(readFileSync(join(worktreePath, 'user.txt'), 'utf8')).toBe('must survive\n');
  });

  it('fails closed without changing dirty, wrong-base, or foreign existing paths', async () => {
    const shape = fixture();
    const worktreePath = join(shape.root, 'worktrees', 'imcodes', 'deck_sub_worker', 'supervision_assignment_dirty', 'repo');
    await ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_dirty',
      baseRevision: shape.baseRevision, worktreePath,
    });
    writeFileSync(join(worktreePath, 'base.txt'), 'user bytes\n');
    await expect(ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_dirty',
      baseRevision: shape.baseRevision, worktreePath,
    })).resolves.toMatchObject({ ok: false, reason: 'existing_dirty' });
    expect(readFileSync(join(worktreePath, 'base.txt'), 'utf8')).toBe('user bytes\n');

    writeFileSync(join(worktreePath, 'base.txt'), 'base\n');
    writeFileSync(join(shape.source, 'next.txt'), 'next\n');
    git(shape.source, 'add', 'next.txt');
    git(shape.source, 'commit', '-qm', 'next');
    const next = git(shape.source, 'rev-parse', 'HEAD');
    await expect(ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_dirty',
      baseRevision: next, worktreePath,
    })).resolves.toMatchObject({ ok: false, reason: 'base_mismatch' });
    expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(shape.baseRevision);

    const foreign = join(shape.root, 'foreign');
    mkdirSync(foreign);
    git(foreign, 'init', '-q');
    await expect(ensureSupervisionAssignmentWorktree({
      projectRoot: shape.source, sessionName: 'deck_sub_worker', assignmentId: 'supervision_assignment_foreign',
      baseRevision: shape.baseRevision, worktreePath: foreign,
    })).resolves.toMatchObject({ ok: false, reason: 'existing_unsafe' });
  });

  it('resolves an exact commit and rejects a stale explicit base', async () => {
    const shape = fixture();
    await expect(resolveSupervisionWorktreeBase({ projectRoot: shape.source }))
      .resolves.toEqual({ ok: true, baseRevision: shape.baseRevision });
    await expect(resolveSupervisionWorktreeBase({ projectRoot: shape.source, requestedBaseRevision: 'missing-ref' }))
      .resolves.toMatchObject({ ok: false, reason: 'base_unavailable' });
  });
});
