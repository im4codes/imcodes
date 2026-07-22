import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';

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
});
