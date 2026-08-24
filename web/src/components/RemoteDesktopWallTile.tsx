import { REMOTE_DESKTOP_STATE } from '@shared/remote-desktop.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { RemoteDesktopWallHost } from '../api/remote-desktop-wall.js';
import type { RemoteDesktopSnapshot } from '../remote-desktop-client.js';
import type { RemoteDesktopConnectionManager } from '../remote-desktop-connection-manager.js';
import { openRemoteDesktopWindow } from '../remote-desktop-window.js';

const INITIAL: RemoteDesktopSnapshot = {
  state: REMOTE_DESKTOP_STATE.AUTHORIZING,
  mode: 'view',
  inputEpoch: 0,
  inputEnabled: false,
  displays: [],
  layoutRevision: 0,
  stream: null,
};
const FRESH_FRAME_MS = 3_000;

export interface RemoteDesktopWallTileProps {
  host: RemoteDesktopWallHost;
  manager: RemoteDesktopConnectionManager;
  wallVisible: boolean;
  pressurePaused?: boolean;
}

export function RemoteDesktopWallTile({
  host,
  manager,
  wallVisible,
  pressurePaused = false,
}: RemoteDesktopWallTileProps) {
  const { t } = useTranslation();
  const presentationRef = useRef<object>({});
  const tileRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [snapshot, setSnapshot] = useState<RemoteDesktopSnapshot>(INITIAL);
  const [lastFrameAt, setLastFrameAt] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible');
  const [inViewport, setInViewport] = useState(true);
  const [sizeTier, setSizeTier] = useState<'compact' | 'normal'>('normal');
  const paused = pressurePaused || !wallVisible || !pageVisible || !inViewport;

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    const tile = tileRef.current;
    if (!tile) return;
    const intersection = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      setInViewport(entries[0]?.isIntersecting !== false);
    });
    intersection?.observe(tile);
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? tile.getBoundingClientRect().width;
      setSizeTier(width < 280 ? 'compact' : 'normal');
    });
    resize?.observe(tile);
    return () => { intersection?.disconnect(); resize?.disconnect(); };
  }, []);

  useEffect(() => {
    const connection = manager.presentation(host, presentationRef.current);
    const unsubscribe = connection.subscribe(presentationRef.current, setSnapshot, { controlsInput: false });
    void connection.start();
    return unsubscribe;
  }, [host.remoteDesktopHostId, host.serverId, manager]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.srcObject !== snapshot.stream) video.srcObject = snapshot.stream;
    if (paused) {
      video.pause();
    } else {
      void video.play().catch(() => {});
    }
  }, [paused, snapshot.stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const markFrame = () => setLastFrameAt(Date.now());
    video.addEventListener('timeupdate', markFrame);
    video.addEventListener('loadeddata', markFrame);
    if (typeof video.requestVideoFrameCallback !== 'function') {
      return () => {
        video.removeEventListener('timeupdate', markFrame);
        video.removeEventListener('loadeddata', markFrame);
      };
    }
    let callbackId = 0;
    const frame: VideoFrameRequestCallback = () => {
      setLastFrameAt(Date.now());
      callbackId = video.requestVideoFrameCallback(frame);
    };
    callbackId = video.requestVideoFrameCallback(frame);
    return () => {
      video.cancelVideoFrameCallback?.(callbackId);
      video.removeEventListener('timeupdate', markFrame);
      video.removeEventListener('loadeddata', markFrame);
    };
  }, [snapshot.stream]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const health = useMemo(() => {
    if (pressurePaused) return 'pressure_paused';
    if (paused) return 'paused';
    if (snapshot.state === REMOTE_DESKTOP_STATE.FAILED || snapshot.state === REMOTE_DESKTOP_STATE.STOPPED) return 'failed';
    if (snapshot.state === REMOTE_DESKTOP_STATE.RECONNECTING) return 'reconnecting';
    const connected = snapshot.state === REMOTE_DESKTOP_STATE.DIRECT || snapshot.state === REMOTE_DESKTOP_STATE.RELAYED;
    if (!connected || !snapshot.stream || lastFrameAt === 0) return 'connecting';
    return clock - lastFrameAt <= FRESH_FRAME_MS ? 'live' : 'stale';
  }, [clock, lastFrameAt, paused, pressurePaused, snapshot.state, snapshot.stream]);

  return (
    <article
      ref={tileRef}
      class="remote-desktop-wall-tile"
      data-health={health}
      data-presentation-priority={paused ? 'paused' : 'visible-wall'}
      data-route={snapshot.route ?? 'pending'}
      data-size-tier={sizeTier}
    >
      <video ref={videoRef} muted playsInline aria-label={t('remote_desktop.video_label', { machine: host.displayName })} />
      <button
        type="button"
        class="remote-desktop-wall-tile-open"
        aria-label={`${t('remote_desktop.open')}: ${host.displayName}`}
        title={`${t('remote_desktop.open')}: ${host.displayName}`}
        onClick={() => openRemoteDesktopWindow(host.serverId)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M14 5h5v5M19 5l-8 8M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </svg>
        <span>{t('remote_desktop.open')}</span>
      </button>
    </article>
  );
}
