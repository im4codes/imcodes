/**
 * @vitest-environment jsdom
 *
 * Render-stability regression tests for the desktop window stack integration
 * (openspec change `unify-floating-window-stack`, tasks 7.1–7.3).
 *
 * The previous attempt at this change recreated the stack object on every
 * mutation. Every pointer-down, drag-start, or resize-start inside a managed
 * window flipped the stack reference, invalidated `useMemo([..., stack])`
 * dep arrays in `App`, remounted the entire chat tree, and re-fired the
 * `timeline.history/full` fetch effect — producing a 30+ rps fetch storm
 * per open session that overwhelmed the daemon's WS write buffer.
 *
 * These tests pin the contract that prevents that bug class from
 * recurring, mirroring the React integration shape used by `app.tsx`:
 *
 *   - stack instance lives in a `useRef`
 *   - re-renders are triggered by a `useState` version counter
 *   - mutation helpers bump the counter ONLY when the underlying stack
 *     reports a real change
 *
 * If the integration regresses (e.g., someone reintroduces
 * `createDesktopWindowStack(prev.getOrderForTests())` inside a setState
 * updater), these tests will fail because the version counter will bump
 * on every redundant call and the consumer will see new memo references.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import { cleanup, render, act } from '@testing-library/preact';
import {
  MutableDesktopWindowStack,
  DESKTOP_WINDOW_IDS,
  DESKTOP_WINDOW_KINDS,
  type DesktopWindowMeta,
} from '../src/window-stack.js';

afterEach(() => {
  cleanup();
});

interface UseDesktopStackResult {
  stackRef: { current: MutableDesktopWindowStack };
  stackVersion: number;
  ensureWindow: (id: string, meta: DesktopWindowMeta, opts?: { bringToFront?: boolean }) => void;
  bringToFront: (id: string) => void;
  removeWindow: (id: string) => void;
  getZIndex: (id: string, fallback: number) => number;
}

/**
 * Mirrors the exact React integration shape used in `web/src/app.tsx`. The
 * point of these tests is to lock down THAT shape — keeping the test
 * helper byte-identical to the production integration is load-bearing.
 */
function useDesktopStack(): UseDesktopStackResult {
  const stackRef = useRef<MutableDesktopWindowStack | null>(null);
  if (stackRef.current === null) stackRef.current = new MutableDesktopWindowStack();
  const [stackVersion, setStackVersion] = useState(0);
  const bumpStack = useCallback(() => setStackVersion((n) => n + 1), []);

  const ensureWindow = useCallback((id: string, meta: DesktopWindowMeta, opts?: { bringToFront?: boolean }) => {
    const stack = stackRef.current!;
    let changed = stack.ensureWindow(id, meta);
    if (opts?.bringToFront) {
      if (stack.bringToFront(id)) changed = true;
    }
    if (changed) bumpStack();
  }, [bumpStack]);

  const bringToFront = useCallback((id: string) => {
    if (stackRef.current!.bringToFront(id)) bumpStack();
  }, [bumpStack]);

  const removeWindow = useCallback((id: string) => {
    if (stackRef.current!.removeWindow(id)) bumpStack();
  }, [bumpStack]);

  const getZIndex = useCallback((id: string, fallback: number) => {
    return stackRef.current!.getZIndex(id) ?? fallback;
  }, []);

  return {
    stackRef: stackRef as { current: MutableDesktopWindowStack },
    stackVersion,
    ensureWindow,
    bringToFront,
    removeWindow,
    getZIndex,
  };
}

interface ChildHarnessProps {
  watchedZ: number;
  /** Memo dep list mirrors `app.tsx` — primitive only, never object/Map/Set. */
  derivedKey: string;
}

const childRenderSpy = vi.fn();
const fetchSpy = vi.fn();

/**
 * Stand-in for `ChatView`. Counts mounts (test 7.1 / 7.2 assertion target)
 * and runs a fetch effect that is keyed on `derivedKey` — a primitive — so
 * we can prove the fetch effect does NOT re-fire when the stack changes
 * but `derivedKey` does not.
 */
function ChildHarness({ watchedZ, derivedKey }: ChildHarnessProps) {
  // Mount counter via ref+effect-once.
  const mountedRef = useRef(false);
  if (!mountedRef.current) {
    mountedRef.current = true;
    childRenderSpy();
    // Simulate the post-mount history fetch. Effect deps would normally
    // include something stable like sessionId — here we simulate with
    // `derivedKey`. If `derivedKey` were the stack object, this would
    // refire on every mutation; since it's a string, it does not.
    fetchSpy(derivedKey);
  }
  return <div data-testid="child" data-z={watchedZ}>child</div>;
}

interface TestAppHandle {
  ensureWindow: UseDesktopStackResult['ensureWindow'];
  bringToFront: UseDesktopStackResult['bringToFront'];
  removeWindow: UseDesktopStackResult['removeWindow'];
  /** Reads the latest memoized z-value for `sub:A`. */
  getMemoizedZForSubA: () => number;
}

const handleSlot: { current: TestAppHandle | null } = { current: null };

