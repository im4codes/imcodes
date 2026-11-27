/**
 * @vitest-environment jsdom
 *
 * Tests for the WebSocket constructor patch injected by buildPreviewRuntimePatch.
 * We evaluate the script string in jsdom and verify URL rewriting behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPreviewRuntimePatch } from '../../server/src/preview/policy.js';

// Simulate the variables that buildPreviewRuntimePatch injects.
const PREFIX = '/api/server/server1/local-web/preview123';
const PREVIEW_PORT = 3000;
const ACCESS_TOKEN = 'tok-abc';

/**
 * Extract the real IIFE from `buildPreviewRuntimePatch` so jsdom tests always run
 * against the authoritative production runtime patch (no duplicated inline copy).
 */
function buildTestScript(prefix: string, port: number, accessToken: string | null): string {
  const html = buildPreviewRuntimePatch(prefix, port, accessToken ?? undefined);
  const match = html.match(/^<script data-imcodes-preview-runtime>([\s\S]*)<\/script>$/);
  if (!match) throw new Error('Failed to extract runtime patch script');
  return `(function(){window.__IMCODES_PREVIEW_PATCHED__=false;${match[1]}})();`;
}

// ── Mock WebSocket ─────────────────────────────────────────────────────────

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  url: string;
  protocols: string | string[] | undefined;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function installPatch(prefix = PREFIX, port = PREVIEW_PORT, token: string | null = ACCESS_TOKEN) {
  vi.stubGlobal('WebSocket', MockWebSocket);
  const script = buildTestScript(prefix, port, token);
  // eslint-disable-next-line no-eval
  (0, eval)(script);
}

