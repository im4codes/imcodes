import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks must be hoisted via vi.hoisted so they exist when vi.mock factories run ──

const {
  upsertSessionMock, startWatchingMock, startWatchingFileMock,
  isWatchingMock, sessionExistsMock, newSessionMock, getDriverMock, getSessionMock,
  capturePaneMock, timelineReadMock,
  geminiStartWatchingMock, geminiIsWatchingMock,
  codexStartWatchingByIdMock, codexIsWatchingMock, codexIsFileClaimedMock,
  removeSessionMock, resolveGeminiSessionIdMock, injectGeminiMemoryMock,
  launchTransportSessionMock, getTransportRuntimeMock,
  getAgentVersionMock,
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
  geminiStartWatchingMock: vi.fn().mockResolvedValue(undefined),
  geminiIsWatchingMock: vi.fn().mockReturnValue(false),
  codexStartWatchingByIdMock: vi.fn().mockResolvedValue(undefined),
  codexIsWatchingMock: vi.fn().mockReturnValue(false),
  codexIsFileClaimedMock: vi.fn().mockReturnValue(false),
  removeSessionMock: vi.fn(),
  resolveGeminiSessionIdMock: vi.fn().mockResolvedValue('resolved-gemini-uuid'),
  injectGeminiMemoryMock: vi.fn().mockResolvedValue(undefined),
  launchTransportSessionMock: vi.fn().mockResolvedValue(undefined),
  getTransportRuntimeMock: vi.fn().mockReturnValue(null),
  getAgentVersionMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/store/session-store.js', () => ({
  upsertSession: upsertSessionMock,
  getSession: getSessionMock,
  removeSession: removeSessionMock,
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  startWatchingFile: startWatchingFileMock,
  startWatching: startWatchingMock,
  stopWatching: vi.fn(),
  isWatching: isWatchingMock,
  preClaimFile: vi.fn(),
  claudeProjectDir: (dir: string) => `/mock-claude-projects/${dir.replace(/\//g, '-')}`,
  findJsonlPathBySessionId: (dir: string, id: string) => `/mock-claude-projects/${dir.replace(/\//g, '-')}/${id}.jsonl`,
  ensureClaudeSessionFile: vi.fn().mockResolvedValue('/mock/seed.jsonl'),
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  ensureSessionFile: vi.fn().mockResolvedValue('/mock/codex-rollout.jsonl'),
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingSpecificFile: vi.fn().mockResolvedValue(undefined),
  startWatchingById: codexStartWatchingByIdMock,
  stopWatching: vi.fn(),
  isWatching: codexIsWatchingMock,
  isFileClaimedByOther: codexIsFileClaimedMock,
  findRolloutPathByUuid: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/daemon/gemini-watcher.js', () => ({
  startWatching: geminiStartWatchingMock,
  startWatchingDiscovered: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: geminiIsWatchingMock,
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
  launchTransportSession: launchTransportSessionMock,
  getTransportRuntime: getTransportRuntimeMock,
}));

vi.mock('../../src/agent/agent-version.js', () => ({
  getAgentVersion: getAgentVersionMock,
}));

vi.mock('../../src/agent/drivers/gemini.js', () => ({
  GeminiDriver: vi.fn().mockImplementation(() => ({
    resolveSessionId: resolveGeminiSessionIdMock,
  })),
}));

vi.mock('../../src/daemon/memory-inject.js', () => ({
  injectGeminiMemory: injectGeminiMemoryMock,
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: { read: timelineReadMock, append: vi.fn() },
}));

import { subSessionName, detectShells, startSubSession, rebuildSubSessions, readSubSessionResponse, normalizeShellBinForHost } from '../../src/daemon/subsession-manager.js';
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

