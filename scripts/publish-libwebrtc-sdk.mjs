#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIBWEBRTC_SDK_ARCHIVE_FILENAME,
  LIBWEBRTC_SDK_LOCK_FILENAME,
  createLibwebrtcSdkDirectory,
  createLibwebrtcSdkLock,
} from './libwebrtc-sdk-artifacts.mjs';

const [, , releaseDirectoryArgument, outputDirectoryArgument, sourceCommit] = process.argv;
if (!releaseDirectoryArgument || !outputDirectoryArgument || !sourceCommit) {
  throw new Error('usage: publish-libwebrtc-sdk.mjs <release-dir> <output-dir> <source-commit>');
}

const releaseDirectory = resolve(releaseDirectoryArgument);
const outputDirectory = resolve(outputDirectoryArgument);
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const sdkDirectory = await mkdtemp(join(tmpdir(), 'imcodes-libwebrtc-sdk-create-'));
const archivePath = join(outputDirectory, LIBWEBRTC_SDK_ARCHIVE_FILENAME);
const lockPath = join(outputDirectory, LIBWEBRTC_SDK_LOCK_FILENAME);

try {
  await createLibwebrtcSdkDirectory(releaseDirectory, sdkDirectory, sourceCommit);
  const windowsPowerShell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  execFileSync(windowsPowerShell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(scriptsDirectory, 'windows-libwebrtc-sdk-archive.ps1'),
    '-Mode', 'Compress',
    '-SourcePath', sdkDirectory,
    '-DestinationPath', archivePath,
  ], { stdio: 'inherit' });
  const lock = await createLibwebrtcSdkLock(archivePath, sdkDirectory, lockPath);
  process.stdout.write(`${JSON.stringify(lock)}\n`);
} finally {
  await rm(sdkDirectory, { recursive: true, force: true });
}
