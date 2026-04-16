import { describe, expect, it } from 'vitest';
import { buildWorkerSessionPersistBody, mergeWorkerSessionSnapshot } from '../../src/daemon/session-bootstrap.js';

describe('session bootstrap supervision persistence', () => {
  it('includes the resolved transportConfig supervision snapshot when persisting to the worker', () => {
    const body = buildWorkerSessionPersistBody({
      name: 'deck_proj_brain',
      projectName: 'demo',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: '/tmp/demo',
      state: 'running',
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: 'provider-session-1',
      transportConfig: {
        supervision: {
          mode: 'supervised_audit',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
          timeoutMs: 12_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          auditMode: 'audit',
          maxAuditLoops: 2,
          taskRunPromptVersion: 'task_run_status_v1',
        },
      },
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 2,
    });

    expect(body.transportConfig).toEqual(expect.objectContaining({
      supervision: expect.objectContaining({
        mode: 'supervised_audit',
        auditMode: 'audit',
      }),
    }));
  });

  it('preserves an existing session supervision snapshot when later worker defaults change elsewhere', () => {
    const existing = {
      name: 'deck_proj_brain',
      projectName: 'demo',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: '/tmp/demo',
      state: 'running',
      transportConfig: {
        supervision: {
          mode: 'supervised',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
          timeoutMs: 12_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          auditMode: 'audit',
          maxAuditLoops: 2,
          taskRunPromptVersion: 'task_run_status_v1',
        },
      },
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 2,
    } as const;

    const merged = mergeWorkerSessionSnapshot(existing as any, {
      name: 'deck_proj_brain',
      project_name: 'demo',
      role: 'brain',
      agent_type: 'codex-sdk',
      project_dir: '/tmp/demo',
      state: 'running',
      transport_config: null,
    });

    expect(merged.transportConfig).toEqual(existing.transportConfig);
  });
});
