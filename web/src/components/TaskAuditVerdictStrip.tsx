import { useTranslation } from 'react-i18next';
import type { GlobalTaskAuditSummary } from '@shared/global-task-mode.js';

export interface TaskAuditVerdictStripProps {
  audit: GlobalTaskAuditSummary;
  taskId: string;
  testIdPrefix?: string;
  interactive?: boolean;
  onOpenDetails?: () => void;
  className?: string;
}

const AUDIT_SEVERITY_LEVELS = ['P0', 'P1', 'P2', 'P3', 'P4'] as const;

/**
 * Shared clickable (or read-only when offline/unscoped) audit verdict strip
 * showing the round verdict, blocking pending counts, non-blocking severity
 * chips, details CTA, and one-line summary.
 */
export function TaskAuditVerdictStrip({
  audit,
  taskId,
  testIdPrefix = 'task-mode',
  interactive = true,
  onOpenDetails,
  className,
}: TaskAuditVerdictStripProps) {
  const { t } = useTranslation();
  const isRework = audit.verb === 'REWORK';
  const blockingSet = new Set(audit.blocking.map((b) => b.toUpperCase()));
  const blockingItems = AUDIT_SEVERITY_LEVELS
    .filter((lvl) => blockingSet.has(lvl))
    .map((lvl) => ({ lvl, count: audit.counts[lvl.toLowerCase() as keyof typeof audit.counts] ?? 0 }))
    .filter((entry) => entry.count > 0);
  const blockingText = blockingItems.length > 0
    ? blockingItems.map((entry) => `${entry.lvl} ×${entry.count}`).join(' · ')
    : (audit.blockingCount > 0 ? `${audit.blocking[0] ?? 'P0'} ×${audit.blockingCount}` : '');
  const otherChips = AUDIT_SEVERITY_LEVELS
    .filter((lvl) => !blockingSet.has(lvl))
    .map((lvl) => ({ lvl, count: audit.counts[lvl.toLowerCase() as keyof typeof audit.counts] ?? 0 }))
    .filter((entry) => entry.count > 0);
  const verdictLabel = isRework
    ? (audit.round > 0
      ? t('taskMode.audit_verdict_rework_round', { round: audit.round, defaultValue: `Rework · R${audit.round}` })
      : t('taskMode.audit_verdict_rework', 'Rework'))
    : (audit.round > 0
      ? t('taskMode.audit_verdict_pass_round', { round: audit.round, defaultValue: `Passed · R${audit.round}` })
      : t('taskMode.audit_verdict_pass', 'Passed'));
  const ctaLabel = audit.findingsCount > 0
    ? t('taskMode.audit_open_details_count', { count: audit.findingsCount, defaultValue: `View 1..${audit.findingsCount}` })
    : t('taskMode.audit_open_details', 'Details');

  const canOpen = Boolean(interactive && onOpenDetails);
  const stripClass = `global-task-audit-strip ${isRework ? 'is-rework' : 'is-pass'}${canOpen ? '' : ' is-readonly'}${className ? ` ${className}` : ''}`;

  const body = (
    <>
      <div class="global-task-audit-strip-header">
        <span class="global-task-audit-strip-verdict">{verdictLabel}</span>
        {blockingText ? (
          <span
            class="global-task-audit-strip-blocking"
            data-testid={`${testIdPrefix}-audit-blocking-${taskId}`}
          >
            {t('taskMode.audit_blocking_pending', { items: blockingText, defaultValue: `${blockingText} pending` })}
          </span>
        ) : (
          !isRework && (
            <span class="global-task-audit-strip-chip is-zero">P0 0</span>
          )
        )}
        {otherChips.map((chip) => (
          <span key={chip.lvl} class={`global-task-audit-strip-chip is-${chip.lvl.toLowerCase()}`}>
            {chip.lvl} ×{chip.count}
          </span>
        ))}
        {canOpen && (
          <span class="global-task-audit-strip-cta">{ctaLabel} ›</span>
        )}
      </div>
      {audit.summary && (
        <div class="global-task-audit-strip-summary" title={audit.summary}>{audit.summary}</div>
      )}
    </>
  );

  if (!canOpen) {
    return (
      <div
        class={stripClass}
        data-testid={`${testIdPrefix}-audit-strip-${taskId}`}
      >
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      class={stripClass}
      data-testid={`${testIdPrefix}-audit-strip-${taskId}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpenDetails?.();
      }}
    >
      {body}
    </button>
  );
}
