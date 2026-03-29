/**
 * Tests for IMCODES_SESSION env injection into session launches.
 * Verifies that session-manager and subsession-manager both inject the env var.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  newSession: vi.fn().mockResolvedValue(undefined),
  upsertSession: vi.fn(),
  getSession: vi.fn(() => null),
  sessionExists: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  upsertSession: mocks.upsertSession,
  getSession: mocks.getSession,
  removeSession: vi.fn(),
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  sessionExists: mocks.sessionExists,
  getPaneCwd: vi.fn().mockResolvedValue('/proj'),
  getPaneId: vi.fn().mockResolvedValue('%1'),
  cleanupOrphanFifos: vi.fn(),
  newSession: mocks.newSession,
  killSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingSpecificFile: vi.fn().mockResolvedValue(undefined),
  startWatchingById: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn().mockReturnValue(false),
  extractNewRolloutUuid: vi.fn().mockResolvedValue(null),
  findRolloutPathByUuid: vi.fn().mockResolvedValue(null),
  preClaimFile: vi.fn(),
  ensureSessionFile: vi.fn().mockResolvedValue(undefined),
  isFileClaimedByOther: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingFile: vi.fn().mockResolvedValue(undefined),
  isWatching: vi.fn().mockReturnValue(false),
  preClaimFile: vi.fn(),
  findJsonlPathBySessionId: vi.fn().mockReturnValue('/mock/session.jsonl'),
  ensureClaudeSessionFile: vi.fn().mockResolvedValue('/mock/seed.jsonl'),
}));

vi.mock('../../src/daemon/gemini-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingLatest: vi.fn().mockResolvedValue(undefined),
  isWatching: vi.fn().mockReturnValue(false),
  preClaimFile: vi.fn(),
  startWatchingDiscovered: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/signal.js', () => ({
  setupCCStopHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/notify-setup.js', () => ({
  setupCodexNotify: vi.fn().mockResolvedValue(undefined),
  setupOpenCodePlugin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(() => ({})), on: vi.fn() },
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: { read: vi.fn(() => []) },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { launchSession } from '../../src/agent/session-manager.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IMCODES_SESSION env injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionExists.mockResolvedValue(false);
  });

  it('injects IMCODES_SESSION into newSession env for shell agent', async () => {
    await launchSession({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'shell',
      projectDir: '/proj',
    });

    expect(mocks.newSession).toHaveBeenCalledOnce();
    const callArgs = mocks.newSession.mock.calls[0];
    // newSession(name, command, opts) — opts is 3rd arg
    const opts = callArgs[2];
    expect(opts.env).toBeDefined();
    expect(opts.env.IMCODES_SESSION).toBe('deck_proj_brain');
  });

  it('injects IMCODES_SESSION into newSession env for claude-code agent', async () => {
    await launchSession({
      name: 'deck_proj_w1',
      projectName: 'proj',
      role: 'w1',
      agentType: 'claude-code',
      projectDir: '/proj',
    });

    expect(mocks.newSession).toHaveBeenCalledOnce();
    const opts = mocks.newSession.mock.calls[0][2];
    expect(opts.env.IMCODES_SESSION).toBe('deck_proj_w1');
  });

  it('merges IMCODES_SESSION with existing extraEnv', async () => {
    await launchSession({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'shell',
      projectDir: '/proj',
      extraEnv: { RCC_AUTOFIX_MODE: '1' },
    });

    expect(mocks.newSession).toHaveBeenCalledOnce();
    const opts = mocks.newSession.mock.calls[0][2];
    expect(opts.env.IMCODES_SESSION).toBe('deck_proj_brain');
    expect(opts.env.RCC_AUTOFIX_MODE).toBe('1');
  });

  it('does not call newSession when tmux session already exists', async () => {
    mocks.sessionExists.mockResolvedValue(true);

    await launchSession({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'shell',
      projectDir: '/proj',
    });

    expect(mocks.newSession).not.toHaveBeenCalled();
  });
});
