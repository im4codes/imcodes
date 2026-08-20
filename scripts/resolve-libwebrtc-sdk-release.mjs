#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  LIBWEBRTC_SDK_LOCK_FILENAME,
  computeLibwebrtcSdkSourceSha256,
  validateLibwebrtcSdkLock,
  verifyLibwebrtcSdkLock,
} from './libwebrtc-sdk-artifacts.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultRelativeLockPath = `native/windows-remote-desktop/${LIBWEBRTC_SDK_LOCK_FILENAME}`;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
// The first automatic SDK producer is allowed up to 240 minutes. Consumers
// start in the same push workflow fan-out, so their bounded bootstrap wait must
// cover that one-time producer window (plus queue/startup skew). Once the lock
// is promoted this path returns immediately and ordinary CI never waits.
const MAX_WAIT_SECONDS = 18_000;

export function parseArguments(argv) {
  let lockArgument;
  let waitSeconds = 0;
  let branch = 'dev';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--wait-seconds') {
      const raw = argv[index += 1];
      if (!/^\d+$/.test(raw ?? '')) throw new Error('--wait-seconds requires a non-negative integer');
      waitSeconds = Number(raw);
      if (!Number.isSafeInteger(waitSeconds) || waitSeconds > MAX_WAIT_SECONDS) {
        throw new Error(`--wait-seconds must not exceed ${MAX_WAIT_SECONDS}`);
      }
    } else if (argument === '--branch') {
      branch = argv[index += 1];
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch ?? '')
        || branch.includes('..') || branch.endsWith('/') || branch.includes('//')) {
        throw new Error('--branch is invalid');
      }
    } else if (argument?.startsWith('-') || lockArgument !== undefined) {
      throw new Error('usage: resolve-libwebrtc-sdk-release.mjs [lock] [--wait-seconds N] [--branch dev]');
    } else {
      lockArgument = argument;
    }
  }
  return {
    lockPath: resolve(repositoryRoot, lockArgument ?? defaultRelativeLockPath),
    lockRepositoryPath: lockArgument ?? defaultRelativeLockPath,
    waitSeconds,
    branch,
  };
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function readRemoteLock(branch, repositoryPath, expectedSourceSha256) {
  await execFileAsync('git', ['fetch', '--quiet', 'origin', branch], { cwd: repositoryRoot });
  const { stdout } = await execFileAsync(
    'git', ['show', `origin/${branch}:${repositoryPath}`],
    { cwd: repositoryRoot, maxBuffer: 1024 * 1024 },
  );
  return validateLibwebrtcSdkLock(JSON.parse(stdout), expectedSourceSha256);
}

export async function resolveLibwebrtcSdkLock(options, dependencies = {}) {
  const verifyLocalLock = dependencies.verifyLocalLock ?? verifyLibwebrtcSdkLock;
  const computeSourceSha256 = dependencies.computeSourceSha256 ?? computeLibwebrtcSdkSourceSha256;
  const fetchRemoteLock = dependencies.fetchRemoteLock ?? readRemoteLock;
  const writeResolvedLock = dependencies.writeResolvedLock
    ?? ((lockPath, lock) => writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8'));
  const wait = dependencies.delay ?? delay;
  const now = dependencies.now ?? Date.now;
  const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  try {
    return await verifyLocalLock(options.lockPath);
  } catch (initialError) {
    if (options.waitSeconds === 0) throw initialError;
    const expectedSourceSha256 = await computeSourceSha256();
    const deadline = now() + options.waitSeconds * 1000;
    let lastError = initialError;
    while (now() < deadline) {
      try {
        const lock = await fetchRemoteLock(
          options.branch,
          options.lockRepositoryPath.split('\\').join('/'),
          expectedSourceSha256,
        );
        await writeResolvedLock(options.lockPath, lock);
        return await verifyLocalLock(options.lockPath);
      } catch (error) {
        lastError = error;
      }
      await wait(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
    }
    throw new Error(
      `timed out waiting for a matching libwebrtc SDK lock on origin/${options.branch}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  const lock = await resolveLibwebrtcSdkLock(parseArguments(argv));
  const outputPath = process.env.GITHUB_OUTPUT?.trim();
  const lines = [
    `repository=${lock.repository}`,
    `release_tag=${lock.releaseTag}`,
    `asset_name=${lock.assetName}`,
    `sha256=${lock.sha256}`,
    `source_sha256=${lock.sourceSha256}`,
  ];
  if (outputPath) {
    await appendFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
  } else {
    process.stdout.write(`${JSON.stringify(lock)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
