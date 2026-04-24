/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { FILE_TRANSFER_LIMITS } from '../../../shared/transport/file-transfer.js';

const DEFAULT_INNER_WIDTH = 1280;

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
      if (key === 'openspec.propose_action') return 'propose_action';
      if (key === 'openspec.propose_from_discussion_action') return 'propose_from_discussion_action';
      if (key === 'openspec.propose_from_description_action') return 'propose_from_description_action';
      if (key === 'openspec.audit_implementation_prompt') {
        return `audit implementation ${(opts?.reference as string) ?? ''}, fix code gaps and update openspec files`;
      }
      if (key === 'openspec.audit_spec_prompt') {
        return `audit spec ${(opts?.reference as string) ?? ''}, update proposal design specs and tasks`;
      }
      if (key === 'openspec.implement_prompt') {
        return `implement ${(opts?.reference as string) ?? ''}, keep openspec artifacts aligned while coding`;
      }
      if (key === 'openspec.achieve_prompt') {
        return `complete ${(opts?.reference as string) ?? ''}, update proposal design specs tasks and archive if done`;
      }
      if (key === 'openspec.propose_from_discussion_prompt') {
        return 'generate openspec change from recent discussion and write proposal design specs tasks';
      }
      if (key === 'openspec.propose_from_description_prompt') {
        return 'generate openspec change from description below and write proposal design specs tasks';
      }
      if (key === 'session.transport_send_queued_collapsed') {
        return `${opts?.count ?? 0} queued · showing latest only`;
      }
      if (key === 'session.transport_send_queued_count') {
        return `${opts?.count ?? 0} queued`;
      }
      if (key === 'session.send_placeholder') {
        return `Send to ${String(opts?.name ?? 'session')}…`;
      }
      if (key === 'session.send_placeholder_desktop_upload') {
        return `${String(opts?.placeholder ?? '')} Supports fast multi-file paste upload`;
      }
      if (key === 'upload.long_text_attached') {
        return `Large pasted text attached as ${String(opts?.name ?? '')}`;
      }
      if (key === 'upload.file_too_large') {
        return `File too large (max ${String(opts?.max ?? '')}MB)`;
      }
      if (key === 'upload.long_text_requires_attachment') {
        return 'Paste is too large for inline input here. Upload it as a file instead.';
      }
      if (key === 'session.stop_plain') return 'Stop';
      if (key === 'session.supervision.quickLabel') return 'Auto';
      if (key === 'session.supervision.quickTitle') return 'Auto mode';
      if (key === 'session.approval.pending') return 'Approval required';
      if (key === 'session.approval.allow') return 'Allow';
      if (key === 'session.approval.deny') return 'Deny';
      if (key === 'session.approval.tool') return `${String(opts?.tool ?? 'tool')} wants approval`;
      if (key === 'common.hide') return 'hide';
      if (key === 'common.show') return 'show';
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

vi.mock('../../src/components/AtPicker.js', () => ({
  AtPicker: ({ visible, onSelectAllConfig, onSelectAgent, p2pConfig, sessions, rootSession }: {
    visible: boolean;
    onSelectAllConfig?: (config: unknown, rounds: number, modeOverride: string) => void;
    onSelectAgent?: (session: string, mode: string) => void;
    p2pConfig?: { rounds?: number } | null;
    sessions?: Array<{ name: string; label?: string | null; parentSession?: string | null; isSelf?: boolean }>;
    rootSession?: string | null;
  }) => {
    const [stage, setStage] = useState<'root' | 'agents' | { session: string }>('root');
    if (!visible) return null;
    const visibleAgents = (sessions ?? []).filter((entry) => {
      const sameRoot = (entry.parentSession ?? entry.name) === rootSession || entry.name === rootSession;
      return sameRoot;
    });
    if (stage === 'root') {
      return (
        <div>
          <button onClick={() => onSelectAllConfig?.(p2pConfig, p2pConfig?.rounds ?? 1, 'config')}>mock-select-all-config</button>
          <button>files</button>
          <button onClick={() => setStage('agents')}>agents</button>
        </div>
      );
    }
    if (stage === 'agents') {
      return (
        <div>
          {visibleAgents.map((entry) => (
            <button key={entry.name} onClick={() => setStage({ session: entry.name })}>
              {entry.label ?? entry.name}
            </button>
          ))}
        </div>
      );
    }
    return (
      <div>
        {['audit', 'discuss', 'review', 'plan', 'brainstorm'].map((mode) => (
          <button key={mode} onClick={() => onSelectAgent?.(stage.session, mode)}>{mode}</button>
        ))}
      </div>
    );
  },
}));

const uploadFileMock = vi.fn();
const execCommandMock = vi.fn(() => true);
const getUserPrefMock = vi.fn().mockResolvedValue(null);
const saveUserPrefMock = vi.fn().mockResolvedValue(undefined);
const fetchSupervisorDefaultsMock = vi.fn().mockResolvedValue(null);
const patchSessionMock = vi.fn().mockResolvedValue(undefined);
const patchSubSessionMock = vi.fn().mockResolvedValue(undefined);
const onUserPrefChangedMock = vi.fn((cb: (key: string, value: unknown) => void) => {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string; value?: unknown }>).detail;
    if (!detail?.key) return;
    cb(detail.key, detail.value);
  };
  window.addEventListener('imcodes:user-pref-changed', handler as EventListener);
  return () => window.removeEventListener('imcodes:user-pref-changed', handler as EventListener);
});
vi.mock('../../src/api.js', () => ({
  uploadFile: (...args: unknown[]) => uploadFileMock(...args),
  getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
  fetchSupervisorDefaults: (...args: unknown[]) => fetchSupervisorDefaultsMock(...args),
  patchSession: (...args: unknown[]) => patchSessionMock(...args),
  patchSubSession: (...args: unknown[]) => patchSubSessionMock(...args),
  onUserPrefChanged: (...args: unknown[]) => onUserPrefChangedMock(...args as Parameters<typeof onUserPrefChangedMock>),
}));

