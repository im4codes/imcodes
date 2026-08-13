#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const NODE_EXE_MANIFEST_SCHEMA_VERSION = 1;
export const NODE_EXE_MANIFEST_SUFFIX = '.manifest.json';

const SHA256_RE = /^[a-f0-9]{64}$/;
const SUPPORTED_PLATFORMS = new Set(['linux', 'darwin', 'win32']);
const SUPPORTED_ARCHES = new Set(['x64', 'arm64', 'universal']);
const EXPECTED_TARGET_BY_ARTIFACT = new Map([
  ['imcodes-node-linux', { os: 'linux', arch: 'x64' }],
  ['imcodes-node-macos', { os: 'darwin', arch: 'universal' }],
  ['imcodes-node.exe', { os: 'win32', arch: 'x64' }],
]);
const EXPECTED_HELPER_BY_ARTIFACT = new Map([
  ['imcodes-node-linux', ['computer-use-helper', 'linux-x64', 'open-computer-use']],
  ['imcodes-node-macos', ['computer-use-helper', 'darwin-universal', 'open-computer-use.app.zip']],
  ['imcodes-node.exe', ['computer-use-helper', 'win32-x64', 'open-computer-use.exe']],
]);
const BUILD_VERSION_RE = /^[0-9]+(?:\.[0-9]+){1,3}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

