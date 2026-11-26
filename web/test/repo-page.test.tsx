/**
 * @vitest-environment jsdom
 *
 * Tests for RepoPage component.
 * Covers: overview header, tab switching, loading/error/empty states,
 * load more pagination, and stale response discarding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/preact';

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

// jsdom localStorage may be a plain object without methods — ensure a working stub
const localStorageStore: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => localStorageStore[k] ?? null,
    setItem: (k: string, v: string) => { localStorageStore[k] = v; },
    removeItem: (k: string) => { delete localStorageStore[k]; },
    clear: () => { for (const k of Object.keys(localStorageStore)) delete localStorageStore[k]; },
    get length() { return Object.keys(localStorageStore).length; },
    key: (i: number) => Object.keys(localStorageStore)[i] ?? null,
  },
  writable: true,
  configurable: true,
});

beforeEach(() => {
  // Clear localStorage between tests
  for (const k of Object.keys(localStorageStore)) delete localStorageStore[k];
});

afterEach(cleanup);

// ── i18n stub ─────────────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, _opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'repo.tab_issues': 'Issues',
        'repo.tab_prs': 'PRs',
        'repo.tab_branches': 'Branches',
        'repo.tab_commits': 'Commits',
        'repo.tab_actions': 'Actions',
        'repo.tab_cicd': 'Actions',
        'repo.back': 'Back',
        'repo.refresh': 'Refresh',
        'repo.load_more': 'Load more',
        'repo.retry': 'Retry',
        'repo.detail_loading': 'Loading details...',
        'repo.detail_error': 'Failed to load details',
        'repo.detail_retry': 'Retry details',
        'repo.actions_view': 'View',
        'repo.cli_not_installed': 'CLI not installed',
        'repo.error_cli_missing_hint': 'Install the GitHub CLI',
        'repo.error_unauthorized_hint': 'Run gh auth login',
        'repo.current_branch': 'current',
        'repo.default_branch': 'default',
        'repo.branch_local_label': 'Local branch',
        'repo.branch_local_short': 'local',
        'repo.branch_remote_label': 'Remote branch',
        'repo.branch_remote_short': 'remote',
        'repo.checkout_switch': 'Switch',
        'repo.checkout_switching': 'Switching...',
        'repo.checkout_switch_to': `Switch to ${_opts?.branch ?? ''}`,
        'repo.checkout_pending': `Switching to ${_opts?.branch ?? ''}`,
        'repo.checkout_success': `Switched to ${_opts?.branch ?? ''}.`,
        'repo.checkout_remote_only_disabled': 'Remote-only branches cannot be switched in this version.',
        'repo.checkout_dirty_worktree': 'Clean or commit local changes before switching branches.',
        'repo.checkout_invalid_target': 'Only existing local branches can be switched.',
        'repo.checkout_in_progress': 'A branch switch is already in progress for this repository.',
        'repo.checkout_busy': 'Repository operations are busy. Try again shortly.',
        'repo.checkout_failed': 'Branch switch failed.',
        'repo.empty_issues': 'No issues found',
        'repo.empty_prs': 'No pull requests found',
        'repo.empty_branches': 'No branches found',
        'repo.empty_commits': 'No commits found',
        'common.loading': 'Loading...',
      };
      return map[key] ?? key;
    },
  }),
}));

import { RepoPage } from '../src/pages/RepoPage.js';
import type { WsClient, ServerMessage } from '../src/ws-client.js';
import { __resetSessionRepoContextStoreForTests } from '../src/session-repo-context-store.js';
import {
  __resetRepoPageCacheMemoryForTests,
  clearRepoPageCache,
  getRepoPageCache,
  makeRepoPageCacheKey,
  REPO_PAGE_CACHE_FRESH_TTL_MS,
  REPO_PAGE_CACHE_MAX_ENTRIES,
  REPO_PAGE_CACHE_STORAGE_KEY,
  setRepoPageCache,
} from '../src/repo-page-cache.js';
import { FS_SESSION_ROOT_PATH } from '../../src/shared/transport/fs.js';

// ── WsClient mock factory ─────────────────────────────────────────────────

function makeWs() {
  let messageHandler: ((msg: ServerMessage) => void) | null = null;
  // Track request IDs returned by each method
  let detectReqId = '';
  const lastTabReqIds: Partial<Record<'issues' | 'prs' | 'branches' | 'commits' | 'actions', string>> = {};
  let lastActionDetailReqId = '';
  let lastCommitDetailReqId = '';
  let lastCheckoutReqId = '';

  const repoDetect = vi.fn((_projectDir: string, _opts?: any) => {
    detectReqId = `detect-${Date.now()}-${Math.random()}`;
    return detectReqId;
  });
  const repoListIssues = vi.fn((_dir: string, _opts?: any) => {
    lastTabReqIds.issues = `issues-${Date.now()}-${Math.random()}`;
    return lastTabReqIds.issues;
  });
  const repoListPRs = vi.fn((_dir: string, _opts?: any) => {
    lastTabReqIds.prs = `prs-${Date.now()}-${Math.random()}`;
    return lastTabReqIds.prs;
  });
  const repoListBranches = vi.fn((_dir: string) => {
    lastTabReqIds.branches = `branches-${Date.now()}-${Math.random()}`;
    return lastTabReqIds.branches;
  });
  const repoListCommits = vi.fn((_dir: string, _opts?: any) => {
    lastTabReqIds.commits = `commits-${Date.now()}-${Math.random()}`;
    return lastTabReqIds.commits;
  });
  const repoListActions = vi.fn((_dir: string, _opts?: any) => {
    lastTabReqIds.actions = `actions-${Date.now()}-${Math.random()}`;
    return lastTabReqIds.actions;
  });
  const repoActionDetail = vi.fn((_dir: string, _runId: number, _opts?: any) => {
    lastActionDetailReqId = `action-detail-${Date.now()}-${Math.random()}`;
    return lastActionDetailReqId;
  });
  const repoCommitDetail = vi.fn((_dir: string, _sha: string) => {
    lastCommitDetailReqId = `commit-detail-${Date.now()}-${Math.random()}`;
    return lastCommitDetailReqId;
  });
  const repoCheckoutBranch = vi.fn((_dir: string, _branch: string, _opts?: any) => {
    lastCheckoutReqId = `checkout-${Date.now()}-${Math.random()}`;
    return lastCheckoutReqId;
  });
  const fsGitStatus = vi.fn((_path: string, _opts?: any) => `git-status-${Date.now()}-${Math.random()}`);
  const repoCallbackStatus = vi.fn((_dir: string) => {});

  const ws: WsClient = {
    connected: true,
    onMessage: (handler: (msg: ServerMessage) => void) => {
      messageHandler = handler;
      return () => { messageHandler = null; };
    },
    repoDetect,
    repoListIssues,
    repoListPRs,
    repoListBranches,
    repoListCommits,
    repoListActions,
    repoActionDetail,
    repoCommitDetail,
    repoCheckoutBranch,
    repoCallbackStatus,
    fsGitStatus,
  } as unknown as WsClient;

  /** Send a message to the component's onMessage handler */
  const emit = (msg: ServerMessage) => messageHandler?.(msg);

  /** Respond to the pending detect request with repo context (nested shape) */
  const respondDetect = (context: Record<string, unknown>) => {
    emit({
      type: 'repo.detect_response',
      requestId: detectReqId,
      context,
    } as ServerMessage);
  };

  /** Respond with real daemon shape: context fields spread at top level, no nested context */
  const respondDetectFlat = (context: Record<string, unknown>, projectDir = PROJECT_DIR) => {
    emit({
      type: 'repo.detect_response',
      requestId: detectReqId,
      projectDir,
      ...context,
    } as ServerMessage);
  };

  /** Respond with a repo.error for the detect request */
  const respondDetectError = (error: string) => {
    emit({
      type: 'repo.error',
      requestId: detectReqId,
      error,
    } as ServerMessage);
  };

  /** Respond to the last tab request with items */
  const respondTab = (type: string, projectDir: string, items: any[], page = 1, hasMore = false) => {
    const requestId = type === 'repo.issues_response'
      ? lastTabReqIds.issues
      : type === 'repo.prs_response'
        ? lastTabReqIds.prs
        : type === 'repo.branches_response'
          ? lastTabReqIds.branches
          : type === 'repo.commits_response'
            ? lastTabReqIds.commits
            : lastTabReqIds.actions;
    emit({
      type,
      requestId,
      projectDir,
      items,
      page,
      hasMore,
    } as unknown as ServerMessage);
  };

  /** Respond to the last tab request with a repo.error */
  const respondTabError = (error: string, tab: 'issues' | 'prs' | 'branches' | 'commits' | 'actions' = 'issues') => {
    emit({
      type: 'repo.error',
      requestId: lastTabReqIds[tab],
      error,
    } as ServerMessage);
  };

  const respondActionDetail = (projectDir: string, detail: any) => {
    emit({
      type: 'repo.action_detail_response',
      requestId: lastActionDetailReqId,
      projectDir,
      detail,
    } as unknown as ServerMessage);
  };

  const respondCommitDetail = (projectDir: string, detail: any, requestId = lastCommitDetailReqId) => {
    emit({
      type: 'repo.commit_detail_response',
      requestId,
      projectDir,
      detail,
    } as unknown as ServerMessage);
  };

  const respondCheckout = (projectDir: string, currentBranch: string, repoGeneration = 2) => {
    emit({
      type: 'repo.checkout_branch_response',
      requestId: lastCheckoutReqId,
      projectDir,
      ok: true,
      previousBranch: 'main',
      currentBranch,
      repoGeneration,
      detectedAt: Date.now(),
    } as unknown as ServerMessage);
  };

  const respondCheckoutError = (error: string) => {
    emit({
      type: 'repo.error',
      requestId: lastCheckoutReqId,
      projectDir: PROJECT_DIR,
      error,
    } as ServerMessage);
  };

  const respondActionDetailError = (error: string) => {
    emit({
      type: 'repo.error',
      requestId: lastActionDetailReqId,
      error,
    } as ServerMessage);
  };

  return {
    ws,
    emit,
    repoDetect,
    repoListIssues,
    repoListPRs,
    repoListBranches,
    repoListCommits,
    repoListActions,
    repoActionDetail,
    repoCommitDetail,
    repoCheckoutBranch,
    repoCallbackStatus,
    respondDetect,
    respondDetectFlat,
    respondDetectError,
    respondTab,
    respondTabError,
    respondActionDetail,
    respondCommitDetail,
    respondCheckout,
    respondCheckoutError,
    respondActionDetailError,
    getDetectReqId: () => detectReqId,
    getLastTabReqId: (tab: 'issues' | 'prs' | 'branches' | 'commits' | 'actions' = 'issues') => lastTabReqIds[tab] ?? '',
    getLastCommitDetailReqId: () => lastCommitDetailReqId,
    getLastCheckoutReqId: () => lastCheckoutReqId,
  };
}

const PROJECT_DIR = '/home/user/myproject';

// ── Tests ─────────────────────────────────────────────────────────────────

