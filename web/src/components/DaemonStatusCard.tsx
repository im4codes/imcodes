import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  CONTROLLED_NODE_UPGRADE_STATUS,
  DAEMON_UPGRADE_BLOCK_REASON,
  isDaemonUpgradeAvailable,
  type DaemonAutoUpgradeView,
} from '@shared/daemon-upgrade.js';
import { daemonUpgradeReasonLabelKey } from '../daemon-upgrade-blocked.js';

export type DaemonUpgradeRequestState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'sent' }
  | { phase: 'failed'; message?: string; blockedReason?: string; blockedSessionNames?: string[] };

interface Props {
  currentVersion?: string | null;
  latestVersion?: string | null;
  online: boolean;
  busySessions: number;
  upgrading: boolean;
  requestState: DaemonUpgradeRequestState;
  /** What the server's automatic trigger is doing for this daemon (rides daemon.stats). */
  autoUpgrade?: DaemonAutoUpgradeView | null;
  onUpgrade: () => void;
  compact?: boolean;
}

export function DaemonStatusCard({
  currentVersion,
  latestVersion,
  online,
  busySessions,
  upgrading,
  requestState,
  autoUpgrade = null,
  onUpgrade,
  compact = false,
}: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const upgradeAvailable = isDaemonUpgradeAvailable(currentVersion, latestVersion);
  const pending = upgrading || requestState.phase === 'requesting' || requestState.phase === 'sent';
  const statusLabel = requestState.phase === 'failed'
    ? (requestState.blockedReason ? t('server.daemon_upgrade_blocked') : requestState.message ?? t('server.upgrade_failed'))
    : upgrading || requestState.phase === 'requesting'
      ? t('server.daemon_upgrade_in_progress')
      : requestState.phase === 'sent'
        ? t('server.daemon_upgrade_reconnecting')
        : !online ? t('server.daemon_offline') : null;

  const autoUpgradeLine = upgradeAvailable ? describeAutoUpgrade(autoUpgrade, t) : null;

  if (!upgradeAvailable && !expanded && !pending && requestState.phase !== 'failed') return null;

  return (
    <div class={`daemon-status-card${compact ? ' daemon-status-card-compact' : ''}${expanded ? ' is-expanded' : ''}`}>
      {upgradeAvailable && (
        <button
          type="button"
          class="daemon-upgrade-icon"
          aria-label={t('server.daemon_upgrade_available')}
          title={t('server.daemon_upgrade_available')}
          onClick={() => setExpanded((value) => !value)}
        >
          <span aria-hidden="true">↥</span>
        </button>
      )}
      {(expanded || pending || requestState.phase === 'failed') && (
        <div class="daemon-status-card-content" role="status" aria-live="polite">
          <div class="daemon-status-card-title">{t('server.daemon_status')}</div>
          <div class="daemon-status-card-row">
            <span>{t('server.daemon_current_version')}</span>
            <code>{currentVersion ? `v${currentVersion}` : '—'}</code>
          </div>
          <div class="daemon-status-card-row">
            <span>{t('server.daemon_latest_version')}</span>
            <code>{latestVersion ? `v${latestVersion}` : '—'}</code>
          </div>
          {busySessions > 0 && (
            <div class="daemon-status-card-warning">{t('server.daemon_busy_sessions', { count: busySessions })}</div>
          )}
          {statusLabel && <div class="daemon-status-card-state">{statusLabel}</div>}
          {autoUpgradeLine && <div class="daemon-status-card-state daemon-auto-upgrade-state">{autoUpgradeLine}</div>}
          {upgradeAvailable && (
            <button
              type="button"
              class="btn btn-primary daemon-upgrade-button"
              disabled={!online || pending}
              onClick={onUpgrade}
            >
              {pending ? t('server.daemon_upgrade_in_progress') : t('server.daemon_upgrade_button')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type Translate = (key: string, values?: Record<string, unknown>) => string;

/** One line for the card: why the automatic upgrade is waiting, retrying or off. */
export function describeAutoUpgrade(view: DaemonAutoUpgradeView | null | undefined, t: Translate): string | null {
  if (!view) return null;
  if (view.reason === DAEMON_UPGRADE_BLOCK_REASON.AUTO_UPGRADE_DISABLED) return t('server.daemon_auto_upgrade_disabled');
  const reason = t(daemonUpgradeReasonLabelKey(view.reason));
  if (view.status === CONTROLLED_NODE_UPGRADE_STATUS.DEFERRED && view.reason) {
    return t('server.daemon_auto_upgrade_waiting', { reason });
  }
  if (view.status === CONTROLLED_NODE_UPGRADE_STATUS.FAILED) {
    return t('server.daemon_auto_upgrade_retrying', { reason });
  }
  return null;
}

export function DaemonUpgradeConfirmDialog({
  busySessions,
  targetCount = 1,
  blockedReason,
  blockedSessionNames,
  onConfirm,
  onCancel,
}: {
  busySessions: number;
  targetCount?: number;
  /** The daemon's most recent reason for holding an upgrade back: what a confirmed upgrade will interrupt. */
  blockedReason?: string | null;
  blockedSessionNames?: readonly string[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div class="ask-dialog-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div class="ask-dialog daemon-upgrade-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="daemon-upgrade-confirm-title">
        <div id="daemon-upgrade-confirm-title" class="daemon-status-card-title">{t('server.daemon_upgrade_confirm_title')}</div>
        <div class="daemon-upgrade-confirm-body">
          {t('server.daemon_upgrade_confirm_warning')}
          {busySessions > 0 && <><br />{t('server.daemon_upgrade_confirm_busy', { count: busySessions })}</>}
          {blockedReason && <><br />{t('server.daemon_upgrade_confirm_blocked', { reason: t(daemonUpgradeReasonLabelKey(blockedReason)) })}</>}
          {blockedReason && blockedSessionNames && blockedSessionNames.length > 0 && (
            <><br />{t('server.daemon_upgrade_confirm_blocked_sessions', { names: blockedSessionNames.slice(0, 5).join(', ') })}</>
          )}
          {targetCount > 1 && <><br />{t('server.daemon_upgrade_confirm_multiple', { count: targetCount })}</>}
        </div>
        <div class="ask-actions">
          <button type="button" class="ask-btn-cancel" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="button" class="ask-btn-submit" onClick={onConfirm}>{t('server.daemon_upgrade_confirm')}</button>
        </div>
      </div>
    </div>
  );
}
