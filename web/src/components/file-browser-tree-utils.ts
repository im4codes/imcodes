/**
 * Pure tree, path, git-rollup, and drag-and-drop helpers for FileBrowser.
 * Supports Unix `/`, Windows `\`, drive roots (`C:\`), `~`, and `:session-root:` paths.
 */

export type DirGitStatusKind = 'modified' | 'deleted' | 'added' | 'untracked';

export interface TreeNavNode {
  id: string;
  name: string;
  isDir: boolean;
  hidden?: boolean;
  children?: TreeNavNode[];
}

export interface VisibleTreeEntry {
  node: TreeNavNode;
  depth: number;
  parentId: string | null;
}

const DIR_GIT_SEVERITY: Record<DirGitStatusKind, number> = {
  modified: 4,
  deleted: 3,
  added: 2,
  untracked: 1,
};

/** Strip trailing directory separators except Unix `/` and Windows drive roots (`C:\`, `C:/`). */
export function normalizeFsPath(p: string): string {
  if (!p) return p;
  if (p === '/' || p === '\\') return p;
  if (/^[A-Za-z]:[/\\]$/.test(p)) return p;
  const trimmed = p.replace(/[/\\]+$/, '');
  if (!trimmed) return p.startsWith('\\') ? '\\' : '/';
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + (p.includes('\\') ? '\\' : '/');
  return trimmed;
}

/** Determine native separator (`\` for Windows paths, `/` otherwise). */
export function getPathSeparator(p: string): '/' | '\\' {
  return p.includes('\\') ? '\\' : '/';
}

/** Return the basename segment of a Unix, Windows, or scoped path. */
export function getPathBasename(p: string): string {
  const norm = normalizeFsPath(p);
  if (norm === '/' || /^[A-Za-z]:[/\\]$/.test(norm)) return norm;
  const parts = norm.split(/[/\\]/).filter(Boolean);
  return parts.pop() || norm;
}

/**
 * Return parent directory path or null if already at a root (`/`, `C:\`, `~`, `:session-root:`).
 */
export function getParentDirPath(p: string): string | null {
  if (!p) return null;
  if (p === '/' || p === '~' || /^:[a-z0-9-]+:$/.test(p) || /^[A-Za-z]:[/\\]?$/.test(p)) {
    return null;
  }
  const normalized = p.replace(/[/\\]+$/, '');
  if (!normalized) return null;
  const sep = getPathSeparator(normalized);
  const idx = normalized.lastIndexOf(sep);
  if (idx < 0) return null;
  if (idx === 0) return sep;
  let parent = normalized.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) parent += sep;
  return parent;
}

/** Build child path preserving parent path's separator style. */
export function buildChildFsPath(parentPath: string, childName: string): string {
  const sep = getPathSeparator(parentPath);
  return `${parentPath}${parentPath.endsWith(sep) ? '' : sep}${childName}`;
}

/** Validate single file or folder entry name (non-empty, no separators, not `.` or `..`). */
export function isValidEntryName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return false;
  return !trimmed.includes('/') && !trimmed.includes('\\');
}

/**
 * Check whether `candidatePath` is identical to or strictly inside `ancestorPath`.
 * Handles both `/` and `\` separators safely without prefix collisions (`/src` vs `/src2`).
 */
export function isPathEqualOrDescendant(candidatePath: string, ancestorPath: string): boolean {
  if (!candidatePath || !ancestorPath) return false;
  const normCandidate = normalizeFsPath(candidatePath).replace(/\\/g, '/');
  const normAncestor = normalizeFsPath(ancestorPath).replace(/\\/g, '/');
  if (normCandidate === normAncestor) return true;
  if (normAncestor === '/') return normCandidate.startsWith('/');
  if (/^[A-Za-z]:\/$/.test(normAncestor)) {
    return normCandidate.toLowerCase().startsWith(normAncestor.toLowerCase());
  }
  const isWin = /^[A-Za-z]:\//.test(normAncestor) || /^[A-Za-z]:\//.test(normCandidate);
  if (isWin) {
    return normCandidate.toLowerCase().startsWith(`${normAncestor.toLowerCase()}/`);
  }
  return normCandidate.startsWith(`${normAncestor}/`);
}

