#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PINNED_DEPOT_TOOLS_REVISION,
  PINNED_LIBWEBRTC_REVISION,
} from './remote-desktop-worker-artifacts.mjs';

export const LIBWEBRTC_SDK_MANIFEST_FILENAME = 'imcodes-libwebrtc-sdk.manifest.json';
export const LIBWEBRTC_SDK_ARCHIVE_FILENAME = 'imcodes-libwebrtc-sdk-windows-x64.zip';
export const LIBWEBRTC_SDK_LOCK_FILENAME = 'libwebrtc-sdk.lock.json';

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const RELEASE_TAG_RE = /^libwebrtc-sdk-windows-x64-[a-f0-9]{16}-[a-f0-9]{16}$/;
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE_INPUTS = Object.freeze([
  'shared/remote-desktop-native-pins.json',
  'native/windows-remote-desktop/sdk.BUILD.gn',
  'native/windows-remote-desktop/libwebrtc-sdk.gni',
  'native/windows-remote-desktop/sdk_anchor.cc',
  'native/windows-remote-desktop/load-native-pins.ps1',
  'native/windows-remote-desktop/initialize-hermetic-windows-git.ps1',
  'native/windows-remote-desktop/invoke-native-logged.ps1',
  'native/windows-remote-desktop/build-libwebrtc-sdk.ps1',
  'native/windows-remote-desktop/generate-libwebrtc-sdk-notices.py',
]);
const REQUIRED_TOP_LEVEL_ENTRIES = Object.freeze([
  'THIRD_PARTY_NOTICES.webrtc.md',
  'gen',
  'include',
  'lib',
  'sdk-build.json',
  'toolchain',
]);
const REQUIRED_FILES = Object.freeze([
  'lib/imcodes_libwebrtc_sdk.lib',
  'lib/imcodes_libwebrtc_test_sdk.lib',
  'lib/imcodes_libcxx_runtime_sdk.lib',
  'toolchain/manifest/as_invoker.manifest',
  'toolchain/manifest/common_controls.manifest',
  'toolchain/manifest/compatibility.manifest',
  'toolchain/bin/clang-cl.exe',
  'toolchain/bin/lld-link.exe',
  'toolchain/bin/llvm-ml.exe',
  'toolchain/lib/clang_rt.builtins-x86_64.lib',
]);
export const REQUIRED_LIBWEBRTC_SDK_NOTICE_SECTIONS = Object.freeze([
  'compiler-rt',
  'googletest',
  'libc++',
  'llvm-toolchain',
  'webrtc',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const expected = new Set(keys);
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => expected.has(key));
}

function normalizedRelativePath(path) {
  return relative(repositoryRoot, path).split(sep).join('/');
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolveStream);
  });
  return hash.digest('hex');
}

async function regularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`libwebrtc SDK path is not a regular file: ${path}`);
  }
  return stat;
}

