/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { SessionControls } from '../../src/components/SessionControls.js';
import type { SessionInfo } from '../../src/types.js';

const fetchSupervisorDefaultsMock = vi.fn().mockResolvedValue(null);
const patchSessionSupervisionMock = vi.fn().mockResolvedValue(null);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string) => {
      if (key === 'session.supervision.quickLabel') return 'Auto';
      if (key === 'session.supervision.quickTitle') return 'Auto mode';
      if (key === 'session.settings') return 'Settings';
      if (key === 'session.actions') return 'Actions';
      return key.split('.').at(-1) ?? key;
    },
  }),
}));

vi.mock('../../src/api.js', () => ({
  deleteAttachment: vi.fn().mockResolvedValue(undefined),
  fetchSessionSupervisorDefaults: (...args: unknown[]) => fetchSupervisorDefaultsMock(...args),
  fetchSupervisorDefaults: (...args: unknown[]) => fetchSupervisorDefaultsMock(...args),
  getUserPref: vi.fn().mockResolvedValue(null),
  onUserPrefChanged: vi.fn(() => () => {}),
  patchSession: vi.fn().mockResolvedValue(undefined),
  patchSessionSupervision: (...args: unknown[]) => patchSessionSupervisionMock(...args),
  patchSubSession: vi.fn().mockResolvedValue(undefined),
  saveSessionSupervisorDefaults: vi.fn(async (_serverId: string, _sessionName: string, value: unknown) => value),
  saveUserPref: vi.fn().mockResolvedValue(undefined),
  sendSessionViaHttp: vi.fn().mockResolvedValue(undefined),
  uploadFile: vi.fn(),
}));

vi.mock('../../src/components/VoiceInput.js', () => ({
  isAvailable: () => false,
}));

const quickData = {
  data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  loaded: true,
  recordHistory: vi.fn(),
  addCommand: vi.fn(),
  addPhrase: vi.fn(),
  removeCommand: vi.fn(),
  removePhrase: vi.fn(),
  removeHistory: vi.fn(),
  removeSessionHistory: vi.fn(),
  clearHistory: vi.fn(),
  clearSessionHistory: vi.fn(),
};

function makeWs() {
  return {
    connected: true,
    send: vi.fn(),
    sendSessionCommand: vi.fn(),
    sendSessionCommandUrgent: vi.fn(),
    sendSessionMessage: vi.fn(),
    sendInput: vi.fn(),
    requestSessionList: vi.fn(),
    subscribeTransportSession: vi.fn(),
    unsubscribeTransportSession: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    onDaemonCapabilitySnapshot: vi.fn(() => () => {}),
    getDaemonCapabilitySnapshot: vi.fn(() => null),
    isDaemonCapabilityStale: vi.fn(() => false),
  };
}

function sharedSession(role: 'participant' | 'viewer'): SessionInfo {
  return {
    name: 'deck_shared_brain',
    project: 'shared-project',
    role: 'brain',
    agentType: 'codex-sdk',
    runtimeType: 'transport',
    state: 'idle',
    supervisionMode: 'supervised_audit',
    sharedState: { effectiveRole: role, status: 'active' },
  } as SessionInfo;
}

function renderControls(role: 'participant' | 'viewer', onSettings: () => void) {
  return render(
    <SessionControls
      ws={makeWs() as never}
      connected
      serverId="server-shared"
      activeSession={sharedSession(role)}
      quickData={quickData}
      onSettings={onSettings}
    />,
  );
}

describe('SessionControls shared participant settings entry points', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSupervisorDefaultsMock.mockResolvedValue(null);
    patchSessionSupervisionMock.mockResolvedValue(null);
  });

  afterEach(() => cleanup());

  it('opens the owner settings surface from the Auto dropdown for an active participant', () => {
    const onSettings = vi.fn();
    renderControls('participant', onSettings);

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    const autoMenu = document.querySelector('.menu-dropdown-auto') as HTMLElement;
    const settings = within(autoMenu).getByRole('button', { name: 'Settings' });
    fireEvent.click(settings);

    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it('renders the owner-authoritative audit mode but keeps every quick mode choice read-only', () => {
    renderControls('participant', vi.fn());

    const auto = screen.getByRole('button', { name: 'Auto' });
    expect(auto.textContent).toContain('quickAuditLabel');
    fireEvent.click(auto);

    const menu = document.querySelector('.menu-dropdown-auto') as HTMLElement;
    const options = within(menu).getAllByRole('button').filter((button) => button.textContent !== 'Settings');
    expect(options).toHaveLength(3);
    for (const option of options) {
      expect((option as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(option);
    }
    expect(patchSessionSupervisionMock).not.toHaveBeenCalled();
  });

  it('opens the same settings surface from the session action menu for an active participant', () => {
    const onSettings = vi.fn();
    renderControls('participant', onSettings);

    fireEvent.click(screen.getByTitle('Actions'));
    const actionMenu = document.querySelector('.session-actions-menu') as HTMLElement;
    const settings = within(actionMenu).getByRole('button', { name: 'Settings' });
    fireEvent.click(settings);

    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it('removes both settings entries when an open participant surface is downgraded to viewer', () => {
    const onSettings = vi.fn();
    const view = renderControls('participant', onSettings);

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(within(document.querySelector('.menu-dropdown-auto') as HTMLElement)
      .getByRole('button', { name: 'Settings' })).toBeDefined();
    view.rerender(
      <SessionControls
        ws={makeWs() as never}
        connected
        serverId="server-shared"
        activeSession={sharedSession('viewer')}
        quickData={quickData}
        onSettings={onSettings}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();

    view.rerender(
      <SessionControls
        ws={makeWs() as never}
        connected
        serverId="server-shared"
        activeSession={sharedSession('participant')}
        quickData={quickData}
        onSettings={onSettings}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    fireEvent.click(screen.getByTitle('Actions'));
    expect(within(document.querySelector('.session-actions-menu') as HTMLElement)
      .getByRole('button', { name: 'Settings' })).toBeDefined();

    view.rerender(
      <SessionControls
        ws={makeWs() as never}
        connected
        serverId="server-shared"
        activeSession={sharedSession('viewer')}
        quickData={quickData}
        onSettings={onSettings}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(onSettings).not.toHaveBeenCalled();
  });
});
