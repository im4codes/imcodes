/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, _opts?: Record<string, unknown>) => {
      const parts = key.split('.');
      return parts[parts.length - 1];
    },
  }),
}));

vi.mock('../../src/components/QuickInputPanel.js', () => ({
  QuickInputPanel: () => null,
  EMPTY_QUICK_DATA: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  getNavigableHistory: (data: { history: string[]; sessionHistory: Record<string, string[]> }, sessionName?: string) => {
    if (!sessionName) return data.history;
    const sessionHist = data.sessionHistory[sessionName] ?? [];
    return sessionHist.length > 0 ? sessionHist : data.history;
  },
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

const makeWs = () => ({
  sendSessionCommand: vi.fn(),
  sendInput: vi.fn(),
  connected: true,
  subSessionSetModel: vi.fn(),
  onMessage: vi.fn(() => () => {}),
});

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
    getUserPrefMock.mockResolvedValue(null);
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


  it('sends message to running transport session without blocking (queuing is daemon-side)', () => {
    const ws = makeWs();
    const runningSession = makeSession({
      name: 'qwen-session',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
    });
    render(
      <SessionControls
        ws={ws as any}
        activeSession={runningSession}
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'queued send';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    // Message is sent immediately — daemon handles queuing internally
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', {
      sessionName: 'qwen-session',
      text: 'queued send',
    });
    // No frontend queued notice — transport runtime queues internally
    expect(screen.queryByText('transport_send_queued')).toBeNull();
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
