import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  syncSessionIdentities,
  syncSessionIdentity,
  syncSessionIdentitiesForCommand,
  startSessionIdentitySync,
  stopSessionIdentitySync,
} from '../../src/daemon/session-identity-sync.js';
import {
  identityStoreReadStatsForTests,
  localSessionIdentityDbPath,
  putLocalSessionIdentityProfile,
  resetIdentityStoreCacheForTests,
} from '../../src/daemon/session-identity-local-store.js';
import {
  identityResolverCacheStatsForTests,
  resolveDriftedSessionIdentities,
  resetSessionIdentityResolverCacheForTests,
} from '../../src/daemon/session-identity-resolver.js';
import * as watchdog from '../../src/daemon/event-loop-watchdog.js';
import { identityPromptHash } from '../../src/util/identity-prompt-hash.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import {
  renderSessionIdentityProfiles,
  type SessionIdentityProfile,
} from '../../shared/session-identity.js';

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    name: 'deck_proj_brain',
    projectName: 'proj',
    projectDir: '/tmp/proj',
    role: 'brain',
    agentType: 'codex-sdk',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    contextNamespace: { scope: 'user_private', userId: 'u1', projectId: 'repo-1' },
    ...overrides,
  };
}

function profile(scope: SessionIdentityProfile['scope'], scopeKey: string, content: string): SessionIdentityProfile {
  return { scope, scopeKey, content, contentHash: content, revision: 1, updatedAt: 1, source: 'mcp' };
}

/**
 * Owner rule (tsk_cd_identity_daemon_storage): the 60s reconciliation loop
 * now reads only the daemon's own local cache -- no network call of any
 * kind. Every test below passes a `boundServerId` spy purely to compute the
 * SESSION-scope key deterministically; it is never a network operation
 * (session-identity-local-store.js's listLocalSessionIdentityProfiles is the
 * only "fetch", and it is a local-disk read).
 */
