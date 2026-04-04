import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const MOCK_SESSIONS = [
  { name: 'deck_proj_brain', agentType: 'claude-code', state: 'running', projectName: 'proj' },
  { name: 'deck_proj_w1', agentType: 'codex', state: 'running', projectName: 'proj' },
  { name: 'deck_proj_w2', agentType: 'gemini', state: 'idle', projectName: 'proj' },
];
vi.mock('../../src/store/session-store.js', () => ({
  listSessions: () => MOCK_SESSIONS,
  getSession: (name: string) => MOCK_SESSIONS.find(s => s.name === name) ?? null,
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: vi.fn(),
  stopProject: vi.fn(),
  teardownProject: vi.fn(),
  getTransportRuntime: vi.fn(() => undefined),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: vi.fn(),
  sendRawInput: vi.fn(),
  resizeSession: vi.fn(),
  sendKey: vi.fn(),
}));

vi.mock('../../src/router/message-router.js', () => ({
  routeMessage: vi.fn(),
}));

vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../../src/daemon/server-link.js', () => ({}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: {
    append: vi.fn(),
    read: vi.fn(() => []),
    clear: vi.fn(),
  },
}));

vi.mock('../../src/daemon/subsession-manager.js', () => ({
  startSubSession: vi.fn(),
  stopSubSession: vi.fn(),
  rebuildSubSessions: vi.fn(),
  detectShells: vi.fn().mockResolvedValue([]),
  readSubSessionResponse: vi.fn(),
  subSessionName: (id: string) => `deck_sub_${id}`,
}));

vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({
  startP2pRun: vi.fn(),
  cancelP2pRun: vi.fn(),
  getP2pRun: vi.fn(() => undefined),
  listP2pRuns: vi.fn(() => []),
}));

vi.mock('../../src/daemon/repo-handler.js', () => ({
  handleRepoCommand: vi.fn(),
}));

