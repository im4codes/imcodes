/**
 * Desktop floating-window stack.
 *
 * One unified ordering system for all desktop, non-modal, managed workspace
 * floating windows in the web client. Replaces the previous split between
 * `subZIndexes` (in `app.tsx`) and `FloatingPanel`'s default `zIndex` props.
 *
 * Why this module exists is the spec; HOW it's shaped is set by the design
 * doc's "React State Integration (Normative)" section. The TL;DR for anyone
 * wiring this up:
 *
 *   1. The stack instance is a single MUTABLE object held in a `useRef`.
 *   2. `ensureWindow`/`bringToFront`/`removeWindow` mutate in place and
 *      return `true` only when something observable changed.
 *   3. The React side keeps a `useReducer((n) => n + 1, 0)` version counter
 *      and bumps it only when a mutation returned `true`.
 *   4. Components subscribe to the version counter (a number), NOT to the
 *      stack object. `useMemo` / `useEffect` dep arrays MUST list the
 *      counter or other primitives — never the stack instance.
 *
 * The previous attempt at this change recreated the entire stack object on
 * every interaction, which cascaded through `useMemo([..., stack])` deps in
 * `App` and remounted ChatView on every pointer-down inside any managed
 * window. ChatView's history-fetch effect re-fired on every remount,
 * producing 30+ concurrent `/timeline/history/full` requests per second per
 * open session and overwhelming the daemon's WS write buffer. See commit
 * `31f2a56e` (reverted) and the `7c4e43b3` revert.
 */

export const DESKTOP_WINDOW_STACK_BASE_Z = 5000;
export const DESKTOP_WINDOW_STACK_STRIDE = 10;

/**
 * Stable identity helpers — these strings are also persisted as
 * `FloatingPanel` geometry keys (`localStorage["rcc_float_${id}"]`), so
 * changing them resets the user's saved window positions. Don't.
 */
/**
 * NOTE on `cronManager: 'cron'`: the deployed `FloatingPanel` for the cron
 * UI uses `id="cron"`, which is also the localStorage geometry key
 * `rcc_float_cron`. Aligning the stack identity to the deployed id avoids
 * resetting saved window positions for existing users. The spec doc
 * (`specs/desktop-window-stack/spec.md`) was updated to match.
 */
export const DESKTOP_WINDOW_IDS = {
  filePreview: 'file-preview',
  fileBrowser: 'filebrowser',
  repo: 'repo',
  cronManager: 'cron',
  discussions: 'discussions',
  sharedContextManagement: 'shared-context-management',
  sharedContextDiagnostics: 'shared-context-diagnostics',
  localWebPreview: (serverId: string) => `local-web-preview-${serverId}`,
  subSession: (subId: string) => `sub:${subId}`,
  subsessionFileBrowser: (subId: string) => `subsession-filebrowser:${subId}`,
} as const;

export const DESKTOP_WINDOW_KINDS = {
  filePreview: 'file-preview',
  fileBrowser: 'file-browser',
  localWebPreview: 'local-web-preview',
  repo: 'repo',
  cronManager: 'cronmanager',
  discussions: 'discussions',
  sharedContextManagement: 'shared-context-management',
  sharedContextDiagnostics: 'shared-context-diagnostics',
  subSession: 'sub-session',
  subsessionFileBrowser: 'subsession-filebrowser',
} as const;

export type DesktopWindowKind = typeof DESKTOP_WINDOW_KINDS[keyof typeof DESKTOP_WINDOW_KINDS] | string;

export interface DesktopWindowMeta {
  kind: DesktopWindowKind;
  parentId?: string;
  serverId?: string;
  subId?: string;
}

export interface DesktopWindowStackEntry {
  id: string;
  meta: DesktopWindowMeta;
}

interface InternalEntry extends DesktopWindowStackEntry {
  /** Root ordering counter. Higher = more recently raised. Children carry 0. */
  order: number;
  /** 0 for root entries; increasing for sibling children of the same parent. */
  childOrder: number;
}

function sameMeta(a: DesktopWindowMeta, b: DesktopWindowMeta): boolean {
  return a.kind === b.kind
    && a.parentId === b.parentId
    && a.serverId === b.serverId
    && a.subId === b.subId;
}

/**
 * Mutable stack. The CLASS NAME contains "Mutable" deliberately so call sites
 * understand they must not clone or replace this instance per render.
 */
export class MutableDesktopWindowStack {
  private readonly entries = new Map<string, InternalEntry>();
  private nextRootOrder = 1;
  private nextChildOrder = 1;

  /**
   * Idempotent register. Returns true iff the entry was newly added OR an
   * existing entry's meta was updated to differ from the previous value.
   * Calling repeatedly with identical args returns false — the React side
   * uses this to suppress version bumps on no-op re-registers.
   */
  ensureWindow(id: string, meta: DesktopWindowMeta): boolean {
    const existing = this.entries.get(id);
    if (existing) {
      if (sameMeta(existing.meta, meta)) return false;
      existing.meta = { ...meta };
      return true;
    }
    const isChild = !!meta.parentId && this.entries.has(meta.parentId);
    this.entries.set(id, {
      id,
      meta: { ...meta },
      order: isChild ? 0 : this.nextRootOrder++,
      childOrder: isChild ? this.nextChildOrder++ : 0,
    });
    return true;
  }