describe('local-only session identity reconciliation', () => {
  it('reads one local snapshot and refreshes only sessions whose effective identity changed', async () => {
    const unchangedPrompt = renderSessionIdentityProfiles([profile('user', '', 'global')]);
    const sessions = [
      session({ name: 'deck_proj_brain', appliedIdentityHash: identityPromptHash(unchangedPrompt) }),
      session({ name: 'deck_proj_cc1' }),
      session({ name: 'deck_other_brain', projectName: 'other', appliedIdentityHash: identityPromptHash(unchangedPrompt), contextNamespace: { scope: 'user_private', userId: 'u1', projectId: 'repo-2' } }),
      session({ name: 'deck_stopped', state: 'stopped' }),
    ];
    const listLocalProfiles = vi.fn(async () => [
      profile('user', '', 'global'),
      profile('project', 'repo-1', 'repo rules'),
      profile('session', 'srv-9:deck_proj_cc1', 'worker rules'),
    ]);
    const applyIdentity = vi.fn(() => ({ applied: true }));

    const result = await syncSessionIdentities({
      listLocalProfiles,
      listLocalSessions: () => sessions,
      applyIdentity,
      boundServerId: async () => 'srv-9',
    });

    expect(result).toEqual({ status: 'ok', checked: 3, changed: 2 });
    expect(listLocalProfiles).toHaveBeenCalledTimes(1);
    expect(applyIdentity).toHaveBeenCalledWith(
      'deck_proj_cc1',
      expect.stringMatching(/<user>[\s\S]*<project>[\s\S]*<session>/),
      { refresh: true },
    );
    expect(applyIdentity).not.toHaveBeenCalledWith('deck_stopped', expect.anything(), expect.anything());
  });

  it('an unreadable identity store applies NOTHING (it is not "no identity") and the session keeps what it runs with', async () => {
    const applyIdentity = vi.fn(() => ({ applied: true }));
    const sessions = [session({ appliedIdentityHash: 'running-with-this' })];
    await expect(syncSessionIdentities({
      listLocalProfiles: async () => { throw new Error('identity store unreadable'); },
      listLocalSessions: () => sessions,
      applyIdentity,
      boundServerId: async () => 'srv-9',
    })).rejects.toThrow('identity store unreadable');
    expect(applyIdentity).not.toHaveBeenCalled();
    expect(sessions[0]!.appliedIdentityHash).toBe('running-with-this');
  });

  it('a session whose identity was removed is applied once (to nothing), then stays quiet', async () => {
    const applyIdentity = vi.fn(() => ({ applied: true }));
    const running = session({ appliedIdentityHash: identityPromptHash('old identity') });
    const deps = { listLocalProfiles: async () => [], listLocalSessions: () => [running], applyIdentity, boundServerId: async () => 'srv-9' };
    await expect(syncSessionIdentities(deps)).resolves.toEqual({ status: 'ok', checked: 1, changed: 1 });
    expect(applyIdentity).toHaveBeenCalledWith('deck_proj_brain', undefined, { refresh: true });
    running.appliedIdentityHash = undefined; // what applyEffectiveSessionIdentity records for "no identity"
    await expect(syncSessionIdentities(deps)).resolves.toEqual({ status: 'ok', checked: 1, changed: 0 });
  });

  it('joins a concurrent periodic sync instead of falsely reporting skipped before apply completes', async () => {
    let releaseSnapshot!: (value: SessionIdentityProfile[]) => void;
    const listLocalProfiles = vi.fn(() => new Promise<SessionIdentityProfile[]>((resolve) => { releaseSnapshot = resolve; }));
    const applyIdentity = vi.fn(() => ({ applied: true }));
    const deps = {
      listLocalProfiles,
      listLocalSessions: () => [session({})],
      applyIdentity,
      boundServerId: async () => 'srv-9',
    };

    const periodic = syncSessionIdentities(deps);
    const explicit = syncSessionIdentities(deps);
    expect(listLocalProfiles).toHaveBeenCalledTimes(1);
    releaseSnapshot([profile('user', '', 'global')]);

    await expect(periodic).resolves.toEqual({ status: 'ok', checked: 1, changed: 1 });
    await expect(explicit).resolves.toEqual({ status: 'ok', checked: 1, changed: 1 });
    expect(applyIdentity).toHaveBeenCalledTimes(1);
  });

  it('never calls out to the network -- listLocalProfiles is the only data source', async () => {
    const listLocalProfiles = vi.fn(async () => [profile('user', '', 'global')]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch must never be called by the local sync loop');
    });
    try {
      await syncSessionIdentities({
        listLocalProfiles,
        listLocalSessions: () => [session({})],
        applyIdentity: () => ({ applied: true }),
        boundServerId: async () => 'srv-9',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('builds the explicit refresh ack only after convergence and carries failures', async () => {
    const runSync = vi.fn(async () => ({ status: 'ok' as const, checked: 1, changed: 1 }));
    await expect(syncSessionIdentitiesForCommand({
      commandId: 'identity-1',
      sessionName: 'deck_proj_brain',
    }, runSync)).resolves.toEqual({
      commandId: 'identity-1',
      sessionName: 'deck_proj_brain',
      status: 'ok',
    });
    await expect(syncSessionIdentitiesForCommand({
      commandId: 'identity-2',
      sessionName: 'deck_proj_brain',
    }, async () => { throw new Error('profile fetch failed'); })).resolves.toEqual({
      commandId: 'identity-2',
      sessionName: 'deck_proj_brain',
      status: 'error',
      error: 'profile fetch failed',
    });
  });

  it('uses the local scoped reads for an explicit refresh of one session', async () => {
    const listLocalProfiles = vi.fn(async () => [
      profile('user', '', 'global'), profile('session', 'srv-9:deck_proj_brain', 'session'),
    ]);
    const applyIdentity = vi.fn(() => ({ applied: true }));
    const result = await syncSessionIdentity('deck_proj_brain', {
      listLocalProfiles,
      listLocalSessions: () => [session({})],
      applyIdentity,
      boundServerId: async () => 'srv-9',
    });
    expect(result).toEqual({ status: 'ok', checked: 1, changed: 1 });
    expect(applyIdentity).toHaveBeenCalledWith(
      'deck_proj_brain', expect.stringContaining('session'), { refresh: true },
    );
  });

  it('reports the target unavailable instead of applying a stopped/missing session', async () => {
    const result = await syncSessionIdentity('missing_session', {
      listLocalProfiles: async () => [],
      listLocalSessions: () => [session({ name: 'deck_stopped', state: 'stopped' })],
      applyIdentity: () => ({ applied: true }),
      boundServerId: async () => 'srv-9',
    });
    expect(result).toEqual({ status: 'error', checked: 0, changed: 0, message: 'session identity target is unavailable' });
  });
});

describe('metadata-first steady-state session identity reconciliation', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    stopSessionIdentitySync();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetIdentityStoreCacheForTests();
    resetSessionIdentityResolverCacheForTests();
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeIsolatedHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-identity-sync-scale-'));
    createdDirs.push(dir);
    return dir;
  }

  it('triggers zero content reads and zero listScans in steady state across 50 x 220KB profiles (>11MB), and only fetches changed PKs on drift', async () => {
    const home = makeIsolatedHome();
    vi.stubEnv('IMCODES_HOME', home);
    resetIdentityStoreCacheForTests();
    resetSessionIdentityResolverCacheForTests();

    const userContent = `user-global:${'U'.repeat(90_000)}`;
    await putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: userContent, source: 'web' });
    const projContent = `proj-rules:${'P'.repeat(220_000)}`;
    await putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'repo-1', content: projContent, source: 'mcp' });

    const liveSessions: SessionRecord[] = [];
    for (let i = 0; i < 50; i += 1) {
      const name = `deck_proj_worker_${i}`;
      const sessContent = `worker-${i}:${'W'.repeat(220_000)}`;
      await putLocalSessionIdentityProfile({ scope: 'session', scopeKey: `srv-9:${name}`, content: sessContent, source: 'mcp' });
      liveSessions.push(session({ name }));
    }
    // Also seed 5 stale stopped-session profiles that active sync should never even touch
    for (let i = 0; i < 5; i += 1) {
      await putLocalSessionIdentityProfile({
        scope: 'session',
        scopeKey: `srv-9:deck_dead_${i}`,
        content: `dead-${i}:${'D'.repeat(220_000)}`,
        source: 'mcp',
      });
    }

    const applyIdentity = vi.fn((name: string, prompt: string | undefined) => {
      const rec = liveSessions.find((s) => s.name === name);
      if (rec) rec.appliedIdentityHash = identityPromptHash(prompt);
      return { applied: true };
    });

    const beforeCold = identityStoreReadStatsForTests();
    const cold = await syncSessionIdentities({
      listLocalSessions: () => liveSessions,
      applyIdentity,
      boundServerId: async () => 'srv-9',
    });
    expect(cold).toEqual({ status: 'ok', checked: 50, changed: 50 });
    expect(applyIdentity).toHaveBeenCalledTimes(50);

    const afterCold = identityStoreReadStatsForTests();
    // Cold pass uses metadata + targeted PK reads ONLY (1 user + 1 project + 50 live sessions = 52 PK reads; dead profiles skipped)
    expect(afterCold.listScans).toBe(beforeCold.listScans);
    expect(afterCold.metaScans).toBe(beforeCold.metaScans + 1);
    expect(afterCold.pkReads).toBe(beforeCold.pkReads + 52);

    applyIdentity.mockClear();

    // Steady state pass 2 & 3: ZERO content/PK reads, ZERO full scans!
    const steady1 = await syncSessionIdentities({
      listLocalSessions: () => liveSessions,
      applyIdentity,
      boundServerId: async () => 'srv-9',
    });
    const steady2 = await syncSessionIdentities({
      listLocalSessions: () => liveSessions,
      applyIdentity,
      boundServerId: async () => 'srv-9',
    });
    expect(steady1).toEqual({ status: 'ok', checked: 50, changed: 0 });
    expect(steady2).toEqual({ status: 'ok', checked: 50, changed: 0 });
    expect(applyIdentity).not.toHaveBeenCalled();

    const afterSteady = identityStoreReadStatsForTests();
    expect(afterSteady.listScans).toBe(afterCold.listScans);
    expect(afterSteady.pkReads).toBe(afterCold.pkReads);
    expect(afterSteady.metaScans).toBe(afterCold.metaScans + 2);

    // Mutate ONE session profile -> loads ONLY the 3 PKs relevant to that drifted session (user + project + worker_7)
    await putLocalSessionIdentityProfile({
      scope: 'session',
      scopeKey: 'srv-9:deck_proj_worker_7',
      content: 'worker-7-updated',
      source: 'mcp',
    });
    const updateRes = await syncSessionIdentities({
      listLocalSessions: () => liveSessions,
      applyIdentity,
      boundServerId: async () => 'srv-9',
    });
    expect(updateRes).toEqual({ status: 'ok', checked: 50, changed: 1 });
    expect(applyIdentity).toHaveBeenCalledTimes(1);
    expect(applyIdentity).toHaveBeenCalledWith(
      'deck_proj_worker_7',
      expect.stringContaining('worker-7-updated'),
      { refresh: true },
    );

    const afterOneUpdate = identityStoreReadStatsForTests();
    expect(afterOneUpdate.listScans).toBe(afterSteady.listScans);
    expect(afterOneUpdate.pkReads).toBe(afterSteady.pkReads + 3);
  });

  it('invalidates shareKey cache immediately when pairTaskId changes', async () => {
    const home = makeIsolatedHome();
    vi.stubEnv('IMCODES_HOME', home);
    resetIdentityStoreCacheForTests();
    resetSessionIdentityResolverCacheForTests();

    await putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'base-user', source: 'web' });
    await putLocalSessionIdentityProfile({ scope: 'pair', scopeKey: 'tsk_round_1', content: 'pair-one', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'pair', scopeKey: 'tsk_round_2', content: 'pair-two', source: 'mcp' });

    let activePairId: string | undefined = 'tsk_round_1';
    const worker = session({ name: 'deck_proj_sub' });
    const applyIdentity = vi.fn((_name: string, prompt: string | undefined) => {
      worker.appliedIdentityHash = identityPromptHash(prompt);
      return { applied: true };
    });

    await syncSessionIdentities({
      listLocalSessions: () => [worker],
      applyIdentity,
      boundServerId: async () => 'srv-9',
      pairTaskIdForSession: () => activePairId,
    });
    expect(applyIdentity).toHaveBeenLastCalledWith('deck_proj_sub', expect.stringContaining('pair-one'), { refresh: true });

    // Steady state with same pairTaskId: 0 extra PK reads
    const beforeSteady = identityStoreReadStatsForTests();
    const resSteady = await syncSessionIdentities({
      listLocalSessions: () => [worker],
      applyIdentity,
      boundServerId: async () => 'srv-9',
      pairTaskIdForSession: () => activePairId,
    });
    expect(resSteady).toEqual({ status: 'ok', checked: 1, changed: 0 });
    expect(identityStoreReadStatsForTests().pkReads).toBe(beforeSteady.pkReads);

    // Pair reassignment changes pairTaskId -> shareKey changes -> applies pair-two immediately
    activePairId = 'tsk_round_2';
    const resSwitch = await syncSessionIdentities({
      listLocalSessions: () => [worker],
      applyIdentity,
      boundServerId: async () => 'srv-9',
      pairTaskIdForSession: () => activePairId,
    });
    expect(resSwitch).toEqual({ status: 'ok', checked: 1, changed: 1 });
    expect(applyIdentity).toHaveBeenLastCalledWith('deck_proj_sub', expect.stringContaining('pair-two'), { refresh: true });
  });

  it('fails closed when local SQLite identity store is unreadable via default metadata path', async () => {
    const home = makeIsolatedHome();
    vi.stubEnv('IMCODES_HOME', home);
    resetIdentityStoreCacheForTests();
    resetSessionIdentityResolverCacheForTests();

    await putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'valid', source: 'web' });
    resetIdentityStoreCacheForTests();
    await writeFile(localSessionIdentityDbPath(), 'corrupted sqlite bytes');

    const applyIdentity = vi.fn(() => ({ applied: true }));
    const live = [session({ appliedIdentityHash: 'keep-existing-hash' })];
    await expect(syncSessionIdentities({
      listLocalSessions: () => live,
      applyIdentity,
      boundServerId: async () => 'srv-9',
    })).rejects.toThrow();
    expect(applyIdentity).not.toHaveBeenCalled();
    expect(live[0]!.appliedIdentityHash).toBe('keep-existing-hash');
  });

  it('bounds shareKey -> hash cache at max entries and stores only hash digests without large content', async () => {
    resetSessionIdentityResolverCacheForTests();
    const bigContent = 'H'.repeat(50_000);
    const metaFor = (i: number): SessionIdentityProfile[] => [{
      scope: 'session',
      scopeKey: `srv-9:sess-${i}`,
      content: bigContent,
      contentHash: `hash-${i}`,
      revision: 1,
      updatedAt: 1,
      source: 'mcp',
    }];

    const total = 2200;
    for (let i = 0; i < total; i += 1) {
      const s: SessionRecord = session({ name: `sess-${i}` });
      await resolveDriftedSessionIdentities([s], {
        boundServerId: async () => 'srv-9',
        listMetadata: async () => metaFor(i).map(({ content: _c, ...m }) => m),
        getProfilesByKeys: async () => metaFor(i),
      });
    }

    const stats = identityResolverCacheStatsForTests();
    expect(stats.size).toBe(stats.max);
    expect(stats.max).toBe(2048);
  });

  it('wraps periodic startSessionIdentitySync cycle inside runPeriodicPass("session-identity-sync", ...)', async () => {
    const home = makeIsolatedHome();
    vi.stubEnv('IMCODES_HOME', home);
    resetIdentityStoreCacheForTests();

    const runPassSpy = vi.spyOn(watchdog, 'runPeriodicPass');
    startSessionIdentitySync();
    await vi.waitFor(() => {
      expect(runPassSpy).toHaveBeenCalledWith('session-identity-sync', expect.any(Function));
    });
  });
});
