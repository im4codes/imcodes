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
const HEADER_RE = /^\s*\[IM\.codes task\s+([A-Za-z0-9._:-]{1,96})(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(?:\r?\n|$)/u;
const STATUS_RE = /\bstatus\s+([a-z_]+)/iu;
const ROUND_RE = /\bround\s+(\d+)/iu;
const EXECUTOR_RE = /\bexecutor\s+([^,\s.]+)/iu;
const AUDITOR_RE = /\bauditor\s+([^,\s.]+)/iu;
const WHY_RE = /^Why:\s*(.+)$/imu;

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
  if (/\bPASSED?\b/iu.test(text)) return 'PASS';
  if (/\bREWORK\b/iu.test(text) || status === 'rework') return 'REWORK';
  if (/\b(?:queued|queue)\b/iu.test(text) || status === 'queued') return 'QUEUE';
  if (/\b(?:needs your decision|needs input|awaiting)\b/iu.test(text)) return 'NEEDS_INPUT';
  if (/\b(?:cancelled|canceled)\b/iu.test(text) || status === 'cancelled') return 'CANCEL';
  if (/\bDONE\b/iu.test(text) || status === 'done') return 'DONE';
  return 'DISPATCH';
}

function inferStatus(verb: TaskPairVerb, status: TaskPairStatus | undefined): TaskPairStatus | undefined {
  if (status) return status;
  switch (verb) {
    case 'PASS': return 'passed';
    case 'REWORK': return 'rework';
    case 'QUEUE': return 'queued';
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

/** Parse one daemon-authored task notice into the payload consumed by the card. */
export function parseTaskPairNotification(text: unknown): ParsedTaskPairNotification | undefined {
  if (typeof text !== 'string') return undefined;
  // Fenced examples and inline mentions are intentionally rejected.  The
  // header must occupy the first non-empty line and the body must be non-empty.
  const match = text.match(HEADER_RE);
  const markerScan = match ? undefined : scanTaskPairMarkers(text);
  const marker = markerScan?.markers.find((candidate) => candidate.knownVerb === 'DISPATCH'
    || candidate.knownVerb === 'QUEUE'
    || candidate.knownVerb === 'PASS'
    || candidate.knownVerb === 'REWORK'
    || candidate.knownVerb === 'NEEDS_INPUT'
    || candidate.knownVerb === 'DONE'
    || candidate.knownVerb === 'CANCEL');
  if (!match && !marker) return undefined;
  const body = match
    ? text.slice(match[0].length).trim()
    : text.trim();
  if (!body || body.startsWith('```')) return undefined;
  if (!marker && !/(?:\bstatus\b|\b(?:executor|auditor)\b|\bround\b|\b(?:PASS|PASSED|REWORK|QUEUED|QUEUE|NEEDS_INPUT|NEEDS YOUR DECISION|CANCEL(?:LED|ED)?|DONE)\b|^Why:)/imu.test(body)) {
    return undefined;
  }
  const taskId = match?.[1] ?? marker!.taskId;
  const title = unescapeQuotedTitle(match?.[2])
    ?? unescapeQuotedTitle(marker?.attrs.title)
    ?? deriveSupervisionTaskTitleFromBrief(marker?.brief);
  const status = knownStatus(body.match(STATUS_RE)?.[1])
    ?? knownStatus(marker?.attrs.status);
  const verb = marker?.knownVerb ?? inferVerb(body, status);
  const effectiveStatus = inferStatus(verb, status);
  const payload: Record<string, unknown> = {
    taskId,
    ...(title ? { title } : {}),
    writer: 'daemon',
    role: 'daemon',
    source: 'daemon',
    effect: 'recorded',
    verb,
    ...(effectiveStatus ? { toStatus: effectiveStatus } : {}),
    ...(body.match(ROUND_RE)?.[1] ? { round: Number(body.match(ROUND_RE)![1]) } : {}),
    ...(body.match(EXECUTOR_RE)?.[1] && body.match(EXECUTOR_RE)![1] !== '-' ? { executor: body.match(EXECUTOR_RE)![1] } : {}),
    ...(body.match(AUDITOR_RE)?.[1] && body.match(AUDITOR_RE)![1] !== '-' ? { auditor: body.match(AUDITOR_RE)![1] } : {}),
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
