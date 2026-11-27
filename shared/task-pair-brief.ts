import { MACHINE_CONFIG_REQUEST_ERROR } from './machine-config-request.js';
import { AUDIT_SEVERITY_LEVELS, normalizeAuditBlockingSeverities } from './audit-convergence.js';
import {
  GLOBAL_TASK_AUDIT_SUMMARY_MAX_CHARS,
  truncateGlobalBrainText,
  type GlobalTaskAuditCounts,
  type GlobalTaskAuditSummary,
} from './global-task-mode.js';
import type { TaskPairAuditFinding, TaskPairLastVerdict } from './task-pair.js';

export const TASK_PAIR_BRIEF_MSG = {
  REQUEST: 'task_pair.brief_request',
  RESPONSE: 'task_pair.brief_response',
} as const;

export const TASK_PAIR_BRIEF_TIMEOUT_MS = 10_000 as const;

export const TASK_PAIR_BRIEF_ERROR = {
  INVALID_REQUEST: 'invalid_request',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  REQUEST_FAILED: 'request_failed',
  DAEMON_OFFLINE: MACHINE_CONFIG_REQUEST_ERROR.DAEMON_OFFLINE,
  TIMEOUT: MACHINE_CONFIG_REQUEST_ERROR.TIMEOUT,
} as const;
export type TaskPairBriefError = (typeof TASK_PAIR_BRIEF_ERROR)[keyof typeof TASK_PAIR_BRIEF_ERROR];

export interface TaskPairBriefChecklistSummary {
  total: number;
  implemented: number;
  audited: number;
}

export interface GlobalTaskAuditFindingItem {
  index: number;
  severity?: string;
  blocking: boolean;
  summary: string;
  location?: string;
  evidence?: string;
  proposal?: string;
  invariant?: string;
  tradeoffs?: string;
}

export interface GlobalTaskAuditDetail {
  verb: 'PASS' | 'REWORK';
  round: number;
  counts: GlobalTaskAuditCounts;
  blocking: string[];
  blockingCount: number;
  findingsCount: number;
  summary?: string;
  reason?: string;
  nextStep?: string;
  noticeText?: string;
  findings: GlobalTaskAuditFindingItem[];
}

export interface TaskPairBriefResponse {
  ok: boolean;
  taskId?: string;
  brief?: string;
  briefRevision?: string;
  checklist?: TaskPairBriefChecklistSummary;
  lastAudit?: GlobalTaskAuditDetail;
  updatedAt?: number;
  error?: TaskPairBriefError | string;
}

const AUDIT_TAGGED_FINDING_RE = /^\s*(?:(?:\d+[.)、]\s*)|(?:[-*•]\s*)|(?:#{1,6}\s*)|(?:第[0-9一二三四五六七八九十]+[条项个]?\s*))*(?:\*\*|__)?(?:(?:REWORK|PASS|finding|发现|问题|audit|审计)\s*[:：]\s*)?(?:finding\s*)?\[\s*(P[0-4])\s*\](?:\*\*|__)?\s*[:：\-—]?\s*(.*)$/iu;
const AUDIT_BARE_FINDING_RE = /^\s*(?:(?:\d+[.)、]\s*)|(?:[-*•]\s*)|(?:#{1,6}\s*))?(?:\*\*|__)?\b(P[0-4])\b(?:\*\*|__)?\s*[:：\-—]\s*(.*)$/iu;
const AUDIT_NUMBERED_ITEM_RE = /^\s*(?:\*\*|__)?(\d{1,3})[.)、](?:\*\*|__)?\s+(.+)$/u;
const AUDIT_BULLET_ITEM_RE = /^\s*[-*•]\s+(.+)$/u;
const AUDIT_SUMMARY_LINE_RE = /^\s*(?:[-*•]\s*)?(?:\*\*|__)?(?:summary|audit summary|摘要|审计摘要|总体评价|评估|结论)(?:\*\*|__)?\s*[:：]\s*(.*)$/iu;
const AUDIT_FIELD_RE = /^\s*(?:[-*•]\s*)?(?:\*\*|__)?(?<label>invariant|violat(?:es|ed|ion)|violation\s+of\s+invariant|invariant\s+violated|违反不变量|不变量|location|位置|file(?:\s*\/\s*function)?|文件(?:路径|位置)?|function|evidence(?:\s*\/\s*repro(?:duction)?)?|证据|repro(?:duction)?|复现|proposal|recommendation|auditor\s+proposal|suggest(?:ed)?\s+(?:solution|fix)|solution|fix|建议(?:方案)?|修复(?:建议|方案)|建议|trade[- ]?offs?|权衡|validation(?:\s+summary)?|验证(?:摘要)?|tests?|suite|next step|next steps|下一步|reason|why|原因|返工原因|未通过原因|主要问题|审计意见|返工意见|审查意见)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?(?<value>.*)$/iu;
const AUDIT_METADATA_LINE_RE = /^\s*(?:\[IM\.codes task\b|<!--|Audited\s+pair\b|(?:status|round|executor|auditor|verdict|blocking)\s*[:=])/iu;
const AUDIT_INLINE_SEVERITY_RE = /(?:\[(P[0-4])\]|\((P[0-4])\)|\b(P[0-4])\b)/iu;

function cleanUntruncatedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\*\*/gu, '').replace(/__/gu, '').replace(/[ \t]+/gu, ' ').trim();
  return cleaned || undefined;
}

