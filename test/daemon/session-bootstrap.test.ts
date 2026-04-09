import { describe, expect, it } from 'vitest';

import { buildWorkerSessionPersistBody, mergeWorkerSessionSnapshot } from '../../src/daemon/session-bootstrap.js';

describe('buildWorkerSessionPersistBody', () => {
  it('serializes the current label so later daemon syncs do not wipe it', () => {
    const payload = buildWorkerSessionPersistBody({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'codex',
      projectDir: '/tmp/proj',
      state: 'idle',
      label: 'Readable Main',
      description: 'persona',
      requestedModel: 'gpt-5',
      activeModel: 'gpt-5',
      modelDisplay: 'GPT-5',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as any);

    expect(payload).toEqual(expect.objectContaining({
      projectName: 'proj',
      projectRole: 'brain',
      label: 'Readable Main',
      requestedModel: 'gpt-5',
      activeModel: 'gpt-5',
    }));
  });
});

describe('mergeWorkerSessionSnapshot', () => {
  it('hydrates the persisted main-session label from the worker snapshot', () => {
    const merged = mergeWorkerSessionSnapshot(undefined, {
      name: 'deck_proj_brain',
      project_name: 'proj',
      role: 'brain',
      agent_type: 'codex',
      project_dir: '/tmp/proj',
      state: 'idle',
      label: 'Readable Main',
    });

    expect(merged.label).toBe('Readable Main');
    expect(merged.projectName).toBe('proj');
  });

  it('clears a stale local label when the persisted worker snapshot has no label', () => {
    const merged = mergeWorkerSessionSnapshot({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'codex',
      projectDir: '/tmp/proj',
      state: 'idle',
      label: 'Stale Label',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    }, {
      name: 'deck_proj_brain',
      project_name: 'proj',
      role: 'brain',
      agent_type: 'codex',
      project_dir: '/tmp/proj',
      state: 'idle',
      label: null,
    });

    expect(merged.label).toBeUndefined();
  });
});
