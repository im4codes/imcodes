/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { REPO_MSG } from '@shared/repo-types.js';
import {
  REPO_CALLBACK_PREF_KEYS,
  normalizeRepoCallbackRepoConfig,
  repoCallbackServerPrefKey,
  resolveRepoCallbackPromptTemplate,
  type RepoCallbackRepoConfig,
  type RepoCallbackTemplate,
} from '@shared/repo-callback.js';
import type { CallbackTaskRecord } from '@shared/callback-types.js';
import type { WsClient, ServerMessage } from '../src/ws-client.js';
import { RepoPage } from '../src/pages/RepoPage.js';
import { REPO_CALLBACK_PAGE_SIZE } from '../src/components/RepoCallbackModal.js';
import { buildRepoCallbackTargetOptions, saveRepoCallbackRepoConfig } from '../src/repo-callback-prefs.js';
import { getUserPref } from '../src/api.js';

const nativeMockState = vi.hoisted(() => ({
  isNative: false,
  browserOpen: vi.fn(async (_opts: { url: string }) => {}),
}));

vi.mock('../src/native.js', () => ({
  isNative: () => nativeMockState.isNative,
}));

vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: (opts: { url: string }) => nativeMockState.browserOpen(opts),
  },
}));

const prefStore = new Map<string, unknown>();

vi.mock('../src/api.js', () => ({
  getUserPref: vi.fn(async (key: string) => prefStore.get(key) ?? null),
  saveUserPref: vi.fn(async (key: string, value: unknown) => {
    prefStore.set(key, value);
  }),
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'repo.callback_button') return 'Monitor & Callback';
      if (key === 'repo.callback_modal_title') return 'Repository Monitor & Auto-Callback';
      if (key === 'repo.callback_enabled') return 'Enable background repository monitoring';
      if (key === 'repo.callback_interval_label') return 'Poll interval';
      if (key === 'repo.callback_interval_minutes') return `Every ${opts?.minutes ?? ''}`;
      if (key === 'repo.callback_lookback_label') return 'Monitor from';
      if (key === 'repo.callback_lookback_now') return 'From now (after enabled)';
      if (key === 'repo.callback_lookback_1d') return 'Last 1 day';
      if (key === 'repo.callback_lookback_3d') return 'Last 3 days';
      if (key === 'repo.callback_lookback_7d') return 'Last 7 days';
      if (key === 'repo.callback_target_label') return 'Callback target session';
      if (key === 'repo.callback_target_brain') return 'Project Brain (default)';
      if (key === 'repo.callback_events_title') return 'Monitored events';
      if (key === 'repo.callback_event_ci_failed') return 'New CI failure (Actions / Pipelines)';
      if (key === 'repo.callback_event_pr_new') return 'New Pull Request';
      if (key === 'repo.callback_event_issue_new') return 'New Issue';
      if (key === 'repo.callback_event_critical') return 'Critical';
      if (key === 'repo.callback_hide_prompt') return 'Hide prompt';
      if (key === 'repo.callback_edit_prompt') return 'Edit prompt';
      if (key === 'repo.callback_template_label') return 'Prompt template';
      if (key === 'repo.callback_tpl_source_default') return 'Built-in default prompt';
      if (key === 'repo.callback_tpl_scope_global') return 'Global';
      if (key === 'repo.callback_tpl_scope_repo') return 'Repo';
      if (key === 'repo.callback_prompt_label') return 'Callback prompt';
      if (key === 'repo.callback_tpl_name_placeholder') return 'Template name (to save/reuse)';
      if (key === 'repo.callback_tpl_save_global') return 'Save Global';
      if (key === 'repo.callback_tpl_save_repo') return 'Save Repo';
      if (key === 'repo.callback_save') return 'Save settings';
      if (key === 'repo.callback_saved') return 'Callback settings saved and synced.';
      if (key === 'repo.callback_recent_title') return 'Recent callbacks';
      if (key === 'repo.callback_recent_empty') return 'No callbacks recorded';
      if (key === 'repo.callback_filter_all') return 'All';
      if (key === 'repo.callback_filter_active') return 'Active';
      if (key === 'repo.callback_filter_done') return 'Done';
      if (key === 'repo.callback_filter_ignored') return 'Ignored';
      if (key === 'repo.callback_filter_failed') return 'Failed';
      if (key === 'repo.callback_status_pending') return 'Pending';
      if (key === 'repo.callback_status_in_progress') return 'In Progress';
      if (key === 'repo.callback_status_done') return 'Done';
      if (key === 'repo.callback_status_ignored') return 'Ignored';
      if (key === 'repo.callback_status_failed') return 'Failed';
      if (key === 'repo.callback_failed_at') return `Failed: ${opts?.time ?? ''}`;
      if (key === 'repo.callback_event_at') return `Occurred: ${opts?.time ?? ''}`;
      if (key === 'repo.callback_triggered_at') return `Callback: ${opts?.time ?? ''}`;
      if (key === 'repo.callback_completed_at') return `Completed: ${opts?.time ?? ''}`;
      if (key === 'repo.callback_open_link') return 'Open link';
      if (key === 'repo.callback_related_task') return `Related task: ${opts?.taskId ?? ''}`;
      if (key === 'repo.callback_prev_page') return 'Previous';
      if (key === 'repo.callback_next_page') return 'Next';
      if (key === 'repo.callback_page_info') {
        return `Page ${opts?.current ?? ''} / ${opts?.total ?? ''} (${opts?.pageSize ?? ''}/page)`;
      }
      if (key === 'repo.callback_check_now') return 'Check now';
      if (key === 'common.close') return 'Close';
      return key;
    },
  }),
}));

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

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

