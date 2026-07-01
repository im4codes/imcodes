import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_DIAGNOSTIC,
  SDK_SUBAGENT_MAX_TERMINAL_ROWS,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_STATUS,
  SDK_SUBAGENT_TERMINAL_RETENTION_MS,
  parseSdkSubagentDetail,
  type SdkSubagentDetail,
  type SdkSubagentDiagnosticCode,
  type SdkSubagentNormalizedStatus,
  type SdkSubagentProvider,
  type SdkSubagentProviderKind,
} from '@shared/sdk-subagent-status.js';
import type { TimelineEvent } from '../ws-client.js';

export interface SdkSubagentAggregationOptions {
  terminalTtlMs?: number;
  maxTerminalRows?: number;
  activeStaleMs?: number;
}

export interface SdkSubagentStatusRow {
  canonicalKey: string;
  sessionId: string;
  eventId: string;
  startTs: number;
  ts: number;
  provider: SdkSubagentProvider;
  providerKind: SdkSubagentProviderKind;
  normalizedStatus: SdkSubagentNormalizedStatus;
  rawStatus?: string;
  summary?: string;
  description?: string;
  output?: string;
  active: boolean;
  terminal: boolean;
  parentItemId?: string;
  parentToolUseId?: string;
  agentPath?: string;
  agentName?: string;
  model?: string;
  taskId?: string;
  receiverThreadId?: string;
  receiverIndex?: number;
  receiverCount?: number;
  runningChildCount?: number;
  childStatusSummary?: string;
  backgrounded?: boolean;
  usageTotalTokens?: number;
  usageToolUses?: number;
  usageDurationMs?: number;
  startedAtMs?: number;
}

export interface SdkSubagentDiagnostic {
  id: string;
  eventId: string;
  sessionId: string;
  ts: number;
  canonicalKey?: string;
  provider?: SdkSubagentProvider;
  providerKind?: SdkSubagentProviderKind;
  normalizedStatus?: SdkSubagentNormalizedStatus;
  rawStatus?: string;
  summary?: string;
  description?: string;
  output?: string;
  diagnosticCode: SdkSubagentDiagnosticCode;
  childStatusSummary?: string;
}

export interface SdkSubagentAggregationResult {
  rows: SdkSubagentStatusRow[];
  runningCount: number;
  diagnostics: SdkSubagentDiagnostic[];
}

interface RowState extends SdkSubagentStatusRow {
  firstOrder: number;
  lastOrder: number;
}

interface DiagnosticState extends SdkSubagentDiagnostic {
  firstOrder: number;
  lastOrder: number;
}

interface SessionFinishState {
  eventId: string;
  ts: number;
  order: number;
}

const ACTIVE_STATUSES = new Set<SdkSubagentNormalizedStatus>([
  SDK_SUBAGENT_STATUS.PENDING,
  SDK_SUBAGENT_STATUS.RUNNING,
]);

const TERMINAL_STATUSES = new Set<SdkSubagentNormalizedStatus>([
  SDK_SUBAGENT_STATUS.COMPLETE,
  SDK_SUBAGENT_STATUS.ERROR,
  SDK_SUBAGENT_STATUS.INTERRUPTED,
  SDK_SUBAGENT_STATUS.STALE,
]);

const DEFAULT_ACTIVE_STALE_MS = 15 * 60_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getSdkSubagentDetail(event: TimelineEvent): SdkSubagentDetail | 'malformed' | null {
  const payload = asRecord(event.payload);
  const detail = asRecord(payload?.detail);
  if (!detail) return null;
  if (detail.kind !== SDK_SUBAGENT_DETAIL_KIND) return null;
  const parsed = parseSdkSubagentDetail(detail);
  return parsed.kind === 'ok' ? parsed.detail : 'malformed';
}

function getSessionFinishState(event: TimelineEvent, order: number): SessionFinishState | null {
  if (event.type !== 'session.state') return null;
  const payload = asRecord(event.payload);
  const state = typeof payload?.state === 'string' ? payload.state : undefined;
  if (state !== 'idle' && state !== 'error') return null;
  return { eventId: event.eventId, ts: event.ts, order };
}

function getCodexCollabWrapperFinishState(event: TimelineEvent, order: number): SessionFinishState | null {
  if (event.type === 'assistant.text') return { eventId: event.eventId, ts: event.ts, order };
  return getSessionFinishState(event, order);
}

function isKnownStatus(value: string): value is SdkSubagentNormalizedStatus {
  return Object.values(SDK_SUBAGENT_STATUS).includes(value as SdkSubagentNormalizedStatus);
}

