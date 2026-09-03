/**
 * Compact "where did this actually run" line attached to dispatch receipts.
 *
 * A receipt used to carry only opaque ids — `send_dispatch_…`, `tsk_…`,
 * `asg_…`. Answering "which session, which model, which provider, which pool"
 * then meant a second round trip to fetch a large task object and a model turn
 * to reason over it, per id, every time. That is the cost this removes: the
 * facts travel with the receipt, deterministically, in a handful of fields.
 *
 * Deliberately NOT the task object. It is the smallest set that lets a reader
 * identify the executor and its lane without another call, and it is built by a
 * bounded join, never by inference.
 */
import type {
  SupervisionExecutionBinding,
  SupervisionExecutionPoolKind,
} from './supervision-execution-pool.js';

/** Live session facts the join may consider. Mirrors the target catalog. */
export interface SupervisionExecutionSummaryCandidate {
  sessionName: string;
  label?: string | null;
  agentType?: string;
  providerFamily?: string;
  model?: string;
  /** Session runtime state; a dead session is not evidence of anything. */
  status?: string;
  pool?: SupervisionExecutionPoolKind;
}

export interface SupervisionExecutionSummary {
  sessionName: string;
  label?: string;
  agentType?: string;
  providerFamily?: string;
  model?: string;
  runtimeType?: 'process' | 'transport';
  pool?: SupervisionExecutionPoolKind;
  assignmentStatus?: string;
  /**
   * Which authority produced this. `assignment` is the identity the work was
   * admitted under and is durable; `live` is a best-effort catalog match and can
   * drift, so a reader that cares about provenance can tell them apart.
   */
  source: 'assignment' | 'live';
}

/** A session that is gone cannot testify to where work is running. */
const DEAD_SESSION_STATES: ReadonlySet<string> = new Set(['stopped', 'error']);

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Resolve the executor for one receipt.
 *
 * Order is not a preference, it is an authority ranking. The persisted binding
 * records what the work was actually admitted under, so it wins even when a
 * live session of the same name now reports something else — a name reused by a
 * different provider must never be able to relabel work already dispatched.
 *
 * The live fallback exists only for assignments minted before bindings were
 * persisted. It requires exactly one live, non-dead session matching the exact
 * name: two matches, none, or a dead one all return null, because a plausible
 * wrong executor is worse here than an absent one.
 */
export function buildSupervisionExecutionSummary(input: {
  binding?: SupervisionExecutionBinding | null;
  assignmentStatus?: string;
  sessionName?: string;
  candidates?: readonly SupervisionExecutionSummaryCandidate[];
}): SupervisionExecutionSummary | null {
  const assignmentStatus = text(input.assignmentStatus);

  const actual = input.binding?.actual;
  const boundName = text(actual?.sessionName);
  if (actual && boundName) {
    return {
      sessionName: boundName,
      ...(text(actual.agentType) ? { agentType: text(actual.agentType)! } : {}),
      ...(text(actual.providerFamily) ? { providerFamily: text(actual.providerFamily)! } : {}),
      ...(text(actual.model) ? { model: text(actual.model)! } : {}),
      ...(actual.runtimeType ? { runtimeType: actual.runtimeType } : {}),
      ...(input.binding?.pool ? { pool: input.binding.pool } : {}),
      ...(assignmentStatus ? { assignmentStatus } : {}),
      source: 'assignment',
    };
  }

  const wanted = text(input.sessionName);
  if (!wanted) return null;
  const matches = (input.candidates ?? []).filter((candidate) => candidate.sessionName === wanted);
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  if (match.status !== undefined && DEAD_SESSION_STATES.has(match.status)) return null;

  return {
    sessionName: wanted,
    ...(text(match.label) ? { label: text(match.label)! } : {}),
    ...(text(match.agentType) ? { agentType: text(match.agentType)! } : {}),
    ...(text(match.providerFamily) ? { providerFamily: text(match.providerFamily)! } : {}),
    ...(text(match.model) ? { model: text(match.model)! } : {}),
    ...(match.pool ? { pool: match.pool } : {}),
    ...(assignmentStatus ? { assignmentStatus } : {}),
    source: 'live',
  };
}

/**
 * Read a summary off an untrusted payload.
 *
 * The projection that reaches the browser has crossed a relay, so the shape is
 * re-established here rather than assumed. `sessionName` is the only required
 * fact -- a summary that cannot name the executor is not a summary -- and a
 * `source` outside the known set is rejected rather than passed through, so a
 * renderer can never present relayed junk as provenance.
 */
export function readSupervisionExecutionSummary(value: unknown): SupervisionExecutionSummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sessionName = text(record.sessionName);
  if (!sessionName) return null;
  const source = record.source === 'assignment' || record.source === 'live' ? record.source : null;
  if (!source) return null;
  const pool = record.pool === 'primary' || record.pool === 'economy' ? record.pool : undefined;
  const runtimeType = record.runtimeType === 'process' || record.runtimeType === 'transport'
    ? record.runtimeType
    : undefined;
  return {
    sessionName,
    ...(text(record.label) ? { label: text(record.label)! } : {}),
    ...(text(record.agentType) ? { agentType: text(record.agentType)! } : {}),
    ...(text(record.providerFamily) ? { providerFamily: text(record.providerFamily)! } : {}),
    ...(text(record.model) ? { model: text(record.model)! } : {}),
    ...(runtimeType ? { runtimeType } : {}),
    ...(pool ? { pool } : {}),
    ...(text(record.assignmentStatus) ? { assignmentStatus: text(record.assignmentStatus)! } : {}),
    source,
  };
}
