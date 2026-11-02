/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openSharedEntry,
  SharedOpenTimeoutError,
  DEFAULT_SHARED_ENTRY_OPEN_TIMEOUT_MS,
  type OpenSharedEntryResponse,
  type SharedEntrySummary,
} from '../src/api.js';
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

  afterEach(() => {
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
