/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/TerminalView.js', () => ({
  TerminalView: () => null,
}));

vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => <div data-testid="file-browser-stub" />,
}));

const chatViewPropsSpy = vi.fn();

vi.mock('../../src/components/ChatView.js', () => ({
  ChatView: (props: any) => {
    chatViewPropsSpy(props);
    return null;
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
const usageFooterSpy = vi.fn((props: any) => (
  <div
    data-testid="usage-footer"
    data-quota={props.quotaLabel ?? ''}
    data-state={props.sessionState ?? ''}
    data-model={props.modelOverride ?? ''}
    data-pending-user-send={String(!!props.pendingUserSend)}
  />
));
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
  getTailSessionStateInfo: (events: Array<{ type: string; ts?: number; payload?: Record<string, unknown> }>) => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'session.state') {
        return { state: String(events[i].payload?.state ?? ''), ts: events[i].ts ?? null };
      }
    }
    return { state: null, ts: null };
  },
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
const loadOlderEventsSpy = vi.fn();

vi.mock('../../src/hooks/useTimeline.js', () => ({
  requestActiveTimelineRefreshAfterUserAction: vi.fn(),
  useTimeline: () => ({
    events: timelineEventsMock,
    refreshing: false,
    // Provide the optimistic helpers so the onSend / retry handlers don't
    // blow up when a test triggers user interaction. Real behavior is
    // covered by the useTimeline unit tests.
    addOptimisticUserMessage: addOptimisticUserMessageSpy,
    markOptimisticFailed: markOptimisticFailedSpy,
    retryOptimisticMessage: retryOptimisticMessageSpy,
    // Older-history pagination — must be forwarded to ChatView so scroll-to-top loads history.
    loadingOlder: false,
    hasOlderHistory: true,
    loadOlderEvents: loadOlderEventsSpy,
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

function rectWithBottom(bottom: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: bottom,
    top: 0,
    right: 0,
    bottom,
    left: 0,
    toJSON: () => ({}),
  };
}

function rectAt(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    width: 320,
    height,
    top,
    right: 320,
    bottom: top + height,
    left: 0,
    toJSON: () => ({}),
  };
}

function setElementRect(el: HTMLElement, top: number, height: number): void {
  el.getBoundingClientRect = () => rectAt(top, height);
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

  it('projects canonical peer-audit identity/model metadata into SessionControls', () => {
    render(
      <SubSessionWindow
        sub={makeSubSession({
          type: 'codex-sdk',
          sessionInstanceId: 'window-instance-1',
          runtimeEpoch: 'window-runtime-1',
          activeModel: 'gpt-5.6',
          providerId: 'openai',
        })}
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
    const props = sessionControlsSpy.mock.calls.at(-1)?.[0];
    expect(props.activeSession).toMatchObject({
      name: 'deck_sub_sub-1',
      sessionInstanceId: 'window-instance-1',
      runtimeEpoch: 'window-runtime-1',
      activeModel: 'gpt-5.6',
      providerId: 'openai',
    });
  });

  it('exposes the accent color as a CSS variable on the window root', () => {
    const { container } = render(
      <SubSessionWindow
        sub={makeSubSession()}
        ws={ws}
        connected={true}
        active={true}
        accentColor="#34d399"
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

    const root = container.querySelector('.subsession-window') as HTMLElement;
    expect(root.style.getPropertyValue('--subsession-accent-color')).toBe('#34d399');
  });

  it('focuses an inactive desktop window before allowing hide/minimize actions', () => {
    const onFocus = vi.fn();
    const onMinimize = vi.fn();
    const view = render(
      <SubSessionWindow
        sub={makeSubSession()}
        ws={ws}
        connected={true}
        active={false}
        desktopLayoutCapable={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        onMinimize={onMinimize}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRename={vi.fn()}
        zIndex={1}
        onFocus={onFocus}
      />,
    );

    const root = view.container.querySelector('.subsession-window') as HTMLElement;
    expect(root.className).not.toContain('subsession-window-active');

    fireEvent.mouseDown(view.container.querySelector('button[aria-label="window.hide"]') as HTMLButtonElement);

    expect(onFocus).toHaveBeenCalledOnce();
    expect(onMinimize).not.toHaveBeenCalled();

    view.rerender(
      <SubSessionWindow
        sub={makeSubSession()}
        ws={ws}
        connected={true}
        active={true}
        desktopLayoutCapable={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        onMinimize={onMinimize}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRename={vi.fn()}
        zIndex={1}
        onFocus={onFocus}
      />,
    );

    expect((view.container.querySelector('.subsession-window') as HTMLElement).className).toContain('subsession-window-active');
    fireEvent.click(view.container.querySelector('button[aria-label="window.hide"]') as HTMLButtonElement);
    expect(onMinimize).not.toHaveBeenCalled();

    fireEvent.click(view.container.querySelector('button[aria-label="window.hide"]') as HTMLButtonElement);
    expect(onMinimize).toHaveBeenCalledOnce();
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

  it('passes streaming assistant text through to the sub-session window ChatView', async () => {
    timelineEventsMock = [{
      eventId: 'stream-1',
      sessionId: 'deck_sub_sub-1',
      type: 'assistant.text',
      payload: { text: 'window partial stream', streaming: true },
    }];

    render(
      <SubSessionWindow
        sub={makeSubSession({
          type: 'codex-sdk',
          runtimeType: 'transport' as any,
          state: 'running',
        } as any)}
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
      const props = chatViewPropsSpy.mock.calls.at(-1)?.[0];
      expect(props.events).toEqual(timelineEventsMock);
      expect(props.events[0].payload).toMatchObject({ text: 'window partial stream', streaming: true });
    });
  });

  it('forwards a pending optimistic send for immediate sub-session status feedback', async () => {
    timelineEventsMock = [
      { eventId: 'idle', sessionId: 'deck_sub_sub-1', ts: 1, type: 'session.state', payload: { state: 'idle' } },
      { eventId: 'pending', sessionId: 'deck_sub_sub-1', ts: 2, type: 'user.message', payload: { text: 'just sent', pending: true, commandId: 'cmd-now' } },
    ];

    render(
      <SubSessionWindow
        sub={makeSubSession({
          type: 'codex-sdk',
          runtimeType: 'transport' as any,
          state: 'idle',
        } as any)}
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
      expect(footer?.dataset.pendingUserSend).toBe('true');
    });
  });

  it('forwards older-history pagination (onLoadOlder / hasOlderHistory / loadingOlder) to the ChatView', async () => {
    // Regression: the sub-session window never forwarded these, so ChatView's
    // scroll-to-top loader no-op'd and older history could not be loaded in a
    // sub-session (it worked in the main SessionPane, which does forward them).
    render(
      <SubSessionWindow
        sub={makeSubSession({
          type: 'codex-sdk',
          runtimeType: 'transport' as any,
          state: 'running',
        } as any)}
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
      const props = chatViewPropsSpy.mock.calls.at(-1)?.[0];
      expect(props.onLoadOlder).toBe(loadOlderEventsSpy);
      expect(props.hasOlderHistory).toBe(true);
      expect(props.loadingOlder).toBe(false);
    });
  });

  it('keeps the usage footer mounted for idle-looking agent sub-sessions without usage', async () => {
    const sub = makeSubSession({
      type: 'codex-sdk',
      runtimeType: 'transport' as any,
      state: 'stopped',
      modelDisplay: undefined,
      quotaLabel: undefined,
      planLabel: undefined,
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
      expect(footer?.dataset.state).toBe('stopped');
    });
  });

  it('passes detected timeline model to the usage footer when session metadata has no modelDisplay', async () => {
    timelineEventsMock = [
      { type: 'usage.update', payload: { model: 'gpt-5.5' } },
    ];
    const sub = makeSubSession({
      type: 'codex-sdk',
      runtimeType: 'transport' as any,
      state: 'idle',
      modelDisplay: undefined,
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
      expect(footer?.dataset.model).toBe('gpt-5.5');
    });
  });

  it('passes active/requested transport model to the usage footer before timeline fallback', async () => {
    timelineEventsMock = [
      { type: 'usage.update', payload: { inputTokens: 1, cacheTokens: 0, contextWindow: 258_400 } },
    ];
    const sub = makeSubSession({
      type: 'codex-sdk',
      runtimeType: 'transport' as any,
      state: 'idle',
      activeModel: 'gpt-5.5',
      requestedModel: 'gpt-5.4',
      modelDisplay: undefined,
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
      expect(footer?.dataset.model).toBe('gpt-5.5');
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

  it('uses authoritative outer idle when stale timeline running has no active work', async () => {
    timelineEventsMock = [
      { type: 'session.state', payload: { state: 'running' } },
      { type: 'assistant.text', payload: { text: 'done', streaming: false } },
      { type: 'usage.update', payload: { inputTokens: 1, outputTokens: 1 } },
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
      expect(footer?.dataset.state).toBe('idle');
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
  const releaseHold = vi.fn();
  const ws = {
    subscribeTerminal: vi.fn(),
    unsubscribeTerminal: vi.fn(),
    holdTerminalRaw: vi.fn(() => releaseHold),
    sendSnapshotRequest: vi.fn(),
    sendResize: vi.fn(),
  } as any;

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    document.documentElement.classList.remove('kb-open', 'input-focused');
    document.querySelectorAll('.tab-bar').forEach((node) => node.remove());
  });

  it('on mobile only reserves the bottom sub-session button bar below the sub-session window', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
    const viewportHeight = window.innerHeight;
    const controls = document.createElement('div');
    controls.className = 'controls-wrapper';
    Object.defineProperty(controls, 'offsetHeight', { configurable: true, value: 132 });
    const subCardBar = document.createElement('div');
    subCardBar.className = 'subcard-bar';
    Object.defineProperty(subCardBar, 'offsetHeight', { configurable: true, value: 88 });
    setElementRect(subCardBar, viewportHeight - 88, 88);
    setElementRect(controls, viewportHeight - 132, 132);
    document.body.appendChild(controls);
    document.body.appendChild(subCardBar);

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

    const initialPanel = container.querySelector('.subsession-window') as HTMLElement | null;
    expect(initialPanel?.style.bottom).toBe('88px');
    expect(initialPanel?.style.height).toContain('88px');

    await waitFor(() => {
      const panel = container.querySelector('.subsession-window') as HTMLElement | null;
      expect(panel).toBeTruthy();
      expect(panel?.style.bottom).toBe('88px');
      expect(panel?.style.height).toContain('88px');
      expect(panel?.style.zIndex).toBe('6000');
    });

    unmount();
    controls.remove();
    subCardBar.remove();
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
  });

  it('on mobile ignores both main and sub-window composer controls when reserving bottom space', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
    const viewportHeight = window.innerHeight;

    const mainControls = document.createElement('div');
    mainControls.className = 'controls-wrapper';
    Object.defineProperty(mainControls, 'offsetHeight', { configurable: true, value: 148 });
    const subCardBar = document.createElement('div');
    subCardBar.className = 'subcard-bar';
    Object.defineProperty(subCardBar, 'offsetHeight', { configurable: true, value: 72 });
    setElementRect(subCardBar, viewportHeight - 72, 72);
    setElementRect(mainControls, viewportHeight - 148, 148);
    document.body.appendChild(mainControls);
    document.body.appendChild(subCardBar);

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
      expect(panel?.style.bottom).toBe('72px');
      expect(panel?.style.height).toContain('72px');
    });

    unmount();
    mainControls.remove();
    subCardBar.remove();
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
  });

  it('on mobile does not reserve main controls height when no external sub-session bar exists', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
    const viewportHeight = window.innerHeight;
    const controls = document.createElement('div');
    controls.className = 'controls-wrapper';
    Object.defineProperty(controls, 'offsetHeight', { configurable: true, value: 132 });
    setElementRect(controls, viewportHeight - 132, 132);
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
      expect(panel?.style.bottom).toBe('0px');
      expect(panel?.style.height).toContain('0px');
    });

    unmount();
    controls.remove();
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
  });

  it('on mobile releases the sub-session bar reserve when the keyboard hides that bar', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
    const viewportHeight = window.innerHeight;
    let subCardBarTop = viewportHeight - 88;
    let subCardBarHeight = 88;
    const subCardBar = document.createElement('div');
    subCardBar.className = 'subcard-bar';
    Object.defineProperty(subCardBar, 'offsetHeight', { configurable: true, get: () => subCardBarHeight });
    subCardBar.getBoundingClientRect = () => rectAt(subCardBarTop, subCardBarHeight);
    document.body.appendChild(subCardBar);

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
      expect(panel?.style.bottom).toBe('88px');
    });

    subCardBarTop = 0;
    subCardBarHeight = 0;
    document.documentElement.classList.add('input-focused');
    window.dispatchEvent(new Event('resize'));

    await waitFor(() => {
      const panel = container.querySelector('.subsession-window') as HTMLElement | null;
      expect(panel?.style.bottom).toBe('0px');
      expect(panel?.style.height).toContain('0px');
    });

    unmount();
    subCardBar.remove();
    document.documentElement.classList.remove('input-focused');
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
      expect(panel?.style.left).toBe(`${window.innerWidth - 620}px`);
      expect(panel?.style.top).toBe(`${window.innerHeight - 100 - 480}px`);
    });
  });

  it('clamps upward drag to the session tab button bottom', async () => {
    const tabBar = document.createElement('div');
    tabBar.className = 'tab-bar';
    const tabButton = document.createElement('button');
    tabButton.setAttribute('role', 'tab');
    tabButton.getBoundingClientRect = () => rectWithBottom(44);
    tabBar.appendChild(tabButton);
    document.body.appendChild(tabBar);
    localStorage.setItem('rcc_subsession_sub-1', JSON.stringify({
      geom: { x: 100, y: 120, w: 620, h: 480 },
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

    const header = container.querySelector('.subsession-header') as HTMLElement | null;
    expect(header).toBeTruthy();
    fireEvent.mouseDown(header!, { clientX: 160, clientY: 130 });
    fireEvent.mouseMove(document, { clientX: 160, clientY: -200 });
    fireEvent.mouseUp(document);

    await waitFor(() => {
      const panel = container.querySelector('.subsession-window') as HTMLElement | null;
      expect(panel?.style.top).toBe('44px');
    });

    tabBar.remove();
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
      expect(panel?.style.width).toBe('620px');
      expect(panel?.style.height).toBe('620px');
      expect(panel?.style.zIndex).toBe('6000');
    });
  });

  it('clamps persisted desktop geometry to a minimum 600x400 window', async () => {
    localStorage.setItem('rcc_subsession_sub-1', JSON.stringify({
      geom: { x: 120, y: 80, w: 120, h: 60 },
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
        zIndex={6000}
        onFocus={vi.fn()}
      />,
    );

    await waitFor(() => {
      const panel = container.querySelector('.subsession-window') as HTMLElement | null;
      expect(panel).toBeTruthy();
      expect(panel?.style.width).toBe('600px');
      expect(panel?.style.height).toBe('400px');
    });
  });

  it('holds the shell window raw stream for its whole lifetime, regardless of focus', async () => {
    // Regression: an open shell window that lost focus used to unsubscribe and
    // freeze. It must now keep the raw PTY stream HELD the whole time it is open
    // (users pin one to the side to observe), via the ref-counted holdTerminalRaw.
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

    // Held immediately even though inactive; shell no longer uses the focus-gated
    // base subscribe, and the hold is not released while mounted.
    await waitFor(() => {
      expect(ws.holdTerminalRaw).toHaveBeenCalledWith(sub.sessionName);
    });
    expect(ws.holdTerminalRaw).toHaveBeenCalledTimes(1);
    expect(ws.subscribeTerminal).not.toHaveBeenCalled();
    expect(releaseHold).not.toHaveBeenCalled();

    // Toggling focus must NOT re-hold or release — the hold is focus-independent.
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
    expect(ws.holdTerminalRaw).toHaveBeenCalledTimes(1);
    expect(releaseHold).not.toHaveBeenCalled();

    // Closing the window releases the hold (server stops streaming when the last
    // holder unmounts).
    view.unmount();
    await waitFor(() => {
      expect(releaseHold).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps non-shell windows passively subscribed when inactive', async () => {
    const sub = makeSubSession({ type: 'codex', shellBin: null });

    render(
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

  it('passes active timeline turn state into sub-session controls', async () => {
    timelineEventsMock = [{
      eventId: 'sub-running-state',
      type: 'session.state',
      ts: 10,
      payload: { state: 'running' },
    }];
    const sub = makeSubSession({ type: 'claude-code-sdk', runtimeType: 'transport' as any, state: 'idle' } as any);

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
    expect(controlsProps?.activeTransportTurn).toBe(true);
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

describe('SubSessionWindow desktop file-browser stack integration', () => {
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

  it('uses desktopFileBrowserZIndex for the floating child file-browser when supplied', async () => {
    const sub = makeSubSession({ type: 'claude-code-sdk', runtimeType: 'transport' as any } as any);
    const { container, rerender } = render(
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
        zIndex={5010}
        desktopFileBrowserZIndex={5777}
        onDesktopFileBrowserOpen={vi.fn()}
        onDesktopFileBrowserClose={vi.fn()}
        onDesktopFileBrowserFocus={vi.fn()}
        onFocus={vi.fn()}
      />,
    );
    // Click the file-browser toggle button (📁 in the header) to open it.
    const toggle = container.querySelector('button[title="picker.files"]') as HTMLButtonElement | null;
    expect(toggle).toBeTruthy();
    toggle!.click();
    await waitFor(() => {
      const fbPanel = document.querySelector(`[data-testid="floating-panel-subsession-filebrowser:${sub.id}"]`) as HTMLElement | null;
      expect(fbPanel).toBeTruthy();
      expect(fbPanel?.style.zIndex).toBe('5777');
    });
    // Re-render with no override → fallback to zIndex+1 path.
    rerender(
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
        zIndex={5010}
        onFocus={vi.fn()}
      />,
    );
  });

  it('fires onDesktopFileBrowserOpen on open and onDesktopFileBrowserClose on close (desktop only)', async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const onFocus = vi.fn();
    const sub = makeSubSession({ type: 'claude-code-sdk', runtimeType: 'transport' as any } as any);
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
        zIndex={5010}
        onFocus={vi.fn()}
        onDesktopFileBrowserOpen={onOpen}
        onDesktopFileBrowserClose={onClose}
        onDesktopFileBrowserFocus={onFocus}
      />,
    );
    // The mount-time effect should fire onClose once (showFileBrowser starts false).
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    onClose.mockClear();
    onOpen.mockClear();

    const toggle = container.querySelector('button[title="picker.files"]') as HTMLButtonElement | null;
    toggle!.click();
    await waitFor(() => {
      expect(onOpen).toHaveBeenCalled();
    });

    toggle!.click(); // close again
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
