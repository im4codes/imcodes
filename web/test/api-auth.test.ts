/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { appGetInfoMock, updaterCurrentMock } = vi.hoisted(() => ({
  appGetInfoMock: vi.fn(),
  updaterCurrentMock: vi.fn(),
}));

vi.mock('@capacitor/app', () => ({
  App: {
    getInfo: (...args: unknown[]) => appGetInfoMock(...args),
  },
}));

vi.mock('@capgo/capacitor-updater', () => ({
  CapacitorUpdater: {
    current: (...args: unknown[]) => updaterCurrentMock(...args),
  },
}));

describe('auth nonce exchange API', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'android',
    });
    appGetInfoMock.mockResolvedValue({ version: '1.2.3' });
    updaterCurrentMock.mockResolvedValue({ bundle: { id: 'bundle-9', version: '2026.4.937' } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('attaches auth telemetry headers and exchanges a nonce', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      apiKey: 'api-key-1',
      userId: 'user-1',
      keyId: 'key-1',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { exchangeNonce } = await import('../src/api.js');
    const result = await exchangeNonce('https://server.example', 'nonce-123');

    expect(result).toEqual({
      apiKey: 'api-key-1',
      userId: 'user-1',
      keyId: 'key-1',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://server.example/api/auth/token-exchange');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ nonce: 'nonce-123' }));
    const headers = new Headers(init.headers);
    expect(headers.get('X-Platform')).toBe('android');
    expect(headers.get('X-App-Version')).toBe('1.2.3');
    expect(headers.get('X-Bundle-Version')).toBe('2026.4.937');
  });

  it('drops a stale browser API key so web login can store cookies', async () => {
    vi.resetModules();
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'web',
      isNativePlatform: () => false,
    });
    localStorage.setItem('rcc_api_key', 'deck_stale_browser_key');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { passwordLogin, getApiKey } = await import('../src/api.js');
    await passwordLogin('wyj', 'password');

    expect(getApiKey()).toBeNull();
    expect(localStorage.getItem('rcc_api_key')).toBeNull();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has('Authorization')).toBe(false);
    expect(init.credentials).toBe('include');
  });

  it('retries transient failures with exponential backoff', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        apiKey: 'api-key-2',
        userId: 'user-2',
        keyId: 'key-2',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const { exchangeNonceWithRetry } = await import('../src/api.js');
    const promise = exchangeNonceWithRetry('https://server.example', 'nonce-456');

    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toEqual({
      apiKey: 'api-key-2',
      userId: 'user-2',
      keyId: 'key-2',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('aborts a single nonce exchange attempt with AbortSignal timeout', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 0);
      return controller.signal;
    });

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((_url, init) => new Promise((_, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (!signal) {
        reject(new Error('missing signal'));
        return;
      }
      if (signal.aborted) {
        reject(new DOMException('The operation was aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
    }));

    const { exchangeNonce } = await import('../src/api.js');
    const promise = exchangeNonce('https://server.example', 'nonce-timeout').catch(() => undefined);

    await vi.advanceTimersByTimeAsync(0);
    await promise;
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.signal as AbortSignal).aborted).toBe(true);
    vi.useRealTimers();
  });

  it('bounds timeline history HTTP backfill with a short abort timeout', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 0);
      return controller.signal;
    });

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((_url, init) => new Promise((_, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (!signal) {
        reject(new Error('missing signal'));
        return;
      }
      if (signal.aborted) {
        reject(new DOMException('The operation was aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
    }));

    const { fetchTimelineHistoryHttp } = await import('../src/api.js');
    const promise = fetchTimelineHistoryHttp('srv-1', 'deck_proj_brain', { limit: 300 });

    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toBeNull();
    expect(timeoutSpy).toHaveBeenCalledWith(2_500);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/server/srv-1/timeline/history/full?');
    expect((init.signal as AbortSignal).aborted).toBe(true);
    vi.useRealTimers();
  });
});
