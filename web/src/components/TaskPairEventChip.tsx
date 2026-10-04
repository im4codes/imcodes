import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { AUDIT_SEVERITY_LEVELS } from '@shared/audit-convergence.js';
import {
  TASK_PAIR_STATUSES,
  TASK_PAIR_VERBS,
  TASK_PAIR_WORKSPACE_EFFECTS,
  TASK_PAIR_WORKSPACE_EVENT_VERB,
  type TaskPairEventPayload,
  type TaskPairStatus,
} from '@shared/task-pair.js';
import { normalizeTaskPairAuditDetails, parseTaskPairAuditDetails } from '@shared/task-pair-notification.js';

type SessionModelEntry = { name: string; activeModel?: string | null; requestedModel?: string | null; effort?: string | null };

const HOVER_PREVIEW_OPEN_DELAY_MS = 180;
const HOVER_PREVIEW_CLOSE_DELAY_MS = 140;
let hoverPreviewSequence = 0;

function isStatus(value: unknown): value is TaskPairStatus {
  return typeof value === 'string' && (TASK_PAIR_STATUSES as readonly string[]).includes(value);
}

function verbKey(verb: unknown): string {
  return typeof verb === 'string' && (TASK_PAIR_VERBS as readonly string[]).includes(verb) ? verb.toLowerCase() : 'other';
}

function safeDetailText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/((?:api[_ -]?key|token|password|secret)\s*[:=]\s*)\S+/gi, '$1•••')
    .replace(/(?:\/Users\/|\/home\/|C:\\\\Users\\\\)[^\s/\\]+/gu, '<user-home>');
}

/** Text of a daemon workspace event: where a kept deliverable went, or what happened to the workspace. */
function workspaceText(t: (key: string, options?: Record<string, unknown>) => string, event: Partial<TaskPairEventPayload>): string {
  switch (event.effect) {
    case TASK_PAIR_WORKSPACE_EFFECTS.OUTPUT_SAVED:
      return t('taskPair.output_saved', { path: event.outputPath ?? '' });
    case TASK_PAIR_WORKSPACE_EFFECTS.OUTPUT_FAILED:
      return t('taskPair.output_failed', { reason: event.outputError ?? '' });
    case TASK_PAIR_WORKSPACE_EFFECTS.KEPT:
      return t('taskPair.workspace_kept');
    default:
      return t('taskPair.workspace_removed');
  }
}

