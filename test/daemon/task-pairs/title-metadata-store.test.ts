import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import type { TaskPairState } from '../../../shared/task-pair.js';
import type { TaskPairTitleAccess } from '../../../shared/task-pair-title-access.js';

const initial = { taskId: 'tsk_title_metadata', brain: 'brain', executor: 'exec', auditor: 'none', status: 'working', title: 'Original', brief: '- [ ][ ] original', flags: [], flagSides: {}, round: 1, blocking: ['P0'], previousAuditors: [], capCounts: {}, capRound: 1, createdAt: 1, updatedAt: 1 } as TaskPairState;
const grant: TaskPairTitleAccess = { version: 1, serverId: 'source', userIds: ['alice'] };
let dir: string | undefined;
let stores: TaskPairStore[] = [];
afterEach(() => { for (const store of stores) store.close(); stores = []; if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('atomic title/brief metadata patches across SQLite connections', () => {
  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'imcodes-test-title-metadata-'));
    const a = new TaskPairStore(join(dir, 'pairs.sqlite')), b = new TaskPairStore(join(dir, 'pairs.sqlite'));
    stores = [a, b]; a.savePair('project', initial); return { a, b };
  }
  it('does not overwrite another connection\'s title/audience when applying a stale brief update', () => {
    const { a, b } = setup();
    const stale = a.getPair('project', initial.taskId)!;
    expect(b.patchPairMetadata('project', initial.taskId, 'brain', { title: 'Concurrent title', titleAccess: grant }, 2)).toBeDefined();
    const saved = a.patchPairMetadata('project', stale.state.taskId, 'exec', { brief: 'new brief' }, 3)!;
    expect(saved.state).toMatchObject({ title: 'Concurrent title', titleAccess: grant, brief: 'new brief', status: 'working', round: 1 });
    expect(b.getPair('project', initial.taskId)?.state).toEqual(saved.state);
  });
  it('CAS refuses stale audiences without changing title/brief, and a re-merged grant preserves both writers', () => {
    const { a, b } = setup();
    a.patchPairMetadata('project', initial.taskId, 'brain', { titleAccess: grant }, 2);
    expect(b.patchPairMetadata('project', initial.taskId, 'brain', { title: 'must not write', titleAccess: { ...grant, userIds: ['bob'] } }, 3)).toBeUndefined();
    expect(b.getPair('project', initial.taskId)?.state.title).toBe(initial.title);
    const previous = b.getPair('project', initial.taskId)!.state.titleAccess!;
    expect(b.patchPairMetadata('project', initial.taskId, 'brain', { titleAccess: { ...previous, userIds: [...previous.userIds, 'bob'] } }, 4, previous)?.state.titleAccess?.userIds).toEqual(['alice', 'bob']);
  });
  it('checks the current role inside the write and keeps the shared index/listeners coherent', () => {
    const { a, b } = setup();
    a.listActivePairsShared('project');
    b.savePair('project', { ...initial, executor: 'replacement' });
    expect(a.patchPairMetadata('project', initial.taskId, 'exec', { brief: 'forbidden' }, 2)).toBeUndefined();
    expect(a.patchPairMetadata('project', initial.taskId, 'replacement', { title: 'forbidden' }, 2)).toBeUndefined();
    const saved = a.patchPairMetadata('project', initial.taskId, 'brain', { title: 'Allowed', titleAccess: grant }, 3)!;
    expect(a.listActivePairsShared('project')[0]?.state.titleAccess).toEqual(saved.state.titleAccess);
    expect(saved.state.brief).toBe(initial.brief);
  });
});
