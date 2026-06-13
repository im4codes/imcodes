import type { ComponentChildren } from 'preact';
import { useTranslation } from 'react-i18next';

interface Props {
  changeName: string;
  taskStats?: {
    total: number;
    checked: number;
    unchecked: number;
  };
  mobile: boolean;
  expanded: boolean;
  auditMenuOpen: boolean;
  actionsDisabled?: boolean;
  disabledReason?: string;
  onAppendReference: () => void;
  onOpenFolder: () => void;
  onToggleExpanded: () => void;
  onToggleAuditMenu: () => void;
  onAuditImplementation: () => void;
  onAuditSpec: () => void;
  onImplement: () => void;
  onAchieve: () => void;
  onAuto: () => void;
  renderAuditSubmenu: (content: ComponentChildren, minWidth: number) => ComponentChildren;
  auditButtonRef: (el: HTMLButtonElement | null) => void;
}

export function OpenSpecChangeRow({
  changeName,
  taskStats,
  mobile,
  expanded,
  auditMenuOpen,
  actionsDisabled = false,
  disabledReason,
  onAppendReference,
  onOpenFolder,
  onToggleExpanded,
  onToggleAuditMenu,
  onAuditImplementation,
  onAuditSpec,
  onImplement,
  onAchieve,
  onAuto,
  renderAuditSubmenu,
  auditButtonRef,
}: Props) {
  const { t } = useTranslation();
  const actionsVisible = !mobile || expanded;
  const actionTitle = actionsDisabled ? disabledReason : undefined;
  const taskStatus = taskStats
    ? taskStats.total > 0
      ? {
        text: `${taskStats.checked}/${taskStats.total}`,
        className: taskStats.unchecked === 0 ? 'openspec-change-task-badge-done' : 'openspec-change-task-badge-pending',
        title: t('openspec.task_status_title', {
          checked: taskStats.checked,
          total: taskStats.total,
          unchecked: taskStats.unchecked,
        }),
      }
      : {
        text: t('openspec.no_tasks'),
        className: 'openspec-change-task-badge-empty',
        title: t('openspec.no_tasks'),
      }
    : null;

  return (
    <div
      class={`openspec-change-row${mobile ? ' openspec-change-row-mobile' : ''}${expanded ? ' openspec-change-row-expanded' : ''}`}
      data-testid={`openspec-change-row-${changeName}`}
    >
      <div class="openspec-change-header">
        <button
          class="menu-item openspec-change-name"
          type="button"
          onClick={onAppendReference}
        >
          <span class="openspec-change-ref-prefix" aria-hidden="true">@</span>
          <span class="openspec-change-name-text">{changeName}</span>
          {taskStatus && (
            <span
              class={`openspec-change-task-badge ${taskStatus.className}`}
              title={taskStatus.title}
              aria-hidden="true"
            >
              {taskStatus.text}
            </span>
          )}
        </button>
        <button
          type="button"
          class="openspec-change-folder-btn"
          title={t('sidebar.pinned_repo')}
          aria-label={t('sidebar.pinned_repo')}
          onClick={onOpenFolder}
        >
          <span class="fb-create-icon fb-create-icon-folder" aria-hidden="true" />
        </button>
        {mobile && (
          <button
            type="button"
            class="openspec-change-toggle"
            aria-label={expanded ? `collapse ${changeName}` : `expand ${changeName}`}
            aria-expanded={expanded}
            onClick={onToggleExpanded}
          >
            {expanded ? '▾' : '▸'}
          </button>
        )}
      </div>
      <div
        class={`openspec-change-actions${actionsVisible ? ' openspec-change-actions-visible' : ''}`}
        hidden={mobile && !expanded}
      >
        <button
          type="button"
          class="btn btn-secondary openspec-change-action-btn openspec-change-action-btn-auto"
          disabled={actionsDisabled}
          title={actionTitle}
          onClick={() => {
            if (actionsDisabled) return;
            onAuto();
          }}
        >
          {t('openspec.auto.action')}
        </button>
        <div class="openspec-change-action-wrap">
          <button
          type="button"
          class="btn btn-secondary openspec-change-action-btn"
          ref={auditButtonRef}
          disabled={actionsDisabled}
          title={actionTitle}
          onClick={() => {
            if (actionsDisabled) return;
            onToggleAuditMenu();
          }}
        >
          {t('openspec.audit_action')}
        </button>
        {auditMenuOpen && renderAuditSubmenu(
          <>
              <button
                class="menu-item"
                type="button"
                onClick={() => {
                  if (actionsDisabled) return;
                  onAuditImplementation();
                }}
                disabled={actionsDisabled}
                title={actionTitle}
              >
                {t('openspec.audit_implementation_action')}
              </button>
              <button
                class="menu-item"
                type="button"
                onClick={() => {
                  if (actionsDisabled) return;
                  onAuditSpec();
                }}
                disabled={actionsDisabled}
                title={actionTitle}
              >
                {t('openspec.audit_spec_action')}
              </button>
            </>,
            180,
          )}
        </div>
        <button
          type="button"
          class="btn btn-secondary openspec-change-action-btn"
          disabled={actionsDisabled}
          title={actionTitle}
          onClick={() => {
            if (actionsDisabled) return;
            onImplement();
          }}
        >
          {t('openspec.implement_action')}
        </button>
        <button
          type="button"
          class="btn btn-secondary openspec-change-action-btn"
          disabled={actionsDisabled}
          title={actionTitle}
          onClick={() => {
            if (actionsDisabled) return;
            onAchieve();
          }}
        >
          {t('openspec.achieve_action')}
        </button>
      </div>
    </div>
  );
}
