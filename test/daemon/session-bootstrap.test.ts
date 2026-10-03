import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildWorkerSessionPersistBody,
  mergeWorkerSessionSnapshot,
  shouldPersistMainSessionToWorkerOnStartup,
} from '../../src/daemon/session-bootstrap.js';

describe('session bootstrap supervision persistence', () => {
  it('wires restored transport snapshots into automation before automation init', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/daemon/lifecycle.ts'), 'utf8');
    const restoreWire = source.indexOf('setTransportSessionRestoredCallback((sessionName) => {');
    const applyWire = source.indexOf('supervisionAutomation.applyPersistedSnapshot(sessionName);', restoreWire);
    const automationInit = source.indexOf('supervisionAutomation.init();');

    expect(restoreWire).toBeGreaterThan(-1);
    expect(applyWire).toBeGreaterThan(restoreWire);
    expect(automationInit).toBeGreaterThan(applyWire);
  });

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

  it('does not push sub-sessions through the main session startup sync path', () => {
    const main = {
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: '/tmp/proj',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 2,
    } as const;

    expect(shouldPersistMainSessionToWorkerOnStartup(main as any)).toBe(true);
    expect(shouldPersistMainSessionToWorkerOnStartup({
      ...main,
      name: 'deck_sub_abc123',
      parentSession: 'deck_proj_brain',
    } as any)).toBe(false);
    expect(shouldPersistMainSessionToWorkerOnStartup({
      ...main,
      state: 'stopped',
    } as any)).toBe(false);
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

  it('preserves local supervision when the worker row still holds the default empty transport_config', () => {
    // Regression: users reported auto mode "turning itself off" because the daemon's
    // startup sync clobbered the local supervision snapshot with the server's default
    // `{}` column value. The merge must layer existing under the server snapshot.
    const existing = {
      name: 'deck_proj_brain',
      projectName: 'demo',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/tmp/demo',
      state: 'running',
      transportConfig: {
        supervision: {
          mode: 'supervised',
          backend: 'claude-code-sdk',
          model: 'claude-sonnet-4-5',
          timeoutMs: 30_000,
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
      agent_type: 'claude-code-sdk',
      project_dir: '/tmp/demo',
      state: 'running',
      transport_config: {}, // server default
    });

    expect(merged.transportConfig).toEqual(existing.transportConfig);
  });

  it('lets the server override individual transport_config keys while preserving untouched ones', () => {
    const existing = {
      name: 'deck_proj_brain',
      projectName: 'demo',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/tmp/demo',
      state: 'running',
      transportConfig: {
        supervision: { mode: 'supervised', backend: 'claude-code-sdk', model: 'claude-sonnet-4-5', timeoutMs: 30_000, promptVersion: 'supervision_decision_v1', maxParseRetries: 1, auditMode: 'audit', maxAuditLoops: 2, taskRunPromptVersion: 'task_run_status_v1' },
        customFlag: 'local',
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
      agent_type: 'claude-code-sdk',
      project_dir: '/tmp/demo',
      state: 'running',
      transport_config: { customFlag: 'server' },
    });

    expect((merged.transportConfig as any).customFlag).toBe('server');
    expect((merged.transportConfig as any).supervision).toEqual(existing.transportConfig.supervision);
  });
});
