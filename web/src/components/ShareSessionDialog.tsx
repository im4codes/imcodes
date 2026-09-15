import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { ApiError, createShare, listSharesForTarget, revokeShare, updateShare } from '../api.js';
import {
  buildCurrentTabShareTarget,
  isParticipantRole,
  shareTargetKey,
  type ShareDialogTarget,
  type ShareGrantSummary,
  type ShareRole,
  type ShareTarget,
} from '../tab-sharing-ui.js';
import { RemoteDesktopOwnerAccess } from './RemoteDesktopOwnerAccess.js';

interface RemoteDesktopShareAccess {
  hostId: string | null;
  endpointLabel: string;
}

interface Props {
  target: ShareDialogTarget;
  onClose: () => void;
  onSharesChanged?: () => void;
  /** Fixed machine targets reuse grant management without exposing Tab/server scope choices. */
  fixedTarget?: ShareTarget;
  variant?: 'session' | 'machine';
  /** Owner-only public remote-desktop access lives inside the machine share dialog. */
  remoteDesktopAccess?: RemoteDesktopShareAccess;
}

type TargetChoice = 'current-tab' | 'server';
type MachineShareSection = 'account' | 'remote-desktop';

function formatShareError(error: unknown): string {
  if (error instanceof ApiError) return error.body || error.message;
  if (error instanceof Error) return error.message;
  return String(error || 'share_failed');
}

function getGrantDisplayName(grant: ShareGrantSummary): string {
  return grant.targetUserDisplayName?.trim() || grant.targetUserId;
}