function makeMalformedDiagnostic(event: TimelineEvent, order: number): DiagnosticState {
  return {
    id: `${event.eventId}:malformed`,
    eventId: event.eventId,
    sessionId: event.sessionId,
    ts: event.ts,
    diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.MALFORMED_PAYLOAD,
    firstOrder: order,
    lastOrder: order,
  };
}

function makeDiagnosticFromDetail(
  event: TimelineEvent,
  detail: SdkSubagentDetail,
  order: number,
  fallbackCode: SdkSubagentDiagnosticCode,
): DiagnosticState {
  const meta = detail.meta;
  return {
    id: meta.canonicalKey,
    eventId: event.eventId,
    sessionId: event.sessionId,
    ts: event.ts,
    canonicalKey: meta.canonicalKey,
    provider: meta.provider,
    providerKind: meta.providerKind,
    normalizedStatus: meta.normalizedStatus,
    rawStatus: meta.rawStatus,
    summary: detail.summary,
    description: detail.input?.description,
    output: detail.output,
    diagnosticCode: meta.diagnosticCode ?? fallbackCode,
    childStatusSummary: meta.childStatusSummary,
    firstOrder: order,
    lastOrder: order,
  };
}

function isTerminalish(row: Pick<SdkSubagentStatusRow, 'terminal' | 'normalizedStatus'>): boolean {
  return row.terminal || TERMINAL_STATUSES.has(row.normalizedStatus);
}

function normalizeStartedAtMs(value: unknown, eventTs: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return eventTs;
  const startedAtMs = Math.floor(value);
  if (startedAtMs <= 0) return eventTs;
  // Provider clocks can be a little ahead, but a future "start" would make
  // elapsed time negative and produce the app-reopen reset this metadata is
  // meant to prevent. Fall back rather than trusting impossible data.
  if (startedAtMs > eventTs) return eventTs;
  return startedAtMs;
}

function mergeStartTs(previous: RowState | undefined, next: RowState): number {
  if (!previous) return next.startTs;
  return Math.min(previous.startTs, next.startTs);
}

function makeRow(event: TimelineEvent, detail: SdkSubagentDetail, order: number): RowState | null {
  const meta = detail.meta;
  if (!isKnownStatus(meta.normalizedStatus)) return null;
  const terminal = isTerminalish(meta);
  const active = meta.active && !terminal && ACTIVE_STATUSES.has(meta.normalizedStatus);
  const startTs = normalizeStartedAtMs(meta.startedAtMs, event.ts);
  return {
    canonicalKey: meta.canonicalKey,
    sessionId: event.sessionId,
    eventId: event.eventId,
    startTs,
    ts: event.ts,
    provider: meta.provider,
    providerKind: meta.providerKind,
    normalizedStatus: meta.normalizedStatus,
    rawStatus: meta.rawStatus,
    summary: detail.summary,
    description: detail.input?.description,
    output: detail.output,
    active,
    terminal,
    parentItemId: meta.parentItemId,
    parentToolUseId: meta.parentToolUseId,
    agentPath: meta.agentPath,
    agentName: meta.agentName,
    model: meta.model,
    taskId: meta.taskId,
    receiverThreadId: meta.receiverThreadId,
    receiverIndex: meta.receiverIndex,
    receiverCount: meta.receiverCount,
    runningChildCount: meta.runningChildCount,
    childStatusSummary: meta.childStatusSummary,
    backgrounded: meta.backgrounded === true,
    usageTotalTokens: meta.usageTotalTokens,
    usageToolUses: meta.usageToolUses,
    usageDurationMs: meta.usageDurationMs,
    startedAtMs: meta.startedAtMs,
    firstOrder: order,
    lastOrder: order,
  };
}

function isRetained(ts: number, now: number, ttlMs: number): boolean {
  return now - ts <= ttlMs;
}

function receiverOrder(a: Pick<SdkSubagentStatusRow, 'providerKind' | 'parentItemId' | 'receiverIndex'>, b: Pick<SdkSubagentStatusRow, 'providerKind' | 'parentItemId' | 'receiverIndex'>): number {
  if (
    a.providerKind === SDK_SUBAGENT_PROVIDER_KINDS.CODEX_COLLAB_AGENT
    && b.providerKind === SDK_SUBAGENT_PROVIDER_KINDS.CODEX_COLLAB_AGENT
    && a.parentItemId
    && a.parentItemId === b.parentItemId
    && typeof a.receiverIndex === 'number'
    && typeof b.receiverIndex === 'number'
  ) {
    return a.receiverIndex - b.receiverIndex;
  }
  return 0;
}

