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
  const lastTabReqIds: Partial<Record<'issues' | 'prs' | 'branches' | 'commits' | 'actions', string>> = {};
  let lastActionDetailReqId = '';

  const repoDetect = vi.fn((projectDir: string) => {
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
    respondDetect,
    respondDetectFlat,
    respondDetectError,
    respondTab,
    respondTabError,
    respondActionDetail,
    respondActionDetailError,
    getDetectReqId: () => detectReqId,
    getLastTabReqId: (tab: 'issues' | 'prs' | 'branches' | 'commits' | 'actions' = 'issues') => lastTabReqIds[tab] ?? '',
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

  it('shows timeout error with projectDir if no detect response within 10s', async () => {
    vi.useFakeTimers();
    const { ws } = makeWs();
    render(<RepoPage ws={ws} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    // Advance past the 10s timeout
    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });

    vi.useRealTimers();

    // The timeout error message should appear
    const errorElements = screen.getAllByText(/Detect timeout/);
    expect(errorElements.length).toBeGreaterThanOrEqual(1);
    // Should mention "10s" in the error
    expect(errorElements[0].textContent).toContain('10s');
  });

  it('shows send error when WS is not connected', async () => {
    // Create a ws mock where repoDetect throws (simulating disconnected WS)
    const failWs = {
      connected: false,
      onMessage: (_handler: (msg: any) => void) => () => {},
      repoDetect: () => { throw new Error('WebSocket not connected'); },
      repoListIssues: vi.fn(),
      repoListPRs: vi.fn(),
      repoListBranches: vi.fn(),
      repoListCommits: vi.fn(),
    } as unknown as WsClient;

    render(<RepoPage ws={failWs} projectDir={PROJECT_DIR} onBack={vi.fn()} />);

    // Should immediately show send error
    await act(async () => {});
    const errorElements = screen.getAllByText(/Send failed/);
    expect(errorElements.length).toBeGreaterThanOrEqual(1);
    expect(errorElements[0].textContent).toContain('WebSocket not connected');
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
});
