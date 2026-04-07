/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { h } from 'preact';
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key.split('.').pop() ?? key,
  }),
}));

import { P2pProgressCard } from '../../src/components/P2pProgressCard.js';

describe('P2pProgressCard', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows round-local hop progress instead of global hop index', () => {
    render(
      <P2pProgressCard
        discussion={{
          id: 'p2p_run_1',
          topic: 'P2P audit · brain',
          state: 'running',
          modeKey: 'audit',
          currentRound: 2,
          maxRounds: 3,
          completedHops: 3,
          totalHops: 2,
          activeHop: 4,
          activeRoundHop: 2,
          activePhase: 'hop',
          nodes: [],
        }}
      />,
    );

    expect(screen.getAllByText('H2/2').length).toBeGreaterThan(0);
    expect(screen.queryByText('H4/2')).toBeNull();
  });

  it('shows a close action for failed discussions', () => {
    const onStopDiscussion = vi.fn();

    render(
      <P2pProgressCard
        discussion={{
          id: 'p2p_run_failed',
          topic: 'P2P audit · brain',
          state: 'failed',
          modeKey: 'audit',
          currentRound: 1,
          maxRounds: 1,
          completedHops: 0,
          totalHops: 1,
          activePhase: 'summary',
          error: 'timed_out',
          nodes: [],
        }}
        onStopDiscussion={onStopDiscussion}
      />,
    );

    const closeButton = screen.getByText(/close/i);
    expect(screen.queryByText(/cancel/i)).toBeNull();
    fireEvent.click(closeButton);
    expect(onStopDiscussion).toHaveBeenCalledWith('p2p_run_failed');
  });

  it('keeps active progress highlighted but static once the discussion is no longer running', () => {
    const { container } = render(
      <P2pProgressCard
        discussion={{
          id: 'p2p_run_failed',
          topic: 'P2P audit · brain',
          state: 'failed',
          modeKey: 'audit',
          currentRound: 1,
          maxRounds: 2,
          completedHops: 0,
          totalHops: 2,
          activeHop: 1,
          activeRoundHop: 1,
          activePhase: 'hop',
          nodes: [
            { label: 'brain', agentType: 'codex', status: 'active', phase: 'hop' },
          ],
        }}
      />,
    );

    expect(container.querySelectorAll('.is-active').length).toBe(0);
    expect(container.querySelectorAll('.is-active-static').length).toBeGreaterThan(0);
    expect(container.querySelector('.p2p-timer-total')).toBeNull();
  });

  it('preserves animated progress while the discussion is running', () => {
    const { container } = render(
      <P2pProgressCard
        discussion={{
          id: 'p2p_run_running',
          topic: 'P2P audit · brain',
          state: 'running',
          modeKey: 'audit',
          currentRound: 1,
          maxRounds: 2,
          completedHops: 0,
          totalHops: 2,
          activeHop: 1,
          activeRoundHop: 1,
          activePhase: 'hop',
          nodes: [
            { label: 'brain', agentType: 'codex', status: 'active', phase: 'hop' },
          ],
        }}
      />,
    );

    expect(container.querySelectorAll('.is-active').length).toBeGreaterThan(0);
    expect(container.querySelector('.p2p-timer-total')).toBeTruthy();
  });
});
