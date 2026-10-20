/**
 * Pure path redirect for a pair worktree that moved under a new executor.
 * No imports on purpose: it also runs unchanged under plain node on a Windows
 * test machine.
 */
export interface TaskPairWorkspacePathInfo {
  path: string;
  previousPaths?: string[];
}

function normalizeWorkspacePath(value: string): string {
  const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed;
}

/**
 * Map a path that points into a worktree this pair moved away from (or the old
 * path itself) onto the workspace's current location. Other paths pass
 * through unchanged. Pure; used on the audit-material path, which runs per READY.
 */
export function redirectTaskPairWorkspacePath(workspace: TaskPairWorkspacePathInfo | undefined, path: string): string {
  if (!workspace?.previousPaths?.length || !path) return path;
  const wanted = normalizeWorkspacePath(path);
  for (const previous of workspace.previousPaths) {
    const old = normalizeWorkspacePath(previous);
    if (wanted === old) return workspace.path;
    if (wanted.startsWith(`${old}/`)) return `${workspace.path.replace(/[\\/]+$/, '')}${path.slice(previous.replace(/[\\/]+$/, '').length)}`;
  }
  return path;
}

