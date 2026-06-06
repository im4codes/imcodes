import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { ApiError, createShare, listSharesForTarget, revokeShare, updateShare } from '../api.js';
import {
  buildCurrentTabShareTarget,
  isParticipantRole,
  type ShareDialogTarget,
  type ShareGrantSummary,
  type ShareRole,
  type ShareTarget,
} from '../tab-sharing-ui.js';

interface Props {
  target: ShareDialogTarget;
  onClose: () => void;
}

type TargetChoice = 'current-tab' | 'server';

function formatShareError(error: unknown): string {
  if (error instanceof ApiError) return error.body || error.message;
  if (error instanceof Error) return error.message;
  return String(error || 'share_failed');
}

function getGrantDisplayName(grant: ShareGrantSummary): string {
  return grant.targetUserDisplayName?.trim() || grant.targetUserId;
}

export function ShareSessionDialog({ target, onClose }: Props) {
  const { t } = useTranslation();
  const [targetChoice, setTargetChoice] = useState<TargetChoice>('current-tab');
  const [role, setRole] = useState<ShareRole>('viewer');
  const [targetUser, setTargetUser] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shares, setShares] = useState<ShareGrantSummary[]>([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [updatingShareId, setUpdatingShareId] = useState<string | null>(null);

  const selectedTarget = useMemo<ShareTarget>(() => (
    targetChoice === 'server'
      ? { kind: 'server', serverId: target.serverId }
      : buildCurrentTabShareTarget(target)
  ), [target, targetChoice]);

  const targetLabel = targetChoice === 'server'
    ? (target.serverLabel?.trim() || t('share.target.serverFallback'))
    : target.tabLabel;

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
    } catch (err) {
      setError(formatShareError(err));
    } finally {
      setSubmitting(false);
    }
  }, [role, selectedTarget, submitting, target.serverId, targetUser]);

  const replaceShare = useCallback((nextShare: ShareGrantSummary) => {
    setShares((current) => current.map((item) => item.id === nextShare.id ? nextShare : item));
  }, []);

  const handleRoleChange = useCallback(async (share: ShareGrantSummary, nextRole: ShareRole) => {
    if (share.role === nextRole || updatingShareId) return;
    setUpdatingShareId(share.id);
    setError(null);
    try {
      replaceShare(await updateShare(target.serverId, share.id, { role: nextRole }));
    } catch (err) {
      setError(formatShareError(err));
    } finally {
      setUpdatingShareId(null);
    }
  }, [replaceShare, target.serverId, updatingShareId]);

  const handleRevoke = useCallback(async (share: ShareGrantSummary) => {
    if (updatingShareId) return;
    const displayName = getGrantDisplayName(share);
    if (!window.confirm(t('share.manage.revokeConfirm', { user: displayName }))) return;
    setUpdatingShareId(share.id);
    setError(null);
    try {
      replaceShare(await revokeShare(target.serverId, share.id));
    } catch (err) {
      setError(formatShareError(err));
    } finally {
      setUpdatingShareId(null);
    }
  }, [replaceShare, t, target.serverId, updatingShareId]);

  return (
    <div class="ask-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="ask-dialog share-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('share.dialogTitle')}>
        <div>
          <div class="share-dialog-title">{t('share.dialogTitle')}</div>
          <div class="share-dialog-subtitle">{t('share.dialogSubtitle', { target: targetLabel })}</div>
        </div>

        <div class="share-field">
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
        </div>

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
          <div class="share-help">{t(`share.roleHelp.${role}`)}</div>
        </div>

        {isParticipantRole(role) && (
          <div class="share-trust-disclosure" role="note">
            <strong>{t('share.trust.title')}</strong>
            <span>{t('share.trust.body')}</span>
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
                    onChange={(e) => void handleRoleChange(share, (e.currentTarget as HTMLSelectElement).value as ShareRole)}
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

        <div class="ask-actions">
          <button class="ask-btn-cancel" onClick={onClose}>{t('common.cancel')}</button>
          <button
            class="ask-btn-submit"
            disabled={!targetUser.trim() || submitting}
            onClick={submit}
          >
            {submitting ? t('share.creating') : t('share.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