function activeRowSort(a: RowState, b: RowState): number {
  return receiverOrder(a, b) || a.firstOrder - b.firstOrder;
}

function terminalRowSort(a: RowState, b: RowState): number {
  return receiverOrder(a, b) || b.ts - a.ts || b.lastOrder - a.lastOrder;
}

function diagnosticSort(a: DiagnosticState, b: DiagnosticState): number {
  return b.ts - a.ts || b.lastOrder - a.lastOrder;
}

function stripRowState(row: RowState): SdkSubagentStatusRow {
  const publicRow: Partial<RowState> = { ...row };
  delete publicRow.firstOrder;
  delete publicRow.lastOrder;
  return publicRow as SdkSubagentStatusRow;
}

function stripDiagnosticState(diagnostic: DiagnosticState): SdkSubagentDiagnostic {
  const publicDiagnostic: Partial<DiagnosticState> = { ...diagnostic };
  delete publicDiagnostic.firstOrder;
  delete publicDiagnostic.lastOrder;
  return publicDiagnostic as SdkSubagentDiagnostic;
}

function findFinishAfter(row: RowState, finishes: SessionFinishState[]): SessionFinishState | null {
  for (const finish of finishes) {
    if (finish.order > row.lastOrder) return finish;
  }
  return null;
}

function staleRowAfterFinish(row: RowState, finish: SessionFinishState): RowState {
  return {
    ...row,
    eventId: finish.eventId,
    ts: finish.ts,
    normalizedStatus: SDK_SUBAGENT_STATUS.STALE,
    rawStatus: row.rawStatus ?? SDK_SUBAGENT_STATUS.STALE,
    active: false,
    terminal: true,
    lastOrder: finish.order,
  };
}

function isCodexCollabWrapperRow(row: Pick<SdkSubagentStatusRow, 'providerKind' | 'receiverThreadId'>): boolean {
  return row.providerKind === SDK_SUBAGENT_PROVIDER_KINDS.CODEX_COLLAB_AGENT && !row.receiverThreadId;
}

function getRunningContribution(row: SdkSubagentStatusRow): number {
  if (!row.active || row.terminal || !ACTIVE_STATUSES.has(row.normalizedStatus)) return 0;
  if (
    row.providerKind === SDK_SUBAGENT_PROVIDER_KINDS.CODEX_COLLAB_AGENT
    && !row.receiverThreadId
    && typeof row.runningChildCount === 'number'
    && Number.isFinite(row.runningChildCount)
  ) {
    return Math.max(0, Math.floor(row.runningChildCount));
  }
  return 1;
}

function suppressClaudeRuntimeFallbackRows(rows: RowState[]): RowState[] {
  const structuredToolUseIds = new Set(
    rows
      .filter((row) => row.providerKind === SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK && row.parentToolUseId)
      .map((row) => row.parentToolUseId as string),
  );
  if (structuredToolUseIds.size === 0) return rows;
  return rows.filter((row) => {
    if (row.providerKind !== SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_RUNTIME_AGENT) return true;
    const toolUseId = row.parentToolUseId ?? row.parentItemId;
    return !toolUseId || !structuredToolUseIds.has(toolUseId);
  });
}

