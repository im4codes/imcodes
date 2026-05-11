/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { AddProject } from '../../src/pages/AddProject.js';
import { AdminPage } from '../../src/pages/AdminPage.js';
import { AutoFixControls } from '../../src/pages/AutoFixControls.js';
import { AutoFixMonitor } from '../../src/pages/AutoFixMonitor.js';
import { ProjectSettings } from '../../src/pages/ProjectSettings.js';
import { ServerSetupPage } from '../../src/pages/ServerSetupPage.js';
import { VoiceOverlay } from '../../src/components/VoiceOverlay.js';
import OfficePreview from '../../src/components/OfficePreview.js';
import type { AutoFixTaskStatus } from '../../src/types.js';

const {
  adminApi,
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
    onAudioLevel: vi.fn((handler: ((level: number) => void) | null) => {
      voiceApi.audioLevelHandler = handler;
    }),
    startListening: vi.fn(async (handler: (partial: string) => void) => {
      voiceApi.partialHandler = handler;
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
  nativeApi.getServerList.mockResolvedValue(['https://cloud.im.codes']);
  nativeApi.addServerToList.mockResolvedValue(undefined);
  nativeApi.removeServerFromList.mockResolvedValue(undefined);
  nativeApi.setServerUrl.mockResolvedValue(undefined);
  nativeApi.isNative.mockReturnValue(false);
  translate.mockClear();
  voiceApi.audioLevelHandler = null;
  voiceApi.partialHandler = null;
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
    changeSelect(screen.getAllByRole('combobox')[2], 'github');
    fireEvent.input(await screen.findByPlaceholderText('ghp_...'), { target: { value: 'ghp_token' } });
    fireEvent.input(screen.getByPlaceholderText('myorg/myrepo'), { target: { value: 'imcodes/app' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Project' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(fetch).mock.calls;
    expect(String(calls[0][0])).toBe('/api/server/srv-1/tracker/validate');
    expect(String(calls[1][0])).toBe('/api/server/srv-1/projects');
    expect(onAdded).toHaveBeenCalledWith('alpha');
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
    fireEvent.click(screen.getByText('admin.approve'));
    await waitFor(() => expect(adminApi.approveUser).toHaveBeenCalledWith('u-pending'));

    await screen.findByText('admin.registration_enabled');
    const toggleButtons = Array.from(view.container.querySelectorAll('button')).filter((button) => button.textContent === '');
    expect(toggleButtons.length).toBeGreaterThan(0);
    fireEvent.click(toggleButtons[0]);
    await waitFor(() => expect(adminApi.updateAdminSettings).toHaveBeenCalledWith({ registration_enabled: 'false' }));
  });
});
