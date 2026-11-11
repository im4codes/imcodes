/**
 * @vitest-environment jsdom
 */
import { cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));

/** OfficePreview fetches its bytes from the chunked download URL. */
function installFetchStub(bytes = new Uint8Array([0, 0]).buffer): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes,
  })));
}

const pdfjsApi = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?raw', () => ({
  default: '/* pdf worker source */',
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: pdfjsApi.GlobalWorkerOptions,
  getDocument: (...args: unknown[]) => pdfjsApi.getDocument(...args),
}));

// The real SheetJS escapes cell text, but the npm package is frozen at 0.18.5
// (fixes ship only on the SheetJS CDN), so the component must not depend on it.
// This mock returns markup verbatim to assert OUR sanitization does the work.
const xlsxApi = vi.hoisted(() => ({ html: '' }));

vi.mock('xlsx', () => ({
  read: () => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } }),
  utils: { sheet_to_html: () => xlsxApi.html },
}));

function installCreateObjectURL(value: ((blob: Blob) => string) | undefined): void {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value,
  });
}

function installResizeObserver(width: number): void {
  vi.stubGlobal('ResizeObserver', class {
    private readonly cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element) {
      Object.defineProperty(target, 'clientWidth', { configurable: true, value: width });
      this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect() {}
    unobserve() {}
  });
}

function installControllableResizeObserver(initialWidth: number): { trigger: (width: number) => void } {
  let callback: ResizeObserverCallback | null = null;
  let target: Element | null = null;
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: ResizeObserverCallback) {
      callback = cb;
    }
    observe(nextTarget: Element) {
      target = nextTarget;
      Object.defineProperty(nextTarget, 'clientWidth', { configurable: true, value: initialWidth });
    }
    disconnect() {
      callback = null;
      target = null;
    }
    unobserve() {}
  });
  return {
    trigger(width: number) {
      if (!callback || !target) return;
      Object.defineProperty(target, 'clientWidth', { configurable: true, value: width });
      callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('OfficePreview PDF worker setup', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    pdfjsApi.GlobalWorkerOptions.workerSrc = '';
    pdfjsApi.getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 0,
        getPage: vi.fn(),
      }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    installCreateObjectURL(originalCreateObjectURL);
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it('uses an inline blob URL for the pdf.js worker so preview does not depend on deployed asset chunks', async () => {
    installFetchStub();
    const createObjectURL = vi.fn(() => 'blob:imcodes-pdf-worker');
    installCreateObjectURL(createObjectURL);
    const { getPdfWorkerSrc } = await import('../../src/components/OfficePreview.js');

    await expect(getPdfWorkerSrc()).resolves.toBe('blob:imcodes-pdf-worker');
    await expect(getPdfWorkerSrc()).resolves.toBe('blob:imcodes-pdf-worker');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
  });

  it('reports an explicit setup error when Blob URLs are unavailable', async () => {
    installFetchStub();
    installCreateObjectURL(undefined);
    const { getPdfWorkerSrc } = await import('../../src/components/OfficePreview.js');

    await expect(getPdfWorkerSrc()).rejects.toThrow('PDF worker Blob URLs are unavailable');
  });

  it('configures PDF previews with the inline worker before opening the document', async () => {
    installFetchStub();
    installCreateObjectURL(vi.fn(() => 'blob:preview-worker'));
    installResizeObserver(320);
    const { default: OfficePreview } = await import('../../src/components/OfficePreview.js');

    render(<OfficePreview srcUrl="https://example.test/doc" mimeType="application/pdf" path="/tmp/file.pdf" />);

    await waitFor(() => expect(pdfjsApi.getDocument).toHaveBeenCalled());
    expect(pdfjsApi.GlobalWorkerOptions.workerSrc).toBe('blob:preview-worker');
    expect(pdfjsApi.getDocument.mock.calls[0]?.[0]).toMatchObject({ data: expect.any(Uint8Array) });
  });

  it('cancels stale overlapping PDF renders so resized previews do not duplicate later pages', async () => {
    installFetchStub();
    installCreateObjectURL(vi.fn(() => 'blob:preview-worker'));
    const resize = installControllableResizeObserver(320);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    const blockedPage = deferred<ReturnType<typeof makePdfPage>>();
    let getPageCallCount = 0;
    const makePdfPage = (pageNumber: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 140 * scale }),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      pageNumber,
    });
    const getPage = vi.fn((pageNumber: number) => {
      getPageCallCount += 1;
      if (getPageCallCount === 2) return blockedPage.promise;
      return Promise.resolve(makePdfPage(pageNumber));
    });
    pdfjsApi.getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
      }),
    });
    const { default: OfficePreview } = await import('../../src/components/OfficePreview.js');

    const { container } = render(<OfficePreview srcUrl="https://example.test/doc" mimeType="application/pdf" path="/tmp/file.pdf" />);
    await waitFor(() => expect(getPage).toHaveBeenCalledTimes(2));
    expect(container.querySelectorAll('canvas')).toHaveLength(1);

    resize.trigger(360);
    await new Promise((resolve) => setTimeout(resolve, 180));
    await waitFor(() => {
      expect([...container.querySelectorAll('canvas')].map((canvas) => canvas.dataset.pdfPageNumber)).toEqual(['1', '2', '3']);
    });

    blockedPage.resolve(makePdfPage(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect([...container.querySelectorAll('canvas')].map((canvas) => canvas.dataset.pdfPageNumber)).toEqual(['1', '2', '3']);
    expect([...container.querySelectorAll('canvas')].map((canvas) => canvas.style.width)).toEqual(['360px', '360px', '360px']);
  });
});

