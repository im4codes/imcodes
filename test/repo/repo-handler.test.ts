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

vi.mock('../../src/repo/local-git.js', () => ({
  assertGitRepository: vi.fn(),
  getCurrentBranch: vi.fn(),
  listLocalBranches: vi.fn(),
  getWorktreeState: vi.fn(),
  detectInProgressOperation: vi.fn(),
  resolveCheckoutTarget: vi.fn(),
  switchLocalBranch: vi.fn(),
  listLocalCommits: vi.fn(),
  getLocalCommitDetail: vi.fn(),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  __clearRepoOperationStateForTests,
  __setRepoInflightForTests,
  handleRepoCommand,
} from '../../src/daemon/repo-handler.js';
import { repoCache, RepoCache } from '../../src/repo/cache.js';
import { REPO_MSG } from '../../shared/repo-types.js';
import {
  assertGitRepository,
  detectInProgressOperation,
  getCurrentBranch,
  getWorktreeState,
  listLocalBranches,
  listLocalCommits,
  resolveCheckoutTarget,
  switchLocalBranch,
} from '../../src/repo/local-git.js';

function createMockServerLink() {
  return { send: vi.fn() } as { send: ReturnType<typeof vi.fn> };
}

function mockCleanLocalGit(projectDir = '/home/user/myproject'): void {
  vi.mocked(assertGitRepository).mockResolvedValue(undefined);
  vi.mocked(getCurrentBranch).mockResolvedValue('main');
  vi.mocked(listLocalBranches).mockResolvedValue([{ name: 'main', isCurrent: true }]);
  vi.mocked(listLocalCommits).mockResolvedValue({
    items: [],
    page: 1,
    hasMore: false,
    projectDir,
  });
  vi.mocked(getWorktreeState).mockResolvedValue({
    dirty: false,
    staged: false,
    unstaged: false,
    untracked: false,
    submoduleDirty: false,
    entries: [],
  });
  vi.mocked(detectInProgressOperation).mockResolvedValue(null);
  vi.mocked(resolveCheckoutTarget).mockImplementation(async (_projectDir, branch) => ({
    branch,
    ref: `refs/heads/${branch}` as `refs/heads/${string}`,
  }));
  vi.mocked(switchLocalBranch).mockResolvedValue(undefined);
}

describe('handleRepoCommand — input validation', () => {
  let serverLink: ReturnType<typeof createMockServerLink>;

  beforeEach(() => {
    serverLink = createMockServerLink();
    repoCache.invalidateAll();
    __clearRepoOperationStateForTests();
    vi.clearAllMocks();
    mockCleanLocalGit();
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

describe('handleRepoCommand — local branch inventory and commits', () => {
  let serverLink: ReturnType<typeof createMockServerLink>;

  beforeEach(() => {
    serverLink = createMockServerLink();
    repoCache.invalidateAll();
    __clearRepoOperationStateForTests();
    vi.clearAllMocks();
    mockCleanLocalGit();
  });

  it('marks local-only branches checkoutable with shared branch fields', async () => {
    vi.mocked(listLocalBranches).mockResolvedValue([
      { name: 'main', isCurrent: true },
      { name: 'wip/local-only', isCurrent: false },
    ]);

    handleRepoCommand(
      { type: REPO_MSG.LIST_BRANCHES, requestId: 'branches-1', projectDir: '/home/user/myproject' },
      serverLink as any,
    );

    await vi.waitFor(() => {
      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: REPO_MSG.BRANCHES_RESPONSE,
        requestId: 'branches-1',
      }));
    });
    const response = serverLink.send.mock.calls.at(-1)?.[0];
    expect(response.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'main',
        isCurrent: true,
        localPresent: true,
        remotePresent: false,
        checkoutable: true,
      }),
      expect.objectContaining({
        name: 'wip/local-only',
        isCurrent: false,
        localPresent: true,
        remotePresent: false,
        checkoutable: true,
      }),
    ]));
  });

  it('uses the local current branch for commit fallback when no branch is supplied', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('wip/local-only');
    vi.mocked(listLocalCommits).mockResolvedValue({
      items: [{
        sha: 'abc1234',
        shortSha: 'abc1234',
        message: 'local branch commit',
        author: 'Test User',
        date: 123,
        url: '',
      }],
      page: 1,
      hasMore: false,
      projectDir: '/home/user/myproject',
    });

    handleRepoCommand(
      { type: REPO_MSG.LIST_COMMITS, requestId: 'commits-1', projectDir: '/home/user/myproject' },
      serverLink as any,
    );

    await vi.waitFor(() => {
      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: REPO_MSG.COMMITS_RESPONSE,
        requestId: 'commits-1',
        items: [expect.objectContaining({ message: 'local branch commit' })],
      }));
    });
    expect(listLocalCommits).toHaveBeenCalledWith('/home/user/myproject', 'wip/local-only', undefined);
  });
});