export function normalizeNodeExeBuildVersion(value) {
  if (typeof value !== 'string' || !BUILD_VERSION_RE.test(value.trim())) {
    throw new Error('invalid controlled-node build version');
  }
  return value.trim();
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  return await new Promise((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

export function parseOfficialNodeShasums(text, artifactName) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (match && match[2] === artifactName) return match[1].toLowerCase();
  }
  throw new Error(`official Node SHASUMS256.txt has no entry for ${artifactName}`);
}

export async function verifyOfficialNodeArtifact(artifactPath, artifactName, shasumsText) {
  const expected = parseOfficialNodeShasums(shasumsText, artifactName);
  const actual = await sha256File(artifactPath);
  if (actual !== expected) {
    throw new Error(`official Node checksum mismatch for ${artifactName}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

function assertUniversalNodeArchives(value, context) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${context}: toolchain.nodeArchives must contain x64 and arm64 entries`);
  }
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${context}: invalid universal Node archive entry`);
    }
    if ((entry.arch !== 'x64' && entry.arch !== 'arm64') || seen.has(entry.arch)) {
      throw new Error(`${context}: invalid or duplicate universal Node archive architecture`);
    }
    if (typeof entry.nodeArchive !== 'string'
      || basename(entry.nodeArchive) !== entry.nodeArchive
      || entry.nodeArchive.length === 0
      || typeof entry.nodeArchiveSha256 !== 'string'
      || !SHA256_RE.test(entry.nodeArchiveSha256)) {
      throw new Error(`${context}: invalid universal Node archive provenance`);
    }
    seen.add(entry.arch);
  }
  if (!seen.has('x64') || !seen.has('arm64')) {
    throw new Error(`${context}: universal Node archive architectures are incomplete`);
  }
}

export async function createNodeExeManifest({
  artifactPath,
  os,
  arch,
  nodeVersion,
  nodeArchive,
  nodeArchiveSha256,
  postjectVersion,
  buildCommit,
  buildVersion,
  nodeArchives,
  helperPath,
  helperRelativePath,
  authenticodeSignerSha256,
}) {
  if (!SUPPORTED_PLATFORMS.has(os)) throw new Error(`unsupported manifest os: ${os}`);
  if (!SUPPORTED_ARCHES.has(arch)) throw new Error(`unsupported manifest arch: ${arch}`);
  if (typeof nodeVersion !== 'string' || !/^v\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error('invalid Node version');
  if (typeof nodeArchive !== 'string' || basename(nodeArchive) !== nodeArchive || nodeArchive.length === 0) throw new Error('invalid Node archive');
  if (typeof nodeArchiveSha256 !== 'string' || !SHA256_RE.test(nodeArchiveSha256)) throw new Error('invalid Node archive SHA-256');
  if (arch === 'universal') assertUniversalNodeArchives(nodeArchives, 'universal manifest');
  if (typeof postjectVersion !== 'string' || postjectVersion.length === 0) throw new Error('invalid postject version');
  if (typeof buildCommit !== 'string' || !/^[a-f0-9]{7,64}$/.test(buildCommit.trim())) throw new Error('invalid build commit');
  const normalizedBuildVersion = normalizeNodeExeBuildVersion(buildVersion);

  const file = await stat(artifactPath);
  if (!file.isFile()) throw new Error(`artifact is not a regular file: ${artifactPath}`);
  let computerUseHelper;
  if (helperPath !== undefined || helperRelativePath !== undefined) {
    if (typeof helperPath !== 'string' || typeof helperRelativePath !== 'string'
      || helperRelativePath.length === 0 || helperRelativePath.includes('\\')
      || helperRelativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('invalid Computer Use helper path');
    }
    const helper = await stat(helperPath);
    if (!helper.isFile() || helper.size <= 0) throw new Error('Computer Use helper is not a regular file');
    computerUseHelper = {
      relativePath: helperRelativePath,
      size: helper.size,
      sha256: await sha256File(helperPath),
      ...(authenticodeSignerSha256 ? { authenticodeSignerSha256 } : {}),
    };
  }
  if (authenticodeSignerSha256 !== undefined
    && (typeof authenticodeSignerSha256 !== 'string' || !SHA256_RE.test(authenticodeSignerSha256))) {
    throw new Error('invalid Authenticode signer SHA-256');
  }
  return {
    schemaVersion: NODE_EXE_MANIFEST_SCHEMA_VERSION,
    artifact: {
      fileName: basename(artifactPath),
      os,
      arch,
      size: file.size,
      sha256: await sha256File(artifactPath),
      ...(authenticodeSignerSha256 ? { authenticodeSignerSha256 } : {}),
    },
    ...(computerUseHelper ? { computerUseHelper } : {}),
    toolchain: {
      nodeVersion,
      nodeArchive,
      nodeArchiveSha256,
      postjectVersion,
      ...(arch === 'universal' ? { nodeArchives } : {}),
    },
    build: {
      commit: buildCommit.trim(),
      version: normalizedBuildVersion,
    },
  };
}

export async function writeNodeExeManifest(manifest, outputPath) {
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
}

function assertManifestShape(value, manifestPath) {
  const fail = (reason) => { throw new Error(`invalid controlled-node manifest ${manifestPath}: ${reason}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('root must be an object');
  if (value.schemaVersion !== NODE_EXE_MANIFEST_SCHEMA_VERSION) fail('unsupported schemaVersion');
  const artifact = value.artifact;
  const toolchain = value.toolchain;
  const build = value.build;
  const computerUseHelper = value.computerUseHelper;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) fail('artifact must be an object');
  if (typeof artifact.fileName !== 'string' || basename(artifact.fileName) !== artifact.fileName || artifact.fileName.length === 0) fail('artifact.fileName must be a basename');
  if (!SUPPORTED_PLATFORMS.has(artifact.os)) fail('artifact.os is unsupported');
  if (!SUPPORTED_ARCHES.has(artifact.arch)) fail('artifact.arch is unsupported');
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) fail('artifact.size must be a positive integer');
  if (typeof artifact.sha256 !== 'string' || !SHA256_RE.test(artifact.sha256)) fail('artifact.sha256 must be lowercase SHA-256 hex');
  if (artifact.authenticodeSignerSha256 !== undefined
    && (typeof artifact.authenticodeSignerSha256 !== 'string' || !SHA256_RE.test(artifact.authenticodeSignerSha256))) fail('artifact.authenticodeSignerSha256 is invalid');
  if (computerUseHelper !== undefined) {
    if (!computerUseHelper || typeof computerUseHelper !== 'object' || Array.isArray(computerUseHelper)) fail('computerUseHelper must be an object');
    if (typeof computerUseHelper.relativePath !== 'string' || computerUseHelper.relativePath.length === 0
      || computerUseHelper.relativePath.includes('\\')
      || computerUseHelper.relativePath.split('/').some((part) => !part || part === '.' || part === '..')) fail('computerUseHelper.relativePath is invalid');
    if (!Number.isSafeInteger(computerUseHelper.size) || computerUseHelper.size <= 0) fail('computerUseHelper.size is invalid');
    if (typeof computerUseHelper.sha256 !== 'string' || !SHA256_RE.test(computerUseHelper.sha256)) fail('computerUseHelper.sha256 is invalid');
    if (computerUseHelper.authenticodeSignerSha256 !== undefined
      && (typeof computerUseHelper.authenticodeSignerSha256 !== 'string' || !SHA256_RE.test(computerUseHelper.authenticodeSignerSha256))) fail('computerUseHelper.authenticodeSignerSha256 is invalid');
  }
  if (!toolchain || typeof toolchain !== 'object' || Array.isArray(toolchain)) fail('toolchain must be an object');
  if (typeof toolchain.nodeVersion !== 'string' || !/^v\d+\.\d+\.\d+$/.test(toolchain.nodeVersion)) fail('toolchain.nodeVersion is invalid');
  if (typeof toolchain.nodeArchive !== 'string' || basename(toolchain.nodeArchive) !== toolchain.nodeArchive || toolchain.nodeArchive.length === 0) fail('toolchain.nodeArchive is invalid');
  if (typeof toolchain.nodeArchiveSha256 !== 'string' || !SHA256_RE.test(toolchain.nodeArchiveSha256)) fail('toolchain.nodeArchiveSha256 is invalid');
  if (typeof toolchain.postjectVersion !== 'string' || toolchain.postjectVersion.length === 0) fail('toolchain.postjectVersion is invalid');
  if (artifact.arch === 'universal') {
    try {
      assertUniversalNodeArchives(toolchain.nodeArchives, manifestPath);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  if (!build || typeof build !== 'object' || Array.isArray(build) || typeof build.commit !== 'string' || !/^[a-f0-9]{7,64}$/.test(build.commit.trim())) fail('build.commit is invalid');
  if (typeof build.version !== 'string' || !BUILD_VERSION_RE.test(build.version.trim())) fail('build.version is invalid');
  return value;
}

export async function verifyNodeExeManifest(manifestPath, artifactDirectory) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read controlled-node manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = assertManifestShape(parsed, manifestPath);
  const artifactPath = join(artifactDirectory, manifest.artifact.fileName);
  const file = await stat(artifactPath).catch(() => null);
  if (!file?.isFile()) throw new Error(`controlled-node artifact is missing or not a regular file: ${artifactPath}`);
  if (file.size !== manifest.artifact.size) {
    throw new Error(`controlled-node artifact size mismatch for ${manifest.artifact.fileName}: expected ${manifest.artifact.size}, got ${file.size}`);
  }
  const actualSha256 = await sha256File(artifactPath);
  if (actualSha256 !== manifest.artifact.sha256) {
    throw new Error(`controlled-node artifact checksum mismatch for ${manifest.artifact.fileName}: expected ${manifest.artifact.sha256}, got ${actualSha256}`);
  }
  return manifest;
}

