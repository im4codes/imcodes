/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearCachedServerSessions,
  MAX_CACHED_SERVERS,
  readCachedServerSessions,
  SESSION_LIST_CACHE_STORAGE_KEY,
  writeCachedServerSessions,
} from '../src/session-list-cache.js';
import { mergeRestSessionEntry, mergeRestSessionList } from '../src/session-list-merge.js';
import type { SessionInfo } from '../src/types.js';

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    name: 'deck_control_center_brain',
    project: 'control-center',
    role: 'brain',
    agentType: 'claude-code-sdk',
    state: 'running',
    runtimeType: 'transport',
    label: 'Control Center',
    modelDisplay: 'claude-opus-4-6',
    activeModel: 'claude-opus-4-6',
    requestedModel: 'claude-opus-4-6',
    planLabel: 'Max',
    quotaLabel: '5h 12% · 7d 40%',
    quotaUsageLabel: 'used 12%',
    quotaMeta: {
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
    },
    ...overrides,
  };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('session-list-cache', () => {
  it('persists lightweight main tabs per serverId, restores model & quota with unknown state, and strips heavy queue data', () => {
    const control = makeSession({
      transportPendingMessages: ['secret queued prompt'],
      transportPendingMessageEntries: [{ clientMessageId: 'm1', text: 'secret queued prompt' }],
      error: 'stale error',
    });
    const testTab = makeSession({
      name: 'deck_test_brain',
      project: 'test',
      agentType: 'agy-sdk',
      label: 'Test',
      modelDisplay: 'gemini-3-pro',
      activeModel: 'gemini-3-pro',
      quotaLabel: 'Gemini 10% · Claude 20%',
    });

    writeCachedServerSessions('srv-100', [control, testTab]);
    const restored = readCachedServerSessions('srv-100');

    expect(restored).toHaveLength(2);
    expect(restored[0]).toMatchObject({
      name: 'deck_control_center_brain',
      label: 'Control Center',
      modelDisplay: 'claude-opus-4-6',
      activeModel: 'claude-opus-4-6',
      planLabel: 'Max',
      quotaLabel: '5h 12% · 7d 40%',
      quotaUsageLabel: 'used 12%',
      state: 'unknown',
    });
    expect(restored[0]?.transportPendingMessages).toBeUndefined();
    expect(restored[0]?.transportPendingMessageEntries).toBeUndefined();
    expect(restored[0]?.error).toBeUndefined();
    expect(restored[1]).toMatchObject({
      name: 'deck_test_brain',
      label: 'Test',
      modelDisplay: 'gemini-3-pro',
      quotaLabel: 'Gemini 10% · Claude 20%',
      state: 'unknown',
    });
  });

  it('excludes incognito, sub-sessions, and worker tabs and clears cleanly on logout', () => {
    writeCachedServerSessions('srv-100', [
      makeSession({ name: 'deck_main_brain' }),
      makeSession({ name: 'deck_secret_brain', incognito: true }),
      makeSession({ name: 'deck_sub_w1', role: 'w1' }),
      makeSession({ name: 'deck_main_w1', role: 'w1' }),
    ]);

    expect(readCachedServerSessions('srv-100').map((s) => s.name)).toEqual(['deck_main_brain']);

    // Even if tampered in storage, incognito / non-navigable rows are never hydrated.
    localStorage.setItem(
      SESSION_LIST_CACHE_STORAGE_KEY,
      JSON.stringify({
        'srv-100': {
          updatedAt: Date.now(),
          sessions: [
            { name: 'deck_main_brain', project: 'main', role: 'brain', agentType: 'codex-sdk' },
            { name: 'deck_tampered_incog_brain', project: 'x', role: 'brain', agentType: 'codex-sdk', incognito: true },
            { name: 'deck_sub_abc', project: 'x', role: 'w1', agentType: 'codex-sdk' },
          ],
        },
      }),
    );
    expect(readCachedServerSessions('srv-100').map((s) => s.name)).toEqual(['deck_main_brain']);

    clearCachedServerSessions();
    expect(readCachedServerSessions('srv-100')).toEqual([]);
  });

  it('bounds cached server count to MAX_CACHED_SERVERS and removes empty server entries', () => {
    vi.spyOn(Date, 'now').mockImplementation((() => {
      let tick = 1000;
      return () => ++tick;
    })());

    for (let i = 1; i <= MAX_CACHED_SERVERS + 2; i++) {
      writeCachedServerSessions(`srv-${i}`, [makeSession({ name: `deck_s${i}_brain`, project: `s${i}` })]);
    }

    expect(readCachedServerSessions('srv-1')).toEqual([]);
    expect(readCachedServerSessions('srv-2')).toEqual([]);
    expect(readCachedServerSessions(`srv-${MAX_CACHED_SERVERS + 2}`)).toHaveLength(1);

    // Authoritative empty list removes that server's stale tabs.
    writeCachedServerSessions(`srv-${MAX_CACHED_SERVERS + 2}`, []);
    expect(readCachedServerSessions(`srv-${MAX_CACHED_SERVERS + 2}`)).toEqual([]);
  });

  it('fails soft on corrupt JSON or throwing storage APIs', () => {
    localStorage.setItem(SESSION_LIST_CACHE_STORAGE_KEY, '{not-json');
    expect(readCachedServerSessions('srv-1')).toEqual([]);

    const throwingStorage = {
      getItem: () => { throw new Error('storage disabled'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => { throw new Error('storage disabled'); },
    } as unknown as Storage;

    expect(() => writeCachedServerSessions('srv-1', [makeSession()], throwingStorage)).not.toThrow();
    expect(readCachedServerSessions('srv-1', throwingStorage)).toEqual([]);
    expect(() => clearCachedServerSessions(throwingStorage)).not.toThrow();
  });
});

describe('mergeRestSessionEntry', () => {
  it('preserves cached modelDisplay and quotaMeta when REST /sessions omits them across providers, without flashing default', () => {
    for (const agentType of ['claude-code-sdk', 'agy-sdk', 'grok-sdk', 'muse-code-sdk', 'qwen', 'codex-sdk']) {
      const cached = makeSession({
        name: `deck_${agentType}_brain`,
        agentType,
        state: 'unknown',
        modelDisplay: 'custom-pro-model',
        activeModel: 'custom-pro-model',
        requestedModel: 'custom-pro-model',
        planLabel: 'Pro',
        quotaLabel: '5h 10% · 7d 20%',
        quotaUsageLabel: 'today 5/100',
        qwenModel: agentType === 'qwen' ? 'qwen3-coder-plus' : undefined,
      });
      const restRow: SessionInfo = {
        name: `deck_${agentType}_brain`,
        project: 'control-center',
        role: 'brain',
        agentType,
        state: 'unknown',
        label: 'Updated Label',
        modelDisplay: undefined,
        activeModel: undefined,
        requestedModel: undefined,
        planLabel: undefined,
        quotaLabel: undefined,
        quotaUsageLabel: undefined,
        quotaMeta: undefined,
        qwenModel: undefined,
      };

      const merged = mergeRestSessionEntry(restRow, cached);
      expect(merged.label).toBe('Updated Label');
      expect(merged.modelDisplay).toBe('custom-pro-model');
      expect(merged.activeModel).toBe('custom-pro-model');
      expect(merged.planLabel).toBe('Pro');
      expect(merged.quotaLabel).toBe('5h 10% · 7d 20%');
      expect(merged.quotaUsageLabel).toBe('today 5/100');
      expect(merged.quotaMeta).toEqual(cached.quotaMeta);
    }
  });

  it('does not downgrade live WS state back to unknown when REST resolves late', () => {
    const liveWs = makeSession({
      state: 'running',
      modelDisplay: 'claude-opus-4-6',
    });
    const lateRest: SessionInfo = {
      name: liveWs.name,
      project: liveWs.project,
      role: 'brain',
      agentType: liveWs.agentType,
      state: 'unknown',
    };

    const merged = mergeRestSessionEntry(lateRest, liveWs);
    expect(merged.state).toBe('running');
    expect(merged.modelDisplay).toBe('claude-opus-4-6');
  });

  it('preserves all 65+ navigable main tabs without arbitrary truncation at 64', () => {
    const many = Array.from({ length: 65 }, (_, idx) =>
      makeSession({
        name: `deck_proj_${idx}_brain`,
        project: `proj-${idx}`,
        label: `Tab ${idx}`,
        modelDisplay: `model-${idx}`,
      }),
    );

    writeCachedServerSessions('srv-many', many);
    const restored = readCachedServerSessions('srv-many');
    expect(restored).toHaveLength(65);
    expect(restored[64]).toMatchObject({
      name: 'deck_proj_64_brain',
      label: 'Tab 64',
      modelDisplay: 'model-64',
      state: 'unknown',
    });
  });

  it('sanitizes malformed quotaMeta (e.g. non-array groups) on hydration and fails soft when localStorage getter throws SecurityError', () => {
    localStorage.setItem(
      SESSION_LIST_CACHE_STORAGE_KEY,
      JSON.stringify({
        'srv-corrupt': {
          updatedAt: Date.now(),
          sessions: [
            {
              name: 'deck_good_with_bad_quota_brain',
              project: 'good',
              role: 'brain',
              agentType: 'agy-sdk',
              modelDisplay: 'gemini-3-pro',
              quotaMeta: { groups: 'bad' },
            },
            {
              name: 'deck_good_with_null_quota_brain',
              project: 'nullq',
              role: 'brain',
              agentType: 'claude-code-sdk',
              quotaMeta: null,
            },
          ],
        },
      }),
    );

    const restored = readCachedServerSessions('srv-corrupt');
    expect(restored).toHaveLength(2);
    expect(restored[0]).toMatchObject({
      name: 'deck_good_with_bad_quota_brain',
      modelDisplay: 'gemini-3-pro',
    });
    expect(restored[0]?.quotaMeta).toBeUndefined();
    expect(restored[1]?.quotaMeta).toBeNull();

    const desc = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    try {
      expect(readCachedServerSessions('srv-corrupt')).toEqual([]);
      expect(() => writeCachedServerSessions('srv-corrupt', [makeSession()])).not.toThrow();
      expect(() => clearCachedServerSessions()).not.toThrow();
    } finally {
      if (desc) Object.defineProperty(window, 'localStorage', desc);
    }
  });

  it('mergeRestSessionList keeps cached tabs when REST returns empty or partial rows before WS session_list', () => {
    const cachedA = makeSession({ name: 'deck_a_brain', project: 'a', modelDisplay: 'opus' });
    const cachedB = makeSession({ name: 'deck_b_brain', project: 'b', modelDisplay: 'sonnet' });

    expect(mergeRestSessionList([], [cachedA, cachedB]).map((s) => s.name)).toEqual([
      'deck_a_brain',
      'deck_b_brain',
    ]);

    const partialRest: SessionInfo[] = [
      { name: 'deck_a_brain', project: 'a', role: 'brain', agentType: 'claude-code-sdk', state: 'unknown', label: 'A from DB' },
    ];
    const mergedPartial = mergeRestSessionList(partialRest, [cachedA, cachedB]);
    expect(mergedPartial.map((s) => s.name)).toEqual(['deck_a_brain', 'deck_b_brain']);
    expect(mergedPartial[0]).toMatchObject({ label: 'A from DB', modelDisplay: 'opus' });
  });
});
