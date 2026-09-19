import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CAPABILITY_LIMITS } from '../../shared/capability-management.js';
import {
  readManagedSkillIndex,
  verifyManagedSkillVersion,
  writeManagedSkillIndex,
  type ManagedSkillIndexEntry,
} from './managed-skill-store.js';
import { assertOpaqueCapabilityId } from './managed-skill-paths.js';
import type { CapabilitySyncPublication } from './capability-sync-service.js';

const CONVERGENCE_SCHEMA_VERSION = 1 as const;
const CONVERGENCE_DIRECTORY = 'capability-convergence';
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export interface CapabilitySourceConvergenceRecord {
  schemaVersion: typeof CONVERGENCE_SCHEMA_VERSION;
  ownerId: string;
  operationId: string;
  localRegistryId: string;
  localVersionId: string;
  authoritativeCapabilityId: string;
  authoritativeVersionId: string;
  artifactDigest: string;
  auditDigest: string;
  blobDigest: string;
  blobByteSize: number;
  createdAt: number;
}

export interface RecordCapabilitySourceUploadInput extends Omit<CapabilitySourceConvergenceRecord, 'schemaVersion' | 'createdAt'> {
  createdAt?: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function bounded(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= CAPABILITY_LIMITS.SOURCE_CHARS;
}

function validateRecord(value: unknown): CapabilitySourceConvergenceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid capability convergence record');
  const record = value as CapabilitySourceConvergenceRecord;
  if (record.schemaVersion !== CONVERGENCE_SCHEMA_VERSION
    || !bounded(record.ownerId)
    || !bounded(record.operationId)
    || !DIGEST_PATTERN.test(record.artifactDigest)
    || !DIGEST_PATTERN.test(record.auditDigest)
    || !DIGEST_PATTERN.test(record.blobDigest)
    || !Number.isSafeInteger(record.blobByteSize)
    || record.blobByteSize < 1
    || record.blobByteSize > CAPABILITY_LIMITS.PACKAGE_BYTES
    || !Number.isSafeInteger(record.createdAt)
    || record.createdAt < 0) throw new Error('Invalid capability convergence record');
  assertOpaqueCapabilityId(record.localRegistryId, 'local registry ID');
  assertOpaqueCapabilityId(record.localVersionId, 'local version ID');
  assertOpaqueCapabilityId(record.authoritativeCapabilityId, 'authoritative registry ID');
  assertOpaqueCapabilityId(record.authoritativeVersionId, 'authoritative version ID');
  return record;
}

function atomicWrite(path: string, value: CapabilitySourceConvergenceRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export class CapabilitySourceConvergenceStore {
  private readonly homeDir: string;

  constructor(homeDir = homedir()) {
    this.homeDir = homeDir;
  }

  recordUpload(input: RecordCapabilitySourceUploadInput): void {
    const record = validateRecord({
      ...input,
      schemaVersion: CONVERGENCE_SCHEMA_VERSION,
      createdAt: input.createdAt ?? Date.now(),
    });
    if (record.localRegistryId === record.authoritativeCapabilityId
      && record.localVersionId === record.authoritativeVersionId) return;
    atomicWrite(this.pathFor(record.ownerId, record.authoritativeCapabilityId, record.authoritativeVersionId), record);
  }

  retireSourceAfterAuthoritativePublish(input: {
    ownerId: string;
    authoritativeCapabilityId: string;
    authoritativeVersionId: string;
    artifactDigest: string;
    auditDigest: string;
  }): CapabilitySyncPublication | null {
    const path = this.pathFor(input.ownerId, input.authoritativeCapabilityId, input.authoritativeVersionId);
    if (!existsSync(path)) return null;
    let record: CapabilitySourceConvergenceRecord;
    try {
      record = validateRecord(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return null;
    }
    if (record.ownerId !== input.ownerId
      || record.authoritativeCapabilityId !== input.authoritativeCapabilityId
      || record.authoritativeVersionId !== input.authoritativeVersionId
      || record.artifactDigest !== input.artifactDigest
      || record.auditDigest !== input.auditDigest) return null;
    const index = readManagedSkillIndex(this.homeDir);
    const local = index.entries.find((entry) => entry.registryId === record.localRegistryId);
    const authoritative = index.entries.find((entry) => entry.registryId === record.authoritativeCapabilityId);
    if (!local
      || !authoritative
      || authoritative.activeVersionId !== record.authoritativeVersionId
      || local.activeVersionId !== record.localVersionId
      || !local.bindings.some((binding) => binding.ownerId === input.ownerId)) return null;
    let manifest;
    try {
      manifest = verifyManagedSkillVersion(this.homeDir, record.localRegistryId, record.localVersionId);
    } catch {
      return null;
    }
    if (manifest.treeDigest !== record.artifactDigest || manifest.auditDigest !== record.auditDigest) return null;
    const localSnapshot = structuredClone(local) as ManagedSkillIndexEntry;
    writeManagedSkillIndex({
      ...index,
      revision: index.revision + 1,
      entries: index.entries.filter((entry) => entry.registryId !== record.localRegistryId),
    }, this.homeDir);
    rmSync(path, { force: true });
    return {
      rollback: () => {
        const current = readManagedSkillIndex(this.homeDir);
        if (current.entries.some((entry) => entry.registryId === record.localRegistryId)) {
          throw new Error('Local source Skill identity was reused; convergence rollback refused');
        }
        writeManagedSkillIndex({
          ...current,
          revision: current.revision + 1,
          entries: [...current.entries, localSnapshot]
            .sort((left, right) => left.registryId < right.registryId ? -1 : left.registryId > right.registryId ? 1 : 0),
        }, this.homeDir);
        atomicWrite(path, record);
      },
    };
  }

  private pathFor(ownerId: string, capabilityId: string, versionId: string): string {
    if (!bounded(ownerId)) throw new Error('Invalid capability convergence owner');
    assertOpaqueCapabilityId(capabilityId, 'authoritative registry ID');
    assertOpaqueCapabilityId(versionId, 'authoritative version ID');
    return join(
      this.homeDir,
      '.imcodes',
      CONVERGENCE_DIRECTORY,
      sha256(ownerId),
      `${sha256(`${capabilityId}\0${versionId}`)}.json`,
    );
  }
}

export const CAPABILITY_SOURCE_CONVERGENCE_TESTING = {
  convergenceDirectory: CONVERGENCE_DIRECTORY,
  validateRecord,
};
