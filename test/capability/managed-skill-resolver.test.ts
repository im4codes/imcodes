import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { inventoryAgentSkillPackage } from '../../src/capability/agent-skill-package.js';
import {
  MANAGED_SKILL_STORE_TESTING,
  publishManagedSkillVersion,
  readManagedSkillIndex,
  updateManagedSkillEntry,
  writeManagedSkillIndex,
} from '../../src/capability/managed-skill-store.js';
import { getManagedSkillVersionPath } from '../../src/capability/managed-skill-paths.js';
import { scanAgentSkillPackage } from '../../src/capability/skill-scanner.js';
import { buildTransportStartupMemory } from '../../src/agent/runtime-context-bootstrap.js';
import { buildProviderContextPayload } from '../../src/agent/transport-runtime-assembly.js';
import type { TransportProvider } from '../../src/agent/transport-provider.js';
import { buildUserSkillRegistry } from '../../src/context/skill-registry-builder.js';
import { collectSkillStartupCandidates } from '../../src/context/skill-startup-context.js';
import { readManagedSkillResource, resolveSkillByKey } from '../../src/context/skill-resolver.js';
import { activateCapabilitySkill } from '../../src/capability/capability-skill-activation.js';
import { createDefaultCapabilityService } from '../../src/capability/capability-service-adapter.js';
import { CAPABILITY_KIND, CAPABILITY_READINESS, CAPABILITY_SCOPE, CAPABILITY_STATE } from '../../shared/capability-management.js';
import { authorizedManagedBindings } from './capability-authorization-fixture.js';

const namespace = { scope: 'personal' as const, userId: 'owner', projectId: 'project-1' };

function provider(id: string): TransportProvider {
  return {
    id,
    connectionMode: 'local-sdk',
    sessionOwnership: 'shared',
    capabilities: {
      streaming: true, toolCalling: true, approval: false, sessionRestore: true,
      multiTurn: true, attachments: false, contextSupport: 'full-normalized-context-injection',
    },
    connect: async () => {}, disconnect: async () => {}, createSession: async () => 'session',
    endSession: async () => {}, send: async () => {}, onDelta: () => () => {},
    onComplete: () => () => {}, onError: () => () => {},
  };
}

