import { useEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import { TASK_PAIR_CLOSE_ERROR, type TaskPairCloseAction } from '@shared/task-pair-close.js';

export interface TaskPairCloseConfirmTarget {
  serverId: string;
  taskId: string;
  title: string;
  action: TaskPairCloseAction;
  status?: string;
}

export interface TaskPairContextMenuItem {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  testId?: string;
  onSelect: () => void;
}

export function clampContextMenuPosition(
  clientX: number,
  clientY: number,
  menuWidth = 200,
  menuHeight = 150,
): { x: number; y: number } {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  return {
    x: Math.max(8, Math.min(clientX, vw - menuWidth - 8)),
    y: Math.max(8, Math.min(clientY, vh - menuHeight - 8)),
  };
}

export function formatTaskPairCloseError(
  errorCode: string | undefined,
  t: (key: string, defaultValue?: string) => string,
): string {
  switch (errorCode) {
    case TASK_PAIR_CLOSE_ERROR.DAEMON_OFFLINE:
      return t('taskMode.close_error_offline', 'Daemon is offline');
    case TASK_PAIR_CLOSE_ERROR.TIMEOUT:
      return t('taskMode.close_error_timeout', 'Request timed out');
    case TASK_PAIR_CLOSE_ERROR.FORBIDDEN:
      return t('taskMode.close_error_forbidden', 'Only the server owner can cancel tasks');
    case TASK_PAIR_CLOSE_ERROR.ALREADY_TERMINAL:
      return t('taskMode.close_error_already_terminal', 'Task is already closed');
    default:
      return t('taskMode.cancel_failed', 'Failed to cancel task');
  }
}

export function TaskPairContextMenu({
  x,
  y,
  ariaLabel,
  items,
  onClose,
}: {
  x: number;
  y: number;
  ariaLabel: string;
  items: readonly TaskPairContextMenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    const onScrollOrResize = () => onClose();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [onClose]);

  if (items.length === 0) return null;

  const menuEl = (
    <div
      ref={menuRef}
      class="task-pair-context-menu"
      data-testid="task-pair-context-menu"
      role="menu"
      aria-label={ariaLabel}
      style={{ left: `${x}px`, top: `${y}px` }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          class={`task-pair-context-menu-item${item.danger ? ' is-danger' : ''}`}
          data-testid={item.testId}
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );

  return typeof document !== 'undefined' && document.body
    ? createPortal(menuEl, document.body)
    : menuEl;
}

export function TaskPairCloseConfirmDialog({
  target,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  target: TaskPairCloseConfirmTarget | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [busy, onCancel, target]);

  if (!target) return null;

  const isDone = target.action === 'done';
  const titleText = isDone
    ? t('taskMode.close_done_confirm_title', 'Close task as done?')
    : t('taskMode.cancel_confirm_title', 'Cancel this task?');
  const bodyText = isDone
    ? t('taskMode.close_done_confirm_body', { title: target.title, defaultValue: `"${target.title}" will be closed and marked done.` })
    : t('taskMode.cancel_confirm_body', { title: target.title, defaultValue: `"${target.title}" will be marked cancelled and stopped.` });
  const confirmLabel = isDone
    ? t('taskMode.close_done_confirm_action', 'Close as done')
    : t('taskMode.cancel_confirm_action', 'Cancel task');

  const dialogEl = (
    <div
      class="global-task-modal-backdrop task-pair-close-confirm-backdrop"
      data-testid="task-pair-close-confirm-backdrop"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        class="global-task-composer-dialog task-pair-close-confirm-dialog"
        data-testid="task-pair-close-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={titleText}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="global-task-composer-header">
          <div class="global-task-composer-target">
            <strong>{titleText}</strong>
            <span class="global-task-composer-task-title">{target.title}</span>
          </div>
          <button
            type="button"
            class="global-task-modal-close"
            aria-label={t('common.close', 'Close')}
            disabled={busy}
            onClick={onCancel}
          >
            ✕
          </button>
        </div>

        <p class="task-pair-close-confirm-body">{bodyText}</p>

        {error && (
          <div class="global-task-error-banner" data-testid="task-pair-close-confirm-error">
            {error}
          </div>
        )}

        <div class="global-task-composer-footer task-pair-close-confirm-actions">
          <button
            type="button"
            class="task-pair-close-keep-btn"
            data-testid="task-pair-close-keep-btn"
            disabled={busy}
            onClick={onCancel}
          >
            {t('taskMode.cancel_keep', 'Keep task')}
          </button>
          <button
            type="button"
            class="task-pair-close-confirm-btn"
            data-testid="task-pair-close-confirm-btn"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? t('common.loading', 'Closing…') : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' && document.body
    ? createPortal(dialogEl, document.body)
    : dialogEl;
}
