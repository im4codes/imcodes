/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openSharedEntry,
  SharedOpenTimeoutError,
  DEFAULT_SHARED_ENTRY_OPEN_TIMEOUT_MS,
  configureApiKey,
  clearApiKey,
  resetRefreshStateForTesting,
  onAuthExpired,
  type OpenSharedEntryResponse,
  type SharedEntrySummary,
} from '../src/api.js';
import { AUTH_IDENTITY_ERRORS } from '../../shared/auth-identity.js';
import { SharedEntriesPanel } from '../src/components/SharedEntriesPanel.js';
import type { ShareTarget } from '../src/tab-sharing-ui.js';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

const WEB_ROOT = resolve(__dirname, '..');
const LOCALES = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'] as const;

describe('shared entry open bounded timeout & cancellation (api contract)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetRefreshStateForTesting();
  });

  afterEach(() => {
    resetRefreshStateForTesting();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('exports default bounded timeout of 15 seconds', () => {
    expect(DEFAULT_SHARED_ENTRY_OPEN_TIMEOUT_MS).toBe(15_000);
  });

  it('rejects with SharedOpenTimeoutError when open hangs longer than timeoutMs', async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation timed out.', 'TimeoutError'));
        });
      });
    }) as typeof fetch;

    const target: ShareTarget = { kind: 'server', serverId: 'server-slow' };
    const promise = openSharedEntry(target, { timeoutMs: 30 });

    await expect(promise).rejects.toThrow(SharedOpenTimeoutError);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('cancels fetch when caller passes an explicit AbortSignal', async () => {
    const callerController = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    }) as typeof fetch;

    const target: ShareTarget = { kind: 'server', serverId: 'server-cancel' };
    const promise = openSharedEntry(target, { signal: callerController.signal, timeoutMs: 10_000 });

    // Abort from caller (e.g. user clicked another item or navigated away)
    callerController.abort(new DOMException('User navigated away', 'AbortError'));

    await expect(promise).rejects.toThrow();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('completes normally when response arrives before timeout', async () => {
    const mockResponse: OpenSharedEntryResponse = {
      server: { id: 'srv-1', name: 'Server 1', status: 'online', lastHeartbeatAt: Date.now() },
      target: { kind: 'server', serverId: 'srv-1' },
      coverage: {
        effectiveRole: 'participant',
        historyCutoffAt: 0,
        nextCoverageRecheckAt: null,
        coveringShareIds: ['share-1'],
        primaryShareId: 'share-1',
        authorizedAt: Date.now(),
      },
      sessions: [{
        sessionName: 'deck_beta_brain',
        title: 'Beta Session',
        state: 'running',
        agentType: 'codex',
      }],
      subSessions: [],
    };

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => mockResponse,
      text: async () => JSON.stringify(mockResponse),
      headers: new Headers({ 'content-type': 'application/json' }),
    })) as unknown as typeof fetch;

    const res = await openSharedEntry({ kind: 'server', serverId: 'srv-1' }, { timeoutMs: 5000 });
    expect(res.server.id).toBe('srv-1');
    expect(res.sessions[0].sessionName).toBe('deck_beta_brain');
  });

  it('shared open deadline bounds hanging native 401 /me verification', async () => {
    vi.useFakeTimers();
    configureApiKey('isolated-test-key-not-real');
    let firstSignal: AbortSignal | null = null;
    vi.stubGlobal('fetch', vi.fn((url: string, opts: any) => {
      if (String(url).includes('/api/shares/open')) {
        firstSignal = opts.signal;
        return Promise.resolve({ status: 401, ok: false, text: async () => '', headers: new Headers() });
      }
      return new Promise(() => {});
    }));
    let settled = 'pending';
    const promise = openSharedEntry({ kind: 'server', serverId: 'fixture-server' }, { timeoutMs: 30 });
    void promise.then(() => { settled = 'success'; }, (e) => { settled = e.name; });
    await vi.advanceTimersByTimeAsync(2200);
    expect(firstSignal?.aborted).toBe(true);
    expect(settled, 'open must settle at its deadline even when auth verification is hung').toBe('SharedOpenTimeoutError');
    clearApiKey();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shared open deadline bounds hanging cookie 401 refresh coordination', async () => {
    vi.useFakeTimers();
    clearApiKey();
    let firstSignal: AbortSignal | null = null;
    vi.stubGlobal('fetch', vi.fn((url: string, opts: any) => {
      if (String(url).includes('/api/shares/open')) {
        firstSignal = opts.signal;
        return Promise.resolve({ status: 401, ok: false, text: async () => '', headers: new Headers() });
      }
      return new Promise(() => {});
    }));
    let settled = 'pending';
    const promise = openSharedEntry({ kind: 'server', serverId: 'fixture-server' }, { timeoutMs: 30 });
    void promise.then(() => { settled = 'success'; }, (e) => { settled = e.name; });
    await vi.advanceTimersByTimeAsync(2200);
    expect(firstSignal?.aborted).toBe(true);
    expect(settled, 'open must settle at its deadline even when cookie refresh is hung').toBe('SharedOpenTimeoutError');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('audit r2: default deadline includes cold auth telemetry before a dedicated native verifier', async () => {
    vi.useFakeTimers();
    configureApiKey('isolated-fixture-key');
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/api/shares/open')) {
        return new Promise((resolve) => setTimeout(() => resolve(new Response('', { status: 401 })), 14990));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }));
    let result = 'pending';
    void openSharedEntry({ kind: 'server', serverId: 'fixture' }).then(() => { result = 'opened'; }, (e) => { result = e.name; });
    await vi.advanceTimersByTimeAsync(15001);
    expect(result, '15s deadline must not wait another cold-telemetry interval').toBe('SharedOpenTimeoutError');
    clearApiKey();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('audit r2: canceled operation cannot expire auth from a late identity-error body', async () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    onAuthExpired(expired);
    const ctrl = new AbortController();
    let release!: (s: string) => void;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 409,
      ok: false,
      headers: new Headers(),
      text: () => new Promise<string>((resolve) => { release = resolve; }),
    })));
    const done = openSharedEntry({ kind: 'server', serverId: 'fixture' }, { signal: ctrl.signal }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toBeTypeOf('function');
    ctrl.abort(new DOMException('navigation superseded', 'AbortError'));
    release(JSON.stringify({ error: AUTH_IDENTITY_ERRORS.CHANGED }));
    await done;
    expect(expired, 'late body after caller cancel must not clear the newer route/login').not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('audit r2: successful response body wait is also bounded by the open deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: new Headers(),
      json: () => new Promise(() => {}),
    })));
    let result = 'pending';
    void openSharedEntry({ kind: 'server', serverId: 'fixture' }, { timeoutMs: 30 }).then(() => { result = 'opened'; }, (e) => { result = e.name; });
    await vi.advanceTimersByTimeAsync(50);
    expect(result, 'headers are not completed shared-open data; body must remain cancelable').toBe('SharedOpenTimeoutError');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('positive control: shared refresh allows Caller B to succeed when concurrent Caller A is canceled', async () => {
    clearApiKey();
    let refreshCalls = 0;
    let resolveRefresh!: (res: Response) => void;
    const refreshPromise = new Promise<Response>((resolve) => { resolveRefresh = resolve; });

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/auth/refresh')) {
        refreshCalls++;
        return refreshPromise;
      }
      if (u.includes('/api/shares/open')) {
        if (refreshCalls === 0) {
          return new Response('', { status: 401 });
        }
        return new Response(JSON.stringify({
          server: { id: 'srv-b', name: 'Server B', status: 'online', lastHeartbeatAt: Date.now() },
          target: { kind: 'server', serverId: 'srv-b' },
          coverage: {
            effectiveRole: 'participant',
            historyCutoffAt: 0,
            nextCoverageRecheckAt: null,
            coveringShareIds: ['share-b'],
            primaryShareId: 'share-b',
            authorizedAt: Date.now(),
          },
          sessions: [],
          subSessions: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('', { status: 404 });
    }));

    const ctrlA = new AbortController();
    const promiseA = openSharedEntry({ kind: 'server', serverId: 'srv-a' }, { signal: ctrlA.signal });
    const promiseB = openSharedEntry({ kind: 'server', serverId: 'srv-b' });

    // Wait until refresh is triggered
    await vi.waitFor(() => expect(refreshCalls).toBe(1));

    // Cancel Caller A while refresh is in flight
    ctrlA.abort(new DOMException('User changed mind', 'AbortError'));
    await expect(promiseA).rejects.toThrow();

    // Now resolve the shared refresh successfully for Caller B
    resolveRefresh(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const resB = await promiseB;
    expect(resB.server.id).toBe('srv-b');
    vi.unstubAllGlobals();
  });

  it('positive control: live request with 409 identity changed properly triggers onAuthExpired', async () => {
    const expired = vi.fn();
    onAuthExpired(expired);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 409,
      ok: false,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: AUTH_IDENTITY_ERRORS.CHANGED }),
    })));
    await expect(openSharedEntry({ kind: 'server', serverId: 'srv-live' })).rejects.toThrow();
    expect(expired).toHaveBeenCalledWith(AUTH_IDENTITY_ERRORS.CHANGED);
    vi.unstubAllGlobals();
  });

  it('positive control: normal successful shared open completes in a single request with no extra polling', async () => {
    let fetchCount = 0;
    const mockResponse: OpenSharedEntryResponse = {
      server: { id: 'srv-direct', name: 'Server Direct', status: 'online', lastHeartbeatAt: Date.now() },
      target: { kind: 'server', serverId: 'srv-direct' },
      coverage: {
        effectiveRole: 'participant',
        historyCutoffAt: 0,
        nextCoverageRecheckAt: null,
        coveringShareIds: ['share-direct'],
        primaryShareId: 'share-direct',
        authorizedAt: Date.now(),
      },
      sessions: [],
      subSessions: [],
    };
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCount++;
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const res = await openSharedEntry({ kind: 'server', serverId: 'srv-direct' });
    expect(res.server.id).toBe('srv-direct');
    expect(fetchCount).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe('all 7 locales include openTimeout and openFailed in share.sharedWithMe', () => {
  for (const locale of LOCALES) {
    it(`verifies locale ${locale} has non-empty openTimeout and openFailed`, () => {
      const file = resolve(WEB_ROOT, `src/i18n/locales/${locale}.json`);
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        share?: { sharedWithMe?: Record<string, string> };
      };
      const sharedWithMe = parsed.share?.sharedWithMe;
      expect(sharedWithMe, `${locale}: sharedWithMe missing`).toBeDefined();
      expect(typeof sharedWithMe?.openTimeout, `${locale}: openTimeout must be string`).toBe('string');
      expect(sharedWithMe?.openTimeout?.trim().length, `${locale}: openTimeout must not be empty`).toBeGreaterThan(0);
      expect(typeof sharedWithMe?.openFailed, `${locale}: openFailed must be string`).toBe('string');
      expect(sharedWithMe?.openFailed?.trim().length, `${locale}: openFailed must not be empty`).toBeGreaterThan(0);
    });
  }
});

describe('SharedEntriesPanel UI button state during in-flight open', () => {
  afterEach(() => {
    cleanup();
  });

  const entryZhilan: SharedEntrySummary = {
    id: 'shared-zhilan',
    serverId: 'srv-zhilan',
    serverName: 'Zhilan Server (ai-207)',
    targetLabel: 'Zhilan Workspace',
    role: 'participant',
    status: 'active',
    target: { kind: 'main', serverId: 'srv-zhilan', sessionName: 'deck_zhilan_brain' },
  };

  const entryUniversity: SharedEntrySummary = {
    id: 'shared-university',
    serverId: 'srv-university',
    serverName: 'University Server',
    targetLabel: 'University Workspace',
    role: 'participant',
    status: 'active',
    target: { kind: 'main', serverId: 'srv-university', sessionName: 'deck_uni_brain' },
  };

  it('disables only the pending entry button while keeping other shared entries enabled and clickable', () => {
    const onOpen = vi.fn();
    const onRefresh = vi.fn();

    render(
      <SharedEntriesPanel
        entries={[entryZhilan, entryUniversity]}
        openingEntryId="shared-zhilan"
        onOpen={onOpen}
        onRefresh={onRefresh}
      />,
    );

    const zhilanBtn = screen.getByText('Zhilan Workspace').closest('button')!;
    const universityBtn = screen.getByText('University Workspace').closest('button')!;

    expect(zhilanBtn.disabled).toBe(true);
    expect(universityBtn.disabled).toBe(false);

    // Clicking pending zhilan does not trigger onOpen
    fireEvent.click(zhilanBtn);
    expect(onOpen).not.toHaveBeenCalled();

    // Clicking university triggers onOpen immediately
    fireEvent.click(universityBtn);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(entryUniversity);
  });
});