function appendDetailText(existing: string | undefined, next: string | undefined): string | undefined {
  if (!next) return existing;
  if (!existing) return next;
  return `${existing}\n${next}`;
}

function isBlockingSeverity(severity: string | undefined, blockingSet: ReadonlySet<string>): boolean {
  if (!severity) return false;
  return blockingSet.has(severity.trim().toUpperCase());
}

function assignFieldFromLabel(
  finding: Omit<GlobalTaskAuditFindingItem, 'index' | 'blocking'>,
  label: string,
  value: string,
): keyof Omit<GlobalTaskAuditFindingItem, 'index' | 'blocking' | 'severity'> | undefined {
  const key = label.toLowerCase().replace(/[：:]/gu, '').trim();
  const normalized = cleanUntruncatedText(value);
  let field: keyof Omit<GlobalTaskAuditFindingItem, 'index' | 'blocking' | 'severity'> | undefined;
  if (key.includes('invariant') || key.includes('violat') || key.includes('不变量')) field = 'invariant';
  else if (key.includes('location') || key === 'file' || key === 'function' || key.includes('位置') || key.includes('文件')) field = 'location';
  else if (key.includes('evidence') || key.includes('repro') || key.includes('证据') || key.includes('复现')) field = 'evidence';
  else if (key.includes('proposal') || key.includes('recommend') || key.includes('solution') || key === 'fix' || key.includes('建议') || key.includes('修复')) field = 'proposal';
  else if (key.includes('trade') || key.includes('权衡')) field = 'tradeoffs';
  if (field && normalized) {
    finding[field] = appendDetailText(finding[field], normalized) ?? normalized;
  }
  return field;
}

function parseUntruncatedTextAudit(rawText: string): {
  findings: Array<Omit<GlobalTaskAuditFindingItem, 'index' | 'blocking'>>;
  summary?: string;
  reason?: string;
  nextStep?: string;
} {
  const lines = rawText.replace(/\r\n?/gu, '\n').split('\n');
  const taggedFindings: Array<Omit<GlobalTaskAuditFindingItem, 'index' | 'blocking'>> = [];
  let current: Omit<GlobalTaskAuditFindingItem, 'index' | 'blocking'> | undefined;
  let currentField: keyof Omit<GlobalTaskAuditFindingItem, 'index' | 'blocking' | 'severity'> | undefined;
  let summary: string | undefined;
  const reasons: string[] = [];
  const nextSteps: string[] = [];
  const proseLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      currentField = undefined;
      continue;
    }
    const taggedMatch = line.match(AUDIT_TAGGED_FINDING_RE) || line.match(AUDIT_BARE_FINDING_RE);
    if (taggedMatch) {
      const severity = taggedMatch[1]?.toUpperCase();
      const body = cleanUntruncatedText(taggedMatch[2]) ?? '';
      current = { severity, summary: body };
      taggedFindings.push(current);
      currentField = 'summary';
      continue;
    }
    const summaryMatch = line.match(AUDIT_SUMMARY_LINE_RE);
    if (summaryMatch) {
      const val = cleanUntruncatedText(summaryMatch[1]);
      if (val) summary = appendDetailText(summary, val);
      currentField = undefined;
      continue;
    }
    const labelled = line.match(AUDIT_FIELD_RE);
    if (labelled) {
      const label = labelled.groups?.label ?? '';
      const value = labelled.groups?.value ?? '';
      if (current) {
        const assigned = assignFieldFromLabel(current, label, value);
        if (assigned) {
          currentField = assigned;
          continue;
        }
      }
      const cleanVal = cleanUntruncatedText(value);
      if (/next step|下一步/iu.test(label)) {
        if (cleanVal) nextSteps.push(cleanVal);
        currentField = undefined;
        continue;
      }
      if (/reason|why|原因|返工原因|未通过原因|主要问题|审计意见|返工意见|审查意见/iu.test(label)) {
        if (cleanVal) reasons.push(cleanVal);
        currentField = undefined;
        continue;
      }
      if (/validation|验证|tests?|suite/iu.test(label)) {
        currentField = undefined;
        continue;
      }
    }
    if (current && currentField) {
      const cont = cleanUntruncatedText(line);
      if (cont) {
        current[currentField] = appendDetailText(current[currentField], cont) ?? cont;
      }
      continue;
    }
    if (!AUDIT_METADATA_LINE_RE.test(line) && !line.startsWith('```')) {
      const cleaned = cleanUntruncatedText(line);
      if (cleaned) proseLines.push(cleaned);
    }
  }

  let findings = taggedFindings.filter((item) => Boolean(item.summary || item.location || item.proposal || item.evidence));

  // Fallback for numbered / bullet lists when auditor did not tag [P0]..[P4] on each line
  if (findings.length === 0) {
    const listFindings: Array<Omit<GlobalTaskAuditFindingItem, 'index' | 'blocking'>> = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || AUDIT_METADATA_LINE_RE.test(line) || line.startsWith('```')) continue;
      if (AUDIT_SUMMARY_LINE_RE.test(line)) continue;
      const numMatch = line.match(AUDIT_NUMBERED_ITEM_RE);
      const bulletMatch = !numMatch ? line.match(AUDIT_BULLET_ITEM_RE) : null;
      const itemBody = numMatch ? cleanUntruncatedText(numMatch[2]) : (bulletMatch ? cleanUntruncatedText(bulletMatch[1]) : undefined);
      if (!itemBody) continue;
      const sevMatch = itemBody.match(AUDIT_INLINE_SEVERITY_RE);
      const severity = (sevMatch?.[1] ?? sevMatch?.[2] ?? sevMatch?.[3])?.toUpperCase();
      listFindings.push({
        ...(severity ? { severity } : {}),
        summary: itemBody,
      });
    }
    if (listFindings.length > 0) {
      findings = listFindings;
    }
  }

  const effectiveSummary = summary ?? (proseLines.length > 0 ? proseLines[0] : undefined);
  return {
    findings,
    ...(effectiveSummary ? { summary: effectiveSummary } : {}),
    ...(reasons.length > 0 ? { reason: reasons.join('\n') } : {}),
    ...(nextSteps.length > 0 ? { nextStep: nextSteps.join('\n') } : {}),
  };
}

