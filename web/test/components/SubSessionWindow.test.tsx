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

const sessionControlsSpy = vi.fn((props: any) => <div data-testid="session-controls" data-model={props.activeSession?.modelDisplay ?? ''} data-effort={props.activeSession?.effort ?? ''} data-quota={props.activeSession?.quotaLabel ?? ''} data-queued={(props.activeSession?.transportPendingMessages ?? []).join('|')} />);
const usageFooterSpy = vi.fn((props: any) => <div data-testid="usage-footer" data-quota={props.quotaLabel ?? ''} data-state={props.sessionState ?? ''} />);
let timelineEventsMock: any[] = [];
let activeToolCallMock = false;

vi.mock('../../src/components/SessionControls.js', () => ({
  SessionControls: (props: any) => sessionControlsSpy(props),
}));

vi.mock('../../src/components/UsageFooter.js', () => ({
  UsageFooter: (props: any) => usageFooterSpy(props),
}));

vi.mock('../../src/thinking-utils.js', () => ({
  getActiveThinkingTs: () => null,
  getActiveStatusText: () => null,
  hasActiveToolCall: () => activeToolCallMock,
  getTailSessionState: (events: Array<{ type: string; payload?: Record<string, unknown> }>) => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'session.state') return String(events[i].payload?.state ?? '');
    }
    return null;
  },
}));

