import { mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  CAPABILITY_BLOB_ACTION,
  CAPABILITY_ERROR,
  CAPABILITY_SCOPE,
  CAPABILITY_STATE,
  type CapabilityBlobAccess,
  type CapabilitySyncBinding,
} from '../../shared/capability-management.js';
import { CapabilityBlobHttpError, type CapabilityBlobHttpClient } from './capability-blob-http-client.js';
import type {
  CapabilitySyncPreparedSkill,
  CapabilitySyncPublication,
  CapabilitySyncServiceOptions,
} from './capability-sync-service.js';
import {
  publishManagedSkillVersion,
  readManagedSkillIndex,
  updateManagedSkillEntry,
  verifyManagedSkillVersion,
  writeManagedSkillIndex,
  type ManagedSkillBinding,
  type ManagedSkillIndexEntry,
} from './managed-skill-store.js';
import {
  getManagedSkillManifestPath,
  getManagedSkillVersionPath,
} from './managed-skill-paths.js';
import { scanAgentSkillPackage } from './skill-scanner.js';
import { inventoryAgentSkillPackage } from './agent-skill-package.js';
import { extractSkillTransferArchive } from './skill-transfer-archive.js';
import { CapabilitySourceConvergenceStore } from './capability-source-convergence.js';

const SYNC_DOWNLOAD_DIRECTORY = 'capability-sync-downloads';

export interface CapabilitySyncRuntimeOptions {
  ownerId: string;
  serverId: string;
  homeDir?: string;
  blobClient: Pick<CapabilityBlobHttpClient, 'requestAccess' | 'download'>;
  convergenceStore?: Pick<CapabilitySourceConvergenceStore, 'retireSourceAfterAuthoritativePublish'>;
}

function managedBinding(binding: CapabilitySyncBinding, ownerId: string): ManagedSkillBinding {
  return {
    bindingId: binding.id,
    versionId: binding.versionId,
    scope: binding.scope,
    ownerId,
    ...(binding.scope === CAPABILITY_SCOPE.LOCAL && binding.scopeId ? { serverId: binding.scopeId } : {}),
    ...(binding.scope === CAPABILITY_SCOPE.PROJECT && binding.scopeId ? { projectId: binding.scopeId } : {}),
    ...(binding.scope === CAPABILITY_SCOPE.SESSION && binding.scopeId ? { sessionId: binding.scopeId } : {}),
    providers: [...binding.providers],
    machines: [...binding.machines],
    active: binding.active,
    ...(binding.authorization ? { authorization: structuredClone(binding.authorization) } : {}),
  };
}

function restoreRegistryEntry(
  homeDir: string,
  registryId: string,
  versionId: string,
  previous: ManagedSkillIndexEntry | undefined,
): void {
  const current = readManagedSkillIndex(homeDir);
  const published = current.entries.find((entry) => entry.registryId === registryId);
  if (!published || published.activeVersionId !== versionId || !published.versions.includes(versionId)) {
    throw new Error('Managed Skill changed after synchronization; automatic rollback refused');
  }
  rmSync(getManagedSkillVersionPath(homeDir, registryId, versionId), { recursive: true, force: true });
  rmSync(getManagedSkillManifestPath(homeDir, registryId, versionId), { force: true });
  writeManagedSkillIndex({
    ...current,
    revision: current.revision + 1,
    entries: [
      ...current.entries.filter((entry) => entry.registryId !== registryId),
      ...(previous ? [previous] : []),
    ].sort((left, right) => left.registryId < right.registryId ? -1 : left.registryId > right.registryId ? 1 : 0),
  }, homeDir);
}

export class CapabilitySyncRuntime {
  private readonly homeDir: string;
  private readonly convergenceStore: Pick<CapabilitySourceConvergenceStore, 'retireSourceAfterAuthoritativePublish'>;

  constructor(private readonly options: CapabilitySyncRuntimeOptions) {
    this.homeDir = options.homeDir ?? homedir();
    this.convergenceStore = options.convergenceStore ?? new CapabilitySourceConvergenceStore(this.homeDir);
  }

  readonly loadSkillContent: NonNullable<CapabilitySyncServiceOptions['loadSkillContent']> = async ({ capability, version }) => {
    if (!version.blobDigest || !version.blobByteSize) return { status: 'missing' };
    let access: CapabilityBlobAccess;
    try {
      access = await this.options.blobClient.requestAccess(
        capability.id,
        version.id,
        CAPABILITY_BLOB_ACTION.DOWNLOAD,
      );
    } catch (error) {
      if (error instanceof CapabilityBlobHttpError
        && (error.code === CAPABILITY_ERROR.RUNTIME_PENDING || error.code === CAPABILITY_ERROR.NOT_FOUND)) {
        return { status: 'missing' };
      }
      throw error;
    }
    if (access.blobDigest !== version.blobDigest || access.maxBytes !== version.blobByteSize) {
      throw new CapabilityBlobHttpError(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Capability blob grant does not match authoritative metadata');
    }
    const root = join(this.homeDir, '.imcodes', SYNC_DOWNLOAD_DIRECTORY);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(root, 'blob-'));
    const destination = join(temporary, 'package');
    try {
      const blob = await this.options.blobClient.download(access);
      extractSkillTransferArchive({
        bytes: blob,
        blobDigest: version.blobDigest,
        treeDigest: version.artifactDigest,
        destination,
      });
      return {
        status: 'available',
        blob,
        sourceDirectory: destination,
        cleanup: async () => { await rm(temporary, { recursive: true, force: true }); },
      };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (error instanceof CapabilityBlobHttpError
        && (error.code === CAPABILITY_ERROR.RUNTIME_PENDING || error.code === CAPABILITY_ERROR.NOT_FOUND)) {
        return { status: 'missing' };
      }
      throw error;
    }
  };

