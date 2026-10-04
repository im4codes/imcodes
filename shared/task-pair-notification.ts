import {
  deriveSupervisionTaskTitleFromBrief,
} from './supervision-task-identity.js';
import {
  scanTaskPairMarkers,
  TASK_PAIR_STATUSES,
  TASK_PAIR_VERBS,
  type TaskPairStatus,
  type TaskPairVerb,
} from './task-pair.js';

/**
 * The daemon sends a few task-pair lifecycle notices as ordinary assistant
 * text (for example `[IM.codes task tsk_demo "Readable title"]`).  Keep the
 * grammar deliberately strict: the header must be the first non-empty line,
 * so prose and fenced examples never become task cards.
 */
const HEADER_RE = /^\s*\[IM\.codes task\s+([A-Za-z0-9._:-]{1,96})(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*/u;
const STATUS_RE = /\bstatus\s*(?::|=)\s*([a-z_]+)|\bstatus\s+([a-z_]+)/iu;
const ROUND_RE = /\bround\s*(?::|=)\s*(\d+)|\bround\s+(\d+)/iu;
const EXECUTOR_RE = /\bexecutor\s*(?::|=)\s*([^,\s.]+)|\bexecutor\s+([^,\s.]+)/iu;
const AUDITOR_RE = /\bauditor\s*(?::|=)\s*([^,\s.]+)|\bauditor\s+([^,\s.]+)/iu;
const WHY_RE = /^Why:\s*(.+)$/imu;
const QUEUE_DISPATCH_RE = /\bdispatched\s+from\s+the\s+queue\b/iu;
const AUDIT_VERB_RE = /^\s*Audited\s+pair\s+(done|passed|pass|rework|ready(?:_for_audit)?|blocked|needs(?:_input|\s+your\s+decision)|cancel(?:led|ed)?)/iu;
const AUDIT_SUMMARY_RE = /^\s*Audited\s+pair\b/iu;
const AUDIT_LIFECYCLE_RE = /\b(?:done|pass(?:ed)?|rework|ready(?:_for_audit)?|blocked|needs(?:_input|\s+your\s+decision)|cancel(?:led|ed)?)\b/iu;
const AUDIT_FIELD_RE = /\b(?:executor|auditor|verdict|status|worktree|p[0-4]\s*=)\b/iu;
const TASK_ID_RE = /\b(tsk_[A-Za-z0-9._:-]{1,96})\b/iu;
const QUOTED_TITLE_RE = /\btsk_[A-Za-z0-9._:-]{1,96}\s+"((?:[^"\\]|\\.)*)"/iu;

function unescapeQuotedTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const title = value.replace(/\\([\\"])/gu, '$1').trim();
  return title || undefined;
}

function knownStatus(value: string | undefined): TaskPairStatus | undefined {
  const normalized = value?.toLowerCase();
  return normalized && (TASK_PAIR_STATUSES as readonly string[]).includes(normalized)
    ? normalized as TaskPairStatus
    : undefined;
}

function inferVerb(text: string, status: TaskPairStatus | undefined): TaskPairVerb {
  // A daemon PASS notice for a completed pair contains both lifecycle words
  // ("Audited pair done") and the auditor's verdict ("PASS"). The lifecycle
  // stage is authoritative; otherwise DONE would be downgraded to PASS.
  const auditVerb = text.match(AUDIT_VERB_RE)?.[1]?.toLowerCase();
  if (auditVerb === 'done') return 'DONE';
  if (auditVerb === 'passed' || auditVerb === 'pass') return 'PASS';
  if (auditVerb === 'rework') return 'REWORK';
  if (auditVerb?.startsWith('ready')) return 'READY_FOR_AUDIT';
  if (auditVerb === 'blocked' || auditVerb?.startsWith('needs')) return 'NEEDS_INPUT';
  if (auditVerb?.startsWith('cancel')) return 'CANCEL';

  // A structured status is also stronger than incidental words in the
  // explanatory body (for example `DONE status done ... verdict PASS`).
  if (status === 'done') return 'DONE';
  if (status === 'passed') return 'PASS';
  if (status === 'rework') return 'REWORK';
  if (status === 'in_audit') return 'READY_FOR_AUDIT';
  if (status === 'cancelled') return 'CANCEL';
  if (status === 'queued') return 'QUEUE';

  if (QUEUE_DISPATCH_RE.test(text)) return 'DISPATCH';
  if (/\bPASS(?:ED)?\b/iu.test(text)) return 'PASS';
  if (/\bREWORK\b/iu.test(text)) return 'REWORK';
  if (/\b(?:queued|queue)\b/iu.test(text)) return 'QUEUE';
  if (/\bREADY(?:_FOR_AUDIT)?\b/iu.test(text)) return 'READY_FOR_AUDIT';
  if (/\b(?:STARTED|WORKING)\b/iu.test(text)) return 'WORKING';
  if (/\b(?:BLOCKED|NEEDS_INPUT|NEEDS YOUR DECISION|AWAITING)\b/iu.test(text)) return 'NEEDS_INPUT';
  if (/\b(?:needs your decision|needs input|awaiting)\b/iu.test(text)) return 'NEEDS_INPUT';
  if (/\b(?:cancelled|canceled)\b/iu.test(text)) return 'CANCEL';
  if (/\bDONE\b/iu.test(text)) return 'DONE';
  return 'DISPATCH';
}

function inferStatus(verb: TaskPairVerb, status: TaskPairStatus | undefined): TaskPairStatus | undefined {
  if (status) return status;
  switch (verb) {
    case 'DISPATCH': return 'working';
    case 'PASS': return 'passed';
    case 'REWORK': return 'rework';
    case 'QUEUE': return 'queued';
    case 'READY_FOR_AUDIT': return 'in_audit';
    case 'STARTED':
    case 'WORKING': return 'working';
    case 'BLOCKED':
    case 'NEEDS_INPUT': return 'awaiting_brain_decision';
    case 'DONE': return 'done';
    case 'CANCEL': return 'cancelled';
    default: return undefined;
  }
}

export interface ParsedTaskPairNotification {
  taskId: string;
  title?: string;
  payload: Record<string, unknown>;
  rawText: string;
}

/**
 * Stable UI correlation key for one task lifecycle.  Event ids differ between
 * structured timeline delivery, assistant text, and replay; task id plus the
 * resulting lifecycle status is the shared identity across those sources.
 * Missing ids deliberately return undefined so unrelated notices are never
 * merged merely because their titles happen to match.
 */
export function taskPairNotificationKey(payload: Record<string, unknown>): string | undefined {
  const taskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
  if (!taskId) return undefined;
  const rawStatus = typeof payload.toStatus === 'string' ? payload.toStatus.trim().toLowerCase() : '';
  const rawVerb = typeof payload.verb === 'string' ? payload.verb.trim().toUpperCase() : '';
  // Structured events normally carry toStatus while assistant notices often
  // only carry a verb. Normalize both forms to the same lifecycle identity so
  // cross-source delivery (for example DISPATCH + working) collapses safely.
  const statusByVerb: Record<string, string> = {
    DISPATCH: 'working',
    QUEUE: 'queued',
    STARTED: 'working',
    WORKING: 'working',
    READY_FOR_AUDIT: 'in_audit',
    PASS: 'passed',
    REWORK: 'rework',
    DONE: 'done',
    BLOCKED: 'awaiting_brain_decision',
    NEEDS_INPUT: 'awaiting_brain_decision',
    CANCEL: 'cancelled',
  };
  const statusAliases: Record<string, string> = {
    started: 'working',
    working: 'working',
    queued: 'queued',
    in_audit: 'in_audit',
    awaiting_audit: 'awaiting_audit',
    awaiting_brain_decision: 'awaiting_brain_decision',
    passed: 'passed',
    pass: 'passed',
    rework: 'rework',
    done: 'done',
    cancelled: 'cancelled',
    canceled: 'cancelled',
  };
  const lifecycle = statusAliases[rawStatus]
    ?? statusByVerb[rawVerb]
    ?? (rawStatus || rawVerb.toLowerCase() || 'unknown');
  return `${taskId}\u0000${lifecycle}`;
}

/** Parse one daemon-authored task notice into the payload consumed by the card. */
export function parseTaskPairNotification(text: unknown): ParsedTaskPairNotification | undefined {
  if (typeof text !== 'string') return undefined;
  // Fenced examples and inline mentions are intentionally rejected.  The
  // header must occupy the first non-empty line and the body must be non-empty.
  const match = text.match(HEADER_RE);
  const auditSummary = !match
    && AUDIT_SUMMARY_RE.test(text)
    && TASK_ID_RE.test(text)
    && AUDIT_LIFECYCLE_RE.test(text)
    && AUDIT_FIELD_RE.test(text);
  const markerScan = match || auditSummary ? undefined : scanTaskPairMarkers(text);
  const marker = markerScan?.markers.find((candidate) => candidate.knownVerb === 'DISPATCH'
    || candidate.knownVerb === 'QUEUE'
    || candidate.knownVerb === 'PASS'
    || candidate.knownVerb === 'REWORK'
    || candidate.knownVerb === 'READY_FOR_AUDIT'
    || candidate.knownVerb === 'STARTED'
    || candidate.knownVerb === 'WORKING'
    || candidate.knownVerb === 'BLOCKED'
    || candidate.knownVerb === 'NEEDS_INPUT'
    || candidate.knownVerb === 'DONE'
    || candidate.knownVerb === 'CANCEL');
  if (!match && !auditSummary && !marker) return undefined;
  const body = match
    ? text.slice(match[0].length).trim()
    : text.trim();
  if (!body || body.startsWith('```')) return undefined;
  if (!marker && !/(?:\bstatus\b|\b(?:executor|auditor)\b|\bround\b|\b(?:Audited\s+pair|PASS(?:ED)?|REWORK|QUEUED|QUEUE|READY(?:_FOR_AUDIT)?|STARTED|WORKING|BLOCKED|NEEDS_INPUT|NEEDS YOUR DECISION|CANCEL(?:LED|ED)?|DONE)\b|^Why:)/imu.test(body)) {
    return undefined;
  }
  const bareTaskId = auditSummary ? body.match(TASK_ID_RE)?.[1] : undefined;
  const taskId = match?.[1] ?? marker?.taskId ?? bareTaskId;
  if (!taskId) return undefined;
  const summaryTitle = auditSummary ? body.match(QUOTED_TITLE_RE)?.[1] : undefined;
  const title = unescapeQuotedTitle(match?.[2])
    ?? unescapeQuotedTitle(summaryTitle)
    ?? unescapeQuotedTitle(marker?.attrs.title)
    ?? deriveSupervisionTaskTitleFromBrief(marker?.brief);
  const status = knownStatus(body.match(STATUS_RE)?.[1] ?? body.match(STATUS_RE)?.[2])
    ?? knownStatus(marker?.attrs.status);
  const verb = marker?.knownVerb ?? inferVerb(body, status);
  const effectiveStatus = inferStatus(verb, status ?? (QUEUE_DISPATCH_RE.test(body) ? 'working' : undefined));
  const payload: Record<string, unknown> = {
    taskId,
    ...(title ? { title } : {}),
    writer: 'daemon',
    role: 'daemon',
    source: 'daemon',
    effect: 'recorded',
    verb,
    ...(effectiveStatus ? { toStatus: effectiveStatus } : {}),
    ...((body.match(ROUND_RE)?.[1] ?? body.match(ROUND_RE)?.[2]) ? { round: Number(body.match(ROUND_RE)![1] ?? body.match(ROUND_RE)![2]) } : {}),
    ...((body.match(EXECUTOR_RE)?.[1] ?? body.match(EXECUTOR_RE)?.[2]) && (body.match(EXECUTOR_RE)![1] ?? body.match(EXECUTOR_RE)![2]) !== '-' ? { executor: body.match(EXECUTOR_RE)![1] ?? body.match(EXECUTOR_RE)![2] } : {}),
    ...((body.match(AUDITOR_RE)?.[1] ?? body.match(AUDITOR_RE)?.[2]) && (body.match(AUDITOR_RE)![1] ?? body.match(AUDITOR_RE)![2]) !== '-' ? { auditor: body.match(AUDITOR_RE)![1] ?? body.match(AUDITOR_RE)![2] } : {}),
    ...(body.match(WHY_RE)?.[1] ? { noticeReason: body.match(WHY_RE)![1].trim() } : {}),
    noticeText: body,
    rawText: text,
    unusual: false,
  };
  // Keep unknown statuses as an ordinary notice with a safe card fallback;
  // known verbs are still constrained to the shared protocol vocabulary.
  if (!TASK_PAIR_VERBS.includes(verb)) return undefined;
  return { taskId, ...(title ? { title } : {}), payload, rawText: text };
}
