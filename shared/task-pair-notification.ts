import {
  deriveSupervisionTaskTitleFromBrief,
} from './supervision-task-identity.js';
import {
  scanTaskPairMarkers,
  TASK_PAIR_NOTICE_VERB,
  TASK_PAIR_STATUSES,
  TASK_PAIR_VERBS,
  type TaskPairStatus,
  type TaskPairVerb,
  type TaskPairAuditDetails,
  type TaskPairAuditFinding,
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
const EXECUTOR_MODEL_RE = /\b(?:executor(?:model|_model)|executor\s+model)\s*(?::|=)?\s*([^,\s.]+)/iu;
const AUDITOR_MODEL_RE = /\b(?:auditor(?:model|_model)|auditor\s+model)\s*(?::|=)?\s*([^,\s.]+)/iu;
const EXECUTOR_THINKING_RE = /\b(?:executor(?:thinking|_thinking|effort)|executor\s+(?:thinking|effort))\s*(?::|=)?\s*([A-Za-z0-9_-]{1,40})/iu;
const AUDITOR_THINKING_RE = /\b(?:auditor(?:thinking|_thinking|effort)|auditor\s+(?:thinking|effort))\s*(?::|=)?\s*([A-Za-z0-9_-]{1,40})/iu;
const WHY_RE = /^Why:\s*(.+)$/imu;
const CANCEL_REASON_RE = /\b(?:reason|cause|note)\s*(?::|=)\s*(?:"([^"]*)"|'([^']*)'|(.+?))(?=\s+\b(?:executor|auditor|status|round)\b|$)/imu;
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

/**
 * A bare lifecycle word that opens the notice body and is followed by nothing,
 * a `status` field or a `key=value` attribute (`DISPATCH executor=x`,
 * `QUEUE status queued`). Prose that merely starts with such a word
 * (`DONE without a PASS is not complete`) is not a lifecycle statement.
 */
const LEADING_VERB_RE = /^\s*(?:[-*]\s*)?(PASS(?:ED)?|REWORK|QUEUED?|READY(?:_FOR_AUDIT)?|STARTED|WORKING|BLOCKED|NEEDS_INPUT|CANCEL(?:LED|ED)?|DONE|DISPATCH)\b(?=\s*(?:$|status\b|[A-Za-z_]+=))/imu;

const LEADING_VERBS: Record<string, TaskPairVerb> = {
  PASS: 'PASS', PASSED: 'PASS', REWORK: 'REWORK', QUEUE: 'QUEUE', QUEUED: 'QUEUE',
  READY: 'READY_FOR_AUDIT', READY_FOR_AUDIT: 'READY_FOR_AUDIT', STARTED: 'STARTED', WORKING: 'WORKING',
  BLOCKED: 'BLOCKED', NEEDS_INPUT: 'NEEDS_INPUT', CANCEL: 'CANCEL', CANCELLED: 'CANCEL', CANCELED: 'CANCEL',
  DONE: 'DONE', DISPATCH: 'DISPATCH',
};

/**
 * The lifecycle verb a text notice states, or undefined. Only explicit
 * statements count: the daemon's `Audited pair <verb>` summary, a structured
 * `status` field, the queue-dispatch phrase, or a leading bare verb. Words
 * elsewhere in the body never count: the dispatched brief and every reminder
 * quote the whole PASS/REWORK/DONE contract, and guessing from that showed an
 * unaudited, still-running pair as "passed".
 */
