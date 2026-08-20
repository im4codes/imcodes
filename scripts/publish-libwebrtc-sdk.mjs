#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIBWEBRTC_SDK_ARCHIVE_FILENAME,
  LIBWEBRTC_SDK_LOCK_FILENAME,
  createLibwebrtcSdkLock,
  createLibwebrtcSdkManifest,
} from './libwebrtc-sdk-artifacts.mjs';

const [, , sdkDirectoryArgument, outputDirectoryArgument, sourceCommit] = process.argv;
if (!sdkDirectoryArgument || !outputDirectoryArgument || !sourceCommit) {
  throw new Error('usage: publish-libwebrtc-sdk.mjs <sdk-dir> <output-dir> <source-commit>');
}

const sdkDirectory = resolve(sdkDirectoryArgument);
const outputDirectory = resolve(outputDirectoryArgument);
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const archivePath = join(outputDirectory, LIBWEBRTC_SDK_ARCHIVE_FILENAME);
const lockPath = join(outputDirectory, LIBWEBRTC_SDK_LOCK_FILENAME);
await mkdir(outputDirectory, { recursive: true });
await createLibwebrtcSdkManifest(sdkDirectory, sourceCommit);
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
// A successful synchronous PowerShell child must not leak a stale native exit
// status into wrappers that inspect the publisher process itself.
process.exitCode = 0;
