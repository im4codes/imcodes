import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  mapP2pRunToDiscussion,
  mergeP2pDiscussionUpdate,
  mergeP2pStatusResponseDiscussions,
} from '../src/p2p-run-mapping.js';

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

  it('preserves legacy flow cycle progress separately from execution steps', () => {
    const discussion = mapP2pRunToDiscussion({
      id: 'run_combo_cycle_progress',
      status: 'running',
      mode_key: 'brainstorm>discuss',
      current_round_mode: 'brainstorm',
      current_round: 3,
      total_rounds: 4,
      flow_cycle_current: 2,
      flow_cycle_total: 2,
      flow_step_current: 1,
      flow_step_total: 2,
      total_hops: 1,
      active_phase: 'hop',
    });

    expect(discussion.currentRound).toBe(3);
    expect(discussion.maxRounds).toBe(4);
    expect(discussion.flowCycleCurrent).toBe(2);
    expect(discussion.flowCycleTotal).toBe(2);
    expect(discussion.flowStepCurrent).toBe(1);
    expect(discussion.flowStepTotal).toBe(2);
  });

  it('preserves execution phase and marker-gate progress fields', () => {
    const discussion = mapP2pRunToDiscussion({
      id: 'run_execution_phase',
      status: 'running',
      mode_key: 'plan',
      current_round: 2,
      total_rounds: 2,
      flow_cycle_current: 1,
      flow_cycle_total: 1,
      active_phase: 'execution',
      execution_attempt: 2,
      execution_cycle_current: 1,
      execution_cycle_total: 1,
      all_nodes: [
        { label: 'brain', agentType: 'claude-code', status: 'done', phase: 'summary' },
        { label: 'brain', agentType: 'claude-code', status: 'active', phase: 'execution' },
      ],
    });

    expect(discussion.activePhase).toBe('execution');
    expect(discussion.nodes?.find((node) => node.phase === 'execution')?.status).toBe('active');
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

  it('keeps authoritative row status over stale progress snapshots', () => {
    const updatedAt = '2026-04-09T00:03:00.000Z';
    const completedAt = '2026-04-09T00:03:10.000Z';
    const discussion = mapP2pRunToDiscussion({
      id: 'run_done_stale_snapshot',
      status: 'completed',
      mode_key: 'audit',
      current_round: 3,
      total_rounds: 3,
      total_hops: 2,
      completed_hops_count: 2,
      active_phase: 'summary',
      updated_at: updatedAt,
      completed_at: completedAt,
      progress_snapshot: JSON.stringify({
        projectionVersion: 1,
        runId: 'run_done_stale_snapshot',
        workflowId: 'audit',
        status: 'running',
        currentRound: 1,
        completedNodeIds: [],
        diagnostics: [],
        updatedAt: '2026-04-09T00:01:00.000Z',
      }),
    });

    expect(discussion.state).toBe('done');
    expect(discussion.currentRound).toBe(3);
    expect(discussion.maxRounds).toBe(3);
    expect(discussion.updatedAt).toBe(Date.parse(updatedAt));
    expect(discussion.completedAt).toBe(Date.parse(completedAt));
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

  it('ignores stale non-terminal updates so progress cannot roll back', () => {
    const existing = {
      id: 'p2p_run_progress',
      topic: 'P2P audit · brain',
      state: 'running',
      currentRound: 3,
      maxRounds: 3,
      completedHops: 2,
      totalHops: 2,
      updatedAt: Date.parse('2026-04-09T00:03:00.000Z'),
    };

    const incoming = {
      id: 'p2p_run_progress',
      topic: 'P2P audit · brain',
      state: 'running',
      currentRound: 1,
      maxRounds: 3,
      completedHops: 0,
      totalHops: 2,
      updatedAt: Date.parse('2026-04-09T00:01:00.000Z'),
    };

    const merged = mergeP2pDiscussionUpdate(existing, incoming);

    expect(merged.currentRound).toBe(3);
    expect(merged.completedHops).toBe(2);
    expect(merged.updatedAt).toBe(existing.updatedAt);
  });

  it('does not resurrect terminal P2P entries from later stale running snapshots', () => {
    const existing = {
      id: 'p2p_run_done',
      topic: 'P2P audit · brain',
      state: 'done',
      currentRound: 3,
      maxRounds: 3,
      completedHops: 2,
      totalHops: 2,
      updatedAt: Date.parse('2026-04-09T00:03:00.000Z'),
    };

    const incoming = {
      id: 'p2p_run_done',
      topic: 'P2P audit · brain',
      state: 'running',
      currentRound: 1,
      maxRounds: 3,
      completedHops: 0,
      totalHops: 2,
      updatedAt: Date.parse('2026-04-09T00:01:00.000Z'),
    };

    const merged = mergeP2pDiscussionUpdate(existing, incoming);

    expect(merged.state).toBe('done');
    expect(merged.currentRound).toBe(3);
    expect(merged.completedHops).toBe(2);
  });

  it('still accepts terminal updates immediately', () => {
    const existing = {
      id: 'p2p_run_finishes',
      topic: 'P2P audit · brain',
      state: 'running',
      currentRound: 3,
      maxRounds: 3,
      completedHops: 2,
      totalHops: 2,
      updatedAt: Date.parse('2026-04-09T00:03:00.000Z'),
    };

    const incoming = {
      id: 'p2p_run_finishes',
      topic: 'P2P audit · brain',
      state: 'done',
      currentRound: 3,
      maxRounds: 3,
      completedHops: 2,
      totalHops: 2,
      updatedAt: Date.parse('2026-04-09T00:02:59.000Z'),
    };

    const merged = mergeP2pDiscussionUpdate(existing, incoming);

    expect(merged.state).toBe('done');
  });

  it('keeps existing P2P entries that are absent from a scoped status response', () => {
    const existing = [
      {
        id: 'p2p_run_alpha',
        topic: 'P2P audit · alpha',
        state: 'running',
        currentRound: 1,
        maxRounds: 2,
        completedHops: 0,
        totalHops: 2,
      },
      {
        id: 'p2p_run_beta',
        topic: 'P2P review · beta',
        state: 'running',
        currentRound: 1,
        maxRounds: 1,
        completedHops: 0,
        totalHops: 1,
      },
    ];

    const merged = mergeP2pStatusResponseDiscussions(existing, []);

    expect(merged.map((d) => d.id)).toEqual(['p2p_run_alpha', 'p2p_run_beta']);
  });

  it('removes only an explicitly missing status run', () => {
    const existing = [
      {
        id: 'p2p_run_alpha',
        topic: 'P2P audit · alpha',
        state: 'running',
        currentRound: 1,
        maxRounds: 2,
        completedHops: 0,
        totalHops: 2,
      },
      {
        id: 'p2p_run_beta',
        topic: 'P2P review · beta',
        state: 'running',
        currentRound: 1,
        maxRounds: 1,
        completedHops: 0,
        totalHops: 1,
      },
    ];

    const merged = mergeP2pStatusResponseDiscussions(existing, [], {
      runId: 'run_alpha',
      runFound: false,
    });

    expect(merged.map((d) => d.id)).toEqual(['p2p_run_beta']);
  });

  it('exposes workflow_projection.diagnostics on the run model', () => {
    // PR-D: the bridge now retains daemon-emitted workflow diagnostics inside
    // workflow_projection. mapP2pRunToDiscussion MUST surface them so the
    // progress card can render them with translated messageKey + summary.
    const discussion = mapP2pRunToDiscussion({
      id: 'run_with_diagnostics',
      status: 'running',
      mode_key: 'audit',
      current_round: 1,
      total_rounds: 1,
      total_hops: 1,
      active_phase: 'hop',
      workflow_projection: {
        projectionVersion: 1,
        runId: 'run_with_diagnostics',
        workflowId: 'audit',
        status: 'running',
        completedNodeIds: [],
        diagnostics: [
          {
            code: 'daemon_busy',
            phase: 'bind',
            severity: 'error',
            messageKey: 'p2p.workflow.diagnostics.daemon_busy',
            summary: 'busy',
            runId: 'run_with_diagnostics',
          },
          {
            code: 'private_projection_field_dropped',
            phase: 'sanitize',
            severity: 'warning',
            messageKey: 'p2p.workflow.diagnostics.private_projection_field_dropped',
            summary: 'Sanitized oversized workflow payload',
            runId: 'run_with_diagnostics',
          },
        ],
        updatedAt: '2026-04-09T00:00:00.000Z',
      },
    });

    expect(discussion.diagnostics).toBeDefined();
    expect(discussion.diagnostics?.map((d) => d.code).sort()).toEqual([
      'daemon_busy',
      'private_projection_field_dropped',
    ]);
    const daemonBusy = discussion.diagnostics?.find((d) => d.code === 'daemon_busy');
    expect(daemonBusy?.messageKey).toBe('p2p.workflow.diagnostics.daemon_busy');
    expect(daemonBusy?.summary).toBe('busy');
    expect(daemonBusy?.severity).toBe('error');
  });

  it('falls back to top-level diagnostics when workflow_projection is missing', () => {
    const discussion = mapP2pRunToDiscussion({
      id: 'run_legacy_diags',
      status: 'running',
      mode_key: 'audit',
      current_round: 1,
      total_rounds: 1,
      total_hops: 1,
      active_phase: 'hop',
      diagnostics: [
        {
          code: 'missing_required_capability',
          phase: 'bind',
          severity: 'error',
          messageKey: 'p2p.workflow.diagnostics.missing_required_capability',
        },
      ],
    });

    expect(discussion.diagnostics?.map((d) => d.code)).toEqual(['missing_required_capability']);
  });

  it('drops unknown diagnostic codes from the run mapping', () => {
    const discussion = mapP2pRunToDiscussion({
      id: 'run_bad_diags',
      status: 'running',
      mode_key: 'audit',
      current_round: 1,
      total_rounds: 1,
      total_hops: 1,
      active_phase: 'hop',
      workflow_projection: {
        projectionVersion: 1,
        runId: 'run_bad_diags',
        workflowId: 'audit',
        status: 'running',
        completedNodeIds: [],
        diagnostics: [
          { code: 'totally_made_up_code', phase: 'execute', severity: 'error' },
          { code: 'daemon_busy', phase: 'bind', severity: 'error' },
        ],
        updatedAt: '2026-04-09T00:00:00.000Z',
      },
    });

    expect(discussion.diagnostics?.map((d) => d.code)).toEqual(['daemon_busy']);
  });

  // Audit fix (P2P bar scoping) — pin the contract that the mapping
  // preserves session-identity fields so `app.tsx` can filter the bar
  // to the user's current session view. Without these, every active
  // session view rendered the bar for every running P2P discussion
  // across the daemon.
  describe('session-identity fields for bar scoping', () => {
    it('preserves mainSession + initiatorSession + participantSessions for advanced runs', () => {
      const discussion = mapP2pRunToDiscussion({
        id: 'run_with_sessions',
        status: 'running',
        mode_key: 'discuss',
        current_round: 1,
        total_rounds: 1,
        active_phase: 'hop',
        main_session: 'deck_proj_brain',
        initiator_session: 'deck_proj_brain',
        current_target_session: 'deck_sub_a',
        hop_states: [
          { hop_index: 1, round_index: 1, session: 'deck_sub_a', status: 'running' },
          { hop_index: 2, round_index: 1, session: 'deck_sub_b', status: 'queued' },
        ],
      });

      expect(discussion.mainSession).toBe('deck_proj_brain');
      expect(discussion.initiatorSession).toBe('deck_proj_brain');
      // De-duplicated set: initiator + main + current target + every hop session.
      expect(discussion.participantSessions?.sort()).toEqual([
        'deck_proj_brain', 'deck_sub_a', 'deck_sub_b',
      ]);
    });

    it('omits session fields when run payload lacks them (legacy)', () => {
      const discussion = mapP2pRunToDiscussion({
        id: 'run_legacy_no_session',
        status: 'running',
        mode_key: 'audit',
        current_round: 1,
        total_rounds: 1,
        total_hops: 0,
        active_phase: 'queued',
      });

      expect(discussion.mainSession).toBeUndefined();
      expect(discussion.initiatorSession).toBeUndefined();
      // Legacy: undefined — caller treats this as "show unscoped".
      expect(discussion.participantSessions).toBeUndefined();
    });

    it('aggregates participants from all_targets when hop_states is absent', () => {
      const discussion = mapP2pRunToDiscussion({
        id: 'run_pre_dispatch',
        status: 'queued',
        mode_key: 'audit',
        current_round: 1,
        total_rounds: 1,
        active_phase: 'queued',
        main_session: 'deck_proj_brain',
        initiator_session: 'deck_proj_brain',
        all_targets: [
          { session: 'deck_sub_a', mode: 'audit' },
          { session: 'deck_sub_b', mode: 'audit' },
        ],
      });

      expect(discussion.participantSessions?.sort()).toEqual([
        'deck_proj_brain', 'deck_sub_a', 'deck_sub_b',
      ]);
    });
  });
});
