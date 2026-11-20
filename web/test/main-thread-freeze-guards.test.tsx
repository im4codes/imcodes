/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_SCHEMA_VERSION,
  SDK_SUBAGENT_STATUS,
} from '../../shared/sdk-subagent-status.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && typeof opts === 'object' && 'duration' in opts ? `${key}:${String(opts.duration)}` : key,
  }),
}));

vi.mock('../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock('../src/components/file-browser-lazy.js', () => ({
  FileBrowser: () => null,
}));

vi.mock('../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

vi.mock('../src/components/TerminalView.js', () => ({
  TerminalView: () => null,
}));

vi.mock('../src/components/SessionControls.js', () => ({
  SessionControls: () => <div data-testid="session-controls" />,
}));

vi.mock('../src/components/UsageFooter.js', () => ({
  UsageFooter: () => <div data-testid="usage-footer" />,
}));

vi.mock('../src/hooks/useSwipeBack.js', () => ({
  useSwipeBack: () => ({ current: null }),
}));

vi.mock('../src/components/QuickInputPanel.js', () => ({
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

vi.mock('../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: false,
    rawValue: false,
    loaded: true,
    loading: false,
    stale: false,
    error: null,
    save: async () => undefined,
    set: () => undefined,
    reload: async () => true,
  }),
}));

import { useNowTicker } from '../src/hooks/useNowTicker.js';
import { TaskPairStatusPanel, collapsedStorageKey } from '../src/components/TaskPairStatusPanel.js';
import { ChatView } from '../src/components/ChatView.js';
import { SubSessionWindow } from '../src/components/SubSessionWindow.js';
import {
  extractChatFileReferences,
  extractMarkdownLocalFileDestinations,
  findChatFileReferencesInText,
  normalizeLocalMarkdownDestinations,
} from '../../shared/chat-local-path.js';
import { splitTextByCloudDocQuoteTags } from '../src/cloud-docs-reference.js';