describe('OfficePreview — XLSX sanitization', () => {
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  afterEach(() => { cleanup(); });

  it('strips scripts and event handlers from spreadsheet-derived markup', async () => {
    installFetchStub();
    xlsxApi.html = '<table><tr><td><script>window.__pwned = true;</script>'
      + '<img src=x onerror="window.__pwned = true">cell</td></tr></table>';
    const { default: OfficePreview } = await import('../../src/components/OfficePreview.js');
    const { container } = render(<OfficePreview srcUrl="https://example.test/doc" mimeType={XLSX_MIME} path="/tmp/a.xlsx" />);

    await waitFor(() => expect(container.querySelector('table')).not.toBeNull());
    // A spreadsheet is attacker-controlled input rendered through
    // dangerouslySetInnerHTML; neither vector may survive.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('onerror') ?? null).toBeNull();
    expect(container.innerHTML).not.toContain('__pwned');
  });

  it('keeps ordinary table content intact', async () => {
    installFetchStub();
    xlsxApi.html = '<table><tr><td>hello</td><td>42</td></tr></table>';
    const { default: OfficePreview } = await import('../../src/components/OfficePreview.js');
    const { container } = render(<OfficePreview srcUrl="https://example.test/doc" mimeType={XLSX_MIME} path="/tmp/a.xlsx" />);

    await waitFor(() => expect(container.textContent).toContain('hello'));
    expect(container.textContent).toContain('42');
  });
});

