#!/usr/bin/env node
/**
 * Writes and checks the manifest of a built native aiDesk window (shared/aidesk-local-ui-artifact.ts is the node-side contract).
 *
 *   node scripts/aidesk-ui-artifact.mjs write  <dir> <os> <arch> <version> [signerSha256]
 *   node scripts/aidesk-ui-artifact.mjs verify <dir> <os> <arch> [version]
 *
 * `write` hashes the executable in <dir> AS IT NOW IS (so on Windows run it after signing) and records it; `verify` re-reads both and
 * fails on any mismatch. The constants below are mirrored from the shared TypeScript module (test/node/aidesk-local-ui-artifact.test.ts
 * asserts they match and that a manifest written here passes the TypeScript validator).
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AIDESK_LOCAL_UI_MANIFEST_FILENAME = 'aidesk-local-ui.manifest.json';
export const AIDESK_LOCAL_UI_MANIFEST_SCHEMA_VERSION = 1;
export const AIDESK_LOCAL_UI_NOTICES_FILENAME = 'THIRD-PARTY-NOTICES.txt';
const EXECUTABLE_BASE_NAME = 'aidesk-local-ui';
const OS = ['win32', 'darwin', 'linux'];
const ARCH = ['x64', 'arm64'];
const SHA256_RE = /^[a-f0-9]{64}$/u;

export function executableFileName(os) { return os === 'win32' ? `${EXECUTABLE_BASE_NAME}.exe` : EXECUTABLE_BASE_NAME; }

function checkTarget(os, arch) {
  if (!OS.includes(os) || !ARCH.includes(arch)) throw new Error(`invalid target: ${os} ${arch}`);
}

export function buildManifest({ dir, os, arch, version, signerSha256 }) {
  checkTarget(os, arch);
  const path = join(dir, executableFileName(os));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path} is not a regular file`);
  if (os === 'win32' && !(typeof signerSha256 === 'string' && SHA256_RE.test(signerSha256))) throw new Error('a Windows executable needs the sha256 of its signer');
  return {
    schemaVersion: AIDESK_LOCAL_UI_MANIFEST_SCHEMA_VERSION,
    artifact: executableFileName(os),
    os,
    arch,
    version,
    size: stat.size,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    ...(os === 'win32' ? { signerSha256 } : {}),
  };
}

export function writeManifest(input) {
  const manifest = buildManifest(input);
  writeFileSync(join(input.dir, AIDESK_LOCAL_UI_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function verifyManifest({ dir, os, arch, version }) {
  checkTarget(os, arch);
  const manifest = JSON.parse(readFileSync(join(dir, AIDESK_LOCAL_UI_MANIFEST_FILENAME), 'utf8'));
  const actual = buildManifest({ dir, os, arch, version: manifest.version, signerSha256: manifest.signerSha256 });
  if (JSON.stringify(actual) !== JSON.stringify(manifest)) throw new Error('aidesk-local-ui manifest does not match the executable');
  if (version !== undefined && manifest.version !== version) throw new Error(`aidesk-local-ui version ${manifest.version} is not ${version}`);
  return manifest;
}

if (process.argv[1] && process.argv[1].endsWith('aidesk-ui-artifact.mjs')) {
  const [, , command, dir, os, arch, extra, signer] = process.argv;
  try {
    if (command === 'write' && dir && os && arch && extra) {
      const manifest = writeManifest({ dir, os, arch, version: extra, signerSha256: signer });
      process.stdout.write(`${JSON.stringify(manifest)}\n`);
    } else if (command === 'verify' && dir && os && arch) {
      process.stdout.write(`${JSON.stringify(verifyManifest({ dir, os, arch, version: extra }))}\n`);
    } else {
      process.stderr.write('usage: aidesk-ui-artifact.mjs write <dir> <os> <arch> <version> [signerSha256] | verify <dir> <os> <arch> [version]\n');
      process.exit(2);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