  readonly publishSkill: NonNullable<CapabilitySyncServiceOptions['publishSkill']> = async (
    input: CapabilitySyncPreparedSkill,
  ): Promise<CapabilitySyncPublication> => {
    const before = readManagedSkillIndex(this.homeDir);
    const previous = before.entries.find((entry) => entry.registryId === input.capability.id);
    const scan = scanAgentSkillPackage(inventoryAgentSkillPackage(input.stagingDirectory));
    publishManagedSkillVersion({
      registryId: input.capability.id,
      versionId: input.version.id,
      quarantinePath: input.stagingDirectory,
      source: `account-sync:${input.version.sourceKind}`,
      scannerDigest: scan.scannerDigest,
      auditDigest: input.version.auditDigest,
      auditPolicyVersion: 'account-sync-v1',
      // Publication installs immutable bytes first. Signed current bindings
      // are written only by reconcileSkill together with their exact item
      // authority revision, so the strict index codec never observes a mixed
      // old-revision/new-envelope state.
      bindings: input.bindings.map((binding) => {
        const candidate = managedBinding(binding, this.options.ownerId);
        delete candidate.authorization;
        return candidate;
      }),
    }, this.homeDir);
    const retired = this.convergenceStore.retireSourceAfterAuthoritativePublish({
      ownerId: this.options.ownerId,
      authoritativeCapabilityId: input.capability.id,
      authoritativeVersionId: input.version.id,
      artifactDigest: input.version.artifactDigest,
      auditDigest: input.version.auditDigest,
    });
    return {
      rollback: async () => {
        await retired?.rollback();
        restoreRegistryEntry(
          this.homeDir,
          input.capability.id,
          input.version.id,
          previous ? structuredClone(previous) : undefined,
        );
      },
    };
  };

  readonly reconcileSkill: NonNullable<CapabilitySyncServiceOptions['reconcileSkill']> = async (input) => {
    const previous = readManagedSkillIndex(this.homeDir).entries.find((entry) => entry.registryId === input.capability.id);
    const localBindings = (previous?.bindings ?? []).filter((binding) => binding.scope === CAPABILITY_SCOPE.LOCAL);
    const synchronizedBindings = input.bindings.map((binding) => managedBinding(binding, this.options.ownerId));
    const synchronizedIds = new Set(synchronizedBindings.map((binding) => binding.bindingId));
    if (localBindings.some((binding) => synchronizedIds.has(binding.bindingId))) {
      throw new Error('Synchronized binding collides with a machine-local binding');
    }
    const bindings = [...localBindings.map((binding) => structuredClone(binding)), ...synchronizedBindings];
    const requiredVersionIds = [...new Set(bindings.flatMap((binding) => binding.versionId ? [binding.versionId] : []))];
    if (!previous || !requiredVersionIds.every((versionId) => previous.versions.includes(versionId))) {
      throw new Error('Verified managed Skill index entry is unavailable');
    }
    for (const versionId of requiredVersionIds) verifyManagedSkillVersion(this.homeDir, input.capability.id, versionId);
    const snapshot = structuredClone(previous);
    const versionBindings = { ...(previous.versionBindings ?? {}) };
    for (const versionId of requiredVersionIds) {
      versionBindings[versionId] = structuredClone(bindings.filter((binding) => binding.versionId === versionId));
    }
    updateManagedSkillEntry(input.capability.id, (entry) => {
      const next = {
        ...entry,
        activeVersionId: input.version.id,
        bindings,
        versionBindings,
        state: bindings.some((binding) => binding.active !== false && binding.removed !== true)
          ? CAPABILITY_STATE.ACTIVE : CAPABILITY_STATE.DISABLED,
        authorityRevision: input.capability.revision,
        revision: entry.revision + 1,
        updatedAt: Date.now(),
      };
      return next;
    }, this.homeDir);
    const retired = this.convergenceStore.retireSourceAfterAuthoritativePublish({
      ownerId: this.options.ownerId,
      authoritativeCapabilityId: input.capability.id,
      authoritativeVersionId: input.version.id,
      artifactDigest: input.version.artifactDigest,
      auditDigest: input.version.auditDigest,
    });
    return {
      rollback: async () => {
        await retired?.rollback();
        updateManagedSkillEntry(input.capability.id, (current) => {
          if (current.authorityRevision !== input.capability.revision) {
            throw new Error('Managed Skill changed after binding reconciliation; automatic rollback refused');
          }
          return snapshot;
        }, this.homeDir);
      },
    };
  };
}

export function createCapabilitySyncRuntime(options: CapabilitySyncRuntimeOptions): CapabilitySyncRuntime {
  return new CapabilitySyncRuntime(options);
}

export const CAPABILITY_SYNC_RUNTIME_TESTING = {
  managedBinding,
  restoreRegistryEntry,
};
