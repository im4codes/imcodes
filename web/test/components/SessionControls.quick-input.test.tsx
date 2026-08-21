/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'quick_input.title') return 'Quick input';
      if (key === 'session.send_placeholder') return `Send to ${String(opts?.name ?? 'session')}…`;
      if (key === 'session.send_placeholder_desktop_upload') return String(opts?.placeholder ?? '');
      const parts = key.split('.');
      return parts[parts.length - 1];
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../src/components/VoiceOverlay.js', () => ({
  VoiceOverlay: () => null,
}));

vi.mock('../../src/components/VoiceInput.js', () => ({
  isAvailable: () => false,
}));

vi.mock('../../src/components/AtPicker.js', () => ({
  AtPicker: () => null,
}));

vi.mock('../../src/components/P2pConfigPanel.js', () => ({
  P2pConfigPanel: () => null,
}));

vi.mock('../../src/components/p2p-combos.js', () => ({
  useP2pCustomCombos: () => ({ allCombos: { presets: [], custom: [] } }),
}));

vi.mock('../../src/hooks/useSwipeBack.js', () => ({
  useSwipeBack: () => ({ current: null }),
}));

vi.mock('../../src/api.js', () => ({
  uploadFile: vi.fn(),
  getUserPref: vi.fn().mockResolvedValue(null),
  saveUserPref: vi.fn().mockResolvedValue(undefined),
  onUserPrefChanged: vi.fn(() => () => {}),
  apiFetch: vi.fn().mockResolvedValue({ data: { history: [], sessionHistory: {}, commands: [], phrases: [] } }),
}));

import { SessionControls } from '../../src/components/SessionControls.js';
import type { SessionInfo } from '../../src/types.js';

const makeSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  name: 'deck_main',
  project: 'main',
  role: 'main',
  agentType: 'claude-code-sdk',
  state: 'idle',
  runtimeType: 'transport',
  projectDir: '/tmp/project',
  ...overrides,
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

