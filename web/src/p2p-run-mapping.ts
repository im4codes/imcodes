import { mapP2pStatusToUiState, type P2pActivePhase, type P2pProgressNodeStatus } from '@shared/p2p-status.js';

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function normalizeTimerAnchor(startValue: unknown, updatedValue: unknown, receivedAt: number): number | undefined {
  const start = parseTimestamp(startValue);
  if (start === undefined) return undefined;

  const updated = parseTimestamp(updatedValue);
  if (updated === undefined || updated <= receivedAt || updated < start) return start;

  // When the daemon/server clock is ahead of the browser clock, anchor the
  // timer using the persisted server delta instead of resetting to local "now"
  // on every remount.
  return start - (updated - receivedAt);
}

function parseSnapshot(rawSnapshot: unknown): Record<string, any> {
  if (typeof rawSnapshot === 'string') {
    try {
      return JSON.parse(rawSnapshot) as Record<string, any>;
    } catch {
      return {};
    }
  }
  return (rawSnapshot ?? {}) as Record<string, any>;
}

function mapLegacyNodes(source: Record<string, any>) {
  return Array.isArray(source.all_nodes) ? source.all_nodes.map((n: any) => ({
    session: typeof n.session === 'string' ? n.session : undefined,
    label: String(n.label ?? ''),
    displayLabel: String(n.displayLabel ?? n.display_label ?? n.label ?? ''),
    agentType: String(n.agentType ?? ''),
    ccPreset: n.ccPreset ?? n.cc_preset ?? null,
    mode: typeof n.mode === 'string' ? n.mode : undefined,
    phase: typeof n.phase === 'string' ? n.phase as 'initial' | 'hop' | 'summary' : undefined,
    status: String(n.status ?? 'pending') as P2pProgressNodeStatus,
  })) : undefined;
}

function mapAdvancedNodes(source: Record<string, any>) {
  return Array.isArray(source.advanced_nodes) ? source.advanced_nodes.map((n: any) => ({
    id: String(n.id ?? ''),
    label: String(n.title ?? n.id ?? ''),
    displayLabel: String(n.title ?? n.id ?? ''),
    agentType: String(n.preset ?? 'advanced'),
    ccPreset: null,
    mode: typeof n.preset === 'string' ? n.preset : undefined,
    phase: 'hop' as const,
    status: String(n.status ?? 'pending') as P2pProgressNodeStatus,
  })) : undefined;
}

export function mapP2pRunToDiscussion(r: Record<string, any>) {
  const snapshot = parseSnapshot(r.progress_snapshot);
  const source = { ...r, ...snapshot } as Record<string, any>;
  const receivedAt = Date.now();
  const advancedEnabled = source.advanced_p2p_enabled === true;
  const id = `p2p_${source.id}`;
  const status = String(source.status ?? '');
  const state = mapP2pStatusToUiState(status);
  const mode = source.mode_key ?? 'discuss';
  const initiatorLabel = source.initiator_label ?? 'brain';
  const totalCount = source.total_count ?? 3;
  const legacyTotalHops = source.total_hops ?? Math.max(0, totalCount - 2);
  const legacyNodes = mapLegacyNodes(source);
  const advancedNodes = mapAdvancedNodes(source);
  const useAdvancedNodes = advancedEnabled && Array.isArray(advancedNodes) && advancedNodes.length > 0;
  const advancedCurrentIndex = useAdvancedNodes && typeof source.current_round_id === 'string'
    ? Math.max(0, source.advanced_nodes.findIndex((n: any) => String(n.id ?? '') === source.current_round_id))
    : -1;
  const advancedCurrentNode = useAdvancedNodes && advancedCurrentIndex >= 0
    ? source.advanced_nodes[advancedCurrentIndex]
    : null;
  const currentRoundMode = advancedEnabled
    ? (typeof source.current_round_mode === 'string'
      ? source.current_round_mode
      : typeof advancedCurrentNode?.preset === 'string'
        ? advancedCurrentNode.preset
        : (typeof source.current_round_id === 'string' ? source.current_round_id : mode))
    : (source.current_round_mode ?? mode);
  const currentTarget = advancedEnabled
    ? (source.current_round_id ?? source.current_target_label ?? undefined)
    : (source.current_target_label ?? (source.current_target_session ? String(source.current_target_session).split('_').pop() : undefined));
  const hopStates = Array.isArray(source.hop_states) ? source.hop_states.map((hop: any) => ({
    hopIndex: Number(hop.hop_index ?? 0),
    roundIndex: Number(hop.round_index ?? 0),
    session: typeof hop.session === 'string' ? hop.session : undefined,
    mode: typeof hop.mode === 'string' ? hop.mode : undefined,
    status: String(hop.status ?? 'queued') as 'queued' | 'dispatched' | 'running' | 'completed' | 'timed_out' | 'failed' | 'cancelled',
  })) : undefined;

  return {
    id,
    fileId: typeof source.discussion_id === 'string' && source.discussion_id
      ? source.discussion_id
      : undefined,
    topic: `P2P ${currentRoundMode} · ${initiatorLabel}`,
    state,
    modeKey: currentRoundMode,
    currentRound: useAdvancedNodes
      ? ((advancedCurrentIndex >= 0 ? advancedCurrentIndex + 1 : 1))
      : (source.current_round ?? 1),
    maxRounds: useAdvancedNodes
      ? advancedNodes.length
      : (source.total_rounds ?? 1),
    completedHops: source.completed_hops_count ?? 0,
    completedRoundHops: typeof source.completed_round_hops_count === 'number' ? source.completed_round_hops_count : undefined,
    totalHops: useAdvancedNodes
      ? advancedNodes.length
      : legacyTotalHops,
    activeHop: source.active_hop_number ?? null,
    activeRoundHop: source.active_round_hop_number ?? null,
    activePhase: (typeof source.active_phase === 'string' ? source.active_phase : 'queued') as P2pActivePhase,
    initiatorLabel,
    currentSpeaker: currentTarget,
    conclusion: status === 'completed' ? (source.result_summary ?? source.conclusion ?? '') : '',
    error: state === 'failed' ? (source.error ?? source.terminal_reason ?? '') : '',
    nodes: useAdvancedNodes ? advancedNodes : legacyNodes,
    hopStates,
    startedAt: normalizeTimerAnchor(
      source.created_at ?? source.startedAt,
      source.updated_at ?? source.updatedAt,
      receivedAt,
    ),
    hopStartedAt: normalizeTimerAnchor(
      source.hop_started_at ?? source.hopStartedAt,
      source.updated_at ?? source.updatedAt,
      receivedAt,
    ),
  };
}

export function mergeP2pDiscussionUpdate<T extends { startedAt?: number; hopStartedAt?: number }>(existing: T | undefined, incoming: T): T {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    startedAt: incoming.startedAt ?? existing.startedAt,
    hopStartedAt: incoming.hopStartedAt ?? existing.hopStartedAt,
  };
}
