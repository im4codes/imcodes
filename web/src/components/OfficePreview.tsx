/**
 * OfficePreview — embedded ONLYOFFICE Document Server viewer/collaborative editor
 * with automatic fallback to lazy-loaded local previewers (PDF, DOCX, XLSX).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { fetchOnlyOfficeConfig, type OnlyOfficeConfigResponse } from '../api.js';

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
  /** Optional external share token for external collaborator access. */
  shareToken?: string;
  /** Optional bound device token for device-locked external links. */
  deviceToken?: string;
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
      reject(new Error('Document is unavailable'));
      return;
    }
    if (window.DocsAPI?.DocEditor) {
      resolve();
      return;
    }
    const existingTag = document.querySelector(`script[data-onlyoffice-src="${scriptUrl}"]`) as HTMLScriptElement | null;
    if (existingTag) {
      existingTag.addEventListener('load', () => resolve(), { once: true });
      existingTag.addEventListener('error', () => reject(new Error('Failed to load ONLYOFFICE API script')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.dataset.onlyofficeSrc = scriptUrl;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoadPromises.delete(scriptUrl);
      reject(new Error('Failed to load ONLYOFFICE API script'));
    };
    document.head.appendChild(script);
  });

  scriptLoadPromises.set(scriptUrl, promise);
  return promise;
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
  onOpenShare,
  downloadUrl,
}: {
  ooConfig: OnlyOfficeConfigResponse;
  mode: 'view' | 'edit';
  onModeChange: (next: 'view' | 'edit') => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onFallbackLocal?: () => void;
  onOpenShare?: () => void;
  downloadUrl?: string;
}) {
  const { t } = useTranslation();
  const holderIdRef = useRef(`onlyoffice-editor-${Math.random().toString(36).slice(2, 10)}`);
  const editorInstanceRef = useRef<{ destroyEditor?: () => void } | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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
          setScriptError(err instanceof Error ? err.message : String(err));
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
  }, [ooConfig]);

  if (scriptError) {
    return (
      <div style={{ padding: 16, textAlign: 'center', color: '#f87171' }}>
        <div style={{ marginBottom: 8 }}>{t('office_preview.onlyoffice_load_failed', 'ONLYOFFICE failed to load')}: {scriptError}</div>
        {onFallbackLocal && (
          <button
            type="button"
            onClick={onFallbackLocal}
            style={{ padding: '6px 14px', background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
          >
            {t('office_preview.switch_local_preview', 'Use Local Preview')}
          </button>
        )}
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
          {allowDownload && effectiveDownloadUrl && (
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
          )}
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

export default function OfficePreview({
  srcUrl,
  mimeType,
  path,
  serverId,
  shareToken,
  deviceToken,
  initialMode,
  onOpenShare,
}: OfficePreviewProps) {
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ooState, setOoState] = useState<{
    loading: boolean;
    config: OnlyOfficeConfigResponse | null;
    forceLocal: boolean;
  }>({
    loading: Boolean(serverId),
    config: null,
    forceLocal: false,
  });
  const [mode, setMode] = useState<'view' | 'edit'>(initialMode ?? 'edit');
  const [isFullscreen, setIsFullscreen] = useState(false);

  // 1. When `serverId` is provided, query ONLYOFFICE config first
  useEffect(() => {
    if (!serverId || ooState.forceLocal) {
      setOoState((prev) => ({ ...prev, loading: false, config: null }));
      return;
    }

    let cancelled = false;
    setOoState((prev) => ({ ...prev, loading: true }));

    fetchOnlyOfficeConfig(serverId, {
      path,
      mode,
      shareToken,
      deviceToken,
    })
      .then((res) => {
        if (cancelled) return;
        setOoState({
          loading: false,
          config: res,
          forceLocal: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        // Fallback seamlessly to local preview when ONLYOFFICE config endpoint is unreachable or disabled
        setOoState({
          loading: false,
          config: null,
          forceLocal: true,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [serverId, path, mode, shareToken, deviceToken, ooState.forceLocal]);

  const useOnlyOffice =
    Boolean(serverId) &&
    !ooState.forceLocal &&
    ooState.config?.enabled === true &&
    Boolean(ooState.config?.config);

  const effectiveSrcUrl = srcUrl || ooState.config?.fileUrl || ooState.config?.config?.document?.url || '';

  // 2. Local preview ArrayBuffer fetch (runs when serverId is omitted OR when ONLYOFFICE is disabled/forced-local)
  useEffect(() => {
    if (ooState.loading || useOnlyOffice) return;
    if (!effectiveSrcUrl) return;

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
  }, [effectiveSrcUrl, ooState.loading, useOnlyOffice]);

  if (ooState.loading) {
    return <div style={{ color: '#64748b', padding: 12 }}>…</div>;
  }

  if (useOnlyOffice && ooState.config) {
    return (
      <OnlyOfficeEmbeddedEditor
        ooConfig={ooState.config}
        mode={ooState.config.mode}
        onModeChange={(nextMode) => setMode(nextMode)}
        isFullscreen={isFullscreen}
        onToggleFullscreen={() => setIsFullscreen((f) => !f)}
        onFallbackLocal={effectiveSrcUrl ? () => setOoState((s) => ({ ...s, forceLocal: true })) : undefined}
        onOpenShare={onOpenShare}
        downloadUrl={srcUrl}
      />
    );
  }

  if (error) return <div style={{ color: '#ef4444', padding: 12 }}>{error}</div>;
  if (!data) return <div style={{ color: '#64748b', padding: 12 }}>…</div>;
  const lowerPath = path.toLowerCase();
  if (mimeType === 'application/pdf' || lowerPath.endsWith('.pdf')) return <PdfPreview data={data} />;
  if (mimeType.includes('wordprocessingml') || lowerPath.endsWith('.docx')) return <DocxPreview data={data} />;
  if (
    mimeType.includes('spreadsheetml')
    || mimeType === 'text/csv'
    || lowerPath.endsWith('.xlsx')
    || lowerPath.endsWith('.xls')
    || lowerPath.endsWith('.csv')
    || lowerPath.endsWith('.ods')
  ) {
    return <XlsxPreview data={data} />;
  }
  return <div style={{ color: '#64748b', padding: 12 }}>Unsupported format: {path.split('/').pop()}</div>;
}