describe('SessionControls quick input integration', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('opens the real quick input panel from the composer trigger', () => {
    const ws = {
      connected: true,
      send: vi.fn(),
      sendSessionCommand: vi.fn(),
      sendInput: vi.fn(),
      subSessionSetModel: vi.fn(),
      fsListDir: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    } as any;

    render(
      <SessionControls
        ws={ws}
        activeSession={makeSession()}
        quickData={makeQuickData()}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );

    fireEvent.click(screen.getByTitle('Quick input'));

    expect(document.querySelector('.qp')).toBeTruthy();
  });

  it('preserves visual newlines from the composer when sending and recording history', () => {
    const ws = {
      connected: true,
      send: vi.fn(),
      sendSessionCommand: vi.fn(),
      sendInput: vi.fn(),
      subSessionSetModel: vi.fn(),
      fsListDir: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    } as any;
    const quickData = makeQuickData();

    render(
      <SessionControls
        ws={ws}
        activeSession={makeSession()}
        quickData={quickData}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox');
    input.innerHTML = 'first line<div>second line</div>';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: 'send' }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      sessionName: 'deck_main',
      text: 'first line\nsecond line',
    }));
    expect(quickData.recordHistory).toHaveBeenCalledWith('first line\nsecond line', 'deck_main');
  });

  it('preserves multiline quick history through arrow restore and quick panel selection', () => {
    const ws = {
      connected: true,
      send: vi.fn(),
      sendSessionCommand: vi.fn(),
      sendInput: vi.fn(),
      subSessionSetModel: vi.fn(),
      fsListDir: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    } as any;
    const multiline = 'restore alpha\nrestore beta';
    const quickData = {
      ...makeQuickData(),
      data: {
        history: [],
        sessionHistory: { deck_main: [multiline] },
        commands: [],
        phrases: [],
      },
    };

    render(
      <SessionControls
        ws={ws}
        activeSession={makeSession()}
        quickData={quickData}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(ws.sendSessionCommand).toHaveBeenLastCalledWith('send', expect.objectContaining({
      text: multiline,
    }));

    fireEvent.click(screen.getByTitle('Quick input'));
    const historyText = screen.getByText((_, element) => element?.classList.contains('qp-item-text') === true);
    fireEvent.click(historyText.closest('.qp-item')!);
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(ws.sendSessionCommand).toHaveBeenLastCalledWith('send', expect.objectContaining({
      text: multiline,
    }));
  });

  it('opens slash suggestions, filters provider and user commands, and fills the selected command', () => {
    const ws = {
      connected: true,
      send: vi.fn(),
      sendSessionCommand: vi.fn(),
      sendInput: vi.fn(),
      subSessionSetModel: vi.fn(),
      fsListDir: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    } as any;
    const quickData = {
      ...makeQuickData(),
      data: {
        history: [],
        sessionHistory: {},
        commands: ['/code-review'],
        phrases: [],
      },
    };

    const { container } = render(
      <SessionControls
        ws={ws}
        activeSession={makeSession({ agentType: 'codex-sdk' })}
        quickData={quickData}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox');
    input.textContent = '/';
    fireEvent.input(input);
    expect(container.querySelector('[data-slash-command="/stop"]')).toBeTruthy();
    expect(container.querySelector('[data-slash-command="/fast on"]')).toBeTruthy();
    expect(container.querySelector('[data-slash-command="/code-review"]')).toBeTruthy();

    input.textContent = '/co';
    fireEvent.input(input);
    expect(container.querySelector('[data-slash-command="/compact"]')).toBeTruthy();
    expect(container.querySelector('[data-slash-command="/code-review"]')).toBeTruthy();
    expect(container.querySelector('[data-slash-command="/fast on"]')).toBeNull();

    fireEvent.click(container.querySelector('[data-slash-command="/code-review"]')!);
    expect(input.textContent).toBe('/code-review');
    expect(container.querySelector('.controls-slash-picker')).toBeNull();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('accepts the highlighted slash command with Enter without sending it immediately', () => {
    const ws = {
      connected: true,
      send: vi.fn(),
      sendSessionCommand: vi.fn(),
      sendInput: vi.fn(),
      subSessionSetModel: vi.fn(),
      fsListDir: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    } as any;

    const { container } = render(
      <SessionControls
        ws={ws}
        activeSession={makeSession({ agentType: 'codex-sdk' })}
        quickData={makeQuickData()}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox');
    input.textContent = '/fa';
    fireEvent.input(input);
    expect(container.querySelector('[data-slash-command="/fast on"]')?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.textContent).toBe('/fast on');
    expect(container.querySelector('.controls-slash-picker')).toBeNull();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('filters built-in and user quick phrases from a leading exclamation mark', () => {
    const ws = {
      connected: true,
      send: vi.fn(),
      sendSessionCommand: vi.fn(),
      sendInput: vi.fn(),
      subSessionSetModel: vi.fn(),
      fsListDir: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    } as any;
    const quickData = {
      ...makeQuickData(),
      data: {
        history: [],
        sessionHistory: {},
        commands: [],
        phrases: ['inspect errors', 'custom release checklist'],
      },
    };

    const { container } = render(
      <SessionControls
        ws={ws}
        activeSession={makeSession()}
        quickData={quickData}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox');
    input.textContent = '!err';
    fireEvent.input(input);
    expect(container.querySelector('[data-quick-phrase="check errors"]')).toBeTruthy();
    expect(container.querySelector('[data-quick-phrase="inspect errors"]')).toBeTruthy();
    expect(container.querySelector('[data-quick-phrase="custom release checklist"]')).toBeNull();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.textContent).toBe('inspect errors');
    expect(container.querySelector('.controls-slash-picker')).toBeNull();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('does not open command or phrase suggestions when the trigger is not the first character', () => {
    const ws = {
      connected: true,
      send: vi.fn(),
      sendSessionCommand: vi.fn(),
      sendInput: vi.fn(),
      subSessionSetModel: vi.fn(),
      fsListDir: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    } as any;
    const { container } = render(
      <SessionControls
        ws={ws}
        activeSession={makeSession()}
        quickData={makeQuickData()}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );
    const input = screen.getByRole('textbox');

    input.textContent = 'text /co';
    fireEvent.input(input);
    expect(container.querySelector('.controls-slash-picker')).toBeNull();

    input.textContent = 'text !err';
    fireEvent.input(input);
    expect(container.querySelector('.controls-slash-picker')).toBeNull();
  });
});
