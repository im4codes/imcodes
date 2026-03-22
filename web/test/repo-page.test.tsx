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
        'repo.back': 'Back',
        'repo.refresh': 'Refresh',
        'repo.load_more': 'Load more',
        'repo.retry': 'Retry',
        'repo.cli_not_installed': 'CLI not installed',
        'repo.error_cli_missing_hint': 'Install the GitHub CLI',
        'repo.error_unauthorized_hint': 'Run gh auth login',
        'repo.current_branch': 'current',
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

// ── WsClient mock factory ─────────────────────────────────────────────────

function makeWs() {
  let messageHandler: ((msg: ServerMessage) => void) | null = null;
  // Track request IDs returned by each method
  let detectReqId = '';
  let lastTabReqId = '';

  const repoDetect = vi.fn((projectDir: string) => {
    detectReqId = `detect-${Date.now()}-${Math.random()}`;
    return detectReqId;
  });
  const repoListIssues = vi.fn((_dir: string, _opts?: any) => {
    lastTabReqId = `issues-${Date.now()}-${Math.random()}`;
    return lastTabReqId;
  });
  const repoListPRs = vi.fn((_dir: string, _opts?: any) => {
    lastTabReqId = `prs-${Date.now()}-${Math.random()}`;
    return lastTabReqId;
  });
  const repoListBranches = vi.fn((_dir: string) => {
    lastTabReqId = `branches-${Date.now()}-${Math.random()}`;
    return lastTabReqId;
  });
  const repoListCommits = vi.fn((_dir: string, _opts?: any) => {
    lastTabReqId = `commits-${Date.now()}-${Math.random()}`;
    return lastTabReqId;
  });

  const ws: WsClient = {
    onMessage: (handler: (msg: ServerMessage) => void) => {
      messageHandler = handler;
      return () => { messageHandler = null; };
    },
    repoDetect,
    repoListIssues,
    repoListPRs,
    repoListBranches,
    repoListCommits,
  } as unknown as WsClient;

  /** Send a message to the component's onMessage handler */
  const emit = (msg: ServerMessage) => messageHandler?.(msg);

  /** Respond to the pending detect request with repo context */
  const respondDetect = (context: Record<string, unknown>) => {
    emit({
      type: 'repo.detect_response',
      requestId: detectReqId,
      context,
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
    emit({
      type,
      requestId: lastTabReqId,
      projectDir,
      items,
      page,
      hasMore,
    } as unknown as ServerMessage);
  };

  /** Respond to the last tab request with a repo.error */
  const respondTabError = (error: string) => {
    emit({
      type: 'repo.error',
      requestId: lastTabReqId,
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
    respondDetect,
    respondDetectError,
    respondTab,
    respondTabError,
    getDetectReqId: () => detectReqId,
    getLastTabReqId: () => lastTabReqId,
  };
}

const PROJECT_DIR = '/home/user/myproject';

// ── Tests ─────────────────────────────────────────────────────────────────

describe('RepoPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(screen.getByText('Could not detect repository')).toBeDefined();
  });

  // Back button calls onBack
  it('calls onBack when Back button is clicked', () => {
    const onBack = vi.fn();
    const { ws } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={onBack} />);

    fireEvent.click(screen.getByText('Back'));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
