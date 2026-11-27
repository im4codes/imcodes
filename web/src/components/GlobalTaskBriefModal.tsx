import { createPortal } from 'preact/compat';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { GlobalTaskAuditSummary, GlobalTaskSummaryRow } from '@shared/global-task-mode.js';
import { parseTaskPairChecklist } from '@shared/task-pair-checklist.js';
import {
  TASK_PAIR_BRIEF_ERROR,
  type GlobalTaskAuditDetail,
  type TaskPairBriefResponse,
} from '@shared/task-pair-brief.js';
import { fetchServerTaskPairBrief } from '../api.js';
import { copyToClipboard } from '../util/clipboard.js';
import type { GlobalTaskJumpContext } from '../global-task-mode-store.js';
import { ChatMarkdown } from './ChatMarkdown.js';
import './global-task-mode-brief.css';

export type GlobalTaskBriefTab = 'checklist' | 'audit' | 'brief';

interface CachedBriefEntry {
  response: TaskPairBriefResponse;
  fetchedAt: number;
  updatedAt: number;
}

const briefResponseCache = new Map<string, CachedBriefEntry>();

export function clearGlobalTaskBriefCache(): void {
  briefResponseCache.clear();
}

function briefCacheKey(serverId: string, taskId: string): string {
  return `${serverId}\u0000${taskId}`;
}

