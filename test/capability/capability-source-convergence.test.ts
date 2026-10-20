import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_AUDIT_VERDICT,
  CAPABILITY_BLOB_ACTION,
  CAPABILITY_CONFIRMATION_DECISION,
  CAPABILITY_KIND,
  CAPABILITY_OPERATION_MSG,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  CAPABILITY_SYNC_MSG,
  computeCapabilitySyncDigest,
  type CapabilityBlobAccess,
  type CapabilityOperationActivateFrame,
  type CapabilityOperationProgressFrame,
  type CapabilitySummary,
  type CapabilitySyncBinding,
  type CapabilitySyncAuthorityFrame,
  type CapabilitySyncDigestFrame,
  type CapabilitySyncSnapshot,
  type CapabilityVersion,
} from '../../shared/capability-management.js';
import { CapabilityOperationHandler } from '../../src/capability/capability-operation-handler.js';
import { createDefaultCapabilityService } from '../../src/capability/capability-service-adapter.js';
import { CapabilitySourceConvergenceStore } from '../../src/capability/capability-source-convergence.js';
import { CapabilitySyncRuntime } from '../../src/capability/capability-sync-runtime.js';
import { CapabilitySyncService } from '../../src/capability/capability-sync-service.js';
import { publishManagedSkillVersion, readManagedSkillIndex } from '../../src/capability/managed-skill-store.js';
import { inventoryAgentSkillPackage } from '../../src/capability/agent-skill-package.js';
import { scanAgentSkillPackage } from '../../src/capability/skill-scanner.js';
import { resolveSkillByKey } from '../../src/context/skill-resolver.js';
import { signedSyncBinding, TEST_CAPABILITY_AUTHORIZATION_KEY } from './capability-authorization-fixture.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function signed<T extends CapabilitySyncDigestFrame>(frame: Omit<T, 'digest'>): T {
  const draft = { ...frame, digest: sha256('placeholder') } as T;
  return { ...draft, digest: computeCapabilitySyncDigest(draft, sha256) };
}

