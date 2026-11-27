import { MACHINE_CONFIG_REQUEST_ERROR } from './machine-config-request.js';
import { AUDIT_SEVERITY_LEVELS, normalizeAuditBlockingSeverities } from './audit-convergence.js';
import {
  GLOBAL_TASK_AUDIT_SUMMARY_MAX_CHARS,
  truncateGlobalBrainText,
  type GlobalTaskAuditCounts,
  type GlobalTaskAuditSummary,
} from './global-task-mode.js';
import { isAppliedVerdict, type TaskPairAuditFinding, type TaskPairLastVerdict } from './task-pair.js';

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
const AUDIT_NUMBERED_ITEM_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(\d{1,3})[.)、](?:\*\*|__)?\s+(.+)$/u;
const AUDIT_BULLET_ITEM_RE = /^\s*[-*•]\s+(.+)$/u;
const AUDIT_HEADING_OR_RULE_RE = /^\s*(?:#{1,6}\s+\S|[-*_]{3,}\s*$)/u;
const AUDIT_NON_FINDING_SECTION_RE = /^(?:verification|validation|checks?|tests?|test\s+results?|evidence\s+summary|acceptance|conclusion|result|summary|next\s+steps?|验证(?:结果|摘要|情况)?|检查(?:项|结果)?|测试(?:结果|通过)?|结论|总结|下一步)$/iu;
const AUDIT_FINDING_SECTION_RE = /^(?:findings?|issues?|problems?|defects?|bugs?|rework\s+items?|audit\s+findings?|blocking\s+findings?|review\s+findings?|发现(?:的问题)?|问题(?:清单|列表)?|缺陷|审计发现|返工(?:项|原因))$/iu;
const AUDIT_SUMMARY_LINE_RE = /^\s*(?:[-*•]\s*)?(?:\*\*|__)?(?:summary|audit summary|摘要|审计摘要|总体评价|评估|结论)(?:\*\*|__)?\s*[:：]\s*(.*)$/iu;
const AUDIT_FIELD_RE = /^\s*(?:[-*•]\s*)?(?:\*\*|__)?(?<label>invariant|violat(?:es|ed|ion)|violation\s+of\s+invariant|invariant\s+violated|违反不变量|不变量|location|位置|file(?:\s*\/\s*function)?|function|文件(?:路径|位置)?|evidence(?:\s*\/\s*repro(?:duction)?)?|证据|repro(?:duction)?|复现|proposal|recommendation|auditor\s+proposal|suggest(?:ed)?\s+(?:solution|fix)|solution|fix|建议(?:方案)?|修复(?:建议|方案)|建议|trade[- ]?offs?|权衡|validation(?:\s+summary)?|验证(?:摘要)?|tests?|suite|next step|next steps|下一步|reason|why|原因|返工原因|未通过原因|主要问题|审计意见|返工意见|审查意见)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?(?<value>.*)$/iu;
const AUDIT_METADATA_LINE_RE = /^\s*(?:\[IM\.codes task\b|<!--|Audited\s+pair\b|(?:status|round|executor|auditor|verdict|blocking)\s*[:=])/iu;
const AUDIT_INLINE_SEVERITY_RE = /(?:\[(P[0-4])\]|\((P[0-4])\)|\b(P[0-4])\b)/iu;

type AuditFindingFieldKey = keyof Omit<GlobalTaskAuditFindingItem, 'index' | 'blocking' | 'severity'>;
type AuditDraftFinding = Omit<GlobalTaskAuditFindingItem, 'index' | 'blocking'> & { hasExplicitTag?: boolean };

function stripMarkdownBold(value: string): string {
  // Strip `**bold**` emphasis only; never remove `__` so paths/identifiers like `src/a__b.ts` stay intact.
  return value.replace(/\*\*([^\n]*?)\*\*/gu, '$1');
}

function cleanUntruncatedText(value: unknown, preserveNewlines = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (preserveNewlines) {
    const cleaned = value
      .replace(/\r\n?/gu, '\n')
      .split('\n')
      .map((line) => stripMarkdownBold(line).replace(/[ \t]+/gu, ' ').trimEnd())
      .join('\n')
      .trim();
    return cleaned || undefined;
  }
  const cleaned = stripMarkdownBold(value).replace(/[ \t]+/gu, ' ').trim();
  return cleaned || undefined;
}

function appendDetailText(
  existing: string | undefined,
  next: string | undefined,
  blankLineBefore = false,
): string | undefined {
  if (!next) return existing;
  if (!existing) return next;
  return `${existing}${blankLineBefore ? '\n\n' : '\n'}${next}`;
}

function isBlockingSeverity(severity: string | undefined, blockingSet: ReadonlySet<string>): boolean {
  if (!severity) return false;
  return blockingSet.has(severity.trim().toUpperCase());
}

function assignFieldFromLabel(
  finding: AuditDraftFinding,
  label: string,
  value: string,
): AuditFindingFieldKey | undefined {
  const key = label.toLowerCase().replace(/[：:]/gu, '').trim();
  const normalized = cleanUntruncatedText(value);
  let field: AuditFindingFieldKey | undefined;
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
  findings: AuditDraftFinding[];
  summary?: string;
  reason?: string;
  nextStep?: string;
} {
  const lines = rawText.replace(/\r\n?/gu, '\n').split('\n');
  const findings: AuditDraftFinding[] = [];
  let current: AuditDraftFinding | undefined;
  let currentField: AuditFindingFieldKey | undefined;
  let pendingBlankLine = false;
  let sawEmptyHeaderField = false;
  let inCodeFence = false;
  let inNonFindingSection = false;
  let topLevelSection: 'summary' | 'reason' | 'nextStep' | null = null;
  let summary: string | undefined;
  const reasons: string[] = [];
  const nextSteps: string[] = [];
  const proseLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('```')) {
      inCodeFence = !inCodeFence;
      if (current && currentField) {
        current[currentField] = appendDetailText(current[currentField], line, pendingBlankLine) ?? line;
        pendingBlankLine = false;
      }
      continue;
    }

    if (inCodeFence) {
      if (current && currentField) {
        const fenceLine = stripMarkdownBold(rawLine).trimEnd();
        current[currentField] = appendDetailText(current[currentField], fenceLine, pendingBlankLine) ?? fenceLine;
      }
      pendingBlankLine = false;
      continue;
    }

    if (!line) {
      // Preserve paragraph boundaries inside active findings/fields instead of dropping subsequent paragraphs.
      pendingBlankLine = true;
      continue;
    }

    const leadingSpaces = rawLine.match(/^([ \t]*)/u)?.[1].replace(/\t/gu, '  ').length ?? 0;

    const taggedMatch = line.match(AUDIT_TAGGED_FINDING_RE) || line.match(AUDIT_BARE_FINDING_RE);
    if (taggedMatch) {
      const severity = taggedMatch[1]?.toUpperCase();
      const body = cleanUntruncatedText(taggedMatch[2]) ?? '';
      current = { ...(severity ? { severity } : {}), summary: body, hasExplicitTag: true };
      findings.push(current);
      currentField = 'summary';
      pendingBlankLine = false;
      sawEmptyHeaderField = !body || body.endsWith(':');
      inNonFindingSection = false;
      topLevelSection = null;
      continue;
    }

    const summaryMatch = line.match(AUDIT_SUMMARY_LINE_RE);
    if (summaryMatch) {
      const val = cleanUntruncatedText(summaryMatch[1]);
      if (val) summary = appendDetailText(summary, val, pendingBlankLine);
      current = undefined;
      currentField = undefined;
      pendingBlankLine = false;
      sawEmptyHeaderField = false;
      inNonFindingSection = false;
      topLevelSection = 'summary';
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
          const cleanVal = cleanUntruncatedText(value);
          sawEmptyHeaderField = !cleanVal || cleanVal.endsWith(':');
          pendingBlankLine = false;
          topLevelSection = null;
          continue;
        }
      }
      const cleanVal = cleanUntruncatedText(value);
      if (/next step|下一步/iu.test(label)) {
        if (cleanVal) nextSteps.push(cleanVal);
        current = undefined;
        currentField = undefined;
        pendingBlankLine = false;
        sawEmptyHeaderField = false;
        inNonFindingSection = true;
        topLevelSection = 'nextStep';
        continue;
      }
      if (/reason|why|原因|返工原因|未通过原因|主要问题|审计意见|返工意见|审查意见/iu.test(label)) {
        if (cleanVal) reasons.push(cleanVal);
        current = undefined;
        currentField = undefined;
        pendingBlankLine = false;
        sawEmptyHeaderField = false;
        topLevelSection = 'reason';
        continue;
      }
      if (/validation|验证|tests?|suite/iu.test(label)) {
        current = undefined;
        currentField = undefined;
        pendingBlankLine = false;
        sawEmptyHeaderField = false;
        inNonFindingSection = true;
        topLevelSection = null;
        continue;
      }
    }

    const numMatch = line.match(AUDIT_NUMBERED_ITEM_RE);
    if (numMatch && !inNonFindingSection) {
      const isNestedSubStep = Boolean(
        current
        && currentField
        && currentField !== 'summary'
        && (leadingSpaces >= 2 || (sawEmptyHeaderField && !pendingBlankLine)),
      );
      if (!isNestedSubStep) {
        const body = cleanUntruncatedText(numMatch[2]) ?? '';
        if (body) {
          const sevMatch = body.match(AUDIT_INLINE_SEVERITY_RE);
          const severity = (sevMatch?.[1] ?? sevMatch?.[2] ?? sevMatch?.[3])?.toUpperCase();
          current = { ...(severity ? { severity } : {}), summary: body, hasExplicitTag: false };
          findings.push(current);
          currentField = 'summary';
          pendingBlankLine = false;
          sawEmptyHeaderField = body.endsWith(':');
          topLevelSection = null;
          continue;
        }
      }
    }

    const bulletMatch = line.match(AUDIT_BULLET_ITEM_RE);
    if (bulletMatch && !inNonFindingSection) {
      const isNestedBullet = Boolean(
        current
        && currentField
        && (
          leadingSpaces >= 2
          || (currentField !== 'summary' && (!pendingBlankLine || sawEmptyHeaderField))
        ),
      );
      if (!isNestedBullet) {
        const body = cleanUntruncatedText(bulletMatch[1]) ?? '';
        if (body) {
          const sevMatch = body.match(AUDIT_INLINE_SEVERITY_RE);
          const severity = (sevMatch?.[1] ?? sevMatch?.[2] ?? sevMatch?.[3])?.toUpperCase();
          current = { ...(severity ? { severity } : {}), summary: body, hasExplicitTag: false };
          findings.push(current);
          currentField = 'summary';
          pendingBlankLine = false;
          sawEmptyHeaderField = body.endsWith(':');
          topLevelSection = null;
          continue;
        }
      }
    }

    if (AUDIT_METADATA_LINE_RE.test(line)) {
      pendingBlankLine = false;
      continue;
    }

    if (AUDIT_HEADING_OR_RULE_RE.test(line)) {
      current = undefined;
      currentField = undefined;
      pendingBlankLine = false;
      sawEmptyHeaderField = false;
      topLevelSection = null;
      const cleanedHeading = cleanUntruncatedText(line.replace(/^#+\s*/u, ''));
      if (cleanedHeading && !/^[-*_]{3,}$/u.test(cleanedHeading)) {
        const headingKey = cleanedHeading.replace(/[:：]+$/u, '').trim();
        if (AUDIT_NON_FINDING_SECTION_RE.test(headingKey)) inNonFindingSection = true;
        else if (AUDIT_FINDING_SECTION_RE.test(headingKey)) inNonFindingSection = false;
        proseLines.push(cleanedHeading);
      }
      continue;
    }

    const cleaned = cleanUntruncatedText(line);
    if (cleaned) {
      if (current && currentField) {
        current[currentField] = appendDetailText(current[currentField], cleaned, pendingBlankLine) ?? cleaned;
      } else if (topLevelSection === 'nextStep') {
        nextSteps.push(cleaned);
      } else if (topLevelSection === 'reason') {
        reasons.push(cleaned);
      } else if (topLevelSection === 'summary') {
        summary = appendDetailText(summary, cleaned, pendingBlankLine);
      } else {
        proseLines.push(cleaned);
      }
    }
    pendingBlankLine = false;
    sawEmptyHeaderField = false;
  }

  const normalizedFindings = findings.filter((item) => Boolean(item.summary || item.location || item.proposal || item.evidence));
  const effectiveSummary = summary ?? (proseLines.length > 0 ? proseLines[0] : undefined);
  return {
    findings: normalizedFindings,
    ...(effectiveSummary ? { summary: effectiveSummary } : {}),
    ...(reasons.length > 0 ? { reason: reasons.join('\n') } : {}),
    ...(nextSteps.length > 0 ? { nextStep: nextSteps.join('\n') } : {}),
  };
}

