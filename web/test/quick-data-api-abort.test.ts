/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, cleanup, waitFor, act } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../src/components/file-browser-lazy.js', () => ({
  FileBrowser: () => null,
}));

import { EXPECTED_USER_ID_HEADER } from '../../shared/http-header-names.js';
import {
  apiFetch,
  configure,
  configureExpectedUserId,
  onAuthExpired,
  resetRefreshStateForTesting,
} from '../src/api.js';
import {
  useQuickData,
  __resetQuickDataForTests,
} from '../src/components/QuickInputPanel.js';

describe('quick-data 401 refresh retry isolation across account/server switches', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    resetRefreshStateForTesting();
    __resetQuickDataForTests();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    __resetQuickDataForTests();
    onAuthExpired(() => undefined);
    configureExpectedUserId(null);
    configure('');
    resetRefreshStateForTesting();
    localStorage.clear();
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('aborts suspended 401 refresh retry when switching account or same-origin service base path so old body never lands on new endpoint', async () => {
    configure('https://host.test/tenant-a');
    configureExpectedUserId('user-a');

    let resolveRefresh!: (res: Response) => void;
    const putCalls: Array<{ url: string; body?: string; expectedUserId: string | null }> = [];
    let getCount = 0;

    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      const expectedUserId = headers.get(EXPECTED_USER_ID_HEADER);

      if (url.endsWith('/api/quick-data') && method === 'GET') {
        getCount += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                history: getCount === 1 ? ['a-initial'] : ['b-initial'],
                sessionHistory: {},
                commands: [],
                phrases: [],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      if (url.endsWith('/api/quick-data') && method === 'PUT') {
        putCalls.push({
          url,
          body: typeof init?.body === 'string' ? init.body : undefined,
          expectedUserId,
        });
        return Promise.resolve(new Response('unauthorized', { status: 401 }));
      }

      if (url.endsWith('/api/auth/refresh') && method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        });
      }

      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    let quick!: ReturnType<typeof useQuickData>;
    function Harness() {
      quick = useQuickData();
      return h('div', { 'data-testid': 'hist' }, quick.data.history.join(','));
    }

    render(h(Harness, null));
    await waitFor(() => expect(quick.loaded).toBe(true));
    expect(quick.data.history).toEqual(['a-initial']);

    // Edit under user-a on /tenant-a, flush on pagehide -> PUT returns 401 -> refresh suspends.
    act(() => {
      quick.recordHistory('user-a-secret', 's1');
    });
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(putCalls).toHaveLength(1));
    await waitFor(() => expect(typeof resolveRefresh).toBe('function'));
    expect(putCalls[0]).toEqual({
      url: 'https://host.test/tenant-a/api/quick-data',
      body: expect.stringContaining('user-a-secret'),
      expectedUserId: 'user-a',
    });

    // While 401 refresh is suspended, switch server path to /tenant-b and account to user-b.
    act(() => {
      configure('https://host.test/tenant-b');
      configureExpectedUserId('user-b');
    });

    // Resolve the suspended refresh OK — aborted request MUST NOT retry user-a's PUT to /tenant-b or user-b!
    await act(async () => {
      resolveRefresh(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(quick.data.history).toEqual(['b-initial']));
    expect(putCalls).toHaveLength(1);
    expect(putCalls.every((c) => c.url === 'https://host.test/tenant-a/api/quick-data')).toBe(true);

    // Pending snapshot remains scoped ONLY under /tenant-a|user-a, never /tenant-b|user-b.
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    expect(keys.some((k) => k.includes(encodeURIComponent('https://host.test/tenant-a|user-a')))).toBe(true);
    expect(keys.some((k) => k.includes(encodeURIComponent('https://host.test/tenant-b|user-b')))).toBe(false);
  });

  it('does not trigger onAuthExpired when 409 version_conflict payload contains auth_identity_changed or expected_user_id_mismatch as ordinary history text, while still triggering logout on real top-level 409 identity errors', async () => {
    const authExpiredCalls: Array<string | undefined> = [];
    onAuthExpired((reason) => {
      authExpiredCalls.push(reason);
    });

    configure('https://host.test/app');
    configureExpectedUserId('user-1');

    let serverSnapshot = {
      history: ['auth_identity_changed', 'expected_user_id_mismatch'],
      sessionHistory: { s1: ['auth_identity_changed', 'expected_user_id_mismatch'] },
      historyTimestamps: { auth_identity_changed: 3000, expected_user_id_mismatch: 2500 },
      sessionHistoryTimestamps: { s1: { auth_identity_changed: 3000, expected_user_id_mismatch: 2500 } },
      commands: [] as string[],
      phrases: [] as string[],
    };
    let serverVersion = 'v1:1';
    const putVersions: Array<string | undefined> = [];

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/quick-data') && method === 'GET') {
        // Initial load sees stale v1:0 before server advances to v1:1 with error-like history text.
        return new Response(
          JSON.stringify({
            data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
            version: 'v1:0',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/quick-data') && method === 'PUT') {
        const parsed = JSON.parse(String(init?.body)) as { data: typeof serverSnapshot; expectedVersion?: string };
        putVersions.push(parsed.expectedVersion);
        if (parsed.expectedVersion !== serverVersion) {
          return new Response(
            JSON.stringify({ error: 'version_conflict', data: serverSnapshot, version: serverVersion }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        }
        serverSnapshot = {
          history: parsed.data.history,
          sessionHistory: parsed.data.sessionHistory as { s1: string[] },
          historyTimestamps: parsed.data.historyTimestamps as typeof serverSnapshot.historyTimestamps,
          sessionHistoryTimestamps: parsed.data.sessionHistoryTimestamps as typeof serverSnapshot.sessionHistoryTimestamps,
          commands: parsed.data.commands,
          phrases: parsed.data.phrases,
        };
        serverVersion = 'v1:2';
        return new Response(
          JSON.stringify({ ok: true, version: serverVersion }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    let quick!: ReturnType<typeof useQuickData>;
    function Harness() {
      quick = useQuickData();
      return h('div', { 'data-testid': 'hist' }, quick.data.history.join(','));
    }

    const view = render(h(Harness, null));
    await waitFor(() => expect(quick.loaded).toBe(true));

    act(() => { quick.recordHistory('normal-cmd', 's1'); });
    window.dispatchEvent(new Event('pagehide'));

    // First PUT uses v1:0 -> 409 version_conflict containing 'auth_identity_changed' in history text ->
    // MUST NOT call onAuthExpired, MUST rebase & complete second PUT at v1:1!
    await waitFor(() => expect(putVersions).toEqual(['v1:0', 'v1:1']));
    expect(authExpiredCalls).toEqual([]);
    expect(serverSnapshot.history).toEqual(['normal-cmd', 'auth_identity_changed', 'expected_user_id_mismatch']);
    view.unmount();

    // Real top-level 409 auth_identity_changed MUST still trigger onAuthExpired (no CAS retry).
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'auth_identity_changed' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(apiFetch('/api/quick-data', { method: 'PUT', body: '{}' })).rejects.toThrow();
    expect(authExpiredCalls).toEqual(['auth_identity_changed']);
  });
});