function normalizeStructuredFindings(
  structured: readonly TaskPairAuditFinding[] | undefined,
): Array<Omit<GlobalTaskAuditFindingItem, 'index' | 'blocking'>> {
  if (!Array.isArray(structured) || structured.length === 0) return [];
  const out: Array<Omit<GlobalTaskAuditFindingItem, 'index' | 'blocking'>> = [];
  for (const item of structured) {
    if (!item || typeof item !== 'object') continue;
    const summary = cleanUntruncatedText(item.summary) ?? cleanUntruncatedText(item.invariant) ?? '';
    const location = cleanUntruncatedText(item.location);
    const evidence = cleanUntruncatedText(item.evidence);
    const proposal = cleanUntruncatedText(item.proposal);
    const invariant = cleanUntruncatedText(item.invariant);
    const tradeoffs = cleanUntruncatedText(item.tradeoffs);
    const severity = typeof item.severity === 'string' && item.severity.trim()
      ? item.severity.trim().toUpperCase()
      : undefined;
    if (!summary && !location && !proposal && !evidence) continue;
    out.push({
      ...(severity ? { severity } : {}),
      summary: summary || location || proposal || '',
      ...(location ? { location } : {}),
      ...(evidence ? { evidence } : {}),
      ...(proposal ? { proposal } : {}),
      ...(invariant && invariant !== summary ? { invariant } : {}),
      ...(tradeoffs ? { tradeoffs } : {}),
    });
  }
  return out;
}

function normalizeCounts(
  raw: (Partial<GlobalTaskAuditCounts> & Partial<Record<'P0' | 'P1' | 'P2' | 'P3' | 'P4', number>>) | undefined,
): GlobalTaskAuditCounts {
  return {
    p0: Math.max(0, Math.floor(Number(raw?.p0 ?? raw?.P0 ?? 0) || 0)),
    p1: Math.max(0, Math.floor(Number(raw?.p1 ?? raw?.P1 ?? 0) || 0)),
    p2: Math.max(0, Math.floor(Number(raw?.p2 ?? raw?.P2 ?? 0) || 0)),
    p3: Math.max(0, Math.floor(Number(raw?.p3 ?? raw?.P3 ?? 0) || 0)),
    p4: Math.max(0, Math.floor(Number(raw?.p4 ?? raw?.P4 ?? 0) || 0)),
  };
}

/**
 * Extract full, untruncated numbered audit details from a persisted `TaskPairLastVerdict`.
 * Prefers full structured details (`structuredDetails`) or untruncated reply text (`fullNoticeText`),
 * falling back cleanly to `noticeText` / `auditDetails` for legacy persisted pairs.
 */
