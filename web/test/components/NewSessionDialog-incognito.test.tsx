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
import { __resetTimelineCacheForTests, registerIncognitoTimelineSession } from '../../src/hooks/useTimeline.js';

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

    // Supported Antigravity SDK card ('agy-sdk') stays enabled in incognito mode
    const agyButton = view.container.querySelector('[data-agent-type="agy-sdk"]') as HTMLButtonElement | null;
    if (agyButton) expect(agyButton.disabled).toBe(false);

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

  it('allows selecting pi in incognito mode and submits session.start with agentType: pi and incognito: true', async () => {
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
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    const piButton = view.container.querySelector('[data-agent-type="pi"]') as HTMLButtonElement | null;
    expect(piButton).toBeTruthy();
    expect(piButton!.disabled).toBe(false);
    fireEvent.click(piButton!);

    const projectInput = view.container.querySelector('input[placeholder="my-project"]') as HTMLInputElement;
    fireEvent.input(projectInput, { target: { value: 'pipriv' } });

    const startBtn = view.container.querySelector('.dialog-footer .btn-primary') as HTMLButtonElement;
    expect(startBtn.disabled).toBe(false);
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(wsCap.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
        project: 'pipriv',
        agentType: 'pi',
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
    __resetTimelineCacheForTests();
  });

  it('SessionControls skips auto quickData.recordHistory for incognito sends (flag or timeline registry) and records for normal sends (F1-R2)', () => {
    const makeProps = (session: Record<string, unknown>, recordHistory = vi.fn()) => {
      const ws = {
        connected: true,
        send: vi.fn(),
        sendSessionCommand: vi.fn(),
        onMessage: vi.fn(() => () => {}),
      };
      const quickData = {
        data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
        loaded: true,
        recordHistory,
        addCommand: vi.fn(),
        addPhrase: vi.fn(),
        removeCommand: vi.fn(),
        removePhrase: vi.fn(),
        removeHistory: vi.fn(),
        removeSessionHistory: vi.fn(),
        clearHistory: vi.fn(),
        clearSessionHistory: vi.fn(),
      };
      return { ws, quickData, session };
    };

    // 1. Explicitly incognito session
    const priv = makeProps({
      name: 'deck_priv_send',
      project: 'priv',
      role: 'brain',
      agentType: 'claude-code-sdk',
      state: 'idle',
      runtimeType: 'transport',
      incognito: true,
    });
    render(
      <SessionControls
        ws={priv.ws as any}
        connected={true}
        activeSession={priv.session as any}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
        quickData={priv.quickData as any}
      />,
    );
    const privInput = screen.getByRole('textbox');
    privInput.textContent = 'PRIVATE-QUICK-PROMPT';
    fireEvent.input(privInput);
    fireEvent.keyDown(privInput, { key: 'Enter' });
    expect(priv.ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      sessionName: 'deck_priv_send',
      text: 'PRIVATE-QUICK-PROMPT',
    }));
    expect(priv.quickData.recordHistory).not.toHaveBeenCalled();
    cleanup();

    // 2. Session known to be incognito in timeline state even before activeSession prop catches up
    __resetTimelineCacheForTests();
    registerIncognitoTimelineSession('srv-1', 'deck_tl_priv_send', { sessionInstanceId: 'inst-tl', runtimeEpoch: 'rt-tl' });
    const tlPriv = makeProps({
      name: 'deck_tl_priv_send',
      project: 'priv',
      role: 'brain',
      agentType: 'claude-code-sdk',
      state: 'idle',
      runtimeType: 'transport',
    });
    render(
      <SessionControls
        ws={tlPriv.ws as any}
        connected={true}
        activeSession={tlPriv.session as any}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
        quickData={tlPriv.quickData as any}
      />,
    );
    const tlInput = screen.getByRole('textbox');
    tlInput.textContent = 'TL-PRIVATE-PROMPT';
    fireEvent.input(tlInput);
    fireEvent.keyDown(tlInput, { key: 'Enter' });
    expect(tlPriv.ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      sessionName: 'deck_tl_priv_send',
      text: 'TL-PRIVATE-PROMPT',
    }));
    expect(tlPriv.quickData.recordHistory).not.toHaveBeenCalled();
    cleanup();
    __resetTimelineCacheForTests();

    // 3. Normal session control MUST continue recording history
    const norm = makeProps({
      name: 'deck_norm_send',
      project: 'norm',
      role: 'brain',
      agentType: 'claude-code-sdk',
      state: 'idle',
      runtimeType: 'transport',
    });
    render(
      <SessionControls
        ws={norm.ws as any}
        connected={true}
        activeSession={norm.session as any}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
        quickData={norm.quickData as any}
      />,
    );
    const normInput = screen.getByRole('textbox');
    normInput.textContent = 'NORMAL-QUICK-PROMPT';
    fireEvent.input(normInput);
    fireEvent.keyDown(normInput, { key: 'Enter' });
    expect(norm.ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      sessionName: 'deck_norm_send',
      text: 'NORMAL-QUICK-PROMPT',
    }));
    expect(norm.quickData.recordHistory).toHaveBeenCalledWith('NORMAL-QUICK-PROMPT', 'deck_norm_send');
  });

  it('allows codex-sdk selection in incognito mode and keeps CLI runtimes disabled', async () => {
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
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    const codexSdkBtn = view.container.querySelector('[data-agent-type="codex-sdk"]') as HTMLButtonElement | null;
    expect(codexSdkBtn).toBeTruthy();
    expect(codexSdkBtn!.disabled).toBe(false);

    const codexCliBtn = view.container.querySelector('[data-agent-type="codex"]') as HTMLButtonElement | null;
    if (codexCliBtn) expect(codexCliBtn.disabled).toBe(true);
    const claudeCliBtn = view.container.querySelector('[data-agent-type="claude-code"]') as HTMLButtonElement | null;
    if (claudeCliBtn) expect(claudeCliBtn.disabled).toBe(true);

    fireEvent.click(codexSdkBtn!);

    const projectInput = view.container.querySelector('input[placeholder="my-project"]') as HTMLInputElement;
    fireEvent.input(projectInput, { target: { value: 'privcodex' } });

    const startBtn = view.container.querySelector('.dialog-footer .btn-primary') as HTMLButtonElement;
    expect(startBtn.disabled).toBe(false);
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(wsCap.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
        project: 'privcodex',
        agentType: 'codex-sdk',
        incognito: true,
      }));
    });
    expect(saveSessionIdentityProfileMock).not.toHaveBeenCalled();
  });

  it('all 7 UI locales mention both Claude SDK and Codex SDK for incognito availability and unsupported strings', async () => {
    const locales = ['en', 'es', 'ja', 'ko', 'ru', 'zh-CN', 'zh-TW'] as const;
    for (const locale of locales) {
      const mod = await import(`../../src/i18n/locales/${locale}.json`);
      const data = mod.default as { session: { incognito_available: string; incognito_unsupported: string } };
      expect(data.session.incognito_available, `${locale}.session.incognito_available`).toMatch(/claude/i);
      expect(data.session.incognito_available, `${locale}.session.incognito_available`).toMatch(/codex/i);
      expect(data.session.incognito_unsupported, `${locale}.session.incognito_unsupported`).toMatch(/claude/i);
      expect(data.session.incognito_unsupported, `${locale}.session.incognito_unsupported`).toMatch(/codex/i);
    }
  });
});
