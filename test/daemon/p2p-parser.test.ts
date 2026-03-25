import { describe, it, expect, vi } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: () => [
    { name: 'deck_proj_brain', agentType: 'claude-code', state: 'running', projectName: 'proj' },
    { name: 'deck_proj_w1', agentType: 'codex', state: 'running', projectName: 'proj' },
    { name: 'deck_proj_w2', agentType: 'gemini', state: 'idle', projectName: 'proj' },
  ],
  getSession: () => null,
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

import { parseAtTokens } from '../../src/daemon/command-handler.js';

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