describe('managed Skill resolver and provider projection', () => {
  const temporary: string[] = [];
  afterEach(async () => {
    MANAGED_SKILL_STORE_TESTING.setBeforeVerifiedFileOpen();
    await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('derives catalog identity from the verified manifest and rejects a verify-to-read replacement', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-resolver-toctou-home-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-resolver-toctou-source-'));
    temporary.push(homeDir, source);
    await writeFile(join(source, 'SKILL.md'), '---\nname: verified-name\ndescription: Verified description.\n---\nTrusted instructions.\n');
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    publishManagedSkillVersion({
      registryId: 'verified-registry', versionId: inventory.treeDigest, quarantinePath: source,
      source: 'attacker\nstartup-injection', scannerDigest: scan.scannerDigest, auditDigest: 'audit', auditPolicyVersion: 'v1',
      bindings: authorizedManagedBindings({ ownerId: 'owner', serverId: 'server-1', capabilityId: 'verified-registry',
        versionId: inventory.treeDigest, artifactDigest: inventory.treeDigest, auditDigest: 'audit',
        bindings: [{ scope: 'account', ownerId: 'owner' }] }),
    }, homeDir);
    const index = readManagedSkillIndex(homeDir);
    writeManagedSkillIndex({
      ...index,
      entries: index.entries.map((entry) => ({ ...entry, name: 'forged-name', description: 'Forged startup metadata.' })),
    }, homeDir);
    const startup = collectSkillStartupCandidates({ namespace, homeDir, serverId: 'server-1', featureEnabled: true });
    const startupText = startup.map((candidate) => candidate.text).join('\n');
    expect(startupText).toContain('managed/verified-name');
    expect(startupText).toContain('Verified description.');
    expect(startupText).not.toContain('forged-name');
    expect(startupText).not.toContain('Forged startup metadata.');
    expect(startupText).not.toContain('startup-injection');
    expect(resolveSkillByKey({ namespace, homeDir, serverId: 'server-1', key: 'managed/forged-name' }))
      .toEqual({ ok: false, key: 'managed/forged-name', reason: 'unknown_key' });

    // The hook must mutate synchronously to exercise the exact verification
    // boundary; use the sync filesystem below rather than awaiting an async race.
    MANAGED_SKILL_STORE_TESTING.setBeforeVerifiedFileOpen(() => {
      MANAGED_SKILL_STORE_TESTING.setBeforeVerifiedFileOpen();
      writeFileSync(
        join(getManagedSkillVersionPath(homeDir, 'verified-registry', inventory.treeDigest), 'SKILL.md'),
        '---\nname: verified-name\ndescription: Verified description.\n---\nAttacker replacement.\n',
      );
    });
    expect(resolveSkillByKey({ namespace, homeDir, serverId: 'server-1', key: 'managed/verified-name' }))
      .toEqual({ ok: false, key: 'managed/verified-name', reason: 'read_failed' });
  });

  it('projects bounded verified instructions and validates resource generation', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-resolver-home-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-resolver-source-'));
    temporary.push(homeDir, source);
    await mkdir(join(source, 'references'));
    await writeFile(join(source, 'SKILL.md'), '---\nname: portable\ndescription: Portable Skill description.\ncompatibility: IM.codes\n---\nFull managed instructions.\n');
    await writeFile(join(source, 'references', 'guide.md'), 'Approved reference.\n');
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    publishManagedSkillVersion({
      registryId: 'portable-registry', versionId: inventory.treeDigest, quarantinePath: source,
      source: 'test-repository@commit', scannerDigest: scan.scannerDigest, auditDigest: 'audit', auditPolicyVersion: 'v1',
      bindings: authorizedManagedBindings({ ownerId: 'owner', serverId: 'server-1', capabilityId: 'portable-registry',
        versionId: inventory.treeDigest, artifactDigest: inventory.treeDigest, auditDigest: 'audit',
        bindings: [{ scope: 'project', ownerId: 'owner', projectId: 'project-1' }] }),
    }, homeDir);

    const startup = collectSkillStartupCandidates({ namespace, homeDir, serverId: 'server-1', featureEnabled: true });
    expect(startup.map((entry) => entry.text).join('\n')).toContain('managed/portable');
    expect(startup.map((entry) => entry.text).join('\n')).not.toContain('Full managed instructions.');
    expect(startup.map((entry) => entry.text).join('\n')).toContain('capability_status');
    expect(startup.map((entry) => entry.text).join('\n')).toContain('resources: Additional package resources are unavailable');
    expect(startup.map((entry) => entry.text).join('\n')).toContain('never write or invoke provider-native');

    const resolved = resolveSkillByKey({ namespace, homeDir, serverId: 'server-1', key: 'managed/portable' });
    expect(resolved).toMatchObject({ ok: true, layer: 'managed_registry', registryId: 'portable-registry' });
    expect(resolved.ok && resolved.text).toContain('Full managed instructions.');
    expect(activateCapabilitySkill({
      id: 'portable-registry', revision: 1, kind: CAPABILITY_KIND.SKILL, name: 'portable',
      state: CAPABILITY_STATE.ACTIVE, scope: CAPABILITY_SCOPE.PROJECT, versionId: inventory.treeDigest,
      readiness: CAPABILITY_READINESS.READY, findings: [], updatedAt: Date.now(),
    }, {
      ownerId: 'owner', namespace, homeDir, sessionId: 'session-1', projectDir: '/project',
      providerId: 'claude-code-sdk', serverId: 'server-1',
    })).toMatchObject({
      status: 'ok',
      skillActivation: { capabilityId: 'portable-registry', versionId: inventory.treeDigest },
    });
    const generationId = resolved.ok ? resolved.generationId! : '';
    expect(readManagedSkillResource({ namespace, homeDir, serverId: 'server-1', key: 'managed/portable', generationId, resourcePath: 'references/guide.md' }))
      .toMatchObject({ ok: true, path: 'references/guide.md' });
    expect(readManagedSkillResource({ namespace, homeDir, serverId: 'server-1', key: 'managed/portable', generationId: 'stale', resourcePath: 'references/guide.md' }))
      .toEqual({ ok: false, key: 'managed/portable', reason: 'stale_generation' });
    expect(readManagedSkillResource({ namespace, homeDir, serverId: 'server-1', key: 'managed/portable', generationId, resourcePath: '../outside' }))
      .toEqual({ ok: false, key: 'managed/portable', reason: 'unauthorized' });
  });

  it('gives a managed binding precedence over a same-name legacy flat Skill', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-resolver-home-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-resolver-source-'));
    temporary.push(homeDir, source);
    await writeFile(join(source, 'SKILL.md'), '---\nname: collide\ndescription: Managed winner.\n---\nManaged.\n');
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    publishManagedSkillVersion({
      registryId: 'collide-registry', versionId: inventory.treeDigest, quarantinePath: source, source: 'test',
      scannerDigest: scan.scannerDigest, auditDigest: 'audit', auditPolicyVersion: 'v1',
      bindings: authorizedManagedBindings({ ownerId: 'owner', serverId: 'server-1', capabilityId: 'collide-registry',
        versionId: inventory.treeDigest, artifactDigest: inventory.treeDigest, auditDigest: 'audit', bindings: [{ scope: 'local' }] }),
    }, homeDir);
    const flat = join(homeDir, '.imcodes', 'skills', 'general', 'collide.md');
    await mkdir(join(homeDir, '.imcodes', 'skills', 'general'), { recursive: true });
    await writeFile(flat, '---\nname: collide\ncategory: general\ndescription: Legacy loser.\n---\nLegacy.\n');
    buildUserSkillRegistry({ homeDir });
    const startup = collectSkillStartupCandidates({ namespace, homeDir, serverId: 'server-1', featureEnabled: true });
    const text = startup.map((entry) => entry.text).join('\n');
    expect(text).toContain('Managed winner.');
    expect(text).not.toContain('Legacy loser.');
  });

  it('rejects a filesystem-consistent package whose authorization signature is forged or rebound', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-resolver-forgery-home-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-resolver-forgery-source-'));
    temporary.push(homeDir, source);
    await writeFile(join(source, 'SKILL.md'), '---\nname: forged-local\ndescription: Locally forged package.\n---\nNever load forged instructions.\n');
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    publishManagedSkillVersion({
      registryId: 'forged-registry', versionId: inventory.treeDigest, quarantinePath: source,
      source: 'attacker-local-write', scannerDigest: scan.scannerDigest, auditDigest: 'audit', auditPolicyVersion: 'v1',
      bindings: authorizedManagedBindings({ ownerId: 'owner', serverId: 'server-1', capabilityId: 'forged-registry',
        versionId: inventory.treeDigest, artifactDigest: inventory.treeDigest, auditDigest: 'audit',
        bindings: [{ scope: 'account', ownerId: 'owner' }] }),
    }, homeDir);
    expect(resolveSkillByKey({ namespace, homeDir, serverId: 'server-1', key: 'managed/forged-local' }))
      .toMatchObject({ ok: true });

    updateManagedSkillEntry('forged-registry', (entry) => ({
      ...entry,
      bindings: entry.bindings.map((binding) => ({
        ...binding,
        authorization: binding.authorization
          ? { ...binding.authorization, signature: Buffer.alloc(64, 7).toString('base64url') }
          : undefined,
      })),
    }), homeDir);
    expect(resolveSkillByKey({ namespace, homeDir, serverId: 'server-1', key: 'managed/forged-local' }))
      .toEqual({ ok: false, key: 'managed/forged-local', reason: 'unknown_key' });
  });

  it('projects session bindings only for the exact session identity', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-resolver-home-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-resolver-source-'));
    temporary.push(homeDir, source);
    await writeFile(join(source, 'SKILL.md'), '---\nname: session-only\ndescription: Exact session Skill.\n---\nSession instructions.\n');
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    publishManagedSkillVersion({
      registryId: 'session-registry', versionId: inventory.treeDigest, quarantinePath: source, source: 'test',
      scannerDigest: scan.scannerDigest, auditDigest: 'audit', auditPolicyVersion: 'v1',
      bindings: authorizedManagedBindings({ ownerId: 'owner', serverId: 'server-1', capabilityId: 'session-registry',
        versionId: inventory.treeDigest, artifactDigest: inventory.treeDigest, auditDigest: 'audit',
        bindings: [{ scope: 'session', ownerId: 'owner', sessionId: 'deck_project_sub1' }] }),
    }, homeDir);
    expect(collectSkillStartupCandidates({ namespace, homeDir, serverId: 'server-1', sessionId: 'deck_project_sub2', featureEnabled: true })
      .some((candidate) => candidate.text.includes('session-only'))).toBe(false);
    expect(collectSkillStartupCandidates({ namespace, homeDir, serverId: 'server-1', sessionId: 'deck_project_sub1', featureEnabled: true })
      .some((candidate) => candidate.text.includes('session-only'))).toBe(true);
    expect(resolveSkillByKey({ namespace, homeDir, serverId: 'server-1', sessionId: 'deck_project_sub2', key: 'managed/session-only' }))
      .toEqual({ ok: false, key: 'managed/session-only', reason: 'unknown_key' });
    expect(resolveSkillByKey({ namespace, homeDir, serverId: 'server-1', sessionId: 'deck_project_sub1', key: 'managed/session-only' }))
      .toMatchObject({ ok: true, registryId: 'session-registry' });
  });

  it('intersects account, project, and session scope with exact provider and machine identities', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-binding-home-'));
    temporary.push(homeDir);
    const cases = [
      { name: 'account-gated', binding: { scope: 'account' as const, ownerId: 'owner' }, sessionId: 'session-1' },
      { name: 'project-gated', binding: { scope: 'project' as const, ownerId: 'owner', projectId: 'project-1' }, sessionId: 'session-1' },
      { name: 'session-gated', binding: { scope: 'session' as const, ownerId: 'owner', sessionId: 'session-1' }, sessionId: 'session-1' },
    ];
    for (const entry of cases) {
      const source = await mkdtemp(join(tmpdir(), 'imcodes-binding-source-'));
      temporary.push(source);
      await writeFile(join(source, 'SKILL.md'), `---\nname: ${entry.name}\ndescription: Exact binding dimensions.\n---\n${entry.name} instructions.\n`);
      const inventory = inventoryAgentSkillPackage(source);
      const scan = scanAgentSkillPackage(inventory);
      publishManagedSkillVersion({
        registryId: `${entry.name}-registry`, versionId: inventory.treeDigest, quarantinePath: source, source: 'test',
        scannerDigest: scan.scannerDigest, auditDigest: 'audit', auditPolicyVersion: 'v1',
        bindings: authorizedManagedBindings({ ownerId: 'owner', serverId: 'server-1', capabilityId: `${entry.name}-registry`,
          versionId: inventory.treeDigest, artifactDigest: inventory.treeDigest, auditDigest: 'audit',
          bindings: [{ ...entry.binding, providers: ['claude-code-sdk'], machines: ['server-1'] }] }),
      }, homeDir);
    }

    for (const entry of cases) {
      const allowed = { namespace, homeDir, sessionId: entry.sessionId, providerId: 'claude-code-sdk', serverId: 'server-1' };
      expect(resolveSkillByKey({ ...allowed, key: `managed/${entry.name}` })).toMatchObject({ ok: true });
      expect(collectSkillStartupCandidates({ ...allowed, featureEnabled: true }).some((candidate) => candidate.text.includes(`managed/${entry.name}`))).toBe(true);
      for (const providerId of ['codex-sdk', 'pi', 'deepseek-harness']) {
        expect(resolveSkillByKey({ ...allowed, providerId, key: `managed/${entry.name}` }), providerId)
          .toEqual({ ok: false, key: `managed/${entry.name}`, reason: 'unknown_key' });
      }
      expect(resolveSkillByKey({ ...allowed, serverId: 'server-2', key: `managed/${entry.name}` }))
        .toEqual({ ok: false, key: `managed/${entry.name}`, reason: 'unknown_key' });
      expect(resolveSkillByKey({ namespace, homeDir, sessionId: entry.sessionId, key: `managed/${entry.name}` }))
        .toEqual({ ok: false, key: `managed/${entry.name}`, reason: 'unknown_key' });
    }

    const claudeStartup = await buildTransportStartupMemory(namespace, {
      homeDir, sessionId: 'session-1', providerId: 'claude-code-sdk', serverId: 'server-1',
      skillsFeatureEnabled: true, limit: 20, remoteItems: [],
    });
    expect(claudeStartup?.injectedText).toContain('managed/account-gated');
    const codexStartup = await buildTransportStartupMemory(namespace, {
      homeDir, sessionId: 'session-1', providerId: 'codex-sdk', serverId: 'server-1',
      skillsFeatureEnabled: true, limit: 20, remoteItems: [],
    });
    expect(codexStartup?.injectedText ?? '').not.toContain('managed/account-gated');
  });

  it('delivers the same managed activation catalog through the common Claude, Codex, Pi, and DSH seam', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-resolver-home-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-resolver-source-'));
    temporary.push(homeDir, source);
    await writeFile(join(source, 'SKILL.md'), '---\nname: shared-seam\ndescription: Shared provider seam.\n---\nUse the verified shared-seam workflow.\n');
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    publishManagedSkillVersion({
      registryId: 'shared-seam-registry', versionId: inventory.treeDigest, quarantinePath: source, source: 'test',
      scannerDigest: scan.scannerDigest, auditDigest: 'audit', auditPolicyVersion: 'v1',
      bindings: authorizedManagedBindings({ ownerId: 'owner', serverId: 'server-1', capabilityId: 'shared-seam-registry',
        versionId: inventory.treeDigest, artifactDigest: inventory.treeDigest, auditDigest: 'audit',
        bindings: [{ scope: 'account', ownerId: 'owner' }] }),
    }, homeDir);
    const startupMemory = await buildTransportStartupMemory(namespace, {
      homeDir, serverId: 'server-1', skillsFeatureEnabled: true, limit: 20, remoteItems: [],
    });
    expect(startupMemory?.injectedText).toContain('capability-id: shared-seam-registry');
    expect(startupMemory?.injectedText).not.toContain('Use the verified shared-seam workflow.');

    for (const providerId of ['claude-code-sdk', 'codex-sdk', 'pi', 'deepseek-harness']) {
      const payload = buildProviderContextPayload(provider(providerId), {
        userMessage: 'Use the installed Skill',
        namespace,
        localProcessedFreshness: 'fresh',
        startupMemory,
      });
      expect(payload.messagePreamble, providerId).toContain('capability-id: shared-seam-registry');
      expect(payload.assembledMessage, providerId).toContain('capability_status');
    }
  });

  it('finds and explicitly activates an authorized large Skill omitted by the startup budget', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-activation-budget-home-'));
    temporary.push(homeDir);
    let targetVersion = '';
    for (let index = 0; index < 8; index += 1) {
      const source = await mkdtemp(join(tmpdir(), 'imcodes-activation-budget-source-'));
      temporary.push(source);
      const name = index === 7 ? 'zz-target-skill' : `catalog-skill-${index}`;
      const instructions = index === 7
        ? `Use the explicit target workflow. ${'bounded-step '.repeat(900)}`
        : `Use catalog workflow ${index}.`;
      await writeFile(join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: Catalog entry ${index}.\n---\n${instructions}\n`);
      const inventory = inventoryAgentSkillPackage(source);
      const scan = scanAgentSkillPackage(inventory);
      if (index === 7) targetVersion = inventory.treeDigest;
      publishManagedSkillVersion({
        registryId: `${name}-registry`, versionId: inventory.treeDigest, quarantinePath: source, source: 'test',
        scannerDigest: scan.scannerDigest, auditDigest: 'audit', auditPolicyVersion: 'v1',
        bindings: authorizedManagedBindings({ ownerId: 'owner', serverId: 'server-1', capabilityId: `${name}-registry`,
          versionId: inventory.treeDigest, artifactDigest: inventory.treeDigest, auditDigest: 'audit',
          bindings: [{ scope: 'account', ownerId: 'owner', providers: ['claude-code-sdk'], machines: ['server-1'] }] }),
      }, homeDir);
    }

    const startup = await buildTransportStartupMemory(namespace, {
      homeDir, sessionId: 'session-1', providerId: 'claude-code-sdk', serverId: 'server-1',
      skillsFeatureEnabled: true, remoteItems: [],
    });
    expect(startup?.injectedText ?? '').not.toContain('capability-id: zz-target-skill-registry');
    expect(startup?.injectedText).toContain('capability_list');

    const service = createDefaultCapabilityService({
      ownerId: 'owner', conversationIdentity: 'activation-test', homeDir, namespace,
      sessionId: 'session-1', providerId: 'claude-code-sdk', serverId: 'server-1',
    });
    expect(service.list({ kind: CAPABILITY_KIND.SKILL, query: 'zz-target' })).toMatchObject({
      status: 'ok', items: [expect.objectContaining({ id: 'zz-target-skill-registry', versionId: targetVersion })],
    });
    expect(service.status({ capabilityId: 'zz-target-skill-registry', activate: true })).toMatchObject({
      status: 'ok',
      skillActivation: {
        capabilityId: 'zz-target-skill-registry',
        versionId: targetVersion,
        instructions: expect.stringContaining('Use the explicit target workflow.'),
      },
    });
    expect(service.status({ capabilityId: 'zz-target-skill-registry', activate: true })).not.toMatchObject({
      skillActivation: expect.objectContaining({ resources: expect.anything() }),
    });
  });

  it('uses trusted owner identity for fallback namespaces and still rejects cross-owner access', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-owner-fallback-home-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-owner-fallback-source-'));
    temporary.push(homeDir, source);
    await writeFile(join(source, 'SKILL.md'), '---\nname: owner-fallback\ndescription: Owner fallback.\n---\nTrusted owner workflow.\n');
    const inventory = inventoryAgentSkillPackage(source);
    const scan = scanAgentSkillPackage(inventory);
    publishManagedSkillVersion({
      registryId: 'owner-fallback-registry', versionId: inventory.treeDigest, quarantinePath: source, source: 'test',
      scannerDigest: scan.scannerDigest, auditDigest: 'audit', auditPolicyVersion: 'v1',
      bindings: authorizedManagedBindings({ ownerId: 'owner', serverId: 'server-1', capabilityId: 'owner-fallback-registry',
        versionId: inventory.treeDigest, artifactDigest: inventory.treeDigest, auditDigest: 'audit',
        bindings: [{ scope: 'account', ownerId: 'owner' }] }),
    }, homeDir);
    for (const fallbackNamespace of [
      { scope: 'personal' as const, projectId: 'local/non-git' },
      { scope: 'personal' as const, projectId: 'local/no-project-dir' },
      { scope: 'personal' as const, projectId: 'github.com/backend/fallback' },
    ]) {
      expect(resolveSkillByKey({
        namespace: fallbackNamespace, trustedOwnerId: 'owner', homeDir,
        providerId: 'claude-code-sdk', serverId: 'server-1', key: 'owner-fallback-registry',
      })).toMatchObject({ ok: true });
      expect(resolveSkillByKey({
        namespace: fallbackNamespace, trustedOwnerId: 'other-owner', homeDir,
        providerId: 'claude-code-sdk', serverId: 'server-1', key: 'owner-fallback-registry',
      })).toEqual({ ok: false, key: 'owner-fallback-registry', reason: 'unknown_key' });
    }
  });
});
