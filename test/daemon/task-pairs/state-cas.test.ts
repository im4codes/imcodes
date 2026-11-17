import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TaskPairState } from '../../../shared/task-pair.js';
import { TaskPairStore, TaskPairWriteConflictError, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';

const initial = (): TaskPairState => ({
  taskId: 'test-cas', brain: 'deck_test_brain', executor: 'deck_test_exec', auditor: 'deck_test_audit',
  workspaceKind: 'none', status: 'working', round: 1, deliveryRound: 1, flags: [], flagSides: {}, blocking: ['P0'],
  previousAuditors: [], capCounts: {}, createdAt: 1, updatedAt: 1,
});
let store: TaskPairStore;
const stores: TaskPairStore[] = [];
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imcodes-test-pair-cas-'));
  store = new TaskPairStore(join(dir, 'pairs.sqlite')); stores.push(store);
  setTaskPairStoreForTests(store);
  setTaskPairDeliveryDepsForTests({ send: async () => {} });
});
afterEach(async () => {
  await taskPairService.waitForIdle();
  vi.restoreAllMocks();
  setTaskPairDeliveryDepsForTests(undefined);
  // Close all connections before cleaning our own isolated directory.
  setTaskPairStoreForTests(undefined);
  for (const connection of stores.splice(0)) { try { connection.close(); } catch { /* singleton already closed */ } }
  rmSync(dir, { recursive: true, force: true });
});
const marker = (verb: string, writer = initial().executor!, attrs: Record<string, string> = {}, id = verb) => taskPairService.applyMarker({
  project: 'p', writer, marker: { verb, knownVerb: verb as 'WORKING', taskId: initial().taskId, attrs },
  eventId: `cas:${id}`, source: 'marker', now: 100,
});

