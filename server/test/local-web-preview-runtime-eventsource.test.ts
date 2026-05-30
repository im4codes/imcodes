import { describe, expect, it } from 'vitest';
import { rewritePreviewHtmlDocument } from '../src/preview/policy.js';

/**
 * V-eventsource — server EventSource runtime rewrite (capability
 * local-web-preview-runtime-rewrite, task P1.5.2).
 *
 * Two layers of assertions:
 *  1. Structural — the injected runtime script must include EventSource in the
 *     patched set, preserve constructor semantics (prototype/static constants),
 *     and pass the second arg through.
 *  2. Behavioral — extract the inline IIFE and execute it against a synthetic
 *     `window` (mock EventSource/WebSocket; native `URL`) so the URL-form matrix
 *     + instanceof + static-constant + EventSourceInit passthrough are verified
 *     as actual runtime behavior, not just string presence.
 */

const SERVER_ID = 'server123';
const PREVIEW_ID = 'preview123';
const PREVIEW_PORT = 3000;
const PREFIX = `/api/server/${SERVER_ID}/local-web/${PREVIEW_ID}`;

function buildRuntimeScript(accessToken?: string): string {
  const html = '<html><head></head><body></body></html>';
  const rewritten = rewritePreviewHtmlDocument(html, SERVER_ID, PREVIEW_ID, PREVIEW_PORT, accessToken);
  return rewritten;
}

/** Pull the IIFE body out of the injected `<script data-imcodes-preview-runtime>...</script>`. */
function extractRuntimeIife(accessToken?: string): string {
  const rewritten = buildRuntimeScript(accessToken);
  const match = rewritten.match(/<script data-imcodes-preview-runtime>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('runtime patch script not found in rewritten HTML');
  return match[1];
}

/** Captured EventSource construction call. */
interface CapturedES {
  url: unknown;
  init: unknown;
  argc: number;
}

/**
 * Build a synthetic `window` and run the injected IIFE against it. Returns the
 * mock EventSource class (post-patch `window.EventSource`) plus a record of the
 * latest construction call so URL rewriting can be asserted behaviorally.
 */
function runPatchedRuntime(opts?: { accessToken?: string; locationHref?: string }): {
  ESClass: any;
  WSClass: any;
  lastES: () => CapturedES | null;
  lastWsUrl: () => unknown;
  win: any;
} {
  const accessToken = opts?.accessToken;
  const href = opts?.locationHref ?? `https://im.codes${PREFIX}/`;
  const locUrl = new URL(href);

  let lastES: CapturedES | null = null;
  let lastWsUrl: unknown = null;

  // Native EventSource constants (per WHATWG): CONNECTING=0, OPEN=1, CLOSED=2.
  class MockEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    url: unknown;
    constructor(url: unknown, init?: unknown) {
      lastES = { url, init, argc: arguments.length };
      this.url = url;
    }
  }

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    url: unknown;
    constructor(url: unknown) {
      lastWsUrl = url;
      this.url = url;
    }
  }

  const documentStub = {
    addEventListener: () => {},
  };

  const win: any = {
    location: {
      href: locUrl.href,
      origin: locUrl.origin,
      protocol: locUrl.protocol,
      host: locUrl.host,
    },
    EventSource: MockEventSource,
    WebSocket: MockWebSocket,
    fetch: undefined,
    open: undefined,
    Location: undefined,
    document: documentStub,
    Request: class {},
    URL,
    URLSearchParams,
  };

  const iife = extractRuntimeIife(accessToken);
  // The IIFE references bare globals: window, document, history, XMLHttpRequest,
  // URL, URLSearchParams, Request. Provide them as function params so we never
  // touch the real test-process globals.
  const historyStub = { pushState: () => {}, replaceState: () => {} };
  const xhrStub: any = function () {};
  xhrStub.prototype = { open: function () {} };

  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'window',
    'document',
    'history',
    'XMLHttpRequest',
    'URL',
    'URLSearchParams',
    'Request',
    iife,
  );
  fn(win, documentStub, historyStub, xhrStub, URL, URLSearchParams, win.Request);

  return {
    ESClass: win.EventSource,
    WSClass: win.WebSocket,
    lastES: () => lastES,
    lastWsUrl: () => lastWsUrl,
    win,
  };
}

