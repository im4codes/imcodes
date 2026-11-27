/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import en from '../src/i18n/locales/en.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import es from '../src/i18n/locales/es.json';
import ru from '../src/i18n/locales/ru.json';
import {
  encodeVoiceHotwordProjectKey,
  flushVoiceHotwordsPush,
  getCompiledVoiceHotwordsForProject,
  getGlobalVoiceHotwordsRaw,
  getProjectVoiceHotwordsRaw,
  getShareHotwordsWithOthers,
  getVoiceHotwordsAuthScopeKey,
  listVoiceHotwordProjectKeys,
  registerOpenVoiceHotwordsSettingsHandler,
  registerVoiceHotwordsSyncClient,
  resetVoiceHotwordsScopeForTesting,
  resolveRemoteVoiceHotwordsForProvider,
  setActiveVoiceHotwordProject,
  setGlobalVoiceHotwordsRaw,
  setProjectVoiceHotwordsRaw,
  setShareHotwordsWithOthers,
  setVoiceHotwordsAuthScope,
  shouldSendRemoteVoiceHotwords,
  syncVoiceHotwordsFromServer,
  type VoiceHotwordProjectInput,
} from '../src/voice-hotwords.js';
import {
  configure as configureApi,
  configureExpectedUserId,
  fetchVoiceHotwords,
  updateVoiceHotwords,
} from '../src/api.js';
import { VoiceHotwordsSection } from '../src/components/VoiceHotwordsSection.js';
import { VoiceOverlay } from '../src/components/VoiceOverlay.js';
import { SettingsPage } from '../src/pages/SettingsPage.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts.project === 'string') return `${key}(${opts.project})`;
      if (opts && opts.count !== undefined && opts.max !== undefined) return `${opts.count}/${opts.max}`;
      return key;
    },
  }),
}));

