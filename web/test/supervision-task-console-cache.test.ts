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
});
