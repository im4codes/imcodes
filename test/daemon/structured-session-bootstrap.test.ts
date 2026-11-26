import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureCodexSessionFile: vi.fn().mockResolvedValue('/proj/rollout-seeded.jsonl'),
  findRolloutPathByUuid: vi.fn().mockResolvedValue(null),
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

import { resolveStructuredSessionBootstrap } from '../../src/agent/structured-session-bootstrap.js';

describe('resolveStructuredSessionBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRolloutPathByUuid.mockResolvedValue(null);
  });

  it('generates a Claude session id for new claude-code sessions', async () => {
    const result = await resolveStructuredSessionBootstrap({
      sessionName: 'deck_proj_brain',
      agentType: 'claude-code',
      projectDir: '/proj',
      isNewSession: true,
    });

    expect(result.ccSessionId).toBe('cc-uuid-1');
  });

  it('generates a Codex session id and ensures its rollout file for new codex sessions', async () => {
    const result = await resolveStructuredSessionBootstrap({
      sessionName: 'deck_proj_brain',
      agentType: 'codex',
      projectDir: '/proj',
      isNewSession: true,
    });

    expect(result.codexSessionId).toBe('codex-uuid-1');
    expect(mocks.ensureCodexSessionFile).toHaveBeenCalledWith('codex-uuid-1', '/proj', 'deck_proj_brain');
  });
});
