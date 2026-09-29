import { describe, expect, it } from 'vitest';
import { TaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { MainCheckoutGuard } from '../../../src/daemon/task-pairs/main-checkout-guard.js';
describe('pair resource claims', () => {
  it('conflicts across projects, expires and releases', () => {
    const store = new TaskPairStore(':memory:');
    expect(store.tryClaimResource({ project: 'a', taskId: 't1', owner: 'e1', resource: 'machine:211', mode: 'exclusive', ttlMs: 1000, now: 100 }).ok).toBe(true);
    expect(store.tryClaimResource({ project: 'b', taskId: 't2', owner: 'e2', resource: 'machine:211', mode: 'shared', ttlMs: 1000, now: 101 }).ok).toBe(false);
    expect(store.listActiveResourceClaims(1200)).toHaveLength(0);
    store.tryClaimResource({ project: 'a', taskId: 't1', owner: 'e1', resource: 'dir:x', mode: 'exclusive', ttlMs: 10000, now: 100 });
    expect(store.releaseResourceClaims('a', 't1', 200)).toHaveLength(1); store.close();
  });
  it('reports new checkout paths once and prioritizes credentials', async () => {
    const guard = new MainCheckoutGuard(); const exec = async () => '?? .env.local\0 M src/main.ts\0';
    expect((await guard.inspect('p', '/repo', { exec }))?.credentialPaths).toEqual(['.env.local']);
    expect(await guard.inspect('p', '/repo', { exec })).toBeUndefined();
  });
  it('self-checks a pair participant editing the main checkout', async () => {
    const guard = new MainCheckoutGuard();
    const notice = await guard.inspect('p', '/main', { writerSession: 'executor-1', pairParticipants: ['executor-1'], brainSession: 'brain-1', exec: async () => ' M src/owned.ts\0' });
    expect(notice?.paths).toEqual(['src/owned.ts']);
    expect(await guard.inspect('p', '/brain', { writerSession: 'brain-1', pairParticipants: ['executor-1'], brainSession: 'brain-1', exec: async () => ' M src/brain.ts\0' })).toBeUndefined();
  });
  it('ignores Brain activity and non-git failures', async () => {
    const guard = new MainCheckoutGuard();
    expect(await guard.inspect('p', '/repo', { brainActive: true, exec: async () => ' M file.ts\0' })).toBeUndefined();
    expect(await guard.inspect('p', '/missing', { exec: async () => { throw new Error('not git'); } })).toBeUndefined();
  });
});
