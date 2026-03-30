/**
 * Cross-platform path utilities for display paths.
 * Handles both Unix (/) and Windows (\) separators.
 *
 * NOTE: These are for DISPLAY paths received from the daemon as strings.
 * The daemon should use Node's `path` module (OS-aware). The web UI
 * doesn't have access to Node's `path`, so it needs its own helpers.
 */

/** Extract filename from a path (handles both / and \ separators). */
export function pathBasename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

/** Check if a path is absolute (Unix /, Windows C:\, UNC \\, or tilde ~). */
export function isAbsolutePath(p: string): boolean {
  return /^[/\\]/.test(p) || /^[A-Za-z]:[/\\]/.test(p) || p.startsWith('~');
}

/** Detect the path separator used in a path string. */
export function detectSeparator(p: string): '/' | '\\' {
  return p.includes('\\') ? '\\' : '/';
}

/** Get parent directory (handles both separators). */
export function pathDirname(p: string): string {
  const stripped = p.replace(/[/\\]+$/, '');
  // Windows drive root (C: after stripping \) → return C:\
  if (/^[A-Za-z]:$/.test(stripped)) return stripped + '\\';
  const segs = stripped.split(/[/\\]/);
  segs.pop();
  let result = segs.join('/') || '/';
  // Parent is a drive root: C: → C:\
  if (/^[A-Za-z]:$/.test(result)) result += '\\';
  return result;
}
