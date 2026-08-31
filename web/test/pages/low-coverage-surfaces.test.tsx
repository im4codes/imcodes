/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { AddProject } from '../../src/pages/AddProject.js';
import { AdminPage } from '../../src/pages/AdminPage.js';
import { DashboardPage } from '../../src/pages/DashboardPage.js';
import { AutoFixControls } from '../../src/pages/AutoFixControls.js';
import { AutoFixMonitor } from '../../src/pages/AutoFixMonitor.js';
import { ProjectSettings } from '../../src/pages/ProjectSettings.js';
import { ServerSetupPage } from '../../src/pages/ServerSetupPage.js';
import { VoiceOverlay } from '../../src/components/VoiceOverlay.js';
import OfficePreview from '../../src/components/OfficePreview.js';
import type { AutoFixTaskStatus } from '../../src/types.js';

const {
  adminApi,
  dashboardApi,
  nativeApi,
  translate,
  voiceApi,
  xlsxApi,
} = vi.hoisted(() => ({
  adminApi: {
    approveUser: vi.fn(),
    deleteAdminUser: vi.fn(),
    disableUser: vi.fn(),
    fetchAdminSettings: vi.fn(),
    fetchAdminUsers: vi.fn(),
    updateAdminSettings: vi.fn(),
  },
  dashboardApi: {
    apiFetch: vi.fn(),
  },
  nativeApi: {
    addServerToList: vi.fn(),
    getServerList: vi.fn(),
    isNative: vi.fn(),
    removeServerFromList: vi.fn(),
    setServerUrl: vi.fn(),
  },
  translate: vi.fn((key: string, vars?: Record<string, unknown>) => (
    vars?.name ? `${key}:${vars.name}` : key
  )),
  voiceApi: {
    audioLevelHandler: null as ((level: number) => void) | null,
    partialHandler: null as ((partial: string) => void) | null,
    listeningHandler: null as ((listening: boolean) => void) | null,
    onAudioLevel: vi.fn((handler: ((level: number) => void) | null) => {
      voiceApi.audioLevelHandler = handler;
    }),
    startListening: vi.fn(async (
      handler: (partial: string) => void,
      onListeningChange?: (listening: boolean) => void,
    ) => {
      voiceApi.partialHandler = handler;
      voiceApi.listeningHandler = onListeningChange ?? null;
      voiceApi.listeningHandler?.(true);
      return true;
    }),
    stopListening: vi.fn(async () => undefined),
  },
  xlsxApi: {
    read: vi.fn(),
    sheetToHtml: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: translate,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => dashboardApi.apiFetch(...args),
  approveUser: (...args: unknown[]) => adminApi.approveUser(...args),
  deleteAdminUser: (...args: unknown[]) => adminApi.deleteAdminUser(...args),
  disableUser: (...args: unknown[]) => adminApi.disableUser(...args),
  fetchAdminSettings: (...args: unknown[]) => adminApi.fetchAdminSettings(...args),
  fetchAdminUsers: (...args: unknown[]) => adminApi.fetchAdminUsers(...args),
  updateAdminSettings: (...args: unknown[]) => adminApi.updateAdminSettings(...args),
}));

vi.mock('../../src/native.js', () => ({
  DEFAULT_SERVER_URL: 'https://cloud.im.codes',
  addServerToList: (...args: unknown[]) => nativeApi.addServerToList(...args),
  getServerList: (...args: unknown[]) => nativeApi.getServerList(...args),
  isNative: (...args: unknown[]) => nativeApi.isNative(...args),
  isValidServerUrl: (url: string) => /^https?:\/\//.test(url),
  removeServerFromList: (...args: unknown[]) => nativeApi.removeServerFromList(...args),
  setServerUrl: (...args: unknown[]) => nativeApi.setServerUrl(...args),
}));

vi.mock('../../src/components/VoiceInput.js', () => ({
  onAudioLevel: (...args: unknown[]) => voiceApi.onAudioLevel(...args),
  startListening: (...args: unknown[]) => voiceApi.startListening(...args),
  stopListening: (...args: unknown[]) => voiceApi.stopListening(...args),
}));

vi.mock('xlsx', () => ({
  default: {
    read: (...args: unknown[]) => xlsxApi.read(...args),
    utils: {
      sheet_to_html: (...args: unknown[]) => xlsxApi.sheetToHtml(...args),
    },
  },
  read: (...args: unknown[]) => xlsxApi.read(...args),
  utils: {
    sheet_to_html: (...args: unknown[]) => xlsxApi.sheetToHtml(...args),
  },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function changeSelect(select: HTMLElement, value: string): void {
  const element = select as HTMLSelectElement;
  element.value = value;
  for (const option of Array.from(element.options)) {
    option.selected = option.value === value;
  }
  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
}

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
  adminApi.fetchAdminUsers.mockResolvedValue([
    { id: 'u-pending', username: 'newbie', displayName: 'New User', status: 'pending', isAdmin: false, createdAt: 1778460000000 },
    { id: 'u-active', username: 'ada', displayName: 'Ada', status: 'active', isAdmin: true, createdAt: 1778460000000 },
  ]);
  adminApi.fetchAdminSettings.mockResolvedValue({
    registration_enabled: 'true',
    require_approval: 'false',
  });
  adminApi.approveUser.mockResolvedValue(undefined);
  adminApi.deleteAdminUser.mockResolvedValue(undefined);
  adminApi.disableUser.mockResolvedValue(undefined);
  adminApi.updateAdminSettings.mockResolvedValue(undefined);
  dashboardApi.apiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/server') return { servers: [] };
    if (path === '/api/auth/user/me/keys') return { keys: [] };
    return {};
  });
  nativeApi.getServerList.mockResolvedValue(['https://cloud.im.codes']);
  nativeApi.addServerToList.mockResolvedValue(undefined);
  nativeApi.removeServerFromList.mockResolvedValue(undefined);
  nativeApi.setServerUrl.mockResolvedValue(undefined);
  nativeApi.isNative.mockReturnValue(false);
  translate.mockClear();
  voiceApi.audioLevelHandler = null;
  voiceApi.partialHandler = null;
  voiceApi.listeningHandler = null;
  voiceApi.onAudioLevel.mockClear();
  voiceApi.startListening.mockClear();
  voiceApi.stopListening.mockClear();
  xlsxApi.read.mockReturnValue({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } });
  xlsxApi.sheetToHtml.mockReturnValue('<table><tr><td>Total</td></tr></table>');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('low-coverage page and component surfaces', () => {
  it('AddProject submits a project and validates tracker-backed projects first', async () => {
    const onAdded = vi.fn();
    render(<AddProject apiKey="key-1" serverId="srv-1" onAdded={onAdded} onCancel={vi.fn()} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'alpha' } });
    fireEvent.input(screen.getByPlaceholderText('/home/user/projects/my-project'), { target: { value: '/work/alpha' } });
    const issueTrackerSelect = screen.getByText('Issue Tracker').parentElement?.querySelector('select');
    expect(issueTrackerSelect).not.toBeNull();
    fireEvent.change(issueTrackerSelect!, { target: { value: 'github' } });
    fireEvent.input(await screen.findByPlaceholderText('ghp_...'), { target: { value: 'ghp_token' } });
    fireEvent.input(screen.getByPlaceholderText('myorg/myrepo'), { target: { value: 'imcodes/app' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Project' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(fetch).mock.calls;
    expect(String(calls[0][0])).toBe('/api/server/srv-1/tracker/validate');
    expect(String(calls[1][0])).toBe('/api/server/srv-1/projects');
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('alpha'));
  });

  it('ServerSetupPage adds, verifies, connects, and removes saved servers', async () => {
    const onConnect = vi.fn();
    render(<ServerSetupPage onConnect={onConnect} />);

    expect(await screen.findByText('https://cloud.im.codes')).toBeTruthy();
    fireEvent.click(screen.getByText('serverSetup.addServer'));
    fireEvent.input(screen.getByPlaceholderText('serverSetup.placeholder'), {
      target: { value: 'https://self-hosted.example' },
    });
    fireEvent.click(screen.getByText('serverSetup.connect'));

    await waitFor(() => expect(nativeApi.setServerUrl).toHaveBeenCalledWith('https://self-hosted.example'));
    expect(onConnect).toHaveBeenCalledWith('https://self-hosted.example');

    fireEvent.click(screen.getByLabelText('Remove'));
    await waitFor(() => expect(nativeApi.removeServerFromList).toHaveBeenCalledWith('https://self-hosted.example'));
  });

  it('AutoFixControls starts task mode and stops a running pipeline', async () => {
    const onStarted = vi.fn();
    const { rerender } = render(
      <AutoFixControls
        apiKey="key-1"
        serverId="srv-1"
        projectName="alpha"
        isRunning={false}
        onStarted={onStarted}
        onStopped={vi.fn()}
      />,
    );

    fireEvent.input(screen.getByPlaceholderText('Describe the task to fix or implement…'), {
      target: { value: 'Fix CI' },
    });
    fireEvent.click(screen.getByText('Start Auto-Fix'));

    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).toBe('/api/server/srv-1/projects/alpha/autofix');

    const onStopped = vi.fn();
    rerender(
      <AutoFixControls
        apiKey="key-1"
        serverId="srv-1"
        projectName="alpha"
        isRunning
        onStarted={onStarted}
        onStopped={onStopped}
      />,
    );
    fireEvent.click(screen.getByLabelText('Stop immediately (vs. stop after current task)'));
    fireEvent.click(screen.getByText('Stop Now'));
    await waitFor(() => expect(onStopped).toHaveBeenCalled());
  });

  it('AutoFixControls loads issue mode and starts the selected issue', async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/issues')) {
        return jsonResponse([{ id: '42', title: 'Fix parser', priority: 1, assignee: 'ada' }]);
      }
      return jsonResponse({ ok: true });
    });
    const onStarted = vi.fn();
    render(
      <AutoFixControls
        apiKey="key-1"
        serverId="srv-1"
        projectName="alpha"
        isRunning={false}
        onStarted={onStarted}
        onStopped={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Pick Issue'));
    expect(await screen.findByText('#42 Fix parser')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio'));
    fireEvent.click(screen.getByText('Start Auto-Fix'));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
  });

  it('AutoFixMonitor switches sessions and exposes progress timeline states', () => {
    const onSessionSelect = vi.fn();
    const task: AutoFixTaskStatus = {
      id: 'task-1',
      title: 'Ship coverage',
      state: 'implementing',
      discussionRounds: 2,
      maxDiscussionRounds: 3,
      coderSession: 'deck_alpha_coder',
      auditorSession: 'deck_alpha_auditor',
      startedAt: 1778460000000,
      updatedAt: 1778460060000,
    };

    render(<AutoFixMonitor apiKey="key-1" serverId="srv-1" projectName="alpha" task={task} onSessionSelect={onSessionSelect} />);

    expect(screen.getByText('Ship coverage')).toBeTruthy();
    expect(screen.getByText('Round 2/3')).toBeTruthy();
    fireEvent.click(screen.getByText('deck_alpha_auditor'));
    fireEvent.click(screen.getByText(/Session:/));
    expect(onSessionSelect).toHaveBeenCalledWith('deck_alpha_auditor');
  });

  it('ProjectSettings loads settings, edits fields, and saves', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      name: 'alpha',
      coderAgent: 'claude-code',
      auditorAgent: 'codex',
      baseBranch: 'main',
      maxDiscussionRounds: 3,
      autoMerge: false,
      issueFilters: { labels: ['bug'], assignedToMe: false },
      autoFixMode: 'one-time',
    })).mockResolvedValueOnce(jsonResponse({ ok: true }));
    const onSaved = vi.fn();
    render(<ProjectSettings apiKey="key-1" serverId="srv-1" projectName="alpha" onSaved={onSaved} onCancel={vi.fn()} />);

    const branch = await screen.findByDisplayValue('main');
    fireEvent.input(branch, { target: { value: 'release' } });
    fireEvent.click(screen.getByText('Auto-merge on approval'));
    fireEvent.click(screen.getByText('Save Settings'));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [, init] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ baseBranch: 'release', autoMerge: true });
  });

  it('VoiceOverlay starts listening, inserts partial text, and sends trimmed text', async () => {
    vi.useFakeTimers();
    const onSend = vi.fn();
    const onClose = vi.fn();
    render(<VoiceOverlay open initialText="hello" onSend={onSend} onClose={onClose} />);

    await vi.advanceTimersByTimeAsync(150);
    await waitFor(() => expect(voiceApi.startListening).toHaveBeenCalled());
    voiceApi.partialHandler?.('world');
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(screen.getByText('voice.send'));

    expect(onSend).toHaveBeenCalledWith('hello world');
    expect(onClose).toHaveBeenCalled();
  });

  it('VoiceOverlay restarts on the first tap after native listening stops itself', async () => {
    vi.useFakeTimers();
    render(<VoiceOverlay open initialText="" onSend={vi.fn()} onClose={vi.fn()} />);

    await vi.advanceTimersByTimeAsync(150);
    await waitFor(() => expect(voiceApi.startListening).toHaveBeenCalledTimes(1));
    voiceApi.listeningHandler?.(false);
    await waitFor(() => expect(screen.getByText('voice.paused')).toBeTruthy());

    const micButton = document.querySelector('.voice-overlay-mic') as HTMLButtonElement;
    fireEvent.click(micButton);

    await waitFor(() => expect(voiceApi.startListening).toHaveBeenCalledTimes(2));
    expect(voiceApi.stopListening).not.toHaveBeenCalled();
  });

  it('OfficePreview renders unsupported and spreadsheet previews', async () => {
    const { rerender } = render(<OfficePreview data="" mimeType="text/plain" path="/tmp/readme.txt" />);
    expect(screen.getByText('Unsupported format: readme.txt')).toBeTruthy();

    rerender(<OfficePreview data="AA==" mimeType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" path="/tmp/book.xlsx" />);
    expect(await screen.findByText('Total')).toBeTruthy();
    expect(xlsxApi.read).toHaveBeenCalledWith('AA==', { type: 'base64' });
  });

  it('AdminPage loads users, approves a pending user, and toggles settings', async () => {
    const view = render(<AdminPage onBack={vi.fn()} />);

    expect(await screen.findByText('newbie')).toBeTruthy();
    const scrollContainer = screen.getByTestId('admin-page-scroll');
    expect(scrollContainer.style.height).toBe('100%');
    expect(scrollContainer.style.flex).toBe('1 1 auto');
    expect(scrollContainer.style.overflowY).toBe('auto');
    expect(scrollContainer.style.overscrollBehaviorY).toBe('contain');
    expect(scrollContainer.style.touchAction).toBe('pan-y');
    expect(scrollContainer.style.boxSizing).toBe('border-box');

    fireEvent.click(screen.getByRole('button', { name: 'admin.filter_pending (1)' }));
    expect(screen.getByText('newbie')).toBeTruthy();
    expect(screen.queryByText('ada')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'admin.filter_all (2)' }));
    fireEvent.input(screen.getByPlaceholderText('admin.search_placeholder'), { target: { value: 'ada' } });
    expect(screen.getByText('ada')).toBeTruthy();
    expect(screen.queryByText('newbie')).toBeNull();
    fireEvent.input(screen.getByPlaceholderText('admin.search_placeholder'), { target: { value: '' } });

    fireEvent.click(screen.getByText('admin.approve'));
    await waitFor(() => expect(adminApi.approveUser).toHaveBeenCalledWith('u-pending'));

    await screen.findByText('admin.registration_enabled');
    const toggleButtons = Array.from(view.container.querySelectorAll('button')).filter((button) => button.textContent === '');
    expect(toggleButtons.length).toBeGreaterThan(0);
    fireEvent.click(toggleButtons[0]);
    await waitFor(() => expect(adminApi.updateAdminSettings).toHaveBeenCalledWith({ registration_enabled: 'false' }));
  });

  it('AdminPage paginates filtered users and resets pagination when searching', async () => {
    adminApi.fetchAdminUsers.mockResolvedValue(Array.from({ length: 22 }, (_, index) => ({
      id: `user-${index + 1}`,
      username: `user-${String(index + 1).padStart(2, '0')}`,
      displayName: `User ${index + 1}`,
      status: index === 21 ? 'pending' : 'active',
      isAdmin: false,
      createdAt: 1778460000000 + index,
    })));
    render(<AdminPage onBack={vi.fn()} />);

    expect(await screen.findByText('user-01')).toBeTruthy();
    expect(screen.queryByText('user-21')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'admin.next_page' }));
    expect(screen.getByText('user-21')).toBeTruthy();
    expect(screen.queryByText('user-01')).toBeNull();

    fireEvent.input(screen.getByPlaceholderText('admin.search_placeholder'), { target: { value: 'user-01' } });
    expect(screen.getByText('user-01')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'admin.previous_page' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('DashboardPage shows authorized shared resources instead of device onboarding when no server is owned', async () => {
    const sharedEntry = {
      id: 'share-dashboard',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'viewer' as const,
      status: 'active' as const,
      target: { kind: 'main' as const, serverId: 'srv-shared', sessionName: 'deck_shared_brain' },
      targetLabel: 'Shared Conversation',
    };
    const onOpenSharedEntry = vi.fn();
    const props = {
      onSelectServer: vi.fn(),
      onLogout: vi.fn(),
      onOpenUsageSummary: vi.fn(),
      sharedEntries: [sharedEntry],
      sharedEntriesLoading: false,
      sharedEntriesLoaded: true,
      sharedEntriesError: null,
      openingSharedEntryId: null,
      onOpenSharedEntry,
      onRefreshSharedEntries: vi.fn(),
    };
    const view = render(<DashboardPage {...props} />);

    expect(await screen.findByText('Shared Conversation')).toBeTruthy();
    expect(screen.queryByText('Connect a Device')).toBeNull();
    fireEvent.click(screen.getByText('Shared Conversation'));
    expect(onOpenSharedEntry).toHaveBeenCalledWith(sharedEntry);

    view.rerender(<DashboardPage {...props} sharedEntries={[]} />);
    expect(await screen.findByText('Connect a Device')).toBeTruthy();
  });
});
