import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { REMOTE_DESKTOP_ACTOR_SOURCE } from '@shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_STOP_ORIGIN,
  type RemoteDesktopStopOrigin,
} from '@shared/remote-desktop.js';
import {
  createRemoteDesktopAccessApi,
  createRemoteDesktopBootstrapProof,
  mapRemoteDesktopApiError,
  newRemoteDesktopGuestBrowserKey,
  remoteDesktopGuestSessionStarter,
  type RemoteDesktopAccessApi,
  type RemoteDesktopGuestReady,
  type RemoteDesktopGuestSessionStarter,
  type RemoteDesktopGuestSessionState,
} from '../api/remote-desktop-access.js';
import type { RemoteDesktopInviteBootstrapResult } from '../remote-desktop-invite-bootstrap.js';
import { LoginPage } from '../pages/LoginPage.js';
import {
  REMOTE_DESKTOP_INVITE_HISTORY_STATE_KEY,
  REMOTE_DESKTOP_PUBLIC_ID_HISTORY_STATE_KEY,
  getOrCreateRemoteDesktopInviteBinding,
  loadRemoteDesktopInviteBinding,
  type PersistedRemoteDesktopInviteBinding,
} from '../remote-desktop-access-crypto.js';
import './remote-desktop-access.css';

export interface RemoteDesktopGuestAccessProps {
  bootstrap?: Promise<RemoteDesktopInviteBootstrapResult>;
  api?: RemoteDesktopAccessApi;
  sessionStarter?: RemoteDesktopGuestSessionStarter;
  onExit?: () => void;
}

type GuestUiState =
  | 'idle'
  | 'resolving'
  | RemoteDesktopGuestSessionState
  | 'cooldown'
  | 'auth_required'
  | 'invitation_invalid'
  | 'invitation_expired'
  | 'password_invalid'
  | 'device_offline'
  | 'invite_unavailable'
  | 'password_unavailable'
  | 'unavailable';

type GuestSaveContext = {
  publicNodeId: string;
  bootstrapTicket: string;
  browserKeyThumbprint: string;
};

function readResumablePublicNodeId(): string {
  const queryValue = new URLSearchParams(window.location.search).get('publicId');
  if (queryValue && /^[5-9]\d{9}$/.test(queryValue)) return queryValue;
  const state = window.history.state;
  if (!state || typeof state !== 'object') return '';
  const candidate = (state as Record<string, unknown>)[REMOTE_DESKTOP_PUBLIC_ID_HISTORY_STATE_KEY];
  return typeof candidate === 'string' && /^[5-9]\d{9}$/.test(candidate) ? candidate : '';
}

function replacePublicNodeIdHistoryState(publicNodeId: string | null): void {
  const state = window.history.state && typeof window.history.state === 'object'
    ? window.history.state as Record<string, unknown>
    : {};
  const next = { ...state };
  if (publicNodeId) next[REMOTE_DESKTOP_PUBLIC_ID_HISTORY_STATE_KEY] = publicNodeId;
  else delete next[REMOTE_DESKTOP_PUBLIC_ID_HISTORY_STATE_KEY];
  window.history.replaceState(next, '', '/remote-desktop/access');
}

