import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upsertSession: vi.fn(),
  newSession: vi.fn().mockResolvedValue(undefined),
  listOpenCodeSessions: vi.fn().mockResolvedValue([{ id: 'old-session', title: 'old', updated: 1, created: 1, directory: '/proj' }]),
  discoverOpenCodeSessionId: vi.fn().mockResolvedValue('oc-main-uuid'),
  startOpenCodeWatching: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  upsertSession: mocks.upsertSession,
  getSession: vi.fn(() => null),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  sessionExists: vi.fn().mockResolvedValue(false),
  getPaneCwd: vi.fn().mockResolvedValue('/proj'),
  getPaneId: vi.fn().mockResolvedValue('%1'),
  cleanupOrphanFifos: vi.fn(),
  newSession: mocks.newSession,
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingFile: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn().mockReturnValue(false),
  findJsonlPathBySessionId: vi.fn(),
  ensureClaudeSessionFile: vi.fn().mockResolvedValue('/mock/claude-seed.jsonl'),
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingSpecificFile: vi.fn().mockResolvedValue(undefined),
  startWatchingById: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn().mockReturnValue(false),
  findRolloutPathByUuid: vi.fn().mockResolvedValue(null),
  ensureSessionFile: vi.fn().mockResolvedValue('/mock/codex-rollout.jsonl'),
}));

vi.mock('../../src/daemon/gemini-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  isWatching: vi.fn().mockReturnValue(false),
  stopWatching: vi.fn(),
}));

vi.mock('../../src/daemon/opencode-watcher.js', () => ({
  startWatching: mocks.startOpenCodeWatching,
  stopWatching: vi.fn(),
  isWatching: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/daemon/opencode-history.js', () => ({
  listOpenCodeSessions: mocks.listOpenCodeSessions,
  waitForOpenCodeSessionId: mocks.discoverOpenCodeSessionId,
}));

vi.mock('../../src/agent/agent-version.js', () => ({
  getAgentVersion: vi.fn().mockResolvedValue('test-version'),
}));

vi.mock('../../src/agent/signal.js', () => ({
  setupCCStopHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/notify-setup.js', () => ({
  setupCodexNotify: vi.fn().mockResolvedValue(undefined),
  setupOpenCodePlugin: vi.fn().mockResolvedValue(undefined),
}));

import { launchSession } from '../../src/agent/session-manager.js';

describe('launchSession — OpenCode ID handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('discovers and persists opencodeSessionId after first launch', async () => {
    await launchSession({
      name: 'deck_opencode_brain',
      projectName: 'test',
      role: 'brain',
      agentType: 'opencode',
      projectDir: '/proj',
    });

    const launchCmd = mocks.newSession.mock.calls[0]?.[1];
    expect(launchCmd).toContain('opencode');
    expect(launchCmd).not.toContain(' -s ');
    expect(launchCmd).not.toContain(' -c ');

    const upsertCalls = mocks.upsertSession.mock.calls;
    const lastRecord = upsertCalls[upsertCalls.length - 1][0];
    expect(lastRecord.opencodeSessionId).toBe('oc-main-uuid');
    expect(lastRecord.state).toBe('idle');
    expect(mocks.discoverOpenCodeSessionId).toHaveBeenCalledWith('/proj', expect.objectContaining({
      exactDirectory: '/proj',
      knownSessionIds: ['old-session'],
    }));
    expect(mocks.startOpenCodeWatching).toHaveBeenCalledWith('deck_opencode_brain', '/proj', 'oc-main-uuid');
  });
});
