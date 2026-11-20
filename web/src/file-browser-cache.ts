export interface CachedFsNode {
  id: string;
  name: string;
  isDir: boolean;
  children?: CachedFsNode[];
  isLoading?: boolean;
  size?: number;
  mtime?: number;
  freeBytes?: number;
  totalBytes?: number;
  listing?: {
    complete: boolean;
    truncated?: { total: number };
    partial?: true;
  };
}

export interface FileBrowserMemoryCacheEntry {
  data: CachedFsNode[];
  currentLabel: string;
  expandedPaths: string[];
  modifiedFiles: Array<[string, string]>;
  updatedAt: number;
}

export const FILE_BROWSER_CACHE_MAX_ENTRIES = 20;

const fileBrowserCache = new Map<string, FileBrowserMemoryCacheEntry>();

export function makeFileBrowserCacheKey(opts: {
  serverId?: string | null;
  scopedSessionName?: string | null;
  startPath: string;
  includeFiles: boolean;
  showHidden: boolean;
  listView?: boolean;
}): string {
  const server = opts.serverId?.trim() || 'local';
  const session = opts.scopedSessionName?.trim() || '';
  return JSON.stringify([
    server,
    session,
    opts.startPath,
    opts.includeFiles ? 1 : 0,
    opts.showHidden ? 1 : 0,
    opts.listView ? 1 : 0,
  ]);
}

function cloneCachedNodes(nodes: CachedFsNode[]): CachedFsNode[] {
  return nodes.map((node) => ({
    ...node,
    isLoading: false,
    ...(node.children ? { children: cloneCachedNodes(node.children) } : {}),
  }));
}

export function getFileBrowserCache(key: string): FileBrowserMemoryCacheEntry | null {
  const entry = fileBrowserCache.get(key);
  if (!entry) return null;
  // Touch LRU order.
  fileBrowserCache.delete(key);
  fileBrowserCache.set(key, entry);
  return {
    data: cloneCachedNodes(entry.data),
    currentLabel: entry.currentLabel,
    expandedPaths: [...entry.expandedPaths],
    modifiedFiles: entry.modifiedFiles.map(([k, v]) => [k, v]),
    updatedAt: entry.updatedAt,
  };
}

export function setFileBrowserCache(key: string, entry: FileBrowserMemoryCacheEntry): void {
  fileBrowserCache.delete(key);
  fileBrowserCache.set(key, {
    data: cloneCachedNodes(entry.data),
    currentLabel: entry.currentLabel,
    expandedPaths: [...entry.expandedPaths],
    modifiedFiles: entry.modifiedFiles.map(([k, v]) => [k, v]),
    updatedAt: entry.updatedAt,
  });
  while (fileBrowserCache.size > FILE_BROWSER_CACHE_MAX_ENTRIES) {
    const oldestKey = fileBrowserCache.keys().next().value;
    if (oldestKey === undefined) break;
    fileBrowserCache.delete(oldestKey);
  }
}

export function clearFileBrowserCache(): void {
  fileBrowserCache.clear();
}

export function mergePreservedExpandedChildren<T extends CachedFsNode>(
  freshChildren: T[],
  existingChildren: readonly T[] | undefined,
  expandedPaths: ReadonlySet<string>,
): T[] {
  if (!existingChildren || existingChildren.length === 0 || expandedPaths.size === 0) {
    return freshChildren;
  }
  const existingById = new Map<string, T>();
  for (const child of existingChildren) {
    existingById.set(child.id, child);
  }
  return freshChildren.map((child) => {
    if (!child.isDir || !expandedPaths.has(child.id)) return child;
    const prev = existingById.get(child.id);
    if (!prev || !prev.isDir || !prev.children) return child;
    const mergedSubchildren = child.children && child.children.length > 0
      ? mergePreservedExpandedChildren(child.children, prev.children, expandedPaths)
      : mergePreservedExpandedChildren(prev.children, prev.children, expandedPaths);
    return {
      ...child,
      children: mergedSubchildren,
      ...(child.listing === undefined && prev.listing !== undefined ? { listing: prev.listing } : {}),
    };
  });
}