describe('main-thread freeze guards & timer/observer gating', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    delete (window as { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot;
    delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('useNowTicker pauses while document is hidden, refreshes immediately on visible, and cleans up visibility listener', () => {
    vi.useFakeTimers();
    const start = 1_000_000;
    vi.setSystemTime(start);

    let visibilityState: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    });
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const values: number[] = [];
    function TickerHarness({ active }: { active: boolean }) {
      const now = useNowTicker(active, 1000);
      values.push(now);
      return <span data-testid="now">{now}</span>;
    }

    const view = render(<TickerHarness active={true} />);
    expect(values[values.length - 1]).toBe(start);
    expect(addSpy.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(values[values.length - 1]).toBe(start + 2000);

    // Hide document -> 0 ticks over 10s
    const countBeforeHide = values.length;
    visibilityState = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(10_000);
    });
    expect(values.length).toBe(countBeforeHide);

    // Become visible again -> emits immediate fresh tick and resumes 1Hz interval
    visibilityState = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(values[values.length - 1]).toBe(start + 12_000);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(values[values.length - 1]).toBe(start + 13_000);

    view.unmount();
    expect(removeSpy.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(true);
  });

  it('TaskPairStatusPanel stops 1Hz ticking when collapsed, hidden, or terminal-only and refreshes immediately when expanded/shown', () => {
    vi.useFakeTimers();
    const t0 = 5_000_000;
    vi.setSystemTime(t0);

    const activeEvents = [
      {
        eventId: 'tp-active-1',
        type: 'task_pair.event',
        ts: t0,
        sessionId: 'deck_brain',
        source: 'daemon',
        confidence: 'high',
        payload: {
          taskId: 'tsk_active_1',
          title: 'Active task',
          toStatus: 'working',
          round: 1,
        },
      },
    ] as any[];

    // Start collapsed in desktop localStorage
    localStorage.setItem(collapsedStorageKey(undefined, false), '1');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const get1HzCalls = () => setIntervalSpy.mock.calls.filter(([, ms]) => ms === 1000);
    const { container, rerender } = render(
      <TaskPairStatusPanel events={activeEvents} visible={true} />,
    );
    expect(get1HzCalls()).toHaveLength(0);

    // Advance 30s while collapsed -> no interval ticks; then expand -> immediate fresh duration ("30s"), no stale "0s"
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(get1HzCalls()).toHaveLength(0);

    fireEvent.click(container.querySelector('.task-pair-status-toggle')!);
    expect(container.textContent).toContain('30');
    expect(get1HzCalls()).toHaveLength(1);

    // Hide panel (visible={false}) -> timer stops; advance 20s -> still 0 extra ticks; show again -> immediate "50s"
    setIntervalSpy.mockClear();
    rerender(<TaskPairStatusPanel events={activeEvents} visible={false} />);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(get1HzCalls()).toHaveLength(0);

    rerender(<TaskPairStatusPanel events={activeEvents} visible={true} />);
    expect(container.textContent).toContain('50');

    // Terminal-only rows -> 0 interval ticks
    setIntervalSpy.mockClear();
    const terminalEvents = [
      {
        ...activeEvents[0],
        eventId: 'tp-done-1',
        ts: t0 + 50_000,
        payload: {
          ...activeEvents[0].payload,
          toStatus: 'done',
          finishedAt: t0 + 50_000,
        },
      },
    ] as any[];
    rerender(<TaskPairStatusPanel events={terminalEvents} visible={true} />);
    setIntervalSpy.mockClear();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(get1HzCalls()).toHaveLength(0);
  });

  it('ChatView sdkAgentsNow skips 1Hz ticking when no agent is running or pane is closed/hidden, and CollapsibleUserMessage skips ResizeObserver when hardLineOverflow or hidden', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let resizeObserverCount = 0;
    class CountingResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor() {
        resizeObserverCount += 1;
      }
    }
    vi.stubGlobal('ResizeObserver', CountingResizeObserver);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const get1HzCalls = () => setIntervalSpy.mock.calls.filter(([, ms]) => ms === 1000);

    const completedAgentEvent = {
      eventId: 'sdk-done-1',
      sessionId: 'deck_sdk',
      ts: 10_000,
      seq: 1,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'tool.result',
      hidden: true,
      payload: {
        tool: 'Agent',
        detail: {
          kind: SDK_SUBAGENT_DETAIL_KIND,
          meta: {
            isSdkSubagent: true,
            schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
            provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
            providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
            canonicalKey: 'claude:deck_sdk:task-done',
            normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
            active: false,
            terminal: true,
            taskId: 'task-done',
          },
        },
      },
    };
    const runningAgentEvent = {
      ...completedAgentEvent,
      eventId: 'sdk-run-1',
      type: 'tool.call',
      payload: {
        tool: 'Agent',
        detail: {
          kind: SDK_SUBAGENT_DETAIL_KIND,
          meta: {
            isSdkSubagent: true,
            schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
            provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
            providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
            canonicalKey: 'claude:deck_sdk:task-run',
            normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
            active: true,
            terminal: false,
            taskId: 'task-run',
          },
        },
      },
    };
    const hardOverflowMsg = {
      eventId: 'user-long',
      sessionId: 'deck_sdk',
      ts: 10_001,
      seq: 2,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'user.message',
      payload: { text: Array.from({ length: 14 }, (_, i) => `line ${i}`).join('\n') },
    };
    const shortMsg = {
      ...hardOverflowMsg,
      eventId: 'user-short',
      seq: 3,
      payload: { text: 'short message' },
    };

    // Closed agents panel + running agent + hardLineOverflow message -> 0 1Hz intervals
    localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '0');
    const { container, rerender } = render(
      <ChatView events={[completedAgentEvent, runningAgentEvent, hardOverflowMsg] as any} loading={false} sessionId="deck_sdk" visible={true} />,
    );
    expect(container.querySelector('.chat-user-message-fold.is-folded')).toBeTruthy();
    expect(get1HzCalls()).toHaveLength(0);
    const roHardOverflowOnly = resizeObserverCount;

    // Adding a short (non-hardLineOverflow) message adds exactly 1 ResizeObserver while visible
    rerender(
      <ChatView events={[completedAgentEvent, runningAgentEvent, hardOverflowMsg, shortMsg] as any} loading={false} sessionId="deck_sdk" visible={true} />,
    );
    expect(resizeObserverCount).toBe(roHardOverflowOnly + 1);

    // With visible={false} and hardOverflow + shortMsg, UserMessageText adds 0 ResizeObservers and 0 1Hz intervals run
    resizeObserverCount = 0;
    setIntervalSpy.mockClear();
    cleanup();
    const hiddenView = render(
      <ChatView events={[completedAgentEvent, hardOverflowMsg, shortMsg] as any} loading={false} sessionId="deck_sdk" visible={false} />,
    );
    expect(get1HzCalls()).toHaveLength(0);
    const roHiddenTotal = resizeObserverCount;
    hiddenView.rerender(
      <ChatView events={[completedAgentEvent, hardOverflowMsg, shortMsg, { ...shortMsg, eventId: 'user-short-2', seq: 4 }] as any} loading={false} sessionId="deck_sdk" visible={false} />,
    );
    expect(resizeObserverCount).toBe(roHiddenTotal);

    // Completed-only SDK agent with visible={true} -> 0 1Hz intervals
    setIntervalSpy.mockClear();
    hiddenView.rerender(<ChatView events={[completedAgentEvent] as any} loading={false} sessionId="deck_sdk" visible={true} />);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(get1HzCalls()).toHaveLength(0);
  });

  it('SubSessionWindow skips git polling and mobile body MutationObserver while hidden, then attaches immediately on visible=true without recreating ResizeObserver on body mutations', async () => {
    vi.useFakeTimers();
    const originalUa = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    });

    let moObserveCalls = 0;
    const bodyObservedNodes: Node[] = [];
    const OriginalMutationObserver = globalThis.MutationObserver;
    class TrackingMutationObserver extends OriginalMutationObserver {
      override observe(target: Node, options?: MutationObserverInit) {
        moObserveCalls += 1;
        bodyObservedNodes.push(target);
        super.observe(target, options);
      }
    }
    vi.stubGlobal('MutationObserver', TrackingMutationObserver);

    let roConstructions = 0;
    class TrackingResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor() {
        roConstructions += 1;
      }
    }
    vi.stubGlobal('ResizeObserver', TrackingResizeObserver);

    const sendSpy = vi.fn(() => true);
    const mockWs = {
      connected: true,
      send: sendSpy,
      onMessage: () => () => {},
      subscribeTimelineSession: () => () => {},
      subscribeTransportSession: vi.fn(),
      unsubscribeTransportSession: vi.fn(),
      onDaemonCapabilitySnapshot: () => () => {},
      getDaemonCapabilitySnapshot: () => null,
      timelineReplayRequest: vi.fn(),
      timelineHistoryRequest: vi.fn(() => 'req-1'),
      sendTimelineReplayRequest: vi.fn(),
      sendTimelineHistoryRequest: vi.fn(() => 'req-1'),
      fsListDir: vi.fn(),
      fsGitStatus: vi.fn(() => 'git-req-1'),
    } as any;

    const sub = {
      id: 'sub-hidden-1',
      serverId: 'srv-1',
      type: 'shell',
      shellBin: '/bin/bash',
      cwd: '/repo/project',
      ccSessionId: null,
      geminiSessionId: null,
      parentSession: 'deck_brain',
      label: 'worker',
      ccPresetId: null,
      sessionName: 'deck_sub_hidden_1',
      state: 'running',
    } as any;

    try {
      const { rerender } = render(
        <SubSessionWindow
          sub={sub}
          ws={mockWs}
          connected={true}
          active={false}
          visible={false}
          onClose={vi.fn()}
          onMinimize={vi.fn()}
          onRestart={vi.fn()}
          onRename={vi.fn()}
          onSettings={vi.fn()}
          onDiff={vi.fn()}
          onHistory={vi.fn()}
          onFocus={vi.fn()}
          zIndex={10}
          sessions={[]}
          subSessions={[sub]}
          serverId="srv-1"
        />,
      );

      act(() => {
        vi.advanceTimersByTime(65_000);
      });
      // Hidden window never polls git status and never attaches MutationObserver to document.body
      expect(mockWs.fsGitStatus).not.toHaveBeenCalled();
      expect(bodyObservedNodes).not.toContain(document.body);
      const roWhileHidden = roConstructions;

      // Transition visible: false -> true -> attaches immediately
      rerender(
        <SubSessionWindow
          sub={sub}
          ws={mockWs}
          connected={true}
          active={true}
          visible={true}
          onClose={vi.fn()}
          onMinimize={vi.fn()}
          onRestart={vi.fn()}
          onRename={vi.fn()}
          onSettings={vi.fn()}
          onDiff={vi.fn()}
          onHistory={vi.fn()}
          onFocus={vi.fn()}
          zIndex={10}
          sessions={[]}
          subSessions={[sub]}
          serverId="srv-1"
        />,
      );

      expect(mockWs.fsGitStatus).toHaveBeenCalled();
      expect(bodyObservedNodes).toContain(document.body);
      const roAfterShow = roConstructions;
      expect(roAfterShow).toBeGreaterThan(roWhileHidden);

      // Unrelated DOM mutations on document.body must NOT tear down & recreate ResizeObserver
      await act(async () => {
        const probe = document.createElement('div');
        document.body.appendChild(probe);
        probe.className = 'unrelated-mutation';
        await Promise.resolve();
      });
      expect(roConstructions).toBe(roAfterShow);
      expect(moObserveCalls).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: originalUa,
      });
    }
  });

  it('keeps chat path parsing linear on large unclosed brackets and adversarial path characters', () => {
    const unclosedBrackets = `${'[a '.repeat(20_000)}see [report](dir/file name.md)`;
    const t0 = performance.now();
    expect(normalizeLocalMarkdownDestinations(unclosedBrackets)).toContain('[report](<dir/file name.md>)');
    expect(extractMarkdownLocalFileDestinations(unclosedBrackets)).toEqual(['dir/file name.md']);
    expect(performance.now() - t0).toBeLessThan(250);

    const rootedNoDot = `${'/a'.repeat(9_500)} src/app.tsx`;
    const rootedManyDots = `${'/a.b'.repeat(4_500)}/\n/tmp/ok.ts`;
    const bareDashes = `${'-a'.repeat(9_500)} foo-bar.ts`;
    const t1 = performance.now();
    expect(findChatFileReferencesInText(rootedNoDot).map((m) => m.path)).toEqual(['src/app.tsx']);
    expect(findChatFileReferencesInText(rootedManyDots).map((m) => m.path)).toContain('/tmp/ok.ts');
    expect(findChatFileReferencesInText(bareDashes).map((m) => m.path)).toEqual(['foo-bar.ts']);
    expect(extractChatFileReferences(`${'[x '.repeat(15_000)}\n/tmp/ok.ts`)).toContain('/tmp/ok.ts');
    expect(performance.now() - t1).toBeLessThan(250);

    // Malformed destinations: repeated unclosed `](` / `](<` / `](<a >` must stay O(N)
    const pureUnclosedParens = '[x]('.repeat(15_000);
    const malformedParens = `${pureUnclosedParens} [doc](dir/file (v1) final.md) [img](dir/sub(1)/pic.png)`;
    const malformedAngles = `${'[x](<'.repeat(15_000)}\n[a](<dir/next file.md>)`;
    const malformedAngleNoClose = `${'[x](<a >'.repeat(15_000)}\n/tmp/ok.ts`;
    const malformedCloudDocs = `${'[CloudDoc: '.repeat(10_000)}[CloudDoc: report.pdf | id=cdoc_1234]`;

    const tPure = performance.now();
    expect(normalizeLocalMarkdownDestinations(pureUnclosedParens)).toBe(pureUnclosedParens);
    expect(extractMarkdownLocalFileDestinations(pureUnclosedParens)).toEqual([]);
    expect(extractChatFileReferences(pureUnclosedParens)).toEqual([]);
    expect(performance.now() - tPure).toBeLessThan(200);

    const tParens = performance.now();
    expect(normalizeLocalMarkdownDestinations(malformedParens)).toContain('[doc](<dir/file (v1) final.md>)');
    expect(extractMarkdownLocalFileDestinations(malformedParens)).toEqual([
      'dir/file (v1) final.md',
      'dir/sub(1)/pic.png',
    ]);
    expect(extractChatFileReferences(malformedParens)).toEqual([
      'dir/file (v1) final.md',
      'dir/sub(1)/pic.png',
    ]);
    expect(performance.now() - tParens).toBeLessThan(200);

    const tAngles = performance.now();
    expect(extractMarkdownLocalFileDestinations(malformedAngles)).toEqual(['dir/next file.md']);
    expect(extractChatFileReferences(malformedAngles)).toContain('dir/next file.md');
    expect(extractChatFileReferences(malformedAngleNoClose)).toContain('/tmp/ok.ts');
    expect(performance.now() - tAngles).toBeLessThan(250);

    const tCloud = performance.now();
    const cloudSegs = splitTextByCloudDocQuoteTags(malformedCloudDocs);
    expect(cloudSegs.some((seg) => seg.type === 'cloud_doc' && seg.docId === 'cdoc_1234')).toBe(true);
    expect(performance.now() - tCloud).toBeLessThan(250);
  });

  it('keeps ChatView PATH_REGEX linear on repeated tilde/dot prefixes without separators', () => {
    const t0 = performance.now();
    const text = `${'~a'.repeat(9_500)} src/main.ts`;
    const { container } = render(
      <ChatView
        events={[
          {
            eventId: 'evt-tilde-path',
            type: 'user.message',
            ts: 1_000,
            sessionId: 'sess-1',
            source: 'daemon',
            confidence: 'high',
            payload: { text },
          },
        ]}
        loading={false}
        ws={{} as any}
        onPreviewFile={vi.fn()}
      />,
    );
    expect(performance.now() - t0).toBeLessThan(250);
    const links = Array.from(container.querySelectorAll('.chat-path-link')).map((el) => el.textContent);
    expect(links).toContain('src/main.ts');
  });
});