vi.mock('../../src/hooks/useTimeline.js', () => ({
  useTimeline: () => ({
    events: timelineEventsMock,
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


describe('SubSessionWindow metadata wiring', () => {
  const ws = {
    subscribeTerminal: vi.fn(),
    unsubscribeTerminal: vi.fn(),
    sendSnapshotRequest: vi.fn(),
    sendResize: vi.fn(),
  } as any;

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    timelineEventsMock = [];
    activeToolCallMock = false;
  });

  it('passes model, level, and quota metadata through for transport sub-sessions', async () => {
    const sub = makeSubSession({
      type: 'codex-sdk',
      runtimeType: 'transport' as any,
      label: 'codex-sub',
      effort: 'high' as any,
      modelDisplay: 'gpt-5.4',
      quotaLabel: '5h 11% 2h03m 4/6 14:40 · 7d 50% 1d04h 4/8 15:48',
      planLabel: 'Pro',
    } as any);

    render(
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
      const controls = document.querySelector('[data-testid="session-controls"]') as HTMLElement | null;
      const footer = document.querySelector('[data-testid="usage-footer"]') as HTMLElement | null;
      expect(controls?.dataset.model).toBe('gpt-5.4');
      expect(controls?.dataset.effort).toBe('high');
      expect(controls?.dataset.quota).toContain('5h 11%');
      expect(footer?.dataset.quota).toContain('5h 11%');
    });
  });

  it('passes queued transport messages through to shared session controls for sub-sessions', async () => {
    const sub = makeSubSession({
      type: 'claude-code-sdk',
      runtimeType: 'transport' as any,
      transportPendingMessages: ['queued one', 'queued two'],
    } as any);

    render(
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
      const controls = document.querySelector('[data-testid="session-controls"]') as HTMLElement | null;
      expect(controls?.dataset.queued).toBe('queued one|queued two');
    });
  });

  it('prefers timeline tail running state over stale outer idle state for footer status', async () => {
    timelineEventsMock = [
      { type: 'session.state', payload: { state: 'running' } },
      { type: 'tool.result', payload: { ok: true } },
    ];

    const sub = makeSubSession({
      type: 'codex-sdk',
      runtimeType: 'transport' as any,
      state: 'idle',
    } as any);

    render(
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
      const footer = document.querySelector('[data-testid="usage-footer"]') as HTMLElement | null;
      expect(footer?.dataset.state).toBe('running');
    });
  });

  it('keeps footer visible while a tool call is active even without usage or running state', async () => {
    activeToolCallMock = true;

    const sub = makeSubSession({
      type: 'codex-sdk',
      runtimeType: 'transport' as any,
      state: null,
    } as any);

    render(
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
      expect(document.querySelector('[data-testid="usage-footer"]')).toBeTruthy();
    });
  });
});

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
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('on mobile leaves the main controls area visible below the sub-session window', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
    const controls = document.createElement('div');
    controls.className = 'controls-wrapper';
    Object.defineProperty(controls, 'offsetHeight', { configurable: true, value: 132 });
    document.body.appendChild(controls);

    const sub = makeSubSession();
    const { container, unmount } = render(
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
        zIndex={6000}
        onFocus={vi.fn()}
      />,
    );

    await waitFor(() => {
      const panel = container.querySelector('.subsession-window') as HTMLElement | null;
      expect(panel).toBeTruthy();
      expect(panel?.style.bottom).toBe('132px');
      expect(panel?.style.height).toContain('132px');
      expect(panel?.style.zIndex).toBe('6000');
    });

    unmount();
    controls.remove();
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
  });


  it('clamps a persisted off-screen window back into the visible viewport', async () => {
    localStorage.setItem('rcc_subsession_sub-1', JSON.stringify({
      geom: { x: 5000, y: 5000, w: 620, h: 480 },
      viewMode: 'chat',
    }));

    const sub = makeSubSession();
    const { container } = render(
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
      const panel = container.querySelector('.subsession-window') as HTMLElement | null;
      expect(panel).toBeTruthy();
      expect(panel?.style.left).toBe(`${window.innerWidth - 32}px`);
      expect(panel?.style.top).toBe(`${window.innerHeight - 32}px`);
    });
  });

  it('uses the taller default desktop height for new sub-session windows', async () => {
    localStorage.removeItem('rcc_subsession_sub-1');

    const sub = makeSubSession();
    const { container } = render(
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
        zIndex={6000}
        onFocus={vi.fn()}
      />,
    );

    await waitFor(() => {
      const panel = container.querySelector('.subsession-window') as HTMLElement | null;
      expect(panel).toBeTruthy();
      expect(panel?.style.height).toBe('620px');
      expect(panel?.style.zIndex).toBe('6000');
    });
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

  it('does not replay an existing idle flash token when the window remounts', async () => {
    const sub = makeSubSession();
    const first = render(
      <SubSessionWindow
        sub={sub}
        ws={ws}
        connected={true}
        active={true}
        idleFlashToken={4}
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
    expect(first.container.querySelector('.idle-flash-layer--frame')).toBeNull();
    first.unmount();

    const second = render(
      <SubSessionWindow
        sub={sub}
        ws={ws}
        connected={true}
        active={true}
        idleFlashToken={4}
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

    expect(second.container.querySelector('.idle-flash-layer--frame')).toBeNull();

    second.rerender(
      <SubSessionWindow
        sub={sub}
        ws={ws}
        connected={true}
        active={true}
        idleFlashToken={5}
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

    expect(second.container.querySelector('.idle-flash-layer--frame')).not.toBeNull();
  });

  it('does not replay the idle flash when the window is re-activated with the same token', async () => {
    const sub = makeSubSession();
    const view = render(
      <SubSessionWindow
        sub={sub}
        ws={ws}
        connected={true}
        active={true}
        idleFlashToken={4}
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

    view.rerender(
      <SubSessionWindow
        sub={sub}
        ws={ws}
        connected={true}
        active={true}
        idleFlashToken={5}
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

    expect(view.container.querySelector('.idle-flash-layer--frame')).not.toBeNull();

    vi.advanceTimersByTime(2800);

    await waitFor(() => {
      expect(view.container.querySelector('.idle-flash-layer--frame')).toBeNull();
    });

    view.rerender(
      <SubSessionWindow
        sub={sub}
        ws={ws}
        connected={true}
        active={false}
        idleFlashToken={5}
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

    view.rerender(
      <SubSessionWindow
        sub={sub}
        ws={ws}
        connected={true}
        active={true}
        idleFlashToken={5}
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

    expect(view.container.querySelector('.idle-flash-layer--frame')).toBeNull();
  });
});
