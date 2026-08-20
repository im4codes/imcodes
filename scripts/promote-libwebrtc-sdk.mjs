#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIBWEBRTC_SDK_LOCK_FILENAME,
  verifyLibwebrtcSdkLock,
} from './libwebrtc-sdk-artifacts.mjs';

const COMMIT_RE = /^[a-f0-9]{40}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_PUSH_ATTEMPTS = 5;

function defaultRun(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

export function parsePromotionArguments(args) {
  const [lockArgument, archiveArgument, builtCommit, branch = 'dev'] = args;
  if (!lockArgument || !archiveArgument || !COMMIT_RE.test(builtCommit ?? '')) {
    throw new Error('usage: promote-libwebrtc-sdk.mjs <lock> <archive> <built-commit> [branch]');
  }
  if (!BRANCH_RE.test(branch)
    || branch.includes('..') || branch.endsWith('/') || branch.includes('//')) {
    throw new Error('invalid SDK promotion branch');
  }
  return {
    lockPath: resolve(lockArgument),
    archivePath: resolve(archiveArgument),
    builtCommit,
    branch,
  };
}

export async function promoteLibwebrtcSdk(options, overrides = {}) {
  const dependencies = {
    run: defaultRun,
    verifyLock: verifyLibwebrtcSdkLock,
    makeTempDirectory: mkdtemp,
    remove: rm,
    readText: (path) => readFile(path, 'utf8'),
    makeDirectory: mkdir,
    copy: copyFile,
    temporaryRoot: tmpdir(),
    repositoryRoot: resolve('.'),
    ...overrides,
  };
  const { lockPath, archivePath, builtCommit, branch } = options;
  const lock = await dependencies.verifyLock(lockPath, archivePath);
  if (lock.sourceCommit !== builtCommit) {
    throw new Error('SDK lock commit does not match the workflow commit');
  }

  const computeSourceSha256 = (root) => dependencies.run(
    process.execPath,
    [join(root, 'scripts/libwebrtc-sdk-artifacts.mjs'), 'fingerprint'],
    { cwd: root },
  );
  const builtSource = computeSourceSha256(dependencies.repositoryRoot);
  if (builtSource !== lock.sourceSha256) {
    throw new Error('built SDK inputs no longer match the generated lock');
  }

  let releaseExists = false;
  try {
    dependencies.run('gh', [
      'release', 'view', lock.releaseTag,
      '--repo', lock.repository,
      '--json', 'tagName',
    ]);
    releaseExists = true;
  } catch {
    releaseExists = false;
  }
  if (releaseExists) {
    const verifyRoot = await dependencies.makeTempDirectory(
      join(dependencies.temporaryRoot, 'imcodes-sdk-release-verify-'),
    );
    try {
      dependencies.run('gh', [
        'release', 'download', lock.releaseTag,
        '--repo', lock.repository,
        '--pattern', lock.assetName,
        '--dir', verifyRoot,
        '--clobber',
      ]);
      await dependencies.verifyLock(lockPath, join(verifyRoot, lock.assetName));
    } finally {
      await dependencies.remove(verifyRoot, { recursive: true, force: true });
    }
  } else {
    try {
      dependencies.run('gh', [
        'release', 'create', lock.releaseTag,
        archivePath,
        '--repo', lock.repository,
        '--title', `Pinned Windows libwebrtc SDK ${lock.sourceSha256.slice(0, 16)}`,
        '--notes', `Immutable dependency SDK for libwebrtc ${lock.libwebrtcRevision}.`,
      ]);
    } catch {
      // A concurrent identical workflow may win. Accept only the exact locked
      // bytes from that immutable tag; all other release failures stay fatal.
      const verifyRoot = await dependencies.makeTempDirectory(
        join(dependencies.temporaryRoot, 'imcodes-sdk-release-race-'),
      );
      try {
        dependencies.run('gh', [
          'release', 'download', lock.releaseTag,
          '--repo', lock.repository,
          '--pattern', lock.assetName,
          '--dir', verifyRoot,
          '--clobber',
        ]);
        await dependencies.verifyLock(lockPath, join(verifyRoot, lock.assetName));
      } finally {
        await dependencies.remove(verifyRoot, { recursive: true, force: true });
      }
    }
  }

  let promoted = false;
  let lastPushError;
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS && !promoted; attempt += 1) {
    const worktreeRoot = await dependencies.makeTempDirectory(
      join(dependencies.temporaryRoot, 'imcodes-sdk-lock-'),
    );
    const worktree = join(worktreeRoot, 'checkout');
    let attached = false;
    try {
      dependencies.run('git', ['fetch', 'origin', branch]);
      dependencies.run('git', ['worktree', 'add', '--detach', worktree, `origin/${branch}`]);
      attached = true;
      const currentSource = computeSourceSha256(worktree);
      if (currentSource !== lock.sourceSha256) {
        throw new Error('SDK inputs changed while the SDK was building; refusing to advance the lock');
      }
      const relativeLockPath = `native/windows-remote-desktop/${LIBWEBRTC_SDK_LOCK_FILENAME}`;
      const destination = join(worktree, ...relativeLockPath.split('/'));
      const current = await dependencies.readText(destination).catch(() => '');
      const next = await dependencies.readText(lockPath);
      if (current === next) {
        promoted = true;
        continue;
      }
      await dependencies.makeDirectory(join(worktree, 'native', 'windows-remote-desktop'), {
        recursive: true,
      });
      await dependencies.copy(lockPath, destination);
      dependencies.run('git', ['add', '--', relativeLockPath], { cwd: worktree });
      dependencies.run('git', [
        '-c', 'user.name=github-actions[bot]',
        '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', `lock libwebrtc sdk ${lock.sourceSha256.slice(0, 16)}`,
      ], { cwd: worktree });
      try {
        dependencies.run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: worktree });
        promoted = true;
      } catch (error) {
        lastPushError = error;
        if (attempt === MAX_PUSH_ATTEMPTS) throw error;
      }
    } finally {
      if (attached) {
        try {
          dependencies.run('git', ['worktree', 'remove', '--force', worktree]);
        } catch {
          // Temporary worktree cleanup is best effort; its parent is removed next.
        }
      }
      await dependencies.remove(worktreeRoot, { recursive: true, force: true });
    }
  }
  if (!promoted) throw lastPushError ?? new Error('SDK lock promotion did not complete');
  return { archiveName: basename(archivePath), releaseTag: lock.releaseTag };
}

async function main() {
  const options = parsePromotionArguments(process.argv.slice(2));
  const result = await promoteLibwebrtcSdk(options);
  process.stdout.write(`promoted ${result.archiveName} as ${result.releaseTag}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
