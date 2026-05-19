import { mapP2pStatusToUiState, type P2pActivePhase, type P2pProgressNodeStatus } from '@shared/p2p-status.js';
import {
  P2P_WORKFLOW_DIAGNOSTIC_CODES,
  P2P_WORKFLOW_DIAGNOSTIC_PHASES,
  P2P_WORKFLOW_DIAGNOSTIC_SEVERITIES,
  type P2pWorkflowDiagnostic,
  type P2pWorkflowDiagnosticCode,
  type P2pWorkflowDiagnosticPhase,
  type P2pWorkflowDiagnosticSeverity,
} from '@shared/p2p-workflow-diagnostics.js';

const DIAGNOSTIC_CODES = new Set<string>(P2P_WORKFLOW_DIAGNOSTIC_CODES);
const DIAGNOSTIC_PHASES = new Set<string>(P2P_WORKFLOW_DIAGNOSTIC_PHASES);
const DIAGNOSTIC_SEVERITIES = new Set<string>(P2P_WORKFLOW_DIAGNOSTIC_SEVERITIES);

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function mapDiagnostic(raw: unknown): P2pWorkflowDiagnostic | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const code = typeof r.code === 'string' ? r.code : '';
  if (!DIAGNOSTIC_CODES.has(code)) return null;
  const phase = typeof r.phase === 'string' && DIAGNOSTIC_PHASES.has(r.phase)
    ? r.phase as P2pWorkflowDiagnosticPhase
    : 'sanitize';
  const severity = typeof r.severity === 'string' && DIAGNOSTIC_SEVERITIES.has(r.severity)
    ? r.severity as P2pWorkflowDiagnosticSeverity
    : 'error';
  const diagnostic: P2pWorkflowDiagnostic = {
    code: code as P2pWorkflowDiagnosticCode,
    phase,
    severity,
    messageKey: `p2p.workflow.diagnostics.${code as P2pWorkflowDiagnosticCode}`,
  };
  if (isString(r.summary)) diagnostic.summary = r.summary;
  if (isString(r.nodeId)) diagnostic.nodeId = r.nodeId;
  if (isString(r.runId)) diagnostic.runId = r.runId;
  if (isString(r.fieldPath)) diagnostic.fieldPath = r.fieldPath;
  return diagnostic;
}

function extractDiagnostics(source: Record<string, any>): P2pWorkflowDiagnostic[] {
  const projection = source.workflow_projection as Record<string, unknown> | undefined;
  const projectionDiags = projection && Array.isArray(projection.diagnostics)
    ? projection.diagnostics
    : null;
  const fallbackDiags = Array.isArray(source.diagnostics) ? source.diagnostics : null;
  const candidates = projectionDiags ?? fallbackDiags ?? [];
  return candidates
    .map(mapDiagnostic)
    .filter((d): d is P2pWorkflowDiagnostic => d !== null);
}

