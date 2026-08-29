import { describe, expect, it } from 'vitest';
import { buildControlledNodeBootstrapPage } from '../src/routes/controlled-node-bootstrap-page.js';

type Listener = () => void;

class FakeElement {
  textContent = '';
  disabled = false;
  hidden = false;
  href = '';
  download = '';
  rel = '';
  value = 0;
  clicked = false;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, listener);
  }

  click(): void {
    this.clicked = true;
    this.listeners.get('click')?.();
  }

  remove(): void {}
}

class FakeXhr {
  static readonly DONE = 4;
  static current: FakeXhr | null = null;

  readyState = 1;
  status = 0;
  responseType = '';
  response: Blob | null = null;
  withCredentials = true;
  method = '';
  url = '';
  async = false;
  body = '';
  aborted = false;
  onprogress: ((event: { loaded: number; lengthComputable: boolean; total: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;
  readonly requestHeaders = new Map<string, string>();
  readonly responseHeaders = new Map<string, string>();

  constructor() {
    FakeXhr.current = this;
  }

  open(method: string, url: string, async: boolean): void {
    this.method = method;
    this.url = url;
    this.async = async;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders.set(name.toLowerCase(), value);
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders.get(name.toLowerCase()) ?? null;
  }

  send(body: string): void {
    this.body = body;
  }

  abort(): void {
    if (this.readyState === FakeXhr.DONE) return;
    this.aborted = true;
    this.readyState = FakeXhr.DONE;
    this.onabort?.();
  }

  progress(loaded: number, total?: number): void {
    this.onprogress?.({
      loaded,
      lengthComputable: total !== undefined,
      total: total ?? 0,
    });
  }

  finish(status: number, response: Blob | null, headers: Record<string, string> = {}): void {
    this.status = status;
    this.response = response;
    this.readyState = FakeXhr.DONE;
    for (const [name, value] of Object.entries(headers)) {
      this.responseHeaders.set(name.toLowerCase(), value);
    }
    this.onload?.();
  }
}

function bootstrapScript(html: string): string {
  const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  return scripts[0]?.[1] ?? '';
}

function runPage(input: { ticket?: string; now?: number; historyThrows?: boolean } = {}) {
  const ticket = input.ticket ?? 'ticket_secret_123456';
  const elements = new Map<string, FakeElement>([
    ['download-status', new FakeElement()],
    ['download-detail', new FakeElement()],
    ['download-progress', new FakeElement()],
    ['download-cancel', new FakeElement()],
  ]);
  const anchors: FakeElement[] = [];
  const pageListeners = new Map<string, Listener>();
  const replaced: string[] = [];
  const revoked: string[] = [];
  const createdBlobs: Blob[] = [];
  let objectId = 0;
  let now = input.now ?? 0;
  const document = {
    getElementById(id: string) {
      return elements.get(id) ?? null;
    },
    createElement(tag: string) {
      expect(tag).toBe('a');
      const anchor = new FakeElement();
      anchors.push(anchor);
      return anchor;
    },
    body: {
      appendChild(_element: FakeElement) {},
    },
  };
  const location = {
    hash: input.ticket === '' ? '' : `#ticket=${ticket}`,
    pathname: '/api/enroll/v2/bootstrap',
    search: '',
  };
  const history = {
    replaceState(_state: null, _title: string, url: string) {
      if (input.historyThrows) throw new Error('history unavailable');
      replaced.push(url);
    },
  };
  const objectUrl = {
    createObjectURL(blob: Blob) {
      createdBlobs.push(blob);
      objectId += 1;
      return `blob:download-${objectId}`;
    },
    revokeObjectURL(url: string) {
      revoked.push(url);
    },
  };
  const execute = new Function(
    'location',
    'history',
    'document',
    'XMLHttpRequest',
    'Intl',
    'performance',
    'URL',
    'Blob',
    'setTimeout',
    'addEventListener',
    'encodeURIComponent',
    bootstrapScript(buildControlledNodeBootstrapPage('test-nonce')),
  );
  FakeXhr.current = null;
  execute(
    location,
    history,
    document,
    FakeXhr,
    Intl,
    { now: () => now },
    objectUrl,
    Blob,
    (callback: Listener) => callback(),
    (name: string, listener: Listener) => pageListeners.set(name, listener),
    encodeURIComponent,
  );
  return {
    ticket,
    elements,
    anchors,
    pageListeners,
    replaced,
    revoked,
    createdBlobs,
    xhr: FakeXhr.current,
    setNow(value: number) {
      now = value;
    },
  };
}

describe('controlled-node bootstrap download page', () => {
  it('scrubs the fragment before POSTing and never writes the ticket into the page or query', () => {
    const runtime = runPage();
    expect(runtime.replaced).toEqual(['/api/enroll/v2/bootstrap']);
    expect(runtime.xhr).not.toBeNull();
    expect(runtime.xhr?.method).toBe('POST');
    expect(runtime.xhr?.url).toBe('/api/enroll/v2/download');
    expect(runtime.xhr?.url).not.toContain(runtime.ticket);
    expect(runtime.xhr?.body).toBe(`ticket=${encodeURIComponent(runtime.ticket)}`);
    expect(runtime.xhr?.withCredentials).toBe(false);
    expect(runtime.xhr?.requestHeaders.get('content-type')).toBe('application/x-www-form-urlencoded;charset=UTF-8');
    expect([...runtime.elements.values()].map((element) => element.textContent).join(' ')).not.toContain(runtime.ticket);
  });

  it('renders integer percent, locale-aware SI sizes and speed when total length is known', () => {
    const runtime = runPage();
    runtime.setNow(8_762);
    runtime.xhr?.progress(18_400_000, 39_200_000);

    const detail = runtime.elements.get('download-detail');
    const progress = runtime.elements.get('download-progress');
    expect(detail?.textContent).toBe('47% · 18.4 MB / 39.2 MB · 2.1 MB/s');
    expect(detail?.textContent).not.toContain('18400000');
    expect(progress?.attributes.get('aria-valuenow')).toBe('47');
  });

  it('keeps progress indeterminate and omits percent when Content-Length is unknown', () => {
    const runtime = runPage();
    runtime.setNow(500);
    runtime.xhr?.progress(1_500_000);

    const detail = runtime.elements.get('download-detail');
    const progress = runtime.elements.get('download-progress');
    expect(detail?.textContent).toBe('1.5 MB · 3 MB/s');
    expect(detail?.textContent).not.toContain('%');
    expect(progress?.attributes.has('value')).toBe(false);
    expect(progress?.attributes.has('aria-valuenow')).toBe(false);
  });

  it('downloads the exact Blob with the response filename and revokes its object URL', () => {
    const runtime = runPage();
    runtime.setNow(1_000);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    runtime.xhr?.finish(200, new Blob([bytes]), {
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': 'attachment; filename="imcodes-node-win.exe"',
    });

    expect(runtime.anchors).toHaveLength(1);
    expect(runtime.anchors[0]?.download).toBe('imcodes-node-win.exe');
    expect(runtime.anchors[0]?.href).toBe('blob:download-1');
    expect(runtime.anchors[0]?.clicked).toBe(true);
    expect(runtime.createdBlobs).toHaveLength(1);
    expect(runtime.createdBlobs[0]?.size).toBe(bytes.byteLength);
    expect(runtime.revoked).toEqual(['blob:download-1']);
    expect(runtime.elements.get('download-status')?.textContent).toBe('Download complete.');
  });

  it('fails closed for empty, failed, cancelled and oversized responses', () => {
    const empty = runPage();
    empty.xhr?.finish(200, new Blob([]));
    expect(empty.elements.get('download-status')?.textContent).toBe('The download was empty.');
    expect(empty.anchors).toHaveLength(0);

    const failed = runPage();
    failed.xhr?.finish(503, new Blob(['unavailable']));
    expect(failed.elements.get('download-status')?.textContent).toBe('Download failed. Please request a new link.');
    expect(failed.anchors).toHaveLength(0);

    const networkFailed = runPage();
    networkFailed.xhr?.onerror?.();
    expect(networkFailed.elements.get('download-status')?.textContent).toBe('Download failed. Please try again.');
    expect(networkFailed.anchors).toHaveLength(0);

    const cancelled = runPage();
    cancelled.elements.get('download-cancel')?.click();
    expect(cancelled.xhr?.aborted).toBe(true);
    expect(cancelled.elements.get('download-status')?.textContent).toBe('Download cancelled.');

    const oversized = runPage();
    oversized.xhr?.progress(1, 2_147_483_649);
    expect(oversized.xhr?.aborted).toBe(true);
    expect(oversized.elements.get('download-status')?.textContent).toBe('Download is too large for this browser.');
  });

  it('rejects a missing fragment without issuing any request', () => {
    const runtime = runPage({ ticket: '' });
    expect(runtime.replaced).toEqual(['/api/enroll/v2/bootstrap']);
    expect(runtime.xhr).toBeNull();
    expect(runtime.elements.get('download-status')?.textContent).toBe('This download link is invalid.');
  });

  it('does not send the bearer when the fragment cannot be scrubbed', () => {
    const runtime = runPage({ historyThrows: true });
    expect(runtime.xhr).toBeNull();
    expect(runtime.elements.get('download-status')?.textContent).toBe('This browser could not secure the download link.');
  });

  it('keeps a completed unknown-length response indeterminate and sanitizes path-like filenames', () => {
    const runtime = runPage();
    runtime.setNow(2_000);
    runtime.xhr?.progress(2_000_000);
    runtime.xhr?.finish(200, new Blob([new Uint8Array(2_000_000)]), {
      'Content-Disposition': 'attachment; filename="../unsafe/node.bin"',
    });

    expect(runtime.elements.get('download-detail')?.textContent).not.toContain('%');
    expect(runtime.elements.get('download-progress')?.attributes.has('value')).toBe(false);
    expect(runtime.anchors[0]?.download).toBe('.._unsafe_node.bin');
  });

  it('binds both inline blocks to the supplied nonce without logging or query-string token transport', () => {
    const html = buildControlledNodeBootstrapPage('fixed-nonce');
    expect(html.match(/nonce="fixed-nonce"/g)).toHaveLength(2);
    expect(html).toContain("history.replaceState(null,'',location.pathname+location.search)");
    expect(html).toContain("xhr.open('POST',downloadPath,true)");
    expect(html).not.toContain('console.');
    expect(html).not.toContain('?ticket=');
  });
});
