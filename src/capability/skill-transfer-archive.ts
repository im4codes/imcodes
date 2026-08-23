import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { CAPABILITY_LIMITS } from '../../shared/capability-management.js';
import {
  inventoryAgentSkillPackage,
  type AgentSkillPackageFile,
} from './agent-skill-package.js';
import {
  getManagedSkillVersionPath,
} from './managed-skill-paths.js';
import { verifyManagedSkillVersion } from './managed-skill-store.js';

const TRANSFER_MAGIC = Buffer.from('IMCODES_SKILL_BLOB_V1\n', 'ascii');
const TRANSFER_SCHEMA_VERSION = 1 as const;
const MAX_HEADER_BYTES = 256 * 1024;

interface SkillTransferManifest {
  schemaVersion: typeof TRANSFER_SCHEMA_VERSION;
  treeDigest: string;
  files: AgentSkillPackageFile[];
}

export interface SkillTransferArchive {
  bytes: Buffer;
  blobDigest: string;
  blobByteSize: number;
  treeDigest: string;
}

export type SkillTransferArchiveErrorCode =
  | 'blob_too_large'
  | 'blob_digest_mismatch'
  | 'tree_digest_mismatch'
  | 'invalid_archive'
  | 'invalid_path'
  | 'destination_exists';

export class SkillTransferArchiveError extends Error {
  constructor(readonly code: SkillTransferArchiveErrorCode) {
    super(code);
    this.name = 'SkillTransferArchiveError';
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeRelativePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.includes(':') || isAbsolute(value)) {
    throw new SkillTransferArchiveError('invalid_path');
  }
  const normalized = normalize(value).split('\\').join('/');
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')
    || normalized.split('/').includes('..') || normalized.split('/').length - 1 > CAPABILITY_LIMITS.TREE_DEPTH) {
    throw new SkillTransferArchiveError('invalid_path');
  }
  return normalized;
}

function parseManifest(value: unknown): SkillTransferManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SkillTransferArchiveError('invalid_archive');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['schemaVersion', 'treeDigest', 'files'].includes(key))
    || record.schemaVersion !== TRANSFER_SCHEMA_VERSION
    || typeof record.treeDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.treeDigest)
    || !Array.isArray(record.files)
    || record.files.length === 0
    || record.files.length > CAPABILITY_LIMITS.FILE_COUNT) throw new SkillTransferArchiveError('invalid_archive');
  const folded = new Set<string>();
  let totalBytes = 0;
  const files = record.files.map((value): AgentSkillPackageFile => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SkillTransferArchiveError('invalid_archive');
    const file = value as Record<string, unknown>;
    if (Object.keys(file).some((key) => !['path', 'size', 'sha256', 'executable'].includes(key))) {
      throw new SkillTransferArchiveError('invalid_archive');
    }
    const path = safeRelativePath(String(file.path ?? ''));
    const foldedPath = path.normalize('NFKC').toLocaleLowerCase('en-US');
    if (folded.has(foldedPath)) throw new SkillTransferArchiveError('invalid_path');
    folded.add(foldedPath);
    if (!Number.isSafeInteger(file.size) || Number(file.size) < 0 || Number(file.size) > CAPABILITY_LIMITS.FILE_BYTES
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
      || typeof file.executable !== 'boolean') throw new SkillTransferArchiveError('invalid_archive');
    totalBytes += Number(file.size);
    if (totalBytes > CAPABILITY_LIMITS.PACKAGE_BYTES) throw new SkillTransferArchiveError('blob_too_large');
    return { path, size: Number(file.size), sha256: file.sha256, executable: file.executable };
  });
  if (files.some((file, index) => index > 0 && codepointCompare(files[index - 1].path, file.path) >= 0)) {
    throw new SkillTransferArchiveError('invalid_archive');
  }
  return { schemaVersion: TRANSFER_SCHEMA_VERSION, treeDigest: record.treeDigest, files };
}

