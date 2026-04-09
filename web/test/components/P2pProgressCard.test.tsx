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
import { mapP2pRunToDiscussion } from '../../src/p2p-run-mapping.js';

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

    expect(screen.getAllByText('00:00').length).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getAllByText('00:02').length).toBeGreaterThan(0);
  });

  it('keeps timers ticking during setup state before the run reaches running', () => {
    render(
      <P2pProgressCard
        discussion={{
          id: 'p2p_run_setup_timers',
          topic: 'P2P audit · brain',
          state: 'setup',
          modeKey: 'audit',
          currentRound: 1,
          maxRounds: 2,
          completedHops: 0,
          totalHops: 2,
          activeHop: 1,
          activeRoundHop: 1,
          activePhase: 'initial',
          startedAt: Date.now(),
          hopStartedAt: Date.now(),
          nodes: [
            { label: 'brain', agentType: 'codex', status: 'active', phase: 'initial' },
          ],
        }}
      />,
    );

    expect(screen.getAllByText('00:00').length).toBeGreaterThan(0);

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

  it('renders folded advanced retry history as logical rounds instead of execution steps', () => {
    const discussion = mapP2pRunToDiscussion({
      id: 'run_folded_render',
      status: 'running',
      mode_key: 'discuss',
      advanced_p2p_enabled: true,
      current_execution_step: 5,
      current_round_id: 'implementation',
      current_round_attempt: 3,
      round_attempt_counts: {
        discussion: 1,
        openspec_propose: 1,
        proposal_audit: 1,
        implementation: 3,
        implementation_audit: 2,
      },
      routing_history: [
        { fromRoundId: 'implementation_audit', toRoundId: 'implementation', atStep: 3, atAttempt: 1, timestamp: 1, trigger: 'REWORK' },
        { fromRoundId: 'implementation_audit', toRoundId: 'implementation', atStep: 4, atAttempt: 2, timestamp: 2, trigger: 'REWORK' },
      ],
      advanced_nodes: [
        { id: 'discussion', title: 'Discussion', preset: 'discussion', status: 'done' },
        { id: 'openspec_propose', title: 'OpenSpec Propose', preset: 'openspec_propose', status: 'done' },
        { id: 'proposal_audit', title: 'Proposal Audit', preset: 'proposal_audit', status: 'done' },
        { id: 'implementation', title: 'Implementation', preset: 'implementation', status: 'active' },
        { id: 'implementation_audit', title: 'Implementation Audit', preset: 'implementation_audit', status: 'pending' },
      ],
      completed_hops_count: 7,
      completed_round_hops_count: 1,
      active_phase: 'hop',
    });

    const { container } = render(<P2pProgressCard discussion={discussion} />);

    expect(screen.getAllByText('R4/5').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('implementation').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.discussions-progress-segments-round .discussions-progress-segment')).toHaveLength(5);
  });

  it('falls back to legacy nodes and counters when advanced payload lacks advanced nodes', () => {
    const discussion = mapP2pRunToDiscussion({
      id: 'run_fallback_render',
      status: 'running',
      mode_key: 'audit',
      advanced_p2p_enabled: true,
      current_round: 2,
      total_rounds: 4,
      current_target_label: 'w2',
      all_nodes: [
        { label: 'brain', agentType: 'claude-code', status: 'done', phase: 'initial' },
        { label: 'w2', agentType: 'codex', status: 'active', phase: 'hop' },
      ],
      total_hops: 4,
      completed_hops_count: 2,
      active_hop_number: 3,
      active_round_hop_number: 3,
      active_phase: 'hop',
      advanced_nodes: [],
    });

    render(<P2pProgressCard discussion={discussion} />);

    expect(screen.getAllByText('R2/4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('H3/4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('audit').length).toBeGreaterThan(0);
    expect(screen.getByText('w2')).toBeTruthy();
  });

  it('keeps legacy rendering when advanced nodes are present but advanced mode is off', () => {
    const discussion = mapP2pRunToDiscussion({
      id: 'run_fallback_render_explicit_legacy',
      status: 'running',
      mode_key: 'audit',
      advanced_p2p_enabled: false,
      current_round: 2,
      total_rounds: 4,
      current_target_label: 'w2',
      all_nodes: [
        { label: 'brain', agentType: 'claude-code', status: 'done', phase: 'initial' },
        { label: 'w2', agentType: 'codex', status: 'active', phase: 'hop' },
      ],
      total_hops: 4,
      completed_hops_count: 2,
      active_hop_number: 3,
      active_round_hop_number: 3,
      active_phase: 'hop',
      advanced_nodes: [
        { id: 'implementation', title: 'Implementation', preset: 'implementation', status: 'active' },
        { id: 'implementation_audit', title: 'Implementation Audit', preset: 'implementation_audit', status: 'pending' },
      ],
      current_round_id: 'implementation',
      current_execution_step: 5,
    });

    render(<P2pProgressCard discussion={discussion} />);

    expect(screen.getAllByText('R2/4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('H3/4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('audit').length).toBeGreaterThan(0);
    expect(screen.getByText('w2')).toBeTruthy();
  });
});
