import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import { setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';
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

  it('uses materializationMinIntervalMs from cloud config to set the rate limit', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      materializationMinIntervalMs: 30_000,
    });
    const coordinator = new MaterializationCoordinator();
    expect(coordinator.thresholds.minIntervalMs).toBe(30_000);
  });

  it('falls back to default 10s rate limit when config has no materializationMinIntervalMs', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
    });
    const coordinator = new MaterializationCoordinator();
    expect(coordinator.thresholds.minIntervalMs).toBe(10_000);
  });

  it('allows explicit threshold override to take precedence over config materializationMinIntervalMs', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      materializationMinIntervalMs: 30_000,
    });
    const coordinator = new MaterializationCoordinator({
      thresholds: { minIntervalMs: 5_000 },
    });
    expect(coordinator.thresholds.minIntervalMs).toBe(5_000);
  });

  it('stores primaryContextSdk and backupContextSdk in model config', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      primaryContextSdk: 'anthropic-sdk',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-4.1-mini',
      backupContextSdk: 'openai-sdk',
    });
    const coordinator = new MaterializationCoordinator();
    expect(coordinator.modelConfig.primaryContextSdk).toBe('anthropic-sdk');
    expect(coordinator.modelConfig.backupContextSdk).toBe('openai-sdk');
  });

  it('records model+backend in materialized projection content', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'qwen',
      primaryContextModel: 'qwen3-coder-plus',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-4.1-mini',
    });
    const coordinator = new MaterializationCoordinator({
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'test', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'done', createdAt: 101 });

    const result = coordinator.materializeTarget(target, 'manual', 500);

    expect(result.summaryProjection.content).toMatchObject({
      primaryContextBackend: 'qwen',
      primaryContextModel: 'qwen3-coder-plus',
      backupContextBackend: 'codex-sdk',
    });
    // backupContextModel is normalized by the config resolver — just verify it's present
    expect(typeof result.summaryProjection.content.backupContextModel).toBe('string');
  });

  it('enforces rate limit using config-derived minIntervalMs', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      materializationMinIntervalMs: 20_000,
    });
    const coordinator = new MaterializationCoordinator({
      thresholds: { eventCount: 1 },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'first', createdAt: 100 });
    coordinator.materializeTarget(target, 'manual', 100);

    // Within 20s cooldown — rate limited
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'second', createdAt: 10_000 });
    expect(coordinator.canMaterializeTarget(target, 10_000)).toBe(false);

    // After 20s cooldown — allowed
    expect(coordinator.canMaterializeTarget(target, 20_200)).toBe(true);
  });
});
