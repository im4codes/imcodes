import { REMOTE_DESKTOP_STATE } from '@shared/remote-desktop.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
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
  onOpen(host: RemoteDesktopWallHost): void;
  onRemove(hostId: string): void;
}

export function RemoteDesktopWallTile({
  host,
  manager,
  wallVisible,
  pressurePaused = false,
  onOpen,
  onRemove,
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
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const paused = pressurePaused || !wallVisible || !pageVisible || !inViewport;

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    if (!menuPosition) return;
    const close = () => setMenuPosition(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('blur', close);
    };
  }, [menuPosition]);

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

  const openContextMenu = (left: number, top: number) => {
    const width = 238;
    const height = Math.min(360, 132 + snapshot.displays.length * 38);
    setMenuPosition({
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
    });
  };

  const contextMenu = menuPosition && typeof document !== 'undefined' ? createPortal(
    <div
      class="remote-desktop-wall-context-menu"
      role="menu"
      aria-label={t('remote_desktop.wall_manage', { machine: host.displayName })}
      style={{ left: menuPosition.left, top: menuPosition.top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button type="button" role="menuitem" onClick={() => { setMenuPosition(null); onOpen(host); }}>
        {t('remote_desktop.wall_open_host', { machine: host.displayName })}
      </button>
      {snapshot.displays.filter((display) => display.available).length > 1 && (
        <div class="remote-desktop-wall-context-group" role="group" aria-label={t('remote_desktop.displays')}>
          <span>{t('remote_desktop.displays')}</span>
          {snapshot.displays.filter((display) => display.available).map((display) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={snapshot.selectedDisplayId === display.id}
              key={display.id}
              onClick={() => {
                manager.connection(host).selectDisplay(display.id);
                setMenuPosition(null);
              }}
            >
              <span aria-hidden="true">{snapshot.selectedDisplayId === display.id ? '●' : '○'}</span>
              {display.label}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          manager.presentation(host, presentationRef.current).retry();
          setMenuPosition(null);
        }}
      >{t('remote_desktop.retry')}</button>
      <button
        type="button"
        role="menuitem"
        class="is-danger"
        onClick={() => { setMenuPosition(null); onRemove(host.hostId); }}
      >{t('remote_desktop.wall_remove', { machine: host.displayName })}</button>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <article
        ref={tileRef}
        class="remote-desktop-wall-tile"
        data-health={health}
        data-presentation-priority={paused ? 'paused' : 'visible-wall'}
        data-route={snapshot.route ?? 'pending'}
        data-size-tier={sizeTier}
        tabIndex={0}
        role="button"
        aria-label={t('remote_desktop.wall_open_host', { machine: host.displayName })}
        aria-haspopup="menu"
        onClick={() => onOpen(host)}
        onContextMenu={(event) => {
          event.preventDefault();
          openContextMenu(event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(host);
          }
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const rect = tileRef.current?.getBoundingClientRect();
            openContextMenu(rect?.left ?? 8, rect?.top ?? 8);
          }
        }}
      >
        <video ref={videoRef} muted playsInline aria-label={t('remote_desktop.video_label', { machine: host.displayName })} />
      </article>
      {contextMenu}
    </>
  );
}