/** Check whether two paths denote the same normalized location. */
export function areFsPathsEqual(a: string, b: string): boolean {
  const na = normalizeFsPath(a).replace(/\\/g, '/');
  const nb = normalizeFsPath(b).replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(na) || /^[A-Za-z]:\//.test(nb)) {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

/** Compute relative path from `rootPath` to `fullPath` when nested under `rootPath`; otherwise `fullPath`. */
export function toRelativeDisplayPath(fullPath: string, rootPath: string): string {
  const normFull = normalizeFsPath(fullPath);
  const normRoot = normalizeFsPath(rootPath);
  if (!normRoot) return normFull;
  if (areFsPathsEqual(normFull, normRoot)) return '.';
  if (!isPathEqualOrDescendant(normFull, normRoot)) return normFull;
  if (normRoot === '/' || /^[A-Za-z]:[/\\]$/.test(normRoot)) {
    return normFull.slice(normRoot.length);
  }
  return normFull.slice(normRoot.length + 1);
}

/** Propagate descendant git changes up to every ancestor folder (ignoring `'!!'` gitignored entries). */
export function computeDirGitStatus(
  modifiedFiles: ReadonlyMap<string, string>,
): Map<string, DirGitStatusKind> {
  const result = new Map<string, DirGitStatusKind>();
  for (const [filePath, code] of modifiedFiles) {
    if (code === '!!') continue;
    const status: DirGitStatusKind = code === '??'
      ? 'untracked'
      : code === 'A'
        ? 'added'
        : code === 'D'
          ? 'deleted'
          : 'modified';
    let cur = getParentDirPath(filePath);
    let guard = 0;
    while (cur && guard++ < 64) {
      const existing = result.get(cur);
      if (!existing || DIR_GIT_SEVERITY[status] > DIR_GIT_SEVERITY[existing]) {
        result.set(cur, status);
      }
      cur = getParentDirPath(cur);
    }
  }
  return result;
}

/** Pre-selection range for inline rename: filename stem before extension, or full name for folders/dotfiles. */
export function getRenameSelectionRange(name: string, isDir: boolean): { start: number; end: number } {
  if (isDir) return { start: 0, end: name.length };
  const lastDot = name.lastIndexOf('.');
  if (lastDot > 0) return { start: 0, end: lastDot };
  return { start: 0, end: name.length };
}

/** Guard drag-and-drop move against missing inputs, non-directories, same-parent, self, and descendant drops. */
export function canDropPathIntoDir(sourcePath: string, targetDirPath: string): boolean {
  if (!sourcePath || !targetDirPath) return false;
  if (areFsPathsEqual(sourcePath, targetDirPath)) return false;
  const sourceParent = getParentDirPath(sourcePath);
  if (sourceParent && areFsPathsEqual(sourceParent, targetDirPath)) return false;
  if (isPathEqualOrDescendant(targetDirPath, sourcePath)) return false;
  return true;
}

/** Flatten currently visible tree rows in visual top-to-bottom order for keyboard navigation. */
export function collectVisibleTreeEntries(
  roots: readonly TreeNavNode[],
  expandedPaths: ReadonlySet<string>,
  showHidden: boolean,
  forceExpanded?: ReadonlySet<string>,
): VisibleTreeEntry[] {
  const out: VisibleTreeEntry[] = [];
  const visit = (nodes: readonly TreeNavNode[], depth: number, parentId: string | null) => {
    for (const node of nodes) {
      if (!showHidden && node.hidden) continue;
      out.push({ node, depth, parentId });
      const isExpanded = node.isDir && (expandedPaths.has(node.id) || Boolean(forceExpanded?.has(node.id)));
      if (isExpanded && node.children?.length) {
        visit(node.children, depth + 1, node.id);
      }
    }
  };
  visit(roots, 0, null);
  return out;
}