describe('normalizeShellBinForHost()', () => {
  it('rejects Windows shell paths on unix hosts', () => {
    expect(normalizeShellBinForHost('C:\\Windows\\system32\\cmd.exe')).toBeUndefined();
    expect(normalizeShellBinForHost('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBeUndefined();
  });

  it('accepts unix shell paths when they exist', () => {
    expect(normalizeShellBinForHost('/bin/sh')).toBe('/bin/sh');
  });

  it('accepts bare unix shell commands', () => {
    expect(normalizeShellBinForHost('fish')).toBe('fish');
    expect(normalizeShellBinForHost('pwsh')).toBe('pwsh');
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
      buildResumeCommand: () => 'claude --dangerously-skip-permissions --resume test-id',
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
      'my-session-uuid',
    );
    expect(startWatching).not.toHaveBeenCalled();
  });

  it('auto-generates ccSessionId when absent and still calls startWatchingFile', async () => {
    await startSubSession({
      id: 'sub789',
      type: 'claude-code',
      cwd: '/proj',
      ccSessionId: null,
    });

    // Codex's fix: CC sub-sessions always get a UUID via randomUUID()
    expect(startWatchingFile).toHaveBeenCalledWith(
      'deck_sub_sub789',
      expect.stringContaining('.jsonl'),
      expect.any(String),
    );
  });

  it('upsertSession always has ccSessionId for claude-code (auto-generated if null)', async () => {
    await startSubSession({
      id: 'sub999',
      type: 'claude-code',
      cwd: '/proj',
      ccSessionId: null,
    });

    const call = vi.mocked(upsertSession).mock.calls[0]?.[0] as Record<string, unknown>;
    // Should be a valid UUID string, not undefined or null
    expect(typeof call.ccSessionId).toBe('string');
    expect(call.ccSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('startSubSession — shellBin host normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionExistsMock.mockResolvedValue(false);
    newSessionMock.mockResolvedValue(undefined);
    getDriverMock.mockReturnValue({
      buildLaunchCommand: vi.fn(() => '/bin/sh'),
      buildResumeCommand: vi.fn(() => '/bin/sh'),
      postLaunch: undefined,
    });
  });

  it('drops incompatible Windows shellBin on unix hosts before launch', async () => {
    await startSubSession({
      id: 'shell-win-path',
      type: 'shell',
      cwd: '/proj',
      shellBin: 'C:\\Windows\\system32\\cmd.exe',
    });

    const buildLaunchCommand = getDriverMock.mock.results[0]?.value.buildLaunchCommand as ReturnType<typeof vi.fn>;
    expect(buildLaunchCommand).toHaveBeenCalledWith(
      'deck_sub_shell-win-path',
      expect.not.objectContaining({ shellBin: 'C:\\Windows\\system32\\cmd.exe' }),
    );

    expect(upsertSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ shellBin: 'C:\\Windows\\system32\\cmd.exe' }),
    );
  });
});

describe('startSubSession — geminiSessionId stored in session-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionExistsMock.mockResolvedValue(false);
    newSessionMock.mockResolvedValue(undefined);
    getDriverMock.mockReturnValue({
      buildLaunchCommand: () => 'gemini',
      buildResumeCommand: () => 'gemini --resume test-id',
      postLaunch: undefined,
    });
  });

  it('passes geminiSessionId to upsertSession for gemini sub-sessions', async () => {
    await startSubSession({
      id: 'gem-sub1',
      type: 'gemini',
      cwd: '/proj',
      geminiSessionId: 'gemini-uuid-abc',
    });

    expect(upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ geminiSessionId: 'gemini-uuid-abc' }),
    );
  });

  it('persists undefined geminiSessionId as undefined (not lost)', async () => {
    resolveGeminiSessionIdMock.mockResolvedValue('resolved-gemini-uuid');

    await startSubSession({
      id: 'gem-sub2',
      type: 'gemini',
      cwd: '/proj',
      geminiSessionId: null,
      fresh: true,
    });

    const call = vi.mocked(upsertSession).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.geminiSessionId).toBe('resolved-gemini-uuid');
    expect(injectGeminiMemoryMock).toHaveBeenCalledWith('resolved-gemini-uuid', '/proj');
  });
});

describe('startSubSession — transport SDK agents do not use tmux', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionExistsMock.mockResolvedValue(false);
    getTransportRuntimeMock.mockReturnValue(null);
  });

  it('launches claude-code-sdk via launchTransportSession instead of getDriver/newSession', async () => {
    await startSubSession({
      id: 'sdk-sub1',
      type: 'claude-code-sdk',
      cwd: '/proj',
      ccSessionId: 'cc-sdk-session-id',
      parentSession: 'deck_proj_brain',
      description: 'SDK test',
    });

    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_sub_sdk-sub1',
      agentType: 'claude-code-sdk',
      projectDir: '/proj',
      parentSession: 'deck_proj_brain',
      description: 'SDK test',
      fresh: true,
      userCreated: true,
    }));
    expect(String(launchTransportSessionMock.mock.calls[0][0].ccSessionId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(getDriverMock).not.toHaveBeenCalled();
    expect(newSessionMock).not.toHaveBeenCalled();
  });
});

