#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractTargetOption,
  verifyLibwebrtcSdkLock,
} from './libwebrtc-sdk-artifacts.mjs';
import { libwebrtcSdkTarget } from './libwebrtc-sdk-targets.mjs';
import { isModuleEntry } from './module-entry.mjs';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));

const MAX_ARCHIVE_ENTRIES = 100_000;

/**
 * Reject an archive member before anything is written to disk.
 *
 * The lock is verified against the archive bytes first, so a tampered archive
 * never reaches here. This guards the other case: an archive that is exactly
 * what it claims to be and still writes outside the directory it was given,
 * because `tar` resolves `../` and absolute paths itself.
 */
function validateArchiveEntries(target, entries) {
  if (entries.length === 0) throw new Error('libwebrtc SDK archive is empty');
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('libwebrtc SDK archive contains too many entries');
  }
  const seen = new Set();
  for (const entry of entries) {
    if (entry.length === 0 || entry.length > 1024
      || entry.startsWith('/') || entry.includes('\\') || entry.includes('//')
      || entry.endsWith('/')
      || entry.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error(`libwebrtc SDK archive contains an unsafe entry: ${entry}`);
    }
    // Case-insensitively, because macOS filesystems are by default: two
    // members differing only in case would silently overwrite one another.
    const key = entry.toLowerCase();
    if (seen.has(key)) throw new Error(`libwebrtc SDK archive contains a duplicate entry: ${entry}`);
    seen.add(key);
  }
  const present = new Set(entries);
  for (const required of target.requiredFiles) {
    if (!present.has(required)) {
      throw new Error(`libwebrtc SDK archive is missing ${required}`);
    }
  }
}

async function expandTarGz(target, archivePath, outputPath) {
  const listing = execFileSync('/usr/bin/tar', ['-tzf', archivePath], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  validateArchiveEntries(target, listing.split('\n').filter((line) => line.length > 0));
  await mkdir(outputPath, { recursive: true });
  // `-p` so the staged modes survive: the manifest records path, size and
  // digest but not mode, so an executable bit stripped here would be restored
  // by nothing and caught by nothing -- the SDK would verify perfectly and its
  // compiler would refuse to run.
  execFileSync('/usr/bin/tar', ['-xzpf', archivePath, '-C', outputPath], { stdio: 'inherit' });
}

function expandZip(archivePath, outputPath) {
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
}

/** Every staged tool has to still be executable once it is back on disk. */
function verifyExecutableTools(target, outputPath) {
  for (const required of target.requiredFiles) {
    if (!required.startsWith('toolchain/bin/')) continue;
    const path = join(outputPath, ...required.split('/'));
    try {
      accessSync(path, constants.X_OK);
    } catch {
      throw new Error(`installed libwebrtc SDK tool is not executable: ${required}`);
    }
  }
}

export async function installLibwebrtcSdk(targetId, archiveArgument, outputArgument) {
  const target = libwebrtcSdkTarget(targetId);
  const archivePath = resolve(archiveArgument);
  const outputPath = resolve(outputArgument);
  const lockPath = resolve(...target.lockRelativePath.split('/'));
  // Before extraction, so a mismatched archive is never unpacked at all.
  await verifyLibwebrtcSdkLock(lockPath, archivePath, undefined, target.id);
  await rm(outputPath, { recursive: true, force: true });
  if (target.archiveFormat === 'zip') expandZip(archivePath, outputPath);
  else await expandTarGz(target, archivePath, outputPath);
  // And again afterwards, now including the expanded tree: this is what checks
  // every file's digest against the manifest.
  await verifyLibwebrtcSdkLock(lockPath, archivePath, outputPath, target.id);
  verifyExecutableTools(target, outputPath);
  return outputPath;
}

async function main() {
  const { targetId, positional } = extractTargetOption(process.argv.slice(2));
  const [archiveArgument, outputArgument] = positional;
  if (!archiveArgument || !outputArgument) {
    throw new Error('usage: install-libwebrtc-sdk.mjs <archive> <sdk-dir> [--target <id>]');
  }
  const outputPath = await installLibwebrtcSdk(targetId, archiveArgument, outputArgument);
  process.stdout.write(`installed ${outputPath}\n`);
}

if (isModuleEntry(import.meta.url)) {
  await main();
}