/** Compact chat chip for one task-pair marker event (it replaces the hidden marker line). */
export function TaskPairEventChip({ eventId, payload, timestamp, sessions }: { eventId: string; payload: Record<string, unknown>; timestamp?: number; sessions?: readonly SessionModelEntry[] }) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [hoverPreviewAnchor, setHoverPreviewAnchor] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const hoverOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverPreviewIdRef = useRef<string | null>(null);
  if (hoverPreviewIdRef.current === null) hoverPreviewIdRef.current = `task-pair-hover-preview-${++hoverPreviewSequence}`;
  const hoverPreviewId = hoverPreviewIdRef.current;
  const event = payload as Partial<TaskPairEventPayload>;
  const taskId = typeof event.taskId === 'string' ? event.taskId : '—';
  const writer = typeof event.writer === 'string' ? event.writer : '';
  const isCancelledEvent = event.toStatus === 'cancelled';
  const cancelActor = typeof event.cancelActor === 'string' && event.cancelActor.trim()
    ? event.cancelActor.trim()
    : event.cancelProvenanceTrusted ? writer : '';
  const cancelSource = typeof event.cancelSource === 'string' && event.cancelSource.trim()
    ? event.cancelSource.trim()
    : event.cancelProvenanceTrusted && typeof event.source === 'string' ? event.source : '';
  const cancelReason = typeof event.cancelReason === 'string' && event.cancelReason.trim()
    ? event.cancelReason.trim()
    : t('taskPair.card_cancel_reason_unknown');
  const verb = t(`taskPair.verb.${verbKey(event.verb)}`);
  const status = isStatus(event.toStatus) ? t(`taskPair.status.${event.toStatus}`) : t('taskPair.card_unknown_status');
  const counts = event.severityCounts
    ? AUDIT_SEVERITY_LEVELS
      .filter((level) => (event.severityCounts?.[level] ?? 0) > 0)
      .map((level) => t('taskPair.severity', { level, count: event.severityCounts?.[level] }))
      .join(' · ')
    : '';
  const held = event.verdictJudgement === 'inconsistent' || event.verdictJudgement === 'missing_severity';
  const verdict = typeof event.verdictJudgement === 'string' ? event.verdictJudgement : '';
  const payloadForDetails = typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? { ...payload, _eventTimestamp: new Date(timestamp).toISOString() }
    : payload;
  const payloadJson = JSON.stringify(payloadForDetails, null, 2) ?? '{}';
  const eventTime = typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(i18n?.language || undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp))
    : '';
  const noticeText = typeof (event as Record<string, unknown>).noticeText === 'string'
    ? (event as Record<string, unknown>).noticeText as string
    : '';
  const auditDetails = normalizeTaskPairAuditDetails(event) ?? parseTaskPairAuditDetails(noticeText);
  const findings = auditDetails?.findings ?? [];
  const hasAuditDetails = Boolean(auditDetails && Object.values(auditDetails).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value)));
  const noBlockingFindings = (event.toStatus === 'passed' || event.toStatus === 'done')
    && findings.length === 0
    && (event.severityCounts ? (event.severityCounts.P0 ?? 0) === 0 && (event.severityCounts.P1 ?? 0) === 0 : true);
  const previewNoticeText = noticeText
    .replace(/((?:api[_ -]?key|token|password|secret)\s*[:=]\s*)\S+/gi, '$1•••')
    .slice(0, 320);
  // One colour per status (styles.css `.task-pair-chip--<status>`).
  const statusClass = isStatus(event.toStatus) ? ` task-pair-chip--${event.toStatus}` : '';
  const statusBadgeClass = isStatus(event.toStatus) ? event.toStatus : 'unknown';
  const title = typeof event.title === 'string' && event.title.trim() ? event.title.trim() : t('taskPair.card_untitled');
  const clearHoverTimers = () => {
    if (hoverOpenTimerRef.current) clearTimeout(hoverOpenTimerRef.current);
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
    hoverOpenTimerRef.current = null;
    hoverCloseTimerRef.current = null;
  };
  const closeHoverPreview = () => {
    clearHoverTimers();
    setHoverPreviewAnchor(null);
  };
  const supportsDesktopHover = () => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const scheduleHoverPreview = (pointerType?: string) => {
    // Pointer hover is deliberately restricted to a fine hover-capable device;
    // focus still calls this without a pointer type for keyboard accessibility.
    if (pointerType && pointerType !== 'mouse' && pointerType !== 'pen') return;
    if (pointerType && !supportsDesktopHover()) return;
    if (!cardRef.current || expanded) return;
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = null;
    if (hoverPreviewAnchor) return;
    if (hoverOpenTimerRef.current) clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = setTimeout(() => {
      hoverOpenTimerRef.current = null;
      if (!cardRef.current || expanded) return;
      setHoverPreviewAnchor(cardRef.current.getBoundingClientRect());
    }, HOVER_PREVIEW_OPEN_DELAY_MS);
  };
  const scheduleHoverPreviewClose = () => {
    if (hoverOpenTimerRef.current) clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = null;
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = setTimeout(() => {
      hoverCloseTimerRef.current = null;
      setHoverPreviewAnchor(null);
    }, HOVER_PREVIEW_CLOSE_DELAY_MS);
  };
  const showHoverPreviewForFocus = () => {
    if (!cardRef.current || expanded) return;
    clearHoverTimers();
    setHoverPreviewAnchor(cardRef.current.getBoundingClientRect());
  };
  useEffect(() => () => clearHoverTimers(), []);
  useEffect(() => {
    if (!hoverPreviewAnchor) return;
    const syncAnchor = () => {
      if (cardRef.current) setHoverPreviewAnchor(cardRef.current.getBoundingClientRect());
    };
    window.addEventListener('scroll', syncAnchor, true);
    window.addEventListener('resize', syncAnchor);
    return () => {
      window.removeEventListener('scroll', syncAnchor, true);
      window.removeEventListener('resize', syncAnchor);
    };
  }, [Boolean(hoverPreviewAnchor)]);
  const sessionLabel = (id: unknown, label: unknown) => {
    if (typeof id !== 'string' || !id) return null;
    const text = typeof label === 'string' && label ? `${label} (${id})` : id;
    return <button type="button" class="task-pair-chip-session" onClick={(click) => {
      click.stopPropagation();
      window.dispatchEvent(new CustomEvent('deck:navigate', { detail: { session: id } }));
    }}>{text}</button>;
  };
  const resolveModel = (id: unknown, payloadModel: unknown): string | undefined => {
    if (typeof payloadModel === 'string' && payloadModel.trim()) return payloadModel.trim();
    if (typeof id !== 'string' || !id) return undefined;
    const session = sessions?.find((entry) => entry.name === id);
    return session?.activeModel?.trim() || session?.requestedModel?.trim() || undefined;
  };
  const resolveThinking = (id: unknown, payloadThinking: unknown): string | undefined => {
    if (typeof payloadThinking === 'string' && payloadThinking.trim()) return payloadThinking.trim();
    if (typeof id !== 'string' || !id) return undefined;
    const session = sessions?.find((entry) => entry.name === id);
    return session?.effort?.trim() || undefined;
  };
  const roleLabel = (id: unknown, label: unknown, modelValue: unknown, thinkingValue: unknown, role: 'executor' | 'auditor') => {
    const session = sessionLabel(id, label);
    const model = resolveModel(id, modelValue);
    const thinking = resolveThinking(id, thinkingValue);
    return <span class="task-pair-card-role"><span class="task-pair-card-role-label">{t(`taskPair.card_${role}`)}</span>{session ?? <span class="task-pair-card-unassigned">{t('taskPair.card_unassigned')}</span>}{session && <span class="task-pair-card-role-model">{t('taskPair.card_model', { value: model ?? t('taskPair.card_model_unknown') })}</span>}{session && <span class="task-pair-card-role-thinking">{t('taskPair.card_thinking', { value: thinking ?? t('taskPair.card_thinking_unknown') })}</span>}</span>;
  };
  const previewRole = (id: unknown, label: unknown, modelValue: unknown, thinkingValue: unknown, role: 'executor' | 'auditor') => {
    const sessionId = typeof id === 'string' && id.trim() ? id.trim() : '';
    const sessionName = typeof label === 'string' && label.trim() ? label.trim() : sessionId;
    if (!sessionName) return null;
    const model = resolveModel(id, modelValue) ?? t('taskPair.card_model_unknown');
    const thinking = resolveThinking(id, thinkingValue) ?? t('taskPair.card_thinking_unknown');
    return <div class="task-pair-card-hover-role">
      <span class="task-pair-card-hover-role-name">{t(`taskPair.card_${role}`)}: {sessionName}</span>
      <span class="task-pair-card-hover-role-meta">{t('taskPair.card_model', { value: model })} · {t('taskPair.card_thinking', { value: thinking })}</span>
    </div>;
  };
  const renderHoverPreview = () => {
    if (!hoverPreviewAnchor || typeof document === 'undefined' || expanded) return null;
    const margin = 10;
    const width = Math.min(440, Math.max(180, window.innerWidth - margin * 2));
    const spaceAbove = hoverPreviewAnchor.top;
    const placeBelow = spaceAbove < 250 && window.innerHeight - hoverPreviewAnchor.bottom > spaceAbove;
    const maxHeight = Math.max(150, (placeBelow ? window.innerHeight - hoverPreviewAnchor.bottom : hoverPreviewAnchor.top) - margin * 2);
    const left = Math.min(Math.max(margin, hoverPreviewAnchor.left), Math.max(margin, window.innerWidth - width - margin));
    const position = placeBelow
      ? { top: `${hoverPreviewAnchor.bottom + margin}px` }
      : { bottom: `${window.innerHeight - hoverPreviewAnchor.top + margin}px` };
    return createPortal(<div
      id={hoverPreviewId}
      class="task-pair-card-hover-preview"
      role="tooltip"
      style={{ left: `${left}px`, width: `${width}px`, maxHeight: `${maxHeight}px`, ...position }}
      onPointerEnter={() => { if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current); hoverCloseTimerRef.current = null; }}
      onPointerLeave={scheduleHoverPreviewClose}
    >
      <div class="task-pair-card-hover-preview-head">
        <strong>{title}</strong>
        <span class={`task-pair-chip-status status-${statusBadgeClass}`}>{status}</span>
        {eventTime && <time dateTime={new Date(timestamp!).toISOString()}>{eventTime}</time>}
      </div>
      <div class="task-pair-card-hover-preview-body">
        <span class="task-pair-card-hover-preview-event">{verb}</span>
        {previewRole(event.executor, event.executorLabel, event.executorModel, event.executorThinking, 'executor')}
        {previewRole(event.auditor, event.auditorLabel, event.auditorModel, event.auditorThinking, 'auditor')}
        {previewNoticeText && <p>{previewNoticeText}{noticeText.length > 320 ? '…' : ''}</p>}
        {isCancelledEvent && <p>{t('taskPair.card_cancel_reason', { value: cancelReason })}</p>}
      </div>
    </div>, document.body);
  };
  const renderAuditDetails = () => <section class="task-pair-card-audit-details" aria-label={t('taskPair.card_audit_details')}>
    <h4>{t('taskPair.card_audit_details')}</h4>
    {findings.length > 0 ? findings.map((finding, index) => <article class="task-pair-card-finding" key={`${index}-${finding.severity ?? ''}`}>
      <div class="task-pair-card-finding-head">
        <strong>{t('taskPair.card_finding', { index: index + 1 })}</strong>
        {finding.severity && <span class="task-pair-card-finding-severity">{safeDetailText(finding.severity)}</span>}
      </div>
      {finding.summary && <p class="task-pair-card-finding-summary">{safeDetailText(finding.summary)}</p>}
      {finding.invariant && <p><b>{t('taskPair.card_invariant')}:</b> {safeDetailText(finding.invariant)}</p>}
      {finding.location && <p><b>{t('taskPair.card_location')}:</b> {safeDetailText(finding.location)}</p>}
      {finding.evidence && <p><b>{t('taskPair.card_evidence')}:</b> {safeDetailText(finding.evidence)}</p>}
      {finding.proposal && <p><b>{t('taskPair.card_proposal')}:</b> {safeDetailText(finding.proposal)}</p>}
      {finding.tradeoffs && <p><b>{t('taskPair.card_tradeoffs')}:</b> {safeDetailText(finding.tradeoffs)}</p>}
    </article>) : null}
    {auditDetails?.summary && <p class="task-pair-card-detail-line"><b>{t('taskPair.card_summary')}:</b> {safeDetailText(auditDetails.summary)}</p>}
    {auditDetails?.validation && <p class="task-pair-card-detail-line"><b>{t('taskPair.card_validation')}:</b> {safeDetailText(auditDetails.validation)}</p>}
    {auditDetails?.reason && <p class="task-pair-card-detail-line"><b>{t('taskPair.card_reason')}:</b> {safeDetailText(auditDetails.reason)}</p>}
    {auditDetails?.nextStep && <p class="task-pair-card-detail-line"><b>{t('taskPair.card_next_step')}:</b> {safeDetailText(auditDetails.nextStep)}</p>}
    {noBlockingFindings && <p class="task-pair-card-detail-line">{t('taskPair.card_no_blocking')}</p>}
    {!hasAuditDetails && !noBlockingFindings && <p class="task-pair-card-details-unavailable">{t('taskPair.card_details_unavailable')}</p>}
  </section>;
  return (
    <section
      ref={cardRef}
      class={`chat-event chat-system task-pair-chip task-pair-event-card${expanded ? ' is-expanded' : ''}${statusClass}${event.unusual ? ' task-pair-chip--unusual' : ''}${held ? ' task-pair-chip--held' : ''}`}
      data-task-status={isStatus(event.toStatus) ? event.toStatus : undefined}
      data-event-id={eventId}
      data-task-id={taskId}
      onPointerEnter={(pointer) => scheduleHoverPreview(pointer.pointerType)}
      onPointerLeave={scheduleHoverPreviewClose}
    >
      <header class="task-pair-card-head">
        <button
          type="button"
          class="task-pair-card-toggle"
          aria-label={expanded ? t('taskPair.card_collapse') : t('taskPair.card_expand')}
          title={expanded ? t('taskPair.card_collapse') : t('taskPair.card_expand')}
          aria-expanded={expanded}
          aria-describedby={hoverPreviewAnchor ? hoverPreviewId : undefined}
          onFocus={showHoverPreviewForFocus}
          onFocusIn={showHoverPreviewForFocus}
          onBlur={scheduleHoverPreviewClose}
          onFocusOut={scheduleHoverPreviewClose}
          onClick={() => { closeHoverPreview(); setExpanded((value) => !value); }}
        >
          <span class="task-pair-card-heading">
            <span class="task-pair-card-kicker">{t('taskPair.card_kicker')}</span>
          </span>
          <span class="task-pair-card-meta">
            <span class={`task-pair-chip-status status-${statusBadgeClass}`}>{status}</span>
            {eventTime && <time class="task-pair-card-time" dateTime={new Date(timestamp!).toISOString()}>{eventTime}</time>}
            <span class={`task-pair-card-chevron${expanded ? ' is-expanded' : ''}`} aria-hidden="true">⌄</span>
          </span>
          <span class="task-pair-chip-task">
            <strong>{title}</strong>
          </span>
        </button>
      </header>
      {expanded && <>
        <div class="task-pair-card-body">
          <span class="task-pair-chip-text">
            {event.verb === TASK_PAIR_WORKSPACE_EVENT_VERB
              ? workspaceText(t, event)
              : t('taskPair.chip', { writer: writer === 'daemon' ? t('taskPair.daemon') : writer, verb })}
          </span>
          {renderAuditDetails()}
          {noticeText && <pre class="task-pair-card-notice">{noticeText}</pre>}
          <span class="task-pair-card-event-meta"><span>{t('taskPair.card_event')}</span>{verb}</span>
          {roleLabel(event.executor, event.executorLabel, event.executorModel, event.executorThinking, 'executor')}
          {roleLabel(event.auditor, event.auditorLabel, event.auditorModel, event.auditorThinking, 'auditor')}
          {isCancelledEvent && <div class="task-pair-card-cancel-meta" data-cancel-provenance="true">
            <span>{t('taskPair.card_cancel_actor', { value: cancelActor || t('taskPair.card_cancel_unknown') })}</span>
            <span>{t('taskPair.card_cancel_source', { value: cancelSource ? t(`taskPair.cancel_source.${cancelSource}`, { defaultValue: cancelSource }) : t('taskPair.card_cancel_unknown') })}</span>
            <span>{t('taskPair.card_cancel_reason', { value: cancelReason })}</span>
          </div>}
        </div>
        {(counts || verdict || held || event.unusual) && <footer class="task-pair-card-flags">
          {counts && <span class="task-pair-chip-counts">{counts}</span>}
          {verdict && <span class="task-pair-chip-verdict">{t('taskPair.card_verdict', { value: verdict })}</span>}
          {held && <span class="task-pair-chip-held">{t('taskPair.verdict_held')}</span>}
          {event.unusual && <span class="task-pair-chip-unusual">{t('taskPair.unusual')}</span>}
        </footer>}
        <details class="task-pair-card-payload">
          <summary class="task-pair-card-payload-label">{t('taskPair.card_payload')}</summary>
          <pre>{payloadJson}</pre>
        </details>
      </>}
      {renderHoverPreview()}
    </section>
  );
}
