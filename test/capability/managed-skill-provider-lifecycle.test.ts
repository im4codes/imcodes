import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, TransportMemoryRecallArtifact } from '../../shared/context-types.js';
import { MANAGED_SKILL_PROVIDER_COMPATIBILITY } from '../../shared/capability-management.js';
import { inventoryAgentSkillPackage } from '../../src/capability/agent-skill-package.js';
import {
  publishManagedSkillVersion,
  readManagedSkillIndex,
} from '../../src/capability/managed-skill-store.js';
import { scanAgentSkillPackage } from '../../src/capability/skill-scanner.js';
import { buildTransportStartupMemory } from '../../src/agent/runtime-context-bootstrap.js';
import { buildProviderContextPayload } from '../../src/agent/transport-runtime-assembly.js';
import type { TransportProvider } from '../../src/agent/transport-provider.js';
import { collectSkillStartupCandidates } from '../../src/context/skill-startup-context.js';
import { resolveSkillByKey } from '../../src/context/skill-resolver.js';
import { authorizedManagedBindings } from './capability-authorization-fixture.js';

const namespace: ContextNamespace = {
  scope: 'personal',
  userId: 'owner',
  projectId: 'project-provider-lifecycle',
};

const providerIds = ['claude-code-sdk', 'codex-sdk', 'pi', 'deepseek-harness'] as const;

function provider(id: string): TransportProvider {
  return {
    id,
    connectionMode: 'local-sdk',
    sessionOwnership: 'shared',
    capabilities: {
      streaming: true,
      toolCalling: true,
      approval: false,
      sessionRestore: true,
      multiTurn: true,
      attachments: false,
      contextSupport: 'full-normalized-context-injection',
    },
    connect: async () => {},
    disconnect: async () => {},
    createSession: async () => 'provider-session',
    endSession: async () => {},
    send: async () => {},
    onDelta: () => () => {},
    onComplete: () => () => {},
    onError: () => () => {},
  };
}

async function publishSkill(input: {
  homeDir: string;
  sourceDir: string;
  registryId: string;
  name: string;
  instructions: string;
  bindings: Array<{
    scope: 'account' | 'project' | 'session' | 'local';
    ownerId?: string;
    projectId?: string;
    sessionId?: string;
  }>;
  script?: string;
}): Promise<{ generationId: string; versionId: string }> {
  await mkdir(input.sourceDir, { recursive: true });
  await writeFile(join(input.sourceDir, 'SKILL.md'), [
    '---',
    `name: ${input.name}`,
    `description: ${input.name} lifecycle fixture.`,
    'compatibility: IM.codes',
    '---',
    input.instructions,
    '',
  ].join('\n'));
  if (input.script) {
    await mkdir(join(input.sourceDir, 'scripts'), { recursive: true });
    await writeFile(join(input.sourceDir, 'scripts', 'install.sh'), input.script);
  }
  const inventory = inventoryAgentSkillPackage(input.sourceDir);
  const scan = scanAgentSkillPackage(inventory);
  publishManagedSkillVersion({
    registryId: input.registryId,
    versionId: inventory.treeDigest,
    quarantinePath: input.sourceDir,
    source: 'provider-lifecycle-test@immutable',
    scannerDigest: scan.scannerDigest,
    auditDigest: 'audit-pass',
    auditPolicyVersion: 'test-v1',
    bindings: authorizedManagedBindings({
      ownerId: 'owner', serverId: 'server-1', capabilityId: input.registryId,
      versionId: inventory.treeDigest, artifactDigest: inventory.treeDigest,
      auditDigest: 'audit-pass', bindings: input.bindings,
    }),
  }, input.homeDir);
  return {
    versionId: inventory.treeDigest,
    generationId: `${input.registryId}:${inventory.treeDigest}:${inventory.treeDigest}`,
  };
}

function generationFromStartup(startup: TransportMemoryRecallArtifact | undefined): string {
  const match = startup?.injectedText.match(/^generation: (.+)$/m);
  if (!match?.[1]) throw new Error('managed Skill generation missing from startup context');
  return match[1];
}