export function deriveSdkSubagentStatusRows(
  events: TimelineEvent[],
  now: number,
  options: SdkSubagentAggregationOptions = {},
): SdkSubagentAggregationResult {
  const terminalTtlMs = options.terminalTtlMs ?? SDK_SUBAGENT_TERMINAL_RETENTION_MS;
  const maxTerminalRows = options.maxTerminalRows ?? SDK_SUBAGENT_MAX_TERMINAL_ROWS;
  const activeStaleMs = options.activeStaleMs ?? DEFAULT_ACTIVE_STALE_MS;
  const rowsByCanonicalKey = new Map<string, RowState>();
  const diagnosticsById = new Map<string, DiagnosticState>();
  const sessionFinishes: SessionFinishState[] = [];
  const codexCollabWrapperFinishes: SessionFinishState[] = [];

  events.forEach((event, order) => {
    const finish = getSessionFinishState(event, order);
    if (finish) sessionFinishes.push(finish);
    const codexCollabFinish = getCodexCollabWrapperFinishState(event, order);
    if (codexCollabFinish) codexCollabWrapperFinishes.push(codexCollabFinish);

    const detail = getSdkSubagentDetail(event);
    if (!detail) return;
    if (detail === 'malformed') {
      const diagnostic = makeMalformedDiagnostic(event, order);
      diagnosticsById.set(diagnostic.id, diagnostic);
      return;
    }

    const knownStatus = isKnownStatus(detail.meta.normalizedStatus);
    if (detail.meta.diagnosticCode || !knownStatus || detail.meta.normalizedStatus === SDK_SUBAGENT_STATUS.UNKNOWN) {
      const next = knownStatus ? makeRow(event, detail, order) : null;
      if (next) {
        const previous = rowsByCanonicalKey.get(next.canonicalKey);
        if (!(previous && isTerminalish(previous) && next.active && !isTerminalish(next))) {
          rowsByCanonicalKey.set(next.canonicalKey, {
            ...next,
            firstOrder: previous?.firstOrder ?? next.firstOrder,
            startTs: mergeStartTs(previous, next),
          });
        }
      }
      const diagnostic = makeDiagnosticFromDetail(
        event,
        detail,
        order,
        knownStatus ? SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE : SDK_SUBAGENT_DIAGNOSTIC.MALFORMED_PAYLOAD,
      );
      const existingDiagnostic = diagnosticsById.get(diagnostic.id);
      diagnosticsById.set(diagnostic.id, {
        ...diagnostic,
        firstOrder: existingDiagnostic?.firstOrder ?? diagnostic.firstOrder,
      });
      return;
    }

    const next = makeRow(event, detail, order);
    if (!next) return;
    const previous = rowsByCanonicalKey.get(next.canonicalKey);
    if (previous && isTerminalish(previous) && next.active && !isTerminalish(next)) {
      return;
    }
    rowsByCanonicalKey.set(next.canonicalKey, {
      ...next,
      firstOrder: previous?.firstOrder ?? next.firstOrder,
      startTs: mergeStartTs(previous, next),
    });
  });

  for (const [canonicalKey, row] of rowsByCanonicalKey.entries()) {
    if (!row.active || isTerminalish(row)) continue;
    if (activeStaleMs > 0 && now - row.ts > activeStaleMs) {
      rowsByCanonicalKey.set(canonicalKey, {
        ...row,
        normalizedStatus: SDK_SUBAGENT_STATUS.STALE,
        rawStatus: row.rawStatus ?? SDK_SUBAGENT_STATUS.STALE,
        active: false,
        terminal: true,
      });
      continue;
    }
    if (row.backgrounded) continue;
    const finish = findFinishAfter(
      row,
      isCodexCollabWrapperRow(row) ? codexCollabWrapperFinishes : sessionFinishes,
    );
    if (!finish) continue;
    rowsByCanonicalKey.set(canonicalKey, staleRowAfterFinish(row, finish));
  }

  const rowStates = suppressClaudeRuntimeFallbackRows(Array.from(rowsByCanonicalKey.values()));

  const activeRows = rowStates
    .filter((row) => row.active && !isTerminalish(row))
    .sort(activeRowSort);

  const terminalRows = rowStates
    .filter((row) => !row.active || isTerminalish(row))
    .filter((row) => isRetained(row.ts, now, terminalTtlMs))
    .sort(terminalRowSort);

  const diagnostics = Array.from(diagnosticsById.values())
    .filter((diagnostic) => isRetained(diagnostic.ts, now, terminalTtlMs))
    .sort(diagnosticSort);

  const retainedRecent = [
    ...terminalRows.map((row) => ({ kind: 'row' as const, row, ts: row.ts, order: row.lastOrder })),
    ...diagnostics.map((diagnostic) => ({ kind: 'diagnostic' as const, diagnostic, ts: diagnostic.ts, order: diagnostic.lastOrder })),
  ]
    .sort((a, b) => b.ts - a.ts || b.order - a.order)
    .slice(0, maxTerminalRows);
  const retainedTerminalKeys = new Set(retainedRecent.flatMap((item) => (item.kind === 'row' ? [item.row.canonicalKey] : [])));
  const retainedDiagnosticIds = new Set(retainedRecent.flatMap((item) => (item.kind === 'diagnostic' ? [item.diagnostic.id] : [])));

  const retainedTerminalRows = terminalRows.filter((row) => retainedTerminalKeys.has(row.canonicalKey));
  const retainedDiagnostics = diagnostics.filter((diagnostic) => retainedDiagnosticIds.has(diagnostic.id));
  const rows = [...activeRows, ...retainedTerminalRows].map(stripRowState);
  return {
    rows,
    runningCount: activeRows.reduce((total, row) => total + getRunningContribution(row), 0),
    diagnostics: retainedDiagnostics.map(stripDiagnosticState),
  };
}