function mergeSingleAuditField(saved: string | undefined, parsed: string | undefined): string | undefined {
  if (!saved) return parsed;
  if (!parsed) return saved;
  // Prefer saved structured field unless parsed untruncated text strictly expands a truncated prefix.
  if (parsed.length > saved.length && parsed.startsWith(saved.slice(0, Math.min(40, saved.length)))) {
    return parsed;
  }
  return saved;
}

function sameFindingSummaryOrPrefixTruncation(a: string, b: string): boolean {
  const normA = a.replace(/\s+/gu, ' ').trim().toLowerCase();
  const normB = b.replace(/\s+/gu, ' ').trim().toLowerCase();
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  // Allow only full-string prefix expansion when an older slice truncated the tail of the same summary.
  return (normA.length >= 24 && normB.startsWith(normA)) || (normB.length >= 24 && normA.startsWith(normB));
}

function mergeAuditFindings(
  structuredFull: readonly AuditDraftFinding[],
  parsedFromText: readonly AuditDraftFinding[],
  legacyStructured: readonly AuditDraftFinding[],
): AuditDraftFinding[] {
  if (structuredFull.length > 0) {
    // Explicit structured findings are authoritative; independent notice stays available via `noticeText` without cross-list field guessing.
    return [...structuredFull];
  }

  if (parsedFromText.length > 0) {
    // `parsedFromText` owns item boundaries and ordering from `fullNoticeText`/`noticeText`.
    // Only fill missing fields from `legacyStructured` when both parses agree 1-to-1 on every item
    // so a lossy legacy parse (`parseTaskPairAuditDetails` dropping unbracketed items) can never drop, duplicate, or cross-contaminate items.
    const parsedHasAnyField = parsedFromText.some((p) => Boolean(p.location || p.proposal || p.evidence || p.invariant || p.tradeoffs));
    const canFillFromLegacy = legacyStructured.length === parsedFromText.length
      && parsedFromText.every((p, idx) => {
        const l = legacyStructured[idx]!;
        const sevAligned = !p.severity || !l.severity || p.severity === l.severity;
        if (!sevAligned) return false;
        return sameFindingSummaryOrPrefixTruncation(p.summary, l.summary) || (legacyStructured.length === 1 && !parsedHasAnyField);
      });
    if (!canFillFromLegacy) {
      return [...parsedFromText];
    }
    return parsedFromText.map((parsed, idx) => {
      const legacy = legacyStructured[idx]!;
      const severity = parsed.severity ?? legacy.severity;
      const summary = mergeSingleAuditField(legacy.summary, parsed.summary) ?? parsed.summary;
      const location = parsed.location ?? legacy.location;
      const evidence = parsed.evidence ?? legacy.evidence;
      const proposal = parsed.proposal ?? legacy.proposal;
      const invariant = parsed.invariant ?? legacy.invariant;
      const tradeoffs = parsed.tradeoffs ?? legacy.tradeoffs;
      return {
        ...(severity ? { severity } : {}),
        summary,
        ...(location ? { location } : {}),
        ...(evidence ? { evidence } : {}),
        ...(proposal ? { proposal } : {}),
        ...(invariant ? { invariant } : {}),
        ...(tradeoffs ? { tradeoffs } : {}),
      };
    });
  }

  return [...legacyStructured];
}

