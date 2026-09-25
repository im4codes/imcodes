/**
 * Marker-driven executor + auditor task pairs (the `pairs` supervision engine).
 *
 * Models signal progress with one-line markers in their own output; the daemon
 * parses them, advances the lenient state machine below, and projects the
 * result to the web UI. Nothing here refuses work: every well-formed marker is
 * recorded, applied when it makes sense, and otherwise kept as history.
 *
 * Kept from the legacy system: the P0-P4 severity contract
 * (`audit_convergence_v1`) judges verdict markers, and participants come from
 * the execution model pool.
 */
import {
  AUDIT_CONVERGENCE_CONTRACT_ID,
  AUDIT_SEVERITY_LEVELS,
  normalizeAuditBlockingSeverities,
  type AuditSeverity,
} from './audit-convergence.js';
import { advanceMarkdownFence, type MarkdownFenceState } from './markdown-fence.js';

export const TASK_PAIR_CONTRACT_ID = 'task_pair_markers_v1' as const;
export const TASK_PAIR_MARKER_TAG = 'IMCODES_TASK' as const;
export const TASK_PAIR_BRIEF_END_TAG = 'IMCODES_TASK_END' as const;
/** Timeline event carrying every applied or recorded marker event. */
export const TASK_PAIR_TIMELINE_EVENT = 'task_pair.event' as const;
/** Every daemon-authored pair message id starts with this prefix plus the task id. */
export const TASK_PAIR_NUDGE_ID_PREFIX = 'task-pair-nudge:' as const;
/** Hook path through which MCP child processes hand legacy supervision tool calls to the daemon. */
export const TASK_PAIR_LEGACY_TOOL_HOOK_PATH = '/task-pairs/legacy-tool' as const;
/** Automation kind stamped on daemon-authored pair messages. */
export const TASK_PAIR_AUTOMATION_KIND = 'task-pair' as const;

export const TASK_PAIR_ENGINES = ['pairs', 'legacy'] as const;
export type TaskPairEngine = typeof TASK_PAIR_ENGINES[number];
export const TASK_PAIR_DEFAULT_ENGINE: TaskPairEngine = 'pairs';
/** Global override for every project, e.g. `IMCODES_SUPERVISION_ENGINE=legacy`. */
export const TASK_PAIR_ENGINE_ENV = 'IMCODES_SUPERVISION_ENGINE' as const;

export const TASK_PAIR_DEFAULT_MAX_CONCURRENCY = 5;
export const TASK_PAIR_HEARTBEAT_MS = 6 * 60_000;
/** Silent ticks before a side stops being nudged and escalates. */
export const TASK_PAIR_SILENCE_LIMIT = 3;
/** Marker-triggered daemon messages per pair, per reason, per audit round. */
export const TASK_PAIR_MESSAGE_CAP_PER_ROUND = 2;
export const TASK_PAIR_ATTR_VALUE_MAX = 500;
export const TASK_PAIR_BRIEF_MAX_BYTES = 256 * 1024;
/** `auditor=none`: no audit wanted. */
export const TASK_PAIR_NO_AUDITOR = 'none' as const;
/** Task id meaning "the writer's single open pair" (or, for `QUEUE - max=`, the writer's queue). */
export const TASK_PAIR_INFER_TASK_ID = '-' as const;

export const TASK_PAIR_VERBS = [
  'DISPATCH', 'QUEUE', 'STARTED', 'WORKING', 'READY_FOR_AUDIT', 'PASS', 'REWORK',
  'DONE', 'BLOCKED', 'NEEDS_INPUT', 'REASSIGN', 'CANCEL',
] as const;
export type TaskPairVerb = typeof TASK_PAIR_VERBS[number];

export const TASK_PAIR_STATUSES = [
  'queued', 'working', 'in_audit', 'awaiting_audit', 'rework', 'passed', 'done', 'cancelled',
] as const;
export type TaskPairStatus = typeof TASK_PAIR_STATUSES[number];
export const TASK_PAIR_TERMINAL_STATUSES: readonly TaskPairStatus[] = ['done', 'cancelled'];
/** Statuses that occupy a concurrency slot. */
export const TASK_PAIR_OPEN_STATUSES: readonly TaskPairStatus[] = ['working', 'in_audit', 'awaiting_audit', 'rework', 'passed'];

export const TASK_PAIR_FLAGS = [
  'blocked', 'needs_input', 'unaudited', 'needs_auditor', 'over_limit', 'off_pool', 'economy_unreviewed',
  'waiting_for_capacity', 'executor_silent', 'verdict_inconsistent', 'awaiting_audit_ignored',
  'replacement_churn', 'markers_unresolved',
] as const;
export type TaskPairFlag = typeof TASK_PAIR_FLAGS[number];

export const TASK_PAIR_ROLES = ['brain', 'executor', 'auditor', 'other', 'daemon'] as const;
export type TaskPairRole = typeof TASK_PAIR_ROLES[number];