describe('local web preview runtime — EventSource patch (structural)', () => {
  it('includes EventSource constructor patch in the injected script', () => {
    const script = buildRuntimeScript('tok123');
    expect(script).toContain('window.EventSource');
    expect(script).toContain('OriginalEventSource');
    expect(script).toContain('PatchedEventSource');
  });

  it('preserves prototype + static constants CONNECTING/OPEN/CLOSED', () => {
    const script = buildRuntimeScript();
    expect(script).toContain('PatchedEventSource.prototype=OriginalEventSource.prototype');
    expect(script).toContain('PatchedEventSource.CONNECTING=OriginalEventSource.CONNECTING');
    expect(script).toContain('PatchedEventSource.OPEN=OriginalEventSource.OPEN');
    expect(script).toContain('PatchedEventSource.CLOSED=OriginalEventSource.CLOSED');
  });

  it('passes the second EventSourceInit arg through to the native constructor', () => {
    const script = buildRuntimeScript();
    // Mirrors the WebSocket protocols passthrough shape.
    expect(script).toContain('if(eventSourceInitDict!==undefined)');
    expect(script).toContain('new OriginalEventSource(rewrittenUrl,eventSourceInitDict)');
  });

  it('guards on EventSource existence (no throw when env lacks EventSource)', () => {
    const script = buildRuntimeScript();
    expect(script).toContain("if(typeof window.EventSource==='function')");
  });

  it('lists EventSource alongside the other patched globals', () => {
    const script = buildRuntimeScript('tok123');
    // The full patched set: fetch / XHR / WebSocket / EventSource / history /
    // Location / window.open / <a> / <form>.
    expect(script).toContain('window.fetch');
    expect(script).toContain('XMLHttpRequest.prototype.open');
    expect(script).toContain('window.WebSocket');
    expect(script).toContain('window.EventSource');
    expect(script).toContain("wrapHistory('pushState')");
    expect(script).toContain("wrapHistory('replaceState')");
    expect(script).toContain('Location.prototype.assign');
    expect(script).toContain('window.open');
    expect(script).toContain("a[href]");
    expect(script).toContain('HTMLFormElement');
  });
});

