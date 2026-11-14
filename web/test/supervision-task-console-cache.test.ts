/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPERVISION_TASK_STATUS_CONTRACT_VERSION } from '@shared/supervision-config.js';
import { SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION } from '@shared/supervision-task-console.js';
import {
  MAX_CACHED_AUTHORITIES,
  SUPERVISION_TASK_CONSOLE_CACHE_STORAGE_KEY,
  clearAllSupervisionTaskConsoleCaches,
  clearSupervisionTaskConsoleCache,
  clearSupervisionTaskConsoleCacheForUser,
  readSupervisionTaskConsoleCache,
  writeSupervisionTaskConsoleCache,
  type SupervisionTaskConsoleAuthority,
} from '../src/supervision-task-console-cache.js';
import {
  SUPERVISION_TASK_CONSOLE_PHASE,
  SUPERVISION_TASK_CONSOLE_SYNC_STATE,
  createSupervisionTaskConsoleState,
  type SupervisionTaskConsoleReducerState,
} from '../src/supervision-task-console-reducer.js';

function makeAuthority(index: number, overrides: Partial<SupervisionTaskConsoleAuthority> = {}): SupervisionTaskConsoleAuthority {
  return {
    userId: 'user-1',
    serverId: `srv-${index}`,
    projectName: `proj-${index}`,
    coordinatorSessionName: `deck_proj_${index}_brain`,
    ...overrides,
  };
}

function makeSnapshotState(
  authority: SupervisionTaskConsoleAuthority,
  taskId: string,
  title = `Task ${taskId}`,
): SupervisionTaskConsoleReducerState {
  const base = createSupervisionTaskConsoleState({
    projectName: authority.projectName,
    coordinatorSessionName: authority.coordinatorSessionName,
  });
  return {
    ...base,
    subscriptionId: 'sub-live',
    phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
    hasAuthoritativeSnapshot: true,
    syncing: false,
    syncState: SUPERVISION_TASK_CONSOLE_SYNC_STATE.SYNCED,
    lastSyncedAt: 1_000,
    projectionVersion: 3,
    lastDurableEventId: 10,
    projectionEpoch: 'epoch-1',
    pairRevision: 1,
    pairProjection: true,
    tasks: {
      [taskId]: {
        taskId,
        title,
        status: 'implementing',
        phase: 'active',
        validationState: 'pending',
        updatedAt: 1_000,
        lastEventId: 10,
        pair: {
          status: 'working',
          flags: [],
          round: 0,
          blocking: ['P0'],
          executor: 'deck_sub_exec',
          auditor: 'deck_sub_aud',
          createdAt: 500,
          startedAt: 600,
          updatedAt: 1_000,
        },
      },
    },
    assignments: {},
    pools: [],
  };
}

