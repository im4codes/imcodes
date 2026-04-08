/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';
import { h } from 'preact';

const addOptimisticUserMessageMock = vi.fn();

vi.mock('../../src/components/TerminalView.js', () => ({ TerminalView: () => null }));
vi.mock('../../src/components/ChatView.js', () => ({ ChatView: () => null }));
vi.mock('../../src/components/SessionControls.js', () => ({
  SessionControls: (props: { onSend?: (sessionName: string, text: string) => void; activeSession?: { name: string } | null }) => (
    <button type="button" onClick={() => props.onSend?.(props.activeSession?.name ?? 'session', 'queued text')}>
      send
    </button>
  ),
}));
vi.mock('../../src/hooks/useTimeline.js', () => ({
  useTimeline: () => ({
    events: [],
    loading: false,
    refreshing: false,
    loadingOlder: false,
    hasOlderHistory: false,
    addOptimisticUserMessage: addOptimisticUserMessageMock,
    loadOlderEvents: vi.fn(),
  }),
}));
vi.mock('../../src/thinking-utils.js', () => ({
  getActiveThinkingTs: () => null,
  getActiveStatusText: () => null,
}));
vi.mock('../../src/cost-tracker.js', () => ({ recordCost: vi.fn() }));
vi.mock('../../src/format-label.js', () => ({ formatLabel: (x: string) => x }));
vi.mock('../../src/components/UsageFooter.js', () => ({
  UsageFooter: (props: any) => <div data-testid="usage-footer">{props.quotaLabel ?? props.planLabel ?? 'footer'}</div>,
}));

import { SessionPane } from '../../src/components/SessionPane.js';

describe('SessionPane', () => {
  beforeEach(() => {
    addOptimisticUserMessageMock.mockReset();
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

  it('does not add optimistic user messages for transport sessions', () => {
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
    expect(addOptimisticUserMessageMock).not.toHaveBeenCalled();
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
    expect(addOptimisticUserMessageMock).toHaveBeenCalledWith('queued text');
  });
});