vi.mock('../../src/daemon/file-transfer-handler.js', () => ({
  handleFileUpload: vi.fn(),
  handleFileDownload: vi.fn(),
  initFileTransfer: vi.fn().mockResolvedValue(undefined),
  startCleanupTimer: vi.fn(),
  createProjectFileHandle: vi.fn(),
  lookupAttachment: vi.fn(() => undefined),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/util/imc-dir.js', () => ({
  ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'),
  imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { parseAtTokens, handleWebCommand } from '../../src/daemon/command-handler.js';
import { startP2pRun, listP2pRuns } from '../../src/daemon/p2p-orchestrator.js';
import { sendKeysDelayedEnter } from '../../src/agent/tmux.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseAtTokens', () => {
  describe('@@all token', () => {
    it('@@all(audit) returns expandAll with mode "audit"', () => {
      const result = parseAtTokens('@@all(audit) please review everything');
      expect(result.expandAll).toBeDefined();
      expect(result.expandAll!.mode).toBe('audit');
    });

    it('@@all(config) returns expandAll with mode "config"', () => {
      const result = parseAtTokens('@@all(config) configure all sessions');
      expect(result.expandAll).toBeDefined();
      expect(result.expandAll!.mode).toBe('config');
    });

    it('@@all(config, exclude-same-type) returns expandAll with excludeSameType true', () => {
      const result = parseAtTokens('@@all(config, exclude-same-type) run config');
      expect(result.expandAll).toBeDefined();
      expect(result.expandAll!.mode).toBe('config');
      expect(result.expandAll!.excludeSameType).toBe(true);
    });

    it('@@all(audit ×2) returns expandAll with rounds=2', () => {
      const result = parseAtTokens('@@all(audit ×2) please review everything');
      expect(result.expandAll).toBeDefined();
      expect(result.expandAll!.mode).toBe('audit');
      expect(result.expandAll!.rounds).toBe(2);
    });

    it('@@all(brainstorm>discuss>plan ×3) returns combo mode with rounds=3', () => {
      const result = parseAtTokens('@@all(brainstorm>discuss>plan ×3) plan this');
      expect(result.expandAll).toBeDefined();
      expect(result.expandAll!.mode).toBe('brainstorm>discuss>plan');
      expect(result.expandAll!.rounds).toBe(3);
    });

    it('@@all(brainstorm>discuss>plan x3) also accepts ascii x rounds suffix', () => {
      const result = parseAtTokens('@@all(brainstorm>discuss>plan x3) plan this');
      expect(result.expandAll).toBeDefined();
      expect(result.expandAll!.mode).toBe('brainstorm>discuss>plan');
      expect(result.expandAll!.rounds).toBe(3);
    });

    it('@@all(invalid) returns no expandAll for an unrecognized mode', () => {
      const result = parseAtTokens('@@all(invalid) do something');
      expect(result.expandAll).toBeUndefined();
    });
  });

  describe('@@discuss token', () => {
    it('@@discuss(deck_proj_w1, audit) extracts agent with correct session and mode', () => {
      const result = parseAtTokens('@@discuss(deck_proj_w1, audit) here is the task');
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].session).toBe('deck_proj_w1');
      expect(result.agents[0].mode).toBe('audit');
    });

    it('@@discuss(nonexistent, audit) is ignored when session is not in listSessions', () => {
      const result = parseAtTokens('@@discuss(nonexistent_session, audit) task');
      expect(result.agents).toHaveLength(0);
    });
  });

  describe('@@p2p-config token', () => {
    it('@@p2p-config(rounds=3) is stripped from cleanText', () => {
      const result = parseAtTokens('@@p2p-config(rounds=3) run the analysis');
      expect(result.cleanText).not.toContain('@@p2p-config');
      expect(result.cleanText).toBe('run the analysis');
    });
  });

  describe('mixed tokens', () => {
    it('@@p2p-config + @@discuss + @file all parsed, cleanText is stripped of tokens', () => {
      const input = '@@p2p-config(rounds=3) @@discuss(deck_proj_w1, review) @src/index.ts check this';
      const result = parseAtTokens(input);

      // @@discuss extracted
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].session).toBe('deck_proj_w1');
      expect(result.agents[0].mode).toBe('review');

      // @src/index.ts extracted as file
      expect(result.files).toContain('src/index.ts');

      // cleanText has only the user message
      expect(result.cleanText).toBe('check this');
      expect(result.cleanText).not.toContain('@@p2p-config');
      expect(result.cleanText).not.toContain('@@discuss');
      expect(result.cleanText).not.toContain('@src/index.ts');
    });

    it('@@all(config) + @@p2p-config both stripped, cleanText has only user message', () => {
      const input = '@@all(config) @@p2p-config(rounds=5) please configure all agents';
      const result = parseAtTokens(input);

      expect(result.expandAll).toBeDefined();
      expect(result.expandAll!.mode).toBe('config');
      expect(result.cleanText).toBe('please configure all agents');
      expect(result.cleanText).not.toContain('@@all');
      expect(result.cleanText).not.toContain('@@p2p-config');
    });
  });

  describe('@file tokens', () => {
    it('@src/foo.ts @lib/bar.ts extracts both file paths', () => {
      const result = parseAtTokens('@src/foo.ts @lib/bar.ts review these files');
      expect(result.files).toContain('src/foo.ts');
      expect(result.files).toContain('lib/bar.ts');
    });
  });

  describe('no tokens', () => {
    it('plain text returns empty agents, empty files, original text as cleanText', () => {
      const input = 'just a plain message with no tokens';
      const result = parseAtTokens(input);
      expect(result.agents).toHaveLength(0);
      expect(result.files).toHaveLength(0);
      expect(result.cleanText).toBe(input);
      expect(result.expandAll).toBeUndefined();
    });
  });
});

// ── Structured WS field routing (no inline @@tokens) ──────────────────────────