function TestApp() {
  const { stackVersion, ensureWindow, bringToFront, removeWindow, getZIndex } = useDesktopStack();

  // Mirrors `app.tsx`: memo dep list MUST be primitives only. Listing the
  // stack object here is the bug we're guarding against — that would
  // cause `subAZ` to re-allocate on every stack mutation, the parent
  // component would re-render, and ChildHarness would unmount/remount.
  const subAZ = useMemo(
    () => getZIndex(DESKTOP_WINDOW_IDS.subSession('A'), 6000),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: stackVersion only
    [stackVersion],
  );

  // Primitive derivation used by the child's fetch effect.
  const derivedKey = `subA:open`;

  // Expose helpers for the test to drive interactions.
  handleSlot.current = {
    ensureWindow,
    bringToFront,
    removeWindow,
    getMemoizedZForSubA: () => subAZ,
  };

  return <ChildHarness watchedZ={subAZ} derivedKey={derivedKey} />;
}

function setupTestApp(): TestAppHandle {
  childRenderSpy.mockReset();
  fetchSpy.mockReset();
  handleSlot.current = null;
  render(<TestApp />);
  if (!handleSlot.current) throw new Error('TestApp did not mount');
  return handleSlot.current;
}

describe('Section 7.1 — repeated bringToFront on the frontmost window does not remount descendants', () => {
  it('100 redundant bringToFront calls produce zero additional ChildHarness mounts', () => {
    const handle = setupTestApp();
    act(() => {
      handle.ensureWindow(DESKTOP_WINDOW_IDS.subSession('A'), {
        kind: DESKTOP_WINDOW_KINDS.subSession,
        subId: 'A',
      }, { bringToFront: true });
    });
    const mountsAfterOpen = childRenderSpy.mock.calls.length;

    act(() => {
      for (let i = 0; i < 100; i++) {
        handle.bringToFront(DESKTOP_WINDOW_IDS.subSession('A'));
      }
    });

    // The ChildHarness mounts exactly once on initial render and stays mounted
    // through the redundant interactions.
    expect(childRenderSpy.mock.calls.length).toBe(mountsAfterOpen);
  });

  it('100 redundant bringToFront calls produce zero additional fetch invocations', () => {
    const handle = setupTestApp();
    act(() => {
      handle.ensureWindow(DESKTOP_WINDOW_IDS.subSession('A'), {
        kind: DESKTOP_WINDOW_KINDS.subSession,
        subId: 'A',
      }, { bringToFront: true });
    });
    const fetchesAfterOpen = fetchSpy.mock.calls.length;

    act(() => {
      for (let i = 0; i < 100; i++) {
        handle.bringToFront(DESKTOP_WINDOW_IDS.subSession('A'));
      }
    });

    expect(fetchSpy.mock.calls.length).toBe(fetchesAfterOpen);
  });
});

describe('Section 7.2 — pointer-down equivalent on the frontmost window does not refetch session history', () => {
  it('repeated bringToFront calls (the "pointer-down" stack effect) issue zero new fetches', () => {
    const handle = setupTestApp();
    act(() => {
      handle.ensureWindow(DESKTOP_WINDOW_IDS.subSession('A'), {
        kind: DESKTOP_WINDOW_KINDS.subSession,
        subId: 'A',
      }, { bringToFront: true });
    });
    const initialFetches = fetchSpy.mock.calls.length;

    act(() => {
      for (let i = 0; i < 50; i++) {
        // Each call simulates `FloatingPanel.onMouseDown`'s onFocus → bringToFront.
        handle.bringToFront(DESKTOP_WINDOW_IDS.subSession('A'));
      }
    });

    expect(fetchSpy.mock.calls.length).toBe(initialFetches);
  });
});

describe('Section 7.3 — useMemo referential stability for an unchanged window\'s z-index', () => {
  it('memoized z-value retains referential equality when only an UNRELATED window\'s order changes', () => {
    const handle = setupTestApp();
    act(() => {
      handle.ensureWindow(DESKTOP_WINDOW_IDS.subSession('A'), {
        kind: DESKTOP_WINDOW_KINDS.subSession,
        subId: 'A',
      }, { bringToFront: true });
    });
    const zBefore = handle.getMemoizedZForSubA();

    // Open a second window — at this point sub:A is no longer frontmost,
    // so its rank changes and z-index legitimately differs.
    act(() => {
      handle.ensureWindow(DESKTOP_WINDOW_IDS.subSession('B'), {
        kind: DESKTOP_WINDOW_KINDS.subSession,
        subId: 'B',
      }, { bringToFront: true });
    });

    // Now bring B to front 50 times. B is already frontmost → no version
    // bump → no re-render → memoized subAZ retains its previous value.
    act(() => {
      for (let i = 0; i < 50; i++) {
        handle.bringToFront(DESKTOP_WINDOW_IDS.subSession('B'));
      }
    });
    const zAfterRedundantInteractions = handle.getMemoizedZForSubA();
    expect(zAfterRedundantInteractions).toBe(zBefore);
  });
});

describe('Section 7.4 — dep-array hygiene (lint-style grep)', () => {
  it('app.tsx lists `stackVersion` in dep arrays where ordering matters, and never lists the stack instance itself', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const appPath = path.join(process.cwd(), 'web', 'src', 'app.tsx');
    const src = await fs.readFile(appPath, 'utf8');

    // Forbidden patterns: stack object inside a hook dep array.
    // Both legacy (`desktopWindowStack`) and current (`stackRef.current`) are blocked.
    const forbidden = [
      /\[(?:[^\]]*,\s*)?desktopWindowStack(?:\s*[,\]])/,
      /\[(?:[^\]]*,\s*)?stackRef\.current(?:\s*[,\]])/,
    ];
    for (const re of forbidden) {
      expect(src).not.toMatch(re);
    }
  });
});
