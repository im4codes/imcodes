/**
 * OfficePreview — embedded ONLYOFFICE Document Server viewer/collaborative editor
 * with automatic fallback to lazy-loaded local previewers (PDF, DOCX, XLSX).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  downloadCloudDocApi,
  fetchCloudDocOnlyOfficeConfig,
  fetchOnlyOfficeConfig,
  mintCloudDocDownloadUrl,
  type OnlyOfficeConfigResponse,
} from '../api.js';

export interface OfficePreviewProps {
  /**
   * Chunked HTTP download URL for local fallback preview.
   * Optional when `serverId` is provided and ONLYOFFICE is active.
   */
  srcUrl?: string;
  /** MIME type (application/pdf, .../wordprocessingml.document, .../spreadsheetml.sheet). */
  mimeType: string;
  /** File path — used for display, extension detection, and ONLYOFFICE config lookup. */
  path: string;
  /** Target server ID — enables embedded ONLYOFFICE preview/collaborative editing when configured. */
  serverId?: string;
  /** Optional Cloud Doc ID — opens independent server-stored Cloud Document in ONLYOFFICE / fallback preview. */
  cloudDocId?: string;
  /** Optional external share token for external collaborator access. */
  shareToken?: string;
  /** Optional bound device token for device-locked external links. */
  deviceToken?: string;
  /** Optional session name for main/sub session-share coverage resolution. */
  sessionName?: string;
  /** Force read-only view mode (e.g., viewer session share). */
  readOnly?: boolean;
  /** Optional initial mode preference ('view' | 'edit'). */
  initialMode?: 'view' | 'edit';
  /** Optional callback to open the document share dialog. */
  onOpenShare?: () => void;
}

declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: new (placeholderId: string, config: Record<string, unknown>) => {
        destroyEditor?: () => void;
      };
    };
  }
}

async function fetchArrayBuffer(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
}

const scriptLoadPromises = new Map<string, Promise<void>>();

export function loadOnlyOfficeScript(scriptUrl: string): Promise<void> {
  if (typeof window !== 'undefined' && window.DocsAPI?.DocEditor) {
    return Promise.resolve();
  }
  const existing = scriptLoadPromises.get(scriptUrl);
  if (existing) return existing;

  const promise = new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') {
      scriptLoadPromises.delete(scriptUrl);
      reject(new Error('Document is unavailable'));
      return;
    }
    if (window.DocsAPI?.DocEditor) {
      resolve();
      return;
    }
    const existingTag = document.querySelector(`script[data-onlyoffice-src="${scriptUrl}"]`) as HTMLScriptElement | null;
    if (existingTag) {
      existingTag.remove();
    }
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.dataset.onlyofficeSrc = scriptUrl;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoadPromises.delete(scriptUrl);
      script.remove();
      reject(new Error('Failed to load ONLYOFFICE API script'));
    };
    document.head.appendChild(script);
  });

  scriptLoadPromises.set(scriptUrl, promise);
  return promise;
}

export function isLocallyPreviewableFormat(filePath: string, mimeType: string): boolean {
  const lowerPath = filePath.toLowerCase();
  if (mimeType === 'application/pdf' || lowerPath.endsWith('.pdf')) return true;
  if (mimeType.includes('wordprocessingml') || lowerPath.endsWith('.docx')) return true;
  if (
    mimeType.includes('spreadsheetml')
    || mimeType === 'text/csv'
    || lowerPath.endsWith('.xlsx')
    || lowerPath.endsWith('.xls')
    || lowerPath.endsWith('.csv')
    || lowerPath.endsWith('.ods')
  ) {
    return true;
  }
  if (
    mimeType.startsWith('text/')
    || lowerPath.endsWith('.md')
    || lowerPath.endsWith('.txt')
    || lowerPath.endsWith('.rtf')
  ) {
    return true;
  }
  return false;
}

let pdfWorkerBlobUrl: string | null = null;
let pdfWorkerSrcPromise: Promise<string> | null = null;

