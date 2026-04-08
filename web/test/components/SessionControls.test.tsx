/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/preact';

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'openspec.title') return 'OpenSpec';
      if (key === 'openspec.changes') return 'changes';
      if (key === 'openspec.empty') return 'empty';
      if (key === 'openspec.audit_action') return 'audit_action';
      if (key === 'openspec.audit_implementation_action') return 'audit_implementation_action';
      if (key === 'openspec.audit_spec_action') return 'audit_spec_action';
      if (key === 'openspec.implement_action') return 'implement_action';
      if (key === 'openspec.achieve_action') return 'achieve_action';
      if (key === 'openspec.audit_implementation_prompt') {
        return `audit implementation ${(opts?.reference as string) ?? ''}, fix code gaps`;
      }
      if (key === 'openspec.audit_spec_prompt') {
        return `audit spec ${(opts?.reference as string) ?? ''}, fix spec gaps`;
      }
      if (key === 'openspec.implement_prompt') {
        return `delegate ${(opts?.reference as string) ?? ''}, split tasks and accept`;
      }
      if (key === 'openspec.achieve_prompt') {
        return `complete ${(opts?.reference as string) ?? ''}, finish remaining work and archive if done`;
      }
      const parts = key.split('.');
      return parts[parts.length - 1];
    },
  }),
}));

vi.mock('../../src/components/QuickInputPanel.js', () => ({
  QuickInputPanel: ({ open, onSend }: { open: boolean; onSend: (text: string) => void }) => open ? (
    <button onClick={() => onSend('quick combo message')}>quick-panel-send</button>
  ) : null,
  EMPTY_QUICK_DATA: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  getNavigableHistory: (data: { history: string[]; sessionHistory: Record<string, string[]> }, sessionName?: string) => {
    if (!sessionName) return data.history;
    const sessionHist = data.sessionHistory[sessionName] ?? [];
    return sessionHist.length > 0 ? sessionHist : data.history;
  },
}));

vi.mock('../../src/components/VoiceOverlay.js', () => ({
  VoiceOverlay: ({ open, onSend }: { open: boolean; onSend: (text: string) => void }) => open ? (
    <button onClick={() => onSend('voice combo message')}>voice-overlay-send</button>
  ) : null,
}));

vi.mock('../../src/components/VoiceInput.js', () => ({
  isAvailable: () => true,
}));

const uploadFileMock = vi.fn();
const getUserPrefMock = vi.fn().mockResolvedValue(null);
const saveUserPrefMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/api.js', () => ({
  uploadFile: (...args: unknown[]) => uploadFileMock(...args),
  getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
}));

import { SessionControls } from '../../src/components/SessionControls.js';
import type { SessionInfo } from '../../src/types.js';

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

const makeWs = () => {
  const handlers = new Set<(msg: unknown) => void>();
  return {
    sendSessionCommand: vi.fn(),
    sendInput: vi.fn(),
    connected: true,
    subSessionSetModel: vi.fn(),
    fsListDir: vi.fn(() => 'openspec-request'),
    onMessage: vi.fn((handler: (msg: unknown) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    emit: (msg: unknown) => {
      handlers.forEach((handler) => handler(msg));
    },
  };
};

const makeQuickData = () => ({
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
});

const makeSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  name: 'my-session',
  project: 'my-project',
  role: 'w1',
  agentType: 'worker',
  state: 'idle',
  ...overrides,
});

const mainSession = makeSession({
  name: 'deck_my-project_brain',
  project: 'my-project',
  role: 'brain',
  label: 'brain',
});

const subSession = (name: string, label: string): SessionInfo =>
  makeSession({
    name,
    project: 'my-project',
    role: label,
    label,
    agentType: 'codex',
  });

