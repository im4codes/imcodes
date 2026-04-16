import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureCodexSessionFile: vi.fn().mockResolvedValue('/proj/rollout-seeded.jsonl'),
  findRolloutPathByUuid: vi.fn().mockResolvedValue(null),
  resolveGeminiSessionId: vi.fn().mockResolvedValue('gemini-uuid-1'),
  injectGeminiMemory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: vi.fn()
      .mockReturnValueOnce('cc-uuid-1')
      .mockReturnValueOnce('codex-uuid-1'),
  };
});

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  ensureSessionFile: mocks.ensureCodexSessionFile,
  findRolloutPathByUuid: mocks.findRolloutPathByUuid,
}));

vi.mock('../../src/agent/drivers/gemini.js', () => ({
  GeminiDriver: vi.fn().mockImplementation(() => ({
    resolveSessionId: mocks.resolveGeminiSessionId,
  })),
}));

vi.mock('../../src/daemon/memory-inject.js', () => ({
  injectGeminiMemory: mocks.injectGeminiMemory,
}));

import { resolveStructuredSessionBootstrap } from '../../src/agent/structured-session-bootstrap.js';

describe('resolveStructuredSessionBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRolloutPathByUuid.mockResolvedValue(null);
    mocks.resolveGeminiSessionId.mockResolvedValue('gemini-uuid-1');
  });

  it('generates a Claude session id for new claude-code sessions', async () => {
    const result = await resolveStructuredSessionBootstrap({
      agentType: 'claude-code',
      projectDir: '/proj',
      isNewSession: true,
    });

    expect(result.ccSessionId).toBe('cc-uuid-1');
  });

  it('generates a Codex session id and ensures its rollout file for new codex sessions', async () => {
    const result = await resolveStructuredSessionBootstrap({
      agentType: 'codex',
      projectDir: '/proj',
      isNewSession: true,
    });

    expect(result.codexSessionId).toBe('codex-uuid-1');
    expect(mocks.ensureCodexSessionFile).toHaveBeenCalledWith('codex-uuid-1', '/proj');
  });

  it('resolves a Gemini session id for new gemini sessions and injects memory', async () => {
    const result = await resolveStructuredSessionBootstrap({
      agentType: 'gemini',
      projectDir: '/proj',
      isNewSession: true,
    });

    expect(result.geminiSessionId).toBe('gemini-uuid-1');
    expect(mocks.injectGeminiMemory).toHaveBeenCalledWith('gemini-uuid-1', '/proj', 'proj');
  });

  it('skips Gemini legacy memory injection when legacy injection is disabled', async () => {
    process.env.IMCODES_SHARED_CONTEXT_LEGACY_INJECTION_DISABLED = 'true';
    try {
      const result = await resolveStructuredSessionBootstrap({
        agentType: 'gemini',
        projectDir: '/proj',
        isNewSession: true,
      });

      expect(result.geminiSessionId).toBe('gemini-uuid-1');
      expect(mocks.injectGeminiMemory).not.toHaveBeenCalled();
    } finally {
      delete process.env.IMCODES_SHARED_CONTEXT_LEGACY_INJECTION_DISABLED;
    }
  });
});