describe('supervision-task-console-cache', () => {
  beforeEach(() => {
    clearAllSupervisionTaskConsoleCaches();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearAllSupervisionTaskConsoleCaches();
    window.localStorage.clear();
  });

  it('retains up to MAX_CACHED_AUTHORITIES (48) projections and evicts the oldest LRU entry beyond capacity', () => {
    expect(MAX_CACHED_AUTHORITIES).toBe(48);
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 10;
      return now;
    });

    for (let i = 0; i < MAX_CACHED_AUTHORITIES; i += 1) {
      const auth = makeAuthority(i);
      writeSupervisionTaskConsoleCache(auth, makeSnapshotState(auth, `t-${i}`));
    }
    // Touch entry 0 so entry 1 becomes least recently used.
    expect(readSupervisionTaskConsoleCache(makeAuthority(0))?.tasks['t-0']).toBeTruthy();

    const extra = makeAuthority(MAX_CACHED_AUTHORITIES);
    writeSupervisionTaskConsoleCache(extra, makeSnapshotState(extra, 't-extra'));

    expect(readSupervisionTaskConsoleCache(makeAuthority(0))?.tasks['t-0']).toBeTruthy();
    expect(readSupervisionTaskConsoleCache(makeAuthority(1))).toBeNull();
    expect(readSupervisionTaskConsoleCache(extra)?.tasks['t-extra']).toBeTruthy();
  });

  it('persists bounded normalized snapshots to localStorage across module reloads and honors clear APIs', async () => {
    const authA = makeAuthority(1, { userId: 'user-a', serverId: 'srv-1' });
    const authB = makeAuthority(2, { userId: 'user-b', serverId: 'srv-2' });
    writeSupervisionTaskConsoleCache(authA, makeSnapshotState(authA, 'ta', 'User A Task'));
    writeSupervisionTaskConsoleCache(authB, makeSnapshotState(authB, 'tb', 'User B Task'));

    expect(window.localStorage.getItem(SUPERVISION_TASK_CONSOLE_CACHE_STORAGE_KEY)).toBeTruthy();

    vi.resetModules();
    const reloaded = await import('../src/supervision-task-console-cache.js');
    const restoredA = reloaded.readSupervisionTaskConsoleCache(authA);
    expect(restoredA).toMatchObject({
      subscriptionId: null,
      phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
      syncing: false,
      syncState: SUPERVISION_TASK_CONSOLE_SYNC_STATE.STALE,
      hasAuthoritativeSnapshot: true,
    });
    expect(restoredA?.tasks.ta?.title).toBe('User A Task');
    // Isolation checks across every axis
    expect(reloaded.readSupervisionTaskConsoleCache({ ...authA, userId: 'user-other' })).toBeNull();
    expect(reloaded.readSupervisionTaskConsoleCache({ ...authA, serverId: 'srv-other' })).toBeNull();
    expect(reloaded.readSupervisionTaskConsoleCache({ ...authA, projectName: 'proj-other' })).toBeNull();
    expect(reloaded.readSupervisionTaskConsoleCache({ ...authA, coordinatorSessionName: 'other_brain' })).toBeNull();

    reloaded.clearSupervisionTaskConsoleCacheForUser('user-a');
    expect(reloaded.readSupervisionTaskConsoleCache(authA)).toBeNull();
    expect(reloaded.readSupervisionTaskConsoleCache(authB)?.tasks.tb?.title).toBe('User B Task');

    reloaded.clearSupervisionTaskConsoleCache(authB);
    expect(reloaded.readSupervisionTaskConsoleCache(authB)).toBeNull();
    expect(window.localStorage.getItem(SUPERVISION_TASK_CONSOLE_CACHE_STORAGE_KEY)).toBeNull();
  });

  it('ignores corrupted, mismatched-schema, or scope-mismatched localStorage payloads safely', () => {
    const auth = makeAuthority(1);
    const valid = makeSnapshotState(auth, 'valid-task');

    window.localStorage.setItem(SUPERVISION_TASK_CONSOLE_CACHE_STORAGE_KEY, '{not-json');
    expect(readSupervisionTaskConsoleCache(auth)).toBeNull();

    window.localStorage.setItem(
      SUPERVISION_TASK_CONSOLE_CACHE_STORAGE_KEY,
      JSON.stringify([
        { authority: auth, accessedAt: 10, state: { ...valid, schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION + 99 } },
        { authority: auth, accessedAt: 20, state: { ...valid, statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION + 99 } },
        { authority: auth, accessedAt: 30, state: { ...valid, scope: { projectName: 'other', coordinatorSessionName: auth.coordinatorSessionName } } },
        { authority: auth, accessedAt: 40, state: { ...valid, hasAuthoritativeSnapshot: false } },
      ]),
    );
    expect(readSupervisionTaskConsoleCache(auth)).toBeNull();
  });

  it('survives localStorage quota errors without throwing or breaking in-memory reads', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    const auth = makeAuthority(1);
    expect(() => writeSupervisionTaskConsoleCache(auth, makeSnapshotState(auth, 't1'))).not.toThrow();
    expect(setItemSpy).toHaveBeenCalled();
    expect(readSupervisionTaskConsoleCache(auth)?.tasks.t1?.title).toBe('Task t1');
  });

  it('rejects structurally corrupted persisted tasks, pairs, assignments, pools, and events while accepting valid legacy optional omissions', () => {
    const authBad = makeAuthority(10);
    const authGood = makeAuthority(11);
    const baseValid = makeSnapshotState(authBad, 'tsk_shared', 'Valid Title');
    const validRow = baseValid.tasks.tsk_shared;
    const validLegacyEntry = makeSnapshotState(authGood, 'tsk_legacy', 'Legacy Optional Fields Omitted');
    const { eventsByTask: _omitEvents, resyncGeneration: _omitGen, ...legacyRest } = validLegacyEntry as unknown as Record<string, unknown>;
    const validPairWithoutOptionals = {
      status: 'working',
      flags: [],
      round: 0,
      blocking: ['P0'],
    };

    const badPayloads = [
      // F2 exact counterexample: pair.flags = 17
      { ...baseValid, tasks: { tsk_shared: { ...validRow, pair: { ...validRow.pair!, flags: 17 } } } },
      // Corrupted pair.status & pair.blocking & pair.scheduling
      { ...baseValid, tasks: { tsk_shared: { ...validRow, pair: { ...validRow.pair!, status: 'bogus_status' } } } },
      { ...baseValid, tasks: { tsk_shared: { ...validRow, pair: { ...validRow.pair!, blocking: 'P0' } } } },
      { ...baseValid, tasks: { tsk_shared: { ...validRow, pair: { ...validRow.pair!, scheduling: { epoch: 1, manual: true, dependsOn: 17, since: 1, writer: 'brain' } } } } },
      // Corrupted assignment row shape
      { ...baseValid, assignments: { asg_bad: { assignmentId: 'asg_bad', taskId: 'tsk_shared', status: 'bogus' } } },
      // Corrupted pool row shape
      { ...baseValid, pools: [{ poolId: 'p1', label: 'Primary', activeCount: 'many', capacity: 4 }] },
      // Corrupted eventsByTask shape
      { ...baseValid, eventsByTask: { tsk_shared: [{ eventId: 'bad', projectionVersion: 1, op: 'task_upsert' }] } },
    ];

    for (const badState of badPayloads) {
      clearAllSupervisionTaskConsoleCaches();
      window.localStorage.setItem(
        SUPERVISION_TASK_CONSOLE_CACHE_STORAGE_KEY,
        JSON.stringify([
          { authority: authBad, accessedAt: 100, state: badState },
          {
            authority: authGood,
            accessedAt: 100,
            state: {
              ...legacyRest,
              tasks: {
                tsk_legacy: {
                  ...validLegacyEntry.tasks.tsk_legacy,
                  pair: validPairWithoutOptionals,
                },
              },
            },
          },
        ]),
      );
      expect(readSupervisionTaskConsoleCache(authBad)).toBeNull();
      expect(readSupervisionTaskConsoleCache(authGood)?.tasks.tsk_legacy?.title).toBe('Legacy Optional Fields Omitted');
    }
  });

  it('never resurrects cleared user/authority entries from stale storage when setItem or removeItem fails', () => {
    const authA1 = makeAuthority(21, { userId: 'user-a', projectName: 'proj-a1' });
    const authA2 = makeAuthority(22, { userId: 'user-a', projectName: 'proj-a2' });
    const authB = makeAuthority(23, { userId: 'user-b', projectName: 'proj-b' });

    writeSupervisionTaskConsoleCache(authA1, makeSnapshotState(authA1, 'ta1', 'User A1 Task'));
    writeSupervisionTaskConsoleCache(authA2, makeSnapshotState(authA2, 'ta2', 'User A2 Task'));
    writeSupervisionTaskConsoleCache(authB, makeSnapshotState(authB, 'tb', 'User B Task'));

    // Case 1: only Storage.setItem throws QuotaExceededError (getItem/removeItem work)
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    clearSupervisionTaskConsoleCacheForUser('user-a');
    expect(readSupervisionTaskConsoleCache(authA1)).toBeNull();
    expect(readSupervisionTaskConsoleCache(authA2)).toBeNull();
    expect(readSupervisionTaskConsoleCache(authB)?.tasks.tb?.title).toBe('User B Task');

    // Re-enable setItem and verify single-authority clear when setItem fails again
    setItemSpy.mockRestore();
    writeSupervisionTaskConsoleCache(authA1, makeSnapshotState(authA1, 'ta1', 'User A1 Fresh'));
    expect(readSupervisionTaskConsoleCache(authA1)?.tasks.ta1?.title).toBe('User A1 Fresh');

    // Case 2: BOTH setItem AND removeItem throw during clear
    const setItemFail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    const removeItemFail = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('SecurityError', 'SecurityError');
    });
    clearSupervisionTaskConsoleCache(authA1);
    expect(readSupervisionTaskConsoleCache(authA1)).toBeNull();
    expect(readSupervisionTaskConsoleCache(authB)?.tasks.tb?.title).toBe('User B Task');

    // Writing a new authoritative snapshot for authA1 keeps authA1 readable in memory
    // while keeping untouched cleared entries inaccessible, and recovers storage once restored.
    writeSupervisionTaskConsoleCache(authA1, makeSnapshotState(authA1, 'ta1', 'Recovered A1 Task'));
    expect(readSupervisionTaskConsoleCache(authA1)?.tasks.ta1?.title).toBe('Recovered A1 Task');
    expect(readSupervisionTaskConsoleCache(authA2)).toBeNull();

    setItemFail.mockRestore();
    removeItemFail.mockRestore();
    writeSupervisionTaskConsoleCache(authA1, makeSnapshotState(authA1, 'ta1', 'Persisted A1 Task'));
    clearAllSupervisionTaskConsoleCaches();
    expect(readSupervisionTaskConsoleCache(authA1)).toBeNull();
    expect(readSupervisionTaskConsoleCache(authB)).toBeNull();
  });
});
