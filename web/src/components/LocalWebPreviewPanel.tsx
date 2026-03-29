import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { isNative } from '../native.js';
import {
  buildLocalWebPreviewProxyUrl,
  closeLocalWebPreview,
  createLocalWebPreview,
  normalizeLocalWebPreviewPath,
} from '../api.js';

interface Props {
  serverId: string;
  port?: string | number;
  path?: string;
  onDraftChange?: (draft: { port: string; path: string }) => void;
}

interface ActivePreview {
  previewId: string;
  previewUrl: string;
}

function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function LocalWebPreviewPanel({ serverId, port, path, onDraftChange }: Props) {
  const { t } = useTranslation();
  const [portText, setPortText] = useState(() => String(port ?? ''));
  const [pathText, setPathText] = useState(() => path ?? '/');
  const [preview, setPreview] = useState<ActivePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const currentPreviewRef = useRef<ActivePreview | null>(null);
  const autoOpenAttemptedRef = useRef(false);

  useEffect(() => {
    setPortText(String(port ?? ''));
  }, [port]);

  useEffect(() => {
    setPathText(path ?? '/');
  }, [path]);

  // Use ref to avoid infinite loop: onDraftChange is a new closure every render
  // from the pinned panel registry, so including it in deps would cause re-render cycles.
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  useEffect(() => {
    onDraftChangeRef.current?.({ port: portText, path: pathText });
  }, [portText, pathText]);

  const normalizedPath = useMemo(() => normalizeLocalWebPreviewPath(pathText), [pathText]);
  const parsedPort = useMemo(() => parsePort(portText), [portText]);
  const isReady = !!serverId && parsedPort !== null;

  const closePreview = useCallback(async (previewToClose: ActivePreview | null = currentPreviewRef.current) => {
    const next = previewToClose;
    requestSeqRef.current += 1;
    currentPreviewRef.current = null;
    setPreview(null);
    setIframeLoaded(false);
    setLoading(false);
    setError(null);
    if (!next) return;
    try {
      await closeLocalWebPreview(serverId, next.previewId);
    } catch {
      // Closing a stale preview is best-effort only.
    }
  }, [serverId]);

  const openPreview = useCallback(async () => {
    const portNum = parsePort(portText);
    if (!serverId) {
      setError(t('localWebPreview.noServer'));
      return null;
    }
    if (portNum === null) {
      setError(t('localWebPreview.invalidPort'));
      return null;
    }

    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);

    try {
      const response = await createLocalWebPreview(serverId, portNum, normalizedPath);
      if (seq !== requestSeqRef.current) {
        try {
          await closeLocalWebPreview(serverId, response.previewId);
        } catch {
          // ignore stale request cleanup failures
        }
        return null;
      }

      // Always build absolute URL — server returns a relative path that breaks
      // on iOS Capacitor where the origin is capacitor://localhost, not the remote server.
      const previewUrl = buildLocalWebPreviewProxyUrl(serverId, response.previewId, normalizedPath, response.previewAccessToken);
      const nextPreview = { previewId: response.previewId, previewUrl };
      const previous = currentPreviewRef.current;
      currentPreviewRef.current = nextPreview;
      setPreview(nextPreview);
      setIframeLoaded(false);

      if (previous && previous.previewId !== response.previewId) {
        void closeLocalWebPreview(serverId, previous.previewId).catch(() => {});
      }

      return nextPreview;
    } catch (err) {
      if (seq === requestSeqRef.current) {
        const message = err instanceof Error && err.message ? err.message : t('localWebPreview.openFailed');
        setError(message);
      }
      return null;
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [normalizedPath, portText, serverId, t]);

  const handleSubmit = useCallback((e: Event) => {
    e.preventDefault();
    void openPreview();
  }, [openPreview]);

  const handleOpenInNewTab = useCallback(async () => {
    const existing = currentPreviewRef.current;
    const url = existing?.previewUrl ?? (await openPreview())?.previewUrl;
    if (!url) return;
    if (isNative()) {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url });
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, [openPreview]);

  const handleClosePreview = useCallback(() => {
    void closePreview();
  }, [closePreview]);

  useEffect(() => {
    requestSeqRef.current += 1;
    currentPreviewRef.current = null;
    setPreview(null);
    setLoading(false);
    setIframeLoaded(false);
    setError(null);
    autoOpenAttemptedRef.current = false;
    return () => {
      const next = currentPreviewRef.current;
      currentPreviewRef.current = null;
      if (!next) return;
      void closeLocalWebPreview(serverId, next.previewId).catch(() => {});
    };
  }, [serverId]);

  useEffect(() => {
    if (autoOpenAttemptedRef.current) return;
    autoOpenAttemptedRef.current = true;
    if (!isReady) return;
    void openPreview();
  }, [isReady, openPreview]);

  const [collapsed, setCollapsed] = useState(false);

  const previewStatus = preview
    ? `${t('localWebPreview.previewing')} ${preview.previewUrl}`
    : t('localWebPreview.empty');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: collapsed ? 0 : 8, height: '100%', minHeight: 0, padding: collapsed ? 0 : 10, color: '#cbd5e1' }}>
      {!collapsed && (
        <>
          <form onSubmit={handleSubmit} style={{ display: 'grid', gridTemplateColumns: '88px 1fr auto', gap: 8, alignItems: 'end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{t('localWebPreview.port')}</span>
              <input
                class="input"
                inputMode="numeric"
                placeholder="3000"
                value={portText}
                onInput={(e) => setPortText((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{t('localWebPreview.path')}</span>
              <input
                class="input"
                placeholder="/"
                value={pathText}
                onInput={(e) => setPathText((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <button class="btn btn-primary" type="submit" disabled={!isReady || loading}>
              {loading ? t('common.loading') : t('localWebPreview.open')}
            </button>
          </form>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button class="btn btn-secondary" type="button" onClick={() => void openPreview()} disabled={!isReady || loading}>
              {t('localWebPreview.refresh')}
            </button>
            <button class="btn btn-secondary" type="button" onClick={() => void handleOpenInNewTab()} disabled={!isReady || loading}>
              {t('localWebPreview.openInNewTab')}
            </button>
            <button class="btn btn-secondary" type="button" onClick={handleClosePreview} disabled={!preview && !loading}>
              {t('localWebPreview.closePreview')}
            </button>
            <span style={{ fontSize: 11, color: '#64748b' }}>
              {t('localWebPreview.sandboxNote')}
            </span>
          </div>

          {error && (
            <div style={{ color: '#fda4af', fontSize: 12, lineHeight: 1.4, background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 6, padding: '8px 10px' }}>
              {error}
            </div>
          )}
        </>
      )}

      {collapsed && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: '#1e293b', borderBottom: '1px solid #334155', flexShrink: 0 }}>
          <button class="btn btn-secondary" type="button" onClick={() => void openPreview()} disabled={!isReady || loading} style={{ padding: '2px 8px', fontSize: 11 }}>
            {t('localWebPreview.refresh')}
          </button>
          <span style={{ flex: 1, fontSize: 11, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            :{portText}{pathText !== '/' ? pathText : ''}
          </span>
          <button onClick={() => setCollapsed(false)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 14, padding: '2px 4px' }} title="Expand toolbar">▾</button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#020617', border: collapsed ? 'none' : '1px solid #1e293b', borderRadius: collapsed ? 0 : 8, overflow: 'hidden' }}>
        {!collapsed && preview && (
          <button
            onClick={() => setCollapsed(true)}
            style={{ position: 'absolute', top: 4, right: 4, zIndex: 10, background: 'rgba(15,23,42,0.7)', border: '1px solid #334155', borderRadius: 4, color: '#94a3b8', cursor: 'pointer', fontSize: 12, padding: '2px 6px', lineHeight: 1 }}
            title="Collapse toolbar"
          >▴</button>
        )}
        {preview ? (
          <iframe
            key={preview.previewId}
            src={preview.previewUrl}
            title={t('localWebPreview.title')}
            sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            referrerPolicy="no-referrer"
            style={{ width: '100%', height: '100%', border: 'none', background: '#020617' }}
            onLoad={() => setIframeLoaded(true)}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', justifyContent: 'center', color: '#64748b', textAlign: 'center', padding: 24 }}>
            <div style={{ fontSize: 28 }}>🌐</div>
            <div style={{ maxWidth: 360, fontSize: 13, lineHeight: 1.5 }}>{previewStatus}</div>
          </div>
        )}

        {preview && !iframeLoaded && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#020617', color: '#94a3b8', pointerEvents: 'none' }}>
            {t('localWebPreview.opening')}
          </div>
        )}
      </div>
    </div>
  );
}
