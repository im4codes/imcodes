import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
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

  useEffect(() => {
    onDraftChange?.({ port: portText, path: pathText });
  }, [onDraftChange, portText, pathText]);

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

      const previewUrl = response.previewUrl ?? buildLocalWebPreviewProxyUrl(serverId, response.previewId, normalizedPath);
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
    if (existing?.previewUrl) {
      window.open(existing.previewUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    const tab = window.open('about:blank', '_blank', 'noopener,noreferrer');
    const next = await openPreview();
    if (next?.previewUrl) {
      if (tab) {
        tab.location.href = next.previewUrl;
      } else {
        window.open(next.previewUrl, '_blank', 'noopener,noreferrer');
      }
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

  const previewStatus = preview
    ? `${t('localWebPreview.previewing')} ${preview.previewUrl}`
    : t('localWebPreview.empty');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0, padding: 10, color: '#cbd5e1' }}>
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
        <span style={{ fontSize: 11, color: '#64748b' }}>
          {t('localWebPreview.initialPathNote')}
        </span>
      </div>

      {error && (
        <div style={{ color: '#fda4af', fontSize: 12, lineHeight: 1.4, background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 6, padding: '8px 10px' }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#020617', border: '1px solid #1e293b', borderRadius: 8, overflow: 'hidden' }}>
        {preview ? (
          <iframe
            key={preview.previewId}
            src={preview.previewUrl}
            title={t('localWebPreview.title')}
            sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts"
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