function inferVerb(text: string, status: TaskPairStatus | undefined): TaskPairVerb | undefined {
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

  // A structured status is stronger than incidental words in the body.
  if (status === 'done') return 'DONE';
  if (status === 'passed') return 'PASS';
  if (status === 'rework') return 'REWORK';
  if (status === 'in_audit') return 'READY_FOR_AUDIT';
  if (status === 'cancelled') return 'CANCEL';
  if (status === 'queued') return 'QUEUE';
  if (status === 'awaiting_brain_decision') return 'NEEDS_INPUT';

  if (QUEUE_DISPATCH_RE.test(text)) return 'DISPATCH';
  if (status === 'working') return 'WORKING';
  const leading = text.match(LEADING_VERB_RE)?.[1]?.toUpperCase();
  return leading ? LEADING_VERBS[leading] : undefined;
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

const DETAIL_FIELD_RE = /^\s*(?:[-*]\s*)?(?:\*\*|__)?(?<label>invariant|violat(?:es|ed|ion)|violation\s+of\s+invariant|invariant\s+violated|违反不变量|不变量|location|位置|file(?:\s*\/\s*function)?|function|evidence(?:\s*\/\s*repro(?:duction)?)?|证据|repro(?:duction)?|复现|proposal|recommendation|auditor\s+proposal|suggest(?:ed)? solution|suggested fix|fix|建议(?:方案)?|trade[- ]?offs?|权衡|validation(?:\s+summary)?|验证(?:摘要)?|tests?|suite|next step|next steps|下一步|reason|why|原因)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?(?<value>.*)$/iu;
const FINDING_RE = /^\s*(?:[-*]\s*)?(?:finding\s*)?\[\s*(P[0-4])\s*\]\s*(.*)$/iu;
const FINDING_WORD_RE = /^\s*(?:[-*]\s*)?(?:finding|发现)\s*[:：]?\s*(.*)$/iu;
const SUMMARY_RE = /^\s*(?:summary|audit summary|摘要|审计摘要)\s*[:：]\s*(.*)$/iu;

function cleanDetailText(value: unknown, max = 2000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/gu, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

function setFindingField(finding: TaskPairAuditFinding, label: string, value: string): void {
  const key = label.toLowerCase().replace(/[：:]/gu, '').trim();
  const field = key.includes('invariant') || key.includes('violat') || key.includes('不变量') ? 'invariant'
    : key.includes('location') || key === 'file' || key === 'function' || key.includes('位置') ? 'location'
      : key.includes('evidence') || key.includes('repro') || key.includes('证据') || key.includes('复现') ? 'evidence'
          : key.includes('proposal') || key.includes('recommend') || key.includes('solution') || key === 'fix' || key.includes('建议') ? 'proposal'
          : key.includes('trade') || key.includes('权衡') ? 'tradeoffs' : undefined;
  if (!field) return;
  const normalized = cleanDetailText(value);
  if (!normalized) return;
  finding[field] = finding[field] ? `${finding[field]} ${normalized}`.slice(0, 2000) : normalized;
}

/** Parse the explicitly labelled portions of an auditor notice. Unlabelled
 * prose is retained as noticeText but is never guessed to be a finding. */
export function parseTaskPairAuditDetails(text: unknown): TaskPairAuditDetails | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const findings: TaskPairAuditFinding[] = [];
  let current: TaskPairAuditFinding | undefined;
  let currentField: keyof TaskPairAuditFinding | undefined;
  let summary: string | undefined;
  const validation: string[] = [];
  const nextSteps: string[] = [];
  const reasons: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const findingMatch = line.match(FINDING_RE);
    const findingWord = line.match(FINDING_WORD_RE);
    if (findingMatch || findingWord) {
      current = { ...(findingMatch?.[1] ? { severity: findingMatch[1].toUpperCase() } : {}) };
      const initial = cleanDetailText(findingMatch?.[2] ?? findingWord?.[1]);
      if (initial) current.summary = initial;
      findings.push(current);
      currentField = 'summary';
      continue;
    }
    const summaryMatch = line.match(SUMMARY_RE);
    if (summaryMatch) {
      summary = cleanDetailText(summaryMatch[1]);
      currentField = undefined;
      continue;
    }
    const labelled = line.match(DETAIL_FIELD_RE);
    if (labelled) {
      const label = labelled.groups?.label ?? '';
      const value = labelled.groups?.value ?? '';
      if (current && /invariant|violat|不变量/iu.test(label)) { setFindingField(current, 'invariant', value); currentField = 'invariant'; continue; }
      if (current && /location|位置|file|function/iu.test(label)) { setFindingField(current, 'location', value); currentField = 'location'; continue; }
      if (current && /evidence|repro|证据|复现/iu.test(label)) { setFindingField(current, 'evidence', value); currentField = 'evidence'; continue; }
      if (current && /proposal|solution|建议/iu.test(label)) { setFindingField(current, 'proposal', value); currentField = 'proposal'; continue; }
      if (current && /trade|权衡/iu.test(label)) { setFindingField(current, 'tradeoffs', value); currentField = 'tradeoffs'; continue; }
      if (/validation|验证|tests?|suite/iu.test(label)) validation.push(value);
      else if (/next step|下一步/iu.test(label)) nextSteps.push(value);
      else if (/reason|why|原因/iu.test(label)) reasons.push(value);
      continue;
    }
    if (current && currentField && currentField !== 'severity') {
      const continuation = cleanDetailText(line);
      if (continuation && currentField !== 'summary') current[currentField] = `${current[currentField] ?? ''} ${continuation}`.trim().slice(0, 2000);
    }
  }
  const result: TaskPairAuditDetails = {
    ...(findings.length ? { findings: findings.slice(0, 20) } : {}),
    ...(summary ? { summary } : {}),
    ...(validation.length ? { validation: cleanDetailText(validation.join(' '), 3000) } : {}),
    ...(reasons.length ? { reason: cleanDetailText(reasons.join(' '), 2000) } : {}),
    ...(nextSteps.length ? { nextStep: cleanDetailText(nextSteps.join(' '), 2000) } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

/** Accept structured fields from newer projections and legacy aliases. */
export function normalizeTaskPairAuditDetails(input: unknown): TaskPairAuditDetails | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const source = record.auditDetails && typeof record.auditDetails === 'object'
    ? record.auditDetails as Record<string, unknown> : record;
  const rawFindings = source.findings ?? source.auditFindings;
  const findings = Array.isArray(rawFindings) ? rawFindings.slice(0, 20).flatMap((item): TaskPairAuditFinding[] => {
    if (typeof item === 'string') return [{ summary: cleanDetailText(item) }];
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const finding: TaskPairAuditFinding = {};
    for (const field of ['severity', 'summary', 'invariant', 'location', 'evidence', 'proposal', 'tradeoffs'] as const) {
      const text = cleanDetailText(value[field]);
      if (text) finding[field] = text;
    }
    return Object.keys(finding).length ? [finding] : [];
  }) : [];
  const details: TaskPairAuditDetails = {
    ...(findings.length ? { findings } : {}),
    ...(['summary', 'validation', 'reason', 'nextStep'].reduce((out, field) => {
      const value = cleanDetailText(
        source[field]
          ?? source[`${field}Summary`]
          ?? record[`${field}Summary`]
          ?? (field === 'reason' ? record.blockedNote ?? record.noticeReason : undefined),
      );
      if (value) (out as Record<string, string>)[field] = value;
      return out;
    }, {} as Partial<TaskPairAuditDetails>)),
  };
  return Object.keys(details).length ? details : undefined;
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
  // A neutral notice states no lifecycle, so it is never merged with (or
  // hidden behind) a lifecycle event of the same task.
  if (rawVerb === TASK_PAIR_NOTICE_VERB && !rawStatus) return undefined;
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
  const stated = marker?.knownVerb ?? inferVerb(body, status);
  // No explicit lifecycle statement: a neutral notice that carries no status
  // (an explicit `status` field, e.g. awaiting_audit, is still shown).
  const verb: TaskPairVerb | typeof TASK_PAIR_NOTICE_VERB = stated ?? TASK_PAIR_NOTICE_VERB;
  const effectiveStatus = stated
    ? inferStatus(stated, status ?? (QUEUE_DISPATCH_RE.test(body) ? 'working' : undefined))
    : status;
  const cancellationReason = effectiveStatus === 'cancelled'
    ? (body.match(WHY_RE)?.[1]?.trim() ?? (() => {
      const match = body.match(CANCEL_REASON_RE);
      return match?.[1]?.trim() ?? match?.[2]?.trim() ?? match?.[3]?.trim();
    })())
    : undefined;
  const auditDetails = parseTaskPairAuditDetails(body);
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
    ...((body.match(EXECUTOR_MODEL_RE)?.[1] ?? marker?.attrs.executormodel) ? { executorModel: body.match(EXECUTOR_MODEL_RE)?.[1] ?? marker?.attrs.executormodel } : {}),
    ...((body.match(AUDITOR_MODEL_RE)?.[1] ?? marker?.attrs.auditormodel) ? { auditorModel: body.match(AUDITOR_MODEL_RE)?.[1] ?? marker?.attrs.auditormodel } : {}),
    ...((body.match(EXECUTOR_THINKING_RE)?.[1] ?? marker?.attrs.executorthinking) ? { executorThinking: body.match(EXECUTOR_THINKING_RE)?.[1] ?? marker?.attrs.executorthinking } : {}),
    ...((body.match(AUDITOR_THINKING_RE)?.[1] ?? marker?.attrs.auditorthinking) ? { auditorThinking: body.match(AUDITOR_THINKING_RE)?.[1] ?? marker?.attrs.auditorthinking } : {}),
    ...(body.match(WHY_RE)?.[1] ? { noticeReason: body.match(WHY_RE)![1].trim() } : {}),
    ...(auditDetails ? { auditDetails } : {}),
    ...(effectiveStatus === 'cancelled' ? {
      cancelActor: 'daemon', cancelSource: 'daemon',
      ...(cancellationReason ? { cancelReason: cancellationReason.slice(0, 500) } : {}),
    } : {}),
    noticeText: body,
    rawText: text,
    unusual: false,
  };
  // Keep unknown statuses as an ordinary notice with a safe card fallback;
  // known verbs are still constrained to the shared protocol vocabulary.
  if (verb !== TASK_PAIR_NOTICE_VERB && !TASK_PAIR_VERBS.includes(verb)) return undefined;
  return { taskId, ...(title ? { title } : {}), payload, rawText: text };
}