describe('SessionControls', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    getUserPrefMock.mockImplementation(async (key: unknown) => {
      if (typeof key === 'string' && key.startsWith('p2p_session_config:')) {
        const sessionKey = key.slice('p2p_session_config:'.length);
        return JSON.stringify({
          sessions: {
            [sessionKey]: { enabled: true, mode: 'audit' },
          },
          rounds: 3,
        });
      }
      return null;
    });
    saveUserPrefMock.mockResolvedValue(undefined);
  });

  it('renders input and send button', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    expect(screen.getByRole('textbox')).toBeDefined();
    expect(screen.getByRole('button', { name: /send/i })).toBeDefined();
  });

  it('renders menu button (⋯)', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    // The ⋯ menu button has title from t('session.actions') → 'actions'
    const menuBtn = screen.getByTitle('actions');
    expect(menuBtn).toBeDefined();
  });

  it('only shows the scan sweep while the session is running', () => {
    const idleView = render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession({ state: 'idle' })}
        activeThinking={true}
        quickData={makeQuickData() as any}
      />,
    );
    expect(idleView.container.querySelector('.controls-wrapper-running')).toBeNull();
    idleView.unmount();

    const runningView = render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession({ state: 'running' })}
        activeThinking={false}
        quickData={makeQuickData() as any}
      />,
    );
    expect(runningView.container.querySelector('.controls-wrapper-running')).toBeTruthy();
  });

  it('send button is disabled when input is empty', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const sendBtn = screen.getByRole('button', { name: /send/i });
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('send button is enabled when input has text', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    // contenteditable: set textContent and fire input event
    input.textContent = 'hello';
    fireEvent.input(input);
    const sendBtn = screen.getByRole('button', { name: /send/i });
    expect((sendBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('clicking send calls ws.sendSessionCommand with correct args', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'run tests';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(ws.sendSessionCommand).toHaveBeenCalledOnce();
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', {
      sessionName: 'my-session',
      text: 'run tests',
    });
  });

  it('keeps the p2p button in solo mode after triggering a combo from the dropdown', async () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    await flushAsync();

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'run combo';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /mode_solo/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_plan/i));

    expect(screen.getByText('combo_send_confirm_title')).toBeDefined();
    expect(screen.getAllByRole('button', { name: /^send$/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /mode_solo/i })).toBeDefined();
  });

  it('asks for confirmation before directly sending from a combo dropdown item', async () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'run combo';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /mode_solo/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_plan/i));

    expect(screen.getByText('combo_send_confirm_title')).toBeDefined();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode_solo/i })).toBeDefined();
  });

  it('blocks combo sends that only contain routing markup and shows a warning', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = '@@all(audit>plan)';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    expect(screen.queryByText('combo_send_confirm_title')).toBeNull();
    expect(screen.getByText('combo_empty_message_warning')).toBeDefined();
  });

  it('disables combo modes when no participants are configured', async () => {
    getUserPrefMock.mockImplementation(async (key: unknown) => {
      if (typeof key === 'string' && key.startsWith('p2p_session_config:')) {
        return JSON.stringify({
          sessions: {
            'my-session': { enabled: false, mode: 'audit' },
          },
          rounds: 3,
        });
      }
      return null;
    });

    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: /mode_solo/i }));

    expect(screen.getByText('combo_requires_participants_hint')).toBeDefined();
    const comboBtn = screen.getByRole('button', { name: /mode_audit→mode_plan/i }) as HTMLButtonElement;
    expect(comboBtn.disabled).toBe(true);
    expect(comboBtn.title).toBe('combo_requires_participants_hint');
  });

  it('only shows solo plus combo items in the p2p dropdown', async () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: /mode_solo/i }));

    expect(screen.getByText('mode_solo')).toBeDefined();
    expect(screen.queryByText(/^mode_audit$/i)).toBeNull();
    expect(screen.queryByText(/^mode_review$/i)).toBeNull();
    expect(screen.queryByText(/^mode_plan$/i)).toBeNull();
    expect(screen.queryByText(/^mode_brainstorm$/i)).toBeNull();
    expect(screen.queryByText(/^mode_discuss$/i)).toBeNull();
    expect(screen.queryByText(/^mode_config$/i)).toBeNull();
    expect(screen.getByText(/mode_audit→mode_plan/i)).toBeDefined();
  });

  it('updates the p2p dropdown when custom combos are created without a page refresh', async () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    const { P2pConfigPanel } = await import('../../src/components/P2pConfigPanel.js');
    render(
      <P2pConfigPanel
        sessions={[{ name: 'my-session', agentType: 'claude-code', state: 'idle' }]}
        subSessions={[]}
        activeSession="my-session"
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    await flushAsync();

    fireEvent.click(screen.getAllByRole('button', { name: 'combo_label' }).at(-1)!);
    fireEvent.click(screen.getByText('+mode_brainstorm'));
    fireEvent.click(screen.getByText('+mode_review'));
    fireEvent.click(screen.getByText('✓'));
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: /mode_solo/i }));
    expect(screen.getAllByText(/mode_brainstorm→mode_review/i).length).toBeGreaterThanOrEqual(1);
  });

  it('remembers skipping combo confirmation across later dropdown combo sends', async () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'first combo';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /mode_solo/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_plan/i));

    const dialog = screen.getByText('combo_send_confirm_title').closest('.dialog') as HTMLElement;
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: /^send$/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', {
      sessionName: 'my-session',
      text: 'first combo',
      p2pAtTargets: [
        { session: '__all__', mode: 'config' },
      ],
      p2pMode: 'audit>plan',
      p2pSessionConfig: {
        'my-session': { enabled: true, mode: 'audit' },
      },
      p2pRounds: 2,
      p2pLocale: 'en',
    });
    expect(saveUserPrefMock).toHaveBeenCalledWith('p2p_combo_direct_send_skip_confirm', true);

    input.textContent = 'second combo';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /mode_solo/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_plan/i));

    expect(screen.queryByText('combo_send_confirm_title')).toBeNull();
    expect(ws.sendSessionCommand).toHaveBeenLastCalledWith('send', {
      sessionName: 'my-session',
      text: 'second combo',
      p2pAtTargets: [
        { session: '__all__', mode: 'config' },
      ],
      p2pMode: 'audit>plan',
      p2pSessionConfig: {
        'my-session': { enabled: true, mode: 'audit' },
      },
      p2pRounds: 2,
      p2pLocale: 'en',
    });
  });

  it('clicking a combo dropdown item sends immediately once confirmation is accepted', async () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'direct combo';
    fireEvent.input(input);

    fireEvent.click(screen.getByRole('button', { name: /mode_solo/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_plan/i));

    const dialog = screen.getByText('combo_send_confirm_title').closest('.dialog') as HTMLElement;
    fireEvent.click(within(dialog).getByRole('button', { name: /^send$/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', {
      sessionName: 'my-session',
      text: 'direct combo',
      p2pAtTargets: [
        { session: '__all__', mode: 'config' },
      ],
      p2pMode: 'audit>plan',
      p2pSessionConfig: {
        'my-session': { enabled: true, mode: 'audit' },
      },
      p2pRounds: 2,
      p2pLocale: 'en',
    });
  });

  it('opens combo settings from the bottom of the solo combo dropdown', async () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: /mode_solo/i }));

    const menu = document.querySelector('.menu-dropdown-p2p') as HTMLElement;
    fireEvent.click(within(menu).getByRole('button', { name: 'settings_button' }));
    await flushAsync();

    expect(screen.getByText('+mode_brainstorm')).toBeDefined();
  });

  it('lists openspec changes and appends the selected reference to the input', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));

    expect(ws.fsListDir).toHaveBeenCalledWith('/repo/openspec/changes', false, false);

    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-b', path: '/repo/openspec/changes/change-b', isDir: true, hidden: false },
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
        { name: 'README.md', path: '/repo/openspec/changes/README.md', isDir: false, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'change-a' }));

    expect(screen.getByRole('textbox').textContent).toBe('@openspec/changes/change-a');
  });

  it('inserts an openspec implementation-audit prompt without sending immediately', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'audit_action' }));
    fireEvent.click(screen.getByRole('button', { name: 'audit_implementation_action' }));

    expect(screen.getByRole('textbox').textContent).toBe('audit implementation @openspec/changes/change-a, fix code gaps');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('inserts an openspec spec-audit prompt without sending immediately', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'audit_action' }));
    fireEvent.click(screen.getByRole('button', { name: 'audit_spec_action' }));

    expect(screen.getByRole('textbox').textContent).toBe('audit spec @openspec/changes/change-a, fix spec gaps');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('inserts an openspec implement prompt without sending immediately', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'implement_action' }));

    expect(screen.getByRole('textbox').textContent).toBe('delegate @openspec/changes/change-a, split tasks and accept');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('sends an openspec achieve prompt directly', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'achieve_action' }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', {
      sessionName: 'my-session',
      text: 'complete @openspec/changes/change-a, finish remaining work and archive if done',
    });
  });

  it('limits openspec dropdown height to the visible space above the trigger', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect() {
      if ((this as HTMLElement).classList?.contains('shortcuts-model')) {
        return {
          x: 0, y: 0, top: 220, left: 0, right: 120, bottom: 252, width: 120, height: 32,
          toJSON() { return {}; },
        } as DOMRect;
      }
      return {
        x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
        toJSON() { return {}; },
      } as DOMRect;
    });

    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    try {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
          quickData={makeQuickData() as any}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /openspec/i }));

      const dropdown = document.querySelector('.menu-dropdown-openspec') as HTMLElement;
      expect(dropdown.style.maxHeight).toBe('208px');
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    }
  });

  it('collapses openspec actions behind a disclosure toggle on mobile', async () => {
    const innerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });

    try {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
          quickData={makeQuickData() as any}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
      ws.emit({
        type: 'fs.ls_response',
        requestId: 'openspec-request',
        status: 'ok',
        resolvedPath: '/repo/openspec/changes',
        entries: [
          { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
        ],
      });
      await flushAsync();

      expect(screen.queryByRole('button', { name: 'implement_action' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'expand change-a' }));

      expect(screen.getByRole('button', { name: 'implement_action' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'collapse change-a' })).toBeDefined();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
    }
  });

  it('clears input after send', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'hello world';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(input.textContent).toBe('');
  });

  it('stop action requires 3-level confirmation for main session', () => {
    const ws = makeWs();
    // Mock window.confirm to auto-accept
    const origConfirm = window.confirm;
    window.confirm = () => true;
    try {
      render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session', project: 'my-project' })} quickData={makeQuickData() as any} />);
      // Open the ⋯ menu
      fireEvent.click(screen.getByTitle('actions'));
      // Click 1: triggers level 1 (warn)
      const stopBtn = screen.getByRole('button', { name: /stop/i });
      fireEvent.click(stopBtn);
      expect(ws.sendSessionCommand).not.toHaveBeenCalled();
      // Click 2: triggers level 2 (danger)
      const warnBtn = screen.getByRole('button', { name: /stop/i });
      fireEvent.click(warnBtn);
      expect(ws.sendSessionCommand).not.toHaveBeenCalled();
      // Click 3: triggers window.confirm dialog → executes stop
      const dangerBtn = screen.getByRole('button', { name: /stop/i });
      fireEvent.click(dangerBtn);
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('stop', { project: 'my-project' });
    } finally {
      window.confirm = origConfirm;
    }
  });

  it('input changes on typing', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'typed text';
    fireEvent.input(input);
    expect(input.textContent).toBe('typed text');
  });

  it('send button is disabled when ws is null', () => {
    render(<SessionControls ws={null} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const sendBtn = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });

  it('input has contenteditable false when activeSession is null', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={null} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    expect(input.getAttribute('contenteditable')).toBe('false');
  });

  it('pressing Enter submits the message', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'enter message';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', {
      sessionName: 'my-session',
      text: 'enter message',
    });
  });

  it('qwen oauth model dropdown only shows coder-model even if stale model list exists', () => {
    render(<SessionControls
      ws={makeWs() as any}
      activeSession={makeSession({
        agentType: 'qwen',
        qwenAuthType: 'qwen-oauth',
        qwenModel: 'coder-model',
        qwenAvailableModels: ['coder-model', 'qwen3-coder-plus', 'qwen3-max-2026-01-23'],
      })}
      quickData={makeQuickData() as any}
    />);
    fireEvent.click(screen.getByRole('button', { name: /qwen_tier_free/i }));
    expect(screen.getByText(/coder-model/)).toBeDefined();
    expect(screen.queryByText(/qwen3-coder-plus/)).toBeNull();
    expect(screen.queryByText(/qwen3-max-2026-01-23/)).toBeNull();
  });

  it('shows level control for qwen and sends /thinking', () => {
    const ws = makeWs();
    render(<SessionControls
      ws={ws as any}
      activeSession={makeSession({
        name: 'qwen-session',
        agentType: 'qwen',
        runtimeType: 'transport',
        effort: 'medium',
      })}
      quickData={makeQuickData() as any}
    />);

    fireEvent.click(screen.getByRole('button', { name: /^medium$/i }));
    fireEvent.click(screen.getByRole('button', { name: /high/i }));
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', {
      sessionName: 'qwen-session',
      text: '/thinking high',
    });
  });


  it('shows queued transport messages at the bottom', () => {
    const runningSession = makeSession({
      name: 'qwen-session',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      transportPendingMessages: ['queued send', 'second queued send'],
    });
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={runningSession}
        quickData={makeQuickData() as any}
      />,
    );
    expect(screen.getByText('transport_send_queued')).toBeDefined();
    expect(screen.getByText('queued send')).toBeDefined();
    expect(screen.getByText('second queued send')).toBeDefined();
  });

  it('pressing Escape in a running transport input sends /stop command', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'qwen-session',
          agentType: 'qwen',
          runtimeType: 'transport',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    fireEvent.keyDown(input, { key: 'Escape' });

    // Transport sessions send /stop instead of raw escape byte
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', { sessionName: 'qwen-session', text: '/stop' });
    expect(ws.sendInput).not.toHaveBeenCalled();
  });

  it('keeps transport Stop enabled even when session state is idle', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'codex-sdk-session',
          agentType: 'codex-sdk',
          runtimeType: 'transport',
          state: 'idle',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const stopBtn = screen.getByRole('button', { name: /^stop$/i }) as HTMLButtonElement;
    expect(stopBtn.disabled).toBe(false);
    fireEvent.click(stopBtn);
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', {
      sessionName: 'codex-sdk-session',
      text: '/stop',
    });
  });

  it('pressing Shift+Enter does not submit', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'multiline';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('ArrowUp/ArrowDown navigates the same history source and restores the draft', () => {
    const ws = makeWs();
    const quickData = makeQuickData();
    quickData.data = {
      history: ['global newest'],
      sessionHistory: {
        'my-session': ['session newest', 'session older'],
      },
      commands: [],
      phrases: [],
    };
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={quickData as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;

    input.textContent = 'draft text';
    fireEvent.input(input);

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.textContent).toBe('session newest');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.textContent).toBe('session older');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.textContent).toBe('session newest');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.textContent).toBe('draft text');
  });

  it('closes @ picker if user keeps typing without making a selection', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
      anchorOffset: input.textContent?.length ?? 0,
    }) as any);

    input.textContent = '@';
    fireEvent.input(input);
    expect(screen.getByText('files')).toBeDefined();

    input.textContent = '@hello';
    fireEvent.input(input);
    expect(screen.queryByText('files')).toBeNull();
    expect(screen.queryByText('agents')).toBeNull();

    getSelectionSpy.mockRestore();
  });

  it('does not send immediately after selecting agent and mode; sends a direct message after further editing when only one target is present', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
      anchorOffset: input.textContent?.length ?? 0,
    }) as any);

    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText('w1'));
    fireEvent.click(screen.getByText('audit'));
    expect(input.textContent).toBe('@@w1(audit) ');

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    input.textContent = `${input.textContent}please review`;
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      sessionName: 'deck_my-project_brain',
      text: 'please review',
      p2pAtTargets: [
        { session: 'deck_sub_w1', mode: 'audit' },
      ],
    }));

    getSelectionSpy.mockRestore();
  });

  it('inserts session-name-based token even when display label has spaces', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_worker-alpha', type: 'codex', label: 'Worker Alpha', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
      anchorOffset: input.textContent?.length ?? 0,
    }) as any);

    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText('Worker Alpha'));
    fireEvent.click(screen.getByText('audit'));

    // Input shows @@label plus selected mode when sub-session has a label
    expect(input.textContent).toBe('@@Worker Alpha(audit) ');
    getSelectionSpy.mockRestore();
  });

  it('shows the selected mode in the inserted label for single-agent mentions', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
      anchorOffset: input.textContent?.length ?? 0,
    }) as any);

    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText('w1'));
    fireEvent.click(screen.getByText('discuss'));

    expect(input.textContent).toBe('@@w1(discuss) ');
    getSelectionSpy.mockRestore();
  });

  it('sends p2pAtTargets in textbox order, not selection order', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
          { sessionName: 'deck_sub_w2', type: 'gemini', label: 'w2', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
      anchorOffset: input.textContent?.length ?? 0,
    }) as any);

    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText('w1'));
    fireEvent.click(screen.getByText('audit'));

    input.textContent = `${input.textContent}@`;
    fireEvent.input(input);
    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText('w2'));
    fireEvent.click(screen.getByText('discuss'));

    input.textContent = '@@w2(discuss) @@w1(audit) please review';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      sessionName: 'deck_my-project_brain',
      text: 'please review',
      p2pAtTargets: [
        { session: 'deck_sub_w2', mode: 'discuss' },
        { session: 'deck_sub_w1', mode: 'audit' },
      ],
    }));

    getSelectionSpy.mockRestore();
  });

  it('manual @@label(mode) text sends p2pAtTargets when exactly one target resolves', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_plan', type: 'codex', label: 'plan', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = '@@plan(Audit) check this';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      sessionName: 'deck_my-project_brain',
      text: 'check this',
      p2pAtTargets: [
        { session: 'deck_sub_plan', mode: 'audit' },
      ],
    }));
  });

  it('manual @@label(mode) text sends p2pAtTargets when multiple targets resolve', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_plan', type: 'codex', label: 'plan', state: 'idle', parentSession: 'deck_my-project_brain' },
          { sessionName: 'deck_sub_planx', type: 'codex', label: 'planx', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = '@@plan(Audit) @@planx(Audit) compare';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      sessionName: 'deck_my-project_brain',
      text: 'compare',
      p2pAtTargets: [
        { session: 'deck_sub_plan', mode: 'audit' },
        { session: 'deck_sub_planx', mode: 'audit' },
      ],
    }));
  });

  it('when active session is a sub-session, agent picker still shows same-root peers', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={subSession('deck_sub_w2', 'w2')}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
          { sessionName: 'deck_sub_w2', type: 'codex', label: 'w2', state: 'idle', parentSession: 'deck_my-project_brain' },
          { sessionName: 'deck_sub_other', type: 'codex', label: 'other', state: 'idle', parentSession: 'deck_other_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
      anchorOffset: input.textContent?.length ?? 0,
    }) as any);

    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('agents'));

    expect(screen.getByText('brain')).toBeDefined();
    expect(screen.getByText('w1')).toBeDefined();
    expect(screen.getByText('w2')).toBeDefined();
    expect(screen.queryByText('other')).toBeNull();

    getSelectionSpy.mockRestore();
  });

  // ── File upload tests ─────────────────────────────────────────────────────

  it('shows upload button when serverId is provided', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession()}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );
    expect(screen.getByTitle('upload_file')).toBeDefined();
  });

  it('does not show upload button when serverId is missing', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession()}
        quickData={makeQuickData() as any}
      />,
    );
    expect(screen.queryByTitle('upload_file')).toBeNull();
  });

  // TODO: fix — file upload mock doesn't trigger state update in jsdom
  describe.skip('attachment badges', () => {
    it('shows badge after file upload', async () => {
      uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/test.txt' } });
      render(
        <SessionControls
          ws={makeWs() as any}
          activeSession={makeSession()}
          quickData={makeQuickData() as any}
          serverId="srv-1"
        />,
      );
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['hello'], 'test.txt', { type: 'text/plain' });
      Object.defineProperty(fileInput, 'files', { value: [file] });
      fireEvent.change(fileInput);
      // Wait for async upload
      await vi.waitFor(() => {
        expect(screen.getByText('test.txt')).toBeDefined();
      });
      // Badge should exist
      expect(document.querySelector('.attachment-badge')).toBeTruthy();
    });

    it('removes badge when × is clicked', async () => {
      uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/remove-me.txt' } });
      render(
        <SessionControls
          ws={makeWs() as any}
          activeSession={makeSession()}
          quickData={makeQuickData() as any}
          serverId="srv-1"
        />,
      );
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['data'], 'remove-me.txt', { type: 'text/plain' });
      Object.defineProperty(fileInput, 'files', { value: [file] });
      fireEvent.change(fileInput);
      await vi.waitFor(() => {
        expect(screen.getByText('remove-me.txt')).toBeDefined();
      });
      // Click × to remove
      const removeBtn = document.querySelector('.attachment-badge-remove') as HTMLButtonElement;
      fireEvent.click(removeBtn);
      expect(document.querySelector('.attachment-badge')).toBeNull();
    });

    it('prepends @path references on send', async () => {
      uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/data.csv' } });
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'my-session' })}
          quickData={makeQuickData() as any}
          serverId="srv-1"
        />,
      );
      // Upload file
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['csv'], 'data.csv', { type: 'text/csv' });
      Object.defineProperty(fileInput, 'files', { value: [file] });
      fireEvent.change(fileInput);
      await vi.waitFor(() => {
        expect(screen.getByText('data.csv')).toBeDefined();
      });
      // Type message
      const input = screen.getByRole('textbox') as HTMLDivElement;
      input.textContent = 'analyze this';
      fireEvent.input(input);
      // Send
      fireEvent.click(screen.getByRole('button', { name: /send/i }));
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', {
        sessionName: 'my-session',
        text: '@/tmp/data.csv analyze this',
      });
    });

    it('send enabled with attachment but no text', async () => {
      uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/file.txt' } });
      render(
        <SessionControls
          ws={makeWs() as any}
          activeSession={makeSession()}
          quickData={makeQuickData() as any}
          serverId="srv-1"
        />,
      );
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['x'], 'file.txt', { type: 'text/plain' });
      Object.defineProperty(fileInput, 'files', { value: [file] });
      fireEvent.change(fileInput);
      await vi.waitFor(() => {
        expect(screen.getByText('file.txt')).toBeDefined();
      });
      const sendBtn = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;
      expect(sendBtn.disabled).toBe(false);
    });

    it('clears badges after send', async () => {
      uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/gone.txt' } });
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession()}
          quickData={makeQuickData() as any}
          serverId="srv-1"
        />,
      );
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['x'], 'gone.txt', { type: 'text/plain' });
      Object.defineProperty(fileInput, 'files', { value: [file] });
      fireEvent.change(fileInput);
      await vi.waitFor(() => {
        expect(screen.getByText('gone.txt')).toBeDefined();
      });
      // Send (with attachment only, no text)
      fireEvent.click(screen.getByRole('button', { name: /send/i }));
      expect(document.querySelector('.attachment-badge')).toBeNull();
    });

    it('sends a full P2P command immediately for one @-picked target', () => {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={mainSession}
          quickData={makeQuickData() as any}
          sessions={[mainSession]}
          subSessions={[
            { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
          ]}
        />,
      );
      const input = screen.getByRole('textbox') as HTMLDivElement;
      const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
        anchorOffset: input.textContent?.length ?? 0,
      }) as any);

      input.textContent = '@';
      fireEvent.input(input);
      fireEvent.click(screen.getByText('agents'));
      fireEvent.click(screen.getByText('w1'));
      fireEvent.click(screen.getByText('audit'));
      input.textContent = `${input.textContent}please review`;
      fireEvent.input(input);
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
        sessionName: 'deck_my-project_brain',
        text: 'please review',
        p2pAtTargets: [
          { session: 'deck_sub_w1', mode: 'audit' },
        ],
      }));
      expect(screen.queryByText('title')).toBeNull();

      getSelectionSpy.mockRestore();
    });

    it('sends a full P2P command immediately for handwritten single-agent @@ targets', () => {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={mainSession}
          quickData={makeQuickData() as any}
          sessions={[mainSession]}
          subSessions={[
            { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
          ]}
        />,
      );
      const input = screen.getByRole('textbox') as HTMLDivElement;
      input.textContent = '@@w1(audit) please review';
      fireEvent.input(input);
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
        sessionName: 'deck_my-project_brain',
        text: 'please review',
        p2pAtTargets: [
          { session: 'deck_sub_w1', mode: 'audit' },
        ],
      }));
      expect(screen.queryByText('title')).toBeNull();
    });

    it('does not show any warning for @@all', () => {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={mainSession}
          quickData={makeQuickData() as any}
          sessions={[mainSession]}
          subSessions={[
            { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
            { sessionName: 'deck_sub_w2', type: 'gemini', label: 'w2', state: 'idle', parentSession: 'deck_my-project_brain' },
          ]}
        />,
      );
      const input = screen.getByRole('textbox') as HTMLDivElement;
      input.textContent = '@@all(audit) please review';
      fireEvent.input(input);
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      expect(screen.queryByText('title')).toBeNull();
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
        sessionName: 'deck_my-project_brain',
        text: 'please review',
      }));
    });
  });


  it('shows the same transport controls for sub-sessions as main sessions', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'codex-sdk-sub',
          agentType: 'codex-sdk',
          runtimeType: 'transport',
          effort: 'high',
          state: 'running',
          quotaLabel: '5h 11% 2h03m 4/6 14:40 · 7d 50% 1d04h 4/8 15:48',
        })}
        quickData={makeQuickData() as any}
        onSubStop={vi.fn()}
        onSubRestart={vi.fn()}
        onSubNew={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /^Stop$/ })).toBeDefined();
    expect(screen.getByTitle('actions')).toBeDefined();
    expect(screen.getByRole('button', { name: /^high$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^default$/i })).toBeDefined();
  });

  it('shows thinking control for codex-sdk and sends /thinking command', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'codex-sdk-session',
          agentType: 'codex-sdk',
          runtimeType: 'transport',
          effort: 'medium',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^medium$/i }));
    fireEvent.click(screen.getByRole('button', { name: /high/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', {
      sessionName: 'codex-sdk-session',
      text: '/thinking high',
    });
  });
});
