/**
 * @vitest-environment jsdom
 *
 * Tests for the WebSocket constructor patch injected by buildPreviewRuntimePatch.
 * We evaluate the script string in jsdom and verify URL rewriting behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Simulate the variables that buildPreviewRuntimePatch injects.
const PREFIX = '/api/server/server1/local-web/preview123';
const PREVIEW_PORT = 3000;
const ACCESS_TOKEN = 'tok-abc';

/**
 * Build a minimal runtime patch script string that matches the structure
 * produced by buildPreviewRuntimePatch, but extracted so we can test it
 * in isolation without importing the server-side module.
 *
 * The function MUST stay in sync with the actual patch script in
 * server/src/preview/policy.ts — if you change the patch, update this too.
 */
function buildTestScript(prefix: string, port: number, accessToken: string | null): string {
  const prefixJson = JSON.stringify(prefix);
  const portJson = JSON.stringify(port);
  const tokenJson = accessToken !== null ? JSON.stringify(accessToken) : 'null';
  return `(function(){var PREFIX=${prefixJson};var PREVIEW_PORT=${portJson};var ACCESS_TOKEN=${tokenJson};var TOKEN_PARAM='preview_access_token';window.__IMCODES_PREVIEW_PATCHED__=false;function isLoopbackHost(host){return host==='127.0.0.1'||host==='localhost'||host==='[::1]'||host==='::1';}if(typeof window.WebSocket==='function'){var OriginalWebSocket=window.WebSocket;function rewriteWsUrl(url){var wsScheme=window.location.protocol==='http:'?'ws://':'wss://';var base=wsScheme+window.location.host;if(typeof url==='string'&&url.startsWith('/')){var path=url;var sep=path.indexOf('?')===-1?'?':'&';return base+PREFIX+path+(ACCESS_TOKEN?(sep+TOKEN_PARAM+'='+encodeURIComponent(ACCESS_TOKEN)):'');}try{var parsed=new URL(url);var parsedPort=Number(parsed.port||(parsed.protocol==='wss:'?'443':'80'));if((parsed.protocol==='ws:'||parsed.protocol==='wss:')&&isLoopbackHost(parsed.hostname)&&parsedPort===PREVIEW_PORT){var sep2=(parsed.search?'&':'?');return base+PREFIX+parsed.pathname+parsed.search+(ACCESS_TOKEN?(sep2+TOKEN_PARAM+'='+encodeURIComponent(ACCESS_TOKEN)):'');}}catch(_e){}return url;}function PatchedWebSocket(url,protocols){var rewrittenUrl=rewriteWsUrl(url);if(protocols!==undefined){return new OriginalWebSocket(rewrittenUrl,protocols);}return new OriginalWebSocket(rewrittenUrl);}PatchedWebSocket.prototype=OriginalWebSocket.prototype;PatchedWebSocket.CONNECTING=OriginalWebSocket.CONNECTING;PatchedWebSocket.OPEN=OriginalWebSocket.OPEN;PatchedWebSocket.CLOSING=OriginalWebSocket.CLOSING;PatchedWebSocket.CLOSED=OriginalWebSocket.CLOSED;window.WebSocket=PatchedWebSocket;}})();`;
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

function getLastSocket(url: string, protocols?: string | string[]): MockWebSocket {
  const ctor = window.WebSocket as unknown as typeof MockWebSocket;
  return new ctor(url, protocols) as unknown as MockWebSocket;
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
