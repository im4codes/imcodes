import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock session-store before importing the handler
vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => [
    { projectDir: '/home/user/myproject', name: 'deck_myproject_brain' },
  ]),
}));

// Mock repo modules to avoid real CLI calls
vi.mock('../../src/repo/detector.js', () => ({
  detectRepo: vi.fn(async () => ({ info: null, status: 'no_repo' })),
}));

vi.mock('../../src/repo/github-provider.js', () => ({
  GitHubProvider: vi.fn(),
}));

vi.mock('../../src/repo/gitlab-provider.js', () => ({
  GitLabProvider: vi.fn(),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { handleRepoCommand } from '../../src/daemon/repo-handler.js';

function createMockServerLink() {
  return { send: vi.fn() } as { send: ReturnType<typeof vi.fn> };
}

describe('handleRepoCommand — input validation', () => {
  let serverLink: ReturnType<typeof createMockServerLink>;

  beforeEach(() => {
    serverLink = createMockServerLink();
    vi.clearAllMocks();
  });

  it('rejects unknown projectDir with invalid_params', () => {
    handleRepoCommand(
      { type: 'repo.detect', projectDir: '/nonexistent/dir' },
      serverLink as any,
    );

    expect(serverLink.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'repo.error', error: 'invalid_params' }),
    );
  });

  it('rejects missing projectDir', () => {
    handleRepoCommand(
      { type: 'repo.detect' },
      serverLink as any,
    );

    expect(serverLink.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'repo.error', error: 'invalid_params' }),
    );
  });

  it('rejects invalid state value', () => {
    handleRepoCommand(
      { type: 'repo.list_issues', projectDir: '/home/user/myproject', state: 'invalid' },
      serverLink as any,
    );

    expect(serverLink.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'repo.error', error: 'invalid_params' }),
    );
  });

  it('accepts valid state values', () => {
    for (const state of ['open', 'closed', 'merged', 'all']) {
      const sl = createMockServerLink();
      handleRepoCommand(
        { type: 'repo.list_issues', projectDir: '/home/user/myproject', state },
        sl as any,
      );
      // Should not immediately send an error — validation passes
      const errorCall = sl.send.mock.calls.find(
        (c: any[]) => c[0]?.error === 'invalid_params',
      );
      expect(errorCall).toBeUndefined();
    }
  });

  it('rejects branch with shell metacharacters', () => {
    handleRepoCommand(
      { type: 'repo.list_commits', projectDir: '/home/user/myproject', branch: 'main; rm -rf /' },
      serverLink as any,
    );

    expect(serverLink.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'repo.error', error: 'invalid_params' }),
    );
  });

  it('rejects branch with backticks', () => {
    handleRepoCommand(
      { type: 'repo.list_commits', projectDir: '/home/user/myproject', branch: '`whoami`' },
      serverLink as any,
    );

    expect(serverLink.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'repo.error', error: 'invalid_params' }),
    );
  });

  it('accepts valid branch names', () => {
    const sl = createMockServerLink();
    handleRepoCommand(
      { type: 'repo.list_commits', projectDir: '/home/user/myproject', branch: 'feature/my-branch_v2.0' },
      sl as any,
    );

    const errorCall = sl.send.mock.calls.find(
      (c: any[]) => c[0]?.error === 'invalid_params',
    );
    expect(errorCall).toBeUndefined();
  });

  it('rejects negative page number', () => {
    handleRepoCommand(
      { type: 'repo.list_issues', projectDir: '/home/user/myproject', page: -1 },
      serverLink as any,
    );

    expect(serverLink.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'repo.error', error: 'invalid_params' }),
    );
  });

  it('rejects page > 100', () => {
    handleRepoCommand(
      { type: 'repo.list_issues', projectDir: '/home/user/myproject', page: 101 },
      serverLink as any,
    );

    expect(serverLink.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'repo.error', error: 'invalid_params' }),
    );
  });

  it('rejects non-integer page', () => {
    handleRepoCommand(
      { type: 'repo.list_issues', projectDir: '/home/user/myproject', page: 1.5 },
      serverLink as any,
    );

    expect(serverLink.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'repo.error', error: 'invalid_params' }),
    );
  });

  it('rejects page = 0', () => {
    handleRepoCommand(
      { type: 'repo.list_issues', projectDir: '/home/user/myproject', page: 0 },
      serverLink as any,
    );

    expect(serverLink.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'repo.error', error: 'invalid_params' }),
    );
  });

  it('strips browser-sent provider field without affecting behavior', () => {
    const cmd = {
      type: 'repo.detect',
      projectDir: '/home/user/myproject',
      provider: 'github',
    } as Record<string, unknown>;

    handleRepoCommand(cmd, serverLink as any);

    // provider should be deleted from the command object
    expect(cmd.provider).toBeUndefined();

    // Should not have sent an invalid_params error (validation passed)
    const errorCall = serverLink.send.mock.calls.find(
      (c: any[]) => c[0]?.error === 'invalid_params',
    );
    expect(errorCall).toBeUndefined();
  });

  it('valid request shape passes validation and proceeds', () => {
    const sl = createMockServerLink();
    handleRepoCommand(
      { type: 'repo.list_prs', projectDir: '/home/user/myproject', state: 'open', page: 1 },
      sl as any,
    );

    // No immediate invalid_params error
    const errorCall = sl.send.mock.calls.find(
      (c: any[]) => c[0]?.error === 'invalid_params',
    );
    expect(errorCall).toBeUndefined();
  });
});
