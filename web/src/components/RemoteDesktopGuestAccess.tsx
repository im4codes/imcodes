import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { REMOTE_DESKTOP_ACTOR_SOURCE } from '@shared/remote-desktop-access.js';
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
  | 'unavailable';

export function RemoteDesktopGuestAccess({
  bootstrap = Promise.resolve({ status: 'unavailable' }),
  api = createRemoteDesktopAccessApi(),
  sessionStarter = remoteDesktopGuestSessionStarter,
  onExit = () => window.location.replace('/'),
}: RemoteDesktopGuestAccessProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<GuestUiState>('idle');
  const [publicNodeId, setPublicNodeId] = useState('');
  const [password, setPassword] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const session = useRef<{ stop(): void } | null>(null);
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

  const resolveInvite = async (token: string) => {
    setState('resolving');
    setError(null);
    try {
      const browserKey = await newRemoteDesktopGuestBrowserKey();
      const result = await api.resolveInvite({ token, browserKey });
      if (result.status !== 'ready') {
        setState(result.status === 'rate_limited' ? 'cooldown' : 'unavailable');
        return;
      }
      await startReady(result, t('remote_desktop.guest.invited_target'));
    } catch (reason) {
      setError(mapRemoteDesktopApiError(reason));
      setState('unavailable');
    }
  };

  useEffect(() => {
    alive.current = true;
    document.getElementById('splash')?.classList.add('splash-exit');
    void bootstrap.then((result) => {
      if (alive.current && result.status === 'invite') void resolveInvite(result.token);
    });
    return () => {
      alive.current = false;
      session.current?.stop();
      session.current = null;
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
        setState(result.status === 'rate_limited' ? 'cooldown' : 'unavailable');
        return;
      }
      await startReady(result, targetLabel);
    } catch (reason) {
      setPassword('');
      setError(mapRemoteDesktopApiError(reason));
      setState('unavailable');
    }
  };

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
          {(state === 'unavailable' || state === 'cooldown' || state === 'denied' || state === 'timeout' || state === 'cancelled') && <button type="button" onClick={() => { setState('idle'); setTarget(null); setError(null); }}>{t('remote_desktop.guest.try_again')}</button>}
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
