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
const SUPPORTED_ARCHES = new Set(['x64', 'arm64']);
const EXPECTED_OS_BY_ARTIFACT = new Map([
  ['imcodes-node-linux', 'linux'],
  ['imcodes-node-macos', 'darwin'],
  ['imcodes-node.exe', 'win32'],
]);

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

export async function createNodeExeManifest({
  artifactPath,
  os,
  arch,
  nodeVersion,
  nodeArchive,
  nodeArchiveSha256,
  postjectVersion,
  buildCommit,
}) {
  if (!SUPPORTED_PLATFORMS.has(os)) throw new Error(`unsupported manifest os: ${os}`);
  if (!SUPPORTED_ARCHES.has(arch)) throw new Error(`unsupported manifest arch: ${arch}`);
  if (typeof nodeVersion !== 'string' || !/^v\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error('invalid Node version');
  if (typeof nodeArchive !== 'string' || basename(nodeArchive) !== nodeArchive || nodeArchive.length === 0) throw new Error('invalid Node archive');
  if (typeof nodeArchiveSha256 !== 'string' || !SHA256_RE.test(nodeArchiveSha256)) throw new Error('invalid Node archive SHA-256');
  if (typeof postjectVersion !== 'string' || postjectVersion.length === 0) throw new Error('invalid postject version');
  if (typeof buildCommit !== 'string' || !/^[a-f0-9]{7,64}$/.test(buildCommit.trim())) throw new Error('invalid build commit');

  const file = await stat(artifactPath);
  if (!file.isFile()) throw new Error(`artifact is not a regular file: ${artifactPath}`);
  return {
    schemaVersion: NODE_EXE_MANIFEST_SCHEMA_VERSION,
    artifact: {
      fileName: basename(artifactPath),
      os,
      arch,
      size: file.size,
      sha256: await sha256File(artifactPath),
    },
    toolchain: {
      nodeVersion,
      nodeArchive,
      nodeArchiveSha256,
      postjectVersion,
    },
    build: {
      commit: buildCommit.trim(),
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
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) fail('artifact must be an object');
  if (typeof artifact.fileName !== 'string' || basename(artifact.fileName) !== artifact.fileName || artifact.fileName.length === 0) fail('artifact.fileName must be a basename');
  if (!SUPPORTED_PLATFORMS.has(artifact.os)) fail('artifact.os is unsupported');
  if (!SUPPORTED_ARCHES.has(artifact.arch)) fail('artifact.arch is unsupported');
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) fail('artifact.size must be a positive integer');
  if (typeof artifact.sha256 !== 'string' || !SHA256_RE.test(artifact.sha256)) fail('artifact.sha256 must be lowercase SHA-256 hex');
  if (!toolchain || typeof toolchain !== 'object' || Array.isArray(toolchain)) fail('toolchain must be an object');
  if (typeof toolchain.nodeVersion !== 'string' || !/^v\d+\.\d+\.\d+$/.test(toolchain.nodeVersion)) fail('toolchain.nodeVersion is invalid');
  if (typeof toolchain.nodeArchive !== 'string' || basename(toolchain.nodeArchive) !== toolchain.nodeArchive || toolchain.nodeArchive.length === 0) fail('toolchain.nodeArchive is invalid');
  if (typeof toolchain.nodeArchiveSha256 !== 'string' || !SHA256_RE.test(toolchain.nodeArchiveSha256)) fail('toolchain.nodeArchiveSha256 is invalid');
  if (typeof toolchain.postjectVersion !== 'string' || toolchain.postjectVersion.length === 0) fail('toolchain.postjectVersion is invalid');
  if (!build || typeof build !== 'object' || Array.isArray(build) || typeof build.commit !== 'string' || !/^[a-f0-9]{7,64}$/.test(build.commit.trim())) fail('build.commit is invalid');
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
  for (const fileName of expectedFileNames) {
    if (basename(fileName) !== fileName || seen.has(fileName)) throw new Error(`invalid or duplicate expected artifact: ${fileName}`);
    seen.add(fileName);
    const manifestPath = join(artifactDirectory, `${fileName}${NODE_EXE_MANIFEST_SUFFIX}`);
    const manifest = await verifyNodeExeManifest(manifestPath, artifactDirectory);
    if (manifest.artifact.fileName !== fileName) throw new Error(`manifest ${manifestPath} describes ${manifest.artifact.fileName}, expected ${fileName}`);
    const expectedOs = EXPECTED_OS_BY_ARTIFACT.get(fileName);
    if (expectedOs && manifest.artifact.os !== expectedOs) throw new Error(`controlled-node artifact OS mismatch for ${fileName}: expected ${expectedOs}, got ${manifest.artifact.os}`);
    const toolchainKey = JSON.stringify({
      nodeVersion: manifest.toolchain.nodeVersion,
      postjectVersion: manifest.toolchain.postjectVersion,
    });
    expectedToolchain ??= toolchainKey;
    if (toolchainKey !== expectedToolchain) throw new Error(`controlled-node artifacts were built with inconsistent toolchains: ${fileName}`);
    expectedCommit ??= manifest.build.commit;
    if (manifest.build.commit !== expectedCommit) throw new Error(`controlled-node artifact commit mismatch for ${fileName}: expected ${expectedCommit}, got ${manifest.build.commit}`);
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
