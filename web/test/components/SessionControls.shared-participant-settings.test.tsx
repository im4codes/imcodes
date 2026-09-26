/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
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
      if (key === 'session.supervision.settingsTitle') return 'Supervision settings';
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

function sharedSession(
  role: 'participant' | 'viewer',
  targetKind: 'server' | 'main' = 'main',
  supervisionMode: 'off' | 'supervised_audit' = 'supervised_audit',
): SessionInfo {
  return {
    name: 'deck_shared_brain',
    project: 'shared-project',
    role: 'brain',
    agentType: 'codex-sdk',
    runtimeType: 'transport',
    state: 'idle',
    supervisionMode,
    sharedState: { targetKind, effectiveRole: role, status: 'active' },
  } as SessionInfo;
}

function renderControls(role: 'participant' | 'viewer', onSettings: (intent?: { surface?: string }) => void) {
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
    const settings = within(autoMenu).getByRole('button', { name: 'Supervision settings' });
    fireEvent.click(settings);

    expect(onSettings).toHaveBeenCalledWith({ surface: 'supervision' });
  });

  it('lets an active participant change the mode, because a participant drives the session', async () => {
    renderControls('participant', vi.fn());

    const auto = screen.getByRole('button', { name: 'Auto' });
    expect(auto.textContent).toContain('quickAuditLabel');
    fireEvent.click(auto);

    const menu = document.querySelector('.menu-dropdown-auto') as HTMLElement;
    const options = within(menu).getAllByRole('button').filter((button) => button.textContent !== 'Supervision settings');
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect((option as HTMLButtonElement).disabled).toBe(false);
    }

    // The projected share row contains no owner transport config. The client
    // therefore sends only the requested mode; the server merges it into the
    // existing owner-authoritative snapshot.
    fireEvent.click(options[0]!);
    await waitFor(() => expect(patchSessionSupervisionMock).toHaveBeenCalledWith(
      'server-shared',
      'deck_shared_brain',
      { mode: 'off' },
    ));
  });

  it('never offers the control to a viewer', () => {
    renderControls('viewer', vi.fn());
    expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull();
  });

  it('opens supervision settings when enabling without any owner defaults configured', async () => {
    const onSettings = vi.fn();
    render(
      <SessionControls
        ws={makeWs() as never}
        connected
        serverId="server-shared"
        activeSession={sharedSession('participant', 'main', 'off')}
        quickData={quickData}
        onSettings={onSettings}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    fireEvent.click(within(document.querySelector('.menu-dropdown-auto') as HTMLElement)
      .getByRole('button', { name: /supervised_audit/i }));

    // A participant may now author a fresh configuration, but only once the
    // owner's account-level runtime defaults are known. With none configured
    // yet (mocked null), the toggle sends the caller to Settings instead of
    // persisting a mode-only patch the server would reject as incomplete.
    await waitFor(() => expect(fetchSupervisorDefaultsMock).toHaveBeenCalledWith('server-shared', 'deck_shared_brain'));
    await waitFor(() => expect(onSettings).toHaveBeenCalledWith({ surface: 'supervision', supervisionMode: 'supervised_audit' }));
    expect(patchSessionSupervisionMock).not.toHaveBeenCalled();
  });

  it('enables audit for a share participant by authoring the owner account defaults', async () => {
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'codex-sdk',
      model: 'gpt-5.6-sol',
      timeoutMs: 30_000,
      promptVersion: 'supervision_decision_v1',
      maxAutoContinueStreak: 2,
      maxAutoContinueTotal: 0,
      executionPools: {
        state: 'configured',
        primaryDevelopmentPool: {
          configs: [{
            capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6-sol',
            agentType: 'codex-sdk',
            providerFamily: 'openai',
            runtimeType: 'transport',
            model: 'gpt-5.6-sol',
          }],
          controls: {},
        },
        economyTaskPool: { configs: [], controls: {} },
      },
    });
    render(
      <SessionControls
        ws={makeWs() as never}
        connected
        serverId="server-shared"
        activeSession={sharedSession('participant', 'main', 'off')}
        quickData={quickData}
        onSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    fireEvent.click(within(document.querySelector('.menu-dropdown-auto') as HTMLElement)
      .getByRole('button', { name: /supervised_audit/i }));

    // A participant authoring from scratch sends the full owner-default
    // runtime config the server needs to validate and persist a new snapshot
    // -- not just the bare mode the mode-only merge path used to send.
    await waitFor(() => expect(patchSessionSupervisionMock).toHaveBeenCalledWith(
      'server-shared',
      'deck_shared_brain',
      expect.objectContaining({
        mode: 'supervised_audit',
        backend: 'codex-sdk',
        model: 'gpt-5.6-sol',
      }),
    ));
  });

  it('keeps stop restricted for a session share but exposes it for a server-share participant', () => {
    const view = renderControls('participant', vi.fn());
    fireEvent.click(screen.getByTitle('Actions'));
    expect(within(document.querySelector('.session-actions-menu') as HTMLElement)
      .queryByRole('button', { name: /stop_plain/i })).toBeNull();

    view.unmount();
    const serverView = render(
      <SessionControls
        ws={makeWs() as never}
        connected
        serverId="server-shared"
        activeSession={sharedSession('participant', 'server')}
        quickData={quickData}
        onSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Actions'));
    expect(within(document.querySelector('.session-actions-menu') as HTMLElement)
      .getByRole('button', { name: /stop_plain/i })).toBeDefined();
    serverView.unmount();
  });

  it('offers independent session and supervision settings from the session action menu', () => {
    const onSettings = vi.fn();
    renderControls('participant', onSettings);

    fireEvent.click(screen.getByTitle('Actions'));
    const actionMenu = document.querySelector('.session-actions-menu') as HTMLElement;
    const settings = within(actionMenu).getByRole('button', { name: 'Settings' });
    fireEvent.click(settings);
    expect(onSettings).toHaveBeenLastCalledWith({ surface: 'session' });

    fireEvent.click(screen.getByTitle('Actions'));
    const reopenedMenu = document.querySelector('.session-actions-menu') as HTMLElement;
    fireEvent.click(within(reopenedMenu).getByRole('button', { name: 'Supervision settings' }));

    expect(onSettings).toHaveBeenLastCalledWith({ surface: 'supervision' });
    expect(onSettings).toHaveBeenCalledTimes(2);
  });

  it('keeps both independent settings entries available in the mobile action menu', () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    try {
      const onSettings = vi.fn();
      renderControls('participant', onSettings);
      fireEvent.click(screen.getByTitle('Actions'));
      const actionMenu = document.querySelector('.session-actions-menu') as HTMLElement;
      fireEvent.click(within(actionMenu).getByRole('button', { name: 'Supervision settings' }));
      expect(onSettings).toHaveBeenCalledWith({ surface: 'supervision' });
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth });
    }
  });

  it('opens the independent supervision surface from a sub-session action menu', () => {
    const onSettings = vi.fn();
    render(
      <SessionControls
        ws={makeWs() as never}
        connected
        serverId="server-shared"
        activeSession={{
          ...sharedSession('participant'),
          name: 'deck_sub_worker',
          role: 'worker',
        } as SessionInfo}
        subSessionId="sub-1"
        onSubStop={vi.fn()}
        quickData={quickData}
        onSettings={onSettings}
      />,
    );
    fireEvent.click(screen.getByTitle('Actions'));
    const actionMenu = document.querySelector('.session-actions-menu') as HTMLElement;
    fireEvent.click(within(actionMenu).getByRole('button', { name: 'Supervision settings' }));
    expect(onSettings).toHaveBeenCalledWith({ surface: 'supervision' });
  });

  it('removes both settings entries when an open participant surface is downgraded to viewer', () => {
    const onSettings = vi.fn();
    const view = renderControls('participant', onSettings);

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(within(document.querySelector('.menu-dropdown-auto') as HTMLElement)
      .getByRole('button', { name: 'Supervision settings' })).toBeDefined();
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
    expect(within(document.querySelector('.session-actions-menu') as HTMLElement)
      .getByRole('button', { name: 'Supervision settings' })).toBeDefined();

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