export function getPdfWorkerSrc(): Promise<string> {
  if (pdfWorkerBlobUrl) return Promise.resolve(pdfWorkerBlobUrl);
  if (!pdfWorkerSrcPromise) {
    pdfWorkerSrcPromise = (async () => {
      if (
        typeof Blob === 'undefined'
        || typeof URL === 'undefined'
        || typeof URL.createObjectURL !== 'function'
      ) {
        throw new Error('PDF worker Blob URLs are unavailable in this browser');
      }
      const { default: pdfWorkerSource } = await import('pdfjs-dist/build/pdf.worker.min.mjs?raw');
      pdfWorkerBlobUrl = URL.createObjectURL(new Blob([pdfWorkerSource], { type: 'text/javascript' }));
      return pdfWorkerBlobUrl;
    })().catch((err) => {
      pdfWorkerSrcPromise = null;
      throw err;
    });
  }
  return pdfWorkerSrcPromise;
}

function PdfPreview({ data }: { data: ArrayBuffer }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let pdfDoc: any = null;
    let renderGeneration = 0;

    async function renderPages(width: number) {
      if (cancelled || !pdfDoc || !container || width < 10) return;
      const generation = ++renderGeneration;
      container.innerHTML = '';
      const dpr = window.devicePixelRatio || 1;
      const maxPages = Math.min(pdfDoc.numPages, 20);
      for (let i = 1; i <= maxPages; i++) {
        const page = await pdfDoc.getPage(i);
        if (cancelled || generation !== renderGeneration) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = (width / baseViewport.width) * dpr;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.dataset.pdfPageNumber = String(i);
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${Math.round(viewport.height / dpr)}px`;
        canvas.style.display = 'block';
        canvas.style.marginBottom = '8px';
        canvas.style.borderRadius = '2px';
        canvas.style.boxShadow = '0 1px 4px rgba(0,0,0,0.3)';
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvasContext: ctx, viewport, canvas } as any).promise;
        if (cancelled || generation !== renderGeneration) return;
        container.appendChild(canvas);
      }
      if (cancelled || generation !== renderGeneration) return;
      if (pdfDoc.numPages > maxPages) {
        const note = document.createElement('div');
        note.style.cssText = 'text-align:center;color:#64748b;padding:12px;font-size:12px';
        note.textContent = `Showing ${maxPages} of ${pdfDoc.numPages} pages`;
        container.appendChild(note);
      }
    }

    // Load PDF once, then render reactively via ResizeObserver
    (async () => {
      try {
        const pdfjsLib = await import('pdfjs-dist');
        const workerSrc = await getPdfWorkerSrc();
        if (cancelled) return;
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
        pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
        if (cancelled) return;
        // Initial render at current width
        const w = container.clientWidth;
        if (w > 10) await renderPages(w);
      } catch (e) {
        if (!cancelled) setError(`PDF preview failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();

    // ResizeObserver re-renders when container width changes
    let lastWidth = 0;
    let resizeTimer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      if (w < 10 || Math.abs(w - lastWidth) < 6) return;
      lastWidth = w;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (pdfDoc) renderPages(w); }, 150);
    });
    observer.observe(container);

    return () => {
      cancelled = true;
      renderGeneration += 1;
      observer.disconnect();
      clearTimeout(resizeTimer);
    };
  }, [data, retryKey]);

  if (error) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <div style={{ color: '#f87171', marginBottom: 12, fontSize: 13 }}>{error}</div>
        <button onClick={() => { setError(null); setRetryKey((k) => k + 1); }}
          style={{ padding: '6px 16px', background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
          Retry
        </button>
      </div>
    );
  }
  return <div ref={containerRef} style={{ overflow: 'auto', width: '100%', height: '100%' }} />;
}

