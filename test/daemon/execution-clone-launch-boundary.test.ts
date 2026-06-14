import { describe, it, expect, beforeEach } from 'vitest';
import {
  upsertSession,
  getSession,
  removeSession,
  type SessionRecord,
} from '../../src/store/session-store.js';
import { isExecutionClone, countActiveExecutionClones } from '../../src/daemon/execution-clone.js';
import { EXECUTION_CLONE_KIND, type ExecutionCloneMetadata } from '../../shared/execution-clone.js';

/**
 * P0 locking test (audit f3b99242-11e, checklist items 1–3).
 *
 * The CRITICAL bug: `upsertSession` REPLACES the whole record, but the
 * sub-session launch (`subsession-manager.ts:227-239`) and later incidental
 * re-upserts (provider-id capture by watchers, model/state refresh) construct a
 * fresh `SessionRecord` that OMITS `executionCloneMetadata`. On the un-patched
 * store that dropped the `kind: execution_clone` marker right after launch,
 * silently disabling the poller-skip, GC sweep, per-run cap count, identity
 * scrub, and destroy authz. The unit tests passed only because they snapshot the
 * PRE-launch record.
 *
 * These assertions reproduce the production re-upsert shapes and FAIL on the
 * pre-patch `upsertSession`; they pass once it preserves the clone marker.
 */

const CLONE = 'deck_sub_execclone_p0boundary';
const NORMAL = 'deck_sub_execclone_p0normal';

function cloneMeta(over: Partial<ExecutionCloneMetadata> = {}): ExecutionCloneMetadata {
  return {
    kind: EXECUTION_CLONE_KIND,
    ephemeral: true,
    cloneOfSessionName: 'deck_proj_w1',
    parentRunId: 'run-p0',
    parentStage: 'team_final_execution',
    createdBySessionName: 'deck_proj_brain',
    createdAt: 1000,
    hardTimeoutAt: 1000 + 60 * 60 * 1000,
    retentionExpiresAt: null,
    cleanupState: 'active',
    autoDestroy: true,
    ...over,
  };
}

/** The create-time FIRST upsert (execution-clone.ts:343-369), carries metadata. */
function firstCloneUpsert(): void {
  upsertSession({
    name: CLONE,
    projectName: 'proj',
    role: 'w1',
    agentType: 'claude-code',
    projectDir: '/p',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    parentSession: 'deck_proj_brain',
    userCreated: true,
    executionCloneMetadata: cloneMeta(),
  } as SessionRecord);
}

/** The launch re-upsert (subsession-manager.ts:227-239), OMITS metadata. */
function launchReplaceUpsert(extra: Partial<SessionRecord> = {}): void {
  upsertSession({
    name: CLONE,
    projectName: 'proj',
    agentType: 'claude-code',
    role: 'w1',
    state: 'idle',
    projectDir: '/p',
    parentSession: 'deck_proj_brain',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 2,
    updatedAt: 2,
    ...extra,
  } as SessionRecord);
}

describe('execution-clone launch-boundary metadata preservation (P0)', () => {
  beforeEach(() => {
    removeSession(CLONE);
    removeSession(NORMAL);
  });

  it('keeps kind: execution_clone across the launch re-upsert that omits metadata', () => {
    firstCloneUpsert();
    expect(getSession(CLONE)?.executionCloneMetadata?.kind).toBe(EXECUTION_CLONE_KIND);

    // Pre-patch this REPLACED the record and dropped the marker.
    launchReplaceUpsert();

    const rec = getSession(CLONE);
    expect(rec?.executionCloneMetadata?.kind).toBe(EXECUTION_CLONE_KIND);
    expect(isExecutionClone(rec)).toBe(true);
  });

  it('survives a later provider-id capture re-upsert AND still applies the normal field update', () => {
    firstCloneUpsert();
    launchReplaceUpsert();
    // Watcher captures the provider session id and re-upserts a fresh record.
    const rec = getSession(CLONE)!;
    upsertSession({ ...rec, ccSessionId: 'cc-post-launch', executionCloneMetadata: undefined } as SessionRecord);

    const after = getSession(CLONE)!;
    expect(after.executionCloneMetadata?.kind).toBe(EXECUTION_CLONE_KIND); // marker preserved
    expect(after.ccSessionId).toBe('cc-post-launch'); // normal field update applied
  });

  it('keeps the clone countable by countActiveExecutionClones after launch (cap enforcement restored)', () => {
    firstCloneUpsert();
    launchReplaceUpsert();
    expect(countActiveExecutionClones('run-p0')).toBe(1);
  });

  it('explicit metadata mutation still overwrites (completedAt / cleanupState transitions)', () => {
    firstCloneUpsert();
    const rec = getSession(CLONE)!;
    upsertSession({
      ...rec,
      executionCloneMetadata: { ...rec.executionCloneMetadata!, cleanupState: 'collecting', completedAt: 5 },
    });
    const after = getSession(CLONE)!.executionCloneMetadata!;
    expect(after.cleanupState).toBe('collecting');
    expect(after.completedAt).toBe(5);
  });

  it('does NOT attach clone metadata to an ordinary sub-session record', () => {
    upsertSession({
      name: NORMAL, projectName: 'proj', role: 'w1', agentType: 'claude-code',
      projectDir: '/p', state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
    } as SessionRecord);
    upsertSession({
      name: NORMAL, projectName: 'proj', role: 'w1', agentType: 'claude-code',
      projectDir: '/p', state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 2, updatedAt: 2,
    } as SessionRecord);
    expect(getSession(NORMAL)?.executionCloneMetadata).toBeUndefined();
    expect(isExecutionClone(getSession(NORMAL))).toBe(false);
  });
});