export function buildSkillTransferArchive(packageRootInput: string, expectedTreeDigest?: string): SkillTransferArchive {
  const packageRoot = resolve(packageRootInput);
  const inventory = inventoryAgentSkillPackage(packageRoot);
  if (expectedTreeDigest && inventory.treeDigest !== expectedTreeDigest) throw new SkillTransferArchiveError('tree_digest_mismatch');
  const manifest: SkillTransferManifest = {
    schemaVersion: TRANSFER_SCHEMA_VERSION,
    treeDigest: inventory.treeDigest,
    files: inventory.files.map((file) => ({ ...file })),
  };
  const header = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (header.length > MAX_HEADER_BYTES) throw new SkillTransferArchiveError('blob_too_large');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(header.length);
  const fileBuffers = inventory.files.map((file) => {
    const path = join(packageRoot, safeRelativePath(file.path));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size !== file.size) {
      throw new SkillTransferArchiveError('invalid_archive');
    }
    const bytes = readFileSync(path);
    if (sha256(bytes) !== file.sha256) throw new SkillTransferArchiveError('tree_digest_mismatch');
    return bytes;
  });
  const bytes = Buffer.concat([TRANSFER_MAGIC, length, header, ...fileBuffers]);
  if (bytes.length > CAPABILITY_LIMITS.PACKAGE_BYTES) throw new SkillTransferArchiveError('blob_too_large');
  return { bytes, blobDigest: sha256(bytes), blobByteSize: bytes.length, treeDigest: inventory.treeDigest };
}

export function buildManagedSkillTransferArchive(
  homeDir: string,
  registryId: string,
  versionId: string,
): SkillTransferArchive {
  const manifest = verifyManagedSkillVersion(homeDir, registryId, versionId);
  return buildSkillTransferArchive(getManagedSkillVersionPath(homeDir, registryId, versionId), manifest.treeDigest);
}

export function extractSkillTransferArchive(input: {
  bytes: Buffer;
  blobDigest: string;
  treeDigest: string;
  destination: string;
}): void {
  if (input.bytes.length > CAPABILITY_LIMITS.PACKAGE_BYTES) throw new SkillTransferArchiveError('blob_too_large');
  if (sha256(input.bytes) !== input.blobDigest) throw new SkillTransferArchiveError('blob_digest_mismatch');
  if (!input.bytes.subarray(0, TRANSFER_MAGIC.length).equals(TRANSFER_MAGIC)
    || input.bytes.length < TRANSFER_MAGIC.length + 4) throw new SkillTransferArchiveError('invalid_archive');
  const headerLength = input.bytes.readUInt32BE(TRANSFER_MAGIC.length);
  const headerStart = TRANSFER_MAGIC.length + 4;
  const headerEnd = headerStart + headerLength;
  if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES || headerEnd > input.bytes.length) {
    throw new SkillTransferArchiveError('invalid_archive');
  }
  let decoded: unknown;
  try { decoded = JSON.parse(input.bytes.subarray(headerStart, headerEnd).toString('utf8')); }
  catch { throw new SkillTransferArchiveError('invalid_archive'); }
  const manifest = parseManifest(decoded);
  if (manifest.treeDigest !== input.treeDigest) throw new SkillTransferArchiveError('tree_digest_mismatch');
  const destination = resolve(input.destination);
  if (existsSync(destination)) throw new SkillTransferArchiveError('destination_exists');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  mkdirSync(temporary, { mode: 0o700 });
  let offset = headerEnd;
  try {
    for (const file of manifest.files) {
      const target = resolve(temporary, safeRelativePath(file.path));
      const rel = relative(temporary, target);
      if (rel.startsWith('..') || isAbsolute(rel) || offset + file.size > input.bytes.length) {
        throw new SkillTransferArchiveError('invalid_archive');
      }
      const bytes = input.bytes.subarray(offset, offset + file.size);
      offset += file.size;
      if (sha256(bytes) !== file.sha256) throw new SkillTransferArchiveError('blob_digest_mismatch');
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: file.executable ? 0o700 : 0o600, flag: 'wx' });
    }
    if (offset !== input.bytes.length) throw new SkillTransferArchiveError('invalid_archive');
    const inventory = inventoryAgentSkillPackage(temporary);
    if (inventory.treeDigest !== manifest.treeDigest || inventory.treeDigest !== input.treeDigest) {
      throw new SkillTransferArchiveError('tree_digest_mismatch');
    }
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export const SKILL_TRANSFER_ARCHIVE_TESTING = {
  magic: TRANSFER_MAGIC,
  parseManifest,
};
