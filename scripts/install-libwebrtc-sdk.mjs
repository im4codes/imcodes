#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIBWEBRTC_SDK_LOCK_FILENAME,
  materializeLibwebrtcSdk,
  verifyLibwebrtcSdkLock,
} from './libwebrtc-sdk-artifacts.mjs';

const [, , archiveArgument, outputArgument, version] = process.argv;
if (!archiveArgument || !outputArgument || !version) {
  throw new Error('usage: install-libwebrtc-sdk.mjs <archive.zip> <release-dir> <worker-version>');
}

const archivePath = resolve(archiveArgument);
const outputPath = resolve(outputArgument);
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const lockPath = resolve('native/windows-remote-desktop', LIBWEBRTC_SDK_LOCK_FILENAME);
const extractRoot = await mkdtemp(join(tmpdir(), 'imcodes-libwebrtc-sdk-'));

try {
  await verifyLibwebrtcSdkLock(lockPath, archivePath);
  const windowsPowerShell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  execFileSync(windowsPowerShell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(scriptsDirectory, 'windows-libwebrtc-sdk-archive.ps1'),
    '-Mode', 'Expand',
    '-SourcePath', archivePath,
    '-DestinationPath', extractRoot,
  ], { stdio: 'inherit' });
  await verifyLibwebrtcSdkLock(lockPath, archivePath, extractRoot);
  const result = await materializeLibwebrtcSdk(extractRoot, outputPath, version);
  process.stdout.write(`installed ${result.executablePath}\n`);
} finally {
  await rm(extractRoot, { recursive: true, force: true });
}
