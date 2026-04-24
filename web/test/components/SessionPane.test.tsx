/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';
import { h } from 'preact';

const addOptimisticUserMessageMock = vi.fn();
let timelineEventsMock: any[] = [];
let activeToolCallMock = false;
const useTimelineMock = vi.fn();
const terminalViewSpy = vi.fn(() => null);
const chatViewSpy = vi.fn(() => null);

vi.mock('../../src/components/TerminalView.js', () => ({ TerminalView: (props: any) => terminalViewSpy(props) }));
vi.mock('../../src/components/ChatView.js', () => ({ ChatView: (props: any) => chatViewSpy(props) }));
vi.mock('../../src/components/SessionControls.js', () => ({
  SessionControls: (props: {
    onSend?: (
      sessionName: string,
      text: string,
      meta?: { commandId: string; attachments?: Array<Record<string, unknown>>; extra?: Record<string, unknown> },
    ) => void;
    activeSession?: { name: string } | null;
  }) => (
    <button
      type="button"
      onClick={() => props.onSend?.(
        props.activeSession?.name ?? 'session',
        'queued text',
        { commandId: 'test-cmd-1' },
      )}
    >
      send
    </button>
  ),
}));
const removeOptimisticMessageMock = vi.fn();
vi.mock('../../src/hooks/useTimeline.js', () => ({
  useTimeline: (...args: any[]) => {
    useTimelineMock(...args);
    return {
      events: timelineEventsMock,
      loading: false,
      refreshing: false,
      loadingOlder: false,
      hasOlderHistory: false,
      addOptimisticUserMessage: addOptimisticUserMessageMock,
      removeOptimisticMessage: removeOptimisticMessageMock,
      loadOlderEvents: vi.fn(),
    };
  },
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
vi.mock('../../src/cost-tracker.js', () => ({ recordCost: vi.fn() }));
vi.mock('../../src/format-label.js', () => ({ formatLabel: (x: string) => x }));
vi.mock('../../src/components/UsageFooter.js', () => ({
  UsageFooter: (props: any) => <div data-testid="usage-footer" data-state={props.sessionState}>{props.quotaLabel ?? props.planLabel ?? 'footer'}</div>,
}));

import { SessionPane } from '../../src/components/SessionPane.js';

describe('SessionPane', () => {
  beforeEach(() => {
    addOptimisticUserMessageMock.mockReset();
    useTimelineMock.mockReset();
    timelineEventsMock = [];
    activeToolCallMock = false;
    terminalViewSpy.mockClear();
    chatViewSpy.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders UsageFooter for codex CLI when only quota metadata exists', () => {
    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'codex',
          state: 'idle',
          projectDir: '/tmp/test',
          quotaLabel: '5h 11% 2h03m 4/6 14:40 · 7d 50% 1d04h 4/8 15:48',
          quotaUsageLabel: undefined,
          planLabel: 'Pro',
        } as any}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={false}
        isActive={true}
        viewMode="terminal"
        quickData={{} as any}
      />,
    );

    expect(screen.getByTestId('usage-footer')).toBeDefined();
    expect(screen.getByText(/5h 11% 2h03m 4\/6 14:40/)).toBeDefined();
  });

  it('adds optimistic user messages for transport sessions', () => {
    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'claude-code-sdk',
          state: 'running',
          runtimeType: 'transport',
          projectDir: '/tmp/test',
        } as any}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={false}
        isActive={true}
        viewMode="chat"
        quickData={{} as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(addOptimisticUserMessageMock).toHaveBeenCalledWith('queued text', 'test-cmd-1', {});
  });

  it('forces copilot-sdk sessions into chat mode when runtimeType is omitted', () => {
    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'copilot-sdk',
          state: 'running',
          runtimeType: undefined,
          projectDir: '/tmp/test',
        } as any}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={false}
        isActive={true}
        viewMode="terminal"
        quickData={{} as any}
      />,
    );

    expect(chatViewSpy).toHaveBeenCalled();
    expect(terminalViewSpy).toHaveBeenCalled();
    const lastTerminalProps = terminalViewSpy.mock.calls.at(-1)?.[0];
    expect(lastTerminalProps?.active).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(addOptimisticUserMessageMock).toHaveBeenCalledWith('queued text', 'test-cmd-1', {});
  });

  it('keeps optimistic user messages for process sessions', () => {
    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'codex',
          state: 'idle',
          runtimeType: 'process',
          projectDir: '/tmp/test',
        } as any}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={false}
        isActive={true}
        viewMode="chat"
        quickData={{} as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(addOptimisticUserMessageMock).toHaveBeenCalledWith('queued text', 'test-cmd-1', {});
  });

  it('keeps the failed retry bubble when resend cannot write to the socket', () => {
    timelineEventsMock = [{
      type: 'user.message',
      payload: { text: 'retry me', failed: true, commandId: 'failed-cmd' },
    }];
    const ws = {
      connected: true,
      sendSessionCommand: vi.fn(() => {
        throw new Error('WebSocket not connected');
      }),
    };

    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'codex',
          state: 'idle',
          runtimeType: 'process',
          projectDir: '/tmp/test',
        } as any}
        sessions={[]}
        subSessions={[]}
        ws={ws as any}
        connected={true}
        isActive={true}
        viewMode="chat"
        quickData={{} as any}
      />,
    );

    const props = chatViewSpy.mock.calls.at(-1)?.[0] as { onResendFailed?: (commandId: string, text: string) => void };
    props.onResendFailed?.('failed-cmd', 'retry me');

    expect(ws.sendSessionCommand).toHaveBeenCalledOnce();
    expect(removeOptimisticMessageMock).not.toHaveBeenCalled();
    expect(addOptimisticUserMessageMock).not.toHaveBeenCalled();
  });

  it('disables chat timeline bootstrap and optimistic bubbles for shell sessions', () => {
    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_shell_brain',
          project: 'test',
          role: 'brain',
          agentType: 'shell',
          state: 'idle',
          runtimeType: 'process',
          projectDir: '/tmp/test',
        } as any}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={false}
        isActive={true}
        viewMode="terminal"
        quickData={{} as any}
      />,
    );

    expect(useTimelineMock).toHaveBeenCalledWith(
      'deck_shell_brain',
      null,
      's1',
      expect.objectContaining({ isActiveSession: true, disableHistory: true }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(addOptimisticUserMessageMock).not.toHaveBeenCalled();
  });

  it('prefers timeline tail running state over stale outer idle state for footer status', () => {
    timelineEventsMock = [
      { type: 'session.state', payload: { state: 'running' } },
      { type: 'tool.result', payload: { ok: true } },
    ];

    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'codex-sdk',
          state: 'idle',
          runtimeType: 'transport',
          projectDir: '/tmp/test',
        } as any}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={false}
        isActive={true}
        viewMode="chat"
        quickData={{} as any}
      />,
    );

    expect(screen.getByTestId('usage-footer').getAttribute('data-state')).toBe('running');
  });

  it('keeps footer visible while a tool call is active even without usage or running state', () => {
    activeToolCallMock = true;

    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'codex-sdk',
          state: null,
          runtimeType: 'transport',
          projectDir: '/tmp/test',
        } as any}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={false}
        isActive={true}
        viewMode="chat"
        quickData={{} as any}
      />,
    );

    expect(screen.getByTestId('usage-footer')).toBeDefined();
  });
});