export async function verifyNodeExeManifestSet(artifactDirectory, expectedFileNames) {
  if (!Array.isArray(expectedFileNames) || expectedFileNames.length === 0) throw new Error('expected at least one controlled-node artifact');
  const seen = new Set();
  let expectedToolchain;
  let expectedCommit = process.env.GITHUB_SHA?.trim();
  let expectedVersion = process.env.IMCODES_BUILD_VERSION?.trim() || process.env.APP_VERSION?.trim();
  if (expectedVersion) expectedVersion = normalizeNodeExeBuildVersion(expectedVersion);
  for (const fileName of expectedFileNames) {
    if (basename(fileName) !== fileName || seen.has(fileName)) throw new Error(`invalid or duplicate expected artifact: ${fileName}`);
    seen.add(fileName);
    const manifestPath = join(artifactDirectory, `${fileName}${NODE_EXE_MANIFEST_SUFFIX}`);
    const manifest = await verifyNodeExeManifest(manifestPath, artifactDirectory);
    if (manifest.artifact.fileName !== fileName) throw new Error(`manifest ${manifestPath} describes ${manifest.artifact.fileName}, expected ${fileName}`);
    const expectedTarget = EXPECTED_TARGET_BY_ARTIFACT.get(fileName);
    if (expectedTarget && manifest.artifact.os !== expectedTarget.os) throw new Error(`controlled-node artifact OS mismatch for ${fileName}: expected ${expectedTarget.os}, got ${manifest.artifact.os}`);
    if (expectedTarget && manifest.artifact.arch !== expectedTarget.arch) throw new Error(`controlled-node artifact architecture mismatch for ${fileName}: expected ${expectedTarget.arch}, got ${manifest.artifact.arch}`);
    const toolchainKey = JSON.stringify({
      nodeVersion: manifest.toolchain.nodeVersion,
      postjectVersion: manifest.toolchain.postjectVersion,
    });
    expectedToolchain ??= toolchainKey;
    if (toolchainKey !== expectedToolchain) throw new Error(`controlled-node artifacts were built with inconsistent toolchains: ${fileName}`);
    expectedCommit ??= manifest.build.commit;
    if (manifest.build.commit !== expectedCommit) throw new Error(`controlled-node artifact commit mismatch for ${fileName}: expected ${expectedCommit}, got ${manifest.build.commit}`);
    expectedVersion ??= manifest.build.version;
    if (manifest.build.version !== expectedVersion) throw new Error(`controlled-node artifact version mismatch for ${fileName}: expected ${expectedVersion}, got ${manifest.build.version}`);
    const helperRelativePath = EXPECTED_HELPER_BY_ARTIFACT.get(fileName);
    if (helperRelativePath) {
      const helperPath = join(artifactDirectory, ...helperRelativePath);
      const helper = await stat(helperPath).catch(() => null);
      const expectedRelativePath = helperRelativePath.join('/');
      if (!helper?.isFile() || helper.size <= 0
        || manifest.computerUseHelper?.relativePath !== expectedRelativePath
        || manifest.computerUseHelper?.size !== helper.size
        || manifest.computerUseHelper?.sha256 !== await sha256File(helperPath)) {
        throw new Error(`controlled-node Computer Use helper is missing or empty for ${fileName}: ${helperPath}`);
      }
      if (manifest.artifact.os === 'win32') {
        const signer = manifest.artifact.authenticodeSignerSha256;
        if (!signer || manifest.computerUseHelper.authenticodeSignerSha256 !== signer) {
          throw new Error('Windows controlled-node executable and Computer Use helper do not share one Authenticode signer');
        }
      }
    }
  }
}

async function cli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'verify') {
    if (args.length !== 2) throw new Error('usage: node-exe-artifacts.mjs verify <manifest> <artifact-dir>');
    await verifyNodeExeManifest(args[0], args[1]);
    return;
  }
  if (command === 'verify-set') {
    if (args.length < 2) throw new Error('usage: node-exe-artifacts.mjs verify-set <artifact-dir> <artifact>...');
    await verifyNodeExeManifestSet(args[0], args.slice(1));
    return;
  }
  throw new Error('usage: node-exe-artifacts.mjs <verify|verify-set> ...');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  cli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