function createMockWs() {
  const listeners = new Set<(msg: ServerMessage) => void>();
  const ws = {
    connected: true,
    onMessage: (fn: (msg: ServerMessage) => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    emit: (msg: ServerMessage) => {
      for (const fn of listeners) fn(msg);
    },
    repoDetect: vi.fn(() => 'detect-1'),
    repoListIssues: vi.fn(() => 'issues-1'),
    repoListPRs: vi.fn(() => 'prs-1'),
    repoListBranches: vi.fn(() => 'branches-1'),
    repoListCommits: vi.fn(() => 'commits-1'),
    repoListActions: vi.fn(() => 'actions-1'),
    repoCallbackSync: vi.fn(),
    repoCallbackCheckNow: vi.fn(() => 'cb-check-1'),
    repoCallbackStatus: vi.fn(() => 'cb-status-1'),
  };
  return ws as unknown as WsClient & { emit: (msg: ServerMessage) => void };
}

beforeEach(() => {
  prefStore.clear();
  for (const k of Object.keys(localStorageStore)) delete localStorageStore[k];
  nativeMockState.isNative = false;
  nativeMockState.browserOpen.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openModalAndAwaitPrefs() {
  const prevCalls = vi.mocked(getUserPref).mock.calls.length;
  fireEvent.click(screen.getByText('Monitor & Callback'));
  expect(screen.getByRole('dialog')).toBeTruthy();
  await waitFor(() => {
    expect(vi.mocked(getUserPref).mock.calls.length).toBeGreaterThanOrEqual(prevCalls + 2);
  });
  await new Promise((r) => setTimeout(r, 0));
  await waitFor(() => {
    expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(false);
  });
}

// Dispatch a native DOM 'change' event for <select> controls regardless of whether another
// mounted component in the same Vitest process has flipped @testing-library/preact's isCompat flag.
function changeSelect(selectEl: HTMLSelectElement, value: string) {
  selectEl.value = value;
  selectEl.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('RepoCallbackModal & RepoPage callback integration', () => {
  it('configures events, reuses global templates across repos, isolates repo templates, switches Brain/sub-session target, and renders independent callbacks', async () => {
    const ws = createMockWs();

    const targets = buildRepoCallbackTargetOptions(
      '/work/repo-a',
      [
        { name: 'deck_proj_brain', role: 'brain', state: 'idle', projectDir: '/work/repo-a' },
        { name: 'deck_other_w1', role: 'w1', state: 'idle', projectDir: '/work/other' },
      ],
      [
        { sessionName: 'deck_sub_triage', type: 'codex-sdk', label: 'CI Triage', cwd: '/work/repo-a', state: 'idle', closedAt: null, parentSession: 'deck_proj_brain' },
        { sessionName: 'deck_sub_stopped', type: 'codex-sdk', label: 'Stopped Sub', cwd: '/work/repo-a', state: 'stopped', closedAt: null, parentSession: 'deck_proj_brain' },
        { sessionName: 'deck_sub_clone', type: 'codex-sdk', label: 'Clone', cwd: '/work/repo-a', state: 'idle', closedAt: null, executionCloneKind: 'exec', parentRunId: 'run1' },
      ],
    );
    expect(targets.map((t) => t.sessionName)).toEqual(['deck_sub_triage']);

    const { unmount } = render(
      <RepoPage
        ws={ws}
        serverId="srv-1"
        projectDir="/work/repo-a"
        callbackTargets={targets}
      />,
    );

    const initialCallbacks: CallbackTaskRecord[] = [
      {
        callbackId: 'cb_repo_1',
        source: 'repo',
        eventType: 'ci_failed',
        scopeKey: '/work/repo-a',
        entityKey: 'run#10#1',
        dedupKey: 'repo:/work/repo-a:ci_failed:10:1',
        title: 'CI failed: unit-tests',
        url: 'https://github.com/acme/repo-a/actions/runs/10',
        targetSession: 'deck_proj_brain',
        status: 'pending',
        summary: '',
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        callbackId: 'cb_repo_2',
        source: 'repo',
        eventType: 'pr_new',
        scopeKey: '/work/repo-a',
        entityKey: 'pr#42',
        dedupKey: 'repo:/work/repo-a:pr_new:42',
        title: 'PR #42: Feature X',
        targetSession: 'deck_sub_triage',
        status: 'done',
        summary: 'Reviewed PR #42 and filed follow-up task',
        relatedTaskId: 'tsk_pair_99',
        createdAt: 900,
        updatedAt: 1100,
      },
    ];

    ws.emit({
      type: REPO_MSG.CALLBACK_STATUS_RESPONSE,
      projectDir: '/work/repo-a',
      enabled: false,
      checking: false,
      callbacks: initialCallbacks,
    });

    // Open Monitor & Callback modal from RepoPage header and wait for initial prefs load
    await openModalAndAwaitPrefs();

    // Critical CI event indicator is visible and default target is Project Brain
    expect(screen.getByText('Critical')).toBeTruthy();
    const targetSelect = screen.getByLabelText('Callback target session') as HTMLSelectElement;
    expect(targetSelect.value).toBe('brain');

    // Switch target to sub-session and enable monitoring + pr_new
    changeSelect(targetSelect, 'deck_sub_triage');
    fireEvent.click(screen.getByLabelText('Enable background repository monitoring'));
    fireEvent.click(screen.getByLabelText('New Pull Request'));

    // Edit CI prompt and save as reusable Global template
    const ciPromptArea = screen.getByLabelText('New CI failure (Actions / Pipelines) Callback prompt') as HTMLTextAreaElement;
    fireEvent.input(ciPromptArea, { target: { value: 'Triage CI {{title}} and call {{callbackId}}' } });
    const tplNameInput = screen.getByPlaceholderText('Template name (to save/reuse)') as HTMLInputElement;
    fireEvent.input(tplNameInput, { target: { value: 'Shared CI Fix' } });
    fireEvent.click(screen.getByText('Save Global'));

    await waitFor(() => {
      const savedGlobal = prefStore.get(REPO_CALLBACK_PREF_KEYS.GLOBAL_TEMPLATES) as { templates: Array<{ name: string; scope: string }> } | undefined;
      expect(savedGlobal?.templates.some((tpl) => tpl.name === 'Shared CI Fix' && tpl.scope === 'global')).toBe(true);
    });

    // Save a Repo-only template for Repo A
    fireEvent.input(tplNameInput, { target: { value: 'Repo A Only' } });
    fireEvent.click(screen.getByText('Save Repo'));
    await waitFor(() => {
      const serverPrefs = prefStore.get(repoCallbackServerPrefKey('srv-1')) as { repos: Record<string, { templates: Array<{ name: string }> }> };
      expect(serverPrefs.repos['/work/repo-a']?.templates.some((t) => t.name === 'Repo A Only')).toBe(true);
    });

    // Save main settings and verify sync sent
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => {
      expect(ws.repoCallbackSync).toHaveBeenCalled();
      const serverPrefs = prefStore.get(repoCallbackServerPrefKey('srv-1')) as {
        repos: Record<string, { enabled: boolean; target: string; events: { pr_new: { enabled: boolean } } }>;
      };
      expect(serverPrefs.repos['/work/repo-a']?.enabled).toBe(true);
      expect(serverPrefs.repos['/work/repo-a']?.target).toBe('deck_sub_triage');
      expect(serverPrefs.repos['/work/repo-a']?.events.pr_new.enabled).toBe(true);
    });

    // Independent recent callbacks list + live status update + filtering
    expect(screen.getByText('CI failed: unit-tests')).toBeTruthy();
    expect(screen.getByText('Related task: tsk_pair_99')).toBeTruthy();

    ws.emit({
      type: REPO_MSG.CALLBACK_EVENT,
      projectDir: '/work/repo-a',
      callback: {
        ...initialCallbacks[0]!,
        status: 'ignored',
        summary: 'Flaky network error, ignored',
        updatedAt: 2000,
      },
    });

    await waitFor(() => {
      expect(screen.getByText('Flaky network error, ignored')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Ignored' }));
    expect(screen.getByText('CI failed: unit-tests')).toBeTruthy();
    expect(screen.queryByText('PR #42: Feature X')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('PR #42: Feature X')).toBeTruthy();
    expect(screen.queryByText('CI failed: unit-tests')).toBeNull();

    unmount();

    // Open Repo B: Global template 'Shared CI Fix' is selectable & reusable, while 'Repo A Only' is isolated!
    const wsB = createMockWs();
    render(
      <RepoPage
        ws={wsB}
        serverId="srv-1"
        projectDir="/work/repo-b"
        callbackTargets={[]}
      />,
    );
    fireEvent.click(screen.getByText('Monitor & Callback'));

    await waitFor(() => {
      expect(screen.getByText('[Global] Shared CI Fix')).toBeTruthy();
    });
    expect(screen.queryByText('[Repo] Repo A Only')).toBeNull();

    const tplSelectB = screen.getByLabelText('New CI failure (Actions / Pipelines) Prompt template') as HTMLSelectElement;
    const globalOption = Array.from(tplSelectB.options).find((o) => o.text.includes('Shared CI Fix'));
    expect(globalOption).toBeTruthy();
    changeSelect(tplSelectB, globalOption!.value);
    await waitFor(() => {
      const promptB = screen.getByLabelText('New CI failure (Actions / Pipelines) Callback prompt') as HTMLTextAreaElement;
      expect(promptB.value).toContain('Triage CI {{title}}');
    });
  });

  it('F3: preserves edited overrides over selected global/repo templates after save+reload while keeping unedited template references live-updatable', async () => {
    const serverKey = repoCallbackServerPrefKey('srv-1');
    prefStore.set(REPO_CALLBACK_PREF_KEYS.GLOBAL_TEMPLATES, {
      version: 1,
      templates: [
        {
          id: 'global_g1',
          name: 'Global Base',
          scope: 'global',
          eventType: 'pr_new',
          prompt: 'Original global prompt',
          updatedAt: 100,
        },
      ],
    });
    prefStore.set(serverKey, {
      version: 1,
      repos: {
        '/work/repo-a': {
          projectDir: '/work/repo-a',
          enabled: true,
          intervalMs: 120_000,
          target: 'brain',
          events: {
            pr_new: { enabled: true, templateScope: 'default' },
            issue_new: { enabled: false, templateScope: 'default' },
            ci_failed: { enabled: true, templateScope: 'default' },
          },
          templates: [
            {
              id: 'repo_r1',
              name: 'Repo Base',
              scope: 'repo',
              eventType: 'issue_new',
              prompt: 'Original repo prompt',
              updatedAt: 100,
            },
          ],
          updatedAt: 100,
        },
      },
    });

    const ws1 = createMockWs();
    const { unmount } = render(<RepoPage ws={ws1} serverId="srv-1" projectDir="/work/repo-a" />);
    await openModalAndAwaitPrefs();

    // Expand PR prompt editor (initially ci_failed is expanded, so Edit prompt buttons are [0]=pr_new, [1]=issue_new)
    const editButtons = screen.getAllByText('Edit prompt');
    fireEvent.click(editButtons[0]!);

    await waitFor(() => {
      expect(screen.getByText('[Global] Global Base')).toBeTruthy();
    });
    const prTplSelect = screen.getByLabelText('New Pull Request Prompt template') as HTMLSelectElement;
    changeSelect(prTplSelect, 'global:global_g1');
    const prTextarea = await waitFor(() => {
      const ta = screen.getByLabelText('New Pull Request Callback prompt') as HTMLTextAreaElement;
      expect(ta.value).toBe('Original global prompt');
      return ta;
    });
    fireEvent.input(prTextarea, { target: { value: 'Edited global prompt saved' } });

    // Also select Repo Base for issue_new, edit text, and save settings (now [0]=ci_failed, [1]=issue_new)
    fireEvent.click(screen.getAllByText('Edit prompt')[1]!);
    const issueTplSelect = await waitFor(() => screen.getByLabelText('New Issue Prompt template') as HTMLSelectElement);
    changeSelect(issueTplSelect, 'repo:repo_r1');
    const issueTextarea = screen.getByLabelText('New Issue Callback prompt') as HTMLTextAreaElement;
    fireEvent.input(issueTextarea, { target: { value: 'Edited repo prompt saved' } });

    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => {
      expect(ws1.repoCallbackSync).toHaveBeenCalled();
    });

    const savedServerPrefs = prefStore.get(serverKey) as { repos: Record<string, RepoCallbackRepoConfig> };
    const savedGlobal = prefStore.get(REPO_CALLBACK_PREF_KEYS.GLOBAL_TEMPLATES) as { templates: RepoCallbackTemplate[] };
    const savedRepoCfg = savedServerPrefs.repos['/work/repo-a']!;
    expect(resolveRepoCallbackPromptTemplate(savedRepoCfg, 'pr_new', savedGlobal.templates)).toBe('Edited global prompt saved');
    expect(resolveRepoCallbackPromptTemplate(savedRepoCfg, 'issue_new', savedGlobal.templates)).toBe('Edited repo prompt saved');

    // Unmount & reload modal: edited text must remain visible
    unmount();
    const ws2 = createMockWs();
    const view2 = render(<RepoPage ws={ws2} serverId="srv-1" projectDir="/work/repo-a" />);
    await openModalAndAwaitPrefs();
    fireEvent.click(screen.getAllByText('Edit prompt')[0]!);
    await waitFor(() => {
      expect((screen.getByLabelText('New Pull Request Callback prompt') as HTMLTextAreaElement).value).toBe('Edited global prompt saved');
    });

    // Now re-select global:global_g1 WITHOUT editing, save, then update global template externally
    changeSelect(screen.getByLabelText('New Pull Request Prompt template') as HTMLSelectElement, 'global:global_g1');
    await waitFor(() => {
      expect((screen.getByLabelText('New Pull Request Callback prompt') as HTMLTextAreaElement).value).toBe('Original global prompt');
    });
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => {
      expect(ws2.repoCallbackSync).toHaveBeenCalled();
    });
    view2.unmount();

    prefStore.set(REPO_CALLBACK_PREF_KEYS.GLOBAL_TEMPLATES, {
      version: 1,
      templates: [
        {
          id: 'global_g1',
          name: 'Global Base',
          scope: 'global',
          eventType: 'pr_new',
          prompt: 'Global prompt v2 live',
          updatedAt: 200,
        },
      ],
    });

    const savedAfterLive = (prefStore.get(serverKey) as { repos: Record<string, RepoCallbackRepoConfig> }).repos['/work/repo-a']!;
    const globalV2 = (prefStore.get(REPO_CALLBACK_PREF_KEYS.GLOBAL_TEMPLATES) as { templates: RepoCallbackTemplate[] }).templates;
    expect(resolveRepoCallbackPromptTemplate(savedAfterLive, 'pr_new', globalV2)).toBe('Global prompt v2 live');

    const ws3 = createMockWs();
    render(<RepoPage ws={ws3} serverId="srv-1" projectDir="/work/repo-a" />);
    await openModalAndAwaitPrefs();
    fireEvent.click(screen.getAllByText('Edit prompt')[0]!);
    await waitFor(() => {
      expect((screen.getByLabelText('New Pull Request Callback prompt') as HTMLTextAreaElement).value).toBe('Global prompt v2 live');
    });
  });

  it('renders callback modal controls cleanly at 375px narrow viewport without fixed wide minWidth overflows', async () => {
    const origInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true, writable: true });
    try {
      const ws = createMockWs();
      render(<RepoPage ws={ws} serverId="srv-1" projectDir="/work/repo-a" />);
      await openModalAndAwaitPrefs();

      const dialog = screen.getByRole('dialog');
      const modalCard = dialog.firstElementChild as HTMLElement | null;
      expect(modalCard?.style.width).toBe('100%');
      expect(modalCard?.style.overflow).toBe('hidden');
      // ci_failed starts expanded; verify template select fits container
      const selectEl = screen.getByLabelText('New CI failure (Actions / Pipelines) Prompt template') as HTMLSelectElement;
      expect(selectEl.style.maxWidth).toBe('100%');
      // Monitor from selector should also be present in the settings grid
      const lookbackSelect = screen.getByLabelText('Monitor from') as HTMLSelectElement;
      expect(lookbackSelect.value).toBe('now');
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: origInnerWidth, configurable: true, writable: true });
    }
  });

  it('portals callback modal to document.body above mobile sidebar drawer and constrains mobile widths/safe-area padding', async () => {
    const origInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true, writable: true });
    try {
      const ws = createMockWs();
      render(
        <div
          data-testid="mobile-sidebar-drawer-sim"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '320px',
            overflow: 'hidden',
            transform: 'translateX(0)',
          }}
        >
          <RepoPage ws={ws} serverId="srv-1" projectDir="/work/repo-a" />
        </div>,
      );
      await openModalAndAwaitPrefs();

      const drawer = screen.getByTestId('mobile-sidebar-drawer-sim');
      const dialog = screen.getByRole('dialog');
      expect(drawer.contains(dialog)).toBe(false);
      expect(dialog.parentElement).toBe(document.body);
      expect(Number(dialog.style.zIndex)).toBeGreaterThanOrEqual(10000);
      expect(dialog.style.overflowX).toBe('hidden');
      expect(dialog.style.width).toBe('var(--imcodes-ui-vw, 100%)');
      expect(dialog.style.height).toBe('var(--vvh, var(--imcodes-ui-dvh))');
      expect(dialog.style.paddingTop).toContain('safe-area-inset-top');
      expect(dialog.style.paddingBottom).toContain('safe-area-inset-bottom');

      const modalCard = dialog.firstElementChild as HTMLElement | null;
      expect(modalCard?.style.width).toBe('100%');
      expect(modalCard?.style.minWidth).toBe('0px');
      expect(modalCard?.style.boxSizing).toBe('border-box');
      expect(modalCard?.style.overflow).toBe('hidden');

      const lookbackSelect = screen.getByLabelText('Monitor from') as HTMLSelectElement;
      expect(lookbackSelect.style.width).toBe('100%');
      expect(lookbackSelect.style.minWidth).toBe('0px');
      expect(lookbackSelect.style.maxWidth).toBe('100%');

      const templateSelect = screen.getByLabelText('New CI failure (Actions / Pipelines) Prompt template') as HTMLSelectElement;
      expect(templateSelect.style.maxWidth).toBe('100%');
      expect(templateSelect.style.minWidth).toBe('min(160px, 100%)');

      const templateNameInput = screen.getByLabelText('Template name (to save/reuse)') as HTMLInputElement;
      expect(templateNameInput.style.maxWidth).toBe('100%');
      expect(templateNameInput.style.minWidth).toBe('min(150px, 100%)');
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: origInnerWidth, configurable: true, writable: true });
    }
  });

  it('anchors sinceAtMs on enable, preserves it on unrelated saves, re-anchors on lookback change, and persists modal selection', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t0 = 1_700_500_000_000;
      vi.setSystemTime(t0);

      // 1. Default normalization uses lookbackWindow: 'now'
      const normalized = normalizeRepoCallbackRepoConfig({ projectDir: '/work/repo-a', enabled: true, intervalMs: 120_000, target: 'brain', events: {} });
      expect(normalized?.lookbackWindow).toBe('now');
      expect(normalized?.sinceAtMs).toBeUndefined();

      // 2. Enable via modal with '3d' lookback -> sets sinceAtMs = now - 3d
      const ws = createMockWs();
      render(<RepoPage ws={ws} serverId="srv-1" projectDir="/work/repo-a" />);
      await openModalAndAwaitPrefs();

      const lookbackSelect = screen.getByLabelText('Monitor from') as HTMLSelectElement;
      expect(lookbackSelect.value).toBe('now');

      fireEvent.click(screen.getByLabelText('Enable background repository monitoring'));
      changeSelect(lookbackSelect, '3d');
      await waitFor(() => {
        expect((screen.getByLabelText('Monitor from') as HTMLSelectElement).value).toBe('3d');
      });
      const statusCallsBeforeSave = vi.mocked(ws.repoCallbackStatus).mock.calls.length;
      fireEvent.click(screen.getByText('Save settings'));

      const serverKey = repoCallbackServerPrefKey('srv-1');
      await waitFor(() => {
        const saved = (prefStore.get(serverKey) as { repos: Record<string, RepoCallbackRepoConfig> } | undefined)?.repos['/work/repo-a'];
        expect(saved?.enabled).toBe(true);
        expect(saved?.lookbackWindow).toBe('3d');
        expect(saved?.sinceAtMs).toBeGreaterThanOrEqual(t0 - 3 * 86_400_000);
        expect(saved?.sinceAtMs).toBeLessThanOrEqual(t0 - 3 * 86_400_000 + 2_000);
        expect(ws.repoCallbackSync).toHaveBeenCalledWith('/work/repo-a');
      });
      // Must NOT fire a racing concurrent repoCallbackStatus immediately on save
      expect(vi.mocked(ws.repoCallbackStatus).mock.calls.length).toBe(statusCallsBeforeSave);

      const anchoredSince = ((prefStore.get(serverKey) as { repos: Record<string, RepoCallbackRepoConfig> }).repos['/work/repo-a']!).sinceAtMs!;

      // 3. Unrelated save (interval change) while enabled with same lookbackWindow preserves sinceAtMs
      const t1 = t0 + 60_000;
      vi.setSystemTime(t1);
      const savedAfterInterval = await saveRepoCallbackRepoConfig('srv-1', {
        ...((prefStore.get(serverKey) as { repos: Record<string, RepoCallbackRepoConfig> }).repos['/work/repo-a']!),
        intervalMs: 300_000,
      });
      expect(savedAfterInterval.repos['/work/repo-a']?.sinceAtMs).toBe(anchoredSince);

      // 4. Changing lookbackWindow from '3d' to '1d' re-anchors sinceAtMs
      const t2 = t0 + 120_000;
      vi.setSystemTime(t2);
      const savedAfterLookback = await saveRepoCallbackRepoConfig('srv-1', {
        ...savedAfterInterval.repos['/work/repo-a']!,
        lookbackWindow: '1d',
      });
      expect(savedAfterLookback.repos['/work/repo-a']?.sinceAtMs).toBeGreaterThanOrEqual(t2 - 86_400_000);
      expect(savedAfterLookback.repos['/work/repo-a']?.sinceAtMs).toBeLessThanOrEqual(t2 - 86_400_000 + 2_000);

      // 5. Disabling clears sinceAtMs so later re-enable anchors fresh
      const savedDisabled = await saveRepoCallbackRepoConfig('srv-1', {
        ...savedAfterLookback.repos['/work/repo-a']!,
        enabled: false,
      });
      expect(savedDisabled.repos['/work/repo-a']?.sinceAtMs).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('initializes callbackRuntimeEnabled green dot from persisted prefs before CALLBACK_STATUS_RESPONSE arrives, and lets live daemon response govern', async () => {
    const serverKey = repoCallbackServerPrefKey('srv-1');
    prefStore.set(serverKey, {
      version: 1,
      repos: {
        '/work/repo-green': {
          projectDir: '/work/repo-green',
          enabled: true,
          intervalMs: 120_000,
          target: 'brain',
          lookbackWindow: 'now',
          sinceAtMs: 1_700_000_000_000,
          events: {
            ci_failed: { enabled: true, templateScope: 'default' },
            pr_new: { enabled: false, templateScope: 'default' },
            issue_new: { enabled: false, templateScope: 'default' },
          },
          templates: [],
          updatedAt: 1_700_000_000_000,
        },
      },
    });

    const ws = createMockWs();
    const { container } = render(<RepoPage ws={ws} serverId="srv-1" projectDir="/work/repo-green" />);

    const findDot = () => {
      const btn = screen.getByText('Monitor & Callback').closest('button')!;
      return btn.querySelector('span') as HTMLSpanElement;
    };

    // Even before daemon sends CALLBACK_STATUS_RESPONSE, green dot should reflect persisted enabled=true
    await waitFor(() => {
      expect(findDot().style.background).toBe('rgb(34, 197, 94)');
    });

    // When live daemon CALLBACK_STATUS_RESPONSE arrives with enabled=false, live daemon state governs
    ws.emit({
      type: REPO_MSG.CALLBACK_STATUS_RESPONSE,
      projectDir: '/work/repo-green',
      enabled: false,
      checking: false,
      callbacks: [],
    });
    await waitFor(() => {
      expect(findDot().style.background).toBe('rgb(100, 116, 139)');
    });
    expect(container).toBeTruthy();
  });

  it('shows missing-server error instead of fake success when saving a repo template without serverId, and clears checking state even with trailing slash projectDir', async () => {
    const ws = createMockWs();
    render(<RepoPage ws={ws} projectDir="/work/repo-nosrv/" />);

    // 1. Daemon emits checking=true then checking=false without trailing slash
    ws.emit({
      type: REPO_MSG.CALLBACK_STATUS_RESPONSE,
      projectDir: '/work/repo-nosrv',
      enabled: true,
      checking: true,
      callbacks: [],
    });
    const modalBtn = await screen.findByText('Monitor & Callback');
    fireEvent.click(modalBtn);
    await waitFor(() => {
      expect(screen.getByText('repo.callback_checking')).toBeTruthy();
    });

    ws.emit({
      type: REPO_MSG.CALLBACK_STATUS_RESPONSE,
      projectDir: '/work/repo-nosrv',
      enabled: true,
      checking: false,
      callbacks: [],
    });
    await waitFor(() => {
      expect(screen.queryByText('repo.callback_checking')).toBeNull();
    });

    // 2. Attempting to save a repo template without serverId shows error feedback, not success
    fireEvent.click(screen.getAllByText('Edit prompt')[0]!);
    const nameInput = await waitFor(() => screen.getByPlaceholderText('Template name (to save/reuse)') as HTMLInputElement);
    fireEvent.input(nameInput, { target: { value: 'Unsynced Template' } });
    fireEvent.click(screen.getByText('Save Repo'));

    await waitFor(() => {
      expect(screen.getByText('repo.callback_missing_server')).toBeTruthy();
    });
    expect(screen.queryByText('repo.callback_tpl_saved_repo')).toBeNull();
  });

  it('renders failure/event time, callback time, terminal completion time, and opens safe http(s) URLs via web window.open or native Browser.open', async () => {
    const ws = createMockWs();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(
      <RepoPage
        ws={ws}
        serverId="srv-1"
        projectDir="/work/repo-ts"
        callbackTargets={[]}
      />,
    );

    const tPending = 1_700_000_010_000;
    const tProgressEvent = 1_700_000_018_000;
    const tProgressStart = 1_700_000_020_000;
    const tProgressUpdate = 1_700_000_025_000;
    const tDoneEvent = 1_700_000_028_000;
    const tDoneStart = 1_700_000_030_000;
    const tDoneEnd = 1_700_000_040_000;
    const tIgnoredStart = 1_700_000_050_000;
    const tIgnoredEnd = 1_700_000_060_000;
    const tFailedEvent = 1_700_000_065_000;
    const tFailedStart = 1_700_000_070_000;
    const tFailedEnd = 1_700_000_080_000;

    const callbacks: CallbackTaskRecord[] = [
      {
        callbackId: 'cb_pending',
        source: 'repo',
        eventType: 'ci_failed',
        scopeKey: '/work/repo-ts',
        entityKey: 'run#1',
        dedupKey: 'repo:/work/repo-ts:ci_failed:1',
        title: 'Pending CB',
        url: 'https://github.com/acme/repo-ts/actions/runs/1',
        targetSession: 'deck_proj_brain',
        status: 'pending',
        summary: '',
        createdAt: tPending,
        updatedAt: tPending + 5_000,
      },
      {
        callbackId: 'cb_in_progress',
        source: 'repo',
        eventType: 'pr_new',
        scopeKey: '/work/repo-ts',
        entityKey: 'pr#2',
        dedupKey: 'repo:/work/repo-ts:pr_new:2',
        title: 'In Progress CB',
        targetSession: 'deck_proj_brain',
        status: 'in_progress',
        summary: '',
        metadata: { eventAt: tProgressEvent },
        createdAt: tProgressStart,
        updatedAt: tProgressUpdate,
      },
      {
        callbackId: 'cb_done',
        source: 'repo',
        eventType: 'issue_new',
        scopeKey: '/work/repo-ts',
        entityKey: 'issue#3',
        dedupKey: 'repo:/work/repo-ts:issue_new:3',
        title: 'Done CB',
        targetSession: 'deck_proj_brain',
        status: 'done',
        summary: 'Fixed issue #3',
        relatedTaskId: 'tsk_done_3',
        metadata: { eventAt: tDoneEvent },
        createdAt: tDoneStart,
        updatedAt: tDoneEnd,
      },
      {
        callbackId: 'cb_ignored',
        source: 'repo',
        eventType: 'ci_failed',
        scopeKey: '/work/repo-ts',
        entityKey: 'run#4',
        dedupKey: 'repo:/work/repo-ts:ci_failed:4',
        title: 'Ignored CB',
        targetSession: 'deck_proj_brain',
        status: 'ignored',
        summary: 'Noise',
        createdAt: tIgnoredStart,
        updatedAt: tIgnoredEnd,
      },
      {
        callbackId: 'cb_failed',
        source: 'repo',
        eventType: 'ci_failed',
        scopeKey: '/work/repo-ts',
        entityKey: 'run#5',
        dedupKey: 'repo:/work/repo-ts:ci_failed:5',
        title: 'Failed CB',
        url: 'https://github.com/acme/repo-ts/actions/runs/5',
        targetSession: 'deck_proj_brain',
        status: 'failed',
        summary: '',
        lastError: 'Timed out',
        metadata: { failedAt: tFailedEvent, eventAt: tFailedEvent },
        createdAt: tFailedStart,
        updatedAt: tFailedEnd,
      },
      {
        callbackId: 'cb_invalid',
        source: 'repo',
        eventType: 'pr_new',
        scopeKey: '/work/repo-ts',
        entityKey: 'pr#6',
        dedupKey: 'repo:/work/repo-ts:pr_new:6',
        title: 'Invalid TS CB',
        url: 'javascript:alert(1)',
        targetSession: 'deck_proj_brain',
        status: 'done',
        summary: 'Bad timestamps',
        metadata: { eventAt: Number.NaN },
        createdAt: 0,
        updatedAt: Number.NaN,
      },
    ];

    ws.emit({
      type: REPO_MSG.CALLBACK_STATUS_RESPONSE,
      projectDir: '/work/repo-ts',
      enabled: true,
      checking: false,
      callbacks,
    });

    await openModalAndAwaitPrefs();

    // Timestamps: failure/event time + callback time + terminal completion time
    expect(screen.getByText(`Callback: ${new Date(tPending).toLocaleString()}`)).toBeTruthy();
    expect(screen.queryByText(`Completed: ${new Date(tPending + 5_000).toLocaleString()}`)).toBeNull();

    expect(screen.getByText(`Occurred: ${new Date(tProgressEvent).toLocaleString()}`)).toBeTruthy();
    expect(screen.getByText(`Callback: ${new Date(tProgressStart).toLocaleString()}`)).toBeTruthy();
    expect(screen.queryByText(`Completed: ${new Date(tProgressUpdate).toLocaleString()}`)).toBeNull();

    expect(screen.getByText(`Occurred: ${new Date(tDoneEvent).toLocaleString()}`)).toBeTruthy();
    expect(screen.getByText(`Callback: ${new Date(tDoneStart).toLocaleString()}`)).toBeTruthy();
    expect(screen.getByText(`Completed: ${new Date(tDoneEnd).toLocaleString()}`)).toBeTruthy();
    expect(screen.getByText('Related task: tsk_done_3')).toBeTruthy();

    expect(screen.getByText(`Callback: ${new Date(tIgnoredStart).toLocaleString()}`)).toBeTruthy();
    expect(screen.getByText(`Completed: ${new Date(tIgnoredEnd).toLocaleString()}`)).toBeTruthy();

    expect(screen.getByText(`Failed: ${new Date(tFailedEvent).toLocaleString()}`)).toBeTruthy();
    expect(screen.getByText(`Callback: ${new Date(tFailedStart).toLocaleString()}`)).toBeTruthy();
    expect(screen.getByText(`Completed: ${new Date(tFailedEnd).toLocaleString()}`)).toBeTruthy();

    // Invalid timestamps never show Invalid Date, and unsafe javascript: URL is not rendered as an anchor
    const invalidTitleEl = screen.getByText('Invalid TS CB');
    expect(invalidTitleEl.tagName).toBe('SPAN');
    expect(screen.queryByText(/Invalid Date/i)).toBeNull();

    // Safe URLs: clicking title anchor or Open link button invokes window.open on web
    const pendingTitleLink = screen.getByRole('link', { name: 'Pending CB' });
    fireEvent.click(pendingTitleLink);
    expect(openSpy).toHaveBeenCalledWith('https://github.com/acme/repo-ts/actions/runs/1', '_blank', 'noopener,noreferrer');

    const openLinkButtons = screen.getAllByRole('button', { name: 'Open link ↗' });
    expect(openLinkButtons).toHaveLength(2);
    fireEvent.click(openLinkButtons[1]!);
    expect(openSpy).toHaveBeenCalledWith('https://github.com/acme/repo-ts/actions/runs/5', '_blank', 'noopener,noreferrer');

    // Native app path: Browser.open({ url }) is used instead of window.open
    openSpy.mockClear();
    nativeMockState.isNative = true;
    fireEvent.click(screen.getByRole('link', { name: 'Failed CB' }));
    await waitFor(() => {
      expect(nativeMockState.browserOpen).toHaveBeenCalledWith({ url: 'https://github.com/acme/repo-ts/actions/runs/5' });
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('paginates recent callbacks at 10 per page and resets/clamps page across empty, 10, 19, filter changes, shrink, reopen, and project switch', async () => {
    expect(REPO_CALLBACK_PAGE_SIZE).toBe(10);

    const makeCallbacks = (count: number, scopeKey = '/work/repo-page'): CallbackTaskRecord[] =>
      Array.from({ length: count }, (_, idx) => {
        const n = idx + 1;
        const status = n <= 12 ? 'done' : n <= 16 ? 'failed' : 'pending';
        return {
          callbackId: `cb_${scopeKey}_${n}`,
          source: 'repo',
          eventType: 'ci_failed',
          scopeKey,
          entityKey: `run#${n}`,
          dedupKey: `repo:${scopeKey}:ci_failed:${n}`,
          title: `Callback Item #${n}`,
          targetSession: 'deck_proj_brain',
          status,
          summary: `Summary for #${n}`,
          createdAt: 10_000 - n,
          updatedAt: 10_000 - n,
        };
      });

    const ws = createMockWs();
    const { rerender } = render(<RepoPage ws={ws} serverId="srv-1" projectDir="/work/repo-page" />);

    // 0 items boundary: empty state shown, no pagination controls
    ws.emit({
      type: REPO_MSG.CALLBACK_STATUS_RESPONSE,
      projectDir: '/work/repo-page',
      enabled: true,
      checking: false,
      callbacks: [],
    });

    await openModalAndAwaitPrefs();
    expect(screen.getByText('Recent callbacks (0)')).toBeTruthy();
    expect(screen.getByText('No callbacks recorded')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();

    // Exact 10 items boundary: single page renders all 10 without pagination controls
    ws.emit({
      type: REPO_MSG.CALLBACK_STATUS_RESPONSE,
      projectDir: '/work/repo-page',
      enabled: true,
      checking: false,
      callbacks: makeCallbacks(10),
    });

    await waitFor(() => {
      expect(screen.getByText('Recent callbacks (10)')).toBeTruthy();
    });
    expect(screen.getByText('Callback Item #1')).toBeTruthy();
    expect(screen.getByText('Callback Item #10')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();

    // 19 items scenario: 2 pages (10 + 9), title retains total (19)
    ws.emit({
      type: REPO_MSG.CALLBACK_STATUS_RESPONSE,
      projectDir: '/work/repo-page',
      enabled: true,
      checking: false,
      callbacks: makeCallbacks(19),
    });

    await waitFor(() => {
      expect(screen.getByText('Recent callbacks (19)')).toBeTruthy();
    });
    expect(screen.getByText('Page 1 / 2 (10/page)')).toBeTruthy();
    expect(screen.getByText('Callback Item #1')).toBeTruthy();
    expect(screen.getByText('Callback Item #10')).toBeTruthy();
    expect(screen.queryByText('Callback Item #11')).toBeNull();
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);

    // Navigate to Page 2: renders items #11..#19, Next disabled, Previous enabled
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Recent callbacks (19)')).toBeTruthy();
    expect(screen.getByText('Page 2 / 2 (10/page)')).toBeTruthy();
    expect(screen.queryByText('Callback Item #1')).toBeNull();
    expect(screen.queryByText('Callback Item #10')).toBeNull();
    expect(screen.getByText('Callback Item #11')).toBeTruthy();
    expect(screen.getByText('Callback Item #19')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);

    // Filter switch from Page 2 to 'Done' (12 items > 10): resets to Page 1
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Recent callbacks (12)')).toBeTruthy();
    expect(screen.getByText('Page 1 / 2 (10/page)')).toBeTruthy();
    expect(screen.getByText('Callback Item #1')).toBeTruthy();
    expect(screen.queryByText('Callback Item #11')).toBeNull();

    // Advance to Page 2 of 'Done', then switch to 'Failed' (4 items <= 10): resets to Page 1 & hides pagination
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Callback Item #12')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
    expect(screen.getByText('Recent callbacks (4)')).toBeTruthy();
    expect(screen.getByText('Callback Item #13')).toBeTruthy();
    expect(screen.getByText('Callback Item #16')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();

    // Switch back to 'All', go to Page 2, then shrink data from 19 -> 8: clamps to Page 1 with zero blank state
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Page 2 / 2 (10/page)')).toBeTruthy();

    ws.emit({
      type: REPO_MSG.CALLBACK_STATUS_RESPONSE,
      projectDir: '/work/repo-page',
      enabled: true,
      checking: false,
      callbacks: makeCallbacks(8),
    });

    await waitFor(() => {
      expect(screen.getByText('Recent callbacks (8)')).toBeTruthy();
    });
    expect(screen.getByText('Callback Item #1')).toBeTruthy();
    expect(screen.getByText('Callback Item #8')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();

    // Restore 19 items, go to Page 2, close & reopen modal: resets to Page 1
    ws.emit({
      type: REPO_MSG.CALLBACK_STATUS_RESPONSE,
      projectDir: '/work/repo-page',
      enabled: true,
      checking: false,
      callbacks: makeCallbacks(19),
    });
    await waitFor(() => {
      expect(screen.getByText('Recent callbacks (19)')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Page 2 / 2 (10/page)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await openModalAndAwaitPrefs();
    expect(screen.getByText('Page 1 / 2 (10/page)')).toBeTruthy();
    expect(screen.getByText('Callback Item #1')).toBeTruthy();
    expect(screen.queryByText('Callback Item #11')).toBeNull();

    // Go to Page 2, then switch projectDir while modal is open: resets to Page 1
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Page 2 / 2 (10/page)')).toBeTruthy();

    rerender(<RepoPage ws={ws} serverId="srv-1" projectDir="/work/repo-page-2" />);
    ws.emit({
      type: REPO_MSG.CALLBACK_STATUS_RESPONSE,
      projectDir: '/work/repo-page-2',
      enabled: true,
      checking: false,
      callbacks: makeCallbacks(19, '/work/repo-page-2'),
    });

    await waitFor(() => {
      expect(screen.getByText('Page 1 / 2 (10/page)')).toBeTruthy();
    });
    expect(screen.getByText('Callback Item #1')).toBeTruthy();
    expect(screen.queryByText('Callback Item #11')).toBeNull();
  });
});
