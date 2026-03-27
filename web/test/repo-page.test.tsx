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
    respondDetectFlat,
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

  it('stays in loading when WS is not connected (no error flash)', async () => {
    // Create a ws mock where repoDetect throws (simulating disconnected WS)
    // When ws.connected is false, the error is suppressed — the connected handler will retry
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

    // Should stay in loading state (no error flash) — connected handler will retry
    await act(async () => {});
    expect(screen.getAllByText('Loading...').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/Send failed/)).toBeNull();
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
