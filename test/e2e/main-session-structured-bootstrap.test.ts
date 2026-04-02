/**
 * E2E for main-session structured bootstrap.
 *
 * Uses:
 * - real tmux sessions
 * - real launchSession() flow
 * - mocked provider drivers/watchers so no external CLI is required
 *
 * Verifies that main sessions for structured providers now bootstrap like
 * sub-sessions: explicit session ids are prepared before launch and reused by
 * watcher binding.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { killSession, capturePane } from '../../src/agent/tmux.js';

const SKIP = process.env.SKIP_TMUX_TESTS === '1' || !!process.env.CLAUDECODE;
const RUN_ID = Math.random().toString(36).slice(2, 8);
const PROJECT = `bootmain${RUN_ID}`;
const CLAUDE_SESSION = `deck_${PROJECT}_brain`;
const CODEX_SESSION = `deck_${PROJECT}_w1`;
const GEMINI_SESSION = `deck_${PROJECT}_w2`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mocks = vi.hoisted(() => {
  const sessions = new Map<string, Record<string, unknown>>();
  const uuidQueue = ['cc-main-e2e-uuid', 'codex-main-e2e-uuid'];
  return {
    sessions,
    startWatchingFile: vi.fn().mockResolvedValue(undefined),
    startWatching: vi.fn().mockResolvedValue(undefined),
    startCodexWatching: vi.fn().mockResolvedValue(undefined),
    startCodexWatchingSpecificFile: vi.fn().mockResolvedValue(undefined),
    startGeminiWatching: vi.fn().mockResolvedValue(undefined),
    ensureCodexSessionFile: vi.fn().mockResolvedValue('/mock/codex-rollout.jsonl'),
    findRolloutPathByUuid: vi.fn((uuid: string) => Promise.resolve(`/mock/${uuid}.jsonl`)),
    resolveGeminiSessionId: vi.fn().mockResolvedValue('gemini-main-e2e-uuid'),
    injectGeminiMemory: vi.fn().mockResolvedValue(undefined),
    nextUuid: vi.fn(() => uuidQueue.shift() ?? `uuid-${Math.random().toString(36).slice(2, 10)}`),
  };
});

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: mocks.nextUuid,
  };
});

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => [...mocks.sessions.values()]),
  getSession: vi.fn((name: string) => mocks.sessions.get(name) ?? null),
  upsertSession: vi.fn((record: Record<string, unknown>) => {
    if (typeof record.name === 'string') mocks.sessions.set(record.name, record);
  }),
  removeSession: vi.fn((name: string) => { mocks.sessions.delete(name); }),
  updateSessionState: vi.fn((name: string, state: string) => {
    const record = mocks.sessions.get(name);
    if (record) mocks.sessions.set(name, { ...record, state });
  }),
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

vi.mock('../../src/repo/cache.js', () => ({
  repoCache: { invalidate: vi.fn() },
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  startWatching: mocks.startWatching,
  startWatchingFile: mocks.startWatchingFile,
  stopWatching: vi.fn(),
  isWatching: vi.fn().mockReturnValue(false),
  findJsonlPathBySessionId: vi.fn((dir: string, id: string) => `/mock/${dir.replace(/\//g, '_')}/${id}.jsonl`),
  ensureClaudeSessionFile: vi.fn().mockResolvedValue('/mock/claude-seed.jsonl'),
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  startWatching: mocks.startCodexWatching,
  startWatchingSpecificFile: mocks.startCodexWatchingSpecificFile,
  startWatchingById: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn().mockReturnValue(false),
  findRolloutPathByUuid: mocks.findRolloutPathByUuid,
  ensureSessionFile: mocks.ensureCodexSessionFile,
}));

vi.mock('../../src/daemon/gemini-watcher.js', () => ({
  startWatching: mocks.startGeminiWatching,
  startWatchingLatest: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/daemon/memory-inject.js', () => ({
  injectGeminiMemory: mocks.injectGeminiMemory,
}));

vi.mock('../../src/agent/drivers/claude-code.js', () => ({
  ClaudeCodeDriver: class {
    readonly type = 'claude-code' as const;
    readonly promptChar = '❯';
    readonly spinnerChars = ['⠋'];
    buildLaunchCommand(_sessionName: string, opts?: { ccSessionId?: string }) {
      return `bash -lc 'printf \"CLAUDE:${opts?.ccSessionId ?? "none"}\\n\"; sleep 15'`;
    }
    buildResumeCommand(_sessionName: string, opts?: { ccSessionId?: string }) {
      return `bash -lc 'printf \"CLAUDE-RESUME:${opts?.ccSessionId ?? "none"}\\n\"; sleep 15'`;
    }
    detectStatus() { return 'idle' as const; }
    isOverlay() { return false; }
  },
}));

vi.mock('../../src/agent/drivers/codex.js', () => ({
  CodexDriver: class {
    readonly type = 'codex' as const;
    readonly promptChar = '›';
    readonly spinnerChars = ['⠋'];
    buildLaunchCommand(_sessionName: string, opts?: { codexSessionId?: string }) {
      return `bash -lc 'printf \"CODEX:${opts?.codexSessionId ?? "none"}\\n\"; sleep 15'`;
    }
    buildResumeCommand(_sessionName: string, opts?: { codexSessionId?: string }) {
      return `bash -lc 'printf \"CODEX-RESUME:${opts?.codexSessionId ?? "none"}\\n\"; sleep 15'`;
    }
    detectStatus() { return 'idle' as const; }
    isOverlay() { return false; }
  },
}));

vi.mock('../../src/agent/drivers/gemini.js', () => ({
  GeminiDriver: class {
    readonly type = 'gemini' as const;
    readonly promptChar = '>';
    readonly spinnerChars = ['⠋'];
    async resolveSessionId() {
      return mocks.resolveGeminiSessionId();
    }
    buildLaunchCommand(_sessionName: string, opts?: { geminiSessionId?: string }) {
      return `bash -lc 'printf \"GEMINI:${opts?.geminiSessionId ?? "none"}\\n\"; sleep 15'`;
    }
    buildResumeCommand(_sessionName: string, opts?: { geminiSessionId?: string }) {
      return `bash -lc 'printf \"GEMINI-RESUME:${opts?.geminiSessionId ?? "none"}\\n\"; sleep 15'`;
    }
    detectStatus() { return 'idle' as const; }
    isOverlay() { return false; }
  },
}));

import { launchSession } from '../../src/agent/session-manager.js';

describe.skipIf(SKIP)('main-session structured bootstrap e2e', () => {
  afterEach(async () => {
    await killSession(CLAUDE_SESSION).catch(() => {});
    await killSession(CODEX_SESSION).catch(() => {});
    await killSession(GEMINI_SESSION).catch(() => {});
    mocks.sessions.clear();
    vi.clearAllMocks();
  });

  it('bootstraps explicit structured ids for main claude/codex/gemini sessions', async () => {
    await launchSession({
      name: CLAUDE_SESSION,
      projectName: PROJECT,
      role: 'brain',
      agentType: 'claude-code',
      projectDir: '/tmp',
    });
    await launchSession({
      name: CODEX_SESSION,
      projectName: PROJECT,
      role: 'w1',
      agentType: 'codex',
      projectDir: '/tmp',
    });
    await launchSession({
      name: GEMINI_SESSION,
      projectName: PROJECT,
      role: 'w2',
      agentType: 'gemini',
      projectDir: '/tmp',
    });

    await wait(400);

    const claudePane = (await capturePane(CLAUDE_SESSION)).join('\n');
    const codexPane = (await capturePane(CODEX_SESSION)).join('\n');
    const geminiPane = (await capturePane(GEMINI_SESSION)).join('\n');

    expect(claudePane).toContain('CLAUDE:cc-main-e2e-uuid');
    expect(codexPane).toContain('CODEX:codex-main-e2e-uuid');
    expect(geminiPane).toContain('GEMINI:gemini-main-e2e-uuid');

    const claudeRecord = mocks.sessions.get(CLAUDE_SESSION);
    const codexRecord = mocks.sessions.get(CODEX_SESSION);
    const geminiRecord = mocks.sessions.get(GEMINI_SESSION);

    expect(claudeRecord?.ccSessionId).toBe('cc-main-e2e-uuid');
    expect(codexRecord?.codexSessionId).toBe('codex-main-e2e-uuid');
    expect(geminiRecord?.geminiSessionId).toBe('gemini-main-e2e-uuid');

    expect(mocks.startWatchingFile).toHaveBeenCalledWith(
      CLAUDE_SESSION,
      expect.stringContaining('cc-main-e2e-uuid.jsonl'),
      'cc-main-e2e-uuid',
    );
    expect(mocks.startCodexWatchingSpecificFile).toHaveBeenCalledWith(
      CODEX_SESSION,
      '/mock/codex-main-e2e-uuid.jsonl',
    );
    expect(mocks.startGeminiWatching).toHaveBeenCalledWith(
      GEMINI_SESSION,
      'gemini-main-e2e-uuid',
    );
  }, 20_000);
});
