import { describe, it, expect, vi, beforeEach } from 'vitest';

// The orchestrator drives real sub-sessions / tmux / file IO, so importing it
// (and exercising the failure path) requires stubbing those boundaries. We only
// assert requestId propagation — the additive-optional correlation field the web
// reconciler matches on (proposal FIX-1 / tasks 2.2, 2.3).
vi.mock('../../src/agent/tmux.js', () => ({
  sessionExists: vi.fn().mockResolvedValue(true),
  sendKeysDelayedEnter: vi.fn().mockResolvedValue(undefined),
}));

const startSubSessionMock = vi.fn();
const stopSubSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/daemon/subsession-manager.js', () => ({
  startSubSession: (...args: unknown[]) => startSubSessionMock(...args),
  stopSubSession: (...args: unknown[]) => stopSubSessionMock(...args),
  rebuildSubSessions: vi.fn(),
  detectShells: vi.fn().mockResolvedValue([]),
  readSubSessionResponse: vi.fn().mockResolvedValue({ status: 'idle' }),
  subSessionName: (id: string) => `deck_sub_${id}`,
}));

import { startDiscussion, buildRunningTransitionRelay } from '../../src/daemon/discussion-orchestrator.js';

describe('discussion-orchestrator — requestId propagation', () => {
  beforeEach(() => {
    startSubSessionMock.mockReset();
    stopSubSessionMock.mockReset().mockResolvedValue(undefined);
  });

  describe('setup→running transition relay (2.2 / D3)', () => {
    it('relays a discussion.update carrying requestId so a pending optimistic card can match', () => {
      const relay = buildRunningTransitionRelay({
        id: 'disc-1', requestId: 'req-abc', maxRounds: 3, filePath: '/p/.imc/discussions/x-title.md',
      });
      expect(relay).toMatchObject({
        type: 'discussion.update',
        discussionId: 'disc-1',
        requestId: 'req-abc',
        state: 'running',
        currentRound: 0,
        maxRounds: 3,
        currentSpeaker: null,
        filePath: '/p/.imc/discussions/x-title.md',
      });
    });

    it('keeps requestId additive-optional (absent when the discussion has none)', () => {
      const relay = buildRunningTransitionRelay({ id: 'd2', requestId: undefined, maxRounds: 2, filePath: '' });
      expect(relay.requestId).toBeUndefined();
      expect(relay).toMatchObject({ type: 'discussion.update', discussionId: 'd2', state: 'running' });
    });
  });

  describe('runtime failure (2.3 / FIX-1)', () => {
    it('emits discussion.error carrying requestId when the run throws', async () => {
      startSubSessionMock.mockRejectedValue(new Error('spawn failed'));
      const onUpdate = vi.fn();

      await startDiscussion(
        {
          id: 'disc-err',
          serverId: 'srv1',
          requestId: 'req-err',
          topic: 'Should we ship?',
          cwd: '/tmp/proj',
          participants: [
            { agentType: 'claude-code', roleId: 'critic' },
            { agentType: 'claude-code', roleId: 'pragmatist' },
          ],
          maxRounds: 1,
        },
        onUpdate,
      );

      await vi.waitFor(() => {
        expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
          type: 'discussion.error',
          discussionId: 'disc-err',
          requestId: 'req-err',
          error: 'spawn failed',
        }));
      });
    });
  });
});