function markdownWithoutChecklist(brief: string): string {
  let fenced = false;
  let fenceChar = '';
  let fenceLen = 0;
  return brief.split(/\r?\n/u).filter((line) => {
    if (fenceLen > 0) {
      const closeFence = line.match(/^\s*(`{3,}|~{3,})\s*$/u);
      if (closeFence && closeFence[1]![0] === fenceChar && closeFence[1]!.length >= fenceLen) {
        fenced = false;
        fenceChar = '';
        fenceLen = 0;
      }
      return true;
    }
    const openFence = line.match(/^\s*(`{3,}|~{3,})(.*)$/u);
    if (openFence) {
      const char = openFence[1]![0]!;
      if (!(char === '`' && openFence[2]!.includes('`'))) {
        fenced = true;
        fenceChar = char;
        fenceLen = openFence[1]!.length;
        return true;
      }
    }
    if (fenced) return true;
    return !/^\s*-\s+\[[ xX]\](?:\[[ xX]\])?\s+/u.test(line);
  }).join('\n').trim();
}

function formatBriefFetchError(
  errorCode: string | undefined,
  t: (key: string, defaultValue: string) => string,
): string {
  switch (errorCode) {
    case TASK_PAIR_BRIEF_ERROR.DAEMON_OFFLINE:
      return t('taskMode.brief_error_offline', 'Server daemon is offline — showing cached summary counts.');
    case TASK_PAIR_BRIEF_ERROR.TIMEOUT:
      return t('taskMode.brief_error_timeout', 'Request to server daemon timed out.');
    case TASK_PAIR_BRIEF_ERROR.NOT_FOUND:
      return t('taskMode.brief_error_not_found', 'Task brief was not found on the daemon.');
    case TASK_PAIR_BRIEF_ERROR.FORBIDDEN:
      return t('taskMode.brief_error_forbidden', 'You do not have permission to view this task brief.');
    default:
      return t('taskMode.brief_error_unavailable', 'Unable to load detailed brief from daemon.');
  }
}

export interface GlobalTaskBriefModalProps {
  task: GlobalTaskSummaryRow | null;
  initialTab: GlobalTaskBriefTab;
  statusLabel: string;
  executorDisplay: string;
  auditorDisplay: string;
  onClose: () => void;
  onJumpToSession: (serverId: string, sessionName: string, taskContext?: GlobalTaskJumpContext) => void;
}

export function GlobalTaskBriefModal({
  task,
  initialTab,
  statusLabel,
  executorDisplay,
  auditorDisplay,
  onClose,
  onJumpToSession,
}: GlobalTaskBriefModalProps) {
  const { t } = useTranslation();
  const currentKey = task ? briefCacheKey(task.serverId, task.taskId) : null;
  const [activeTab, setActiveTab] = useState<GlobalTaskBriefTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [loadedBrief, setLoadedBrief] = useState<{
    key: string;
    response: TaskPairBriefResponse;
    updatedAt: number;
  } | null>(() => {
    if (!currentKey) return null;
    const cached = briefResponseCache.get(currentKey);
    return cached?.response.ok
      ? { key: currentKey, response: cached.response, updatedAt: cached.updatedAt }
      : null;
  });
  const [errorState, setErrorState] = useState<{ key: string; code: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const activeKeyRef = useRef<string | null>(currentKey);
  const latestTaskRef = useRef<GlobalTaskSummaryRow | null>(task);
  const inFlightRef = useRef<{
    key: string;
    requestedUpdatedAt: number;
    force: boolean;
    controller: AbortController;
  } | null>(null);
  activeKeyRef.current = currentKey;
  latestTaskRef.current = task;

  const startFetch = useCallback(async (
    targetTask: GlobalTaskSummaryRow,
    forceRefresh: boolean,
    opts?: { preserveError?: boolean },
  ) => {
    const key = briefCacheKey(targetTask.serverId, targetTask.taskId);
    const cached = briefResponseCache.get(key);
    const stale = cached ? (targetTask.updatedAt > cached.updatedAt) : true;
    if (!forceRefresh && cached && cached.response.ok && !stale) {
      setLoadedBrief({ key, response: cached.response, updatedAt: cached.updatedAt });
      setLoading(false);
      return;
    }

    inFlightRef.current?.controller.abort();
    const flight = {
      key,
      requestedUpdatedAt: targetTask.updatedAt,
      force: forceRefresh,
      controller: new AbortController(),
    };
    inFlightRef.current = flight;

    setLoading(true);
    if (!opts?.preserveError) {
      setErrorState(null);
    }
    if (cached?.response.ok) {
      setLoadedBrief((prev) => (prev?.key === key
        ? prev
        : { key, response: cached.response, updatedAt: cached.updatedAt }));
    }

    let res: TaskPairBriefResponse;
    let isCurrent = false;
    try {
      res = await fetchServerTaskPairBrief(targetTask.serverId, targetTask.taskId, {
        signal: flight.controller.signal,
      });
      isCurrent = inFlightRef.current === flight && activeKeyRef.current === key;
    } finally {
      if (inFlightRef.current === flight) {
        inFlightRef.current = null;
      }
    }

    if (!isCurrent) return;

    if (res.ok) {
      const effectiveUpdatedAt = Math.max(
        flight.requestedUpdatedAt,
        typeof res.updatedAt === 'number' ? res.updatedAt : 0,
      );
      briefResponseCache.set(key, {
        response: res,
        fetchedAt: Date.now(),
        updatedAt: effectiveUpdatedAt,
      });
      setLoadedBrief({ key, response: res, updatedAt: effectiveUpdatedAt });
      setErrorState(null);

      const latestTask = latestTaskRef.current;
      if (
        latestTask
        && briefCacheKey(latestTask.serverId, latestTask.taskId) === key
        && latestTask.updatedAt > effectiveUpdatedAt
      ) {
        void startFetch(latestTask, false);
        return;
      }
      setLoading(false);
      return;
    }

    const terminalDenial = res.error === TASK_PAIR_BRIEF_ERROR.FORBIDDEN
      || res.error === TASK_PAIR_BRIEF_ERROR.NOT_FOUND;
    if (terminalDenial) {
      briefResponseCache.delete(key);
      setLoadedBrief((prev) => (prev?.key === key ? null : prev));
    }
    setErrorState({ key, code: res.error ?? TASK_PAIR_BRIEF_ERROR.REQUEST_FAILED });

    const latestTask = latestTaskRef.current;
    const cachedUpdatedAt = briefResponseCache.get(key)?.updatedAt ?? -Infinity;
    if (
      !terminalDenial
      && latestTask
      && briefCacheKey(latestTask.serverId, latestTask.taskId) === key
      && latestTask.updatedAt > Math.max(flight.requestedUpdatedAt, cachedUpdatedAt)
    ) {
      void startFetch(latestTask, false, { preserveError: true });
      return;
    }
    setLoading(false);
  }, []);

  const syncBrief = useCallback((targetTask: GlobalTaskSummaryRow) => {
    const key = briefCacheKey(targetTask.serverId, targetTask.taskId);
    if (inFlightRef.current?.key === key) return;
    void startFetch(targetTask, false);
  }, [startFetch]);

  const handleManualRefresh = useCallback((targetTask: GlobalTaskSummaryRow) => {
    const key = briefCacheKey(targetTask.serverId, targetTask.taskId);
    const inFlight = inFlightRef.current;
    if (inFlight && inFlight.key === key && inFlight.force) return;
    void startFetch(targetTask, true);
  }, [startFetch]);

  // Initialize active tab only when opening or switching tasks — never on live updatedAt refreshes.
  useEffect(() => {
    if (!task) return;
    setActiveTab(initialTab);
    setCopied(false);
  }, [Boolean(task), task?.serverId, task?.taskId, initialTab]);

  // Reset and abort in-flight work only when closing or switching to a different task.
  useEffect(() => {
    if (!task || !currentKey) {
      inFlightRef.current?.controller.abort();
      inFlightRef.current = null;
      setLoadedBrief(null);
      setErrorState(null);
      setLoading(false);
      return;
    }
    const cached = briefResponseCache.get(currentKey);
    setLoadedBrief(cached?.response.ok
      ? { key: currentKey, response: cached.response, updatedAt: cached.updatedAt }
      : null);
    setErrorState(null);
    setLoading(false);
    return () => {
      inFlightRef.current?.controller.abort();
      inFlightRef.current = null;
    };
  }, [currentKey]);

  // Trigger initial load and coalesce live updatedAt changes for the same open task.
  useEffect(() => {
    if (!task) return;
    syncBrief(task);
  }, [currentKey, task?.updatedAt, syncBrief]);

  useEffect(() => {
    if (!task) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [task, onClose]);

  const activeEntry = loadedBrief && currentKey && loadedBrief.key === currentKey ? loadedBrief : null;
  const activeBrief = activeEntry?.response ?? null;
  const activeErrorCode = errorState && currentKey && errorState.key === currentKey ? errorState.code : null;
  const briefText = typeof activeBrief?.brief === 'string' ? activeBrief.brief : '';
  const checklistItems = useMemo(
    () => (briefText ? parseTaskPairChecklist(briefText) : []),
    [briefText],
  );
  const renderedBriefMarkdown = useMemo(() => {
    if (!briefText.trim()) return '';
    const stripped = markdownWithoutChecklist(briefText);
    return stripped || briefText.trim();
  }, [briefText]);

  if (!task) return null;

  const briefIsFresh = Boolean(activeEntry && activeEntry.updatedAt >= task.updatedAt);
  const summaryChecklist = briefIsFresh && activeBrief?.ok && activeBrief.checklist
    ? activeBrief.checklist
    : task.checklist;
  const total = summaryChecklist.total;
  const implDone = Math.min(total, Math.max(0, summaryChecklist.implemented));
  const auditDone = Math.min(total, Math.max(0, summaryChecklist.audited));
  const implPct = total > 0 ? Math.round((implDone / total) * 100) : 0;
  const auditPct = total > 0 ? Math.round((auditDone / total) * 100) : 0;
  const hasBriefOk = Boolean(activeBrief?.ok);
  const detailAudit: GlobalTaskAuditDetail | undefined = activeBrief?.ok ? activeBrief.lastAudit : undefined;
  const cachedAudit: GlobalTaskAuditSummary | undefined = task.lastAudit;
  const effectiveAudit = detailAudit ?? cachedAudit;
  const auditTabBadge = effectiveAudit
    ? (effectiveAudit.blockingCount > 0 ? effectiveAudit.blockingCount : effectiveAudit.findingsCount)
    : 0;
  const fetchError = activeErrorCode
    ? formatBriefFetchError(activeErrorCode, (key, defaultValue) => t(key, { defaultValue }))
    : null;

  const renderAuditTabContent = () => {
    if (!effectiveAudit) {
      if (loading) {
        return (
          <div class="global-task-brief-hud-loading" data-testid="global-task-brief-loading">
            <span class="global-task-brief-hud-spinner" aria-hidden="true" />
            <span>{t('taskMode.brief_loading', 'Syncing brief & checklist from daemon…')}</span>
          </div>
        );
      }
      if (fetchError) return null;
      return (
        <div class="global-task-brief-hud-empty" data-testid="global-task-audit-empty">
          {t('taskMode.audit_empty', 'No audit feedback recorded for this task yet.')}
        </div>
      );
    }

    const isRework = effectiveAudit.verb === 'REWORK';
    const blockingSet = new Set(effectiveAudit.blocking.map((b) => b.toUpperCase()));
    const blockingItems = (['P0', 'P1', 'P2', 'P3', 'P4'] as const)
      .filter((lvl) => blockingSet.has(lvl))
      .map((lvl) => ({ lvl, count: effectiveAudit.counts[lvl.toLowerCase() as keyof typeof effectiveAudit.counts] ?? 0 }))
      .filter((entry) => entry.count > 0);
    const blockingText = blockingItems.length > 0
      ? blockingItems.map((entry) => `${entry.lvl} ×${entry.count}`).join(' · ')
      : (effectiveAudit.blockingCount > 0 ? `${effectiveAudit.blocking[0] ?? 'P0'} ×${effectiveAudit.blockingCount}` : '');
    const verdictLabel = isRework
      ? (effectiveAudit.round > 0
        ? t('taskMode.audit_verdict_rework_round', { round: effectiveAudit.round, defaultValue: `Rework · R${effectiveAudit.round}` })
        : t('taskMode.audit_verdict_rework', 'Rework'))
      : (effectiveAudit.round > 0
        ? t('taskMode.audit_verdict_pass_round', { round: effectiveAudit.round, defaultValue: `Passed · R${effectiveAudit.round}` })
        : t('taskMode.audit_verdict_pass', 'Passed'));

    return (
      <div class="global-task-audit-detail" data-testid="global-task-audit-detail">
        <div class={`global-task-audit-summary-panel ${isRework ? 'is-rework' : 'is-pass'}`}>
          <div class="global-task-audit-summary-badges">
            <span class={`global-task-audit-verdict-badge ${isRework ? 'is-rework' : 'is-pass'}`}>
              {verdictLabel}
            </span>
            {blockingText && (
              <span class="global-task-audit-blocking-badge" data-testid="global-task-audit-modal-blocking">
                {t('taskMode.audit_blocking_pending', { items: blockingText, defaultValue: `${blockingText} pending` })}
              </span>
            )}
            {(['P0', 'P1', 'P2', 'P3', 'P4'] as const).map((lvl) => {
              const count = effectiveAudit.counts[lvl.toLowerCase() as keyof typeof effectiveAudit.counts] ?? 0;
              if (count === 0 && lvl !== 'P0') return null;
              return (
                <span key={lvl} class={`global-task-audit-sev-pill is-${lvl.toLowerCase()}`}>
                  {lvl}: {count}
                </span>
              );
            })}
          </div>

          {effectiveAudit.summary && (
            <div class="global-task-audit-meta-note" data-testid="global-task-audit-summary-text">
              <span class="global-task-audit-meta-label">{t('taskMode.audit_label_summary', 'Summary')}:</span>
              <span>{effectiveAudit.summary}</span>
            </div>
          )}
          {detailAudit?.reason && detailAudit.reason !== effectiveAudit.summary && (
            <div class="global-task-audit-meta-note">
              <span class="global-task-audit-meta-label">{t('taskMode.audit_label_reason', 'Reason')}:</span>
              <span>{detailAudit.reason}</span>
            </div>
          )}
          {detailAudit?.nextStep && (
            <div class="global-task-audit-meta-note">
              <span class="global-task-audit-meta-label">{t('taskMode.audit_label_next_step', 'Next step')}:</span>
              <span>{detailAudit.nextStep}</span>
            </div>
          )}
        </div>

        {detailAudit ? (
          detailAudit.findings.length > 0 ? (
            <div class="global-task-audit-findings-list" data-testid="global-task-audit-findings-list">
              {detailAudit.findings.map((finding) => {
                const sevClass = finding.severity ? ` is-${finding.severity.toLowerCase()}` : '';
                return (
                  <div
                    key={finding.index}
                    class={`global-task-audit-finding-card${finding.blocking ? ' is-blocking' : ''}`}
                    data-testid={`global-task-audit-finding-${finding.index}`}
                  >
                    <div class="global-task-audit-finding-head">
                      <span class="global-task-audit-finding-index">{finding.index}</span>
                      {finding.severity && (
                        <span class={`global-task-audit-sev-pill${sevClass}`}>[{finding.severity}]</span>
                      )}
                      {finding.blocking && (
                        <span class="global-task-audit-blocking-tag">
                          {t('taskMode.audit_blocking_tag', 'Blocking')}
                        </span>
                      )}
                      {finding.location && (
                        <code class="global-task-audit-finding-location">{finding.location}</code>
                      )}
                    </div>
                    {finding.summary && (
                      <div class="global-task-audit-finding-desc">{finding.summary}</div>
                    )}
                    {finding.invariant && (
                      <div class="global-task-audit-finding-sub">
                        <span class="global-task-audit-meta-label">{t('taskMode.audit_label_invariant', 'Invariant')}:</span>
                        <span>{finding.invariant}</span>
                      </div>
                    )}
                    {finding.evidence && (
                      <div class="global-task-audit-finding-sub">
                        <span class="global-task-audit-meta-label">{t('taskMode.audit_label_evidence', 'Evidence')}:</span>
                        <span>{finding.evidence}</span>
                      </div>
                    )}
                    {finding.proposal && (
                      <div class="global-task-audit-finding-proposal">
                        <span class="global-task-audit-meta-label">{t('taskMode.audit_label_proposal', 'Fix proposal')}:</span>
                        <span>{finding.proposal}</span>
                      </div>
                    )}
                    {finding.tradeoffs && (
                      <div class="global-task-audit-finding-sub">
                        <span class="global-task-audit-meta-label">{t('taskMode.audit_label_tradeoffs', 'Trade-offs')}:</span>
                        <span>{finding.tradeoffs}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : detailAudit.noticeText ? (
            <div class="global-task-audit-raw-notice" data-testid="global-task-audit-raw-notice">
              <div class="global-task-audit-meta-label">{t('taskMode.audit_label_raw_notice', 'Full audit reply')}</div>
              <div>{detailAudit.noticeText}</div>
            </div>
          ) : (
            <div class="global-task-brief-hud-empty" data-testid="global-task-audit-empty-findings">
              {t('taskMode.audit_empty', 'No audit feedback recorded for this task yet.')}
            </div>
          )
        ) : loading ? (
          <div class="global-task-brief-hud-loading" data-testid="global-task-brief-loading">
            <span class="global-task-brief-hud-spinner" aria-hidden="true" />
            <span>{t('taskMode.brief_loading', 'Syncing brief & checklist from daemon…')}</span>
          </div>
        ) : (
          <div class="global-task-brief-hud-empty" data-testid="global-task-audit-cached-only">
            {t('taskMode.audit_cached_only_notice', 'Showing cached summary from card (detailed findings unavailable).')}
          </div>
        )}
      </div>
    );
  };

  const handleCopy = () => {
    if (!briefText.trim()) return;
    copyToClipboard(briefText, () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  const modal = (
    <div
      class="global-task-brief-hud-backdrop"
      data-testid="global-task-brief-hud-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        class="global-task-brief-hud"
        data-testid="global-task-brief-hud"
        role="dialog"
        aria-modal="true"
        aria-labelledby="global-task-brief-hud-title"
        onClick={(e) => e.stopPropagation()}
      >
        <span class="global-task-brief-hud-corner is-tl" aria-hidden="true" />
        <span class="global-task-brief-hud-corner is-tr" aria-hidden="true" />
        <span class="global-task-brief-hud-corner is-bl" aria-hidden="true" />
        <span class="global-task-brief-hud-corner is-br" aria-hidden="true" />

        <header class="global-task-brief-hud-header">
          <div class="global-task-brief-hud-top-row">
            <div class="global-task-brief-hud-telemetry">
              <span class="global-task-brief-hud-kicker">{t('taskMode.brief_hud_badge', 'PAIR TELEMETRY')}</span>
              <span class="global-task-brief-hud-chip">
                <span class={`global-task-brief-hud-dot${task.serverOnline ? ' is-online' : ''}`} aria-hidden="true" />
                {task.serverName}
              </span>
              {task.projectName && <span class="global-task-brief-hud-chip">{task.projectName}</span>}
              <span class="global-task-brief-hud-chip">{statusLabel}</span>
              {task.round > 0 && <span class="global-task-brief-hud-chip">R{task.round}</span>}
            </div>
            <button
              type="button"
              class="global-task-brief-hud-close"
              data-testid="global-task-brief-hud-close"
              aria-label={t('common.close', 'Close')}
              title={t('common.close', 'Close')}
              onClick={onClose}
            >
              ×
            </button>
          </div>

          <h2 id="global-task-brief-hud-title" class="global-task-brief-hud-title">
            {task.title}
          </h2>

          <div class="global-task-brief-hud-participants">
            <span>{t('taskPair.card_executor', 'Executor')}: {executorDisplay}</span>
            <span>{t('taskPair.card_auditor', 'Auditor')}: {auditorDisplay}</span>
            {task.executorModel && <span>{task.executorModel}{task.auditorModel ? ` / ${task.auditorModel}` : ''}</span>}
          </div>

          <div class="global-task-brief-hud-progress-panel" data-testid="global-task-brief-hud-progress">
            <div class="global-task-brief-hud-progress-stats">
              <div class="global-task-brief-hud-stat-group">
                <span class="global-task-brief-hud-impl-text">
                  {t('taskMode.progress_impl', { done: implDone, total })}
                </span>
                <span class="global-task-brief-hud-audit-text">
                  {t('taskMode.progress_audit', { done: auditDone, total })}
                </span>
              </div>
              <span class="global-task-brief-hud-pct">
                {total > 0 ? `${implPct}% / ${auditPct}%` : '—'}
              </span>
            </div>
            <div class="global-task-brief-hud-track" aria-hidden="true">
              <div class="global-task-brief-hud-impl-bar" style={{ width: `${implPct}%` }} />
              <div class="global-task-brief-hud-audit-bar" style={{ width: `${auditPct}%` }} />
            </div>
          </div>
        </header>

        <div class="global-task-brief-hud-tabs-row">
          <div class="global-task-brief-hud-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'checklist'}
              class={`global-task-brief-hud-tab${activeTab === 'checklist' ? ' is-active' : ''}`}
              data-testid="global-task-brief-tab-checklist"
              onClick={() => setActiveTab('checklist')}
            >
              {t('taskMode.brief_tab_checklist', 'Checklist')} ({total})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'audit'}
              class={`global-task-brief-hud-tab${activeTab === 'audit' ? ' is-active' : ''}`}
              data-testid="global-task-brief-tab-audit"
              onClick={() => setActiveTab('audit')}
            >
              {t('taskMode.brief_tab_audit', 'Audit Feedback')}
              {auditTabBadge > 0 && (
                <span class="global-task-audit-tab-count">{auditTabBadge}</span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'brief'}
              class={`global-task-brief-hud-tab${activeTab === 'brief' ? ' is-active' : ''}`}
              data-testid="global-task-brief-tab-brief"
              onClick={() => setActiveTab('brief')}
            >
              {t('taskMode.brief_tab_brief', 'Brief')}
            </button>
          </div>

          <div class="global-task-brief-hud-tools">
            <button
              type="button"
              class="global-task-brief-hud-tool-btn"
              data-testid="global-task-brief-copy-btn"
              disabled={!briefText.trim()}
              onClick={() => void handleCopy()}
            >
              {t(copied ? 'taskPair.brief_copied' : 'taskPair.brief_copy', copied ? 'Copied' : 'Copy brief')}
            </button>
            <button
              type="button"
              class="global-task-brief-hud-tool-btn"
              data-testid="global-task-brief-refresh-btn"
              onClick={() => handleManualRefresh(task)}
            >
              {t('taskMode.brief_refresh', 'Refresh')}
            </button>
          </div>
        </div>

        <div class="global-task-brief-hud-body" data-testid="global-task-brief-hud-body">
          {fetchError && (
            <div class="global-task-brief-hud-banner" data-testid="global-task-brief-error">
              <span>{fetchError}</span>
              <button
                type="button"
                class="global-task-brief-hud-retry-btn"
                data-testid="global-task-brief-retry-btn"
                onClick={() => handleManualRefresh(task)}
              >
                {t('taskMode.brief_retry', 'Retry')}
              </button>
            </div>
          )}

          {activeTab === 'audit' ? (
            renderAuditTabContent()
          ) : loading && !hasBriefOk ? (
            <div class="global-task-brief-hud-loading" data-testid="global-task-brief-loading">
              <span class="global-task-brief-hud-spinner" aria-hidden="true" />
              <span>{t('taskMode.brief_loading', 'Syncing brief & checklist from daemon…')}</span>
            </div>
          ) : activeTab === 'checklist' ? (
            hasBriefOk ? (
              checklistItems.length > 0 ? (
                <div class="global-task-brief-hud-checklist" data-testid="global-task-brief-checklist-items">
                  {checklistItems.map((item) => {
                    const isComplete = item.implemented && (!item.hasAuditBox || item.audited);
                    const rowClass = isComplete
                      ? 'is-complete'
                      : (item.implemented ? 'is-implemented' : '');
                    return (
                      <div
                        key={item.index}
                        class={`global-task-brief-hud-item ${rowClass}`}
                        data-testid={`global-task-brief-item-${item.index}`}
                      >
                        <div class="global-task-brief-hud-item-main">
                          <span class="global-task-brief-hud-item-idx">
                            {String(item.index).padStart(2, '0')}
                          </span>
                          <span class="global-task-brief-hud-item-text">{item.text}</span>
                        </div>
                        <div class="global-task-brief-hud-item-badges">
                          <span
                            class={`global-task-brief-hud-pill${item.implemented ? ' is-impl-done' : ''}`}
                            data-testid={`global-task-brief-item-${item.index}-impl`}
                          >
                            {item.implemented ? '✓' : '○'} {t('taskPair.implemented', 'Implemented')}
                          </span>
                          <span
                            class={`global-task-brief-hud-pill${item.hasAuditBox && item.audited ? ' is-audit-done' : ''}`}
                            data-testid={`global-task-brief-item-${item.index}-audit`}
                          >
                            {!item.hasAuditBox ? '—' : (item.audited ? '✓' : '○')} {t('taskPair.audited', 'Audited')}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div class="global-task-brief-hud-empty" data-testid="global-task-brief-checklist-empty">
                  {t('taskPair.checklist_empty', 'No numbered checklist items')}
                </div>
              )
            ) : null
          ) : hasBriefOk ? (
            renderedBriefMarkdown ? (
              <div class="global-task-brief-hud-markdown" data-testid="global-task-brief-markdown">
                <ChatMarkdown
                  text={renderedBriefMarkdown}
                  cacheKey={`global-task-brief:${task.serverId}:${task.taskId}:${activeBrief?.briefRevision ?? ''}`}
                />
              </div>
            ) : (
              <div class="global-task-brief-hud-empty" data-testid="global-task-brief-empty">
                {t('taskMode.brief_empty', 'No brief content recorded for this task yet.')}
              </div>
            )
          ) : null}
        </div>

        <footer class="global-task-brief-hud-footer">
          <button
            type="button"
            class="global-task-brief-hud-btn-secondary"
            data-testid="global-task-brief-footer-close"
            onClick={onClose}
          >
            {t('common.close', 'Close')}
          </button>
          <button
            type="button"
            class="global-task-brief-hud-btn-primary"
            data-testid="global-task-brief-open-session"
            onClick={() => {
              onClose();
              onJumpToSession(task.serverId, task.brainSession, {
                taskId: task.taskId,
                title: task.title,
                status: task.status,
              });
            }}
          >
            {t('taskMode.enter_session', 'Open session')}
          </button>
        </footer>
      </section>
    </div>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(modal, document.body);
  }
  return modal;
}