describe('handleRepoCommand — checkout', () => {
  let serverLink: ReturnType<typeof createMockServerLink>;

  beforeEach(() => {
    serverLink = createMockServerLink();
    repoCache.invalidateAll();
    __clearRepoOperationStateForTests();
    vi.clearAllMocks();
    mockCleanLocalGit();
  });

  const checkoutCmd = (branch = 'feature') => ({
    type: REPO_MSG.CHECKOUT_BRANCH,
    requestId: 'checkout-1',
    projectDir: '/home/user/myproject',
    branch,
    sessionId: 'deck_myproject_brain',
  });

  it('switches a clean local branch and invalidates project caches', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValueOnce('main').mockResolvedValueOnce('feature');
    const cacheKeys = [
      RepoCache.buildKey('/home/user/myproject', 'detect'),
      RepoCache.buildKey('/home/user/myproject', 'branches'),
      RepoCache.buildKey('/home/user/myproject', 'commits', { branch: 'main' }),
    ];
    for (const cacheKey of cacheKeys) {
      repoCache.set(cacheKey, { stale: true }, '/home/user/myproject');
    }

    handleRepoCommand(checkoutCmd(), serverLink as any);

    await vi.waitFor(() => {
      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: REPO_MSG.CHECKOUT_BRANCH_RESPONSE,
        previousBranch: 'main',
        currentBranch: 'feature',
        repoGeneration: expect.any(Number),
        detectedAt: expect.any(Number),
      }));
    });
    expect(switchLocalBranch).toHaveBeenCalledWith('/home/user/myproject', {
      branch: 'feature',
      ref: 'refs/heads/feature',
    });
    for (const cacheKey of cacheKeys) {
      expect(repoCache.get(cacheKey)).toBeNull();
    }
  });

  it('returns no-op success when requested branch is already current', async () => {
    handleRepoCommand(checkoutCmd('main'), serverLink as any);

    await vi.waitFor(() => {
      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: REPO_MSG.CHECKOUT_BRANCH_RESPONSE,
        currentBranch: 'main',
      }));
    });
    expect(resolveCheckoutTarget).not.toHaveBeenCalled();
    expect(switchLocalBranch).not.toHaveBeenCalled();
  });

  it('rejects dirty worktrees before switching', async () => {
    vi.mocked(getWorktreeState).mockResolvedValue({
      dirty: true,
      staged: true,
      unstaged: false,
      untracked: false,
      submoduleDirty: false,
      entries: ['M  file.ts'],
    });

    handleRepoCommand(checkoutCmd(), serverLink as any);

    await vi.waitFor(() => {
      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: REPO_MSG.ERROR,
        error: 'dirty_worktree',
      }));
    });
    expect(switchLocalBranch).not.toHaveBeenCalled();
  });

  it('rejects in-progress git operations before switching', async () => {
    vi.mocked(detectInProgressOperation).mockResolvedValue('merge');

    handleRepoCommand(checkoutCmd(), serverLink as any);

    await vi.waitFor(() => {
      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: REPO_MSG.ERROR,
        error: 'git_operation_in_progress',
      }));
    });
    expect(switchLocalBranch).not.toHaveBeenCalled();
  });

  it('rejects non-git project directories before detached-head handling', async () => {
    const err = new Error('not a git repo');
    (err as any).code = 'not_a_git_repo';
    vi.mocked(assertGitRepository).mockRejectedValue(err);

    handleRepoCommand(checkoutCmd(), serverLink as any);

    await vi.waitFor(() => {
      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: REPO_MSG.ERROR,
        error: 'not_a_git_repo',
      }));
    });
    expect(getCurrentBranch).not.toHaveBeenCalled();
    expect(switchLocalBranch).not.toHaveBeenCalled();
  });

  it('preserves allowlisted local git checkout errors', async () => {
    const err = new Error('invalid target');
    (err as any).code = 'invalid_checkout_target';
    vi.mocked(resolveCheckoutTarget).mockRejectedValue(err);

    handleRepoCommand(checkoutCmd('missing-branch'), serverLink as any);

    await vi.waitFor(() => {
      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: REPO_MSG.ERROR,
        error: 'invalid_checkout_target',
      }));
    });
    expect(switchLocalBranch).not.toHaveBeenCalled();
  });

  it('serializes concurrent checkout requests for the same projectDir', async () => {
    let releaseSwitch!: () => void;
    vi.mocked(switchLocalBranch).mockImplementation(() => new Promise<void>((resolve) => {
      releaseSwitch = resolve;
    }));

    handleRepoCommand(checkoutCmd('feature-a'), serverLink as any);
    await vi.waitFor(() => expect(switchLocalBranch).toHaveBeenCalledTimes(1));
    handleRepoCommand({ ...checkoutCmd('feature-b'), requestId: 'checkout-2' }, serverLink as any);

    await vi.waitFor(() => {
      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'checkout-2',
        error: 'checkout_in_progress',
      }));
    });
    releaseSwitch();
  });

  it('returns repo_busy when checkout cannot start because repo capacity is full', async () => {
    __setRepoInflightForTests('/home/user/myproject', 20);

    handleRepoCommand(checkoutCmd(), serverLink as any);

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: REPO_MSG.ERROR,
      error: 'repo_busy',
    }));
    expect(switchLocalBranch).not.toHaveBeenCalled();
  });

  it('rejects checkout without requestId as invalid_params', () => {
    handleRepoCommand({ ...checkoutCmd(), requestId: undefined }, serverLink as any);

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: REPO_MSG.ERROR,
      error: 'invalid_params',
    }));
    expect(resolveCheckoutTarget).not.toHaveBeenCalled();
    expect(switchLocalBranch).not.toHaveBeenCalled();
  });

  it('requires checkout requests to name the active session context', () => {
    const cmd: Record<string, unknown> = { ...checkoutCmd() };
    delete cmd.sessionId;

    handleRepoCommand(cmd, serverLink as any);

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: REPO_MSG.ERROR,
      error: 'unauthorized',
    }));
    expect(switchLocalBranch).not.toHaveBeenCalled();
  });

  it('ignores provider field and enforces session/project authorization', async () => {
    const cmd = { ...checkoutCmd(), provider: 'gitlab' };
    handleRepoCommand(cmd, serverLink as any);
    await vi.waitFor(() => expect(switchLocalBranch).toHaveBeenCalled());
    expect(cmd.provider).toBeUndefined();

    vi.clearAllMocks();
    handleRepoCommand({ ...checkoutCmd(), sessionId: 'other-session' }, serverLink as any);
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: REPO_MSG.ERROR,
      error: 'unauthorized',
    }));
    expect(switchLocalBranch).not.toHaveBeenCalled();
  });

  it('maps unknown thrown error codes to checkout_failed', async () => {
    const err = new Error('bad');
    (err as any).code = 'not_a_repo_code';
    vi.mocked(switchLocalBranch).mockRejectedValue(err);

    handleRepoCommand(checkoutCmd(), serverLink as any);

    await vi.waitFor(() => {
      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: REPO_MSG.ERROR,
        error: 'checkout_failed',
      }));
    });
  });
});