describe('structured P2P routing via WS fields', () => {
  const mockServerLink = {
    send: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (listP2pRuns as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (startP2pRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'run-1' });
  });

  it('p2pAtTargets with __all__ expands to all active sessions', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'review this code',
      commandId: 'cmd-1',
      p2pAtTargets: [{ session: '__all__', mode: 'audit' }],
    }, mockServerLink as any);

    // Give async handler time to process
    await new Promise((r) => setTimeout(r, 100));

    expect(startP2pRun).toHaveBeenCalledOnce();
    const [_initiator, targets, cleanText] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t: any) => t.mode === 'audit')).toBe(true);
    // Text should be clean — no @@tokens
    expect(cleanText).toBe('review this code');
    expect(cleanText).not.toContain('@@');
  });

  it('single-target p2pAtTargets routes through the initiator with a peer consultation prompt', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'check the tests',
      commandId: 'cmd-2',
      p2pAtTargets: [{ session: 'deck_proj_w1', mode: 'review' }],
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    expect(startP2pRun).not.toHaveBeenCalled();
    expect(sendKeysDelayedEnter).toHaveBeenCalledWith(
      'deck_proj_brain',
      expect.stringContaining('[Peer Consultation Task]'),
      undefined,
    );
    expect(sendKeysDelayedEnter).toHaveBeenCalledWith(
      'deck_proj_brain',
      expect.stringContaining('User request: "check the tests"'),
      undefined,
    );
    expect(sendKeysDelayedEnter).toHaveBeenCalledWith(
      'deck_proj_brain',
      expect.stringContaining('imcodes send --reply "deck_proj_w1"'),
      undefined,
    );
    expect(sendKeysDelayedEnter).toHaveBeenCalledWith(
      'deck_proj_brain',
      expect.stringContaining('Consultation mode for deck_proj_w1: review'),
      undefined,
    );
  });

  it('structured p2pAtTargets is authoritative for single-target consult routing', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: '@@w1(discuss) check the tests',
      commandId: 'cmd-2b',
      p2pAtTargets: [{ session: 'deck_proj_w1', mode: 'review' }],
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    expect(startP2pRun).not.toHaveBeenCalled();
    expect(sendKeysDelayedEnter).toHaveBeenCalledWith(
      'deck_proj_brain',
      expect.stringContaining('Consultation mode for deck_proj_w1: review'),
      undefined,
    );
  });

  it('structured p2pAtTargets preserves the caller-provided agent order', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'please review',
      commandId: 'cmd-2c',
      p2pAtTargets: [
        { session: 'deck_proj_w2', mode: 'discuss' },
        { session: 'deck_proj_w1', mode: 'audit' },
      ],
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    expect(startP2pRun).toHaveBeenCalledOnce();
    const [_initiator, targets, cleanText] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(targets).toEqual([
      { session: 'deck_proj_w2', mode: 'discuss' },
      { session: 'deck_proj_w1', mode: 'audit' },
    ]);
    expect(cleanText).toBe('please review');
  });

  it('p2pMode field expands to all sessions with that mode', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'brainstorm ideas',
      commandId: 'cmd-3',
      p2pMode: 'brainstorm',
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    expect(startP2pRun).toHaveBeenCalledOnce();
    const [_initiator, targets, cleanText] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t: any) => t.mode === 'brainstorm')).toBe(true);
    expect(cleanText).toBe('brainstorm ideas');
  });

  it('plain text without p2p fields is sent directly (no P2P)', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'just a normal message',
      commandId: 'cmd-4',
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    // Should NOT trigger P2P
    expect(startP2pRun).not.toHaveBeenCalled();
  });

  it('legacy directTargetSession also routes through the initiator prompt', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'please check this',
      commandId: 'cmd-direct-1',
      directTargetSession: 'deck_proj_w1',
      directTargetMode: 'audit',
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    expect(startP2pRun).not.toHaveBeenCalled();
    expect(sendKeysDelayedEnter).toHaveBeenCalledWith(
      'deck_proj_brain',
      expect.stringContaining('please check this'),
      undefined,
    );
    expect(sendKeysDelayedEnter).toHaveBeenCalledWith(
      'deck_proj_brain',
      expect.stringContaining('imcodes send --reply "deck_proj_w1"'),
      undefined,
    );
    expect(sendKeysDelayedEnter).toHaveBeenCalledWith(
      'deck_proj_brain',
      expect.stringContaining('Consultation mode for deck_proj_w1: audit'),
      undefined,
    );
    expect(mockServerLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command.ack',
      session: 'deck_proj_brain',
      status: 'accepted',
    }));
  });

  it('legacy @@all(audit) in text still works (backward compat)', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: '@@all(audit) legacy client message',
      commandId: 'cmd-5',
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    expect(startP2pRun).toHaveBeenCalledOnce();
    const [_initiator, targets] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t: any) => t.mode === 'audit')).toBe(true);
  });

  it('legacy @@all(audit ×2) in text still works and forwards rounds', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: '@@all(audit ×2) legacy client message',
      commandId: 'cmd-6',
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    expect(startP2pRun).toHaveBeenCalledOnce();
    const call = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[5]).toBe(2);
  });
});
