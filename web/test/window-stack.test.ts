import { describe, it, expect } from 'vitest';
import {
  MutableDesktopWindowStack,
  createDesktopWindowStack,
  getFrontmostSubSessionId,
  openSubIdsKey,
  DESKTOP_WINDOW_IDS,
  DESKTOP_WINDOW_KINDS,
  DESKTOP_WINDOW_STACK_BASE_Z,
  DESKTOP_WINDOW_STACK_STRIDE,
} from '../src/window-stack.js';

describe('MutableDesktopWindowStack', () => {
  describe('ensureWindow', () => {
    it('returns true on first registration and false on identical re-register', () => {
      const s = new MutableDesktopWindowStack();
      expect(s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo })).toBe(true);
      expect(s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo })).toBe(false);
      expect(s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo })).toBe(false);
    });

    it('returns true when re-registering with materially different meta (e.g. serverId change)', () => {
      const s = new MutableDesktopWindowStack();
      s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo, serverId: 'A' });
      expect(s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo, serverId: 'B' })).toBe(true);
      expect(s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo, serverId: 'B' })).toBe(false);
    });

    it('does not create duplicate stack entries', () => {
      const s = new MutableDesktopWindowStack();
      s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo });
      s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo });
      s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo });
      expect(s.getOrderForTests().filter((e) => e.id === 'repo')).toHaveLength(1);
    });
  });

  describe('bringToFront', () => {
    it('returns false when called on the only/frontmost root (no version bump)', () => {
      const s = new MutableDesktopWindowStack();
      s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo });
      // Already frontmost as the only root.
      expect(s.bringToFront('repo')).toBe(false);
      expect(s.bringToFront('repo')).toBe(false);
      expect(s.bringToFront('repo')).toBe(false);
    });

    it('returns false when bringing the already-frontmost root forward 100 times', () => {
      const s = new MutableDesktopWindowStack();
      s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo });
      s.ensureWindow('discussions', { kind: DESKTOP_WINDOW_KINDS.discussions });
      s.bringToFront('discussions'); // discussions becomes frontmost
      let bumps = 0;
      for (let i = 0; i < 100; i++) {
        if (s.bringToFront('discussions')) bumps++;
      }
      expect(bumps).toBe(0);
    });

    it('returns true when raising a non-frontmost root above peers', () => {
      const s = new MutableDesktopWindowStack();
      s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo });
      s.ensureWindow('discussions', { kind: DESKTOP_WINDOW_KINDS.discussions });
      // discussions is registered later → it is currently frontmost.
      expect(s.bringToFront('repo')).toBe(true);
      expect(s.getZIndex('repo')!).toBeGreaterThan(s.getZIndex('discussions')!);
    });

    it('returns false for unknown id', () => {
      const s = new MutableDesktopWindowStack();
      expect(s.bringToFront('does-not-exist')).toBe(false);
    });

    it('treats child bringToFront as raising the OWNING root (and a no-op when root is already frontmost)', () => {
      const s = new MutableDesktopWindowStack();
      const subId = 'abc';
      const parent = DESKTOP_WINDOW_IDS.subSession(subId);
      const child = DESKTOP_WINDOW_IDS.subsessionFileBrowser(subId);
      s.ensureWindow(parent, { kind: DESKTOP_WINDOW_KINDS.subSession, subId });
      s.ensureWindow(child, { kind: DESKTOP_WINDOW_KINDS.subsessionFileBrowser, parentId: parent, subId });
      // Only one root → already frontmost. Raising the child should be a no-op.
      expect(s.bringToFront(child)).toBe(false);
    });

    it('raising a child raises the owning root above its peers', () => {
      const s = new MutableDesktopWindowStack();
      const subA = 'A', subB = 'B';
      s.ensureWindow(DESKTOP_WINDOW_IDS.subSession(subA), { kind: DESKTOP_WINDOW_KINDS.subSession, subId: subA });
      s.ensureWindow(DESKTOP_WINDOW_IDS.subsessionFileBrowser(subA), {
        kind: DESKTOP_WINDOW_KINDS.subsessionFileBrowser,
        parentId: DESKTOP_WINDOW_IDS.subSession(subA),
        subId: subA,
      });
      s.ensureWindow(DESKTOP_WINDOW_IDS.subSession(subB), { kind: DESKTOP_WINDOW_KINDS.subSession, subId: subB });
      // subB is the most recently registered root → currently frontmost.
      expect(s.getZIndex(DESKTOP_WINDOW_IDS.subSession(subB))!).toBeGreaterThan(
        s.getZIndex(DESKTOP_WINDOW_IDS.subSession(subA))!,
      );
      // Raising the child of subA should pull subA's whole band above subB.
      expect(s.bringToFront(DESKTOP_WINDOW_IDS.subsessionFileBrowser(subA))).toBe(true);
      expect(s.getZIndex(DESKTOP_WINDOW_IDS.subSession(subA))!).toBeGreaterThan(
        s.getZIndex(DESKTOP_WINDOW_IDS.subSession(subB))!,
      );
    });
  });

  describe('removeWindow', () => {
    it('removes a root and returns true', () => {
      const s = new MutableDesktopWindowStack();
      s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo });
      expect(s.removeWindow('repo')).toBe(true);
      expect(s.hasWindow('repo')).toBe(false);
      expect(s.getZIndex('repo')).toBeNull();
    });

    it('returns false for unknown id', () => {
      const s = new MutableDesktopWindowStack();
      expect(s.removeWindow('nope')).toBe(false);
    });

    it('removing a parent removes its child descendants', () => {
      const s = new MutableDesktopWindowStack();
      const subId = 'abc';
      const parent = DESKTOP_WINDOW_IDS.subSession(subId);
      const child = DESKTOP_WINDOW_IDS.subsessionFileBrowser(subId);
      s.ensureWindow(parent, { kind: DESKTOP_WINDOW_KINDS.subSession, subId });
      s.ensureWindow(child, { kind: DESKTOP_WINDOW_KINDS.subsessionFileBrowser, parentId: parent, subId });
      s.removeWindow(parent);
      expect(s.hasWindow(parent)).toBe(false);
      expect(s.hasWindow(child)).toBe(false);
    });

    it('removing only the child leaves the parent intact', () => {
      const s = new MutableDesktopWindowStack();
      const subId = 'abc';
      const parent = DESKTOP_WINDOW_IDS.subSession(subId);
      const child = DESKTOP_WINDOW_IDS.subsessionFileBrowser(subId);
      s.ensureWindow(parent, { kind: DESKTOP_WINDOW_KINDS.subSession, subId });
      s.ensureWindow(child, { kind: DESKTOP_WINDOW_KINDS.subsessionFileBrowser, parentId: parent, subId });
      expect(s.removeWindow(child)).toBe(true);
      expect(s.hasWindow(parent)).toBe(true);
      expect(s.hasWindow(child)).toBe(false);
    });
  });

  describe('singleton reopen behavior', () => {
    it('reopening reuses the same identity and becomes frontmost in a single ensureWindow call', () => {
      const s = new MutableDesktopWindowStack();
      s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo });
      s.ensureWindow('discussions', { kind: DESKTOP_WINDOW_KINDS.discussions });
      // discussions frontmost (registered last).
      expect(s.removeWindow('repo')).toBe(true);
      // Reopen as the same id — fresh registration assigns the next root order
      // and makes 'repo' the frontmost root in one shot.
      expect(s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo })).toBe(true);
      expect(s.getZIndex('repo')!).toBeGreaterThan(s.getZIndex('discussions')!);
      // The follow-up bringToFront is therefore a no-op (already frontmost) —
      // call sites can safely chain ensure+bring without spurious version bumps.
      expect(s.bringToFront('repo')).toBe(false);
    });
  });

  describe('parent-child banded ordering', () => {
    it('child is above its owning parent', () => {
      const s = new MutableDesktopWindowStack();
      const subId = 'abc';
      const parent = DESKTOP_WINDOW_IDS.subSession(subId);
      const child = DESKTOP_WINDOW_IDS.subsessionFileBrowser(subId);
      s.ensureWindow(parent, { kind: DESKTOP_WINDOW_KINDS.subSession, subId });
      s.ensureWindow(child, { kind: DESKTOP_WINDOW_KINDS.subsessionFileBrowser, parentId: parent, subId });
      expect(s.getZIndex(child)!).toBeGreaterThan(s.getZIndex(parent)!);
    });

    it('an unrelated peer brought to front sits above the entire owner-child group', () => {
      const s = new MutableDesktopWindowStack();
      const subId = 'abc';
      const parent = DESKTOP_WINDOW_IDS.subSession(subId);
      const child = DESKTOP_WINDOW_IDS.subsessionFileBrowser(subId);
      s.ensureWindow(parent, { kind: DESKTOP_WINDOW_KINDS.subSession, subId });
      s.ensureWindow(child, { kind: DESKTOP_WINDOW_KINDS.subsessionFileBrowser, parentId: parent, subId });
      s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo });
      s.bringToFront('repo');
      const zRepo = s.getZIndex('repo')!;
      expect(zRepo).toBeGreaterThan(s.getZIndex(child)!);
      expect(zRepo).toBeGreaterThan(s.getZIndex(parent)!);
      // The owner-child relationship is still preserved within their own band.
      expect(s.getZIndex(child)!).toBeGreaterThan(s.getZIndex(parent)!);
    });

    it('child without parentId, or with a parentId that was never registered, is treated as a root', () => {
      const s = new MutableDesktopWindowStack();
      s.ensureWindow('orphan-child', {
        kind: DESKTOP_WINDOW_KINDS.subsessionFileBrowser,
        parentId: 'never-registered',
      });
      expect(s.getZIndex('orphan-child')).not.toBeNull();
    });
  });

  describe('z-index numeric layout', () => {
    it('z-index uses BASE_Z + (rank+1) * STRIDE for roots', () => {
      const s = new MutableDesktopWindowStack();
      s.ensureWindow('a', { kind: 'a' });
      s.ensureWindow('b', { kind: 'b' });
      s.ensureWindow('c', { kind: 'c' });
      // Newest (c) is frontmost (rank 2), oldest (a) is at rank 0.
      expect(s.getZIndex('a')).toBe(DESKTOP_WINDOW_STACK_BASE_Z + 1 * DESKTOP_WINDOW_STACK_STRIDE);
      expect(s.getZIndex('b')).toBe(DESKTOP_WINDOW_STACK_BASE_Z + 2 * DESKTOP_WINDOW_STACK_STRIDE);
      expect(s.getZIndex('c')).toBe(DESKTOP_WINDOW_STACK_BASE_Z + 3 * DESKTOP_WINDOW_STACK_STRIDE);
    });

    it('returns null for unknown id', () => {
      const s = new MutableDesktopWindowStack();
      expect(s.getZIndex('mystery')).toBeNull();
    });
  });

  describe('getFrontmostMatching', () => {
    it('returns frontmost root whose meta matches predicate', () => {
      const s = new MutableDesktopWindowStack();
      s.ensureWindow(DESKTOP_WINDOW_IDS.subSession('A'), { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'A' });
      s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo });
      s.ensureWindow(DESKTOP_WINDOW_IDS.subSession('B'), { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'B' });
      // B was registered last among sub-sessions → frontmost sub-session is B.
      const m = s.getFrontmostMatching((e) => e.meta.kind === DESKTOP_WINDOW_KINDS.subSession);
      expect(m?.meta.subId).toBe('B');
    });

    it('returns null when no entry matches', () => {
      const s = new MutableDesktopWindowStack();
      s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo });
      expect(s.getFrontmostMatching((e) => e.meta.kind === DESKTOP_WINDOW_KINDS.subSession)).toBeNull();
    });

    it('ignores child entries (only roots are candidates)', () => {
      const s = new MutableDesktopWindowStack();
      const parent = DESKTOP_WINDOW_IDS.subSession('A');
      s.ensureWindow(parent, { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'A' });
      s.ensureWindow(DESKTOP_WINDOW_IDS.subsessionFileBrowser('A'), {
        kind: DESKTOP_WINDOW_KINDS.subsessionFileBrowser,
        parentId: parent,
        subId: 'A',
      });
      const m = s.getFrontmostMatching((e) => e.meta.subId === 'A');
      expect(m?.id).toBe(parent);
    });
  });

  describe('getOrderForTests', () => {
    it('returns entries sorted back-to-front by effective z-index', () => {
      const s = new MutableDesktopWindowStack();
      s.ensureWindow('a', { kind: 'a' });
      s.ensureWindow('b', { kind: 'b' });
      s.ensureWindow('c', { kind: 'c' });
      s.bringToFront('a');
      const order = s.getOrderForTests().map((e) => e.id);
      expect(order).toEqual(['b', 'c', 'a']);
    });
  });

  describe('createDesktopWindowStack constructor seed', () => {
    it('seeds entries via repeated ensureWindow', () => {
      const s = createDesktopWindowStack([
        { id: 'a', meta: { kind: 'a' } },
        { id: 'b', meta: { kind: 'b' } },
      ]);
      expect(s.hasWindow('a')).toBe(true);
      expect(s.hasWindow('b')).toBe(true);
      expect(s.getZIndex('b')!).toBeGreaterThan(s.getZIndex('a')!);
    });
  });
});