export const TASK_PAIR_EVENT_SOURCES = ['marker', 'implicit_dispatch', 'legacy_tool', 'legacy_import', 'heartbeat', 'queue'] as const;
export type TaskPairEventSource = typeof TASK_PAIR_EVENT_SOURCES[number];

/** Reasons for marker-triggered daemon messages; each is capped per round. */
export const TASK_PAIR_CAPPED_REASONS = {
  verdict_correction: 'verdict_inconsistent',
  done_reminder: 'awaiting_audit_ignored',
  blocked_replacement: 'replacement_churn',
  unresolved_hint: 'markers_unresolved',
} as const satisfies Record<string, TaskPairFlag>;
export type TaskPairCappedReason = keyof typeof TASK_PAIR_CAPPED_REASONS;

export const TASK_PAIR_VERDICT_JUDGEMENTS = ['consistent', 'inconsistent', 'missing_severity', 'implicit_zero'] as const;
export type TaskPairVerdictJudgement = typeof TASK_PAIR_VERDICT_JUDGEMENTS[number];

export type TaskPairSeverityCounts = Record<AuditSeverity, number>;

// ---------------------------------------------------------------------------
// Allowlist (daemon picks only)
// ---------------------------------------------------------------------------

export const TASK_PAIR_ALLOWLIST_ROLES = ['executor', 'auditor', 'both'] as const;
export type TaskPairAllowlistRole = typeof TASK_PAIR_ALLOWLIST_ROLES[number];

export interface TaskPairAllowlistEntry {
  role: TaskPairAllowlistRole;
  agentType: string;
  /** Case-insensitive substring of the normalized model id. Empty matches any model. */
  modelPattern: string;
}

/** Owner routing policy: executors on Codex gpt-6-luna, auditors on Claude Opus. */
export const TASK_PAIR_DEFAULT_ALLOWLIST: readonly TaskPairAllowlistEntry[] = [
  { role: 'executor', agentType: 'codex-sdk', modelPattern: 'gpt-6-luna' },
  { role: 'auditor', agentType: 'claude-code-sdk', modelPattern: 'opus' },
];

export function normalizeTaskPairAllowlist(value: unknown): TaskPairAllowlistEntry[] {
  if (!Array.isArray(value)) return TASK_PAIR_DEFAULT_ALLOWLIST.map((entry) => ({ ...entry }));
  const entries: TaskPairAllowlistEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const role = (TASK_PAIR_ALLOWLIST_ROLES as readonly string[]).includes(String(record.role))
      ? record.role as TaskPairAllowlistRole
      : 'both';
    const agentType = typeof record.agentType === 'string' ? record.agentType.trim() : '';
    const modelPattern = typeof record.modelPattern === 'string' ? record.modelPattern.trim() : '';
    if (!agentType) continue;
    entries.push({ role, agentType, modelPattern });
  }
  return entries;
}

export function matchesTaskPairAllowlist(
  allowlist: readonly TaskPairAllowlistEntry[],
  role: 'executor' | 'auditor',
  agentType: string,
  model: string | undefined,
): boolean {
  const normalizedModel = (model ?? '').toLowerCase();
  return allowlist.some((entry) => (
    (entry.role === 'both' || entry.role === role)
    && entry.agentType === agentType
    && (!entry.modelPattern || normalizedModel.includes(entry.modelPattern.toLowerCase()))
  ));
}

// ---------------------------------------------------------------------------
// Marker grammar and parsing
// ---------------------------------------------------------------------------

export interface TaskPairMarker {
  verb: string;
  /** Upper-cased known verb, or undefined for an unrecognized one. */
  knownVerb?: TaskPairVerb;
  taskId: string;
  attrs: Record<string, string>;
  lineIndex: number;
  /** Position among markers of this turn; with the turn id this is the idempotency key. */
  markerIndex: number;
  /** QUEUE brief captured between the marker and its END line, verbatim. */
  brief?: string;
  /** QUEUE without a matching END in the same turn. */
  briefMissing?: boolean;
}

export interface TaskPairMarkerScan {
  markers: TaskPairMarker[];
  /** Line indexes of active marker and END lines, hidden from display. */
  markerLineIndexes: number[];
}

const MARKER_LINE_RE = new RegExp(
  String.raw`^[ \t]{0,3}<!--\s*${TASK_PAIR_MARKER_TAG}\s+([A-Za-z_]+)\s+([A-Za-z0-9._:-]{1,64}|-)`
  + String.raw`((?:\s+[a-z0-9_]+=(?:"(?:[^"\\]|\\.){0,${TASK_PAIR_ATTR_VALUE_MAX}}"|[^\s">]+))*)\s*-->[ \t]*$`,
);
const ATTR_RE = /([a-z0-9_]+)=(?:"((?:[^"\\]|\\.)*)"|([^\s">]+))/g;

function briefEndLineRe(taskId: string): RegExp {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`^[ \t]{0,3}<!--\s*${TASK_PAIR_BRIEF_END_TAG}\s+${escaped}\s*-->[ \t]*$`);
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTR_RE)) {
    const key = match[1]!;
    const value = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3]!;
    attrs[key] = value;
  }
  return attrs;
}

