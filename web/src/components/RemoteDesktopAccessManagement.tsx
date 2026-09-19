import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  REMOTE_DESKTOP_LINK_DURATION_MS,
  REMOTE_DESKTOP_LINK_KIND,
  REMOTE_DESKTOP_LINK_USE_POLICY,
  REMOTE_DESKTOP_LINK_MUTATION,
  type RemoteDesktopLinkKind,
  type RemoteDesktopLinkUsePolicy,
} from '@shared/remote-desktop-access.js';
import { REMOTE_DESKTOP_ACCESS_MODE, type RemoteDesktopAccessMode } from '@shared/remote-desktop.js';
import {
  createRemoteDesktopAccessApi,
  mapRemoteDesktopApiError,
  newRemoteDesktopRequestId,
  prepareRemoteDesktopLink,
  remoteDesktopLinkMutationAction,
  remoteDesktopPasswordMutationAction,
  remoteDesktopManagementWebPrivacyCoordinator,
  runRemoteDesktopStepUp,
  type RemoteDesktopAccessApi,
  type RemoteDesktopOwnerHostSummary,
  type RemoteDesktopOwnerLinkView,
  type RemoteDesktopPrivacyCoordinator,
  type RemoteDesktopPrivacyEpochRef,
} from '../api/remote-desktop-access.js';
import './remote-desktop-access.css';

export interface RemoteDesktopAccessManagementProps {
  hostId: string;
  endpointLabel: string;
  api?: RemoteDesktopAccessApi;
  privacy?: RemoteDesktopPrivacyCoordinator;
}

type OneTimeInvite = { url: string; epoch: RemoteDesktopPrivacyEpochRef };

const DURATION_OPTIONS = [
  REMOTE_DESKTOP_LINK_DURATION_MS.H1,
  REMOTE_DESKTOP_LINK_DURATION_MS.H6,
  REMOTE_DESKTOP_LINK_DURATION_MS.H24,
  REMOTE_DESKTOP_LINK_DURATION_MS.D7,
  REMOTE_DESKTOP_LINK_DURATION_MS.D30,
] as const;

function formatConnectionDuration(
  durationMs: number,
  t: (key: string, options?: Record<string, number>) => string,
): string {
  const totalMinutes = Math.floor(durationMs / 60_000);
  if (totalMinutes < 1) return t('remote_desktop.access_audit_under_minute');
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0
    ? t('remote_desktop.access_audit_hours_minutes', { hours, minutes })
    : t('remote_desktop.access_audit_minutes', { minutes });
}