import { SessionControls } from '../../src/components/SessionControls.js';
import type { SessionInfo } from '../../src/types.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { P2P_CONFIG_MSG } from '@shared/p2p-config-events.js';
import { TRANSPORT_MSG } from '@shared/transport-events.js';

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob text'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(blob);
  });
}

const TEST_OPENSPEC_ADVANCED_ROUNDS = [
  {
    id: 'initial_audit',
    mode: 'audit',
    rounds: 1,
    summaryMode: 'append',
  },
  {
    id: 'implementation_plan',
    mode: 'plan',
    rounds: 1,
    summaryMode: 'append',
  },
] as const;

const makeWs = () => {
  const handlers = new Set<(msg: unknown) => void>();
  return {
    send: vi.fn(),
    sendSessionCommand: vi.fn(),
    sendInput: vi.fn(),
    subscribeTransportSession: vi.fn(),
    unsubscribeTransportSession: vi.fn(),
    respondTransportApproval: vi.fn(),
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

function expectSendPayload(ws: ReturnType<typeof makeWs>, payload: Record<string, unknown>): void {
  expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
    ...payload,
    commandId: expect.any(String),
  }));
}

function expectLastSendPayload(ws: ReturnType<typeof makeWs>, payload: Record<string, unknown>): void {
  expect(ws.sendSessionCommand).toHaveBeenLastCalledWith('send', expect.objectContaining({
    ...payload,
    commandId: expect.any(String),
  }));
}

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

const makeTransportSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => makeSession({
  agentType: 'codex-sdk',
  runtimeType: 'transport',
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
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: DEFAULT_INNER_WIDTH });
});

  beforeEach(() => {
    vi.clearAllMocks();
    execCommandMock.mockImplementation((_command: string, _ui?: boolean, value?: string) => {
      const active = document.activeElement as HTMLDivElement | null;
      if (active && typeof active.textContent === 'string') {
        active.textContent = `${active.textContent}${String(value ?? '')}`;
      }
      return true;
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommandMock,
    });
    sessionStorage.clear();
    localStorage.clear();
    fetchSupervisorDefaultsMock.mockResolvedValue(null);
    patchSessionMock.mockResolvedValue(undefined);
    patchSubSessionMock.mockResolvedValue(undefined);
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

  it('keeps openspec through p2p settings controls visible in compact card mode', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession({ projectDir: '/tmp/project' })}
        quickData={makeQuickData() as any}
        compact
      />,
    );
    expect(screen.getByText('OpenSpec')).toBeDefined();
    expect(screen.getByText('P2P')).toBeDefined();
    expect(screen.getByLabelText('settings_button')).toBeDefined();
    expect(document.querySelector('.shortcuts')).toBeNull();
  });

  it('reports card overlay state when compact dropdowns open', () => {
    const onOverlayOpenChange = vi.fn();
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession({ projectDir: '/tmp/project' })}
        quickData={makeQuickData() as any}
        compact
        onOverlayOpenChange={onOverlayOpenChange}
      />,
    );

    fireEvent.click(screen.getByText('OpenSpec'));
    expect(onOverlayOpenChange).toHaveBeenLastCalledWith(true);
    expect(document.querySelector('.menu-dropdown-openspec')).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(onOverlayOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('shows the desktop upload hint in the placeholder on desktop', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: DEFAULT_INNER_WIDTH });
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    expect(document.querySelector('.controls-input')?.getAttribute('data-placeholder')).toBe('Send to my-project… Supports fast multi-file paste upload');
  });

  it('keeps the placeholder short on mobile', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    expect(document.querySelector('.controls-input')?.getAttribute('data-placeholder')).toBe('Send to my-project…');
  });

  it('hides the send button on mobile and shows the embedded voice button when empty', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    expect(screen.queryByRole('button', { name: /send/i })).toBeNull();
    expect(document.querySelector('.btn-voice-embedded')).toBeTruthy();
    expect(screen.getByTitle('voice_input')).toBeDefined();
  });

  it('hides the embedded voice button after typing on mobile', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'hello';
    fireEvent.input(input);
    expect(document.querySelector('.btn-voice-embedded')).toBeNull();
  });

  it('sends on Enter on mobile without a send button', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'run tests';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: 'run tests',
    });
  });

  it('bottom-aligns side buttons on mobile once the composer grows past two lines', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const { container } = render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    Object.defineProperty(input, 'clientHeight', { configurable: true, value: 32 });
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 84 });
    input.textContent = 'hello world';
    fireEvent.input(input);
    expect(container.querySelector('.controls-mobile-multiline')).toBeTruthy();
  });

  it('does not show the mobile expand button until the composer exceeds two lines', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    expect(screen.queryByRole('button', { name: 'expand composer' })).toBeNull();
  });

  it('places the mobile expand button above the quick trigger and expands the composer', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const { container } = render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    Object.defineProperty(input, 'clientHeight', { configurable: true, value: 32 });
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 84 });
    fireEvent.input(input);
    const expandButton = screen.getByRole('button', { name: 'expand composer' });
    expect(expandButton.className).toContain('btn-input-expand-floating');
    fireEvent.click(expandButton);
    expect(container.querySelector('.controls-composer-mobile-expanded')).toBeTruthy();
    expect(container.querySelector('.controls-composer-backdrop')).toBeTruthy();
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
    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: 'run tests',
    });
  });

  it('generates a distinct commandId for each send', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;

    input.textContent = 'first';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    input.textContent = 'second';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledTimes(2);
    const firstPayload = ws.sendSessionCommand.mock.calls[0]?.[1] as { commandId?: string };
    const secondPayload = ws.sendSessionCommand.mock.calls[1]?.[1] as { commandId?: string };
    expect(firstPayload.commandId).toEqual(expect.any(String));
    expect(secondPayload.commandId).toEqual(expect.any(String));
    expect(firstPayload.commandId).not.toBe(secondPayload.commandId);
  });

  it('sends advanced p2p config fields when config mode is used', async () => {
    const ws = makeWs();
    getUserPrefMock.mockImplementation(async (key: unknown) => {
      if (typeof key === 'string' && key.startsWith('p2p_session_config:')) {
        const sessionKey = key.slice('p2p_session_config:'.length);
        return JSON.stringify({
          sessions: {
            [sessionKey]: { enabled: true, mode: 'audit' },
            'deck_sub_abc': { enabled: true, mode: 'review' },
          },
          rounds: 3,
          advancedPresetKey: 'openspec',
          advancedRounds: TEST_OPENSPEC_ADVANCED_ROUNDS,
          advancedRunTimeoutMinutes: 45,
          contextReducer: {
            mode: 'clone_sdk_session',
            templateSession: sessionKey,
          },
        });
      }
      return null;
    });

    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session' })}
        quickData={makeQuickData() as any}
      />,
    );
    await flushAsync();

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('mock-select-all-config'));

    input.textContent = `${input.textContent} ship it`;
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: 'ship it',
      p2pAtTargets: [
        { session: '__all__', mode: 'config' },
      ],
      p2pSessionConfig: {
        'my-session': { enabled: true, mode: 'audit' },
        'deck_sub_abc': { enabled: true, mode: 'review' },
      },
      p2pRounds: 3,
      p2pAdvancedPresetKey: 'openspec',
      p2pAdvancedRounds: TEST_OPENSPEC_ADVANCED_ROUNDS,
      p2pAdvancedRunTimeoutMinutes: 45,
      p2pContextReducer: {
        mode: 'clone_sdk_session',
        templateSession: 'my-session',
      },
      p2pLocale: 'en',
    });
  });

  it('keeps the p2p button in solo mode after triggering a combo from the dropdown', async () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    await flushAsync();

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'run combo';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /^p2p$/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_plan/i));

    expect(screen.getByText('combo_send_confirm_title')).toBeDefined();
    expect(screen.getAllByRole('button', { name: /^send$/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /^p2p$/i })).toBeDefined();
  });

  it('asks for confirmation before directly sending from a combo dropdown item', async () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'run combo';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /^p2p$/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_plan/i));

    expect(screen.getByText('combo_send_confirm_title')).toBeDefined();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^p2p$/i })).toBeDefined();
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

    fireEvent.click(screen.getByRole('button', { name: /^p2p$/i }));

    expect(screen.getByText('combo_requires_participants_hint')).toBeDefined();
    const comboBtn = screen.getByRole('button', { name: /mode_audit→mode_plan/i }) as HTMLButtonElement;
    expect(comboBtn.disabled).toBe(true);
    expect(comboBtn.title).toBe('combo_requires_participants_hint');
  });

  it('reloads P2P config when the session preference changes externally', async () => {
    let prefValue = JSON.stringify({
      sessions: {
        'my-session': { enabled: false, mode: 'audit' },
      },
      rounds: 3,
    });
    getUserPrefMock.mockImplementation(async (key: unknown) => {
      if (typeof key === 'string' && key.startsWith('p2p_session_config:')) {
        return prefValue;
      }
      return null;
    });

    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();
    const initialFetches = getUserPrefMock.mock.calls.filter(([key]) => key === 'p2p_session_config:my-session').length;

    prefValue = JSON.stringify({
      sessions: {
        'my-session': { enabled: true, mode: 'audit' },
        'deck_sub_abc': { enabled: true, mode: 'review' },
      },
      rounds: 3,
    });
    window.dispatchEvent(new CustomEvent('imcodes:user-pref-changed', {
      detail: { key: 'p2p_session_config:my-session', value: prefValue },
    }));
    await flushAsync();
    await waitFor(() => {
      const currentFetches = getUserPrefMock.mock.calls.filter(([key]) => key === 'p2p_session_config:my-session').length;
      expect(currentFetches).toBeGreaterThan(initialFetches);
    });
  });

  it('syncs loaded P2P config into daemon authority on mount', async () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);

    await flushAsync();
    await waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith({
        type: P2P_CONFIG_MSG.SAVE,
        requestId: expect.any(String),
        scopeSession: 'my-session',
        config: {
          sessions: {
            'my-session': { enabled: true, mode: 'audit' },
          },
          rounds: 3,
        },
      });
    });
  });

  it('re-sends the current P2P config when the daemon reconnects', async () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);

    await flushAsync();
    await waitFor(() => expect(ws.send).toHaveBeenCalledTimes(1));

    ws.emit({ type: DAEMON_MSG.RECONNECTED });
    await flushAsync();

    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.send).toHaveBeenLastCalledWith({
      type: P2P_CONFIG_MSG.SAVE,
      requestId: expect.any(String),
      scopeSession: 'my-session',
      config: {
        sessions: {
          'my-session': { enabled: true, mode: 'audit' },
        },
        rounds: 3,
      },
    });
  });

  it('only shows solo plus combo items in the p2p dropdown', async () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: /^p2p$/i }));

    expect(screen.getByText('P2P')).toBeDefined();
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

    fireEvent.click(screen.getByRole('button', { name: /^p2p$/i }));
    expect(screen.getAllByText(/mode_brainstorm→mode_review/i).length).toBeGreaterThanOrEqual(1);
  });

  it('remembers skipping combo confirmation across later dropdown combo sends', async () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'first combo';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /^p2p$/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_plan/i));

    const dialog = screen.getByText('combo_send_confirm_title').closest('.dialog') as HTMLElement;
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: /^send$/i }));

    expectSendPayload(ws, {
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
    fireEvent.click(screen.getByRole('button', { name: /^p2p$/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_plan/i));

    expect(screen.queryByText('combo_send_confirm_title')).toBeNull();
    expectLastSendPayload(ws, {
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

    fireEvent.click(screen.getByRole('button', { name: /^p2p$/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_plan/i));

    const dialog = screen.getByText('combo_send_confirm_title').closest('.dialog') as HTMLElement;
    fireEvent.click(within(dialog).getByRole('button', { name: /^send$/i }));

    expectSendPayload(ws, {
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

    fireEvent.click(screen.getByRole('button', { name: /^p2p$/i }));

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

    expect(screen.getByRole('textbox').textContent).toBe('audit implementation @openspec/changes/change-a, fix code gaps and update openspec files');
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

    expect(screen.getByRole('textbox').textContent).toBe('audit spec @openspec/changes/change-a, update proposal design specs and tasks');
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

    expect(screen.getByRole('textbox').textContent).toBe('implement @openspec/changes/change-a, keep openspec artifacts aligned while coding');
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

    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: 'complete @openspec/changes/change-a, update proposal design specs tasks and archive if done',
    });
  });

  it('inserts an openspec propose-from-discussion prompt without sending immediately', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    fireEvent.click(screen.getByRole('button', { name: 'propose_action' }));
    fireEvent.click(screen.getByRole('button', { name: 'propose_from_discussion_action' }));

    expect(screen.getByRole('textbox').textContent).toBe('generate openspec change from recent discussion and write proposal design specs tasks');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('inserts an openspec propose-from-description prompt without sending immediately', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    fireEvent.click(screen.getByRole('button', { name: 'propose_action' }));
    fireEvent.click(screen.getByRole('button', { name: 'propose_from_description_action' }));

    expect(screen.getByRole('textbox').textContent).toBe('generate openspec change from description below and write proposal design specs tasks');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('shows openspec propose even when there are no existing changes', async () => {
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
      entries: [],
    });
    await flushAsync();

    expect(screen.getByRole('button', { name: 'propose_action' })).toBeDefined();
  });

  it('limits openspec dropdown height to the visible space above the trigger', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect() {
      const el = this as HTMLElement;
      if (el.getAttribute('title') === 'OpenSpec changes') {
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
      expect(dropdown.style.position).toBe('fixed');
      expect(dropdown.style.bottom).toBe('584px');
      expect(dropdown.style.maxHeight).toBe('208px');
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    }
  });

  it('raises openspec dropdowns above surrounding cards on desktop', async () => {
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

    const dropdown = document.querySelector('.menu-dropdown-openspec') as HTMLElement;
    expect(dropdown).toBeTruthy();
    expect(dropdown.style.position).toBe('fixed');
    expect(dropdown.style.zIndex).toBe('2147483646');

    fireEvent.click(screen.getByRole('button', { name: 'audit_action' }));

    const submenu = document.querySelector('.openspec-submenu') as HTMLElement;
    expect(submenu).toBeTruthy();
    expect(submenu.style.position).toBe('fixed');
    expect(submenu.style.zIndex).toBe('2147483647');
    expect(within(submenu).getByRole('button', { name: 'audit_implementation_action' })).toBeDefined();
    expect(within(submenu).getByRole('button', { name: 'audit_spec_action' })).toBeDefined();
  });

  it('keeps the desktop openspec audit submenu open when clicking inside the portal submenu', async () => {
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

    const submenu = document.querySelector('.openspec-submenu') as HTMLElement;
    expect(submenu).toBeTruthy();

    fireEvent.mouseDown(within(submenu).getByRole('button', { name: 'audit_implementation_action' }));

    expect(document.querySelector('.openspec-submenu')).toBeTruthy();
    expect(screen.getByRole('button', { name: /openspec/i })).toBeDefined();
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

  it('anchors the openspec audit submenu to the audit button on mobile', async () => {
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect() {
      const el = this as HTMLElement;
      if (el.classList?.contains('shortcuts-model')) {
        return {
          x: 250, y: 0, top: 720, left: 250, right: 360, bottom: 752, width: 110, height: 32,
          toJSON() { return {}; },
        } as DOMRect;
      }
      if (el.textContent?.trim() === 'audit_action') {
        return {
          x: 260, y: 0, top: 648, left: 260, right: 328, bottom: 676, width: 68, height: 28,
          toJSON() { return {}; },
        } as DOMRect;
      }
      return {
        x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
        toJSON() { return {}; },
      } as DOMRect;
    });

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

      fireEvent.click(screen.getByRole('button', { name: 'expand change-a' }));
      fireEvent.click(screen.getByRole('button', { name: 'audit_action' }));

      const submenu = document.querySelector('.openspec-submenu') as HTMLElement;
      expect(submenu).toBeTruthy();
      expect(submenu.className).toContain('openspec-submenu-inline');
      expect(within(submenu).getByRole('button', { name: 'audit_implementation_action' })).toBeDefined();
      expect(within(submenu).getByRole('button', { name: 'audit_spec_action' })).toBeDefined();
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    }
  });

  it('renders the openspec change list inline in compact mobile mode', async () => {
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect() {
      const el = this as HTMLElement;
      if (el.classList?.contains('shortcuts-model')) {
        return {
          x: 300, y: 0, top: 708, left: 300, right: 372, bottom: 740, width: 72, height: 32,
          toJSON() { return {}; },
        } as DOMRect;
      }
      if (el.getAttribute('title') === 'OpenSpec changes') {
        return {
          x: 314, y: 0, top: 708, left: 314, right: 372, bottom: 740, width: 58, height: 32,
          toJSON() { return {}; },
        } as DOMRect;
      }
      return {
        x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
        toJSON() { return {}; },
      } as DOMRect;
    });

    try {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
          quickData={makeQuickData() as any}
          compact={true}
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

      const dropdown = document.querySelector('.menu-dropdown-openspec') as HTMLElement;
      expect(dropdown).toBeTruthy();
      expect(dropdown.className).toContain('menu-dropdown-openspec-inline');
      expect(dropdown.style.position).toBe('');
      expect(within(dropdown).getByRole('button', { name: 'change-a' })).toBeDefined();
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    }
  });

  it('renders the openspec change list inline on mobile for the main session', async () => {
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });

    try {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'main-session', projectDir: '/repo', agentType: 'codex' })}
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

      const dropdown = document.querySelector('.menu-dropdown-openspec') as HTMLElement;
      expect(dropdown).toBeTruthy();
      expect(dropdown.className).toContain('menu-dropdown-openspec-inline');
      expect(within(dropdown).getByRole('button', { name: 'change-a' })).toBeDefined();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    }
  });

  it('anchors the openspec propose submenu to the propose button on mobile', async () => {
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect() {
      const el = this as HTMLElement;
      if (el.classList?.contains('shortcuts-model')) {
        return {
          x: 250, y: 0, top: 720, left: 250, right: 360, bottom: 752, width: 110, height: 32,
          toJSON() { return {}; },
        } as DOMRect;
      }
      if (el.textContent?.trim() === 'propose_action') {
        return {
          x: 265, y: 0, top: 662, left: 265, right: 375, bottom: 694, width: 110, height: 32,
          toJSON() { return {}; },
        } as DOMRect;
      }
      return {
        x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
        toJSON() { return {}; },
      } as DOMRect;
    });

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
        entries: [],
      });
      await flushAsync();

      fireEvent.click(screen.getByRole('button', { name: 'propose_action' }));

      const submenu = document.querySelector('.openspec-submenu') as HTMLElement;
      expect(submenu).toBeTruthy();
      expect(submenu.className).toContain('openspec-submenu-inline');
      expect(within(submenu).getByRole('button', { name: 'propose_from_discussion_action' })).toBeDefined();
      expect(within(submenu).getByRole('button', { name: 'propose_from_description_action' })).toBeDefined();
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    }
  });

  it('opens the openspec audit submenu below the trigger when the trigger is high in the viewport', async () => {
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect() {
      const el = this as HTMLElement;
      if (el.classList?.contains('shortcuts-model')) {
        return {
          x: 250, y: 0, top: 720, left: 250, right: 360, bottom: 752, width: 110, height: 32,
          toJSON() { return {}; },
        } as DOMRect;
      }
      if (el.textContent?.trim() === 'audit_action') {
        return {
          x: 248, y: 0, top: 92, left: 248, right: 328, bottom: 120, width: 80, height: 28,
          toJSON() { return {}; },
        } as DOMRect;
      }
      return {
        x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
        toJSON() { return {}; },
      } as DOMRect;
    });

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

      fireEvent.click(screen.getByRole('button', { name: 'expand change-a' }));
      fireEvent.click(screen.getByRole('button', { name: 'audit_action' }));

      const submenu = document.querySelector('.openspec-submenu') as HTMLElement;
      expect(submenu).toBeTruthy();
      expect(submenu.className).toContain('openspec-submenu-inline');
      expect(within(submenu).getByRole('button', { name: 'audit_implementation_action' })).toBeDefined();
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
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

  it('renders queued transport hints from legacy pendingMessages when pending entries are empty', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          runtimeType: 'transport',
          transportPendingMessages: ['queued first', 'queued second'],
          transportPendingMessageEntries: [],
        })}
        quickData={makeQuickData() as any}
      />,
    );

    // Compact pill is shown by default — click to expand
    fireEvent.click(screen.getByRole('button', { name: /2 queued/i }));
    expect(document.querySelector('.controls-queued-hint')).toBeTruthy();
    expect(screen.getByText('queued first')).toBeDefined();
    expect(screen.getByText('queued second')).toBeDefined();
  });

  it('renders all queued transport messages when pending entries are partial', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'qwen-session',
          runtimeType: 'transport',
          state: 'running',
          transportPendingMessages: ['queued first', 'queued second'],
          transportPendingMessageEntries: [
            { clientMessageId: 'msg-1', text: 'queued first' },
          ],
        })}
        quickData={makeQuickData() as any}
      />,
    );

    // Compact pill is shown by default — click to expand
    fireEvent.click(screen.getByRole('button', { name: /2 queued/i }));
    expect(screen.getByText('queued first')).toBeDefined();
    expect(screen.getByText('queued second')).toBeDefined();
  });

  it('does not offer edit or delete actions for legacy queued fallback entries', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'qwen-session',
          runtimeType: 'transport',
          state: 'running',
          transportPendingMessages: ['queued first'],
          transportPendingMessageEntries: [],
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
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
    expectSendPayload(ws, {
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
    expectSendPayload(ws, {
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
      transportPendingMessageEntries: [
        { clientMessageId: 'msg-1', text: 'queued send' },
        { clientMessageId: 'msg-2', text: 'second queued send' },
      ],
    });
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={runningSession}
        quickData={makeQuickData() as any}
      />,
    );
    // Compact pill is shown by default — click to expand
    fireEvent.click(screen.getByRole('button', { name: /2 queued/i }));
    expect(screen.getByText('transport_send_queued')).toBeDefined();
    expect(screen.getByText('queued send')).toBeDefined();
    expect(screen.getByText('second queued send')).toBeDefined();
  });

  it('can collapse queued transport messages to latest-only view', () => {
    const runningSession = makeSession({
      name: 'qwen-session',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      transportPendingMessages: ['queued send', 'second queued send'],
      transportPendingMessageEntries: [
        { clientMessageId: 'msg-1', text: 'queued send' },
        { clientMessageId: 'msg-2', text: 'second queued send' },
      ],
    });
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={runningSession}
        quickData={makeQuickData() as any}
      />,
    );

    // Compact pill is shown by default — click to expand first
    fireEvent.click(screen.getByRole('button', { name: /2 queued/i }));
    fireEvent.click(screen.getByRole('button', { name: 'hide' }));

    // Collapsed state is now a compact pill — only a count, no latest-only
    // summary or message preview (took too much vertical space on mobile).
    // The pill itself is the button that expands the full list back.
    expect(screen.getByRole('button', { name: '2 queued' })).toBeDefined();
    expect(screen.queryByText('queued send')).toBeNull();
    expect(screen.queryByText('second queued send')).toBeNull();
    expect(screen.queryByText('2 queued · showing latest only')).toBeNull();
  });

  it('remembers collapsed queued transport messages globally', () => {
    const runningSession = makeSession({
      name: 'qwen-session',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      transportPendingMessages: ['queued send', 'second queued send'],
      transportPendingMessageEntries: [
        { clientMessageId: 'msg-1', text: 'queued send' },
        { clientMessageId: 'msg-2', text: 'second queued send' },
      ],
    });
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={runningSession}
        quickData={makeQuickData() as any}
      />,
    );

    // Compact pill is shown by default — click to expand
    expect(screen.getByRole('button', { name: '2 queued' })).toBeDefined();
    expect(screen.queryByText('queued send')).toBeNull();
    expect(screen.queryByText('second queued send')).toBeNull();
    expect(screen.queryByText('2 queued · showing latest only')).toBeNull();
    // Click pill to expand and verify messages appear
    fireEvent.click(screen.getByRole('button', { name: /2 queued/i }));
    expect(screen.getByText('queued send')).toBeDefined();
    expect(screen.getByText('second queued send')).toBeDefined();
  });

  it('edits a queued transport message through the queue controls', () => {
    const ws = makeWs();
    const runningSession = makeSession({
      name: 'qwen-session',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      transportPendingMessages: ['queued send'],
      transportPendingMessageEntries: [
        { clientMessageId: 'msg-1', text: 'queued send' },
      ],
    });
    render(
      <SessionControls
        ws={ws as any}
        activeSession={runningSession}
        quickData={makeQuickData() as any}
      />,
    );

    // Compact pill is shown by default — click to expand first
    fireEvent.click(screen.getByRole('button', { name: /1 queued/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    const input = screen.getByRole('textbox') as HTMLDivElement;
    expect(input.textContent).toBe('queued send');

    input.textContent = 'edited queued send';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.edit_queued_message',
      sessionName: 'qwen-session',
      clientMessageId: 'msg-1',
      text: 'edited queued send',
      commandId: expect.any(String),
    }));
    expect(screen.getByText('edited queued send')).toBeDefined();
    expect(screen.queryByText('queued send')).toBeNull();
  });

  it('removes a queued transport message through the queue controls', () => {
    const ws = makeWs();
    const runningSession = makeSession({
      name: 'qwen-session',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      transportPendingMessages: ['queued send'],
      transportPendingMessageEntries: [
        { clientMessageId: 'msg-1', text: 'queued send' },
      ],
    });
    render(
      <SessionControls
        ws={ws as any}
        activeSession={runningSession}
        quickData={makeQuickData() as any}
      />,
    );

    // Compact pill is shown by default — click to expand first
    fireEvent.click(screen.getByRole('button', { name: /1 queued/i }));
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.undo_queued_message',
      sessionName: 'qwen-session',
      clientMessageId: 'msg-1',
      commandId: expect.any(String),
    }));
    expect(screen.queryByText('queued send')).toBeNull();
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
    expectSendPayload(ws, { sessionName: 'qwen-session', text: '/stop' });
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
    expect(stopBtn.textContent).toBe('■');
    expect(stopBtn.disabled).toBe(false);
    fireEvent.click(stopBtn);
    expectSendPayload(ws, {
      sessionName: 'codex-sdk-session',
      text: '/stop',
    });
  });

  it('shows a compact Auto dropdown for supported transport sessions and enables supervised mode from saved defaults', async () => {
    const ws = makeWs();
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'codex-sdk',
      model: 'gpt-5.4',
      timeoutMs: 12000,
      promptVersion: 'supervision_decision_v1',
    });
    const onTransportConfigSaved = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'codex-sdk-session',
          state: 'idle',
        })}
        onSettings={vi.fn()}
        onTransportConfigSaved={onTransportConfigSaved}
        quickData={makeQuickData() as any}
      />,
    );

    const autoBtn = screen.getByRole('button', { name: /^Auto$/ });
    expect(autoBtn.textContent).toContain('Auto');
    expect(autoBtn.textContent).not.toContain('Supervised');
    fireEvent.click(autoBtn);
    expect(document.querySelector('.menu-dropdown-auto')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /supervised$/i }));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv1', 'codex-sdk-session', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised',
            backend: 'codex-sdk',
            model: 'gpt-5.4',
          }),
        }),
      }));
    });
    expect(onTransportConfigSaved).toHaveBeenCalledWith(expect.objectContaining({
      supervision: expect.objectContaining({
        mode: 'supervised',
      }),
    }));
  });

  it('upgrades supervised mode to audit mode with default audit config', async () => {
    const ws = makeWs();
    const onSettings = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'codex-sdk-session',
          state: 'idle',
          transportConfig: {
            supervision: {
              mode: 'supervised',
              backend: 'codex-sdk',
              model: 'gpt-5.4',
              timeoutMs: 12000,
              promptVersion: 'supervision_decision_v1',
              maxParseRetries: 1,
            },
          },
        })}
        onSettings={onSettings}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Auto$/ }));
    fireEvent.click(screen.getByRole('button', { name: /supervised_audit$/i }));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv1', 'codex-sdk-session', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised_audit',
            auditMode: 'audit',
            maxAuditLoops: 2,
            taskRunPromptVersion: 'task_run_status_v1',
          }),
        }),
      }));
    });
    expect(onSettings).not.toHaveBeenCalled();
  });

  it('falls back to Settings when heavy mode snapshot is present but audit config is invalid', async () => {
    const ws = makeWs();
    const onSettings = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'codex-sdk-session',
          state: 'idle',
          transportConfig: {
            supervision: {
              mode: 'supervised',
              backend: 'codex-sdk',
              model: 'gpt-5.4',
              timeoutMs: 12000,
              promptVersion: 'supervision_decision_v1',
              maxParseRetries: 1,
              auditMode: 'audit',
              maxAuditLoops: 0,
            },
          },
        })}
        onSettings={onSettings}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Auto$/ }));
    fireEvent.click(screen.getByRole('button', { name: /supervised_audit$/i }));

    await waitFor(() => {
      expect(onSettings).toHaveBeenCalled();
    });
    expect(patchSessionMock).not.toHaveBeenCalled();
  });

  it('always shows Session Settings in the Auto dropdown when settings are available', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'codex-sdk-session',
          state: 'idle',
          transportConfig: {
            supervision: {
              mode: 'supervised',
              backend: 'codex-sdk',
              model: 'gpt-5.4',
              timeoutMs: 12000,
              promptVersion: 'supervision_decision_v1',
              maxParseRetries: 1,
            },
          },
        })}
        onSettings={vi.fn()}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Auto$/ }));
    const autoMenu = document.querySelector('.menu-dropdown-auto');
    expect(autoMenu).toBeTruthy();
    expect(within(autoMenu as HTMLElement).getByRole('button', { name: /settings/i })).toBeDefined();
  });

  it('renders approval controls for active transport chat events', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'codex-sdk-session',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    await waitFor(() => {
      expect(ws.onMessage).toHaveBeenCalled();
    });
    await flushAsync();

    await act(async () => {
      for (const call of ws.onMessage.mock.calls) {
        const handler = call[0] as ((msg: unknown) => void) | undefined;
        handler?.({
          type: TRANSPORT_MSG.CHAT_APPROVAL,
          sessionId: 'codex-sdk-session',
          requestId: 'approval-1',
          description: 'Allow file write',
          tool: 'shell',
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Approval required')).toBeDefined();
      expect(screen.getByText('shell wants approval')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Allow$/ }));
    expect(ws.respondTransportApproval).toHaveBeenCalledWith('codex-sdk-session', 'approval-1', true);
  });

  it('clears stale approval banners when switching between transport sessions', async () => {
    const ws = makeWs();
    const { rerender } = render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'transport-a',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    await waitFor(() => {
      expect(ws.onMessage).toHaveBeenCalled();
    });

    await act(async () => {
      for (const call of ws.onMessage.mock.calls) {
        const handler = call[0] as ((msg: unknown) => void) | undefined;
        handler?.({
          type: TRANSPORT_MSG.CHAT_APPROVAL,
          sessionId: 'transport-a',
          requestId: 'approval-stale',
          description: 'Allow file write',
          tool: 'shell',
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Approval required')).toBeDefined();
    });

    rerender(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'transport-b',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Approval required')).toBeNull();
      expect(screen.queryByText('shell wants approval')).toBeNull();
    });
  });

  it('treats copilot-sdk sessions as transport even when runtimeType is omitted', async () => {
    const ws = makeWs();

    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeSession({
          name: 'copilot-session',
          agentType: 'copilot-sdk',
          state: 'running',
          runtimeType: undefined,
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.getByRole('button', { name: /^Stop$/ })).toBeDefined();
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

  it('shows upload button in compact card composer when serverId is provided', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession()}
        quickData={makeQuickData() as any}
        serverId="srv-1"
        compact
      />,
    );
    expect(screen.getByTitle('upload_file')).toBeDefined();
  });

  it('shows upload button in regular chat composer when serverId is provided', () => {
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

  it('does not show desktop paste-upload hint in compact card composer', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession()}
        quickData={makeQuickData() as any}
        compact
      />,
    );
    expect(document.querySelector('.controls-input')?.getAttribute('data-placeholder')).toBe('Send to my-project…');
  });

  it('keeps normal plain-text paste inline for short clipboard content', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession()}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.focus();
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? 'short inline paste' : '',
      },
    });

    expect(execCommandMock).toHaveBeenCalledWith('insertText', false, 'short inline paste');
    expect(input.textContent).toBe('short inline paste');
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it('converts oversized plain-text paste into an attachment upload', async () => {
    uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/pasted-text.txt' } });
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.focus();
    const longText = 'x'.repeat(13000);
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? longText : '',
      },
    });

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    const uploadedFile = uploadFileMock.mock.calls[0]?.[1] as File;
    expect(uploadedFile).toBeInstanceOf(File);
    expect(uploadedFile.name).toMatch(/^pasted-text-.*\.txt$/);
    expect(await readBlobText(uploadedFile)).toBe(longText);
    expect(execCommandMock).not.toHaveBeenCalled();
    expect(input.textContent).toBe('');
    await waitFor(() => {
      expect(document.querySelector('.attachment-badge-name')?.textContent).toMatch(/^pasted-text-.*\.txt$/);
    });

    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: '@/tmp/pasted-text.txt',
    });
  });

  it('restores uploaded attachment badges when switching back to the same main session', async () => {
    uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/persisted-attachment.txt' } });
    const ws = makeWs();
    const { rerender } = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'session-a' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? 'x'.repeat(1300) : '',
      },
    });

    await waitFor(() => {
      expect(document.querySelector('.attachment-badge-name')?.textContent).toMatch(/^pasted-text-.*\.txt$/);
    });
    const badgeName = document.querySelector('.attachment-badge-name')?.textContent ?? '';

    rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'session-b' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    expect(document.querySelector('.attachment-badge-name')).toBeNull();

    rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'session-a' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.attachment-badge-name')?.textContent).toBe(badgeName);
    });
  });

  it('restores uploaded attachment badges when switching back to the same sub-session', async () => {
    uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/persisted-sub-attachment.txt' } });
    const ws = makeWs();
    const { rerender } = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'deck_sub_sub-1' })}
        subSessionId="sub-1"
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? 'x'.repeat(1300) : '',
      },
    });

    await waitFor(() => {
      expect(document.querySelector('.attachment-badge-name')?.textContent).toMatch(/^pasted-text-.*\.txt$/);
    });
    const badgeName = document.querySelector('.attachment-badge-name')?.textContent ?? '';

    rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'deck_sub_sub-2' })}
        subSessionId="sub-2"
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    expect(document.querySelector('.attachment-badge-name')).toBeNull();

    rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'deck_sub_sub-1' })}
        subSessionId="sub-1"
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.attachment-badge-name')?.textContent).toBe(badgeName);
    });
  });

  it('does not clear stored attachments when another control surface mounts for the same sub-session', async () => {
    uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/shared-sub-attachment.txt' } });
    const ws = makeWs();
    const first = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'deck_sub_shared' })}
        subSessionId="sub-shared"
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = within(first.container).getByRole('textbox') as HTMLDivElement;
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? 'x'.repeat(1300) : '',
      },
    });

    await waitFor(() => {
      expect(first.container.querySelector('.attachment-badge-name')?.textContent).toMatch(/^pasted-text-.*\.txt$/);
    });
    const badgeName = first.container.querySelector('.attachment-badge-name')?.textContent ?? '';

    const second = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'deck_sub_shared' })}
        subSessionId="sub-shared"
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    await waitFor(() => {
      expect(second.container.querySelector('.attachment-badge-name')?.textContent).toBe(badgeName);
    });
    expect(first.container.querySelector('.attachment-badge-name')?.textContent).toBe(badgeName);
  });

  it('blocks oversized plain-text paste when upload context is unavailable', async () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession()}
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.focus();
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? 'y'.repeat(13000) : '',
      },
    });

    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(execCommandMock).not.toHaveBeenCalled();
    expect(input.textContent).toBe('');
    expect(await screen.findByText('Paste is too large for inline input here. Upload it as a file instead.')).toBeDefined();
  });

  it('uses the shared 2GB upload limit for user-facing size calculations', () => {
    expect(FILE_TRANSFER_LIMITS.MAX_FILE_SIZE).toBe(2 * 1024 * 1024 * 1024);
    expect(Math.round(FILE_TRANSFER_LIMITS.MAX_FILE_SIZE / (1024 * 1024))).toBe(2048);
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
      expectSendPayload(ws, {
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

  it('opens the quick input panel when the quick trigger is clicked', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession({ name: 'my-session' })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.queryByText('quick-panel-send')).toBeNull();
    fireEvent.click(screen.getByTitle('title'));
    expect(screen.getByText('quick-panel-send')).toBeDefined();
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
    // Menu items render as "○ <Label>" / "● <Label>" with a formatted label
    // (e.g. "○ High", "○ Extra High"). Use an exact string match so we hit
    // "High" and not "Extra High" (which `/high/i` would also match).
    fireEvent.click(screen.getByRole('button', { name: '○ High' }));

    expectSendPayload(ws, {
      sessionName: 'codex-sdk-session',
      text: '/thinking high',
    });
  });

  it('prefers dynamically discovered codex-sdk models over the static fallback list', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'codex-sdk-session',
          agentType: 'codex-sdk',
          runtimeType: 'transport',
          activeModel: 'gpt-5.4',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const request = ws.send.mock.calls.find((call) => call[0]?.type === 'transport.list_models')?.[0];
    expect(request).toMatchObject({ type: 'transport.list_models', agentType: 'codex-sdk' });

    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      requestId: request?.requestId,
      models: [
        { id: 'gpt-5.5', name: 'GPT-5.5', supportsReasoningEffort: true },
        { id: 'gpt-5.5-mini', name: 'GPT-5.5 Mini' },
      ],
      defaultModel: 'gpt-5.5',
      isAuthenticated: true,
    }));

    fireEvent.click(screen.getByRole('button', { name: /^default$/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /gpt-5.5/i })[0]!);

    expectSendPayload(ws, {
      sessionName: 'codex-sdk-session',
      text: '/model gpt-5.5',
    });
  });

  it('shows a model selector for copilot-sdk and sends /model', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'copilot-sdk-session',
          agentType: 'copilot-sdk',
          runtimeType: 'transport',
          activeModel: 'gpt-5.4',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^gpt-5.4$/i }));
    fireEvent.click(screen.getByRole('button', { name: /gpt-5.4-mini/i }));

    expectSendPayload(ws, {
      sessionName: 'copilot-sdk-session',
      text: '/model gpt-5.4-mini',
    });
  });

  it('shows a model selector for cursor-headless and sends /model', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'cursor-headless-session',
          agentType: 'cursor-headless',
          runtimeType: 'transport',
          activeModel: 'gpt-5.2',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^gpt-5.2$/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /gpt-5.2/i })[1]!);

    expectSendPayload(ws, {
      sessionName: 'cursor-headless-session',
      text: '/model gpt-5.2',
    });
  });
});
