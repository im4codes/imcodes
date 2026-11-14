/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { REPO_MSG } from '@shared/repo-types.js';
import { REPO_CALLBACK_PREF_KEYS, repoCallbackServerPrefKey, resolveRepoCallbackPromptTemplate, type RepoCallbackRepoConfig, type RepoCallbackTemplate } from '@shared/repo-callback.js';
import type { CallbackTaskRecord } from '@shared/callback-types.js';
import type { WsClient, ServerMessage } from '../src/ws-client.js';
import { RepoPage } from '../src/pages/RepoPage.js';
import { buildRepoCallbackTargetOptions } from '../src/repo-callback-prefs.js';
import { getUserPref } from '../src/api.js';

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
      if (key === 'repo.callback_related_task') return `Related task: ${opts?.taskId ?? ''}`;
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
});

afterEach(cleanup);

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
    fireEvent.change(targetSelect, { target: { value: 'deck_sub_triage' } });
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
    fireEvent.change(tplSelectB, { target: { value: globalOption!.value } });
    const promptB = screen.getByLabelText('New CI failure (Actions / Pipelines) Callback prompt') as HTMLTextAreaElement;
    expect(promptB.value).toContain('Triage CI {{title}}');
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
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: origInnerWidth, configurable: true, writable: true });
    }
  });
});
