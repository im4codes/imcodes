import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_AUDIT_VERDICT,
  CAPABILITY_BLOB_ACTION,
  CAPABILITY_KIND,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  CAPABILITY_SYNC_MSG,
  computeCapabilitySyncDigest,
  type CapabilityBlobAccess,
  type CapabilitySummary,
  type CapabilitySyncBinding,
  type CapabilitySyncAuthorityFrame,
  type CapabilitySyncDigestFrame,
  type CapabilitySyncSnapshot,
  type CapabilitySyncTombstoneFrame,
  type CapabilityTombstone,
  type CapabilityVersion,
} from '../../shared/capability-management.js';
import { inventoryAgentSkillPackage } from '../../src/capability/agent-skill-package.js';
import { CapabilitySyncFrameHandler } from '../../src/capability/capability-sync-handler.js';
import { CapabilitySyncRuntime } from '../../src/capability/capability-sync-runtime.js';
import {
  CAPABILITY_SYNC_ERROR,
  CapabilitySyncError,
  CapabilitySyncService,
} from '../../src/capability/capability-sync-service.js';
import { publishManagedSkillVersion, readManagedSkillIndex } from '../../src/capability/managed-skill-store.js';
import { scanAgentSkillPackage } from '../../src/capability/skill-scanner.js';
import { buildSkillTransferArchive } from '../../src/capability/skill-transfer-archive.js';
import { resolveSkillByKey } from '../../src/context/skill-resolver.js';
import { clearCapabilityAuthorizationKeys } from '../../src/capability/capability-authorization.js';
import { signedSyncBinding, TEST_CAPABILITY_AUTHORIZATION_KEY } from './capability-authorization-fixture.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function signed<T extends CapabilitySyncDigestFrame>(frame: Omit<T, 'digest'>): T {
  const draft = { ...frame, digest: sha256('placeholder') } as T;
  return { ...draft, digest: computeCapabilitySyncDigest(draft, sha256) };
}

function authorityFrame(
  serverId: string,
  revision: number,
  bindings: readonly CapabilitySyncBinding[],
): CapabilitySyncAuthorityFrame {
  return signed<CapabilitySyncAuthorityFrame>({
    type: CAPABILITY_SYNC_MSG.AUTHORITY,
    ownerId: 'owner-1',
    serverId,
    revision,
    records: bindings.flatMap((binding) => binding.authorization ? [{
      capabilityId: binding.capabilityId,
      versionId: binding.versionId,
      bindingId: binding.id,
      state: binding.authorization.bindingState,
      itemRevision: binding.authorization.itemRevision,
      bindingRevision: binding.authorization.bindingRevision,
      authorization: binding.authorization,
    }] : []),
    authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
  });
}