describe('source daemon identity convergence', () => {
  let homeDir: string | undefined;
  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
    homeDir = undefined;
  });

  it('converges install, confirmation, upload, and authoritative snapshot to one Registry entry', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-convergence-home-'));
    const convergenceStore = new CapabilitySourceConvergenceStore(homeDir);
    const sent: Array<CapabilityOperationProgressFrame | CapabilityOperationActivateFrame> = [];
    let uploaded = Buffer.alloc(0);
    const handler = new CapabilityOperationHandler({
      homeDir,
      isFullDaemon: true,
      serverId: 'server-1',
      serviceForOwner: (ownerId) => createDefaultCapabilityService({
        ownerId,
        conversationIdentity: 'source-install',
        homeDir,
        auditRunner: {
          identity: 'isolated-auditor',
          async audit(envelope) {
            return { verdict: CAPABILITY_AUDIT_VERDICT.PASS, artifactDigest: envelope.artifactDigest, scannerDigest: envelope.scannerDigest, findings: [], model: 'test' };
          },
        },
      }),
      send: (frame) => { sent.push(frame); },
      blobClient: { upload: vi.fn(async (_access, bytes) => { uploaded = Buffer.from(bytes); }) },
      convergenceStore,
    });
    await handler.handle({
      type: CAPABILITY_OPERATION_MSG.INSTALL,
      operationId: 'external-operation',
      revision: 1,
      ownerId: 'owner-1',
      request: {
        kind: CAPABILITY_KIND.SKILL,
        source: { kind: CAPABILITY_SOURCE_KIND.INLINE, inlineFiles: {
          'SKILL.md': '---\nname: converged-skill\ndescription: Converged Skill.\n---\nSafe instructions.\n',
        } },
        scope: CAPABILITY_SCOPE.ACCOUNT,
        providers: ['codex-sdk'],
        machines: ['server-1'],
        idempotencyKey: 'convergence-install',
      },
    });
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ state: 'awaiting_confirmation' }));
    const progress = sent.at(-1) as CapabilityOperationProgressFrame;
    await handler.handle({
      type: CAPABILITY_OPERATION_MSG.CONFIRM,
      operationId: 'external-operation', expectedRevision: 6,
      decision: CAPABILITY_CONFIRMATION_DECISION.INSTALL,
      artifactDigest: progress.artifactDigest!, auditDigest: progress.auditDigest!,
      scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: ['server-1'],
    });
    const localActivation = sent.at(-1) as CapabilityOperationActivateFrame;
    expect(readManagedSkillIndex(homeDir).entries).toHaveLength(0);
    expect(localActivation.capability.id).not.toBe('authoritative-skill');

    const uploadAccess: CapabilityBlobAccess = {
      action: CAPABILITY_BLOB_ACTION.UPLOAD,
      capabilityId: 'authoritative-skill', versionId: 'authoritative-version',
      blobDigest: localActivation.version.blobDigest!, maxBytes: localActivation.version.blobByteSize!,
      expiresAt: Date.now() + 60_000, singleUseToken: 'authority-upload-grant',
    };
    await handler.handle({
      type: CAPABILITY_SYNC_MSG.BLOB_CAPABILITY,
      operationId: 'external-operation',
      access: uploadAccess,
    });
    expect(uploaded.byteLength).toBe(uploadAccess.maxBytes);

    const capability: CapabilitySummary = {
      id: uploadAccess.capabilityId, revision: 1, kind: CAPABILITY_KIND.SKILL, name: 'converged-skill',
      state: CAPABILITY_STATE.ACTIVE, scope: CAPABILITY_SCOPE.ACCOUNT,
      versionId: uploadAccess.versionId, version: 1, artifactDigest: progress.artifactDigest,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE, sourceLabel: 'account-sync',
      readiness: CAPABILITY_READINESS.CONTENT_MISSING, findings: [], updatedAt: 100,
    };
    const version: CapabilityVersion = {
      id: uploadAccess.versionId, capabilityId: capability.id, version: 1,
      artifactDigest: progress.artifactDigest!, blobDigest: uploadAccess.blobDigest, blobByteSize: uploadAccess.maxBytes,
      auditDigest: progress.auditDigest!, auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE, createdAt: 100,
    };
    const binding = signedSyncBinding({ ownerId: 'owner-1', capabilityId: capability.id, version, issuedRevision: 1, binding: {
      id: 'authority-binding', capabilityId: capability.id, versionId: version.id,
      scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: ['server-1'], active: true,
    } });
    await handler.handle({
      type: CAPABILITY_OPERATION_MSG.AUTHORIZE,
      operationId: 'external-operation', expectedRevision: 7,
      capability: { ...capability, state: CAPABILITY_STATE.PENDING, bindings: [binding] },
      version, binding, authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY], expiresAt: Date.now() + 60_000,
    });
    expect(sent.at(-1)).toMatchObject({ type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT, ok: true });
    expect(readManagedSkillIndex(homeDir).entries).toHaveLength(1);
    const downloadAccess = { ...uploadAccess, action: CAPABILITY_BLOB_ACTION.DOWNLOAD, singleUseToken: 'authority-download-grant' } as const;
    const runtime = new CapabilitySyncRuntime({
      ownerId: 'owner-1', serverId: 'server-1', homeDir, convergenceStore,
      blobClient: {
        requestAccess: vi.fn(async () => downloadAccess),
        download: vi.fn(async () => Buffer.from(uploaded)),
      },
    });
    const sync = new CapabilitySyncService({
      ownerId: 'owner-1', serverId: 'server-1', homeDir,
      loadSkillContent: runtime.loadSkillContent,
      publishSkill: runtime.publishSkill,
      reconcileSkill: runtime.reconcileSkill,
    });
    await sync.apply(signed<CapabilitySyncSnapshot>({
      type: CAPABILITY_SYNC_MSG.SNAPSHOT, ownerId: 'owner-1', revision: 1,
      items: [capability], versions: [version], bindings: [binding], tombstones: [],
      authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    }));
    const authorization = binding.authorization!;
    await sync.apply(signed<CapabilitySyncAuthorityFrame>({
      type: CAPABILITY_SYNC_MSG.AUTHORITY, ownerId: 'owner-1', serverId: 'server-1', revision: 1,
      records: [{
        capabilityId: capability.id, versionId: version.id, bindingId: binding.id,
        state: authorization.bindingState, itemRevision: authorization.itemRevision,
        bindingRevision: authorization.bindingRevision, authorization,
      }],
      authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    }));

    const index = readManagedSkillIndex(homeDir);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]).toMatchObject({ registryId: capability.id, activeVersionId: version.id, name: 'converged-skill' });
    expect(resolveSkillByKey({
      namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' }, key: capability.id, homeDir,
      providerId: 'codex-sdk', serverId: 'server-1',
    })).toMatchObject({ ok: true });
  });

  it('never retires a local entry for a mismatched owner or reviewed digest', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-convergence-mismatch-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-convergence-source-'));
    await writeFile(join(source, 'SKILL.md'), '---\nname: same-name\ndescription: Same name is not authority.\n---\nSafe.\n');
    try {
      const inventory = inventoryAgentSkillPackage(source);
      const scannerDigest = scanAgentSkillPackage(inventory).scannerDigest;
      const auditDigest = sha256('exact-audit');
      for (const [registryId, versionId] of [['local-entry', 'local-version'], ['authority-entry', 'authority-version']] as const) {
        publishManagedSkillVersion({
          registryId, versionId, quarantinePath: source, source: 'test', scannerDigest,
          auditDigest, auditPolicyVersion: 'test-v1',
          bindings: [{ scope: CAPABILITY_SCOPE.ACCOUNT, ownerId: 'owner-1' }],
        }, homeDir);
      }
      const store = new CapabilitySourceConvergenceStore(homeDir);
      store.recordUpload({
        ownerId: 'owner-1', operationId: 'exact-operation',
        localRegistryId: 'local-entry', localVersionId: 'local-version',
        authoritativeCapabilityId: 'authority-entry', authoritativeVersionId: 'authority-version',
        artifactDigest: inventory.treeDigest, auditDigest,
        blobDigest: sha256('blob'), blobByteSize: 4,
      });
      expect(store.retireSourceAfterAuthoritativePublish({
        ownerId: 'owner-2', authoritativeCapabilityId: 'authority-entry', authoritativeVersionId: 'authority-version',
        artifactDigest: inventory.treeDigest, auditDigest,
      })).toBeNull();
      expect(store.retireSourceAfterAuthoritativePublish({
        ownerId: 'owner-1', authoritativeCapabilityId: 'authority-entry', authoritativeVersionId: 'authority-version',
        artifactDigest: inventory.treeDigest, auditDigest: sha256('wrong-audit'),
      })).toBeNull();
      expect(readManagedSkillIndex(homeDir).entries.map((entry) => entry.registryId).sort()).toEqual(['authority-entry', 'local-entry']);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });
});
