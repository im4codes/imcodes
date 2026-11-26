import { REMOTE_DESKTOP_STATE } from '@shared/remote-desktop.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import type { RemoteDesktopWallHost } from '../api/remote-desktop-wall.js';
import { REMOTE_DESKTOP_CLIENT_ERROR, type RemoteDesktopSnapshot } from '../remote-desktop-client.js';
import type { RemoteDesktopConnectionManager } from '../remote-desktop-connection-manager.js';
import { remoteDesktopDisplayName } from '../remote-desktop-display-name.js';
import {
  cssLayoutViewportSize,
  resolveCssZoomMetrics,
} from '../remote-desktop-coords.js';

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
  retryGeneration?: number;
  onRetryableChange?(hostId: string, retryable: boolean): void;
  onOpen(host: RemoteDesktopWallHost): void;
  onRemove(hostId: string): void;
}

export function RemoteDesktopWallTile({
  host,
  manager,
  wallVisible,
  pressurePaused = false,
  retryGeneration = 0,
  onRetryableChange,
  onOpen,
  onRemove,
}: RemoteDesktopWallTileProps) {
  const { t } = useTranslation();
  const presentationRef = useRef<object>({});
  const tileRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const subscriptionKey = `${host.remoteDesktopHostId?.trim() || ''}\0${host.serverId.trim()}`;
  const activeSubscriptionRef = useRef({ key: subscriptionKey, manager });
  activeSubscriptionRef.current = { key: subscriptionKey, manager };
  const [snapshotState, setSnapshotState] = useState<{
    key: string;
    manager: RemoteDesktopConnectionManager;
    snapshot: RemoteDesktopSnapshot;
  }>(() => ({ key: subscriptionKey, manager, snapshot: INITIAL }));
  const snapshot = snapshotState.key === subscriptionKey && snapshotState.manager === manager
    ? snapshotState.snapshot
    : INITIAL;
  const [frameState, setFrameState] = useState<{
    key: string;
    manager: RemoteDesktopConnectionManager;
    stream: MediaStream | null;
    at: number;
  }>({ key: '', manager, stream: null, at: 0 });
  const lastFrameAt = frameState.key === subscriptionKey
    && frameState.manager === manager
    && frameState.stream === snapshot.stream
    && snapshot.stream !== null
    ? frameState.at
    : 0;
  const [clock, setClock] = useState(() => Date.now());
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible');
  const [inViewport, setInViewport] = useState(true);
  const [sizeTier, setSizeTier] = useState<'compact' | 'normal'>('normal');
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const lastRetryGenerationRef = useRef(retryGeneration);
  const paused = pressurePaused || !wallVisible || !pageVisible || !inViewport;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const webrtcUnavailable = snapshot.terminalReason === REMOTE_DESKTOP_CLIENT_ERROR.WEBRTC_UNAVAILABLE
    || snapshot.error === REMOTE_DESKTOP_CLIENT_ERROR.WEBRTC_UNAVAILABLE;
  const retryable = !webrtcUnavailable
    && (snapshot.state === REMOTE_DESKTOP_STATE.FAILED || snapshot.state === REMOTE_DESKTOP_STATE.STOPPED);

  const retryConnection = useCallback(() => {
    manager.presentation(host, presentationRef.current).retry();
  }, [host, manager]);

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
    const unsubscribe = connection.subscribe(
      presentationRef.current,
      (nextSnapshot) => setSnapshotState({ key: subscriptionKey, manager, snapshot: nextSnapshot }),
      { controlsInput: false },
    );
    void connection.start();
    return unsubscribe;
  }, [host.remoteDesktopHostId, host.serverId, manager, subscriptionKey]);

  useEffect(() => {
    onRetryableChange?.(host.hostId, retryable);
    return () => onRetryableChange?.(host.hostId, false);
  }, [host.hostId, onRetryableChange, retryable]);

  useEffect(() => {
    if (retryGeneration === lastRetryGenerationRef.current) return;
    lastRetryGenerationRef.current = retryGeneration;
    if (retryable) retryConnection();
  }, [retryConnection, retryGeneration, retryable]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.srcObject !== snapshot.stream) video.srcObject = snapshot.stream;
    if (paused) {
      video.pause();
    } else {
      void video.play().catch(() => {});
    }
  }, [paused, snapshot.stream, subscriptionKey, manager]);

  useEffect(() => {
    const video = videoRef.current;
    const stream = snapshot.stream;
    if (!video || paused || !stream || video.srcObject !== stream) return;
    const connection = manager.presentation(host, presentationRef.current);
    const boundKey = subscriptionKey;
    const boundHostKey = connection.hostKey;
    const boundServerId = connection.serverId;
    if (boundServerId !== host.serverId || connection.current().stream !== stream) return;

    let disposed = false;
    let callbackId: number | null = null;
    const isCurrentStreamActive = () => (
      !disposed
      && !pausedRef.current
      && activeSubscriptionRef.current.key === boundKey
      && activeSubscriptionRef.current.manager === manager
      && connection.hostKey === boundHostKey
      && connection.serverId === boundServerId
      && connection.current().stream === stream
      && video.srcObject === stream
    );
    const onFramePainted = () => {
      if (!isCurrentStreamActive()) return;
      if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
      connection.acknowledgePresentedFrame?.(video.videoWidth, video.videoHeight);
      if (!isCurrentStreamActive()) return;
      setFrameState({ key: boundKey, manager, stream, at: Date.now() });
    };

    if (typeof video.requestVideoFrameCallback !== 'function') {
      video.addEventListener('timeupdate', onFramePainted);
      video.addEventListener('loadeddata', onFramePainted);
      return () => {
        disposed = true;
        video.removeEventListener('timeupdate', onFramePainted);
        video.removeEventListener('loadeddata', onFramePainted);
      };
    }

    const frame: VideoFrameRequestCallback = () => {
      if (disposed) return;
      onFramePainted();
      if (isCurrentStreamActive()) {
        callbackId = video.requestVideoFrameCallback(frame);
      }
    };
    callbackId = video.requestVideoFrameCallback(frame);
    return () => {
      disposed = true;
      if (callbackId !== null) video.cancelVideoFrameCallback?.(callbackId);
    };
  }, [host.remoteDesktopHostId, host.serverId, manager, paused, snapshot.stream, subscriptionKey]);

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

  const openContextMenu = (clientX: number, clientY: number) => {
    const metrics = resolveCssZoomMetrics(document, window, tileRef.current);
    const viewportCss = cssLayoutViewportSize(metrics, window);
    const width = 238;
    const height = Math.min(360, 132 + snapshot.displays.length * 38);
    setMenuPosition({
      left: Math.max(8, Math.min(clientX / metrics.cssZoom, viewportCss.width - width - 8)),
      top: Math.max(8, Math.min(clientY / metrics.cssZoom, viewportCss.height - height - 8)),
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
              {remoteDesktopDisplayName(t, snapshot.displays, display)}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          retryConnection();
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
        onContextMenu={(event) => {
          event.preventDefault();
          openContextMenu(event.clientX, event.clientY);
        }}
      >
        <div
          class="remote-desktop-wall-tile-title"
          title={host.displayName}
          aria-hidden="true"
        >
          <span>{host.displayName}</span>
        </div>
        <button
          type="button"
          class="remote-desktop-wall-picture"
          aria-label={t('remote_desktop.wall_open_host', { machine: host.displayName })}
          aria-haspopup="menu"
          onClick={() => onOpen(host)}
          onKeyDown={(event) => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              const tile = tileRef.current;
              const rect = tile?.getBoundingClientRect();
              const metrics = resolveCssZoomMetrics(document, window, tile);
              openContextMenu(
                rect ? rect.left * metrics.clientPerRect : 8 * metrics.cssZoom,
                rect ? rect.top * metrics.clientPerRect : 8 * metrics.cssZoom,
              );
            }
          }}
        >
          <video ref={videoRef} muted playsInline aria-label={t('remote_desktop.video_label', { machine: host.displayName })} />
        </button>
        {health !== 'live' && (
          <div class={`remote-desktop-wall-state is-${health}`}>
            <span class="remote-desktop-wall-state-copy" role="status" aria-live="polite">
              <span class="remote-desktop-wall-status-dot" aria-hidden="true" />
              <strong>{t(`remote_desktop.wall_health_${health}`)}</strong>
            </span>
            {retryable && (
              <button
                type="button"
                class="remote-desktop-wall-tile-retry"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  retryConnection();
                }}
              >{t('remote_desktop.retry')}</button>
            )}
          </div>
        )}
      </article>
      {contextMenu}
    </>
  );
}