describe('local web preview runtime — EventSource patch (behavioral)', () => {
  it('rewrites absolute loopback URL on the preview port to the proxy prefix', () => {
    const { ESClass, lastES } = runPatchedRuntime({ accessToken: 'tok123' });
    new ESClass(`http://127.0.0.1:${PREVIEW_PORT}/events`);
    const call = lastES()!;
    expect(typeof call.url).toBe('string');
    expect(call.url as string).toBe(`${PREFIX}/events?preview_access_token=tok123`);
  });

  it('treats localhost / 0.0.0.0 / [::1] / ::1 the same as 127.0.0.1', () => {
    for (const host of ['localhost', '0.0.0.0', '[::1]']) {
      const { ESClass, lastES } = runPatchedRuntime();
      new ESClass(`http://${host}:${PREVIEW_PORT}/events`);
      expect(lastES()!.url as string).toBe(`${PREFIX}/events`);
    }
    // bare ::1 is not a valid URL host without brackets; the bracketed form
    // above plus the loopback set in shared/preview-policy cover ::1 semantics.
  });

  it('rewrites relative "/events" through the proxy without making it absolute', () => {
    const { ESClass, lastES } = runPatchedRuntime();
    new ESClass('/events');
    const url = lastES()!.url as string;
    expect(url).toBe(`${PREFIX}/events`);
    expect(url.startsWith('http')).toBe(false);
  });

  it('leaves bare-relative "events" intact (it already resolves under the proxied base)', () => {
    const { ESClass, lastES } = runPatchedRuntime();
    new ESClass('events');
    const url = lastES()!.url as string;
    // The injected document is served under PREFIX/ (and <base href> is
    // rewritten to PREFIX/), so a document-relative `events` already resolves to
    // PREFIX/events through the proxy. Prefixing it would double the prefix —
    // so the rewriter correctly leaves bare-relative URLs unchanged, matching
    // how the patched fetch/XHR treat them.
    expect(url).toBe('events');
  });

  it('preserves search and hash when rewriting', () => {
    const { ESClass, lastES } = runPatchedRuntime();
    new ESClass(`http://127.0.0.1:${PREVIEW_PORT}/events?topic=a#frag`);
    const url = lastES()!.url as string;
    expect(url).toContain('topic=a');
    expect(url).toContain('#frag');
    expect(url.startsWith(`${PREFIX}/events?`)).toBe(true);
  });

  it('does NOT rewrite an absolute URL on a non-preview port', () => {
    const { ESClass, lastES } = runPatchedRuntime();
    const original = `http://127.0.0.1:${PREVIEW_PORT + 1}/events`;
    new ESClass(original);
    expect(lastES()!.url as string).toBe(original);
  });

  it('does NOT rewrite an absolute non-loopback URL on the preview port', () => {
    const { ESClass, lastES } = runPatchedRuntime();
    const original = `http://example.com:${PREVIEW_PORT}/events`;
    new ESClass(original);
    expect(lastES()!.url as string).toBe(original);
  });

  it('appends preview_access_token only when missing (URLSearchParams.has, not includes)', () => {
    const { ESClass, lastES } = runPatchedRuntime({ accessToken: 'tok123' });
    new ESClass(`http://127.0.0.1:${PREVIEW_PORT}/events?preview_access_token=existing`);
    const url = lastES()!.url as string;
    // Existing token preserved, NOT duplicated.
    expect(url).toBe(`${PREFIX}/events?preview_access_token=existing`);
    expect(url.match(/preview_access_token/g)).toHaveLength(1);
  });

  it('does not append a token when no access token is configured', () => {
    const { ESClass, lastES } = runPatchedRuntime();
    new ESClass(`http://127.0.0.1:${PREVIEW_PORT}/events`);
    expect(lastES()!.url as string).toBe(`${PREFIX}/events`);
  });

  it('passes the EventSourceInit second arg through unchanged', () => {
    const { ESClass, lastES } = runPatchedRuntime();
    const init = { withCredentials: true };
    new ESClass('/events', init);
    const call = lastES()!;
    expect(call.argc).toBe(2);
    expect(call.init).toBe(init);
  });

  it('omits the second arg when none is supplied (single-arg native call)', () => {
    const { ESClass, lastES } = runPatchedRuntime();
    new ESClass('/events');
    expect(lastES()!.argc).toBe(1);
  });

  it('keeps instanceof working through the patched constructor', () => {
    const { ESClass } = runPatchedRuntime();
    const es = new ESClass('/events');
    expect(es instanceof ESClass).toBe(true);
  });

  it('exposes static constants equal to the native EventSource values', () => {
    const { ESClass } = runPatchedRuntime();
    expect(ESClass.CONNECTING).toBe(0);
    expect(ESClass.OPEN).toBe(1);
    expect(ESClass.CLOSED).toBe(2);
  });

  it('leaves a non-string URL arg untouched (documented known limitation, no throw)', () => {
    const { ESClass, lastES } = runPatchedRuntime();
    const urlObj = new URL(`http://127.0.0.1:${PREVIEW_PORT}/events`);
    expect(() => new ESClass(urlObj)).not.toThrow();
    // The URL object is forwarded as-is (not reliably rewritten) — known limit.
    expect(lastES()!.url).toBe(urlObj);
  });

  it('does not regress the WebSocket patch (absolute loopback ws still rewritten)', () => {
    const { WSClass, lastWsUrl } = runPatchedRuntime({ accessToken: 'tok123' });
    new WSClass(`ws://127.0.0.1:${PREVIEW_PORT}/hmr`);
    const url = lastWsUrl() as string;
    expect(url).toContain(`im.codes${PREFIX}/hmr`);
    expect(url).toContain('preview_access_token=tok123');
  });
});
