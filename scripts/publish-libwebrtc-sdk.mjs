#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createLibwebrtcSdkLock,
  createLibwebrtcSdkManifest,
  extractTargetOption,
} from './libwebrtc-sdk-artifacts.mjs';
import { libwebrtcSdkTarget } from './libwebrtc-sdk-targets.mjs';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * Every regular file under the staging directory, as `/`-separated relative
 * paths sorted by raw byte order.
 *
 * Sorting in Node rather than leaving it to the archiver is what makes the
 * member order a property of the input tree instead of a property of the
 * producer's filesystem readdir order.
 */
async function sortedRelativeFiles(root) {
  const files = [];
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error('libwebrtc SDK cannot contain links');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
      else throw new Error('libwebrtc SDK contains a non-file entry');
    }
  };
  await visit(root);
  return files.sort((left, right) => (
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  ));
}

/**
 * Pack the staging directory into a byte-reproducible `.tar.gz`.
 *
 * The archive digest is the release identity, so two runs over the same tree
 * must produce the same bytes. Everything below exists to remove one source of
 * per-run variation:
 *
 *  - a Node-sorted `-T` list       : fixes member order, and archives only the
 *                                    regular files (no directory entries, whose
 *                                    permissions and mtimes vary by umask).
 *  - `--null` + NUL-separated list : names are taken literally, never re-split.
 *  - normalized mtimes             : the one stat field tar records that changes
 *                                    on every rebuild and every fresh checkout.
 *  - `--format ustar`              : a fixed-width header with no extended
 *                                    attribute records; pax would embed
 *                                    sub-second times and vendor keywords.
 *  - `--uid 0 --gid 0 --numeric-owner` : drops the building account's ids and
 *                                    stops tar resolving them to names.
 *  - `--no-mac-metadata`           : suppresses the AppleDouble `._` members
 *                                    bsdtar synthesizes for xattrs and resource
 *                                    forks, which differ between machines.
 *  - `gzip -n`                     : omits the original filename and the
 *                                    compression timestamp from the gzip header.
 *  - `gzip -9`                     : pins the compression level, so the deflate
 *                                    stream does not depend on a default.
 */
async function compressTarGz(sdkDirectory, archivePath) {
  const files = await sortedRelativeFiles(sdkDirectory);
  if (files.length === 0) throw new Error('libwebrtc SDK staging directory is empty');
  // ustar splits a name into a 155-byte prefix and a 100-byte name at a `/`.
  // Refuse anything it cannot represent instead of letting tar truncate later.
  for (const file of files) {
    if (Buffer.byteLength(file, 'utf8') > 255) {
      throw new Error(`libwebrtc SDK path is too long for a ustar archive: ${file}`);
    }
  }
  const workspace = await mkdtemp(join(tmpdir(), 'imcodes-libwebrtc-sdk-tar-'));
  try {
    const listPath = join(workspace, 'members.lst');
    await writeFile(listPath, `${files.join('\0')}\0`, 'utf8');
    await Promise.all(files.map((file) => (
      utimes(join(sdkDirectory, ...file.split('/')), 0, 0)
    )));
    const tarPath = join(workspace, 'sdk.tar');
    execFileSync('/usr/bin/tar', [
      '-cf', tarPath,
      '--format', 'ustar',
      '--uid', '0', '--gid', '0', '--numeric-owner',
      '--no-mac-metadata',
      '--null', '-T', listPath,
    ], { cwd: sdkDirectory, stdio: ['ignore', 'inherit', 'inherit'] });
    // The SDK is hundreds of megabytes, so gzip writes straight into the
    // destination file descriptor rather than through a buffered pipe.
    const staged = join(workspace, 'sdk.tar.gz');
    const output = openSync(staged, 'w');
    try {
      const gzip = spawnSync('/usr/bin/gzip', ['-n', '-9', '-c', tarPath], {
        stdio: ['ignore', output, 'inherit'],
      });
      if (gzip.error) throw gzip.error;
      if (gzip.status !== 0) throw new Error(`gzip failed with status ${gzip.status}`);
    } finally {
      closeSync(output);
    }
    await rename(staged, archivePath);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Compress one verified staging directory using its target's archive format. */
export async function createLibwebrtcSdkArchive(target, sdkDirectory, archivePath) {
  if (target.archiveFormat === 'zip') {
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
    return archivePath;
  }
  await compressTarGz(sdkDirectory, archivePath);
  return archivePath;
}

export async function publishLibwebrtcSdk(targetId, sdkDirectory, outputDirectory, sourceCommit) {
  const target = libwebrtcSdkTarget(targetId);
  const archivePath = join(outputDirectory, target.archiveFilename);
  const lockPath = join(outputDirectory, target.lockFilename);
  await mkdir(outputDirectory, { recursive: true });
  await createLibwebrtcSdkManifest(sdkDirectory, sourceCommit, target.id);
  await createLibwebrtcSdkArchive(target, sdkDirectory, archivePath);
  return createLibwebrtcSdkLock(archivePath, sdkDirectory, lockPath, target.id);
}

async function main() {
  const { targetId, positional } = extractTargetOption(process.argv.slice(2));
  const [sdkDirectoryArgument, outputDirectoryArgument, sourceCommit] = positional;
  if (!sdkDirectoryArgument || !outputDirectoryArgument || !sourceCommit) {
    throw new Error('usage: publish-libwebrtc-sdk.mjs <sdk-dir> <output-dir> <source-commit> [--target <id>]');
  }
  const lock = await publishLibwebrtcSdk(
    targetId,
    resolve(sdkDirectoryArgument),
    resolve(outputDirectoryArgument),
    sourceCommit,
  );
  process.stdout.write(`${JSON.stringify(lock)}\n`);
  // A successful synchronous PowerShell child must not leak a stale native exit
  // status into wrappers that inspect the publisher process itself.
  process.exitCode = 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