export function ShareSessionDialog({
  target,
  onClose,
  onSharesChanged,
  fixedTarget,
  variant = 'session',
  remoteDesktopAccess,
}: Props) {
  const { t } = useTranslation();
  const [targetChoice, setTargetChoice] = useState<TargetChoice>('current-tab');
  const [machineSection, setMachineSection] = useState<MachineShareSection>('account');
  const [role, setRole] = useState<ShareRole>('viewer');
  const [targetUser, setTargetUser] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shares, setShares] = useState<ShareGrantSummary[]>([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [updatingShareId, setUpdatingShareId] = useState<string | null>(null);
  const accountTabRef = useRef<HTMLButtonElement>(null);
  const remoteDesktopTabRef = useRef<HTMLButtonElement>(null);
  const hasRemoteDesktopSection = variant === 'machine' && remoteDesktopAccess !== undefined;

  // ControlledNodesPanel refreshes presence in the background and recreates
  // its inline target objects on every render. Depend on the target identity,
  // not object identity, or the dialog continuously reloads and can overwrite
  // a role mutation with a stale list response.
  const fixedTargetKey = shareTargetKey(fixedTarget);

  const selectedTarget = useMemo<ShareTarget>(() => (
    fixedTarget ?? (targetChoice === 'server'
      ? { kind: 'server', serverId: target.serverId }
      : buildCurrentTabShareTarget(target))
  ), [
    fixedTargetKey,
    target.serverId,
    target.sessionName,
    target.subSessionDisplayName,
    target.subSessionId,
    targetChoice,
  ]);

  const targetLabel = fixedTarget
    ? target.tabLabel
    : targetChoice === 'server'
    ? (target.serverLabel?.trim() || t('share.target.serverFallback'))
    : target.tabLabel;
  const roleHelpPrefix = variant === 'machine' ? 'controlled_nodes.share.role_help' : 'share.roleHelp';

  const loadShares = useCallback(async () => {
    setSharesLoading(true);
    setError(null);
    try {
      setShares(await listSharesForTarget(target.serverId, selectedTarget));
    } catch (err) {
      setShares([]);
      setError(formatShareError(err));
    } finally {
      setSharesLoading(false);
    }
  }, [selectedTarget, target.serverId]);

  useEffect(() => {
    void loadShares();
  }, [loadShares]);

  const submit = useCallback(async () => {
    const trimmedUser = targetUser.trim();
    if (!trimmedUser || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const share = await createShare(target.serverId, {
        target: selectedTarget,
        targetUserId: trimmedUser,
        role,
      });
      setTargetUser('');
      setShares((current) => [share, ...current.filter((item) => item.id !== share.id)]);
      onSharesChanged?.();
    } catch (err) {
      setError(formatShareError(err));
    } finally {
      setSubmitting(false);
    }
  }, [onSharesChanged, role, selectedTarget, submitting, target.serverId, targetUser]);

  const replaceShare = useCallback((nextShare: ShareGrantSummary) => {
    setShares((current) => current.map((item) => item.id === nextShare.id ? nextShare : item));
  }, []);

  const handleRoleChange = useCallback(async (share: ShareGrantSummary, nextRole: ShareRole) => {
    if (share.role === nextRole || updatingShareId) return;
    setUpdatingShareId(share.id);
    setError(null);
    try {
      replaceShare(await updateShare(target.serverId, share.id, { role: nextRole }));
      onSharesChanged?.();
    } catch (err) {
      setError(formatShareError(err));
    } finally {
      setUpdatingShareId(null);
    }
  }, [onSharesChanged, replaceShare, target.serverId, updatingShareId]);

  const handleRevoke = useCallback(async (share: ShareGrantSummary) => {
    if (updatingShareId) return;
    const displayName = getGrantDisplayName(share);
    if (!window.confirm(t('share.manage.revokeConfirm', { user: displayName }))) return;
    setUpdatingShareId(share.id);
    setError(null);
    try {
      replaceShare(await revokeShare(target.serverId, share.id));
      onSharesChanged?.();
    } catch (err) {
      setError(formatShareError(err));
    } finally {
      setUpdatingShareId(null);
    }
  }, [onSharesChanged, replaceShare, t, target.serverId, updatingShareId]);

  const handleMachineTabKeyDown = useCallback((event: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    let next: MachineShareSection | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'Home') next = 'account';
    if (event.key === 'ArrowRight' || event.key === 'End') next = 'remote-desktop';
    if (!next) return;
    event.preventDefault();
    setMachineSection(next);
    (next === 'account' ? accountTabRef : remoteDesktopTabRef).current?.focus();
  }, []);

  return (
    <div class="ask-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="ask-dialog share-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t(variant === 'machine' ? 'controlled_nodes.share.title' : 'share.dialogTitle')}>
        <div>
          <div class="share-dialog-title">{t(variant === 'machine' ? 'controlled_nodes.share.title' : 'share.dialogTitle')}</div>
          <div class="share-dialog-subtitle">{t(variant === 'machine' ? 'controlled_nodes.share.subtitle' : 'share.dialogSubtitle', { target: targetLabel })}</div>
        </div>

        {hasRemoteDesktopSection && (
          <div class="share-dialog-tabs" role="tablist" aria-label={t('controlled_nodes.share.sections_label')}>
            <button
              ref={accountTabRef}
              id="machine-account-share-tab"
              class={`share-dialog-tab${machineSection === 'account' ? ' is-active' : ''}`}
              type="button"
              role="tab"
              aria-selected={machineSection === 'account'}
              aria-controls="machine-account-share-panel"
              tabIndex={machineSection === 'account' ? 0 : -1}
              onClick={() => setMachineSection('account')}
              onKeyDown={handleMachineTabKeyDown}
            >
              {t('controlled_nodes.share.account_tab')}
            </button>
            <button
              ref={remoteDesktopTabRef}
              id="machine-remote-desktop-share-tab"
              class={`share-dialog-tab${machineSection === 'remote-desktop' ? ' is-active' : ''}`}
              type="button"
              role="tab"
              aria-selected={machineSection === 'remote-desktop'}
              aria-controls="machine-remote-desktop-share-panel"
              tabIndex={machineSection === 'remote-desktop' ? 0 : -1}
              onClick={() => setMachineSection('remote-desktop')}
              onKeyDown={handleMachineTabKeyDown}
            >
              {t('controlled_nodes.share.remote_desktop_tab')}
            </button>
          </div>
        )}

        {(!hasRemoteDesktopSection || machineSection === 'account') && (
          <div
            id={hasRemoteDesktopSection ? 'machine-account-share-panel' : undefined}
            class="share-dialog-panel"
            role={hasRemoteDesktopSection ? 'tabpanel' : undefined}
            aria-labelledby={hasRemoteDesktopSection ? 'machine-account-share-tab' : undefined}
          >
            {!fixedTarget && <div class="share-field">
              <div class="share-field-label">{t('share.target.label')}</div>
              <div class="share-choice-row" role="radiogroup" aria-label={t('share.target.label')}>
                <label class="share-choice">
                  <input
                    type="radio"
                    checked={targetChoice === 'current-tab'}
                    onChange={() => setTargetChoice('current-tab')}
                  />
                  <span>{t('share.target.currentTab')}</span>
                </label>
                <label class="share-choice">
                  <input
                    type="radio"
                    checked={targetChoice === 'server'}
                    onChange={() => setTargetChoice('server')}
                  />
                  <span>{t('share.target.server')}</span>
                </label>
              </div>
            </div>}

            <div class="share-field">
              <div class="share-field-label">{t('share.role.label')}</div>
              <div class="share-choice-row" role="radiogroup" aria-label={t('share.role.label')}>
                <label class="share-choice">
                  <input type="radio" checked={role === 'viewer'} onChange={() => setRole('viewer')} />
                  <span>{t('share.role.viewer')}</span>
                </label>
                <label class="share-choice">
                  <input type="radio" checked={role === 'participant'} onChange={() => setRole('participant')} />
                  <span>{t('share.role.participant')}</span>
                </label>
              </div>
              <div class="share-help">{t(`${roleHelpPrefix}.${role}`)}</div>
            </div>

            {isParticipantRole(role) && (
              <div class="share-trust-disclosure" role="note">
                <strong>{t(variant === 'machine' ? 'controlled_nodes.share.trust_title' : 'share.trust.title')}</strong>
                <span>{t(variant === 'machine' ? 'controlled_nodes.share.trust_body' : 'share.trust.body')}</span>
              </div>
            )}

            <div class="share-field">
              <label class="share-field-label" for="share-target-user">{t('share.recipient.label')}</label>
              <input
                id="share-target-user"
                class="share-input"
                value={targetUser}
                onInput={(e) => setTargetUser((e.target as HTMLInputElement).value)}
                placeholder={t('share.recipient.placeholder')}
              />
            </div>

            {error && <div class="share-error" role="alert">{error}</div>}

            <div class="share-list" aria-label={t('share.list.label')}>
              <div class="share-list-title">{t('share.list.title')}</div>
              {sharesLoading ? (
                <div class="share-list-empty">{t('common.loading')}</div>
              ) : shares.length === 0 ? (
                <div class="share-list-empty">{t('share.list.empty')}</div>
              ) : (
                shares.map((share) => (
                  <div class="share-list-row" key={share.id}>
                    <div class="share-list-main">
                      <div class="share-list-name">{getGrantDisplayName(share)}</div>
                      <div class="share-list-meta">
                        <span>{t(`share.status.${share.status}`)}</span>
                        {share.targetLabel && <span>{share.targetLabel}</span>}
                      </div>
                    </div>
                    <div class="share-list-actions">
                      <select
                        class="share-role-select"
                        aria-label={t('share.manage.roleFor', { user: getGrantDisplayName(share) })}
                        value={share.role}
                        disabled={share.status !== 'active' || updatingShareId === share.id}
                        onInput={(e) => void handleRoleChange(share, (e.currentTarget as HTMLSelectElement).value as ShareRole)}
                      >
                        <option value="viewer">{t('share.role.viewer')}</option>
                        <option value="participant">{t('share.role.participant')}</option>
                      </select>
                      <button
                        class="share-revoke-btn"
                        type="button"
                        disabled={share.status !== 'active' || updatingShareId === share.id}
                        onClick={() => void handleRevoke(share)}
                      >
                        {t('share.manage.revoke')}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {hasRemoteDesktopSection && machineSection === 'remote-desktop' && (
          <div
            id="machine-remote-desktop-share-panel"
            class="share-dialog-panel share-dialog-remote-desktop"
            role="tabpanel"
            aria-labelledby="machine-remote-desktop-share-tab"
          >
            <RemoteDesktopOwnerAccess
              hostId={remoteDesktopAccess.hostId}
              endpointLabel={remoteDesktopAccess.endpointLabel}
            />
          </div>
        )}

        <div class="ask-actions">
          <button class="ask-btn-cancel" onClick={onClose}>{t('common.cancel')}</button>
          {(!hasRemoteDesktopSection || machineSection === 'account') && (
            <button
              class="ask-btn-submit"
              disabled={!targetUser.trim() || submitting}
              onClick={submit}
            >
              {submitting ? t('share.creating') : t('share.create')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
