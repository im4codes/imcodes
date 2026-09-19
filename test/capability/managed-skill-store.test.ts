import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildUserSkillRegistry } from '../../src/context/skill-registry-builder.js';
import {
  establishManagedSkillStore,
  getManagedSkillMarkerPath,
  getManagedSkillManifestPath,
  getManagedSkillVersionPath,
} from '../../src/capability/managed-skill-paths.js';
import {
  publishManagedSkillVersion,
  manageExactLocalSkillBinding,
  readManagedSkillIndex,
  restoreManagedSkillVersion,
  trashManagedSkillVersion,
  updateManagedSkillEntry,
  verifyManagedSkillVersion,
  writeManagedSkillIndex,
} from '../../src/capability/managed-skill-store.js';
import { inventoryAgentSkillPackage } from '../../src/capability/agent-skill-package.js';
import { scanAgentSkillPackage } from '../../src/capability/skill-scanner.js';
import { CAPABILITY_MANAGE_ACTION, CAPABILITY_SCOPE, CAPABILITY_STATE } from '../../shared/capability-management.js';

const portableSkill = (name = 'portable-skill'): string => `---\nname: ${name}\ndescription: Portable managed Skill.\n---\nUse it safely.\n`;

describe('canonical managed Skill store', () => {
  const temporary: string[] = [];
  afterEach(async () => {
    await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('does not hide a pre-existing unmarked managed directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-store-home-'));
    temporary.push(homeDir);
    const collision = join(homeDir, '.imcodes', 'skills', 'managed');
    await mkdir(collision, { recursive: true });
    await writeFile(join(collision, 'legacy.md'), '---\nname: legacy\ncategory: managed\n---\nLegacy body.\n');
    expect(() => establishManagedSkillStore(homeDir)).toThrowError(expect.objectContaining({ code: 'managed_root_collision' }));
    expect(buildUserSkillRegistry({ homeDir }).entries).toContainEqual(expect.objectContaining({ key: 'managed/legacy' }));
  });

  it('skips an established managed subtree before the legacy 64-file budget', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-store-home-'));
    temporary.push(homeDir);
    establishManagedSkillStore(homeDir);
    expect(await readFile(getManagedSkillMarkerPath(homeDir), 'utf8')).toContain('managed-skill-store');
    for (let index = 0; index < 70; index += 1) {
      const path = join(homeDir, '.imcodes', 'skills', 'managed', `entry-${index}`, 'v1');
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'SKILL.md'), portableSkill(`managed-${index}`));
    }
    const ordinary = join(homeDir, '.imcodes', 'skills', 'zzz', 'ordinary.md');
    await mkdir(join(homeDir, '.imcodes', 'skills', 'zzz'), { recursive: true });
    await writeFile(ordinary, '---\nname: ordinary\ncategory: zzz\n---\nOrdinary.\n');
    const snapshot = buildUserSkillRegistry({ homeDir });
    expect(snapshot.entries.map((entry) => entry.key)).toEqual(['zzz/ordinary']);
  });

  it('publishes atomically, verifies digest, and supports recoverable trash/restore', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-store-home-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-store-source-'));
    temporary.push(homeDir, source);
    await writeFile(join(source, 'SKILL.md'), portableSkill());
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    const entry = publishManagedSkillVersion({
      registryId: 'registry-1',
      versionId: inventory.treeDigest,
      quarantinePath: source,
      source: 'test-source',
      scannerDigest: scan.scannerDigest,
      auditDigest: 'audit-digest',
      auditPolicyVersion: 'audit-v1',
      bindings: [{ scope: 'account', ownerId: 'owner-1' }],
    }, homeDir);
    expect(entry.activeVersionId).toBe(inventory.treeDigest);
    expect(verifyManagedSkillVersion(homeDir, 'registry-1', inventory.treeDigest).treeDigest).toBe(inventory.treeDigest);
    const trashId = trashManagedSkillVersion(homeDir, 'registry-1', inventory.treeDigest);
    expect(existsSync(getManagedSkillVersionPath(homeDir, 'registry-1', inventory.treeDigest))).toBe(false);
    expect(readManagedSkillIndex(homeDir).entries[0]).toMatchObject({ state: 'tombstoned' });
    const restored = restoreManagedSkillVersion(homeDir, 'registry-1', trashId);
    expect(restored).toMatchObject({ state: 'active', activeVersionId: inventory.treeDigest });
  });

  it('converges exact rename-before-index replays and repairs only its unindexed partial version', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-store-replay-home-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-store-replay-source-'));
    temporary.push(homeDir, source);
    await writeFile(join(source, 'SKILL.md'), portableSkill('replay-safe'));
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    const input = {
      registryId: 'replay-registry', versionId: 'replay-version', quarantinePath: source, source: 'sync-blob',
      scannerDigest: scan.scannerDigest, auditDigest: 'audit-replay', auditPolicyVersion: 'v1',
      bindings: [{ scope: 'account' as const, ownerId: 'owner-1' }],
      now: 1234,
    };
    publishManagedSkillVersion(input, homeDir);
    writeManagedSkillIndex({ schemaVersion: 1, revision: 0, entries: [] }, homeDir);

    const replayed = publishManagedSkillVersion({ ...input, now: 9999 }, homeDir);
    expect(replayed).toMatchObject({ registryId: 'replay-registry', activeVersionId: 'replay-version', updatedAt: 1234 });
    expect(readManagedSkillIndex(homeDir).entries).toHaveLength(1);

    // Simulate the earlier crash boundary after the package directory rename
    // but before the manifest/index rename. The exact unindexed version may be
    // removed and recreated; unrelated or indexed versions are never touched.
    await rm(getManagedSkillManifestPath(homeDir, 'replay-registry', 'replay-version'), { force: true });
    writeManagedSkillIndex({ schemaVersion: 1, revision: 2, entries: [] }, homeDir);
    const repaired = publishManagedSkillVersion(input, homeDir);
    expect(repaired.activeVersionId).toBe('replay-version');
    expect(verifyManagedSkillVersion(homeDir, 'replay-registry', 'replay-version').treeDigest).toBe(inventory.treeDigest);
  });

  it('detects local package tampering', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-store-home-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-store-source-'));
    temporary.push(homeDir, source);
    await writeFile(join(source, 'SKILL.md'), portableSkill());
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    publishManagedSkillVersion({
      registryId: 'registry-2', versionId: inventory.treeDigest, quarantinePath: source, source: 'test',
      scannerDigest: scan.scannerDigest, auditDigest: 'audit', auditPolicyVersion: 'v1', bindings: [{ scope: 'local' }],
    }, homeDir);
    await writeFile(join(getManagedSkillVersionPath(homeDir, 'registry-2', inventory.treeDigest), 'SKILL.md'), `${portableSkill()}tampered\n`);
    expect(() => verifyManagedSkillVersion(homeDir, 'registry-2', inventory.treeDigest)).toThrow();
  });

  it('strictly bounds and verifies manifest metadata, provenance, and exact file inventory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-store-manifest-home-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-store-manifest-source-'));
    temporary.push(homeDir, source);
    await writeFile(join(source, 'SKILL.md'), portableSkill('strict-manifest'));
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    publishManagedSkillVersion({
      registryId: 'strict-manifest', versionId: inventory.treeDigest, quarantinePath: source,
      source: 'https://example.com/repository?token=redacted', scannerDigest: scan.scannerDigest,
      auditDigest: 'audit', auditPolicyVersion: 'v1', bindings: [{ scope: 'account', ownerId: 'owner-1' }],
    }, homeDir);
    const manifestPath = getManagedSkillManifestPath(homeDir, 'strict-manifest', inventory.treeDigest);
    const original = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(original.source).toBe('https://example.com');
    const rejects = async (mutate: (value: Record<string, unknown>) => void) => {
      const value = structuredClone(original);
      mutate(value);
      await writeFile(manifestPath, `${JSON.stringify(value)}\n`);
      expect(() => verifyManagedSkillVersion(homeDir, 'strict-manifest', inventory.treeDigest)).toThrow();
    };
    await rejects((value) => { value.unknown = true; });
    await rejects((value) => { value.source = 'safe\nforged-system-line'; });
    await rejects((value) => { value.description = 'Forged description.'; });
    await rejects((value) => {
      const files = value.files as Array<Record<string, unknown>>;
      files[0] = { ...files[0], sha256: '0'.repeat(64) };
    });
    await writeFile(manifestPath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    expect(() => verifyManagedSkillVersion(homeDir, 'strict-manifest', inventory.treeDigest)).toThrow();
  });

  it('never writes provider-native Skill directories', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-store-home-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-store-source-'));
    temporary.push(homeDir, source);
    const providerSentinels = [
      join(homeDir, '.claude', 'skills', 'sentinel.txt'),
      join(homeDir, '.codex', 'skills', 'sentinel.txt'),
      join(homeDir, '.pi', 'skills', 'sentinel.txt'),
      join(homeDir, '.dsh', 'skills', 'sentinel.txt'),
    ];
    for (const sentinel of providerSentinels) {
      await mkdir(join(sentinel, '..'), { recursive: true });
      await writeFile(sentinel, 'unchanged');
    }
    await writeFile(join(source, 'SKILL.md'), portableSkill('provider-independent'));
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    publishManagedSkillVersion({
      registryId: 'provider-independent', versionId: inventory.treeDigest, quarantinePath: source, source: 'test',
      scannerDigest: scan.scannerDigest, auditDigest: 'audit', auditPolicyVersion: 'v1', bindings: [{ scope: 'local' }],
    }, homeDir);
    const trashId = trashManagedSkillVersion(homeDir, 'provider-independent', inventory.treeDigest);
    restoreManagedSkillVersion(homeDir, 'provider-independent', trashId);
    await expect(Promise.all(providerSentinels.map((sentinel) => readFile(sentinel, 'utf8'))))
      .resolves.toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged']);
  });

  it('restores one removed binding in place while another binding keeps the package active', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-store-multibinding-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-store-source-'));
    temporary.push(homeDir, source);
    await writeFile(join(source, 'SKILL.md'), portableSkill('multi-binding'));
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    publishManagedSkillVersion({
      registryId: 'multi-binding', versionId: inventory.treeDigest, quarantinePath: source, source: 'test',
      scannerDigest: scan.scannerDigest, auditDigest: 'audit', auditPolicyVersion: 'v1',
      bindings: [
        { bindingId: 'local-a', versionId: inventory.treeDigest, scope: 'local', ownerId: 'owner', serverId: 'server-1', active: true },
        // Disabled siblings still reference immutable bytes for exact restore;
        // uninstalling another binding must not trash their shared version.
        { bindingId: 'account-b', versionId: inventory.treeDigest, scope: 'account', ownerId: 'owner', active: false },
      ],
    }, homeDir);
    updateManagedSkillEntry('multi-binding', (entry) => ({ ...entry, authorityRevision: 1 }), homeDir);
    const removed = manageExactLocalSkillBinding({
      ownerId: 'owner', serverId: 'server-1', capabilityId: 'multi-binding', bindingId: 'local-a',
      expectedRevision: 1, action: 'uninstall', finalAuthorityRevision: 2,
    }, homeDir);
    expect(removed).toMatchObject({ ok: true, entry: { state: 'disabled', activeVersionId: inventory.treeDigest } });
    expect(readManagedSkillIndex(homeDir).entries[0]?.bindings[0]).toMatchObject({ removed: true, active: false });
    expect(readManagedSkillIndex(homeDir).entries[0]?.bindings[0]).not.toHaveProperty('trashId');

    expect(manageExactLocalSkillBinding({
      ownerId: 'owner', serverId: 'server-1', capabilityId: 'multi-binding', bindingId: 'local-a',
      expectedRevision: 2, action: 'restore', versionId: 'wrong-version', finalAuthorityRevision: 3,
    }, homeDir)).toEqual({ ok: false, code: 'integrity_failed' });
    const restored = manageExactLocalSkillBinding({
      ownerId: 'owner', serverId: 'server-1', capabilityId: 'multi-binding', bindingId: 'local-a',
      expectedRevision: 2, action: 'restore', versionId: inventory.treeDigest, finalAuthorityRevision: 3,
    }, homeDir);
    expect(restored).toMatchObject({ ok: true, entry: { state: 'active', authorityRevision: 3 } });
    expect(readManagedSkillIndex(homeDir).entries[0]?.bindings[0]).toMatchObject({ removed: false, active: true });
  });

  it('retains a shared version across either local-binding uninstall order and restart', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-store-removed-siblings-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-store-removed-source-'));
    temporary.push(homeDir, source);
    await writeFile(join(source, 'SKILL.md'), portableSkill('removed-siblings'));
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    publishManagedSkillVersion({
      registryId: 'removed-siblings', versionId: inventory.treeDigest, quarantinePath: source, source: 'test',
      scannerDigest: scan.scannerDigest, auditDigest: 'audit', auditPolicyVersion: 'v1',
      bindings: ['binding-a', 'binding-b'].map((bindingId) => ({
        bindingId, versionId: inventory.treeDigest, scope: CAPABILITY_SCOPE.LOCAL,
        ownerId: 'owner', serverId: 'server-1', active: true,
      })),
    }, homeDir);
    updateManagedSkillEntry('removed-siblings', (entry) => ({ ...entry, authorityRevision: 1 }), homeDir);

    expect(manageExactLocalSkillBinding({
      ownerId: 'owner', serverId: 'server-1', capabilityId: 'removed-siblings', bindingId: 'binding-a',
      expectedRevision: 1, finalAuthorityRevision: 2, action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
    }, homeDir)).toMatchObject({ ok: true });
    expect(manageExactLocalSkillBinding({
      ownerId: 'owner', serverId: 'server-1', capabilityId: 'removed-siblings', bindingId: 'binding-b',
      expectedRevision: 2, finalAuthorityRevision: 3, action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
    }, homeDir)).toMatchObject({ ok: true });
    const removed = readManagedSkillIndex(homeDir).entries[0]!;
    expect(removed.bindings).toEqual([
      expect.objectContaining({ bindingId: 'binding-a', removed: true, active: false }),
      expect.objectContaining({ bindingId: 'binding-b', removed: true, active: false }),
    ]);
    expect(removed.bindings.every((binding) => !binding.trashId)).toBe(true);
    expect(removed.versions).toContain(inventory.treeDigest);
    expect(() => verifyManagedSkillVersion(homeDir, 'removed-siblings', inventory.treeDigest)).not.toThrow();

    // The strict disk codec is the restart boundary. Either exact removed
    // binding can be restored without depending on uninstall order.
    expect(manageExactLocalSkillBinding({
      ownerId: 'owner', serverId: 'server-1', capabilityId: 'removed-siblings', bindingId: 'binding-a',
      expectedRevision: 3, finalAuthorityRevision: 4, action: CAPABILITY_MANAGE_ACTION.RESTORE,
      versionId: inventory.treeDigest,
    }, homeDir)).toMatchObject({ ok: true, entry: { state: CAPABILITY_STATE.ACTIVE } });
    expect(readManagedSkillIndex(homeDir).entries[0]?.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ bindingId: 'binding-a', removed: false, active: true }),
      expect.objectContaining({ bindingId: 'binding-b', removed: true, active: false }),
    ]));
  });
});
