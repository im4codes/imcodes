import { REMOTE_DESKTOP_STATE } from '@shared/remote-desktop.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { RemoteDesktopWallHost } from '../api/remote-desktop-wall.js';
import type { RemoteDesktopSnapshot } from '../remote-desktop-client.js';
import type { RemoteDesktopConnectionManager } from '../remote-desktop-connection-manager.js';

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
  onActivate(host: RemoteDesktopWallHost): void;
  onRemove(hostId: string): void;
  onMove(hostId: string, direction: -1 | 1): void;
  first: boolean;
  last: boolean;
}

export function RemoteDesktopWallTile({
  host,
  manager,
  wallVisible,
  pressurePaused = false,
  onActivate,
  onRemove,
  onMove,
  first,
  last,
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
      onClick={() => onActivate(host)}
    >
      <header>
        <button
          type="button"
          class="remote-desktop-wall-tile-open"
          aria-label={t('remote_desktop.wall_open_host', { machine: host.displayName })}
          onClick={(event) => { event.stopPropagation(); onActivate(host); }}
        ><strong>{host.displayName}</strong></button>
        <span class="remote-desktop-wall-health">{t(`remote_desktop.wall_health_${health}`)}</span>
      </header>
      <video ref={videoRef} muted playsInline aria-label={t('remote_desktop.video_label', { machine: host.displayName })} />
      <dl class="remote-desktop-wall-diagnostics">
        <div><dt>{t('remote_desktop.wall_route')}</dt><dd>{snapshot.route ?? '—'}</dd></div>
        <div><dt>FPS</dt><dd>{snapshot.quality?.fps.toFixed(0) ?? '—'}</dd></div>
        <div><dt>{t('remote_desktop.wall_resolution')}</dt><dd>{snapshot.quality ? `${snapshot.quality.width}×${snapshot.quality.height}` : '—'}</dd></div>
        <div><dt>{t('remote_desktop.wall_latency')}</dt><dd>{snapshot.quality ? `${snapshot.quality.rttMs.toFixed(0)} ms` : '—'}</dd></div>
        <div><dt>{t('remote_desktop.wall_bitrate')}</dt><dd>{snapshot.quality ? `${(snapshot.quality.bitrateBps / 1_000_000).toFixed(1)} Mbps` : '—'}</dd></div>
        <div><dt>{t('remote_desktop.wall_frame_age')}</dt><dd>{lastFrameAt ? `${Math.max(0, clock - lastFrameAt)} ms` : '—'}</dd></div>
      </dl>
      <footer onClick={(event) => event.stopPropagation()}>
        <button type="button" disabled={first} onClick={() => onMove(host.hostId, -1)} aria-label={t('remote_desktop.wall_move_before', { machine: host.displayName })}>←</button>
        <button type="button" disabled={last} onClick={() => onMove(host.hostId, 1)} aria-label={t('remote_desktop.wall_move_after', { machine: host.displayName })}>→</button>
        <button type="button" onClick={() => manager.presentation(host, presentationRef.current).retry()}>{t('remote_desktop.retry')}</button>
        <button type="button" onClick={() => onRemove(host.hostId)} aria-label={t('remote_desktop.wall_remove', { machine: host.displayName })}>×</button>
      </footer>
    </article>
  );
}