export function RemoteDesktopAccessManagement({
  hostId,
  endpointLabel,
  api = createRemoteDesktopAccessApi(),
  privacy = remoteDesktopManagementWebPrivacyCoordinator,
}: RemoteDesktopAccessManagementProps) {
  const { t } = useTranslation();
  const [host, setHost] = useState<RemoteDesktopOwnerHostSummary | null>(null);
  const [links, setLinks] = useState<RemoteDesktopOwnerLinkView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [kind, setKind] = useState<RemoteDesktopLinkKind>(REMOTE_DESKTOP_LINK_KIND.ATTENDED);
  const [mode, setMode] = useState<RemoteDesktopAccessMode>(REMOTE_DESKTOP_ACCESS_MODE.CONTROL);
  const [usePolicy, setUsePolicy] = useState<RemoteDesktopLinkUsePolicy>(REMOTE_DESKTOP_LINK_USE_POLICY.REUSABLE);
  const [durationMs, setDurationMs] = useState<number>(REMOTE_DESKTOP_LINK_DURATION_MS.H24);
  const [label, setLabel] = useState('');
  const [invite, setInvite] = useState<OneTimeInvite | null>(null);
  const [passwordEpoch, setPasswordEpoch] = useState<RemoteDesktopPrivacyEpochRef | null>(null);
  const [passwordAction, setPasswordAction] = useState<'set' | 'change' | null>(null);
  const [password, setPassword] = useState('');
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const inviteRef = useRef<HTMLInputElement>(null);
  const createLinkButtonRef = useRef<HTMLButtonElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const heldInviteEpoch = useRef<RemoteDesktopPrivacyEpochRef | null>(null);
  const heldPasswordEpoch = useRef<RemoteDesktopPrivacyEpochRef | null>(null);

  const refresh = async () => {
    const [nextHost, nextLinks] = await Promise.all([api.loadHost(hostId), api.listLinks(hostId)]);
    if (!mounted.current) return;
    setHost(nextHost);
    setLinks(nextLinks);
  };

  const endPrivacySafely = async (epoch: RemoteDesktopPrivacyEpochRef) => {
    try {
      await privacy.end(hostId, epoch);
    } catch {
      setRecoveryRequired(true);
      setError('privacy_recovery_required');
    }
  };

  useEffect(() => {
    mounted.current = true;
    setError(null);
    void refresh().catch((reason) => setError(mapRemoteDesktopApiError(reason)));
    return () => {
      mounted.current = false;
      if (heldInviteEpoch.current) void privacy.end(hostId, heldInviteEpoch.current).catch(() => undefined);
      if (heldPasswordEpoch.current) void privacy.end(hostId, heldPasswordEpoch.current).catch(() => undefined);
    };
  }, [hostId]);

  useEffect(() => {
    if (invite) requestAnimationFrame(() => inviteRef.current?.focus());
  }, [invite]);

  const withMutation = async <T,>(input: {
    requestId: string;
    action: Record<string, unknown>;
    run(epoch: RemoteDesktopPrivacyEpochRef, grant: string): Promise<T>;
  }): Promise<T> => {
    const epoch = await privacy.begin(hostId);
    try {
      const grant = await runRemoteDesktopStepUp(api, {
        canonicalHostId: hostId,
        requestId: input.requestId,
        action: input.action,
      });
      return await input.run(epoch, grant);
    } finally {
      await endPrivacySafely(epoch);
    }
  };

  const createLink = async () => {
    setBusy(true);
    setError(null);
    let epoch: RemoteDesktopPrivacyEpochRef | null = null;
    try {
      // Server gate first: no token exists while a remote route may still see it.
      epoch = await privacy.begin(hostId);
      const prepared = await prepareRemoteDesktopLink({
        hostId,
        kind,
        mode,
        usePolicy,
        label: label.trim(),
        ...(kind === REMOTE_DESKTOP_LINK_KIND.UNATTENDED ? { durationMs } : {}),
      });
      const link = await api.createLink({ prepared, privacyEpoch: epoch });
      setLinks((current) => [link, ...current.filter((item) => item.id !== link.id)]);
      setLabel('');
      setInvite({ url: prepared.inviteUrl, epoch });
      heldInviteEpoch.current = epoch;
      epoch = null; // Held until the one-time secret is cleared.
    } catch (reason) {
      setInvite(null);
      setError(mapRemoteDesktopApiError(reason));
    } finally {
      if (epoch) await endPrivacySafely(epoch);
      setBusy(false);
    }
  };

  const closeInvite = async () => {
    const current = invite;
    setInvite(null);
    heldInviteEpoch.current = null;
    if (current) await endPrivacySafely(current.epoch);
    requestAnimationFrame(() => createLinkButtonRef.current?.focus());
  };

  const rotate = async () => {
    const requestId = newRemoteDesktopRequestId();
    setBusy(true);
    setError(null);
    try {
      setHost(await api.rotateHost({ hostId, requestId }));
    } catch (reason) {
      setError(mapRemoteDesktopApiError(reason));
    } finally { setBusy(false); }
  };

  const mutateLink = async (
    link: RemoteDesktopOwnerLinkView,
    mutation: typeof REMOTE_DESKTOP_LINK_MUTATION[keyof typeof REMOTE_DESKTOP_LINK_MUTATION],
    options: { label?: string; expiresAt?: number } = {},
  ) => {
    const requestId = newRemoteDesktopRequestId();
    setBusy(true);
    setError(null);
    try {
      const updated = await withMutation({
        requestId,
        action: remoteDesktopLinkMutationAction({ hostId, linkId: link.id, mutation, ...options }),
        run: (privacyEpoch, stepUpGrant) => mutation === REMOTE_DESKTOP_LINK_MUTATION.REVOKE
          ? api.revokeLink({ linkId: link.id, hostId, requestId, privacyEpoch, stepUpGrant })
          : api.mutateLink({ linkId: link.id, hostId, requestId, mutation, privacyEpoch, stepUpGrant, ...options }),
      });
      setLinks((current) => current.map((item) => item.id === updated.id
        ? { ...updated, connectionAudit: item.connectionAudit }
        : item));
    } catch (reason) {
      setError(mapRemoteDesktopApiError(reason));
    } finally { setBusy(false); }
  };

  const beginPassword = async (action: 'set' | 'change' | 'disable') => {
    setBusy(true);
    setError(null);
    try {
      const epoch = await privacy.begin(hostId);
      setPasswordEpoch(epoch);
      heldPasswordEpoch.current = epoch;
      if (action === 'disable') {
        await finishPassword('disable', epoch);
      } else {
        setPasswordAction(action);
        requestAnimationFrame(() => passwordRef.current?.focus());
      }
    } catch (reason) {
      setError(mapRemoteDesktopApiError(reason));
      setBusy(false);
    }
  };

  const finishPassword = async (
    action: 'set' | 'change' | 'disable',
    activeEpoch: RemoteDesktopPrivacyEpochRef | null = passwordEpoch,
  ) => {
    if (!activeEpoch) return;
    const requestId = newRemoteDesktopRequestId();
    setBusy(true);
    setError(null);
    try {
      const grant = await runRemoteDesktopStepUp(api, {
        canonicalHostId: hostId,
        requestId,
        action: remoteDesktopPasswordMutationAction({ hostId, action, requestId }),
      });
      await api.mutatePassword({
        hostId, requestId, action, privacyEpoch: activeEpoch, stepUpGrant: grant,
        ...(action === 'disable' ? {} : { password }),
      });
    } catch (reason) {
      setError(mapRemoteDesktopApiError(reason));
    } finally {
      setPassword('');
      setPasswordEpoch(null);
      setPasswordAction(null);
      heldPasswordEpoch.current = null;
      await endPrivacySafely(activeEpoch);
      setBusy(false);
    }
  };

  const cancelPassword = async () => {
    const epoch = passwordEpoch;
    setPassword('');
    setPasswordEpoch(null);
    setPasswordAction(null);
    heldPasswordEpoch.current = null;
    if (epoch) await endPrivacySafely(epoch);
  };

  const durationLabels = useMemo(() => new Map<number, string>([
    [REMOTE_DESKTOP_LINK_DURATION_MS.H1, t('remote_desktop.access_duration_1h')],
    [REMOTE_DESKTOP_LINK_DURATION_MS.H6, t('remote_desktop.access_duration_6h')],
    [REMOTE_DESKTOP_LINK_DURATION_MS.H24, t('remote_desktop.access_duration_24h')],
    [REMOTE_DESKTOP_LINK_DURATION_MS.D7, t('remote_desktop.access_duration_7d')],
    [REMOTE_DESKTOP_LINK_DURATION_MS.D30, t('remote_desktop.access_duration_30d')],
  ]), [t]);

  return (
    <section class="remote-desktop-access" aria-label={t('remote_desktop.access_owner_title')}>
      <header>
        <div>
          <h2>{t('remote_desktop.access_owner_title')}</h2>
          <p>{t('remote_desktop.access_linked_endpoints', { endpoint: endpointLabel })}</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy}>{t('common.refresh')}</button>
      </header>

      {error && <div class="remote-desktop-access-alert" role="alert">{t(recoveryRequired
        ? 'remote_desktop.access_privacy_recovery'
        : 'remote_desktop.access_error_generic')}</div>}

      <div class="remote-desktop-access-card">
        <h3>{t('remote_desktop.access_public_id')}</h3>
        <p>{t('remote_desktop.access_public_id_non_secret')}</p>
        <output aria-live="polite">{host?.publicNodeId ?? t('common.loading')}</output>
        <div class="remote-desktop-access-actions">
          <button type="button" disabled={!host} onClick={() => void navigator.clipboard.writeText(host?.publicNodeId != null ? String(host.publicNodeId) : '')}>{t('common.copy')}</button>
          <button type="button" disabled={!host || busy || recoveryRequired} onClick={() => void rotate()}>{t('remote_desktop.access_rotate')}</button>
        </div>
      </div>

      <div class="remote-desktop-access-card">
        <h3>{t('remote_desktop.access_links_title')}</h3>
        <label>{t('remote_desktop.access_link_label')}<input value={label} maxLength={128} onInput={(e) => setLabel(e.currentTarget.value)} /></label>
        <div class="remote-desktop-access-grid">
          <label>{t('remote_desktop.access_kind')}
            <select value={kind} onChange={(e) => setKind(e.currentTarget.value as RemoteDesktopLinkKind)}>
              <option value={REMOTE_DESKTOP_LINK_KIND.ATTENDED}>{t('remote_desktop.access_attended')}</option>
              <option value={REMOTE_DESKTOP_LINK_KIND.UNATTENDED}>{t('remote_desktop.access_unattended')}</option>
            </select>
          </label>
          <label>{t('remote_desktop.access_mode')}
            <select value={mode} onChange={(e) => setMode(e.currentTarget.value as RemoteDesktopAccessMode)}>
              <option value={REMOTE_DESKTOP_ACCESS_MODE.VIEW}>{t('remote_desktop.view_mode')}</option>
              <option value={REMOTE_DESKTOP_ACCESS_MODE.CONTROL}>{t('remote_desktop.control_mode')}</option>
            </select>
          </label>
          <label>{t('remote_desktop.access_use_policy')}
            <select value={usePolicy} onChange={(e) => setUsePolicy(e.currentTarget.value as RemoteDesktopLinkUsePolicy)}>
              <option value={REMOTE_DESKTOP_LINK_USE_POLICY.SINGLE_USE}>{t('remote_desktop.access_single_use')}</option>
              <option value={REMOTE_DESKTOP_LINK_USE_POLICY.REUSABLE}>{t('remote_desktop.access_reusable')}</option>
            </select>
          </label>
          {kind === REMOTE_DESKTOP_LINK_KIND.UNATTENDED && <label>{t('remote_desktop.access_expires')}
            <select value={durationMs} onChange={(e) => setDurationMs(Number(e.currentTarget.value))}>
              {DURATION_OPTIONS.map((duration) => <option value={duration}>{durationLabels.get(duration)}</option>)}
            </select>
          </label>}
        </div>
        <button ref={createLinkButtonRef} type="button" disabled={busy || recoveryRequired || host?.mergeState === 'conflict_pending'} onClick={() => void createLink()}>{t('remote_desktop.access_create_link')}</button>

        {invite && <div class="remote-desktop-secret-once" role="dialog" aria-modal="true" aria-label={t('remote_desktop.access_secret_once_title')} onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            void closeInvite();
          }
        }}>
          <h4>{t('remote_desktop.access_secret_once_title')}</h4>
          <p>{t('remote_desktop.access_secret_once')}</p>
          <input ref={inviteRef} readOnly value={invite.url} aria-label={t('remote_desktop.access_secret_value')} onFocus={(e) => e.currentTarget.select()} />
          <div class="remote-desktop-access-actions">
            <button type="button" onClick={() => void navigator.clipboard.writeText(invite.url)}>{t('common.copy')}</button>
            <button type="button" onClick={() => void closeInvite()}>{t('common.close')}</button>
          </div>
        </div>}

        <ul class="remote-desktop-link-list">
          {links.map((link) => <li key={link.id}>
            <div><strong>{link.label || t('remote_desktop.access_unnamed')}</strong><span>{t(`remote_desktop.access_${link.kind}`)} · {t(`remote_desktop.${link.mode}_mode`)} · {t(`remote_desktop.access_${link.usePolicy}`)}</span></div>
            <div>
              <span>{link.claimed ? t('remote_desktop.access_claimed') : t('remote_desktop.access_unclaimed')}</span>
              <span>{t(`remote_desktop.access_state_${link.state}`)}</span>
              <span>{link.expiresAt
                ? t('remote_desktop.access_expires_at', { value: new Date(link.expiresAt).toLocaleString() })
                : t('remote_desktop.access_never_expires')}</span>
            </div>
            <div class="remote-desktop-link-audit-summary">
              <span>{t('remote_desktop.access_audit_connections', {
                count: link.connectionAudit.connectionCount,
              })}</span>
              <span>{t('remote_desktop.access_audit_total_duration', {
                duration: formatConnectionDuration(link.connectionAudit.totalDurationMs, t),
              })}</span>
              {link.connectionAudit.lastConnectedAt !== null && (
                <span>{t('remote_desktop.access_audit_last_connected', {
                  value: new Date(link.connectionAudit.lastConnectedAt).toLocaleString(),
                })}</span>
              )}
            </div>
            {link.connectionAudit.recentConnections.length > 0 && (
              <details class="remote-desktop-link-audit-history">
                <summary>{t('remote_desktop.access_audit_history')}</summary>
                <ul>
                  {link.connectionAudit.recentConnections.map((entry, index) => (
                    <li key={`${entry.connectedAt}:${entry.ipAddress}:${index}`}>
                      <code>{entry.ipAddress}</code>
                      <span>{new Date(entry.connectedAt).toLocaleString()}</span>
                      <span>{entry.disconnectedAt === null
                        ? t('remote_desktop.access_audit_connected_now', {
                          duration: formatConnectionDuration(entry.durationMs, t),
                        })
                        : formatConnectionDuration(entry.durationMs, t)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {editingLinkId === link.id && <form class="remote-desktop-access-inline-edit" onSubmit={(event) => {
              event.preventDefault();
              void mutateLink(link, REMOTE_DESKTOP_LINK_MUTATION.SET_LABEL, { label: editingLabel })
                .then(() => setEditingLinkId(null));
            }}>
              <label>{t('remote_desktop.access_link_label')}
                <input autoFocus required maxLength={128} value={editingLabel} onInput={(event) => setEditingLabel(event.currentTarget.value)} />
              </label>
              <div class="remote-desktop-access-actions">
                <button type="submit" disabled={busy || recoveryRequired || !editingLabel.trim()}>{t('common.save')}</button>
                <button type="button" onClick={() => setEditingLinkId(null)}>{t('common.cancel')}</button>
              </div>
            </form>}
            {link.state === 'active' && <div class="remote-desktop-access-actions">
              <button type="button" disabled={busy || recoveryRequired} onClick={() => {
                setEditingLinkId(link.id);
                setEditingLabel(link.label);
              }}>{t('remote_desktop.access_rename')}</button>
              {link.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL && <button type="button" disabled={busy || recoveryRequired} onClick={() => void mutateLink(link, REMOTE_DESKTOP_LINK_MUTATION.REDUCE_TO_VIEW)}>{t('remote_desktop.access_reduce')}</button>}
              {link.expiresAt && <button type="button" disabled={busy || recoveryRequired || link.expiresAt <= Date.now() + 60_000} onClick={() => void mutateLink(link, REMOTE_DESKTOP_LINK_MUTATION.SHORTEN_EXPIRY, { expiresAt: Math.max(Date.now() + 60_000, link.expiresAt! - 60 * 60_000) })}>{t('remote_desktop.access_shorten')}</button>}
              <button type="button" class="danger" disabled={busy || recoveryRequired} onClick={() => void mutateLink(link, REMOTE_DESKTOP_LINK_MUTATION.REVOKE)}>{t('remote_desktop.access_revoke')}</button>
            </div>}
          </li>)}
        </ul>
      </div>

      <div class="remote-desktop-access-card">
        <h3>{t('remote_desktop.access_password_title')}</h3>
        <p>{t('remote_desktop.access_password_invalidation')}</p>
        {!passwordEpoch ? <div class="remote-desktop-access-actions">
          <button type="button" disabled={busy || recoveryRequired} onClick={() => void beginPassword('set')}>{t('remote_desktop.access_password_set')}</button>
          <button type="button" disabled={busy || recoveryRequired} onClick={() => void beginPassword('change')}>{t('remote_desktop.access_password_change')}</button>
          <button type="button" class="danger" disabled={busy || recoveryRequired} onClick={() => void beginPassword('disable')}>{t('remote_desktop.access_password_disable')}</button>
        </div> : passwordAction && <>
          <label>{t('remote_desktop.access_password_value')}<input ref={passwordRef} type="password" minLength={12} maxLength={256} autoComplete="new-password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} /></label>
          <p>{t('remote_desktop.access_password_strength')}</p>
          <div class="remote-desktop-access-actions">
            <button type="button" disabled={busy || new TextEncoder().encode(password).length < 12} onClick={() => void finishPassword(passwordAction)}>{t('common.save')}</button>
            <button type="button" disabled={busy} onClick={() => void cancelPassword()}>{t('common.cancel')}</button>
          </div>
        </>}
      </div>
    </section>
  );
}
