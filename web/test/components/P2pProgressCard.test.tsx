/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { h } from 'preact';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key.split('.').pop() ?? key,
  }),
}));

import { P2pProgressCard } from '../../src/components/P2pProgressCard.js';

describe('P2pProgressCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-08T00:00:00.000Z'));
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
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
          startedAt: Date.now(),
          hopStartedAt: Date.now(),
          nodes: [
            { label: 'brain', agentType: 'codex', status: 'active', phase: 'hop' },
          ],
        }}
      />,
    );

    expect(container.querySelectorAll('.is-active').length).toBeGreaterThan(0);
    expect(container.querySelector('.p2p-timer-total')).toBeTruthy();
  });

  it('updates timer labels while keeping the running progress card active', () => {
    render(
      <P2pProgressCard
        discussion={{
          id: 'p2p_run_timers',
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
          startedAt: Date.now(),
          hopStartedAt: Date.now(),
          nodes: [
            { label: 'brain', agentType: 'codex', status: 'active', phase: 'hop' },
          ],
        }}
      />,
    );

    expect(screen.getAllByText('00:00').length).toBeGreaterThanOrEqual(2);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getAllByText('00:02').length).toBeGreaterThan(0);
  });

  it('shows parallel hop ranges and highlights all active hop segments', () => {
    const { container } = render(
      <P2pProgressCard
        discussion={{
          id: 'p2p_run_parallel',
          topic: 'P2P audit · brain',
          state: 'running',
          modeKey: 'audit',
          currentRound: 1,
          maxRounds: 1,
          completedHops: 1,
          totalHops: 4,
          activeHop: 2,
          activeRoundHop: 2,
          activePhase: 'hop',
          nodes: [
            { label: 'w1', agentType: 'codex', status: 'done', phase: 'hop' },
            { label: 'w2', agentType: 'codex', status: 'active', phase: 'hop' },
            { label: 'w3', agentType: 'codex', status: 'active', phase: 'hop' },
            { label: 'w4', agentType: 'codex', status: 'active', phase: 'hop' },
          ],
        }}
      />,
    );

    expect(screen.getAllByText('H2-4/4').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.discussions-progress-segments-hop .is-active').length).toBe(3);
  });

  it('uses hopStates and completedRoundHops to render parallel hop bars even when global hop counters are stale', () => {
    const { container } = render(
      <P2pProgressCard
        discussion={{
          id: 'p2p_run_parallel_stale',
          topic: 'P2P audit · brain',
          state: 'running',
          modeKey: 'audit',
          currentRound: 2,
          maxRounds: 3,
          completedHops: 4,
          completedRoundHops: 1,
          totalHops: 4,
          activeHop: 6,
          activeRoundHop: 2,
          activePhase: 'hop',
          nodes: [],
          hopStates: [
            { hopIndex: 5, roundIndex: 2, status: 'completed' },
            { hopIndex: 6, roundIndex: 2, status: 'running' },
            { hopIndex: 7, roundIndex: 2, status: 'dispatched' },
            { hopIndex: 8, roundIndex: 2, status: 'running' },
          ],
        }}
      />,
    );

    expect(screen.getAllByText('H2-4/4').length).toBeGreaterThan(0);
    const hopSegments = [...container.querySelectorAll('.discussions-progress-segments-hop .discussions-progress-segment')];
    expect(hopSegments).toHaveLength(4);
    expect(hopSegments[0]?.className).toContain('is-done');
    expect(hopSegments[1]?.className).toContain('is-active');
    expect(hopSegments[2]?.className).toContain('is-active');
    expect(hopSegments[3]?.className).toContain('is-active');
  });
});