describe('managed Skill provider lifecycle contract', () => {
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('uses the exact IM.codes main/sub-session identity and wires both launch and restore bootstraps', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-provider-session-home-'));
    const mainSource = await mkdtemp(join(tmpdir(), 'imcodes-provider-main-source-'));
    const subSource = await mkdtemp(join(tmpdir(), 'imcodes-provider-sub-source-'));
    temporary.push(homeDir, mainSource, subSource);
    await publishSkill({
      homeDir,
      sourceDir: mainSource,
      registryId: 'main-session-registry',
      name: 'main-session-skill',
      instructions: 'Only the main session may see this instruction.',
      bindings: [{ scope: 'session', ownerId: 'owner', sessionId: 'deck_project_brain' }],
    });
    await publishSkill({
      homeDir,
      sourceDir: subSource,
      registryId: 'sub-session-registry',
      name: 'sub-session-skill',
      instructions: 'Only the exact sub-session may see this instruction.',
      bindings: [{ scope: 'session', ownerId: 'owner', sessionId: 'deck_project_w1' }],
    });

    const main = collectSkillStartupCandidates({
      namespace,
      homeDir,
      sessionId: 'deck_project_brain',
      serverId: 'server-1',
      featureEnabled: true,
    }).map((entry) => entry.text).join('\n');
    const sub = collectSkillStartupCandidates({
      namespace,
      homeDir,
      sessionId: 'deck_project_w1',
      serverId: 'server-1',
      featureEnabled: true,
    }).map((entry) => entry.text).join('\n');
    const other = collectSkillStartupCandidates({
      namespace,
      homeDir,
      sessionId: 'deck_project_w2',
      serverId: 'server-1',
      featureEnabled: true,
    }).map((entry) => entry.text).join('\n');

    expect(main).toContain('main-session-skill');
    expect(main).not.toContain('sub-session-skill');
    expect(sub).toContain('sub-session-skill');
    expect(sub).not.toContain('main-session-skill');
    expect(other).not.toContain('main-session-skill');
    expect(other).not.toContain('sub-session-skill');

    // Structural regression for the two real session-manager entry points:
    // daemon restore uses the stored record identity and launch/relaunch uses
    // the requested IM.codes name. Provider route IDs are deliberately not
    // accepted as substitutes for session-scoped binding authority.
    const sessionManager = await readFile('src/agent/session-manager.ts', 'utf8');
    expect(sessionManager).toMatch(/resolveTransportContextBootstrap\(\{\s*projectDir: s\.projectDir,\s*sessionId: s\.name,/);
    expect(sessionManager).toMatch(/resolveTransportContextBootstrap\(\{\s*projectDir,\s*sessionId: name,/);
  });

  it('re-resolves one immutable generation for cold launch/restore and every provider switch without installing again', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-provider-generation-home-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'imcodes-provider-generation-source-'));
    temporary.push(homeDir, sourceDir);
    const published = await publishSkill({
      homeDir,
      sourceDir,
      registryId: 'immutable-provider-registry',
      name: 'immutable-provider-skill',
      instructions: 'Use the immutable provider lifecycle workflow.',
      bindings: [{ scope: 'account', ownerId: 'owner' }],
    });
    const indexBefore = JSON.stringify(readManagedSkillIndex(homeDir));

    const firstLaunch = await buildTransportStartupMemory(namespace, {
      homeDir,
      sessionId: 'deck_project_brain',
      serverId: 'server-1',
      skillsFeatureEnabled: true,
      remoteItems: [],
    });
    const coldRestore = await buildTransportStartupMemory(namespace, {
      homeDir,
      sessionId: 'deck_project_brain',
      serverId: 'server-1',
      skillsFeatureEnabled: true,
      remoteItems: [],
      managedSkillsOnly: true,
    });
    expect(generationFromStartup(firstLaunch)).toBe(published.generationId);
    expect(generationFromStartup(coldRestore)).toBe(published.generationId);
    expect(coldRestore?.injectedText).toContain(
      `lifecycle-compaction: ${MANAGED_SKILL_PROVIDER_COMPATIBILITY.COMPACTION}`,
    );
    expect(coldRestore?.injectedText).toContain(
      `resources: Additional package resources are ${MANAGED_SKILL_PROVIDER_COMPATIBILITY.PACKAGED_RESOURCES}`,
    );

    const renderedGenerations = new Set<string>();
    for (const providerId of providerIds) {
      for (const userMessage of ['first turn', 'append while active', 'turn after provider relaunch']) {
        const payload = buildProviderContextPayload(provider(providerId), {
          userMessage,
          namespace,
          localProcessedFreshness: 'fresh',
          startupMemory: coldRestore,
        });
        expect(payload.messagePreamble, `${providerId}:${userMessage}`).toContain('capability-id: immutable-provider-registry');
        expect(payload.messagePreamble, `${providerId}:${userMessage}`).not.toContain('Use the immutable provider lifecycle workflow.');
        const match = payload.messagePreamble?.match(/^generation: (.+)$/m);
        expect(match?.[1], `${providerId}:${userMessage}`).toBe(published.generationId);
        if (match?.[1]) renderedGenerations.add(match[1]);
      }
    }
    expect([...renderedGenerations]).toEqual([published.generationId]);
    expect(JSON.stringify(readManagedSkillIndex(homeDir))).toBe(indexBefore);
    for (const nativeRoot of ['.claude/skills', '.codex/skills', '.pi/skills', '.dsh/skills']) {
      expect(existsSync(join(homeDir, nativeRoot)), nativeRoot).toBe(false);
    }
  });

  it('fails a previous generation closed after an audited version switch', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-provider-stale-home-'));
    const sourceV1 = await mkdtemp(join(tmpdir(), 'imcodes-provider-stale-v1-'));
    const sourceV2 = await mkdtemp(join(tmpdir(), 'imcodes-provider-stale-v2-'));
    temporary.push(homeDir, sourceV1, sourceV2);
    const first = await publishSkill({
      homeDir,
      sourceDir: sourceV1,
      registryId: 'stale-provider-registry',
      name: 'stale-provider-skill',
      instructions: 'Version one instructions.',
      bindings: [{ scope: 'account', ownerId: 'owner' }],
    });
    const firstResolution = resolveSkillByKey({
      namespace,
      homeDir,
      serverId: 'server-1',
      key: 'managed/stale-provider-skill',
      generationId: first.generationId,
    });
    expect(firstResolution).toMatchObject({ ok: true, generationId: first.generationId });

    const second = await publishSkill({
      homeDir,
      sourceDir: sourceV2,
      registryId: 'stale-provider-registry',
      name: 'stale-provider-skill',
      instructions: 'Version two instructions.',
      bindings: [{ scope: 'account', ownerId: 'owner' }],
    });
    expect(second.generationId).not.toBe(first.generationId);
    expect(resolveSkillByKey({
      namespace,
      homeDir,
      serverId: 'server-1',
      key: 'managed/stale-provider-skill',
      generationId: first.generationId,
    })).toEqual({
      ok: false,
      key: 'managed/stale-provider-skill',
      reason: 'stale_generation',
    });
    expect(resolveSkillByKey({
      namespace,
      homeDir,
      serverId: 'server-1',
      key: 'managed/stale-provider-skill',
      generationId: second.generationId,
    })).toMatchObject({ ok: true, generationId: second.generationId });
  });

  it('does not execute packaged scripts during admission, resolution, or provider projection', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-provider-script-home-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'imcodes-provider-script-source-'));
    const marker = join(homeDir, 'script-executed');
    temporary.push(homeDir, sourceDir);
    await publishSkill({
      homeDir,
      sourceDir,
      registryId: 'script-provider-registry',
      name: 'script-provider-skill',
      instructions: 'The packaged script is inventory only and must not execute.',
      bindings: [{ scope: 'account', ownerId: 'owner' }],
      script: `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`,
    });
    expect(existsSync(marker)).toBe(false);

    const startup = await buildTransportStartupMemory(namespace, {
      homeDir,
      serverId: 'server-1',
      skillsFeatureEnabled: true,
      remoteItems: [],
    });
    expect(startup?.injectedText).toContain('Never infer or read package files directly');
    expect(startup?.injectedText).not.toContain('The packaged script is inventory only');
    for (const providerId of providerIds) {
      buildProviderContextPayload(provider(providerId), {
        userMessage: 'Use the installed Skill',
        namespace,
        localProcessedFreshness: 'fresh',
        startupMemory: startup,
      });
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('keeps model/probe paths Skill-free and provider adapters free of native Skill writes', async () => {
    for (const providerName of ['claude-code-sdk', 'codex-sdk', 'pi', 'deepseek-harness']) {
      const source = readFileSync(join('src', 'agent', 'providers', `${providerName}.ts`), 'utf8');
      expect(source, providerName).not.toMatch(/skill-startup-context|managed-skill-store|publishManagedSkillVersion/);
      expect(source, providerName).not.toMatch(/\.claude\/skills|\.codex\/skills|\.pi\/skills|\.dsh\/skills/);
    }

    const { PiProvider } = await import('../../src/agent/providers/pi.js');
    const { DeepseekHarnessProvider } = await import('../../src/agent/providers/deepseek-harness.js');
    await expect(new PiProvider().listModels()).resolves.toEqual({ models: [] });
    await expect(new DeepseekHarnessProvider().listModels()).resolves.toEqual({ models: [] });
  });
});
