import { describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import { PREFERENCE_MAX_BYTES } from '../../shared/preference-ingest.js';
import { MEMORY_MCP_CAPS } from '../../shared/memory-mcp-contracts.js';
import { createMemoryToolCaller } from '../../src/context/memory-read-tools.js';
import { saveObservation, savePreference } from '../../src/context/memory-write-tools.js';
import type { ContextNamespaceRow, ContextObservationRow } from '../../src/store/context-store.js';

function namespaceRow(overrides: Partial<ContextNamespaceRow> = {}): ContextNamespaceRow {
  return {
    id: 'ns-1',
    localTenant: 'local',
    scope: 'user_private',
    key: 'scope:user_private/user:user-1',
    visibility: 'private',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function observationRow(overrides: Partial<ContextObservationRow> = {}): ContextObservationRow {
  return {
    id: 'obs-1',
    namespaceId: 'ns-1',
    scope: 'user_private',
    class: 'note',
    origin: 'agent_learned',
    fingerprint: 'fp',
    content: {},
    textHash: 'hash',
    sourceEventIds: [],
    state: 'candidate',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('memory MCP write tools', () => {
  const namespace: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' };
  const caller = createMemoryToolCaller({
    userId: 'user-1',
    namespace,
    sourceSessionName: 'deck_sub_worker',
    sourceProjectName: 'proj',
    sourceServerId: 'srv-1',
  });

  it('saves observations with fixed identity fields and computed fingerprint', async () => {
    const ensureContextNamespace = vi.fn(() => namespaceRow());
    const writeContextObservation = vi.fn((input) => observationRow({
      id: 'obs-1',
      fingerprint: input.fingerprint,
      content: input.content,
      sourceEventIds: input.sourceEventIds ?? [],
    }));

    const result = await saveObservation({
      content: 'Use the MCP caller boundary',
      tags: ['mcp'],
      turnId: 'turn-1',
      userId: 'mallory',
      namespace: { scope: 'org_shared' },
      scope: 'project_shared',
      state: 'active',
      origin: 'user_note',
      fingerprint: 'forged',
      sourceSessionName: 'deck_sub_forged',
      sourceProjectName: 'other',
      sourceServerId: 'srv-forged',
      projectRoot: '/tmp/secret',
    }, caller, { ensureContextNamespace, writeContextObservation, now: () => 123 });

    expect(result).toMatchObject({ status: 'ok', observationId: 'obs-1', state: 'candidate' });
    expect(ensureContextNamespace).toHaveBeenCalledWith({
      scope: 'user_private',
      projectId: 'github.com/acme/repo',
      userId: 'user-1',
    }, 123);
    expect(writeContextObservation).toHaveBeenCalledWith(expect.objectContaining({
      namespaceId: 'ns-1',
      scope: 'user_private',
      class: 'note',
      origin: 'agent_learned',
      state: 'candidate',
      sourceEventIds: ['turn-1'],
      content: expect.objectContaining({
        text: 'Use the MCP caller boundary',
        tags: ['mcp'],
        ownerUserId: 'user-1',
        sourceSessionName: 'deck_sub_worker',
        sourceProjectName: 'proj',
        sourceServerId: 'srv-1',
      }),
    }));
    expect(writeContextObservation.mock.calls[0][0].fingerprint).not.toBe('forged');
    expect(JSON.stringify(writeContextObservation.mock.calls[0][0])).not.toContain('mallory');
    expect(JSON.stringify(writeContextObservation.mock.calls[0][0])).not.toContain('deck_sub_forged');
    expect(JSON.stringify(writeContextObservation.mock.calls[0][0])).not.toContain('/tmp/secret');
  });

  it('rejects observation caps before persistence', async () => {
    const writeContextObservation = vi.fn();
    const oversized = 'a'.repeat(MEMORY_MCP_CAPS.OBSERVATION_CONTENT_MAX_BYTES + 1);
    expect(await saveObservation({ content: oversized }, caller, { writeContextObservation })).toMatchObject({
      status: 'error',
      reason: 'write_quota_exceeded',
    });
    expect(await saveObservation({ content: 'ok', tags: Array.from({ length: 9 }, (_, index) => `t${index}`) }, caller, { writeContextObservation })).toMatchObject({
      reason: 'write_quota_exceeded',
    });
    expect(await saveObservation({ content: 'ok', tags: ['x'.repeat(65)] }, caller, { writeContextObservation })).toMatchObject({
      reason: 'write_quota_exceeded',
    });
    expect(writeContextObservation).not.toHaveBeenCalled();
  });

  it('rejects agent observations when the caller has no project scope', async () => {
    const scopedOutCaller = createMemoryToolCaller({
      userId: 'user-1',
      namespace: { scope: 'personal', userId: 'user-1' },
    });
    const writeContextObservation = vi.fn();

    expect(await saveObservation({ content: 'projectless observation' }, scopedOutCaller, { writeContextObservation })).toMatchObject({
      status: 'error',
      reason: 'scope_forbidden',
    });
    expect(writeContextObservation).not.toHaveBeenCalled();
  });

  it('saves preferences through explicit observation writes without @pref parsing authority', async () => {
    const ensureContextNamespace = vi.fn(() => namespaceRow());
    const writeContextObservation = vi.fn((input) => observationRow({
      id: 'pref-1',
      class: input.class,
      origin: input.origin,
      state: input.state,
      fingerprint: input.fingerprint,
      content: input.content,
    }));

    const result = await savePreference({
      text: '@pref: Keep tests focused',
      idempotencyKey: 'pref-key',
      origin: 'agent_learned',
      state: 'candidate',
      sourceSessionName: 'deck_sub_forged',
    }, caller, { ensureContextNamespace, writeContextObservation });

    expect(result).toMatchObject({ status: 'ok', observationId: 'pref-1', state: 'active' });
    expect(ensureContextNamespace).toHaveBeenCalledWith({
      scope: 'user_private',
      userId: 'user-1',
      name: 'preferences',
    }, undefined);
    expect(writeContextObservation).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'user_private',
      class: 'preference',
      origin: 'user_note',
      state: 'active',
      content: expect.objectContaining({
        text: '@pref: Keep tests focused',
        idempotencyKey: 'pref-key',
        sourceSessionName: 'deck_sub_worker',
        sourceProjectName: 'proj',
        sourceServerId: 'srv-1',
      }),
    }));
  });

  it('caps preference text by shared preference max bytes', async () => {
    const writeContextObservation = vi.fn();
    expect(await savePreference({ text: 'a'.repeat(PREFERENCE_MAX_BYTES + 1) }, caller, { writeContextObservation })).toMatchObject({
      status: 'error',
      reason: 'write_quota_exceeded',
    });
    expect(writeContextObservation).not.toHaveBeenCalled();
  });
});