describe('getFrontmostSubSessionId', () => {
  it('returns null when nothing is open', () => {
    const s = new MutableDesktopWindowStack();
    expect(getFrontmostSubSessionId(s, new Set())).toBeNull();
  });

  it('returns null when registered sub-sessions are not in the open set', () => {
    const s = new MutableDesktopWindowStack();
    s.ensureWindow(DESKTOP_WINDOW_IDS.subSession('A'), { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'A' });
    expect(getFrontmostSubSessionId(s, new Set())).toBeNull();
  });

  it('returns the frontmost open sub-session id', () => {
    const s = new MutableDesktopWindowStack();
    s.ensureWindow(DESKTOP_WINDOW_IDS.subSession('A'), { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'A' });
    s.ensureWindow(DESKTOP_WINDOW_IDS.subSession('B'), { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'B' });
    s.bringToFront(DESKTOP_WINDOW_IDS.subSession('A'));
    expect(getFrontmostSubSessionId(s, new Set(['A', 'B']))).toBe('A');
  });

  it('skips closed sub-sessions even when they are stacked higher', () => {
    const s = new MutableDesktopWindowStack();
    s.ensureWindow(DESKTOP_WINDOW_IDS.subSession('A'), { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'A' });
    s.ensureWindow(DESKTOP_WINDOW_IDS.subSession('B'), { kind: DESKTOP_WINDOW_KINDS.subSession, subId: 'B' });
    // B is stacked higher (registered later), but only A is open.
    expect(getFrontmostSubSessionId(s, new Set(['A']))).toBe('A');
  });
});