function knownVerb(verb: string): TaskPairVerb | undefined {
  const upper = verb.toUpperCase();
  return (TASK_PAIR_VERBS as readonly string[]).includes(upper) ? upper as TaskPairVerb : undefined;
}

/**
 * Scan assistant-authored text for task-pair markers. Markers inside fenced
 * code, inline in prose, or inside a QUEUE brief are not protocol.
 */
export function scanTaskPairMarkers(text: string): TaskPairMarkerScan {
  const lines = text.split(/\r?\n/u);
  const markers: TaskPairMarker[] = [];
  const markerLineIndexes: number[] = [];
  let fence: MarkdownFenceState | undefined;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const advanced = advanceMarkdownFence(line, fence);
    fence = advanced.fence;
    if (advanced.fenced) continue;
    const match = line.match(MARKER_LINE_RE);
    if (!match) continue;
    const verb = match[1]!;
    const taskId = match[2]!;
    const marker: TaskPairMarker = {
      verb,
      knownVerb: knownVerb(verb),
      taskId,
      attrs: parseAttrs(match[3] ?? ''),
      lineIndex,
      markerIndex: markers.length,
    };
    markerLineIndexes.push(lineIndex);
    if (marker.knownVerb === 'QUEUE' && taskId !== TASK_PAIR_INFER_TASK_ID) {
      // The brief runs to the matching END line regardless of fences inside it.
      const endRe = briefEndLineRe(taskId);
      let endIndex = -1;
      for (let probe = lineIndex + 1; probe < lines.length; probe += 1) {
        if (endRe.test(lines[probe]!)) { endIndex = probe; break; }
      }
      if (endIndex >= 0) {
        const brief = lines.slice(lineIndex + 1, endIndex).join('\n');
        marker.brief = brief.length > TASK_PAIR_BRIEF_MAX_BYTES ? brief.slice(0, TASK_PAIR_BRIEF_MAX_BYTES) : brief;
        markerLineIndexes.push(endIndex);
        lineIndex = endIndex;
        fence = undefined;
      } else {
        marker.briefMissing = true;
      }
    }
    markers.push(marker);
  }
  return { markers, markerLineIndexes };
}

/** Hide active marker and END lines from displayed assistant text; briefs stay visible. */
export function stripTaskPairMarkersForDisplay(text: string): string {
  const { markerLineIndexes } = scanTaskPairMarkers(text);
  if (markerLineIndexes.length === 0) return text;
  const hidden = new Set(markerLineIndexes);
  return text.split(/\r?\n/u).filter((_line, index) => !hidden.has(index)).join('\n');
}

/** Cheap pre-check before a full scan. */
export function mayContainTaskPairMarker(text: string): boolean {
  return text.includes(TASK_PAIR_MARKER_TAG);
}

// ---------------------------------------------------------------------------
// Severity judgement (audit_convergence_v1)
// ---------------------------------------------------------------------------

export function emptySeverityCounts(): TaskPairSeverityCounts {
  return { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 };
}

export function parseBlockingAttr(value: string | undefined): AuditSeverity[] | undefined {
  if (value === undefined) return undefined;
  return normalizeAuditBlockingSeverities(value.split(',').map((level) => level.trim().toUpperCase()));
}

export interface TaskPairVerdictJudgementResult {
  judgement: TaskPairVerdictJudgement;
  counts: TaskPairSeverityCounts;
  blockingCount: number;
  statedBlocking?: AuditSeverity[];
  blockingMismatch: boolean;
}

/**
 * Judge a PASS/REWORK against the pair's blocking set: REWORK needs at least
 * one blocking finding, PASS none. A PASS with no severity at all is the common
 * "no findings" case and counts as zero.
 */