function normalizeStructuredFindings(
  structured: readonly TaskPairAuditFinding[] | undefined,
): AuditDraftFinding[] {
  if (!Array.isArray(structured) || structured.length === 0) return [];
  const out: AuditDraftFinding[] = [];
  for (const item of structured) {
    if (!item || typeof item !== 'object') continue;
    const summary = cleanUntruncatedText(item.summary, true) ?? cleanUntruncatedText(item.invariant, true) ?? '';
    const location = cleanUntruncatedText(item.location);
    const evidence = cleanUntruncatedText(item.evidence, true);
    const proposal = cleanUntruncatedText(item.proposal, true);
    const invariant = cleanUntruncatedText(item.invariant, true);
    const tradeoffs = cleanUntruncatedText(item.tradeoffs, true);
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
 * Extract full, untruncated numbered audit details from an applied `TaskPairLastVerdict`.
 * Unapplied verdicts (`judgement` inconsistent / missing_severity) yield `undefined`.
 */
export function extractAuditFindingsFromVerdict(
  lastVerdict: TaskPairLastVerdict | null | undefined,
  blocking: readonly string[] = ['P0'],
): GlobalTaskAuditDetail | undefined {
  if (!lastVerdict || (lastVerdict.verb !== 'PASS' && lastVerdict.verb !== 'REWORK')) {
    return undefined;
  }
  if (!isAppliedVerdict(lastVerdict.judgement)) {
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
  const countSum = AUDIT_SEVERITY_LEVELS.reduce((sum, lvl) => {
    const key = lvl.toLowerCase() as keyof GlobalTaskAuditCounts;
    return sum + (counts[key] ?? 0);
  }, 0);
  // On a zero-finding PASS, never promote unbracketed bullet/numbered verification checklists into findings.
  const effectiveParsedFindings = lastVerdict.verb === 'PASS' && countSum === 0
    ? parsedFromText.findings.filter((item) => item.hasExplicitTag)
    : parsedFromText.findings;

  const rawFindings = mergeAuditFindings(structuredFull, effectiveParsedFindings, legacyStructured);

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

  const findingsCount = findings.length > 0 ? findings.length : countSum;

  const summary = cleanUntruncatedText(lastVerdict.structuredDetails?.summary, true)
    ?? parsedFromText.summary
    ?? cleanUntruncatedText(lastVerdict.auditDetails?.summary, true)
    ?? cleanUntruncatedText(lastVerdict.reason, true)
    ?? cleanUntruncatedText(lastVerdict.auditDetails?.reason, true)
    ?? findings[0]?.summary;

  const reason = cleanUntruncatedText(lastVerdict.structuredDetails?.reason, true)
    ?? parsedFromText.reason
    ?? cleanUntruncatedText(lastVerdict.reason, true)
    ?? cleanUntruncatedText(lastVerdict.auditDetails?.reason, true);

  const nextStep = cleanUntruncatedText(lastVerdict.structuredDetails?.nextStep, true)
    ?? parsedFromText.nextStep
    ?? cleanUntruncatedText(lastVerdict.auditDetails?.nextStep, true);

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
