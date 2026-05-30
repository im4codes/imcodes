import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { isNative } from '../native.js';
import {
  buildLocalWebPreviewProxyUrl,
  closeLocalWebPreview,
  createLocalWebPreview,
  normalizeLocalWebPreviewPath,
} from '../api.js';
import { stripPreviewAccessTokenFromUpstreamPath } from '@shared/preview-policy.js';
import { useLocalPreviewInputHistory } from '../hooks/useLocalPreviewInputHistory.js';

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

// Legacy single-value keys — migrated into their respective MRU history lists
// (capability local-web-preview-input-history). Kept only as migration sources.
const LOCAL_PORT_KEY = 'imcodes_local_preview_port';
const LOCAL_PATH_KEY = 'imcodes_local_preview_path';
// MRU history lists (port and path are independent).
const LOCAL_PORT_HISTORY_KEY = 'imcodes_local_preview_port_history';
const LOCAL_PATH_HISTORY_KEY = 'imcodes_local_preview_path_history';

function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** History dedup/normalize key for a port: the parsePort output as a string. */
function normalizePortForHistory(raw: string): string | null {
  const port = parsePort(raw);
  return port === null ? null : String(port);
}

/**
 * History dedup/normalize key for a path: strip the access token first (so it
 * never lands in localStorage), then run the same normalization the proxy uses.
 */
function normalizePathForHistory(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const stripped = stripPreviewAccessTokenFromUpstreamPath(normalizeLocalWebPreviewPath(trimmed));
  return stripped || null;
}

interface InputWithHistoryProps {
  value: string;
  onValue: (value: string) => void;
  history: string[];
  /** i18n key for the field's history dropdown aria-label. */
  historyLabelKey: string;
  placeholder?: string;
  inputMode?: 'numeric' | 'text';
}

/**
 * A text input with a click/focus-triggered MRU history dropdown (capability
 * local-web-preview-input-history). Mouse selection is the MVP; arrow-key /
 * Enter / Esc navigation is provided as a SHOULD-level enhancement. All
 * readable text (aria-label) goes through `t()`.
 */
function InputWithHistory({ value, onValue, history, historyLabelKey, placeholder, inputMode }: InputWithHistoryProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const hasHistory = history.length > 0;

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const choose = useCallback((item: string) => {
    onValue(item);
    close();
  }, [onValue, close]);

  // Close when focus/click leaves the field+dropdown.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [open, close]);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (!hasHistory) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, history.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && activeIndex >= 0 && activeIndex < history.length) {
        e.preventDefault();
        choose(history[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        close();
      }
    }
  }, [hasHistory, history, open, activeIndex, choose, close]);

  return (
    <div ref={containerRef} style={{ position: 'relative', minWidth: 0 }}>
      <input
        class="input"
        inputMode={inputMode}
        placeholder={placeholder}
        value={value}
        role={hasHistory ? 'combobox' : undefined}
        aria-expanded={hasHistory ? open : undefined}
        aria-haspopup={hasHistory ? 'listbox' : undefined}
        onInput={(e) => onValue((e.currentTarget as HTMLInputElement).value)}
        onFocus={() => { if (hasHistory) setOpen(true); }}
        onClick={() => { if (hasHistory) setOpen(true); }}
        onKeyDown={onKeyDown}
      />
      {open && hasHistory && (
        <ul
          role="listbox"
          aria-label={t(historyLabelKey)}
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, margin: '2px 0 0', padding: 4,
            listStyle: 'none', maxHeight: 180, overflowY: 'auto',
            background: '#0f172a', border: '1px solid #334155', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}
        >
          {history.map((item, index) => (
            <li
              key={item}
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(e) => { e.preventDefault(); choose(item); }}
              onMouseEnter={() => setActiveIndex(index)}
              style={{
                padding: '4px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 12,
                color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                background: index === activeIndex ? '#1e293b' : 'transparent',
              }}
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LocalWebPreviewPanel({ serverId, port, path, onDraftChange }: Props) {
  const { t } = useTranslation();

  // Independent MRU histories for port and path (migrating any legacy single
  // value into history[0]). Written only on successful preview creation.
  const portHistory = useLocalPreviewInputHistory(LOCAL_PORT_HISTORY_KEY, normalizePortForHistory, LOCAL_PORT_KEY);
  const pathHistory = useLocalPreviewInputHistory(LOCAL_PATH_HISTORY_KEY, normalizePathForHistory, LOCAL_PATH_KEY);
  // `commit` is referentially stable across renders (keyed only on storageKey),
  // so depending on these keeps `openPreview` stable.
  const commitPort = portHistory.commit;
  const commitPath = pathHistory.commit;

  // Controlled props must NOT clobber local history with their empty initial
  // values: seed from the prop when it is explicitly provided, otherwise from
  // the most-recent history entry (history[0]).
  const [portText, setPortText] = useState(() => (port !== undefined ? String(port) : (portHistory.mostRecent ?? '')));
  const [pathText, setPathText] = useState(() => (path !== undefined ? path : (pathHistory.mostRecent ?? '/')));
  const [preview, setPreview] = useState<ActivePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const currentPreviewRef = useRef<ActivePreview | null>(null);
  const autoOpenAttemptedRef = useRef(false);

  // Only sync from a controlled prop when it is explicitly provided (!== undefined);
  // never overwrite locally-restored input with an empty/default initial value.
  useEffect(() => {
    if (port !== undefined) setPortText(String(port));
  }, [port]);

  useEffect(() => {
    if (path !== undefined) setPathText(path);
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

      // Record successful inputs into their MRU histories (normalized/stripped
      // inside the validators). Write only on success, never on keystroke.
      commitPort(portText);
      commitPath(pathText);

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
  }, [normalizedPath, pathText, portText, serverId, t, commitPort, commitPath]);

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
              <InputWithHistory
                value={portText}
                onValue={setPortText}
                history={portHistory.history}
                historyLabelKey="localWebPreview.portHistoryLabel"
                placeholder="3000"
                inputMode="numeric"
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{t('localWebPreview.path')}</span>
              <InputWithHistory
                value={pathText}
                onValue={setPathText}
                history={pathHistory.history}
                historyLabelKey="localWebPreview.pathHistoryLabel"
                placeholder="/"
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