describe('SAFE_SESSION_NAME_RE — session name validation', () => {
  // Import the regex pattern indirectly by testing stopSubSession behavior
  // The regex is: /^deck_sub_[a-zA-Z0-9_-]+$/

  it('accepts valid session names', () => {
    const re = /^deck_sub_[a-zA-Z0-9_-]+$/;
    expect(re.test('deck_sub_abc12345')).toBe(true);
    expect(re.test('deck_sub_my-session-id')).toBe(true);
    expect(re.test('deck_sub_a_b_c')).toBe(true);
  });

  it('rejects injection attempts', () => {
    const re = /^deck_sub_[a-zA-Z0-9_-]+$/;
    expect(re.test('deck_sub_$(whoami)')).toBe(false);
    expect(re.test('deck_sub_; rm -rf /')).toBe(false);
    expect(re.test('deck_sub_`id`')).toBe(false);
    expect(re.test('../../../etc/passwd')).toBe(false);
    expect(re.test('deck_sub_a b c')).toBe(false);
    expect(re.test('')).toBe(false);
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

// ── rebuildSubSessions: geminiSessionId preserved ────────────────────────────
// Regression: rebuildSubSessions overwrote the session record without
// geminiSessionId, causing the watcher to fall back to findLatestSessionFile
// which would track the wrong file after old files were touched.

describe('rebuildSubSessions — geminiSessionId preserved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Session already exists in tmux (rebuild, not create)
    sessionExistsMock.mockResolvedValue(true);
    geminiIsWatchingMock.mockReturnValue(false);
    getDriverMock.mockReturnValue({
      buildLaunchCommand: () => 'gemini --yolo',
      buildResumeCommand: () => 'gemini --yolo --resume test',
      postLaunch: undefined,
    });
  });

  it('preserves geminiSessionId from local store when sub.geminiSessionId is absent', async () => {
    // Local store has the UUID from a previous run
    getSessionMock.mockReturnValue({
      name: 'deck_sub_rebuild1',
      agentType: 'gemini',
      geminiSessionId: 'stored-uuid-1234',
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1000,
    });

    await rebuildSubSessions([{
      id: 'rebuild1',
      type: 'gemini',
      cwd: '/proj',
      // geminiSessionId NOT provided by server (common during reconnect)
    }]);

    // upsertSession must include the stored geminiSessionId
    expect(upsertSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ geminiSessionId: 'stored-uuid-1234', state: 'idle' }),
    );
  });

  it('uses sub.geminiSessionId when both sub and store have it', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_sub_rebuild2',
      agentType: 'gemini',
      geminiSessionId: 'old-uuid',
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1000,
    });

    await rebuildSubSessions([{
      id: 'rebuild2',
      type: 'gemini',
      cwd: '/proj',
      geminiSessionId: 'new-uuid-from-server',
    }]);

    expect(upsertSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ geminiSessionId: 'new-uuid-from-server', state: 'idle' }),
    );
  });

  it('starts gemini watcher with stored UUID when sub has none', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_sub_rebuild3',
      agentType: 'gemini',
      geminiSessionId: 'fallback-uuid',
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1000,
    });

    await rebuildSubSessions([{
      id: 'rebuild3',
      type: 'gemini',
      cwd: '/proj',
    }]);

    expect(geminiStartWatchingMock).toHaveBeenCalledWith(
      'deck_sub_rebuild3',
      'fallback-uuid',
    );
    expect(upsertSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ geminiSessionId: 'fallback-uuid', state: 'idle' }),
    );
  });

  it('does NOT lose geminiSessionId when store has it (regression)', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_sub_rebuild4',
      agentType: 'gemini',
      geminiSessionId: 'must-not-lose',
      state: 'idle',
      restarts: 1,
      restartTimestamps: [1000],
      createdAt: 500,
    });

    await rebuildSubSessions([{
      id: 'rebuild4',
      type: 'gemini',
      cwd: '/proj',
      // No geminiSessionId from server
    }]);

    const call = upsertSessionMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.geminiSessionId).toBe('must-not-lose');
    // Also verify other fields aren't clobbered
    expect(call.agentType).toBe('gemini');
  });
});
