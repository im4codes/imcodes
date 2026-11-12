/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, fireEvent, cleanup, waitFor, screen } from '@testing-library/preact';
import { SESSION_INCOGNITO_CAPABILITY } from '../../../shared/session-incognito-types.js';
import { GIT_REMOTE_CLONE_CAPABILITY_V1 } from '../../../shared/git-remote-url.js';

const { saveSessionIdentityProfileMock } = vi.hoisted(() => ({
  saveSessionIdentityProfileMock: vi.fn(),
}));

vi.mock('../../src/api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/api.js')>(),
  fetchSessionIdentityProfile: vi.fn(async () => null),
  saveSessionIdentityProfile: (...args: unknown[]) => saveSessionIdentityProfileMock(...args),
  clearSessionIdentityProfile: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/FileBrowser.js', () => ({ FileBrowser: () => null }));
vi.mock('../../src/components/file-browser-lazy.js', () => ({ FileBrowser: () => null }));

import { NewSessionDialog } from '../../src/components/NewSessionDialog.js';
import { SessionControls } from '../../src/components/SessionControls.js';

describe('NewSessionDialog & SessionControls incognito UI contracts (F3)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    saveSessionIdentityProfileMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  function makeDialogWs(capabilities: string[] = [GIT_REMOTE_CLONE_CAPABILITY_V1, SESSION_INCOGNITO_CAPABILITY]) {
    const handlers = new Set<(msg: unknown) => void>();
    return {
      sendSessionCommand: vi.fn(),
      send: vi.fn(),
      requestSessionList: vi.fn(),
      connected: true,
      onMessage: vi.fn((h: (msg: unknown) => void) => {
        handlers.add(h);
        return () => handlers.delete(h);
      }),
      subSessionDetectShells: vi.fn(),
      getDaemonCapabilitySnapshot: vi.fn(() => ({
        daemonId: 'daemon-1',
        capabilities,
        helloEpoch: 1,
        sentAt: Date.now(),
        observedAt: Date.now(),
      })),
      isDaemonCapabilityStale: vi.fn(() => false),
    };
  }

  it('disables incognito checkbox when server lacks session.incognito capability and sends incognito:true for supported runtimes when enabled', async () => {
    // 1. Server lacks capability -> checkbox disabled, status shown
    const wsNoCap = makeDialogWs([GIT_REMOTE_CLONE_CAPABILITY_V1]);
    const viewNoCap = render(
      <NewSessionDialog
        ws={wsNoCap as any}
        serverId="srv-1"
        onClose={vi.fn()}
        onSessionStarted={vi.fn()}
      />,
    );
    const checkboxNoCap = viewNoCap.container.querySelector('.incognito-create-option input[type="checkbox"]') as HTMLInputElement;
    expect(checkboxNoCap).toBeTruthy();
    expect(checkboxNoCap.disabled).toBe(true);
    expect(viewNoCap.container.querySelector('.incognito-create-option [role="status"]')?.textContent).toBe('session.incognito_unsupported');
    cleanup();

    // 2. Server supports capability -> toggling disables unsupported process runtimes and submits session.start with incognito: true
    const wsCap = makeDialogWs([GIT_REMOTE_CLONE_CAPABILITY_V1, SESSION_INCOGNITO_CAPABILITY]);
    const view = render(
      <NewSessionDialog
        ws={wsCap as any}
        serverId="srv-1"
        onClose={vi.fn()}
        onSessionStarted={vi.fn()}
      />,
    );

    const checkbox = view.container.querySelector('.incognito-create-option input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    // Unsupported CLI process agent card ('claude-code') must be disabled in incognito mode
    const cliButton = view.container.querySelector('[data-agent-type="claude-code"]') as HTMLButtonElement | null;
    if (cliButton) expect(cliButton.disabled).toBe(true);

    const projectInput = view.container.querySelector('input[placeholder="my-project"]') as HTMLInputElement;
    fireEvent.input(projectInput, { target: { value: 'privproj' } });

    const startBtn = view.container.querySelector('.dialog-footer .btn-primary') as HTMLButtonElement;
    expect(startBtn.disabled).toBe(false);
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(wsCap.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
        project: 'privproj',
        agentType: 'claude-code-sdk',
        incognito: true,
      }));
    });
    expect(saveSessionIdentityProfileMock).not.toHaveBeenCalled();
  });

  it('SessionControls displays incognito badge and suppresses composer draft persistence in localStorage', () => {
    const ws = {
      connected: true,
      send: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    };
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
    const { container } = render(
      <SessionControls
        ws={ws as any}
        activeSession={{
          name: 'deck_priv_brain',
          project: 'priv',
          role: 'brain',
          agentType: 'claude-code-sdk',
          state: 'idle',
          incognito: true,
        }}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
        quickData={quickData as any}
        onSend={vi.fn()}
        onStopProject={vi.fn()}
        onRestartProject={vi.fn()}
        composerDraftScope="srv-1:deck_priv_brain"
      />,
    );

    const badge = container.querySelector('.incognito-session-badge');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toContain('session.incognito');

    const input = screen.getByRole('textbox');
    expect(input).toBeTruthy();
    input.textContent = 'SECRET-COMPOSER-DRAFT';
    fireEvent.input(input);

    // Must not write any rcc_draft_* entry to localStorage while incognito
    const keys = Object.keys(localStorage);
    expect(keys.some((k) => k.includes('rcc_draft'))).toBe(false);
  });
});