export function RemoteDesktopGuestAccess({
  bootstrap = Promise.resolve({ status: 'unavailable' }),
  api = createRemoteDesktopAccessApi(),
  sessionStarter = remoteDesktopGuestSessionStarter,
  onExit = () => window.location.replace('/'),
}: RemoteDesktopGuestAccessProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<GuestUiState>('idle');
  const [publicNodeId, setPublicNodeId] = useState(readResumablePublicNodeId);
  const [password, setPassword] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register' | null>(null);
  // Bearer/proof material is operational state only. Keep it out of the
  // render tree and clear it whenever this guest session stops.
  const saveReady = useRef<GuestSaveContext | null>(null);
  const [saveAvailable, setSaveAvailable] = useState(false);
  const [saved, setSaved] = useState(false);
  const session = useRef<{ stop(origin: RemoteDesktopStopOrigin): void } | null>(null);
  const invite = useRef<PersistedRemoteDesktopInviteBinding | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    if (!video.current) return;
    video.current.srcObject = stream;
    if (stream) void video.current.play().catch(() => {});
  }, [stream]);

  const startReady = async (ready: RemoteDesktopGuestReady, targetLabel: string) => {
    const proof = await createRemoteDesktopBootstrapProof(ready);
    if (!alive.current) return;
    setTarget(targetLabel);
    const attended = ready.source === REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK;
    setState(attended ? 'waiting_for_consent' : 'approved');
    // serverId is used only in this non-rendering signaling seam.
    session.current = await sessionStarter.start({
      serverId: ready.serverId,
      hostId: ready.hostId,
      mode: ready.mode,
      source: ready.source,
      bootstrapProof: proof,
      expiresAt: ready.expiresAt,
      onSnapshot: (snapshot) => {
        if (alive.current) setStream(snapshot.stream);
      },
    }, (next) => { if (alive.current) setState(next); });
  };

  const saveCurrentDevice = async () => {
    const context = saveReady.current;
    if (!context) return;
    try {
      await api.saveDevice(context);
      setSaved(true);
      saveReady.current = null;
      setSaveAvailable(false);
    } catch (reason) {
      setError(mapRemoteDesktopApiError(reason));
    }
  };

  const captureSaveContext = (ready: RemoteDesktopGuestReady, targetLabel: string) => {
    if (ready.source !== REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD) {
      saveReady.current = null;
      setSaveAvailable(false);
      return;
    }
    saveReady.current = {
      publicNodeId: targetLabel,
      bootstrapTicket: ready.bootstrapTicket,
      browserKeyThumbprint: ready.browserKey.thumbprint,
    };
    setSaveAvailable(true);
  };

  const resolveInvite = async () => {
    const currentInvite = invite.current;
    if (!currentInvite) return;
    setState('resolving');
    setError(null);
    try {
      const result = await api.resolveInvite({
        token: currentInvite.token,
        browserKey: currentInvite.browserKey,
      });
      if (result.status !== 'ready') {
        setState(result.status === 'auth_required'
          ? 'auth_required'
          : result.status === 'rate_limited' ? 'cooldown'
            : result.status === 'invitation_expired' ? 'invitation_expired'
              : result.status === 'device_offline' ? 'device_offline'
                : result.status === 'invitation_invalid' ? 'invitation_invalid' : 'invite_unavailable');
        return;
      }
      await startReady(result, t('remote_desktop.guest.invited_target'));
    } catch (reason) {
      setError(mapRemoteDesktopApiError(reason));
      setState('invite_unavailable');
    }
  };

  useEffect(() => {
    alive.current = true;
    document.getElementById('splash')?.classList.add('splash-exit');
    void bootstrap.then(async (result) => {
      const binding = result.status === 'invite'
        ? await getOrCreateRemoteDesktopInviteBinding(result.token)
        : result.status === 'resume'
          ? await loadRemoteDesktopInviteBinding(result.tokenHash)
          : null;
      if (!alive.current || !binding) return;
      invite.current = binding;
      const state = window.history.state && typeof window.history.state === 'object'
        ? window.history.state as Record<string, unknown>
        : {};
      window.history.replaceState({
        ...state,
        [REMOTE_DESKTOP_INVITE_HISTORY_STATE_KEY]: binding.tokenHash,
      }, '', '/remote-desktop/access');
      void resolveInvite();
    }).catch((reason) => {
      if (!alive.current) return;
      setError(mapRemoteDesktopApiError(reason));
      setState('unavailable');
    });
    return () => {
      alive.current = false;
      session.current?.stop(REMOTE_DESKTOP_STOP_ORIGIN.GUEST_UNMOUNT);
      session.current = null;
      invite.current = null;
      saveReady.current = null;
      setStream(null);
      setPassword('');
    };
  }, []);

  const provePassword = async (event: Event) => {
    event.preventDefault();
    setState('resolving');
    setError(null);
    const targetLabel = publicNodeId;
    try {
      const browserKey = await newRemoteDesktopGuestBrowserKey();
      const result = await api.provePassword({
        publicNodeId: Number(publicNodeId), password, browserKey,
      });
      setPassword('');
      if (result.status !== 'ready') {
        if (result.status === 'auth_required') replacePublicNodeIdHistoryState(targetLabel);
        setState(result.status === 'auth_required'
          ? 'auth_required'
          : result.status === 'rate_limited' ? 'cooldown'
            : result.status === 'device_offline' ? 'device_offline'
              : result.status === 'password_invalid' ? 'password_invalid' : 'password_unavailable');
        return;
      }
      replacePublicNodeIdHistoryState(null);
      captureSaveContext(result, targetLabel);
      setSaved(false);
      await startReady(result, targetLabel);
    } catch (reason) {
      setPassword('');
      setError(mapRemoteDesktopApiError(reason));
      setState('password_unavailable');
    }
  };

  const retryOrReset = () => {
    session.current?.stop(REMOTE_DESKTOP_STOP_ORIGIN.GUEST_RETRY);
    session.current = null;
    setStream(null);
    setTarget(null);
    saveReady.current = null;
    setSaveAvailable(false);
    setSaved(false);
    setError(null);
    if (invite.current) {
      void resolveInvite();
      return;
    }
    setState('idle');
  };

  // Authentication stays in this same-origin tab. Successful LoginPage flows
  // reload this exact scrubbed path; history.state then recovers the token hash
  // and IndexedDB decrypts the bearer. No caller-controlled redirect is used.
  if (authMode) {
    return (
      <div class="remote-desktop-guest-auth">
        <button type="button" class="remote-desktop-guest-auth-back" onClick={() => setAuthMode(null)}>
          <span aria-hidden="true">←</span>
          <span>{t('remote_desktop.guest.back_to_invitation')}</span>
        </button>
        <LoginPage
          initialMode={authMode === 'register' ? 'register' : 'buttons'}
          showGithub={false}
        />
      </div>
    );
  }

  return (
    <main class="remote-desktop-guest" aria-labelledby="remote-desktop-guest-title">
      <section class="remote-desktop-guest-card">
        <button type="button" class="remote-desktop-guest-exit" onClick={onExit}>
          <span aria-hidden="true">←</span>
          <span>{t('remote_desktop.guest.back_to_imcodes')}</span>
        </button>
        <img src="/imcodes-robot-avatar.png" alt="" aria-hidden="true" />
        <h1 id="remote-desktop-guest-title">{t('remote_desktop.guest.title')}</h1>
        <p>{t('remote_desktop.guest.subtitle')}</p>

        {state === 'idle' && <form onSubmit={(event) => void provePassword(event)}>
          <label>{t('remote_desktop.guest.public_id')}
            <input inputMode="numeric" pattern="[5-9][0-9]{9}" maxLength={10} autoComplete="off" required value={publicNodeId} onInput={(event) => setPublicNodeId(event.currentTarget.value.replace(/\D/g, '').slice(0, 10))} />
          </label>
          <label>{t('remote_desktop.guest.password')}
            <input type="password" minLength={12} maxLength={256} autoComplete="current-password" required value={password} onInput={(event) => setPassword(event.currentTarget.value)} />
          </label>
          <button type="submit" disabled={!/^[5-9]\d{9}$/.test(publicNodeId) || new TextEncoder().encode(password).length < 12}>{t('remote_desktop.guest.connect')}</button>
        </form>}

        {state !== 'idle' && <div class="remote-desktop-guest-state" role="status" aria-live="polite">
          <strong>{t(`remote_desktop.guest.state_${state}`)}</strong>
          {target && <p>{t('remote_desktop.guest.target', { target })}</p>}
          {state === 'waiting_for_consent' && <p>{t('remote_desktop.guest.waiting_help')}</p>}
          {saveAvailable && !saved && (state === 'approved' || state === 'waiting_for_consent') && <button type="button" onClick={() => void saveCurrentDevice()}>
            {t('remote_desktop.guest.save_device')}
          </button>}
          {saved && <p role="status">{t('remote_desktop.guest.saved_device')}</p>}
          {state === 'auth_required' && <>
            <p>{t('remote_desktop.guest.auth_required_help')}</p>
            <div class="remote-desktop-guest-auth-actions">
              <button type="button" onClick={() => setAuthMode('login')}>
                {t('remote_desktop.guest.sign_in')}
              </button>
              <button type="button" onClick={() => setAuthMode('register')}>
                {t('remote_desktop.guest.register')}
              </button>
            </div>
          </>}
          {(state === 'unavailable' || state === 'invite_unavailable' || state === 'password_unavailable'
            || state === 'invitation_invalid' || state === 'invitation_expired'
            || state === 'password_invalid' || state === 'device_offline'
            || state === 'cooldown' || state === 'denied' || state === 'timeout' || state === 'cancelled')
            && <button type="button" onClick={retryOrReset}>{t('remote_desktop.guest.try_again')}</button>}
        </div>}
        {stream && <video
          ref={video}
          class="remote-desktop-guest-video"
          autoplay
          playsInline
          aria-label={t('remote_desktop.guest.remote_screen')}
        />}
        {error && <p class="remote-desktop-access-alert" role="alert">{t('remote_desktop.guest.generic_error')}</p>}
        <p class="remote-desktop-guest-boundary">{t('remote_desktop.guest.boundary')}</p>
      </section>
    </main>
  );
}