  /**
   * Raise the entry's root to be the frontmost root. Returns true iff the
   * order actually changed. Calling repeatedly on a window whose root is
   * already frontmost returns false — this is the critical render-stability
   * guard for rapid pointer events.
   *
   * For child entries, raising the child raises the OWNING ROOT's order;
   * banded ordering keeps the child above its owner automatically.
   */
  bringToFront(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const rootId = this.getRootId(entry);
    const root = this.entries.get(rootId);
    if (!root) return false;

    // Find the highest current root order.
    let maxOrder = root.order;
    for (const e of this.entries.values()) {
      if (e.childOrder === 0 && e.order > maxOrder) maxOrder = e.order;
    }
    if (root.order === maxOrder) return false; // already frontmost

    root.order = ++this.nextRootOrder;
    return true;
  }

  /** Returns true iff the window (and any of its descendant children) was removed. */
  removeWindow(id: string): boolean {
    if (!this.entries.has(id)) return false;
    const descendants = this.collectDescendants(id);
    for (const did of descendants) this.entries.delete(did);
    return true;
  }

  /**
   * Cheap read used during render. Computes from current state without
   * allocating top-level structures (just a couple of small temporary
   * arrays for ranking — bounded by the number of managed windows, which
   * is in the low single digits in practice).
   */
  getZIndex(id: string): number | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const rootId = this.getRootId(entry);
    const rootRank = this.computeRootRank(rootId);
    if (rootRank < 0) return null;
    const rootZ = DESKTOP_WINDOW_STACK_BASE_Z + (rootRank + 1) * DESKTOP_WINDOW_STACK_STRIDE;
    if (entry.id === rootId) return rootZ;
    const siblingRank = this.computeChildRank(rootId, entry.id);
    return rootZ + (siblingRank >= 0 ? siblingRank + 1 : 1);
  }

  /** Returns the frontmost root entry whose meta matches the predicate, or null. */
  getFrontmostMatching(predicate: (entry: DesktopWindowStackEntry) => boolean): DesktopWindowStackEntry | null {
    let best: InternalEntry | null = null;
    for (const e of this.entries.values()) {
      if (e.childOrder !== 0) continue;
      if (!predicate(e)) continue;
      if (!best || e.order > best.order) best = e;
    }
    return best ? { id: best.id, meta: best.meta } : null;
  }

  hasWindow(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * Test-only deterministic read. Returns entries sorted back-to-front by
   * effective z-index. May allocate freely — production code should use
   * `getZIndex` / `getFrontmostMatching` instead.
   */
  getOrderForTests(): DesktopWindowStackEntry[] {
    const ranked = Array.from(this.entries.values()).map((e) => ({
      entry: e,
      z: this.getZIndex(e.id) ?? 0,
    }));
    ranked.sort((a, b) => a.z - b.z);
    return ranked.map((r) => ({ id: r.entry.id, meta: r.entry.meta }));
  }

  private getRootId(entry: InternalEntry): string {
    if (entry.childOrder === 0) return entry.id;
    return entry.meta.parentId ?? entry.id;
  }

  private collectDescendants(id: string): Set<string> {
    const out = new Set<string>([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of this.entries.values()) {
        if (e.meta.parentId && out.has(e.meta.parentId) && !out.has(e.id)) {
          out.add(e.id);
          changed = true;
        }
      }
    }
    return out;
  }

  private computeRootRank(rootId: string): number {
    const roots: InternalEntry[] = [];
    for (const e of this.entries.values()) {
      if (e.childOrder === 0) roots.push(e);
    }
    roots.sort((a, b) => a.order - b.order);
    return roots.findIndex((r) => r.id === rootId);
  }

  private computeChildRank(rootId: string, childId: string): number {
    const children: InternalEntry[] = [];
    for (const e of this.entries.values()) {
      if (e.childOrder !== 0 && e.meta.parentId === rootId) children.push(e);
    }
    children.sort((a, b) => a.childOrder - b.childOrder);
    return children.findIndex((c) => c.id === childId);
  }
}

/** Convenience constructor (also seeds with prior entries — used for tests / hydration only). */
export function createDesktopWindowStack(initial: Iterable<DesktopWindowStackEntry> = []): MutableDesktopWindowStack {
  const s = new MutableDesktopWindowStack();
  for (const e of initial) s.ensureWindow(e.id, e.meta);
  return s;
}

/**
 * Pure helper for deriving the frontmost open sub-session ID. Lives in this
 * module so consumers can call it from a `useMemo` whose deps are
 * `[stackVersion, openSubIdsKey]` rather than the stack instance.
 */
export function getFrontmostSubSessionId(
  stack: MutableDesktopWindowStack,
  openSubIds: ReadonlySet<string>,
): string | null {
  const entry = stack.getFrontmostMatching(
    (e) => e.meta.kind === DESKTOP_WINDOW_KINDS.subSession
      && !!e.meta.subId
      && openSubIds.has(e.meta.subId),
  );
  return entry?.meta.subId ?? null;
}

/**
 * Stable serialization of the open sub-session set for use in memo dep arrays.
 * Returns a sorted, comma-joined string so memos dependent on "which subs are
 * open" can compare with referential equality on the string instead of on the
 * Set instance (Sets are reference-typed and would invalidate every render).
 */
export function openSubIdsKey(openSubIds: ReadonlySet<string>): string {
  return Array.from(openSubIds).sort().join(',');
}
