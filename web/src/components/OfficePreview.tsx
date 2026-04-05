/**
 * OfficePreview — lazy-loaded previewer for PDF, DOCX, and XLSX files.
 * Libraries are dynamically imported on first render to avoid bloating the main bundle.
 */
import { useEffect, useRef, useState } from 'preact/hooks';

interface Props {
  /** Base64-encoded file content. */
  data: string;
  /** MIME type (application/pdf, .../wordprocessingml.document, .../spreadsheetml.sheet). */
  mimeType: string;
  /** File path — used for display and extension detection. */
  path: string;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function PdfPreview({ data }: { data: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let pdfDoc: any = null;

    async function renderPages(width: number) {
      if (cancelled || !pdfDoc || !container || width < 10) return;
      container.innerHTML = '';
      const dpr = window.devicePixelRatio || 1;
      const maxPages = Math.min(pdfDoc.numPages, 20);
      for (let i = 1; i <= maxPages; i++) {
        const page = await pdfDoc.getPage(i);
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = (width / baseViewport.width) * dpr;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
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
        if (cancelled) return;
        container.appendChild(canvas);
      }
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
        try {
          const workerModule = await import('pdfjs-dist/build/pdf.worker.min.mjs');
          (globalThis as any).pdfjsWorker = workerModule;
        } catch {
          console.warn('PDF worker module failed to load, using main-thread fallback');
        }
        pdfDoc = await pdfjsLib.getDocument({ data: base64ToArrayBuffer(data) }).promise;
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

function DocxPreview({ data }: { data: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const docxPreview = await import('docx-preview');
        if (cancelled || !containerRef.current) return;
        const buf = base64ToArrayBuffer(data);
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

function XlsxPreview({ data }: { data: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(data, { type: 'base64' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        if (!sheet) { setError('Empty workbook'); return; }
        const tableHtml = XLSX.utils.sheet_to_html(sheet, { editable: false });
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

export default function OfficePreview({ data, mimeType, path }: Props) {
  if (mimeType === 'application/pdf') return <PdfPreview data={data} />;
  if (mimeType.includes('wordprocessingml')) return <DocxPreview data={data} />;
  if (mimeType.includes('spreadsheetml')) return <XlsxPreview data={data} />;
  return <div style={{ color: '#64748b', padding: 12 }}>Unsupported format: {path.split('/').pop()}</div>;
}