export function judgeTaskPairVerdict(
  verb: 'PASS' | 'REWORK',
  attrs: Record<string, string>,
  pairBlocking: readonly AuditSeverity[],
): TaskPairVerdictJudgementResult {
  const counts = emptySeverityCounts();
  let hasSeverity = attrs.blocking !== undefined;
  for (const level of AUDIT_SEVERITY_LEVELS) {
    const raw = attrs[level.toLowerCase()];
    if (raw === undefined) continue;
    hasSeverity = true;
    const parsed = Number.parseInt(raw, 10);
    counts[level] = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  const statedBlocking = parseBlockingAttr(attrs.blocking);
  const blockingMismatch = !!statedBlocking
    && statedBlocking.join(',') !== [...pairBlocking].join(',');
  const blockingCount = pairBlocking.reduce((sum, level) => sum + counts[level], 0);
  let judgement: TaskPairVerdictJudgement;
  if (!hasSeverity) judgement = verb === 'PASS' ? 'implicit_zero' : 'missing_severity';
  else if (verb === 'REWORK') judgement = blockingCount >= 1 ? 'consistent' : 'inconsistent';
  else judgement = blockingCount === 0 ? 'consistent' : 'inconsistent';
  return { judgement, counts, blockingCount, statedBlocking, blockingMismatch };
}

export function isAppliedVerdict(judgement: TaskPairVerdictJudgement): boolean {
  return judgement === 'consistent' || judgement === 'implicit_zero';
}

// ---------------------------------------------------------------------------
// Pair state and the lenient state machine
// ---------------------------------------------------------------------------

export interface TaskPairState {
  taskId: string;
  brain: string;
  executor?: string;
  /** Session name, `none` for no audit, or undefined while one is being picked. */
  auditor?: string;
  title?: string;
  status: TaskPairStatus;
  flags: TaskPairFlag[];
  /** Which side set `blocked` / `needs_input`, so that side's progress clears it. */
  flagSides: Partial<Record<'blocked' | 'needs_input', TaskPairRole>>;
  /** Audit submissions so far. */
  round: number;
  /** Round in which a consistent PASS was recorded, if any. */
  passRound?: number;
  blocking: AuditSeverity[];
  lastVerdict?: { verb: 'PASS' | 'REWORK'; counts: TaskPairSeverityCounts; judgement: TaskPairVerdictJudgement; round: number };
  previousAuditors: string[];
  executorPool?: string;
  auditorPool?: string;
  brief?: string;
  /** Marker-triggered messages sent this round, per capped reason. */
  capCounts: Partial<Record<TaskPairCappedReason, number>>;
  capRound: number;
  createdAt: number;
  updatedAt: number;
}

export type TaskPairIntent =
  | { kind: 'pick_auditor' }
  | { kind: 'pick_executor' }
  | { kind: 'correction'; to: string; judgement: TaskPairVerdictJudgement }
  | { kind: 'done_reminder'; to: string }
  | { kind: 'rework_notice'; to: string; counts: TaskPairSeverityCounts }
  | { kind: 'replace_auditor'; reason: 'executor_blocked' }
  | { kind: 'brain_notice'; flag: TaskPairFlag }
  | { kind: 'slot_changed' }
  | { kind: 'queue_settings'; brain: string; maxConcurrency: number };

export interface TaskPairTransition {
  /** New or updated pair; undefined when the marker only created nothing (recorded). */
  pair?: TaskPairState;
  fromStatus?: TaskPairStatus;
  toStatus?: TaskPairStatus;
  /** Short machine description of what happened, e.g. `status`, `recorded`, `roles`. */
  effect: string;
  unusual: boolean;
  intents: TaskPairIntent[];
  verdict?: TaskPairVerdictJudgementResult;
}

export interface TaskPairApplyContext {
  /** Session that wrote the marker, or `daemon`. */
  writer: string;
  /** Project Brain used when a pair is created without a known dispatcher. */
  fallbackBrain: string;
  /** Project default blocking set. */
  projectBlocking?: readonly AuditSeverity[];
  now: number;
  source: TaskPairEventSource;
}

export function isTerminalTaskPairStatus(status: TaskPairStatus): boolean {
  return TASK_PAIR_TERMINAL_STATUSES.includes(status);
}

export function taskPairRoleOf(pair: TaskPairState | undefined, writer: string): TaskPairRole {
  if (writer === 'daemon') return 'daemon';
  if (!pair) return 'other';
  if (writer === pair.brain) return 'brain';
  if (writer === pair.executor) return 'executor';
  if (writer === pair.auditor) return 'auditor';
  return 'other';
}

/**
 * Pair binding id: what a `pairs`-engine send_message receipt returns (and
 * records on each delivery) as `assignmentId`.
 *
 * Format: `pair:<taskId>:executor` or `pair:<taskId>:auditor`. It names one
 * role slot of one pair, so it stays the same across replays and across a
 * replacement of the session in that slot; the session itself is the
 * delivery `target`. The `pairs` engine has no registry assignments, so this is
 * NOT a legacy registry assignment id and is never looked up there. It exists
 * so every consumer of the `{ taskId, assignmentId }` receipt contract
 * (delegation claim, dispatch card, legacy tools) works on both engines
 * without asking which engine produced it.
 */
export const TASK_PAIR_BINDING_ID_PREFIX = 'pair' as const;
export const TASK_PAIR_BINDING_ROLES = ['executor', 'auditor'] as const;
export type TaskPairBindingRole = typeof TASK_PAIR_BINDING_ROLES[number];

export function taskPairBindingId(taskId: string, role: TaskPairBindingRole): string {
  return `${TASK_PAIR_BINDING_ID_PREFIX}:${taskId}:${role}`;
}

export function parseTaskPairBindingId(value: unknown): { taskId: string; role: TaskPairBindingRole } | undefined {
  if (typeof value !== 'string') return undefined;
  const prefix = `${TASK_PAIR_BINDING_ID_PREFIX}:`;
  if (!value.startsWith(prefix)) return undefined;
  const cut = value.lastIndexOf(':');
  const taskId = value.slice(prefix.length, cut);
  const role = value.slice(cut + 1);
  if (cut < prefix.length || !taskId || !(TASK_PAIR_BINDING_ROLES as readonly string[]).includes(role)) return undefined;
  return { taskId, role: role as TaskPairBindingRole };
}

/** The binding a session holds in a pair, if it is the executor or the auditor. */
export function taskPairBindingOf(pair: TaskPairState | undefined, sessionName: string): string | undefined {
  if (!pair) return undefined;
  if (sessionName === pair.executor) return taskPairBindingId(pair.taskId, 'executor');
  if (sessionName === pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR) return taskPairBindingId(pair.taskId, 'auditor');
  return undefined;
}

function hasAudit(pair: TaskPairState): boolean {
  return pair.auditor !== TASK_PAIR_NO_AUDITOR;
}

function addFlag(pair: TaskPairState, flag: TaskPairFlag): void {
  if (!pair.flags.includes(flag)) pair.flags.push(flag);
}

function removeFlag(pair: TaskPairState, flag: TaskPairFlag): void {
  pair.flags = pair.flags.filter((existing) => existing !== flag);
}

function clonePair(pair: TaskPairState): TaskPairState {
  return {
    ...pair,
    flags: [...pair.flags],
    flagSides: { ...pair.flagSides },
    blocking: [...pair.blocking],
    previousAuditors: [...pair.previousAuditors],
    capCounts: { ...pair.capCounts },
    lastVerdict: pair.lastVerdict ? { ...pair.lastVerdict, counts: { ...pair.lastVerdict.counts } } : undefined,
  };
}

function newPair(taskId: string, brain: string, ctx: TaskPairApplyContext, status: TaskPairStatus): TaskPairState {
  return {
    taskId,
    brain,
    status,
    flags: [],
    flagSides: {},
    round: 0,
    blocking: normalizeAuditBlockingSeverities(ctx.projectBlocking),
    previousAuditors: [],
    capCounts: {},
    capRound: 0,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

/** Try to spend one capped message; past the cap set the flag and tell Brain once. */
function spendCap(pair: TaskPairState, reason: TaskPairCappedReason, intents: TaskPairIntent[]): boolean {
  if (pair.capRound !== pair.round) {
    pair.capRound = pair.round;
    pair.capCounts = {};
  }
  const used = pair.capCounts[reason] ?? 0;
  if (used < TASK_PAIR_MESSAGE_CAP_PER_ROUND) {
    pair.capCounts[reason] = used + 1;
    return true;
  }
  const flag = TASK_PAIR_CAPPED_REASONS[reason];
  if (!pair.flags.includes(flag)) {
    addFlag(pair, flag);
    intents.push({ kind: 'brain_notice', flag });
  }
  return false;
}

/** A new round or a Brain action clears the cap flags and counters. */
function resetCaps(pair: TaskPairState): void {
  pair.capCounts = {};
  pair.capRound = pair.round;
  for (const flag of Object.values(TASK_PAIR_CAPPED_REASONS)) removeFlag(pair, flag);
}

function setRolesFromAttrs(pair: TaskPairState, attrs: Record<string, string>, intents: TaskPairIntent[]): void {
  if (attrs.executor) pair.executor = attrs.executor;
  if (attrs.auditor) {
    if (pair.auditor && pair.auditor !== attrs.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR) {
      pair.previousAuditors.push(pair.auditor);
    }
    pair.auditor = attrs.auditor;
    removeFlag(pair, 'needs_auditor');
  }
  if (attrs.title) pair.title = attrs.title;
  if (attrs.pool) pair.executorPool = attrs.pool;
  const blocking = parseBlockingAttr(attrs.blocking);
  if (blocking) pair.blocking = blocking;
  if (!pair.auditor) {
    addFlag(pair, 'needs_auditor');
    intents.push({ kind: 'pick_auditor' });
  }
}

const PROGRESS_VERBS: readonly TaskPairVerb[] = ['DISPATCH', 'STARTED', 'WORKING', 'READY_FOR_AUDIT', 'PASS', 'REWORK', 'DONE'];

function clearSideFlags(pair: TaskPairState, role: TaskPairRole): void {
  for (const flag of ['blocked', 'needs_input'] as const) {
    if (pair.flagSides[flag] === role) {
      removeFlag(pair, flag);
      delete pair.flagSides[flag];
    }
  }
}

function recorded(pair: TaskPairState | undefined, unusual = true): TaskPairTransition {
  return { pair: undefined, fromStatus: pair?.status, toStatus: pair?.status, effect: 'recorded', unusual, intents: [] };
}

/**
 * Apply one marker to a pair. Pure: returns the updated pair (never mutates the
 * input) and the daemon intents to execute. Never throws, never refuses.
 */
export function applyTaskPairMarker(
  existing: TaskPairState | undefined,
  marker: Pick<TaskPairMarker, 'knownVerb' | 'taskId' | 'attrs' | 'brief' | 'briefMissing'>,
  ctx: TaskPairApplyContext,
): TaskPairTransition {
  const verb = marker.knownVerb;
  if (!verb) return { ...recorded(existing), effect: 'unrecognized' };
  const intents: TaskPairIntent[] = [];
  const role = taskPairRoleOf(existing, ctx.writer);
  const roleAuthority = role === 'brain' || role === 'daemon';
  const attrs = marker.attrs;
  const fromStatus = existing?.status;

  if (verb === 'QUEUE' && marker.taskId === TASK_PAIR_INFER_TASK_ID) {
    const max = Number.parseInt(attrs.max ?? '', 10);
    if (Number.isFinite(max) && max > 0) {
      intents.push({ kind: 'queue_settings', brain: ctx.writer, maxConcurrency: max });
      return { effect: 'queue_settings', unusual: false, intents };
    }
    return { ...recorded(undefined), effect: 'recorded' };
  }
  // `-` is resolved by ingestion; an unresolved one never names a pair.
  if (marker.taskId === TASK_PAIR_INFER_TASK_ID) return { ...recorded(existing), effect: 'unresolved' };

  // ---- no pair yet ------------------------------------------------------
  if (!existing) {
    switch (verb) {
      case 'QUEUE': {
        const pair = newPair(marker.taskId, ctx.writer, ctx, 'queued');
        setRolesFromAttrsQueued(pair, attrs);
        if (marker.brief !== undefined) pair.brief = marker.brief;
        return { pair, toStatus: 'queued', effect: 'created', unusual: false, intents: [{ kind: 'slot_changed' }] };
      }
      case 'DISPATCH': {
        const pair = newPair(marker.taskId, ctx.writer, ctx, 'working');
        setRolesFromAttrs(pair, attrs, intents);
        if (!pair.executor) intents.push({ kind: 'pick_executor' });
        return { pair, toStatus: 'working', effect: 'created', unusual: false, intents };
      }
      case 'STARTED':
      case 'WORKING':
      case 'READY_FOR_AUDIT':
      case 'DONE': {
        const pair = newPair(marker.taskId, ctx.fallbackBrain, ctx, 'working');
        pair.executor = ctx.writer;
        setRolesFromAttrs(pair, attrs, intents);
        if (verb === 'READY_FOR_AUDIT' && hasAudit(pair)) {
          pair.status = 'in_audit';
          pair.round = 1;
        } else if (verb === 'DONE') {
          if (!hasAudit(pair)) pair.status = 'done';
          else {
            pair.status = 'awaiting_audit';
            if (spendCap(pair, 'done_reminder', intents)) intents.push({ kind: 'done_reminder', to: ctx.writer });
          }
        }
        return { pair, toStatus: pair.status, effect: 'created', unusual: true, intents };
      }
      case 'PASS':
      case 'REWORK': {
        const pair = newPair(marker.taskId, ctx.fallbackBrain, ctx, 'in_audit');
        pair.auditor = ctx.writer;
        pair.round = 1;
        const verdict = judgeTaskPairVerdict(verb, attrs, pair.blocking);
        applyVerdict(pair, verb, verdict, ctx.writer, intents);
        return { pair, toStatus: pair.status, effect: 'created', unusual: true, intents, verdict };
      }
      default:
        return recorded(undefined);
    }
  }

  // A queued pair without an executor leaves the queue only through its Brain
  // or the daemon's dispatch; anyone else's progress is recorded, so no open
  // pair can exist that nobody drives.
  if (existing.status === 'queued' && !existing.executor && !roleAuthority
    && (verb === 'STARTED' || verb === 'WORKING' || verb === 'READY_FOR_AUDIT' || verb === 'DONE')) {
    return recorded(existing);
  }

  const pair = clonePair(existing);
  pair.updatedAt = ctx.now;
  const terminal = isTerminalTaskPairStatus(pair.status);
  let unusual = role === 'other';
  if (PROGRESS_VERBS.includes(verb)) clearSideFlags(pair, role);

  const done = (effect: string, extra: Partial<TaskPairTransition> = {}): TaskPairTransition => ({
    pair, fromStatus, toStatus: pair.status, effect, unusual, intents, ...extra,
  });

  switch (verb) {
    case 'QUEUE': {
      if (!roleAuthority) return recorded(existing);
      if (pair.status === 'queued') {
        setRolesFromAttrsQueued(pair, attrs);
        if (marker.brief !== undefined) pair.brief = marker.brief;
        return done('updated');
      }
      if (terminal) {
        pair.status = 'queued';
        setRolesFromAttrsQueued(pair, attrs);
        if (marker.brief !== undefined) pair.brief = marker.brief;
        unusual = true;
        intents.push({ kind: 'slot_changed' });
        return done('reopened');
      }
      return recorded(existing);
    }
    case 'DISPATCH': {
      // Roles change only through the pair's Brain or the daemon.
      if (!roleAuthority) return recorded(existing);
      if (terminal) unusual = true;
      resetCaps(pair);
      setRolesFromAttrs(pair, attrs, intents);
      if (!pair.executor) intents.push({ kind: 'pick_executor' });
      if (pair.status === 'queued' || terminal) {
        pair.status = 'working';
        intents.push({ kind: 'slot_changed' });
      }
      return done('dispatched');
    }
    case 'STARTED':
    case 'WORKING': {
      if (pair.status === 'in_audit' || pair.status === 'passed' || terminal) unusual = true;
      if (terminal) intents.push({ kind: 'slot_changed' });
      pair.status = 'working';
      return done('status');
    }
    case 'READY_FOR_AUDIT': {
      if (!hasAudit(pair)) return recorded(existing);
      if (pair.status === 'in_audit') return done('status');
      if (pair.status === 'queued' || pair.status === 'passed' || terminal) unusual = true;
      if (terminal) intents.push({ kind: 'slot_changed' });
      pair.status = 'in_audit';
      pair.round += 1;
      resetCaps(pair);
      removeFlag(pair, 'executor_silent');
      if (!pair.auditor) {
        addFlag(pair, 'needs_auditor');
        intents.push({ kind: 'pick_auditor' });
      }
      return done('status');
    }
    case 'PASS':
    case 'REWORK': {
      if (!hasAudit(pair)) return recorded(existing);
      if (role !== 'auditor' && role !== 'brain' && role !== 'daemon') unusual = true;
      const verdict = judgeTaskPairVerdict(verb, attrs, pair.blocking);
      if (verdict.blockingMismatch) unusual = true;
      if (terminal && verb === 'PASS') {
        pair.lastVerdict = { verb, counts: verdict.counts, judgement: verdict.judgement, round: pair.round };
        return done('recorded', { verdict });
      }
      if (pair.status !== 'in_audit') unusual = true;
      if (terminal) intents.push({ kind: 'slot_changed' });
      applyVerdict(pair, verb, verdict, ctx.writer, intents);
      if (role === 'brain') resetCapFlagsOnBrainAction(pair);
      return done(isAppliedVerdict(verdict.judgement) ? 'verdict' : 'verdict_held', { verdict });
    }
    case 'DONE': {
      const force = role === 'brain' && isTrue(attrs.force);
      if (terminal) return recorded(existing, false);
      if (force) {
        if (pair.status !== 'passed' && hasAudit(pair)) addFlag(pair, 'unaudited');
        pair.status = 'done';
        intents.push({ kind: 'slot_changed' });
        return done('forced');
      }
      if (!hasAudit(pair) || pair.status === 'passed') {
        pair.status = 'done';
        intents.push({ kind: 'slot_changed' });
        return done('status');
      }
      if (pair.status === 'in_audit') {
        unusual = true;
        return done('recorded');
      }
      if (pair.status === 'queued') unusual = true;
      pair.status = 'awaiting_audit';
      if (pair.executor && spendCap(pair, 'done_reminder', intents)) {
        intents.push({ kind: 'done_reminder', to: pair.executor });
      }
      return done('status');
    }
    case 'BLOCKED':
    case 'NEEDS_INPUT': {
      if (terminal) return recorded(existing, false);
      const flag = verb === 'BLOCKED' ? 'blocked' : 'needs_input';
      addFlag(pair, flag);
      pair.flagSides[flag] = role;
      if (verb === 'BLOCKED' && role === 'executor' && isAboutAuditor(attrs) && hasAudit(pair)) {
        if (spendCap(pair, 'blocked_replacement', intents)) intents.push({ kind: 'replace_auditor', reason: 'executor_blocked' });
      }
      return done('flag');
    }
    case 'REASSIGN': {
      if (!roleAuthority || terminal) return recorded(existing);
      if (role === 'brain') resetCapFlagsOnBrainAction(pair);
      const auditorBefore = pair.auditor;
      setRolesFromAttrs(pair, attrs, intents);
      if (attrs.executor) removeFlag(pair, 'executor_silent');
      if (attrs.auditor === TASK_PAIR_NO_AUDITOR && pair.status === 'in_audit') pair.status = 'working';
      return done(auditorBefore !== pair.auditor ? 'reassigned_auditor' : 'reassigned');
    }
    case 'CANCEL': {
      if (terminal) return recorded(existing, false);
      pair.status = 'cancelled';
      intents.push({ kind: 'slot_changed' });
      return done('status');
    }
    default:
      return recorded(existing);
  }
}

function setRolesFromAttrsQueued(pair: TaskPairState, attrs: Record<string, string>): void {
  if (attrs.executor) pair.executor = attrs.executor;
  if (attrs.auditor) pair.auditor = attrs.auditor;
  if (attrs.title) pair.title = attrs.title;
  if (attrs.pool) pair.executorPool = attrs.pool;
  const blocking = parseBlockingAttr(attrs.blocking);
  if (blocking) pair.blocking = blocking;
}

function resetCapFlagsOnBrainAction(pair: TaskPairState): void {
  resetCaps(pair);
}

function applyVerdict(
  pair: TaskPairState,
  verb: 'PASS' | 'REWORK',
  verdict: TaskPairVerdictJudgementResult,
  writer: string,
  intents: TaskPairIntent[],
): void {
  pair.lastVerdict = { verb, counts: verdict.counts, judgement: verdict.judgement, round: pair.round };
  if (!isAppliedVerdict(verdict.judgement)) {
    if (spendCap(pair, 'verdict_correction', intents)) {
      intents.push({ kind: 'correction', to: writer, judgement: verdict.judgement });
    }
    return;
  }
  removeFlag(pair, 'verdict_inconsistent');
  if (verb === 'PASS') {
    pair.status = 'passed';
    pair.passRound = pair.round;
  } else {
    const wasRework = pair.status === 'rework';
    pair.status = 'rework';
    if (!wasRework && pair.executor) intents.push({ kind: 'rework_notice', to: pair.executor, counts: verdict.counts });
  }
}

function isTrue(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes';
}

function isAboutAuditor(attrs: Record<string, string>): boolean {
  return attrs.about === 'auditor' || /\bauditor\b/i.test(attrs.note ?? '');
}

/** The side whose turn it is, or undefined for statuses nobody is nudged in. */
export function taskPairSideToAct(pair: TaskPairState): 'executor' | 'auditor' | undefined {
  switch (pair.status) {
    case 'working':
    case 'rework':
    case 'awaiting_audit':
    case 'passed':
      return 'executor';
    case 'in_audit':
      return hasAudit(pair) ? 'auditor' : 'executor';
    default:
      return undefined;
  }
}

export function formatTaskPairSeverityCounts(counts: TaskPairSeverityCounts): string {
  return AUDIT_SEVERITY_LEVELS.map((level) => `${level.toLowerCase()}=${counts[level]}`).join(' ');
}

/** Closest legacy lifecycle per pair status, so the task console groups pair rows like legacy ones. */
export const TASK_PAIR_CONSOLE_LEGACY_STATUS = {
  queued: 'planned',
  working: 'implementing',
  in_audit: 'auditing',
  awaiting_audit: 'ready_for_audit',
  rework: 'rework',
  passed: 'passed',
  done: 'finalized',
  cancelled: 'cancelled',
} as const satisfies Record<TaskPairStatus, string>;

// ---------------------------------------------------------------------------
// Wire payloads
// ---------------------------------------------------------------------------

export interface TaskPairEventPayload {
  taskId: string;
  verb: string;
  writer: string;
  role: TaskPairRole;
  source: TaskPairEventSource;
  effect: string;
  fromStatus?: TaskPairStatus;
  toStatus?: TaskPairStatus;
  unusual: boolean;
  title?: string;
  executor?: string;
  auditor?: string;
  round?: number;
  flags?: TaskPairFlag[];
  blocking?: AuditSeverity[];
  severityCounts?: TaskPairSeverityCounts;
  verdictJudgement?: TaskPairVerdictJudgement;
  executorPool?: string;
  auditorPool?: string;
}

// ---------------------------------------------------------------------------
// Contract body (registered once per session; referenced by id afterwards)
// ---------------------------------------------------------------------------

export function buildTaskPairMarkerContract(): string {
  return [
    `[Contract: ${TASK_PAIR_CONTRACT_ID}]`,
    'Supervised tasks are executor+auditor pairs driven by one-line markers you write on their own line in your reply (never inside code fences):',
    `<!-- ${TASK_PAIR_MARKER_TAG} <VERB> <taskId> [key=value | key="quoted value"] -->`,
    'Verbs: DISPATCH, QUEUE, STARTED, WORKING, READY_FOR_AUDIT, PASS, REWORK, DONE, BLOCKED, NEEDS_INPUT, REASSIGN, CANCEL. taskId "-" means your single open task.',
    'Executor: write STARTED when you begin; send your materials to the auditor with send_message, then write READY_FOR_AUDIT; after PASS commit/push yourself and write DONE. DONE without a PASS is not complete. Write BLOCKED or NEEDS_INPUT with note="..." when stuck.',
    `Auditor: judge by ${AUDIT_CONVERGENCE_CONTRACT_ID}. Reply to the executor with every finding tagged [P0]..[P4], then write PASS or REWORK with the blocking set and a count per level, e.g. REWORK <taskId> blocking=P0 p0=1 p1=2. REWORK needs at least one finding at a blocking level; PASS has none. Re-audits check only the prior blocking classes plus regressions.`,
    `Brain: DISPATCH <taskId> executor=<session> auditor=<session>|none [blocking=P0,P1] [pool=primary|economy]; queue with QUEUE <taskId> title="..." then the full brief then <!-- ${TASK_PAIR_BRIEF_END_TAG} <taskId> -->; QUEUE - max=<n> sets your queue limit; REASSIGN <taskId> auditor=<session>; DONE <taskId> force=true completes without audit; CANCEL <taskId>.`,
  ].join('\n');
}
