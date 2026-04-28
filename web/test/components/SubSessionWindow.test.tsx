/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/TerminalView.js', () => ({
  TerminalView: () => null,
}));

const chatViewPropsSpy = vi.fn();
const floatingPanelPropsSpy = vi.fn();
const fileBrowserPropsSpy = vi.fn();
const defaultUserAgent = navigator.userAgent;

vi.mock('../../src/components/ChatView.js', () => ({
  ChatView: (props: any) => {
    chatViewPropsSpy(props);
    return null;
  },
}));

vi.mock('../../src/components/FloatingPanel.js', () => ({
  FloatingPanel: (props: any) => {
    floatingPanelPropsSpy(props);
    return (
      <div
        data-testid={`floating-panel-${props.id}`}
        data-z-index={props.zIndex}
        data-title={props.title}
        onMouseDown={props.onFocus}
      >
        <button data-testid={`floating-panel-close-${props.id}`} onClick={props.onClose}>close</button>
        {props.children}
      </div>
    );
  },
}));

vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: (props: any) => {
    fileBrowserPropsSpy(props);
    return <button data-testid="file-browser-close" onClick={props.onClose}>file browser</button>;
  },
}));

const sessionControlsSpy = vi.fn((props: any) => (
  <div
    class="controls-wrapper"
    data-testid="session-controls"
    data-model={props.activeSession?.modelDisplay ?? ''}
    data-effort={props.activeSession?.effort ?? ''}
    data-quota={props.activeSession?.quotaLabel ?? ''}
    data-queued={(props.activeSession?.transportPendingMessages ?? []).join('|')}
  />
));
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

const addOptimisticUserMessageSpy = vi.fn();
const markOptimisticFailedSpy = vi.fn();
const retryOptimisticMessageSpy = vi.fn();

