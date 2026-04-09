import { describe, expect, it, vi, afterEach } from 'vitest';

import { mapP2pRunToDiscussion, mergeP2pDiscussionUpdate } from '../src/p2p-run-mapping.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('mapP2pRunToDiscussion', () => {
  it('keeps legacy payloads on legacy nodes and legacy counters', () => {
    const discussion = mapP2pRunToDiscussion({
      id: 'run_legacy',
      status: 'running',
      mode_key: 'audit',
      current_round: 2,
      total_rounds: 3,
      current_target_label: 'w1',
      all_nodes: [
        { label: 'brain', agentType: 'claude-code', status: 'done', phase: 'initial' },
        { label: 'w1', agentType: 'codex', status: 'active', phase: 'hop' },
      ],
      hop_states: [
        { hop_index: 1, round_index: 2, session: 'deck_proj_w1', mode: 'audit', status: 'running' },
      ],
      total_hops: 2,
      active_hop_number: 1,
      active_round_hop_number: 1,
      active_phase: 'hop',
    });

    expect(discussion.currentRound).toBe(2);
    expect(discussion.maxRounds).toBe(3);
    expect(discussion.nodes?.map((node) => node.label)).toEqual(['brain', 'w1']);
    expect(discussion.totalHops).toBe(2);
    expect(discussion.currentSpeaker).toBe('w1');
  });

  it('maps advanced payloads to logical rounds instead of raw execution steps', () => {
    const discussion = mapP2pRunToDiscussion({
      id: 'run_advanced',
      discussion_id: 'disc_advanced',
      status: 'running',
      mode_key: 'discuss',
      advanced_p2p_enabled: true,
      current_execution_step: 4,
      current_round_id: 'implementation_audit',
      total_rounds: 99,
      advanced_nodes: [
        { id: 'discussion', title: 'Discussion', preset: 'discussion', status: 'done' },
        { id: 'implementation', title: 'Implementation', preset: 'implementation', status: 'active' },
        { id: 'implementation_audit', title: 'Implementation Audit', preset: 'implementation_audit', status: 'pending' },
      ],
      total_hops: 42,
      completed_hops_count: 5,
      completed_round_hops_count: 2,
      active_phase: 'summary',
    });

    expect(discussion.currentRound).toBe(3);
    expect(discussion.maxRounds).toBe(3);
    expect(discussion.fileId).toBe('disc_advanced');
    expect(discussion.totalHops).toBe(3);
    expect(discussion.currentSpeaker).toBe('implementation_audit');
    expect(discussion.modeKey).toBe('implementation_audit');
    expect(discussion.topic).toContain('implementation_audit');
    expect(discussion.nodes?.map((node) => node.label)).toEqual(['Discussion', 'Implementation', 'Implementation Audit']);
  });

  it('folds retry history into the active logical round instead of exposing execution-step count', () => {
    const discussion = mapP2pRunToDiscussion({
      id: 'run_folded',
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
      total_hops: 99,
      completed_hops_count: 7,
      completed_round_hops_count: 1,
      active_phase: 'hop',
    });

    expect(discussion.currentRound).toBe(4);
    expect(discussion.maxRounds).toBe(5);
    expect(discussion.totalHops).toBe(5);
    expect(discussion.modeKey).toBe('implementation');
    expect(discussion.topic).toContain('implementation');
  });

  it('falls back cleanly to legacy counters when advanced nodes are absent', () => {
    const discussion = mapP2pRunToDiscussion({
      id: 'run_advanced_fallback',
      status: 'running',
      mode_key: 'plan',
      advanced_p2p_enabled: true,
      current_execution_step: 7,
      current_round: 2,
      total_rounds: 5,
      total_hops: 7,
      active_phase: 'hop',
    });

    expect(discussion.currentRound).toBe(2);
    expect(discussion.maxRounds).toBe(5);
    expect(discussion.totalHops).toBe(7);
    expect(discussion.nodes).toBeUndefined();
  });

  it('falls back to legacy nodes and hop counters when advanced mode lacks advanced nodes', () => {
    const discussion = mapP2pRunToDiscussion({
      id: 'run_advanced_legacy_nodes',
      status: 'running',
      mode_key: 'discuss',
      advanced_p2p_enabled: true,
      current_round: 2,
      total_rounds: 4,
      current_target_label: 'w2',
      total_hops: 4,
      completed_hops_count: 2,
      active_hop_number: 3,
      active_round_hop_number: 3,
      active_phase: 'hop',
      advanced_nodes: [],
      all_nodes: [
        { label: 'brain', agentType: 'claude-code', status: 'done', phase: 'initial' },
        { label: 'w2', agentType: 'codex', status: 'active', phase: 'hop' },
      ],
    });

    expect(discussion.currentRound).toBe(2);
    expect(discussion.maxRounds).toBe(4);
    expect(discussion.totalHops).toBe(4);
    expect(discussion.currentSpeaker).toBe('w2');
    expect(discussion.nodes?.map((node) => node.label)).toEqual(['brain', 'w2']);
  });

  it('keeps legacy semantics when advanced nodes are present but advanced mode is off', () => {
    const discussion = mapP2pRunToDiscussion({
      id: 'run_legacy_with_advanced_noise',
      status: 'running',
      mode_key: 'audit',
      advanced_p2p_enabled: false,
      current_round: 2,
      total_rounds: 4,
      current_target_label: 'w2',
      total_hops: 4,
      completed_hops_count: 2,
      active_hop_number: 3,
      active_round_hop_number: 3,
      active_phase: 'hop',
      all_nodes: [
        { label: 'brain', agentType: 'claude-code', status: 'done', phase: 'initial' },
        { label: 'w2', agentType: 'codex', status: 'active', phase: 'hop' },
      ],
      advanced_nodes: [
        { id: 'implementation', title: 'Implementation', preset: 'implementation', status: 'active' },
        { id: 'implementation_audit', title: 'Implementation Audit', preset: 'implementation_audit', status: 'pending' },
      ],
      current_round_id: 'implementation',
      current_execution_step: 5,
    });

    expect(discussion.currentRound).toBe(2);
    expect(discussion.maxRounds).toBe(4);
    expect(discussion.totalHops).toBe(4);
    expect(discussion.currentSpeaker).toBe('w2');
    expect(discussion.modeKey).toBe('audit');
    expect(discussion.nodes?.map((node) => node.label)).toEqual(['brain', 'w2']);
  });

  it('preserves p2p discussion file id for homepage navigation', () => {
    const discussion = mapP2pRunToDiscussion({
      id: 'run_nav',
      discussion_id: 'disc_nav',
      status: 'running',
      mode_key: 'audit',
      current_round: 1,
      total_rounds: 2,
      total_hops: 1,
      active_phase: 'hop',
    });

    expect(discussion.id).toBe('p2p_run_nav');
    expect(discussion.fileId).toBe('disc_nav');
  });

  it('preserves timeout serialization for round and summary boundary failures', () => {
    const summaryTimeout = mapP2pRunToDiscussion({
      id: 'run_summary_timeout',
      status: 'timed_out',
      mode_key: 'plan',
      advanced_p2p_enabled: true,
      current_round_id: 'implementation_audit',
      advanced_nodes: [
        { id: 'implementation', title: 'Implementation', preset: 'implementation', status: 'done' },
        { id: 'implementation_audit', title: 'Implementation Audit', preset: 'implementation_audit', status: 'active' },
      ],
      run_phase: 'summarizing',
      summary_phase: 'failed',
      error: 'timed_out: advanced_run_timeout',
    });

    const roundTimeout = mapP2pRunToDiscussion({
      id: 'run_round_timeout',
      status: 'timed_out',
      mode_key: 'plan',
      advanced_p2p_enabled: true,
      current_round_id: 'implementation',
      advanced_nodes: [
        { id: 'implementation', title: 'Implementation', preset: 'implementation', status: 'active' },
      ],
      run_phase: 'round_execution',
      summary_phase: null,
      error: 'timed_out: deck_proj_brain',
    });

    expect(summaryTimeout.state).toBe('failed');
    expect(summaryTimeout.error).toContain('advanced_run_timeout');
    expect(roundTimeout.state).toBe('failed');
    expect(roundTimeout.error).toContain('timed_out');
  });

  it('maps timer timestamps from both string and numeric payload fields', () => {
    const startedAt = 1_775_692_800_000;
    const hopStartedAt = startedAt + 5_000;
    const stringStamped = mapP2pRunToDiscussion({
      id: 'run_string_time',
      status: 'running',
      mode_key: 'audit',
      current_round: 1,
      total_rounds: 1,
      total_hops: 1,
      created_at: '2026-04-09T00:00:00.000Z',
      hop_started_at: startedAt,
    });

    const numericStamped = mapP2pRunToDiscussion({
      id: 'run_numeric_time',
      status: 'running',
      mode_key: 'audit',
      current_round: 1,
      total_rounds: 1,
      total_hops: 1,
      created_at: startedAt,
      hop_started_at: '2026-04-09T00:00:05.000Z',
    });

    expect(stringStamped.startedAt).toBe(startedAt);
    expect(stringStamped.hopStartedAt).toBe(startedAt);
    expect(numericStamped.startedAt).toBe(startedAt);
    expect(numericStamped.hopStartedAt).toBe(hopStartedAt);
  });

  it('adjusts persisted timer anchors when server timestamps are ahead of the browser clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-09T00:00:00.000Z'));

    const discussion = mapP2pRunToDiscussion({
      id: 'run_clock_skew',
      status: 'running',
      mode_key: 'audit',
      current_round: 1,
      total_rounds: 1,
      total_hops: 1,
      created_at: '2026-04-09T00:00:10.000Z',
      hop_started_at: '2026-04-09T00:00:40.000Z',
      updated_at: '2026-04-09T00:01:00.000Z',
    });

    expect(discussion.startedAt).toBe(Date.parse('2026-04-08T23:59:10.000Z'));
    expect(discussion.hopStartedAt).toBe(Date.parse('2026-04-08T23:59:40.000Z'));
  });

  it('preserves existing timer anchors when later run updates omit them', () => {
    const existing = {
      id: 'p2p_run_anchor',
      topic: 'P2P audit · brain',
      state: 'setup',
      currentRound: 0,
      maxRounds: 2,
      completedHops: 0,
      totalHops: 2,
      startedAt: 1_744_156_800_000,
      hopStartedAt: 1_744_156_801_000,
    };

    const incoming = {
      id: 'p2p_run_anchor',
      topic: 'P2P audit · brain',
      state: 'running',
      currentRound: 1,
      maxRounds: 2,
      completedHops: 0,
      totalHops: 2,
      startedAt: undefined,
      hopStartedAt: undefined,
    };

    const merged = mergeP2pDiscussionUpdate(existing, incoming);

    expect(merged.startedAt).toBe(existing.startedAt);
    expect(merged.hopStartedAt).toBe(existing.hopStartedAt);
    expect(merged.state).toBe('running');
    expect(merged.currentRound).toBe(1);
  });
});
