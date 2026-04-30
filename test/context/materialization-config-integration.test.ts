import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import { localOnlyCompressor } from '../../src/context/summary-compressor.js';
import { setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';
import { DEFAULT_MEMORY_CONFIG } from '../../src/context/memory-config.js';
import { redactSensitiveText } from '../../src/util/redact-secrets.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('MaterializationCoordinator config integration', () => {
  let tempDir: string;
  let namespace: ContextNamespace;
  let target: ContextTargetRef;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('materialization-config-integration');
    setContextModelRuntimeConfig(null);
    namespace = { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' };
    target = { namespace, kind: 'session', sessionName: 'deck_repo_brain' };
  });

  afterEach(async () => {
    setContextModelRuntimeConfig(null);
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('uses materializationMinIntervalMs from cloud config to set the rate limit', async () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      materializationMinIntervalMs: 30_000,
    });
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor });
    expect(coordinator.thresholds.minIntervalMs).toBe(30_000);
  });

  it('falls back to default 10s rate limit when config has no materializationMinIntervalMs', async () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
    });
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor });
    expect(coordinator.thresholds.minIntervalMs).toBe(10_000);
  });

  it('allows explicit threshold override to take precedence over config materializationMinIntervalMs', async () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      materializationMinIntervalMs: 30_000,
    });
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { minIntervalMs: 5_000 },
    });
    expect(coordinator.thresholds.minIntervalMs).toBe(5_000);
  });

  it('stores primaryContextSdk and backupContextSdk in model config', async () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      primaryContextSdk: 'anthropic-sdk',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-4.1-mini',
      backupContextSdk: 'openai-sdk',
    });
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor });
    expect(coordinator.modelConfig.primaryContextSdk).toBe('anthropic-sdk');
    expect(coordinator.modelConfig.backupContextSdk).toBe('openai-sdk');
  });

  it('stores primaryContextPreset and backupContextPreset in model config', async () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'qwen',
      primaryContextModel: 'qwen3-coder-plus',
      primaryContextPreset: 'Qwen Team',
      backupContextBackend: 'qwen',
      backupContextModel: 'qwen3-coder-plus',
      backupContextPreset: 'Qwen Backup',
    });
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor });
    expect(coordinator.modelConfig.primaryContextPreset).toBe('Qwen Team');
    expect(coordinator.modelConfig.backupContextPreset).toBe('Qwen Backup');
  });

  it('records model+backend in materialized projection content', async () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'qwen',
      primaryContextModel: 'qwen3-coder-plus',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-4.1-mini',
    });
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'test', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'done', createdAt: 101 });

    const result = await coordinator.materializeTarget(target, 'manual', 500);

    expect(result.summaryProjection.content).toMatchObject({
      primaryContextBackend: 'qwen',
      primaryContextModel: 'qwen3-coder-plus',
      backupContextBackend: 'codex-sdk',
    });
    // backupContextModel is normalized by the config resolver — just verify it's present
    expect(typeof result.summaryProjection.content.backupContextModel).toBe('string');
  });

  it('enforces rate limit using config-derived minIntervalMs', async () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      materializationMinIntervalMs: 20_000,
    });
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 1 },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'first', createdAt: 100 });
    await coordinator.materializeTarget(target, 'manual', 100);

    // Within 20s cooldown — rate limited
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'second', createdAt: 10_000 });
    expect(coordinator.canMaterializeTarget(target, 10_000)).toBe(false);

    // After 20s cooldown — allowed
    expect(coordinator.canMaterializeTarget(target, 20_200)).toBe(true);
  });

  it('resolves memory config per namespace during automatic materialization', async () => {
    const otherNamespace: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/other', userId: 'user-1' };
    const seen: Array<{ projectId: string; redacted: string; maxEventChars: number | undefined }> = [];
    const coordinator = new MaterializationCoordinator({
      memoryConfigResolver: (ns) => ({
        ...DEFAULT_MEMORY_CONFIG,
        maxEventChars: ns.projectId.endsWith('/repo') ? 111 : 222,
        redactPatterns: [],
        extraRedactPatterns: ns.projectId.endsWith('/repo') ? [/repo-only-secret/g] : [/other-only-secret/g],
      }),
      compressor: async (input) => {
        const redacted = redactSensitiveText('repo-only-secret other-only-secret', input.extraRedactPatterns);
        seen.push({
          projectId: input.events[0]?.target.namespace.projectId ?? 'unknown',
          redacted,
          maxEventChars: input.maxEventChars,
        });
        return {
          summary: redacted,
          model: 'test',
          backend: 'test',
          usedBackup: false,
          fromSdk: true,
        };
      },
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });

    const otherTarget: ContextTargetRef = { namespace: otherNamespace, kind: 'session', sessionName: 'deck_other_brain' };
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'repo turn', createdAt: 100 });
    coordinator.ingestEvent({ target: otherTarget, eventType: 'user.turn', content: 'other turn', createdAt: 200 });

    await coordinator.materializeTarget(target, 'manual', 300);
    await coordinator.materializeTarget(otherTarget, 'manual', 400);

    expect(seen).toEqual([
      {
        projectId: namespace.projectId,
        redacted: '[REDACTED:custom] other-only-secret',
        maxEventChars: 111,
      },
      {
        projectId: otherNamespace.projectId,
        redacted: 'repo-only-secret [REDACTED:custom]',
        maxEventChars: 222,
      },
    ]);
  });
});
