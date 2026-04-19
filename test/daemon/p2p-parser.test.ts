import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { P2P_CONFIG_ERROR, P2P_CONFIG_MSG } from '../../shared/p2p-config-events.js';

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

const getSavedP2pConfigMock = vi.fn();
const upsertSavedP2pConfigMock = vi.fn();
vi.mock('../../src/store/p2p-config-store.js', () => ({
  getSavedP2pConfig: (...args: unknown[]) => getSavedP2pConfigMock(...args),
  upsertSavedP2pConfig: (...args: unknown[]) => upsertSavedP2pConfigMock(...args),
  removeSavedP2pConfig: vi.fn(),
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
    getSavedP2pConfigMock.mockResolvedValue(undefined);
    upsertSavedP2pConfigMock.mockResolvedValue(undefined);
    (listP2pRuns as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (startP2pRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'run-1' });
  });

  it('structured combo mode with p2pSessionConfig filters __all__ expansion to enabled participants', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'review this code',
      commandId: 'cmd-combo-config',
      p2pMode: 'brainstorm>discuss',
      p2pSessionConfig: {
        deck_proj_w1: { enabled: true, mode: 'audit' },
        deck_proj_w2: { enabled: false, mode: 'review' },
      },
    }, mockServerLink as any);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(startP2pRun).toHaveBeenCalledTimes(1);
    const [{ targets }] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(targets).toEqual([
      { session: 'deck_proj_w1', mode: 'brainstorm>discuss' },
    ]);
  });

  it('config mode still uses per-session configured modes', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'review this code',
      commandId: 'cmd-config-mode',
      p2pMode: 'config',
      p2pSessionConfig: {
        deck_proj_w1: { enabled: true, mode: 'audit' },
        deck_proj_w2: { enabled: true, mode: 'review' },
      },
    }, mockServerLink as any);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(startP2pRun).toHaveBeenCalledTimes(1);
    const [{ targets }] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(targets).toEqual([
      { session: 'deck_proj_w1', mode: 'audit' },
      { session: 'deck_proj_w2', mode: 'review' },
    ]);
  });

  it('prefers daemon-persisted config over a stale client snapshot', async () => {
    getSavedP2pConfigMock.mockResolvedValue({
      sessions: {
        deck_proj_w1: { enabled: true, mode: 'audit' },
        deck_proj_w2: { enabled: false, mode: 'review' },
      },
      rounds: 1,
    });

    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'review this code',
      commandId: 'cmd-authoritative-config',
      p2pMode: 'review',
      p2pSessionConfig: {
        deck_proj_w1: { enabled: false, mode: 'audit' },
        deck_proj_w2: { enabled: false, mode: 'review' },
      },
    }, mockServerLink as any);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(startP2pRun).toHaveBeenCalledTimes(1);
    const [{ targets }] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(targets).toEqual([{ session: 'deck_proj_w1', mode: 'review' }]);
  });

  it('returns a distinct error when config filtering removes all otherwise-valid targets', async () => {
    getSavedP2pConfigMock.mockResolvedValue({
      sessions: {
        deck_proj_w1: { enabled: false, mode: 'audit' },
        deck_proj_w2: { enabled: false, mode: 'review' },
      },
      rounds: 1,
    });

    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'review this code',
      commandId: 'cmd-no-configured-targets',
      p2pMode: 'review',
      p2pSessionConfig: {
        deck_proj_w1: { enabled: false, mode: 'audit' },
      },
    }, mockServerLink as any);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(startP2pRun).not.toHaveBeenCalled();
    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-no-configured-targets',
      status: 'error',
      session: 'deck_proj_brain',
      error: P2P_CONFIG_ERROR.NO_CONFIGURED_TARGETS,
    });
  });

  it('persists config saves from the web command path into the daemon store', async () => {
    const config = {
      sessions: { deck_proj_w1: { enabled: true, mode: 'audit' } },
      rounds: 2,
    };

    handleWebCommand({
      type: P2P_CONFIG_MSG.SAVE,
      requestId: 'req-save-ok',
      scopeSession: 'deck_proj_brain',
      config,
    }, mockServerLink as any);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upsertSavedP2pConfigMock).toHaveBeenCalledWith('deck_proj_brain', config);
    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: P2P_CONFIG_MSG.SAVE_RESPONSE,
      requestId: 'req-save-ok',
      scopeSession: 'deck_proj_brain',
      ok: true,
    });
  });

  it('rejects invalid daemon config saves with a typed error response', async () => {
    handleWebCommand({
      type: P2P_CONFIG_MSG.SAVE,
      requestId: 'req-save-invalid',
      scopeSession: 'deck_proj_brain',
      config: { sessions: [], rounds: 'bad' },
    }, mockServerLink as any);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upsertSavedP2pConfigMock).not.toHaveBeenCalled();
    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: P2P_CONFIG_MSG.SAVE_RESPONSE,
      requestId: 'req-save-invalid',
      scopeSession: 'deck_proj_brain',
      ok: false,
      error: P2P_CONFIG_ERROR.INVALID_CONFIG,
    });
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
    expect((startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(1);
    const [{ targets, userText: cleanText }] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t: any) => t.mode === 'audit')).toBe(true);
    // Text should be clean — no @@tokens
    expect(cleanText).toBe('review this code');
    expect(cleanText).not.toContain('@@');
  });

  it('single-target p2pAtTargets starts a full P2P run', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'check the tests',
      commandId: 'cmd-2',
      p2pAtTargets: [{ session: 'deck_proj_w1', mode: 'review' }],
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    expect(startP2pRun).toHaveBeenCalledOnce();
    const [{ targets, userText: cleanText }] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(targets).toEqual([
      { session: 'deck_proj_w1', mode: 'review' },
    ]);
    expect(cleanText).toBe('check the tests');
    expect(sendKeysDelayedEnter).not.toHaveBeenCalled();
  });

  it('does NOT emit an initiator user.message on P2P success — command is intercepted, not chatted', async () => {
    // P2P sends are COMMANDS to launch a discussion run, not messages to
    // the main session's agent. The conversation happens in the P2P
    // discussion file (.imc/discussions/<run>.md) — nothing about the
    // user's prompt belongs in the initiator's chat timeline.
    //
    // The web composer mirrors this: SessionPane / SubSessionWindow /
    // SubSessionCard skip `addOptimisticUserMessage` when the send
    // payload carries `p2pAtTargets` / `p2pMode` / `p2pSessionConfig`.
    // With no pending bubble to reconcile, the daemon must NOT emit a
    // `user.message` here — doing so would leave a stray committed
    // user bubble in the main session's chat (regression from an
    // earlier round; see commit history).
    //
    // The `command.ack status: 'accepted'` + `p2p.run_started` pair is
    // still emitted so the web clears any failure timer and the
    // discussions UI surfaces the new run.
    const { timelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
    const emitMock = (timelineEmitter as unknown as { emit: ReturnType<typeof vi.fn> }).emit;
    emitMock.mockClear();

    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'kick off a discussion',
      commandId: 'cmd-p2p-no-echo',
      p2pAtTargets: [{ session: 'deck_proj_w1', mode: 'review' }],
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    // No `user.message` should be emitted on the initiator session.
    const userEchoCall = emitMock.mock.calls.find(
      (call) => call[0] === 'deck_proj_brain'
        && call[1] === 'user.message',
    );
    expect(userEchoCall, 'unexpected user.message — P2P command leaking into main session chat').toBeUndefined();

    // But the ack IS still emitted (clears any failure timer the web set
    // speculatively on send).
    const ackCall = emitMock.mock.calls.find(
      (call) => call[0] === 'deck_proj_brain'
        && call[1] === 'command.ack'
        && (call[2] as Record<string, unknown>)?.commandId === 'cmd-p2p-no-echo',
    );
    expect(ackCall).toBeDefined();
    expect((ackCall![2] as Record<string, unknown>).status).toBe('accepted');
  });


  it('auto-appends the selected i18n language instruction for p2p runs', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'check the tests',
      commandId: 'cmd-2lang',
      p2pAtTargets: [{ session: 'deck_proj_w1', mode: 'review' }],
      p2pLocale: 'zh-CN',
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    expect(startP2pRun).toHaveBeenCalledOnce();
    expect((startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(1);
    const [{ extraPrompt }] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(extraPrompt).toContain("Use the user's selected i18n language (Chinese (Simplified)) for the discussion.");
  });

  it('forwards advanced p2p options through the structured session.send path', async () => {
    const advancedRounds = [
      {
        id: 'implementation',
        title: 'Implementation',
        preset: 'implementation',
        executionMode: 'single_main',
        permissionScope: 'implementation',
      },
    ];

    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'run advanced p2p',
      commandId: 'cmd-advanced-1',
      p2pAtTargets: [{ session: 'deck_proj_w1', mode: 'audit' }],
      p2pAdvancedPresetKey: 'openspec',
      p2pAdvancedRounds: advancedRounds as any,
      p2pAdvancedRunTimeoutMinutes: 45,
      p2pContextReducer: {
        mode: 'clone_sdk_session',
        templateSession: 'deck_proj_brain',
      },
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    expect(startP2pRun).toHaveBeenCalledOnce();
    expect((startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(1);
    expect((startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      initiatorSession: 'deck_proj_brain',
      targets: [{ session: 'deck_proj_w1', mode: 'audit' }],
      userText: 'run advanced p2p',
      advancedPresetKey: 'openspec',
      advancedRounds,
      advancedRunTimeoutMs: 45 * 60_000,
      contextReducer: {
        mode: 'clone_sdk_session',
        templateSession: 'deck_proj_brain',
      },
    });
  });

  it('forwards the selected i18n locale to the P2P run for final-summary prompting', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'localized final summary reminder',
      commandId: 'cmd-locale-1',
      p2pAtTargets: [{ session: 'deck_proj_w1', mode: 'review' }],
      p2pLocale: 'zh-CN',
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    expect(startP2pRun).toHaveBeenCalledOnce();
    expect((startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      initiatorSession: 'deck_proj_brain',
      targets: [{ session: 'deck_proj_w1', mode: 'review' }],
      userText: 'localized final summary reminder',
      locale: 'zh-CN',
    });
  });

  it('structured p2pAtTargets stays authoritative for single-target P2P runs', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: '@@w1(discuss) check the tests',
      commandId: 'cmd-2b',
      p2pAtTargets: [{ session: 'deck_proj_w1', mode: 'review' }],
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    expect(startP2pRun).toHaveBeenCalledOnce();
    const [{ targets, userText: cleanText }] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(targets).toEqual([
      { session: 'deck_proj_w1', mode: 'review' },
    ]);
    expect(cleanText).toBe('@@w1(discuss) check the tests');
    expect(sendKeysDelayedEnter).not.toHaveBeenCalled();
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
    const [{ targets, userText: cleanText }] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
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
    const [{ targets, userText: cleanText }] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
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

  it('legacy directTargetSession also starts a full P2P run', async () => {
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'please check this',
      commandId: 'cmd-direct-1',
      directTargetSession: 'deck_proj_w1',
      directTargetMode: 'audit',
    }, mockServerLink as any);

    await new Promise((r) => setTimeout(r, 100));

    expect(startP2pRun).toHaveBeenCalledOnce();
    const [{ targets, userText: cleanText }] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(targets).toEqual([
      { session: 'deck_proj_w1', mode: 'audit' },
    ]);
    expect(cleanText).toBe('please check this');
    expect(sendKeysDelayedEnter).not.toHaveBeenCalled();
    expect(mockServerLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command.ack',
      session: 'deck_proj_brain',
      status: 'accepted',
    }));
    expect(mockServerLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'p2p.run_started',
      session: 'deck_proj_brain',
      runId: 'run-1',
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
    const [{ targets }] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
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
    const [{ rounds }] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(rounds).toBe(2);
  });

  it('limits pulled file contents to the first 20 referenced files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p2p-file-limit-'));
    try {
      const filePaths: string[] = [];
      for (let i = 0; i < 25; i++) {
        const filePath = join(dir, `file-${i}.ts`);
        await writeFile(filePath, `export const value${i} = ${i};\n`, 'utf8');
        filePaths.push(filePath);
      }

      handleWebCommand({
        type: 'session.send',
        sessionName: 'deck_proj_brain',
        text: `${filePaths.map((fp) => `@${fp}`).join(' ')} review these files`,
        commandId: 'cmd-file-limit',
        p2pAtTargets: [{ session: 'deck_proj_w1', mode: 'review' }],
      }, mockServerLink as any);

      // Poll until startP2pRun is called — reading 25 small files and hopping
      // through handleSend's async path takes longer than the fixed 100 ms
      // wait used elsewhere in this suite. Poll with a generous budget so the
      // test is deterministic under slow CI rather than racing the timeout.
      await vi.waitFor(
        () => expect(startP2pRun).toHaveBeenCalledOnce(),
        { timeout: 10_000, interval: 50 },
      );

      const [{ fileContents }] = (startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fileContents).toHaveLength(20);
      expect(fileContents.map((f: { path: string }) => f.path)).toEqual(filePaths.slice(0, 20));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