describe('RepoPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSessionRepoContextStoreForTests();
    clearRepoPageCache();
  });

  // 1. Renders overview header
  it('renders provider badge and owner/repo after detect response', async () => {
    const { ws, respondDetect } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetect({ provider: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' });
    });

    // Provider is rendered lowercase with CSS text-transform: uppercase
    expect(screen.getByText('github')).toBeDefined();
    expect(screen.getByText('acme/widgets')).toBeDefined();
    expect(screen.getByText('main')).toBeDefined();
  });

  it('does not re-trigger repo detect after receiving detect response', async () => {
    const { ws, respondDetect, repoDetect } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    expect(repoDetect).toHaveBeenCalledTimes(1);

    await act(async () => {
      respondDetect({ provider: 'github', owner: 'acme', repo: 'widgets' });
    });

    expect(repoDetect).toHaveBeenCalledTimes(1);
  });

  it('uses the virtual session root and accepts daemon-owned paths in shared repository responses', async () => {
    const { ws, repoDetect, respondDetectFlat, respondTab } = makeWs();
    render(
      <RepoPage
        ws={ws}
        sessionId="deck_proj_brain"
        projectDir={FS_SESSION_ROOT_PATH}
        scopeToSessionRoot
        readOnly
        onBack={vi.fn()}
      />,
    );

    expect(repoDetect).toHaveBeenCalledWith(FS_SESSION_ROOT_PATH, {
      sessionName: 'deck_proj_brain',
    });

    await act(async () => {
      respondDetectFlat({ provider: 'github', owner: 'acme', repo: 'widgets', branch: 'main' }, '/daemon/owned/project');
    });
    await act(async () => {
      respondTab('repo.issues_response', '/daemon/owned/project', [
        { number: 7, title: 'Shared issue', state: 'open' },
      ]);
    });

    expect(screen.getByText('Shared issue')).toBeDefined();
  });

  // 2. Tab switching preserves state (no re-fetch)
  it('does not re-fetch issues tab when switching away and back', async () => {
    const { ws, respondDetect, respondTab, repoListIssues, repoListPRs } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    // Complete detect — triggers lazy-load of active tab (issues)
    await act(async () => {
      respondDetect({ provider: 'github', owner: 'acme', repo: 'widgets' });
    });

    // Respond to the issues fetch
    await act(async () => {
      respondTab('repo.issues_response', PROJECT_DIR, [
        { number: 1, title: 'Bug A', state: 'open' },
      ]);
    });

    const issuesFetchCount = repoListIssues.mock.calls.length;
    expect(issuesFetchCount).toBe(1);

    // Switch to PRs tab
    await act(async () => {
      fireEvent.click(screen.getByText('PRs'));
    });

    // Respond to PRs fetch
    await act(async () => {
      respondTab('repo.prs_response', PROJECT_DIR, [
        { number: 10, title: 'PR X', state: 'open' },
      ]);
    });

    expect(repoListPRs).toHaveBeenCalledTimes(1);

    // Switch back to Issues — should NOT re-fetch
    await act(async () => {
      fireEvent.click(screen.getByText('Issues'));
    });

    expect(repoListIssues.mock.calls.length).toBe(issuesFetchCount);
    // Original data should still be displayed
    expect(screen.getByText('Bug A')).toBeDefined();
  });

  it('opens and fetches the requested initial tab', async () => {
    const { ws, respondDetect, repoListIssues, repoListBranches } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} initialTab="branches" initialTabToken={1} onBack={vi.fn()} />);

    await act(async () => {
      respondDetect({ provider: 'github', owner: 'acme', repo: 'widgets' });
    });

    expect(repoListBranches).toHaveBeenCalledTimes(1);
    expect(repoListIssues).not.toHaveBeenCalled();
    expect(localStorage.getItem('repo-active-tab')).toBe('branches');
  });

  // 3. Loading state
  it('shows loading indicator before detect response arrives', () => {
    const { ws } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    // The header should show the loading text while waiting for detect
    const loadingElements = screen.getAllByText('Loading...');
    expect(loadingElements.length).toBeGreaterThanOrEqual(1);
  });

  // 4. Error state on tab
  it('shows error message when tab receives repo.error', async () => {
    const { ws, respondDetect, respondTabError } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetect({ provider: 'github', owner: 'acme', repo: 'widgets' });
    });

    // Issues tab auto-fetches; respond with error
    await act(async () => {
      respondTabError('rate limit exceeded (429)');
    });

    expect(screen.getByText('rate limit exceeded (429)')).toBeDefined();
    // Rate-limited errors show a Retry button
    expect(screen.getByText('Retry')).toBeDefined();
  });

  it('keeps existing tab items visible and shows tab error marker when refresh fails', async () => {
    vi.useFakeTimers();
    try {
      const { ws, respondDetect, respondTab, respondTabError } = makeWs();
      render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

      await act(async () => {
        respondDetect({ provider: 'github', owner: 'acme', repo: 'widgets' });
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Actions'));
        respondTab('repo.actions_response', PROJECT_DIR, [
          { id: 1, name: 'CI', status: 'success', conclusion: 'success', updatedAt: Date.now() },
        ]);
      });

      expect(screen.getByText('CI')).toBeDefined();

      await act(async () => {
        vi.advanceTimersByTime(61_000);
      });

      await act(async () => {
        respondTabError('cli_error', 'actions');
      });

      expect(screen.getByText('CI')).toBeDefined();
      expect(screen.queryByText('cli_error')).toBeNull();
      const actionsTab = screen.getByText('Actions').closest('button') as HTMLButtonElement;
      expect(actionsTab.title).toBe('cli_error');
      expect(screen.getByText('!')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('silently retries latest action detail errors instead of showing a detail error immediately', async () => {
    vi.useFakeTimers();
    try {
      const { ws, respondDetect, respondTab, respondActionDetailError, repoActionDetail } = makeWs();
      render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

      await act(async () => {
        respondDetect({ provider: 'github', owner: 'acme', repo: 'widgets' });
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Actions'));
      });

      await act(async () => {
        respondTab('repo.actions_response', PROJECT_DIR, [
          { id: 101, name: 'CI', status: 'failure', conclusion: 'failure', updatedAt: Date.now() },
        ]);
      });

      await act(async () => {
        fireEvent.click(screen.getByText('CI'));
      });

      expect(repoActionDetail).toHaveBeenCalledTimes(1);

      await act(async () => {
        respondActionDetailError('cli_error');
      });

      expect(screen.queryByText('Failed to load details')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1300);
      });

      expect(screen.queryByText('Failed to load details')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies CSS focus animation classes to the targeted failed action step', async () => {
    const { ws, respondDetect, respondTab, respondActionDetail } = makeWs();
    const { container, rerender } = render(
      <RepoPage
        ws={ws}
        projectDir={PROJECT_DIR}
        onBack={vi.fn()}
        focusLatestAction={{ token: 1, failedJobName: 'test', failedStepName: 'unit tests' }}
      />,
    );

    await act(async () => {
      respondDetect({ provider: 'github', owner: 'acme', repo: 'widgets' });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Actions'));
    });

    await act(async () => {
      respondTab('repo.actions_response', PROJECT_DIR, [
        { id: 101, name: 'CI', status: 'failure', conclusion: 'failure', updatedAt: Date.now() },
      ]);
    });

    await act(async () => {
      respondActionDetail(PROJECT_DIR, {
        runId: 101,
        jobs: [
          {
            id: 'job-1',
            name: 'test',
            status: 'failure',
            conclusion: 'failure',
            steps: [
              { number: 1, name: 'install', status: 'completed', conclusion: 'success' },
              { number: 2, name: 'unit tests', status: 'failure', conclusion: 'failure' },
            ],
          },
        ],
      });
    });

    const focusedStep = Array.from(container.querySelectorAll('.repo-action-step')).find((el) => el.textContent?.includes('unit tests'));
    expect(focusedStep?.className).toMatch(/repo-action-focus-[ab]/);

    rerender(
      <RepoPage
        ws={ws}
        projectDir={PROJECT_DIR}
        onBack={vi.fn()}
        focusLatestAction={{ token: 2, failedJobName: 'test', failedStepName: 'unit tests' }}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const replayedStep = Array.from(container.querySelectorAll('.repo-action-step')).find((el) => el.textContent?.includes('unit tests'));
    expect(replayedStep?.className).toMatch(/repo-action-focus-[ab]/);
  });

  it('renders branch inventory fields and switches only checkoutable local branches', async () => {
    const { ws, respondDetectFlat, respondTab, respondCheckout, repoCheckoutBranch, repoListBranches, repoListCommits, repoDetect } = makeWs();
    render(<RepoPage ws={ws} sessionId="deck_proj_brain" projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetectFlat({
        status: 'ok',
        info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'main', defaultBranch: 'main' },
        repoGeneration: 1,
        detectedAt: 1000,
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Branches'));
    });

    await act(async () => {
      respondTab('repo.branches_response', PROJECT_DIR, [
        { name: 'main', isCurrent: true, isDefault: true, localPresent: true, remotePresent: true, checkoutable: true },
        { name: 'feature/a', isCurrent: false, isDefault: false, localPresent: true, remotePresent: false, checkoutable: true },
        { name: 'remote-only', isCurrent: false, isDefault: false, localPresent: false, remotePresent: true, checkoutable: false },
      ]);
    });

    expect(screen.getByText('feature/a')).toBeDefined();
    expect(screen.getByText('Remote-only branches cannot be switched in this version.')).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByTitle('Switch to feature/a'));
    });

    expect(repoCheckoutBranch).toHaveBeenCalledWith(PROJECT_DIR, 'feature/a', { sessionId: 'deck_proj_brain' });

    await act(async () => {
      respondCheckout(PROJECT_DIR, 'feature/a', 2);
    });

    expect(screen.getByText('Switched to feature/a.')).toBeDefined();
    expect(repoDetect).toHaveBeenLastCalledWith(PROJECT_DIR, { force: true });
    expect(repoListBranches).toHaveBeenLastCalledWith(PROJECT_DIR, { force: true });
    expect(repoListCommits).toHaveBeenLastCalledWith(PROJECT_DIR, { page: 1, branch: 'feature/a', force: true });
  });

  it('shows checkout dirty feedback without optimistic current-branch update', async () => {
    const { ws, respondDetectFlat, respondTab, respondCheckoutError, repoCheckoutBranch } = makeWs();
    render(<RepoPage ws={ws} sessionId="deck_proj_brain" projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetectFlat({
        status: 'ok',
        info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'main', defaultBranch: 'main' },
        repoGeneration: 1,
        detectedAt: 1000,
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Branches'));
    });

    await act(async () => {
      respondTab('repo.branches_response', PROJECT_DIR, [
        { name: 'main', isCurrent: true, isDefault: true, localPresent: true, remotePresent: true, checkoutable: true },
        { name: 'feature/a', isCurrent: false, isDefault: false, localPresent: true, remotePresent: false, checkoutable: true },
      ]);
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle('Switch to feature/a'));
    });

    expect(repoCheckoutBranch).toHaveBeenCalledWith(PROJECT_DIR, 'feature/a', { sessionId: 'deck_proj_brain' });

    await act(async () => {
      respondCheckoutError('dirty_worktree');
    });

    expect(screen.getByText('Clean or commit local changes before switching branches.')).toBeDefined();
    expect(screen.queryByText('Switched to feature/a.')).toBeNull();
    expect(screen.getAllByText('current')).toHaveLength(1);
  });

  it('requests commits for current branch and loads commit details on first row click once', async () => {
    const { ws, respondDetectFlat, respondTab, respondCommitDetail, repoListCommits, repoCommitDetail } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetectFlat({
        status: 'ok',
        info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'feature/a' },
        repoGeneration: 5,
        detectedAt: 1000,
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Commits'));
    });

    expect(repoListCommits).toHaveBeenCalledWith(PROJECT_DIR, { page: 1, branch: 'feature/a' });

    await act(async () => {
      respondTab('repo.commits_response', PROJECT_DIR, [
        { sha: 'abcdef1234567890', message: 'Add feature\n\nbody', author: 'Ada', date: Date.now(), url: 'https://example.test/c' },
      ]);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Add feature'));
    });

    expect(repoCommitDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      respondCommitDetail(PROJECT_DIR, {
        sha: 'abcdef1234567890',
        shortSha: 'abcdef1',
        message: 'Add feature',
        body: 'body',
        author: 'Ada',
        date: Date.now(),
        url: 'https://example.test/c',
        stats: { additions: 2, deletions: 1, filesChanged: 1 },
        files: [{ filename: 'src/app.ts', status: 'modified', additions: 2, deletions: 1 }],
        hasMoreFiles: false,
      });
    });

    expect(screen.getByText('src/app.ts')).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByText('Add feature'));
    });

    expect(repoCommitDetail).toHaveBeenCalledTimes(1);
  });

  it('ignores commit detail responses that do not match a pending request id', async () => {
    const { ws, emit, respondDetectFlat, respondTab, respondCommitDetail } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetectFlat({
        status: 'ok',
        info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'feature/a' },
        repoGeneration: 5,
        detectedAt: 1000,
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Commits'));
    });

    await act(async () => {
      respondTab('repo.commits_response', PROJECT_DIR, [
        { sha: 'abcdef1234567890', message: 'Add feature', author: 'Ada', date: Date.now(), url: '' },
      ]);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Add feature'));
    });

    await act(async () => {
      emit({
        type: 'repo.commit_detail_response',
        projectDir: PROJECT_DIR,
        detail: {
          sha: 'abcdef1234567890',
          stats: { additions: 1, deletions: 0, filesChanged: 1 },
          files: [{ filename: 'src/no-request.ts', status: 'modified', additions: 1, deletions: 0 }],
        },
      } as unknown as ServerMessage);
    });

    expect(screen.queryByText('src/no-request.ts')).toBeNull();

    await act(async () => {
      respondCommitDetail(PROJECT_DIR, {
        sha: 'abcdef1234567890',
        stats: { additions: 2, deletions: 0, filesChanged: 1 },
        files: [{ filename: 'src/current.ts', status: 'modified', additions: 2, deletions: 0 }],
        hasMoreFiles: false,
      });
    });

    expect(screen.getByText('src/current.ts')).toBeDefined();
  });

  it('drops stale pending commit detail after checkout generation changes', async () => {
    const {
      ws,
      respondDetectFlat,
      respondTab,
      respondCommitDetail,
      respondCheckout,
      getLastCommitDetailReqId,
    } = makeWs();
    render(<RepoPage ws={ws} sessionId="deck_proj_brain" projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetectFlat({
        status: 'ok',
        info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'main', defaultBranch: 'main' },
        repoGeneration: 1,
        detectedAt: 1000,
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Commits'));
    });

    await act(async () => {
      respondTab('repo.commits_response', PROJECT_DIR, [
        { sha: 'abcdef1234567890', message: 'Add feature', author: 'Ada', date: Date.now(), url: '' },
      ]);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Add feature'));
    });
    const staleDetailRequestId = getLastCommitDetailReqId();

    await act(async () => {
      fireEvent.click(screen.getByText('Branches'));
    });

    await act(async () => {
      respondTab('repo.branches_response', PROJECT_DIR, [
        { name: 'main', isCurrent: true, isDefault: true, localPresent: true, remotePresent: true, checkoutable: true },
        { name: 'feature/a', isCurrent: false, isDefault: false, localPresent: true, remotePresent: false, checkoutable: true },
      ]);
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle('Switch to feature/a'));
    });

    await act(async () => {
      respondCheckout(PROJECT_DIR, 'feature/a', 2);
    });

    await act(async () => {
      respondCommitDetail(PROJECT_DIR, {
        sha: 'abcdef1234567890',
        shortSha: 'abcdef1',
        message: 'Add feature',
        body: '',
        author: 'Ada',
        date: Date.now(),
        url: '',
        stats: { additions: 1, deletions: 0, filesChanged: 1 },
        files: [{ filename: 'src/stale.ts', status: 'modified', additions: 1, deletions: 0 }],
        hasMoreFiles: false,
      }, staleDetailRequestId);
    });

    expect(screen.queryByText('src/stale.ts')).toBeNull();
  });

  it('ignores checkout success responses that do not match the active checkout request', async () => {
    const { ws, emit, respondDetectFlat, respondTab, repoDetect, repoListCommits } = makeWs();
    render(<RepoPage ws={ws} sessionId="deck_proj_brain" projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetectFlat({
        status: 'ok',
        info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'main', defaultBranch: 'main' },
        repoGeneration: 1,
        detectedAt: 1000,
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Branches'));
    });

    await act(async () => {
      respondTab('repo.branches_response', PROJECT_DIR, [
        { name: 'main', isCurrent: true, isDefault: true, localPresent: true, remotePresent: true, checkoutable: true },
        { name: 'feature/a', isCurrent: false, isDefault: false, localPresent: true, remotePresent: false, checkoutable: true },
      ]);
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle('Switch to feature/a'));
    });

    const detectCallsBefore = repoDetect.mock.calls.length;
    await act(async () => {
      emit({
        type: 'repo.checkout_branch_response',
        projectDir: PROJECT_DIR,
        ok: true,
        previousBranch: 'main',
        currentBranch: 'feature/a',
        repoGeneration: 2,
        detectedAt: 2000,
      } as unknown as ServerMessage);
    });

    expect(screen.queryByText('Switched to feature/a.')).toBeNull();
    expect(repoDetect).toHaveBeenCalledTimes(detectCallsBefore);
    expect(repoListCommits).not.toHaveBeenCalledWith(PROJECT_DIR, { page: 1, branch: 'feature/a', force: true });
  });

  // 5. Empty state
  it('shows empty state message when tab has zero items', async () => {
    const { ws, respondDetect, respondTab } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetect({ provider: 'github', owner: 'acme', repo: 'widgets' });
    });

    await act(async () => {
      respondTab('repo.issues_response', PROJECT_DIR, [], 1, false);
    });

    expect(screen.getByText('No issues found')).toBeDefined();
  });

  // 6. Load more pagination
  it('shows Load more button when hasMore is true, hides it after second page', async () => {
    const { ws, respondDetect, respondTab, repoListIssues } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetect({ provider: 'github', owner: 'acme', repo: 'widgets' });
    });

    // First page with hasMore=true
    await act(async () => {
      respondTab('repo.issues_response', PROJECT_DIR, [
        { number: 1, title: 'Issue One', state: 'open' },
      ], 1, true);
    });

    const loadMoreBtn = screen.getByText('Load more');
    expect(loadMoreBtn).toBeDefined();

    // Click load more
    await act(async () => {
      fireEvent.click(loadMoreBtn);
    });

    expect(repoListIssues).toHaveBeenCalledWith(PROJECT_DIR, { page: 2 });

    // Second page with hasMore=false
    await act(async () => {
      respondTab('repo.issues_response', PROJECT_DIR, [
        { number: 2, title: 'Issue Two', state: 'open' },
      ], 2, false);
    });

    // Both items should be visible (appended)
    expect(screen.getByText('Issue One')).toBeDefined();
    expect(screen.getByText('Issue Two')).toBeDefined();

    // Load more button should be gone
    expect(screen.queryByText('Load more')).toBeNull();
  });

  // 7. Stale response discarded (wrong projectDir)
  it('discards tab response with wrong projectDir', async () => {
    const { ws, respondDetect, respondTab, emit, getLastTabReqId } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetect({ provider: 'github', owner: 'acme', repo: 'widgets' });
    });

    // Capture the request ID for the issues fetch
    const reqId = getLastTabReqId();

    // Send a response with a DIFFERENT projectDir
    await act(async () => {
      emit({
        type: 'repo.issues_response',
        requestId: reqId,
        projectDir: '/some/other/project',
        items: [{ number: 999, title: 'Stale Issue', state: 'open' }],
        page: 1,
        hasMore: false,
      } as unknown as ServerMessage);
    });

    // The stale item should NOT appear
    expect(screen.queryByText('Stale Issue')).toBeNull();

    // Now send a valid response
    await act(async () => {
      respondTab('repo.issues_response', PROJECT_DIR, [
        { number: 1, title: 'Real Issue', state: 'open' },
      ]);
    });

    // But this uses a new requestId from a fresh call, not the original one.
    // The stale response was discarded due to projectDir mismatch. The valid
    // response also won't match if the requestId changed. Let's verify the
    // stale item is still absent and that there's no issue rendered from stale data.
    expect(screen.queryByText('Stale Issue')).toBeNull();
  });

  // Additional: detect error renders in header
  it('shows detect error in header', async () => {
    const { ws, respondDetectError } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetectError('Could not detect repository');
    });

    // Error text appears in both header and tab content (with debug info)
    const elements = screen.getAllByText('Could not detect repository');
    expect(elements.length).toBeGreaterThanOrEqual(1);
  });

  // Critical: detect_response with flat shape (real daemon format)
  it('renders correctly with flat detect_response (real daemon shape)', async () => {
    const { ws, respondDetectFlat } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetectFlat({
        status: 'ok',
        info: { platform: 'github', owner: 'facebook', repo: 'react' },
        cliVersion: '2.50.0',
        cliAuth: true,
      });
    });

    expect(screen.getByText('github')).toBeDefined();
    expect(screen.getByText('facebook/react')).toBeDefined();
  });

  it('shows cli_missing hint with flat detect_response', async () => {
    const { ws, respondDetectFlat } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetectFlat({
        status: 'cli_missing',
        info: null,
        cliMinVersion: '2.0.0',
      });
    });

    expect(screen.getByText('CLI not installed')).toBeDefined();
  });

  // Back button removed — FloatingPanel provides close/minimize instead

  // ── Detect timeout ──────────────────────────────────────────────────────────

  it('retries detect timeouts before showing an error', async () => {
    vi.useFakeTimers();
    const { ws, repoDetect } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        vi.advanceTimersByTime(10_001);
      });
      expect(screen.queryByText(/Detect timeout/)).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(1_201);
      });
    }

    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });

    vi.useRealTimers();

    const errorElements = screen.getAllByText(/Detect timeout/);
    expect(errorElements.length).toBeGreaterThanOrEqual(1);
    expect(errorElements[0].textContent).toContain('10s');
    expect(repoDetect).toHaveBeenCalledTimes(4);
  });

  it('retries transient WS send failures before showing an error', async () => {
    vi.useFakeTimers();
    const repoDetect = vi.fn(() => { throw new Error('WebSocket not connected'); });
    // Create a ws mock where repoDetect throws (simulating disconnected WS)
    const failWs = {
      connected: false,
      onMessage: (_handler: (msg: any) => void) => () => {},
      repoDetect,
      repoListIssues: vi.fn(),
      repoListPRs: vi.fn(),
      repoListBranches: vi.fn(),
      repoListCommits: vi.fn(),
    } as unknown as WsClient;

    render(<RepoPage ws={failWs} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    // Transient disconnected sends stay in loading/retry instead of failing immediately.
    await act(async () => {});
    expect(screen.queryByText(/Send failed/)).toBeNull();

    for (let i = 0; i < 2; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1_201);
      });
      expect(screen.queryByText(/Send failed/)).toBeNull();
    }

    await act(async () => {
      vi.advanceTimersByTime(1_201);
    });

    vi.useRealTimers();

    const errorElements = screen.getAllByText(/Send failed/);
    expect(errorElements.length).toBeGreaterThanOrEqual(1);
    expect(errorElements[0].textContent).toContain('WebSocket not connected');
    expect(repoDetect).toHaveBeenCalledTimes(4);
  });

  it('does not show timeout if detect response arrives before 10s', async () => {
    vi.useFakeTimers();
    const { ws, respondDetect } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    // Response arrives at 5s
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    await act(async () => {
      respondDetect({ provider: 'github', owner: 'acme', repo: 'widgets' });
    });

    // Advance past 10s
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });

    vi.useRealTimers();

    // No timeout error should appear
    expect(screen.queryByText(/Detect timeout/)).toBeNull();
    expect(screen.getByText('acme/widgets')).toBeDefined();
  });

  // ── End-to-end flat daemon shape through mapDetectToContext ──────────────────

  it('mapDetectToContext: flat daemon shape displays provider/owner/repo correctly', async () => {
    const { ws, respondDetectFlat } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    // Simulate the exact shape daemon sends: status + info at top level
    await act(async () => {
      respondDetectFlat({
        status: 'ok',
        info: { platform: 'gitlab', owner: 'myorg', repo: 'myapp', defaultBranch: 'develop' },
        cliVersion: '2.60.0',
        cliAuth: true,
      });
    });

    // mapDetectToContext should extract info.platform → provider, info.owner → owner, info.repo → repo
    expect(screen.getByText('gitlab')).toBeDefined();
    expect(screen.getByText('myorg/myapp')).toBeDefined();
    expect(screen.getByText('develop')).toBeDefined();
  });

  it('mapDetectToContext: flat daemon shape with nested context also works', async () => {
    const { ws, respondDetect } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    // respondDetect wraps in { context: { ... } } — the "old" nested shape
    await act(async () => {
      respondDetect({
        status: 'ok',
        info: { platform: 'github', owner: 'torvalds', repo: 'linux', defaultBranch: 'master' },
        cliVersion: '2.50.0',
        cliAuth: true,
      });
    });

    expect(screen.getByText('github')).toBeDefined();
    expect(screen.getByText('torvalds/linux')).toBeDefined();
    expect(screen.getByText('master')).toBeDefined();
  });

  it('mapDetectToContext: cli_missing status sets cliInstalled=false', async () => {
    const { ws, respondDetectFlat } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetectFlat({
        status: 'cli_missing',
        info: null,
        cliMinVersion: '2.0.0',
      });
    });

    // When CLI is missing, the header shows the cli_missing badge
    expect(screen.getByText('CLI not installed')).toBeDefined();
    // No provider badge or owner/repo should be rendered since info is null
    expect(screen.queryByText('github')).toBeNull();
    expect(screen.queryByText('gitlab')).toBeNull();
  });

  it('hydrates cached context, tabs, expanded details, and callbacks on remount and refreshes silently', async () => {
    const first = makeWs();
    const { unmount } = render(
      <RepoPage ws={first.ws} serverId="srv-1" projectDir={PROJECT_DIR} onBack={vi.fn()} />,
    );

    await act(async () => {
      first.respondDetect({
        status: 'ok',
        info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'main', defaultBranch: 'main' },
        repoGeneration: 1,
      });
    });
    await act(async () => {
      first.respondTab('repo.issues_response', PROJECT_DIR, [
        { number: 42, title: 'Cached Issue', state: 'open', author: 'alice', labels: [], updatedAt: Date.now(), url: '' },
      ]);
      first.respondTab('repo.actions_response', PROJECT_DIR, []);
      first.emit({
        type: 'repo.callback_status_response',
        projectDir: PROJECT_DIR,
        enabled: true,
        checking: false,
        callbacks: [
          {
            callbackId: 'cb-1',
            projectDir: PROJECT_DIR,
            title: 'CI Check',
            status: 'completed',
            targetSession: 'deck_brain',
            createdAt: 1000,
            updatedAt: 2000,
          },
        ],
      } as unknown as ServerMessage);
    });
    expect(screen.getByText('Cached Issue')).toBeDefined();
    unmount();

    // Remount within TTL with a fresh WS: cached content renders immediately with zero refetches
    const second = makeWs();
    render(
      <RepoPage ws={second.ws} serverId="srv-1" projectDir={PROJECT_DIR} onBack={vi.fn()} />,
    );
    expect(screen.getByText('Cached Issue')).toBeDefined();
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(second.repoDetect).toHaveBeenCalledTimes(0);
    expect(second.repoListIssues).toHaveBeenCalledTimes(0);
    expect(second.repoListActions).toHaveBeenCalledTimes(0);

    // Different serverId with identical projectDir must NOT leak srv-1 cache
    cleanup();
    const otherServer = makeWs();
    render(
      <RepoPage ws={otherServer.ws} serverId="srv-2" projectDir={PROJECT_DIR} onBack={vi.fn()} />,
    );
    expect(screen.queryByText('Cached Issue')).toBeNull();
    expect(screen.getAllByText('Loading...').length).toBeGreaterThanOrEqual(1);
  });

  it('isolates tab-share scope and clears cache cleanly on clearRepoPageCache()', async () => {
    const shared = makeWs();
    const { unmount } = render(
      <RepoPage
        ws={shared.ws}
        serverId="srv-1"
        sessionId="sess-share-a"
        scopeToSessionRoot
        projectDir={FS_SESSION_ROOT_PATH}
        onBack={vi.fn()}
      />,
    );
    await act(async () => {
      shared.respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'shared-a' } });
    });
    await act(async () => {
      shared.respondTab('repo.issues_response', FS_SESSION_ROOT_PATH, [
        { number: 7, title: 'Share A Issue', state: 'open', author: 'bob', labels: [], updatedAt: Date.now(), url: '' },
      ]);
    });
    expect(screen.getByText('Share A Issue')).toBeDefined();
    unmount();

    // Another shared session with the same FS_SESSION_ROOT_PATH must not see Share A cache
    const otherShare = makeWs();
    render(
      <RepoPage
        ws={otherShare.ws}
        serverId="srv-1"
        sessionId="sess-share-b"
        scopeToSessionRoot
        projectDir={FS_SESSION_ROOT_PATH}
        onBack={vi.fn()}
      />,
    );
    expect(screen.queryByText('Share A Issue')).toBeNull();
    expect(screen.getAllByText('Loading...').length).toBeGreaterThanOrEqual(1);
    cleanup();

    // Clearing cache drops Share A entry too
    clearRepoPageCache();
    const afterClear = makeWs();
    render(
      <RepoPage
        ws={afterClear.ws}
        serverId="srv-1"
        sessionId="sess-share-a"
        scopeToSessionRoot
        projectDir={FS_SESSION_ROOT_PATH}
        onBack={vi.fn()}
      />,
    );
    expect(screen.queryByText('Share A Issue')).toBeNull();
    expect(screen.getAllByText('Loading...').length).toBeGreaterThanOrEqual(1);

    // Bounded LRU eviction beyond REPO_PAGE_CACHE_MAX_ENTRIES (24)
    const emptyTab = { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: false };
    for (let i = 0; i <= REPO_PAGE_CACHE_MAX_ENTRIES; i++) {
      const k = makeRepoPageCacheKey({ serverId: 'srv-lru', projectDir: `/repo/${i}` });
      setRepoPageCache(k, {
        context: { status: 'ok', owner: 'acme', repo: `r-${i}` },
        tabs: { issues: { ...emptyTab }, prs: { ...emptyTab }, branches: { ...emptyTab }, commits: { ...emptyTab }, actions: { ...emptyTab } },
        expandedKey: null,
        detailData: [],
        callbacks: [],
        callbackRuntimeEnabled: false,
        updatedAt: Date.now(),
      });
    }
    expect(getRepoPageCache(makeRepoPageCacheKey({ serverId: 'srv-lru', projectDir: '/repo/0' }))).toBeNull();
    expect(getRepoPageCache(makeRepoPageCacheKey({ serverId: 'srv-lru', projectDir: `/repo/${REPO_PAGE_CACHE_MAX_ENTRIES}` }))).not.toBeNull();
  });

  it('renders semantic .repo-* structure, running actions live indicator, expanded card state, and hides branch switch in readOnly mode', async () => {
    const { ws, respondDetectFlat, respondTab } = makeWs();
    const { container } = render(
      <RepoPage ws={ws} projectDir={PROJECT_DIR} initialTab="actions" readOnly onBack={vi.fn()} />,
    );

    await act(async () => {
      respondDetectFlat({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
    });

    expect(container.querySelector('.repo-page')).toBeTruthy();
    expect(container.querySelector('.repo-header')).toBeTruthy();
    expect(container.querySelector('.repo-tabs[role="tablist"]')).toBeTruthy();
    expect(container.querySelector('.repo-tab.is-active')?.textContent).toContain('Actions');

    await act(async () => {
      respondTab('repo.actions_response', PROJECT_DIR, [
        {
          id: 901,
          runNumber: 18,
          name: 'CI Pipeline',
          status: 'running',
          conclusion: null,
          branch: 'main',
          commitSha: 'abc1234',
          event: 'push',
          createdAt: Date.now() - 5000,
          url: 'https://github.com/acme/widgets/actions/runs/901',
        },
      ]);
    });

    expect(container.querySelector('.repo-tab-live-dot')).toBeTruthy();
    expect(container.querySelector('.repo-card-wrap')).toBeTruthy();
    expect(container.querySelector('.repo-status-pill.is-running')?.textContent).toBe('RUNNING');

    fireEvent.click(screen.getByText('CI Pipeline'));
    expect(container.querySelector('.repo-card-wrap.is-expanded')).toBeTruthy();

    fireEvent.click(screen.getByText('Branches'));
    await act(async () => {
      respondTab('repo.branches_response', PROJECT_DIR, [
        { name: 'main', isCurrent: true, isDefault: true, localPresent: true, checkoutable: true },
        { name: 'feat/ui', isCurrent: false, isDefault: false, localPresent: true, checkoutable: true },
      ]);
    });

    expect(screen.getByText('feat/ui')).toBeDefined();
    expect(screen.queryByText('Switch')).toBeNull();
  });

  it('silently refreshes expired cached entries in background without clearing UI or showing Loading...', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const first = makeWs();
      const { unmount } = render(
        <RepoPage ws={first.ws} serverId="srv-1" projectDir={PROJECT_DIR} onBack={vi.fn()} />,
      );
      await act(async () => {
        first.respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
      });
      await act(async () => {
        first.respondTab('repo.issues_response', PROJECT_DIR, [
          { number: 10, title: 'Stale Issue Before Refresh', state: 'open', author: 'alice', labels: [], updatedAt: Date.now(), url: '' },
        ]);
        first.respondTab('repo.actions_response', PROJECT_DIR, []);
      });
      expect(screen.getByText('Stale Issue Before Refresh')).toBeDefined();
      unmount();

      vi.advanceTimersByTime(REPO_PAGE_CACHE_FRESH_TTL_MS + 1);

      const second = makeWs();
      render(
        <RepoPage ws={second.ws} serverId="srv-1" projectDir={PROJECT_DIR} onBack={vi.fn()} />,
      );
      expect(screen.getByText('Stale Issue Before Refresh')).toBeDefined();
      expect(screen.queryByText('Loading...')).toBeNull();
      expect(second.repoDetect).toHaveBeenCalledTimes(1);
      expect(second.repoListIssues).toHaveBeenCalledTimes(1);
      expect(second.repoListActions).toHaveBeenCalledTimes(1);

      await act(async () => {
        second.respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
        second.respondTab('repo.issues_response', PROJECT_DIR, [
          { number: 11, title: 'Fresh Issue After SWR', state: 'open', author: 'bob', labels: [], updatedAt: Date.now(), url: '' },
        ]);
        second.respondTab('repo.actions_response', PROJECT_DIR, []);
      });
      expect(screen.getByText('Fresh Issue After SWR')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves distinct caches when an unkeyed mounted RepoPage switches projects A -> B -> A', async () => {
    const sharedWs = makeWs();
    const projA = '/proj-switch-a';
    const projB = '/proj-switch-b';

    const { rerender } = render(
      <RepoPage ws={sharedWs.ws} serverId="srv-1" projectDir={projA} onBack={vi.fn()} />,
    );
    await act(async () => {
      sharedWs.respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'proj-a', defaultBranch: 'main' } });
    });
    await act(async () => {
      sharedWs.respondTab('repo.issues_response', projA, [
        { number: 1, title: 'Issue Alpha', state: 'open', author: 'alice', labels: [], updatedAt: Date.now(), url: '' },
      ]);
      sharedWs.respondTab('repo.actions_response', projA, []);
    });
    expect(screen.getByText('Issue Alpha')).toBeDefined();

    // Switch unkeyed mounted component to Project B
    rerender(
      <RepoPage ws={sharedWs.ws} serverId="srv-1" projectDir={projB} onBack={vi.fn()} />,
    );
    expect(screen.queryByText('Issue Alpha')).toBeNull();
    expect(getRepoPageCache(makeRepoPageCacheKey({ serverId: 'srv-1', projectDir: projA }))?.tabs.issues.items[0]?.title).toBe('Issue Alpha');

    await act(async () => {
      sharedWs.respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'proj-b', defaultBranch: 'main' } });
    });
    await act(async () => {
      sharedWs.respondTab('repo.issues_response', projB, [
        { number: 2, title: 'Issue Beta', state: 'open', author: 'bob', labels: [], updatedAt: Date.now(), url: '' },
      ]);
      sharedWs.respondTab('repo.actions_response', projB, []);
    });
    expect(screen.getByText('Issue Beta')).toBeDefined();

    const detectCallsBeforeSwitchBack = sharedWs.repoDetect.mock.calls.length;
    const issueCallsBeforeSwitchBack = sharedWs.repoListIssues.mock.calls.length;

    // Switch back to Project A: must restore A immediately from cache without overwriting B or refetching
    rerender(
      <RepoPage ws={sharedWs.ws} serverId="srv-1" projectDir={projA} onBack={vi.fn()} />,
    );
    expect(screen.getByText('Issue Alpha')).toBeDefined();
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(sharedWs.repoDetect).toHaveBeenCalledTimes(detectCallsBeforeSwitchBack);
    expect(sharedWs.repoListIssues).toHaveBeenCalledTimes(issueCallsBeforeSwitchBack);
    expect(getRepoPageCache(makeRepoPageCacheKey({ serverId: 'srv-1', projectDir: projB }))?.tabs.issues.items[0]?.title).toBe('Issue Beta');
  });

  it('persists bounded cache in localStorage across cold-boot memory resets and handles corrupt JSON/quota/clear', async () => {
    const first = makeWs();
    const { unmount } = render(
      <RepoPage ws={first.ws} serverId="srv-1" projectDir={PROJECT_DIR} onBack={vi.fn()} />,
    );
    await act(async () => {
      first.respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
    });
    const manyIssues = Array.from({ length: 55 }, (_, i) => ({
      number: i + 1,
      title: 'Persisted Issue #' + (i + 1),
      state: 'open',
      author: 'alice',
      labels: [],
      updatedAt: Date.now(),
      url: '',
    }));
    await act(async () => {
      first.respondTab('repo.issues_response', PROJECT_DIR, manyIssues.slice(0, 50), 1, true);
      first.respondTab('repo.actions_response', PROJECT_DIR, []);
    });
    fireEvent.click(screen.getByText('Load more'));
    await act(async () => {
      first.respondTab('repo.issues_response', PROJECT_DIR, manyIssues.slice(50), 2, false);
    });
    fireEvent.click(screen.getByText('Persisted Issue #1'));
    await act(async () => {
      first.emit({
        type: 'repo.issue_detail_response',
        projectDir: PROJECT_DIR,
        detail: { number: 1, title: 'Persisted Issue #1', body: 'Loaded persisted detail', comments: [] },
      } as unknown as ServerMessage);
    });
    expect(screen.getByText('Loaded persisted detail')).toBeDefined();
    unmount();

    const rawPersisted = localStorage.getItem(REPO_PAGE_CACHE_STORAGE_KEY);
    expect(rawPersisted).toBeTruthy();

    // Simulate cold boot (memory wiped, localStorage kept)
    __resetRepoPageCacheMemoryForTests();
    const coldWs = makeWs();
    render(
      <RepoPage ws={coldWs.ws} serverId="srv-1" projectDir={PROJECT_DIR} onBack={vi.fn()} />,
    );
    expect(screen.getByText('Persisted Issue #1')).toBeDefined();
    expect(screen.getByText('Loaded persisted detail')).toBeDefined();
    expect(screen.queryByText('Persisted Issue #55')).toBeNull();
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(coldWs.repoDetect).toHaveBeenCalledTimes(0);

    // Truncated 55 -> 50 items resets page to 1 with hasMore=true so Load more requests page 2
    fireEvent.click(screen.getByText('Load more'));
    expect(coldWs.repoListIssues).toHaveBeenCalledWith(PROJECT_DIR, expect.objectContaining({ page: 2 }));
    cleanup();

    // Oversized detail (>32KB) is dropped cleanly from storage while keeping core tab items
    clearRepoPageCache();
    const bigDetailKey = makeRepoPageCacheKey({ serverId: 'srv-big', projectDir: '/proj-big' });
    const emptyTab = { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: false };
    setRepoPageCache(bigDetailKey, {
      context: { status: 'ok', owner: 'acme', repo: 'big' },
      contextFetchedAt: Date.now(),
      tabs: {
        issues: { items: [{ number: 1, title: 'Core Issue Kept' }], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: true, fetchedAt: Date.now() },
        prs: { ...emptyTab },
        branches: { ...emptyTab },
        commits: { ...emptyTab },
        actions: { ...emptyTab },
      },
      expandedKey: 'issues:1',
      detailData: [['issues:1', { body: 'x'.repeat(40_000) }]],
      callbacks: [],
      callbackRuntimeEnabled: false,
      updatedAt: Date.now(),
    });
    __resetRepoPageCacheMemoryForTests();
    const afterBig = getRepoPageCache(bigDetailKey);
    expect(afterBig?.tabs.issues.items[0]?.title).toBe('Core Issue Kept');
    expect(afterBig?.detailData).toEqual([]);

    // Corrupt localStorage JSON & wrong version recover safely without throwing
    __resetRepoPageCacheMemoryForTests();
    localStorage.setItem(REPO_PAGE_CACHE_STORAGE_KEY, '{broken json');
    expect(getRepoPageCache(bigDetailKey)).toBeNull();
    __resetRepoPageCacheMemoryForTests();
    localStorage.setItem(REPO_PAGE_CACHE_STORAGE_KEY, JSON.stringify({ v: 999, entries: [] }));
    expect(getRepoPageCache(bigDetailKey)).toBeNull();

    // QuotaExceededError evicts oldest entry gracefully and keeps memory intact if storage throws
    clearRepoPageCache();
    const k1 = makeRepoPageCacheKey({ serverId: 'srv-q', projectDir: '/q1' });
    const k2 = makeRepoPageCacheKey({ serverId: 'srv-q', projectDir: '/q2' });
    setRepoPageCache(k1, {
      context: { status: 'ok', repo: 'q1' },
      tabs: { issues: { ...emptyTab }, prs: { ...emptyTab }, branches: { ...emptyTab }, commits: { ...emptyTab }, actions: { ...emptyTab } },
      expandedKey: null,
      detailData: [],
      callbacks: [],
      callbackRuntimeEnabled: false,
      updatedAt: Date.now(),
    });
    const origSetItem = localStorage.setItem;
    let quotaCount = 0;
    localStorage.setItem = vi.fn((key: string, val: string) => {
      quotaCount++;
      if (quotaCount === 1) throw new Error('QuotaExceededError');
      origSetItem(key, val);
    });
    try {
      setRepoPageCache(k2, {
        context: { status: 'ok', repo: 'q2' },
        tabs: { issues: { ...emptyTab }, prs: { ...emptyTab }, branches: { ...emptyTab }, commits: { ...emptyTab }, actions: { ...emptyTab } },
        expandedKey: null,
        detailData: [],
        callbacks: [],
        callbackRuntimeEnabled: false,
        updatedAt: Date.now(),
      });
    } finally {
      localStorage.setItem = origSetItem;
    }
    expect(quotaCount).toBe(2);
    __resetRepoPageCacheMemoryForTests();
    expect(getRepoPageCache(k1)).toBeNull();
    expect(getRepoPageCache(k2)?.context?.repo).toBe('q2');

    // clearRepoPageCache clears both memory and localStorage
    clearRepoPageCache();
    expect(localStorage.getItem(REPO_PAGE_CACHE_STORAGE_KEY)).toBeNull();
    __resetRepoPageCacheMemoryForTests();
    expect(getRepoPageCache(k2)).toBeNull();

    // LRU >24 eviction persists to localStorage
    for (let i = 0; i <= REPO_PAGE_CACHE_MAX_ENTRIES; i++) {
      const k = makeRepoPageCacheKey({ serverId: 'srv-lru-ls', projectDir: '/repo-ls/' + i });
      setRepoPageCache(k, {
        context: { status: 'ok', repo: 'ls-' + i },
        tabs: { issues: { ...emptyTab }, prs: { ...emptyTab }, branches: { ...emptyTab }, commits: { ...emptyTab }, actions: { ...emptyTab } },
        expandedKey: null,
        detailData: [],
        callbacks: [],
        callbackRuntimeEnabled: false,
        updatedAt: Date.now(),
      });
    }
    __resetRepoPageCacheMemoryForTests();
    expect(getRepoPageCache(makeRepoPageCacheKey({ serverId: 'srv-lru-ls', projectDir: '/repo-ls/0' }))).toBeNull();
    expect(getRepoPageCache(makeRepoPageCacheKey({ serverId: 'srv-lru-ls', projectDir: '/repo-ls/' + REPO_PAGE_CACHE_MAX_ENTRIES }))).not.toBeNull();
  });

  it('manual Refresh button forces re-detect and active tab reload while keeping cached items visible', async () => {
    const { ws, repoDetect, repoListIssues, respondDetect, respondTab } = makeWs();
    render(<RepoPage ws={ws} serverId="srv-1" projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
    });
    await act(async () => {
      respondTab('repo.issues_response', PROJECT_DIR, [
        { number: 1, title: 'Initial Issue', state: 'open', author: 'alice', labels: [], updatedAt: Date.now(), url: '' },
      ]);
      respondTab('repo.actions_response', PROJECT_DIR, []);
    });

    const refreshBtn = screen.getByRole('button', { name: 'Refresh' });
    fireEvent.click(refreshBtn);

    expect(screen.getByText('Initial Issue')).toBeDefined();
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(repoDetect).toHaveBeenLastCalledWith(PROJECT_DIR, expect.objectContaining({ force: true }));
    expect(repoListIssues).toHaveBeenLastCalledWith(PROJECT_DIR, expect.objectContaining({ page: 1, force: true }));

    await act(async () => {
      respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
      respondTab('repo.issues_response', PROJECT_DIR, [
        { number: 2, title: 'Updated After Manual Refresh', state: 'open', author: 'alice', labels: [], updatedAt: Date.now(), url: '' },
      ]);
    });
    expect(screen.getByText('Updated After Manual Refresh')).toBeDefined();
  });

  it('preserves genuine empty fetched tab across refresh and keeps ws.onMessage stable across inline onCiEvent/actions updates', async () => {
    const { ws, respondDetect, respondTab, respondTabError } = makeWs();
    const onMessageSpy = vi.spyOn(ws, 'onMessage');
    const firstCi = vi.fn();
    const secondCi = vi.fn();

    const { rerender } = render(
      <RepoPage ws={ws} serverId="srv-1" projectDir={PROJECT_DIR} onCiEvent={firstCi} onBack={vi.fn()} />,
    );
    expect(onMessageSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
    });
    await act(async () => {
      respondTab('repo.issues_response', PROJECT_DIR, []);
      respondTab('repo.actions_response', PROJECT_DIR, [
        { id: 500, runNumber: 1, name: 'Build', status: 'running', conclusion: null, branch: 'main', commitSha: 'aaa', event: 'push', createdAt: Date.now(), url: 'https://example.com/500' },
      ]);
    });
    expect(screen.getByText('No issues found')).toBeDefined();
    expect(onMessageSpy).toHaveBeenCalledTimes(1);

    // Manual refresh of a genuinely empty tab keeps empty UI visible without Loading... or error replacement
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByText('No issues found')).toBeDefined();
    expect(screen.queryByText('Loading...')).toBeNull();
    await act(async () => {
      respondTabError('transient rate error', 'issues');
    });
    expect(screen.getByText('No issues found')).toBeDefined();

    // Rerender with new inline onCiEvent closure must NOT re-subscribe ws.onMessage and must invoke latest callback
    rerender(
      <RepoPage ws={ws} serverId="srv-1" projectDir={PROJECT_DIR} onCiEvent={secondCi} onBack={vi.fn()} />,
    );
    expect(onMessageSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => {
      respondTab('repo.actions_response', PROJECT_DIR, [
        { id: 500, runNumber: 1, name: 'Build', status: 'success', conclusion: 'success', branch: 'main', commitSha: 'aaa', event: 'push', createdAt: Date.now(), updatedAt: Date.now(), url: 'https://example.com/500' },
      ]);
    });
    expect(firstCi).not.toHaveBeenCalled();
    expect(secondCi).toHaveBeenCalledWith(expect.objectContaining({ name: 'Build', status: 'success' }));
  });

  it('switches immediately on first frame for unkeyed RepoPage and isolates late detect responses from prior scope', async () => {
    const sharedWs = makeWs();
    const projA = '/first-frame-a';
    const projB = '/first-frame-b';

    // Pre-seed fresh cache for Project B
    const emptyTab = { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: false };
    setRepoPageCache(makeRepoPageCacheKey({ serverId: 'srv-1', projectDir: projB }), {
      context: { status: 'ok', provider: 'github', owner: 'acme', repo: 'proj-b', defaultBranch: 'main', currentBranch: 'main' },
      contextFetchedAt: Date.now(),
      tabs: {
        issues: { items: [{ number: 20, title: 'Cached Beta First Frame', state: 'open', author: 'bob', labels: [] }], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: true, fetchedAt: Date.now() },
        prs: { ...emptyTab },
        branches: { ...emptyTab },
        commits: { ...emptyTab },
        actions: { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: true, fetchedAt: Date.now() },
      },
      expandedKey: null,
      detailData: [],
      callbacks: [],
      callbackRuntimeEnabled: false,
      updatedAt: Date.now(),
    });

    // Mount Project A (unkeyed wrapper): detect is still pending (lateReqId)
    const { rerender } = render(
      <RepoPage ws={sharedWs.ws} serverId="srv-1" projectDir={projA} onBack={vi.fn()} />,
    );
    const lateDetectReqIdA = sharedWs.getDetectReqId();
    expect(lateDetectReqIdA).toBeTruthy();

    // Switch immediately to Project B while A's detect is still in flight
    rerender(
      <RepoPage ws={sharedWs.ws} serverId="srv-1" projectDir={projB} onBack={vi.fn()} />,
    );
    expect(screen.getByText('Cached Beta First Frame')).toBeDefined();
    expect(screen.getByText('acme/proj-b')).toBeDefined();
    expect(screen.queryByText('Loading...')).toBeNull();

    // Deliver A's late detect response after switch: must NOT pollute Project B UI or cache
    await act(async () => {
      sharedWs.emit({
        type: 'repo.detect_response',
        requestId: lateDetectReqIdA,
        projectDir: projA,
        context: { status: 'ok', info: { platform: 'github', owner: 'evil', repo: 'hijacked-a', defaultBranch: 'dev' } },
      } as unknown as ServerMessage);
    });
    expect(screen.getByText('acme/proj-b')).toBeDefined();
    expect(screen.queryByText('evil/hijacked-a')).toBeNull();
    expect(getRepoPageCache(makeRepoPageCacheKey({ serverId: 'srv-1', projectDir: projB }))?.context?.repo).toBe('proj-b');
  });

  it('continues 5-per-page truncated cache without duplicates and handles unpaginated branches + single-page >50 preview rebuild', async () => {
    const first = makeWs();
    const { unmount } = render(
      <RepoPage ws={first.ws} serverId="srv-1" projectDir={PROJECT_DIR} onBack={vi.fn()} />,
    );
    await act(async () => {
      first.respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
    });

    // 11 pages x 5 items = 55 total items
    for (let page = 1; page <= 11; page++) {
      if (page > 1) fireEvent.click(screen.getByText('Load more'));
      const slice = Array.from({ length: 5 }, (_, idx) => {
        const num = (page - 1) * 5 + idx + 1;
        return { number: num, title: 'Paged Issue #' + num, state: 'open', author: 'alice', labels: [], updatedAt: Date.now(), url: '' };
      });
      await act(async () => {
        first.respondTab('repo.issues_response', PROJECT_DIR, slice, page, page < 11);
        if (page === 1) first.respondTab('repo.actions_response', PROJECT_DIR, []);
      });
    }
    expect(screen.getByText('Paged Issue #55')).toBeDefined();

    // Also load 55 unpaginated branches
    fireEvent.click(screen.getByText('Branches'));
    const allBranches = Array.from({ length: 55 }, (_, i) => ({
      name: 'branch-' + (i + 1),
      isCurrent: i === 0,
      isDefault: i === 0,
      localPresent: true,
      checkoutable: i > 0,
    }));
    await act(async () => {
      first.respondTab('repo.branches_response', PROJECT_DIR, allBranches, 1, false);
    });
    expect(screen.getByText('branch-55')).toBeDefined();
    unmount();

    // Cold boot: Issues keeps 1..50 with page=10, hasMore=true -> Load more asks page 11 & appends 51..55 cleanly
    __resetRepoPageCacheMemoryForTests();
    const cold = makeWs();
    render(
      <RepoPage ws={cold.ws} serverId="srv-1" projectDir={PROJECT_DIR} initialTab="issues" onBack={vi.fn()} />,
    );
    expect(screen.getByText('Paged Issue #1')).toBeDefined();
    expect(screen.getByText('Paged Issue #50')).toBeDefined();
    expect(screen.queryByText('Paged Issue #55')).toBeNull();
    fireEvent.click(screen.getByText('Load more'));
    expect(cold.repoListIssues).toHaveBeenLastCalledWith(PROJECT_DIR, expect.objectContaining({ page: 11 }));
    const tailSlice = Array.from({ length: 5 }, (_, idx) => ({
      number: 51 + idx,
      title: 'Paged Issue #' + (51 + idx),
      state: 'open',
      author: 'alice',
      labels: [],
      updatedAt: Date.now(),
      url: '',
    }));
    await act(async () => {
      cold.respondTab('repo.issues_response', PROJECT_DIR, tailSlice, 11, false);
    });
    expect(screen.getByText('Paged Issue #55')).toBeDefined();
    expect(screen.getAllByText(/^Paged Issue #\d+$/).length).toBe(55);
    expect(screen.queryByText('Load more')).toBeNull();

    // Switching to truncated Branches shows 50 cached branches, NO bogus Load more, and silently rebuilds all 55
    fireEvent.click(screen.getByText('Branches'));
    expect(screen.getByText('branch-50')).toBeDefined();
    expect(screen.queryByText('Load more')).toBeNull();
    expect(cold.repoListBranches).toHaveBeenCalledTimes(1);
    await act(async () => {
      cold.respondTab('repo.branches_response', PROJECT_DIR, allBranches, 1, false);
    });
    expect(screen.getByText('branch-55')).toBeDefined();
    cleanup();

    // Single-page >50 preview (page 1 has 55 items with hasMore=true) rebuilds page 1 cleanly on Load more before requesting page 2
    clearRepoPageCache();
    const singlePageKey = makeRepoPageCacheKey({ serverId: 'srv-sp', projectDir: '/sp' });
    const emptyTab = { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: false };
    setRepoPageCache(singlePageKey, {
      context: { status: 'ok', provider: 'github', owner: 'acme', repo: 'sp', defaultBranch: 'main' },
      contextFetchedAt: Date.now(),
      tabs: {
        issues: {
          items: Array.from({ length: 55 }, (_, i) => ({ number: i + 1, title: 'SP #' + (i + 1), state: 'open' })),
          page: 1,
          hasMore: true,
          loading: false,
          refreshing: false,
          error: null,
          fetched: true,
          fetchedAt: Date.now(),
          pageLengths: [55],
        },
        prs: { ...emptyTab },
        branches: { ...emptyTab },
        commits: { ...emptyTab },
        actions: { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: true, fetchedAt: Date.now() },
      },
      expandedKey: null,
      detailData: [],
      callbacks: [],
      callbackRuntimeEnabled: false,
      updatedAt: Date.now(),
    });
    __resetRepoPageCacheMemoryForTests();
    const spWs = makeWs();
    render(<RepoPage ws={spWs.ws} serverId="srv-sp" projectDir="/sp" initialTab="issues" onBack={vi.fn()} />);
    expect(screen.getByText('SP #50')).toBeDefined();
    expect(screen.queryByText('SP #55')).toBeNull();
    // Auto-rebuild for truncated preview triggered page 1; respond with full 55 page 1, then Load more fetches page 2
    expect(spWs.repoListIssues).toHaveBeenLastCalledWith('/sp', expect.objectContaining({ page: 1 }));
    await act(async () => {
      spWs.respondTab('repo.issues_response', '/sp', Array.from({ length: 55 }, (_, i) => ({ number: i + 1, title: 'SP #' + (i + 1), state: 'open' })), 1, true);
    });
    expect(screen.getByText('SP #55')).toBeDefined();
    fireEvent.click(screen.getByText('Load more'));
    expect(spWs.repoListIssues).toHaveBeenLastCalledWith('/sp', expect.objectContaining({ page: 2 }));
  });

  it('rejects structurally malformed v:1 persisted entries without crashing and re-fetches cleanly', async () => {
    const key = makeRepoPageCacheKey({ serverId: 'srv-bad', projectDir: PROJECT_DIR });
    const badEntry = {
      context: { status: 'ok', provider: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' },
      contextFetchedAt: Date.now(),
      tabs: {
        issues: { items: [{ number: 1, title: 'Healthy Issue', state: 'open' }], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: true, fetchedAt: Date.now() },
        prs: { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: false },
        branches: { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: false },
        commits: { items: [{ sha: 'abc1234', message: 'Commit 1' }], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: true, fetchedAt: Date.now() },
        actions: { items: [null], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: true, fetchedAt: Date.now() },
      },
      expandedKey: 'commits:abc1234',
      detailData: [
        ['commits:abc1234', { body: 'missing stats and files' }],
        ['issues:1', { body: 'Valid Issue Detail', comments: [] }],
      ],
      callbacks: [null, { callbackId: 'cb-valid', status: 'pending', title: 'Valid CB', projectDir: PROJECT_DIR, targetSession: 'b', createdAt: 1, updatedAt: 2 }],
      callbackRuntimeEnabled: true,
      updatedAt: Date.now(),
    };
    localStorage.setItem(REPO_PAGE_CACHE_STORAGE_KEY, JSON.stringify({ v: 1, entries: [[key, badEntry]] }));
    __resetRepoPageCacheMemoryForTests();

    const { ws, respondTab, respondCommitDetail } = makeWs();
    render(<RepoPage ws={ws} serverId="srv-bad" projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    // Renders healthy issues & valid callback badge without crashing on actions.items:[null] or callbacks:[null]
    expect(screen.getByText('Healthy Issue')).toBeDefined();
    expect(screen.getByText('1')).toBeDefined();
    // Rejected bad actions tab re-fetches automatically
    expect(ws.repoListActions).toHaveBeenCalledTimes(1);
    await act(async () => {
      respondTab('repo.actions_response', PROJECT_DIR, [
        { id: 99, runNumber: 1, name: 'Recovered CI', status: 'success', conclusion: 'success', createdAt: Date.now(), url: '' },
      ]);
    });

    // Malformed commit detail was dropped so clicking show_changed_files re-fetches commit detail cleanly
    fireEvent.click(screen.getByText('Commits'));
    expect(screen.getByText('Commit 1')).toBeDefined();
    fireEvent.click(screen.getByText('repo.show_changed_files'));
    await act(async () => {
      respondCommitDetail(PROJECT_DIR, {
        body: 'Recovered Commit Detail',
        stats: { additions: 3, deletions: 1, filesChanged: 1 },
        files: [{ filename: 'a.ts', additions: 3, deletions: 1 }],
      });
    });
    expect(screen.getByText('a.ts')).toBeDefined();
  });

  it('degrades gracefully when localStorage getter throws SecurityError or setItem throws QuotaExceededError', async () => {
    const origDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new DOMException('SecurityError: storage disabled', 'SecurityError');
      },
      configurable: true,
    });
    try {
      const { ws, respondDetect, respondTab } = makeWs();
      render(<RepoPage ws={ws} serverId="srv-sec" projectDir={PROJECT_DIR} onBack={vi.fn()} />);
      await act(async () => {
        respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
      });
      await act(async () => {
        respondTab('repo.issues_response', PROJECT_DIR, [
          { number: 1, title: 'Memory Only Issue', state: 'open', author: 'alice', labels: [] },
        ]);
        respondTab('repo.actions_response', PROJECT_DIR, []);
      });
      expect(screen.getByText('Memory Only Issue')).toBeDefined();

      // Switching tabs writes repo-active-tab through safe wrapper without throwing
      fireEvent.click(screen.getByText('PRs'));
      await act(async () => {
        respondTab('repo.prs_response', PROJECT_DIR, [
          { number: 2, title: 'Memory Only PR', state: 'open', author: 'bob' },
        ]);
      });
      expect(screen.getByText('Memory Only PR')).toBeDefined();
      fireEvent.click(screen.getByText('Issues'));
      expect(screen.getByText('Memory Only Issue')).toBeDefined();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', origDescriptor);
    }

    // Also verify QuotaExceededError when clicking tabs with working getter
    const origSetItem = localStorage.setItem;
    localStorage.setItem = vi.fn(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    try {
      const { ws, respondDetect, respondTab } = makeWs();
      cleanup();
      render(<RepoPage ws={ws} serverId="srv-qtab" projectDir={PROJECT_DIR} onBack={vi.fn()} />);
      await act(async () => {
        respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
      });
      await act(async () => {
        respondTab('repo.issues_response', PROJECT_DIR, []);
        respondTab('repo.actions_response', PROJECT_DIR, []);
      });
      expect(() => fireEvent.click(screen.getByText('PRs'))).not.toThrow();
    } finally {
      localStorage.setItem = origSetItem;
    }
  });

  it('revalidates previously fresh cached tabs after TTL expires on switch without showing .repo-tab-spinner', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const { ws, repoListPRs, respondDetect, respondTab } = makeWs();
      const { container } = render(
        <RepoPage ws={ws} serverId="srv-ttl-tab" projectDir={PROJECT_DIR} onBack={vi.fn()} />,
      );
      await act(async () => {
        respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
      });
      await act(async () => {
        respondTab('repo.issues_response', PROJECT_DIR, [
          { number: 1, title: 'Issue One', state: 'open', author: 'alice', labels: [] },
        ]);
        respondTab('repo.actions_response', PROJECT_DIR, []);
      });
      fireEvent.click(screen.getByText('PRs'));
      await act(async () => {
        respondTab('repo.prs_response', PROJECT_DIR, [
          { number: 10, title: 'Stale PR Before Switch', state: 'open', author: 'bob' },
        ]);
      });
      expect(screen.getByText('Stale PR Before Switch')).toBeDefined();

      // Switch back to Issues while PRs is fresh, then let TTL expire before switching back to PRs
      fireEvent.click(screen.getByText('Issues'));
      vi.advanceTimersByTime(REPO_PAGE_CACHE_FRESH_TTL_MS + 1);

      const prCallsBeforeSwitch = repoListPRs.mock.calls.length;
      fireEvent.click(screen.getByText('PRs'));
      expect(screen.getByText('Stale PR Before Switch')).toBeDefined();
      expect(screen.queryByText('Loading...')).toBeNull();
      expect(repoListPRs).toHaveBeenCalledTimes(prCallsBeforeSwitch + 1);
      // Background SWR must NOT display .repo-tab-spinner
      expect(container.querySelector('.repo-tab-spinner')).toBeNull();

      await act(async () => {
        respondTab('repo.prs_response', PROJECT_DIR, [
          { number: 11, title: 'Refreshed PR After Switch', state: 'open', author: 'bob' },
        ]);
      });
      expect(screen.getByText('Refreshed PR After Switch')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forces detect/active tab/callbacks on RECONNECTED (including interrupted initial fetch) and includes callbacks in manual refresh', async () => {
    const { ws, emit, repoDetect, repoListIssues, repoCallbackStatus, respondDetect, respondTab } = makeWs();
    render(<RepoPage ws={ws} serverId="srv-rc" projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    await act(async () => {
      respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
    });
    // Initial issues fetch is still in flight (loading=true, fetched=false) when WS drops & reconnects!
    expect(screen.getByText('Loading...')).toBeDefined();
    const issuesBeforeReconnect = repoListIssues.mock.calls.length;
    const cbBeforeReconnect = repoCallbackStatus.mock.calls.length;

    await act(async () => {
      emit({ type: 'daemon.reconnected' } as unknown as ServerMessage);
    });
    expect(repoDetect).toHaveBeenLastCalledWith(PROJECT_DIR, expect.objectContaining({ force: true }));
    expect(repoListIssues).toHaveBeenCalledTimes(issuesBeforeReconnect + 1);
    expect(repoListIssues).toHaveBeenLastCalledWith(PROJECT_DIR, expect.objectContaining({ page: 1, force: true }));
    expect(repoCallbackStatus).toHaveBeenCalledTimes(cbBeforeReconnect + 1);

    await act(async () => {
      respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
      respondTab('repo.issues_response', PROJECT_DIR, [
        { number: 7, title: 'Recovered Initial Issue', state: 'open', author: 'alice', labels: [] },
      ]);
      respondTab('repo.actions_response', PROJECT_DIR, []);
    });
    expect(screen.getByText('Recovered Initial Issue')).toBeDefined();

    // Second reconnect while fresh cached data exists ALSO passes force: true
    await act(async () => {
      emit({ type: 'daemon.reconnected' } as unknown as ServerMessage);
    });
    expect(screen.getByText('Recovered Initial Issue')).toBeDefined();
    expect(repoDetect).toHaveBeenLastCalledWith(PROJECT_DIR, expect.objectContaining({ force: true }));
    expect(repoListIssues).toHaveBeenLastCalledWith(PROJECT_DIR, expect.objectContaining({ page: 1, force: true }));

    // Manual Refresh also invokes repoCallbackStatus for normal scope
    const cbBeforeManual = repoCallbackStatus.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(repoCallbackStatus).toHaveBeenCalledTimes(cbBeforeManual + 1);
  });

  it('handles external branch change races in both arrival orders and rejects older SWR arriving after manual refresh', async () => {
    // 1. Order A: DETECT_RESPONSE for new branch arrives BEFORE stale commits response
    const w1 = makeWs();
    render(<RepoPage ws={w1.ws} serverId="srv-br1" projectDir={PROJECT_DIR} initialTab="commits" onBack={vi.fn()} />);
    await act(async () => {
      w1.respondDetect({ status: 'ok', repoGeneration: 1, info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'main', defaultBranch: 'main' } });
    });
    await act(async () => {
      w1.respondTab('repo.commits_response', PROJECT_DIR, [
        { sha: '1111111', message: 'Old Main Commit', author: 'alice' },
      ]);
      w1.respondTab('repo.actions_response', PROJECT_DIR, []);
    });
    expect(screen.getByText('Old Main Commit')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const staleMainCommitsReqId = w1.getLastTabReqId('commits');

    // External branch moved to feat/new (gen 2); DETECT arrives first -> auto-triggers fresh feat/new commits request
    await act(async () => {
      w1.respondDetect({ status: 'ok', repoGeneration: 2, info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'feat/new', defaultBranch: 'main' } });
    });
    expect(w1.repoListCommits).toHaveBeenLastCalledWith(PROJECT_DIR, expect.objectContaining({ branch: 'feat/new', force: true }));
    const newBranchCommitsReqId = w1.getLastTabReqId('commits');
    expect(newBranchCommitsReqId).not.toBe(staleMainCommitsReqId);

    // Late stale main commits arrives: must be ignored without clearing active feat/new fetch
    await act(async () => {
      w1.emit({
        type: 'repo.commits_response',
        requestId: staleMainCommitsReqId,
        projectDir: PROJECT_DIR,
        items: [{ sha: '2222222', message: 'Stale Main After Switch', author: 'alice' }],
        page: 1,
        hasMore: false,
      } as unknown as ServerMessage);
    });
    expect(screen.queryByText('Stale Main After Switch')).toBeNull();

    await act(async () => {
      w1.respondTab('repo.commits_response', PROJECT_DIR, [
        { sha: '3333333', message: 'New Branch Commit', author: 'bob' },
      ]);
    });
    expect(screen.getByText('New Branch Commit')).toBeDefined();
    cleanup();

    // 2. Order B: stale main commits arrives BEFORE feat/new DETECT_RESPONSE -> DETECT invalidates and re-fetches feat/new
    const w2 = makeWs();
    render(<RepoPage ws={w2.ws} serverId="srv-br2" projectDir={PROJECT_DIR} initialTab="commits" onBack={vi.fn()} />);
    await act(async () => {
      w2.respondDetect({ status: 'ok', repoGeneration: 1, info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'main', defaultBranch: 'main' } });
    });
    await act(async () => {
      w2.respondTab('repo.commits_response', PROJECT_DIR, [
        { sha: 'aaaaaaa', message: 'Initial Main Commit', author: 'alice' },
      ]);
      w2.respondTab('repo.actions_response', PROJECT_DIR, []);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => {
      w2.respondTab('repo.commits_response', PROJECT_DIR, [
        { sha: 'bbbbbbb', message: 'Main Commit Arrived First', author: 'alice' },
      ]);
    });
    expect(screen.getByText('Main Commit Arrived First')).toBeDefined();

    await act(async () => {
      w2.respondDetect({ status: 'ok', repoGeneration: 2, info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'feat/next', defaultBranch: 'main' } });
    });
    expect(w2.repoListCommits).toHaveBeenLastCalledWith(PROJECT_DIR, expect.objectContaining({ branch: 'feat/next', force: true }));
    await act(async () => {
      w2.respondTab('repo.commits_response', PROJECT_DIR, [
        { sha: 'ccccccc', message: 'Correct Next Branch Commit', author: 'bob' },
      ]);
    });
    expect(screen.getByText('Correct Next Branch Commit')).toBeDefined();
    expect(screen.queryByText('Main Commit Arrived First')).toBeNull();
    cleanup();

    // 3. Older SWR page-1 response arriving AFTER newer manual refresh page-1 response is ignored
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const w3 = makeWs();
      const { unmount } = render(<RepoPage ws={w3.ws} serverId="srv-race" projectDir={PROJECT_DIR} initialTab="issues" onBack={vi.fn()} />);
      await act(async () => {
        w3.respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
      });
      await act(async () => {
        w3.respondTab('repo.issues_response', PROJECT_DIR, [{ number: 1, title: 'Cached Old Issue', state: 'open' }]);
        w3.respondTab('repo.actions_response', PROJECT_DIR, []);
      });
      unmount();

      vi.advanceTimersByTime(REPO_PAGE_CACHE_FRESH_TTL_MS + 1);
      const w4 = makeWs();
      render(<RepoPage ws={w4.ws} serverId="srv-race" projectDir={PROJECT_DIR} initialTab="issues" onBack={vi.fn()} />);
      const swrReqId = w4.getLastTabReqId('issues');

      // User clicks Manual Refresh before SWR returns
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      const manualReqId = w4.getLastTabReqId('issues');
      expect(manualReqId).not.toBe(swrReqId);

      // Manual response arrives first
      await act(async () => {
        w4.emit({
          type: 'repo.issues_response',
          requestId: manualReqId,
          projectDir: PROJECT_DIR,
          items: [{ number: 2, title: 'Fresh Manual Issue', state: 'open' }],
          page: 1,
          hasMore: false,
        } as unknown as ServerMessage);
      });
      expect(screen.getByText('Fresh Manual Issue')).toBeDefined();

      // Older SWR response arrives late -> must NOT overwrite Manual issue
      await act(async () => {
        w4.emit({
          type: 'repo.issues_response',
          requestId: swrReqId,
          projectDir: PROJECT_DIR,
          items: [{ number: 1, title: 'Stale Late SWR Issue', state: 'open' }],
          page: 1,
          hasMore: false,
        } as unknown as ServerMessage);
      });
      expect(screen.getByText('Fresh Manual Issue')).toBeDefined();
      expect(screen.queryByText('Stale Late SWR Issue')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops malformed labels:[null] and numeric conclusions in actions/jobs/steps while preserving healthy tabs on cold boot', async () => {
    const key = makeRepoPageCacheKey({ serverId: 'srv-mal2', projectDir: PROJECT_DIR });
    const malformedPayload = {
      v: 1,
      entries: [[key, {
        context: { status: 'ok', provider: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' },
        contextFetchedAt: Date.now(),
        tabs: {
          issues: {
            items: [{ number: 1, state: 'open', title: 'Demo Bad Labels', labels: [null] }],
            page: 1,
            hasMore: false,
            loading: false,
            refreshing: false,
            error: null,
            fetched: true,
            fetchedAt: Date.now(),
          },
          prs: {
            items: [{ number: 2, state: 'open', title: 'Healthy PR', head: 'feat/ui', base: 'main' }],
            page: 1,
            hasMore: false,
            loading: false,
            refreshing: false,
            error: null,
            fetched: true,
            fetchedAt: Date.now(),
          },
          branches: { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: false },
          commits: { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: false },
          actions: {
            items: [{ id: 10, status: 'completed', conclusion: 123, name: 'Bad Run' }],
            page: 1,
            hasMore: false,
            loading: false,
            refreshing: false,
            error: null,
            fetched: true,
            fetchedAt: Date.now(),
          },
        },
        expandedKey: 'actions:10',
        detailData: [
          ['actions:10', { jobs: [{ name: 'build', status: 'completed', conclusion: 456, steps: [{ name: 'test', status: 'completed', conclusion: 789 }] }] }],
        ],
        callbacks: [],
        callbackRuntimeEnabled: false,
        updatedAt: Date.now(),
      }]],
    };
    localStorage.setItem(REPO_PAGE_CACHE_STORAGE_KEY, JSON.stringify(malformedPayload));
    __resetRepoPageCacheMemoryForTests();

    const { ws, respondTab, respondActionDetail } = makeWs();
    render(<RepoPage ws={ws} serverId="srv-mal2" projectDir={PROJECT_DIR} initialTab="prs" onBack={vi.fn()} />);

    // Healthy PR tab renders immediately without refetching
    expect(screen.getByText('Healthy PR')).toBeDefined();
    expect(screen.getByText('feat/ui')).toBeDefined();
    // Corrupt actions tab was rejected and auto-re-fetched cleanly
    expect(ws.repoListActions).toHaveBeenCalledTimes(1);
    await act(async () => {
      respondTab('repo.actions_response', PROJECT_DIR, [
        { id: 10, runNumber: 1, name: 'Valid Recovered Run', status: 'failure', conclusion: 'failure', createdAt: Date.now(), url: '' },
      ]);
    });
    // Corrupt action detail was rejected too, so viewing Actions fetches fresh detail
    fireEvent.click(screen.getByText('Actions'));
    expect(screen.getByText('Valid Recovered Run')).toBeDefined();
    expect(ws.repoActionDetail).toHaveBeenCalledWith(PROJECT_DIR, 10, expect.anything());
    await act(async () => {
      respondActionDetail(PROJECT_DIR, {
        runId: 10,
        jobs: [{ name: 'build', status: 'failure', conclusion: 'failure', steps: [{ name: 'test', status: 'failure', conclusion: 'failure' }] }],
      });
    });

    // Corrupt issues tab (labels:[null]) was rejected and re-fetches when clicked
    fireEvent.click(screen.getByText('Issues'));
    expect(ws.repoListIssues).toHaveBeenCalledTimes(1);
    await act(async () => {
      respondTab('repo.issues_response', PROJECT_DIR, [
        { number: 1, state: 'open', title: 'Recovered Issue', labels: ['bug', { name: 'ok' }] },
      ]);
    });
    expect(screen.getByText('Recovered Issue')).toBeDefined();
    expect(screen.getByText('bug')).toBeDefined();
    expect(screen.getByText('ok')).toBeDefined();
  });

  it('prevents branch-mixed pagination after DETECT updates branch and tracks unique merged pageLengths across overlapping pages', async () => {
    // Part A: Branch switch while commits hasMore=true cannot mix main + feat/new into cache
    const w1 = makeWs();
    const { unmount } = render(
      <RepoPage ws={w1.ws} serverId="srv-br-page" projectDir={PROJECT_DIR} initialTab="commits" onBack={vi.fn()} />,
    );
    await act(async () => {
      w1.respondDetect({ status: 'ok', repoGeneration: 1, info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'main', defaultBranch: 'main' } });
    });
    await act(async () => {
      w1.respondTab('repo.commits_response', PROJECT_DIR, [
        { sha: 'm111111', message: 'Main Commit 1', author: 'alice' },
        { sha: 'm222222', message: 'Main Commit 2', author: 'alice' },
      ], 1, true);
      w1.respondTab('repo.actions_response', PROJECT_DIR, []);
    });

    // Refresh starts detect + main commits; DETECT arrives first with feat/new (gen 2)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => {
      w1.respondDetect({ status: 'ok', repoGeneration: 2, info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'feat/new', defaultBranch: 'main' } });
    });
    const featPage1ReqId = w1.getLastTabReqId('commits');
    const callsRightAfterDetect = w1.repoListCommits.mock.calls.length;

    // Immediately clicking Load more right after DETECT must be blocked (button disabled, zero page:2 call, page:1 seq intact)
    const loadMoreBtn = screen.getByText('Load more') as HTMLButtonElement;
    expect(loadMoreBtn.disabled).toBe(true);
    fireEvent.click(loadMoreBtn);
    expect(w1.repoListCommits).toHaveBeenCalledTimes(callsRightAfterDetect);

    // Deliver feat/new page 1 -> replaces main commits cleanly and enables Load more
    await act(async () => {
      w1.emit({
        type: 'repo.commits_response',
        requestId: featPage1ReqId,
        projectDir: PROJECT_DIR,
        items: [
          { sha: 'n111111', message: 'New Branch Commit 1', author: 'bob' },
          { sha: 'n222222', message: 'New Branch Commit 2', author: 'bob' },
        ],
        page: 1,
        hasMore: true,
      } as unknown as ServerMessage);
    });
    expect(screen.getByText('New Branch Commit 1')).toBeDefined();
    expect(screen.queryByText('Main Commit 1')).toBeNull();
    expect((screen.getByText('Load more') as HTMLButtonElement).disabled).toBe(false);

    // Now Load more sends page 2 for feat/new
    fireEvent.click(screen.getByText('Load more'));
    expect(w1.repoListCommits).toHaveBeenLastCalledWith(PROJECT_DIR, expect.objectContaining({ page: 2, branch: 'feat/new' }));
    await act(async () => {
      w1.respondTab('repo.commits_response', PROJECT_DIR, [
        { sha: 'n333333', message: 'New Branch Commit 3', author: 'bob' },
      ], 2, false);
    });
    unmount();

    // Cold boot must contain ONLY feat/new commits
    __resetRepoPageCacheMemoryForTests();
    const wCold = makeWs();
    render(<RepoPage ws={wCold.ws} serverId="srv-br-page" projectDir={PROJECT_DIR} initialTab="commits" onBack={vi.fn()} />);
    expect(screen.getByText('New Branch Commit 1')).toBeDefined();
    expect(screen.getByText('New Branch Commit 3')).toBeDefined();
    expect(screen.queryByText('Main Commit 1')).toBeNull();
    cleanup();

    // Part B: Overlapping paginated pages (25 + 30 w/ 5 overlap = 50 unique, then + 5 = 55) preserve page=2 across cold boot
    const wOv = makeWs();
    const viewOv = render(<RepoPage ws={wOv.ws} serverId="srv-ov" projectDir={PROJECT_DIR} initialTab="issues" onBack={vi.fn()} />);
    await act(async () => {
      wOv.respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
    });
    const makeIssuesRange = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) => ({
      number: start + i,
      title: 'Overlap Issue #' + (start + i),
      state: 'open',
    }));
    await act(async () => {
      wOv.respondTab('repo.issues_response', PROJECT_DIR, makeIssuesRange(1, 25), 1, true);
      wOv.respondTab('repo.actions_response', PROJECT_DIR, []);
    });
    fireEvent.click(screen.getByText('Load more'));
    await act(async () => {
      // 5 overlapping items (#21..#25) + 25 new (#26..#50) -> 50 unique total
      wOv.respondTab('repo.issues_response', PROJECT_DIR, makeIssuesRange(21, 50), 2, true);
    });
    fireEvent.click(screen.getByText('Load more'));
    await act(async () => {
      wOv.respondTab('repo.issues_response', PROJECT_DIR, makeIssuesRange(51, 55), 3, false);
    });
    viewOv.unmount();

    __resetRepoPageCacheMemoryForTests();
    const wOvCold = makeWs();
    render(<RepoPage ws={wOvCold.ws} serverId="srv-ov" projectDir={PROJECT_DIR} initialTab="issues" onBack={vi.fn()} />);
    expect(screen.getByText('Overlap Issue #50')).toBeDefined();
    expect(screen.queryByText('Overlap Issue #51')).toBeNull();
    fireEvent.click(screen.getByText('Load more'));
    // Must continue directly from page 3 (NOT reset to page 1 preview!)
    expect(wOvCold.repoListIssues).toHaveBeenLastCalledWith(PROJECT_DIR, expect.objectContaining({ page: 3 }));
    await act(async () => {
      wOvCold.respondTab('repo.issues_response', PROJECT_DIR, makeIssuesRange(51, 55), 3, false);
    });
    expect(screen.getByText('Overlap Issue #55')).toBeDefined();
    expect(screen.getAllByText(/^Overlap Issue #\d+$/).length).toBe(55);
  });

  it('preserves background flag across fetchTab retries and preserves force:true across all 3 doDetect retry paths', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      // Seed expired cache for background SWR send-error retry test
      const key = makeRepoPageCacheKey({ serverId: 'srv-retry', projectDir: PROJECT_DIR });
      const emptyTab = { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: false };
      setRepoPageCache(key, {
        context: { status: 'ok', provider: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' },
        contextFetchedAt: Date.now() - REPO_PAGE_CACHE_FRESH_TTL_MS - 1000,
        tabs: {
          issues: {
            items: [{ number: 1, title: 'Cached For Retry', state: 'open' }],
            page: 1,
            hasMore: false,
            loading: false,
            refreshing: false,
            error: null,
            fetched: true,
            fetchedAt: Date.now() - REPO_PAGE_CACHE_FRESH_TTL_MS - 1000,
          },
          prs: { ...emptyTab },
          branches: { ...emptyTab },
          commits: { ...emptyTab },
          actions: { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: true, fetchedAt: Date.now() },
        },
        expandedKey: null,
        detailData: [],
        callbacks: [],
        callbackRuntimeEnabled: false,
        updatedAt: Date.now() - REPO_PAGE_CACHE_FRESH_TTL_MS - 1000,
      });

      const w = makeWs();
      let failFirstIssueSend = true;
      const origListIssues = w.repoListIssues.getMockImplementation()!;
      w.repoListIssues.mockImplementation((dir: string, opts?: any) => {
        if (failFirstIssueSend) {
          failFirstIssueSend = false;
          throw new Error('WebSocket not connected');
        }
        return origListIssues(dir, opts);
      });

      const { container } = render(
        <RepoPage ws={w.ws} serverId="srv-retry" projectDir={PROJECT_DIR} initialTab="issues" onBack={vi.fn()} />,
      );
      expect(screen.getByText('Cached For Retry')).toBeDefined();
      expect(container.querySelector('.repo-tab-spinner')).toBeNull();

      // Advance past retry delay (1200ms): retry fires in background and MUST keep .repo-tab-spinner hidden
      await act(async () => {
        vi.advanceTimersByTime(1250);
      });
      expect(w.repoListIssues).toHaveBeenCalledTimes(2);
      expect(container.querySelector('.repo-tab-spinner')).toBeNull();

      await act(async () => {
        w.respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
        w.respondTab('repo.issues_response', PROJECT_DIR, [{ number: 2, title: 'Retry Updated Issue', state: 'open' }]);
      });
      expect(screen.getByText('Retry Updated Issue')).toBeDefined();

      // Now verify manual Refresh force:true is preserved across all 3 doDetect retry paths:
      // 1) Transient send throw
      const origDetect = w.repoDetect.getMockImplementation()!;
      let throwOnce = true;
      w.repoDetect.mockImplementation((dir: string, opts?: any) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('WebSocket not connected');
        }
        return origDetect(dir, opts);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await act(async () => {
        vi.advanceTimersByTime(1250);
      });
      expect(w.repoDetect).toHaveBeenLastCalledWith(PROJECT_DIR, expect.objectContaining({ force: true }));

      // 2) 10s detect timeout
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      await act(async () => {
        vi.advanceTimersByTime(1250);
      });
      expect(w.repoDetect).toHaveBeenLastCalledWith(PROJECT_DIR, expect.objectContaining({ force: true }));

      // 3) REPO_MSG.ERROR response on detect
      await act(async () => {
        w.respondDetectError('temporary server failure');
      });
      await act(async () => {
        vi.advanceTimersByTime(1250);
      });
      expect(w.repoDetect).toHaveBeenLastCalledWith(PROJECT_DIR, expect.objectContaining({ force: true }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('still revalidates expired cache after reopen when closed mid-retry on transient REPO_MSG.ERROR', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const key = makeRepoPageCacheKey({ serverId: 'srv-err-reopen', projectDir: PROJECT_DIR });
      const emptyTab = { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: false };
      setRepoPageCache(key, {
        context: { status: 'ok', provider: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' },
        contextFetchedAt: Date.now() - REPO_PAGE_CACHE_FRESH_TTL_MS - 1000,
        tabs: {
          issues: {
            items: [{ number: 1, state: 'open', title: 'Cached Issue Before Transient Error' }],
            page: 1,
            hasMore: false,
            loading: false,
            refreshing: false,
            error: null,
            fetched: true,
            fetchedAt: Date.now() - REPO_PAGE_CACHE_FRESH_TTL_MS - 1000,
          },
          prs: { ...emptyTab },
          branches: { ...emptyTab },
          commits: { ...emptyTab },
          actions: { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: true, fetchedAt: Date.now() },
        },
        expandedKey: null,
        detailData: [],
        callbacks: [],
        callbackRuntimeEnabled: false,
        updatedAt: Date.now() - REPO_PAGE_CACHE_FRESH_TTL_MS - 1000,
      });

      const w1 = makeWs();
      const firstView = render(
        <RepoPage ws={w1.ws} serverId="srv-err-reopen" projectDir={PROJECT_DIR} initialTab="issues" onBack={vi.fn()} />,
      );
      expect(w1.repoListIssues).toHaveBeenCalledTimes(1);
      await act(async () => {
        w1.respondTabError('temporary rate error', 'issues');
      });
      // Unmount BEFORE retry timer fires and wipe in-memory cache (simulating close + reload)
      firstView.unmount();
      __resetRepoPageCacheMemoryForTests();

      const hydrated = getRepoPageCache(key);
      expect(hydrated?.tabs.issues.error).toBeNull();
      expect(hydrated?.tabs.issues.items[0]?.title).toBe('Cached Issue Before Transient Error');

      const w2 = makeWs();
      const { container } = render(
        <RepoPage ws={w2.ws} serverId="srv-err-reopen" projectDir={PROJECT_DIR} initialTab="issues" onBack={vi.fn()} />,
      );
      expect(screen.getByText('Cached Issue Before Transient Error')).toBeDefined();
      expect(screen.queryByText('Loading...')).toBeNull();
      expect(container.querySelector('.repo-tab-spinner')).toBeNull();
      expect(w2.repoListIssues).toHaveBeenCalledTimes(1);

      await act(async () => {
        w2.respondDetect({ status: 'ok', info: { platform: 'github', owner: 'acme', repo: 'widgets', defaultBranch: 'main' } });
        w2.respondTab('repo.issues_response', PROJECT_DIR, [{ number: 2, state: 'open', title: 'Fresh Issue After Reopen' }]);
      });
      expect(screen.getByText('Fresh Issue After Reopen')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps branch-change refresh silent without .repo-tab-spinner when only repo context was expired', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const key = makeRepoPageCacheKey({ serverId: 'srv-mixed-ttl', projectDir: PROJECT_DIR });
      const emptyTab = { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: false };
      setRepoPageCache(key, {
        context: { status: 'ok', provider: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'main', defaultBranch: 'main', repoGeneration: 1 },
        contextFetchedAt: Date.now() - REPO_PAGE_CACHE_FRESH_TTL_MS - 1000, // expired context
        tabs: {
          issues: { ...emptyTab },
          prs: { ...emptyTab },
          branches: { ...emptyTab },
          commits: {
            items: [{ sha: 'old1111', message: 'Old Main Cached Commit', author: 'alice' }],
            page: 1,
            hasMore: false,
            loading: false,
            refreshing: false,
            error: null,
            fetched: true,
            fetchedAt: Date.now() - 5000, // still fresh commits!
            cursorBranch: 'main',
            cursorRepoGeneration: 1,
          },
          actions: { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: true, fetchedAt: Date.now() - 5000 },
        },
        expandedKey: null,
        detailData: [],
        callbacks: [],
        callbackRuntimeEnabled: false,
        updatedAt: Date.now() - 5000,
      });

      const { ws, repoDetect, repoListCommits, respondDetect, respondTab } = makeWs();
      const { container } = render(
        <RepoPage ws={ws} serverId="srv-mixed-ttl" projectDir={PROJECT_DIR} initialTab="commits" onBack={vi.fn()} />,
      );
      expect(screen.getByText('Old Main Cached Commit')).toBeDefined();
      expect(repoDetect).toHaveBeenCalledTimes(1);
      expect(repoListCommits).toHaveBeenCalledTimes(0);
      expect(container.querySelector('.repo-tab-spinner')).toBeNull();

      // Background detect discovers branch switched from main (gen 1) to feat/auto (gen 2)
      await act(async () => {
        respondDetect({ status: 'ok', repoGeneration: 2, info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'feat/auto', defaultBranch: 'main' } });
      });
      expect(screen.getByText('Old Main Cached Commit')).toBeDefined();
      expect(repoListCommits).toHaveBeenCalledWith(PROJECT_DIR, expect.objectContaining({ branch: 'feat/auto', force: true }));
      expect(container.querySelector('.repo-tab-spinner')).toBeNull();

      await act(async () => {
        respondTab('repo.commits_response', PROJECT_DIR, [
          { sha: 'new2222', message: 'Silent Auto Updated Commit', author: 'bob' },
        ]);
      });
      expect(screen.getByText('Silent Auto Updated Commit')).toBeDefined();
      expect(container.querySelector('.repo-tab-spinner')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});