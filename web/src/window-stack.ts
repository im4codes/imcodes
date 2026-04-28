export const DESKTOP_WINDOW_STACK_BASE_Z = 5000;
export const DESKTOP_WINDOW_STACK_STRIDE = 10;

export const DESKTOP_WINDOW_IDS = {
  filePreview: 'file-preview',
  fileBrowser: 'filebrowser',
  repo: 'repo',
  cronManager: 'cronmanager',
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
  order: number;
  childOrder: number;
}

export interface DesktopWindowStack {
  ensureWindow(id: string, meta: DesktopWindowMeta): boolean;
  bringToFront(id: string): boolean;
  removeWindow(id: string): boolean;
  getZIndex(id: string): number | null;
  getFrontmostMatching(predicate: (entry: DesktopWindowStackEntry) => boolean): DesktopWindowStackEntry | null;
  getOrderForTests(): DesktopWindowStackEntry[];
}

class MutableDesktopWindowStack implements DesktopWindowStack {
  private readonly entries = new Map<string, InternalEntry>();
  private nextOrder = 1;
  private nextChildOrder = 1;

  constructor(initialEntries: Iterable<DesktopWindowStackEntry> = []) {
    for (const entry of initialEntries) {
      this.ensureWindow(entry.id, entry.meta);
    }
  }

  ensureWindow(id: string, meta: DesktopWindowMeta): boolean {
    const existing = this.entries.get(id);
    if (existing) {
      existing.meta = { ...meta };
      return false;
    }

    const isRegisteredChild = !!meta.parentId && this.entries.has(meta.parentId);
    this.entries.set(id, {
      id,
      meta: { ...meta },
      order: isRegisteredChild ? 0 : this.nextOrder++,
      childOrder: isRegisteredChild ? this.nextChildOrder++ : 0,
    });
    return true;
  }

  bringToFront(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;

    const root = this.entries.get(this.getRootId(entry));
    if (!root) return false;
    root.order = this.nextOrder++;
    return true;
  }

  removeWindow(id: string): boolean {
    if (!this.entries.has(id)) return false;

    const descendants = new Set<string>([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of this.entries.values()) {
        if (entry.meta.parentId && descendants.has(entry.meta.parentId) && !descendants.has(entry.id)) {
          descendants.add(entry.id);
          changed = true;
        }
      }
    }

    for (const descendantId of descendants) {
      this.entries.delete(descendantId);
    }
    return true;
  }

  getZIndex(id: string): number | null {
    const entry = this.entries.get(id);
    if (!entry) return null;

    const rootRanks = this.getRootRanks();
    const rootChildren = this.getChildrenForRoots();
    const rootId = this.getRootId(entry);
    const rootRank = rootRanks.get(rootId);
    if (rootRank == null) return null;

    const maxChildOffset = Math.max(
      DESKTOP_WINDOW_STACK_STRIDE,
      ...Array.from(rootChildren.values()).map((children) => children.length + 2),
    );

    const rootZ = DESKTOP_WINDOW_STACK_BASE_Z + (rootRank + 1) * maxChildOffset;
    if (entry.id === rootId) return rootZ;

    const childRank = this.getChildrenForRoot(rootId).findIndex((child) => child.id === entry.id);
    return childRank >= 0 ? rootZ + childRank + 1 : rootZ + 1;
  }

  getFrontmostMatching(predicate: (entry: DesktopWindowStackEntry) => boolean): DesktopWindowStackEntry | null {
    const ordered = this.getOrderForTests();
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (predicate(ordered[i])) return ordered[i];
    }
    return null;
  }

  getOrderForTests(): DesktopWindowStackEntry[] {
    return Array.from(this.entries.values())
      .sort((a, b) => {
        const zA = this.getZIndex(a.id) ?? 0;
        const zB = this.getZIndex(b.id) ?? 0;
        if (zA !== zB) return zA - zB;
        return a.id.localeCompare(b.id);
      })
      .map((entry) => ({ id: entry.id, meta: { ...entry.meta } }));
  }

  private getRootId(entry: InternalEntry): string {
    let current = entry;
    const seen = new Set<string>([entry.id]);
    while (current.meta.parentId) {
      const parent = this.entries.get(current.meta.parentId);
      if (!parent || seen.has(parent.id)) break;
      current = parent;
      seen.add(current.id);
    }
    return current.id;
  }

  private getRootRanks(): Map<string, number> {
    const roots = Array.from(this.entries.values())
      .filter((entry) => this.getRootId(entry) === entry.id)
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.id.localeCompare(b.id);
      });

    return new Map(roots.map((entry, index) => [entry.id, index]));
  }

  private getChildrenForRoot(rootId: string): InternalEntry[] {
    return Array.from(this.entries.values())
      .filter((entry) => entry.id !== rootId && this.getRootId(entry) === rootId)
      .sort((a, b) => {
        if (a.childOrder !== b.childOrder) return a.childOrder - b.childOrder;
        return a.id.localeCompare(b.id);
      });
  }

  private getChildrenForRoots(): Map<string, InternalEntry[]> {
    const childrenByRoot = new Map<string, InternalEntry[]>();
    for (const entry of this.entries.values()) {
      const rootId = this.getRootId(entry);
      if (entry.id === rootId) continue;
      const list = childrenByRoot.get(rootId) ?? [];
      list.push(entry);
      childrenByRoot.set(rootId, list);
    }

    for (const list of childrenByRoot.values()) {
      list.sort((a, b) => {
        if (a.childOrder !== b.childOrder) return a.childOrder - b.childOrder;
        return a.id.localeCompare(b.id);
      });
    }
    return childrenByRoot;
  }
}

export function createDesktopWindowStack(initialEntries?: Iterable<DesktopWindowStackEntry>): DesktopWindowStack {
  return new MutableDesktopWindowStack(initialEntries);
}

export function getFrontmostSubSessionId(
  stack: DesktopWindowStack,
  openSubIds: ReadonlySet<string>,
): string | null {
  const frontmost = stack.getFrontmostMatching((entry) => (
    entry.meta.kind === DESKTOP_WINDOW_KINDS.subSession
    && !!entry.meta.subId
    && openSubIds.has(entry.meta.subId)
  ));
  return frontmost?.meta.subId ?? null;
}

export interface DesktopWindowStackSyncOptions {
  keepChildrenWithActiveParent?: boolean;
}

export function syncDesktopWindowStack(
  stack: DesktopWindowStack,
  activeRootEntries: readonly DesktopWindowStackEntry[],
  options: DesktopWindowStackSyncOptions = {},
): void {
  const { keepChildrenWithActiveParent = true } = options;
  const activeIds = new Set(activeRootEntries.map((entry) => entry.id));
  const existing = stack.getOrderForTests();
  const existingIds = new Set(existing.map((entry) => entry.id));

  for (const entry of existing) {
    const keepDetachedChild = keepChildrenWithActiveParent
      && entry.meta.kind === DESKTOP_WINDOW_KINDS.subsessionFileBrowser
      && !!entry.meta.parentId
      && activeIds.has(entry.meta.parentId);

    if (!activeIds.has(entry.id) && !keepDetachedChild) {
      stack.removeWindow(entry.id);
    }
  }

  for (const entry of activeRootEntries) {
    stack.ensureWindow(entry.id, entry.meta);
    if (!existingIds.has(entry.id)) stack.bringToFront(entry.id);
  }
}
