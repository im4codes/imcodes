/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { h } from 'preact';

vi.mock('../../src/components/TerminalView.js', () => ({ TerminalView: () => null }));
vi.mock('../../src/components/ChatView.js', () => ({ ChatView: () => null }));
vi.mock('../../src/components/SessionControls.js', () => ({ SessionControls: () => null }));
vi.mock('../../src/hooks/useTimeline.js', () => ({
  useTimeline: () => ({
    events: [],
    loading: false,
    refreshing: false,
    loadingOlder: false,
    hasOlderHistory: false,
    addOptimisticUserMessage: vi.fn(),
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
});