describe('web voice hotwords store, privacy gate, UI, and i18n parity', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    resetVoiceHotwordsScopeForTesting();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    resetVoiceHotwordsScopeForTesting();
  });

  it('isolates hotwords per project, merges with global (project priority), and gates cross-account sharing by default', () => {
    setGlobalVoiceHotwordsRaw('Antigravity\n误识词 => GlobalTarget');
    setProjectVoiceHotwordsRaw('proj-a', 'IM.codes\nworktree\n误识词 => IM.codes');
    setProjectVoiceHotwordsRaw('proj-b', 'codex-sdk');

    const compiledA = getCompiledVoiceHotwordsForProject('proj-a');
    expect(compiledA.terms).toEqual(['IM.codes', 'worktree', 'Antigravity']);
    expect(compiledA.asrTerms).toEqual(['IM.codes', 'worktree', 'Antigravity', '误识词']);
    expect(compiledA.replacements).toEqual([{ from: '误识词', to: 'IM.codes' }]);

    const compiledB = getCompiledVoiceHotwordsForProject('proj-b');
    expect(compiledB.terms).toEqual(['codex-sdk', 'Antigravity', 'GlobalTarget']);
    expect(compiledB.asrTerms).toEqual(['codex-sdk', 'Antigravity', 'GlobalTarget', '误识词']);
    expect(compiledB.replacements).toEqual([{ from: '误识词', to: 'GlobalTarget' }]);

    // Privacy default: false for others' shared devices, always true for own PC App & server HTTP ASR
    expect(getShareHotwordsWithOthers()).toBe(false);
    expect(shouldSendRemoteVoiceHotwords({ providerKind: 'http_asr', isOwnDevice: false })).toBe(true);
    expect(shouldSendRemoteVoiceHotwords({ providerKind: 'pc_app', isOwnDevice: true })).toBe(true);
    expect(shouldSendRemoteVoiceHotwords({ providerKind: 'pc_app', isOwnDevice: false })).toBe(false);
    expect(resolveRemoteVoiceHotwordsForProvider({ providerKind: 'pc_app', isOwnDevice: false }, compiledA)).toBeUndefined();
    expect(resolveRemoteVoiceHotwordsForProvider({ providerKind: 'pc_app', isOwnDevice: true }, compiledA)).toEqual(['IM.codes', 'worktree', 'Antigravity', '误识词']);
    expect(resolveRemoteVoiceHotwordsForProvider({ providerKind: 'http_asr', isOwnDevice: false }, compiledA)).toEqual(['IM.codes', 'worktree', 'Antigravity', '误识词']);

    setShareHotwordsWithOthers(true);
    expect(getShareHotwordsWithOthers()).toBe(true);
    expect(resolveRemoteVoiceHotwordsForProvider({ providerKind: 'pc_app', isOwnDevice: false }, compiledA)).toEqual(['IM.codes', 'worktree', 'Antigravity', '误识词']);

    // Fallback compatibility with partial compiled objects lacking asrTerms
    const legacyCompiled = { terms: ['LegacyTerm'], contextText: 'LegacyTerm', replacements: [] };
    expect(resolveRemoteVoiceHotwordsForProvider({ providerKind: 'http_asr', isOwnDevice: false }, legacyCompiled as any)).toEqual(['LegacyTerm']);
  });

  it('renders VoiceHotwordsSection, persists project/global edits and share toggle, and switches projects', async () => {
    setProjectVoiceHotwordsRaw('other-proj', 'OtherWord');
    render(h(VoiceHotwordsSection, { currentProjectName: 'my-proj' }));

    const projectInput = screen.getByTestId('voice-hotwords-project-input') as HTMLTextAreaElement;
    const globalInput = screen.getByTestId('voice-hotwords-global-input') as HTMLTextAreaElement;
    const toggle = screen.getByTestId('voice-hotwords-share-toggle');

    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.input(projectInput, { target: { value: 'IM.codes\nworktree' } });
    fireEvent.input(globalInput, { target: { value: 'Antigravity' } });
    fireEvent.click(toggle);

    expect(getProjectVoiceHotwordsRaw('my-proj')).toBe('IM.codes\nworktree');
    expect(getGlobalVoiceHotwordsRaw()).toBe('Antigravity');
    expect(getShareHotwordsWithOthers()).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    const select = screen.getByTestId('voice-hotwords-project-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'other-proj' } });
    await waitFor(() => {
      expect((screen.getByTestId('voice-hotwords-project-input') as HTMLTextAreaElement).value).toBe('OtherWord');
    });
  });

  it('includes all voice hotword translation keys across all 7 supported locales', () => {
    const requiredKeys = [
      'voice_hotwords_title',
      'voice_hotwords_desc',
      'voice_hotwords_project_label',
      'voice_hotwords_project_empty_title',
      'voice_hotwords_project_select',
      'voice_hotwords_project_placeholder',
      'voice_hotwords_no_project',
      'voice_hotwords_global_label',
      'voice_hotwords_global_placeholder',
      'voice_hotwords_hint',
      'voice_hotwords_count',
      'voice_hotwords_share_toggle',
      'voice_hotwords_share_desc',
    ] as const;

    const locales = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, es, ru } as const;
    for (const [locale, dict] of Object.entries(locales)) {
      const settings = (dict as { settings: Record<string, unknown> }).settings;
      for (const key of requiredKeys) {
        expect(typeof settings[key], `${locale}.settings.${key}`).toBe('string');
        expect(String(settings[key]).trim().length, `${locale}.settings.${key} non-empty`).toBeGreaterThan(0);
      }
      expect(settings.voice_hotwords_project_placeholder, `${locale}.project_placeholder single line`).not.toContain('\n');
      expect(settings.voice_hotwords_global_placeholder, `${locale}.global_placeholder single line`).not.toContain('\n');
      const bannedCoinedHotwordsPattern = new RegExp(['\\u7231\\u7801', '\\u611b\\u78bc', 'ai ' + 'ma'].join('|'), 'i');
      expect(settings.voice_hotwords_project_placeholder, `${locale}.project_placeholder no coined hotword`).not.toMatch(bannedCoinedHotwordsPattern);
      expect(settings.voice_hotwords_global_placeholder, `${locale}.global_placeholder no coined hotword`).not.toMatch(bannedCoinedHotwordsPattern);
    }
  });

  it('strictly matches recursive key sets across all 7 supported locales with en.json', () => {
    function getKeys(obj: unknown, prefix = ''): string[] {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [prefix];
      const keys: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        const full = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          keys.push(...getKeys(v, full));
        } else {
          keys.push(full);
        }
      }
      return keys;
    }

    const enKeys = new Set(getKeys(en));
    const allLocales: Record<string, unknown> = { 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, es, ru };
    for (const [loc, data] of Object.entries(allLocales)) {
      const locKeys = new Set(getKeys(data));
      const missing = [...enKeys].filter((k) => !locKeys.has(k));
      const extra = [...locKeys].filter((k) => !enKeys.has(k));
      expect(missing, `${loc} missing keys compared to en.json`).toEqual([]);
      expect(extra, `${loc} extra keys compared to en.json`).toEqual([]);
    }
  });

  it('isolates global/project hotwords and consent across same-origin accounts (A -> B -> A), cross-server same-named projects, and explicit no-project entries', () => {
    const origin = 'https://app.im.codes';
    // Account A signs in
    setVoiceHotwordsAuthScope({ userId: 'user-a', baseUrl: origin });
    setGlobalVoiceHotwordsRaw('GlobalA');
    setShareHotwordsWithOthers(true);
    const srv1Proj = encodeVoiceHotwordProjectKey('codedeck', 'srv-1')!;
    const srv2Proj = encodeVoiceHotwordProjectKey('codedeck', 'srv-2')!;
    setProjectVoiceHotwordsRaw(srv1Proj, 'ServerOneTerm');
    setProjectVoiceHotwordsRaw(srv2Proj, 'ServerTwoTerm');
    setActiveVoiceHotwordProject(srv1Proj);

    expect(getCompiledVoiceHotwordsForProject(srv1Proj).terms).toEqual(['ServerOneTerm', 'GlobalA']);
    expect(getCompiledVoiceHotwordsForProject(srv2Proj).terms).toEqual(['ServerTwoTerm', 'GlobalA']);
    // Explicit no-project (`null`) MUST ignore _activeProjectKey and return only scoped global terms
    expect(getCompiledVoiceHotwordsForProject(null).terms).toEqual(['GlobalA']);

    // Logout deactivates previous account state immediately
    setVoiceHotwordsAuthScope(null);
    expect(getGlobalVoiceHotwordsRaw()).toBe('');
    expect(getShareHotwordsWithOthers()).toBe(false);
    expect(getCompiledVoiceHotwordsForProject(srv1Proj)).toEqual({ terms: [], asrTerms: [], contextText: '', replacements: [] });

    // Switch on same origin to Account B -> zero inheritance from A
    setVoiceHotwordsAuthScope({ userId: 'user-b', baseUrl: origin });
    expect(getGlobalVoiceHotwordsRaw()).toBe('');
    expect(getShareHotwordsWithOthers()).toBe(false);
    expect(getProjectVoiceHotwordsRaw(srv1Proj)).toBe('');
    expect(getCompiledVoiceHotwordsForProject(srv1Proj).terms).toEqual([]);
    setGlobalVoiceHotwordsRaw('GlobalB');
    expect(getCompiledVoiceHotwordsForProject(null).terms).toEqual(['GlobalB']);

    // Switch back to Account A -> A's global, multi-server project hotwords, and consent are restored
    setVoiceHotwordsAuthScope({ userId: 'user-a', baseUrl: origin });
    expect(getGlobalVoiceHotwordsRaw()).toBe('GlobalA');
    expect(getShareHotwordsWithOthers()).toBe(true);
    expect(getCompiledVoiceHotwordsForProject(srv1Proj).terms).toEqual(['ServerOneTerm', 'GlobalA']);
    expect(getCompiledVoiceHotwordsForProject(srv2Proj).terms).toEqual(['ServerTwoTerm', 'GlobalA']);
  });

  it('opens SettingsPage VoiceHotwordsSection preselected for the current VoiceOverlay project', async () => {
    setVoiceHotwordsAuthScope({ userId: 'user-nav', baseUrl: 'https://nav.example' });
    const srv1Proj = encodeVoiceHotwordProjectKey('my-app', 'srv-mac')!;
    const srv2Proj = encodeVoiceHotwordProjectKey('my-app', 'srv-win')!;
    setProjectVoiceHotwordsRaw(srv1Proj, 'MacTerm');
    setProjectVoiceHotwordsRaw(srv2Proj, 'WinTerm');

    let openedTarget: { section: 'voice-hotwords'; projectKey?: VoiceHotwordProjectInput; token: number } | null = null;
    const unregister = registerOpenVoiceHotwordsSettingsHandler((projectKey) => {
      openedTarget = { section: 'voice-hotwords', projectKey: projectKey ?? null, token: 1 };
    });

    try {
      const onClose = vi.fn();
      const overlay = render(
        h(VoiceOverlay, {
          open: true,
          autoStartListening: false,
          projectKey: srv2Proj,
          onClose,
          onSend: () => 'accepted',
        }),
      );

      const hwBtn = overlay.getByTestId('voice-overlay-hotwords-btn');
      fireEvent.click(hwBtn);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(openedTarget).toEqual({ section: 'voice-hotwords', projectKey: srv2Proj, token: 1 });
      overlay.unmount();

      render(
        h(SettingsPage, {
          displayName: 'Nav User',
          username: 'nav',
          hasPassword: true,
          initialTab: 'security',
          focusTarget: openedTarget,
          serverNamesById: { 'srv-mac': 'Mac Studio', 'srv-win': 'Win Box' },
          onBack: () => {},
          onDisplayNameChanged: () => {},
          onUserAuthUpdated: () => {},
        }),
      );

      await waitFor(() => {
        const input = screen.getByTestId('voice-hotwords-project-input') as HTMLTextAreaElement;
        expect(input.value).toBe('WinTerm');
      });
      const select = screen.getByTestId('voice-hotwords-project-select') as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent)).toEqual([
        'my-app · Mac Studio',
        'my-app · Win Box',
      ]);
    } finally {
      unregister();
    }
  });

  it('syncs bidirectionally with server via LWW, handles same-ms ties, tombstones, per-scope isolation, proto keys, and cold-start safety', async () => {
    vi.useFakeTimers();
    try {
      // Prototype-colliding legacy project keys work cleanly through get/set/list
      for (const protoKey of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        setProjectVoiceHotwordsRaw(protoKey, `Term_${protoKey}`);
        expect(getProjectVoiceHotwordsRaw(protoKey)).toBe(`Term_${protoKey}`);
      }
      expect(listVoiceHotwordProjectKeys()).toEqual(['__proto__', 'constructor', 'hasOwnProperty', 'toString']);

      // Cold-start safety: before setVoiceHotwordsAuthScope confirms identity, sync MUST NOT fire
      const fetchRecord = vi.fn(async () => ({
        version: 1 as const,
        user: { raw: '', updatedAt: 0 },
        projects: {},
        shareWithOthers: { enabled: false, updatedAt: 0 },
      }));
      const updateRecord = vi.fn(async () => ({
        version: 1 as const,
        user: { raw: '', updatedAt: 0 },
        projects: {},
        shareWithOthers: { enabled: false, updatedAt: 0 },
      }));
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'stale-cached', baseUrl: 'https://sync.example' }));
      registerVoiceHotwordsSyncClient({ fetchRecord, updateRecord });
      await syncVoiceHotwordsFromServer();
      expect(fetchRecord).not.toHaveBeenCalled();

      // Confirm user-1 only AFTER mocking serverState, and seed legacy local data prior to first server sync
      resetVoiceHotwordsScopeForTesting();
      localStorage.clear();
      setVoiceHotwordsAuthScope({ userId: 'user-1', baseUrl: 'https://sync.example' });
      setGlobalVoiceHotwordsRaw('LegacyGlobal');
      setProjectVoiceHotwordsRaw('srv:srv-1::app', 'LegacyProj');
      setProjectVoiceHotwordsRaw('srv:srv-1::bad_overflow', 'ValidThenBad');
      setProjectVoiceHotwordsRaw('srv:srv-1::oversized', 'x'.repeat(9000));
      setShareHotwordsWithOthers(true);

      const serverState: any = {
        version: 1,
        user: { raw: '', updatedAt: 0 },
        projects: {
          'srv:srv-1::app': { raw: '', updatedAt: Date.now() + 10_000 }, // empty tombstone beats legacy
          'srv:srv-1::other': { raw: 'FromMcp', updatedAt: 500, source: 'mcp' },
        },
        shareWithOthers: { enabled: true, updatedAt: 500 },
      };

      fetchRecord.mockImplementation(async () => structuredClone(
        getVoiceHotwordsAuthScopeKey()?.endsWith('|user-1')
          ? serverState
          : { version: 1, user: { raw: '', updatedAt: 0 }, projects: {}, shareWithOthers: { enabled: false, updatedAt: 0 } },
      ));
      updateRecord.mockImplementation(async (payload: any) => {
        // Simulate server rejecting one project with 400 too_many_projects while accepting user/share scopes independently
        if (payload.scope === 'project' && payload.projectKey === 'srv:srv-1::bad_overflow') {
          const err = new Error('too_many_projects') as Error & { status: number };
          err.status = 400;
          throw err;
        }
        if (payload.scope === 'user') {
          serverState.user = { raw: payload.raw, updatedAt: payload.clientUpdatedAt ?? Date.now() };
        } else if (payload.scope === 'project') {
          serverState.projects[payload.projectKey] = { raw: payload.raw, updatedAt: payload.clientUpdatedAt ?? Date.now() };
        } else if (payload.scope === 'share') {
          serverState.shareWithOthers = { enabled: payload.enabled, updatedAt: payload.clientUpdatedAt ?? Date.now() };
        }
        return structuredClone(serverState);
      });

      registerVoiceHotwordsSyncClient({ fetchRecord, updateRecord });
      await syncVoiceHotwordsFromServer();

      // Oversized & 400-rejected project MUST keep local raw WITHOUT blocking user/share migration!
      expect(serverState.user.raw).toBe('LegacyGlobal');
      expect(getProjectVoiceHotwordsRaw('srv:srv-1::app')).toBe('');
      expect(getProjectVoiceHotwordsRaw('srv:srv-1::other')).toBe('FromMcp');
      expect(getProjectVoiceHotwordsRaw('srv:srv-1::oversized').length).toBe(9000);
      expect(getProjectVoiceHotwordsRaw('srv:srv-1::bad_overflow')).toBe('ValidThenBad');

      // Revoking shareWithOthers=false MUST succeed even alongside oversized/rejected projects
      setShareHotwordsWithOthers(false);
      await vi.advanceTimersByTimeAsync(350);
      expect(serverState.shareWithOthers.enabled).toBe(false);

      // Same-millisecond LWW tie resolution: server wins ties -> local MUST converge to server's winning value!
      const nowFixed = Date.now() + 50_000;
      vi.setSystemTime(nowFixed);
      setGlobalVoiceHotwordsRaw('ClientTieChoice');
      updateRecord.mockImplementationOnce(async () => ({
        ...structuredClone(serverState),
        user: { raw: 'ServerTieWinner', updatedAt: nowFixed },
      }));
      await flushVoiceHotwordsPush();
      expect(getGlobalVoiceHotwordsRaw()).toBe('ServerTieWinner');

      // Non-dirty previously-synced local cache whose key is absent from server does NOT resurrect on re-sync
      setProjectVoiceHotwordsRaw('srv:srv-1::evicted', 'OldTerm');
      await flushVoiceHotwordsPush();
      delete serverState.projects['srv:srv-1::evicted'];
      await syncVoiceHotwordsFromServer();
      expect(getProjectVoiceHotwordsRaw('srv:srv-1::evicted')).toBe('');

      // Account switch mid-flight aborts old pull and prevents cross-account leakage
      let resolveSlow: ((val: any) => void) | null = null;
      fetchRecord.mockImplementationOnce((opts) => new Promise((resolve) => {
        resolveSlow = resolve;
        opts.signal?.addEventListener('abort', () => resolve({
          version: 1,
          user: { raw: 'StaleUserOneLeak', updatedAt: 999_999_999 },
          projects: {},
          shareWithOthers: { enabled: true, updatedAt: 999_999_999 },
        }));
      }));
      const slowSync = syncVoiceHotwordsFromServer();
      setVoiceHotwordsAuthScope({ userId: 'user-2', baseUrl: 'https://sync.example' });
      resolveSlow?.({
        version: 1,
        user: { raw: 'StaleUserOneLeak', updatedAt: 999_999_999 },
        projects: {},
        shareWithOthers: { enabled: true, updatedAt: 999_999_999 },
      });
      await slowSync;
      expect(getGlobalVoiceHotwordsRaw()).toBe('');
      expect(getShareHotwordsWithOthers()).toBe(false);

      // 404 degradation keeps local writes intact
      fetchRecord.mockResolvedValueOnce(null as any);
      updateRecord.mockResolvedValueOnce(null as any);
      setGlobalVoiceHotwordsRaw('OfflineOr404Term');
      await flushVoiceHotwordsPush();
      expect(getGlobalVoiceHotwordsRaw()).toBe('OfflineOr404Term');
    } finally {
      vi.useRealTimers();
    }
  });

  it('api wrapper fails closed before network when expectedUserId is unconfirmed or mismatched', async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      record: {
        version: 1,
        user: { raw: 'ApiSynced', updatedAt: 10 },
        projects: {},
        shareWithOthers: { enabled: false, updatedAt: 0 },
      },
    }), { status: 200 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      configureApi('https://api-test.example');
      configureExpectedUserId(null);

      await expect(fetchVoiceHotwords()).rejects.toThrow('voice_hotwords_unconfirmed_user');
      await expect(updateVoiceHotwords({ scope: 'user', raw: 'Bad' })).rejects.toThrow('voice_hotwords_unconfirmed_user');
      expect(mockFetch).not.toHaveBeenCalled();

      configureExpectedUserId('user-real');
      await expect(fetchVoiceHotwords({ expectedUserId: 'user-other' })).rejects.toThrow('voice_hotwords_unconfirmed_user');
      expect(mockFetch).not.toHaveBeenCalled();

      const rec = await fetchVoiceHotwords({ expectedUserId: 'user-real' });
      expect(rec?.user.raw).toBe('ApiSynced');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      configureExpectedUserId(null);
      globalThis.fetch = originalFetch;
    }
  });

  it('handles 6-minute-fast clocks across confirmed clears, stale offline resurrection, recoverable capacity retries, and serverId+prefix keys', async () => {
    vi.useFakeTimers();
    try {
      const serverBaseNow = Date.now();
      let serverRev = 100;
      const nextRev = () => {
        serverRev += 1;
        return serverRev;
      };
      const srv: any = {
        version: 1,
        user: { raw: 'InitialUser', updatedAt: serverRev, source: 'web' },
        projects: {},
        shareWithOthers: { enabled: true, updatedAt: serverRev },
      };
      let simulateCapacityFull = false;

      const fetchRecord = vi.fn(async () => structuredClone(srv));
      const updateRecord = vi.fn(async (payload: any) => {
        if (simulateCapacityFull && payload.scope === 'project') {
          const err = new Error('payload_too_large') as Error & { status: number; code: string };
          err.status = 400;
          err.code = 'payload_too_large';
          throw err;
        }
        if (payload.scope === 'user') {
          if (payload.baseUpdatedAt === undefined || payload.baseUpdatedAt === srv.user.updatedAt) {
            srv.user = { raw: payload.raw, updatedAt: nextRev(), source: 'web' };
          }
        } else if (payload.scope === 'project') {
          const curTs = srv.projects[payload.projectKey]?.updatedAt ?? 0;
          if (payload.baseUpdatedAt === undefined || payload.baseUpdatedAt === curTs) {
            srv.projects[payload.projectKey] = { raw: payload.raw, updatedAt: nextRev(), source: 'web' };
          }
        } else if (payload.scope === 'share') {
          if (payload.baseUpdatedAt === undefined || payload.baseUpdatedAt === srv.shareWithOthers.updatedAt) {
            srv.shareWithOthers = { enabled: payload.enabled, updatedAt: nextRev() };
          }
        }
        return structuredClone(srv);
      });

      setVoiceHotwordsAuthScope({ userId: 'user-skew', baseUrl: 'https://skew.example' });
      registerVoiceHotwordsSyncClient({ fetchRecord, updateRecord });
      await syncVoiceHotwordsFromServer();
      expect(getGlobalVoiceHotwordsRaw()).toBe('InitialUser');
      expect(getShareHotwordsWithOthers()).toBe(true);

      // 1. Device clock is 6 minutes ahead, edits & confirms PUT; server clamps/returns authoritative ts
      vi.setSystemTime(serverBaseNow + 6 * 60 * 1000);
      setGlobalVoiceHotwordsRaw('FastClockWord');
      await flushVoiceHotwordsPush();
      expect(srv.user.raw).toBe('FastClockWord');

      // MCP clears user hotwords with authoritative ts still < client's fast wall clock!
      srv.user = { raw: '', updatedAt: nextRev(), source: 'mcp' };
      await syncVoiceHotwordsFromServer();
      expect(getGlobalVoiceHotwordsRaw()).toBe('');

      // 2. Fast-clock offline edit based on old version arrives AFTER a later MCP clear & share revoke: MUST NOT resurrect!
      setGlobalVoiceHotwordsRaw('OfflineFastEdit');
      setShareHotwordsWithOthers(true);
      // Simulate server clearing & revoking AFTER client went offline (before push executes)
      srv.user = { raw: '', updatedAt: nextRev(), source: 'mcp' };
      srv.shareWithOthers = { enabled: false, updatedAt: nextRev() };
      await flushVoiceHotwordsPush();
      expect(srv.user.raw).toBe('');
      expect(srv.shareWithOthers.enabled).toBe(false);
      expect(getGlobalVoiceHotwordsRaw()).toBe('');
      expect(getShareHotwordsWithOthers()).toBe(false);

      // 3. Recoverable capacity conflict (payload_too_large): keeps dirty without 300ms spin, succeeds when space freed
      simulateCapacityFull = true;
      const projKeyA = encodeVoiceHotwordProjectKey('srv:other::my-app', 'srv-1')!;
      const projKeyB = encodeVoiceHotwordProjectKey('srv:other::my-app', 'srv-2')!;
      expect(projKeyA).toBe('srv:srv-1::srv:other::my-app');
      expect(projKeyB).toBe('srv:srv-2::srv:other::my-app');

      setProjectVoiceHotwordsRaw(projKeyA, 'PendingValidHotword');
      setGlobalVoiceHotwordsRaw('IndependentValidGlobal'); // other valid scope succeeds even while project fails capacity!
      await vi.advanceTimersByTimeAsync(350);
      expect(srv.user.raw).toBe('IndependentValidGlobal');
      expect(srv.projects[projKeyA]).toBeUndefined();
      const callsRightAfterCapacityFail = updateRecord.mock.calls.length;

      // No 300ms spin on capacity error
      await vi.advanceTimersByTimeAsync(1500);
      expect(updateRecord.mock.calls.length).toBe(callsRightAfterCapacityFail);

      // Space freed externally -> next sync pull automatically retries the capacity-blocked project & persists it!
      simulateCapacityFull = false;
      await syncVoiceHotwordsFromServer();
      expect(srv.projects[projKeyA]?.raw).toBe('PendingValidHotword');
      expect(getProjectVoiceHotwordsRaw(projKeyA)).toBe('PendingValidHotword');
      expect(getProjectVoiceHotwordsRaw(projKeyB)).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prevents stale-PUT + mid-flight-edit resurrection after external clear and recovers committed writes across serialization/lost replies', async () => {
    vi.useFakeTimers();
    try {
      let rev = 100;
      const nextRev = () => {
        rev += 1;
        return rev;
      };
      const projKey = 'srv:srv-1::race-app';
      const srv: any = {
        version: 1,
        user: { raw: 'OldUser', updatedAt: 100, source: 'web' },
        projects: { [projKey]: { raw: 'OldProj', updatedAt: 100, source: 'web' } },
        shareWithOthers: { enabled: true, updatedAt: 100 },
      };

      const projectPutBases: Array<number | undefined> = [];
      const projectCommittedRevs: number[] = [];
      const userPutBases: Array<number | undefined> = [];
      const sharePutBases: Array<number | undefined> = [];
      let delayNextPut: {
        started: Promise<void>;
        markStarted: () => void;
        release: () => void;
        signalAborted?: boolean;
      } | null = null;
      let dropNextPutReplyAfterCommit = false;

      const recordPutBase = (payload: any) => {
        if (payload.scope === 'project') projectPutBases.push(payload.baseUpdatedAt);
        else if (payload.scope === 'user') userPutBases.push(payload.baseUpdatedAt);
        else if (payload.scope === 'share') sharePutBases.push(payload.baseUpdatedAt);
      };

      const applyServerPut = (payload: any) => {
        if (payload.scope === 'project') {
          const cur = srv.projects[payload.projectKey] ?? { raw: '', updatedAt: 0 };
          let applied = false;
          if (payload.baseUpdatedAt === cur.updatedAt) {
            const committedRev = nextRev();
            srv.projects[payload.projectKey] = {
              raw: payload.raw,
              updatedAt: committedRev,
              source: 'web',
              ...(payload.writeId ? { lastWriteId: payload.writeId } : {}),
            };
            projectCommittedRevs.push(committedRev);
            applied = true;
          } else if (payload.writeId && cur.lastWriteId === payload.writeId) {
            applied = true;
          }
          return {
            ok: true,
            applied,
            appliedScopes: { projects: { [payload.projectKey]: applied } },
            record: structuredClone(srv),
          };
        }
        if (payload.scope === 'user') {
          let applied = false;
          if (payload.baseUpdatedAt === srv.user.updatedAt) {
            srv.user = {
              raw: payload.raw,
              updatedAt: nextRev(),
              source: 'web',
              ...(payload.writeId ? { lastWriteId: payload.writeId } : {}),
            };
            applied = true;
          } else if (payload.writeId && srv.user.lastWriteId === payload.writeId) {
            applied = true;
          }
          return {
            ok: true,
            applied,
            appliedScopes: { user: applied },
            record: structuredClone(srv),
          };
        }
        let applied = false;
        if (payload.baseUpdatedAt === srv.shareWithOthers.updatedAt) {
          srv.shareWithOthers = {
            enabled: payload.enabled,
            updatedAt: nextRev(),
            ...(payload.writeId ? { lastWriteId: payload.writeId } : {}),
          };
          applied = true;
        } else if (payload.writeId && srv.shareWithOthers.lastWriteId === payload.writeId) {
          applied = true;
        }
        return {
          ok: true,
          applied,
          appliedScopes: { shareWithOthers: applied },
          record: structuredClone(srv),
        };
      };

      const fetchRecord = vi.fn(async () => structuredClone(srv));
      const updateRecord = vi.fn(async (payload: any, opts: { signal?: AbortSignal }) => {
        recordPutBase(payload);
        if (delayNextPut) {
          const gate = delayNextPut;
          delayNextPut = null;
          let releaseFn!: () => void;
          const waitRelease = new Promise<void>((r) => {
            releaseFn = r;
          });
          gate.release = releaseFn;
          gate.markStarted();
          await waitRelease;
          gate.signalAborted = Boolean(opts.signal?.aborted);
        }
        const result = applyServerPut(payload);
        if (dropNextPutReplyAfterCommit) {
          dropNextPutReplyAfterCommit = false;
          throw new Error('simulated_network_drop_after_commit');
        }
        return result;
      });

      setVoiceHotwordsAuthScope({ userId: 'user-race', baseUrl: 'https://race.example' });
      registerVoiceHotwordsSyncClient({ fetchRecord, updateRecord });
      await syncVoiceHotwordsFromServer();
      expect(getProjectVoiceHotwordsRaw(projKey)).toBe('OldProj');

      // Direction 1: Edit #1 delayed in flight, edit #2 locally, external MCP clears at V101, delayed PUT #1 rejected (applied: false) -> MUST NOT resend edit #2 on V101!
      let markStarted!: () => void;
      const started = new Promise<void>((r) => {
        markStarted = r;
      });
      const gate = { started, markStarted, release: () => {}, signalAborted: false };
      delayNextPut = gate;

      setProjectVoiceHotwordsRaw(projKey, 'Edit1Proj');
      const flush1 = flushVoiceHotwordsPush();
      await started;

      // User keeps typing edit #2 while PUT #1 is in flight & debounce timer runs, then MCP clears server to V101
      setProjectVoiceHotwordsRaw(projKey, 'Edit2Proj');
      await vi.advanceTimersByTimeAsync(350);
      expect(projectPutBases).toEqual([100]); // serialized: second debounce did not start or abort before first settled!

      srv.projects[projKey] = { raw: '', updatedAt: nextRev(), source: 'mcp' }; // no lastWriteId (101)
      gate.release();
      await flush1;
      await vi.advanceTimersByTimeAsync(500);

      expect(gate.signalAborted).toBe(false);
      expect(projectPutBases).toEqual([100]); // NEVER [100, 101]!
      expect(srv.projects[projKey].raw).toBe('');
      expect(getProjectVoiceHotwordsRaw(projKey)).toBe('');

      // Same Direction-1 invariant for user and share scopes
      const userBase = nextRev();
      const shareBase = nextRev();
      srv.user = { raw: 'User100', updatedAt: userBase, source: 'web' };
      srv.shareWithOthers = { enabled: true, updatedAt: shareBase };
      await syncVoiceHotwordsFromServer();

      let markUserStarted!: () => void;
      const userStarted = new Promise<void>((r) => {
        markUserStarted = r;
      });
      const userGate = { started: userStarted, markStarted: markUserStarted, release: () => {}, signalAborted: false };
      delayNextPut = userGate;
      setGlobalVoiceHotwordsRaw('UserEdit1');
      const userFlush1 = flushVoiceHotwordsPush();
      await userStarted;
      setGlobalVoiceHotwordsRaw('UserEdit2');
      srv.user = { raw: '', updatedAt: nextRev(), source: 'mcp' };
      userGate.release();
      await userFlush1;
      await vi.advanceTimersByTimeAsync(500);
      expect(userPutBases).toEqual([userBase]);
      expect(srv.user.raw).toBe('');
      expect(getGlobalVoiceHotwordsRaw()).toBe('');

      let markShareStarted!: () => void;
      const shareStarted = new Promise<void>((r) => {
        markShareStarted = r;
      });
      const shareGate = { started: shareStarted, markStarted: markShareStarted, release: () => {}, signalAborted: false };
      delayNextPut = shareGate;
      setShareHotwordsWithOthers(false);
      const shareFlush1 = flushVoiceHotwordsPush();
      await shareStarted;
      setShareHotwordsWithOthers(true);
      srv.shareWithOthers = { enabled: false, updatedAt: nextRev() };
      shareGate.release();
      await shareFlush1;
      await vi.advanceTimersByTimeAsync(500);
      expect(sharePutBases).toEqual([shareBase]);
      expect(srv.shareWithOthers.enabled).toBe(false);
      expect(getShareHotwordsWithOthers()).toBe(false);

      // Direction 2a: Own PUT #1 commits in flight while concurrent debounce + pull arrive -> neither aborts PUT #1, edit #2 commits on top!
      projectPutBases.length = 0;
      projectCommittedRevs.length = 0;
      const revBefore2a = srv.projects[projKey].updatedAt;
      let mark2aStarted!: () => void;
      const started2a = new Promise<void>((r) => {
        mark2aStarted = r;
      });
      const gate2a = { started: started2a, markStarted: mark2aStarted, release: () => {}, signalAborted: false };
      delayNextPut = gate2a;
      setProjectVoiceHotwordsRaw(projKey, 'OwnCommit1');
      const flush2a = flushVoiceHotwordsPush();
      await started2a;

      setProjectVoiceHotwordsRaw(projKey, 'OwnCommit2');
      const pullDuringPut = syncVoiceHotwordsFromServer();
      await vi.advanceTimersByTimeAsync(350);
      gate2a.release();
      await flush2a;
      await pullDuringPut;
      await vi.advanceTimersByTimeAsync(350);

      expect(gate2a.signalAborted).toBe(false);
      expect(srv.projects[projKey].raw).toBe('OwnCommit2');
      expect(getProjectVoiceHotwordsRaw(projKey)).toBe('OwnCommit2');
      expect(projectPutBases).toEqual([revBefore2a, projectCommittedRevs[0]]);

      // Direction 2b: PUT #1 commits on server (with lastWriteId) then reply drops before client sees it -> edit #2 recovers via GET OR direct PUT without being discarded!
      projectPutBases.length = 0;
      projectCommittedRevs.length = 0;
      const baseBeforeLost1 = srv.projects[projKey].updatedAt;
      dropNextPutReplyAfterCommit = true;
      setProjectVoiceHotwordsRaw(projKey, 'CommittedLostReply1');
      await flushVoiceHotwordsPush();
      const revAfterLost1 = srv.projects[projKey].updatedAt;
      expect(srv.projects[projKey].raw).toBe('CommittedLostReply1');

      // Local edit #2 while Web still thinks base is old -> GET recognizes own lastWriteId and pushes edit #2 cleanly
      setProjectVoiceHotwordsRaw(projKey, 'EditAfterLostReply2');
      await syncVoiceHotwordsFromServer();
      expect(srv.projects[projKey].raw).toBe('EditAfterLostReply2');
      expect(getProjectVoiceHotwordsRaw(projKey)).toBe('EditAfterLostReply2');
      expect(projectPutBases).toEqual([baseBeforeLost1, revAfterLost1]);

      // Direct flush recovery (no GET beforehand) when prior PUT committed & dropped before local edit #2
      projectPutBases.length = 0;
      projectCommittedRevs.length = 0;
      const baseBeforeLost3 = srv.projects[projKey].updatedAt;
      dropNextPutReplyAfterCommit = true;
      setProjectVoiceHotwordsRaw(projKey, 'CommittedLostReply3');
      await flushVoiceHotwordsPush();
      const revAfterLost3 = srv.projects[projKey].updatedAt;

      setProjectVoiceHotwordsRaw(projKey, 'DirectFlushEdit4');
      await flushVoiceHotwordsPush();
      expect(srv.projects[projKey].raw).toBe('DirectFlushEdit4');
      expect(getProjectVoiceHotwordsRaw(projKey)).toBe('DirectFlushEdit4');
      expect(projectPutBases).toEqual([baseBeforeLost3, baseBeforeLost3, revAfterLost3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes B -> A -> B account-switch queues without letting aborted A finally unblock concurrent B PUT during pending B GET', async () => {
    const baseUrl = 'https://epoch-race.example';
    const projKey = 'srv:srv-1::epoch-proj';
    const srvA: any = {
      version: 1,
      user: { raw: 'A_User', updatedAt: 50, source: 'web' },
      projects: { [projKey]: { raw: 'A_Proj', updatedAt: 50, source: 'web' } },
      shareWithOthers: { enabled: false, updatedAt: 50 },
    };
    const srvB: any = {
      version: 1,
      user: { raw: 'B_User', updatedAt: 100, source: 'web' },
      projects: { [projKey]: { raw: 'B_Initial', updatedAt: 100, source: 'web' } },
      shareWithOthers: { enabled: false, updatedAt: 100 },
    };

    let releaseA!: () => void;
    let releaseBGet!: () => void;
    let bGetPending = false;
    let sendsWhileBGetWasPending = 0;
    const events: string[] = [];

    const fetchRecord = vi.fn(async (opts: { expectedUserId: string; signal?: AbortSignal }) => {
      if (opts.expectedUserId === 'user-a') {
        events.push('fetchA:start');
        await new Promise<void>((resolve) => {
          releaseA = resolve;
          opts.signal?.addEventListener('abort', () => {
            // Delay settlement strictly asynchronously after switching back to B
            setTimeout(() => {
              events.push('fetchA:abortedSettled');
              resolve();
            }, 0);
          });
        });
        return structuredClone(srvA);
      }
      if (bGetPending) {
        events.push('fetchB2:start');
        await new Promise<void>((resolve) => {
          releaseBGet = resolve;
        });
        events.push('fetchB2:resolved');
      }
      return structuredClone(srvB);
    });

    const updateRecord = vi.fn(async (payload: any) => {
      if (bGetPending) sendsWhileBGetWasPending += 1;
      events.push(`putB:${payload.raw}`);
      if (payload.scope === 'project' && payload.baseUpdatedAt === (srvB.projects[payload.projectKey]?.updatedAt ?? 0)) {
        srvB.projects[payload.projectKey] = {
          raw: payload.raw,
          updatedAt: srvB.projects[payload.projectKey].updatedAt + 1,
          source: 'web',
          ...(payload.writeId ? { lastWriteId: payload.writeId } : {}),
        };
      }
      return { ok: true, applied: true, appliedScopes: { projects: { [payload.projectKey]: true } }, record: structuredClone(srvB) };
    });

    registerVoiceHotwordsSyncClient({ fetchRecord, updateRecord });

    // Complete B initial migration
    setVoiceHotwordsAuthScope({ userId: 'user-b', baseUrl });
    await Promise.resolve();
    await Promise.resolve();
    expect(getProjectVoiceHotwordsRaw(projKey)).toBe('B_Initial');

    // Switch to A (hang fetchA), then switch back to B with a pending B GET
    setVoiceHotwordsAuthScope({ userId: 'user-a', baseUrl });
    bGetPending = true;
    setVoiceHotwordsAuthScope({ userId: 'user-b', baseUrl });

    // Allow A's async abort settlement to finish BEFORE B's GET settles
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toContain('fetchA:abortedSettled');

    // Edit B & push while B's GET is STILL pending -> PUT MUST NOT fire yet!
    setProjectVoiceHotwordsRaw(projKey, 'B_NewWord');
    const pushPromise = flushVoiceHotwordsPush();
    await new Promise((r) => setTimeout(r, 10));
    expect(sendsWhileBGetWasPending).toBe(0);

    // Finish B GET -> PUT executes strictly AFTER GET, and both server and local converge to B_NewWord
    bGetPending = false;
    releaseBGet();
    await pushPromise;
    expect(srvB.projects[projKey].raw).toBe('B_NewWord');
    expect(getProjectVoiceHotwordsRaw(projKey)).toBe('B_NewWord');
    expect(events.indexOf('fetchB2:resolved')).toBeGreaterThan(-1);
    expect(events.indexOf('putB:B_NewWord')).toBeGreaterThan(events.indexOf('fetchB2:resolved'));
    releaseA?.();
  });

  it('preserves pending commit ID across 10+ failed offline edits/pushes, recovers final edit on reconnect, and still yields to external clear/revoke', async () => {
    let rev = 100;
    const nextRev = () => {
      rev += 1;
      return rev;
    };
    const projKey = 'srv:srv-1::offline-queue-proj';
    const srv: any = {
      version: 1,
      user: { raw: 'UserInit', updatedAt: 100, source: 'web' },
      projects: { [projKey]: { raw: 'ProjInit', updatedAt: 100, source: 'web' } },
      shareWithOthers: { enabled: true, updatedAt: 100 },
    };

    let offline = false;
    let dropNextCommitReply = false;

    const fetchRecord = vi.fn(async () => {
      if (offline) throw new Error('network_offline_get');
      return structuredClone(srv);
    });

    const updateRecord = vi.fn(async (payload: any) => {
      if (offline) throw new Error('network_offline_put');
      let applied = false;
      const appliedScopes: any = {};
      if (payload.scope === 'project') {
        const cur = srv.projects[payload.projectKey] ?? { raw: '', updatedAt: 0 };
        if (payload.baseUpdatedAt === cur.updatedAt) {
          srv.projects[payload.projectKey] = {
            raw: payload.raw,
            updatedAt: nextRev(),
            source: 'web',
            ...(payload.writeId ? { lastWriteId: payload.writeId } : {}),
          };
          applied = true;
        } else if (payload.writeId && cur.lastWriteId === payload.writeId) {
          applied = true;
        }
        appliedScopes.projects = { [payload.projectKey]: applied };
      } else if (payload.scope === 'user') {
        if (payload.baseUpdatedAt === srv.user.updatedAt) {
          srv.user = {
            raw: payload.raw,
            updatedAt: nextRev(),
            source: 'web',
            ...(payload.writeId ? { lastWriteId: payload.writeId } : {}),
          };
          applied = true;
        } else if (payload.writeId && srv.user.lastWriteId === payload.writeId) {
          applied = true;
        }
        appliedScopes.user = applied;
      } else if (payload.scope === 'share') {
        if (payload.baseUpdatedAt === srv.shareWithOthers.updatedAt) {
          srv.shareWithOthers = {
            enabled: payload.enabled,
            updatedAt: nextRev(),
            ...(payload.writeId ? { lastWriteId: payload.writeId } : {}),
          };
          applied = true;
        } else if (payload.writeId && srv.shareWithOthers.lastWriteId === payload.writeId) {
          applied = true;
        }
        appliedScopes.shareWithOthers = applied;
      }

      if (dropNextCommitReply) {
        dropNextCommitReply = false;
        throw new Error('dropped_reply_after_commit');
      }
      return { ok: true, applied, appliedScopes, record: structuredClone(srv) };
    });

    setVoiceHotwordsAuthScope({ userId: 'user-offline', baseUrl: 'https://offline.example' });
    registerVoiceHotwordsSyncClient({ fetchRecord, updateRecord });
    await syncVoiceHotwordsFromServer();

    // Part 1: First PUT commits on server across all 3 scopes with dropped replies -> 10 offline edits + failed pushes -> reconnect MUST keep & persist final 10th edit!
    dropNextCommitReply = true;
    setGlobalVoiceHotwordsRaw('UserCommittedLost');
    await flushVoiceHotwordsPush();
    dropNextCommitReply = true;
    setProjectVoiceHotwordsRaw(projKey, 'ProjCommittedLost');
    await flushVoiceHotwordsPush();
    dropNextCommitReply = true;
    setShareHotwordsWithOthers(false);
    await flushVoiceHotwordsPush();

    expect(srv.user.raw).toBe('UserCommittedLost');
    expect(srv.projects[projKey].raw).toBe('ProjCommittedLost');
    expect(srv.shareWithOthers.enabled).toBe(false);

    offline = true;
    for (let i = 1; i <= 10; i += 1) {
      setGlobalVoiceHotwordsRaw(`UserOffline_${i}`);
      setProjectVoiceHotwordsRaw(projKey, `ProjOffline_${i}`);
      setShareHotwordsWithOthers(i % 2 === 1);
      await flushVoiceHotwordsPush();
    }

    offline = false;
    await flushVoiceHotwordsPush();
    expect(srv.user.raw).toBe('UserOffline_10');
    expect(getGlobalVoiceHotwordsRaw()).toBe('UserOffline_10');
    expect(srv.projects[projKey].raw).toBe('ProjOffline_10');
    expect(getProjectVoiceHotwordsRaw(projKey)).toBe('ProjOffline_10');
    expect(srv.shareWithOthers.enabled).toBe(false);
    expect(getShareHotwordsWithOthers()).toBe(false);

    // Part 2: External MCP clear/revoke during offline still wins over local offline edits!
    dropNextCommitReply = true;
    setProjectVoiceHotwordsRaw(projKey, 'ProjCommittedLost2');
    await flushVoiceHotwordsPush();

    offline = true;
    for (let i = 1; i <= 10; i += 1) {
      setProjectVoiceHotwordsRaw(projKey, `StaleOffline_${i}`);
      setShareHotwordsWithOthers(true);
      await flushVoiceHotwordsPush();
    }
    // External MCP clears project and revokes share before reconnect
    srv.projects[projKey] = { raw: '', updatedAt: nextRev(), source: 'mcp' };
    srv.shareWithOthers = { enabled: false, updatedAt: nextRev() };

    offline = false;
    await syncVoiceHotwordsFromServer();
    expect(srv.projects[projKey].raw).toBe('');
    expect(getProjectVoiceHotwordsRaw(projKey)).toBe('');
    expect(srv.shareWithOthers.enabled).toBe(false);
    expect(getShareHotwordsWithOthers()).toBe(false);
  });

  it('recovers when PUT drops before commit, GET sees old base V100, and PUT #1 commits late at V101 across project/user/share while preserving external clear priority', async () => {
    let rev = 100;
    const nextRev = () => {
      rev += 1;
      return rev;
    };
    const projKey = 'srv:srv-1::delayed-commit-proj';
    const srv: any = {
      version: 1,
      user: { raw: 'User100', updatedAt: 100, source: 'web' },
      projects: { [projKey]: { raw: 'Proj100', updatedAt: 100, source: 'web' } },
      shareWithOthers: { enabled: true, updatedAt: 100 },
    };

    const delayedCommits: Array<() => void> = [];
    let dropBeforeCommit = false;
    let simulateExternalClearInsteadOfDelayedCommit = false;

    const applyServerPatch = (payload: any) => {
      let applied = false;
      const appliedScopes: any = {};
      if (payload.scope === 'project') {
        const cur = srv.projects[payload.projectKey] ?? { raw: '', updatedAt: 0 };
        if (payload.baseUpdatedAt === cur.updatedAt) {
          srv.projects[payload.projectKey] = {
            raw: payload.raw,
            updatedAt: nextRev(),
            source: 'web',
            ...(payload.writeId ? { lastWriteId: payload.writeId } : {}),
          };
          applied = true;
        } else if (payload.writeId && cur.lastWriteId === payload.writeId) {
          applied = true;
        }
        appliedScopes.projects = { [payload.projectKey]: applied };
      } else if (payload.scope === 'user') {
        if (payload.baseUpdatedAt === srv.user.updatedAt) {
          srv.user = {
            raw: payload.raw,
            updatedAt: nextRev(),
            source: 'web',
            ...(payload.writeId ? { lastWriteId: payload.writeId } : {}),
          };
          applied = true;
        } else if (payload.writeId && srv.user.lastWriteId === payload.writeId) {
          applied = true;
        }
        appliedScopes.user = applied;
      } else if (payload.scope === 'share') {
        if (payload.baseUpdatedAt === srv.shareWithOthers.updatedAt) {
          srv.shareWithOthers = {
            enabled: payload.enabled,
            updatedAt: nextRev(),
            ...(payload.writeId ? { lastWriteId: payload.writeId } : {}),
          };
          applied = true;
        } else if (payload.writeId && srv.shareWithOthers.lastWriteId === payload.writeId) {
          applied = true;
        }
        appliedScopes.shareWithOthers = applied;
      }
      return { ok: true, applied, appliedScopes, record: structuredClone(srv) };
    };

    const fetchRecord = vi.fn(async () => {
      // Independent GET sees pre-commit V100 while delayed PUT is still queued behind transaction lock
      return structuredClone(srv);
    });

    const updateRecord = vi.fn(async (payload: any) => {
      if (dropBeforeCommit) {
        delayedCommits.push(() => {
          applyServerPatch(payload);
        });
        throw new Error('connection_dropped_before_commit');
      }
      // Inside server transaction lock: any previously queued commit lands BEFORE this PUT executes (or MCP beat both)
      while (delayedCommits.length > 0) {
        const commitFn = delayedCommits.shift()!;
        if (!simulateExternalClearInsteadOfDelayedCommit) {
          commitFn();
        }
      }
      if (simulateExternalClearInsteadOfDelayedCommit) {
        simulateExternalClearInsteadOfDelayedCommit = false;
        srv.projects[projKey] = { raw: '', updatedAt: nextRev(), source: 'mcp' };
        srv.user = { raw: '', updatedAt: nextRev(), source: 'mcp' };
        srv.shareWithOthers = { enabled: false, updatedAt: nextRev() };
      }
      return applyServerPatch(payload);
    });

    setVoiceHotwordsAuthScope({ userId: 'user-delayed', baseUrl: 'https://delayed.example' });
    registerVoiceHotwordsSyncClient({ fetchRecord, updateRecord });
    await syncVoiceHotwordsFromServer();

    // Part 1: Drop connection BEFORE server commit across project, user, share -> GET reads V100 -> delayed PUT #1 commits V101 -> Edit #2 MUST still commit!
    dropBeforeCommit = true;
    setProjectVoiceHotwordsRaw(projKey, 'ProjDelayed1');
    setGlobalVoiceHotwordsRaw('UserDelayed1');
    setShareHotwordsWithOthers(false);
    await flushVoiceHotwordsPush();
    dropBeforeCommit = false;

    // Server still at V100 right now while delayed commits wait in server lock!
    expect(srv.projects[projKey].updatedAt).toBe(100);
    expect(srv.user.updatedAt).toBe(100);
    expect(srv.shareWithOthers.updatedAt).toBe(100);

    // Edit #2 locally, then run GET (sees V100!) followed by its push (where delayed commits land at V101+ right before retry/Edit #2)
    setProjectVoiceHotwordsRaw(projKey, 'ProjEdit2');
    setGlobalVoiceHotwordsRaw('UserEdit2');
    setShareHotwordsWithOthers(true);
    await syncVoiceHotwordsFromServer();

    expect(srv.projects[projKey].raw).toBe('ProjEdit2');
    expect(getProjectVoiceHotwordsRaw(projKey)).toBe('ProjEdit2');
    expect(srv.user.raw).toBe('UserEdit2');
    expect(getGlobalVoiceHotwordsRaw()).toBe('UserEdit2');
    expect(srv.shareWithOthers.enabled).toBe(true);
    expect(getShareHotwordsWithOthers()).toBe(true);

    // Part 2: External clear/revoke beats both delayed PUT #1 and Edit #2 when MCP lands first
    dropBeforeCommit = true;
    setProjectVoiceHotwordsRaw(projKey, 'ProjDelayed2');
    setGlobalVoiceHotwordsRaw('UserDelayed2');
    setShareHotwordsWithOthers(false);
    await flushVoiceHotwordsPush();
    dropBeforeCommit = false;

    setProjectVoiceHotwordsRaw(projKey, 'ProjEdit3');
    setGlobalVoiceHotwordsRaw('UserEdit3');
    setShareHotwordsWithOthers(true);
    simulateExternalClearInsteadOfDelayedCommit = true;
    await syncVoiceHotwordsFromServer();

    expect(srv.projects[projKey].raw).toBe('');
    expect(getProjectVoiceHotwordsRaw(projKey)).toBe('');
    expect(srv.user.raw).toBe('');
    expect(getGlobalVoiceHotwordsRaw()).toBe('');
    expect(srv.shareWithOthers.enabled).toBe(false);
    expect(getShareHotwordsWithOthers()).toBe(false);
  });
});