export function extractAuditFindingsFromVerdict(
  lastVerdict: TaskPairLastVerdict | null | undefined,
  blocking: readonly string[] = ['P0'],
): GlobalTaskAuditDetail | undefined {
  if (!lastVerdict || (lastVerdict.verb !== 'PASS' && lastVerdict.verb !== 'REWORK')) {
    return undefined;
  }
  const counts = normalizeCounts(lastVerdict.counts);
  const effectiveBlocking = normalizeAuditBlockingSeverities(blocking);
  const blockingSet = new Set<string>(effectiveBlocking);
  const blockingCount = effectiveBlocking.reduce((sum, lvl) => {
    const key = lvl.toLowerCase() as keyof GlobalTaskAuditCounts;
    return sum + (counts[key] ?? 0);
  }, 0);

  const fullText = cleanUntruncatedTextPreservingNewlines(lastVerdict.fullNoticeText)
    ?? cleanUntruncatedTextPreservingNewlines(lastVerdict.noticeText);
  const parsedFromText = fullText ? parseUntruncatedTextAudit(fullText) : { findings: [] };
  const structuredFull = normalizeStructuredFindings(lastVerdict.structuredDetails?.findings);
  const legacyStructured = normalizeStructuredFindings(lastVerdict.auditDetails?.findings);

  const rawFindings = structuredFull.length > 0
    ? structuredFull
    : (parsedFromText.findings.length > 0 ? parsedFromText.findings : legacyStructured);

  const findings: GlobalTaskAuditFindingItem[] = rawFindings.map((item, idx) => ({
    index: idx + 1,
    ...(item.severity ? { severity: item.severity } : {}),
    blocking: isBlockingSeverity(item.severity, blockingSet),
    summary: item.summary,
    ...(item.location ? { location: item.location } : {}),
    ...(item.evidence ? { evidence: item.evidence } : {}),
    ...(item.proposal ? { proposal: item.proposal } : {}),
    ...(item.invariant ? { invariant: item.invariant } : {}),
    ...(item.tradeoffs ? { tradeoffs: item.tradeoffs } : {}),
  }));

  const countSum = AUDIT_SEVERITY_LEVELS.reduce((sum, lvl) => {
    const key = lvl.toLowerCase() as keyof GlobalTaskAuditCounts;
    return sum + (counts[key] ?? 0);
  }, 0);
  const findingsCount = findings.length > 0 ? findings.length : countSum;

  const summary = cleanUntruncatedText(lastVerdict.structuredDetails?.summary)
    ?? parsedFromText.summary
    ?? cleanUntruncatedText(lastVerdict.auditDetails?.summary)
    ?? cleanUntruncatedText(lastVerdict.reason)
    ?? cleanUntruncatedText(lastVerdict.auditDetails?.reason)
    ?? findings[0]?.summary;

  const reason = cleanUntruncatedText(lastVerdict.structuredDetails?.reason)
    ?? parsedFromText.reason
    ?? cleanUntruncatedText(lastVerdict.reason)
    ?? cleanUntruncatedText(lastVerdict.auditDetails?.reason);

  const nextStep = cleanUntruncatedText(lastVerdict.structuredDetails?.nextStep)
    ?? parsedFromText.nextStep
    ?? cleanUntruncatedText(lastVerdict.auditDetails?.nextStep);

  return {
    verb: lastVerdict.verb,
    round: Math.max(0, Math.floor(Number(lastVerdict.round ?? 0) || 0)),
    counts,
    blocking: [...effectiveBlocking],
    blockingCount,
    findingsCount,
    ...(summary ? { summary } : {}),
    ...(reason ? { reason } : {}),
    ...(nextStep ? { nextStep } : {}),
    ...(fullText ? { noticeText: fullText } : {}),
    findings,
  };
}

function cleanUntruncatedTextPreservingNewlines(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Build the compact, PG-NOTIFY-safe audit summary attached to task cards and snapshots.
 */
export function buildGlobalTaskAuditSummary(
  lastVerdict: TaskPairLastVerdict | null | undefined,
  blocking: readonly string[] = ['P0'],
): GlobalTaskAuditSummary | undefined {
  const detail = extractAuditFindingsFromVerdict(lastVerdict, blocking);
  if (!detail) return undefined;
  const compactSummary = detail.summary
    ? truncateGlobalBrainText(detail.summary.replace(/\s+/gu, ' ').trim(), GLOBAL_TASK_AUDIT_SUMMARY_MAX_CHARS)
    : '';
  return {
    verb: detail.verb,
    round: detail.round,
    counts: { ...detail.counts },
    blocking: [...detail.blocking],
    blockingCount: detail.blockingCount,
    findingsCount: detail.findingsCount,
    ...(compactSummary ? { summary: compactSummary } : {}),
  };
}
