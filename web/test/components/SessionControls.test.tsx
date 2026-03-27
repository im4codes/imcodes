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
}));

const uploadFileMock = vi.fn();
vi.mock('../../src/api.js', () => ({
  uploadFile: (...args: unknown[]) => uploadFileMock(...args),
  getUserPref: vi.fn().mockResolvedValue(null),
  saveUserPref: vi.fn().mockResolvedValue(undefined),
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

  it('stop action appears in menu and calls ws.sendSessionCommand after two clicks', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session', project: 'my-project' })} quickData={makeQuickData() as any} />);
    // Open the ⋯ menu
    fireEvent.click(screen.getByTitle('actions'));
    // Click stop once (triggers confirm mode — button text changes to confirm_stop)
    const stopBtn = screen.getByRole('button', { name: /stop/i });
    fireEvent.click(stopBtn);
    // Click the now-confirmed stop button again
    const confirmBtn = screen.getByRole('button', { name: /stop/i });
    fireEvent.click(confirmBtn);
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('stop', { project: 'my-project' });
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

  it('pressing Shift+Enter does not submit', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'multiline';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
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

  it('does not send immediately after selecting agent and mode; sends after further editing', () => {
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

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    input.textContent = `${input.textContent}please review`;
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      sessionName: 'deck_my-project_brain',
      text: 'please review',
      p2pAtTargets: [{ session: 'deck_sub_w1', mode: 'audit' }],
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

    // Input shows short @@label (double-@ = P2P, single-@ = file ref)
    expect(input.textContent).toBe('@@worker-alpha ');
    getSelectionSpy.mockRestore();
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

  describe('attachment badges', () => {
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
  });
});
