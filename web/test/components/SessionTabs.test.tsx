/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key.split('.').pop() ?? key,
  }),
}));

const getUserPrefMock = vi.fn().mockResolvedValue(null);
const saveUserPrefMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/api.js', () => ({
  getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
}));

import { SessionTabs } from '../../src/components/SessionTabs.js';
import type { SessionInfo } from '../../src/types.js';

const makeSessions = (overrides: Partial<SessionInfo>[] = []): SessionInfo[] =>
  overrides.map((o, i) => ({
    name: `session_w${i + 1}`,
    project: 'my-project',
    role: `w${i + 1}` as SessionInfo['role'],
    agentType: 'worker',
    state: 'idle',
    ...o,
  }));

// Default required props for SessionTabs
const defaultProps = {
  onNewSession: vi.fn(),
  onStopProject: vi.fn(),
  onRestartProject: vi.fn(),
};

describe('SessionTabs', () => {
  beforeEach(() => {
    getUserPrefMock.mockResolvedValue(null);
    saveUserPrefMock.mockResolvedValue(undefined);
    // Ensure localStorage is available (jsdom may provide a broken stub)
    if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.setItem !== 'function') {
      const store: Record<string, string> = {};
      Object.defineProperty(globalThis, 'localStorage', {
        value: {
          getItem: (k: string) => store[k] ?? null,
          setItem: (k: string, v: string) => { store[k] = v; },
          removeItem: (k: string) => { delete store[k]; },
          clear: () => { for (const k of Object.keys(store)) delete store[k]; },
          get length() { return Object.keys(store).length; },
          key: (i: number) => Object.keys(store)[i] ?? null,
        },
        writable: true,
        configurable: true,
      });
    }
  });

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "No active sessions" when sessions array is empty and sessionsLoaded is true', () => {
    render(
      <SessionTabs sessions={[]} activeSession={null} onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
    );
    expect(screen.getByText('No active sessions')).toBeDefined();
  });

  it('renders a button for each session', () => {
    const sessions = makeSessions([{}, {}]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
    );
    const buttons = screen.getAllByRole('tab');
    expect(buttons).toHaveLength(2);
  });

  it('marks the active session button with aria-selected=true', () => {
    const sessions = makeSessions([{ name: 'session_w1' }, { name: 'session_w2' }]);
    render(
      <SessionTabs sessions={sessions} activeSession="session_w1" onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
    );
    const buttons = screen.getAllByRole('tab');
    expect(buttons[0].getAttribute('aria-selected')).toBe('true');
    expect(buttons[1].getAttribute('aria-selected')).toBe('false');
  });

  it('calls onSelect with the session name when a tab is clicked', () => {
    const onSelect = vi.fn();
    const sessions = makeSessions([{ name: 'session_w1' }, { name: 'session_w2' }]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={onSelect} sessionsLoaded={true} {...defaultProps} />,
    );

    const buttons = screen.getAllByRole('tab');
    fireEvent.click(buttons[1]);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('session_w2');
  });

  it('renders brain tab with brain class and project name', () => {
    const sessions: SessionInfo[] = [{
      name: 'session_brain',
      project: 'my-project',
      role: 'brain',
      agentType: 'brain',
      state: 'running',
    }];
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
    );
    const button = screen.getByRole('tab');
    expect(button.className).toContain('brain');
    expect(button.textContent).toContain('my-project');
  });

  it('applies busy class for running session state', () => {
    const sessions = makeSessions([{ name: 'session_w1', state: 'running' }]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
    );
    const button = screen.getByRole('tab');
    expect(button.className).toContain('busy');
  });


  it('shows sdk family badges for claude and codex tabs', () => {
    const sessions = makeSessions([
      { name: 'sdk-cc', role: 'brain', project: 'sdk-proj', agentType: 'claude-code-sdk', state: 'idle', label: 'claude-code-sdk1' },
      { name: 'sdk-cx', role: 'w1', project: 'sdk-proj', agentType: 'codex-sdk', state: 'idle', label: 'codex-sdk2' },
    ]);

    const view = render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
    );

    const badges = [...view.container.querySelectorAll('.agent-badge')].map((el) => el.textContent);
    expect(badges).toEqual(['cc', 'cx']);
    expect(screen.getByText('CC1')).toBeDefined();
    expect(screen.getByText('Cx2')).toBeDefined();
  });

  it('renders tab bar with role=tablist', () => {
    const sessions = makeSessions([{}]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
    );
    expect(screen.getByRole('tablist')).toBeDefined();
  });

  it('requires three confirmations before stopping from the tab context dialog', () => {
    const onStopProject = vi.fn();
    const sessions = makeSessions([{ name: 'session_w1', project: 'proj-1' }]);
    render(
      <SessionTabs
        sessions={sessions}
        activeSession={null}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
        onStopProject={onStopProject}
      />,
    );

    const tab = screen.getByRole('tab');
    fireEvent.contextMenu(tab);
    fireEvent.click(screen.getByText('✕ Stop'));

    const stopBtn = () => screen.getByRole('button', { name: /stop session|confirm stop|really stop/i });

    fireEvent.click(stopBtn());
    expect(onStopProject).not.toHaveBeenCalled();
    expect(screen.getByText('Confirm stop?')).toBeDefined();

    fireEvent.click(stopBtn());
    expect(onStopProject).not.toHaveBeenCalled();
    expect(screen.getByText('⚠ REALLY stop proj-1?')).toBeDefined();

    fireEvent.click(stopBtn());
    expect(onStopProject).toHaveBeenCalledOnce();
    expect(onStopProject).toHaveBeenCalledWith('proj-1');
  });

  it('uses the current label as the rename input value and commits a label update', () => {
    const onRenameSession = vi.fn();
    const sessions: SessionInfo[] = [{
      name: 'deck_proj_brain',
      project: 'my-project',
      role: 'brain',
      agentType: 'brain',
      state: 'idle',
      label: 'Main Label',
    }];

    render(
      <SessionTabs
        sessions={sessions}
        activeSession="deck_proj_brain"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        renameRequest="deck_proj_brain"
        onRenameHandled={vi.fn()}
        onRenameSession={onRenameSession}
        {...defaultProps}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('Main Label');

    fireEvent.input(input, { target: { value: 'Readable Main' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRenameSession).toHaveBeenCalledWith('deck_proj_brain', 'Readable Main');
  });

  it('allows clearing the label so the session falls back to the project name', () => {
    const onRenameSession = vi.fn();
    const sessions: SessionInfo[] = [{
      name: 'deck_proj_brain',
      project: 'my-project',
      role: 'brain',
      agentType: 'brain',
      state: 'idle',
      label: 'Main Label',
    }];

    render(
      <SessionTabs
        sessions={sessions}
        activeSession="deck_proj_brain"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        renameRequest="deck_proj_brain"
        onRenameHandled={vi.fn()}
        onRenameSession={onRenameSession}
        {...defaultProps}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(onRenameSession).toHaveBeenCalledWith('deck_proj_brain', null);
  });
});
