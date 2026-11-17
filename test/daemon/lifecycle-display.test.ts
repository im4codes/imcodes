import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';

const { pairsForSessionMock } = vi.hoisted(() => ({
  pairsForSessionMock: vi.fn<(sessionName: string) => Array<{ state: { status: string; executor?: string; auditor?: string; brain?: string } }>>(() => []),
}));

vi.mock('../../src/daemon/task-pairs/store.js', () => ({
  getTaskPairStore: () => ({
    pairsForSession: pairsForSessionMock,
  }),
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: {
    readByTypesPreferred: vi.fn(),
    append: vi.fn(),
    cleanup: vi.fn(),
    truncateAll: vi.fn(),
    readPreferred: vi.fn(),
  },
}));

const { timelineStore } = await import('../../src/daemon/timeline-store.js');
const { timelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
const {
  getLastAssistantText,
  resolvePushDisplayContext,
  sendExternalMessageToSession,
  shouldRunGenericSilentActiveTurnRecovery,
  shouldSuppressSessionIdlePush,
} = await import('../../src/daemon/lifecycle.js');

const readByTypesPreferred = vi.mocked(timelineStore.readByTypesPreferred);

function session(overrides: Partial<SessionRecord> & { name: string }): SessionRecord {
  return {
    name: overrides.name,
    projectName: overrides.projectName ?? overrides.name,
    projectDir: overrides.projectDir ?? `/repo/${overrides.name}`,
    agentType: overrides.agentType ?? 'codex-sdk',
    state: overrides.state ?? 'idle',
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    ...overrides,
  } as SessionRecord;
}

describe('daemon lifecycle push display helpers', () => {
  afterEach(() => {
    vi.clearAllMocks();
    timelineEmitter.forgetSession('deck_alpha_brain');
  });

  it('uses readable child and parent labels for sub-session push context', () => {
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'Alpha Repo', label: 'Alpha' }),
      session({
        name: 'deck_sub_review_1',
        projectName: 'Review Worktree',
        label: 'Reviewer',
        parentSession: 'deck_alpha_brain',
      }),
    ];

    expect(resolvePushDisplayContext('deck_sub_review_1', sessions)).toEqual({
      project: 'Reviewer',
      label: 'Reviewer',
      parentLabel: 'Alpha',
    });
  });

  it('falls back through parent and project names without looping forever', () => {
    const sessions = [
      session({ name: 'deck_parent', projectName: 'Parent Project', parentSession: 'deck_child' }),
      session({ name: 'deck_child', projectName: 'Child Project', parentSession: 'deck_parent' }),
    ];

    expect(resolvePushDisplayContext('deck_child', sessions)).toEqual({
      project: 'Parent Project',
      parentLabel: 'Parent Project',
    });
    expect(resolvePushDisplayContext('missing_session', sessions)).toEqual({
      project: 'missing_session',
    });
  });

  it('returns the latest non-empty assistant text capped for push payloads', async () => {
    readByTypesPreferred.mockResolvedValueOnce([
      { type: 'assistant.text', payload: { text: 'first answer' } },
      { type: 'assistant.text', payload: { text: '   ' } },
      { type: 'assistant.text', payload: { text: 'x'.repeat(250) } },
    ] as never);

    await expect(getLastAssistantText('deck_alpha_brain')).resolves.toBe('x'.repeat(200));
    expect(readByTypesPreferred).toHaveBeenCalledWith('deck_alpha_brain', ['assistant.text'], { limit: 100 });
  });

  it('prefers live buffered assistant text over lagging projected timeline text', async () => {
    timelineEmitter.emit('deck_alpha_brain', 'assistant.text', {
      text: 'new answer that has not reached projection yet',
      streaming: false,
    });

    await expect(getLastAssistantText('deck_alpha_brain')).resolves.toBe('new answer that has not reached projection yet');
    expect(readByTypesPreferred).not.toHaveBeenCalled();
  });

  it('treats timeline read failures as missing push context', async () => {
    readByTypesPreferred.mockRejectedValueOnce(new Error('timeline unavailable'));

    await expect(getLastAssistantText('deck_alpha_brain')).resolves.toBeUndefined();
  });

  it('lets Codex and continue watchdog recovery own silent active-turn recovery', () => {
    expect(shouldRunGenericSilentActiveTurnRecovery({ agentType: 'codex-sdk' })).toBe(false);
    expect(shouldRunGenericSilentActiveTurnRecovery({ agentType: 'claude-code-sdk', providerId: 'codex-sdk' })).toBe(false);
    expect(shouldRunGenericSilentActiveTurnRecovery({ agentType: 'claude-code-sdk' })).toBe(true);
    expect(shouldRunGenericSilentActiveTurnRecovery({ agentType: 'claude-code-sdk' }, true)).toBe(false);
  });

  it('routes external chat messages through the runtime-neutral send boundary', async () => {
    const sender = vi.fn().mockResolvedValue(undefined);

    await sendExternalMessageToSession('deck_alpha_brain', 'message from chat bridge', sender);

    expect(sender).toHaveBeenCalledWith('deck_alpha_brain', 'message from chat bridge');
  });

  describe('shouldSuppressSessionIdlePush', () => {
    it('suppresses auto-created pair/send sessions, execution clones, and active pair executors/auditors', () => {
      pairsForSessionMock.mockReturnValue([]);

      expect(shouldSuppressSessionIdlePush('deck_sub_pair_auto_0123456789abcdef')).toBe(true);
      expect(shouldSuppressSessionIdlePush('deck_sub_send_auto_0123456789abcdef')).toBe(true);
      expect(shouldSuppressSessionIdlePush('deck_sub_manual_1', session({
        name: 'deck_sub_manual_1',
        pairCreatedMetadata: {
          autoCreated: true,
          source: 'pair_create',
          createdBy: 'deck_alpha_brain',
          reason: 'default_same_vendor_secondary',
          createdAt: 1,
        },
      }))).toBe(true);
      expect(shouldSuppressSessionIdlePush('deck_sub_clone_1', session({
        name: 'deck_sub_clone_1',
        executionCloneMetadata: {
          kind: 'execution_clone',
          templateSessionName: 'deck_sub_t1',
          parentSessionName: 'deck_alpha_brain',
          createdBySessionName: 'deck_alpha_brain',
          parentRunId: 'run-1',
          parentStage: 'generic_execution',
          createdAt: 1,
          hardTimeoutMs: 60_000,
          cleanupState: 'active',
        },
      }))).toBe(true);

      pairsForSessionMock.mockImplementation((name) => {
        if (name === 'deck_sub_exec' || name === 'deck_sub_aud' || name === 'deck_alpha_brain') {
          return [{
            state: {
              status: 'working',
              executor: 'deck_sub_exec',
              auditor: 'deck_sub_aud',
              brain: 'deck_alpha_brain',
            },
          }];
        }
        return [];
      });

      expect(shouldSuppressSessionIdlePush('deck_sub_exec')).toBe(true);
      expect(shouldSuppressSessionIdlePush('deck_sub_aud')).toBe(true);
      // Brain sessions must continue firing task_complete pushes normally.
      expect(shouldSuppressSessionIdlePush('deck_alpha_brain')).toBe(false);
    });

    it('allows normal main/manual sessions, terminal pairs, and uninitialized pair store fallback', () => {
      pairsForSessionMock.mockReturnValue([
        { state: { status: 'done', executor: 'deck_sub_exec', auditor: 'deck_sub_aud', brain: 'deck_alpha_brain' } },
        { state: { status: 'cancelled', executor: 'deck_sub_exec', auditor: 'deck_sub_aud', brain: 'deck_alpha_brain' } },
      ]);

      expect(shouldSuppressSessionIdlePush('deck_sub_exec')).toBe(false);
      expect(shouldSuppressSessionIdlePush('deck_sub_manual_1', session({ name: 'deck_sub_manual_1' }))).toBe(false);
      expect(shouldSuppressSessionIdlePush('deck_alpha_brain', session({ name: 'deck_alpha_brain' }))).toBe(false);

      pairsForSessionMock.mockImplementation(() => {
        throw new Error('store not initialized');
      });
      expect(shouldSuppressSessionIdlePush('deck_alpha_brain')).toBe(false);
      expect(shouldSuppressSessionIdlePush('deck_sub_pair_auto_fallback')).toBe(true);
    });
  });
});