vi.mock('../../src/hooks/useTimeline.js', () => ({
  useTimeline: () => ({
    events: timelineEventsMock,
    refreshing: false,
    // Provide the optimistic helpers so the onSend / retry handlers don't
    // blow up when a test triggers user interaction. Real behavior is
    // covered by the useTimeline unit tests.
    addOptimisticUserMessage: addOptimisticUserMessageSpy,
    markOptimisticFailed: markOptimisticFailedSpy,
    retryOptimisticMessage: retryOptimisticMessageSpy,
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

vi.mock('../../src/git-status-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/git-status-store.js')>();
  return {
    ...actual,
    useSharedGitChanges: () => [],
  };
});

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
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: defaultUserAgent });
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

  it('renders session controls directly without a drag wrapper that can swallow interactions', async () => {
    const sub = makeSubSession({
      type: 'claude-code-sdk',
      runtimeType: 'transport' as any,
    } as any);

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
      const controls = container.querySelector('[data-testid="session-controls"]') as HTMLElement | null;
      expect(controls).toBeTruthy();
      expect(controls?.parentElement?.style.cursor).not.toBe('grab');
    });
  });

  it('skips terminal subscription for copilot-sdk sub-sessions when runtimeType is omitted', async () => {
    const sub = makeSubSession({
      type: 'copilot-sdk',
      runtimeType: undefined,
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
      expect(sessionControlsSpy).toHaveBeenCalled();
    });
    expect(ws.subscribeTerminal).not.toHaveBeenCalled();
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

  it('delegates desktop file browser stack identity and callbacks to the child window', async () => {
    const sub = makeSubSession({ id: 'sub-42', cwd: '/work/project' });
    const onDesktopFileBrowserOpen = vi.fn();
    const onDesktopFileBrowserFocus = vi.fn();
    const onDesktopFileBrowserClose = vi.fn();

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
        zIndex={6000}
        onFocus={vi.fn()}
        desktopFileBrowserZIndex={6105}
        onDesktopFileBrowserOpen={onDesktopFileBrowserOpen}
        onDesktopFileBrowserFocus={onDesktopFileBrowserFocus}
        onDesktopFileBrowserClose={onDesktopFileBrowserClose}
        serverId="srv-1"
      />,
    );

    fireEvent.click(screen.getByLabelText('picker.files'));

    await waitFor(() => {
      expect(floatingPanelPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
        id: 'subsession-filebrowser:sub-42',
        zIndex: 6105,
      }));
      expect(fileBrowserPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
        initialPath: '/work/project',
        changesRootPath: '/work/project',
      }));
    });

    expect(onDesktopFileBrowserOpen).toHaveBeenCalled();
    expect(Number(screen.getByTestId('floating-panel-subsession-filebrowser:sub-42').dataset.zIndex)).toBeGreaterThan(6000);

    fireEvent.mouseDown(screen.getByTestId('floating-panel-subsession-filebrowser:sub-42'));
    expect(onDesktopFileBrowserFocus).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('floating-panel-close-subsession-filebrowser:sub-42'));
    expect(onDesktopFileBrowserClose).toHaveBeenCalledTimes(1);
  });

  it('does not synthesize desktop child z-index from the parent fallback', async () => {
    const sub = makeSubSession({ id: 'sub-no-stack', cwd: '/work/project' });

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
        zIndex={6000}
        onFocus={vi.fn()}
        serverId="srv-1"
      />,
    );

    fireEvent.click(screen.getByLabelText('picker.files'));

    await waitFor(() => {
      expect(floatingPanelPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
        id: 'subsession-filebrowser:sub-no-stack',
        zIndex: 6000,
      }));
    });
  });

  it('keeps mobile file browser outside desktop child stack callbacks', async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
    const sub = makeSubSession({ id: 'sub-mobile', cwd: '/work/mobile' });
    const onDesktopFileBrowserOpen = vi.fn();
    const onDesktopFileBrowserFocus = vi.fn();
    const onDesktopFileBrowserClose = vi.fn();

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
        zIndex={6000}
        onFocus={vi.fn()}
        desktopFileBrowserZIndex={6105}
        onDesktopFileBrowserOpen={onDesktopFileBrowserOpen}
        onDesktopFileBrowserFocus={onDesktopFileBrowserFocus}
        onDesktopFileBrowserClose={onDesktopFileBrowserClose}
        serverId="srv-1"
      />,
    );

    fireEvent.click(screen.getByLabelText('picker.files'));

    await waitFor(() => {
      expect(screen.getByTestId('file-browser-close')).toBeTruthy();
    });

    expect(floatingPanelPropsSpy).not.toHaveBeenCalled();
    expect(onDesktopFileBrowserOpen).not.toHaveBeenCalled();
    expect(onDesktopFileBrowserFocus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('file-browser-close'));

    expect(onDesktopFileBrowserClose).not.toHaveBeenCalled();
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
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: defaultUserAgent });
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
    const subBar = document.createElement('div');
    subBar.className = 'subsession-bar';
    Object.defineProperty(subBar, 'offsetHeight', { configurable: true, value: 48 });
    document.body.appendChild(controls);
    document.body.appendChild(subBar);

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
      expect(panel?.style.bottom).toBe('48px');
      expect(panel?.style.height).toContain('48px');
      expect(panel?.style.zIndex).toBe('6000');
    });

    unmount();
    controls.remove();
    subBar.remove();
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
  });

  it('on mobile ignores the sub-window composer controls and reserves space for the main controls', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });

    const mainControls = document.createElement('div');
    mainControls.className = 'controls-wrapper';
    Object.defineProperty(mainControls, 'offsetHeight', { configurable: true, value: 148 });
    const subBar = document.createElement('div');
    subBar.className = 'subsession-bar';
    Object.defineProperty(subBar, 'offsetHeight', { configurable: true, value: 44 });
    document.body.appendChild(mainControls);
    document.body.appendChild(subBar);

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
      const internalControls = container.querySelector('.subsession-window .controls-wrapper') as HTMLElement | null;
      const panel = container.querySelector('.subsession-window') as HTMLElement | null;
      expect(internalControls).toBeTruthy();
      expect(panel?.style.bottom).toBe('44px');
      expect(panel?.style.height).toContain('44px');
    });

    unmount();
    mainControls.remove();
    subBar.remove();
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
  });

  it('on mobile falls back to the main controls height when no external sub-session bar exists', async () => {
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
      expect(panel?.style.bottom).toBe('132px');
      expect(panel?.style.height).toContain('132px');
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

  it('adds optimistic bubbles for transport sub-session window sends', async () => {
    const sub = makeSubSession({ type: 'claude-code-sdk', runtimeType: 'transport' as any } as any);

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

    const controlsProps = sessionControlsSpy.mock.calls.at(-1)?.[0];
    expect(typeof controlsProps?.onSend).toBe('function');

    // Invoke the onSend callback as SessionControls would after a successful
    // session.send dispatch.
    controlsProps.onSend(sub.sessionName, 'hello from sub', {
      commandId: 'cmd-sub-42',
      attachments: [{ kind: 'file', name: 'a.txt' }],
      extra: { foo: 'bar' },
    });

    expect(addOptimisticUserMessageSpy).toHaveBeenCalledWith('hello from sub', 'cmd-sub-42', {
      attachments: [{ kind: 'file', name: 'a.txt' }],
      resendExtra: { foo: 'bar' },
    });
  });

  it('keeps a new optimistic bubble visible when retrying a failed transport window send', async () => {
    // Also a regression: the failed optimistic bubble in a sub-session had no
    // retry button because onResendFailed was never threaded through to
    // ChatView. Transport retries must also create a fresh local bubble instead
    // of removing the failed bubble and leaving the user with no visible state.
    timelineEventsMock = [{
      eventId: 'failed-window-send',
      type: 'user.message',
      payload: {
        text: 'retry from window',
        failed: true,
        commandId: 'old-window-cmd',
        _resendExtra: { mode: 'quick' },
        attachments: [{ kind: 'file', name: 'notes.md' }],
      },
    }];
    const sub = makeSubSession({ type: 'claude-code-sdk', runtimeType: 'transport' as any } as any);
    const retryWs = { ...ws, sendSessionCommand: vi.fn() } as any;
    render(
      <SubSessionWindow
        sub={sub}
        ws={retryWs}
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

    const chatCall = chatViewPropsSpy.mock.calls.at(-1)?.[0] as { onResendFailed?: (commandId: string, text: string) => void };
    expect(typeof chatCall.onResendFailed).toBe('function');

    chatCall.onResendFailed?.('old-window-cmd', 'retry from window');

    expect(retryWs.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      sessionName: sub.sessionName,
      text: 'retry from window',
      mode: 'quick',
    }));
    expect(retryOptimisticMessageSpy).toHaveBeenCalledWith(
      'old-window-cmd',
      expect.any(String),
      'retry from window',
      {
        attachments: [{ kind: 'file', name: 'notes.md' }],
        resendExtra: { mode: 'quick' },
      },
    );
  });
});