describe('full pair state compare-and-update', () => {
  it('requires a read token for existing rows, without input mutation or a fake success', () => {
    const saved = store.savePair('p', initial());
    const stale = structuredClone(saved.state);
    store.patchPairMetadata('p', stale.taskId, stale.brain, { brief: 'authoritative' }, 2);
    const before = store.getPair('p', stale.taskId)!;
    const snapshot = JSON.stringify(stale);
    const listener = vi.fn(); store.onPairSaved(listener);
    expect(() => store.savePair('p', stale)).toThrow(TaskPairWriteConflictError);
    expect(() => store.savePair('p', stale, { expectedRevision: saved.revision, liveness: { ...saved.liveness, silenceExecutor: 50 } })).toThrow(TaskPairWriteConflictError);
    expect(store.getPair('p', stale.taskId)).toEqual(before);
    expect(JSON.stringify(stale)).toBe(snapshot);
    expect(listener).not.toHaveBeenCalled();
  });

  it('atomically rejects a second SQLite connection using an older snapshot and accepts its recomputed intent', () => {
    store.savePair('p', initial());
    const other = new TaskPairStore(join(dir, 'pairs.sqlite')); stores.push(other);
    const old = other.getPair('p', initial().taskId)!;
    marker('READY_FOR_AUDIT');
    const ready = store.getPair('p', old.state.taskId)!;
    expect(ready.state.episodeGeneration).toBe(old.state.episodeGeneration);
    expect(() => other.savePair('p', { ...old.state, brief: 'late' }, { expectedRevision: old.revision })).toThrow(TaskPairWriteConflictError);
    const fresh = other.getPair('p', old.state.taskId)!;
    other.savePair('p', { ...fresh.state, brief: 'fresh metadata intent' }, { expectedRevision: fresh.revision });
    expect(store.getPair('p', old.state.taskId)!.state).toMatchObject({ status: 'in_audit', round: ready.state.round, brief: 'fresh metadata intent' });
  });

  it('uses the actual post-merge SQL revision, and scoped scheduling/title writes invalidate old tokens', () => {
    const saved = store.savePair('p', initial());
    const scheduled = store.patchScheduling('p', saved.state.taskId, undefined, { manual: true, epoch: 1 }, 2)!;
    expect(() => store.savePair('p', saved.state, { expectedRevision: saved.revision })).toThrow(TaskPairWriteConflictError);
    const returned = store.savePair('p', { ...scheduled.state, scheduling: undefined, brief: 'fresh' }, { expectedRevision: scheduled.revision });
    expect(returned.revision).toBe(store.getPair('p', saved.state.taskId)!.revision);
    expect(returned.state.scheduling).toEqual(scheduled.state.scheduling);
    store.patchPairMetadata('p', saved.state.taskId, saved.state.brain, { title: 'new title' }, 3);
    expect(() => store.savePair('p', returned.state, { expectedRevision: returned.revision })).toThrow(TaskPairWriteConflictError);
  });

  it('keeps legacy JSON/read tokens stable across restart without read-time initialization', () => {
    const first = store.savePair('p', initial()); // no revision/episode field in the JSON shape
    expect(first.state).not.toHaveProperty('revision');
    const other = new TaskPairStore(join(dir, 'pairs.sqlite')); stores.push(other);
    const reopened = other.getPair('p', first.state.taskId)!;
    expect(reopened.revision).toBe(first.revision);
    expect(reopened.state).not.toHaveProperty('episodeGeneration');
    expect(other.getPair('p', first.state.taskId)!.revision).toBe(first.revision);
    other.savePair('p', { ...reopened.state, title: 'legal fresh update' }, { expectedRevision: reopened.revision });
    expect(store.getPair('p', first.state.taskId)!.state.title).toBe('legal fresh update');
  });

  it('rolls back both state and liveness if the marker receipt is duplicate', () => {
    const saved = store.savePair('p', initial());
    const event = { id: 'duplicate', project: 'p', taskId: saved.state.taskId, writer: saved.state.brain, role: 'brain' as const, verb: 'CHECK', attrs: {}, effect: 'checklist', unusual: false, source: 'marker' as const, at: 2 };
    store.recordEvent(event);
    expect(() => store.savePair('p', { ...saved.state, status: 'done' }, { expectedRevision: saved.revision, event, liveness: { ...saved.liveness, silenceExecutor: 99 } })).toThrow(TaskPairWriteConflictError);
    expect(store.getPair('p', saved.state.taskId)).toEqual(saved);
    expect(store.listEvents('p', saved.state.taskId)).toHaveLength(1);
  });

  it('does not create an expected-existing row that was deleted', () => {
    const first = store.savePair('p', { ...initial(), status: 'done' });
    store.prune(100 * 24 * 60 * 60_000);
    expect(() => store.savePair('p', first.state, { expectedRevision: first.revision })).toThrow(TaskPairWriteConflictError);
    expect(store.getPair('p', first.state.taskId)).toBeUndefined();
  });

  it('recomputes a conflicted marker against fresh authority, retaining unrelated metadata and one event', () => {
    store.savePair('p', initial());
    const save = store.savePair.bind(store);
    let conflict = true;
    vi.spyOn(store, 'savePair').mockImplementation((project, state, options) => {
      if (conflict && options?.event) {
        conflict = false;
        store.patchPairMetadata(project, state.taskId, state.brain, { title: 'concurrent title' }, 5);
      }
      return save(project, state, options);
    });
    expect(marker('BLOCKED', initial().executor, { note: 'need owner input' }).unusual).toBe(false);
    expect(store.getPair('p', initial().taskId)!.state).toMatchObject({ title: 'concurrent title', blockedNote: 'need owner input' });
    expect(store.listEvents('p', initial().taskId).filter(e => e.id === 'cas:BLOCKED')).toHaveLength(1);
  });

  it('re-evaluates current roles on conflict, so an old auditor marker cannot acquire new-role authority', () => {
    store.savePair('p', initial()); marker('READY_FOR_AUDIT');
    const save = store.savePair.bind(store);
    let conflict = true;
    vi.spyOn(store, 'savePair').mockImplementation((project, state, options) => {
      if (conflict && options?.event) {
        conflict = false;
        const fresh = store.getPair(project, state.taskId)!;
        save(project, { ...fresh.state, auditor: 'deck_test_new_audit' }, { expectedRevision: fresh.revision });
      }
      return save(project, state, options);
    });
    expect(marker('PASS', initial().auditor).unusual).toBe(true);
    expect(store.getPair('p', initial().taskId)!.state).toMatchObject({ status: 'in_audit', auditor: 'deck_test_new_audit' });
    expect(marker('PASS', 'deck_test_new_audit', {}, 'fresh-pass').unusual).toBe(false);
  });

  it('bounds conflicts without recording success or swallowing the marker as replayed', () => {
    const first = store.savePair('p', initial());
    const spy = vi.spyOn(store, 'savePair').mockImplementation(() => { throw new TaskPairWriteConflictError('p', first.state.taskId); });
    expect(() => marker('BLOCKED')).toThrow(TaskPairWriteConflictError);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(store.hasEvent('cas:BLOCKED')).toBe(false);
    expect(store.getPair('p', first.state.taskId)).toEqual(first);
  });
});
