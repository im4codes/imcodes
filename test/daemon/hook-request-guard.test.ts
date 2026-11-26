/**
 * tsk_854675e1e2: the loopback hook server trusts a caller-written session header; a web page must not be able to reach it through the
 * user's browser (DNS rebinding or a cross-site POST).
 */
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLocalHookRequest } from '../../src/daemon/hook-request-guard.js';

vi.mock('../../src/util/logger.js', () => ({ default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

describe('isLocalHookRequest', () => {
  it('accepts a local program: loopback host, no Origin', () => {
    for (const host of ['127.0.0.1:51913', 'localhost:51913', '[::1]:51913', 'LOCALHOST', undefined, '']) {
      expect(isLocalHookRequest({ host }), String(host)).toBe(true);
    }
  });

  it('refuses a browser: an Origin header (any), or a host that is not loopback (DNS rebinding)', () => {
    expect(isLocalHookRequest({ host: '127.0.0.1:51913', origin: 'https://evil.example' })).toBe(false);
    expect(isLocalHookRequest({ host: '127.0.0.1:51913', origin: 'null' })).toBe(false);
    for (const host of ['evil.example:51913', 'rebind.evil.example', '127.0.0.1.evil.example:51913', '10.0.0.5:51913', '[fe80::1]:51913']) {
      expect(isLocalHookRequest({ host }), host).toBe(false);
    }
  });
});

describe('the hook server', () => {
  let close: (() => void) | undefined;
  afterEach(() => { close?.(); close = undefined; });

  async function post(port: number, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ from: 'deck_x_brain' });
      const req = http.request({ hostname: '127.0.0.1', port, path: '/list', method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), Connection: 'close', ...headers } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('error', reject);
      req.end(body);
    });
  }

  it('answers a local program and refuses a request that carries a browser trait before any route runs', async () => {
    const { startHookServer } = await import('../../src/daemon/hook-server.js');
    const { server, port } = await startHookServer(vi.fn());
    close = () => server.close();
    expect(await post(port, {})).toBe(200);
    expect(await post(port, { Origin: 'https://evil.example' })).toBe(403);
    expect(await post(port, { Host: 'rebind.evil.example' })).toBe(403);
  });
});
