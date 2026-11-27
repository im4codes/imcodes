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

      // Now confirm user-1 and test full bidirectional LWW sync + legacy migration + tombstones + per-scope isolation
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
});
