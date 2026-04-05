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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjsLib = await import('pdfjs-dist');
        // Vite ?url suffix emits the worker as a hashed asset and returns its URL
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
        const pdf = await pdfjsLib.getDocument({ data: base64ToArrayBuffer(data) }).promise;
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = '';

        // Measure container width to calculate the correct scale
        const containerWidth = containerRef.current.clientWidth || 360;
        const dpr = window.devicePixelRatio || 1;

        const maxPages = Math.min(pdf.numPages, 20);
        for (let i = 1; i <= maxPages; i++) {
          const page = await pdf.getPage(i);
          // Scale so the page exactly fills the container width
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = (containerWidth / baseViewport.width) * dpr;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          // CSS size = container width, canvas pixel size = containerWidth * dpr (sharp on retina)
          canvas.style.width = `${containerWidth}px`;
          canvas.style.height = 'auto';
          canvas.style.display = 'block';
          canvas.style.marginBottom = '4px';
          const ctx = canvas.getContext('2d')!;
          await page.render({ canvasContext: ctx, viewport, canvas } as any).promise;
          if (cancelled) return;
          containerRef.current?.appendChild(canvas);
        }
        if (pdf.numPages > maxPages) {
          const note = document.createElement('div');
          note.style.cssText = 'text-align:center;color:#64748b;padding:12px;font-size:12px';
          note.textContent = `Showing ${maxPages} of ${pdf.numPages} pages`;
          containerRef.current?.appendChild(note);
        }
      } catch (e) {
        if (!cancelled) setError(`PDF preview failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [data]);

  if (error) return <div style={{ color: '#f87171', padding: 12 }}>{error}</div>;
  return <div ref={containerRef} style={{ overflow: 'auto', width: '100%' }} />;
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