function DocxPreview({ data }: { data: ArrayBuffer }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const docxPreview = await import('docx-preview');
        if (cancelled || !containerRef.current) return;
        const buf = data;
        await docxPreview.renderAsync(buf, containerRef.current, undefined, {
          ignoreWidth: true,
          ignoreHeight: true,
          ignoreFonts: false,
        });
        // Force all docx-preview wrapper sections to fill width
        const sections = containerRef.current.querySelectorAll('section');
        for (const s of sections) {
          (s as HTMLElement).style.width = '100%';
          (s as HTMLElement).style.maxWidth = '100%';
          (s as HTMLElement).style.padding = '12px';
          (s as HTMLElement).style.boxSizing = 'border-box';
        }
      } catch (e) {
        if (!cancelled) setError(`DOCX preview failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [data]);

  if (error) return <div style={{ color: '#f87171', padding: 12 }}>{error}</div>;
  return <div ref={containerRef} style={{ overflow: 'auto', width: '100%', background: '#fff', color: '#000', borderRadius: 4 }} />;
}

function XlsxPreview({ data }: { data: ArrayBuffer }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [XLSX, { default: DOMPurify }] = await Promise.all([
          import('xlsx'),
          import('dompurify'),
        ]);
        const wb = XLSX.read(data, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        if (!sheet) { setError('Empty workbook'); return; }
        // `sheet_to_html` builds markup out of attacker-controlled cell text and
        // the result is injected with dangerouslySetInnerHTML below, so it is a
        // direct XSS sink for any spreadsheet a user opens. The npm `xlsx`
        // package is frozen at 0.18.5 (SheetJS publishes fixes only on its own
        // CDN), so the escaping upstream cannot be relied on — sanitize here.
        const tableHtml = DOMPurify.sanitize(
          XLSX.utils.sheet_to_html(sheet, { editable: false }),
          { USE_PROFILES: { html: true } },
        );
        if (!cancelled) setHtml(tableHtml);
      } catch (e) {
        if (!cancelled) setError(`XLSX preview failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [data]);

  if (error) return <div style={{ color: '#f87171', padding: 12 }}>{error}</div>;
  if (!html) return <div style={{ padding: 12, color: '#64748b' }}>Loading...</div>;
  return (
    <div
      style={{ overflow: 'auto', padding: '8px', background: '#fff', color: '#000', borderRadius: 4, fontSize: 12 }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function OnlyOfficeEmbeddedEditor({
  ooConfig,
  mode,
  onModeChange,
  isFullscreen,
  onToggleFullscreen,
  onFallbackLocal,
  onAutoFallbackLocal,
  onOpenShare,
  downloadUrl,
  onDownload,
}: {
  ooConfig: OnlyOfficeConfigResponse;
  mode: 'view' | 'edit';
  onModeChange: (next: 'view' | 'edit') => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onFallbackLocal?: () => void;
  onAutoFallbackLocal?: (reason: string) => void;
  onOpenShare?: () => void;
  downloadUrl?: string;
  onDownload?: () => void;
}) {
  const { t } = useTranslation();
  const holderIdRef = useRef(`onlyoffice-editor-${Math.random().toString(36).slice(2, 10)}`);
  const editorInstanceRef = useRef<{ destroyEditor?: () => void } | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setScriptError(null);
    if (!ooConfig.config || !ooConfig.scriptUrl) return;

    (async () => {
      try {
        await loadOnlyOfficeScript(ooConfig.scriptUrl!);
        if (cancelled) return;
        if (!window.DocsAPI?.DocEditor) {
          throw new Error('DocsAPI.DocEditor is unavailable');
        }
        if (editorInstanceRef.current?.destroyEditor) {
          try { editorInstanceRef.current.destroyEditor(); } catch { /* ignore */ }
        }
        editorInstanceRef.current = new window.DocsAPI.DocEditor(
          holderIdRef.current,
          ooConfig.config as unknown as Record<string, unknown>,
        );
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          if (onAutoFallbackLocal) {
            onAutoFallbackLocal(msg);
          } else {
            setScriptError(msg);
          }
        }
      }
    })();

    return () => {
      cancelled = true;
      if (editorInstanceRef.current?.destroyEditor) {
        try { editorInstanceRef.current.destroyEditor(); } catch { /* ignore */ }
        editorInstanceRef.current = null;
      }
    };
  }, [ooConfig, retryCount]);

  if (scriptError) {
    return (
      <div style={{ padding: 16, textAlign: 'center', color: '#f87171' }} data-testid="onlyoffice-script-error">
        <div style={{ marginBottom: 8 }}>{t('office_preview.onlyoffice_load_failed', 'ONLYOFFICE failed to load')}: {scriptError}</div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
          {onFallbackLocal && (
            <button
              type="button"
              data-testid="onlyoffice-error-fallback-btn"
              onClick={onFallbackLocal}
              style={{ padding: '6px 14px', background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
            >
              {t('office_preview.switch_local_preview', 'Use Local Preview')}
            </button>
          )}
          <button
            type="button"
            data-testid="onlyoffice-error-retry-btn"
            onClick={() => setRetryCount((c) => c + 1)}
            style={{ padding: '6px 14px', background: '#334155', color: '#e2e8f0', border: '1px solid #475569', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
          >
            {t('common.retry', 'Retry')}
          </button>
        </div>
      </div>
    );
  }

  const canEdit = ooConfig.role === 'editor';
  const allowDownload = ooConfig.allowDownload;
  const effectiveDownloadUrl = downloadUrl || ooConfig.config?.document?.url;

  return (
    <div
      data-testid="onlyoffice-embedded-wrapper"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: isFullscreen ? '100vh' : '100%',
        minHeight: isFullscreen ? '100vh' : 480,
        position: isFullscreen ? 'fixed' : 'relative',
        inset: isFullscreen ? 0 : undefined,
        zIndex: isFullscreen ? 9999 : undefined,
        background: '#0f172a',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '6px 12px',
          background: '#1e293b',
          borderBottom: '1px solid #334155',
          fontSize: 12,
          color: '#e2e8f0',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 600,
              background: canEdit ? '#065f46' : '#334155',
              color: canEdit ? '#6ee7b7' : '#cbd5e1',
            }}
          >
            {canEdit
              ? t('office_preview.role_editor', 'Collaborative Editor')
              : t('office_preview.role_viewer', 'Read-only Viewer')}
          </span>
          {canEdit && (
            <div style={{ display: 'inline-flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #475569' }}>
              <button
                type="button"
                data-testid="onlyoffice-mode-view"
                onClick={() => onModeChange('view')}
                style={{
                  padding: '3px 10px',
                  fontSize: 11,
                  border: 'none',
                  cursor: 'pointer',
                  background: mode === 'view' ? '#3b82f6' : 'transparent',
                  color: mode === 'view' ? '#fff' : '#cbd5e1',
                }}
              >
                {t('office_preview.mode_view', 'Preview')}
              </button>
              <button
                type="button"
                data-testid="onlyoffice-mode-edit"
                onClick={() => onModeChange('edit')}
                style={{
                  padding: '3px 10px',
                  fontSize: 11,
                  border: 'none',
                  cursor: 'pointer',
                  background: mode === 'edit' ? '#3b82f6' : 'transparent',
                  color: mode === 'edit' ? '#fff' : '#cbd5e1',
                }}
              >
                {t('office_preview.mode_edit', 'Co-Edit')}
              </button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {onOpenShare && ooConfig.canManageShare && (
            <button
              type="button"
              data-testid="onlyoffice-open-share"
              onClick={onOpenShare}
              style={{
                padding: '3px 10px',
                background: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              {t('doc_share.share_button', 'Share & Permissions')}
            </button>
          )}
          {allowDownload && onDownload ? (
            <button
              type="button"
              onClick={onDownload}
              data-testid="onlyoffice-download-link"
              style={{
                padding: '3px 10px',
                background: '#334155',
                color: '#e2e8f0',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              {t('office_preview.download', 'Download')}
            </button>
          ) : allowDownload && effectiveDownloadUrl ? (
            <a
              href={effectiveDownloadUrl}
              download={ooConfig.config?.document?.title || true}
              data-testid="onlyoffice-download-link"
              style={{
                padding: '3px 10px',
                background: '#334155',
                color: '#e2e8f0',
                textDecoration: 'none',
                borderRadius: 4,
                fontSize: 11,
              }}
            >
              {t('office_preview.download', 'Download')}
            </a>
          ) : null}
          {onFallbackLocal && (
            <button
              type="button"
              data-testid="onlyoffice-fallback-btn"
              onClick={onFallbackLocal}
              style={{
                padding: '3px 10px',
                background: 'transparent',
                color: '#94a3b8',
                border: '1px solid #334155',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              {t('office_preview.local_preview', 'Local Preview')}
            </button>
          )}
          <button
            type="button"
            data-testid="onlyoffice-fullscreen-btn"
            onClick={onToggleFullscreen}
            style={{
              padding: '3px 10px',
              background: '#334155',
              color: '#e2e8f0',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            {isFullscreen
              ? t('office_preview.exit_fullscreen', 'Exit Fullscreen')
              : t('office_preview.fullscreen', 'Fullscreen')}
          </button>
        </div>
      </div>
      <div style={{ flex: 1, width: '100%', minHeight: 420, position: 'relative' }}>
        <div id={holderIdRef.current} data-testid="onlyoffice-editor-holder" style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}

export default function OfficePreview(props: OfficePreviewProps) {
  // Reset synchronously on document/auth identity changes. An effect-only reset
  // can let the previous document's forceLocal/authorized URL/data start a new
  // download before the new config has checked its permissions.
  const identity = JSON.stringify([
    props.cloudDocId, props.serverId, props.path, props.srcUrl, props.mimeType,
    props.shareToken, props.deviceToken, props.sessionName, props.readOnly, props.initialMode,
  ]);
  return <OfficePreviewDocument key={identity} {...props} />;
}

function OfficePreviewDocument({
  srcUrl,
  mimeType,
  path,
  serverId,
  cloudDocId,
  shareToken,
  deviceToken,
  sessionName,
  readOnly,
  initialMode,
  onOpenShare,
}: OfficePreviewProps) {
  const { t } = useTranslation();
  const hasRemoteTarget = Boolean(cloudDocId || serverId);
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authDeniedError, setAuthDeniedError] = useState<string | null>(null);
  const [ooConfigError, setOoConfigError] = useState<string | null>(null);
  const [authorizedFileUrl, setAuthorizedFileUrl] = useState<string>('');
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [ooRetryKey, setOoRetryKey] = useState(0);
  const [ooState, setOoState] = useState<{
    loading: boolean;
    config: OnlyOfficeConfigResponse | null;
    forceLocal: boolean;
  }>({
    loading: hasRemoteTarget,
    config: null,
    forceLocal: false,
  });
  const effectiveInitialMode: 'view' | 'edit' = readOnly ? 'view' : (initialMode ?? 'edit');
  const [mode, setMode] = useState<'view' | 'edit'>(effectiveInitialMode);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // 1. When `cloudDocId` or `serverId` is provided, query ONLYOFFICE config first
  useEffect(() => {
    if (!hasRemoteTarget) {
      setOoState({ loading: false, config: null, forceLocal: false });
      return;
    }
    if (ooState.forceLocal) {
      setOoState((prev) => ({ ...prev, loading: false }));
      return;
    }

    let cancelled = false;
    setOoState((prev) => ({ ...prev, loading: true }));
    setAuthDeniedError(null);
    setOoConfigError(null);

    const requestPromise = cloudDocId
      ? fetchCloudDocOnlyOfficeConfig(cloudDocId, { mode: readOnly ? 'view' : mode })
      : fetchOnlyOfficeConfig(serverId!, {
          path,
          mode: readOnly ? 'view' : mode,
          shareToken,
          deviceToken,
          sessionName,
        });

    requestPromise
      .then(async (res) => {
        if (cancelled) return;
        let resolvedUrl = res.fileUrl || res.config?.document?.url || '';
        if (!resolvedUrl && cloudDocId && res.enabled === false && res.allowDownload !== false && isLocallyPreviewableFormat(path, mimeType)) {
          try {
            resolvedUrl = await mintCloudDocDownloadUrl(cloudDocId, true);
          } catch {
            // Fall through with empty resolvedUrl -> bounded error if local preview lacks source
          }
        }
        if (cancelled) return;
        if (resolvedUrl) {
          setAuthorizedFileUrl(resolvedUrl);
        }
        setOoState({
          loading: false,
          config: res,
          forceLocal: false,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = err instanceof ApiError ? err.status : 0;
        const msg = err instanceof Error ? err.message : String(err);
        if (
          status === 401 ||
          status === 403 ||
          (Boolean(cloudDocId) && status === 404) ||
          (status === 0 && /\b(401|403)\b|forbidden|unauthorized|access_denied/i.test(msg))
        ) {
          setAuthDeniedError(msg || 'Access denied');
          setOoState({
            loading: false,
            config: null,
            forceLocal: false,
          });
          return;
        }
        setOoConfigError(msg || 'Preview service unavailable');
        // A missing/disabled ONLYOFFICE route is not a document permission
        // denial. Fall back on 404 as on 5xx/network errors; the authenticated
        // document download still enforces its own access checks. Structured
        // HTTP status takes precedence over auth-shaped text in an error body.
        setOoState((prev) => ({
          loading: false,
          config: prev.config,
          forceLocal: true,
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [hasRemoteTarget, cloudDocId, serverId, path, mode, shareToken, deviceToken, sessionName, readOnly, ooState.forceLocal, ooRetryKey]);

  const useOnlyOffice =
    hasRemoteTarget &&
    !ooState.forceLocal &&
    ooState.config?.enabled === true &&
    Boolean(ooState.config?.config);

  const effectiveSrcUrl =
    authorizedFileUrl ||
    ooState.config?.fileUrl ||
    ooState.config?.config?.document?.url ||
    srcUrl ||
    '';

  const canLocalPreview = isLocallyPreviewableFormat(path, mimeType);

  // 2. Local preview ArrayBuffer fetch (runs when serverId is omitted OR when ONLYOFFICE is disabled/forced-local)
  useEffect(() => {
    if (ooState.loading || useOnlyOffice || authDeniedError) return;
    if (!effectiveSrcUrl || !canLocalPreview) return;

    const controller = new AbortController();
    setData(null);
    setError(null);
    fetchArrayBuffer(effectiveSrcUrl, controller.signal)
      .then((buf) => { if (!controller.signal.aborted) setData(buf); })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [effectiveSrcUrl, canLocalPreview, ooState.loading, useOnlyOffice, authDeniedError]);

  if (authDeniedError) {
    return (
      <div style={{ color: '#ef4444', padding: 16 }} data-testid="office-preview-auth-error">
        {authDeniedError}
      </div>
    );
  }

  if (ooState.loading) {
    return <div style={{ color: '#64748b', padding: 12 }}>…</div>;
  }

  const fileName = path.split('/').pop() || 'document';
  const handleCloudDocDownload = cloudDocId
    ? () => {
        downloadCloudDocApi(cloudDocId, fileName).catch((dlErr: unknown) => {
          setError(dlErr instanceof Error ? dlErr.message : String(dlErr));
        });
      }
    : undefined;

  if (useOnlyOffice && ooState.config) {
    return (
      <OnlyOfficeEmbeddedEditor
        ooConfig={ooState.config}
        mode={readOnly ? 'view' : ooState.config.mode}
        onModeChange={(nextMode) => {
          if (!readOnly) setMode(nextMode);
        }}
        isFullscreen={isFullscreen}
        onToggleFullscreen={() => setIsFullscreen((f) => !f)}
        onFallbackLocal={
          effectiveSrcUrl && canLocalPreview
            ? () => {
                setFallbackNotice(null);
                setOoState((s) => ({ ...s, forceLocal: true }));
              }
            : undefined
        }
        onAutoFallbackLocal={
          effectiveSrcUrl && canLocalPreview
            ? (reason) => {
                setFallbackNotice(reason);
                setOoState((s) => ({ ...s, forceLocal: true }));
              }
            : undefined
        }
        onOpenShare={onOpenShare}
        downloadUrl={handleCloudDocDownload ? undefined : effectiveSrcUrl}
        onDownload={handleCloudDocDownload}
      />
    );
  }

  const retryOnlyOfficeButton = hasRemoteTarget ? (
    <button
      type="button"
      data-testid="office-preview-retry-onlyoffice"
      onClick={() => {
        setFallbackNotice(null);
        setOoConfigError(null);
        setError(null);
        setOoState((s) => ({ ...s, forceLocal: false }));
        setOoRetryKey((k) => k + 1);
      }}
      style={{
        padding: '4px 10px',
        background: '#1e293b',
        color: '#e2e8f0',
        border: '1px solid #334155',
        borderRadius: 4,
        cursor: 'pointer',
        fontSize: 11,
      }}
    >
      {t('common.retry', 'Retry ONLYOFFICE')}
    </button>
  ) : null;

  if (!canLocalPreview) {
    const allowDl = ooState.config ? ooState.config.allowDownload : true;
    return (
      <div style={{ color: '#cbd5e1', padding: 16, textAlign: 'center' }} data-testid="office-preview-unsupported-local">
        <div style={{ marginBottom: 10 }}>
          {t('office_preview.unsupported_local_format', 'Local preview is not available for this format')}: {fileName}
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
          {allowDl && handleCloudDocDownload ? (
            <button
              type="button"
              onClick={handleCloudDocDownload}
              style={{
                padding: '6px 14px',
                background: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {t('office_preview.download', 'Download')}
            </button>
          ) : allowDl && effectiveSrcUrl ? (
            <a
              href={effectiveSrcUrl}
              download={fileName || true}
              style={{
                padding: '6px 14px',
                background: '#2563eb',
                color: '#fff',
                textDecoration: 'none',
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              {t('office_preview.download', 'Download')}
            </a>
          ) : null}
          {retryOnlyOfficeButton}
        </div>
      </div>
    );
  }

  if (!effectiveSrcUrl) {
    return (
      <div style={{ color: '#ef4444', padding: 16, textAlign: 'center' }} data-testid="office-preview-unavailable">
        <div>{ooConfigError || t('office_preview.unavailable', 'Document preview is currently unavailable')}</div>
        {retryOnlyOfficeButton && <div style={{ marginTop: 8 }}>{retryOnlyOfficeButton}</div>}
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ color: '#ef4444', padding: 12 }}>
        <div>{error}</div>
        {retryOnlyOfficeButton && <div style={{ marginTop: 8 }}>{retryOnlyOfficeButton}</div>}
      </div>
    );
  }
  if (!data) return <div style={{ color: '#64748b', padding: 12 }}>…</div>;

  const lowerPath = path.toLowerCase();
  let renderedPreview;
  if (mimeType === 'application/pdf' || lowerPath.endsWith('.pdf')) {
    renderedPreview = <PdfPreview data={data} />;
  } else if (mimeType.includes('wordprocessingml') || lowerPath.endsWith('.docx')) {
    renderedPreview = <DocxPreview data={data} />;
  } else if (
    mimeType.includes('spreadsheetml')
    || mimeType === 'text/csv'
    || lowerPath.endsWith('.xlsx')
    || lowerPath.endsWith('.xls')
    || lowerPath.endsWith('.csv')
    || lowerPath.endsWith('.ods')
  ) {
    renderedPreview = <XlsxPreview data={data} />;
  } else if (
    mimeType.startsWith('text/')
    || lowerPath.endsWith('.md')
    || lowerPath.endsWith('.txt')
    || lowerPath.endsWith('.rtf')
  ) {
    const textContent = new TextDecoder('utf-8').decode(new Uint8Array(data));
    renderedPreview = (
      <pre
        data-testid="office-preview-text-fallback"
        style={{
          overflow: 'auto',
          padding: 12,
          background: '#0f172a',
          color: '#e2e8f0',
          borderRadius: 4,
          fontSize: 12,
          whiteSpace: 'pre-wrap',
          margin: 0,
        }}
      >
        {textContent}
      </pre>
    );
  } else {
    renderedPreview = <div style={{ color: '#64748b', padding: 12 }}>Unsupported format: {path.split('/').pop()}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      {(fallbackNotice || ooState.forceLocal) && hasRemoteTarget && (
        <div
          data-testid="office-preview-local-fallback-bar"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '6px 12px',
            background: '#1e293b',
            borderBottom: '1px solid #334155',
            fontSize: 12,
            color: '#cbd5e1',
          }}
        >
          <span>
            {fallbackNotice
              ? `${t('office_preview.onlyoffice_load_failed', 'ONLYOFFICE unavailable')} — ${t('office_preview.local_preview', 'Local Preview')}`
              : t('office_preview.local_preview', 'Local Preview')}
          </span>
          {retryOnlyOfficeButton}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{renderedPreview}</div>
    </div>
  );
}