describe('openSubIdsKey', () => {
  it('returns a stable string for identical sets in any insertion order', () => {
    expect(openSubIdsKey(new Set(['B', 'A', 'C']))).toBe(openSubIdsKey(new Set(['C', 'A', 'B'])));
    expect(openSubIdsKey(new Set(['a', 'b']))).toBe('a,b');
    expect(openSubIdsKey(new Set())).toBe('');
  });

  it('changes when the set membership changes', () => {
    expect(openSubIdsKey(new Set(['a', 'b']))).not.toBe(openSubIdsKey(new Set(['a', 'b', 'c'])));
  });
});

describe('render-stability invariants (stack-level)', () => {
  it('100 redundant ensureWindow + bringToFront calls on the frontmost window report zero changes', () => {
    const s = new MutableDesktopWindowStack();
    s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo });
    s.bringToFront('repo'); // already frontmost — also no-op
    let changes = 0;
    for (let i = 0; i < 100; i++) {
      if (s.ensureWindow('repo', { kind: DESKTOP_WINDOW_KINDS.repo })) changes++;
      if (s.bringToFront('repo')) changes++;
    }
    expect(changes).toBe(0);
  });

  it('a no-op interaction sequence does NOT change getZIndex output', () => {
    const s = new MutableDesktopWindowStack();
    s.ensureWindow('a', { kind: 'a' });
    s.ensureWindow('b', { kind: 'b' });
    s.bringToFront('b');
    const zBefore = s.getZIndex('b');
    for (let i = 0; i < 50; i++) {
      s.bringToFront('b'); // already frontmost, no-op
      s.ensureWindow('b', { kind: 'b' }); // identical meta, no-op
    }
    expect(s.getZIndex('b')).toBe(zBefore);
  });
});