describe('OfficePreview — Embedded ONLYOFFICE & permission controls', () => {
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  afterEach(() => {
    cleanup();
    delete (window as unknown as { DocsAPI?: unknown }).DocsAPI;
    vi.unstubAllGlobals();
  });

  it('mounts DocsAPI.DocEditor when ONLYOFFICE is enabled, enforces allowDownload, and supports view/edit mode toggle', async () => {
    const docEditorSpy = vi.fn().mockImplementation(() => ({
      destroyEditor: vi.fn(),
    }));
    (window as unknown as { DocsAPI: { DocEditor: typeof docEditorSpy } }).DocsAPI = {
      DocEditor: docEditorSpy,
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes('/onlyoffice/config')) {
        const mode = urlStr.includes('mode=view') ? 'view' : 'edit';
        return {
          ok: true,
          status: 200,
          json: async () => ({
            enabled: true,
            role: 'editor',
            allowDownload: false,
            canManageShare: true,
            isOwner: true,
            mode,
            publicUrl: 'https://im.example.com/onlyoffice',
            scriptUrl: 'https://im.example.com/onlyoffice/web-apps/apps/api/documents/api.js',
            docToken: 'doc_tok_123',
            config: {
              documentType: 'cell',
              document: {
                fileType: 'xlsx',
                key: 'collab_key_123',
                title: 'budget.xlsx',
                url: 'https://im.example.com/api/onlyoffice/file/doc_tok_123?serverId=srv-1',
                permissions: {
                  edit: mode === 'edit',
                  download: false,
                },
              },
              editorConfig: {
                mode,
                callbackUrl: 'https://im.example.com/api/onlyoffice/callback/doc_tok_123?serverId=srv-1',
                user: { id: 'owner-1', name: 'Alice' },
              },
              token: 'jwt_123',
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([0, 0]).buffer,
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { default: OfficePreview } = await import('../../src/components/OfficePreview.js');
    const onOpenShare = vi.fn();
    const { getByTestId, queryByTestId } = render(
      <OfficePreview
        srcUrl="https://example.test/budget.xlsx"
        mimeType={XLSX_MIME}
        path="/team/budget.xlsx"
        serverId="srv-1"
        onOpenShare={onOpenShare}
      />,
    );

    await waitFor(() => expect(getByTestId('onlyoffice-embedded-wrapper')).toBeTruthy());
    await waitFor(() => expect(docEditorSpy).toHaveBeenCalledTimes(1));

    // Download link must be hidden when allowDownload is false
    expect(queryByTestId('onlyoffice-download-link')).toBeNull();

    // Share button is visible for owner/canManageShare
    const shareBtn = getByTestId('onlyoffice-open-share');
    shareBtn.click();
    expect(onOpenShare).toHaveBeenCalledTimes(1);

    // Switch from Co-Edit to Preview mode -> re-fetches config with mode=view
    const viewBtn = getByTestId('onlyoffice-mode-view');
    viewBtn.click();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).includes('/onlyoffice/config') && String(u).includes('mode=view')),
      ).toBe(true),
    );
  });

  it('automatically falls back to local preview when ONLYOFFICE is disabled on the server', async () => {
    xlsxApi.html = '<table><tr><td>local-fallback-cell</td></tr></table>';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes('/onlyoffice/config')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              enabled: false,
              fallbackReason: 'onlyoffice_disabled',
              role: 'viewer',
              allowDownload: true,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([0, 0]).buffer,
        };
      }),
    );

    const { default: OfficePreview } = await import('../../src/components/OfficePreview.js');
    const { container } = render(
      <OfficePreview
        srcUrl="https://example.test/budget.xlsx"
        mimeType={XLSX_MIME}
        path="/team/budget.xlsx"
        serverId="srv-1"
      />,
    );

    await waitFor(() => expect(container.textContent).toContain('local-fallback-cell'));
  });

  it('F7: automatically falls back to local preview via authorized fileUrl when ONLYOFFICE script load fails (even without srcUrl on external shares), cleans up failed script tag, and resets forceLocal on path change', async () => {
    xlsxApi.html = '<table><tr><td>external-fileurl-fallback-ok</td></tr></table>';
    const appendSpy = vi.spyOn(document.head, 'appendChild').mockImplementation((node: Node) => {
      const el = node as HTMLScriptElement;
      if (el.tagName === 'SCRIPT') {
        setTimeout(() => {
          el.onerror?.(new Event('error'));
        }, 5);
      }
      return node;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes('/onlyoffice/config')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            enabled: true,
            role: 'viewer',
            allowDownload: true,
            canManageShare: false,
            isOwner: false,
            mode: 'view',
            publicUrl: 'https://im.example.com/onlyoffice',
            scriptUrl: 'https://broken-onlyoffice.example.com/web-apps/apps/api/documents/api.js',
            docToken: 'doc_tok_ext_1',
            fileUrl: 'https://im.example.com/api/onlyoffice/file/doc_tok_ext_1?serverId=srv-1',
            config: {
              documentType: 'cell',
              document: {
                fileType: 'xlsx',
                key: 'collab_key_ext_1',
                title: 'external.xlsx',
                url: 'https://im.example.com/api/onlyoffice/file/doc_tok_ext_1?serverId=srv-1',
                permissions: { edit: false, download: true },
              },
              editorConfig: {
                mode: 'view',
                callbackUrl: 'https://im.example.com/api/onlyoffice/callback/doc_tok_ext_1?serverId=srv-1',
                user: { id: 'ext-1', name: 'Guest' },
              },
              token: 'jwt_ext_1',
            },
          }),
        };
      }
      if (urlStr.includes('/api/onlyoffice/file/doc_tok_ext_1')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
        };
      }
      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { default: OfficePreview } = await import('../../src/components/OfficePreview.js');
    const { container, rerender, getByTestId } = render(
      <OfficePreview
        mimeType={XLSX_MIME}
        path="/team/external.xlsx"
        serverId="srv-1"
        shareToken="ext_tok_1"
      />,
    );

    // Automatically falls back to local preview using config.fileUrl even though srcUrl was not passed
    await waitFor(() => expect(container.textContent).toContain('external-fileurl-fallback-ok'));
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('/api/onlyoffice/file/doc_tok_ext_1')),
    ).toBe(true);

    // Switching to another document resets forceLocal so ONLYOFFICE editor mounts when DocsAPI is available
    appendSpy.mockRestore();
    const docEditorSpy = vi.fn().mockImplementation(() => ({ destroyEditor: vi.fn() }));
    (window as unknown as { DocsAPI: { DocEditor: typeof docEditorSpy } }).DocsAPI = {
      DocEditor: docEditorSpy,
    };

    rerender(
      <OfficePreview
        mimeType={XLSX_MIME}
        path="/team/second-doc.xlsx"
        serverId="srv-1"
        shareToken="ext_tok_1"
      />,
    );

    await waitFor(() => expect(getByTestId('onlyoffice-embedded-wrapper')).toBeTruthy());
    await waitFor(() => expect(docEditorSpy).toHaveBeenCalledTimes(1));
  });

  it('F7: refuses to downgrade 403/401/404 ONLYOFFICE config errors to local srcUrl and renders safe unsupported fallback for .pptx', async () => {
    const srcUrlFetched = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes('/onlyoffice/config') && urlStr.includes('forbidden.xlsx')) {
          return {
            ok: false,
            status: 403,
            text: async () => JSON.stringify({ error: 'forbidden', reason: 'share_revoked' }),
            json: async () => ({ error: 'forbidden', reason: 'share_revoked' }),
          };
        }
        if (urlStr.includes('/onlyoffice/config') && urlStr.includes('slides.pptx')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              enabled: false,
              fallbackReason: 'onlyoffice_disabled',
              role: 'viewer',
              allowDownload: true,
              fileUrl: 'https://im.example.com/api/onlyoffice/file/pptx_tok?serverId=srv-1',
            }),
          };
        }
        srcUrlFetched(urlStr);
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([0, 0]).buffer,
        };
      }),
    );

    const { default: OfficePreview } = await import('../../src/components/OfficePreview.js');
    const { getByTestId, rerender } = render(
      <OfficePreview
        srcUrl="https://example.test/forbidden.xlsx"
        mimeType={XLSX_MIME}
        path="/team/forbidden.xlsx"
        serverId="srv-1"
      />,
    );

    await waitFor(() => expect(getByTestId('office-preview-auth-error')).toBeTruthy());
    expect(srcUrlFetched).not.toHaveBeenCalled();

    // Now render a .pptx when ONLYOFFICE is disabled -> renders safe unsupported-local fallback with download link
    rerender(
      <OfficePreview
        mimeType="application/vnd.openxmlformats-officedocument.presentationml.presentation"
        path="/team/slides.pptx"
        serverId="srv-1"
      />,
    );

    await waitFor(() => expect(getByTestId('office-preview-unsupported-local')).toBeTruthy());
  });
});