describe('production capability synchronization runtime', () => {
  const temporary: string[] = [];
  afterEach(async () => {
    clearCapabilityAuthorizationKeys('owner-1', 'server-1');
    clearCapabilityAuthorizationKeys('owner-1', 'server-2');
    await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('downloads, publishes, and tombstones the same account Skill on two daemon stores', async () => {
    const source = await mkdtemp(join(tmpdir(), 'imcodes-sync-source-'));
    const firstHome = await mkdtemp(join(tmpdir(), 'imcodes-sync-machine-a-'));
    const secondHome = await mkdtemp(join(tmpdir(), 'imcodes-sync-machine-b-'));
    temporary.push(source, firstHome, secondHome);
    await writeFile(join(source, 'SKILL.md'), '---\nname: shared-skill\ndescription: Shared across machines.\n---\nUse safely.\n');
    const inventory = inventoryAgentSkillPackage(source);
    const archive = buildSkillTransferArchive(source, inventory.treeDigest);
    const capability: CapabilitySummary = {
      id: 'shared-skill', revision: 1, kind: CAPABILITY_KIND.SKILL, name: 'shared-skill',
      state: CAPABILITY_STATE.ACTIVE, scope: CAPABILITY_SCOPE.ACCOUNT,
      versionId: 'shared-version', version: 1, artifactDigest: inventory.treeDigest,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE, sourceLabel: 'account-sync',
      readiness: CAPABILITY_READINESS.CONTENT_MISSING, findings: [], updatedAt: 100,
    };
    const version: CapabilityVersion = {
      id: 'shared-version', capabilityId: capability.id, version: 1,
      artifactDigest: inventory.treeDigest, blobDigest: archive.blobDigest, blobByteSize: archive.blobByteSize,
      auditDigest: sha256('audit'), auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE, createdAt: 100,
    };
    const binding: CapabilitySyncBinding = {
      id: 'shared-binding', capabilityId: capability.id, versionId: version.id,
      scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: [], active: true,
    };
    const authorizedBinding = signedSyncBinding({ ownerId: 'owner-1', capabilityId: capability.id, version, binding, issuedRevision: 1 });
    const snapshot = signed<CapabilitySyncSnapshot>({
      type: CAPABILITY_SYNC_MSG.SNAPSHOT, ownerId: 'owner-1', revision: 1,
      items: [capability], versions: [version], bindings: [authorizedBinding], tombstones: [],
      authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    });
    const clients = [firstHome, secondHome].map(() => {
      const access: CapabilityBlobAccess = {
        action: CAPABILITY_BLOB_ACTION.DOWNLOAD,
        capabilityId: capability.id,
        versionId: version.id,
        blobDigest: archive.blobDigest,
        maxBytes: archive.blobByteSize,
        expiresAt: Date.now() + 60_000,
        singleUseToken: 'download-grant',
      };
      return {
        requestAccess: vi.fn(async () => access),
        download: vi.fn(async () => Buffer.from(archive.bytes)),
      };
    });
    const services = [firstHome, secondHome].map((homeDir, index) => {
      const runtime = new CapabilitySyncRuntime({ ownerId: 'owner-1', serverId: `server-${index + 1}`, homeDir, blobClient: clients[index] });
      return new CapabilitySyncService({
        ownerId: 'owner-1', serverId: `server-${index + 1}`, homeDir,
        loadSkillContent: runtime.loadSkillContent, publishSkill: runtime.publishSkill,
        reconcileSkill: runtime.reconcileSkill,
      });
    });
    await Promise.all(services.map((service) => service.apply(snapshot)));
    await Promise.all(services.map((service, index) => service.apply(authorityFrame(`server-${index + 1}`, 1, [authorizedBinding]))));
    for (let index = 0; index < services.length; index += 1) {
      expect(clients[index].requestAccess).toHaveBeenCalledWith(capability.id, version.id, CAPABILITY_BLOB_ACTION.DOWNLOAD);
      expect(clients[index].download).toHaveBeenCalledTimes(1);
      expect(resolveSkillByKey({
        namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' }, key: capability.id,
        homeDir: index === 0 ? firstHome : secondHome,
        providerId: 'codex-sdk', serverId: `server-${index + 1}`,
      })).toMatchObject({ ok: true });
    }
    expect(readManagedSkillIndex(firstHome).entries[0]?.bindings).toEqual([expect.objectContaining({
      ownerId: 'owner-1', scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'],
    })]);
    // A reconnect reconstructs the cursor from disk and ACKs the authoritative
    // snapshot without downloading or reinstalling the package again.
    const restoredRuntime = new CapabilitySyncRuntime({ ownerId: 'owner-1', serverId: 'server-1', homeDir: firstHome, blobClient: clients[0] });
    const restored = new CapabilitySyncService({
      ownerId: 'owner-1', serverId: 'server-1', homeDir: firstHome,
      loadSkillContent: restoredRuntime.loadSkillContent,
      publishSkill: restoredRuntime.publishSkill,
      reconcileSkill: restoredRuntime.reconcileSkill,
    });
    clearCapabilityAuthorizationKeys('owner-1', 'server-1');
    expect(resolveSkillByKey({
      namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' }, key: capability.id,
      homeDir: firstHome, providerId: 'codex-sdk', serverId: 'server-1',
    })).toMatchObject({ ok: false });
    await expect(restored.apply(snapshot)).resolves.toMatchObject({ idempotent: true, revision: 1 });
    await expect(restored.apply(authorityFrame('server-1', 1, [authorizedBinding])))
      .resolves.toMatchObject({ idempotent: true, revision: 1 });
    expect(resolveSkillByKey({
      namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' }, key: capability.id,
      homeDir: firstHome, providerId: 'codex-sdk', serverId: 'server-1',
    })).toMatchObject({ ok: true });
    expect(clients[0].download).toHaveBeenCalledTimes(1);

    const sessionBinding = signedSyncBinding({ ownerId: 'owner-1', capabilityId: capability.id, version, issuedRevision: 2, binding: {
      ...binding,
      scope: CAPABILITY_SCOPE.SESSION,
      scopeId: 'session-1',
    } });
    const bindingDelta = signed<CapabilitySyncSnapshot>({
      type: CAPABILITY_SYNC_MSG.DELTA,
      ownerId: 'owner-1',
      revision: 2,
      items: [{ ...capability, revision: 2, scope: CAPABILITY_SCOPE.SESSION, updatedAt: 150 }],
      versions: [version],
      bindings: [sessionBinding],
      tombstones: [],
      authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    });
    await Promise.all(services.map((service) => service.apply(bindingDelta)));
    await Promise.all(services.map((service, index) => service.apply(authorityFrame(`server-${index + 1}`, 2, [sessionBinding]))));
    expect(clients[0].download).toHaveBeenCalledTimes(1);
    expect(readManagedSkillIndex(firstHome).entries[0]?.bindings).toEqual([expect.objectContaining({
      ownerId: 'owner-1', scope: CAPABILITY_SCOPE.SESSION, sessionId: 'session-1',
    })]);

    const disabledDelta = signed<CapabilitySyncSnapshot>({
      type: CAPABILITY_SYNC_MSG.DELTA,
      ownerId: 'owner-1',
      revision: 3,
      items: [{ ...capability, revision: 3, state: CAPABILITY_STATE.DISABLED, scope: CAPABILITY_SCOPE.SESSION, updatedAt: 175 }],
      versions: [version], bindings: [], tombstones: [],
      authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    });
    await Promise.all(services.map((service) => service.apply(disabledDelta)));
    await Promise.all(services.map((service, index) => service.apply(authorityFrame(`server-${index + 1}`, 3, []))));
    for (const [index, machineHome] of [firstHome, secondHome].entries()) {
      expect(resolveSkillByKey({
        namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' }, key: capability.id, homeDir: machineHome,
        sessionId: 'session-1', providerId: 'codex-sdk', serverId: `server-${index + 1}`,
      })).toMatchObject({ ok: false });
    }

    const enabledDelta = signed<CapabilitySyncSnapshot>({
      type: CAPABILITY_SYNC_MSG.DELTA,
      ownerId: 'owner-1',
      revision: 4,
      items: [{ ...capability, revision: 4, state: CAPABILITY_STATE.ACTIVE, scope: CAPABILITY_SCOPE.SESSION, updatedAt: 190 }],
      versions: [version], bindings: [signedSyncBinding({ ownerId: 'owner-1', capabilityId: capability.id, version, binding: { ...sessionBinding, authorization: undefined }, issuedRevision: 4 })], tombstones: [],
      authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    });
    await Promise.all(services.map((service) => service.apply(enabledDelta)));
    await Promise.all(services.map((service, index) => service.apply(authorityFrame(
      `server-${index + 1}`,
      4,
      enabledDelta.bindings,
    ))));
    for (const [index, machineHome] of [firstHome, secondHome].entries()) {
      expect(resolveSkillByKey({
        namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' }, key: capability.id, homeDir: machineHome,
        sessionId: 'session-1', providerId: 'codex-sdk', serverId: `server-${index + 1}`,
      })).toMatchObject({ ok: true });
      expect(clients[index].download).toHaveBeenCalledTimes(1);
    }

    const tombstone: CapabilityTombstone = {
      id: 'shared-tombstone', capabilityId: capability.id, scope: CAPABILITY_SCOPE.ACCOUNT,
      accountRevision: 5, createdAt: 200, expiresAt: 10_000,
    };
    const removal = signed<CapabilitySyncTombstoneFrame>({
      type: CAPABILITY_SYNC_MSG.TOMBSTONE, ownerId: 'owner-1', revision: 5, tombstone,
    });
    await Promise.all(services.map((service) => service.apply(removal)));
    expect(resolveSkillByKey({ namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' }, key: capability.id, homeDir: firstHome, providerId: 'codex-sdk', serverId: 'server-1' }))
      .toMatchObject({ ok: false, reason: 'unknown_key' });
    expect(resolveSkillByKey({ namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' }, key: capability.id, homeDir: secondHome, providerId: 'codex-sdk', serverId: 'server-2' }))
      .toMatchObject({ ok: false, reason: 'unknown_key' });
  });

  it('publishes every binding-referenced version on two daemons and rolls back only the exact binding', async () => {
    const sources = await Promise.all([1, 2].map(async (version) => {
      const directory = await mkdtemp(join(tmpdir(), `imcodes-binding-version-${version}-`));
      temporary.push(directory);
      await writeFile(join(directory, 'SKILL.md'), `---\nname: scoped-skill\ndescription: Scoped version ${version}.\n---\nVERSION-${version}\n`);
      const inventory = inventoryAgentSkillPackage(directory);
      return { directory, inventory, archive: buildSkillTransferArchive(directory, inventory.treeDigest) };
    }));
    const versions: CapabilityVersion[] = sources.map((source, index) => ({
      id: `scoped-v${index + 1}`, capabilityId: 'scoped-skill', version: index + 1,
      artifactDigest: source.inventory.treeDigest,
      blobDigest: source.archive.blobDigest, blobByteSize: source.archive.blobByteSize,
      auditDigest: sha256(`audit-${index + 1}`), auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE, createdAt: 100 + index,
    }));
    const capability: CapabilitySummary = {
      id: 'scoped-skill', revision: 1, kind: CAPABILITY_KIND.SKILL, name: 'scoped-skill',
      state: CAPABILITY_STATE.ACTIVE, scope: CAPABILITY_SCOPE.ACCOUNT,
      versionId: versions[1]!.id, version: 2, artifactDigest: versions[1]!.artifactDigest,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE, sourceLabel: 'account-sync',
      readiness: CAPABILITY_READINESS.CONTENT_MISSING, findings: [], updatedAt: 100,
    };
    const rawBindings: CapabilitySyncBinding[] = [
      { id: 'scoped-account', capabilityId: capability.id, versionId: versions[1]!.id,
        scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: [], active: true },
      { id: 'scoped-session', capabilityId: capability.id, versionId: versions[1]!.id,
        scope: CAPABILITY_SCOPE.SESSION, scopeId: 'session-1', providers: ['codex-sdk'], machines: [], active: true },
    ];
    const signBindings = (bindings: readonly CapabilitySyncBinding[], issuedRevision: number) => bindings.map((binding) => {
      const version = versions.find((candidate) => candidate.id === binding.versionId)!;
      return signedSyncBinding({ ownerId: 'owner-1', capabilityId: capability.id, version, binding, issuedRevision });
    });
    const firstBindings = signBindings(rawBindings, 1);
    const first = signed<CapabilitySyncSnapshot>({
      type: CAPABILITY_SYNC_MSG.SNAPSHOT, ownerId: 'owner-1', revision: 1,
      items: [capability], versions, bindings: firstBindings, tombstones: [],
      authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    });
    const homes = await Promise.all([1, 2].map(async (index) => {
      const directory = await mkdtemp(join(tmpdir(), `imcodes-binding-home-${index}-`));
      temporary.push(directory);
      return directory;
    }));
    const clients = homes.map(() => ({
      requestAccess: vi.fn(async (_capabilityId: string, versionId: string): Promise<CapabilityBlobAccess> => {
        const index = versions.findIndex((candidate) => candidate.id === versionId);
        const archive = sources[index]!.archive;
        return { action: CAPABILITY_BLOB_ACTION.DOWNLOAD, capabilityId: capability.id, versionId,
          blobDigest: archive.blobDigest, maxBytes: archive.blobByteSize, expiresAt: Date.now() + 60_000,
          singleUseToken: `grant-${versionId}` };
      }),
      download: vi.fn(async (access: CapabilityBlobAccess) => Buffer.from(
        sources[versions.findIndex((candidate) => candidate.id === access.versionId)]!.archive.bytes,
      )),
    }));
    const services = homes.map((homeDir, index) => {
      const runtime = new CapabilitySyncRuntime({ ownerId: 'owner-1', serverId: `server-${index + 1}`, homeDir, blobClient: clients[index]! });
      return new CapabilitySyncService({ ownerId: 'owner-1', serverId: `server-${index + 1}`, homeDir,
        loadSkillContent: runtime.loadSkillContent, publishSkill: runtime.publishSkill, reconcileSkill: runtime.reconcileSkill });
    });
    await Promise.all(services.map((service) => service.apply(first)));
    await Promise.all(services.map((service, index) => service.apply(authorityFrame(`server-${index + 1}`, 1, firstBindings))));
    for (const [index, homeDir] of homes.entries()) {
      expect(readManagedSkillIndex(homeDir).entries[0]?.versions).toEqual([versions[1]!.id]);
      expect(resolveSkillByKey({ namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' },
        key: capability.id, homeDir, providerId: 'codex-sdk', serverId: `server-${index + 1}` }))
        .toMatchObject({ ok: true, versionId: versions[1]!.id });
    }

    const rolledBackBindings = signBindings([
      rawBindings[0]!,
      { ...rawBindings[1]!, versionId: versions[0]!.id },
    ], 2);
    expect(rolledBackBindings.map((binding) => binding.authorization?.itemRevision)).toEqual([2, 2]);
    const rollback = signed<CapabilitySyncSnapshot>({
      type: CAPABILITY_SYNC_MSG.DELTA, ownerId: 'owner-1', revision: 2,
      items: [{ ...capability, revision: 2, updatedAt: 200 }], versions, bindings: rolledBackBindings,
      tombstones: [], authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    });
    await Promise.all(services.map((service) => service.apply(rollback)));
    await Promise.all(services.map((service, index) => service.apply(authorityFrame(`server-${index + 1}`, 2, rolledBackBindings))));
    for (const [index, homeDir] of homes.entries()) {
      expect(readManagedSkillIndex(homeDir).entries[0]?.versions).toEqual(expect.arrayContaining(versions.map((version) => version.id)));
      expect(resolveSkillByKey({ namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' },
        key: capability.id, homeDir, providerId: 'codex-sdk', serverId: `server-${index + 1}` }))
        .toMatchObject({ ok: true, versionId: versions[1]!.id });
      expect(resolveSkillByKey({ namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' },
        sessionId: 'session-1', key: capability.id, homeDir, providerId: 'codex-sdk', serverId: `server-${index + 1}` }))
        .toMatchObject({ ok: true, versionId: versions[0]!.id });
      expect(readManagedSkillIndex(homeDir).entries[0]?.bindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ bindingId: 'scoped-account', versionId: versions[1]!.id }),
        expect.objectContaining({ bindingId: 'scoped-session', versionId: versions[0]!.id }),
      ]));
    }
  });

  it('preserves machine-local bindings and versions when synchronized bindings are replaced or tombstoned', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-mixed-home-'));
    const localSource = await mkdtemp(join(tmpdir(), 'imcodes-sync-mixed-local-'));
    const syncedSource = await mkdtemp(join(tmpdir(), 'imcodes-sync-mixed-account-'));
    temporary.push(homeDir, localSource, syncedSource);
    await writeFile(join(localSource, 'SKILL.md'), '---\nname: mixed-skill\ndescription: Machine-local version.\n---\nLOCAL-V1\n');
    await writeFile(join(syncedSource, 'SKILL.md'), '---\nname: mixed-skill\ndescription: Account version.\n---\nACCOUNT-V2\n');
    const localInventory = inventoryAgentSkillPackage(localSource);
    const syncedInventory = inventoryAgentSkillPackage(syncedSource);
    const localVersion: CapabilityVersion = {
      id: 'mixed-local-v1', capabilityId: 'mixed-skill', version: 1,
      artifactDigest: localInventory.treeDigest, auditDigest: sha256('mixed-local-audit'),
      auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS, sourceKind: CAPABILITY_SOURCE_KIND.INLINE, createdAt: 1,
    };
    const localBinding = signedSyncBinding({
      ownerId: 'owner-1', capabilityId: 'mixed-skill', version: localVersion, issuedRevision: 1,
      binding: { id: 'mixed-local-binding', capabilityId: 'mixed-skill', versionId: localVersion.id,
        scope: CAPABILITY_SCOPE.LOCAL, scopeId: 'server-1', providers: ['codex-sdk'], machines: ['server-1'], active: true },
    });
    publishManagedSkillVersion({
      registryId: 'mixed-skill', versionId: localVersion.id, quarantinePath: localSource, source: 'local-install',
      scannerDigest: scanAgentSkillPackage(localInventory).scannerDigest, auditDigest: localVersion.auditDigest,
      auditPolicyVersion: 'test', bindings: [{
        bindingId: localBinding.id, versionId: localBinding.versionId, scope: CAPABILITY_SCOPE.LOCAL,
        ownerId: 'owner-1', serverId: 'server-1', providers: localBinding.providers,
        machines: localBinding.machines, active: true, authorization: localBinding.authorization,
      }],
    }, homeDir);

    const archive = buildSkillTransferArchive(syncedSource, syncedInventory.treeDigest);
    const syncedVersion: CapabilityVersion = {
      id: 'mixed-account-v2', capabilityId: 'mixed-skill', version: 2,
      artifactDigest: syncedInventory.treeDigest, blobDigest: archive.blobDigest, blobByteSize: archive.blobByteSize,
      auditDigest: sha256('mixed-account-audit'), auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE, createdAt: 2,
    };
    const accountBinding = signedSyncBinding({
      ownerId: 'owner-1', capabilityId: 'mixed-skill', version: syncedVersion, issuedRevision: 1,
      binding: { id: 'mixed-account-binding', capabilityId: 'mixed-skill', versionId: syncedVersion.id,
        scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: [], active: true },
    });
    const capability: CapabilitySummary = {
      id: 'mixed-skill', revision: 1, kind: CAPABILITY_KIND.SKILL, name: 'mixed-skill',
      state: CAPABILITY_STATE.ACTIVE, scope: CAPABILITY_SCOPE.ACCOUNT, versionId: syncedVersion.id, version: 2,
      artifactDigest: syncedVersion.artifactDigest, sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      readiness: CAPABILITY_READINESS.CONTENT_MISSING, findings: [], updatedAt: 2,
    };
    const snapshot = signed<CapabilitySyncSnapshot>({
      type: CAPABILITY_SYNC_MSG.SNAPSHOT, ownerId: 'owner-1', revision: 1,
      items: [capability], versions: [syncedVersion], bindings: [accountBinding], tombstones: [],
      authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    });
    const blobClient = {
      requestAccess: vi.fn(async (): Promise<CapabilityBlobAccess> => ({
        action: CAPABILITY_BLOB_ACTION.DOWNLOAD, capabilityId: 'mixed-skill', versionId: syncedVersion.id,
        blobDigest: archive.blobDigest, maxBytes: archive.blobByteSize, expiresAt: Date.now() + 60_000,
        singleUseToken: 'mixed-download',
      })),
      download: vi.fn(async () => Buffer.from(archive.bytes)),
    };
    const runtime = new CapabilitySyncRuntime({ ownerId: 'owner-1', serverId: 'server-1', homeDir, blobClient });
    const service = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir,
      loadSkillContent: runtime.loadSkillContent, publishSkill: runtime.publishSkill, reconcileSkill: runtime.reconcileSkill });
    await service.apply(snapshot);
    await service.apply(authorityFrame('server-1', 1, [localBinding, accountBinding]));
    expect(readManagedSkillIndex(homeDir).entries[0]).toMatchObject({
      versions: expect.arrayContaining([localVersion.id, syncedVersion.id]),
      bindings: expect.arrayContaining([
        expect.objectContaining({ bindingId: localBinding.id, versionId: localVersion.id, scope: CAPABILITY_SCOPE.LOCAL }),
        expect.objectContaining({ bindingId: accountBinding.id, versionId: syncedVersion.id, scope: CAPABILITY_SCOPE.ACCOUNT }),
      ]),
    });

    const removal = signed<CapabilitySyncTombstoneFrame>({
      type: CAPABILITY_SYNC_MSG.TOMBSTONE, ownerId: 'owner-1', revision: 2,
      tombstone: { id: 'mixed-account-remove', capabilityId: 'mixed-skill', scope: CAPABILITY_SCOPE.ACCOUNT,
        accountRevision: 2, createdAt: 3, expiresAt: 30_000 },
    });
    await service.apply(removal);
    await service.apply(authorityFrame('server-1', 2, [localBinding]));
    const retained = readManagedSkillIndex(homeDir).entries[0]!;
    expect(retained.versions).toEqual([localVersion.id]);
    expect(retained.bindings).toEqual([expect.objectContaining({ bindingId: localBinding.id, versionId: localVersion.id })]);
    expect(resolveSkillByKey({ namespace: { scope: CAPABILITY_SCOPE.ACCOUNT, userId: 'owner-1' },
      key: 'mixed-skill', homeDir, providerId: 'codex-sdk', serverId: 'server-1' }))
      .toMatchObject({ ok: true, versionId: localVersion.id });
  });

  it('requests a full snapshot on a revision gap and rejects a cross-owner service', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-sync-handler-'));
    temporary.push(homeDir);
    const correct = new CapabilitySyncService({ ownerId: 'owner-1', serverId: 'server-1', homeDir });
    const requestFullSnapshot = vi.fn();
    const handler = new CapabilitySyncFrameHandler({ serviceForOwner: () => correct, requestFullSnapshot });
    const gap = signed<CapabilitySyncSnapshot>({
      type: CAPABILITY_SYNC_MSG.DELTA, ownerId: 'owner-1', revision: 2,
      items: [], versions: [], bindings: [], tombstones: [],
      authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    });
    expect(await handler.handle(gap)).toBe(true);
    expect(requestFullSnapshot).toHaveBeenCalledTimes(1);
    expect(correct.cursor.revision).toBe(0);

    const wrongOwner = new CapabilitySyncService({ ownerId: 'owner-2', serverId: 'server-1', homeDir });
    const crossOwnerHandler = new CapabilitySyncFrameHandler({ serviceForOwner: () => wrongOwner, requestFullSnapshot });
    const ownerOne = signed<CapabilitySyncSnapshot>({
      type: CAPABILITY_SYNC_MSG.SNAPSHOT, ownerId: 'owner-1', revision: 1,
      items: [], versions: [], bindings: [], tombstones: [],
      authorizationKeys: [TEST_CAPABILITY_AUTHORIZATION_KEY],
    });
    await crossOwnerHandler.handle(ownerOne);
    expect(requestFullSnapshot).toHaveBeenCalledTimes(2);
    expect(wrongOwner.cursor.revision).toBe(0);
  });

  it('serializes slow snapshot, authority, and delta frames per owner without poisoning the queue', async () => {
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const order: string[] = [];
    let failAuthority = true;
    const service = {
      async apply(frame: { type: string; revision: number }) {
        order.push(`start:${frame.type}:${frame.revision}`);
        if (frame.type === CAPABILITY_SYNC_MSG.SNAPSHOT) await slow;
        if (frame.type === CAPABILITY_SYNC_MSG.AUTHORITY && failAuthority) {
          failAuthority = false;
          order.push(`fail:${frame.type}:${frame.revision}`);
          throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.REVISION_GAP);
        }
        order.push(`end:${frame.type}:${frame.revision}`);
      },
    } as unknown as CapabilitySyncService;
    const requestFullSnapshot = vi.fn();
    const handler = new CapabilitySyncFrameHandler({ serviceForOwner: () => service, requestFullSnapshot });
    const first = handler.handle({ type: CAPABILITY_SYNC_MSG.SNAPSHOT, ownerId: 'owner-1', revision: 1 });
    await vi.waitFor(() => expect(order).toEqual([`start:${CAPABILITY_SYNC_MSG.SNAPSHOT}:1`]));
    const second = handler.handle({ type: CAPABILITY_SYNC_MSG.AUTHORITY, ownerId: 'owner-1', revision: 2 });
    const third = handler.handle({ type: CAPABILITY_SYNC_MSG.DELTA, ownerId: 'owner-1', revision: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([`start:${CAPABILITY_SYNC_MSG.SNAPSHOT}:1`]);
    releaseSlow?.();
    await Promise.all([first, second, third]);
    expect(order).toEqual([
      `start:${CAPABILITY_SYNC_MSG.SNAPSHOT}:1`, `end:${CAPABILITY_SYNC_MSG.SNAPSHOT}:1`,
      `start:${CAPABILITY_SYNC_MSG.AUTHORITY}:2`, `fail:${CAPABILITY_SYNC_MSG.AUTHORITY}:2`,
      `start:${CAPABILITY_SYNC_MSG.DELTA}:2`, `end:${CAPABILITY_SYNC_MSG.DELTA}:2`,
    ]);
    expect(requestFullSnapshot).toHaveBeenCalledTimes(1);
  });

  it('coalesces a stale-authority feedback loop with bounded backoff without blocking other owners', async () => {
    vi.useFakeTimers();
    try {
      const apply = vi.fn(async (frame: { ownerId: string; revision: number }) => {
        if (frame.ownerId === 'owner-stale' && frame.revision === 1) {
          throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.STALE_REVISION);
        }
      });
      const requestFullSnapshot = vi.fn();
      const onError = vi.fn();
      const handler = new CapabilitySyncFrameHandler({
        serviceForOwner: () => ({ apply } as unknown as CapabilitySyncService),
        requestFullSnapshot,
        onError,
      });
      const stale = {
        type: CAPABILITY_SYNC_MSG.AUTHORITY,
        ownerId: 'owner-stale',
        revision: 1,
        digest: 'a'.repeat(64),
      };

      // Reproduce the exact incident volume. The old handler performed one
      // apply, error emission, and full-snapshot request for every frame; the
      // repaired path admits the first frame and coalesces all 20,353 repeats.
      const handled = await Promise.all(Array.from({ length: 20_354 }, () => handler.handle(stale)));
      expect(handled).toEqual(Array.from({ length: 20_354 }, () => true));
      expect(apply).toHaveBeenCalledTimes(1);
      expect(requestFullSnapshot).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);

      await handler.handle({
        type: CAPABILITY_SYNC_MSG.SNAPSHOT,
        ownerId: 'owner-responsive',
        revision: 1,
        digest: 'b'.repeat(64),
      });
      expect(apply).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(999);
      expect(requestFullSnapshot).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestFullSnapshot).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(requestFullSnapshot).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestFullSnapshot).toHaveBeenCalledTimes(3);

      await handler.handle({
        type: CAPABILITY_SYNC_MSG.AUTHORITY,
        ownerId: 'owner-stale',
        revision: 2,
        digest: 'c'.repeat(64),
      });
      expect(apply).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(requestFullSnapshot).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps stale authority repair backoff across the server SNAPSHOT then AUTHORITY response order', async () => {
    vi.useFakeTimers();
    try {
      const apply = vi.fn(async (frame: { type: string; ownerId: string; revision: number }) => {
        if (frame.type === CAPABILITY_SYNC_MSG.AUTHORITY && frame.revision === 1) {
          throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.STALE_REVISION);
        }
      });
      const requestFullSnapshot = vi.fn();
      const handler = new CapabilitySyncFrameHandler({
        serviceForOwner: () => ({ apply } as unknown as CapabilitySyncService),
        requestFullSnapshot,
      });
      const staleAuthority = {
        type: CAPABILITY_SYNC_MSG.AUTHORITY,
        ownerId: 'owner-stale',
        revision: 1,
        digest: 'a'.repeat(64),
      };
      const snapshot = (revision: number) => ({
        type: CAPABILITY_SYNC_MSG.SNAPSHOT,
        ownerId: 'owner-stale',
        revision,
        digest: 'b'.repeat(64),
      });

      await handler.handle(staleAuthority);
      expect(requestFullSnapshot).toHaveBeenCalledTimes(1);

      // Production server/src/ws/bridge.ts answers each request with a
      // SNAPSHOT followed by AUTHORITY. The successful state snapshot must
      // not clear the still-failing authority dimension.
      await handler.handle(snapshot(2));
      await handler.handle(staleAuthority);
      expect(requestFullSnapshot).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(requestFullSnapshot).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestFullSnapshot).toHaveBeenCalledTimes(2);

      await handler.handle(snapshot(3));
      await handler.handle(staleAuthority);
      expect(requestFullSnapshot).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(requestFullSnapshot).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestFullSnapshot).toHaveBeenCalledTimes(3);

      await handler.handle({ ...staleAuthority, revision: 2, digest: 'c'.repeat(64) });
      expect(apply).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(requestFullSnapshot).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