export function validateLibwebrtcSdkNotices(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 16 * 1024 * 1024) {
    throw new Error('invalid libwebrtc SDK notices');
  }
  const headings = [...text.matchAll(/^# ([^\r\n]+)\r?$/gm)];
  const seen = new Set();
  for (const heading of headings) {
    if (seen.has(heading[1])) throw new Error('libwebrtc SDK notices contain duplicate sections');
    seen.add(heading[1]);
  }
  for (const required of REQUIRED_LIBWEBRTC_SDK_NOTICE_SECTIONS) {
    const index = headings.findIndex((heading) => heading[1] === required);
    if (index === -1) throw new Error(`libwebrtc SDK notices are missing ${required}`);
    const start = headings[index].index + headings[index][0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    const section = text.slice(start, end);
    const fenced = section.match(/^\r?\n```\r?\n([\s\S]*?)\r?\n```\s*$/);
    if (!fenced || fenced[1].trim().length === 0) {
      throw new Error(`libwebrtc SDK notices contain an empty ${required} section`);
    }
  }
  return text;
}

export const MACOS_LIBWEBRTC_NOTICE_TARGETS = Object.freeze([
  '//third_party/imcodes_macos_remote_desktop:imcodes_remote_desktop_disclosure',
  '//third_party/imcodes_macos_remote_desktop:imcodes_remote_desktop_launch_agent',
  '//third_party/imcodes_macos_remote_desktop:imcodes_remote_desktop_worker',
  // Sorted last on purpose: this list is compared byte-for-byte against the
  // generator's own `",".join(sorted(EXPECTED_TARGETS))`, so the order is part
  // of the contract, not a style choice.
  '//third_party/imcodes_macos_remote_desktop:imcodes_virtual_display_helper',
]);

/** Validate the fail-closed inventory emitted from the pinned macOS GN graph. */
export function validateMacosLibwebrtcNotices(text, expectedRevision) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 16 * 1024 * 1024) {
    throw new Error('invalid macOS libwebrtc notices');
  }
  const inventory = text.match(/^<!-- imcodes-macos-libwebrtc-notices-v1\nlibwebrtcRevision=([0-9a-f]{40})\ntargets=([^\n]+)\nlibraries=([^\n]+)\n-->\n\n/u);
  if (!inventory) throw new Error('macOS libwebrtc notices inventory is missing');
  if (expectedRevision !== undefined && inventory[1] !== expectedRevision) {
    throw new Error('macOS libwebrtc notices revision mismatch');
  }
  if (inventory[2] !== MACOS_LIBWEBRTC_NOTICE_TARGETS.join(',')) {
    throw new Error('macOS libwebrtc notices target inventory mismatch');
  }
  const libraries = inventory[3].split(',');
  if (libraries[0] !== 'webrtc' || new Set(libraries).size !== libraries.length) {
    throw new Error('macOS libwebrtc notices library inventory is invalid');
  }
  if (libraries.slice(1).join(',') !== [...libraries.slice(1)].sort().join(',')) {
    throw new Error('macOS libwebrtc notices library inventory is not deterministic');
  }
  const headings = [...text.matchAll(/^# ([^\r\n]+)\r?$/gmu)];
  if (headings.map((heading) => heading[1]).join(',') !== libraries.join(',')) {
    throw new Error('macOS libwebrtc notices sections do not match their inventory');
  }
  for (let index = 0; index < headings.length; index += 1) {
    const start = headings[index].index + headings[index][0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    const section = text.slice(start, end);
    const fenced = section.match(/^\r?\n```\r?\n([\s\S]*?)\r?\n```\s*$/u);
    if (!fenced || fenced[1].trim().length === 0) {
      throw new Error(`macOS libwebrtc notices contain an empty ${headings[index][1]} section`);
    }
  }
  return text;
}

export async function computeLibwebrtcSdkSourceSha256() {
  const hash = createHash('sha256');
  for (const input of SOURCE_INPUTS) {
    const path = resolve(repositoryRoot, input);
    await regularFile(path);
    const original = await readFile(path);
    // Every fingerprint input is UTF-8 text. Normalize checkout line endings
    // so core.autocrlf cannot manufacture a different SDK identity on Windows.
    const bytes = Buffer.from(original.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    const name = normalizedRelativePath(path);
    hash.update(`${Buffer.byteLength(name, 'utf8')}:${name}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function validateBuildMetadata(value) {
  if (!isRecord(value)
    || !exactKeys(value, [
      'manifestVersion', 'os', 'arch', 'libwebrtcRevision', 'depotToolsRevision',
      'buildArgs', 'toolchain',
    ])
    || value.manifestVersion !== 1
    || value.os !== 'win32'
    || value.arch !== 'x64'
    || value.libwebrtcRevision !== PINNED_LIBWEBRTC_REVISION
    || value.depotToolsRevision !== PINNED_DEPOT_TOOLS_REVISION
    || typeof value.buildArgs !== 'string' || value.buildArgs.length === 0 || value.buildArgs.length > 4096
    || !isRecord(value.toolchain)
    || !exactKeys(value.toolchain, ['msvc', 'windowsSdk', 'clang'])
    || !Object.values(value.toolchain).every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 128)) {
    throw new Error('invalid libwebrtc SDK build metadata');
  }
  return value;
}

export function validateLibwebrtcSdkManifest(value, expectedSourceSha256) {
  if (!isRecord(value)
    || !exactKeys(value, [
      'manifestVersion', 'os', 'arch', 'sourceSha256', 'sourceCommit',
      'libwebrtcRevision', 'depotToolsRevision', 'buildArgs', 'toolchain', 'files',
    ])
    || value.manifestVersion !== 2
    || value.os !== 'win32'
    || value.arch !== 'x64'
    || typeof value.sourceSha256 !== 'string' || !SHA256_RE.test(value.sourceSha256)
    || (expectedSourceSha256 !== undefined && value.sourceSha256 !== expectedSourceSha256)
    || typeof value.sourceCommit !== 'string' || !COMMIT_RE.test(value.sourceCommit)
    || value.libwebrtcRevision !== PINNED_LIBWEBRTC_REVISION
    || value.depotToolsRevision !== PINNED_DEPOT_TOOLS_REVISION
    || typeof value.buildArgs !== 'string' || value.buildArgs.length === 0 || value.buildArgs.length > 4096
    || !isRecord(value.toolchain)
    || !exactKeys(value.toolchain, ['msvc', 'windowsSdk', 'clang'])
    || !Object.values(value.toolchain).every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 128)
    || !Array.isArray(value.files) || value.files.length < REQUIRED_FILES.length
    || value.files.length > 100_000) {
    throw new Error('invalid libwebrtc SDK manifest');
  }
  const seen = new Set();
  for (const file of value.files) {
    if (!isRecord(file)
      || !exactKeys(file, ['path', 'size', 'sha256'])
      || typeof file.path !== 'string'
      || file.path.length === 0 || file.path.length > 512
      || file.path.includes('\\') || file.path.startsWith('/')
      || file.path.split('/').some((part) => part === '' || part === '.' || part === '..')
      || seen.has(file.path)
      || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size <= 0
      || typeof file.sha256 !== 'string' || !SHA256_RE.test(file.sha256)) {
      throw new Error('invalid libwebrtc SDK file manifest');
    }
    seen.add(file.path);
  }
  if (REQUIRED_FILES.some((path) => !seen.has(path))) {
    throw new Error('libwebrtc SDK manifest is missing a required file');
  }
  return value;
}

export function validateLibwebrtcSdkLock(value, expectedSourceSha256) {
  if (!isRecord(value)
    || !exactKeys(value, [
      'manifestVersion', 'repository', 'releaseTag', 'assetName', 'sha256',
      'sourceSha256', 'sourceCommit', 'libwebrtcRevision', 'depotToolsRevision',
      'sdkManifestSha256', 'toolchain',
    ])
    || value.manifestVersion !== 2
    || value.repository !== 'im4codes/imcodes'
    || typeof value.releaseTag !== 'string' || !RELEASE_TAG_RE.test(value.releaseTag)
    || value.assetName !== LIBWEBRTC_SDK_ARCHIVE_FILENAME
    || typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)
    || typeof value.sourceSha256 !== 'string' || !SHA256_RE.test(value.sourceSha256)
    || (expectedSourceSha256 !== undefined && value.sourceSha256 !== expectedSourceSha256)
    || typeof value.sourceCommit !== 'string' || !COMMIT_RE.test(value.sourceCommit)
    || value.libwebrtcRevision !== PINNED_LIBWEBRTC_REVISION
    || value.depotToolsRevision !== PINNED_DEPOT_TOOLS_REVISION
    || typeof value.sdkManifestSha256 !== 'string' || !SHA256_RE.test(value.sdkManifestSha256)
    || !isRecord(value.toolchain)
    || !exactKeys(value.toolchain, ['msvc', 'windowsSdk', 'clang'])
    || !Object.values(value.toolchain).every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 128)) {
    throw new Error('invalid libwebrtc SDK lock');
  }
  if (value.releaseTag !== `libwebrtc-sdk-windows-x64-${value.sourceSha256.slice(0, 16)}-${value.sha256.slice(0, 16)}`) {
    throw new Error('libwebrtc SDK release tag does not match its fingerprints');
  }
  return value;
}

async function collectSdkFiles(directory) {
  const files = [];
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error('libwebrtc SDK cannot contain links');
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const name = relative(directory, path).split(sep).join('/');
        const stat = await regularFile(path);
        files.push({ path: name, size: stat.size, sha256: await sha256File(path) });
      } else {
        throw new Error('libwebrtc SDK contains a non-file entry');
      }
    }
  };
  await visit(directory);
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export async function createLibwebrtcSdkManifest(sdkDirectory, sourceCommit) {
  if (!COMMIT_RE.test(sourceCommit)) throw new Error('source commit must be a full lowercase Git SHA');
  const entries = await readdir(sdkDirectory, { withFileTypes: true });
  const actualTopLevel = entries
    .map((entry) => entry.name)
    .filter((name) => name !== LIBWEBRTC_SDK_MANIFEST_FILENAME)
    .sort();
  if (JSON.stringify(actualTopLevel) !== JSON.stringify([...REQUIRED_TOP_LEVEL_ENTRIES].sort())) {
    throw new Error('libwebrtc SDK staging directory has unexpected top-level entries');
  }
  const metadataPath = join(sdkDirectory, 'sdk-build.json');
  const metadata = validateBuildMetadata(JSON.parse(await readFile(metadataPath, 'utf8')));
  if (metadata.buildArgs !== 'target_os=\\"win\\" target_cpu=\\"x64\\" is_debug=false is_component_build=false rtc_include_tests=true rtc_build_examples=false rtc_enable_protobuf=false use_rtti=false') {
    throw new Error('libwebrtc SDK build arguments do not match the pinned contract');
  }
  const files = (await collectSdkFiles(sdkDirectory))
    .filter((file) => file.path !== LIBWEBRTC_SDK_MANIFEST_FILENAME);
  const manifest = {
    manifestVersion: 2,
    os: 'win32',
    arch: 'x64',
    sourceSha256: await computeLibwebrtcSdkSourceSha256(),
    sourceCommit,
    libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
    depotToolsRevision: PINNED_DEPOT_TOOLS_REVISION,
    buildArgs: metadata.buildArgs,
    toolchain: { ...metadata.toolchain },
    files,
  };
  await writeFile(
    join(sdkDirectory, LIBWEBRTC_SDK_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return verifyLibwebrtcSdkDirectory(sdkDirectory);
}

export async function verifyLibwebrtcSdkDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const expected = [...REQUIRED_TOP_LEVEL_ENTRIES, LIBWEBRTC_SDK_MANIFEST_FILENAME].sort();
  if (JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(expected)) {
    throw new Error('libwebrtc SDK contains unexpected top-level entries');
  }
  const manifestPath = join(directory, LIBWEBRTC_SDK_MANIFEST_FILENAME);
  const manifestStat = await regularFile(manifestPath);
  if (manifestStat.size <= 0 || manifestStat.size > 16 * 1024 * 1024) {
    throw new Error('libwebrtc SDK manifest size is invalid');
  }
  const manifest = validateLibwebrtcSdkManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')),
    await computeLibwebrtcSdkSourceSha256(),
  );
  const noticesPath = join(directory, 'THIRD_PARTY_NOTICES.webrtc.md');
  await regularFile(noticesPath);
  validateLibwebrtcSdkNotices(await readFile(noticesPath, 'utf8'));
  const actualFiles = await collectSdkFiles(directory);
  const withoutManifest = actualFiles.filter((file) => file.path !== LIBWEBRTC_SDK_MANIFEST_FILENAME);
  if (JSON.stringify(withoutManifest) !== JSON.stringify(manifest.files)) {
    throw new Error('libwebrtc SDK file manifest does not match its contents');
  }
  return { manifest, manifestPath };
}

export async function createLibwebrtcSdkLock(archivePath, sdkDirectory, outputPath) {
  if (basename(archivePath) !== LIBWEBRTC_SDK_ARCHIVE_FILENAME) {
    throw new Error(`SDK archive must be named ${LIBWEBRTC_SDK_ARCHIVE_FILENAME}`);
  }
  await regularFile(archivePath);
  const sdk = await verifyLibwebrtcSdkDirectory(sdkDirectory);
  const archiveSha256 = await sha256File(archivePath);
  const lock = {
    manifestVersion: 2,
    repository: 'im4codes/imcodes',
    releaseTag: `libwebrtc-sdk-windows-x64-${sdk.manifest.sourceSha256.slice(0, 16)}-${archiveSha256.slice(0, 16)}`,
    assetName: LIBWEBRTC_SDK_ARCHIVE_FILENAME,
    sha256: archiveSha256,
    sourceSha256: sdk.manifest.sourceSha256,
    sourceCommit: sdk.manifest.sourceCommit,
    libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
    depotToolsRevision: PINNED_DEPOT_TOOLS_REVISION,
    sdkManifestSha256: await sha256File(sdk.manifestPath),
    toolchain: { ...sdk.manifest.toolchain },
  };
  validateLibwebrtcSdkLock(lock, sdk.manifest.sourceSha256);
  await writeFile(outputPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return lock;
}

export async function verifyLibwebrtcSdkLock(lockPath, archivePath, sdkDirectory) {
  const lock = validateLibwebrtcSdkLock(
    JSON.parse(await readFile(lockPath, 'utf8')),
    await computeLibwebrtcSdkSourceSha256(),
  );
  if (archivePath !== undefined) {
    await regularFile(archivePath);
    if (basename(archivePath) !== lock.assetName || await sha256File(archivePath) !== lock.sha256) {
      throw new Error('libwebrtc SDK archive does not match the repository lock');
    }
  }
  if (sdkDirectory !== undefined) {
    const sdk = await verifyLibwebrtcSdkDirectory(sdkDirectory);
    if (sdk.manifest.sourceSha256 !== lock.sourceSha256
      || sdk.manifest.sourceCommit !== lock.sourceCommit
      || await sha256File(sdk.manifestPath) !== lock.sdkManifestSha256
      || Object.keys(lock.toolchain).some((key) => sdk.manifest.toolchain[key] !== lock.toolchain[key])) {
      throw new Error('libwebrtc SDK contents do not match the repository lock');
    }
  }
  return lock;
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (command === 'fingerprint' && args.length === 0) {
    process.stdout.write(`${await computeLibwebrtcSdkSourceSha256()}\n`);
  } else if (command === 'create-manifest' && args.length === 2) {
    await createLibwebrtcSdkManifest(args[0], args[1]);
  } else if (command === 'verify' && args.length === 1) {
    const result = await verifyLibwebrtcSdkDirectory(args[0]);
    process.stdout.write(`verified ${result.manifest.sourceSha256}\n`);
  } else if (command === 'create-lock' && args.length === 3) {
    process.stdout.write(`${JSON.stringify(await createLibwebrtcSdkLock(args[0], args[1], args[2]))}\n`);
  } else if (command === 'verify-lock' && args.length >= 1 && args.length <= 3) {
    process.stdout.write(`${JSON.stringify(await verifyLibwebrtcSdkLock(args[0], args[1], args[2]))}\n`);
  } else if (command === 'verify-sdk-lock' && args.length === 2) {
    process.stdout.write(`${JSON.stringify(await verifyLibwebrtcSdkLock(args[0], undefined, args[1]))}\n`);
  } else {
    throw new Error(
      'usage: libwebrtc-sdk-artifacts.mjs '
      + '<fingerprint|create-manifest <sdk-dir> <commit>|verify <sdk-dir>|'
      + 'create-lock <archive> <sdk-dir> <lock>|verify-lock <lock> [archive] [sdk-dir]|'
      + 'verify-sdk-lock <lock> <sdk-dir>>',
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
