import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks must be hoisted via vi.hoisted so they exist when vi.mock factories run ──

const {
  upsertSessionMock, startWatchingMock, startWatchingFileMock,
  isWatchingMock, sessionExistsMock, newSessionMock, getDriverMock, getSessionMock,
  capturePaneMock, timelineReadMock,
} = vi.hoisted(() => ({
  upsertSessionMock: vi.fn(),
  startWatchingMock: vi.fn().mockResolvedValue(undefined),
  startWatchingFileMock: vi.fn().mockResolvedValue(undefined),
  isWatchingMock: vi.fn().mockReturnValue(false),
  sessionExistsMock: vi.fn().mockResolvedValue(false),
  newSessionMock: vi.fn().mockResolvedValue(undefined),
  getDriverMock: vi.fn(),
  getSessionMock: vi.fn(() => null),
  capturePaneMock: vi.fn().mockResolvedValue([]),
  timelineReadMock: vi.fn(() => []),
}));

vi.mock('../../src/store/session-store.js', () => ({
  upsertSession: upsertSessionMock,
  getSession: getSessionMock,
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  startWatchingFile: startWatchingFileMock,
  startWatching: startWatchingMock,
  stopWatching: vi.fn(),
  isWatching: isWatchingMock,
  claudeProjectDir: (dir: string) => `/mock-claude-projects/${dir.replace(/\//g, '-')}`,
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  newSession: newSessionMock,
  killSession: vi.fn().mockResolvedValue(undefined),
  sessionExists: sessionExistsMock,
  capturePane: capturePaneMock,
  sendKey: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getDriver: getDriverMock,
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: { read: timelineReadMock, append: vi.fn() },
}));

import { subSessionName, detectShells, startSubSession, readSubSessionResponse } from '../../src/daemon/subsession-manager.js';
import { upsertSession } from '../../src/store/session-store.js';
import { startWatchingFile, startWatching } from '../../src/daemon/jsonl-watcher.js';

describe('subSessionName()', () => {
  it('prefixes with deck_sub_', () => {
    expect(subSessionName('abc12345')).toBe('deck_sub_abc12345');
  });

  it('does not produce standard deck_ prefix', () => {
    // Must be distinguishable from normal sessions like deck_proj_brain
    const name = subSessionName('xyz');
    expect(name.startsWith('deck_sub_')).toBe(true);
    expect(name).not.toMatch(/deck_[^s]/);
  });
});

describe('detectShells()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns an array', async () => {
    const shells = await detectShells();
    expect(Array.isArray(shells)).toBe(true);
  });

  it('includes SHELL env var when it exists', async () => {
    const original = process.env.SHELL;
    // Only test if SHELL is set and the binary actually exists (CI may not have it)
    if (original) {
      const shells = await detectShells();
      // SHELL should be first in list if it exists on disk
      const { existsSync } = await import('node:fs');
      if (existsSync(original)) {
        expect(shells[0]).toBe(original);
      }
    }
  });

  it('returns no duplicates', async () => {
    const shells = await detectShells();
    const unique = new Set(shells);
    expect(unique.size).toBe(shells.length);
  });

  it('all returned paths are absolute', async () => {
    const shells = await detectShells();
    for (const s of shells) {
      expect(s.startsWith('/')).toBe(true);
    }
  });
});

// ── startSubSession: ccSessionId stored in session-store ─────────────────────
// Regression: sub-sessions were upserted without ccSessionId, causing
// restoreFromStore to fall back to startWatching (directory scan) which
// stole the main session's JSONL file on daemon restart.

describe('startSubSession — ccSessionId stored in session-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionExistsMock.mockResolvedValue(false);
    newSessionMock.mockResolvedValue(undefined);
    getDriverMock.mockReturnValue({
      buildLaunchCommand: () => 'claude --dangerously-skip-permissions --session-id test-id',
      postLaunch: undefined,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes ccSessionId to upsertSession for claude-code sub-sessions', async () => {
    await startSubSession({
      id: 'sub123',
      type: 'claude-code',
      cwd: '/proj',
      ccSessionId: 'abc-uuid-123',
    });

    expect(upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ ccSessionId: 'abc-uuid-123' }),
    );
  });

  it('calls startWatchingFile (not startWatching) for cc sub-session with ccSessionId', async () => {
    await startSubSession({
      id: 'sub456',
      type: 'claude-code',
      cwd: '/proj',
      ccSessionId: 'my-session-uuid',
    });

    expect(startWatchingFile).toHaveBeenCalledWith(
      'deck_sub_sub456',
      expect.stringContaining('my-session-uuid.jsonl'),
    );
    expect(startWatching).not.toHaveBeenCalled();
  });

  it('does NOT call startWatchingFile when ccSessionId is absent', async () => {
    await startSubSession({
      id: 'sub789',
      type: 'claude-code',
      cwd: '/proj',
      ccSessionId: null,
    });

    expect(startWatchingFile).not.toHaveBeenCalled();
    expect(startWatching).not.toHaveBeenCalled();
  });

  it('upsertSession has no ccSessionId when ccSessionId is null', async () => {
    await startSubSession({
      id: 'sub999',
      type: 'claude-code',
      cwd: '/proj',
      ccSessionId: null,
    });

    const call = vi.mocked(upsertSession).mock.calls[0]?.[0] as Record<string, unknown>;
    // ccSessionId should be undefined (not null, not the string 'null')
    expect(call.ccSessionId).toBeUndefined();
  });
});

describe('readSubSessionResponse()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionExistsMock.mockResolvedValue(true);
    capturePaneMock.mockResolvedValue(['still running']);
    timelineReadMock.mockReturnValue([
      { type: 'user.message', payload: { text: 'hi' } },
      { type: 'assistant.text', payload: { text: 'done' } },
    ]);
  });

  it('uses stored structured state for codex instead of terminal prompt detection', async () => {
    getSessionMock.mockReturnValue({ agentType: 'codex', state: 'running' });
    capturePaneMock.mockResolvedValue(['>']);

    const result = await readSubSessionResponse('deck_sub_1');

    expect(result).toEqual({ status: 'working' });
  });

  it('returns idle response for codex when stored state is idle', async () => {
    getSessionMock.mockReturnValue({ agentType: 'codex', state: 'idle' });
    capturePaneMock.mockResolvedValue(['still running looking pane']);

    const result = await readSubSessionResponse('deck_sub_2');

    expect(result).toEqual({ status: 'idle', response: 'done' });
  });

  it('still falls back to terminal detection for shell sessions', async () => {
    getSessionMock.mockReturnValue({ agentType: 'shell', state: 'running' });
    capturePaneMock.mockResolvedValue(['$']);

    const result = await readSubSessionResponse('deck_sub_3');

    expect(result).toEqual({ status: 'idle', response: 'done' });
  });
});
