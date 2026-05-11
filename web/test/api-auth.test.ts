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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('auth nonce exchange API', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'android',
    });
    localStorage.clear();
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
  }, 15_000);

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

  it('routes daemon HTTP helpers through server-scoped API paths', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        preview: {
          id: 'preview-1',
          serverId: 'srv id/1',
          port: 5173,
          path: '/app',
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sessionName: 'deck_proj_brain',
        epoch: 11,
        events: [{ eventId: 'evt-1' }],
        hasMore: false,
        nextCursor: null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sessionName: 'deck_proj_brain',
        events: [{ eventId: 'evt-2', ts: 2, type: 'assistant.text', text: 'ok' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const {
      createLocalWebPreview,
      closeLocalWebPreview,
      sendSessionViaHttp,
      cancelSessionViaHttp,
      fetchTimelineHistoryHttp,
      fetchTimelineTextTailHttp,
    } = await import('../src/api.js');

    await createLocalWebPreview('srv id/1', 5173, 'app');
    await closeLocalWebPreview('srv id/1', 'preview id/2');
    await sendSessionViaHttp('srv id/1', { sessionName: 'deck_proj_brain', text: 'hello' });
    await cancelSessionViaHttp('srv id/1', { sessionName: 'deck_proj_brain' });
    await expect(fetchTimelineHistoryHttp('srv id/1', 'deck_proj_brain', { limit: 25 }))
      .resolves.toEqual({
        events: [{ eventId: 'evt-1' }],
        epoch: 11,
        hasMore: false,
        nextCursor: null,
      });
    await expect(fetchTimelineTextTailHttp('srv id/1', 'deck_proj_brain'))
      .resolves.toEqual({
        events: [{ eventId: 'evt-2', ts: 2, type: 'assistant.text', text: 'ok' }],
      });

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toBe('/api/server/srv%20id%2F1/local-web-preview');
    expect(urls[1]).toBe('/api/server/srv%20id%2F1/local-web-preview/preview%20id%2F2');
    expect(urls[2]).toBe('/api/server/srv%20id%2F1/session/send');
    expect(urls[3]).toBe('/api/server/srv%20id%2F1/session/cancel');
    expect(urls[4]).toBe('/api/server/srv%20id%2F1/timeline/history/full?sessionName=deck_proj_brain&limit=25');
    expect(urls[5]).toBe('/api/server/srv%20id%2F1/timeline/text-tail?sessionName=deck_proj_brain');
  });

  it('builds encoded local web preview proxy URLs with optional access tokens', async () => {
    const {
      buildLocalWebPreviewProxyUrlWithToken,
      configure,
    } = await import('../src/api.js');

    configure('https://server.example/');

    expect(buildLocalWebPreviewProxyUrlWithToken('srv id/1', 'preview id/2', 'app?tab=one#top', 'token+value')).toBe(
      'https://server.example/api/server/srv%20id%2F1/local-web/preview%20id%2F2/app?tab=one&preview_access_token=token%2Bvalue#top',
    );
  });

  it('maps non-ok JSON responses into stable ApiError fields', async () => {
    const cases = [
      { path: '/api/auth/refresh', status: 401, code: 'session_expired' },
      { path: '/api/test/forbidden', status: 403, code: 'forbidden_scope' },
      { path: '/api/test/missing', status: 404, code: 'not_found' },
      { path: '/api/test/conflict', status: 409, code: 'conflict_state' },
      { path: '/api/test/unavailable', status: 503, code: 'daemon_offline' },
    ];
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url) => {
      const match = cases.find(({ path }) => String(url).endsWith(path));
      return new Response(JSON.stringify({ error: match?.code ?? 'unexpected_error' }), {
        status: match?.status ?? 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { apiFetch, ApiError } = await import('../src/api.js');

    for (const { path, status, code } of cases) {
      let error: unknown;
      try {
        await apiFetch(path);
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        name: 'ApiError',
        status,
        body: JSON.stringify({ error: code }),
        code,
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(cases.length);
  });

  it('propagates JSON decode failures from successful API responses', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response('not json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { apiFetch } = await import('../src/api.js');

    await expect(apiFetch('/api/test/bad-json')).rejects.toBeInstanceOf(SyntaxError);
  });

  it('passes caller abort signals through apiFetch', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const controller = new AbortController();
    const { apiFetch } = await import('../src/api.js');

    await expect(apiFetch('/api/test/abortable', { signal: controller.signal })).resolves.toEqual({ ok: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('keeps browser csrf and native bearer auth headers isolated', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true }));
    document.cookie = 'rcc_csrf=csrf%20token';

    const {
      apiFetch,
      clearApiKey,
      configureApiKey,
      getApiKey,
      withTemporaryApiKey,
    } = await import('../src/api.js');

    await apiFetch('/api/test/browser-csrf', {
      method: 'POST',
      body: JSON.stringify({ ok: true }),
    });

    configureApiKey('native-key-1');
    expect(getApiKey()).toBe('native-key-1');
    await apiFetch('/api/test/native-auth', {
      method: 'POST',
      body: JSON.stringify({ ok: true }),
    });

    await withTemporaryApiKey('temporary-key', async () => {
      await apiFetch('/api/test/temp-auth');
    });
    await apiFetch('/api/test/restored-auth');

    clearApiKey();
    expect(getApiKey()).toBeNull();
    await apiFetch('/api/test/browser-again');

    const browserHeaders = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(browserHeaders.get('X-CSRF-Token')).toBe('csrf token');
    expect(browserHeaders.has('Authorization')).toBe(false);
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe('include');

    const nativeHeaders = new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers);
    expect(nativeHeaders.get('Authorization')).toBe('Bearer native-key-1');
    expect(nativeHeaders.has('X-CSRF-Token')).toBe(false);
    expect((fetchMock.mock.calls[1][1] as RequestInit).credentials).toBe('omit');

    const temporaryHeaders = new Headers((fetchMock.mock.calls[2][1] as RequestInit).headers);
    expect(temporaryHeaders.get('Authorization')).toBe('Bearer temporary-key');
    const restoredHeaders = new Headers((fetchMock.mock.calls[3][1] as RequestInit).headers);
    expect(restoredHeaders.get('Authorization')).toBe('Bearer native-key-1');

    const finalHeaders = new Headers((fetchMock.mock.calls[4][1] as RequestInit).headers);
    expect(finalHeaders.has('Authorization')).toBe(false);
    expect((fetchMock.mock.calls[4][1] as RequestInit).credentials).toBe('include');
    expect(localStorage.getItem('rcc_api_key')).toBeNull();
  });

  it('maps sub-session and p2p wrappers to stable request and response shapes', async () => {
    const rawSubSession = {
      id: 'sub-1',
      server_id: 'srv-1',
      type: 'codex-sdk',
      shell_bin: null,
      runtime_type: null,
      provider_id: 'codex',
      provider_session_id: 'provider-1',
      cwd: '/repo',
      label: 'Worker',
      closed_at: null,
      created_at: 11,
      updated_at: 12,
      cc_session_id: null,
      gemini_session_id: null,
      parent_session: 'deck_proj_brain',
      description: 'does work',
      cc_preset_id: null,
      requested_model: 'gpt-5.2',
      active_model: 'gpt-5.2',
      effort: 'high',
      transport_config: '{"supervision":{"enabled":true}}',
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ subSessions: [rawSubSession] }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'sub-2',
        sessionName: 'deck_proj_worker',
        subSession: {
          ...rawSubSession,
          id: 'sub-2',
          transport_config: { supervision: { enabled: false } },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({
        runs: [{
          id: 'run-1',
          status: 'running',
          mode_key: 'review',
          initiator_session: 'deck_proj_brain',
          current_target_session: null,
          remaining_targets: '[]',
          result_summary: null,
          error: null,
          created_at: '2026-05-11T00:00:00Z',
          updated_at: '2026-05-11T00:00:00Z',
          completed_at: null,
        }],
      }));

    const {
      createSubSession,
      deleteSubSession,
      listP2pRuns,
      listSubSessions,
      patchSession,
      patchSubSession,
      reorderSubSessions,
    } = await import('../src/api.js');

    await expect(listSubSessions('srv-1')).resolves.toMatchObject([{
      id: 'sub-1',
      runtimeType: 'transport',
      transportConfig: { supervision: { enabled: true } },
      modelDisplay: 'gpt-5.2',
    }]);

    await expect(createSubSession('srv-1', {
      type: 'codex-sdk',
      label: 'Worker',
      ccSessionId: 'cc-1',
      parentSession: 'deck_proj_brain',
      ccPresetId: 'preset-1',
      requestedModel: 'gpt-5.2',
      activeModel: 'gpt-5.2',
      effort: 'high',
      transportConfig: { supervision: { enabled: false } },
    })).resolves.toMatchObject({
      id: 'sub-2',
      sessionName: 'deck_proj_worker',
      subSession: {
        id: 'sub-2',
        transportConfig: { supervision: { enabled: false } },
      },
    });

    await patchSubSession('srv-1', 'sub-2', { label: 'Renamed', closedAt: null });
    await patchSession('srv-1', 'deck_proj_brain', { label: 'Main', agentType: 'codex-sdk' });
    await reorderSubSessions('srv-1', ['sub-2', 'sub-1']);
    await deleteSubSession('srv-1', 'sub-1');
    await expect(listP2pRuns('srv-1')).resolves.toHaveLength(1);

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit | undefined)?.method ?? 'GET',
      body: (init as RequestInit | undefined)?.body,
    }));
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['GET', '/api/server/srv-1/sub-sessions'],
      ['POST', '/api/server/srv-1/sub-sessions'],
      ['PATCH', '/api/server/srv-1/sub-sessions/sub-2'],
      ['PATCH', '/api/server/srv-1/sessions/deck_proj_brain'],
      ['PATCH', '/api/server/srv-1/sub-sessions/reorder'],
      ['DELETE', '/api/server/srv-1/sub-sessions/sub-1'],
      ['GET', '/api/server/srv-1/p2p/runs'],
    ]);
    expect(JSON.parse(String(requests[1].body))).toMatchObject({
      cc_session_id: 'cc-1',
      parent_session: 'deck_proj_brain',
      cc_preset_id: 'preset-1',
      requested_model: 'gpt-5.2',
      active_model: 'gpt-5.2',
      transport_config: { supervision: { enabled: false } },
    });
    expect(JSON.parse(String(requests[4].body))).toEqual({ ids: ['sub-2', 'sub-1'] });
  });

  it('keeps current user, admin, and preference wrappers on stable contracts', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        id: 'u1',
        username: 'kai',
        display_name: 'Kai',
        is_admin: true,
        status: 'active',
        has_password: true,
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'u1',
        username: 'kai',
        display_name: 'Kai New',
        is_admin: true,
        status: 'active',
        has_password: true,
      }))
      .mockResolvedValueOnce(jsonResponse({ users: [{ id: 'u2', username: 'ana', isAdmin: false, status: 'pending', createdAt: 1 }] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ settings: { inviteOnly: 'true' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ value: { theme: 'dark' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ error: 'missing' }, 404));

    const {
      approveUser,
      deleteAdminUser,
      disableUser,
      fetchAdminSettings,
      fetchAdminUsers,
      fetchMe,
      getUserPref,
      onUserPrefChanged,
      saveUserPref,
      updateAdminSettings,
      updateDisplayName,
    } = await import('../src/api.js');

    const prefEvents: Array<{ key: string; value: unknown }> = [];
    const unsubscribe = onUserPrefChanged((key, value, meta) => {
      if (meta.source === 'local') prefEvents.push({ key, value });
    });

    await expect(fetchMe()).resolves.toMatchObject({ id: 'u1', is_admin: true });
    await expect(updateDisplayName('Kai New')).resolves.toMatchObject({ display_name: 'Kai New' });
    await expect(fetchAdminUsers()).resolves.toHaveLength(1);
    await approveUser('u2');
    await disableUser('u2');
    await deleteAdminUser('u2');
    await expect(fetchAdminSettings()).resolves.toEqual({ inviteOnly: 'true' });
    await updateAdminSettings({ inviteOnly: 'false' });
    await expect(getUserPref('ui.theme')).resolves.toEqual({ theme: 'dark' });
    await saveUserPref('ui.theme', 'light');
    await expect(getUserPref('missing.pref')).resolves.toBeNull();
    unsubscribe();

    expect(prefEvents).toEqual([{ key: 'ui.theme', value: 'light' }]);

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit | undefined)?.method ?? 'GET',
      body: (init as RequestInit | undefined)?.body,
    }));
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['GET', '/api/auth/user/me'],
      ['PATCH', '/api/auth/user/me'],
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users/u2/approve'],
      ['POST', '/api/admin/users/u2/disable'],
      ['DELETE', '/api/admin/users/u2'],
      ['GET', '/api/admin/settings'],
      ['PUT', '/api/admin/settings'],
      ['GET', '/api/preferences/ui.theme'],
      ['PUT', '/api/preferences/ui.theme'],
      ['GET', '/api/preferences/missing.pref'],
    ]);
    expect(JSON.parse(String(requests[1].body))).toEqual({ displayName: 'Kai New' });
    expect(JSON.parse(String(requests[7].body))).toEqual({ inviteOnly: 'false' });
    expect(JSON.parse(String(requests[9].body))).toEqual({ value: 'light' });
  });

  it('keeps passkey and password wrappers on stable request contracts', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'register-1', publicKey: {} }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'login-1', publicKey: {} }))
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'verify-1', publicKey: {} }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ nonce: 'nonce-1', userId: 'u1' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, pending: true, apiKey: 'key-1', keyId: 'kid-1', userId: 'u1' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, apiKey: 'key-2', keyId: 'kid-2', userId: 'u1' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        user: {
          id: 'u1',
          username: 'kai',
          display_name: 'Kai',
          is_admin: false,
          status: 'active',
          has_password: true,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ credentials: [{ id: 'cred-1', deviceName: 'Mac', createdAt: 1, lastUsedAt: null }] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const {
      deletePasskey,
      listPasskeys,
      passkeyLoginBegin,
      passkeyLoginComplete,
      passkeyLoginCompleteNative,
      passkeyRegisterBegin,
      passkeyRegisterComplete,
      passkeyVerifyBegin,
      passwordChange,
      passwordLogin,
      passwordRegister,
      passwordSetupWithPasskey,
    } = await import('../src/api.js');

    await expect(passkeyRegisterBegin('Kai')).resolves.toMatchObject({ challengeId: 'register-1' });
    await passkeyRegisterComplete('register-1', { id: 'cred' }, 'Mac');
    await expect(passkeyLoginBegin()).resolves.toMatchObject({ challengeId: 'login-1' });
    await expect(passkeyVerifyBegin()).resolves.toMatchObject({ challengeId: 'verify-1' });
    await passkeyLoginComplete('login-1', { id: 'cred' });
    await expect(passkeyLoginCompleteNative('login-1', { id: 'cred' })).resolves.toEqual({ nonce: 'nonce-1', userId: 'u1' });
    await expect(passwordRegister('kai', 'pw', 'Kai', true)).resolves.toMatchObject({ pending: true, apiKey: 'key-1' });
    await expect(passwordLogin('kai', 'pw', true)).resolves.toMatchObject({ apiKey: 'key-2' });
    await passwordChange('old-pw', 'new-pw');
    await expect(passwordSetupWithPasskey('kai', 'new-pw', 'verify-1', { id: 'cred' })).resolves.toMatchObject({ ok: true });
    await expect(listPasskeys()).resolves.toMatchObject({ credentials: [{ id: 'cred-1' }] });
    await deletePasskey('cred-1');

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit | undefined)?.method ?? 'GET',
      body: (init as RequestInit | undefined)?.body,
    }));
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['POST', '/api/auth/passkey/register/begin'],
      ['POST', '/api/auth/passkey/register/complete'],
      ['POST', '/api/auth/passkey/login/begin'],
      ['POST', '/api/auth/passkey/verify/begin'],
      ['POST', '/api/auth/passkey/login/complete'],
      ['POST', '/api/auth/passkey/login/complete?native=1'],
      ['POST', '/api/auth/password/register'],
      ['POST', '/api/auth/password/login'],
      ['POST', '/api/auth/password/change'],
      ['POST', '/api/auth/passkey/password/setup'],
      ['GET', '/api/auth/passkey/credentials'],
      ['DELETE', '/api/auth/passkey/credentials/cred-1'],
    ]);
    expect(JSON.parse(String(requests[0].body))).toEqual({ displayName: 'Kai' });
    expect(JSON.parse(String(requests[1].body))).toEqual({ challengeId: 'register-1', response: { id: 'cred' }, deviceName: 'Mac' });
    expect(JSON.parse(String(requests[2].body))).toEqual({});
    expect(JSON.parse(String(requests[6].body))).toEqual({ username: 'kai', password: 'pw', displayName: 'Kai', native: true });
    expect(JSON.parse(String(requests[8].body))).toEqual({ oldPassword: 'old-pw', newPassword: 'new-pw' });
  });
});