function getLastSocket(url: string | URL, protocols?: string | string[]): MockWebSocket {
  const ctor = window.WebSocket as unknown as typeof MockWebSocket;
  return new (ctor as unknown as new (u: string | URL, p?: string | string[]) => MockWebSocket)(url, protocols);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WebSocket constructor patch — URL rewriting', () => {
  beforeEach(() => {
    // jsdom defaults to http: protocol
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { protocol: 'https:', host: 'im.codes' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rewrites ws://localhost:{port}/path to absolute wss:// URL with token', () => {
    installPatch();
    const sock = getLastSocket(`ws://localhost:${PREVIEW_PORT}/socket`);
    expect(sock.url).toBe(
      `wss://im.codes${PREFIX}/socket?${ACCESS_TOKEN ? 'preview_access_token=' + encodeURIComponent(ACCESS_TOKEN) : ''}`,
    );
    expect(sock.url).toContain('preview_access_token=tok-abc');
  });

  it('rewrites ws://127.0.0.1:{port}/path to absolute wss:// URL', () => {
    installPatch();
    const sock = getLastSocket(`ws://127.0.0.1:${PREVIEW_PORT}/ws`);
    expect(sock.url).toContain(`wss://im.codes${PREFIX}/ws`);
    expect(sock.url).toContain('preview_access_token=tok-abc');
  });

  it('rewrites ws://[::1]:{port}/path to absolute wss:// URL', () => {
    installPatch();
    const sock = getLastSocket(`ws://[::1]:${PREVIEW_PORT}/ws`);
    expect(sock.url).toContain(`wss://im.codes${PREFIX}/ws`);
    expect(sock.url).toContain('preview_access_token=tok-abc');
  });

  it('rewrites relative /ws URL to absolute wss:// URL', () => {
    installPatch();
    const sock = getLastSocket('/ws');
    expect(sock.url).toContain(`wss://im.codes${PREFIX}/ws`);
    expect(sock.url).toContain('preview_access_token=tok-abc');
  });

  it('rewrites relative URL with query string, appending token with &', () => {
    installPatch();
    const sock = getLastSocket('/ws?room=1');
    expect(sock.url).toContain(`wss://im.codes${PREFIX}/ws?room=1&preview_access_token=tok-abc`);
  });

  it('rewrites ws://localhost URL with existing query string, appending token with &', () => {
    installPatch();
    const sock = getLastSocket(`ws://localhost:${PREVIEW_PORT}/ws?v=2`);
    expect(sock.url).toContain(`wss://im.codes${PREFIX}/ws?v=2&preview_access_token=tok-abc`);
  });

  it('passes through non-matching wss:// external URLs unchanged', () => {
    installPatch();
    const externalUrl = 'wss://external-service.com/ws';
    const sock = getLastSocket(externalUrl);
    expect(sock.url).toBe(externalUrl);
  });

  it('passes through ws:// URL for different port unchanged', () => {
    installPatch();
    const url = 'ws://localhost:9999/ws';
    const sock = getLastSocket(url);
    expect(sock.url).toBe(url);
  });

  it('uses ws:// scheme (not wss://) when page is served over http:', () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { protocol: 'http:', host: 'localhost:8080' },
    });
    installPatch();
    const sock = getLastSocket(`ws://localhost:${PREVIEW_PORT}/ws`);
    expect(sock.url).toMatch(/^ws:\/\//);
    expect(sock.url).not.toMatch(/^wss:\/\//);
  });

  it('omits token query param when ACCESS_TOKEN is null', () => {
    installPatch(PREFIX, PREVIEW_PORT, null);
    const sock = getLastSocket(`ws://localhost:${PREVIEW_PORT}/ws`);
    expect(sock.url).not.toContain('preview_access_token');
    expect(sock.url).toContain(`wss://im.codes${PREFIX}/ws`);
  });

  it('rewrites same-origin wss://<location.host>/ws URLs (Vite/Next/FastAPI HMR pattern)', () => {
    installPatch();
    const sock = getLastSocket('wss://im.codes/ws?token=app1');
    expect(sock.url).toBe(`wss://im.codes${PREFIX}/ws?token=app1&preview_access_token=tok-abc`);
  });

  it('rewrites same-origin ws:// URLs when page host is localhost:8080 over http:', () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { protocol: 'http:', host: 'localhost:8080', origin: 'http://localhost:8080', href: `http://localhost:8080${PREFIX}/` },
    });
    installPatch();
    const sock = getLastSocket('ws://localhost:8080/hmr');
    expect(sock.url).toBe(`ws://localhost:8080${PREFIX}/hmr?preview_access_token=tok-abc`);
  });

  it('rewrites relative WS path without leading slash (e.g. "ws/chat")', () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { protocol: 'https:', host: 'im.codes', origin: 'https://im.codes', href: `https://im.codes${PREFIX}/app/` },
    });
    installPatch();
    const sock = getLastSocket('ws/chat?room=2');
    expect(sock.url).toBe(`wss://im.codes${PREFIX}/app/ws/chat?room=2&preview_access_token=tok-abc`);
  });

  it('rewrites URL instances passed to new WebSocket(new URL(...)) and leaves external URL objects untouched', () => {
    installPatch();
    const sameOriginObj = new URL('wss://im.codes/ws?x=1');
    expect(getLastSocket(sameOriginObj).url).toBe(`wss://im.codes${PREFIX}/ws?x=1&preview_access_token=tok-abc`);

    const loopbackObj = new URL(`ws://127.0.0.1:${PREVIEW_PORT}/hmr`);
    expect(getLastSocket(loopbackObj).url).toBe(`wss://im.codes${PREFIX}/hmr?preview_access_token=tok-abc`);

    const externalObj = new URL('wss://echo.websocket.org/ws');
    expect(getLastSocket(externalObj).url).toBe(externalObj);
  });

  it('is idempotent for reconnect URLs already containing PREFIX or preview_access_token', () => {
    installPatch();
    const alreadyComplete = `wss://im.codes${PREFIX}/ws?preview_access_token=tok-abc`;
    expect(getLastSocket(alreadyComplete).url).toBe(alreadyComplete);

    const prefixedNoToken = `wss://im.codes${PREFIX}/ws`;
    expect(getLastSocket(prefixedNoToken).url).toBe(alreadyComplete);

    const relPrefixed = `${PREFIX}/ws?room=1`;
    expect(getLastSocket(relPrefixed).url).toBe(`wss://im.codes${PREFIX}/ws?room=1&preview_access_token=tok-abc`);
  });

  it('resolves dot-segment and nested relative WS URLs against the logical page path (never escaping PREFIX)', () => {
    // At preview root / : ../ws must stay at PREFIX/ws (not walk out of previewId).
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { protocol: 'https:', host: 'im.codes', origin: 'https://im.codes', href: `https://im.codes${PREFIX}/`, pathname: `${PREFIX}/` },
    });
    installPatch();
    expect(getLastSocket('../ws').url).toBe(`wss://im.codes${PREFIX}/ws?preview_access_token=tok-abc`);
    expect(getLastSocket('/../ws').url).toBe(`wss://im.codes${PREFIX}/ws?preview_access_token=tok-abc`);
    expect(getLastSocket('/a/../ws?k=1').url).toBe(`wss://im.codes${PREFIX}/ws?k=1&preview_access_token=tok-abc`);

    // Nested logical page /app/sub/index.html : ../ws resolves to /app/ws under PREFIX.
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { protocol: 'https:', host: 'im.codes', origin: 'https://im.codes', href: `https://im.codes${PREFIX}/app/sub/index.html`, pathname: `${PREFIX}/app/sub/index.html` },
    });
    installPatch();
    expect(getLastSocket('../ws').url).toBe(`wss://im.codes${PREFIX}/app/ws?preview_access_token=tok-abc`);
    expect(getLastSocket('./live').url).toBe(`wss://im.codes${PREFIX}/app/sub/live?preview_access_token=tok-abc`);
  });
});