export type { P2pWorkflowDiagnostic } from '@shared/p2p-workflow-diagnostics.js';

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
    phase: typeof n.phase === 'string' ? n.phase as 'initial' | 'hop' | 'summary' | 'execution' : undefined,
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
  const source = { ...snapshot, ...r } as Record<string, any>;
  const diagnostics = extractDiagnostics(source);
  const receivedAt = Date.now();
  const updatedAt = parseTimestamp(source.updated_at ?? source.updatedAt);
  const completedAt = parseTimestamp(source.completed_at ?? source.completedAt);
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

  // Audit fix (P2P bar scoping) — preserve session-identity fields so
  // the bar in `app.tsx` can filter discussions to the active session.
  // Without these, every active main-session view rendered the bar for
  // every running P2P discussion across the whole daemon, regardless
  // of whether the user's currently-selected session participated.
  const mainSession = typeof source.main_session === 'string' && source.main_session
    ? source.main_session
    : undefined;
  const initiatorSession = typeof source.initiator_session === 'string' && source.initiator_session
    ? source.initiator_session
    : undefined;
  // Aggregate every session that participates in this run so the bar's
  // filter can match by ANY participant (initiator + every hop).
  // Falls back to mainSession only when the run has no compiled hop
  // states yet (legacy adapter projection).
  const participantSessions = (() => {
    const set = new Set<string>();
    if (initiatorSession) set.add(initiatorSession);
    if (mainSession) set.add(mainSession);
    if (typeof source.current_target_session === 'string' && source.current_target_session) {
      set.add(source.current_target_session);
    }
    if (Array.isArray(source.hop_states)) {
      for (const hop of source.hop_states) {
        if (hop && typeof hop.session === 'string' && hop.session) set.add(hop.session);
      }
    }
    if (Array.isArray(source.all_targets)) {
      for (const t of source.all_targets) {
        if (t && typeof t.session === 'string' && t.session) set.add(t.session);
      }
    }
    return set.size > 0 ? [...set] : undefined;
  })();

  return {
    id,
    fileId: typeof source.discussion_id === 'string' && source.discussion_id
      ? source.discussion_id
      : undefined,
    topic: `P2P ${currentRoundMode} · ${initiatorLabel}`,
    state,
    mainSession,
    initiatorSession,
    participantSessions,
    modeKey: currentRoundMode,
    currentRound: useAdvancedNodes
      ? ((advancedCurrentIndex >= 0 ? advancedCurrentIndex + 1 : 1))
      : (source.current_round ?? 1),
    maxRounds: useAdvancedNodes
      ? advancedNodes.length
      : (source.total_rounds ?? 1),
    flowCycleCurrent: typeof source.flow_cycle_current === 'number' ? source.flow_cycle_current : undefined,
    flowCycleTotal: typeof source.flow_cycle_total === 'number' ? source.flow_cycle_total : undefined,
    flowStepCurrent: typeof source.flow_step_current === 'number' ? source.flow_step_current : undefined,
    flowStepTotal: typeof source.flow_step_total === 'number' ? source.flow_step_total : undefined,
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
    updatedAt,
    completedAt,
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
    diagnostics,
  };
}

function isTerminalDiscussionState(state: unknown): boolean {
  return state === 'done' || state === 'failed';
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function mergeP2pDiscussionUpdate<T extends {
  startedAt?: number;
  hopStartedAt?: number;
  updatedAt?: number;
  state?: unknown;
}>(existing: T | undefined, incoming: T): T {
  if (!existing) return incoming;
  const existingTerminal = isTerminalDiscussionState(existing.state);
  const incomingTerminal = isTerminalDiscussionState(incoming.state);
  if (existingTerminal && !incomingTerminal) return existing;

  const existingUpdatedAt = finiteTimestamp(existing.updatedAt);
  const incomingUpdatedAt = finiteTimestamp(incoming.updatedAt);
  if (!incomingTerminal && existingUpdatedAt !== undefined && incomingUpdatedAt !== undefined && incomingUpdatedAt < existingUpdatedAt) {
    return existing;
  }

  return {
    ...existing,
    ...incoming,
    startedAt: incoming.startedAt ?? existing.startedAt,
    hopStartedAt: incoming.hopStartedAt ?? existing.hopStartedAt,
  };
}

export function mergeP2pStatusResponseDiscussions<T extends { id: string; startedAt?: number; hopStartedAt?: number }>(
  existing: readonly T[],
  incoming: readonly T[],
  options: { runId?: string; runFound?: boolean } = {},
): T[] {
  const explicitMissingRunId = options.runId && options.runFound === false
    ? `p2p_${options.runId}`
    : null;
  const merged = explicitMissingRunId
    ? existing.filter((d) => d.id !== explicitMissingRunId)
    : [...existing];

  for (const entry of incoming) {
    const idx = merged.findIndex((d) => d.id === entry.id);
    if (idx >= 0) merged[idx] = mergeP2pDiscussionUpdate(merged[idx], entry);
    else merged.push(entry);
  }
  return merged;
}
