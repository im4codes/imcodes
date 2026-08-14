#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIBWEBRTC_SDK_LOCK_FILENAME,
  verifyLibwebrtcSdkLock,
} from './libwebrtc-sdk-artifacts.mjs';

const [, , archiveArgument, outputArgument] = process.argv;
if (!archiveArgument || !outputArgument) {
  throw new Error('usage: install-libwebrtc-sdk.mjs <archive.zip> <sdk-dir>');
}

const archivePath = resolve(archiveArgument);
const outputPath = resolve(outputArgument);
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const lockPath = resolve('native/windows-remote-desktop', LIBWEBRTC_SDK_LOCK_FILENAME);
await verifyLibwebrtcSdkLock(lockPath, archivePath);
await rm(outputPath, { recursive: true, force: true });
const windowsPowerShell = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);
execFileSync(windowsPowerShell, [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
  join(scriptsDirectory, 'windows-libwebrtc-sdk-archive.ps1'),
  '-Mode', 'Expand',
  '-SourcePath', archivePath,
  '-DestinationPath', outputPath,
], { stdio: 'inherit' });
await verifyLibwebrtcSdkLock(lockPath, archivePath, outputPath);
process.stdout.write(`installed ${outputPath}\n`);
