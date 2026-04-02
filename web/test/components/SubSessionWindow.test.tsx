/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, render, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/TerminalView.js', () => ({
  TerminalView: () => null,
}));

vi.mock('../../src/components/ChatView.js', () => ({
  ChatView: () => null,
}));

vi.mock('../../src/components/SessionControls.js', () => ({
  SessionControls: () => null,
}));

vi.mock('../../src/components/UsageFooter.js', () => ({
  UsageFooter: () => null,
}));

vi.mock('../../src/hooks/useTimeline.js', () => ({
  useTimeline: () => ({
    events: [],
    refreshing: false,
  }),
}));

vi.mock('../../src/hooks/useSwipeBack.js', () => ({
  useSwipeBack: () => ({ current: null }),
}));

vi.mock('../../src/components/QuickInputPanel.js', () => ({
  useQuickData: () => ({
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
  }),
}));

import { SubSessionWindow } from '../../src/components/SubSessionWindow.js';
import type { SubSession } from '../../src/hooks/useSubSessions.js';

function makeSubSession(overrides: Partial<SubSession> = {}): SubSession {
  return {
    id: 'sub-1',
    serverId: 'srv-1',
    type: 'shell',
    shellBin: '/bin/bash',
    cwd: '/tmp',
    ccSessionId: null,
    geminiSessionId: null,
    parentSession: 'deck_myapp_brain',
    label: 'worker',
    ccPresetId: null,
    sessionName: 'deck_sub_sub-1',
    state: 'running',
    ...overrides,
  };
}

describe('SubSessionWindow terminal subscription raw mode', () => {
  const ws = {
    subscribeTerminal: vi.fn(),
    unsubscribeTerminal: vi.fn(),
    sendSnapshotRequest: vi.fn(),
    sendResize: vi.fn(),
  } as any;

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('subscribes raw=false when minimized, upgrades to raw=true when active, and downgrades back to raw=false', async () => {
    const sub = makeSubSession();

    const view = render(
      <SubSessionWindow
        sub={sub}
        ws={ws}
        connected={true}
        active={false}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        onMinimize={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRename={vi.fn()}
        zIndex={1}
        onFocus={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(ws.subscribeTerminal).toHaveBeenCalledWith(sub.sessionName, false);
    });

    view.rerender(
      <SubSessionWindow
        sub={sub}
        ws={ws}
        connected={true}
        active={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        onMinimize={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRename={vi.fn()}
        zIndex={1}
        onFocus={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(ws.subscribeTerminal).toHaveBeenCalledWith(sub.sessionName, true);
    });

    view.rerender(
      <SubSessionWindow
        sub={sub}
        ws={ws}
        connected={true}
        active={false}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        onMinimize={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRename={vi.fn()}
        zIndex={1}
        onFocus={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(ws.subscribeTerminal.mock.calls.at(-1)).toEqual([sub.sessionName, false]);
    });
  });
});
