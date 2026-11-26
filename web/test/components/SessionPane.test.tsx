/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';
import { h } from 'preact';

const addOptimisticUserMessageMock = vi.fn();
const markOptimisticFailedMock = vi.fn();
const retryOptimisticMessageMock = vi.fn();
const sendSessionViaHttpMock = vi.fn();
let timelineEventsMock: any[] = [];
let activeToolCallMock = false;
const useTimelineMock = vi.fn();
const terminalViewSpy = vi.fn(() => null);
const chatViewSpy = vi.fn(() => null);
const sessionControlsSpy = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/TerminalView.js', () => ({ TerminalView: (props: any) => terminalViewSpy(props) }));
vi.mock('../../src/components/ChatView.js', () => ({ ChatView: (props: any) => chatViewSpy(props) }));
vi.mock('../../src/components/SessionControls.js', () => ({
  SessionControls: (props: {
    onSend?: (
      sessionName: string,
      text: string,
      meta?: { commandId: string; attachments?: Array<Record<string, unknown>>; extra?: Record<string, unknown>; localFailure?: string },
    ) => void;
    activeSession?: { name: string; state?: string | null } | null;
    activeTransportTurn?: boolean;
  }) => (
    sessionControlsSpy(props),
    <button
      type="button"
      data-active-transport-turn={String(!!props.activeTransportTurn)}
      data-active-session-state={props.activeSession?.state ?? ''}
      onClick={() => {
        if (props.activeSession?.state === 'running' || props.activeTransportTurn) return;
        props.onSend?.(
          props.activeSession?.name ?? 'session',
          'queued text',
          { commandId: 'test-cmd-1' },
        );
      }}
    >
      send
    </button>
  ),
}));
vi.mock('../../src/hooks/useTimeline.js', () => ({
  requestActiveTimelineRefreshAfterUserAction: vi.fn(),
  useTimeline: (...args: any[]) => {
    useTimelineMock(...args);
    return {
      events: timelineEventsMock,
      loading: false,
      refreshing: false,
      loadingOlder: false,
      hasOlderHistory: false,
      addOptimisticUserMessage: addOptimisticUserMessageMock,
      markOptimisticFailed: markOptimisticFailedMock,
      retryOptimisticMessage: retryOptimisticMessageMock,
      loadOlderEvents: vi.fn(),
    };
  },
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
vi.mock('../../src/cost-tracker.js', () => ({ recordCost: vi.fn() }));
vi.mock('../../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api.js')>();
  return {
    ...actual,
    sendSessionViaHttp: (...args: unknown[]) => sendSessionViaHttpMock(...args),
  };
});
vi.mock('../../src/format-label.js', () => ({ formatLabel: (x: string) => x }));
vi.mock('../../src/components/UsageFooter.js', () => ({
  UsageFooter: (props: any) => (
    <div
      data-testid="usage-footer"
      data-state={props.sessionState}
      data-active-timeline-turn={String(!!props.activeTimelineTurn)}
      data-pending-user-send={String(!!props.pendingUserSend)}
      data-model={props.modelOverride ?? ''}
    >
      {props.quotaLabel ?? props.planLabel ?? 'footer'}
    </div>
  ),
}));

import { SessionPane } from '../../src/components/SessionPane.js';

describe('SessionPane', () => {
  beforeEach(() => {
    addOptimisticUserMessageMock.mockReset();
    markOptimisticFailedMock.mockReset();
    retryOptimisticMessageMock.mockReset();
    sendSessionViaHttpMock.mockReset();
    sendSessionViaHttpMock.mockRejectedValue(new Error('http unavailable in test'));
    useTimelineMock.mockReset();
    sessionControlsSpy.mockReset();
    timelineEventsMock = [];
    activeToolCallMock = false;
    terminalViewSpy.mockClear();
    chatViewSpy.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps the main timeline passive while a sub-session owns keyboard focus', () => {
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
        } as any}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={false}
        isActive={true}
        keyboardActive={false}
        viewMode="chat"
        quickData={{} as any}
      />,
    );

    expect(useTimelineMock).toHaveBeenCalledWith(
      'deck_test_brain',
      null,
      's1',
      expect.objectContaining({ isActiveSession: false }),
    );
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

  it('renders UsageFooter for agent sessions even without usage or running state', () => {
    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'codex-sdk',
          state: 'stopped',
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

    expect(screen.getByTestId('usage-footer').getAttribute('data-state')).toBe('stopped');
  });

  it('passes detected model to UsageFooter when session metadata has no modelDisplay', () => {
    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'codex-sdk',
          state: 'idle',
          projectDir: '/tmp/test',
        } as any}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={false}
        isActive={true}
        viewMode="chat"
        quickData={{} as any}
        detectedModel="gpt-5.5"
      />,
    );

    expect(screen.getByTestId('usage-footer').getAttribute('data-model')).toBe('gpt-5.5');
  });

  it('passes active/requested transport model to UsageFooter before falling back to display or detected model', () => {
    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'codex-sdk',
          state: 'idle',
          projectDir: '/tmp/test',
          activeModel: 'gpt-5.5',
          requestedModel: 'gpt-5.4',
        } as any}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={false}
        isActive={true}
        viewMode="chat"
        quickData={{} as any}
        detectedModel="gpt-5"
      />,
    );

    expect(screen.getByTestId('usage-footer').getAttribute('data-model')).toBe('gpt-5.5');
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

    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(addOptimisticUserMessageMock).toHaveBeenCalledWith('queued text', 'test-cmd-1', {});
  });

  it('passes active transport turn when timeline tail has assistant text but no idle state', () => {
    timelineEventsMock = [
      { eventId: 'idle', sessionId: 'deck_test_brain', ts: 1, type: 'session.state', payload: { state: 'idle' } },
      { eventId: 'text', sessionId: 'deck_test_brain', ts: 2, type: 'assistant.text', payload: { text: 'still streaming', streaming: true } },
      { eventId: 'ack', sessionId: 'deck_test_brain', ts: 3, type: 'command.ack', payload: { ok: true } },
    ];

    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'claude-code-sdk',
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

    expect(sessionControlsSpy).toHaveBeenCalledWith(expect.objectContaining({
      activeTransportTurn: true,
    }));
    expect(screen.getByRole('button', { name: 'send' }).getAttribute('data-active-transport-turn')).toBe('true');
    expect(screen.getByTestId('usage-footer').getAttribute('data-active-timeline-turn')).toBe('true');
  });

  it('passes live timeline state to ChatView instead of stale outer session state', () => {
    timelineEventsMock = [
      { eventId: 'idle', sessionId: 'deck_test_brain', ts: 1, type: 'session.state', payload: { state: 'idle' } },
      { eventId: 'running', sessionId: 'deck_test_brain', ts: 2, type: 'session.state', payload: { state: 'running' } },
    ];

    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'claude-code-sdk',
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

    expect(chatViewSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionState: 'running',
    }));
  });


  it('uses authoritative outer idle when stale timeline running has no active work', () => {
    timelineEventsMock = [
      { eventId: 'running', sessionId: 'deck_test_brain', ts: 1, type: 'session.state', payload: { state: 'running' } },
      { eventId: 'done-text', sessionId: 'deck_test_brain', ts: 2, type: 'assistant.text', payload: { text: 'done', streaming: false } },
      { eventId: 'usage', sessionId: 'deck_test_brain', ts: 3, type: 'usage.update', payload: { inputTokens: 1, outputTokens: 1 } },
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

    expect(chatViewSpy).toHaveBeenCalledWith(expect.objectContaining({ sessionState: 'idle' }));
    expect(screen.getByTestId('usage-footer').getAttribute('data-state')).toBe('idle');
    expect(screen.getByRole('button', { name: 'send' }).getAttribute('data-active-session-state')).toBe('idle');
  });

  it('keeps active transport turn through a pending optimistic user message tail', () => {
    timelineEventsMock = [
      { eventId: 'idle', sessionId: 'deck_test_brain', ts: 1, type: 'session.state', payload: { state: 'idle' } },
      { eventId: 'text', sessionId: 'deck_test_brain', ts: 2, type: 'assistant.text', payload: { text: 'still streaming', streaming: true } },
      { eventId: 'pending-user', sessionId: 'deck_test_brain', ts: 3, type: 'user.message', payload: { text: 'queued first', pending: true, commandId: 'cmd-1' } },
      { eventId: 'ack', sessionId: 'deck_test_brain', ts: 4, type: 'command.ack', payload: { ok: true, commandId: 'cmd-1' } },
    ];

    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'claude-code-sdk',
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

    expect(sessionControlsSpy).toHaveBeenCalledWith(expect.objectContaining({
      activeTransportTurn: true,
    }));
    expect(screen.getByRole('button', { name: 'send' }).getAttribute('data-active-transport-turn')).toBe('true');
  });

  it('forwards a pending optimistic send for immediate live-status feedback', () => {
    timelineEventsMock = [
      { eventId: 'idle', sessionId: 'deck_test_brain', ts: 1, type: 'session.state', payload: { state: 'idle' } },
      { eventId: 'pending-user', sessionId: 'deck_test_brain', ts: 2, type: 'user.message', payload: { text: 'just sent', pending: true, commandId: 'cmd-now' } },
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

    expect(screen.getByTestId('usage-footer').getAttribute('data-pending-user-send')).toBe('true');
  });

  it('keeps active transport turn through a confirmed user message after running state', () => {
    timelineEventsMock = [
      { eventId: 'idle', sessionId: 'deck_test_brain', ts: 1, type: 'session.state', payload: { state: 'idle' } },
      { eventId: 'running', sessionId: 'deck_test_brain', ts: 2, type: 'session.state', payload: { state: 'running' } },
      { eventId: 'user', sessionId: 'deck_test_brain', ts: 3, type: 'user.message', payload: { text: 'sent first', pending: false, commandId: 'cmd-1' } },
      { eventId: 'ack', sessionId: 'deck_test_brain', ts: 4, type: 'command.ack', payload: { ok: true, commandId: 'cmd-1' } },
    ];

    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'claude-code-sdk',
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

    expect(sessionControlsSpy).toHaveBeenCalledWith(expect.objectContaining({
      activeTransportTurn: true,
    }));
    expect(screen.getByRole('button', { name: 'send' }).getAttribute('data-active-transport-turn')).toBe('true');
  });

  it('keeps stale outer idle transport sends out of the timeline when the timeline tail is running', () => {
    timelineEventsMock = [
      { eventId: 'idle', sessionId: 'deck_test_brain', ts: 1, type: 'session.state', payload: { state: 'idle' } },
      { eventId: 'running', sessionId: 'deck_test_brain', ts: 2, type: 'session.state', payload: { state: 'running' } },
      { eventId: 'tool', sessionId: 'deck_test_brain', ts: 3, type: 'tool.call', payload: { name: 'shell' } },
    ];

    render(
      <SessionPane
        serverId="s1"
        session={{
          name: 'deck_test_brain',
          project: 'test',
          role: 'brain',
          agentType: 'claude-code-sdk',
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

    expect(sessionControlsSpy).toHaveBeenCalledWith(expect.objectContaining({
      activeSession: expect.objectContaining({ state: 'running' }),
    }));
    expect(screen.getByRole('button', { name: 'send' }).getAttribute('data-active-session-state')).toBe('running');

    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(addOptimisticUserMessageMock).not.toHaveBeenCalled();
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
          state: 'idle',
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
    // Transport sessions stay in chat mode; the inactive terminal is now
    // lazily unmounted rather than keeping an xterm instance alive.
    expect(terminalViewSpy).not.toHaveBeenCalled();
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

  it('keeps the failed retry bubble when resend cannot write to socket or HTTP fallback', () => {
    timelineEventsMock = [{
      type: 'user.message',
      payload: { text: 'retry me', failed: true, commandId: 'failed-cmd' },
    }];
    const ws = {
      connected: true,
      onMessage: vi.fn(() => () => undefined),
      sendSessionCommand: vi.fn(() => {
        throw new Error('WebSocket not connected');
      }),
    };

    render(
      <SessionPane
        serverId=""
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
    expect(retryOptimisticMessageMock).not.toHaveBeenCalled();
    expect(addOptimisticUserMessageMock).not.toHaveBeenCalled();
  });

  it('falls back to HTTP on failed bubble resend when urgent socket throws and marks failed if HTTP rejects', async () => {
    timelineEventsMock = [{
      type: 'user.message',
      payload: { text: 'retry via http', failed: true, commandId: 'failed-http-cmd' },
    }];
    const ws = {
      connected: true,
      onMessage: vi.fn(() => () => undefined),
      sendSessionCommandUrgent: vi.fn(() => {
        throw new Error('WebSocket not connected');
      }),
    };
    let rejectHttp!: (err: Error) => void;
    sendSessionViaHttpMock.mockImplementationOnce(() => new Promise((_, reject) => { rejectHttp = reject; }));

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
    props.onResendFailed?.('failed-http-cmd', 'retry via http');

    expect(ws.sendSessionCommandUrgent).toHaveBeenCalledOnce();
    expect(sendSessionViaHttpMock).toHaveBeenCalledWith('s1', expect.objectContaining({
      sessionName: 'deck_test_brain',
      text: 'retry via http',
      commandId: expect.any(String),
    }));
    expect(retryOptimisticMessageMock).toHaveBeenCalledTimes(1);
    const nextCommandId = retryOptimisticMessageMock.mock.calls[0]?.[1];

    rejectHttp(new Error('503 service unavailable'));
    await Promise.resolve();
    await Promise.resolve();
    expect(markOptimisticFailedMock).toHaveBeenCalledWith(nextCommandId, '503 service unavailable');
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

  it('uses authoritative outer idle over stale timeline running for footer status', () => {
    timelineEventsMock = [
      { type: 'session.state', payload: { state: 'running' } },
      { type: 'assistant.text', payload: { text: 'done', streaming: false } },
      { type: 'usage.update', payload: { inputTokens: 1, outputTokens: 1 } },
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

    expect(screen.getByTestId('usage-footer').getAttribute('data-state')).toBe('idle');
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

  it('forwards pendingSharedUpload and onConsumePendingSharedUpload to SessionControls', () => {
    const onConsume = vi.fn();
    const sharedUpload = {
      id: 'share-pane-1',
      serverId: 's1',
      sessionName: 'deck_test_brain',
      files: [new File(['x'], 'note.txt', { type: 'text/plain' })],
      text: 'caption',
    };

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
        connected={true}
        isActive={true}
        viewMode="chat"
        quickData={{} as any}
        pendingSharedUpload={sharedUpload}
        onPendingSharedUploadConsumed={onConsume}
      />,
    );

    const calledProps = sessionControlsSpy.mock.calls.at(-1)?.[0];
    expect(calledProps?.pendingSharedUpload).toBe(sharedUpload);
    calledProps?.onPendingSharedUploadConsumed?.('share-pane-1');
    expect(onConsume).toHaveBeenCalledWith('share-pane-1');
  });

  it('attaches pendingTaskQuote only when active, replaces previous task-jump quote, and preserves unrelated manual quotes', () => {
    const onConsumed = vi.fn();
    const baseSession = {
      name: 'deck_test_brain',
      project: 'test',
      role: 'brain',
      agentType: 'codex-sdk',
      state: 'idle',
      runtimeType: 'transport',
      projectDir: '/tmp/test',
    } as any;

    const { rerender } = render(
      <SessionPane
        serverId="s1"
        session={baseSession}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={true}
        isActive={false}
        viewMode="chat"
        quickData={{} as any}
        pendingTaskQuote={{ quote: '[关于任务「Task A」]', nonce: 1 }}
        onPendingTaskQuoteConsumed={onConsumed}
      />,
    );

    // Must not consume while inactive (e.g. background server/session tab)
    expect(onConsumed).not.toHaveBeenCalled();

    // Activate pane -> attaches Task A quote and notifies parent
    rerender(
      <SessionPane
        serverId="s1"
        session={baseSession}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={true}
        isActive={true}
        viewMode="chat"
        quickData={{} as any}
        pendingTaskQuote={{ quote: '[关于任务「Task A」]', nonce: 1 }}
        onPendingTaskQuoteConsumed={onConsumed}
      />,
    );

    expect(onConsumed).toHaveBeenCalledWith(1);
    expect(sessionControlsSpy.mock.calls.at(-1)?.[0]?.taskQuote).toBe('[关于任务「Task A」]');
    expect(sessionControlsSpy.mock.calls.at(-1)?.[0]?.quotes).toEqual([]);

    // Add a manual quote (even one matching the exact task-quote text format) via ChatView onQuote -> preserved in manual quotes
    const chatProps = chatViewSpy.mock.calls.at(-1)?.[0];
    chatProps?.onQuote?.('[Regarding task "Task A"]');
    chatProps?.onQuote?.('Manual user message quote');
    rerender(
      <SessionPane
        serverId="s1"
        session={baseSession}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={true}
        isActive={true}
        viewMode="chat"
        quickData={{} as any}
        pendingTaskQuote={null}
        onPendingTaskQuoteConsumed={onConsumed}
      />,
    );
    expect(sessionControlsSpy.mock.calls.at(-1)?.[0]?.taskQuote).toBe('[关于任务「Task A」]');
    expect(sessionControlsSpy.mock.calls.at(-1)?.[0]?.quotes).toEqual([
      '[Regarding task "Task A"]',
      'Manual user message quote',
    ]);

    // Jump to Task B -> replaces Task A slot while preserving ALL manual quotes regardless of text
    rerender(
      <SessionPane
        serverId="s1"
        session={baseSession}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={true}
        isActive={true}
        viewMode="chat"
        quickData={{} as any}
        pendingTaskQuote={{ quote: '[关于任务「Task B」]', nonce: 2 }}
        onPendingTaskQuoteConsumed={onConsumed}
      />,
    );
    expect(onConsumed).toHaveBeenCalledWith(2);
    expect(sessionControlsSpy.mock.calls.at(-1)?.[0]?.taskQuote).toBe('[关于任务「Task B」]');
    expect(sessionControlsSpy.mock.calls.at(-1)?.[0]?.quotes).toEqual([
      '[Regarding task "Task A"]',
      'Manual user message quote',
    ]);

    // Jump to Task B again with a new nonce -> single taskQuote slot updates cleanly without duplicating
    rerender(
      <SessionPane
        serverId="s1"
        session={baseSession}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={true}
        isActive={true}
        viewMode="chat"
        quickData={{} as any}
        pendingTaskQuote={{ quote: '[关于任务「Task B」]', nonce: 3 }}
        onPendingTaskQuoteConsumed={onConsumed}
      />,
    );
    expect(sessionControlsSpy.mock.calls.at(-1)?.[0]?.taskQuote).toBe('[关于任务「Task B」]');
    expect(sessionControlsSpy.mock.calls.at(-1)?.[0]?.quotes).toEqual([
      '[Regarding task "Task A"]',
      'Manual user message quote',
    ]);
  });
});
