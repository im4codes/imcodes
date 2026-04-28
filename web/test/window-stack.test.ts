import { describe, expect, it } from 'vitest';

import {
  createDesktopWindowStack,
  DESKTOP_WINDOW_IDS,
  DESKTOP_WINDOW_KINDS,
  getFrontmostSubSessionId,
  syncDesktopWindowStack,
} from '../src/window-stack.js';

function orderIds(stack: ReturnType<typeof createDesktopWindowStack>): string[] {
  return stack.getOrderForTests().map((entry) => entry.id);
}

describe('createDesktopWindowStack', () => {
  it('keeps registration idempotent for a stable window identity', () => {
    const stack = createDesktopWindowStack();

    stack.ensureWindow('filebrowser', { kind: 'file-browser' });
    stack.ensureWindow('filebrowser', { kind: 'file-browser' });

    expect(orderIds(stack)).toEqual(['filebrowser']);
  });

  it('removes a window from ordering and z-index lookups during cleanup', () => {
    const stack = createDesktopWindowStack();

    stack.ensureWindow('repo', { kind: 'repo' });
    stack.ensureWindow('discussions', { kind: 'discussions' });
    stack.bringToFront('repo');
    stack.removeWindow('repo');

    expect(orderIds(stack)).toEqual(['discussions']);
    expect(stack.getZIndex('repo')).toBeNull();
    expect(stack.getFrontmostMatching((entry) => entry.id === 'repo')).toBeNull();
  });

  it('reopens a singleton with the same identity as one stack entry and raises it frontmost', () => {
    const stack = createDesktopWindowStack();

    stack.ensureWindow('file-preview', { kind: 'file-preview' });
    stack.ensureWindow('repo', { kind: 'repo' });
    stack.bringToFront('repo');
    stack.removeWindow('file-preview');

    stack.ensureWindow('file-preview', { kind: 'file-preview' });
    stack.bringToFront('file-preview');

    expect(orderIds(stack)).toEqual(['repo', 'file-preview']);
    expect(stack.getZIndex('file-preview')).toBeGreaterThan(stack.getZIndex('repo') ?? 0);
  });

  it('uses parent-child bands so a child stays above its owner but below a newer unrelated frontmost group', () => {
    const stack = createDesktopWindowStack();

    stack.ensureWindow('sub:worker-a', { kind: 'sub-session', serverId: 'srv-1' });
    stack.ensureWindow('subsession-filebrowser:worker-a', {
      kind: 'subsession-filebrowser',
      parentId: 'sub:worker-a',
      serverId: 'srv-1',
    });

    const ownerZ = stack.getZIndex('sub:worker-a');
    const childZ = stack.getZIndex('subsession-filebrowser:worker-a');

    expect(childZ).toBeGreaterThan(ownerZ ?? 0);

    stack.bringToFront('sub:worker-a');

    expect(stack.getZIndex('subsession-filebrowser:worker-a')).toBeGreaterThan(stack.getZIndex('sub:worker-a') ?? 0);

    stack.ensureWindow('sub:worker-b', { kind: 'sub-session', serverId: 'srv-1' });
    stack.bringToFront('sub:worker-b');

    expect(stack.getZIndex('sub:worker-b')).toBeGreaterThan(stack.getZIndex('subsession-filebrowser:worker-a') ?? 0);
  });

  it('returns deterministic oldest-to-frontmost order for tests after raises and removals', () => {
    const stack = createDesktopWindowStack();

    stack.ensureWindow('repo', { kind: 'repo' });
    stack.ensureWindow('filebrowser', { kind: 'file-browser' });
    stack.ensureWindow('discussions', { kind: 'discussions' });
    stack.bringToFront('filebrowser');
    stack.removeWindow('repo');

    expect(orderIds(stack)).toEqual(['discussions', 'filebrowser']);
  });

  it('finds the frontmost open sub-session without being confused by non-sub-session windows', () => {
    const stack = createDesktopWindowStack();

    stack.ensureWindow('sub:worker-a', { kind: 'sub-session', subId: 'worker-a', serverId: 'srv-1' });
    stack.ensureWindow('repo', { kind: 'repo' });
    stack.ensureWindow('sub:worker-b', { kind: 'sub-session', subId: 'worker-b', serverId: 'srv-1' });
    stack.bringToFront('repo');

    expect(stack.getFrontmostMatching((entry) => entry.meta.kind === 'sub-session')?.id).toBe('sub:worker-b');

    stack.bringToFront('sub:worker-a');

    expect(stack.getFrontmostMatching((entry) => entry.meta.kind === 'sub-session')?.id).toBe('sub:worker-a');
    expect(getFrontmostSubSessionId(stack, new Set(['worker-a', 'worker-b']))).toBe('worker-a');
    expect(getFrontmostSubSessionId(stack, new Set(['worker-b']))).toBe('worker-b');
  });

  it('orders all v1 managed root identities through the same root stack', () => {
    const stack = createDesktopWindowStack();
    const rootWindows = [
      [DESKTOP_WINDOW_IDS.filePreview, DESKTOP_WINDOW_KINDS.filePreview],
      [DESKTOP_WINDOW_IDS.fileBrowser, DESKTOP_WINDOW_KINDS.fileBrowser],
      [DESKTOP_WINDOW_IDS.repo, DESKTOP_WINDOW_KINDS.repo],
      [DESKTOP_WINDOW_IDS.discussions, DESKTOP_WINDOW_KINDS.discussions],
      [DESKTOP_WINDOW_IDS.cronManager, DESKTOP_WINDOW_KINDS.cronManager],
      [DESKTOP_WINDOW_IDS.sharedContextManagement, DESKTOP_WINDOW_KINDS.sharedContextManagement],
      [DESKTOP_WINDOW_IDS.sharedContextDiagnostics, DESKTOP_WINDOW_KINDS.sharedContextDiagnostics],
      [DESKTOP_WINDOW_IDS.localWebPreview('srv-1'), DESKTOP_WINDOW_KINDS.localWebPreview],
      [DESKTOP_WINDOW_IDS.subSession('worker-a'), DESKTOP_WINDOW_KINDS.subSession],
    ] as const;

    for (const [id, kind] of rootWindows) {
      stack.ensureWindow(id, { kind, serverId: 'srv-1', ...(kind === DESKTOP_WINDOW_KINDS.subSession ? { subId: 'worker-a' } : {}) });
      stack.bringToFront(id);
    }

    expect(orderIds(stack)).toEqual(rootWindows.map(([id]) => id));
    expect(stack.getFrontmostMatching((entry) => entry.meta.kind === DESKTOP_WINDOW_KINDS.subSession)?.id)
      .toBe(DESKTOP_WINDOW_IDS.subSession('worker-a'));

    stack.bringToFront(DESKTOP_WINDOW_IDS.filePreview);

    expect(orderIds(stack).at(-1)).toBe(DESKTOP_WINDOW_IDS.filePreview);
  });

  it('removing a parent removes delegated child stack membership too', () => {
    const stack = createDesktopWindowStack();
    const ownerId = DESKTOP_WINDOW_IDS.subSession('worker-a');
    const childId = DESKTOP_WINDOW_IDS.subsessionFileBrowser('worker-a');

    stack.ensureWindow(ownerId, { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'worker-a' });
    stack.ensureWindow(childId, {
      kind: DESKTOP_WINDOW_KINDS.subsessionFileBrowser,
      parentId: ownerId,
      subId: 'worker-a',
    });

    stack.removeWindow(ownerId);

    expect(stack.getZIndex(ownerId)).toBeNull();
    expect(stack.getZIndex(childId)).toBeNull();
    expect(orderIds(stack)).toEqual([]);
  });

  it('keeps unrelated root windows above an oversized delegated child band', () => {
    const stack = createDesktopWindowStack();
    const ownerId = DESKTOP_WINDOW_IDS.subSession('worker-a');
    const ownerServerId = 'srv-1';

    stack.ensureWindow(ownerId, { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'worker-a', serverId: ownerServerId });
    for (let i = 0; i < 25; i++) {
      stack.ensureWindow(`subsession-filebrowser:worker-a:${i}`, {
        kind: DESKTOP_WINDOW_KINDS.subsessionFileBrowser,
        parentId: ownerId,
        subId: 'worker-a',
        serverId: ownerServerId,
      });
    }
    stack.ensureWindow(DESKTOP_WINDOW_IDS.repo, { kind: DESKTOP_WINDOW_KINDS.repo, serverId: ownerServerId });
    stack.bringToFront(DESKTOP_WINDOW_IDS.repo);

    expect(stack.getZIndex(DESKTOP_WINDOW_IDS.repo)).toBeGreaterThan(
      stack.getZIndex('subsession-filebrowser:worker-a:24') ?? 0,
    );
  });

  it('syncs active root membership while preserving active delegated children', () => {
    const stack = createDesktopWindowStack();
    const ownerId = DESKTOP_WINDOW_IDS.subSession('worker-a');
    const childId = DESKTOP_WINDOW_IDS.subsessionFileBrowser('worker-a');
    const repoId = DESKTOP_WINDOW_IDS.repo;

    stack.ensureWindow(repoId, { kind: DESKTOP_WINDOW_KINDS.repo });
    stack.ensureWindow(ownerId, { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'worker-a' });
    stack.ensureWindow(childId, {
      kind: DESKTOP_WINDOW_KINDS.subsessionFileBrowser,
      parentId: ownerId,
      subId: 'worker-a',
    });

    syncDesktopWindowStack(stack, [
      { id: ownerId, meta: { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'worker-a' } },
    ]);

    expect(stack.getZIndex(repoId)).toBeNull();
    expect(stack.getZIndex(ownerId)).not.toBeNull();
    expect(stack.getZIndex(childId)).toBeGreaterThan(stack.getZIndex(ownerId) ?? 0);
  });

  it('drops delegated child during mobile-style sync when parent membership is intentionally suspended', () => {
    const stack = createDesktopWindowStack();
    const ownerId = DESKTOP_WINDOW_IDS.subSession('worker-a');
    const childId = DESKTOP_WINDOW_IDS.subsessionFileBrowser('worker-a');

    stack.ensureWindow(ownerId, { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'worker-a' });
    stack.ensureWindow(childId, {
      kind: DESKTOP_WINDOW_KINDS.subsessionFileBrowser,
      parentId: ownerId,
      subId: 'worker-a',
    });

    syncDesktopWindowStack(stack, [
      { id: ownerId, meta: { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'worker-a' } },
    ], { keepChildrenWithActiveParent: false });

    expect(orderIds(stack)).toEqual([ownerId]);
    expect(stack.getZIndex(childId)).toBeNull();
  });

  it('syncing out a parent removes delegated child membership', () => {
    const stack = createDesktopWindowStack();
    const ownerId = DESKTOP_WINDOW_IDS.subSession('worker-a');
    const childId = DESKTOP_WINDOW_IDS.subsessionFileBrowser('worker-a');

    stack.ensureWindow(ownerId, { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'worker-a' });
    stack.ensureWindow(childId, {
      kind: DESKTOP_WINDOW_KINDS.subsessionFileBrowser,
      parentId: ownerId,
      subId: 'worker-a',
    });

    syncDesktopWindowStack(stack, []);

    expect(orderIds(stack)).toEqual([]);
    expect(getFrontmostSubSessionId(stack, new Set(['worker-a']))).toBeNull();
  });
});