describe('WebSocket constructor patch — protocols argument', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { protocol: 'https:', host: 'im.codes' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes protocols array verbatim to the original constructor', () => {
    installPatch();
    const protocols = ['proto1', 'proto2'];
    const sock = getLastSocket(`ws://localhost:${PREVIEW_PORT}/ws`, protocols);
    expect(sock.protocols).toEqual(['proto1', 'proto2']);
  });

  it('passes protocols string verbatim', () => {
    installPatch();
    const sock = getLastSocket(`ws://localhost:${PREVIEW_PORT}/ws`, 'chat');
    expect(sock.protocols).toBe('chat');
  });

  it('passes undefined protocols when omitted (no second arg)', () => {
    installPatch();
    const sock = getLastSocket(`ws://localhost:${PREVIEW_PORT}/ws`);
    expect(sock.protocols).toBeUndefined();
  });
});

describe('WebSocket constructor patch — instanceof compatibility', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { protocol: 'https:', host: 'im.codes' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('instanceof WebSocket is true for a patched WebSocket instance', () => {
    installPatch();
    const ctor = window.WebSocket as unknown as new (url: string) => MockWebSocket;
    const sock = new ctor(`ws://localhost:${PREVIEW_PORT}/ws`);
    expect(sock instanceof MockWebSocket).toBe(true);
  });
});

describe('WebSocket constructor patch — static constants', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves static CONNECTING, OPEN, CLOSING, CLOSED constants', () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { protocol: 'https:', host: 'im.codes' },
    });
    installPatch();
    const PatchedWS = window.WebSocket as unknown as {
      CONNECTING: number;
      OPEN: number;
      CLOSING: number;
      CLOSED: number;
    };
    expect(PatchedWS.CONNECTING).toBe(MockWebSocket.CONNECTING);
    expect(PatchedWS.OPEN).toBe(MockWebSocket.OPEN);
    expect(PatchedWS.CLOSING).toBe(MockWebSocket.CLOSING);
    expect(PatchedWS.CLOSED).toBe(MockWebSocket.CLOSED);
  });
});
